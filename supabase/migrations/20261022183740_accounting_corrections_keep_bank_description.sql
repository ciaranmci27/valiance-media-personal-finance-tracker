-- Editing a posted bank transaction saves a corrected version that replaced it, and that
-- version dropped the bank's description and its descriptor key. The import learns from
-- earlier treatments by that key, so every correction was invisible to it: after the
-- Sep 30 Patriot tax debit was corrected to Taxes Payable, the import would still have
-- booked the next one as net pay. A correction now keeps its original's description; the
-- backfill gives the corrections made before this change theirs.

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
    -- The corrected version is the same bank movement: it keeps the bank's description, so the
    -- import still learns from it (an edit used to drop it, Oct 2026).
    replacement:=accounting.ledger_command(c||jsonb_build_object('type','draft.save','id',coalesce((c->>'replacement_id')::uuid,gen_random_uuid()),'expected_version',0,'origin','internal','kind','correction','payee_id',e.payee_id,'source_description',e.source_description));
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

CREATE OR REPLACE FUNCTION accounting.guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; a accounting.accounts; parent accounting.accounts; d date; inherits boolean:=false;
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
   -- Provenance never changes, except once by the backfill below: a correction made before
   -- corrections kept their bank description takes its original's.
   inherits:=current_setting('accounting.action',true)='entry.provenance.backfill' AND OLD.source_description IS NULL AND OLD.replaces_entry_id IS NOT NULL
    AND NEW.source_description IS NOT NULL AND NEW.source_description=(SELECT o.source_description FROM accounting.journal_entries o WHERE o.id=OLD.replaces_entry_id)
    AND NEW.descriptor_key IS NOT DISTINCT FROM accounting.descriptor_key(NEW.source_description);
   IF NEW.id IS DISTINCT FROM OLD.id OR (NOT inherits AND (NEW.source_description IS DISTINCT FROM OLD.source_description OR NEW.descriptor_key IS DISTINCT FROM OLD.descriptor_key)) OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_PROVENANCE'; END IF;
   IF OLD.transfer_group_id IS NOT NULL AND NEW.transfer_group_id IS DISTINCT FROM OLD.transfer_group_id THEN RAISE EXCEPTION 'ACCT_TRANSFER_GROUP_IMMUTABLE'; END IF;
   IF OLD.status='discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   -- A proposed transfer leg leaves draft only through transfer.confirm or after an unpair; how a draft was filled is a draft-only marker.
   IF NEW.status<>'draft' AND NEW.pair_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_PAIR_CONFIRM'; END IF;
   IF NEW.status<>'draft' THEN NEW.fill_source:=NULL; END IF;
   -- Who or what categorized a posted entry is fixed with it; only the one-time history backfill may fill a source the books never recorded.
   IF OLD.status='posted' AND (to_jsonb(NEW)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']-CASE WHEN OLD.category_source IS NULL AND current_setting('accounting.action',true)='entry.source.backfill' THEN ARRAY['category_source','category_actor'] ELSE ARRAY[]::text[] END-CASE WHEN inherits THEN ARRAY['source_description','descriptor_key'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']-CASE WHEN OLD.category_source IS NULL AND current_setting('accounting.action',true)='entry.source.backfill' THEN ARRAY['category_source','category_actor'] ELSE ARRAY[]::text[] END-CASE WHEN inherits THEN ARRAY['source_description','descriptor_key'] ELSE ARRAY[]::text[] END) THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
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
   -- The accrual view's receivable, unbilled and billed-in-advance lines are computed, never posted.
   IF a.system_purpose IN ('accounts_receivable','unbilled_revenue','deferred_revenue') THEN RAISE EXCEPTION 'ACCT_ACCRUAL_ACCOUNT'; END IF;
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

-- >>> correction description backfill
-- Corrections made before this change dropped the bank's description. Give each the
-- description of the entry it corrected, under the guard's one-time action, then drop
-- the function.
CREATE OR REPLACE FUNCTION accounting.correction_description_backfill()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE n integer;
BEGIN
 PERFORM set_config('accounting.operation_id',gen_random_uuid()::text,true);
 PERFORM set_config('accounting.actor_kind','system',true);
 PERFORM set_config('accounting.action','entry.provenance.backfill',true);
 PERFORM set_config('accounting.reason','A correction keeps the bank description of the entry it corrected',true);
 UPDATE accounting.journal_entries r SET source_description=o.source_description,descriptor_key=accounting.descriptor_key(o.source_description)
 FROM accounting.journal_entries o
 WHERE r.replaces_entry_id=o.id AND r.source_description IS NULL AND o.source_description IS NOT NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM set_config('accounting.action','',true);
 RETURN n;
END $function$
;
-- <<< correction description backfill

SELECT accounting.correction_description_backfill();

DROP FUNCTION accounting.correction_description_backfill();
