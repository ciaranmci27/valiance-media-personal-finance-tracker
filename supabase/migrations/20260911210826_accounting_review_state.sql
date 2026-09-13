-- Keep the review queue independent of posted ledger status.
BEGIN;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS review_pending boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS accounting.entries_review;
CREATE INDEX entries_review ON accounting.journal_entries USING btree (entry_date DESC, id) WHERE (status = 'draft'::text OR (status = 'posted'::text AND review_pending));

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

CREATE OR REPLACE FUNCTION accounting.ledger_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type'; k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid()); actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 e accounting.journal_entries; account_row accounting.accounts; v integer; x jsonb; line jsonb; idx integer; r jsonb; replacement jsonb; reversal jsonb;
 preserved uuid[]:='{}'; seen uuid[]:='{}'; existing_line uuid; original_date date; category uuid; bank_line accounting.journal_lines; total numeric; allocated bigint; remain bigint; share_sum bigint;
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
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(l.id),ARRAY[]::uuid[]) FROM accounting.journal_lines l WHERE l.entry_id=$1 AND EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id)' INTO preserved USING k;
   END IF;
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND NOT (id=ANY(preserved));
   UPDATE accounting.journal_entries SET entry_date=(c->>'entry_date')::date,memo=c->>'memo',kind=coalesce(c->'context'->>'kind',c->>'kind',kind),
    payee_id=CASE WHEN c?'payee_id' OR c->'context'?'payee_id' THEN coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
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
  IF t='entry.review' THEN
   IF jsonb_typeof(c->'reviewed') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
   IF e.status='discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
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
   INSERT INTO accounting.journal_entries(entry_date,memo,origin,kind,reverses_entry_id,reason,created_by,payee_id)
    VALUES(original_date,'Reversal: '||left(e.memo,990),'internal','correction',e.id,c->>'reason',actor,e.payee_id) RETURNING id,version INTO k,v;
   INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
    SELECT k,account_id,-amount_cents,memo,sort_order,cash_class FROM accounting.journal_lines WHERE entry_id=e.id;
   reversal:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    -- A reversal removes the financial treatment, so its bank evidence returns to review.
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING e.id;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING e.id;
   END IF;
   IF t='entry.correct' THEN
    IF (c->>'entry_date')::date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
    replacement:=accounting.ledger_command(c||jsonb_build_object('type','draft.save','id',coalesce((c->>'replacement_id')::uuid,gen_random_uuid()),'expected_version',0,'origin','internal','kind','correction','payee_id',e.payee_id));
    k:=(replacement->>'id')::uuid;
    UPDATE accounting.journal_entries SET replaces_entry_id=e.id WHERE id=k RETURNING version INTO v;
    replacement:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
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
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),kind=coalesce(c->>'kind',kind),payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
   IF coalesce((c->>'remember')::boolean,false) AND e.descriptor_key IS NOT NULL THEN
    PERFORM accounting.banking_command(jsonb_build_object('type','alias.save','id',gen_random_uuid(),'party_id',c->'payee_id','match_kind','key','pattern',e.descriptor_key,'enabled',true,'expected_version',0));
   END IF;
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
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
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE entry_id=NEW.reverses_entry_id AND status='posted') AND current_setting('accounting.action',true)<>'payroll.void' THEN RAISE EXCEPTION 'ACCT_PAYROLL_VOID_REQUIRED';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='payroll_runs' THEN
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

CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc');
BEGIN
 PERFORM accounting.require_owner();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded') OR (f->>'review' IS NOT NULL AND f->>'review' NOT IN ('needs_review','reviewed')) OR (f->>'from')::date>(f->>'to')::date THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) ELSE e.status=f->>'status' END)
 AND (f->>'review' IS NULL OR CASE WHEN f->>'review'='reviewed' THEN e.status='posted' AND NOT e.review_pending ELSE e.status='draft' OR (e.status='posted' AND e.review_pending) END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR e.payee_id=(f->>'payee')::uuid)
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (f->>'query' IS NULL OR e.memo ILIKE '%'||(f->>'query')||'%' OR e.source_description ILIKE '%'||(f->>'query')||'%')
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' OR (status='posted' AND review_pending))) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.workspace(from_date date, to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r jsonb;tx jsonb;
BEGIN
 PERFORM accounting.require_owner();r:=accounting.report('summary',jsonb_build_object('from',from_date,'to',to_date));tx:=accounting.transactions(jsonb_build_object('from',from_date,'to',to_date));
 RETURN jsonb_build_object('legal_name',r->'legal_name','revision',r->'revision','from',from_date,'to',to_date,'accounts',r->'accounts','balances',r->'accounts','entries',tx->'entries','entry_count',tx->'total','draft_count',r->'quality'->'draft_count',
 'needs_review_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' OR (status='posted' AND review_pending)),'sync_due',EXISTS(SELECT 1 FROM accounting.bank_connections WHERE status='active' AND scheduled AND (last_success_at IS NULL OR last_success_at<now()-interval '6 hours')),
 'reports',r-ARRAY['legal_name','revision','definition_version','currency','basis','generated_at','filter','accounts','rows','totals','comparison','monthly','dimensions','cash','quality']);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.patriot_import(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
<<patriot_import>>
DECLARE actor uuid:=accounting.require_owner(); committing boolean:=request->>'mode'='commit';
 item jsonb; body jsonb; part jsonb; lines jsonb; signature jsonb; candidates jsonb; result jsonb:='[]';
 prior accounting.payroll_runs; saved jsonb; posted jsonb; defaults jsonb; state text; message text;
 run_id uuid; entry_id uuid; pay_date date; employer bigint; identity text; choice text;
BEGIN
 IF committing THEN PERFORM accounting.write_lock(); END IF;
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
  ELSIF EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.period_start=(body->>'period_from')::date AND p.period_end=(body->>'period_to')::date) THEN
   state:='conflict';message:='A payroll already covers this period. Check its pay date and employee scope before importing.';
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo) ORDER BY e.id),'[]') INTO candidates
   FROM accounting.journal_entries e WHERE e.entry_date=pay_date AND e.status='posted'
   AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
   AND NOT EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE accounting.payroll_runs.entry_id=e.id)
   AND signature=(SELECT jsonb_agg(jsonb_build_array(account_id,amount::text) ORDER BY account_id)
    FROM (SELECT account_id,sum(amount_cents)::bigint amount FROM accounting.journal_lines WHERE accounting.journal_lines.entry_id=e.id GROUP BY account_id HAVING sum(amount_cents)<>0) g);
   IF jsonb_array_length(candidates)>0 THEN state:='match';message:='Matching journal found. Link it to avoid recording payroll twice.';
   ELSIF EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE abs(e.entry_date-pay_date)<=7 AND e.status<>'discarded'
    AND (e.kind='payroll' OR e.memo ILIKE '%payroll%') AND e.reverses_entry_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id)
    AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.amount_cents=(body->>'declared_gross_cents')::bigint))
   THEN state:='conflict';message:='A nearby payroll journal may already record this payment. Review it before importing.'; END IF;
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
   IF NOT ((state='new' AND choice='new') OR (state='match' AND EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) c WHERE c->>'id'=choice)))
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
   ELSE entry_id:=choice::uuid; END IF;
   PERFORM set_config('accounting.action','payroll.import',true);
   PERFORM set_config('accounting.reason','Imported Patriot Payroll Details',true);
   UPDATE accounting.payroll_runs SET status='posted',entry_id=patriot_import.entry_id,
    ytd=ytd||jsonb_build_object('patriot_import',jsonb_build_object('company_id',request->'company_id',
     'company_name',request->'company_name','mapping',request->'mapping','fingerprint',item->'fingerprint'))
   WHERE id=run_id;
   INSERT INTO accounting.document_links(document_id,payroll_run_id,created_by) VALUES((request->>'document_id')::uuid,run_id,actor) ON CONFLICT DO NOTHING;
  END IF;
  result:=result||jsonb_build_array(jsonb_build_object('key',identity,'pay_date',pay_date,'period_from',body->'period_from',
   'period_to',body->'period_to','gross',body->'declared_gross_cents','net',body->'declared_net_cents','employer_tax',employer::text,
   'employee_count',jsonb_array_length(body->'employees'),'state',state,'message',message,'candidates',candidates,'run_id',run_id,'entry_id',entry_id));
 END LOOP;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.patriot_import(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.patriot_import(jsonb) TO authenticated;

COMMIT;

-- TRANSACTION LIFECYCLE BEGIN
-- Transaction lifecycle delta. Run only after the earlier accounting review migration.
BEGIN;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS restores_entry_id uuid REFERENCES accounting.journal_entries(id) UNIQUE;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS bank_restore_matches jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE OR REPLACE FUNCTION accounting.payroll_import_mode(run accounting.payroll_runs)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT CASE WHEN NOT (run.ytd?'patriot_import') THEN NULL
 WHEN run.ytd->'patriot_import'->>'journal_mode' IN ('created','linked') THEN run.ytd->'patriot_import'->>'journal_mode'
 WHEN EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.id=run.entry_id AND e.created_at=run.created_at AND e.memo='Payroll for '||run.pay_date::text AND e.kind='payroll') THEN 'created' ELSE 'linked' END
