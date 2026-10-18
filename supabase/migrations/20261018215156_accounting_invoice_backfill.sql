-- Backfill review for invoice links. The hourly sync now auto-links exact matches only for
-- deposits dated from the day the source was connected; earlier deposits (back to the accrual
-- start) wait for the owner, who sees them through accounting.receivables with matches=true and
-- confirms the exact ones in one batch (invoice.auto_link from the accrual start) or links the
-- rest one by one.
BEGIN;

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
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(x->'lines') l WHERE jsonb_typeof(l) IS DISTINCT FROM 'object' OR coalesce(l->>'type','') NOT IN ('hourly','fixed','recurring','reimbursement')
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

CREATE OR REPLACE FUNCTION accounting.receivables(view jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_at integer; page_size integer; wanted text; result jsonb;
BEGIN
 PERFORM accounting.require_reader();
 IF jsonb_typeof(view) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 start_at:=coalesce((view->>'offset')::integer,0); page_size:=coalesce((view->>'limit')::integer,100); wanted:=coalesce(view->>'status','open');
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 200 OR wanted NOT IN ('open','all') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 -- Every connection (never its key), the projects to map to clients, and invoices with what the books have linked to each.
 WITH linked AS (SELECT p.invoice_id,sum(p.amount_cents)::bigint cents FROM accounting.live_invoice_payments() p GROUP BY p.invoice_id),
 scoped AS (
  SELECT i.*,s.party_map->>i.project_ref party_text,coalesce(l.cents,0) linked_cents,
   (SELECT coalesce(sum((pay->>'amount_cents')::bigint),0) FROM jsonb_array_elements(i.payments) pay) source_paid_cents
  FROM accounting.invoices i JOIN accounting.invoice_sources s ON s.id=i.source_id LEFT JOIN linked l ON l.invoice_id=i.id
  WHERE (view->>'source_id' IS NULL OR i.source_id=(view->>'source_id')::uuid)
   AND (view->>'party_id' IS NULL OR s.party_map->>i.project_ref=lower(view->>'party_id'))
   AND (wanted='all' OR (i.removed_at IS NULL AND i.status IN ('issued','paid') AND i.total_cents>coalesce(l.cents,0)))),
 paged AS (SELECT * FROM scoped ORDER BY issue_date DESC,number DESC,id LIMIT page_size OFFSET start_at)
 SELECT jsonb_build_object(
  'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1),
  'accrual_start',(SELECT accrual_start FROM accounting.settings WHERE id=1),
  'accounts',(SELECT coalesce(jsonb_object_agg(a.system_purpose,a.id),'{}') FROM accounting.accounts a WHERE a.system_purpose IN ('accounts_receivable','unbilled_revenue','deferred_revenue')),
  'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s)-ARRAY['api_key_encrypted','key_version','lease_run_id','lease_until']||jsonb_build_object(
    'invoice_count',(SELECT count(*) FROM accounting.invoices i WHERE i.source_id=s.id AND i.removed_at IS NULL),
    'pending_pushes',(SELECT count(*) FROM accounting.invoice_payments p JOIN accounting.invoices i ON i.id=p.invoice_id WHERE i.source_id=s.id AND p.sync_state IN ('pending','removing')),
    'failed_pushes',(SELECT count(*) FROM accounting.invoice_payments p JOIN accounting.invoices i ON i.id=p.invoice_id WHERE i.source_id=s.id AND p.sync_state='failed'),
    'projects',(SELECT coalesce(jsonb_agg(jsonb_build_object('project_ref',pr.project_ref,'project_name',pr.project_name,'customer_name',pr.customer_name,'party_id',s.party_map->>pr.project_ref) ORDER BY pr.project_name,pr.project_ref),'[]')
     FROM (SELECT i.project_ref,max(i.project_name) project_name,max(i.customer_name) customer_name FROM accounting.invoices i WHERE i.source_id=s.id GROUP BY i.project_ref) pr)) ORDER BY s.created_at,s.id),'[]') FROM accounting.invoice_sources s),
  'total',(SELECT count(*) FROM scoped),
  -- On request: deposits since the accrual start that were never linked and look like invoice payments, for the owner's review.
  'matches',CASE WHEN view->>'matches'='true' THEN (SELECT coalesce(jsonb_agg(m.row ORDER BY m.entry_date DESC,m.id),'[]') FROM (
   SELECT e.id,e.entry_date,jsonb_build_object('entry_id',e.id,'version',e.version,'entry_date',e.entry_date,'memo',e.memo,'payee_name',(SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),
    'amount_cents',(SELECT sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash'))::text,
    'suggestion',accounting.invoice_candidates(e.id)) row
   FROM accounting.journal_entries e
   WHERE e.entry_date>=(SELECT st.accrual_start FROM accounting.settings st WHERE st.id=1) AND e.status<>'discarded'
    AND NOT EXISTS(SELECT 1 FROM accounting.invoice_payments ip WHERE ip.entry_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM accounting.periods pr WHERE pr.status='locked' AND pr.month>=date_trunc('month',e.entry_date)::date)
    AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash') AND l.amount_cents>0)
    AND accounting.invoice_candidates(e.id) IS NOT NULL
   ORDER BY e.entry_date DESC,e.id LIMIT 200) m) END,
  'invoices',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.version,'source_id',r.source_id,'external_id',r.external_id,'number',r.number,
    'project_ref',r.project_ref,'project_name',r.project_name,'customer_name',r.customer_name,'party_id',r.party_text,'party_name',(SELECT p.name FROM accounting.parties p WHERE p.id::text=r.party_text),
    'issue_date',r.issue_date,'due_date',r.due_date,'status',r.status,'removed_at',r.removed_at,'lines',r.lines,
    'total_cents',r.total_cents::text,'linked_cents',r.linked_cents::text,'outstanding_cents',greatest(r.total_cents-r.linked_cents,0)::text,'source_paid_cents',r.source_paid_cents::text,
    'links',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'entry_id',p.entry_id,'entry_date',e.entry_date,'amount_cents',p.amount_cents::text,'matched_by',p.matched_by,
      'sync_state',p.sync_state,'last_error',p.last_error,'live',accounting.invoice_payment_live(p.id)) ORDER BY e.entry_date,p.id),'[]')
     FROM accounting.invoice_payments p JOIN accounting.journal_entries e ON e.id=p.entry_id WHERE p.invoice_id=r.id AND p.removed_at IS NULL)) ORDER BY r.issue_date DESC,r.number DESC,r.id),'[]') FROM paged r)) INTO result;
 RETURN result;
END $function$
;

COMMIT;
