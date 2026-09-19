-- Transfer pairing and fill indicators. A bank draft the books categorize on
-- their own now records how (fill_source), and two uncategorized bank drafts
-- that are one movement between the owner's own accounts are proposed as a
-- transfer: both drafts stay, each moved to Transfers in transit and pointed
-- at the other (pair_entry_id). transfer.confirm posts both under one
-- transfer_group_id, the same shape transfer.create writes across dates;
-- transfer.unpair puts both back and the books never propose them again.
-- A proposal needs exactly one candidate each way plus a signal: a transfer
-- confirmed before with the same two descriptors, bank text that names the
-- other account, or a transfer keyword. Without a signal the ledger only
-- suggests. Ends with a one-off backfill over the open uncategorized drafts.
BEGIN;

ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS "fill_source" text;

ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS "pair_entry_id" uuid;

ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS "entries_fill_draft_check";

ALTER TABLE accounting.journal_entries ADD CONSTRAINT "entries_fill_draft_check" CHECK (((status = 'draft'::text) OR ((fill_source IS NULL) AND (pair_entry_id IS NULL))));

ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS "entries_fill_source_check";

ALTER TABLE accounting.journal_entries ADD CONSTRAINT "entries_fill_source_check" CHECK ((fill_source = ANY (ARRAY['rule'::text, 'prior'::text, 'payee_default'::text, 'transfer_pair'::text])));

ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS "entries_pair_fk";

