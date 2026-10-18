-- Sales tax on source invoices. An invoice's tax arrives as its own "tax" line; a source maps
-- it to a liability account (the tax is owed, never earned), so the accrual view records it as
-- owed on the issue date and never as income.
BEGIN;

CREATE OR REPLACE FUNCTION accounting.invoice_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type'; key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());
 actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 v integer; source accounting.invoice_sources; link accounting.invoice_payments; dep record; x jsonb; n integer:=0;
 base text; accounts jsonb; outstanding bigint; total bigint:=0; capacity bigint; candidate jsonb; linked jsonb:='[]'; from_date date; to_date date; books_today date;
 new_account_map jsonb; new_party_map jsonb;
BEGIN
 -- Connections and links are the owner's: an API key's drafts-only path never reaches them.
 IF current_setting('accounting.actor_kind',true)='api' THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 IF t='invoice_source.save' THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  SELECT * INTO source FROM accounting.invoice_sources WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(source.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF length(btrim(coalesce(c->>'name',source.name,''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  base:=rtrim(btrim(coalesce(c->>'base_url',source.base_url,'')),'/');
  IF base !~ '^https://[^[:space:]/?#]+(/[^[:space:]?#]*[^[:space:]?#/])?$' OR length(base)>500 THEN RAISE EXCEPTION 'ACCT_INVALID_SOURCE_URL'; END IF;
  IF EXISTS(SELECT 1 FROM accounting.invoice_sources s WHERE s.base_url=base AND s.id<>key) THEN RAISE EXCEPTION 'ACCT_SOURCE_EXISTS'; END IF;
  IF source.id IS NULL AND nullif(c->>'api_key_encrypted','') IS NULL THEN RAISE EXCEPTION 'ACCT_SOURCE_KEY_REQUIRED'; END IF;
  IF c ? 'status' AND coalesce(c->>'status','') NOT IN ('active','paused','disconnected') THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  IF c ? 'auto_link' AND jsonb_typeof(c->'auto_link') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  -- Each line type goes to one revenue account (a reimbursement may reduce an expense instead, and sales tax is owed, so it goes to a
  -- liability), never a suspense or accrual account.
  IF c ? 'account_map' THEN
   IF jsonb_typeof(c->'account_map') IS DISTINCT FROM 'object' OR EXISTS(
    SELECT 1 FROM jsonb_each(c->'account_map') m LEFT JOIN accounting.accounts a ON a.id::text=lower(m.value#>>'{}')
    WHERE m.key NOT IN ('hourly','fixed','recurring','reimbursement','tax') OR jsonb_typeof(m.value) IS DISTINCT FROM 'string' OR a.id IS NULL OR a.is_archived
     OR NOT ((m.key<>'tax' AND a.type='income') OR (m.key='reimbursement' AND a.type='expense') OR (m.key='tax' AND a.type='liability'))
     OR coalesce(a.system_purpose,'') IN ('uncategorized_income','uncategorized_expense','accounts_receivable','unbilled_revenue','deferred_revenue')) THEN RAISE EXCEPTION 'ACCT_INVALID_ACCOUNT_MAP'; END IF;
   SELECT coalesce(jsonb_object_agg(m.key,lower(m.value#>>'{}')),'{}') INTO new_account_map FROM jsonb_each(c->'account_map') m;
  END IF;
  -- A source project belongs to one client contact.
  IF c ? 'party_map' THEN
   IF jsonb_typeof(c->'party_map') IS DISTINCT FROM 'object' OR EXISTS(
    SELECT 1 FROM jsonb_each(c->'party_map') m LEFT JOIN accounting.parties p ON p.id::text=lower(m.value#>>'{}')
    WHERE length(m.key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(m.value) IS DISTINCT FROM 'string' OR p.id IS NULL OR p.is_archived OR NOT ('client'=ANY(p.roles))) THEN RAISE EXCEPTION 'ACCT_INVALID_PARTY_MAP'; END IF;
   SELECT coalesce(jsonb_object_agg(m.key,lower(m.value#>>'{}')),'{}') INTO new_party_map FROM jsonb_each(c->'party_map') m;
  END IF;
  accounts:=accounting.accrual_accounts();
  -- The proposed row is complete before any conflict check, so it carries every kept value forward itself.
  INSERT INTO accounting.invoice_sources(id,name,base_url,api_key_encrypted,key_version,account_map,party_map,auto_link,status)
  VALUES(key,btrim(coalesce(c->>'name',source.name)),base,coalesce(nullif(c->>'api_key_encrypted',''),source.api_key_encrypted),
   CASE WHEN nullif(c->>'api_key_encrypted','') IS NULL THEN coalesce(source.key_version,1) ELSE coalesce((c->>'key_version')::smallint,1) END,
   coalesce(new_account_map,source.account_map,'{}'),coalesce(new_party_map,source.party_map,'{}'),
   CASE WHEN c ? 'auto_link' THEN (c->>'auto_link')::boolean ELSE coalesce(source.auto_link,true) END,
   -- A new key clears an authentication failure; otherwise the worker's status stands unless the owner sets one.
   coalesce(c->>'status',CASE WHEN nullif(c->>'api_key_encrypted','') IS NOT NULL AND source.status='auth_failed' THEN 'active' END,source.status,'active'))
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,api_key_encrypted=excluded.api_key_encrypted,key_version=excluded.key_version,
   account_map=excluded.account_map,party_map=excluded.party_map,auto_link=excluded.auto_link,status=excluded.status,
   last_error=CASE WHEN nullif(c->>'api_key_encrypted','') IS NOT NULL THEN '' ELSE accounting.invoice_sources.last_error END
  RETURNING version INTO v;
  -- The accrual view starts at the beginning of this year unless the owner already chose a month.
  books_today:=(SELECT (now() AT TIME ZONE p.books_timezone)::date FROM public.business_profile p WHERE p.id=1);
  UPDATE accounting.settings SET accrual_start=date_trunc('year',coalesce(books_today,current_date))::date,financial_revision=financial_revision+1 WHERE id=1 AND accrual_start IS NULL;
  RETURN jsonb_build_object('id',key,'version',v,'accounts',accounts);
 ELSIF t='invoice.link' THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  IF jsonb_typeof(c->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'allocations') NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  -- The deposit: money into a bank or cash account, not a transfer, still standing. Its credit lines are what it can apply to invoices.
  SELECT e.id,e.entry_date,e.version,
   (SELECT sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash')) bank_cents,
   (SELECT -sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype NOT IN ('bank','cash','card') AND l.amount_cents<0) credit_cents
  INTO dep FROM accounting.journal_entries e
  WHERE e.id=(c->>'entry_id')::uuid AND e.status<>'discarded' AND e.reverses_entry_id IS NULL AND e.transfer_group_id IS NULL AND e.pair_entry_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id=e.id);
  IF dep.id IS NULL OR coalesce(dep.bank_cents,0)<=0 OR coalesce(dep.credit_cents,0)<=0 THEN RAISE EXCEPTION 'ACCT_LINK_DEPOSIT_REQUIRED'; END IF;
  IF c ? 'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM dep.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  PERFORM accounting.require_open(dep.entry_date);
  capacity:=dep.credit_cents-coalesce((SELECT sum(p.amount_cents) FROM accounting.live_invoice_payments() p WHERE p.entry_id=dep.id),0);
  FOR x IN SELECT value FROM jsonb_array_elements(c->'allocations') LOOP
   n:=n+1;
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR coalesce(x->>'invoice_id','') !~ '^[0-9a-fA-F-]{36}$' OR coalesce(x->>'amount_cents','') !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.invoice_payments p WHERE p.invoice_id=(x->>'invoice_id')::uuid AND p.entry_id=dep.id AND p.removed_at IS NULL) THEN RAISE EXCEPTION 'ACCT_LINK_EXISTS'; END IF;
   SELECT o.outstanding_cents INTO outstanding FROM accounting.open_invoices() o WHERE o.invoice_id=(x->>'invoice_id')::uuid;
   IF outstanding IS NULL THEN RAISE EXCEPTION 'ACCT_LINK_INVOICE_NOT_OPEN'; END IF;
   IF (x->>'amount_cents')::bigint>outstanding THEN RAISE EXCEPTION 'ACCT_LINK_EXCEEDS_INVOICE'; END IF;
   total:=total+(x->>'amount_cents')::bigint;
   IF total>capacity THEN RAISE EXCEPTION 'ACCT_LINK_EXCEEDS_DEPOSIT'; END IF;
   INSERT INTO accounting.invoice_payments(id,invoice_id,entry_id,amount_cents,matched_by,created_by)
   VALUES(md5(key::text||':'||n)::uuid,(x->>'invoice_id')::uuid,dep.id,(x->>'amount_cents')::bigint,'owner',actor);
   linked:=linked||jsonb_build_array(jsonb_build_object('id',md5(key::text||':'||n)::uuid,'invoice_id',x->>'invoice_id','amount_cents',x->>'amount_cents'));
  END LOOP;
  RETURN jsonb_build_object('id',key,'entry_id',dep.id,'links',linked);
 ELSIF t='invoice.unlink' THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  SELECT * INTO link FROM accounting.invoice_payments WHERE id=key;
  IF NOT FOUND OR link.removed_at IS NOT NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM link.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  PERFORM accounting.require_open((SELECT e.entry_date FROM accounting.journal_entries e WHERE e.id=link.entry_id));
  -- Nothing reached the source: the link just ends. Otherwise the source is told to remove the payment it recorded.
  UPDATE accounting.invoice_payments SET removed_at=now(),removed_reason=btrim(c->>'reason'),
   sync_state=CASE WHEN external_payment_id IS NULL AND sync_state<>'synced' THEN 'removed' ELSE 'removing' END,attempts=0,next_attempt_at=NULL,last_error=''
  WHERE id=key RETURNING version INTO v;
  RETURN jsonb_build_object('id',key,'version',v);
 ELSIF t='invoice.retry' THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  SELECT * INTO link FROM accounting.invoice_payments WHERE id=key;
  IF NOT FOUND OR link.sync_state<>'failed' THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM link.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- A refused push goes back in line from the start: recorded again, removed again, or simply ended when nothing reached the source.
  UPDATE accounting.invoice_payments SET attempts=0,next_attempt_at=NULL,last_error='',
   sync_state=CASE WHEN removed_at IS NULL THEN 'pending' WHEN external_payment_id IS NULL THEN 'removed' ELSE 'removing' END
  WHERE id=key RETURNING version INTO v;
  RETURN jsonb_build_object('id',key,'version',v);
 ELSIF t='invoice.auto_link' THEN
  -- The exact matches a source allows, over deposits never linked before (an ended link is never redone), in open months from the accrual start.
  from_date:=coalesce((c->>'from')::date,(SELECT s.accrual_start FROM accounting.settings s WHERE s.id=1));
  to_date:=coalesce((c->>'to')::date,'2100-12-31'::date);
  IF from_date IS NOT NULL THEN
   FOR dep IN SELECT e.id FROM accounting.journal_entries e
    WHERE e.entry_date BETWEEN from_date AND to_date AND e.status<>'discarded'
     AND NOT EXISTS(SELECT 1 FROM accounting.invoice_payments p WHERE p.entry_id=e.id)
     AND NOT EXISTS(SELECT 1 FROM accounting.periods pr WHERE pr.status='locked' AND pr.month>=date_trunc('month',e.entry_date)::date)
     AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash') AND l.amount_cents>0)
    ORDER BY e.entry_date,e.id LOOP
    candidate:=accounting.invoice_candidates(dep.id);
    IF coalesce((candidate->>'auto')::boolean,false) THEN
     n:=n+1;
     INSERT INTO accounting.invoice_payments(id,invoice_id,entry_id,amount_cents,matched_by,created_by)
     VALUES(md5(key::text||':'||n)::uuid,(candidate->'invoices'->0->>'invoice_id')::uuid,dep.id,(candidate->>'remaining_cents')::bigint,'rule',actor);
     linked:=linked||jsonb_build_array(jsonb_build_object('id',md5(key::text||':'||n)::uuid,'entry_id',dep.id,'invoice_id',candidate->'invoices'->0->>'invoice_id','amount_cents',candidate->>'remaining_cents'));
    END IF;
   END LOOP;
  END IF;
  RETURN jsonb_build_object('id',key,'links',linked,'count',jsonb_array_length(linked));
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.invoice_sync_server(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s accounting.invoice_sources; run uuid:=coalesce((command->>'run_id')::uuid,gen_random_uuid()); x jsonb; link accounting.invoice_payments;
 seen text[]:='{}'; earned_keys text[]:='{}'; changed integer:=0; removed integer:=0; retired integer:=0; earned integer:=0; n integer; outcome text; linked jsonb;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'ACCT_WORKER_REQUIRED'; END IF;
 PERFORM accounting.write_lock();
 PERFORM set_config('accounting.operation_id',run::text,true);PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.action','invoice_source.sync',true);
 IF command->>'action'='due' THEN
  -- Due: an hour since the last pull, or links waiting to reach the source. Never a source another run holds.
  RETURN coalesce((SELECT jsonb_agg(d.id ORDER BY d.last_synced_at NULLS FIRST,d.id) FROM accounting.invoice_sources d
   WHERE d.status='active' AND (d.lease_until IS NULL OR d.lease_until<=now())
    AND (coalesce((command->>'force')::boolean,false) OR d.last_synced_at IS NULL OR d.last_synced_at<=now()-interval '50 minutes'
     OR EXISTS(SELECT 1 FROM accounting.invoice_payments p JOIN accounting.invoices i ON i.id=p.invoice_id
      WHERE i.source_id=d.id AND p.sync_state IN ('pending','removing') AND (p.next_attempt_at IS NULL OR p.next_attempt_at<=now())))),'[]');
 END IF;
 SELECT * INTO s FROM accounting.invoice_sources WHERE id=(command->>'id')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 IF command->>'action'='lease' THEN
  IF s.status<>'active' OR (s.lease_until>now() AND s.lease_run_id IS DISTINCT FROM run) THEN RETURN jsonb_build_object('id',s.id,'acquired',false); END IF;
  UPDATE accounting.invoice_sources SET lease_run_id=run,lease_until=now()+interval '5 minutes' WHERE id=s.id;
 ELSIF s.lease_run_id IS DISTINCT FROM run OR s.lease_until<=now() THEN RAISE EXCEPTION 'ACCT_STALE_LEASE';
 END IF;
 IF command->>'action'='lease' THEN retired:=accounting.invoice_retire_dead(s.id); END IF;
 IF command->>'action'='lease' THEN
  RETURN jsonb_build_object('id',s.id,'acquired',true,'run_id',run,'base_url',s.base_url,'api_key_encrypted',s.api_key_encrypted,'key_version',s.key_version,
   'history_start',(SELECT p.earliest_history_date FROM public.business_profile p WHERE p.id=1),
   'today',(SELECT (now() AT TIME ZONE p.books_timezone)::date FROM public.business_profile p WHERE p.id=1),
   'retired',retired,'pushes',accounting.invoice_push_plan(s.id));
 ELSIF command->>'action'='fail' THEN
  UPDATE accounting.invoice_sources SET last_error=left(coalesce(nullif(command->>'error',''),'Invoice sync failed'),1000),
   status=CASE WHEN coalesce((command->>'auth_failed')::boolean,false) THEN 'auth_failed' ELSE status END,lease_run_id=NULL,lease_until=NULL WHERE id=s.id;
  RETURN jsonb_build_object('id',s.id,'status','error');
 ELSIF command->>'action'='release' THEN
  UPDATE accounting.invoice_sources SET lease_run_id=NULL,lease_until=NULL WHERE id=s.id;
  RETURN jsonb_build_object('id',s.id,'status','released');
 ELSIF command->>'action'='push' THEN
  IF jsonb_typeof(command->'results') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  n:=0;
  FOR x IN SELECT value FROM jsonb_array_elements(command->'results') LOOP
   SELECT p.* INTO link FROM accounting.invoice_payments p JOIN accounting.invoices i ON i.id=p.invoice_id
   WHERE p.id::text=x->>'link_id' AND i.source_id=s.id AND p.sync_state IN ('pending','removing');
   IF link.id IS NULL THEN CONTINUE; END IF;
   outcome:=x->>'outcome';
   IF outcome='recorded' THEN
    -- Unlinked while the request was in flight: the payment it just recorded has to go again.
    UPDATE accounting.invoice_payments SET external_payment_id=coalesce(nullif(x->>'external_payment_id',''),external_payment_id),attempts=attempts+1,next_attempt_at=NULL,last_error='',
     sync_state=CASE WHEN removed_at IS NULL THEN 'synced' WHEN coalesce(nullif(x->>'external_payment_id',''),external_payment_id) IS NULL THEN 'removed' ELSE 'removing' END
    WHERE id=link.id;
   ELSIF outcome='removed' AND link.removed_at IS NOT NULL THEN
    UPDATE accounting.invoice_payments SET sync_state='removed',attempts=attempts+1,next_attempt_at=NULL,last_error='' WHERE id=link.id;
   ELSIF outcome='retry' THEN
    -- Backs off from five minutes to a day; the eighth failure stops and waits for the owner.
    UPDATE accounting.invoice_payments SET attempts=attempts+1,last_error=left(coalesce(x->>'error',''),1000),
     sync_state=CASE WHEN attempts+1>=8 THEN 'failed' ELSE sync_state END,
     next_attempt_at=CASE WHEN attempts+1>=8 THEN NULL ELSE now()+least(interval '24 hours',interval '5 minutes'*power(2,attempts)) END
    WHERE id=link.id;
   ELSIF outcome='failed' THEN
    UPDATE accounting.invoice_payments SET sync_state='failed',attempts=attempts+1,next_attempt_at=NULL,last_error=left(coalesce(nullif(x->>'error',''),'The source refused the payment.'),1000) WHERE id=link.id;
   ELSE RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
   n:=n+1;
  END LOOP;
  UPDATE accounting.invoice_sources SET lease_until=now()+interval '5 minutes' WHERE id=s.id;
  RETURN jsonb_build_object('id',s.id,'updated',n,'pushes',accounting.invoice_push_plan(s.id));
 ELSIF command->>'action'='complete' THEN
  IF jsonb_typeof(command->'invoices') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(command->'invoices') LOOP
   -- The source's word, checked before it is kept: known statuses and line types, whole cents, and lines that add up to the total
   -- (a negative line is the source's own correction, such as a discount).
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR length(coalesce(x->>'external_id','')) NOT BETWEEN 1 AND 200 OR length(coalesce(x->>'project_ref','')) NOT BETWEEN 1 AND 200
    OR coalesce(x->>'status','') NOT IN ('draft','issued','paid','void') OR coalesce(x->>'total_cents','') !~ '^[0-9]{1,15}$' OR coalesce(x->>'issue_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(x->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(x->'payments') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(x->'lines') l WHERE jsonb_typeof(l) IS DISTINCT FROM 'object' OR coalesce(l->>'type','') NOT IN ('hourly','fixed','recurring','reimbursement','tax')
     OR coalesce(l->>'amount_cents','') !~ '^-?[0-9]{1,15}$' OR ((l->>'service_from') IS NULL)<>((l->>'service_to') IS NULL)
     OR coalesce(l->>'service_from','2000-01-01') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR coalesce(l->>'service_to','2000-01-01') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(x->'payments') pay WHERE jsonb_typeof(pay) IS DISTINCT FROM 'object' OR coalesce(pay->>'amount_cents','') !~ '^[0-9]{1,15}$'
     OR coalesce(pay->>'paid_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
   THEN RAISE EXCEPTION 'ACCT_SOURCE_INVALID: %',left(coalesce(x->>'external_id','?'),80); END IF;
   IF (SELECT coalesce(sum((l->>'amount_cents')::bigint),0) FROM jsonb_array_elements(x->'lines') l)<>(x->>'total_cents')::bigint
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(x->'lines') l WHERE (l->>'service_to')::date<(l->>'service_from')::date) THEN RAISE EXCEPTION 'ACCT_SOURCE_INVALID: %',left(x->>'external_id',80); END IF;
   INSERT INTO accounting.invoices(source_id,external_id,number,project_ref,project_name,customer_name,issue_date,due_date,status,total_cents,lines,payments,source_updated_at,synced_at)
   VALUES(s.id,x->>'external_id',left(coalesce(x->>'number',''),100),x->>'project_ref',left(coalesce(x->>'project_name',''),200),left(coalesce(x->>'customer_name',''),200),
    (x->>'issue_date')::date,(x->>'due_date')::date,x->>'status',(x->>'total_cents')::bigint,x->'lines',x->'payments',(x->>'source_updated_at')::timestamptz,now())
   ON CONFLICT (source_id,external_id) DO UPDATE SET number=excluded.number,project_ref=excluded.project_ref,project_name=excluded.project_name,customer_name=excluded.customer_name,
    issue_date=excluded.issue_date,due_date=excluded.due_date,status=excluded.status,total_cents=excluded.total_cents,lines=excluded.lines,payments=excluded.payments,
    source_updated_at=excluded.source_updated_at,synced_at=excluded.synced_at,removed_at=NULL
   -- Unchanged invoices stay untouched, so a quiet hour never moves the books revision.
   WHERE (accounting.invoices.number,accounting.invoices.project_ref,accounting.invoices.project_name,accounting.invoices.customer_name,accounting.invoices.issue_date,accounting.invoices.due_date,
     accounting.invoices.status,accounting.invoices.total_cents,accounting.invoices.lines,accounting.invoices.payments,accounting.invoices.removed_at)
    IS DISTINCT FROM (excluded.number,excluded.project_ref,excluded.project_name,excluded.customer_name,excluded.issue_date,excluded.due_date,
     excluded.status,excluded.total_cents,excluded.lines,excluded.payments,NULL::timestamptz);
   GET DIAGNOSTICS n=ROW_COUNT; changed:=changed+n;
   seen:=seen||(x->>'external_id');
  END LOOP;
  -- Only a complete listing can say an invoice is gone; it is marked, never deleted, and comes back if it reappears.
  IF coalesce((command->>'complete')::boolean,false) THEN
   UPDATE accounting.invoices SET removed_at=now(),synced_at=now() WHERE source_id=s.id AND removed_at IS NULL AND NOT (external_id=ANY(seen));
   GET DIAGNOSTICS removed=ROW_COUNT;
  END IF;
  IF jsonb_typeof(command->'earned')='array' THEN
   FOR x IN SELECT value FROM jsonb_array_elements(command->'earned') LOOP
    IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR coalesce(x->>'kind','') NOT IN ('time','scheduled') OR length(coalesce(x->>'external_ref','')) NOT BETWEEN 1 AND 200
     OR length(coalesce(x->>'project_ref','')) NOT BETWEEN 1 AND 200 OR coalesce(x->>'amount_cents','') !~ '^[1-9][0-9]{0,15}$'
     OR coalesce(x->>'earned_from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR coalesce(x->>'earned_to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN RAISE EXCEPTION 'ACCT_SOURCE_INVALID: %',left(coalesce(x->>'external_ref','?'),80); END IF;
    IF (x->>'earned_to')::date<(x->>'earned_from')::date THEN RAISE EXCEPTION 'ACCT_SOURCE_INVALID: %',left(x->>'external_ref',80); END IF;
    INSERT INTO accounting.earned_work(source_id,kind,external_ref,project_ref,earned_from,earned_to,amount_cents,synced_at)
    VALUES(s.id,x->>'kind',x->>'external_ref',x->>'project_ref',(x->>'earned_from')::date,(x->>'earned_to')::date,(x->>'amount_cents')::bigint,now())
    ON CONFLICT (source_id,kind,external_ref) DO UPDATE SET project_ref=excluded.project_ref,earned_from=excluded.earned_from,earned_to=excluded.earned_to,amount_cents=excluded.amount_cents,synced_at=excluded.synced_at
    WHERE (accounting.earned_work.project_ref,accounting.earned_work.earned_from,accounting.earned_work.earned_to,accounting.earned_work.amount_cents)
     IS DISTINCT FROM (excluded.project_ref,excluded.earned_from,excluded.earned_to,excluded.amount_cents);
    GET DIAGNOSTICS n=ROW_COUNT; earned:=earned+n;
    earned_keys:=earned_keys||(x->>'kind'||':'||(x->>'external_ref'));
   END LOOP;
   -- Earned work is the source's current list in full: anything it no longer reports goes.
   DELETE FROM accounting.earned_work w WHERE w.source_id=s.id AND NOT ((w.kind||':'||w.external_ref)=ANY(earned_keys));
   GET DIAGNOSTICS n=ROW_COUNT; earned:=earned+n;
  END IF;
  -- One revision step for everything the pull changed; an upsert's untouched rows never count.
  IF changed+removed+earned>0 THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; END IF;
  retired:=accounting.invoice_retire_dead(s.id);
  -- New money links on its own; deposits from before the source was connected wait for the owner's batch review.
  linked:=accounting.invoice_command(jsonb_build_object('type','invoice.auto_link','id',gen_random_uuid(),'from',greatest(
   (SELECT st.accrual_start FROM accounting.settings st WHERE st.id=1),(SELECT (s.created_at AT TIME ZONE p.books_timezone)::date FROM public.business_profile p WHERE p.id=1))));
  UPDATE accounting.invoice_sources SET last_synced_at=now(),last_error='',lease_until=now()+interval '5 minutes' WHERE id=s.id;
  RETURN jsonb_build_object('id',s.id,'changed',changed,'removed',removed,'retired',retired,'linked',coalesce((linked->>'count')::integer,0),'pushes',accounting.invoice_push_plan(s.id));
 END IF;
 RAISE EXCEPTION 'ACCT_INVALID_COMMAND';
END $function$
;

COMMIT;
