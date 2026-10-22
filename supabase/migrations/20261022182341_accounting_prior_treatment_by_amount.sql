-- A feed draft reuses an earlier treatment of its bank description only when that treatment is
-- unambiguous. One description can carry two kinds of payment: Patriot debits net pay and payroll
-- taxes under the same description, and reusing simply the latest booked the Sep 30 payroll tax
-- debit as net pay. prior_choice reuses the latest when the recent treatments agree, otherwise only
-- the latest of the same amount that is still in use, otherwise none; apply_treatment uses it.

CREATE OR REPLACE FUNCTION accounting.prior_choice(previous jsonb, amount_cents bigint)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- Which earlier treatment a new feed draft reuses, from prior_summary's recent entries (newest
 -- first). Only single-category ones count (a split's proportions may not fit a new purchase), and
 -- only when the latest is one. When they all agree, the latest is the answer. When they disagree,
 -- one description carries more than one kind of payment (Patriot sends net pay and payroll taxes
 -- under one description; the latest alone booked a tax debit as net pay, Oct 2026), so only the
 -- latest entry of the same amount counts, and only if its category is one of the two the
 -- description went to most recently: a vendor moved from one category to another is never pulled
 -- back by an old charge of the same amount. Otherwise none, and the draft waits for a person.
 WITH entries AS (
  SELECT t.ord, t.x->>'payee_id' AS payee_id, t.x->>'memo' AS memo, coalesce(t.x->'lines','[]'::jsonb) AS lines
  FROM jsonb_array_elements(coalesce($1->'entries','[]'::jsonb)) WITH ORDINALITY AS t(x, ord)
 ), singles AS (
  SELECT ord, payee_id, memo, lines->0->>'account_id' AS account_id, abs((lines->0->>'amount_cents')::bigint) AS cents
  FROM entries WHERE jsonb_array_length(lines)=1
 ), in_use AS (
  SELECT account_id FROM singles ORDER BY ord LIMIT 2
 )
 SELECT jsonb_build_object('account_id',s.account_id,'payee_id',s.payee_id,'memo',s.memo)
 FROM singles s
 WHERE EXISTS(SELECT 1 FROM singles WHERE ord=1)
  AND ((SELECT count(DISTINCT account_id) FROM singles)=1
   OR (s.cents=$2 AND s.account_id IN (SELECT account_id FROM in_use)))
 ORDER BY s.ord
 LIMIT 1
$function$
;

REVOKE ALL ON FUNCTION accounting.prior_choice(jsonb,bigint) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.prior_choice(jsonb,bigint) TO "postgres";

CREATE OR REPLACE FUNCTION accounting.apply_treatment(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; bank accounting.journal_lines; candidate jsonb; previous jsonb; result jsonb; party uuid; category uuid;
BEGIN
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF e.status<>'draft' THEN RETURN jsonb_build_object('id',entry,'version',e.version); END IF;
 SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card');
 IF NOT FOUND THEN RETURN jsonb_build_object('id',entry,'version',e.version); END IF;
 SELECT party_id INTO party FROM accounting.payee_aliases a WHERE enabled AND ((match_kind='key' AND pattern=e.descriptor_key) OR (match_kind='exact' AND upper(pattern)=upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g'))) OR (match_kind='prefix' AND left(upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g')),length(pattern))=upper(pattern)))
 ORDER BY CASE match_kind WHEN 'key' THEN 0 WHEN 'exact' THEN 1 ELSE 2 END,length(pattern) DESC,id LIMIT 1;
 IF party IS NOT NULL THEN UPDATE accounting.journal_entries SET payee_id=party WHERE id=entry RETURNING * INTO e; END IF;
 candidate:=accounting.rule_candidate(entry);
 IF candidate IS NOT NULL AND (candidate->>'eligible')::boolean THEN
  IF candidate->'actions'?'splits' THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.split','id',entry,'expected_version',e.version,'splits',candidate->'actions'->'splits','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  ELSE
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',candidate->'actions'->>'account_id','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  END IF;
  UPDATE accounting.journal_entries SET applied_rule_id=(candidate->>'rule_id')::uuid,fill_source='rule',category_source='rule',category_actor=NULL WHERE id=entry RETURNING * INTO e;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after)
  VALUES(CASE WHEN current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE auth.uid() END,
   coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'),
   coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid()),'journal_entries',entry,'rule.applied',candidate,
   jsonb_build_object('version',e.version,'payee_id',e.payee_id,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount_cents::text,'memo',memo) ORDER BY sort_order) FROM accounting.journal_lines WHERE entry_id=entry)));
  IF (candidate->>'auto_post')::boolean AND (SELECT primary_system FROM accounting.settings WHERE id=1)='admin' THEN
   RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',entry,'expected_version',e.version));
  END IF;
 ELSIF e.descriptor_key IS NOT NULL THEN
  -- An earlier treatment of the same description, chosen by prior_choice: the latest when the
  -- recent ones agree, else the latest of the same amount still in use, else none (a person decides).
  previous:=accounting.prior_choice(accounting.prior_summary(e.descriptor_key,bank.account_id,10),abs(bank.amount_cents));
  category:=(previous->>'account_id')::uuid;
  IF category IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',coalesce(e.payee_id::text,previous->>'payee_id'),'memo',coalesce(previous->>'memo',e.memo)));
   UPDATE accounting.journal_entries SET fill_source='prior',category_source='prior',category_actor=NULL WHERE id=entry RETURNING * INTO e;
  END IF;
 END IF;
 -- Still uncategorized after aliases, rules and prior treatment: fall back to the payee's default category.
 IF party IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN
  SELECT p.default_account_id INTO category FROM accounting.parties p WHERE p.id=party AND p.default_account_id IS NOT NULL;
  IF category IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',party::text,'memo',e.memo));
   UPDATE accounting.journal_entries SET fill_source='payee_default',category_source='payee_default',category_actor=NULL WHERE id=entry RETURNING * INTO e;
  END IF;
 END IF;
 -- Last, so a rule or a known treatment always wins: a movement still uncategorized whose one counterpart sits on another own account is proposed as a transfer.
 candidate:=accounting.transfer_candidate(entry);
 IF candidate IS NOT NULL AND candidate->>'signal' IS NOT NULL AND NOT (candidate->>'ambiguous')::boolean THEN
  PERFORM accounting.transfer_pair(entry,(candidate->>'counterpart_id')::uuid,candidate->>'signal');
  SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 END IF;
 RETURN jsonb_build_object('id',entry,'version',e.version);
END $function$
;