ALTER TABLE accounting.journal_entries ADD CONSTRAINT "entries_pair_fk" FOREIGN KEY (pair_entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT;

ALTER TABLE accounting.journal_entries DROP CONSTRAINT IF EXISTS "entries_pair_self_check";

ALTER TABLE accounting.journal_entries ADD CONSTRAINT "entries_pair_self_check" CHECK ((pair_entry_id <> id));

CREATE INDEX IF NOT EXISTS entries_pair ON accounting.journal_entries USING btree (pair_entry_id) WHERE (pair_entry_id IS NOT NULL);

CREATE OR REPLACE FUNCTION accounting.transfer_legs()
 RETURNS TABLE(entry_id uuid, account_id uuid, amount_cents bigint, entry_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- Bank drafts that could still be one side of a transfer: one bank line, one uncategorized line, never paired or declined, in open books.
 SELECT e.id,l.account_id,l.amount_cents,e.entry_date
 FROM accounting.journal_entries e
 JOIN accounting.journal_lines l ON l.entry_id=e.id
 JOIN accounting.accounts a ON a.id=l.account_id AND a.subtype IN ('bank','cash','card')
 WHERE e.status='draft' AND e.origin IN ('simplefin','csv') AND e.pair_entry_id IS NULL AND e.transfer_group_id IS NULL AND e.reverses_entry_id IS NULL
  AND (SELECT count(*) FROM accounting.journal_lines x WHERE x.entry_id=e.id)=2
  AND EXISTS(SELECT 1 FROM accounting.journal_lines s JOIN accounting.accounts sa ON sa.id=s.account_id WHERE s.entry_id=e.id AND sa.system_purpose IN ('uncategorized_income','uncategorized_expense'))
  AND NOT EXISTS(SELECT 1 FROM accounting.audit_log g WHERE g.table_name='journal_entries' AND g.row_id=e.id AND g.action='transfer.unpaired')
  AND NOT EXISTS(SELECT 1 FROM accounting.periods p WHERE p.status='locked' AND p.month>=date_trunc('month',e.entry_date)::date)
$function$
;

CREATE OR REPLACE FUNCTION accounting.transfer_candidate(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE mine record; theirs record; win integer; n integer; back integer; signal text; a text; b text; ka text; kb text;
 kw constant text:='\m(TRANSFER|AUTOPAY|EPAYMENT|E-PAYMENT|ONLINE PMT|MOBILE PMT)\M|PAYMENT[[:space:]-]*THANK YOU';
BEGIN
 SELECT * INTO mine FROM accounting.transfer_legs() t WHERE t.entry_id=entry;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT transfer_window_days INTO win FROM accounting.settings WHERE id=1;
 SELECT count(*) INTO n FROM accounting.transfer_legs() t WHERE t.entry_id<>entry AND t.account_id<>mine.account_id AND t.amount_cents=-mine.amount_cents AND abs(t.entry_date-mine.entry_date)<=win;
 IF n=0 THEN RETURN NULL; END IF;
 SELECT * INTO theirs FROM accounting.transfer_legs() t WHERE t.entry_id<>entry AND t.account_id<>mine.account_id AND t.amount_cents=-mine.amount_cents AND abs(t.entry_date-mine.entry_date)<=win
  ORDER BY abs(t.entry_date-mine.entry_date),t.entry_date,t.entry_id LIMIT 1;
 -- Mutual: the counterpart must have this movement as its only candidate too, or two payments of one amount could cross.
 SELECT count(*) INTO back FROM accounting.transfer_legs() t WHERE t.entry_id<>theirs.entry_id AND t.account_id<>theirs.account_id AND t.amount_cents=-theirs.amount_cents AND abs(t.entry_date-theirs.entry_date)<=win;
 IF n=1 AND back=1 THEN
  SELECT upper(coalesce(source_description,memo)),descriptor_key INTO a,ka FROM accounting.journal_entries WHERE id=entry;
  SELECT upper(coalesce(source_description,memo)),descriptor_key INTO b,kb FROM accounting.journal_entries WHERE id=theirs.entry_id;
  IF ka IS NOT NULL AND kb IS NOT NULL AND EXISTS(
   -- Learned: a posted transfer between the same two accounts, the same way round, claimed bank lines with these two descriptors.
   SELECT 1 FROM accounting.journal_entries g1
    JOIN accounting.journal_lines l1 ON l1.entry_id=g1.id AND l1.account_id=mine.account_id AND sign(l1.amount_cents)=sign(mine.amount_cents)
    JOIN accounting.bank_matches m1 ON m1.journal_line_id=l1.id
    JOIN accounting.bank_transactions o1 ON o1.id=m1.bank_transaction_id AND o1.descriptor_key=ka
    JOIN accounting.journal_entries g2 ON g2.transfer_group_id=g1.transfer_group_id AND g2.status='posted' AND g2.reverses_entry_id IS NULL
    JOIN accounting.journal_lines l2 ON l2.entry_id=g2.id AND l2.account_id=theirs.account_id AND sign(l2.amount_cents)=sign(theirs.amount_cents)
    JOIN accounting.bank_matches m2 ON m2.journal_line_id=l2.id
    JOIN accounting.bank_transactions o2 ON o2.id=m2.bank_transaction_id AND o2.descriptor_key=kb
    WHERE g1.transfer_group_id IS NOT NULL AND g1.status='posted' AND g1.reverses_entry_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id IN (g1.id,g2.id))) THEN signal:='learned';
  ELSIF EXISTS(
   -- One side's bank text names the other side's account: its institution or the last digits of its number.
   SELECT 1 FROM accounting.bank_accounts ba CROSS JOIN LATERAL (SELECT CASE WHEN ba.account_id=theirs.account_id THEN a ELSE b END txt) d
    WHERE ba.account_id IN (mine.account_id,theirs.account_id)
     AND ((length(btrim(ba.institution))>=3 AND position(upper(btrim(ba.institution)) IN d.txt)>0)
      OR (substring(ba.mask from '[0-9]{4,}') IS NOT NULL AND position(substring(ba.mask from '[0-9]{4,}') IN d.txt)>0))) THEN signal:='names_account';
  ELSIF a ~ kw OR b ~ kw THEN signal:='keyword';
  END IF;
 END IF;
 RETURN jsonb_build_object('counterpart_id',theirs.entry_id,'account_id',theirs.account_id,'entry_date',theirs.entry_date,'ambiguous',n<>1 OR back<>1,'signal',signal);
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
  UPDATE accounting.journal_entries SET pair_entry_id=other,fill_source='transfer_pair' WHERE id=leg;
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
  UPDATE accounting.journal_entries SET pair_entry_id=NULL,fill_source=NULL,kind=CASE WHEN bank.amount_cents>0 THEN 'income' ELSE 'expense' END WHERE id=leg;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,after)
  VALUES(CASE WHEN current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE auth.uid() END,
   coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'),
   coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid()),'journal_entries',leg,'transfer.unpaired',
   jsonb_build_object('pair_entry_id',CASE WHEN leg=entry THEN other ELSE entry END));
 END LOOP;
