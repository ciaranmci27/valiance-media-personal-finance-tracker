-- Money fixes from the accounting review (Nov 2026). None had hit the live books yet.
--  * A deleted bank draft came back on the next sync: a person deleting one now sets its bank line
--    aside, as deleting a reviewed transaction already did; other discards still return the line to
--    review (ledger_command, draft.discard with exclude_bank).
--  * A rule could stall a bank connection for good: a rule whose category was archived is no
--    longer applied (rule_candidate), and a split that rounds a cents-sized charge to nothing
--    leaves that charge for a person instead of failing the whole sync (apply_treatment).
--  * An edit to a reviewed transaction that changed the amount, date or category dropped a
--    contact change in the same edit (ledger_command, entry.correct).
--  * Put in / taken out counted a deleted or edited entry both ways: the report adds activity
--    debits and credits that leave out an entry and its reversal inside the same period (report).
--  * Total cost of sales counted only the cost_of_goods_sold subtype, not cogs or direct_costs,
--    which the account form saves and the screens count (report).
--  * The accrual charts mixed bases: the monthly series now read the reports' accrual lines on
--    the accrual basis (breakdown).
--  * Two same-amount bank charges next to two same-amount entries matched neither and added
--    two drafts: the nearest entry now takes each charge (sync_server).