$fn$;

CREATE OR REPLACE FUNCTION accounting.lifecycle_command(c jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE e accounting.journal_entries; re accounting.journal_entries; run accounting.payroll_runs;
 result jsonb; item jsonb; new_id uuid; v integer; restore_date date:=(coalesce(c->>'entry_date',c->>'effective_date'))::date; mode text;
BEGIN
 PERFORM accounting.require_owner();PERFORM accounting.write_lock();
 IF btrim(coalesce(c->>'reason',''))='' OR restore_date IS NULL THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND';END IF;
 PERFORM accounting.require_open(restore_date);
 IF c->>'type'='payroll.import.undo' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=(c->>'id')::uuid;
  IF run.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF run.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF run.status<>'posted' OR NOT (run.ytd?'patriot_import') THEN RAISE EXCEPTION 'ACCT_IMPORT_UNDO_UNAVAILABLE';END IF;
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
  UPDATE accounting.payroll_runs SET status='void',entry_id=CASE WHEN mode='created' THEN run.entry_id ELSE NULL END,provider_run_id='Undone Patriot '||id::text,
   ytd=jsonb_set(ytd,'{patriot_import}',(ytd->'patriot_import')||jsonb_build_object('undone',true,'journal_mode',mode,'original_entry_id',run.entry_id,'original_provider_run_id',run.provider_run_id,'undone_on',restore_date,'reversal_entry_id',result->'id'))
   WHERE id=run.id RETURNING version INTO v;
  RETURN jsonb_build_object('id',run.id,'version',v,'journal_mode',mode);
 ELSIF c->>'type'='entry.restore' THEN
  SELECT * INTO e FROM accounting.journal_entries WHERE id=(c->>'id')::uuid;
  IF e.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF e.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  SELECT * INTO re FROM accounting.journal_entries WHERE reverses_entry_id=e.id;
  IF re.id IS NULL OR e.reverses_entry_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.journal_entries WHERE restores_entry_id=e.id OR replaces_entry_id=e.id) THEN RAISE EXCEPTION 'ACCT_RESTORE_UNAVAILABLE';END IF;
  IF restore_date<re.entry_date THEN RAISE EXCEPTION 'ACCT_RESTORE_DATE';END IF;
  IF e.register_id IS NOT NULL OR e.transfer_group_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE entry_id=e.id OR (ytd->'patriot_import'->>'original_entry_id'=e.id::text AND ytd->'patriot_import'->>'journal_mode'='created')) THEN RAISE EXCEPTION 'ACCT_RESTORE_WORKFLOW';END IF;
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
 PERFORM accounting.require_owner();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'restored_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE restores_entry_id=e.id),
  'replacement_entry_id',(SELECT id FROM accounting.journal_entries WHERE replaces_entry_id=e.id LIMIT 1),
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (p.ytd->'patriot_import'->>'original_entry_id'=e.id::text AND p.ytd->'patriot_import'->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
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
 END IF;
 IF to_regclass('accounting.document_links') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(d)),''[]''::jsonb) FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('documents',extra);
 END IF;
 RETURN result;
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
 preserved uuid[]:='{}'; seen uuid[]:='{}'; existing_line uuid; original_date date; category uuid; bank_line accounting.journal_lines; total numeric; allocated bigint; remain bigint; share_sum bigint;
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
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(l.id),ARRAY[]::uuid[]) FROM accounting.journal_lines l WHERE l.entry_id=$1 AND EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id)' INTO preserved USING k;
   END IF;
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND NOT (id=ANY(preserved));
   UPDATE accounting.journal_entries SET entry_date=(c->>'entry_date')::date,memo=c->>'memo',kind=coalesce(c->'context'->>'kind',c->>'kind',kind),
    payee_id=CASE WHEN c?'payee_id' OR c->'context'?'payee_id' THEN coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
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
    OR EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND (EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id) OR EXISTS(SELECT 1 FROM accounting.reconciliation_items ri WHERE ri.journal_line_id=l.id))))
   THEN RAISE EXCEPTION 'ACCT_CORRECTION_LINKED'; END IF;
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
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),kind=coalesce(c->>'kind',kind),payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
   IF coalesce((c->>'remember')::boolean,false) AND e.descriptor_key IS NOT NULL THEN
    PERFORM accounting.banking_command(jsonb_build_object('type','alias.save','id',gen_random_uuid(),'party_id',c->'payee_id','match_kind','key','pattern',e.descriptor_key,'enabled',true,'expected_version',0));
   END IF;
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.patriot_import(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
<<patriot_import>>
DECLARE actor uuid:=accounting.require_owner(); committing boolean:=request->>'mode'='commit';
 item jsonb; body jsonb; part jsonb; lines jsonb; signature jsonb; candidates jsonb; result jsonb:='[]';
 prior accounting.payroll_runs; saved jsonb; posted jsonb; defaults jsonb; state text; message text;
 run_id uuid; entry_id uuid; pay_date date; employer bigint; identity text; choice text; candidate jsonb; existing accounting.journal_entries; correction boolean;
BEGIN
 IF committing THEN PERFORM accounting.write_lock(); END IF;
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
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.patriot_import(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.patriot_import(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION accounting.operate(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c jsonb:=command->'command'; key uuid:=(command->>'key')::uuid; actor uuid; receipt accounting.command_receipts; hash text; result jsonb; t text; current_version integer; initialized boolean:=false;
BEGIN
 IF key IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM accounting.write_lock();
 t:=c->>'type'; actor:=auth.uid();
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t='settings.save' AND NOT EXISTS(SELECT 1 FROM accounting.settings) THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO accounting.settings(owner_user_id) VALUES(actor); initialized:=true;
 END IF;
 actor:=accounting.require_owner(); hash:=encode(sha256(convert_to(c::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM accounting.command_receipts WHERE idempotency_key=key;
 IF FOUND THEN
  IF receipt.actor_user_id<>actor OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 IF c?'expected_revision' AND (c->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM accounting.settings WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_REVISION'; END IF;
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t IN ('settings.save','preferences.save') THEN
  SELECT version INTO current_version FROM accounting.settings WHERE id=1;
  IF (c->>'expected_version')::integer IS DISTINCT FROM current_version AND NOT (initialized AND coalesce((c->>'expected_version')::integer,0)=0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.settings SET primary_system=coalesce(c->>'primary_system',CASE c->>'authority_mode' WHEN 'admin_primary' THEN 'admin' WHEN 'wave_primary' THEN 'wave' WHEN 'parallel_pilot' THEN 'wave' END,primary_system),
   primary_system_since=CASE WHEN c?'primary_system_since' THEN (c->>'primary_system_since')::date ELSE primary_system_since END,
   transfer_window_days=coalesce((c->>'transfer_window_days')::smallint,transfer_window_days),version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  IF c?'business_profile' THEN
   IF (c->>'profile_version')::integer IS DISTINCT FROM (SELECT version FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(c->'business_profile') k WHERE k NOT IN ('legal_name','dba','entity_type','ein','formation_date','state_of_formation','address','phone','email','tax_classification','tax_classification_since','home_state','is_sstb','fiscal_year_start_month','books_timezone','earliest_history_date','owner_name','owner_title','accountant_name','accountant_email','default_email_account_id')) THEN RAISE EXCEPTION 'ACCT_INVALID_PROFILE'; END IF;
   UPDATE public.business_profile p SET (legal_name,dba,entity_type,ein,formation_date,state_of_formation,address,phone,email,tax_classification,tax_classification_since,home_state,is_sstb,fiscal_year_start_month,books_timezone,earliest_history_date,owner_name,owner_title,accountant_name,accountant_email,default_email_account_id)=
    (SELECT v.legal_name,v.dba,v.entity_type,v.ein,v.formation_date,v.state_of_formation,v.address,v.phone,v.email,v.tax_classification,v.tax_classification_since,v.home_state,v.is_sstb,v.fiscal_year_start_month,v.books_timezone,v.earliest_history_date,v.owner_name,v.owner_title,v.accountant_name,v.accountant_email,v.default_email_account_id FROM jsonb_populate_record(p,c->'business_profile') v) WHERE p.id=1;
  ELSIF c?'legal_name' OR c->>'history_start' IS NOT NULL THEN
   UPDATE public.business_profile SET legal_name=coalesce(c->>'legal_name',legal_name),earliest_history_date=coalesce((c->>'history_start')::date,earliest_history_date) WHERE id=1;
  END IF;
  result:=jsonb_build_object('id',coalesce(c->>'id','1'),'version',current_version);
 ELSIF t='setup.acknowledge' THEN
  IF coalesce(c->>'key','') !~ '^[a-z][a-z0-9-]*(:[a-z0-9]{1,16})?$' OR jsonb_typeof(c->'acknowledged') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  UPDATE accounting.settings SET setup=CASE WHEN (c->>'acknowledged')::boolean THEN setup||jsonb_build_object(c->>'key',jsonb_build_object('at',now(),'by',actor)) ELSE setup-(c->>'key') END,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  result:=jsonb_build_object('id',coalesce(c->>'id',c->>'key'),'version',current_version);
 ELSIF t IN ('entry.restore','payroll.import.undo') THEN result:=accounting.lifecycle_command(c);
 ELSIF t LIKE 'account.%' OR t='chart.seed' OR t LIKE 'entry.%' OR t LIKE 'draft.%' OR t LIKE 'transaction.%' OR t='cash.allocate' THEN result:=accounting.ledger_command(c);
 ELSIF t LIKE 'bank.%' OR t LIKE 'feed.%' OR t LIKE 'transfer.%' OR t LIKE 'party.%' OR t LIKE 'alias.%' OR t LIKE 'rule.%' OR t LIKE 'document.%' THEN result:=accounting.banking_command(c);
 ELSIF t LIKE 'import.%' OR t LIKE 'history.%' THEN result:=accounting.history_command(c);
 ELSIF t LIKE 'period.%' OR t LIKE 'reconciliation.%' THEN result:=accounting.close_command(c);
 ELSIF t LIKE 'payroll.%' OR t LIKE 'register.%' THEN result:=accounting.register_command(c);
 ELSIF t LIKE 'tax.%' THEN result:=accounting.tax_command(c);
 ELSIF t LIKE 'report.%' OR t LIKE 'package.%' THEN result:=accounting.report_command(c);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 INSERT INTO accounting.command_receipts(idempotency_key,payload_hash,actor_user_id,result) VALUES(key,hash,actor,result);
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
  RETURN jsonb_build_object('id',run.id,'version',run.version,'provider_run_id',run.provider_run_id,'head_revision',run.version,'status',CASE run.status WHEN 'void' THEN 'voided' ELSE run.status END,'import_mode',accounting.payroll_import_mode(run),'import_undone',coalesce((run.ytd->'patriot_import'->>'undone')::boolean,false),'register',record,'preview',preview,'posting',posting,
   'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('run_id',run.id,'revision',a.after->'version','body',a.after,'document_id',a.after->'document_id','reason',a.reason,'created_at',a.at) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.table_name='payroll_runs' AND a.row_id=run.id),'history_count',(SELECT count(*) FROM accounting.audit_log WHERE table_name='payroll_runs' AND row_id=run.id),'history_offset',0);
 END IF;

 IF view?'year' AND NOT (view?'through' OR view?'to' OR view?'as_of') THEN cutoff:=make_date(y,12,31);END IF;
 WITH filtered AS (
  SELECT * FROM accounting.payroll_runs r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'year' IS NULL OR extract(year FROM pay_date)=y) AND pay_date<=cutoff
   AND (view->>'from' IS NULL OR pay_date>=(view->>'from')::date) AND (view->>'status' IS NULL OR r.status=CASE view->>'status' WHEN 'voided' THEN 'void' ELSE view->>'status' END)
   AND (coalesce(view->>'query','')='' OR r.provider_run_id ILIKE '%'||(view->>'query')||'%')
 ), paged AS (SELECT * FROM filtered ORDER BY pay_date DESC,id LIMIT 100 OFFSET greatest(coalesce((view->>'offset')::integer,0),0))
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rows',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('import_mode',accounting.payroll_import_mode(r),'import_undone',coalesce((r.ytd->'patriot_import'->>'undone')::boolean,false),'gross_cents',gross_cents::text,'net_cents',net_cents::text,'employee_withholding_cents',employee_withholding_cents::text,'employer_tax_cents',employer_tax_cents::text) ORDER BY pay_date DESC,id),'[]') FROM paged r),
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

CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc');
BEGIN
 PERFORM accounting.require_owner();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded','reversed') OR (f->>'review' IS NOT NULL AND f->>'review' NOT IN ('needs_review','reviewed')) OR (f->>'from')::date>(f->>'to')::date THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (f->>'entry_id' IS NOT NULL OR CASE WHEN f->>'status'='reversed' THEN e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) ELSE e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) END)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) WHEN f->>'status'='reversed' THEN e.status='posted' ELSE e.status=f->>'status' END)
 AND (f->>'review' IS NULL OR CASE WHEN f->>'review'='reviewed' THEN e.status='posted' AND NOT e.review_pending ELSE e.status='draft' OR (e.status='posted' AND e.review_pending) END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR e.payee_id=(f->>'payee')::uuid)
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (f->>'query' IS NULL OR e.memo ILIKE '%'||(f->>'query')||'%' OR e.source_description ILIKE '%'||(f->>'query')||'%')
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id))) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.workspace(from_date date, to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r jsonb;tx jsonb;
BEGIN
 PERFORM accounting.require_owner();r:=accounting.report('summary',jsonb_build_object('from',from_date,'to',to_date));tx:=accounting.transactions(jsonb_build_object('from',from_date,'to',to_date));
 RETURN jsonb_build_object('legal_name',r->'legal_name','revision',r->'revision','from',from_date,'to',to_date,'accounts',r->'accounts','balances',r->'accounts','entries',tx->'entries','entry_count',tx->'total','draft_count',r->'quality'->'draft_count',
 'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)),'sync_due',EXISTS(SELECT 1 FROM accounting.bank_connections WHERE status='active' AND scheduled AND (last_success_at IS NULL OR last_success_at<now()-interval '6 hours')),
 'reports',r-ARRAY['legal_name','revision','definition_version','currency','basis','generated_at','filter','accounts','rows','totals','comparison','monthly','dimensions','cash','quality']);
END $function$
;
REVOKE ALL ON FUNCTION accounting.lifecycle_command(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION accounting.payroll_import_mode(accounting.payroll_runs) FROM PUBLIC,anon,authenticated;
COMMIT;
-- TRANSACTION LIFECYCLE END

-- Related transaction history is loaded only when requested.
CREATE OR REPLACE FUNCTION accounting.entry_history(entry uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE root_id uuid; ids uuid[]; result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 WITH RECURSIVE ancestors AS (
  SELECT id,coalesce(reverses_entry_id,replaces_entry_id,restores_entry_id) parent FROM accounting.journal_entries WHERE id=entry
  UNION
  SELECT e.id,coalesce(e.reverses_entry_id,e.replaces_entry_id,e.restores_entry_id) FROM accounting.journal_entries e JOIN ancestors a ON a.parent=e.id
 ) SELECT id INTO root_id FROM ancestors WHERE parent IS NULL;
 IF root_id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 WITH RECURSIVE family AS (
  SELECT id FROM accounting.journal_entries WHERE id=root_id
  UNION
  SELECT e.id FROM accounting.journal_entries e JOIN family f ON coalesce(e.reverses_entry_id,e.replaces_entry_id,e.restores_entry_id)=f.id
 ) SELECT array_agg(id) INTO ids FROM family;
 SELECT jsonb_build_object('reference',root_id,'entries',coalesce(jsonb_agg(jsonb_build_object(
  'id',e.id,'entry_date',e.entry_date,'created_at',e.created_at,'memo',e.memo,'reason',e.reason,'status',e.status,
  'action',CASE WHEN e.id=root_id THEN 'Original' WHEN e.reverses_entry_id IS NOT NULL THEN 'Reversal' WHEN e.restores_entry_id IS NOT NULL THEN 'Restoration' ELSE 'Replacement' END,
  'actor',CASE WHEN e.created_by=auth.uid() THEN 'You' WHEN e.created_by IS NULL THEN 'System' ELSE 'Another user' END,
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs p WHERE p.entry_id=e.id ORDER BY p.created_at DESC LIMIT 1)
 ) ORDER BY e.created_at,CASE WHEN e.id=root_id THEN 0 WHEN e.reverses_entry_id IS NOT NULL THEN 1 ELSE 2 END,e.id),'[]')) INTO result
 FROM accounting.journal_entries e WHERE e.id=ANY(ids);
 RETURN result||jsonb_build_object('documents',(SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('original_name',d.name,'size_bytes',d.size_bytes::text)),'[]') FROM accounting.documents d WHERE d.status<>'archived' AND EXISTS(SELECT 1 FROM accounting.document_links dl WHERE dl.document_id=d.id AND (dl.entry_id=ANY(ids) OR dl.payroll_run_id IN (SELECT p.id FROM accounting.payroll_runs p WHERE p.entry_id=ANY(ids))))));
END $fn$;
REVOKE ALL ON FUNCTION accounting.entry_history(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.entry_history(uuid) TO authenticated;


-- Setup guide: what is left to set up for a year, in one cheap read, and the owner's acknowledgements.
BEGIN;
ALTER TABLE accounting.settings ADD COLUMN IF NOT EXISTS setup jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION accounting.setup_status(year integer, cutoff date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE through_date date;
BEGIN
 PERFORM accounting.require_owner();
 IF year IS NULL OR year NOT BETWEEN 1900 AND 2100 THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 through_date:=least(coalesce(cutoff,make_date(year,12,31)),(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date);
 IF extract(year FROM through_date)<>year THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 RETURN jsonb_build_object('year',year,'through',through_date,'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1),
  'primary_system',(SELECT primary_system FROM accounting.settings WHERE id=1),
  'acknowledged',(SELECT setup FROM accounting.settings WHERE id=1),
  'accounts_total',(SELECT count(*) FROM accounting.accounts),
  'missing_purposes',(SELECT coalesce(jsonb_agg(p ORDER BY p),'[]') FROM unnest(ARRAY['uncategorized_income','uncategorized_expense','transfers_in_transit']) p WHERE NOT EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.system_purpose=p AND NOT a.is_archived)),
  'profile',(SELECT jsonb_build_object('legal_name',legal_name,'entity_type',entity_type,'classification',tax_classification,'since',tax_classification_since,'timezone',books_timezone,'history_start',earliest_history_date) FROM public.business_profile WHERE id=1),
  'unmapped_accounts',(SELECT count(DISTINCT account_id) FILTER(WHERE NOT mapping_current) FROM accounting.tax_lines(year,through_date)),
  'runs_without_register',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(year,1,1) AND through_date AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=through_date) AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=p.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
END $function$;
REVOKE ALL ON FUNCTION accounting.setup_status(integer,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.setup_status(integer,date) TO authenticated;
-- The books take the same per-year classification rule as the estimator.
CREATE OR REPLACE FUNCTION accounting.tax_source(year integer, cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE accounts jsonb;adjustments jsonb;monthly jsonb;separate jsonb;result jsonb;ordinary numeric;adjusted numeric;book numeric;missing integer;report_data jsonb;
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_owner();END IF;
 IF year IS NULL OR cutoff IS NULL OR year NOT BETWEEN 1900 AND 2100 OR extract(year FROM cutoff)<>year OR cutoff>(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 report_data:=accounting.report('profit_loss',jsonb_build_object('from',make_date(year,1,1),'to',cutoff));book:=(report_data->>'net_income_cents')::numeric;
 WITH grouped AS(SELECT account_id,sum(book_cents) book,sum(ordinary_cents) ordinary,count(*) n FROM accounting.tax_lines(year,cutoff) GROUP BY account_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',a.id,'name',a.name,'code',a.code,'account_type',a.type,'mapping',CASE WHEN m.id IS NULL THEN NULL ELSE to_jsonb(m) END,
 'book_cents',coalesce(g.book,0)::text,'ordinary_cents',coalesce(g.ordinary,0)::text,'line_count',coalesce(g.n,0),'current',m.id IS NOT NULL) ORDER BY a.code,a.name,a.id),'[]') INTO accounts
 FROM accounting.accounts a LEFT JOIN grouped g ON g.account_id=a.id LEFT JOIN accounting.tax_mappings m ON m.account_id=a.id AND m.tax_year=year WHERE a.type IN ('income','expense') AND (g.n>0 OR NOT a.is_archived);
 SELECT coalesce(sum(ordinary_cents),0),count(DISTINCT account_id) FILTER(WHERE NOT mapping_current) INTO ordinary,missing FROM accounting.tax_lines(year,cutoff);
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text,'current',true,'active',true,'version',1) ORDER BY effective_date,id),'[]'),
 ordinary+coalesce(sum(a.amount_cents) FILTER(WHERE a.concept NOT IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt')),0)
 INTO adjustments,adjusted FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff;
 WITH months AS(SELECT d::date AS month FROM generate_series(make_date(year,1,1),date_trunc('month',cutoff),interval '1 month') d),
 lines AS(SELECT date_trunc('month',entry_date)::date AS month,sum(book_cents) book,sum(ordinary_cents) ordinary FROM accounting.tax_lines(year,cutoff) GROUP BY 1),
 adj AS(SELECT date_trunc('month',effective_date)::date AS month,sum(amount_cents) amount FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.concept NOT IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') GROUP BY 1)
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',m.month,'book_cents',coalesce(l.book,0)::text,'ordinary_cents',(coalesce(l.ordinary,0)+coalesce(a.amount,0))::text,
 'complete',(m.month+interval '1 month -1 day')::date<=cutoff AND EXISTS(SELECT 1 FROM accounting.periods p WHERE p.month=m.month AND p.status='locked')) ORDER BY m.month),'[]') INTO monthly FROM months m LEFT JOIN lines l USING(month) LEFT JOIN adj a USING(month);
 SELECT coalesce(jsonb_object_agg(concept,amount::text),'{}') INTO separate FROM (
 SELECT concept,sum(amount) amount FROM (
 SELECT m.concept,-sum(l.amount_cents)::numeric amount FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.tax_mappings m ON m.account_id=l.account_id AND m.tax_year=year WHERE e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND cutoff AND m.separately_stated GROUP BY m.concept
 UNION ALL SELECT a.concept,sum(a.amount_cents)::numeric FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.concept IN ('interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') GROUP BY a.concept) s GROUP BY concept) q;
 result:=jsonb_build_object('year',year,'through',cutoff,'revision',report_data->'revision','year_settings',(SELECT jsonb_build_object('classification',CASE WHEN tax_classification_since IS NOT NULL AND tax_classification_since>year THEN CASE entity_type WHEN 'llc' THEN 'disregarded' WHEN 'corporation' THEN 'c_corp' WHEN 'sole_proprietorship' THEN 'sole_prop' ELSE 'partnership' END ELSE tax_classification END) FROM public.business_profile WHERE id=1),
 'accounts',accounts,'adjustments',adjustments,'basis',NULL,'monthly',monthly,'separately_stated',separate,'book_profit_cents',book::text,'mapped_ordinary_cents',ordinary::text,'adjusted_ordinary_cents',adjusted::text,'book_to_tax_cents',(adjusted-book)::text,'unmapped_accounts',missing,
 'drafts',report_data->'quality'->'draft_count','incomplete_imports',report_data->'quality'->'incomplete_imports',
 'unavailable_adjustments',(SELECT count(*) FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=a.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $function$;
COMMIT;
