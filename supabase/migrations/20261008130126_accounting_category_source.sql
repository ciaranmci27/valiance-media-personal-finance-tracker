-- How each transaction was categorized, kept through review.
--
-- journal_entries gains category_source and category_actor. The source is one
-- of: person (a member in the browser), api (a member's API key, which is how
-- the finance agent works), rule, prior (last time's category), payee_default
-- (the contact's default category), transfer_pair (a transfer the books
-- matched), wave_import, gusto_import, patriot_import. category_actor names
-- the auth user for person and api only; a rule's name comes from
-- applied_rule_id. Unlike fill_source (draft only, cleared on posting), the
-- source stays on a posted entry and is immutable with it.
--
-- Writers:
-- - ledger_command stamps the source in the same statement that already writes
--   the entry: draft.save, transaction.save and transaction.review (insert and
--   update) and entry.categorize and entry.split. accounting.category_stamp
--   decides it: nothing while any line is uncategorized; the same accounts and
--   amounts keep the existing source (a description, date or contact change
--   never takes credit for a category); otherwise an import marker, else the
--   session's member (person) or the API key's member (api). The feed worker
--   never stamps a person.
-- - apply_treatment and transfer_pair stamp rule, prior, payee_default and
--   transfer_pair next to the fill_source they already set; transfer_unpair
--   clears the source with the category.
-- - entry.correct carries the original's source (and rule) onto the
--   replacement when every account and amount is kept; entry.restore always
--   carries it.
-- - gusto_import and patriot_import set a transaction-local marker
--   (accounting.category_source) while committing, so the journals they create
--   or correct, and the Gusto fees they move, record the import.
--
-- Readers: entry_detail (and so transactions, the API and MCP) adds
-- categorized_by {source, self, actor_name, actor_role, rule_name} when a
-- source is known.
--
-- Guard: a posted entry's source is fixed. Only the one-time backfill below
-- (accounting.action 'entry.source.backfill') may fill a source that was never
-- recorded; it cannot change one.
--
-- Backfill: every live draft and posted entry without a source takes the last
-- operation in the audit log that changed its accounts or amounts, then reads
-- what that operation recorded (an import, the books' fill, a rule, a matched
-- transfer, an API key or a person). Edits and restores that kept every line
-- take the earlier entry's source. What the history cannot tell (fills by the
-- books before 2026-09-19, CSV imports) stays unknown. Each filled entry gets
-- an audit row and a version bump, like any other change.

BEGIN;

ALTER TABLE accounting.journal_entries
  ADD COLUMN IF NOT EXISTS category_source text,
  ADD COLUMN IF NOT EXISTS category_actor uuid;

ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS entries_category_source_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_category_source_check
  CHECK (category_source IN ('person', 'api', 'rule', 'prior', 'payee_default', 'transfer_pair', 'wave_import', 'gusto_import', 'patriot_import'));
ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS entries_category_actor_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_category_actor_check
  CHECK (category_actor IS NULL OR category_source IN ('person', 'api'));
ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS entries_category_actor_fk;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_category_actor_fk
  FOREIGN KEY (category_actor) REFERENCES auth.users(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION accounting.lines_key(lines jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- The same accounts and amounts give the same key, whatever the order or the line ids.
 SELECT string_agg(k,',' ORDER BY k) FROM (SELECT lower(l->>'account_id')||':'||CASE WHEN (l->>'amount_cents') ~ '^-?[0-9]+$' THEN ((l->>'amount_cents')::numeric)::text ELSE coalesce(l->>'amount_cents','') END k
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(lines)='array' THEN lines ELSE '[]'::jsonb END) l) x
$function$
;

CREATE OR REPLACE FUNCTION accounting.entry_lines(entry uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text)),'[]'::jsonb) FROM accounting.journal_lines l WHERE l.entry_id=entry
$function$
;

