-- Gusto fees and refunds: recategorize them in the same Gusto import.
--
-- The monthly Gusto fee withdrawals sit in the books on a software expense
-- (Wave's choice), and Gusto's small refund deposits are booked the same way.
-- When the owner imports a Gusto export, the review now lists those entries in
-- the years the file covers and offers to move them: fees and fee refunds to
-- Payroll fees, and a deposit that matches a tax credit in the file (same
-- amount, within 45 days after its check date) to employer payroll taxes.
--
-- 1. accounting.gusto_fees(request) (new, owner read): the candidate entries.
--    Posted, not reversed, not on a payroll run, memo or bank description
--    containing "gusto", exactly one bank, card or cash line and one income or
--    expense line that is not a payroll account (payroll subtypes, the officer
--    wages, employer taxes and payroll fees purposes, the import's mapped
--    accounts or the chosen fees account). Payroll withdrawals clear the
--    payables, so they never qualify, and entries already in the right place
--    drop out. Rows in a locked month, on a bank reconciliation, or on a
--    transfer or register come back with the reason and cannot be chosen.
-- 2. accounting.gusto_import(request) (restated in full): request.fees
--    {fee_account, years, credits, selected:[{id,version}]}. On commit each
--    chosen row is re-checked and moved with entry.correct (same date, same
--    bank line and bank match, only the category account changes), in the same
--    transaction as the payroll links. Defaults also name the account whose
--    purpose is payroll fees, if there is one. Works when every payroll in the file is
--    already imported. Undoing a payroll import does not move fees back; each
--    corrected entry can be edited on its own.
--
-- Postgres 17 compatible. Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION accounting.gusto_import(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
<<gusto_import>>
DECLARE actor uuid:=accounting.require_owner(); committing boolean:=request->>'mode'='commit'; mapping jsonb:=request->'mapping';
 item jsonb; body jsonb; lines jsonb; runs jsonb:='[]'; r jsonb; plan jsonb:='{}'; outcome jsonb:='{}'; pool jsonb; claimed jsonb:='{}'; candidate jsonb; result jsonb:='[]';
 prior accounting.payroll_runs; existing accounting.journal_entries; defaults jsonb; st text; msg text; identity text; day date; employer bigint; employee bigint;
 run_month text; members jsonb; n integer; window_runs jsonb; window_keys jsonb; total jsonb; first_date date; last_date date; pairs jsonb:='[]'; pair jsonb; k text;
 unit jsonb; choice text; link_entry uuid; new_run uuid; saved jsonb; posted jsonb; done jsonb:='{}'; resolution text; group_key text; fee_rows jsonb; pick jsonb;
BEGIN
 IF committing THEN PERFORM accounting.write_lock(); END IF;
 SELECT ytd->'gusto_import' INTO defaults FROM accounting.payroll_runs
 WHERE ytd?'gusto_import' ORDER BY updated_at DESC,id DESC LIMIT 1;
 -- A first Gusto import starts from the payroll accounts the Patriot importer last used.
 IF request->>'mode'='defaults' THEN RETURN coalesce(defaults,(SELECT jsonb_build_object('mapping',ytd->'patriot_import'->'mapping') FROM accounting.payroll_runs
  WHERE ytd?'patriot_import' ORDER BY updated_at DESC,id DESC LIMIT 1),'{}')
  ||jsonb_build_object('fee_account',(SELECT id FROM accounting.accounts WHERE system_purpose='payroll_fees' AND NOT is_archived)); END IF;
 IF request->>'mode' NOT IN ('preview','commit') OR jsonb_typeof(request->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(request->'items') NOT BETWEEN 1 AND 500 OR octet_length(request::text)>3000000
 OR jsonb_typeof(mapping) IS DISTINCT FROM 'object' OR coalesce(mapping->>'wages','')!~'^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF committing AND NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o
 ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=(request->>'document_id')::uuid
 AND d.status<>'archived' AND d.sha256=request->>'content_hash') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items') GROUP BY value->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF request?'fees' AND (jsonb_typeof(request->'fees') IS DISTINCT FROM 'object' OR jsonb_typeof(coalesce(request->'fees'->'selected','[]'::jsonb)) IS DISTINCT FROM 'array'
  OR jsonb_array_length(coalesce(request->'fees'->'selected','[]'::jsonb))>500
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(request->'fees'->'selected','[]'::jsonb)) s WHERE coalesce(s->>'id','')!~'^[0-9a-f-]{36}$' OR coalesce(s->>'version','')!~'^[1-9][0-9]{0,9}$'))
 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;

 -- 1. Each run's account totals, and whether it was imported before.
 FOR item IN SELECT value FROM jsonb_array_elements(request->'items') ORDER BY value->'body'->>'pay_date',value->>'key' LOOP
  body:=item->'body'; identity:=item->>'key'; st:=NULL; msg:=NULL; day:=(body->>'pay_date')::date;
  IF coalesce(identity,'')!~'^Gusto [0-9]{4}-[0-9]{2}-[0-9]{2} [a-f0-9]{64}$' OR substr(identity,7,10)<>body->>'pay_date'
  OR coalesce(item->>'fingerprint','')!~'^[a-f0-9]{64}$' OR jsonb_typeof(body->'components') IS DISTINCT FROM 'array'
  OR jsonb_typeof(item->'payroll_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'payroll_ids') NOT BETWEEN 1 AND 50
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'payroll_ids') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}'!~'^[A-Za-z0-9_-]{1,64}$')
  THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(body->'components') p WHERE
   p->>'kind' NOT IN ('officer_wages','other_wages','net_pay','employee_tax','employer_tax') OR
   coalesce(p->>'amount_cents','')!~'^[0-9]{1,18}$' OR (p->>'amount_cents')::bigint<=0 OR coalesce(p->>'account_id','')!~'^[0-9a-f-]{36}$'
   OR (p->>'kind'='employer_tax' AND coalesce(p->>'offset_account_id','')!~'^[0-9a-f-]{36}$'))
  THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS'; END IF;
  SELECT coalesce(sum((value->>'amount_cents')::bigint) FILTER(WHERE value->>'kind'='employer_tax'),0),coalesce(sum((value->>'amount_cents')::bigint) FILTER(WHERE value->>'kind'='employee_tax'),0)
   INTO employer,employee FROM jsonb_array_elements(body->'components');
  SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',account,'amount_cents',amount::text) ORDER BY account),'[]') INTO lines FROM (
   SELECT account,sum(amount)::bigint amount FROM (
    SELECT (p->>'account_id')::uuid account,(p->>'amount_cents')::bigint*CASE WHEN p->>'kind' IN ('net_pay','employee_tax') THEN -1 ELSE 1 END amount FROM jsonb_array_elements(body->'components') p
    UNION ALL SELECT (p->>'offset_account_id')::uuid,-(p->>'amount_cents')::bigint FROM jsonb_array_elements(body->'components') p WHERE p->>'kind'='employer_tax'
   ) raw GROUP BY account HAVING sum(amount)<>0) grouped;
  IF jsonb_array_length(lines)<2 OR (SELECT sum((value->>'amount_cents')::numeric) FROM jsonb_array_elements(lines))<>0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
  SELECT * INTO prior FROM accounting.payroll_runs WHERE provider_run_id=identity;
  IF FOUND THEN
   IF prior.status='posted' AND prior.ytd->'gusto_import'->>'fingerprint'=item->>'fingerprint'
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=prior.entry_id) THEN st:='duplicate';msg:='Already imported.';
   ELSE st:='conflict';msg:='This payroll was imported before with different figures, or it was voided. Open it in Payroll to review it.'; END IF;
  ELSIF EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.pay_date=gusto_import.day AND p.period_start=(body->>'period_from')::date
   AND p.period_end=(body->>'period_to')::date AND p.status<>'void') THEN
   st:='conflict';msg:='Another payroll with this pay date and pay period is already in your books.';
  END IF;
  runs:=runs||jsonb_build_array(jsonb_build_object('key',identity,'item',item,'pay_date',day,'month',to_char(day,'YYYY-MM'),'lines',lines,
   'totals',accounting.payroll_import_totals(lines),'state',st,'message',msg,'employer',employer::text,'employee',employee::text,'run_id',prior.id,'entry_id',prior.entry_id));
 END LOOP;

 -- 2. Posted entries the runs could already be in: not reversed, not linked to a payroll, with a line on the wage account.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'version',e.version,'entry_date',e.entry_date,'memo',e.memo,'payroll',e.kind='payroll' OR e.memo ILIKE '%payroll%',
   'totals',accounting.payroll_import_totals((SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents)) FROM accounting.journal_lines l WHERE l.entry_id=e.id)),
   'can_correct',e.register_id IS NULL AND e.transfer_group_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM accounting.periods pe WHERE pe.status='locked' AND pe.month>=date_trunc('month',e.entry_date)::date)
    AND NOT EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND (EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id)
     OR EXISTS(SELECT 1 FROM accounting.reconciliation_items ri WHERE ri.journal_line_id=l.id)))) ORDER BY e.entry_date,e.id),'[]') INTO pool
 FROM accounting.journal_entries e WHERE e.status='posted' AND e.reverses_entry_id IS NULL
  AND e.entry_date BETWEEN date_trunc('month',(SELECT min((value->>'pay_date')::date) FROM jsonb_array_elements(runs)))::date-7
   AND (date_trunc('month',(SELECT max((value->>'pay_date')::date) FROM jsonb_array_elements(runs)))+interval '1 month')::date+7
  AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries x WHERE x.reverses_entry_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id)
  AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id=(mapping->>'wages')::uuid);

 -- 3. One run, one entry, same amounts: on the pay date (match) or within a week (date_match).
 FOR r IN SELECT value FROM jsonb_array_elements(runs) LOOP
  CONTINUE WHEN r->>'state' IS NOT NULL;
  day:=(r->>'pay_date')::date; st:='match';
  SELECT c INTO candidate FROM jsonb_array_elements(pool) c WHERE NOT claimed?(c->>'id') AND c->'totals'=r->'totals' AND (c->>'entry_date')::date=day ORDER BY c->>'id' LIMIT 1;
  IF candidate IS NULL THEN
   st:='date_match';
   SELECT c INTO candidate FROM jsonb_array_elements(pool) c WHERE NOT claimed?(c->>'id') AND (c->>'payroll')::boolean AND c->'totals'=r->'totals'
    AND abs((c->>'entry_date')::date-day)<=7 ORDER BY abs((c->>'entry_date')::date-day),c->>'entry_date',c->>'id' LIMIT 1;
  END IF;
  IF candidate IS NOT NULL THEN
   claimed:=claimed||jsonb_build_object(candidate->>'id',true);
   plan:=plan||jsonb_build_object(r->>'key',jsonb_build_object('state',st,'group',jsonb_build_array(r->>'key'),'entry',candidate,'totals',r->'totals'));
  END IF;
 END LOOP;

 -- 4. Consecutive runs in one month whose sums equal one entry (a monthly journal for semimonthly pay).
 FOR run_month IN SELECT DISTINCT value->>'month' FROM jsonb_array_elements(runs) WHERE value->>'state' IS NULL ORDER BY 1 LOOP
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'pay_date',value->>'key'),'[]') INTO members FROM jsonb_array_elements(runs)
   WHERE value->>'month'=run_month AND value->>'state' IS NULL AND NOT plan?(value->>'key');
  n:=jsonb_array_length(members);
  FOR width IN REVERSE n..2 LOOP
   FOR pos IN 0..n-width LOOP
    SELECT jsonb_agg(value ORDER BY ord),jsonb_agg(value->>'key' ORDER BY ord) INTO window_runs,window_keys FROM jsonb_array_elements(members) WITH ORDINALITY w(value,ord) WHERE ord-1 BETWEEN pos AND pos+width-1;
    CONTINUE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements_text(window_keys) x WHERE plan?x);
    total:=accounting.payroll_import_totals((SELECT jsonb_agg(l) FROM jsonb_array_elements(window_runs) w CROSS JOIN LATERAL jsonb_array_elements(w->'lines') l));
    first_date:=(window_runs->0->>'pay_date')::date; last_date:=(window_runs->(width-1)->>'pay_date')::date;
    SELECT c INTO candidate FROM jsonb_array_elements(pool) c WHERE NOT claimed?(c->>'id') AND (c->>'payroll')::boolean AND c->'totals'=total
     AND (c->>'entry_date')::date BETWEEN first_date-7 AND last_date+7 ORDER BY abs((c->>'entry_date')::date-last_date),c->>'id' LIMIT 1;
    IF candidate IS NOT NULL THEN
     claimed:=claimed||jsonb_build_object(candidate->>'id',true);
     FOR k IN SELECT value FROM jsonb_array_elements_text(window_keys) LOOP
      plan:=plan||jsonb_build_object(k,jsonb_build_object('state','group_match','group',window_keys,'entry',candidate,'totals',total));
     END LOOP;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;

 -- 5. What is left pairs with the closest payroll entry nearby, alone or with its month's other runs, and shows the difference.
 FOR run_month IN SELECT DISTINCT value->>'month' FROM jsonb_array_elements(runs) WHERE value->>'state' IS NULL AND NOT plan?(value->>'key') ORDER BY 1 LOOP
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'pay_date',value->>'key'),'[]') INTO members FROM jsonb_array_elements(runs)
   WHERE value->>'month'=run_month AND value->>'state' IS NULL AND NOT plan?(value->>'key');
  n:=jsonb_array_length(members);
  FOR width IN 1..n LOOP
   FOR pos IN 0..n-width LOOP
    SELECT jsonb_agg(value ORDER BY ord),jsonb_agg(value->>'key' ORDER BY ord) INTO window_runs,window_keys FROM jsonb_array_elements(members) WITH ORDINALITY w(value,ord) WHERE ord-1 BETWEEN pos AND pos+width-1;
    total:=accounting.payroll_import_totals((SELECT jsonb_agg(l) FROM jsonb_array_elements(window_runs) w CROSS JOIN LATERAL jsonb_array_elements(w->'lines') l));
    first_date:=(window_runs->0->>'pay_date')::date; last_date:=(window_runs->(width-1)->>'pay_date')::date;
    pairs:=pairs||coalesce((SELECT jsonb_agg(jsonb_build_object('keys',window_keys,'entry',c,'width',width,'totals',total,'distance',abs((c->>'entry_date')::date-last_date),
      'difference',accounting.gusto_difference(c->'totals',total),
      'score',(SELECT coalesce(sum(abs((d->>'difference_cents')::bigint)),0) FROM jsonb_array_elements(accounting.gusto_difference(c->'totals',total)) d)))
     FROM jsonb_array_elements(pool) c WHERE NOT claimed?(c->>'id') AND (c->>'payroll')::boolean
      AND coalesce((c->'totals'->>(mapping->>'wages'))::bigint,0)>0 AND (c->>'entry_date')::date BETWEEN first_date-7 AND last_date+7),'[]');
   END LOOP;
  END LOOP;
 END LOOP;
 FOR pair IN SELECT value FROM jsonb_array_elements(pairs) ORDER BY (value->>'score')::bigint,(value->>'width')::integer DESC,(value->>'distance')::integer,value->'entry'->>'id',value->'keys'->>0 LOOP
  CONTINUE WHEN claimed?(pair->'entry'->>'id') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(pair->'keys') x WHERE plan?x);
  claimed:=claimed||jsonb_build_object(pair->'entry'->>'id',true);
  FOR k IN SELECT value FROM jsonb_array_elements_text(pair->'keys') LOOP
   plan:=plan||jsonb_build_object(k,jsonb_build_object('state','difference','group',pair->'keys','entry',pair->'entry','totals',pair->'totals','difference',pair->'difference'));
  END LOOP;
 END LOOP;

 -- 6. Final state per run. A run with nothing to link to is new, unless its month already holds a payroll entry this file does not explain.
 FOR r IN SELECT value FROM jsonb_array_elements(runs) LOOP
  day:=(r->>'pay_date')::date; unit:=plan->(r->>'key');
  st:=coalesce(r->>'state',unit->>'state','new');
  msg:=coalesce(r->>'message',CASE st
   WHEN 'match' THEN 'Already in your books on this date with the same amounts. Link it so this payroll is not recorded twice.'
   WHEN 'date_match' THEN 'Already in your books on '||to_char((unit->'entry'->>'entry_date')::date,'FMMonth FMDD, YYYY')||' with the same amounts. Keep that date or move it to the Gusto pay date.'
   WHEN 'group_match' THEN 'Your books record this payroll together with '||(jsonb_array_length(unit->'group')-1)::text||CASE WHEN jsonb_array_length(unit->'group')=2 THEN ' other' ELSE ' others' END||' in one entry, with the same amounts. Link them together.'
   WHEN 'difference' THEN 'Your books have this payroll with different amounts. Keep your books as they are, or correct them to match Gusto.'
   ELSE 'Not in your books yet. Importing records it.' END);
  IF st='new' THEN
   SELECT c INTO candidate FROM jsonb_array_elements(pool) c WHERE NOT claimed?(c->>'id') AND (c->>'payroll')::boolean
    AND coalesce((c->'totals'->>(mapping->>'wages'))::bigint,0)>0 AND to_char((c->>'entry_date')::date,'YYYY-MM')=r->>'month' ORDER BY c->>'entry_date',c->>'id' LIMIT 1;
   IF candidate IS NOT NULL THEN
    st:='conflict';msg:='Your books already have a payroll entry this month that does not line up with this file. Include the whole month in the Gusto export, or review that entry.';
    unit:=jsonb_build_object('group',jsonb_build_array(r->>'key'),'entry',candidate);
   END IF;
  END IF;
  IF st NOT IN ('duplicate','conflict') THEN
   BEGIN PERFORM accounting.require_open(day);
   EXCEPTION WHEN OTHERS THEN st:='conflict';msg:='This month is locked. Reopen it to import this payroll.'; END;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'lines') l LEFT JOIN accounting.accounts a ON a.id=(l->>'account_id')::uuid
     WHERE a.id IS NULL OR a.is_archived OR a.type<>CASE WHEN (l->>'amount_cents')::bigint>0 THEN 'expense' ELSE 'liability' END)
   THEN st:='conflict';msg:='Choose active expense and liability accounts for payroll.'; END IF;
  END IF;
  outcome:=outcome||jsonb_build_object(r->>'key',jsonb_build_object('state',st,'message',msg,'unit',coalesce(unit,jsonb_build_object('group',jsonb_build_array(r->>'key')))));
 END LOOP;
 -- Runs linked together stand or fall together.
 FOR r IN SELECT value FROM jsonb_array_elements(runs) LOOP
  unit:=outcome->(r->>'key')->'unit';
  IF outcome->(r->>'key')->>'state'<>'conflict' AND jsonb_array_length(unit->'group')>1 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(unit->'group') g WHERE outcome->g->>'state'='conflict') THEN
   outcome:=outcome||jsonb_build_object(r->>'key',(outcome->(r->>'key'))||jsonb_build_object('state','conflict','message','Another payroll that shares this entry cannot be imported, so this one waits too.'));
  END IF;
 END LOOP;

 -- 7. Results, and on commit the chosen runs, all or nothing.
 FOR r IN SELECT value FROM jsonb_array_elements(runs) LOOP
  item:=r->'item'; body:=item->'body'; day:=(r->>'pay_date')::date; st:=outcome->(r->>'key')->>'state'; msg:=outcome->(r->>'key')->>'message';
  unit:=outcome->(r->>'key')->'unit'; choice:=item->>'choice'; new_run:=(r->>'run_id')::uuid; link_entry:=(r->>'entry_id')::uuid;
  IF committing AND choice IS NOT NULL AND st<>'duplicate' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(unit->'group') g WHERE (SELECT x->'item'->>'choice' FROM jsonb_array_elements(runs) x WHERE x->>'key'=g) IS DISTINCT FROM choice)
   THEN RAISE EXCEPTION 'ACCT_GUSTO_GROUP_CHOICE'; END IF;
   IF NOT coalesce((st='new' AND choice='new')
    OR (st IN ('match','date_match','group_match','difference') AND choice='link:'||(unit->'entry'->>'id')||':'||(unit->'entry'->>'version'))
    OR (st IN ('date_match','difference') AND choice='correct:'||(unit->'entry'->>'id')||':'||(unit->'entry'->>'version') AND (unit->'entry'->>'can_correct')::boolean),false)
   THEN RAISE EXCEPTION 'ACCT_GUSTO_CHANGED'; END IF;
   group_key:=unit->'group'->>0;
   resolution:=CASE WHEN choice LIKE 'correct:%' THEN 'corrected' WHEN st IN ('date_match','difference') THEN 'kept_books' END;
   IF done?group_key THEN link_entry:=(done->>group_key)::uuid;
   ELSIF choice='new' THEN
    posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
     'type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',day,
     'memo','Payroll for '||day::text,'kind','payroll','lines',r->'lines')));
    posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
     'type','entry.post','id',posted->'id','expected_version',posted->'version')));
    link_entry:=(posted->>'id')::uuid;
   ELSIF choice LIKE 'correct:%' THEN
    SELECT * INTO existing FROM accounting.journal_entries WHERE id=(unit->'entry'->>'id')::uuid;
    PERFORM accounting.require_open(existing.entry_date);
    posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
      'type','entry.correct','id',existing.id,'expected_version',existing.version,'reversal_date',existing.entry_date,
      'entry_date',CASE WHEN st='date_match' THEN day ELSE existing.entry_date END,'memo',existing.memo,
      'lines',CASE WHEN st='date_match' THEN accounting.entry_detail(existing.id)->'lines'
       ELSE (SELECT jsonb_agg(jsonb_build_object('account_id',t.key,'amount_cents',t.value#>>'{}') ORDER BY t.key) FROM jsonb_each(unit->'totals') t) END,
      'reason',CASE WHEN st='date_match' THEN 'Correct the payroll date to match Gusto' ELSE 'Correct payroll amounts to match Gusto' END)));
    link_entry:=(posted->>'id')::uuid;
    IF existing.review_pending THEN
     PERFORM accounting.ledger_command(jsonb_build_object('type','entry.review','id',link_entry,'expected_version',posted->'version','reviewed',false));
    END IF;
   ELSE link_entry:=(unit->'entry'->>'id')::uuid; END IF;
   done:=done||jsonb_build_object(group_key,link_entry);
   saved:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
    'type','payroll.save','id',gen_random_uuid(),'expected_version',0,'provider_run_id',r->>'key','body',body,
    'document_id',request->'document_id','reason','Imported Gusto payroll data')));
   new_run:=(saved->>'id')::uuid;
   PERFORM accounting.payroll_plan(jsonb_build_object('id',new_run,'template','accrual','verified',true));
   PERFORM set_config('accounting.action','payroll.import',true);
   PERFORM set_config('accounting.reason','Imported Gusto payroll data',true);
   UPDATE accounting.payroll_runs SET status='posted',provider='gusto',entry_id=link_entry,entry_shared=jsonb_array_length(unit->'group')>1,
    ytd=ytd||jsonb_build_object('gusto_import',jsonb_strip_nulls(jsonb_build_object('mapping',mapping,'fingerprint',item->'fingerprint',
     'payroll_ids',item->'payroll_ids','document_id',request->'document_id','journal_mode',CASE WHEN choice='new' THEN 'created' ELSE 'linked' END,
     'link_state',st,'resolution',resolution,'previous_entry_id',CASE WHEN resolution='corrected' THEN unit->'entry'->>'id' END,
     'group',CASE WHEN jsonb_array_length(unit->'group')>1 THEN unit->'group' END,
     'difference',CASE WHEN st='difference' THEN unit->'difference' END)))
   WHERE id=new_run;
   INSERT INTO accounting.document_links(document_id,payroll_run_id,created_by) VALUES((request->>'document_id')::uuid,new_run,actor) ON CONFLICT DO NOTHING;
  END IF;
  result:=result||jsonb_build_array(jsonb_build_object('key',r->>'key','pay_date',day,'period_from',body->'period_from','period_to',body->'period_to',
   'gross',body->'declared_gross_cents','net',body->'declared_net_cents','employee_tax',r->'employee','employer_tax',r->'employer',
   'employee_count',jsonb_array_length(body->'employees'),'state',st,'message',msg,
   'group',CASE WHEN jsonb_array_length(unit->'group')>1 THEN unit->'group' ELSE '[]'::jsonb END,
   'entry',CASE WHEN unit?'entry' AND st<>'duplicate' THEN jsonb_build_object('id',unit->'entry'->'id','version',unit->'entry'->'version','entry_date',unit->'entry'->'entry_date',
     'memo',unit->'entry'->'memo','can_correct',unit->'entry'->'can_correct',
     'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',t.key,'amount_cents',t.value#>>'{}') ORDER BY t.key),'[]') FROM jsonb_each(unit->'entry'->'totals') t)) END,
   'difference',CASE WHEN st='difference' THEN unit->'difference' ELSE '[]'::jsonb END,'run_id',new_run,'entry_id',link_entry));
 END LOOP;

 -- 8. Gusto fees and refunds the owner chose to recategorize: the same entry, date and bank line, only the category moves.
 IF committing AND jsonb_array_length(coalesce(request->'fees'->'selected','[]'::jsonb))>0 THEN
  fee_rows:=accounting.gusto_fees((request->'fees')-'selected'||jsonb_build_object('mapping',mapping));
  FOR pick IN SELECT value FROM jsonb_array_elements(request->'fees'->'selected') LOOP
   SELECT c INTO candidate FROM jsonb_array_elements(fee_rows) c WHERE c->>'id'=pick->>'id' AND c->>'version'=pick->>'version' AND c->>'blocked' IS NULL AND c->>'to_account_id' IS NOT NULL;
   IF candidate IS NULL THEN RAISE EXCEPTION 'ACCT_GUSTO_CHANGED'; END IF;
   SELECT * INTO existing FROM accounting.journal_entries WHERE id=(candidate->>'id')::uuid;
   PERFORM accounting.require_open(existing.entry_date);
   posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
     'type','entry.correct','id',existing.id,'expected_version',existing.version,'reversal_date',existing.entry_date,
     'entry_date',existing.entry_date,'memo',existing.memo,
     'lines',(SELECT jsonb_agg(CASE WHEN l->>'id'=candidate->>'line_id' THEN l||jsonb_build_object('account_id',candidate->'to_account_id') ELSE l END ORDER BY (l->>'sort_order')::integer)
      FROM jsonb_array_elements(accounting.entry_detail(existing.id)->'lines') l),
     'reason',CASE candidate->>'kind' WHEN 'tax_refund' THEN 'Gusto tax refund moved to employer payroll taxes' ELSE 'Gusto fee moved to payroll fees' END)));
   IF existing.review_pending THEN
    PERFORM accounting.ledger_command(jsonb_build_object('type','entry.review','id',posted->'id','expected_version',posted->'version','reviewed',false));
   END IF;
  END LOOP;
 END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.gusto_import(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.gusto_import(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION accounting.gusto_fees(request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE fee_account uuid; employer uuid; years integer[]; result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 IF jsonb_typeof(request->'years') IS DISTINCT FROM 'array' OR jsonb_array_length(request->'years') NOT BETWEEN 1 AND 20
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(request->'years') y WHERE coalesce(y#>>'{}','')!~'^(19|20|21)[0-9]{2}$')
 OR jsonb_typeof(request->'mapping') IS DISTINCT FROM 'object' OR coalesce(request->'mapping'->>'employer_tax','')!~'^[0-9a-f-]{36}$'
 OR coalesce(request->>'fee_account','00000000-0000-0000-0000-000000000000')!~'^[0-9a-f-]{36}$'
 OR jsonb_typeof(coalesce(request->'credits','[]'::jsonb)) IS DISTINCT FROM 'array' OR jsonb_array_length(coalesce(request->'credits','[]'::jsonb))>200
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(request->'credits','[]'::jsonb)) c WHERE coalesce(c->>'check_date','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR coalesce(c->>'amount','')!~'^-[0-9]{1,15}$')
 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 SELECT id INTO fee_account FROM accounting.accounts WHERE id=(request->>'fee_account')::uuid AND type='expense' AND NOT is_archived;
 employer:=(request->'mapping'->>'employer_tax')::uuid;
 years:=ARRAY(SELECT (y#>>'{}')::integer FROM jsonb_array_elements(request->'years') y);
 -- Gusto's fee withdrawals and refund deposits: one bank or card line and one category line that is not a payroll account.
 -- The payroll withdrawals clear the payables, so they never qualify.
 WITH payroll_accounts AS (
  SELECT a.id FROM accounting.accounts a WHERE coalesce(a.subtype,'') IN ('payroll_expense','payroll_liability')
   OR coalesce(a.system_purpose,'') IN ('officer_wages','employer_payroll_taxes','payroll_fees')
  UNION SELECT (m.value)::uuid FROM jsonb_each_text(request->'mapping') m WHERE m.value~'^[0-9a-f-]{36}$'
  UNION SELECT fee_account WHERE fee_account IS NOT NULL
 ), gusto_rows AS (
  SELECT e.id,e.version,e.entry_date,e.memo,e.source_description,e.register_id,e.transfer_group_id,b.amount_cents bank_cents,o.id line_id,o.account_id from_account,
   CASE WHEN b.amount_cents<0 THEN 'fee'
    WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(request->'credits','[]'::jsonb)) c WHERE -(c->>'amount')::bigint=b.amount_cents
     AND e.entry_date BETWEEN (c->>'check_date')::date AND (c->>'check_date')::date+45) THEN 'tax_refund'
    ELSE 'fee_refund' END kind
  FROM accounting.journal_entries e
  JOIN LATERAL (SELECT l.* FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND coalesce(a.subtype,'') IN ('bank','card','cash')) b ON true
  JOIN LATERAL (SELECT l.* FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND coalesce(a.subtype,'') NOT IN ('bank','card','cash') AND a.type IN ('expense','income')) o ON true
  WHERE e.status='posted' AND e.reverses_entry_id IS NULL AND extract(year FROM e.entry_date)::integer=ANY(years)
   AND (e.memo ILIKE '%gusto%' OR coalesce(e.source_description,'') ILIKE '%gusto%')
   AND (SELECT count(*) FROM accounting.journal_lines l WHERE l.entry_id=e.id)=2
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries x WHERE x.reverses_entry_id=e.id)
   AND NOT EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id)
   AND o.account_id NOT IN (SELECT id FROM payroll_accounts)
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.version,'entry_date',r.entry_date,'memo',coalesce(nullif(r.memo,''),r.source_description,''),
   'amount_cents',r.bank_cents::text,'kind',r.kind,'line_id',r.line_id,'from_account_id',r.from_account,
   'to_account_id',CASE WHEN r.kind='tax_refund' THEN employer ELSE fee_account END,
   'blocked',CASE WHEN EXISTS(SELECT 1 FROM accounting.periods pe WHERE pe.status='locked' AND pe.month>=date_trunc('month',r.entry_date)::date) THEN 'This month is locked.'
    WHEN EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.reconciliation_items ri ON ri.journal_line_id=l.id WHERE l.entry_id=r.id) THEN 'Part of a bank reconciliation.'
    WHEN r.register_id IS NOT NULL OR r.transfer_group_id IS NOT NULL THEN 'Linked to a transfer or register.'
    WHEN r.kind<>'tax_refund' AND fee_account IS NULL THEN 'Choose a payroll fees account first.' END)
  ORDER BY r.entry_date,r.id),'[]'::jsonb) INTO result FROM gusto_rows r;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.gusto_fees(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.gusto_fees(jsonb) TO authenticated;

COMMIT;
