-- SimpleFIN protocol v2. v2 names a connection by the provider's own id (MX-MBR-...)
-- where the v1 adapter derived one (v1:<sha256 of the institution>). Account and
-- transaction ids are identical in both versions, so the first v2 sighting of an
-- account re-keys its v1 identity in place: the feed account, its coverage
-- checkpoint and its discovery entry carry over, and nothing is observed twice.
-- Only sync_server changes.

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
