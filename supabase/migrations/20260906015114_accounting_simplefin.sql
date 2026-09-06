BEGIN;

CREATE TABLE public.acct_feed_connections (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'claiming' CHECK(status IN ('claiming','active','reconnect_required','disconnected')),
 version integer NOT NULL DEFAULT 1, generation integer NOT NULL DEFAULT 1,
 scheduled boolean NOT NULL DEFAULT false, next_sync_at timestamptz, retry_at timestamptz,
 last_success_at timestamptz, last_error text NOT NULL DEFAULT '',
 lease_run_id uuid, lease_until timestamptz, created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_feed_secrets (
 connection_id uuid PRIMARY KEY REFERENCES public.acct_feed_connections(id),
 ciphertext text NOT NULL CHECK(length(ciphertext) BETWEEN 50 AND 20000 AND ciphertext ~ '^v[1-9][0-9]*:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'),
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_feed_claims (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES public.acct_feed_connections(id), generation integer NOT NULL,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','transmitting','completed','failed')),
 error text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(connection_id,generation)
);
CREATE TABLE public.acct_feed_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL UNIQUE REFERENCES public.acct_accounts(id),
 history_start bigint NOT NULL CHECK(history_start BETWEEN 1 AND 4133980800), checkpoint bigint, resume_floor bigint,
 posting_timezone text NOT NULL CHECK(posting_timezone IN ('UTC','America/Phoenix')),
 movement_sign integer NOT NULL CHECK(movement_sign IN (-1,1)), balance_sign integer NOT NULL CHECK(balance_sign IN (-1,1)),
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(checkpoint IS NULL OR checkpoint>=history_start), CHECK(resume_floor IS NULL OR resume_floor BETWEEN history_start AND checkpoint)
);
CREATE TABLE public.acct_feed_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid NOT NULL REFERENCES public.acct_feed_connections(id),
 provider_connection_id text NOT NULL CHECK(length(provider_connection_id) BETWEEN 1 AND 500), provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 500),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 500), institution text NOT NULL CHECK(length(institution)<=500), currency text NOT NULL CHECK(length(currency)<=500),
 observed_generation integer NOT NULL, approved_generation integer,
 ownership text NOT NULL DEFAULT 'unreviewed' CHECK(ownership IN ('unreviewed','company','personal','ignored')),
 feed_account_id uuid REFERENCES public.acct_feed_accounts(id), version integer NOT NULL DEFAULT 1,
 last_seen_at timestamptz NOT NULL DEFAULT now(), last_attempt_at timestamptz,
 UNIQUE(connection_id,provider_connection_id,provider_account_id), CHECK((ownership='company')=(feed_account_id IS NOT NULL))
);
CREATE TABLE public.acct_feed_runs (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES public.acct_feed_connections(id), generation integer NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('owner','worker')), requested_by uuid REFERENCES auth.users(id),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','partial','failed','expired')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error text NOT NULL DEFAULT '',
 CHECK((actor_kind='owner')=(requested_by IS NOT NULL))
);
CREATE TABLE public.acct_feed_requests (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES public.acct_feed_runs(id),
 identity_id uuid REFERENCES public.acct_feed_identities(id), from_stamp bigint NOT NULL, to_stamp bigint NOT NULL,
 discovery boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(to_stamp>from_stamp AND to_stamp-from_stamp<=7776000), UNIQUE(run_id,identity_id)
);
CREATE INDEX acct_feed_request_time ON public.acct_feed_requests(created_at);
CREATE TABLE public.acct_feed_windows (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES public.acct_feed_requests(id), identity_id uuid NOT NULL REFERENCES public.acct_feed_identities(id),
 feed_account_id uuid REFERENCES public.acct_feed_accounts(id), protocol text NOT NULL CHECK(length(protocol)<100),
 response_hash text NOT NULL CHECK(response_hash ~ '^[0-9a-f]{64}$'), account_hash text NOT NULL CHECK(account_hash ~ '^[0-9a-f]{64}$'),
 balance_cents bigint, available_cents bigint, balance_at bigint NOT NULL, issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'),
 complete_response boolean NOT NULL, expected_count integer NOT NULL CHECK(expected_count BETWEEN 0 AND 50000),
 status text NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','accepted','incomplete')),
 received_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,identity_id), CHECK(received_count BETWEEN 0 AND expected_count)
);
CREATE TABLE public.acct_feed_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), window_id uuid NOT NULL REFERENCES public.acct_feed_windows(id), ordinal integer NOT NULL CHECK(ordinal>=0),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 500), state text NOT NULL CHECK(state IN ('posted','pending','nonfinancial')),
 posted bigint NOT NULL CHECK(posted BETWEEN 0 AND 4133980800), transacted_at bigint CHECK(transacted_at BETWEEN 0 AND 4133980800),
 amount_cents bigint NOT NULL CHECK(amount_cents>'-9223372036854775808'::bigint), description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'), raw_payload jsonb NOT NULL CHECK(jsonb_typeof(raw_payload)='object'),
 UNIQUE(window_id,ordinal), UNIQUE(window_id,external_id), CHECK(state<>'posted' OR posted>0 AND amount_cents<>0)
);
CREATE TABLE public.acct_feed_import_links (
 observation_id uuid PRIMARY KEY REFERENCES public.acct_feed_observations(id), group_id uuid NOT NULL REFERENCES public.acct_import_groups(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_feed_gaps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feed_account_id uuid NOT NULL REFERENCES public.acct_feed_accounts(id),
 from_stamp bigint NOT NULL, to_stamp bigint NOT NULL CHECK(to_stamp>from_stamp),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000), created_by uuid REFERENCES auth.users(id),
 document_id uuid REFERENCES public.acct_documents(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(feed_account_id,from_stamp,to_stamp)
);

-- Feed tables deliberately do not increment financial_revision. A network sync
-- cannot change the ledger. Runs retain the authenticated worker/owner identity.
CREATE OR REPLACE FUNCTION public.acct_feed_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.acct_audit_log(table_name,action,actor_id,operation_id,before_value,after_value)
 VALUES(TG_TABLE_NAME,TG_OP,auth.uid(),nullif(current_setting('acct.operation_id',true),''),CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END);
 RETURN coalesce(NEW,OLD);
END $$;
CREATE OR REPLACE FUNCTION public.acct_feed_assert_lease(p_run uuid) RETURNS public.acct_feed_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_feed_runs;c public.acct_feed_connections;
BEGIN
 SELECT * INTO r FROM public.acct_feed_runs WHERE id=p_run;
 SELECT * INTO c FROM public.acct_feed_connections WHERE id=r.connection_id FOR UPDATE;
 IF r.id IS NULL OR r.status<>'running' OR c.status<>'active' OR c.lease_run_id IS DISTINCT FROM r.id OR c.generation<>r.generation OR c.lease_until IS NULL OR c.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'ACCT_FEED_LEASE'; END IF;
 UPDATE public.acct_feed_connections SET lease_until=clock_timestamp()+interval '2 minutes' WHERE id=c.id;
 PERFORM set_config('acct.operation_id',r.id::text,true);
 RETURN r;
END $$;

-- This is the only service-role entry point. It cannot post, alter journals,
-- create a connection, choose account mappings, or enable a schedule.
CREATE OR REPLACE FUNCTION public.acct_feed_server(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type'; c public.acct_feed_connections; r public.acct_feed_runs; a public.acct_feed_identities;
 f public.acct_feed_accounts; q public.acct_feed_requests; w public.acct_feed_windows; claim public.acct_feed_claims;
 actor uuid; v_id uuid; x jsonb; n integer; count_before integer; result jsonb; is_complete boolean;
BEGIN
 IF p_command IS NULL OR octet_length(p_command::text)>4000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM public.acct_write_lock();
 IF op='due' THEN
  RETURN (SELECT coalesce(jsonb_agg(id),'[]') FROM (SELECT id FROM public.acct_feed_connections WHERE status='active' AND scheduled AND coalesce(next_sync_at,'-infinity')<=now() AND coalesce(retry_at,'-infinity')<=now() AND coalesce(lease_until,'-infinity')<=now() ORDER BY next_sync_at NULLS FIRST,id LIMIT 4) s);
 ELSIF op IN ('claim.send','claim.complete','claim.fail') THEN
  SELECT * INTO claim FROM public.acct_feed_claims WHERE id=(p_command->>'id')::uuid;
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=claim.connection_id;
  IF claim.id IS NULL OR c.generation<>claim.generation THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  IF op='claim.complete' AND claim.status='completed' AND c.status='active' AND EXISTS(SELECT 1 FROM public.acct_feed_secrets WHERE connection_id=c.id AND ciphertext=p_command->>'ciphertext') THEN RETURN jsonb_build_object('id',c.id); END IF;
  IF c.status<>'claiming' OR claim.status IS DISTINCT FROM (CASE WHEN op='claim.send' THEN 'started' ELSE 'transmitting' END) THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  PERFORM set_config('acct.operation_id',claim.id::text,true);
  IF op='claim.send' THEN
   UPDATE public.acct_feed_claims SET status='transmitting' WHERE id=claim.id;
  ELSIF op='claim.complete' THEN
   INSERT INTO public.acct_feed_secrets(connection_id,ciphertext) VALUES(c.id,p_command->>'ciphertext') ON CONFLICT(connection_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,changed_at=now();
   UPDATE public.acct_feed_connections SET status='active',last_error='',retry_at=NULL,version=version+1 WHERE id=c.id;
   UPDATE public.acct_feed_claims SET status='completed',completed_at=now() WHERE id=claim.id;
  ELSE
   UPDATE public.acct_feed_connections SET status='reconnect_required',last_error=left(p_command->>'error',1000),version=version+1 WHERE id=c.id;
   UPDATE public.acct_feed_claims SET status='failed',error=left(p_command->>'error',1000),completed_at=now() WHERE id=claim.id;
  END IF;
  RETURN jsonb_build_object('id',c.id);
 ELSIF op='lease' THEN
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=(p_command->>'id')::uuid;
  actor:=nullif(p_command->>'actor_id','')::uuid;
  IF c.id IS NULL OR c.status<>'active' OR actor IS NOT NULL AND actor IS DISTINCT FROM (SELECT owner_user_id FROM public.acct_settings) OR actor IS NULL AND (NOT c.scheduled OR coalesce(c.next_sync_at,'-infinity')>now()) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  IF coalesce(c.retry_at,'-infinity')>now() THEN RAISE EXCEPTION 'ACCT_FEED_BACKOFF'; END IF;
  IF coalesce(c.lease_until,'-infinity')>clock_timestamp() THEN RAISE EXCEPTION 'ACCT_FEED_BUSY'; END IF;
  UPDATE public.acct_feed_runs SET status='expired',finished_at=now(),error='A prior sync stopped before releasing its lease. Its saved observations remain available.' WHERE id=c.lease_run_id AND status='running';
  v_id:=(p_command->>'run_id')::uuid;
  INSERT INTO public.acct_feed_runs(id,connection_id,generation,actor_kind,requested_by) VALUES(v_id,c.id,c.generation,CASE WHEN actor IS NULL THEN 'worker' ELSE 'owner' END,actor);
  PERFORM set_config('acct.operation_id',v_id::text,true);
  UPDATE public.acct_feed_connections SET lease_run_id=v_id,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=c.id;
  RETURN jsonb_build_object('id',v_id,'ciphertext',(SELECT ciphertext FROM public.acct_feed_secrets WHERE connection_id=c.id),'identities',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT i.id,i.provider_connection_id,i.provider_account_id,fa.history_start::text,fa.checkpoint::text,fa.resume_floor::text FROM public.acct_feed_identities i JOIN public.acct_feed_accounts fa ON fa.id=i.feed_account_id WHERE i.connection_id=c.id AND i.ownership='company' AND i.approved_generation=c.generation AND i.observed_generation=c.generation ORDER BY i.last_attempt_at NULLS FIRST,i.id LIMIT 4) s));
 END IF;
 r:=public.acct_feed_assert_lease((p_command->>'run_id')::uuid);
 SELECT * INTO c FROM public.acct_feed_connections WHERE id=r.connection_id;
 IF op='request' THEN
  IF (SELECT count(*) FROM public.acct_feed_requests rq JOIN public.acct_feed_runs sr ON sr.id=rq.run_id WHERE sr.connection_id=c.id AND rq.created_at>now()-interval '24 hours')>=24 THEN RAISE EXCEPTION 'ACCT_FEED_QUOTA'; END IF;
  IF (SELECT count(*) FROM public.acct_feed_requests WHERE run_id=r.id)>=4 THEN RAISE EXCEPTION 'ACCT_FEED_QUOTA'; END IF;
  IF NOT coalesce((p_command->>'discovery')::boolean,false) THEN
   SELECT * INTO a FROM public.acct_feed_identities WHERE id=(p_command->>'identity_id')::uuid AND connection_id=c.id AND ownership='company' AND approved_generation=c.generation AND observed_generation=c.generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
   SELECT * INTO f FROM public.acct_feed_accounts WHERE id=a.feed_account_id;
   IF (p_command->>'from')::bigint IS DISTINCT FROM greatest(f.history_start,coalesce(f.checkpoint,f.history_start)-432000,coalesce(f.resume_floor,f.history_start)) OR (p_command->>'to')::bigint>extract(epoch FROM now())::bigint+1 THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
   UPDATE public.acct_feed_identities SET last_attempt_at=now() WHERE id=a.id;
  ELSIF r.actor_kind<>'owner' THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO public.acct_feed_requests(id,run_id,identity_id,from_stamp,to_stamp,discovery) VALUES((p_command->>'id')::uuid,r.id,a.id,(p_command->>'from')::bigint,(p_command->>'to')::bigint,coalesce((p_command->>'discovery')::boolean,false));
  RETURN jsonb_build_object('id',p_command->>'id');
 ELSIF op='window.begin' THEN
  SELECT * INTO q FROM public.acct_feed_requests WHERE id=(p_command->>'request_id')::uuid AND run_id=r.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  SELECT * INTO a FROM public.acct_feed_identities WHERE connection_id=c.id AND provider_connection_id=p_command->>'provider_connection_id' AND provider_account_id=p_command->>'provider_account_id';
  IF NOT q.discovery AND (a.id IS NULL OR a.id<>q.identity_id OR a.approved_generation<>c.generation OR a.ownership<>'company') THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  IF a.id IS NULL THEN
   INSERT INTO public.acct_feed_identities(connection_id,provider_connection_id,provider_account_id,name,institution,currency,observed_generation) VALUES(c.id,p_command->>'provider_connection_id',p_command->>'provider_account_id',p_command->>'name',p_command->>'institution',p_command->>'currency',c.generation) RETURNING * INTO a;
  ELSE
   UPDATE public.acct_feed_identities SET name=p_command->>'name',institution=p_command->>'institution',currency=p_command->>'currency',observed_generation=c.generation,last_seen_at=now() WHERE id=a.id;
  END IF;
  IF (q.discovery OR p_command->>'currency'<>'USD') AND (p_command->>'expected_count')::integer<>0 THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  INSERT INTO public.acct_feed_windows(id,request_id,identity_id,feed_account_id,protocol,response_hash,account_hash,balance_cents,available_cents,balance_at,issues,complete_response,expected_count)
  VALUES((p_command->>'id')::uuid,q.id,a.id,CASE WHEN NOT q.discovery THEN a.feed_account_id END,p_command->>'protocol',p_command->>'response_hash',p_command->>'account_hash',nullif(p_command->>'balance_cents','')::bigint,nullif(p_command->>'available_cents','')::bigint,(p_command->>'balance_at')::bigint,p_command->'issues',NOT q.discovery AND p_command->>'currency'='USD' AND coalesce((p_command->>'complete')::boolean,false),(p_command->>'expected_count')::integer);
  RETURN jsonb_build_object('id',p_command->>'id');
 ELSIF op IN ('window.append','window.finish') THEN
  SELECT w0.* INTO w FROM public.acct_feed_windows w0 JOIN public.acct_feed_requests q0 ON q0.id=w0.request_id WHERE w0.id=(p_command->>'id')::uuid AND q0.run_id=r.id;
  IF NOT FOUND OR w.status<>'receiving' THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
  SELECT * INTO q FROM public.acct_feed_requests WHERE id=w.request_id;
  IF op='window.append' THEN
   IF jsonb_typeof(p_command->'transactions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'transactions') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
   count_before:=w.received_count;
   IF (p_command->>'offset')::integer IS DISTINCT FROM count_before THEN RAISE EXCEPTION 'ACCT_IMPORT_CHECKPOINT'; END IF;
   FOR x IN SELECT value FROM jsonb_array_elements(p_command->'transactions') LOOP
    IF x->>'state'='posted' AND ((x->>'posted')::bigint<q.from_stamp OR (x->>'posted')::bigint>=q.to_stamp) THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
    INSERT INTO public.acct_feed_observations(window_id,ordinal,external_id,state,posted,transacted_at,amount_cents,description,content_hash,raw_payload)
    VALUES(w.id,count_before,x->>'external_id',x->>'state',(x->>'posted')::bigint,nullif(x->>'transacted_at','')::bigint,(x->>'amount_cents')::bigint,x->>'description',x->>'hash',x->'raw');count_before:=count_before+1;
   END LOOP;
   UPDATE public.acct_feed_windows SET received_count=count_before WHERE id=w.id;
  ELSE
   IF w.received_count<>w.expected_count THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
   IF EXISTS(SELECT 1 FROM public.acct_feed_observations current_o JOIN public.acct_feed_observations old_o ON old_o.external_id=current_o.external_id JOIN public.acct_feed_windows old_w ON old_w.id=old_o.window_id WHERE current_o.window_id=w.id AND old_w.feed_account_id=w.feed_account_id AND old_w.created_at<w.created_at AND old_o.state='posted' AND current_o.state<>'posted') THEN
    w.complete_response:=false;
    UPDATE public.acct_feed_windows SET complete_response=false,issues=issues||jsonb_build_array(jsonb_build_object('code','source_regression','message','A previously posted bank movement is now pending or nonfinancial. Its earlier accounting treatment requires review.')) WHERE id=w.id;
   END IF;
   UPDATE public.acct_feed_windows SET status=CASE WHEN complete_response THEN 'accepted' ELSE 'incomplete' END WHERE id=w.id;
   -- Exact repeat observations inherit the existing reviewed source-group link.
   -- No source/ledger rows are inserted or changed by the worker.
   INSERT INTO public.acct_feed_import_links(observation_id,group_id)
   SELECT current_o.id,matched.group_id FROM public.acct_feed_observations current_o CROSS JOIN LATERAL (
    SELECT fl.group_id FROM public.acct_feed_observations old_o JOIN public.acct_feed_windows old_w ON old_w.id=old_o.window_id JOIN public.acct_feed_import_links fl ON fl.observation_id=old_o.id
    WHERE old_w.feed_account_id=w.feed_account_id AND old_o.external_id=current_o.external_id AND old_o.content_hash=current_o.content_hash AND old_o.posted=current_o.posted AND old_o.amount_cents=current_o.amount_cents AND old_o.state=current_o.state ORDER BY old_w.created_at LIMIT 1
   ) matched WHERE current_o.window_id=w.id ON CONFLICT DO NOTHING;
   IF w.complete_response AND w.feed_account_id IS NOT NULL THEN
    UPDATE public.acct_feed_accounts SET checkpoint=greatest(coalesce(checkpoint,history_start),q.to_stamp) WHERE id=w.feed_account_id;
    IF q.to_stamp<extract(epoch FROM now()-interval '5 days')::bigint AND NOT EXISTS(SELECT 1 FROM public.acct_feed_observations WHERE window_id=w.id AND state='posted') THEN
     INSERT INTO public.acct_feed_gaps(feed_account_id,from_stamp,to_stamp,reason) VALUES(w.feed_account_id,q.from_stamp,q.to_stamp,'The provider returned no posted history for this older window. Confirm coverage with original statements or a historical CSV import.') ON CONFLICT DO NOTHING;
    END IF;
   END IF;
  END IF;
  RETURN jsonb_build_object('id',w.id);
 ELSIF op='finish' THEN
  is_complete:=coalesce((p_command->>'complete')::boolean,false) AND NOT EXISTS(SELECT 1 FROM public.acct_feed_windows w0 JOIN public.acct_feed_requests q0 ON q0.id=w0.request_id WHERE q0.run_id=r.id AND NOT q0.discovery AND w0.status<>'accepted');
  IF EXISTS(SELECT 1 FROM public.acct_feed_requests q0 WHERE q0.run_id=r.id AND NOT q0.discovery AND NOT EXISTS(SELECT 1 FROM public.acct_feed_windows w0 WHERE w0.request_id=q0.id AND w0.identity_id=q0.identity_id AND w0.status='accepted')) THEN is_complete:=false; END IF;
  UPDATE public.acct_feed_runs SET status=CASE WHEN is_complete THEN 'completed' ELSE 'partial' END,finished_at=now(),error=left(coalesce(p_command->>'error',''),1000) WHERE id=r.id;
  UPDATE public.acct_feed_connections SET lease_until=NULL,lease_run_id=NULL,next_sync_at=now()+interval '24 hours'+make_interval(secs=>floor(random()*3600)::integer),last_success_at=CASE WHEN is_complete THEN now() ELSE last_success_at END,last_error=left(coalesce(p_command->>'error',''),1000) WHERE id=c.id;
  RETURN jsonb_build_object('id',r.id,'complete',is_complete);
 ELSIF op='fail' THEN
  UPDATE public.acct_feed_runs SET status='failed',finished_at=now(),error=left(p_command->>'error',1000) WHERE id=r.id;
  UPDATE public.acct_feed_connections SET lease_until=NULL,lease_run_id=NULL,last_error=left(p_command->>'error',1000),retry_at=now()+make_interval(secs=>greatest(60,least(coalesce((p_command->>'retry_seconds')::integer,3600),86400))),status=CASE WHEN p_command->>'code'='access_revoked' THEN 'reconnect_required' ELSE status END WHERE id=c.id;
  RETURN jsonb_build_object('id',r.id);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $$;

CREATE OR REPLACE FUNCTION public.acct_feed_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';c public.acct_feed_connections;a public.acct_feed_identities;f public.acct_feed_accounts;
 v_id uuid:=(p_command->>'id')::uuid;v_feed uuid;v_start bigint;v_checkpoint bigint;v_groups jsonb;v_batch uuid;result jsonb;x record;g record;v_offset integer:=0;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF op='feed.claim' THEN
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=v_id;
  IF FOUND THEN
   IF c.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   UPDATE public.acct_feed_runs SET status='expired',finished_at=now(),error='Connection replaced by its owner.' WHERE id=c.lease_run_id AND status='running';
   UPDATE public.acct_feed_connections SET status='claiming',generation=generation+1,version=version+1,name=p_command->>'name',scheduled=false,lease_run_id=NULL,lease_until=NULL,last_error='' WHERE id=v_id RETURNING * INTO c;
   DELETE FROM public.acct_feed_secrets WHERE connection_id=v_id;
  ELSE
   IF (p_command->>'expected_version')::integer IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   INSERT INTO public.acct_feed_connections(id,name,created_by) VALUES(v_id,p_command->>'name',p_actor) RETURNING * INTO c;
  END IF;
  INSERT INTO public.acct_feed_claims(id,connection_id,generation,created_by) VALUES((p_command->>'claim_id')::uuid,c.id,c.generation,p_actor);
  RETURN jsonb_build_object('id',c.id,'claim_id',p_command->>'claim_id','version',c.version);
 ELSIF op IN ('feed.disconnect','feed.schedule') THEN
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='feed.disconnect' THEN
   IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   UPDATE public.acct_feed_runs SET status='expired',finished_at=now(),error='Disconnected by its owner.' WHERE id=c.lease_run_id AND status='running';
   UPDATE public.acct_feed_connections SET status='disconnected',scheduled=false,generation=generation+1,version=version+1,lease_run_id=NULL,lease_until=NULL WHERE id=v_id;
   DELETE FROM public.acct_feed_secrets WHERE connection_id=v_id;
  ELSE
   IF c.status<>'active' OR coalesce((p_command->>'enabled')::boolean,false) AND NOT EXISTS(SELECT 1 FROM public.acct_feed_identities WHERE connection_id=c.id AND ownership='company' AND approved_generation=c.generation) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
   UPDATE public.acct_feed_connections SET scheduled=(p_command->>'enabled')::boolean,next_sync_at=coalesce(next_sync_at,now()+make_interval(secs=>floor(random()*3600)::integer)),version=version+1 WHERE id=v_id;
  END IF;
  RETURN jsonb_build_object('id',v_id,'version',c.version+1);
 ELSIF op='feed.map' THEN
  SELECT * INTO a FROM public.acct_feed_identities WHERE id=v_id;
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=a.connection_id;
  IF a.id IS NULL OR c.status<>'active' OR a.observed_generation<>c.generation THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  IF a.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF coalesce(c.lease_until,'-infinity')>now() THEN RAISE EXCEPTION 'ACCT_FEED_BUSY'; END IF;
  IF coalesce((p_command->>'reviewed')::boolean,false) IS NOT TRUE OR length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF p_command->>'ownership'='company' THEN
   IF a.currency<>'USD' OR NOT EXISTS(SELECT 1 FROM public.acct_accounts aa JOIN public.acct_account_profiles ap ON ap.account_id=aa.id WHERE aa.id=(p_command->>'account_id')::uuid AND NOT aa.is_archived AND ap.cash_kind IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
   SELECT * INTO f FROM public.acct_feed_accounts WHERE account_id=(p_command->>'account_id')::uuid;
   v_start:=(p_command->>'history_start')::bigint;
   IF v_start>extract(epoch FROM now())::bigint THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
   IF f.id IS NULL THEN
    INSERT INTO public.acct_feed_accounts(account_id,history_start,posting_timezone,movement_sign,balance_sign,created_by) VALUES((p_command->>'account_id')::uuid,v_start,p_command->>'posting_timezone',(p_command->>'movement_sign')::integer,(p_command->>'balance_sign')::integer,p_actor) RETURNING * INTO f;
   ELSE
    IF f.history_start<>v_start OR f.posting_timezone<>p_command->>'posting_timezone' OR f.movement_sign<>(p_command->>'movement_sign')::integer OR f.balance_sign<>(p_command->>'balance_sign')::integer THEN
     IF EXISTS(SELECT 1 FROM public.acct_feed_windows WHERE feed_account_id=f.id) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_IMMUTABLE'; END IF;
     IF f.version IS DISTINCT FROM (p_command->>'expected_feed_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
     UPDATE public.acct_feed_accounts SET history_start=v_start,posting_timezone=p_command->>'posting_timezone',movement_sign=(p_command->>'movement_sign')::integer,balance_sign=(p_command->>'balance_sign')::integer,checkpoint=NULL,resume_floor=NULL,version=version+1 WHERE id=f.id RETURNING * INTO f;
    END IF;
   END IF;
   IF a.feed_account_id IS NOT NULL AND a.feed_account_id<>f.id AND EXISTS(SELECT 1 FROM public.acct_feed_windows WHERE identity_id=a.id AND feed_account_id IS NOT NULL) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_IMMUTABLE'; END IF;
   IF EXISTS(SELECT 1 FROM public.acct_feed_identities i JOIN public.acct_feed_connections ic ON ic.id=i.connection_id WHERE i.id<>a.id AND i.feed_account_id=f.id AND ic.status='active' AND i.approved_generation=ic.generation) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_DUPLICATE'; END IF;
   v_feed:=f.id;
  ELSIF p_command->>'ownership' NOT IN ('personal','ignored') THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  UPDATE public.acct_feed_identities SET feed_account_id=v_feed,ownership=p_command->>'ownership',approved_generation=c.generation,version=version+1 WHERE id=a.id;
  RETURN jsonb_build_object('id',a.id,'version',a.version+1);
 ELSIF op='feed.skip' THEN
  SELECT * INTO f FROM public.acct_feed_accounts WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF f.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_feed_identities i JOIN public.acct_feed_connections c0 ON c0.id=i.connection_id WHERE i.feed_account_id=f.id AND coalesce(c0.lease_until,'-infinity')>now()) THEN RAISE EXCEPTION 'ACCT_FEED_BUSY'; END IF;
  v_checkpoint:=coalesce(f.checkpoint,f.history_start);v_start:=(p_command->>'through')::bigint;
  IF v_start<=v_checkpoint OR v_start>extract(epoch FROM now())::bigint OR length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
  INSERT INTO public.acct_feed_gaps(feed_account_id,from_stamp,to_stamp,reason,created_by) VALUES(f.id,v_checkpoint,v_start,p_command->>'reason',p_actor);
  UPDATE public.acct_feed_accounts SET checkpoint=v_start,resume_floor=v_start,version=version+1 WHERE id=f.id;
  RETURN jsonb_build_object('id',f.id,'version',f.version+1);
 ELSIF op='feed.prepare' THEN
  SELECT * INTO f FROM public.acct_feed_accounts WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  -- Latest observation per canonical provider identity; pending never becomes a
  -- financial draft. Older versions stay available as immutable source evidence.
  SELECT jsonb_agg(jsonb_build_object('observation_id',o.id,'external_id',o.external_id,'source_hash',o.content_hash,'entry_date',(to_timestamp(o.posted) AT TIME ZONE f.posting_timezone)::date,'memo',o.description,'bank_account_id',f.account_id,'bank_amount_cents',(o.amount_cents*f.movement_sign)::text,'identity_kind','provider_id','lines','[]'::jsonb,'raw',o.raw_payload,'fingerprint',encode(sha256(convert_to(jsonb_build_array(f.account_id,(to_timestamp(o.posted) AT TIME ZONE f.posting_timezone)::date,(o.amount_cents*f.movement_sign)::text)::text,'UTF8')),'hex'))) INTO v_groups
  FROM (SELECT latest.* FROM (SELECT DISTINCT ON (o0.external_id) o0.* FROM public.acct_feed_observations o0 JOIN public.acct_feed_windows w0 ON w0.id=o0.window_id WHERE w0.feed_account_id=f.id AND w0.status IN ('accepted','incomplete') ORDER BY o0.external_id,w0.created_at DESC,w0.id DESC) latest WHERE latest.state='posted' AND NOT EXISTS(SELECT 1 FROM public.acct_feed_import_links fl WHERE fl.observation_id=latest.id) ORDER BY latest.posted,latest.external_id LIMIT 50) o;
  IF v_groups IS NULL THEN RETURN jsonb_build_object('count',0); END IF;
  v_batch:=gen_random_uuid();
  result:=public.acct_import_command(jsonb_build_object('type','import.create','id',v_batch,'source_system','simplefin','source_scope',f.id::text,'file_hash',encode(sha256(convert_to(v_groups::text,'UTF8')),'hex'),'mapping_hash',encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex'),'file_name','SimpleFIN: '||(SELECT name FROM public.acct_accounts WHERE id=f.account_id),'mode','bank','basis','cash','expected_groups',jsonb_array_length(v_groups),'from',(SELECT min(value->>'entry_date') FROM jsonb_array_elements(v_groups)),'to',(SELECT max(value->>'entry_date') FROM jsonb_array_elements(v_groups))),p_actor);
  v_batch:=(result->>'id')::uuid;
  SELECT jsonb_agg(value||jsonb_build_object('id',gen_random_uuid(),'ordinal',ordinality-1) ORDER BY ordinality) INTO v_groups FROM jsonb_array_elements(v_groups) WITH ORDINALITY;
  result:=public.acct_import_command(jsonb_build_object('type','import.stage','id',v_batch,'expected_version',result->'version','groups',v_groups),p_actor);
  INSERT INTO public.acct_feed_import_links(observation_id,group_id) SELECT (value->>'observation_id')::uuid,(value->>'id')::uuid FROM jsonb_array_elements(v_groups);
  RETURN result||jsonb_build_object('count',jsonb_array_length(v_groups));
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $$;

CREATE OR REPLACE FUNCTION public.acct_feed_gap_covered(p_gap uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(daterange((to_timestamp(g.from_stamp) AT TIME ZONE f.posting_timezone)::date,(to_timestamp(g.to_stamp-1) AT TIME ZONE f.posting_timezone)::date,'[]') <@ (
 SELECT range_agg(daterange(s.from_date,s.to_date,'[]')) FROM (
  SELECT r.from_date,r.to_date FROM public.acct_reconciliations r WHERE r.account_id=f.account_id AND r.status='completed'
  UNION ALL SELECT h.from_date,h.to_date FROM public.acct_history_checks h WHERE public.acct_history_check_current(h.id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.account_controls) ac WHERE ac->>'account_id'=f.account_id::text)
 ) s),false) FROM public.acct_feed_gaps g JOIN public.acct_feed_accounts f ON f.id=g.feed_account_id WHERE g.id=p_gap;
$$;
REVOKE ALL ON FUNCTION public.acct_feed_gap_covered(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.acct_feed_view() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('owner_id',auth.uid(),'connections',(SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('requests_today',(SELECT count(*) FROM public.acct_feed_requests q JOIN public.acct_feed_runs r ON r.id=q.run_id WHERE r.connection_id=c.id AND q.created_at>now()-interval '24 hours')) ORDER BY c.created_at),'[]') FROM public.acct_feed_connections c),
 'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(fa)||jsonb_build_object('history_start',fa.history_start::text,'checkpoint',fa.checkpoint::text,'can_edit_settings',NOT EXISTS(SELECT 1 FROM public.acct_feed_windows fw WHERE fw.feed_account_id=fa.id))),'[]') FROM public.acct_feed_accounts fa),
 'identities',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('account',CASE WHEN f.id IS NOT NULL THEN to_jsonb(f)||jsonb_build_object('history_start',f.history_start::text,'checkpoint',f.checkpoint::text,'can_edit_settings',NOT EXISTS(SELECT 1 FROM public.acct_feed_windows fw WHERE fw.feed_account_id=f.id)) END,'balance',(SELECT to_jsonb(w)||jsonb_build_object('balance_cents',w.balance_cents::text,'available_cents',w.available_cents::text) FROM public.acct_feed_windows w WHERE w.identity_id=a.id ORDER BY w.created_at DESC,w.id DESC LIMIT 1)) ORDER BY a.institution,a.name),'[]') FROM public.acct_feed_identities a LEFT JOIN public.acct_feed_accounts f ON f.id=a.feed_account_id),
 'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.started_at DESC),'[]') FROM (SELECT * FROM public.acct_feed_runs ORDER BY started_at DESC LIMIT 40) r),
 'gaps',(SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('from_stamp',g.from_stamp::text,'to_stamp',g.to_stamp::text,'covered',public.acct_feed_gap_covered(g.id)) ORDER BY g.created_at DESC),'[]') FROM public.acct_feed_gaps g),
 'queue',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT latest.feed_account_id,count(*) FILTER(WHERE latest.state='posted' AND fl.observation_id IS NULL) ready,count(*) FILTER(WHERE latest.state='pending') pending FROM (SELECT DISTINCT ON (w.feed_account_id,o.external_id) w.feed_account_id,o.id,o.state FROM public.acct_feed_observations o JOIN public.acct_feed_windows w ON w.id=o.window_id WHERE w.feed_account_id IS NOT NULL AND w.status IN ('accepted','incomplete') ORDER BY w.feed_account_id,o.external_id,w.created_at DESC,w.id DESC) latest LEFT JOIN public.acct_feed_import_links fl ON fl.observation_id=latest.id GROUP BY latest.feed_account_id) s));
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['acct_feed_connections','acct_feed_secrets','acct_feed_claims','acct_feed_accounts','acct_feed_identities','acct_feed_runs','acct_feed_requests','acct_feed_windows','acct_feed_observations','acct_feed_import_links','acct_feed_gaps'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  IF t NOT IN ('acct_feed_secrets','acct_feed_observations') THEN EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_feed_audit()',t); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['acct_feed_requests','acct_feed_observations','acct_feed_import_links','acct_feed_gaps'] LOOP
  EXECUTE format('CREATE TRIGGER acct_feed_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.acct_feed_audit(),public.acct_feed_assert_lease(uuid),public.acct_feed_server(jsonb),public.acct_feed_command(jsonb,uuid),public.acct_feed_view() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_feed_server(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.acct_feed_view() TO authenticated;

CREATE OR REPLACE FUNCTION public.acct_operate(p_key uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=public.acct_require_owner();receipt public.acct_command_receipts;result jsonb;original public.acct_journal_entries;reversal jsonb;replacement jsonb;
BEGIN
  IF p_key IS NULL OR p_command IS NULL OR octet_length(p_command::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();actor:=public.acct_require_owner();
  SELECT * INTO receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF p_command->>'type'='import.cancel' AND EXISTS(SELECT 1 FROM public.acct_import_batches WHERE id=(p_command->>'id')::uuid AND (status='completed' OR coverage_verified)) THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  IF p_command->>'type'='entry.correct' THEN
    SELECT * INTO original FROM public.acct_journal_entries WHERE id=(p_command->>'id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    PERFORM public.acct_validate_template(p_command->'lines');
    reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',original.id,'expected_version',p_command->'expected_version','entry_date',coalesce(p_command->>'reversal_date',original.entry_date::text),'reason',p_command->'reason'));
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',p_command->'replacement_id','expected_version',0,'entry_date',p_command->'entry_date','memo',p_command->'memo','lines',p_command->'lines'));
    INSERT INTO public.acct_entry_context SELECT (replacement->>'id')::uuid,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason FROM public.acct_entry_context WHERE entry_id=original.id;
    IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=(replacement->>'id')::uuid AND p.purpose='opening_retained_earnings') THEN
     PERFORM public.acct_retained_review((replacement->>'id')::uuid,'correction',(p_command->'retained_review'->>'document_id')::uuid,p_command->'retained_review'->'controls',p_command->>'reason',actor,original.id);
    END IF;
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by) VALUES(original.id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',original.id);
  ELSIF p_command->>'type' LIKE 'feed.%' THEN result:=public.acct_feed_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'rule.%' OR p_command->>'type'='alias.save' THEN result:=public.acct_rules_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'statement.%' THEN result:=public.acct_statement_command(p_command,actor);
  ELSIF p_command->>'type'='retained.post' THEN result:=public.acct_retained_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'bank.%' THEN result:=public.acct_bank_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'transfer.%' THEN result:=public.acct_transfer_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'history.%' OR p_command->>'type'='import.resume' THEN result:=public.acct_history_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'reconciliation.%' THEN result:=public.acct_close_command(p_command,actor);
  ELSIF p_command->>'type'='account.lifecycle' THEN result:=public.acct_lifecycle_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'clearing.%' THEN result:=public.acct_clearing_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'period.%' OR p_command->>'type' LIKE 'year.%' THEN result:=public.acct_period_command(p_command,actor);
  ELSE RETURN public.acct_execute(p_key,p_command); END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF p_command->>'type' NOT LIKE 'feed.%' OR p_command->>'type'='feed.prepare' THEN UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton; END IF;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,actor,p_command,result);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_books_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;section text;rows jsonb;
BEGIN
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',9,'credential_recovery','SimpleFIN access credentials are excluded. Restore the separate recovery keys and reconnect before enabling any bank worker.');
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations','bank_match_releases','retained_reviews','statement_files','statement_item_sources','statement_amendments','rules','rule_versions','payee_aliases','rule_applications','feed_connections','feed_claims','feed_accounts','feed_identities','feed_runs','feed_requests','feed_windows','feed_observations','feed_import_links','feed_gaps'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_feed_unreviewed(p_through date) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT count(*)::integer FROM (
  SELECT DISTINCT ON (w.feed_account_id,o.external_id) o.id,o.state,o.posted,f.posting_timezone
  FROM public.acct_feed_observations o JOIN public.acct_feed_windows w ON w.id=o.window_id JOIN public.acct_feed_accounts f ON f.id=w.feed_account_id
  WHERE w.status IN ('accepted','incomplete') ORDER BY w.feed_account_id,o.external_id,w.created_at DESC,w.id DESC
 ) latest WHERE latest.state='posted' AND (to_timestamp(latest.posted) AT TIME ZONE latest.posting_timezone)::date<=p_through AND NOT EXISTS(SELECT 1 FROM public.acct_feed_import_links fl WHERE fl.observation_id=latest.id);
$$;
REVOKE ALL ON FUNCTION public.acct_feed_unreviewed(date) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.acct_feed_window_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'receiving' THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','received_count','complete_response','issues']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','received_count','complete_response','issues']) OR NEW.received_count<OLD.received_count OR NOT OLD.complete_response AND NEW.complete_response THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.acct_feed_window_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_feed_window_immutable BEFORE UPDATE OR DELETE ON public.acct_feed_windows FOR EACH ROW EXECUTE FUNCTION public.acct_feed_window_guard();

