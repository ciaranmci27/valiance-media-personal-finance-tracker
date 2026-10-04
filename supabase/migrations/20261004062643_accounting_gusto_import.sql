-- Gusto payroll import that lines up with the payroll already in the books.
--
-- Every Gusto payroll from 2023 to early 2025 is already in the books as an
-- accrual journal (wages and employer taxes against net pay and taxes
-- payable). Some months hold one journal for two semimonthly runs, and a few
-- differ by a cent. Importing Gusto's Payroll data export therefore links each
-- run to the journal it is already in, and only records a new journal when
-- nothing matches. Bank payments are never touched.
--
-- 1. accounting.payroll_runs
--    - provider accepts 'gusto' as well as 'patriot'.
--    - entry_shared (default false): the run is one of several runs linked to
--      one journal. The one-run-per-journal rule (the old UNIQUE on entry_id)
--      becomes a unique index over runs that do not share
--      (payroll_runs_entry_single), plus a plain index for lookups by entry.
-- 2. The storage bucket accounting-private accepts .xlsx, so the export is
--    kept as each run's evidence like the Patriot CSV.
-- 3. Restated in full so they understand a Gusto import (ytd->'gusto_import'
--    next to ytd->'patriot_import'):
--    - payroll_import_mode: created or linked, for either provider.
--    - lifecycle_command: payroll.import.undo works for Gusto runs; undoing a
--      run that shares its journal unlinks every run on that journal and
--      leaves the journal as it is. Restore refuses a journal a Gusto import
--      created, as it does for Patriot.
--    - entry_detail: payroll_run_id is the first run on the journal;
--      payroll_run_ids lists them all.
--    - payroll: import_undone for either provider; the detail names its
--      provider and whether it shares its journal.
--    - register_guard: a journal that several runs share can never be
--      reversed (ACCT_PAYROLL_ENTRY_SHARED), so payroll.void and every delete
--      or correction refuse it; undo the import first.
-- 4. New:
--    - accounting.gusto_import(request): defaults, preview and commit, like
--      patriot_import (which is unchanged). Each run is matched against
--      posted journals by account totals: match (same date), date_match
--      (within 7 days), group_match (consecutive runs in one month whose sums
--      equal one journal), difference (closest payroll journal nearby, with
--      the per-account difference; the owner keeps the books or corrects them
--      to Gusto through entry.correct), duplicate, conflict, or new (posts an
--      accrual journal). A run with nothing to link to while its month already
--      holds an unexplained payroll journal is a conflict, so a partial export
--      cannot record wages twice. Commit is all or nothing.
--    - accounting.payroll_import_totals(lines) and
--      accounting.gusto_difference(books, provider): internal helpers.
--
-- Postgres 17 compatible. Safe to re-run.

BEGIN;

-- 1. Gusto runs, and several runs on one entry.
ALTER TABLE accounting.payroll_runs ADD COLUMN IF NOT EXISTS entry_shared boolean DEFAULT false NOT NULL;
ALTER TABLE accounting.payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_provider_check;
ALTER TABLE accounting.payroll_runs ADD CONSTRAINT payroll_runs_provider_check CHECK (provider = ANY (ARRAY['patriot'::text, 'gusto'::text]));
ALTER TABLE accounting.payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_entry_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_entry_single ON accounting.payroll_runs USING btree (entry_id) WHERE (NOT entry_shared);
CREATE INDEX IF NOT EXISTS payroll_runs_entry ON accounting.payroll_runs USING btree (entry_id) WHERE (entry_id IS NOT NULL);