END $function$
;

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

CREATE OR REPLACE FUNCTION accounting.prior_summary(key text, bank_account uuid, max_rows integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 WITH matched AS (
  SELECT e.* FROM accounting.journal_entries e WHERE e.status='posted' AND e.descriptor_key=key AND e.transfer_group_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries reversal WHERE reversal.reverses_entry_id=e.id)
   AND e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id=bank_account)
 ), recent AS (SELECT * FROM matched ORDER BY entry_date DESC,created_at DESC,id LIMIT greatest(1,least(max_rows,100)))
 SELECT jsonb_build_object('count',(SELECT count(*) FROM matched),'last_date',(SELECT max(entry_date) FROM matched),
  'last_category',(SELECT l.account_id FROM recent e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE l.account_id<>bank_account ORDER BY e.entry_date DESC,e.created_at DESC,l.sort_order LIMIT 1),
  'payee_id',(SELECT payee_id FROM recent ORDER BY entry_date DESC,created_at DESC,id LIMIT 1),
  'memo',(SELECT memo FROM recent ORDER BY entry_date DESC,created_at DESC,id LIMIT 1),
  'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'payee_id',e.payee_id,'entry_date',e.entry_date,
   'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id<>bank_account)) ORDER BY e.entry_date DESC,e.created_at DESC,e.id) FROM recent e),'[]')) INTO result;
 RETURN result;
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
  UPDATE accounting.journal_entries SET applied_rule_id=(candidate->>'rule_id')::uuid,fill_source='rule' WHERE id=entry RETURNING * INTO e;
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
    UPDATE accounting.journal_entries SET fill_source='prior' WHERE id=entry RETURNING * INTO e;
   END IF;
  END IF;
 END IF;
 -- Still uncategorized after aliases, rules and prior treatment: fall back to the payee's default category.
 IF party IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN
  SELECT p.default_account_id INTO category FROM accounting.parties p WHERE p.id=party AND p.default_account_id IS NOT NULL;
  IF category IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',party::text,'memo',e.memo));
   UPDATE accounting.journal_entries SET fill_source='payee_default' WHERE id=entry RETURNING * INTO e;
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
   INSERT INTO accounting.journal_entries(id,entry_date,memo,source_description,origin,kind,payee_id,created_by,import_batch_id,register_id,reason)
    VALUES(k,(c->>'entry_date')::date,c->>'memo',c->>'source_description',coalesce(c->>'origin','manual'),coalesce(c->'context'->>'kind',c->>'kind','manual'),
    coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid,actor,(c->>'import_batch_id')::uuid,(c->>'register_id')::uuid,coalesce(c->>'reason','')) RETURNING version INTO v;
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
BEGIN
 IF t='party.save' THEN
  SELECT version INTO current_version FROM accounting.parties WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  INSERT INTO accounting.parties(id,name,kind,default_account_id,is_contractor,contractor_classification,documentation_status,notes,is_archived)
  VALUES(key,c->>'name',c->>'kind',(c->>'default_account_id')::uuid,coalesce((c->>'is_contractor')::boolean,false),
   CASE WHEN coalesce(c->>'contractor_classification',c->>'tax_classification','unknown')='unreviewed' THEN 'unknown' WHEN c->>'tax_classification'='partnership' THEN 'other' ELSE coalesce(c->>'contractor_classification',c->>'tax_classification','unknown') END,
   CASE WHEN c->>'documentation'='requested' THEN 'missing' ELSE coalesce(c->>'documentation_status',c->>'documentation','missing') END,coalesce(c->>'notes',''),coalesce((c->>'is_archived')::boolean,false))
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,default_account_id=excluded.default_account_id,is_contractor=excluded.is_contractor,contractor_classification=excluded.contractor_classification,documentation_status=excluded.documentation_status,notes=excluded.notes,is_archived=excluded.is_archived RETURNING version INTO v;
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
   UPDATE accounting.rules SET enabled=(c->>'enabled')::boolean WHERE id=key RETURNING version INTO v;
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
   INSERT INTO accounting.rules(id,name,priority,enabled,conditions,actions,auto_post) VALUES(key,c->>'name',coalesce((c->>'priority')::integer,100),coalesce((c->>'enabled')::boolean,false),cond,actions,coalesce((c->>'auto_post')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,conditions=excluded.conditions,actions=excluded.actions,enabled=excluded.enabled,auto_post=excluded.auto_post RETURNING version INTO v;
  END IF;
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
   INSERT INTO accounting.document_links(document_id,entry_id,bank_transaction_id,import_batch_id,reconciliation_id,payroll_run_id,register_id,party_id,created_by)
   VALUES(doc.id,(c->>'entry_id')::uuid,(c->>'bank_transaction_id')::uuid,(c->>'import_batch_id')::uuid,(c->>'reconciliation_id')::uuid,(c->>'payroll_run_id')::uuid,(c->>'register_id')::uuid,(c->>'party_id')::uuid,actor) ON CONFLICT DO NOTHING;
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
 ELSIF t='feed.skip' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  SELECT * INTO mapped_row FROM accounting.bank_accounts WHERE id=key;
  IF NOT FOUND OR mapped_row.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY[mapped_row.provider_account_id],to_jsonb(c->>'through')) WHERE id=mapped_row.connection_id;
  UPDATE accounting.bank_accounts SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t='feed.prepare' THEN RETURN jsonb_build_object('id',key,'prepared',0,'count',0);
 ELSIF t='bank.exclude' THEN
  UPDATE accounting.bank_transactions SET review=CASE WHEN coalesce((c->>'excluded')::boolean,true) THEN 'excluded' ELSE 'unmatched' END,excluded_reason=coalesce(c->>'reason','') WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.release' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  DELETE FROM accounting.bank_matches WHERE id=(c->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.match' THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=coalesce(c->>'bank_transaction_id',c->>'group_id',c->>'id')::uuid;
  IF NOT FOUND AND c->>'group_id' IS NOT NULL THEN
   SELECT o.* INTO observation FROM accounting.import_rows r JOIN accounting.bank_accounts b ON b.account_id=(r.parsed->>'bank_account_id')::uuid JOIN accounting.bank_transactions o ON o.bank_account_id=b.id AND o.external_id=r.external_id WHERE r.id=(c->>'group_id')::uuid;
  END IF;
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

CREATE OR REPLACE FUNCTION accounting.entry_detail(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb; extra jsonb; bank_account uuid;
BEGIN
 PERFORM accounting.require_owner();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'restored_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE restores_entry_id=e.id),
  'replacement_entry_id',(SELECT id FROM accounting.journal_entries WHERE replaces_entry_id=e.id LIMIT 1),
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (p.ytd->'patriot_import'->>'original_entry_id'=e.id::text AND p.ytd->'patriot_import'->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
  -- The own account on the other side of a linked transfer, so either leg can name where the money went or came from.
  'transfer_account_id',CASE WHEN e.transfer_group_id IS NOT NULL THEN (SELECT l.account_id FROM accounting.journal_entries g JOIN accounting.journal_lines l ON l.entry_id=g.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE g.transfer_group_id=e.transfer_group_id AND g.id<>e.id AND g.reverses_entry_id IS NULL AND a.subtype IN ('bank','card','cash') ORDER BY g.entry_date,l.sort_order LIMIT 1) END,
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

REVOKE ALL ON FUNCTION accounting.transfer_candidate(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.transfer_candidate(uuid) TO "postgres";

REVOKE ALL ON FUNCTION accounting.transfer_legs() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.transfer_legs() TO "postgres";

REVOKE ALL ON FUNCTION accounting.transfer_pair(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.transfer_pair(uuid,uuid,text) TO "postgres";

REVOKE ALL ON FUNCTION accounting.transfer_unpair(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.transfer_unpair(uuid) TO "postgres";

-- One-off backfill. It runs as the worker (the same path bank sync takes), so
-- it lives in a definer function the service role may call, dropped right after.
CREATE FUNCTION accounting.transfer_backfill()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE d uuid; c jsonb; n integer:=0;
BEGIN
 PERFORM accounting.write_lock();
 PERFORM set_config('accounting.operation_id',gen_random_uuid()::text,true);PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.action','transfer.backfill',true);
 -- Drafts a rule already filled keep saying so, as long as the rule's category is still on the draft.
 UPDATE accounting.journal_entries e SET fill_source='rule'
  WHERE e.status='draft' AND e.fill_source IS NULL AND e.applied_rule_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM accounting.periods p WHERE p.status='locked' AND p.month>=date_trunc('month',e.entry_date)::date)
   AND EXISTS(SELECT 1 FROM accounting.rules r JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE r.id=e.applied_rule_id AND l.account_id::text=r.actions->>'account_id');
 FOR d IN SELECT t.entry_id FROM accounting.transfer_legs() t ORDER BY t.entry_date,t.entry_id LOOP
  c:=accounting.transfer_candidate(d);
  IF c IS NOT NULL AND c->>'signal' IS NOT NULL AND NOT (c->>'ambiguous')::boolean THEN
   PERFORM accounting.transfer_pair(d,(c->>'counterpart_id')::uuid,c->>'signal'); n:=n+1;
  END IF;
 END LOOP;
 RETURN n;
END $function$
;

REVOKE ALL ON FUNCTION accounting.transfer_backfill() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION accounting.transfer_backfill() TO service_role;

SET LOCAL ROLE service_role;

SELECT accounting.transfer_backfill();

RESET ROLE;

DROP FUNCTION accounting.transfer_backfill();

-- >>> transfer link backfill
-- One-off: link the two legs of transfers that were recorded as separate
-- posted entries through the in-transit account (Wave's Transfer Clearing
-- history) so each leg can name the other account. Only transfer_group_id is
-- set: no amount, date, line or status changes, and nothing fires on closed
-- months. A link cannot be removed once set, so (false) previews: it does the
-- real work inside a subtransaction, reports, and rolls it back.
DROP FUNCTION IF EXISTS accounting.transfer_link_backfill(boolean);

DROP FUNCTION IF EXISTS accounting.transfer_link_legs();

DROP FUNCTION IF EXISTS accounting.transfer_link_names(text,text);

CREATE FUNCTION accounting.transfer_link_names(txt text, mask text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
 -- 1 when bank text carries an account's last digits as a whole number ("*4273", not inside a longer trace number).
 SELECT CASE WHEN mask IS NOT NULL AND txt ~ ('(^|[^0-9])'||mask||'([^0-9]|$)') THEN 1 ELSE 0 END
$function$
;

CREATE FUNCTION accounting.transfer_link_legs()
 RETURNS TABLE(entry_id uuid, account_id uuid, amount_cents bigint, entry_date date, txt text, mask text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- Posted, unlinked, unreversed entries that are exactly one bank line against the in-transit account.
 -- mask: the account's last digits, from its feed mapping or else the end of its name ("Checking -4273").
 SELECT e.id,l.account_id,l.amount_cents,e.entry_date,upper(coalesce(e.source_description,e.memo)),
  coalesce((SELECT substring(b.mask from '[0-9]{4,}') FROM accounting.bank_accounts b WHERE b.account_id=a.id),substring(a.name from '([0-9]{4,})[^0-9]*$'))
 FROM accounting.accounts ta
 JOIN accounting.journal_lines t ON t.account_id=ta.id
 JOIN accounting.journal_entries e ON e.id=t.entry_id
 JOIN accounting.journal_lines l ON l.entry_id=e.id AND l.id<>t.id AND l.amount_cents=-t.amount_cents
 JOIN accounting.accounts a ON a.id=l.account_id AND a.subtype IN ('bank','cash','card')
 WHERE ta.system_purpose='transfers_in_transit' AND e.status='posted' AND e.transfer_group_id IS NULL AND e.reverses_entry_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id=e.id)
  AND (SELECT count(*) FROM accounting.journal_lines x WHERE x.entry_id=e.id)=2
$function$
;

CREATE FUNCTION accounting.transfer_link_backfill(apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE win integer; passes text[]:=ARRAY['strict','named','twins','fifo']; i integer:=1; pass text; leg record; mate record; n integer; accts integer; days integer; best integer; back integer; back_accts integer; back_best integer; progressed boolean;
 links jsonb:='{"strict":0,"named":0,"twins":0,"fifo":0}'; report jsonb; det text;
BEGIN
 IF NOT apply THEN
  BEGIN
   report:=accounting.transfer_link_backfill(true);
   RAISE EXCEPTION 'preview' USING ERRCODE='AC001',DETAIL=report::text;
  EXCEPTION WHEN SQLSTATE 'AC001' THEN
   GET STACKED DIAGNOSTICS det=PG_EXCEPTION_DETAIL;
   RETURN det::jsonb||jsonb_build_object('applied',false);
  END;
 END IF;
 PERFORM accounting.write_lock();
 PERFORM set_config('accounting.operation_id',gen_random_uuid()::text,true);PERFORM set_config('accounting.actor_kind','worker',true);
 PERFORM set_config('accounting.action','transfer.link',true);PERFORM set_config('accounting.reason','Linked the two sides of an imported transfer',true);
 SELECT transfer_window_days INTO win FROM accounting.settings WHERE id=1;
 -- Four ways to be sure, surest first; any progress starts again from the top so a later pass only sees what the surer ones left.
 -- strict: exactly one candidate each way.
 -- named: the bank text names the other account's number ("Transfer to Checking *4273"), best match unique each way.
 -- twins: two or more candidates, all the same account on the same day, so they are interchangeable and any one is right.
 -- fifo: several candidates, all between the same two accounts: oldest out takes oldest in.
 WHILE i<=array_length(passes,1) LOOP
  pass:=passes[i]; progressed:=false;
  FOR leg IN SELECT * FROM accounting.transfer_link_legs() t WHERE pass='twins' OR t.amount_cents<0 ORDER BY t.entry_date,t.entry_id LOOP
   CONTINUE WHEN NOT EXISTS(SELECT 1 FROM accounting.transfer_link_legs() t WHERE t.entry_id=leg.entry_id);
   SELECT count(*),count(DISTINCT t.account_id),count(DISTINCT t.entry_date),
    max(accounting.transfer_link_names(leg.txt,t.mask)+accounting.transfer_link_names(t.txt,leg.mask))
    INTO n,accts,days,best FROM accounting.transfer_link_legs() t
    WHERE t.amount_cents=-leg.amount_cents AND t.account_id<>leg.account_id AND abs(t.entry_date-leg.entry_date)<=win;
   CONTINUE WHEN n=0;
   best:=coalesce(best,0);
   CONTINUE WHEN pass='named' AND (best=0 OR (SELECT count(*) FROM accounting.transfer_link_legs() t
    WHERE t.amount_cents=-leg.amount_cents AND t.account_id<>leg.account_id AND abs(t.entry_date-leg.entry_date)<=win
     AND (accounting.transfer_link_names(leg.txt,t.mask)+accounting.transfer_link_names(t.txt,leg.mask))=best)<>1);
   SELECT * INTO mate FROM accounting.transfer_link_legs() t
    WHERE t.amount_cents=-leg.amount_cents AND t.account_id<>leg.account_id AND abs(t.entry_date-leg.entry_date)<=win
    ORDER BY CASE WHEN pass='named' THEN -(accounting.transfer_link_names(leg.txt,t.mask)+accounting.transfer_link_names(t.txt,leg.mask)) ELSE 0 END,
     CASE WHEN pass='strict' THEN abs(t.entry_date-leg.entry_date) ELSE 0 END,t.entry_date,t.entry_id LIMIT 1;
   SELECT count(*),count(DISTINCT t.account_id),
    max(accounting.transfer_link_names(mate.txt,t.mask)+accounting.transfer_link_names(t.txt,mate.mask))
    INTO back,back_accts,back_best FROM accounting.transfer_link_legs() t
    WHERE t.amount_cents=-mate.amount_cents AND t.account_id<>mate.account_id AND abs(t.entry_date-mate.entry_date)<=win;
   IF (pass='strict' AND n=1 AND back=1)
    OR (pass='named' AND coalesce(back_best,0)=best AND (SELECT count(*) FROM accounting.transfer_link_legs() t
      WHERE t.amount_cents=-mate.amount_cents AND t.account_id<>mate.account_id AND abs(t.entry_date-mate.entry_date)<=win
       AND (accounting.transfer_link_names(mate.txt,t.mask)+accounting.transfer_link_names(t.txt,mate.mask))=best)=1)
    OR (pass='twins' AND n>1 AND accts=1 AND days=1)
    OR (pass='fifo' AND accts=1 AND back_accts=1) THEN
    UPDATE accounting.journal_entries SET transfer_group_id=gen_random_uuid() WHERE id=leg.entry_id;
    UPDATE accounting.journal_entries SET transfer_group_id=(SELECT transfer_group_id FROM accounting.journal_entries WHERE id=leg.entry_id) WHERE id=mate.entry_id;
    links:=jsonb_set(links,ARRAY[pass],to_jsonb((links->>pass)::integer+1));
    progressed:=true;
   END IF;
  END LOOP;
  IF progressed THEN i:=1; ELSE i:=i+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('applied',true,'linked_one_candidate',links->'strict','linked_named_account',links->'named','linked_same_day_twins',links->'twins','linked_same_accounts_in_date_order',links->'fifo',
  'left_unlinked',(SELECT count(*) FROM accounting.transfer_link_legs()),
  'left_sample',coalesce((SELECT jsonb_agg(jsonb_build_object('date',s.entry_date,'amount',(s.amount_cents/100.0)::text,'account',s.name,'memo',s.memo) ORDER BY s.entry_date DESC)
   FROM (SELECT t.entry_date,t.amount_cents,a.name,e.memo FROM accounting.transfer_link_legs() t JOIN accounting.accounts a ON a.id=t.account_id JOIN accounting.journal_entries e ON e.id=t.entry_id ORDER BY t.entry_date DESC LIMIT 25) s),'[]'));
END $function$
;
-- <<< transfer link backfill

SELECT accounting.transfer_link_backfill(true);

DROP FUNCTION accounting.transfer_link_backfill(boolean);

DROP FUNCTION accounting.transfer_link_legs();

DROP FUNCTION accounting.transfer_link_names(text,text);

COMMIT;