CREATE OR REPLACE FUNCTION accounting.category_stamp(before_lines jsonb, after_lines jsonb, current_source text, current_actor uuid, actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE kind text:=coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'); marker text:=nullif(current_setting('accounting.category_source',true),'');
BEGIN
 -- Nothing has a source while a line is still uncategorized.
 IF jsonb_typeof(after_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(after_lines)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(after_lines) l JOIN accounting.accounts a ON a.id::text=lower(l->>'account_id') WHERE a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN
  RETURN jsonb_build_object('source',NULL,'actor',NULL);
 END IF;
 -- The same accounts and amounts keep whoever or whatever chose them.
 IF before_lines IS NOT NULL AND accounting.lines_key(before_lines) IS NOT DISTINCT FROM accounting.lines_key(after_lines) THEN
  RETURN jsonb_build_object('source',current_source,'actor',current_actor);
 END IF;
 -- An import names itself; otherwise the person behind the session or the API key. The feed worker never categorizes as anyone.
 IF marker IS NOT NULL THEN RETURN jsonb_build_object('source',marker,'actor',NULL); END IF;
 IF actor IS NULL OR kind NOT IN ('owner','api') THEN RETURN jsonb_build_object('source',NULL,'actor',NULL); END IF;
 RETURN jsonb_build_object('source',CASE WHEN kind='api' THEN 'api' ELSE 'person' END,'actor',actor);
END $function$
;

REVOKE ALL ON FUNCTION accounting.lines_key(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.lines_key(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.entry_lines(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.entry_lines(uuid) TO "postgres";

REVOKE ALL ON FUNCTION accounting.category_stamp(jsonb,jsonb,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.category_stamp(jsonb,jsonb,text,uuid,uuid) TO "postgres";

CREATE OR REPLACE FUNCTION accounting.guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; a accounting.accounts; parent accounting.accounts; d date;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME IN ('audit_log','command_receipts') THEN
  IF TG_TABLE_NAME='command_receipts' THEN
   IF TG_OP='DELETE' AND OLD.created_at<now()-interval '90 days' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'ACCT_APPEND_ONLY';
 END IF;
 IF TG_TABLE_NAME='settings' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_SETTINGS_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN RAISE EXCEPTION 'ACCT_OWNER_IMMUTABLE'; END IF;
 ELSIF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='INSERT' THEN
   NEW.descriptor_key:=accounting.descriptor_key(NEW.source_description);
   PERFORM accounting.require_open(NEW.entry_date);
   INSERT INTO accounting.periods(month) VALUES(date_trunc('month',NEW.entry_date)::date) ON CONFLICT DO NOTHING;
  ELSE
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_description IS DISTINCT FROM OLD.source_description OR NEW.descriptor_key IS DISTINCT FROM OLD.descriptor_key OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_PROVENANCE'; END IF;
   IF OLD.transfer_group_id IS NOT NULL AND NEW.transfer_group_id IS DISTINCT FROM OLD.transfer_group_id THEN RAISE EXCEPTION 'ACCT_TRANSFER_GROUP_IMMUTABLE'; END IF;
   IF OLD.status='discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   -- A proposed transfer leg leaves draft only through transfer.confirm or after an unpair; how a draft was filled is a draft-only marker.
   IF NEW.status<>'draft' AND NEW.pair_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_PAIR_CONFIRM'; END IF;
   IF NEW.status<>'draft' THEN NEW.fill_source:=NULL; END IF;
   -- Who or what categorized a posted entry is fixed with it; only the one-time history backfill may fill a source the books never recorded.
   IF OLD.status='posted' AND (to_jsonb(NEW)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']-CASE WHEN OLD.category_source IS NULL AND current_setting('accounting.action',true)='entry.source.backfill' THEN ARRAY['category_source','category_actor'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']-CASE WHEN OLD.category_source IS NULL AND current_setting('accounting.action',true)='entry.source.backfill' THEN ARRAY['category_source','category_actor'] ELSE ARRAY[]::text[] END) THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF OLD.status<>'posted' THEN PERFORM accounting.require_open(OLD.entry_date); PERFORM accounting.require_open(NEW.entry_date); END IF;
   -- A closed bank or card account takes nothing dated after its closing day; history up to it stays editable.
   IF NEW.entry_date>OLD.entry_date AND NEW.status<>'discarded' AND EXISTS(SELECT 1 FROM accounting.journal_lines cl JOIN accounting.accounts ca ON ca.id=cl.account_id WHERE cl.entry_id=NEW.id AND ca.closed_on<NEW.entry_date) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CLOSED'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
   SELECT * INTO e FROM accounting.journal_entries WHERE id=NEW.reverses_entry_id;
   IF e.status<>'posted' OR NEW.entry_date<e.entry_date OR btrim(NEW.reason)='' THEN RAISE EXCEPTION 'ACCT_INVALID_REVERSAL_DATE_OR_REASON'; END IF;
  END IF;
  IF NEW.replaces_entry_id IS NOT NULL THEN
   SELECT * INTO e FROM accounting.journal_entries WHERE id=NEW.replaces_entry_id;
   IF NEW.entry_date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) OR btrim(NEW.reason)='' THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.entry_id<>OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  PERFORM accounting.require_open(e.entry_date);
  IF TG_OP<>'DELETE' THEN
   SELECT * INTO a FROM accounting.accounts WHERE id=NEW.account_id;
   IF a.is_archived THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
   IF a.closed_on<e.entry_date THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CLOSED'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  IF TG_OP<>'DELETE' AND (
   (NEW.subtype IN ('bank','cash','undeposited','transit','fixed_asset','accumulated_depreciation','receivable') AND NEW.type<>'asset') OR
   (NEW.subtype IN ('card','loan','payroll_liability') AND NEW.type<>'liability') OR
   (NEW.subtype IN ('owner_equity','retained_earnings','opening_balance') AND NEW.type<>'equity') OR
   (NEW.subtype='revenue' AND NEW.type<>'income') OR
   (NEW.subtype IN ('operating_expense','payroll_expense') AND NEW.type<>'expense') OR
   (NEW.subtype IN ('bank','cash','card') AND NEW.is_contra) OR
   (NEW.subtype='accumulated_depreciation' AND NOT NEW.is_contra)
  ) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND';END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
   IF (NEW.type,NEW.subtype,NEW.is_contra) IS DISTINCT FROM (OLD.type,OLD.subtype,OLD.is_contra) AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.journal_entries posted_entry ON posted_entry.id=l.entry_id WHERE l.account_id=OLD.id AND posted_entry.status='posted') THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
   IF NEW.system_purpose IS DISTINCT FROM OLD.system_purpose AND OLD.system_purpose IS NOT NULL THEN RAISE EXCEPTION 'ACCT_SYSTEM_ACCOUNT'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
   SELECT * INTO parent FROM accounting.accounts WHERE id=NEW.parent_id;
   IF parent.parent_id IS NOT NULL OR parent.type<>NEW.type OR EXISTS(SELECT 1 FROM accounting.accounts WHERE parent_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_INVALID_ACCOUNT_PARENT'; END IF;
  END IF;
  IF NEW.is_archived AND (NEW.system_purpose IS NOT NULL OR coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.journal_entries posted_entry ON posted_entry.id=l.entry_id WHERE l.account_id=NEW.id AND posted_entry.status='posted'),0)<>0) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
 ELSIF TG_TABLE_NAME='periods' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.month<>OLD.month THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
   IF OLD.status='locked' AND NEW.status='open' AND btrim(NEW.reopen_reason)='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.status='locked' AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE status='draft' AND entry_date>=NEW.month AND entry_date<(NEW.month+interval '1 month')::date) THEN RAISE EXCEPTION 'ACCT_DRAFTS_REMAIN'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$
;

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
  previous:=accounting.prior_summary(e.descriptor_key,bank.account_id,1);
  -- Reuse a single-category treatment only. A past split's proportions may not fit this purchase.
  IF jsonb_array_length(coalesce(previous->'entries'->0->'lines','[]'))=1 THEN
   category:=(previous->>'last_category')::uuid;
   IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
    result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',coalesce(e.payee_id::text,previous->>'payee_id'),'memo',coalesce(previous->>'memo',e.memo)));
    UPDATE accounting.journal_entries SET fill_source='prior',category_source='prior',category_actor=NULL WHERE id=entry RETURNING * INTO e;
   END IF;
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

CREATE OR REPLACE FUNCTION accounting.ledger_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type'; k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid()); actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 e accounting.journal_entries; account_row accounting.accounts; v integer; x jsonb; line jsonb; idx integer; r jsonb; replacement jsonb; reversal jsonb;
 preserved uuid[]:='{}'; seen uuid[]:='{}'; existing_line uuid; original_date date; category uuid; bank_line accounting.journal_lines; carried jsonb:='[]'; total numeric; allocated bigint; remain bigint; share_sum bigint;
 closing date; later integer; first_later date; closing_balance bigint; books_today date; stamp jsonb; before_lines jsonb; kept boolean;
BEGIN
 IF t='cash.allocate' THEN
  SELECT * INTO bank_line FROM accounting.journal_lines WHERE id=k;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=bank_line.entry_id;
  IF e.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE';END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=bank_line.account_id AND subtype IN ('bank','cash','card')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED';END IF;
  IF btrim(coalesce(c->>'reason',''))='' OR jsonb_array_length(c->'allocations')<>1 THEN RAISE EXCEPTION 'ACCT_CASH_OVERRIDE_SINGLE_CLASS';END IF;
  IF (c->'allocations'->0->>'amount_cents')::bigint IS DISTINCT FROM bank_line.amount_cents THEN RAISE EXCEPTION 'ACCT_INVALID_CASH_ALLOCATION';END IF;
  UPDATE accounting.journal_lines SET cash_class=CASE c->'allocations'->0->>'classification' WHEN 'internal_transfer' THEN 'transfer' ELSE c->'allocations'->0->>'classification' END WHERE id=k;
  UPDATE accounting.journal_entries SET reason=c->>'reason' WHERE id=e.id RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t='entry.bulkpost' THEN
  r:='[]';
  IF jsonb_typeof(c->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'entries') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
   r:=r||jsonb_build_array(accounting.ledger_command(x||jsonb_build_object('type','entry.post')));
  END LOOP;
  RETURN jsonb_build_object('id',k,'entries',r);
 ELSIF t='chart.seed' THEN
  IF jsonb_typeof(c->'accounts')<>'array' OR jsonb_array_length(c->'accounts') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'accounts') supplied(value) JOIN accounting.accounts a ON a.id=(supplied.value->>'id')::uuid) THEN RAISE EXCEPTION 'ACCT_CHART_EXISTS'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'accounts') LOOP
   PERFORM accounting.ledger_command(x||jsonb_build_object('type','account.create'));
  END LOOP;
  RETURN jsonb_build_object('id',k);
 ELSIF t='account.create' THEN
  INSERT INTO accounting.accounts(id,code,name,type,subtype,is_contra,parent_id,system_purpose,external_names)
  VALUES(k,nullif(c->>'code',''),c->>'name',c->>'account_type',
    CASE WHEN c->>'subtype' IN ('bank','cash','card','receivable','transit','undeposited','fixed_asset','accumulated_depreciation','loan','payroll_liability','owner_equity','retained_earnings','opening_balance','revenue','operating_expense','payroll_expense','other','cogs','uncategorized') THEN c->>'subtype' ELSE coalesce(nullif(nullif(c->>'cash_kind',''),'none'),nullif(c->>'subtype',''),'other') END,
    CASE WHEN c ? 'normal_side' THEN (c->>'normal_side')<>CASE WHEN c->>'account_type' IN ('asset','expense') THEN 'debit' ELSE 'credit' END ELSE coalesce((c->>'is_contra')::boolean,false) END,
    coalesce(c->>'parent_account_id',c->>'parent_id')::uuid,nullif(coalesce(c->>'purpose',c->>'system_purpose'),''),coalesce(c->'external_names','{}')) RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t='account.update' THEN
  SELECT * INTO account_row FROM accounting.accounts WHERE id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM account_row.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.accounts SET name=coalesce(c->>'name',name),code=CASE WHEN c?'code' THEN nullif(c->>'code','') ELSE code END,
   subtype=CASE WHEN c->>'subtype' IN ('bank','cash','card','receivable','transit','undeposited','fixed_asset','accumulated_depreciation','loan','payroll_liability','owner_equity','retained_earnings','opening_balance','revenue','operating_expense','payroll_expense','other','cogs','uncategorized') THEN c->>'subtype' ELSE coalesce(nullif(nullif(c->>'cash_kind',''),'none'),nullif(c->>'subtype',''),subtype) END,
   parent_id=CASE WHEN c?'parent_account_id' OR c?'parent_id' THEN coalesce(c->>'parent_account_id',c->>'parent_id')::uuid ELSE parent_id END,
   system_purpose=CASE WHEN c?'purpose' THEN nullif(c->>'purpose','') ELSE system_purpose END,
   is_archived=coalesce((c->>'is_archived')::boolean,is_archived),external_names=coalesce(c->'external_names',external_names)
   WHERE id=k RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t IN ('account.close','account.reopen') THEN
  -- Closing keeps every past entry and balance; it stops new money after the closing day and stops the bank feed.
  SELECT * INTO account_row FROM accounting.accounts WHERE id=k FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM account_row.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF account_row.subtype NOT IN ('bank','card','cash') THEN RAISE EXCEPTION 'ACCT_CLOSE_KIND'; END IF;
  IF t='account.reopen' THEN
   IF account_row.closed_on IS NULL THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   UPDATE accounting.accounts SET closed_on=NULL WHERE id=k RETURNING version INTO v;
   -- The feed link closed with the account syncs again, unless a newer link has opened since.
   IF NOT EXISTS(SELECT 1 FROM accounting.bank_accounts WHERE account_id=k AND NOT is_closed) THEN
    UPDATE accounting.bank_accounts SET is_closed=false,closed_on=NULL WHERE id=(SELECT ob.id FROM accounting.bank_accounts ob WHERE ob.account_id=k AND ob.is_closed AND ob.closed_on=account_row.closed_on ORDER BY ob.updated_at DESC,ob.id LIMIT 1);
   END IF;
   RETURN jsonb_build_object('id',k,'version',v);
  END IF;
  IF account_row.closed_on IS NOT NULL THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  books_today:=(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile WHERE id=1);
  -- By default the account closes on the last day anything touched it.
  closing:=coalesce((c->>'closed_on')::date,(SELECT max(ce.entry_date) FROM accounting.journal_lines cl JOIN accounting.journal_entries ce ON ce.id=cl.entry_id WHERE cl.account_id=k AND ce.status<>'discarded'),books_today);
  IF closing>books_today THEN RAISE EXCEPTION 'ACCT_CLOSE_DATE'; END IF;
  SELECT count(DISTINCT ce.id),min(ce.entry_date) INTO later,first_later FROM accounting.journal_lines cl JOIN accounting.journal_entries ce ON ce.id=cl.entry_id WHERE cl.account_id=k AND ce.status<>'discarded' AND ce.entry_date>closing;
  IF later>0 THEN RAISE EXCEPTION 'ACCT_CLOSE_LATER_ENTRIES %',jsonb_build_object('count',later,'first',first_later,'closed_on',closing); END IF;
  SELECT count(DISTINCT ce.id) INTO later FROM accounting.journal_lines cl JOIN accounting.journal_entries ce ON ce.id=cl.entry_id WHERE cl.account_id=k AND ce.status='draft';
  IF later>0 THEN RAISE EXCEPTION 'ACCT_CLOSE_DRAFTS %',jsonb_build_object('count',later); END IF;
  SELECT coalesce(sum(cl.amount_cents),0) INTO closing_balance FROM accounting.journal_lines cl JOIN accounting.journal_entries ce ON ce.id=cl.entry_id WHERE cl.account_id=k AND ce.status='posted' AND ce.entry_date<=closing;
  IF closing_balance<>0 THEN RAISE EXCEPTION 'ACCT_CLOSE_BALANCE %',jsonb_build_object('balance_cents',closing_balance::text,'closed_on',closing,'kind',account_row.subtype); END IF;
  UPDATE accounting.accounts SET closed_on=closing WHERE id=k RETURNING version INTO v;
  UPDATE accounting.bank_accounts SET is_closed=true,closed_on=closing WHERE account_id=k AND NOT is_closed;
  RETURN jsonb_build_object('id',k,'version',v,'closed_on',closing);
 ELSIF t IN ('draft.save','transaction.save','transaction.review') THEN
  IF jsonb_typeof(c->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'lines')>100 THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  IF FOUND THEN
   IF (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF e.pair_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_PAIR_CONFIRM'; END IF;
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(l.id),ARRAY[]::uuid[]) FROM accounting.journal_lines l WHERE l.entry_id=$1 AND EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id)' INTO preserved USING k;
   END IF;
   stamp:=accounting.category_stamp(accounting.entry_lines(k),c->'lines',e.category_source,e.category_actor,actor);
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND NOT (id=ANY(preserved));
   UPDATE accounting.journal_entries SET entry_date=(c->>'entry_date')::date,memo=c->>'memo',kind=coalesce(c->'context'->>'kind',c->>'kind',kind),
    payee_id=CASE WHEN c?'payee_id' OR c->'context'?'payee_id' THEN coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid ELSE payee_id END,fill_source=NULL,
    category_source=stamp->>'source',category_actor=(stamp->>'actor')::uuid WHERE id=k RETURNING version INTO v;
  ELSE
   IF coalesce((c->>'expected_version')::integer,-1)<>0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   stamp:=accounting.category_stamp(NULL,c->'lines',NULL,NULL,actor);
   INSERT INTO accounting.journal_entries(id,entry_date,memo,source_description,origin,kind,payee_id,created_by,register_id,reason,category_source,category_actor)
    VALUES(k,(c->>'entry_date')::date,c->>'memo',c->>'source_description',coalesce(c->>'origin','manual'),coalesce(c->'context'->>'kind',c->>'kind','manual'),
    coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid,actor,(c->>'register_id')::uuid,coalesce(c->>'reason',''),stamp->>'source',(stamp->>'actor')::uuid) RETURNING version INTO v;
  END IF;
  idx:=0;
  FOR line IN SELECT value FROM jsonb_array_elements(c->'lines') LOOP
   IF coalesce(line->>'amount_cents','') !~ '^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
   SELECT id INTO existing_line FROM accounting.journal_lines WHERE id=ANY(preserved) AND NOT(id=ANY(seen))
    AND account_id=(line->>'account_id')::uuid AND amount_cents=(line->>'amount_cents')::bigint ORDER BY sort_order LIMIT 1;
   IF FOUND THEN
    seen:=array_append(seen,existing_line);
    UPDATE accounting.journal_lines SET memo=coalesce(line->>'memo','') WHERE id=existing_line;
   ELSE
    WHILE EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=k AND sort_order=idx) LOOP idx:=idx+1; END LOOP;
    INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
     VALUES(k,(line->>'account_id')::uuid,(line->>'amount_cents')::bigint,coalesce(line->>'memo',''),idx,line->>'cash_class');
    idx:=idx+1;
   END IF;
  END LOOP;
  IF cardinality(seen)<>cardinality(preserved) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  IF t='transaction.review' THEN
   IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
   RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t IN ('entry.review','entry.post','entry.discard','draft.discard','entry.reverse','entry.correct','entry.context','entry.categorize','entry.split','entry.annotate') THEN
  IF t='entry.annotate' THEN k:=(c->>'entry_id')::uuid; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF t<>'entry.annotate' AND (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- Recategorizing or discarding one leg of a proposed transfer frees the other leg first.
  IF e.pair_entry_id IS NOT NULL AND t IN ('entry.categorize','entry.split','entry.discard','draft.discard') THEN
   PERFORM accounting.transfer_unpair(k); SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  END IF;
  IF t='entry.review' THEN
   IF jsonb_typeof(c->'reviewed') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
   IF e.status='discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   IF e.reverses_entry_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id) THEN RAISE EXCEPTION 'ACCT_REVERSED_ENTRY'; END IF;
   IF (c->>'reviewed')::boolean THEN
    IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
    IF e.status='draft' THEN
     RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',e.version));
    END IF;
   END IF;
   IF e.status='posted' AND e.review_pending IS DISTINCT FROM NOT (c->>'reviewed')::boolean THEN
    UPDATE accounting.journal_entries SET review_pending=NOT (c->>'reviewed')::boolean WHERE id=k RETURNING version INTO v;
   ELSE v:=e.version;
   END IF;
  ELSIF t='entry.post' THEN
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
   UPDATE accounting.journal_entries SET status='posted',posted_at=now(),review_pending=false WHERE id=k RETURNING version INTO v;
  ELSIF t IN ('entry.discard','draft.discard') THEN
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING k;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING k;
   END IF;
   UPDATE accounting.journal_entries SET status='discarded',reason=c->>'reason' WHERE id=k RETURNING version INTO v;
  ELSIF t IN ('entry.reverse','entry.correct') THEN
   IF e.status<>'posted' THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=k) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
   original_date:=coalesce(c->>'reversal_date',c->>'entry_date')::date;
   IF original_date IS NULL OR original_date<e.entry_date OR btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_INVALID_REVERSAL_DATE_OR_REASON'; END IF;
   IF t='entry.correct' AND (e.register_id IS NOT NULL OR e.transfer_group_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id AND p.status='posted')
    OR EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND EXISTS(SELECT 1 FROM accounting.reconciliation_items ri WHERE ri.journal_line_id=l.id)))
   THEN RAISE EXCEPTION 'ACCT_CORRECTION_LINKED'; END IF;
   IF t='entry.correct' THEN
    -- Bank evidence follows an edit as long as the bank side stays exactly as the bank reported it.
    SELECT coalesce(jsonb_agg(jsonb_build_object('bank_transaction_id',m.bank_transaction_id,'amount_cents',m.amount_cents,'account_id',l.account_id,'line_cents',l.amount_cents) ORDER BY m.amount_cents DESC),'[]') INTO carried
     FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id;
    IF jsonb_array_length(carried)>0 THEN
     IF (c->>'entry_date')::date<>e.entry_date THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
     IF EXISTS(SELECT 1 FROM (SELECT l.account_id,l.amount_cents,count(DISTINCT l.id) n FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id GROUP BY l.account_id,l.amount_cents) need
      WHERE need.n>(SELECT count(*) FROM jsonb_array_elements(c->'lines') nl WHERE (nl->>'account_id')::uuid=need.account_id AND (nl->>'amount_cents')::bigint=need.amount_cents))
     THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
    END IF;
   END IF;
   INSERT INTO accounting.journal_entries(entry_date,memo,origin,kind,reverses_entry_id,reason,created_by,payee_id)
    VALUES(original_date,'Reversal: '||left(e.memo,990),'internal','correction',e.id,c->>'reason',actor,e.payee_id) RETURNING id,version INTO k,v;
   INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
    SELECT k,account_id,-amount_cents,memo,sort_order,cash_class FROM accounting.journal_lines WHERE entry_id=e.id;
   IF t='entry.reverse' THEN
    UPDATE accounting.journal_entries SET bank_restore_matches=(SELECT coalesce(jsonb_agg(jsonb_build_object('bank_transaction_id',m.bank_transaction_id,'sort_order',l.sort_order,'amount_cents',m.amount_cents::text)),'[]') FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id) WHERE id=k RETURNING version INTO v;
   END IF;
   reversal:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    -- A reversal removes the financial treatment, so its bank evidence returns to review.
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING e.id;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING e.id;
   END IF;
   IF t='entry.reverse' THEN
    UPDATE accounting.bank_transactions b SET review='excluded',excluded_reason='Transaction reversed: '||e.id::text
    WHERE b.id IN (SELECT (value->>'bank_transaction_id')::uuid FROM accounting.journal_entries re CROSS JOIN LATERAL jsonb_array_elements(re.bank_restore_matches) WHERE re.id=k)
    AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=b.id);
   END IF;
   IF t='entry.correct' THEN
    IF (c->>'entry_date')::date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
    replacement:=accounting.ledger_command(c||jsonb_build_object('type','draft.save','id',coalesce((c->>'replacement_id')::uuid,gen_random_uuid()),'expected_version',0,'origin','internal','kind','correction','payee_id',e.payee_id));
    k:=(replacement->>'id')::uuid;
    -- An edit that keeps every account and amount keeps whoever or whatever chose them.
    kept:=accounting.lines_key(accounting.entry_lines(e.id)) IS NOT DISTINCT FROM accounting.lines_key(accounting.entry_lines(k));
    UPDATE accounting.journal_entries SET replaces_entry_id=e.id,category_source=CASE WHEN kept THEN e.category_source ELSE category_source END,
     category_actor=CASE WHEN kept THEN e.category_actor ELSE category_actor END,applied_rule_id=CASE WHEN kept AND e.category_source='rule' THEN e.applied_rule_id ELSE applied_rule_id END
     WHERE id=k RETURNING version INTO v;
    replacement:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
    FOR x IN SELECT value FROM jsonb_array_elements(carried) LOOP
     SELECT l.* INTO bank_line FROM accounting.journal_lines l WHERE l.entry_id=k AND l.account_id=(x->>'account_id')::uuid AND l.amount_cents=(x->>'line_cents')::bigint
      AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id AND m.bank_transaction_id=(x->>'bank_transaction_id')::uuid) ORDER BY l.sort_order LIMIT 1;
     INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES((x->>'bank_transaction_id')::uuid,bank_line.id,(x->>'amount_cents')::bigint,actor);
    END LOOP;
    INSERT INTO accounting.document_links(document_id,entry_id,created_by)
     SELECT document_id,k,actor FROM accounting.document_links WHERE entry_id=e.id ON CONFLICT DO NOTHING;
    RETURN replacement||jsonb_build_object('reversal_id',reversal->'id','original_id',e.id);
   END IF;
   RETURN reversal;
  ELSIF t IN ('entry.context','entry.annotate') THEN
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),
    payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END,
    kind=CASE WHEN c?'kind' THEN c->>'kind' ELSE kind END,
    reason=coalesce(c->>'note',c->>'reason',reason),register_id=CASE WHEN c?'register_id' THEN (c->>'register_id')::uuid ELSE register_id END WHERE id=k RETURNING version INTO v;
   IF t='entry.annotate' THEN
    INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,after)
     VALUES(auth.uid(),'owner',current_setting('accounting.operation_id')::uuid,'journal_entries',k,'entry.annotate',jsonb_build_object('note_id',c->'id','note',c->'note'));
   END IF;
  ELSE
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   SELECT l.* INTO bank_line FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id
    WHERE l.entry_id=k AND a.subtype IN ('bank','card','cash');
   IF NOT FOUND OR (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.subtype IN ('bank','card','cash'))<>1 THEN RAISE EXCEPTION 'ACCT_SIMPLE_MOVEMENT_REQUIRED'; END IF;
   before_lines:=accounting.entry_lines(k);
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND id<>bank_line.id;
   -- Preserve the bank line's identity so existing observation matches stay attached.
   IF t='entry.categorize' THEN
    category:=coalesce(c->>'account_id',c->>'category_id')::uuid;
    IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REQUIRED'; END IF;
    INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,sort_order) VALUES(k,category,-bank_line.amount_cents,CASE WHEN bank_line.sort_order=0 THEN 1 ELSE 0 END);
   ELSE
    IF jsonb_typeof(c->'splits') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'splits') NOT BETWEEN 2 AND 99 THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'splits') WHERE (value?'share_bps') IS DISTINCT FROM ((c->'splits'->0)?'share_bps')) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
    IF (c->'splits'->0)?'share_bps' THEN
     SELECT sum((value->>'share_bps')::bigint) INTO share_sum FROM jsonb_array_elements(c->'splits');
     IF share_sum<>10000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'splits') WHERE (value->>'share_bps')::bigint<=0) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
     total:=abs(bank_line.amount_cents::numeric);
     SELECT (total-sum(trunc(total*(value->>'share_bps')::numeric/10000)))::bigint INTO remain FROM jsonb_array_elements(c->'splits');
    END IF;
    -- Allocation below works for exact-cent splits or basis-point shares without floating point.
    idx:=0; total:=0;
    FOR line IN SELECT value FROM jsonb_array_elements(c->'splits') LOOP
     IF line?'share_bps' THEN
      SELECT (trunc(abs(bank_line.amount_cents::numeric)*(line->>'share_bps')::numeric/10000)+CASE WHEN rank<=remain THEN 1 ELSE 0 END)::bigint * CASE WHEN bank_line.amount_cents>0 THEN -1 ELSE 1 END INTO allocated
      FROM (SELECT ordinality-1 ordinal,row_number() OVER(ORDER BY mod(abs(bank_line.amount_cents::numeric)*(value->>'share_bps')::numeric,10000) DESC,ordinality) rank FROM jsonb_array_elements(c->'splits') WITH ORDINALITY) ranked WHERE ordinal=idx;
     ELSE
      IF coalesce(line->>'amount_cents','')!~'^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
      allocated:=(line->>'amount_cents')::bigint;
     END IF;
     IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(line->>'account_id')::uuid AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REQUIRED'; END IF;
     IF allocated=0 OR sign(allocated)=sign(bank_line.amount_cents) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
     total:=total+allocated;
     INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order) VALUES(k,(line->>'account_id')::uuid,allocated,coalesce(line->>'memo',''),CASE WHEN idx>=bank_line.sort_order THEN idx+1 ELSE idx END);
     idx:=idx+1;
    END LOOP;
    IF total<>-bank_line.amount_cents THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
   END IF;
   stamp:=accounting.category_stamp(before_lines,accounting.entry_lines(k),e.category_source,e.category_actor,actor);
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),kind=coalesce(c->>'kind',kind),payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END,fill_source=NULL,
    category_source=stamp->>'source',category_actor=(stamp->>'actor')::uuid WHERE id=k RETURNING version INTO v;
   IF coalesce((c->>'remember')::boolean,false) AND e.descriptor_key IS NOT NULL THEN
    PERFORM accounting.banking_command(jsonb_build_object('type','alias.save','id',gen_random_uuid(),'party_id',c->'payee_id','match_kind','key','pattern',e.descriptor_key,'enabled',true,'expected_version',0));
   END IF;
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.transfer_pair(first_entry uuid, second_entry uuid, signal text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE transit uuid; leg uuid; other uuid; ver integer;
BEGIN
 SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit' AND NOT is_archived;
 IF transit IS NULL THEN RETURN; END IF;
 -- Both bank drafts stay, each moved to transit and pointed at the other; the bank line ids survive so their matches stay attached.
 FOR leg,other IN SELECT v.x,v.y FROM (VALUES(first_entry,second_entry),(second_entry,first_entry)) v(x,y) LOOP
  SELECT version INTO ver FROM accounting.journal_entries WHERE id=leg;
  PERFORM accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',leg,'expected_version',ver,'account_id',transit,'kind','transfer'));
  UPDATE accounting.journal_entries SET pair_entry_id=other,fill_source='transfer_pair',category_source='transfer_pair',category_actor=NULL WHERE id=leg;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,after)
  VALUES(CASE WHEN current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE auth.uid() END,
   coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'),
   coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid()),'journal_entries',leg,'transfer.paired',
   jsonb_build_object('pair_entry_id',other,'signal',signal));
 END LOOP;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.transfer_unpair(entry uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE other uuid; leg uuid; bank accounting.journal_lines; suspense uuid;
BEGIN
 SELECT pair_entry_id INTO other FROM accounting.journal_entries WHERE id=entry AND status='draft';
 IF other IS NULL THEN RETURN; END IF;
 -- Both legs go back to uncategorized; the unpaired mark keeps the books from proposing either of them again.
 FOR leg IN SELECT id FROM accounting.journal_entries WHERE id IN (entry,other) AND status='draft' AND pair_entry_id IS NOT NULL LOOP
  SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=leg AND a.subtype IN ('bank','cash','card') ORDER BY l.sort_order LIMIT 1;
  SELECT id INTO suspense FROM accounting.accounts WHERE system_purpose=CASE WHEN bank.amount_cents>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
  DELETE FROM accounting.journal_lines WHERE entry_id=leg AND id<>bank.id;
  INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,sort_order) VALUES(leg,suspense,-bank.amount_cents,CASE WHEN bank.sort_order=0 THEN 1 ELSE 0 END);
  UPDATE accounting.journal_entries SET pair_entry_id=NULL,fill_source=NULL,category_source=NULL,category_actor=NULL,kind=CASE WHEN bank.amount_cents>0 THEN 'income' ELSE 'expense' END WHERE id=leg;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,after)
  VALUES(CASE WHEN current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE auth.uid() END,
   coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'),
   coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid()),'journal_entries',leg,'transfer.unpaired',
   jsonb_build_object('pair_entry_id',CASE WHEN leg=entry THEN other ELSE entry END));
 END LOOP;