-- 2. The Gusto export is an Excel workbook, kept as the run's evidence.
UPDATE storage.buckets SET allowed_mime_types=array_append(allowed_mime_types,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
 WHERE id='accounting-private' AND NOT ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'=ANY(coalesce(allowed_mime_types,ARRAY[]::text[])));

-- 3. Readers and lifecycle that knew only Patriot (restated in full).
CREATE OR REPLACE FUNCTION accounting.payroll_import_mode(run accounting.payroll_runs)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT CASE WHEN meta IS NULL THEN NULL
 WHEN meta->>'journal_mode' IN ('created','linked') THEN meta->>'journal_mode'
 WHEN EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.id=run.entry_id AND e.created_at=run.created_at AND e.memo='Payroll for '||run.pay_date::text AND e.kind='payroll') THEN 'created' ELSE 'linked' END
 FROM (SELECT coalesce(run.ytd->'patriot_import',run.ytd->'gusto_import') meta) imported
$fn$;

CREATE OR REPLACE FUNCTION accounting.lifecycle_command(c jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE e accounting.journal_entries; re accounting.journal_entries; run accounting.payroll_runs; sibling accounting.payroll_runs;
 result jsonb; item jsonb; new_id uuid; v integer; restore_date date:=(coalesce(c->>'entry_date',c->>'effective_date'))::date; mode text; meta_key text; own_version integer; undone jsonb:='[]';
BEGIN
 PERFORM accounting.require_owner();PERFORM accounting.write_lock();
 IF btrim(coalesce(c->>'reason',''))='' OR restore_date IS NULL THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND';END IF;
 PERFORM accounting.require_open(restore_date);
 IF c->>'type'='payroll.import.undo' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=(c->>'id')::uuid;
  IF run.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF run.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  meta_key:=CASE WHEN run.ytd?'patriot_import' THEN 'patriot_import' WHEN run.ytd?'gusto_import' THEN 'gusto_import' END;
  IF run.status<>'posted' OR meta_key IS NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_UNDO_UNAVAILABLE';END IF;
  mode:=accounting.payroll_import_mode(run);
  SELECT * INTO e FROM accounting.journal_entries WHERE id=run.entry_id;
  IF mode='created' THEN
   IF EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id)
   OR EXISTS(SELECT 1 FROM accounting.reconciliation_items i JOIN accounting.journal_lines l ON l.id=i.journal_line_id WHERE l.entry_id=e.id) THEN RAISE EXCEPTION 'ACCT_IMPORT_UNDO_LINKED';END IF;
   PERFORM set_config('accounting.action','payroll.void',true);
   result:=accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',e.id,'expected_version',e.version,'entry_date',restore_date,'reason',c->>'reason'));
  ELSE PERFORM accounting.require_open(run.pay_date);
  END IF;
  PERFORM set_config('accounting.action','payroll.import.undo',true);
  -- Runs linked together to one entry are unlinked together; the entry itself stays as it is.
  FOR sibling IN SELECT * FROM accounting.payroll_runs p WHERE p.id=run.id
   OR (mode='linked' AND run.entry_shared AND p.entry_shared AND p.entry_id=run.entry_id AND p.status='posted') ORDER BY p.pay_date,p.id LOOP
   IF mode='linked' THEN PERFORM accounting.require_open(sibling.pay_date);END IF;
   UPDATE accounting.payroll_runs SET status='void',entry_id=CASE WHEN mode='created' THEN sibling.entry_id ELSE NULL END,
    provider_run_id='Undone '||CASE sibling.provider WHEN 'gusto' THEN 'Gusto' ELSE 'Patriot' END||' '||id::text,
    ytd=jsonb_set(ytd,ARRAY[meta_key],(ytd->meta_key)||jsonb_build_object('undone',true,'journal_mode',mode,'original_entry_id',sibling.entry_id,'original_provider_run_id',sibling.provider_run_id,'undone_on',restore_date,'reversal_entry_id',result->'id'))
    WHERE id=sibling.id RETURNING version INTO v;
   IF sibling.id=run.id THEN own_version:=v;END IF;
   undone:=undone||to_jsonb(sibling.id);
  END LOOP;
  RETURN jsonb_build_object('id',run.id,'version',own_version,'journal_mode',mode,'run_ids',undone);
 ELSIF c->>'type'='entry.restore' THEN
  SELECT * INTO e FROM accounting.journal_entries WHERE id=(c->>'id')::uuid;
  IF e.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF e.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  SELECT * INTO re FROM accounting.journal_entries WHERE reverses_entry_id=e.id;
  IF re.id IS NULL OR e.reverses_entry_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.journal_entries WHERE restores_entry_id=e.id OR replaces_entry_id=e.id) THEN RAISE EXCEPTION 'ACCT_RESTORE_UNAVAILABLE';END IF;
  IF restore_date<re.entry_date THEN RAISE EXCEPTION 'ACCT_RESTORE_DATE';END IF;
  IF e.register_id IS NOT NULL OR e.transfer_group_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE entry_id=e.id OR (coalesce(ytd->'patriot_import',ytd->'gusto_import')->>'original_entry_id'=e.id::text AND coalesce(ytd->'patriot_import',ytd->'gusto_import')->>'journal_mode'='created')) THEN RAISE EXCEPTION 'ACCT_RESTORE_WORKFLOW';END IF;
  INSERT INTO accounting.journal_entries(entry_date,memo,origin,kind,payee_id,reason,restores_entry_id,created_by)
   VALUES(restore_date,e.memo,'internal',e.kind,e.payee_id,c->>'reason',e.id,auth.uid()) RETURNING id,version INTO new_id,v;
  INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
   SELECT new_id,account_id,amount_cents,memo,sort_order,cash_class FROM accounting.journal_lines WHERE entry_id=e.id;
  result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',new_id,'expected_version',v));
  FOR item IN SELECT value FROM jsonb_array_elements(re.bank_restore_matches) LOOP
   UPDATE accounting.bank_transactions SET review='unmatched',excluded_reason='' WHERE id=(item->>'bank_transaction_id')::uuid AND review='excluded' AND excluded_reason='Transaction reversed: '||e.id::text;
   INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by)
    SELECT (item->>'bank_transaction_id')::uuid,id,(item->>'amount_cents')::bigint,auth.uid() FROM accounting.journal_lines WHERE entry_id=new_id AND sort_order=(item->>'sort_order')::integer;
  END LOOP;
  INSERT INTO accounting.document_links(document_id,entry_id,created_by) SELECT document_id,new_id,auth.uid() FROM accounting.document_links WHERE entry_id=e.id ON CONFLICT DO NOTHING;
  RETURN result;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';END IF;
