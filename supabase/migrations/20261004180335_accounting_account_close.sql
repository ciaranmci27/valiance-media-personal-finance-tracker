-- Closing bank and card accounts, and moving a bank feed to a reissued card.
--
-- Closing: accounts gain closed_on (bank, card and cash accounts only). The
-- owner command account.close (ledger_command) takes a closing day, by default
-- the last day anything touched the account, and refuses with a plain reason
-- when the posted balance through that day is not zero (ACCT_CLOSE_BALANCE,
-- with the amount), when anything is dated after it (ACCT_CLOSE_LATER_ENTRIES)
-- or when drafts still wait on the account (ACCT_CLOSE_DRAFTS). Closing sets
-- closed_on and closes the account's open feed link (is_closed, closed_on), so
-- the feed stops syncing it. account.reopen clears closed_on and reopens the
-- link closed with it, unless a newer link has opened since. Nothing about past
-- entries changes: reports, ledgers and past balances read the same. guard
-- refuses lines dated after the closing day (ACCT_ACCOUNT_CLOSED), and moving a
-- draft past it; earlier history stays editable. banking_guard refuses an open
-- feed link on a closed account.
--
-- Reissued cards: one ledger account may now have many closed feed links but
-- only one open link (the unique account_id constraint becomes a partial
-- unique index WHERE NOT is_closed). The owner command feed.link
-- (banking_command) links a discovered feed account to an existing bank or
-- card account: the account's open link is closed and a new link is created.
-- The new link's coverage starts the day after the last movement any earlier
-- link of the account imported, and the old link closes the day before that
-- (or today), so the overlap is never imported twice; movements still dedupe
-- per link by external id as before. The new link copies the old link's
-- movement and balance signs. feed.dismiss records that a discovered account is
-- not a replacement for a given link (discovery entry not_replacing).
--
-- Readers:
-- - sync_server stamps each discovery entry with seen_at (when the provider last
--   returned it) and keeps not_replacing across runs.
-- - context('feeds') adds last_movement_on to each feed account.
-- - context('manage') adds closed_on and last_activity_on (bank, card and cash)
--   to each account profile.
-- - reconciliation_status (API and MCP) adds account.closed_on and the status
--   'closed'.
-- - close_command reconciles on the account's open link, or its latest one.

BEGIN;

ALTER TABLE accounting.accounts
  ADD COLUMN closed_on date,
  ADD CONSTRAINT accounts_closed_kind_check CHECK (closed_on IS NULL OR subtype IN ('bank', 'card', 'cash'));