END $function$
;

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
  -- Who or what chose the category, kept through review: a person, an API key's member, a rule, the books' own fill, a matched transfer or an import.
  'categorized_by',CASE WHEN e.category_source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('source',e.category_source,
   'self',CASE WHEN e.category_actor IS NOT NULL THEN e.category_actor=auth.uid() END,
   'actor_name',(SELECT m.name FROM public.team_members m WHERE m.auth_user_id=e.category_actor),
   'actor_role',(SELECT m.role FROM public.team_members m WHERE m.auth_user_id=e.category_actor),
   'rule_name',CASE WHEN e.category_source='rule' THEN (SELECT r.name FROM accounting.rules r WHERE r.id=e.applied_rule_id) END)) END,
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
  -- The restored lines are the original's, so is whoever or whatever chose them.
  INSERT INTO accounting.journal_entries(entry_date,memo,origin,kind,payee_id,reason,restores_entry_id,created_by,category_source,category_actor,applied_rule_id)
   VALUES(restore_date,e.memo,'internal',e.kind,e.payee_id,c->>'reason',e.id,auth.uid(),e.category_source,e.category_actor,CASE WHEN e.category_source='rule' THEN e.applied_rule_id END) RETURNING id,version INTO new_id,v;
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

CREATE OR REPLACE FUNCTION accounting.patriot_import(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
<<patriot_import>>
DECLARE actor uuid:=accounting.require_owner(); committing boolean:=request->>'mode'='commit';
 item jsonb; body jsonb; part jsonb; lines jsonb; signature jsonb; candidates jsonb; result jsonb:='[]';
 prior accounting.payroll_runs; saved jsonb; posted jsonb; defaults jsonb; state text; message text;
 run_id uuid; entry_id uuid; pay_date date; employer bigint; identity text; choice text; candidate jsonb; existing accounting.journal_entries; correction boolean;
BEGIN
 -- Entries this import writes or corrects record it as their category source.
 IF committing THEN PERFORM accounting.write_lock(); PERFORM set_config('accounting.category_source','patriot_import',true); END IF;
 SELECT ytd->'patriot_import' INTO defaults FROM accounting.payroll_runs
 WHERE ytd?'patriot_import' ORDER BY updated_at DESC,id DESC LIMIT 1;
 IF request->>'mode'='defaults' THEN RETURN coalesce(defaults,'{}'); END IF;
 IF request->>'mode' NOT IN ('preview','commit') OR jsonb_typeof(request->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(request->'items') NOT BETWEEN 1 AND 500 OR octet_length(request::text)>2000000
 OR coalesce(request->>'company_id','')='' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF committing AND NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o
 ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=(request->>'document_id')::uuid
 AND d.status<>'archived' AND d.sha256=request->>'content_hash') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items') GROUP BY value->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(request->'items') LOOP
  body:=item->'body'; identity:=item->>'key'; pay_date:=(body->>'pay_date')::date; entry_id:=NULL; run_id:=NULL;
  state:='new'; message:='Ready to create'; candidates:='[]'; choice:=item->>'choice';
  IF coalesce(identity,'')!~'^Patriot [0-9-]{10} [a-f0-9]{64}$' OR coalesce(item->>'fingerprint','')!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(body->'components') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(body->'components') p WHERE
   p->>'kind' NOT IN ('officer_wages','other_wages','net_pay','employee_tax','employer_tax') OR
   coalesce(p->>'amount_cents','')!~'^[0-9]{1,18}$' OR (p->>'amount_cents')::bigint<=0)
  THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS'; END IF;
  SELECT coalesce(sum((value->>'amount_cents')::bigint),0) INTO employer FROM jsonb_array_elements(body->'components') WHERE value->>'kind'='employer_tax';
  SELECT jsonb_agg(jsonb_build_object('account_id',account,'amount_cents',amount::text) ORDER BY account),
         jsonb_agg(jsonb_build_array(account,amount::text) ORDER BY account) INTO lines,signature FROM (
   SELECT account,sum(amount)::bigint amount FROM (
    SELECT (p->>'account_id')::uuid account, (p->>'amount_cents')::bigint * CASE WHEN p->>'kind' IN ('net_pay','employee_tax') THEN -1 ELSE 1 END amount FROM jsonb_array_elements(body->'components') p
    UNION ALL SELECT (p->>'offset_account_id')::uuid,-(p->>'amount_cents')::bigint FROM jsonb_array_elements(body->'components') p WHERE p->>'kind'='employer_tax'
   ) raw GROUP BY account HAVING sum(amount)<>0) grouped;
  IF jsonb_array_length(lines)<2 OR (SELECT sum((value->>'amount_cents')::numeric) FROM jsonb_array_elements(lines))<>0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
  SELECT * INTO prior FROM accounting.payroll_runs WHERE provider_run_id=identity;
  IF FOUND THEN
   run_id:=prior.id; entry_id:=prior.entry_id;
   IF prior.status='posted' AND prior.ytd->'patriot_import'->>'fingerprint'=item->>'fingerprint'
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=prior.entry_id) THEN state:='duplicate';message:='Already imported';
   ELSE state:='conflict';message:='This payroll was changed, voided, or is unfinished. Review the existing record.'; END IF;
  ELSIF EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.period_start=(body->>'period_from')::date AND p.period_end=(body->>'period_to')::date AND NOT coalesce((p.ytd->'patriot_import'->>'undone')::boolean,false)) THEN
   state:='conflict';message:='A payroll already covers this period. Check its pay date and employee scope before importing.';
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo) ORDER BY e.id),'[]') INTO candidates
   FROM accounting.journal_entries e WHERE e.entry_date=pay_date AND e.status='posted'
   AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
   AND NOT EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE accounting.payroll_runs.entry_id=e.id)
   AND signature=(SELECT jsonb_agg(jsonb_build_array(account_id,amount::text) ORDER BY account_id)
    FROM (SELECT account_id,sum(amount_cents)::bigint amount FROM accounting.journal_lines WHERE accounting.journal_lines.entry_id=e.id GROUP BY account_id HAVING sum(amount_cents)<>0) g);
   IF jsonb_array_length(candidates)>0 THEN state:='match';message:='Matching journal found. Link it to avoid recording payroll twice.';
   ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'entry_date',e.entry_date,'version',e.version,'lines',accounting.entry_detail(e.id)->'lines',
     'amounts_match',e.status='posted' AND signature=(SELECT jsonb_agg(jsonb_build_array(account_id,amount::text) ORDER BY account_id) FROM (SELECT account_id,sum(amount_cents)::bigint amount FROM accounting.journal_lines WHERE accounting.journal_lines.entry_id=e.id GROUP BY account_id HAVING sum(amount_cents)<>0) g),
     'can_correct_date',e.register_id IS NULL AND e.transfer_group_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM accounting.periods WHERE status='locked' AND month>=date_trunc('month',least(e.entry_date,pay_date))::date)
       AND NOT EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND (EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id) OR EXISTS(SELECT 1 FROM accounting.reconciliation_items ri WHERE ri.journal_line_id=l.id))))),'[]') INTO candidates FROM accounting.journal_entries e WHERE abs(e.entry_date-pay_date)<=7 AND e.status<>'discarded'
    AND (e.kind='payroll' OR e.memo ILIKE '%payroll%') AND e.reverses_entry_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id)
    AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.amount_cents=(body->>'declared_gross_cents')::bigint);
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) c WHERE (c->>'amounts_match')::boolean) THEN
     state:='date_match';message:='All amounts match. Choose whether to keep the journal date or match Patriot.';
    ELSIF jsonb_array_length(candidates)>0 THEN state:='conflict';message:='A similar journal exists. Compare its date and amounts before importing.'; END IF;
   END IF;
  END IF;
  IF state<>'duplicate' THEN
   BEGIN PERFORM accounting.require_open(pay_date);
   EXCEPTION WHEN OTHERS THEN state:='conflict';message:='This accounting period is locked or unavailable.'; END;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l LEFT JOIN accounting.accounts a ON a.id=(l->>'account_id')::uuid
     WHERE a.id IS NULL OR a.is_archived OR a.type<>CASE WHEN (l->>'amount_cents')::bigint>0 THEN 'expense' ELSE 'liability' END)
   THEN state:='conflict';message:='Choose active expense and liability accounts in Payroll accounts.'; END IF;
  END IF;
  IF defaults->>'company_id' IS NOT NULL AND defaults->>'company_id'<>request->>'company_id' THEN
   state:='conflict';message:='This report belongs to a different Patriot company.'; END IF;
  IF committing AND choice IS NOT NULL AND state<>'duplicate' THEN
   candidate:=NULL; correction:=false;
   IF state='date_match' AND split_part(choice,':',1) IN ('link-date','correct-date') THEN
    SELECT c INTO candidate FROM jsonb_array_elements(candidates) c WHERE c->>'id'=split_part(choice,':',2)
     AND (c->>'amounts_match')::boolean AND c->>'version'=split_part(choice,':',3) AND c->>'entry_date'=split_part(choice,':',4);
    correction:=split_part(choice,':',1)='correct-date';
    IF correction AND NOT coalesce((candidate->>'can_correct_date')::boolean,false) THEN RAISE EXCEPTION 'ACCT_PATRIOT_CHANGED'; END IF;
   END IF;
   IF NOT ((state='new' AND choice='new') OR (state='match' AND EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) c WHERE c->>'id'=choice)) OR (state='date_match' AND candidate IS NOT NULL))
   THEN RAISE EXCEPTION 'ACCT_PATRIOT_CHANGED'; END IF;
   saved:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
    'type','payroll.save','id',gen_random_uuid(),'expected_version',0,'provider_run_id',identity,'body',body,
    'document_id',request->'document_id','reason','Imported Patriot Payroll Details')));
   run_id:=(saved->>'id')::uuid;
   PERFORM accounting.payroll_plan(jsonb_build_object('id',run_id,'template','accrual','verified',true));
   IF choice='new' THEN
    posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
     'type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',pay_date,
     'memo','Payroll for '||pay_date::text,'kind','payroll','lines',lines)));
    posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
     'type','entry.post','id',posted->'id','expected_version',posted->'version')));
    entry_id:=(posted->>'id')::uuid;
   ELSIF correction THEN
    SELECT * INTO existing FROM accounting.journal_entries WHERE id=(candidate->>'id')::uuid;
    PERFORM accounting.require_open(existing.entry_date);
    posted:=accounting.operate(jsonb_build_object('key',gen_random_uuid(),'command',jsonb_build_object(
      'type','entry.correct','id',existing.id,'expected_version',existing.version,
      'reversal_date',existing.entry_date,'entry_date',pay_date,'memo',existing.memo,
      'lines',accounting.entry_detail(existing.id)->'lines','reason','Correct journal date to match Patriot payday')));
    entry_id:=(posted->>'id')::uuid;
    IF existing.review_pending THEN
     PERFORM accounting.ledger_command(jsonb_build_object('type','entry.review','id',entry_id,'expected_version',posted->'version','reviewed',false));
    END IF;
    INSERT INTO accounting.document_links(document_id,entry_id,created_by)
     SELECT document_id,patriot_import.entry_id,actor FROM accounting.document_links WHERE accounting.document_links.entry_id=existing.id ON CONFLICT DO NOTHING;
   ELSE entry_id:=coalesce(candidate->>'id',choice)::uuid; END IF;
   PERFORM set_config('accounting.action','payroll.import',true);
   PERFORM set_config('accounting.reason','Imported Patriot Payroll Details',true);
   UPDATE accounting.payroll_runs SET status='posted',entry_id=patriot_import.entry_id,
    ytd=ytd||jsonb_build_object('patriot_import',jsonb_build_object('company_id',request->'company_id',
     'company_name',request->'company_name','mapping',request->'mapping','fingerprint',item->'fingerprint','journal_mode',CASE WHEN choice='new' THEN 'created' ELSE 'linked' END,'date_resolution',CASE WHEN correction THEN 'corrected' WHEN state='date_match' THEN 'kept_existing' ELSE NULL END,'previous_entry_id',CASE WHEN correction THEN candidate->>'id' ELSE NULL END))
   WHERE id=run_id;
   INSERT INTO accounting.document_links(document_id,payroll_run_id,created_by) VALUES((request->>'document_id')::uuid,run_id,actor) ON CONFLICT DO NOTHING;
  END IF;
  result:=result||jsonb_build_array(jsonb_build_object('key',identity,'pay_date',pay_date,'period_from',body->'period_from',
   'period_to',body->'period_to','gross',body->'declared_gross_cents','net',body->'declared_net_cents','employer_tax',employer::text,
   'employee_count',jsonb_array_length(body->'employees'),'state',state,'message',message,'candidates',candidates,'run_id',run_id,'entry_id',entry_id));
 END LOOP;
 PERFORM set_config('accounting.category_source','',true);
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION accounting.gusto_import(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
<<gusto_import>>
DECLARE actor uuid:=accounting.require_owner(); committing boolean:=request->>'mode'='commit'; mapping jsonb:=request->'mapping';
 item jsonb; body jsonb; lines jsonb; runs jsonb:='[]'; r jsonb; plan jsonb:='{}'; outcome jsonb:='{}'; pool jsonb; claimed jsonb:='{}'; candidate jsonb; result jsonb:='[]';
 prior accounting.payroll_runs; existing accounting.journal_entries; defaults jsonb; st text; msg text; identity text; day date; employer bigint; employee bigint;
 run_month text; members jsonb; n integer; window_runs jsonb; window_keys jsonb; total jsonb; first_date date; last_date date; pairs jsonb:='[]'; pair jsonb; k text;
 unit jsonb; choice text; link_entry uuid; new_run uuid; saved jsonb; posted jsonb; done jsonb:='{}'; resolution text; group_key text; fee_rows jsonb; pick jsonb;
BEGIN
 -- Entries this import writes or corrects record it as their category source.
 IF committing THEN PERFORM accounting.write_lock(); PERFORM set_config('accounting.category_source','gusto_import',true); END IF;
 SELECT ytd->'gusto_import' INTO defaults FROM accounting.payroll_runs
 WHERE ytd?'gusto_import' ORDER BY updated_at DESC,id DESC LIMIT 1;
 -- A first Gusto import starts from the payroll accounts the Patriot importer last used.
 IF request->>'mode'='defaults' THEN RETURN coalesce(defaults,(SELECT jsonb_build_object('mapping',ytd->'patriot_import'->'mapping') FROM accounting.payroll_runs
  WHERE ytd?'patriot_import' ORDER BY updated_at DESC,id DESC LIMIT 1),'{}')
  ||jsonb_build_object('fee_account',(SELECT id FROM accounting.accounts WHERE system_purpose='payroll_fees' AND NOT is_archived),
   'first_year',(SELECT extract(year FROM earliest_history_date+1)::integer FROM public.business_profile WHERE id=1)); END IF;
 IF request->>'mode' NOT IN ('preview','commit') OR jsonb_typeof(request->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(request->'items') NOT BETWEEN 0 AND 500 OR octet_length(request::text)>3000000
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
 PERFORM set_config('accounting.category_source','',true);
 RETURN result;
END $fn$;

-- >>> category source backfill
-- One pass over the books' own history, so reviewed transactions show where
-- their category came from too. Unknown stays unknown.
CREATE OR REPLACE FUNCTION accounting.category_source_backfill()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r record; src text; who uuid; earlier accounting.journal_entries; counts jsonb:='{}'::jsonb;
BEGIN
 PERFORM set_config('accounting.operation_id',gen_random_uuid()::text,true);
 PERFORM set_config('accounting.actor_kind','system',true);
 PERFORM set_config('accounting.action','entry.source.backfill',true);
 PERFORM set_config('accounting.reason','Record how each transaction was categorized',true);
 FOR r IN
  WITH ops AS (
   -- Each operation's line writes per entry: what it inserted and what it deleted.
   SELECT (coalesce(g.after,g.before)->>'entry_id')::uuid entry_id,g.operation_id,max(g.id) last_id,
    string_agg(lower(g.after->>'account_id')||':'||(g.after->>'amount_cents'),',' ORDER BY lower(g.after->>'account_id')||':'||(g.after->>'amount_cents')) FILTER(WHERE g.before IS NULL) ins,
    string_agg(lower(g.before->>'account_id')||':'||(g.before->>'amount_cents'),',' ORDER BY lower(g.before->>'account_id')||':'||(g.before->>'amount_cents')) FILTER(WHERE g.after IS NULL) del
   FROM accounting.audit_log g
   WHERE g.table_name='journal_lines' AND (g.before IS NULL OR g.after IS NULL)
   GROUP BY 1,2
  ), changed AS (
   -- The last operation that changed the entry's accounts or amounts, not one that rewrote the same lines.
   SELECT DISTINCT ON (o.entry_id) o.entry_id,o.operation_id,g.actor_kind,g.actor_user_id,g.action
   FROM ops o JOIN accounting.audit_log g ON g.id=o.last_id
   WHERE o.ins IS NOT NULL AND o.ins IS DISTINCT FROM o.del
   ORDER BY o.entry_id,o.last_id DESC
  ), marks AS (
   -- What the books recorded doing to the entry inside one operation, the latest mark first.
   SELECT DISTINCT ON (g.row_id,g.operation_id) g.row_id,g.operation_id,
    CASE g.action WHEN 'rule.applied' THEN 'rule' WHEN 'transfer.paired' THEN 'transfer_pair' ELSE g.after->>'fill_source' END source
   FROM accounting.audit_log g
   WHERE g.table_name='journal_entries' AND (g.action IN ('rule.applied','transfer.paired') OR g.after->>'fill_source' IN ('rule','prior','payee_default','transfer_pair'))
   ORDER BY g.row_id,g.operation_id,g.id DESC
  )
  SELECT e.id,e.replaces_entry_id,e.restores_entry_id,
   CASE
    WHEN p.provider IS NOT NULL THEN p.provider||'_import'
    WHEN e.status='draft' AND e.fill_source IS NOT NULL THEN e.fill_source
    WHEN c.action LIKE 'import.%' THEN CASE WHEN e.origin='wave' THEN 'wave_import' END
    WHEN c.action='entry.correct' AND e.reason IN ('Gusto fee moved to payroll fees','Gusto tax refund moved to employer payroll taxes') THEN 'gusto_import'
    WHEN m.source IS NOT NULL THEN m.source
    WHEN c.actor_kind='api' AND c.actor_user_id IS NOT NULL THEN 'api'
    WHEN c.actor_kind='owner' AND c.actor_user_id IS NOT NULL THEN 'person'
   END source,c.actor_user_id actor
  FROM accounting.journal_entries e
  LEFT JOIN changed c ON c.entry_id=e.id
  LEFT JOIN marks m ON m.row_id=e.id AND m.operation_id=c.operation_id
  LEFT JOIN LATERAL (
   -- A payroll journal an import created, or corrected to the provider's figures.
   SELECT pr.provider FROM accounting.payroll_runs pr
   WHERE pr.entry_id=e.id AND pr.status='posted' AND pr.provider IN ('gusto','patriot') AND (pr.ytd?'gusto_import' OR pr.ytd?'patriot_import')
    AND (accounting.payroll_import_mode(pr)='created' OR coalesce(pr.ytd->'gusto_import'->>'resolution',pr.ytd->'patriot_import'->>'date_resolution')='corrected')
   ORDER BY pr.pay_date,pr.id LIMIT 1) p ON true
  WHERE e.category_source IS NULL AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
   AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id)
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.system_purpose IN ('uncategorized_income','uncategorized_expense'))
   -- A draft in a locked month cannot change, so its source stays unknown.
   AND (e.status='posted' OR NOT EXISTS(SELECT 1 FROM accounting.periods pd WHERE pd.status='locked' AND pd.month>=date_trunc('month',e.entry_date)::date))
  ORDER BY e.created_at,e.id
 LOOP
  src:=r.source; who:=CASE WHEN r.source IN ('person','api') THEN r.actor END;
  -- An edit or a restore that kept every line keeps the earlier entry's source, as the commands now do.
  IF coalesce(r.restores_entry_id,r.replaces_entry_id) IS NOT NULL THEN
   SELECT * INTO earlier FROM accounting.journal_entries WHERE id=coalesce(r.restores_entry_id,r.replaces_entry_id);
   IF r.restores_entry_id IS NOT NULL OR accounting.lines_key(accounting.entry_lines(earlier.id)) IS NOT DISTINCT FROM accounting.lines_key(accounting.entry_lines(r.id)) THEN
    src:=earlier.category_source; who:=earlier.category_actor;
   END IF;
  END IF;
  IF src IS NOT NULL THEN
   UPDATE accounting.journal_entries SET category_source=src,category_actor=who WHERE id=r.id;
   counts:=counts||jsonb_build_object(src,coalesce((counts->>src)::integer,0)+1);
  END IF;
 END LOOP;
 RETURN counts;
END $function$
;
-- <<< category source backfill

SELECT accounting.category_source_backfill();

DROP FUNCTION accounting.category_source_backfill();

COMMIT;