END $fn$;

CREATE OR REPLACE FUNCTION accounting.entry_detail(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb; extra jsonb; bank_account uuid;
BEGIN
 PERFORM accounting.require_reader();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'restored_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE restores_entry_id=e.id),
  'replacement_entry_id',(SELECT id FROM accounting.journal_entries WHERE replaces_entry_id=e.id LIMIT 1),
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted' ORDER BY pay_date,id LIMIT 1),
  'payroll_run_ids',(SELECT coalesce(jsonb_agg(id ORDER BY pay_date,id),'[]'::jsonb) FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (coalesce(p.ytd->'patriot_import',p.ytd->'gusto_import')->>'original_entry_id'=e.id::text AND coalesce(p.ytd->'patriot_import',p.ytd->'gusto_import')->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
  -- The own account on the other side of a linked transfer, so either leg can name where the money went or came from.
  'transfer_account_id',CASE WHEN e.transfer_group_id IS NOT NULL THEN (SELECT l.account_id FROM accounting.journal_entries g JOIN accounting.journal_lines l ON l.entry_id=g.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE g.transfer_group_id=e.transfer_group_id AND g.id<>e.id AND g.reverses_entry_id IS NULL AND a.subtype IN ('bank','card','cash') ORDER BY g.entry_date,l.sort_order LIMIT 1) END,
  'payee_name',(SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),
  'context',jsonb_build_object('kind',e.kind,'payee_id',e.payee_id),'prior_treatment',NULL,
  'lines',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id),'[]')) INTO result
 FROM accounting.journal_entries e WHERE e.id=entry;
 IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY a.id),'[]') INTO extra FROM accounting.audit_log a WHERE a.row_id=entry;
 result:=result||jsonb_build_object('audit',extra,'matches','[]'::jsonb,'documents','[]'::jsonb);
 IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
  SELECT l.account_id INTO bank_account FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1;
  IF bank_account IS NOT NULL AND result->>'descriptor_key' IS NOT NULL THEN
   EXECUTE 'SELECT accounting.prior_summary($1,$2,10)' INTO extra USING result->>'descriptor_key',bank_account;
   result:=result||jsonb_build_object('prior_treatment',extra-ARRAY['entries','memo','last_date']);
  END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object(''amount_cents'',m.amount_cents::text)),''[]''::jsonb) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('matches',extra);
  IF result->>'status'='draft' THEN
   -- What the books did to this draft on their own, and the transfer they would suggest when nothing was sure enough to pair.
   IF result->>'fill_source' IS NOT NULL THEN
    result:=result||jsonb_build_object('fill',jsonb_strip_nulls(jsonb_build_object('source',result->>'fill_source',
     'rule_name',CASE WHEN result->>'fill_source'='rule' THEN (SELECT name FROM accounting.rules WHERE id=(result->>'applied_rule_id')::uuid) END,
     'pair_entry_date',(SELECT p.entry_date FROM accounting.journal_entries p WHERE p.id=(result->>'pair_entry_id')::uuid),
     'pair_account_id',(SELECT l.account_id FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=(result->>'pair_entry_id')::uuid AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1))));
   END IF;
   EXECUTE 'SELECT accounting.transfer_candidate($1)' INTO extra USING entry;
   IF extra IS NOT NULL THEN result:=result||jsonb_build_object('transfer_suggestion',extra); END IF;
  END IF;
 END IF;
 IF to_regclass('accounting.document_links') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(d)),''[]''::jsonb) FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('documents',extra);
 END IF;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.payroll(view jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;employees jsonb;coverage jsonb;cutoff date:=coalesce((view->>'through')::date,(view->>'to')::date,(view->>'as_of')::date,(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile));y integer:=coalesce((view->>'year')::integer,extract(year FROM cutoff)::integer);latest accounting.payroll_runs;run accounting.payroll_runs;body jsonb;preview jsonb;record jsonb;posting jsonb;
BEGIN
 PERFORM accounting.require_owner();
 IF view->>'view'='detail' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=(view->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  body:=jsonb_build_object('pay_date',run.pay_date,'period_from',run.period_start,'period_to',run.period_end,'declared_gross_cents',run.gross_cents::text,'declared_net_cents',run.net_cents::text,'components',run.components,'employees',coalesce(run.ytd->'run_employees','[]'),'ytd',run.ytd);
  posting:=CASE WHEN run.entry_id IS NULL THEN NULL ELSE jsonb_build_object('id',run.entry_id,'entry_id',run.entry_id,'mode','new','void',(SELECT jsonb_build_object('effective_date',entry_date,'reason',reason,'reversal_entry_id',id) FROM accounting.journal_entries WHERE reverses_entry_id=run.entry_id)) END;
  record:=jsonb_build_object('run_id',run.id,'revision',run.version,'body',body,'body_text',body::text,'body_hash',encode(sha256(convert_to(body::text,'UTF8')),'hex'),'document_id',run.document_id,'reason','','created_at',run.updated_at,'posting',posting);
  IF run.status='draft' THEN
   BEGIN preview:=accounting.payroll_plan(view);EXCEPTION WHEN raise_exception THEN preview:=jsonb_build_object('ready',false,'issues',jsonb_build_array(SQLERRM),'lines','[]'::jsonb,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text,'officer_cents','0','other_wages_cents','0','reimbursements_cents','0'));END;
  ELSE preview:=jsonb_build_object('ready',false,'issues','[]'::jsonb,'lines',CASE WHEN run.entry_id IS NULL THEN '[]'::jsonb ELSE accounting.entry_detail(run.entry_id)->'lines' END,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text));END IF;
  RETURN jsonb_build_object('id',run.id,'version',run.version,'provider',run.provider,'entry_shared',run.entry_shared,'provider_run_id',run.provider_run_id,'head_revision',run.version,'status',CASE run.status WHEN 'void' THEN 'voided' ELSE run.status END,'import_mode',accounting.payroll_import_mode(run),'import_undone',coalesce((coalesce(run.ytd->'patriot_import',run.ytd->'gusto_import')->>'undone')::boolean,false),'register',record,'preview',preview,'posting',posting,
   'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('run_id',run.id,'revision',a.after->'version','body',a.after,'document_id',a.after->'document_id','reason',a.reason,'created_at',a.at) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.table_name='payroll_runs' AND a.row_id=run.id),'history_count',(SELECT count(*) FROM accounting.audit_log WHERE table_name='payroll_runs' AND row_id=run.id),'history_offset',0);
 END IF;

 IF view?'year' AND NOT (view?'through' OR view?'to' OR view?'as_of') THEN cutoff:=make_date(y,12,31);END IF;
 WITH filtered AS (
  SELECT * FROM accounting.payroll_runs r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'year' IS NULL OR extract(year FROM pay_date)=y) AND pay_date<=cutoff
   AND (view->>'from' IS NULL OR pay_date>=(view->>'from')::date) AND (view->>'status' IS NULL OR r.status=CASE view->>'status' WHEN 'voided' THEN 'void' ELSE view->>'status' END)
   AND (coalesce(view->>'query','')='' OR r.provider_run_id ILIKE '%'||(view->>'query')||'%')
 ), paged AS (SELECT * FROM filtered ORDER BY pay_date DESC,id LIMIT 100 OFFSET greatest(coalesce((view->>'offset')::integer,0),0))
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rows',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('import_mode',accounting.payroll_import_mode(r),'import_undone',coalesce((coalesce(r.ytd->'patriot_import',r.ytd->'gusto_import')->>'undone')::boolean,false),'gross_cents',gross_cents::text,'net_cents',net_cents::text,'employee_withholding_cents',employee_withholding_cents::text,'employer_tax_cents',employer_tax_cents::text) ORDER BY pay_date DESC,id),'[]') FROM paged r),
 'count',count(*),'totals',jsonb_build_object('gross_cents',coalesce(sum(gross_cents) FILTER(WHERE status<>'void'),0)::text,'net_cents',coalesce(sum(net_cents) FILTER(WHERE status<>'void'),0)::text,'drafts',count(*) FILTER(WHERE status='draft'))) INTO result FROM filtered;

 WITH active_runs AS (
  SELECT * FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff)
 ), per_employee AS (
  SELECT x.value FROM active_runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.ytd->'run_employees','[]')) x
 ), employee_totals AS (
  SELECT value->>'key' key,max(value->>'name') name,bool_or((value->>'is_officer')::boolean) is_officer,sum((value->>'gross_cash_cents')::numeric) gross,
   CASE WHEN bool_and(value->>'federal_taxable_cents' IS NOT NULL) THEN sum((value->>'federal_taxable_cents')::numeric)::text END federal_taxable,
   CASE WHEN bool_and(value->>'federal_withheld_cents' IS NOT NULL) THEN sum((value->>'federal_withheld_cents')::numeric)::text END federal_withheld,
   CASE WHEN bool_and(value->>'state_taxable_cents' IS NOT NULL) THEN sum((value->>'state_taxable_cents')::numeric)::text END state_taxable,
   CASE WHEN bool_and(value->>'state_withheld_cents' IS NOT NULL) THEN sum((value->>'state_withheld_cents')::numeric)::text END state_withheld,
   CASE WHEN bool_and(value->>'social_security_wages_cents' IS NOT NULL) THEN sum((value->>'social_security_wages_cents')::numeric)::text END social_security,
   CASE WHEN bool_and(value->>'medicare_wages_cents' IS NOT NULL) THEN sum((value->>'medicare_wages_cents')::numeric)::text END medicare
  FROM per_employee GROUP BY value->>'key')
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'name',name,'is_officer',is_officer,'gross_cash_cents',gross::text,'federal_taxable_cents',federal_taxable,'federal_withheld_cents',federal_withheld,'state_taxable_cents',state_taxable,'state_withheld_cents',state_withheld,'social_security_wages_cents',social_security,'medicare_wages_cents',medicare) ORDER BY name,key),'[]') INTO employees FROM employee_totals;
 SELECT p.* INTO latest FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff) ORDER BY p.pay_date DESC,p.created_at DESC,p.id LIMIT 1;
 IF latest.ytd->>'verified'='true' THEN coverage:=jsonb_build_object('id',latest.id,'tax_year',y,'version',latest.version,'through_date',cutoff,'source_through_date',latest.pay_date,'current',EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=latest.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)),'employees',coalesce(latest.ytd->'employees','[]'),'document_id',latest.document_id,'reason','Verified YTD from the latest recorded payroll run.','created_at',latest.created_at);END IF;
 result:=result||jsonb_build_object('year',y,'through',cutoff,'employees',employees,'coverage',coverage,
  'run_count',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff)),
  'drafts',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.status='draft' AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff));
 result:=result||jsonb_build_object('as_of',cutoff,'offset',coalesce((view->>'offset')::integer,0),'runs',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('head_revision',value->'version','status',CASE value->>'status' WHEN 'void' THEN 'voided' ELSE value->>'status' END)),'[]') FROM jsonb_array_elements(result->'rows')));
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.register_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE tracked accounting.registers;invalid boolean;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  -- Review metadata does not change register balances or reversal dependencies.
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['review_pending','version','updated_at'])=(to_jsonb(OLD)-ARRAY['review_pending','version','updated_at']) THEN RETURN NEW; END IF;
  IF TG_WHEN='AFTER' AND NEW.status='posted' AND NEW.register_id IS NOT NULL THEN
   SELECT * INTO tracked FROM accounting.registers WHERE id=NEW.register_id;
   WITH daily AS(SELECT e.entry_date,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=tracked.account_id),0) cost,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=tracked.contra_account_id),0) contra
    FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=tracked.id AND e.status='posted' GROUP BY e.entry_date),running AS(SELECT sum(cost) OVER(ORDER BY entry_date) cost,sum(contra) OVER(ORDER BY entry_date) contra FROM daily)
    SELECT coalesce(bool_or(CASE WHEN tracked.kind='loan' THEN cost>0 ELSE cost<0 OR contra>0 OR cost+contra<0 END),false) INTO invalid FROM running;
   IF invalid THEN RAISE EXCEPTION 'ACCT_REGISTER_NEGATIVE_BASIS';END IF;
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs p CROSS JOIN LATERAL jsonb_array_elements(p.components) component(value) JOIN accounting.journal_lines l ON l.id=(component.value->>'source_line_id')::uuid WHERE p.status='posted' AND component.value->>'kind'='noncash_reclass' AND l.entry_id=NEW.reverses_entry_id) THEN RAISE EXCEPTION 'ACCT_NONCASH_DEPENDENCY';END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND (SELECT count(*) FROM accounting.payroll_runs WHERE entry_id=NEW.reverses_entry_id AND status='posted')>1 THEN RAISE EXCEPTION 'ACCT_PAYROLL_ENTRY_SHARED';END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE entry_id=NEW.reverses_entry_id AND status='posted') AND current_setting('accounting.action',true)<>'payroll.void' THEN RAISE EXCEPTION 'ACCT_PAYROLL_VOID_REQUIRED';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='payroll_runs' THEN
   IF current_setting('accounting.action',true)='payroll.import.undo' AND OLD.status='posted' AND NEW.status='void'
    AND (to_jsonb(NEW)-ARRAY['status','version','updated_at','entry_id','provider_run_id','ytd'])=(to_jsonb(OLD)-ARRAY['status','version','updated_at','entry_id','provider_run_id','ytd']) THEN
    NEW.version:=OLD.version+1;NEW.updated_at:=now();RETURN NEW;
   END IF;
   IF OLD.status<>'draft' AND (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at']) THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
   IF OLD.status='void' OR (OLD.status='posted' AND NEW.status<>'void') THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
  ELSE
   IF (NEW.kind,NEW.account_id,NEW.contra_account_id,NEW.started_on,NEW.amount_cents) IS DISTINCT FROM (OLD.kind,OLD.account_id,OLD.contra_account_id,OLD.started_on,OLD.amount_cents) AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=OLD.id AND status='posted') THEN RAISE EXCEPTION 'ACCT_REGISTER_FINANCIAL_TERMS_FROZEN';END IF;
  END IF;
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $function$
;