ALTER TABLE accounting.bank_accounts DROP CONSTRAINT bank_accounts_account_id_key;
CREATE UNIQUE INDEX bank_accounts_one_open_link ON accounting.bank_accounts USING btree (account_id) WHERE (NOT is_closed);

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
   IF OLD.status='posted' AND (to_jsonb(NEW)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']) THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
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

CREATE OR REPLACE FUNCTION accounting.banking_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE observation accounting.bank_transactions; line accounting.journal_lines; movement accounting.bank_accounts; total numeric; capacity numeric; new_review text;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME NOT IN ('journal_lines','journal_entries') THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='INSERT' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.id=NEW.reverses_entry_id AND e.transfer_group_id IS NOT NULL AND (SELECT count(*) FROM accounting.journal_entries g WHERE g.transfer_group_id=e.transfer_group_id AND g.reverses_entry_id IS NULL)>1)
    AND current_setting('accounting.action',true)<>'transfer.reverse' THEN RAISE EXCEPTION 'ACCT_TRANSFER_REVERSE_TOGETHER'; END IF;
  IF TG_OP='UPDATE' AND NEW.entry_date<>OLD.entry_date AND OLD.origin IN ('simplefin','csv') AND EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
   IF (NEW.account_id,NEW.amount_cents,NEW.entry_id) IS DISTINCT FROM (OLD.account_id,OLD.amount_cents,OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='bank_transactions' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','review','excluded_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','review','excluded_reason']) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND OLD.state='posted' AND NEW.state<>'posted' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='INSERT' THEN NEW.descriptor_key:=coalesce(accounting.descriptor_key(NEW.description),''); END IF;
  IF NEW.review='excluded' AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_MATCH_EXISTS'; END IF;
 ELSIF TG_TABLE_NAME='bank_matches' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'ACCT_MATCH_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN
   IF btrim(coalesce(current_setting('accounting.reason',true),''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF OLD.amount_cents>0 AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.journal_line_id AND amount_cents=0) THEN RAISE EXCEPTION 'ACCT_RELEASE_CORROBORATION_FIRST'; END IF;
   RETURN OLD;
  END IF;
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=NEW.bank_transaction_id;
  SELECT * INTO line FROM accounting.journal_lines WHERE id=NEW.journal_line_id;
  SELECT * INTO movement FROM accounting.bank_accounts WHERE id=observation.bank_account_id;
  IF observation.state<>'posted' OR observation.review='excluded' OR line.account_id<>movement.account_id OR sign(line.amount_cents)<>sign(observation.amount_cents) THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH'; END IF;
  IF (SELECT status FROM accounting.journal_entries WHERE id=line.entry_id)='discarded' THEN RAISE EXCEPTION 'ACCT_MATCH_DISCARDED'; END IF;
  IF NEW.amount_cents=0 THEN
   -- Additional independent source evidence carries no second financial allocation.
   IF abs(line.amount_cents)<>abs(observation.amount_cents) OR NOT EXISTS(
    SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions other ON other.id=m.bank_transaction_id
    WHERE m.journal_line_id=line.id AND m.amount_cents=abs(line.amount_cents) AND other.source<>observation.source
      AND other.bank_account_id=observation.bank_account_id AND other.amount_cents=observation.amount_cents
      AND abs(other.posted_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
   ) THEN RAISE EXCEPTION 'ACCT_INVALID_CORROBORATION'; END IF;
  END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE bank_transaction_id=observation.id;
  IF total+NEW.amount_cents>abs(observation.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE journal_line_id=line.id;
  IF total+NEW.amount_cents>abs(line.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
 ELSIF TG_TABLE_NAME='bank_accounts' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
  IF NOT NEW.is_closed AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND closed_on IS NOT NULL) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CLOSED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.account_id,NEW.movement_sign) IS DISTINCT FROM (OLD.account_id,OLD.movement_sign) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_FROZEN'; END IF;
 ELSIF TG_TABLE_NAME='document_links' AND TG_OP='DELETE' AND current_setting('accounting.action',true)='document.unlink' THEN RETURN OLD;
 -- A dismissed suggestion that never ran leaves nothing to keep; banking_command checks that before it deletes.
 ELSIF TG_TABLE_NAME='rules' AND TG_OP='DELETE' AND current_setting('accounting.action',true)='rule.dismiss' THEN
  IF OLD.review_status='suggested' AND NOT OLD.enabled THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('parties','payee_aliases','bank_accounts','bank_connections','documents','rules') THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
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
 closing date; later integer; first_later date; closing_balance bigint; books_today date;
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
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND NOT (id=ANY(preserved));
   UPDATE accounting.journal_entries SET entry_date=(c->>'entry_date')::date,memo=c->>'memo',kind=coalesce(c->'context'->>'kind',c->>'kind',kind),
    payee_id=CASE WHEN c?'payee_id' OR c->'context'?'payee_id' THEN coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid ELSE payee_id END,fill_source=NULL WHERE id=k RETURNING version INTO v;
  ELSE
   IF coalesce((c->>'expected_version')::integer,-1)<>0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   INSERT INTO accounting.journal_entries(id,entry_date,memo,source_description,origin,kind,payee_id,created_by,register_id,reason)
    VALUES(k,(c->>'entry_date')::date,c->>'memo',c->>'source_description',coalesce(c->>'origin','manual'),coalesce(c->'context'->>'kind',c->>'kind','manual'),
    coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid,actor,(c->>'register_id')::uuid,coalesce(c->>'reason','')) RETURNING version INTO v;
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
    UPDATE accounting.journal_entries SET replaces_entry_id=e.id WHERE id=k RETURNING version INTO v;
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
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),kind=coalesce(c->>'kind',kind),payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END,fill_source=NULL WHERE id=k RETURNING version INTO v;
   IF coalesce((c->>'remember')::boolean,false) AND e.descriptor_key IS NOT NULL THEN
    PERFORM accounting.banking_command(jsonb_build_object('type','alias.save','id',gen_random_uuid(),'party_id',c->'payee_id','match_kind','key','pattern',e.descriptor_key,'enabled',true,'expected_version',0));
   END IF;
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.banking_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
<<banking_command>>
DECLARE t text:=c->>'type'; key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 v integer; current_version integer; candidate_count integer; x jsonb; result jsonb; candidate jsonb; observation accounting.bank_transactions; doc accounting.documents; item accounting.journal_lines; existing jsonb;
 cond jsonb; actions jsonb; mapping_connection uuid; mapping_details jsonb; mapped_row accounting.bank_accounts; account uuid; transit uuid; leg accounting.journal_entries; mate accounting.journal_entries; outgoing jsonb; incoming jsonb; out_id uuid; in_id uuid; amount bigint; match_amount bigint; out_date date; in_date date;
 party_roles text[]; merge_from accounting.parties; merge_into accounting.parties; moved_entries integer; moved_aliases integer; moved_documents integer; moved_rules integer;
 rule_row accounting.rules;
 previous_link accounting.bank_accounts; link_start date; last_movement date; books_today date;
BEGIN
 IF t='party.save' THEN
  SELECT version INTO current_version FROM accounting.parties WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- One or more known roles, each stored once, in the list's own order.
  IF jsonb_typeof(c->'roles') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'roles')=0
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'roles') r WHERE jsonb_typeof(r) IS DISTINCT FROM 'string' OR NOT ((r#>>'{}')=ANY(ARRAY['client','vendor','contractor','employee','government','financial','owner']))) THEN RAISE EXCEPTION 'ACCT_INVALID_ROLES'; END IF;
  party_roles:=ARRAY(SELECT known.r FROM unnest(ARRAY['client','vendor','contractor','employee','government','financial','owner']) WITH ORDINALITY AS known(r,n) WHERE c->'roles' ? known.r ORDER BY known.n);
  -- A contact an agent adds is a suggestion that names the agent; the owner's save confirms it.
  INSERT INTO accounting.parties(id,name,roles,email,phone,website,default_account_id,contractor_classification,documentation_status,notes,is_archived,review_status,suggested_by)
  VALUES(key,c->>'name',party_roles,nullif(btrim(c->>'email'),''),nullif(btrim(c->>'phone'),''),nullif(btrim(c->>'website'),''),(c->>'default_account_id')::uuid,
   CASE WHEN coalesce(c->>'contractor_classification',c->>'tax_classification','unknown')='unreviewed' THEN 'unknown' WHEN c->>'tax_classification'='partnership' THEN 'other' ELSE coalesce(c->>'contractor_classification',c->>'tax_classification','unknown') END,
   CASE WHEN c->>'documentation'='requested' THEN 'missing' ELSE coalesce(c->>'documentation_status',c->>'documentation','missing') END,coalesce(c->>'notes',''),coalesce((c->>'is_archived')::boolean,false),
   CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'suggested' ELSE 'confirmed' END,
   CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN (SELECT k.team_member_id FROM public.api_keys k WHERE k.id::text=current_setting('api.key_id',true)) END)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,roles=excluded.roles,email=excluded.email,phone=excluded.phone,website=excluded.website,default_account_id=excluded.default_account_id,contractor_classification=excluded.contractor_classification,documentation_status=excluded.documentation_status,notes=excluded.notes,is_archived=excluded.is_archived,review_status=excluded.review_status RETURNING version INTO v;
 ELSIF t='party.approve' THEN
  IF jsonb_typeof(c->'ids') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'ids') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  result:='[]';
  FOR x IN SELECT value FROM jsonb_array_elements(c->'ids') LOOP
   SELECT * INTO merge_from FROM accounting.parties WHERE id=(x#>>'{}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF c->'expected_versions' ? merge_from.id::text AND (c->'expected_versions'->>merge_from.id::text)::integer IS DISTINCT FROM merge_from.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF merge_from.review_status='suggested' THEN
    UPDATE accounting.parties SET review_status='confirmed' WHERE id=merge_from.id RETURNING version INTO v;
    result:=result||jsonb_build_array(jsonb_build_object('id',merge_from.id,'version',v));
   END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'approved',result,'count',jsonb_array_length(result));
 ELSIF t='party.merge' THEN
  SELECT * INTO merge_from FROM accounting.parties WHERE id=(c->>'from_id')::uuid;
  SELECT * INTO merge_into FROM accounting.parties WHERE id=(c->>'into_id')::uuid;
  IF merge_from.id IS NULL OR merge_into.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF merge_from.id=merge_into.id OR merge_into.is_archived THEN RAISE EXCEPTION 'ACCT_INVALID_MERGE'; END IF;
  IF (c->>'from_version')::integer IS DISTINCT FROM merge_from.version OR (c->>'into_version')::integer IS DISTINCT FROM merge_into.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- A locked month keeps the contact its reports were closed with, so the merge waits until it reopens.
  SELECT min(entry_date) INTO out_date FROM accounting.journal_entries WHERE payee_id=merge_from.id AND status<>'discarded';
  IF out_date IS NOT NULL THEN PERFORM accounting.require_open(out_date); END IF;
  -- Discarded entries keep their contact: they cannot change, and the merged contact stays (archived) for them.
  UPDATE accounting.journal_entries SET payee_id=merge_into.id WHERE payee_id=merge_from.id AND status<>'discarded';
  GET DIAGNOSTICS moved_entries=ROW_COUNT;
  -- Alias patterns are unique across contacts, so every alias moves without a clash.
  UPDATE accounting.payee_aliases SET party_id=merge_into.id WHERE party_id=merge_from.id;
  GET DIAGNOSTICS moved_aliases=ROW_COUNT;
  -- A document already linked to both stays linked to each; only the other links move.
  UPDATE accounting.document_links d SET party_id=merge_into.id WHERE d.party_id=merge_from.id
   AND NOT EXISTS(SELECT 1 FROM accounting.document_links o WHERE o.document_id=d.document_id AND o.party_id=merge_into.id);
  GET DIAGNOSTICS moved_documents=ROW_COUNT;
  UPDATE accounting.rules r SET conditions=CASE WHEN r.conditions->>'payee_id'=merge_from.id::text THEN jsonb_set(r.conditions,'{payee_id}',to_jsonb(merge_into.id::text)) ELSE r.conditions END,
   actions=CASE WHEN r.actions->>'payee_id'=merge_from.id::text THEN jsonb_set(r.actions,'{payee_id}',to_jsonb(merge_into.id::text)) ELSE r.actions END
   WHERE r.conditions->>'payee_id'=merge_from.id::text OR r.actions->>'payee_id'=merge_from.id::text;
  GET DIAGNOSTICS moved_rules=ROW_COUNT;
  -- The kept contact gains the other's roles and fills its own blanks from it.
  UPDATE accounting.parties SET roles=ARRAY(SELECT known.r FROM unnest(ARRAY['client','vendor','contractor','employee','government','financial','owner']) WITH ORDINALITY AS known(r,n) WHERE known.r=ANY(merge_into.roles) OR known.r=ANY(merge_from.roles) ORDER BY known.n),
   email=coalesce(merge_into.email,merge_from.email),phone=coalesce(merge_into.phone,merge_from.phone),website=coalesce(merge_into.website,merge_from.website),
   default_account_id=coalesce(merge_into.default_account_id,merge_from.default_account_id),
   contractor_classification=CASE WHEN merge_into.contractor_classification='unknown' THEN merge_from.contractor_classification ELSE merge_into.contractor_classification END,
   documentation_status=CASE WHEN merge_into.documentation_status='missing' THEN merge_from.documentation_status ELSE merge_into.documentation_status END,
   notes=CASE WHEN merge_into.notes='' THEN merge_from.notes ELSE merge_into.notes END,review_status='confirmed'
   WHERE id=merge_into.id RETURNING version INTO v;
  UPDATE accounting.parties SET is_archived=true,review_status='confirmed' WHERE id=merge_from.id;
  RETURN jsonb_build_object('id',merge_into.id,'version',v,'from_id',merge_from.id,'moved',jsonb_build_object('entries',moved_entries,'aliases',moved_aliases,'documents',moved_documents,'rules',moved_rules));
 ELSIF t='alias.save' THEN
  SELECT version INTO current_version FROM accounting.payee_aliases WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) AND c?'expected_version' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  INSERT INTO accounting.payee_aliases(id,party_id,match_kind,pattern,enabled,created_by)
  VALUES(key,(c->>'party_id')::uuid,coalesce(c->>'match_kind',c->>'match_mode','key'),coalesce(c->>'pattern',c->>'description'),coalesce((c->>'enabled')::boolean,true),actor)
  ON CONFLICT(id) DO UPDATE SET party_id=excluded.party_id,match_kind=excluded.match_kind,pattern=excluded.pattern,enabled=excluded.enabled RETURNING id,version INTO key,v;
 ELSIF t IN ('rule.save','rule.activate') THEN
  SELECT version INTO current_version FROM accounting.rules WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='rule.activate' THEN
   -- Switching a suggestion on after its preview is the owner's approval: it becomes theirs.
   UPDATE accounting.rules SET enabled=(c->>'enabled')::boolean,review_status=CASE WHEN (c->>'enabled')::boolean THEN 'confirmed' ELSE review_status END WHERE id=key RETURNING version INTO v;
  ELSE
   cond:=coalesce(c->'conditions',jsonb_strip_nulls(jsonb_build_object('description_mode',c->'description_mode','description',c->'description','bank_account_id',c->'bank_account_id','direction',c->'direction','amount_min',c->'min_cents','amount_max',c->'max_cents','payee_id',c->'match_payee_id')));
   actions:=coalesce(c->'actions',jsonb_strip_nulls(jsonb_build_object('account_id',c->'category_account_id','payee_id',c->'assign_payee_id')));
   IF EXISTS(SELECT 1 FROM jsonb_each(cond) v WHERE v.key IN ('amount_min','amount_max') AND (jsonb_typeof(value)<>'string' OR (value#>>'{}')!~'^[0-9]+$')) THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   IF NOT(actions?'account_id' OR actions?'splits') OR (cond->>'amount_min')::numeric>(cond->>'amount_max')::numeric THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
   IF actions?'account_id' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(actions->>'account_id')::uuid AND NOT is_archived AND subtype NOT IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_INVALID_RULE_ACCOUNT'; END IF;
   IF actions?'splits' THEN
    IF jsonb_typeof(actions->'splits') IS DISTINCT FROM 'array' OR jsonb_array_length(actions->'splits')<2 THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(actions->'splits') s WHERE (s->>'share_bps') IS NULL OR (s->>'share_bps')!~'^[0-9]+$' OR (s->>'share_bps')::integer NOT BETWEEN 1 AND 9999
      OR NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(s->>'account_id')::uuid AND NOT is_archived AND subtype NOT IN ('bank','card','cash')))
      OR (SELECT sum((s->>'share_bps')::integer) FROM jsonb_array_elements(actions->'splits') s)<>10000 THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
   END IF;
   -- A rule an agent adds is a suggestion that names the agent; the owner's save makes it theirs.
   INSERT INTO accounting.rules(id,name,priority,enabled,conditions,actions,auto_post,review_status,suggested_by) VALUES(key,c->>'name',coalesce((c->>'priority')::integer,100),coalesce((c->>'enabled')::boolean,false),cond,actions,coalesce((c->>'auto_post')::boolean,false),
    CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'suggested' ELSE 'confirmed' END,
    CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN (SELECT k.team_member_id FROM public.api_keys k WHERE k.id::text=current_setting('api.key_id',true)) END)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,conditions=excluded.conditions,actions=excluded.actions,enabled=excluded.enabled,auto_post=excluded.auto_post,review_status=excluded.review_status RETURNING version INTO v;
  END IF;
 ELSIF t='rule.dismiss' THEN
  SELECT * INTO rule_row FROM accounting.rules WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM rule_row.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- Only a suggestion is dismissed; the owner pauses a rule of their own instead.
  IF rule_row.review_status<>'suggested' THEN RAISE EXCEPTION 'ACCT_RULE_NOT_SUGGESTED'; END IF;
  -- A rule that was ever switched on or filled a transaction stays, so the history that names it keeps its source.
  IF rule_row.enabled
   OR EXISTS(SELECT 1 FROM accounting.audit_log a WHERE a.table_name='rules' AND a.row_id=key AND coalesce((a.after->>'enabled')::boolean,false))
   OR EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.applied_rule_id=key)
   OR EXISTS(SELECT 1 FROM accounting.audit_log a WHERE a.table_name='journal_entries' AND a.action='rule.applied' AND a.before->>'rule_id'=key::text) THEN RAISE EXCEPTION 'ACCT_RULE_IN_USE'; END IF;
  DELETE FROM accounting.rules WHERE id=key;
  RETURN jsonb_build_object('id',key,'dismissed',true);
 ELSIF t IN ('rule.apply','rule.apply_preview') THEN
  result:='[]';
  FOR x IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
   candidate:=accounting.rule_candidate((x->>'id')::uuid);
   IF t='rule.apply' AND (candidate IS NULL OR NOT (candidate->>'eligible')::boolean) THEN RAISE EXCEPTION 'ACCT_RULE_INELIGIBLE'; END IF;
   IF candidate IS NULL THEN CONTINUE; END IF;
   IF t='rule.apply' THEN
    IF (candidate->>'entry_version')::integer IS DISTINCT FROM (x->>'expected_version')::integer OR (candidate->>'rule_version')::integer IS DISTINCT FROM (x->>'rule_version')::integer OR candidate->>'rule_id' IS DISTINCT FROM x->>'rule_id' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    result:=result||jsonb_build_array(accounting.apply_treatment((x->>'id')::uuid));
   ELSE result:=result||jsonb_build_array(candidate); END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'entries',result,'count',jsonb_array_length(result));
 ELSIF t='document.prepare' THEN
  INSERT INTO accounting.documents(id,storage_path,name,mime,size_bytes,sha256,kind,uploaded_by)
   VALUES(key,key::text||'/'||coalesce(c->>'sha256',c->>'content_hash'),coalesce(c->>'name',c->>'original_name'),coalesce(c->>'mime',c->>'mime_type'),(c->>'size_bytes')::bigint,coalesce(c->>'sha256',c->>'content_hash'),coalesce(c->>'kind','receipt'),actor) RETURNING version INTO v;
  RETURN jsonb_build_object('id',key,'version',v,'storage_path',key::text||'/'||coalesce(c->>'sha256',c->>'content_hash'));
 ELSIF t IN ('document.complete','document.link','document.archive','document.unlink') THEN
  SELECT * INTO doc FROM accounting.documents WHERE id=coalesce((c->>'document_id')::uuid,key);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t NOT IN ('document.archive','document.unlink') AND NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=doc.storage_path) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF t='document.link' THEN
   INSERT INTO accounting.document_links(document_id,entry_id,bank_transaction_id,reconciliation_id,payroll_run_id,register_id,party_id,created_by)
   VALUES(doc.id,(c->>'entry_id')::uuid,(c->>'bank_transaction_id')::uuid,(c->>'reconciliation_id')::uuid,(c->>'payroll_run_id')::uuid,(c->>'register_id')::uuid,(c->>'party_id')::uuid,actor) ON CONFLICT DO NOTHING;
  END IF;
  IF t IN ('document.archive','document.unlink') AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF t='document.unlink' THEN
   PERFORM set_config('accounting.action','document.unlink',true);
   DELETE FROM accounting.document_links WHERE document_id=doc.id AND entry_id=(c->>'entry_id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  END IF;
  UPDATE accounting.documents SET status=CASE t WHEN 'document.archive' THEN 'archived' WHEN 'document.link' THEN 'linked' WHEN 'document.unlink' THEN CASE WHEN EXISTS(SELECT 1 FROM accounting.document_links WHERE document_id=doc.id) THEN status ELSE 'inbox' END ELSE status END WHERE id=doc.id RETURNING version INTO v;
  key:=doc.id;
 ELSIF t='feed.claim' THEN
  IF c->>'claim_id' IS NOT NULL AND c->>'access_url_encrypted' IS NULL THEN
   INSERT INTO accounting.bank_connections(id,name,status,access_url_encrypted,checkpoint)
    VALUES(key,c->>'name','reconnect_required','',jsonb_build_object('claim',jsonb_build_object('id',c->>'claim_id','state','prepared'))) RETURNING version INTO v;
  ELSE
   IF length(coalesce(c->>'access_url_encrypted',''))<20 THEN RAISE EXCEPTION 'ACCT_ENCRYPTED_ACCESS_REQUIRED'; END IF;
   INSERT INTO accounting.bank_connections(id,name,access_url_encrypted,key_version) VALUES(key,c->>'name',c->>'access_url_encrypted',coalesce((c->>'key_version')::smallint,1)) RETURNING version INTO v;
  END IF;
 ELSIF t IN ('feed.disconnect','feed.schedule','bank.sync_request') THEN
  SELECT version INTO current_version FROM accounting.bank_connections WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF t<>'bank.sync_request' AND (c->>'expected_version')::integer IS DISTINCT FROM current_version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='feed.disconnect' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  UPDATE accounting.bank_connections SET status=CASE WHEN t='feed.disconnect' THEN 'disconnected' ELSE status END,
   scheduled=CASE WHEN t='feed.disconnect' THEN false WHEN t='feed.schedule' THEN (c->>'enabled')::boolean ELSE scheduled END,
   next_sync_at=CASE WHEN t='bank.sync_request' THEN now() ELSE next_sync_at END,
   lease_run_id=CASE WHEN t='feed.disconnect' THEN NULL ELSE lease_run_id END,lease_until=CASE WHEN t='feed.disconnect' THEN NULL ELSE lease_until END
   WHERE id=key RETURNING version INTO v;
 ELSIF t='feed.map' THEN
  IF c->>'connection_id' IS NULL THEN
   SELECT b.id,d.value INTO mapping_connection,mapping_details FROM accounting.bank_connections b CROSS JOIN LATERAL jsonb_each(coalesce(b.checkpoint->'discovery','{}')) d WHERE d.key=banking_command.key::text;
   IF FOUND THEN c:=c||jsonb_build_object('connection_id',mapping_connection,'provider_account_id',mapping_details->>'provider_account_id','institution',mapping_details->>'institution'); END IF;
  END IF;
  SELECT version INTO current_version FROM accounting.bank_accounts WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF coalesce(c->>'ownership','company')<>'company' THEN
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['discovery',key::text,'ownership'],c->'ownership',true) WHERE id=(c->>'connection_id')::uuid;
   RETURN jsonb_build_object('id',key,'version',coalesce(current_version,0));
  END IF;
  INSERT INTO accounting.bank_accounts(id,account_id,connection_id,provider_account_id,institution,mask,movement_sign,coverage_from)
  VALUES(key,(c->>'account_id')::uuid,(c->>'connection_id')::uuid,c->>'provider_account_id',coalesce(c->>'institution',''),coalesce(c->>'mask',''),coalesce((c->>'movement_sign')::smallint,1),coalesce((c->>'coverage_from')::date,(to_timestamp((c->>'history_start')::bigint) AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date))
  ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,connection_id=coalesce(excluded.connection_id,accounting.bank_accounts.connection_id),provider_account_id=coalesce(excluded.provider_account_id,accounting.bank_accounts.provider_account_id),movement_sign=excluded.movement_sign,coverage_from=excluded.coverage_from RETURNING version INTO v;
  IF c?'balance_sign' AND c->>'connection_id' IS NOT NULL THEN
   IF (c->>'balance_sign')::integer NOT IN (-1,1) THEN RAISE EXCEPTION 'ACCT_INVALID_BALANCE_SIGN'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=key) AND (c->>'balance_sign')::smallint IS DISTINCT FROM
     coalesce((SELECT (checkpoint->'balance_signs'->>key::text)::smallint FROM accounting.bank_connections WHERE id=(c->>'connection_id')::uuid),1)
     THEN RAISE EXCEPTION 'ACCT_BANK_MAPPING_FROZEN'; END IF;
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['balance_signs'],coalesce(checkpoint->'balance_signs','{}')||jsonb_build_object(key::text,(c->>'balance_sign')::smallint)) WHERE id=(c->>'connection_id')::uuid;
  END IF;
 ELSIF t='feed.link' THEN
  -- A discovered feed account joins a ledger account that may already have a feed (a reissued card). History stays on the one account.
  SELECT bc.id,d.value INTO mapping_connection,mapping_details FROM accounting.bank_connections bc CROSS JOIN LATERAL jsonb_each(coalesce(bc.checkpoint->'discovery','{}')) d WHERE d.key=banking_command.key::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF coalesce((c->>'expected_version')::integer,-1)<>0 OR EXISTS(SELECT 1 FROM accounting.bank_accounts WHERE id=key) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF coalesce(mapping_details->>'currency','USD')<>'USD' THEN RAISE EXCEPTION 'ACCT_FEED_CURRENCY'; END IF;
  account:=(c->>'account_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=account AND subtype IN ('bank','card') AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=account AND closed_on IS NOT NULL) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CLOSED'; END IF;
  SELECT * INTO previous_link FROM accounting.bank_accounts WHERE account_id=account AND NOT is_closed FOR UPDATE;
  books_today:=(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile WHERE id=1);
  -- The new feed starts the day after the last movement any earlier feed of this account imported, so the overlap is never pulled twice.
  SELECT max(o.posted_date) INTO last_movement FROM accounting.bank_transactions o JOIN accounting.bank_accounts ob ON ob.id=o.bank_account_id WHERE ob.account_id=account;
  link_start:=coalesce(last_movement+1,previous_link.coverage_from,(SELECT primary_system_since FROM accounting.settings WHERE id=1),books_today-90);
  IF previous_link.id IS NOT NULL THEN
   UPDATE accounting.bank_accounts SET is_closed=true,closed_on=least(books_today,link_start-1) WHERE id=previous_link.id;
  END IF;
  INSERT INTO accounting.bank_accounts(id,account_id,connection_id,provider_account_id,institution,mask,movement_sign,coverage_from)
   VALUES(key,account,mapping_connection,mapping_details->>'provider_account_id',coalesce(mapping_details->>'institution',''),'',coalesce(previous_link.movement_sign,1),link_start) RETURNING version INTO v;
  -- The bank reports the new card's balance the way it reported the old one's.
  UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['balance_signs'],coalesce(checkpoint->'balance_signs','{}')||jsonb_build_object(key::text,coalesce((SELECT (oc.checkpoint->'balance_signs'->>previous_link.id::text)::smallint FROM accounting.bank_connections oc WHERE oc.id=previous_link.connection_id),1))) WHERE id=mapping_connection;
 ELSIF t='feed.dismiss' THEN
  -- The owner says a discovered account is not a replacement for this feed; that suggestion stays away.
  SELECT bc.id INTO mapping_connection FROM accounting.bank_connections bc WHERE bc.checkpoint->'discovery' ? banking_command.key::text;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM accounting.bank_accounts WHERE id=(c->>'replaces')::uuid) THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['discovery',key::text,'not_replacing'],coalesce(checkpoint->'discovery'->key::text->'not_replacing','[]')||to_jsonb(c->>'replaces'),true) WHERE id=mapping_connection;
  v:=0;
 ELSIF t='feed.skip' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  SELECT * INTO mapped_row FROM accounting.bank_accounts WHERE id=key;
  IF NOT FOUND OR mapped_row.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY[mapped_row.provider_account_id],to_jsonb(c->>'through')) WHERE id=mapped_row.connection_id;
  UPDATE accounting.bank_accounts SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t='bank.exclude' THEN
  UPDATE accounting.bank_transactions SET review=CASE WHEN coalesce((c->>'excluded')::boolean,true) THEN 'excluded' ELSE 'unmatched' END,excluded_reason=coalesce(c->>'reason','') WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.release' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  DELETE FROM accounting.bank_matches WHERE id=(c->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.match' THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=coalesce(c->>'bank_transaction_id',c->>'group_id',c->>'id')::uuid;
  IF observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(c->'discard_drafts','[]')) LOOP
   PERFORM accounting.ledger_command(x||jsonb_build_object('type','draft.discard','reason',c->>'reason'));
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(c->'allocations',jsonb_build_array(jsonb_build_object('line_id',c->'journal_line_id','amount_cents',c->'amount_cents')))) LOOP
   INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,(x->>'line_id')::uuid,(x->>'amount_cents')::bigint,actor);
  END LOOP;
 ELSIF t='transfer.create' THEN
  amount:=(c->>'amount_cents')::bigint;out_date:=(c->>'outgoing_date')::date;in_date:=(c->>'incoming_date')::date;
  IF amount<=0 OR c->>'from_account_id'=c->>'to_account_id' OR (SELECT count(*) FROM accounting.accounts WHERE id IN ((c->>'from_account_id')::uuid,(c->>'to_account_id')::uuid) AND subtype IN ('bank','cash','card'))<>2 THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  outgoing:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',out_date,'memo',c->'memo','kind','transfer','lines',jsonb_build_array(jsonb_build_object('account_id',c->'from_account_id','amount_cents',(-amount)::text),jsonb_build_object('account_id',CASE WHEN out_date=in_date THEN (c->>'to_account_id')::uuid ELSE transit END,'amount_cents',amount::text))));
  out_id:=(outgoing->>'id')::uuid;
  UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=out_id RETURNING version INTO v;
  outgoing:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',out_id,'expected_version',v));
  in_id:=out_id;
  IF out_date<>in_date THEN
   incoming:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',in_date,'memo',c->'memo','kind','transfer','lines',jsonb_build_array(jsonb_build_object('account_id',transit,'amount_cents',(-amount)::text),jsonb_build_object('account_id',c->'to_account_id','amount_cents',amount::text))));
   in_id:=(incoming->>'id')::uuid;
   UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=in_id RETURNING version INTO v;
   incoming:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',in_id,'expected_version',v));
  END IF;
  -- Explicit creation of a transfer consumes only unambiguous matching bank evidence.
  FOR item IN SELECT l.* FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id IN(out_id,in_id) AND a.subtype IN ('bank','cash','card') LOOP
   SELECT count(*) INTO candidate_count FROM accounting.bank_transactions o JOIN accounting.bank_accounts b ON b.id=o.bank_account_id
    WHERE b.account_id=item.account_id AND o.amount_cents=item.amount_cents AND o.state='posted' AND o.review<>'excluded'
      AND o.posted_date=(SELECT entry_date FROM accounting.journal_entries WHERE id=item.entry_id)
      AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND (e.status<>'draft' OR e.origin NOT IN ('simplefin','csv')));
   IF candidate_count=1 THEN
    SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts b ON b.id=o.bank_account_id
     WHERE b.account_id=item.account_id AND o.amount_cents=item.amount_cents AND o.state='posted' AND o.review<>'excluded'
       AND o.posted_date=(SELECT entry_date FROM accounting.journal_entries WHERE id=item.entry_id)
       AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND (e.status<>'draft' OR e.origin NOT IN ('simplefin','csv')));
    FOR existing IN SELECT DISTINCT jsonb_build_object('id',e.id,'version',e.version) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=observation.id LOOP
     PERFORM set_config('accounting.reason','Replaced by owner-created transfer',true);
     PERFORM accounting.ledger_command(jsonb_build_object('type','draft.discard','id',existing->'id','expected_version',existing->'version','reason','Replaced by owner-created transfer'));
    END LOOP;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,item.id,abs(item.amount_cents),actor);
   END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'version',1,'outgoing_entry_id',out_id,'incoming_entry_id',in_id);
 ELSIF t='transfer.link' THEN
  out_id:=(c->>'outgoing_entry_id')::uuid;in_id:=(c->>'incoming_entry_id')::uuid;amount:=(c->>'amount_cents')::bigint;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  IF amount<=0 OR c->>'from_account_id'=c->>'to_account_id' THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=out_id AND status='posted' AND transfer_group_id IS NULL)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=in_id AND status='posted' AND transfer_group_id IS NULL) THEN RAISE EXCEPTION 'ACCT_TRANSFER_ALREADY_LINKED_OR_UNPOSTED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=out_id AND account_id=(c->>'from_account_id')::uuid AND amount_cents=-amount)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=in_id AND account_id=(c->>'to_account_id')::uuid AND amount_cents=amount) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF out_id<>in_id AND (NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=out_id AND account_id=transit AND amount_cents=amount)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=in_id AND account_id=transit AND amount_cents=-amount)) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF EXISTS(SELECT entry_id FROM accounting.journal_lines WHERE entry_id IN (out_id,in_id) GROUP BY entry_id HAVING count(*)<>2) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id IN(out_id,in_id);
  RETURN jsonb_build_object('id',key,'outgoing_entry_id',out_id,'incoming_entry_id',in_id);
 ELSIF t IN ('transfer.confirm','transfer.unpair') THEN
  SELECT * INTO leg FROM accounting.journal_entries WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM leg.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF leg.status<>'draft' OR leg.pair_entry_id IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_NOT_PAIRED'; END IF;
  IF t='transfer.unpair' THEN
   PERFORM accounting.transfer_unpair(key);
   RETURN jsonb_build_object('id',key,'version',(SELECT version FROM accounting.journal_entries WHERE id=key),'pair_entry_id',leg.pair_entry_id);
  END IF;
  SELECT * INTO mate FROM accounting.journal_entries WHERE id=leg.pair_entry_id;
  IF mate.status IS DISTINCT FROM 'draft' OR mate.pair_entry_id IS DISTINCT FROM key THEN RAISE EXCEPTION 'ACCT_TRANSFER_NOT_PAIRED'; END IF;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  -- The pair must still be exactly a transfer through transit: one bank line and one transit line a side, opposite amounts, two accounts.
  IF (SELECT count(*) FROM accounting.journal_lines WHERE entry_id IN (key,mate.id))<>4
   OR (SELECT count(*) FROM accounting.journal_lines WHERE entry_id IN (key,mate.id) AND account_id=transit)<>2
   OR (SELECT count(DISTINCT l.account_id)<>2 OR sum(l.amount_cents)<>0 OR count(DISTINCT l.entry_id)<>2 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id IN (key,mate.id) AND a.subtype IN ('bank','cash','card'))
  THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  account:=gen_random_uuid();
  UPDATE accounting.journal_entries SET pair_entry_id=NULL,transfer_group_id=account WHERE id IN (key,mate.id);
  FOR x IN SELECT jsonb_build_object('id',e.id,'version',e.version) FROM accounting.journal_entries e WHERE e.id IN (key,mate.id) ORDER BY e.entry_date,e.id LOOP
   PERFORM accounting.ledger_command(jsonb_build_object('type','entry.post','id',x->'id','expected_version',x->'version'));
  END LOOP;
  RETURN jsonb_build_object('id',key,'version',(SELECT version FROM accounting.journal_entries WHERE id=key),'transfer_group_id',account,'pair_entry_id',mate.id);
 ELSIF t='transfer.reverse' THEN
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE transfer_group_id=key AND reverses_entry_id IS NULL) THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT to_jsonb(e) FROM accounting.journal_entries e WHERE transfer_group_id=key AND reverses_entry_id IS NULL ORDER BY entry_date,id LOOP
   PERFORM accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',x->'id','expected_version',x->'version','entry_date',CASE WHEN EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=(x->>'id')::uuid AND amount_cents<0 AND account_id<>(SELECT id FROM accounting.accounts WHERE system_purpose='transfers_in_transit')) THEN c->>'outgoing_date' ELSE c->>'incoming_date' END,'reason',c->'reason'));
  END LOOP;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.sync_server(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c accounting.bank_connections; ba accounting.bank_accounts; observation accounting.bank_transactions; a jsonb; tx jsonb; normalized jsonb;
 provider_key text; discover_id uuid; new_checkpoint jsonb; discovered jsonb; due_list jsonb; zone text; run uuid:=coalesce((command->>'run_id')::uuid,gen_random_uuid());
 run_complete boolean:=coalesce((command->>'complete')::boolean,true);count_new integer:=0;count_pending integer:=0;count_drafts integer:=0;count_conflicts integer:=0; book_date date; amount bigint; existing_id uuid;
 candidate_id uuid; candidate_count integer; allocation bigint; draft jsonb; bank_line uuid; category uuid; account_complete boolean; balance_sign smallint; seen jsonb; blocked jsonb; conflicts_before integer; partial boolean:=coalesce((command->>'partial')::boolean,false); discovery_only boolean:=coalesce((command->>'discovery')::boolean,false);
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'ACCT_WORKER_REQUIRED'; END IF;
 PERFORM accounting.write_lock();
 PERFORM set_config('accounting.operation_id',run::text,true);PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.action','sync',true);
 IF command->>'action'='due' THEN
  due_list:=coalesce((SELECT jsonb_agg(id ORDER BY next_sync_at NULLS FIRST,id) FROM accounting.bank_connections WHERE status='active' AND scheduled AND (next_sync_at IS NULL OR next_sync_at<=now()) AND (lease_until IS NULL OR lease_until<=now())),'[]');
  -- The heartbeat tells the Feeds screen a scheduler is really calling; sync on open never asks what is due.
  INSERT INTO accounting.feed_worker(id,last_tick_at,last_tick_due,source) VALUES(1,now(),jsonb_array_length(due_list),left(coalesce(command->>'source',''),40))
   ON CONFLICT (id) DO UPDATE SET last_tick_at=excluded.last_tick_at,last_tick_due=excluded.last_tick_due,source=excluded.source;
  RETURN due_list;
 END IF;
 SELECT * INTO c FROM accounting.bank_connections WHERE id=(command->>'id')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 IF command->>'action' IN ('claim.send','claim.complete','claim.fail') THEN
  IF c.status<>'reconnect_required' OR c.checkpoint->'claim'->>'id' IS DISTINCT FROM command->>'claim_id' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  IF command->>'action'='claim.send' THEN
   IF c.checkpoint->'claim'->>'state'<>'prepared' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,'{claim,state}','"sent"') WHERE id=c.id;
  ELSIF command->>'action'='claim.complete' THEN
   IF c.checkpoint->'claim'->>'state'<>'sent' OR length(coalesce(command->>'ciphertext',''))<20 THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET access_url_encrypted=command->>'ciphertext',key_version=coalesce((command->>'key_version')::smallint,1),status='active',last_error='',checkpoint=jsonb_set(checkpoint,'{claim,state}','"completed"') WHERE id=c.id;
  ELSE
   IF c.checkpoint->'claim'->>'state'<>'sent' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET last_error=left(coalesce(command->>'error','Connection setup failed'),1000),checkpoint=jsonb_set(checkpoint,'{claim,state}','"failed"') WHERE id=c.id;
  END IF;
  RETURN jsonb_build_object('id',c.id);
 END IF;
 IF command->>'action'='lease' THEN
  IF c.status<>'active' OR (c.lease_until>now() AND c.lease_run_id<>run) THEN RETURN jsonb_build_object('id',c.id,'acquired',false); END IF;
  UPDATE accounting.bank_connections SET lease_run_id=run,lease_until=now()+interval '5 minutes',checkpoint=jsonb_set(checkpoint,ARRAY['sync_run'],CASE WHEN c.lease_run_id=run AND c.lease_until>now() THEN coalesce(checkpoint->'sync_run','{}') ELSE jsonb_build_object('seen','[]'::jsonb,'complete',true) END) WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'acquired',true,'run_id',run,'access_url_encrypted',c.access_url_encrypted,'key_version',c.key_version,'checkpoint',c.checkpoint,'books_timezone',(SELECT books_timezone FROM public.business_profile WHERE id=1),
   'identities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'provider_connection_id',(b.provider_account_id::jsonb)->>0,'provider_account_id',(b.provider_account_id::jsonb)->>1,
    'history_start',extract(epoch FROM (coalesce(b.coverage_from,(SELECT earliest_history_date FROM public.business_profile WHERE id=1))::timestamp AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1)))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'resume_floor',NULL)) FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed),'[]'));
 END IF;
 IF c.lease_run_id IS DISTINCT FROM run OR c.lease_until<=now() OR c.status<>'active' THEN RAISE EXCEPTION 'ACCT_STALE_LEASE'; END IF;
 IF command->>'action'='fail' THEN
  UPDATE accounting.bank_connections SET last_error=left(coalesce(command->>'error','Bank sync failed'),1000),
   status=CASE WHEN coalesce((command->>'reconnect_required')::boolean,false) THEN 'reconnect_required' ELSE status END,
   next_sync_at=now()+greatest(interval '1 hour',make_interval(secs=>least(coalesce((command->>'retry_seconds')::numeric,0),86400))),lease_run_id=NULL,lease_until=NULL WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'status','error');
 END IF;
 IF command->>'action'<>'complete' OR jsonb_typeof(command->'accounts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 zone:=(SELECT books_timezone FROM public.business_profile WHERE id=1);new_checkpoint:=c.checkpoint;
 discovered:=coalesce(c.checkpoint->'discovery','{}');seen:=coalesce(c.checkpoint->'sync_run'->'seen','[]');blocked:=coalesce(c.checkpoint->'sync_run'->'blocked','[]');
 run_complete:=run_complete AND coalesce((c.checkpoint->'sync_run'->>'complete')::boolean,true);
 FOR a IN SELECT value FROM jsonb_array_elements(command->'accounts') LOOP
  provider_key:=jsonb_build_array(a->>'provider_connection_id',a->>'provider_account_id')::text;
  discover_id:=md5(c.id::text||':'||provider_key)::uuid;
  discovered:=jsonb_set(discovered,ARRAY[discover_id::text],jsonb_build_object('id',discover_id,'provider_account_id',provider_key,'raw_provider_account_id',a->>'provider_account_id','provider_connection_id',a->>'provider_connection_id','name',a->>'name','institution',a->>'institution','currency',a->>'currency','balance_cents',a->>'balance_cents','available_cents',a->>'available_cents','balance_at',a->'balance_at','ownership',coalesce(discovered->discover_id::text->>'ownership','unreviewed'),
   'seen_at',extract(epoch FROM now())::bigint,'not_replacing',coalesce(discovered->discover_id::text->'not_replacing','[]'::jsonb)));
  SELECT * INTO ba FROM accounting.bank_accounts WHERE connection_id=c.id AND provider_account_id=provider_key AND NOT is_closed;
  IF NOT FOUND THEN CONTINUE; END IF;
  IF a->>'currency'<>'USD' THEN run_complete:=false; CONTINUE; END IF;
  IF NOT seen ? provider_key THEN seen:=seen||jsonb_build_array(provider_key); END IF;
  balance_sign:=coalesce((new_checkpoint->'balance_signs'->>ba.id::text)::smallint,1);
  IF a->>'balance_cents' IS NOT NULL AND a->>'balance_at' IS NOT NULL THEN
   UPDATE accounting.bank_accounts SET observed_balance_cents=(a->>'balance_cents')::bigint*balance_sign,observed_at=to_timestamp((a->>'balance_at')::bigint) WHERE id=ba.id;
   -- Every balance the bank reports is kept, signed as above, so the books can tell since when they and the bank disagree.
   INSERT INTO accounting.balance_observations(bank_account_id,observed_at,balance_cents) VALUES(ba.id,to_timestamp((a->>'balance_at')::bigint),(a->>'balance_cents')::bigint*balance_sign)
    ON CONFLICT (bank_account_id,observed_at) DO UPDATE SET balance_cents=excluded.balance_cents,recorded_at=now() WHERE accounting.balance_observations.balance_cents<>excluded.balance_cents;
  END IF;
  IF discovery_only THEN CONTINUE; END IF;
  conflicts_before:=count_conflicts;account_complete:=coalesce((a->>'complete')::boolean,false) AND NOT blocked ? provider_key;
  IF coalesce((a->>'chunk_partial')::boolean,false) THEN account_complete:=false; END IF;
  FOR tx IN SELECT value FROM jsonb_array_elements(coalesce(a->'transactions','[]')) LOOP
   IF (tx->>'state' IN ('pending','nonfinancial') OR (tx->>'amount_cents')::bigint=0) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=ba.id AND external_id=tx->>'external_id' AND state='posted') THEN
    account_complete:=false;count_conflicts:=count_conflicts+1;CONTINUE;
   END IF;
   IF tx->>'state'='pending' THEN count_pending:=count_pending+1; CONTINUE; END IF;
   IF tx->>'state'='nonfinancial' OR (tx->>'amount_cents')::bigint=0 THEN CONTINUE; END IF;
   book_date:=(to_timestamp((tx->>'posted')::bigint) AT TIME ZONE zone)::date;
   amount:=(tx->>'amount_cents')::bigint*ba.movement_sign;
   IF ba.coverage_from IS NOT NULL AND book_date<ba.coverage_from THEN CONTINUE; END IF;
   SELECT * INTO observation FROM accounting.bank_transactions WHERE bank_account_id=ba.id AND external_id=tx->>'external_id';
   IF FOUND THEN
    IF observation.content_hash IS DISTINCT FROM tx->>'hash' OR observation.amount_cents<>amount OR observation.posted_date<>book_date THEN
     account_complete:=false;count_conflicts:=count_conflicts+1;CONTINUE;
    END IF;
   ELSE
    INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,transacted_at,amount_cents,description,descriptor_key,content_hash,raw_payload,state)
     VALUES(ba.id,'simplefin',tx->>'external_id',book_date,to_timestamp((tx->>'transacted_at')::bigint),amount,tx->>'description',accounting.descriptor_key(tx->>'description'),tx->>'hash',tx->'raw','posted') RETURNING * INTO observation;
    count_new:=count_new+1;
   END IF;
   IF observation.review<>'unmatched' OR EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=observation.id) THEN CONTINUE; END IF;
   SELECT count(*),(array_agg(l.id ORDER BY e.entry_date,l.id))[1] INTO candidate_count,candidate_id
    FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=ba.account_id AND l.amount_cents=amount AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
     AND abs(e.entry_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
     AND (NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=l.id)
      OR EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions o ON o.id=m.bank_transaction_id WHERE m.journal_line_id=l.id AND m.amount_cents=abs(amount) AND o.source<>observation.source AND o.bank_account_id=ba.id AND o.amount_cents=amount AND abs(o.posted_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)));
   IF candidate_count=1 THEN
    allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=candidate_id) THEN 0 ELSE abs(amount) END;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents) VALUES(observation.id,candidate_id,allocation);
   ELSIF coalesce((command->>'create_drafts')::boolean,false) THEN
    -- Closed-period evidence stays unmatched for owner resolution; never shift its date.
    IF EXISTS(SELECT 1 FROM accounting.periods WHERE status='locked' AND month>=date_trunc('month',book_date)::date) THEN CONTINUE; END IF;
    SELECT id INTO category FROM accounting.accounts WHERE system_purpose=CASE WHEN amount>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
    draft:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',book_date,'memo',observation.description,'source_description',observation.description,'origin','simplefin','kind',CASE WHEN amount>0 THEN 'income' ELSE 'expense' END,
     'lines',jsonb_build_array(jsonb_build_object('account_id',ba.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',category,'amount_cents',(-amount)::text))));
    SELECT id INTO bank_line FROM accounting.journal_lines WHERE entry_id=(draft->>'id')::uuid AND account_id=ba.account_id;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents) VALUES(observation.id,bank_line,abs(amount));
    PERFORM accounting.apply_treatment((draft->>'id')::uuid);count_drafts:=count_drafts+1;
   END IF;
  END LOOP;
  IF count_conflicts>conflicts_before AND NOT blocked ? provider_key THEN blocked:=blocked||jsonb_build_array(provider_key); END IF;
  IF NOT account_complete AND NOT coalesce((a->>'chunk_partial')::boolean,false) THEN run_complete:=false; END IF;
  IF account_complete THEN
   new_checkpoint:=jsonb_set(new_checkpoint,ARRAY[provider_key],coalesce(a->'through',command->'through','null'));
  END IF;
 END LOOP;
 IF NOT partial AND NOT discovery_only AND EXISTS(SELECT 1 FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed AND NOT seen ? b.provider_account_id) THEN run_complete:=false; END IF;
 new_checkpoint:=jsonb_set(new_checkpoint,ARRAY['discovery'],discovered);
 new_checkpoint:=jsonb_set(new_checkpoint,ARRAY['sync_run'],jsonb_build_object('seen',seen,'blocked',blocked,'complete',run_complete AND count_conflicts=0));
 -- 110 minutes lands the two-hour cadence on the next hourly worker tick; an incomplete run retries at the following tick.
 UPDATE accounting.bank_connections SET checkpoint=new_checkpoint,last_success_at=CASE WHEN NOT partial AND NOT discovery_only AND count_conflicts=0 AND run_complete THEN now() ELSE last_success_at END,
  last_error=CASE WHEN count_conflicts>0 THEN 'Provider records changed. Original evidence was retained; review before advancing coverage.' WHEN NOT run_complete THEN 'The provider reported incomplete account data.' ELSE '' END,
  lease_run_id=CASE WHEN partial THEN run ELSE NULL END,lease_until=CASE WHEN partial THEN c.lease_until ELSE NULL END,next_sync_at=now()+CASE WHEN run_complete AND count_conflicts=0 THEN interval '110 minutes' ELSE interval '1 hour' END WHERE id=c.id;
 INSERT INTO accounting.audit_log(actor_kind,operation_id,table_name,row_id,action,after)
  VALUES('worker',run,'bank_connections',c.id,'sync',jsonb_build_object('accounts',jsonb_array_length(command->'accounts'),'new',count_new,'pending',count_pending,'drafts',count_drafts,'errors',count_conflicts));
 RETURN jsonb_build_object('id',c.id,'new',count_new,'pending',count_pending,'drafts',count_drafts,'conflicts',count_conflicts,'complete',run_complete AND count_conflicts=0);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.context(view text, params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=accounting.require_owner();result jsonb;key uuid;selected_record jsonb;items jsonb;candidates jsonb;
BEGIN
 IF view='session' THEN RETURN jsonb_build_object('owner_id',actor); END IF;
 IF view='manage' THEN
  RETURN jsonb_build_object('profiles',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',id,'version',version,'purpose',system_purpose,'cash_kind',CASE WHEN subtype IN ('bank','cash','card') THEN subtype ELSE 'none' END,'parent_account_id',parent_id,'subtype',subtype,'type',type,'external_names',external_names,'closed_on',closed_on,
    'last_activity_on',CASE WHEN subtype IN ('bank','card','cash') THEN (SELECT max(pe.entry_date) FROM accounting.journal_lines pl JOIN accounting.journal_entries pe ON pe.id=pl.entry_id WHERE pl.account_id=accounts.id AND pe.status<>'discarded') END) ORDER BY code,name),'[]') FROM accounting.accounts),
   'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('tax_classification',CASE WHEN contractor_classification='unknown' THEN 'unreviewed' ELSE contractor_classification END,'documentation',documentation_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by),'top_category',CASE WHEN t.account_id IS NULL THEN NULL ELSE jsonb_build_object('id',t.account_id,'name',t.account_name) END) ORDER BY p.name),'[]') FROM accounting.parties p LEFT JOIN accounting.contact_top_categories() t ON t.party_id=p.id),
   'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked')),'[]') FROM accounting.periods p),
   'rule_suggestions',(SELECT count(*) FROM accounting.rules WHERE review_status='suggested'),
   'preferences',(SELECT to_jsonb(s)-ARRAY['owner_user_id','financial_revision']||jsonb_build_object('history_start',p.earliest_history_date,'legal_name',p.legal_name,'business_profile',to_jsonb(p)) FROM accounting.settings s CROSS JOIN public.business_profile p));
 ELSIF view='feeds' THEN
  RETURN jsonb_build_object('owner_id',actor,
   'connections',(SELECT coalesce(jsonb_agg(to_jsonb(c)-ARRAY['access_url_encrypted','key_version','checkpoint','lease_run_id'] ORDER BY created_at,id),'[]') FROM accounting.bank_connections c),
   'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id),'last_movement_on',(SELECT max(o.posted_date) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id))),'[]') FROM accounting.bank_accounts b JOIN accounting.bank_connections c ON c.id=b.connection_id CROSS JOIN public.business_profile p),
   'identities',(SELECT coalesce(jsonb_agg(d.value||jsonb_build_object('connection_id',c.id,'provider_account_id',d.value->>'raw_provider_account_id','version',coalesce(b.version,0),'feed_account_id',b.id,'last_seen_at',c.updated_at,
    'account',CASE WHEN b.id IS NULL THEN NULL ELSE to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id),'last_movement_on',(SELECT max(o.posted_date) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id)) END,
    'balance',jsonb_build_object('balance_cents',d.value->'balance_cents','available_cents',d.value->'available_cents','balance_at',d.value->'balance_at','issues','[]'::jsonb,'created_at',c.updated_at)) ORDER BY c.created_at,d.key),'[]') FROM accounting.bank_connections c CROSS JOIN public.business_profile p CROSS JOIN LATERAL jsonb_each(coalesce(c.checkpoint->'discovery','{}')) d LEFT JOIN accounting.bank_accounts b ON b.id=d.key::uuid),
   'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.operation_id,'connection_id',a.row_id,'actor_kind',a.actor_kind,'status',CASE WHEN (a.after->>'errors')::int>0 THEN 'incomplete' ELSE 'saved' END,'started_at',a.at,'finished_at',a.at,'error','') ORDER BY a.at DESC),'[]') FROM (SELECT * FROM accounting.audit_log WHERE table_name='bank_connections' AND action='sync' AND after ? 'accounts' ORDER BY at DESC LIMIT 100) a),
   'queue',(SELECT coalesce(jsonb_agg(jsonb_build_object('feed_account_id',b.id,'ready',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND o.review='unmatched' AND state='posted'),'pending',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND state='pending'))),'[]') FROM accounting.bank_accounts b),
   'worker',(SELECT jsonb_build_object('last_tick_at',w.last_tick_at,'last_tick_due',w.last_tick_due,'source',w.source) FROM accounting.feed_worker w WHERE w.id=1));
 ELSIF view='rules' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('description_mode',coalesce(r.conditions->>'description_mode',(SELECT d.key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) d LIMIT 1)),'description',coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1)),'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction','min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id','reason','',
   'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=r.suggested_by),
   -- Why a rule is off: the change that switched it off (an edit or the owner's pause), or never switched on yet.
   'paused',CASE WHEN r.enabled THEN NULL ELSE coalesce((SELECT jsonb_build_object('cause',CASE a.action WHEN 'rule.save' THEN 'edited' WHEN 'rule.activate' THEN 'paused' ELSE 'other' END,'at',a.at) FROM accounting.audit_log a
    WHERE a.table_name='rules' AND a.row_id=r.id AND coalesce((a.before->>'enabled')::boolean,false) AND NOT coalesce((a.after->>'enabled')::boolean,false) ORDER BY a.id DESC LIMIT 1),jsonb_build_object('cause','never_on','at',r.created_at)) END,
   'suggestion',CASE WHEN r.review_status='suggested' THEN accounting.rule_evidence(r.id) END) ORDER BY priority,id),'[]') FROM accounting.rules r),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name,'match_mode',a.match_kind,'description',a.pattern) ORDER BY a.pattern),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id));
 ELSIF view='close-history' THEN
  RETURN jsonb_build_object('periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked') ORDER BY month DESC),'[]') FROM accounting.periods p),'reconciliations',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id));
 ELSIF view='tax' THEN
  SELECT id INTO key FROM public.tax_estimates WHERE tax_year=(context.params->>'year')::integer AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1;
  RETURN accounting.tax_link(key)||jsonb_build_object('_safe_harbor_context',jsonb_build_object('as_of',(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'financial_revision',(SELECT financial_revision::text FROM accounting.settings),'available_documents',(SELECT coalesce(jsonb_agg(d.id),'[]') FROM accounting.documents d WHERE d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 ELSIF view='evidence' THEN
  key:=(context.params->>'id')::uuid;PERFORM accounting.entry_detail(key);
  RETURN jsonb_build_object('sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'source_system',o.source,'external_id',o.external_id,'observed_at',o.observed_at,'raw_payload',o.raw_payload)) FROM accounting.bank_transactions o WHERE EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE m.bank_transaction_id=o.id AND l.entry_id=key)),'[]'),
   'notes',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.after->>'note_id','note',a.after->>'note','created_at',a.at) ORDER BY a.at),'[]') FROM accounting.audit_log a WHERE a.row_id=key AND a.action='entry.annotate' AND a.after ? 'note_id'),
   'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'original_name',d.name,'size_bytes',d.size_bytes::text,'mime_type',d.mime)),'[]') FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=key),
   'rules',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'rule_id',a.before->>'rule_id','rule_version',(a.before->>'rule_version')::integer,'rule_name',a.before->'winner'->>'name','created_at',a.at,'before_value',a.before,'after_value',a.after) ORDER BY a.id),'[]') FROM accounting.audit_log a WHERE a.row_id=key AND a.action='rule.applied'),
   'audit',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'table_name',a.table_name,'action',a.action,'recorded_at',a.at,'before_value',a.before,'after_value',a.after) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.row_id=key));
 ELSIF view='tax-snapshot' THEN RETURN accounting.tax_link((context.params->>'id')::uuid)->'snapshot';
 ELSIF view='period-impact' THEN
  RETURN jsonb_build_object('month',(context.params->>'month')::date,'revision',(SELECT financial_revision::text FROM accounting.settings),'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',p.month,'is_locked',p.status='locked') ORDER BY p.month),'[]') FROM accounting.periods p WHERE p.month>=(context.params->>'month')::date),'snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'from_date',from_date,'to_date',to_date,'revision',financial_revision::text) ORDER BY created_at DESC),'[]') FROM accounting.report_snapshots WHERE to_date>=(context.params->>'month')::date));
 ELSIF view='cash-review' THEN
  SELECT jsonb_build_object('line_id',l.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'account_name',a.name,'amount_cents',l.amount_cents::text,'version',e.version,'status',e.status,
   'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('classification',c.classification,'amount_cents',c.amount_cents::text,'note',CASE WHEN l.cash_class IS NULL THEN 'Derived from counter-account' ELSE e.reason END)),'[]') FROM accounting.cash_lines(jsonb_build_object('from',e.entry_date,'to',e.entry_date,'mode','working')) c WHERE c.id=l.id)) INTO result
   FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.accounts a ON a.id=l.account_id WHERE l.id=(context.params->>'line')::uuid;
  IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;RETURN result;
 ELSIF view='reconciliation' THEN
  key:=(context.params->>'id')::uuid;
  WITH records AS (SELECT r.*,b.account_id FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE (context.params->>'account' IS NULL OR b.account_id=(context.params->>'account')::uuid))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'statements',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]')) INTO result FROM records r;
  SELECT to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) INTO selected_record FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE r.id=key;
  IF key IS NOT NULL AND selected_record IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'journal_line_id',i.journal_line_id,'entry_date',e.entry_date,'description',e.memo,'amount_cents',i.amount_cents::text) ORDER BY e.entry_date,i.id),'[]') INTO items FROM accounting.reconciliation_items i JOIN accounting.journal_lines l ON l.id=i.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE i.reconciliation_id=key;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'amount_cents',l.amount_cents::text,'remaining_cents',(l.amount_cents-coalesce((SELECT sum(amount_cents) FROM accounting.reconciliation_items WHERE journal_line_id=l.id),0))::text) ORDER BY e.entry_date,l.id),'[]') INTO candidates FROM (SELECT l.* FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(selected_record->>'account_id',context.params->>'account')::uuid AND e.status='posted' AND (selected_record IS NULL OR e.entry_date<=(selected_record->>'statement_end')::date) ORDER BY e.entry_date,l.id LIMIT 100 OFFSET coalesce((context.params->>'offset')::int,0)) l JOIN accounting.journal_entries e ON e.id=l.entry_id;
  RETURN result||jsonb_build_object('statement',selected_record,'proof',CASE WHEN selected_record IS NULL THEN NULL ELSE jsonb_build_object('ready',(selected_record->>'difference_cents')::numeric=0,'statement_difference_cents',selected_record->>'difference_cents','item_count',jsonb_array_length(items)) END,'items',items,'item_count',jsonb_array_length(items),'lines',candidates,'line_count',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(selected_record->>'account_id',context.params->>'account')::uuid AND e.status='posted' AND (selected_record IS NULL OR e.entry_date<=(selected_record->>'statement_end')::date)));
 ELSIF view='transfers' THEN
  WITH movements AS (SELECT e.transfer_group_id,e.id,e.entry_date,e.memo,e.version,l.amount_cents,a.name,
    EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) reversed
    FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id WHERE e.status='posted' AND e.reverses_entry_id IS NULL AND e.transfer_group_id IS NOT NULL AND a.subtype IN ('bank','cash','card')),
  grouped AS (SELECT transfer_group_id id,max(version) version,CASE WHEN bool_or(reversed) THEN 'corrected' ELSE 'posted' END status,
   (array_agg(id ORDER BY entry_date,id) FILTER(WHERE amount_cents<0))[1] outgoing_entry_id,(array_agg(id ORDER BY entry_date,id) FILTER(WHERE amount_cents>0))[1] incoming_entry_id,
   min(entry_date) FILTER(WHERE amount_cents<0) outgoing_date,max(entry_date) FILTER(WHERE amount_cents>0) incoming_date,max(abs(amount_cents))::text amount_cents,min(memo) memo,
   max(name) FILTER(WHERE amount_cents<0) from_name,max(name) FILTER(WHERE amount_cents>0) to_name,
   min(entry_date) FILTER(WHERE amount_cents<0)<=(context.params->>'to')::date AND max(entry_date) FILTER(WHERE amount_cents>0)>(context.params->>'to')::date in_transit FROM movements GROUP BY transfer_group_id),
  scoped AS(SELECT * FROM grouped WHERE CASE WHEN context.params->>'id' IS NOT NULL THEN id=(context.params->>'id')::uuid ELSE outgoing_date<=(context.params->>'to')::date AND incoming_date>=(context.params->>'from')::date END),
  paged AS(SELECT * FROM scoped ORDER BY outgoing_date DESC,id LIMIT least(greatest(coalesce((context.params->>'limit')::int,100),1),200) OFFSET coalesce((context.params->>'offset')::int,0))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',(SELECT count(*) FROM scoped),'groups',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY outgoing_date DESC,id),'[]') FROM paged p)) INTO result;RETURN result;
 ELSIF view='tax-history' THEN
  WITH scoped AS (SELECT a.id,a.at,a.reason,a.after FROM accounting.audit_log a
   WHERE a.table_name=CASE context.params->>'kind' WHEN 'mapping' THEN 'tax_mappings' WHEN 'adjustment' THEN 'tax_adjustments' WHEN 'basis' THEN 'tax_links' ELSE 'tax_mappings' END
    AND a.after IS NOT NULL
    AND (context.params->>'year' IS NULL OR (a.after->>'tax_year')::integer=(context.params->>'year')::integer)
    AND (context.params->>'key' IS NULL OR a.row_id=(context.params->>'key')::uuid OR a.after->>'account_id'=context.params->>'key' OR a.after->>'id'=context.params->>'key'))
  SELECT jsonb_build_object('count',(SELECT count(*) FROM scoped),'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',coalesce((s.after->>'version')::integer,1),'created_at',s.at,
    'reason',coalesce(nullif(s.reason,''),s.after->>'reason',s.after->>'notes',''),'concept',s.after->>'concept','amount_cents',s.after->>'amount_cents','effective_date',s.after->>'effective_date',
    'deductible_bps',(s.after->>'deductible_bps')::integer,'through_date',s.after->>'cutoff_date','document_id',s.after->>'document_id') ORDER BY s.at DESC),'[]')
   FROM (SELECT * FROM scoped ORDER BY at DESC LIMIT 50 OFFSET coalesce((context.params->>'offset')::integer,0)) s)) INTO result;RETURN result;
 END IF;
 RAISE EXCEPTION 'ACCT_INVALID_VIEW';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.close_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type';key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=accounting.require_owner();r accounting.reconciliations;period accounting.periods;
 v integer;bank uuid;x jsonb;month_date date:=(c->>'month')::date;ending date;checklist jsonb;snapshot jsonb;