CREATE OR REPLACE FUNCTION public.acct_close_checklist(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE ending date:=(p_month+INTERVAL '1 month -1 day')::date;report jsonb;drafts integer;imports integer;feed_pending integer;missing integer;uncategorized integer;suspense integer;clearing integer;required_accounts jsonb;obligations jsonb;
BEGIN
  PERFORM public.acct_require_owner();IF extract(day FROM p_month)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  report:=public.acct_workspace(p_month,ending);
  SELECT count(*) INTO drafts FROM public.acct_journal_entries WHERE status='draft' AND entry_date<=ending;
  SELECT count(*) INTO imports FROM public.acct_import_batches b WHERE b.from_date<=ending AND (CASE WHEN b.mode='journal' THEN b.status<>'completed' OR NOT b.coverage_verified ELSE b.status NOT IN ('review','applying','completed') OR (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=b.id)<>b.expected_groups OR EXISTS(SELECT 1 FROM public.acct_import_groups ig LEFT JOIN public.acct_journal_entries ie ON ie.id=ig.entry_id WHERE ig.batch_id=b.id AND ig.entry_date<=ending AND (ig.status NOT IN ('applied','duplicate') OR ie.id IS NULL OR ie.status<>'posted')) END) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'));
  feed_pending:=public.acct_feed_unreviewed(ending);
  SELECT count(*) INTO uncategorized FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE e.status='posted' AND e.entry_date<=ending AND e.reverses_entry_id IS NULL AND p.purpose IN ('uncategorized_income','uncategorized_expense') AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id AND r.entry_date<=ending);
  SELECT count(*) INTO suspense FROM (SELECT l.account_id FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE e.status='posted' AND e.entry_date<=ending AND p.purpose='opening_balance_equity' GROUP BY l.account_id HAVING sum(l.amount_cents)<>0) x;
  WITH required AS (
    SELECT a.id,a.name,(SELECT r.id FROM public.acct_reconciliations r WHERE r.account_id=a.id AND r.status='completed' AND r.from_date<=ending AND r.to_date>=ending ORDER BY r.to_date LIMIT 1) AS reconciliation_id
    FROM public.acct_accounts a JOIN public.acct_account_profiles p ON p.account_id=a.id LEFT JOIN public.acct_account_lifecycle life ON life.account_id=a.id
    WHERE p.cash_kind IN ('bank','card','cash') AND (life.closed_on IS NULL OR life.closed_on>=p_month) AND (EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a.id AND e.status='posted' AND e.entry_date<=ending) OR EXISTS(SELECT 1 FROM public.acct_feed_accounts fa WHERE fa.account_id=a.id AND (to_timestamp(fa.history_start) AT TIME ZONE fa.posting_timezone)::date<=ending))
  ) SELECT count(*) FILTER(WHERE reconciliation_id IS NULL),coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') INTO missing,required_accounts FROM required x;
  obligations:=public.acct_clearing_view(ending)->'rows';
  SELECT count(*) INTO clearing FROM jsonb_array_elements(obligations) x WHERE NOT (
    -- A recorded later settlement can explain a genuine timing item.
    public.acct_clearing_residual((x->>'line_id')::uuid,'2100-12-31')=0
    OR EXISTS(SELECT 1 FROM public.acct_obligation_reviews r JOIN public.acct_document_states d ON d.document_id=r.document_id WHERE r.line_id=(x->>'line_id')::uuid AND r.as_of=ending AND r.residual_cents=(x->>'residual_cents')::numeric AND r.expected_resolution>ending AND d.state='available')
  );
  RETURN jsonb_build_object('month_start',p_month,'through',ending,'revision',report->'revision','drafts',drafts,'unverified_imports',imports,'unreviewed_feed_movements',feed_pending,'unreconciled_accounts',missing,'uncategorized_lines',uncategorized,'opening_suspense_accounts',suspense,'unexplained_clearing_lines',clearing,'accounts',required_accounts,'obligations',obligations,'reports',report,
    'month_ended',ending<=current_date,
    'ready',ending<=current_date AND drafts=0 AND imports=0 AND feed_pending=0 AND missing=0 AND uncategorized=0 AND suspense=0 AND clearing=0 AND report->'reports'->>'trial_balance_cents'='0' AND report->'reports'->>'balance_difference_cents'='0');
END $$;

COMMIT;