-- 4. The Gusto importer.
CREATE OR REPLACE FUNCTION accounting.payroll_import_totals(lines jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT coalesce(jsonb_object_agg(account,amount),'{}'::jsonb) FROM (
  SELECT value->>'account_id' account,sum((value->>'amount_cents')::bigint) amount FROM jsonb_array_elements(coalesce(lines,'[]'::jsonb))
  GROUP BY value->>'account_id' HAVING sum((value->>'amount_cents')::bigint)<>0) per_account
$fn$;
REVOKE ALL ON FUNCTION accounting.payroll_import_totals(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION accounting.gusto_difference(books jsonb, provider jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',k,'books_cents',b::text,'gusto_cents',p::text,'difference_cents',(b-p)::text) ORDER BY k),'[]'::jsonb)
 FROM (SELECT k,coalesce((books->>k)::bigint,0) b,coalesce((provider->>k)::bigint,0) p FROM (SELECT jsonb_object_keys(books) k UNION SELECT jsonb_object_keys(provider)) account_keys) amounts WHERE b<>p
$fn$;
REVOKE ALL ON FUNCTION accounting.gusto_difference(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION accounting.gusto_import(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
<<gusto_import>>
DECLARE actor uuid:=accounting.require_owner(); committing boolean:=request->>'mode'='commit'; mapping jsonb:=request->'mapping';
 item jsonb; body jsonb; lines jsonb; runs jsonb:='[]'; r jsonb; plan jsonb:='{}'; outcome jsonb:='{}'; pool jsonb; claimed jsonb:='{}'; candidate jsonb; result jsonb:='[]';
 prior accounting.payroll_runs; existing accounting.journal_entries; defaults jsonb; st text; msg text; identity text; day date; employer bigint; employee bigint;
 run_month text; members jsonb; n integer; window_runs jsonb; window_keys jsonb; total jsonb; first_date date; last_date date; pairs jsonb:='[]'; pair jsonb; k text;
 unit jsonb; choice text; link_entry uuid; new_run uuid; saved jsonb; posted jsonb; done jsonb:='{}'; resolution text; group_key text;
BEGIN
 IF committing THEN PERFORM accounting.write_lock(); END IF;
 SELECT ytd->'gusto_import' INTO defaults FROM accounting.payroll_runs
 WHERE ytd?'gusto_import' ORDER BY updated_at DESC,id DESC LIMIT 1;
 -- A first Gusto import starts from the payroll accounts the Patriot importer last used.
 IF request->>'mode'='defaults' THEN RETURN coalesce(defaults,(SELECT jsonb_build_object('mapping',ytd->'patriot_import'->'mapping') FROM accounting.payroll_runs
  WHERE ytd?'patriot_import' ORDER BY updated_at DESC,id DESC LIMIT 1),'{}'); END IF;
 IF request->>'mode' NOT IN ('preview','commit') OR jsonb_typeof(request->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(request->'items') NOT BETWEEN 1 AND 500 OR octet_length(request::text)>3000000
 OR jsonb_typeof(mapping) IS DISTINCT FROM 'object' OR coalesce(mapping->>'wages','')!~'^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF committing AND NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o
 ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=(request->>'document_id')::uuid
 AND d.status<>'archived' AND d.sha256=request->>'content_hash') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items') GROUP BY value->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;

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
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.gusto_import(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.gusto_import(jsonb) TO authenticated;

COMMIT;