BEGIN
 IF t='period.close' THEN t:='period.lock';END IF;
 IF t='reconciliation.unmatch' THEN t:='reconciliation.item.remove';c:=c||jsonb_build_object('item_id',c->'allocation_id');PERFORM set_config('accounting.reason',coalesce(nullif(c->>'reason',''),'Owner removed reconciliation selection'),true);END IF;
 IF t IN ('period.lock','period.reopen') THEN
  IF month_date IS NULL OR extract(day FROM month_date)<>1 THEN RAISE EXCEPTION 'ACCT_MONTH_REQUIRED';END IF;
  SELECT * INTO period FROM accounting.periods WHERE month=month_date;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM coalesce(period.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='period.lock' THEN
   IF period.status='locked' THEN RAISE EXCEPTION 'ACCT_PERIOD_LOCKED';END IF;
   checklist:=accounting.close_checklist(month_date);
   IF (checklist->>'drafts')::integer<>0 THEN RAISE EXCEPTION 'ACCT_DRAFTS_EXIST';END IF;
   IF NOT (checklist->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_CLOSE_NOT_READY';END IF;
   ending:=(month_date+interval '1 month - 1 day')::date;
   snapshot:=jsonb_build_object('financial_revision',(SELECT financial_revision::text FROM accounting.settings),'trial_balance',accounting.report('trial_balance',jsonb_build_object('as_of',ending)),
    'profit_loss',accounting.report('profit_loss',jsonb_build_object('from',month_date,'to',ending)),'balance_sheet',accounting.report('balance_sheet',jsonb_build_object('as_of',ending)));
   INSERT INTO accounting.periods(month,status,locked_at,locked_by,close_snapshot) VALUES(month_date,'locked',now(),actor,snapshot)
    ON CONFLICT(month) DO UPDATE SET status='locked',locked_at=excluded.locked_at,locked_by=excluded.locked_by,close_snapshot=excluded.close_snapshot,reopen_reason='' RETURNING version INTO v;
  ELSE
   IF period.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'ACCT_PERIOD_NOT_LOCKED';END IF;
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   -- Reopening an earlier month also reopens dependent later snapshots atomically.
   UPDATE accounting.periods SET status='open',locked_at=NULL,locked_by=NULL,close_snapshot=NULL,reopen_reason=c->>'reason' WHERE month>=month_date AND status='locked';
   SELECT version INTO v FROM accounting.periods WHERE month=month_date;
  END IF;
 ELSIF t IN ('reconciliation.save','reconciliation.create') THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM coalesce(r.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF r.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
  bank:=(c->>'bank_account_id')::uuid;
  IF bank IS NULL THEN
   -- The open link when there is one; a closed account reconciles on its latest link.
   SELECT id INTO bank FROM accounting.bank_accounts WHERE account_id=(c->>'account_id')::uuid ORDER BY is_closed,created_at DESC,id LIMIT 1;
   IF bank IS NULL THEN INSERT INTO accounting.bank_accounts(account_id,is_closed,closed_on) SELECT ra.id,ra.closed_on IS NOT NULL,ra.closed_on FROM accounting.accounts ra WHERE ra.id=(c->>'account_id')::uuid RETURNING id INTO bank;END IF;
  END IF;
  INSERT INTO accounting.reconciliations(id,bank_account_id,statement_start,statement_end,opening_balance_cents,ending_balance_cents,document_id,difference_cents,notes)
   VALUES(key,bank,coalesce(c->>'statement_start',c->>'from')::date,coalesce(c->>'statement_end',c->>'to')::date,coalesce(c->>'opening_balance_cents',c->>'opening_cents')::bigint,coalesce(c->>'ending_balance_cents',c->>'ending_cents')::bigint,(c->>'document_id')::uuid,0,coalesce(c->>'notes',''))
   ON CONFLICT(id) DO UPDATE SET statement_start=excluded.statement_start,statement_end=excluded.statement_end,opening_balance_cents=excluded.opening_balance_cents,ending_balance_cents=excluded.ending_balance_cents,document_id=excluded.document_id,notes=excluded.notes RETURNING version INTO v;
  IF c?'items' THEN
   PERFORM set_config('accounting.reason',coalesce(c->>'reason','Owner updated reconciliation selection'),true);
   DELETE FROM accounting.reconciliation_items WHERE reconciliation_id=key;
   FOR x IN SELECT value FROM jsonb_array_elements(c->'items') LOOP
    INSERT INTO accounting.reconciliation_items(id,reconciliation_id,journal_line_id,amount_cents) VALUES(coalesce((x->>'id')::uuid,gen_random_uuid()),key,coalesce(x->>'journal_line_id',x->>'line_id')::uuid,(x->>'amount_cents')::bigint);
   END LOOP;
   UPDATE accounting.reconciliations SET updated_at=now() WHERE id=key RETURNING version INTO v;
  END IF;
 ELSIF t='reconciliation.allocate' THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'allocations') LOOP
   INSERT INTO accounting.reconciliation_items(id,reconciliation_id,journal_line_id,amount_cents) VALUES((x->>'id')::uuid,key,coalesce(x->>'journal_line_id',x->>'entry_line_id')::uuid,(x->>'amount_cents')::bigint);
  END LOOP;
  UPDATE accounting.reconciliations SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t IN ('reconciliation.complete','reconciliation.reopen','reconciliation.item.remove') THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='reconciliation.item.remove' THEN DELETE FROM accounting.reconciliation_items WHERE id=(c->>'item_id')::uuid AND reconciliation_id=key;
  ELSIF t='reconciliation.reopen' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
  UPDATE accounting.reconciliations SET status=CASE t WHEN 'reconciliation.complete' THEN 'completed' ELSE 'in_progress' END,completed_at=CASE WHEN t='reconciliation.complete' THEN now() ELSE NULL END WHERE id=key RETURNING version INTO v;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_build_object('id',key,'version',v);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.reconciliation_status(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE zone text; today date; selected uuid; result jsonb;
BEGIN
 PERFORM accounting.require_reader();
 IF jsonb_typeof(params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 selected:=(params->>'account')::uuid;
 IF selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.id=selected AND a.subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 zone:=coalesce((SELECT books_timezone FROM public.business_profile WHERE id=1),'America/Phoenix');
 today:=(now() AT TIME ZONE zone)::date;
 -- Ledger amounts are debit positive. Shown on each account's normal side: cash held positive, card debt owed positive.
 -- observed_balance_cents already carries the connection's balance sign (sync_server applies it), as the Accounts screen reads it.
 WITH money AS (
  SELECT a.id,a.name,a.code,a.subtype,b.id AS bank_id,b.institution,b.mask,b.observed_balance_cents AS observed,b.observed_at,
   (b.observed_at AT TIME ZONE zone)::date AS observed_day,b.connection_id,CASE WHEN a.subtype='card' THEN -1 ELSE 1 END AS sign,a.closed_on
  FROM accounting.accounts a LEFT JOIN accounting.bank_accounts b ON b.account_id=a.id AND NOT b.is_closed
  WHERE a.subtype IN ('bank','card','cash') AND (selected IS NULL OR a.id=selected) AND (NOT a.is_archived OR a.id=selected)
 ), live AS (
  SELECT l.account_id,e.entry_date,e.status,l.amount_cents FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
  WHERE l.account_id IN (SELECT m.id FROM money m) AND (e.status='posted' OR (e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
 ), measured AS (
  SELECT m.*,
   coalesce((SELECT sum(v.amount_cents) FROM live v WHERE v.account_id=m.id AND v.entry_date<=today),0) AS book,
   coalesce((SELECT sum(v.amount_cents) FROM live v WHERE v.account_id=m.id AND v.entry_date<=today AND v.status='posted'),0) AS book_posted,
   -- The gap compares the books on the day the bank reported, so an entry dated later never reads as a difference.
   coalesce((SELECT sum(v.amount_cents) FROM live v WHERE v.account_id=m.id AND v.entry_date<=m.observed_day),0) AS book_observed,
   c.name AS connection_name,c.status AS connection_status,c.last_success_at,c.last_error,
   c.id IS NOT NULL AND (c.status<>'active' OR coalesce(c.last_success_at,c.created_at)<now()-interval '24 hours') AS stale
  FROM money m LEFT JOIN accounting.bank_connections c ON c.id=m.connection_id
 )
 SELECT jsonb_build_object('as_of',today,'checked_at',now(),'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1),
  'accounts',coalesce(jsonb_agg(jsonb_build_object(
   'account',jsonb_build_object('id',r.id,'name',r.name,'code',nullif(r.code,''),'kind',r.subtype,'institution',nullif(r.institution,''),'mask',nullif(r.mask,''),'closed_on',r.closed_on),
   'book_cents',(r.book*r.sign)::text,'book_posted_cents',(r.book_posted*r.sign)::text,
   'bank_cents',(r.observed*r.sign)::text,'bank_observed_at',r.observed_at,
   'gap_cents',((r.book_observed-r.observed)*r.sign)::text,
   'off_since',CASE WHEN r.observed IS NOT NULL AND r.book_observed<>r.observed THEN coalesce(accounting.balance_off_since(r.bank_id),r.observed_at) END,
   'pending_count',(SELECT count(*) FROM accounting.bank_transactions t WHERE t.bank_account_id=r.bank_id AND t.state='pending'),
   'unmatched',(SELECT jsonb_build_object('count',count(*),'amount_cents',coalesce(sum(t.amount_cents),0)::text,'oldest',min(t.posted_date)) FROM accounting.bank_transactions t WHERE t.bank_account_id=r.bank_id AND t.state='posted' AND t.review='unmatched'),
   'last_reconciled_through',(SELECT max(x.statement_end) FROM accounting.reconciliations x WHERE x.bank_account_id=r.bank_id AND x.status='completed'),
   'feed',CASE WHEN r.connection_id IS NULL THEN NULL ELSE jsonb_build_object('connection_id',r.connection_id,'connection',r.connection_name,'status',r.connection_status,'last_success_at',r.last_success_at,'last_error',nullif(r.last_error,''),'stale',r.stale) END,
   'status',CASE WHEN r.closed_on IS NOT NULL THEN 'closed' WHEN r.connection_id IS NULL THEN 'no_feed' WHEN r.stale THEN 'stale_feed' WHEN r.observed IS NOT NULL AND r.book_observed<>r.observed THEN 'gap' ELSE 'ok' END)
  ORDER BY r.subtype,r.code,r.name,r.id),'[]'::jsonb)) INTO result FROM measured r;
 RETURN result;
END $function$
;

COMMIT;