CREATE OR REPLACE FUNCTION accounting.rule_candidate(entry uuid, rule_filter uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; bank accounting.journal_lines; r accounting.rules; descriptor text; mode text; pattern text;
 matches jsonb:='[]';winner jsonb;why text:='';alias_count integer;
BEGIN
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF NOT FOUND OR e.status='discarded' THEN RETURN NULL; END IF;
 SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card');
 IF NOT FOUND OR (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card'))<>1 THEN RETURN NULL; END IF;
 FOR r IN SELECT * FROM accounting.rules WHERE (rule_filter IS NULL AND enabled) OR id=rule_filter ORDER BY priority,id LOOP
  descriptor:=upper(regexp_replace(btrim(CASE WHEN r.conditions?'description' THEN coalesce(e.source_description,e.memo) ELSE coalesce(e.descriptor_key,accounting.descriptor_key(e.memo)) END),'\s+',' ','g'));
  mode:=coalesce(r.conditions->>'description_mode',(SELECT key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1));
  pattern:=upper(regexp_replace(btrim(coalesce(r.conditions->>'description',r.conditions->'descriptor_key'->>mode)),'\s+',' ','g'));
  IF mode NOT IN ('exact','equals','prefix','contains') OR pattern IS NULL THEN CONTINUE; END IF;
  IF (mode IN ('exact','equals') AND descriptor<>pattern) OR (mode='prefix' AND left(descriptor,length(pattern))<>pattern) OR (mode='contains' AND position(pattern IN descriptor)=0) THEN CONTINUE; END IF;
  IF r.conditions->>'bank_account_id' IS NOT NULL AND (r.conditions->>'bank_account_id')::uuid<>bank.account_id THEN CONTINUE; END IF;
  IF r.conditions->>'direction' IN ('increase','in') AND bank.amount_cents<0 OR r.conditions->>'direction' IN ('decrease','out') AND bank.amount_cents>0 THEN CONTINUE; END IF;
  IF r.conditions->>'amount_min' IS NOT NULL AND abs(bank.amount_cents::numeric)<(r.conditions->>'amount_min')::numeric THEN CONTINUE; END IF;
  IF r.conditions->>'amount_max' IS NOT NULL AND abs(bank.amount_cents::numeric)>(r.conditions->>'amount_max')::numeric THEN CONTINUE; END IF;
  IF r.conditions->>'payee_id' IS NOT NULL AND e.payee_id IS DISTINCT FROM (r.conditions->>'payee_id')::uuid THEN CONTINUE; END IF;
  matches:=matches||jsonb_build_array(to_jsonb(r)||jsonb_build_object('rule_id',r.id,
   'description_mode',CASE WHEN mode='equals' THEN 'exact' ELSE mode END,'description',pattern,
   'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction',
   'min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),
   'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id',
   'category_name',coalesce((SELECT name FROM accounting.accounts WHERE id=(r.actions->>'account_id')::uuid),'Split categories'),'reason',''));
 END LOOP;
 IF jsonb_array_length(matches)=0 THEN RETURN NULL; END IF;
 winner:=matches->0;
 descriptor:=upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g'));
 SELECT count(DISTINCT party_id) INTO alias_count FROM accounting.payee_aliases a WHERE enabled AND
  ((match_kind='key' AND a.pattern=e.descriptor_key) OR (match_kind='exact' AND upper(a.pattern)=descriptor) OR (match_kind='prefix' AND left(descriptor,length(a.pattern))=upper(a.pattern)));
 IF e.status='posted' THEN why:='Posted history is preview only';
 ELSIF NOT EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN why:='Category already reviewed';
 ELSIF alias_count>1 THEN why:='Conflicting payee aliases';
 ELSIF (SELECT count(*) FROM jsonb_array_elements(matches) m WHERE m->>'priority'=winner->>'priority')>1 THEN why:='Rules share the winning priority';
 -- A category archived after the rule was saved: the draft waits for a person instead of failing the sync (Nov 2026).
 ELSIF EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.is_archived AND (a.id::text=winner->'actions'->>'account_id'
  OR a.id::text IN (SELECT s->>'account_id' FROM jsonb_array_elements(coalesce(winner->'actions'->'splits','[]')) s))) THEN why:='The rule''s category is archived'; END IF;
 RETURN winner||jsonb_build_object('id',e.id,'version',e.version,'entry_id',entry,'entry_version',e.version,'rule_id',winner->'id','rule_version',winner->'version',
  'entry_date',e.entry_date,'memo',e.memo,'status',e.status,'payee_id',e.payee_id,
  'aliases',jsonb_build_object('conflict',alias_count>1,'aliases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',p.name,'description',a.pattern)),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id WHERE a.enabled AND ((a.match_kind='key' AND a.pattern=e.descriptor_key) OR (a.match_kind='exact' AND upper(a.pattern)=descriptor) OR (a.match_kind='prefix' AND left(descriptor,length(a.pattern))=upper(a.pattern))))),
  'eligible',why='','reason',why,'winner',winner,'matches',matches,'bank_account_id',bank.account_id,'bank_amount_cents',bank.amount_cents::text,
  'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount_cents::text) ORDER BY sort_order) FROM accounting.journal_lines WHERE entry_id=entry));
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
   -- A split can round one share of a cents-sized charge to nothing. That charge waits for a person: a failure
   -- here would undo the whole sync batch, and every later run would stop at the same charge (Nov 2026).
   BEGIN
    result:=accounting.ledger_command(jsonb_build_object('type','entry.split','id',entry,'expected_version',e.version,'splits',candidate->'actions'->'splits','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
   EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'ACCT_INVALID_SPLIT' THEN RAISE; END IF;
    candidate:=NULL;
   END;
  ELSE
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',candidate->'actions'->>'account_id','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  END IF;
 END IF;
 IF candidate IS NOT NULL AND (candidate->>'eligible')::boolean THEN
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

CREATE OR REPLACE FUNCTION accounting.ledger_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type'; k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid()); actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 e accounting.journal_entries; account_row accounting.accounts; v integer; x jsonb; line jsonb; idx integer; r jsonb; replacement jsonb; reversal jsonb;
 preserved uuid[]:='{}'; seen uuid[]:='{}'; existing_line uuid; original_date date; category uuid; bank_line accounting.journal_lines; carried jsonb:='[]'; total numeric; allocated bigint; remain bigint; share_sum bigint;
 closing date; later integer; first_later date; closing_balance bigint; books_today date; stamp jsonb; before_lines jsonb; kept boolean; released uuid[];
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
    SELECT coalesce(array_agg(DISTINCT m.bank_transaction_id),'{}') INTO released FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=k;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING k;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING k;
    -- A discard returns the bank line to review, so it can be matched elsewhere. A person deleting a draft the
    -- feed made (exclude_bank) means the charge itself: its line is set aside, as deleting a reviewed one does,
    -- or the next sync re-reads it and makes the draft again (Nov 2026).
    IF e.origin IN ('simplefin','csv') AND coalesce((c->>'exclude_bank')::boolean,false) THEN
     UPDATE accounting.bank_transactions b SET review='excluded',excluded_reason='Transaction deleted: '||k::text
      WHERE b.id=ANY(released) AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=b.id);
    END IF;
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
    -- import still learns from it (an edit used to drop it, Oct 2026). A contact sent with the edit is the new
    -- version's; without one it keeps the original's (the contact used to be dropped, Nov 2026).
    replacement:=accounting.ledger_command(c||jsonb_build_object('type','draft.save','id',coalesce((c->>'replacement_id')::uuid,gen_random_uuid()),'expected_version',0,'origin','internal','kind','correction',
     'payee_id',CASE WHEN c?'payee_id' THEN c->'payee_id' ELSE to_jsonb(e.payee_id) END,'source_description',e.source_description));
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

CREATE OR REPLACE FUNCTION accounting.sync_server(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c accounting.bank_connections; ba accounting.bank_accounts; observation accounting.bank_transactions; a jsonb; tx jsonb; normalized jsonb;
 provider_key text; legacy text[]; legacy_key text; legacy_id text; discover_id uuid; new_checkpoint jsonb; discovered jsonb; due_list jsonb; zone text; run uuid:=coalesce((command->>'run_id')::uuid,gen_random_uuid());
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
  -- Protocol v2 replaces the derived v1:<hash> connection id with the provider's own; account ids do not change.
  -- The first v2 sighting re-keys the one v1 identity with this account id, so mapping, coverage and evidence carry over.
  IF a->>'provider_connection_id' NOT LIKE 'v1:%' AND NOT EXISTS(SELECT 1 FROM jsonb_each(discovered) d WHERE d.value->>'provider_account_id'=provider_key) THEN
   SELECT array_agg(DISTINCT k) INTO legacy FROM (
    SELECT d.value->>'provider_account_id' k FROM jsonb_each(discovered) d WHERE d.value->>'raw_provider_account_id'=a->>'provider_account_id' AND d.value->>'provider_connection_id' LIKE 'v1:%'
    UNION SELECT b.provider_account_id FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND CASE WHEN b.provider_account_id LIKE '["v1:%' THEN (b.provider_account_id::jsonb)->>1 END=a->>'provider_account_id') l;
   IF cardinality(legacy)=1 THEN
    legacy_key:=legacy[1];
    SELECT d.key INTO legacy_id FROM jsonb_each(discovered) d WHERE d.value->>'provider_account_id'=legacy_key;
    IF legacy_id IS NOT NULL THEN
     discovered:=jsonb_set(discovered,ARRAY[legacy_id],discovered->legacy_id||jsonb_build_object('provider_account_id',provider_key,'provider_connection_id',a->>'provider_connection_id'));
    END IF;
    UPDATE accounting.bank_accounts SET provider_account_id=provider_key WHERE connection_id=c.id AND provider_account_id=legacy_key;
    IF new_checkpoint ? legacy_key THEN new_checkpoint:=jsonb_set(new_checkpoint-legacy_key,ARRAY[provider_key],new_checkpoint->legacy_key); END IF;
   END IF;
  END IF;
  -- A re-keyed entry keeps its original id: feed accounts are keyed by it.
  discover_id:=coalesce((SELECT d.key::uuid FROM jsonb_each(discovered) d WHERE d.value->>'provider_account_id'=provider_key LIMIT 1),md5(c.id::text||':'||provider_key)::uuid);
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
   -- Same-amount entries already in the books take the bank lines one each, nearest date first. Two $25 charges
   -- next to two $25 entries used to match neither and add two drafts, four entries for two charges (Nov 2026).
   SELECT count(*),(array_agg(l.id ORDER BY abs(e.entry_date-book_date),e.entry_date,l.id))[1] INTO candidate_count,candidate_id
    FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=ba.account_id AND l.amount_cents=amount AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
     AND abs(e.entry_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
     AND (NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=l.id)
      OR EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions o ON o.id=m.bank_transaction_id WHERE m.journal_line_id=l.id AND m.amount_cents=abs(amount) AND o.source<>observation.source AND o.bank_account_id=ba.id AND o.amount_cents=amount AND abs(o.posted_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)));
   IF candidate_count>=1 THEN
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
 -- Bridge refreshes each institution about every 24 hours; its accounts' balance-date is the last refresh.
 -- Rest until two hours before the next one is due (six hours at most), poll each half-hour tick until four
 -- hours after, and fall back to two hours for an overdue one. An incomplete run retries in an hour.
 UPDATE accounting.bank_connections SET checkpoint=new_checkpoint,last_success_at=CASE WHEN NOT partial AND NOT discovery_only AND count_conflicts=0 AND run_complete THEN now() ELSE last_success_at END,
  last_error=CASE WHEN count_conflicts>0 THEN 'Provider records changed. Original evidence was retained; review before advancing coverage.' WHEN NOT run_complete THEN 'The provider reported incomplete account data.' ELSE '' END,
  lease_run_id=CASE WHEN partial THEN run ELSE NULL END,lease_until=CASE WHEN partial THEN c.lease_until ELSE NULL END,next_sync_at=CASE WHEN NOT (run_complete AND count_conflicts=0) THEN now()+interval '1 hour'
   ELSE coalesce((SELECT min(CASE WHEN now()<r.refreshed+interval '22 hours' THEN least(r.refreshed+interval '22 hours',now()+interval '6 hours')
     WHEN now()<r.refreshed+interval '28 hours' THEN now()+interval '25 minutes' ELSE now()+interval '110 minutes' END)
    FROM (SELECT d.value->>'provider_connection_id' institution,max(to_timestamp((d.value->>'balance_at')::bigint)) refreshed FROM jsonb_each(discovered) d
     WHERE (d.value->>'seen_at')::bigint>=extract(epoch FROM now())-600 AND jsonb_typeof(d.value->'balance_at')='number' GROUP BY 1) r),now()+interval '110 minutes') END WHERE id=c.id;
 INSERT INTO accounting.audit_log(actor_kind,operation_id,table_name,row_id,action,after)
  VALUES('worker',run,'bank_connections',c.id,'sync',jsonb_build_object('accounts',jsonb_array_length(command->'accounts'),'new',count_new,'pending',count_pending,'drafts',count_drafts,'errors',count_conflicts));
 RETURN jsonb_build_object('id',c.id,'new',count_new,'pending',count_pending,'drafts',count_drafts,'conflicts',count_conflicts,'complete',run_complete AND count_conflicts=0);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report(kind text, params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date:=coalesce((params->>'from')::date,date_trunc('year',coalesce((params->>'as_of')::date,current_date))::date);
 end_date date:=coalesce((params->>'as_of')::date,(params->>'to')::date,current_date);year_start date;compare_year_start date;compare_start date:=(params->>'compare_from')::date;compare_end date:=(params->>'compare_to')::date;
 accounts jsonb;totals jsonb;comparison jsonb;monthly jsonb;cash jsonb;quality jsonb;dimensions jsonb;result jsonb;basis text:=coalesce(params->>'basis','cash');bounds date[]:='{}';
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_reader();END IF;
 PERFORM accounting.report_validate(params);
 IF kind NOT IN ('profit_loss','balance_sheet','trial_balance','general_ledger','cash_movements','account_balances','summary','owner_activity','payee') THEN RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 IF start_date>end_date OR (compare_start IS NULL)<>(compare_end IS NULL) OR compare_start>compare_end THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 year_start:=make_date(extract(year FROM end_date)::integer,(SELECT fiscal_year_start_month FROM public.business_profile WHERE id=1),1);
 IF year_start>end_date THEN year_start:=(year_start-interval '1 year')::date;END IF;
 IF compare_end IS NOT NULL THEN compare_year_start:=make_date(extract(year FROM compare_end)::integer,(SELECT fiscal_year_start_month FROM public.business_profile WHERE id=1),1);IF compare_year_start>compare_end THEN compare_year_start:=(compare_year_start-interval '1 year')::date;END IF;END IF;
 -- The accrual view's straight-line earnings split on every date a total below is cut at, so each sum is exact.
 IF basis='accrual' THEN
  bounds:=ARRAY[start_date-1,end_date,year_start-1]||CASE WHEN compare_end IS NULL THEN '{}'::date[] ELSE ARRAY[compare_start-1,compare_end,compare_year_start-1] END
   ||(SELECT coalesce(array_agg((d+interval '1 month - 1 day')::date),'{}') FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d);
 END IF;
 WITH selected AS (
  SELECT s.entry_date,s.status,s.id,s.entry_id,s.account_id,s.amount_cents,s.line_memo memo,s.sort_order FROM accounting.report_source(params,bounds) s
 ), cancelled AS (
  -- An entry and its reversal both inside the period cancel line for line. The activity debits and credits leave
  -- both out, so a deleted or edited entry never reads as money both in and out (Nov 2026). Net movement is unchanged.
  SELECT o.id FROM accounting.journal_entries o JOIN accounting.journal_entries r ON r.reverses_entry_id=o.id
  WHERE o.status='posted' AND r.status='posted' AND o.entry_date BETWEEN start_date AND end_date AND r.entry_date BETWEEN start_date AND end_date
  UNION ALL
  SELECT r.id FROM accounting.journal_entries o JOIN accounting.journal_entries r ON r.reverses_entry_id=o.id
  WHERE o.status='posted' AND r.status='posted' AND o.entry_date BETWEEN start_date AND end_date AND r.entry_date BETWEEN start_date AND end_date
 ), rows AS (
 SELECT a.*,p.name parent_name,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<start_date),0) opening,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date AND l.amount_cents>0),0) debit,
  -coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date AND l.amount_cents<0),0) credit,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date AND l.amount_cents>0 AND l.entry_id NOT IN (SELECT id FROM cancelled)),0) activity_debit,
  -coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date AND l.amount_cents<0 AND l.entry_id NOT IN (SELECT id FROM cancelled)),0) activity_credit,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date),0) movement,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<=end_date),0) ending,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<year_start),0) prior,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN year_start AND end_date),0) current_year,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN compare_start AND compare_end),0) compare_movement,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<=compare_end),0) compare_ending,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<compare_year_start),0) compare_prior,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN compare_year_start AND compare_end),0) compare_year
 FROM accounting.accounts a LEFT JOIN accounting.accounts p ON p.id=a.parent_id LEFT JOIN selected l ON l.account_id=a.id
 WHERE (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))
 GROUP BY a.id,p.name
 )
 SELECT coalesce(jsonb_agg(to_jsonb(r)-ARRAY['opening','debit','credit','activity_debit','activity_credit','movement','ending','prior','current_year','compare_movement','compare_ending','compare_prior','compare_year']||jsonb_build_object(
  'code',coalesce(r.code,''),'account_type',r.type,'normal_side',CASE WHEN (r.type IN ('asset','expense'))<>r.is_contra THEN 'debit' ELSE 'credit' END,'parent_account_id',r.parent_id,'purpose',r.system_purpose,'cash_kind',CASE WHEN r.subtype IN ('bank','cash','card') THEN r.subtype ELSE 'none' END,
  'opening_cents',opening::text,'debit_cents',debit::text,'credit_cents',credit::text,'activity_debit_cents',activity_debit::text,'activity_credit_cents',activity_credit::text,'movement_cents',movement::text,'period_cents',movement::text,'ending_cents',ending::text,'prior_cents',prior::text,'year_cents',current_year::text,
  'compare_period_cents',compare_movement::text,'compare_ending_cents',compare_ending::text,'compare_prior_cents',compare_prior::text,'compare_year_cents',compare_year::text) ORDER BY r.code NULLS LAST,r.name,r.id),'[]') INTO accounts FROM rows r;
 WITH a AS(SELECT value r FROM jsonb_array_elements(accounts)),s AS(SELECT
  -coalesce(sum((r->>'period_cents')::numeric) FILTER(WHERE r->>'type'='income'),0) income,
  coalesce(sum((r->>'period_cents')::numeric) FILTER(WHERE r->>'type'='expense'),0) expense,
  coalesce(sum((r->>'period_cents')::numeric) FILTER(WHERE r->>'type'='expense' AND lower(r->>'subtype') IN ('cogs','cost_of_goods_sold','cost of goods sold','direct_costs')),0) cogs,
  coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'type'='asset'),0) assets,
  -coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'type'='liability'),0) liabilities,
  -coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'type'='equity'),0) equity,
  -coalesce(sum((r->>'prior_cents')::numeric) FILTER(WHERE r->>'type' IN ('income','expense')),0) prior,
  -coalesce(sum((r->>'year_cents')::numeric) FILTER(WHERE r->>'type' IN ('income','expense')),0) current_year,
  coalesce(sum((r->>'opening_cents')::numeric) FILTER(WHERE r->>'subtype' IN ('bank','cash')),0) cash_opening,
  coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'subtype' IN ('bank','cash')),0) cash_ending
 FROM a)
 SELECT jsonb_build_object('income_cents',income::text,'expense_cents',expense::text,'cogs_cents',cogs::text,'net_cents',(income-expense)::text,'assets_cents',assets::text,'liabilities_cents',liabilities::text,'equity_cents',equity::text,'prior_cents',prior::text,'year_cents',current_year::text,'difference_cents',(assets-liabilities-equity-prior-current_year)::text,'cash_opening_cents',cash_opening::text,'cash_ending_cents',cash_ending::text) INTO totals FROM s;
 IF kind='balance_sheet' AND NOT params ?| ARRAY['account_ids','account_types','payee'] AND (totals->>'difference_cents')::numeric<>0 THEN RAISE EXCEPTION 'ACCT_BALANCE_SHEET_UNBALANCED';END IF;
 IF compare_start IS NOT NULL THEN comparison:=accounting.report(kind,(params-ARRAY['compare_from','compare_to','as_of'])||jsonb_build_object('from',compare_start,'to',compare_end))->'totals';
 ELSE comparison:=(SELECT jsonb_object_agg(key,'0'::text) FROM jsonb_each(totals));END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',month,'income_cents',income::text,'expense_cents',expense::text,'net_cents',(income-expense)::text) ORDER BY month),'[]') INTO monthly FROM (
 SELECT d::date AS month,-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) expense
 FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d
 LEFT JOIN accounting.report_source(params,bounds) l ON l.entry_date>=d::date AND l.entry_date<(d+interval '1 month')::date AND l.entry_date BETWEEN start_date AND end_date
 LEFT JOIN accounting.accounts a ON a.id=l.account_id GROUP BY d) m;
 SELECT coalesce(jsonb_agg(jsonb_build_object('classification',classification,'amount_cents',cents::text,'line_count',n) ORDER BY classification),'[]') INTO cash FROM (SELECT classification,sum(amount_cents) cents,count(DISTINCT id) n FROM accounting.cash_lines(params||jsonb_build_object('from',start_date,'to',end_date)) GROUP BY classification) c;
 SELECT jsonb_build_object('draft_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' AND entry_date BETWEEN start_date AND end_date),
 'unbalanced_drafts',(SELECT count(*) FROM accounting.journal_entries e WHERE e.status='draft' AND e.entry_date BETWEEN start_date AND end_date AND (SELECT count(*)<2 OR coalesce(sum(amount_cents),0)<>0 FROM accounting.journal_lines WHERE entry_id=e.id)),
 'unclassified_cash_lines',0,'uncategorized_lines',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE a.subtype='uncategorized' AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date),
 'reconciliations',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',b.account_id,'through',r.statement_end)),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE r.status='completed'),
 'feeds',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'last_success_at',last_success_at,'status',status)),'[]') FROM accounting.bank_connections)) INTO quality;
 IF basis='accrual' THEN quality:=quality||jsonb_build_object('accrual',accounting.accrual_summary(params,start_date,end_date,bounds));END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind','payee','id',party,'name',name,'income_cents',income::text,'expense_cents',expense::text,'compare_income_cents',compare_income::text,'compare_expense_cents',compare_expense::text)),'[]') INTO dimensions FROM (
 SELECT coalesce(l.payee_id::text,'unassigned') party,coalesce(p.name,'Unassigned') name,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND l.entry_date BETWEEN start_date AND end_date),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND l.entry_date BETWEEN start_date AND end_date),0) expense,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND l.entry_date BETWEEN compare_start AND compare_end),0) compare_income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND l.entry_date BETWEEN compare_start AND compare_end),0) compare_expense
 FROM accounting.report_source(params,bounds||CASE WHEN compare_end IS NULL OR basis<>'accrual' THEN '{}'::date[] ELSE ARRAY[compare_start-1,compare_end] END) l JOIN accounting.accounts a ON a.id=l.account_id LEFT JOIN accounting.parties p ON p.id=l.payee_id
 WHERE (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types'))) AND (l.entry_date BETWEEN start_date AND end_date OR l.entry_date BETWEEN compare_start AND compare_end) GROUP BY l.payee_id,p.name) q;
 result:=jsonb_build_object('legal_name',(SELECT legal_name FROM public.business_profile WHERE id=1),'revision',(SELECT financial_revision::text FROM accounting.settings),'definition_version',1,'currency','USD','basis',basis,'generated_at',now(),
 'filter',(params-'as_of')||jsonb_build_object('from',start_date,'to',end_date,'mode',coalesce(params->>'mode','posted'),'offset',coalesce((params->>'offset')::integer,0)),'accounts',accounts,'rows',accounts,'totals',totals,'comparison',comparison,'monthly',monthly,'dimensions',dimensions,'cash',cash,'quality',quality);
 RETURN result||jsonb_build_object('income_cents',totals->'income_cents','expense_cents',totals->'expense_cents','net_income_cents',totals->'net_cents','cost_of_goods_sold_cents',totals->'cogs_cents',
 'gross_profit_cents',((totals->>'income_cents')::numeric-(totals->>'cogs_cents')::numeric)::text,'operating_expense_cents',((totals->>'expense_cents')::numeric-(totals->>'cogs_cents')::numeric)::text,
 'assets_cents',totals->'assets_cents','liabilities_cents',totals->'liabilities_cents','equity_cents',totals->'equity_cents','retained_cents',totals->'prior_cents','year_income_cents',totals->'year_cents',
 'equity_total_cents',((totals->>'equity_cents')::numeric+(totals->>'prior_cents')::numeric+(totals->>'year_cents')::numeric)::text,'balance_difference_cents',totals->'difference_cents','trial_balance_cents',totals->'difference_cents');
END $function$
;

CREATE OR REPLACE FUNCTION accounting.breakdown(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date; end_date date; compare_start date; compare_end date; shift interval; unit text; step interval; top_n integer; timed boolean; result jsonb;
 measure text:=coalesce(params->>'measure','activity'); dimension text:=params->>'group_by'; working boolean:=coalesce(params->>'mode','posted')='working';
 accrual boolean:=coalesce(params->>'basis','cash')='accrual'; bounds date[]:='{}';
BEGIN
 PERFORM accounting.require_reader();
 PERFORM accounting.report_validate(params);
 start_date:=(params->>'from')::date; end_date:=(params->>'to')::date; top_n:=coalesce((params->>'top')::integer,20);
 compare_start:=(params->>'compare_from')::date; compare_end:=(params->>'compare_to')::date;
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR (compare_start IS NULL)<>(compare_end IS NULL) OR compare_start>compare_end THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE'; END IF;
 IF measure NOT IN ('activity','balance') OR coalesce(dimension,'') NOT IN ('month','quarter','category','contact','bank_account','role') OR top_n NOT BETWEEN 1 AND 100
  OR coalesce(params->>'role','client') NOT IN ('client','vendor','contractor','employee','government','financial','owner')
  OR coalesce(params->>'kind','manual') NOT IN ('manual','income','expense','transfer','payroll','opening','owner','asset','loan','refund','correction')
  OR coalesce(params->>'compare','previous_period') NOT IN ('previous_period','previous_year') OR (params ? 'compare' AND compare_start IS NOT NULL)
  OR (params->>'bank_account' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.id::text=params->>'bank_account' AND a.subtype IN ('bank','card','cash')))
  -- Activity is the profit and loss, so only income and expense accounts; a balance has no contact, role or kind.
  OR (measure='activity' AND EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.id::text IN (SELECT jsonb_array_elements_text(coalesce(params->'account_ids','[]'::jsonb))) AND a.type NOT IN ('income','expense')))
  OR (measure='activity' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(params->'account_types','[]'::jsonb)) t WHERE t.value NOT IN ('income','expense')))
  OR (measure='balance' AND (dimension IN ('contact','role') OR params ?| ARRAY['payee','role','kind','bank_account']))
  -- The accrual view's adjustment lines carry a contact but no kind, role or bank account.
  OR (accrual AND (dimension IN ('bank_account','role') OR params ?| ARRAY['role','kind','bank_account'])) THEN
  RAISE EXCEPTION 'ACCT_INVALID_FILTER';
 END IF;
 timed:=dimension IN ('month','quarter');
 unit:=CASE WHEN dimension='quarter' THEN 'quarter' ELSE 'month' END;
 step:=CASE WHEN dimension='quarter' THEN interval '3 months' ELSE interval '1 month' END;
 IF timed AND (SELECT count(*) FROM generate_series(date_trunc(unit,start_date),date_trunc(unit,end_date),step))>120 THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE'; END IF;
 -- The comparison: the period just before (whole months shift by whole months, so September compares with August,
 -- not the 30 days before it) or the same dates a year earlier. A month bucket meets the bucket the shift maps to it.
 IF params->>'compare'='previous_year' THEN
  shift:=interval '1 year';
 ELSIF params->>'compare'='previous_period' THEN
  shift:=CASE WHEN start_date=date_trunc('month',start_date)::date AND end_date=(date_trunc('month',end_date)+interval '1 month -1 day')::date
   THEN make_interval(months=>((extract(year FROM end_date)-extract(year FROM start_date))*12+extract(month FROM end_date)-extract(month FROM start_date)+1)::integer)
   ELSE make_interval(days=>end_date-start_date+1) END;
 ELSIF compare_start IS NOT NULL THEN
  shift:=CASE WHEN start_date=date_trunc('month',start_date)::date AND compare_start=date_trunc('month',compare_start)::date
   THEN make_interval(months=>((extract(year FROM start_date)-extract(year FROM compare_start))*12+extract(month FROM start_date)-extract(month FROM compare_start))::integer)
   ELSE make_interval(days=>start_date-compare_start) END;
 END IF;
 IF params ? 'compare' THEN
  compare_start:=(start_date-shift)::date;
  compare_end:=CASE WHEN extract(day FROM shift)=0 AND end_date=(date_trunc('month',end_date)+interval '1 month -1 day')::date
   THEN (date_trunc('month',(end_date-shift)::date)+interval '1 month -1 day')::date ELSE (end_date-shift)::date END;
 END IF;
 -- The accrual basis reads the reports' own lines (report_source), cut on every date a sum below ends at, as the reports
 -- cut them, so a chart matches its statement. The ledger alone is the cash basis (the charts mixed the two, Nov 2026).
 IF accrual THEN
  bounds:=ARRAY[start_date-1,end_date]||CASE WHEN compare_start IS NULL THEN '{}'::date[] ELSE ARRAY[compare_start-1,compare_end] END
   ||(SELECT coalesce(array_agg((d+interval '1 month - 1 day')::date),'{}') FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d)
   ||CASE WHEN compare_start IS NULL THEN '{}'::date[] ELSE (SELECT coalesce(array_agg((d+interval '1 month - 1 day')::date),'{}') FROM generate_series(date_trunc('month',compare_start),date_trunc('month',compare_end),interval '1 month') d) END;
 END IF;
 IF measure='activity' THEN
  WITH live AS (
   -- The reports' live entries (posted, or balanced drafts in working mode) in either period, after the entry filters.
   SELECT e.id,e.entry_date,e.payee_id,m.money_account
   FROM accounting.journal_entries e CROSS JOIN LATERAL (
    SELECT count(*) AS line_count,coalesce(sum(l.amount_cents),0) AS balance,
     CASE WHEN count(DISTINCT l.account_id) FILTER(WHERE a.subtype IN ('bank','card','cash'))=1 THEN (min(l.account_id::text) FILTER(WHERE a.subtype IN ('bank','card','cash')))::uuid END AS money_account
    FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
   WHERE (e.entry_date BETWEEN start_date AND end_date OR e.entry_date BETWEEN compare_start AND compare_end)
    AND (e.status='posted' OR (working AND e.status='draft' AND m.line_count>=2 AND m.balance=0))
    AND (params->>'payee' IS NULL OR (params->>'payee'='unassigned' AND e.payee_id IS NULL) OR e.payee_id::text=params->>'payee')
    AND (params->>'kind' IS NULL OR e.kind=params->>'kind')
    AND (params->>'role' IS NULL OR EXISTS(SELECT 1 FROM accounting.parties p WHERE p.id=e.payee_id AND params->>'role'=ANY(p.roles)))
    AND (params->>'bank_account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id AND bl.account_id::text=params->>'bank_account'))
  ), lines AS (
   -- Income and expense lines, once for the period they fall in and once for the comparison they fall in.
   SELECT w.is_compare,x.id,x.payee_id,x.money_account,l.account_id,
    CASE WHEN a.type='income' THEN -l.amount_cents ELSE 0 END AS income,CASE WHEN a.type='expense' THEN l.amount_cents ELSE 0 END AS expense,
    date_trunc(unit,CASE WHEN w.is_compare THEN (x.entry_date+shift)::date ELSE x.entry_date END)::date AS bucket
   FROM live x CROSS JOIN (VALUES (false),(true)) AS w(is_compare) JOIN accounting.journal_lines l ON l.entry_id=x.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE NOT accrual AND CASE WHEN w.is_compare THEN x.entry_date BETWEEN compare_start AND compare_end ELSE x.entry_date BETWEEN start_date AND end_date END
    AND a.type IN ('income','expense')
    AND (NOT params?'account_ids' OR a.id::text IN (SELECT jsonb_array_elements_text(params->'account_ids')))
    AND (NOT params?'account_types' OR a.type IN (SELECT jsonb_array_elements_text(params->'account_types')))
   UNION ALL
   SELECT w.is_compare,s.entry_id,s.payee_id,NULL::uuid,s.account_id,
    CASE WHEN a.type='income' THEN -s.amount_cents ELSE 0 END,CASE WHEN a.type='expense' THEN s.amount_cents ELSE 0 END,
    date_trunc(unit,CASE WHEN w.is_compare THEN (s.entry_date+shift)::date ELSE s.entry_date END)::date
   FROM accounting.report_source(params,bounds) s CROSS JOIN (VALUES (false),(true)) AS w(is_compare) JOIN accounting.accounts a ON a.id=s.account_id
   WHERE accrual AND CASE WHEN w.is_compare THEN s.entry_date BETWEEN compare_start AND compare_end ELSE s.entry_date BETWEEN start_date AND end_date END
    AND a.type IN ('income','expense')
    AND (NOT params?'account_ids' OR a.id::text IN (SELECT jsonb_array_elements_text(params->'account_ids')))
    AND (NOT params?'account_types' OR a.type IN (SELECT jsonb_array_elements_text(params->'account_types')))
  ), keyed AS (
   SELECT l.*,CASE dimension
     WHEN 'category' THEN l.account_id::text
     WHEN 'contact' THEN coalesce(l.payee_id::text,'none')
     WHEN 'bank_account' THEN coalesce(l.money_account::text,'none')
     -- One role per contact, the most specific first, so each line counts once.
     WHEN 'role' THEN coalesce((SELECT r.role FROM accounting.parties p CROSS JOIN LATERAL unnest(ARRAY['owner','employee','contractor','government','financial','client','vendor']) WITH ORDINALITY AS r(role,n)
      WHERE p.id=l.payee_id AND r.role=ANY(p.roles) ORDER BY r.n LIMIT 1),'none')
     ELSE l.bucket::text END AS key
   FROM lines l
  ), grouped AS (
   SELECT k.key,coalesce(sum(k.income) FILTER(WHERE NOT k.is_compare),0) AS income,coalesce(sum(k.expense) FILTER(WHERE NOT k.is_compare),0) AS expense,count(DISTINCT k.id) FILTER(WHERE NOT k.is_compare) AS n,
    coalesce(sum(k.income) FILTER(WHERE k.is_compare),0) AS c_income,coalesce(sum(k.expense) FILTER(WHERE k.is_compare),0) AS c_expense
   FROM keyed k GROUP BY k.key
  ), buckets AS (
   SELECT d::date::text AS key FROM generate_series(date_trunc(unit,start_date),date_trunc(unit,end_date),step) d WHERE timed
  ), grouped_rows AS (
   -- Every period in the range, empty ones included; other dimensions list the groups that have money.
   SELECT b.key,coalesce(g.income,0) AS income,coalesce(g.expense,0) AS expense,coalesce(g.n,0) AS n,coalesce(g.c_income,0) AS c_income,coalesce(g.c_expense,0) AS c_expense FROM buckets b LEFT JOIN grouped g ON g.key=b.key
   UNION ALL SELECT g.key,g.income,g.expense,g.n,g.c_income,g.c_expense FROM grouped g WHERE NOT timed
  ), ranked AS (
   SELECT r.*,CASE dimension
     WHEN 'month' THEN to_char(r.key::date,'Mon YYYY')
     WHEN 'quarter' THEN 'Q'||extract(quarter FROM r.key::date)||' '||extract(year FROM r.key::date)
     WHEN 'category' THEN (SELECT a.name FROM accounting.accounts a WHERE a.id::text=r.key)
     WHEN 'bank_account' THEN coalesce((SELECT a.name FROM accounting.accounts a WHERE a.id::text=r.key),'No single bank account')
     WHEN 'contact' THEN coalesce((SELECT p.name FROM accounting.parties p WHERE p.id::text=r.key),'No contact')
     ELSE CASE WHEN r.key='none' THEN 'No contact' ELSE initcap(r.key) END END AS label,
    CASE WHEN dimension='category' THEN (SELECT a.type FROM accounting.accounts a WHERE a.id::text=r.key) END AS account_type,
    row_number() OVER (ORDER BY CASE WHEN timed THEN r.key END,abs(r.income)+abs(r.expense) DESC,abs(r.c_income)+abs(r.c_expense) DESC,r.key) AS position
   FROM grouped_rows r
  )
  SELECT jsonb_build_object(
   'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.key,'label',r.label)||CASE WHEN r.account_type IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('type',r.account_type) END
    ||accounting.breakdown_amounts(r.income,r.expense,r.n,r.c_income,r.c_expense,compare_start IS NOT NULL) ORDER BY r.position) FROM ranked r WHERE timed OR r.position<=top_n),'[]'::jsonb),
   'other',(SELECT jsonb_build_object('label','Other ('||(SELECT count(*) FROM ranked r WHERE r.position>top_n)||CASE dimension WHEN 'category' THEN ' categories)' WHEN 'contact' THEN ' contacts)' WHEN 'role' THEN ' roles)' ELSE ' accounts)' END,
     'groups',(SELECT count(*) FROM ranked r WHERE r.position>top_n))
    ||accounting.breakdown_amounts(coalesce(sum(k.income) FILTER(WHERE NOT k.is_compare),0),coalesce(sum(k.expense) FILTER(WHERE NOT k.is_compare),0),count(DISTINCT k.id) FILTER(WHERE NOT k.is_compare),
     coalesce(sum(k.income) FILTER(WHERE k.is_compare),0),coalesce(sum(k.expense) FILTER(WHERE k.is_compare),0),compare_start IS NOT NULL)
    FROM keyed k WHERE NOT timed AND k.key IN (SELECT r.key FROM ranked r WHERE r.position>top_n) HAVING count(*)>0),
   'total',(SELECT accounting.breakdown_amounts(coalesce(sum(l.income) FILTER(WHERE NOT l.is_compare),0),coalesce(sum(l.expense) FILTER(WHERE NOT l.is_compare),0),count(DISTINCT l.id) FILTER(WHERE NOT l.is_compare),
     coalesce(sum(l.income) FILTER(WHERE l.is_compare),0),coalesce(sum(l.expense) FILTER(WHERE l.is_compare),0),compare_start IS NOT NULL) FROM lines l)) INTO result;
 ELSE
  WITH chosen AS (
   -- The accounts asked for, or every bank and cash account (the cash position); each on its normal side.
   SELECT a.id,CASE WHEN (a.type IN ('asset','expense'))<>a.is_contra THEN 1 ELSE -1 END AS sign
   FROM accounting.accounts a
   WHERE CASE WHEN params?'account_ids' THEN a.id::text IN (SELECT jsonb_array_elements_text(params->'account_ids'))
    WHEN params?'account_types' THEN a.type IN (SELECT jsonb_array_elements_text(params->'account_types'))
    ELSE a.subtype IN ('bank','cash') END
  ), moves AS (
   SELECT l.account_id,e.entry_date,l.amount_cents*c.sign AS amount
   FROM accounting.journal_lines l JOIN chosen c ON c.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id
   WHERE NOT accrual AND e.entry_date<=greatest(end_date,coalesce(compare_end,end_date))
    AND (e.status='posted' OR (working AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
   UNION ALL
   SELECT s.account_id,s.entry_date,s.amount_cents*c.sign
   FROM accounting.report_source(params,bounds) s JOIN chosen c ON c.id=s.account_id
   WHERE accrual AND s.entry_date<=greatest(end_date,coalesce(compare_end,end_date))
  ), points AS (
   -- Each period's end (the last, partial one ends at `to`), or each account at `to`.
   SELECT d::date::text AS key,NULL::uuid AS account_id,least((d+step-interval '1 day')::date,end_date) AS at FROM generate_series(date_trunc(unit,start_date),date_trunc(unit,end_date),step) d WHERE timed
   UNION ALL SELECT c.id::text,c.id,end_date FROM chosen c WHERE NOT timed
  ), measured AS (
   SELECT p.*,CASE WHEN compare_start IS NULL THEN NULL WHEN NOT timed THEN compare_end
     WHEN extract(day FROM shift)=0 AND p.at=(date_trunc('month',p.at)+interval '1 month -1 day')::date THEN (date_trunc('month',(p.at-shift)::date)+interval '1 month -1 day')::date
     ELSE (p.at-shift)::date END AS compare_at
   FROM points p
  ), valued AS (
   SELECT m.*,coalesce((SELECT sum(v.amount) FROM moves v WHERE v.entry_date<=m.at AND (m.account_id IS NULL OR v.account_id=m.account_id)),0) AS balance,
    coalesce((SELECT sum(v.amount) FROM moves v WHERE v.entry_date<=m.compare_at AND (m.account_id IS NULL OR v.account_id=m.account_id)),0) AS compare_balance
   FROM measured m
  ), ranked AS (
   SELECT v.*,CASE dimension
     WHEN 'month' THEN to_char(v.key::date,'Mon YYYY')
     WHEN 'quarter' THEN 'Q'||extract(quarter FROM v.key::date)||' '||extract(year FROM v.key::date)
     ELSE (SELECT a.name FROM accounting.accounts a WHERE a.id=v.account_id) END AS label,
    (SELECT a.type FROM accounting.accounts a WHERE a.id=v.account_id) AS account_type,
    row_number() OVER (ORDER BY CASE WHEN timed THEN v.key END,abs(v.balance) DESC,abs(v.compare_balance) DESC,v.key) AS position
   FROM valued v
  )
  SELECT jsonb_build_object(
   'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.key,'label',r.label)||CASE WHEN r.account_type IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('type',r.account_type) END
    ||jsonb_build_object('balance_cents',r.balance::text)
    ||CASE WHEN compare_start IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('compare',jsonb_build_object('balance_cents',r.compare_balance::text),'change',jsonb_build_object('balance_cents',(r.balance-r.compare_balance)::text)) END
    ORDER BY r.position) FROM ranked r WHERE timed OR r.position<=top_n),'[]'::jsonb),
   'other',(SELECT jsonb_build_object('label','Other ('||count(*)||' accounts)','groups',count(*),'balance_cents',sum(r.balance)::text)
     ||CASE WHEN compare_start IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('compare',jsonb_build_object('balance_cents',sum(r.compare_balance)::text),'change',jsonb_build_object('balance_cents',(sum(r.balance)-sum(r.compare_balance))::text)) END
    FROM ranked r WHERE NOT timed AND r.position>top_n HAVING count(*)>0),
   'total',(SELECT jsonb_build_object('balance_cents',coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=end_date),0)::text)
     ||CASE WHEN compare_start IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('compare',jsonb_build_object('balance_cents',coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=compare_end),0)::text),
      'change',jsonb_build_object('balance_cents',(coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=end_date),0)-coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=compare_end),0))::text)) END
    FROM moves v)) INTO result;
 END IF;
 RETURN jsonb_build_object('from',start_date,'to',end_date,'book_mode',CASE WHEN working THEN 'working' ELSE 'posted' END,'measure',measure,'group_by',dimension,'top',top_n,
  'compare',CASE WHEN compare_start IS NULL THEN NULL ELSE jsonb_build_object('from',compare_start,'to',compare_end) END)
  ||result
  ||jsonb_build_object('quality',jsonb_build_object(
   'draft_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' AND entry_date BETWEEN start_date AND end_date),
   'unbalanced_drafts',(SELECT count(*) FROM accounting.journal_entries e WHERE e.status='draft' AND e.entry_date BETWEEN start_date AND end_date AND (SELECT count(*)<2 OR coalesce(sum(amount_cents),0)<>0 FROM accounting.journal_lines WHERE entry_id=e.id)),
   'uncategorized_lines',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE a.subtype='uncategorized' AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date),
   'unclassified_cash_lines',0),
   'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1));
END $function$
;
