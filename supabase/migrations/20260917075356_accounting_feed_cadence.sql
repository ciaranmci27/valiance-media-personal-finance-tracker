-- Feed cadence: the scheduler is Supabase cron calling the sync-feeds edge
-- function every hour at :17. A complete run is due again after 110 minutes so
-- the two-hour cadence lands on the next tick; a failed run waits an hour or
-- the provider's Retry-After, whichever is longer. accounting.feed_worker is
-- the worker heartbeat the Feeds screen reads to say whether a scheduler is
-- really calling. Sync on open (six-hour rule) is unchanged.
BEGIN;

-- Inline NOT NULL: the named form in schema.sql is the Postgres 18 dump
-- syntax, and the finance project runs Postgres 17.
CREATE TABLE IF NOT EXISTS accounting.feed_worker (
  "id" smallint DEFAULT 1 NOT NULL,
  "last_tick_at" timestamp with time zone NOT NULL,
  "last_tick_due" smallint DEFAULT 0 NOT NULL,
  "source" text DEFAULT ''::text NOT NULL,
  CONSTRAINT "feed_worker_id_check" CHECK ((id = 1)),
  CONSTRAINT "feed_worker_pkey" PRIMARY KEY (id)
);

ALTER TABLE accounting.feed_worker ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE accounting.feed_worker FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.feed_worker TO "postgres";

GRANT SELECT ON TABLE accounting.feed_worker TO "postgres";

GRANT UPDATE ON TABLE accounting.feed_worker TO "postgres";

GRANT DELETE ON TABLE accounting.feed_worker TO "postgres";

GRANT TRUNCATE ON TABLE accounting.feed_worker TO "postgres";

GRANT REFERENCES ON TABLE accounting.feed_worker TO "postgres";

GRANT TRIGGER ON TABLE accounting.feed_worker TO "postgres";

GRANT MAINTAIN ON TABLE accounting.feed_worker TO "postgres";

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
  discovered:=jsonb_set(discovered,ARRAY[discover_id::text],jsonb_build_object('id',discover_id,'provider_account_id',provider_key,'raw_provider_account_id',a->>'provider_account_id','provider_connection_id',a->>'provider_connection_id','name',a->>'name','institution',a->>'institution','currency',a->>'currency','balance_cents',a->>'balance_cents','available_cents',a->>'available_cents','balance_at',a->'balance_at','ownership',coalesce(discovered->discover_id::text->>'ownership','unreviewed')));
  SELECT * INTO ba FROM accounting.bank_accounts WHERE connection_id=c.id AND provider_account_id=provider_key AND NOT is_closed;
  IF NOT FOUND THEN CONTINUE; END IF;
  IF a->>'currency'<>'USD' THEN run_complete:=false; CONTINUE; END IF;
  IF NOT seen ? provider_key THEN seen:=seen||jsonb_build_array(provider_key); END IF;
  balance_sign:=coalesce((new_checkpoint->'balance_signs'->>ba.id::text)::smallint,1);
  IF a->>'balance_cents' IS NOT NULL AND a->>'balance_at' IS NOT NULL THEN
   UPDATE accounting.bank_accounts SET observed_balance_cents=(a->>'balance_cents')::bigint*balance_sign,observed_at=to_timestamp((a->>'balance_at')::bigint) WHERE id=ba.id;
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

CREATE OR REPLACE FUNCTION accounting.tax_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type';k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());y integer:=coalesce((c->>'tax_year')::integer,(c->>'year')::integer);actor uuid:=accounting.require_owner();m accounting.tax_mappings;link accounting.tax_links;mapped_concept text:=c->>'concept';body jsonb:=coalesce(c->'body',c->'forecast_inputs');estimate public.tax_estimates;method text;
BEGIN
 mapped_concept:=CASE mapped_concept WHEN 'ordinary_income' THEN 'gross_receipts' WHEN 'ordinary_expense' THEN 'other_deduction' WHEN 'officer_wages' THEN 'officer_compensation' WHEN 'meals' THEN 'meals_50' WHEN 'excluded_book' THEN 'balance_sheet_only' ELSE mapped_concept END;
 IF t IN ('tax.mapping','tax.mapping.save') THEN
  SELECT * INTO m FROM accounting.tax_mappings WHERE tax_year=y AND account_id=(c->>'account_id')::uuid;
  IF coalesce((c->>'expected_version')::integer,-1)<>coalesce(m.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(c->>'account_id')::uuid) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_NOT_FOUND';END IF;
  IF m.id IS NULL THEN INSERT INTO accounting.tax_mappings(id,tax_year,account_id,concept,deductible_bps,separately_stated,notes) VALUES(k,y,(c->>'account_id')::uuid,mapped_concept,coalesce((c->>'deductible_bps')::integer,CASE WHEN mapped_concept='meals_50' THEN 5000 ELSE 10000 END),coalesce((c->>'separately_stated')::boolean,mapped_concept IN ('qualified_dividend','short_gain','long_gain','charity','tax_exempt') OR (mapped_concept='interest' AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(c->>'account_id')::uuid AND type='income'))),coalesce(c->>'notes',c->>'reason','')) RETURNING * INTO m;
  ELSE UPDATE accounting.tax_mappings SET concept=mapped_concept,deductible_bps=coalesce((c->>'deductible_bps')::integer,CASE WHEN mapped_concept='meals_50' THEN 5000 ELSE 10000 END),separately_stated=coalesce((c->>'separately_stated')::boolean,mapped_concept IN ('qualified_dividend','short_gain','long_gain','charity','tax_exempt') OR (mapped_concept='interest' AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=m.account_id AND type='income'))),notes=coalesce(c->>'notes',c->>'reason','') WHERE id=m.id RETURNING * INTO m;END IF;
  RETURN jsonb_build_object('id',m.id,'version',m.version);
 ELSIF t IN ('tax.adjustment','tax.adjustment.save') THEN
  IF coalesce((c->>'expected_version')::integer,0)<>0 OR c->>'active'='false' THEN RAISE EXCEPTION 'ACCT_TAX_OFFSET_REQUIRED';END IF;
  IF c->>'document_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=(c->>'document_id')::uuid AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
  INSERT INTO accounting.tax_adjustments(id,tax_year,concept,effective_date,amount_cents,reason,document_id,created_by) VALUES(k,y,mapped_concept,coalesce((c->>'effective_date')::date,make_date(y,12,31)),(c->>'amount_cents')::bigint,c->>'reason',(c->>'document_id')::uuid,actor);
  RETURN jsonb_build_object('id',k,'version',1);
 ELSIF t='tax.link.save' THEN
  SELECT * INTO link FROM accounting.tax_links WHERE id=k;
  IF coalesce((c->>'expected_version')::integer,-1)<>coalesce(link.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  SELECT * INTO estimate FROM public.tax_estimates WHERE id=coalesce((c->>'tax_estimate_id')::uuid,(c->>'estimate_id')::uuid) AND deleted_at IS NULL;
  IF estimate.id IS NULL THEN RAISE EXCEPTION 'ACCT_TAX_ESTIMATE_NOT_FOUND';END IF;
  IF link.id IS NOT NULL AND link.tax_estimate_id<>estimate.id THEN RAISE EXCEPTION 'ACCT_TAX_LINK_IDENTITY';END IF;
  IF body IS NULL OR jsonb_typeof(body)<>'object' OR extract(year FROM (body->>'through')::date)<>estimate.tax_year THEN RAISE EXCEPTION 'ACCT_TAX_LINK_SCOPE';END IF;
  method:=CASE body->'forecast'->>'method' WHEN 'average' THEN 'average_months' WHEN 'prior_pattern' THEN 'prior_year_pattern' ELSE body->'forecast'->>'method' END;
  IF link.id IS NULL THEN INSERT INTO accounting.tax_links(id,tax_estimate_id,tax_year,cutoff_mode,cutoff_date,forecast_method,forecast_inputs) VALUES(k,estimate.id,estimate.tax_year,body->>'cutoff_mode',(body->>'through')::date,method,body||jsonb_build_object('enabled',coalesce((c->>'enabled')::boolean,true),'reason',coalesce(c->>'reason',''))) RETURNING * INTO link;
  ELSE UPDATE accounting.tax_links SET cutoff_mode=body->>'cutoff_mode',cutoff_date=(body->>'through')::date,forecast_method=method,forecast_inputs=body||jsonb_build_object('enabled',coalesce((c->>'enabled')::boolean,true),'reason',coalesce(c->>'reason','')),status='stale',error=NULL,inputs=inputs-'_refresh' WHERE id=k RETURNING * INTO link;END IF;
  RETURN jsonb_build_object('id',link.id,'version',link.version);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.write_lock();
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='tax_adjustments' AND TG_OP<>'INSERT') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_TAX_ADJUSTMENT';END IF;
 IF TG_TABLE_NAME IN ('tax_adjustments','tax_mappings') THEN
  IF NEW.concept NOT IN ('gross_receipts','cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','interest','other_deduction','nondeductible','distribution','contribution','balance_sheet_only','qualified_dividend','short_gain','long_gain','charity','tax_exempt','ordinary_adjustment','stock_basis_opening','debt_basis_opening') THEN RAISE EXCEPTION 'ACCT_TAX_CONCEPT';END IF;
  IF TG_TABLE_NAME='tax_mappings' AND NEW.concept IN ('ordinary_adjustment','stock_basis_opening','debt_basis_opening') THEN RAISE EXCEPTION 'ACCT_TAX_CONCEPT';END IF;
 END IF;
 IF TG_TABLE_NAME='tax_mappings' THEN
  IF NEW.deductible_bps NOT BETWEEN 0 AND 10000 OR
   (NEW.concept='gross_receipts' AND (NEW.deductible_bps<>10000 OR NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='income'))) OR
   (NEW.concept IN ('cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','other_deduction','charity') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='expense')) OR
   (NEW.concept IN ('qualified_dividend','short_gain','long_gain','tax_exempt') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='income')) OR
   (NEW.concept='interest' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type IN ('income','expense'))) OR
   (NEW.concept IN ('distribution','contribution') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='equity'))
   THEN RAISE EXCEPTION 'ACCT_TAX_MAPPING';END IF;
 END IF;
 IF TG_OP='UPDATE' THEN NEW.version:=CASE WHEN TG_TABLE_NAME='tax_links' AND current_setting('accounting.actor_kind',true)='worker' THEN OLD.version ELSE OLD.version+1 END;NEW.updated_at:=now();END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_lines(year integer, cutoff date)
 RETURNS TABLE(line_id uuid, entry_id uuid, entry_date date, account_id uuid, book_cents numeric, ordinary_cents numeric, concept text, mapping_current boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT l.id,e.id,e.entry_date,a.id,-l.amount_cents::numeric,
 CASE WHEN m.separately_stated THEN 0 WHEN m.concept='gross_receipts' THEN -l.amount_cents::numeric
 WHEN m.concept IN ('cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','interest','other_deduction') THEN -round(l.amount_cents::numeric*m.deductible_bps/10000) ELSE 0 END,
 m.concept,m.id IS NOT NULL
 FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id
 LEFT JOIN accounting.tax_mappings m ON m.account_id=a.id AND m.tax_year=year
 WHERE e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND cutoff AND a.type IN ('income','expense')
$function$
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
  RETURN jsonb_build_object('profiles',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',id,'version',version,'purpose',system_purpose,'cash_kind',CASE WHEN subtype IN ('bank','cash','card') THEN subtype ELSE 'none' END,'parent_account_id',parent_id,'subtype',subtype,'type',type,'external_names',external_names) ORDER BY code,name),'[]') FROM accounting.accounts),
   'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('tax_classification',CASE WHEN contractor_classification='unknown' THEN 'unreviewed' ELSE contractor_classification END,'documentation',documentation_status) ORDER BY name),'[]') FROM accounting.parties p),
   'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked')),'[]') FROM accounting.periods p),
   'preferences',(SELECT to_jsonb(s)-ARRAY['owner_user_id','financial_revision']||jsonb_build_object('history_start',p.earliest_history_date,'legal_name',p.legal_name,'business_profile',to_jsonb(p)) FROM accounting.settings s CROSS JOIN public.business_profile p));
 ELSIF view='feeds' THEN
  RETURN jsonb_build_object('owner_id',actor,
   'connections',(SELECT coalesce(jsonb_agg(to_jsonb(c)-ARRAY['access_url_encrypted','key_version','checkpoint','lease_run_id'] ORDER BY created_at,id),'[]') FROM accounting.bank_connections c),
   'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id))),'[]') FROM accounting.bank_accounts b JOIN accounting.bank_connections c ON c.id=b.connection_id CROSS JOIN public.business_profile p),
   'identities',(SELECT coalesce(jsonb_agg(d.value||jsonb_build_object('connection_id',c.id,'provider_account_id',d.value->>'raw_provider_account_id','version',coalesce(b.version,0),'feed_account_id',b.id,'last_seen_at',c.updated_at,
    'account',CASE WHEN b.id IS NULL THEN NULL ELSE to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id)) END,
    'balance',jsonb_build_object('balance_cents',d.value->'balance_cents','available_cents',d.value->'available_cents','balance_at',d.value->'balance_at','issues','[]'::jsonb,'created_at',c.updated_at)) ORDER BY c.created_at,d.key),'[]') FROM accounting.bank_connections c CROSS JOIN public.business_profile p CROSS JOIN LATERAL jsonb_each(coalesce(c.checkpoint->'discovery','{}')) d LEFT JOIN accounting.bank_accounts b ON b.id=d.key::uuid),
   'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.operation_id,'connection_id',a.row_id,'actor_kind',a.actor_kind,'status',CASE WHEN (a.after->>'errors')::int>0 THEN 'incomplete' ELSE 'saved' END,'started_at',a.at,'finished_at',a.at,'error','') ORDER BY a.at DESC),'[]') FROM (SELECT * FROM accounting.audit_log WHERE table_name='bank_connections' AND action='sync' AND after ? 'accounts' ORDER BY at DESC LIMIT 100) a),
   'queue',(SELECT coalesce(jsonb_agg(jsonb_build_object('feed_account_id',b.id,'ready',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND o.review='unmatched' AND state='posted'),'pending',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND state='pending'))),'[]') FROM accounting.bank_accounts b),
   'worker',(SELECT jsonb_build_object('last_tick_at',w.last_tick_at,'last_tick_due',w.last_tick_due,'source',w.source) FROM accounting.feed_worker w WHERE w.id=1));
 ELSIF view='rules' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('description_mode',coalesce(r.conditions->>'description_mode',(SELECT d.key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) d LIMIT 1)),'description',coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1)),'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction','min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id','reason','') ORDER BY priority,id),'[]') FROM accounting.rules r),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name,'match_mode',a.match_kind,'description',a.pattern) ORDER BY a.pattern),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id));
 ELSIF view='history' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'checks',(SELECT coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('from_date',make_date(fiscal_year,1,1),'to_date',make_date(fiscal_year,12,31),'source_document_id',document_id,'created_at',checked_at,'invalidated',status='mismatch','controls',expected) ORDER BY checked_at DESC),'[]') FROM accounting.history_checks h));
 ELSIF view='close-history' THEN
  RETURN jsonb_build_object('periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked') ORDER BY month DESC),'[]') FROM accounting.periods p),'reconciliations',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id));
 ELSIF view='tax' THEN
  SELECT id INTO key FROM public.tax_estimates WHERE tax_year=(context.params->>'year')::integer AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1;
  RETURN accounting.tax_link(key)||jsonb_build_object('_safe_harbor_context',jsonb_build_object('as_of',(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'financial_revision',(SELECT financial_revision::text FROM accounting.settings),'available_documents',(SELECT coalesce(jsonb_agg(d.id),'[]') FROM accounting.documents d WHERE d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 ELSIF view='evidence' THEN
  key:=(context.params->>'id')::uuid;PERFORM accounting.entry_detail(key);
  RETURN jsonb_build_object('sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'source_system',o.source,'external_id',o.external_id,'observed_at',o.observed_at,'raw_payload',o.raw_payload)) FROM accounting.bank_transactions o WHERE EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE m.bank_transaction_id=o.id AND l.entry_id=key)),'[]')||coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'source_system',b.source,'external_id',r.external_id,'observed_at',r.created_at,'raw_payload',r.raw)) FROM accounting.import_rows r JOIN accounting.import_batches b ON b.id=r.batch_id WHERE r.entry_id=key),'[]'),
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

CREATE OR REPLACE FUNCTION accounting.contractor_report(year integer, cutoff date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE threshold bigint;result jsonb;through_date date:=coalesce(cutoff,make_date(year,12,31));
BEGIN
 PERFORM accounting.require_owner();
 IF extract(year FROM through_date)<>year THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 IF year BETWEEN 2022 AND 2025 THEN threshold:=60000;ELSIF year=2026 THEN threshold:=200000;ELSE RAISE EXCEPTION 'ACCT_CONTRACTOR_YEAR_RULE_REQUIRED';END IF;
 SELECT jsonb_build_object('year',year,'through',through_date,'revision',(SELECT financial_revision::text FROM accounting.settings),'threshold_cents',threshold::text,
  'rows',coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'contractor_classification',contractor_classification,'documentation_status',documentation_status,'paid_cents',paid::text,'card_cents',card::text,'meets_threshold',paid>=threshold) ORDER BY name,id),'[]')) INTO result FROM (
 SELECT p.id,p.name,p.contractor_classification,p.documentation_status,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash')),0) paid,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype='card'),0) card
 FROM accounting.parties p LEFT JOIN accounting.journal_entries e ON e.payee_id=p.id AND e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND through_date
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE p.is_contractor GROUP BY p.id) rows;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.descriptor_key(value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v text := upper(value);
BEGIN
 IF v IS NULL THEN RETURN NULL; END IF;
 v:=regexp_replace(v,'\*[[:space:]]*[0-9].*$','','g');
 v:=regexp_replace(v,'\m[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}\M',' ','g');
 v:=regexp_replace(v,'\m(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUN(E)?|JUL(Y)?|AUG(UST)?|SEP(TEMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)[[:space:]]+[0-9]{1,2}(,?[[:space:]]+[0-9]{4})?\M',' ','g');
 v:=regexp_replace(v,'\m[0-9]{1,2}[[:space:]]+(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUN(E)?|JUL(Y)?|AUG(UST)?|SEP(TEMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)([[:space:]]+[0-9]{4})?\M',' ','g');
 v:=regexp_replace(v,'#[[:space:]]*[0-9]+|[0-9]{4,}',' ','g');
 v:=regexp_replace(v,'\m(POS|DEBIT|CREDIT|PURCHASE|PAYMENT|CARD|ACH|RECURRING)\M',' ','g');
 RETURN btrim(regexp_replace(v,'[[:space:]]+',' ','g'));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.document_access(path text, uploading boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=auth.uid() OR public.has_permission('accounting.manage'))) AND EXISTS(SELECT 1 FROM accounting.documents WHERE storage_path=path AND status<>'archived') AND (NOT uploading OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=path))
$function$
;

COMMIT;

-- Scheduler: Supabase only. Skipped where pg_cron or pg_net is unavailable
-- (local fixtures and PGlite). Before the first tick, store the two Vault
-- secrets the job reads (the third is optional):
--   select vault.create_secret('https://<project-ref>.supabase.co','accounting_project_url');
--   select vault.create_secret('<ACCOUNTING_WORKER_SECRET>','accounting_worker_secret');
--   select vault.create_secret('<publishable key>','accounting_publishable_key');
-- Re-running cron.schedule with the same job name updates the job in place.
DO $do$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_cron') AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_net') THEN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_net';
  PERFORM cron.schedule('accounting-sync-feeds','17 * * * *',$job$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='accounting_project_url')||'/functions/v1/sync-feeds',
    headers:=jsonb_strip_nulls(jsonb_build_object(
      'Content-Type','application/json',
      'x-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='accounting_worker_secret'),
      'apikey',(select decrypted_secret from vault.decrypted_secrets where name='accounting_publishable_key'))),
    body:='{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds:=120000)
$job$);
 ELSE
  RAISE NOTICE 'pg_cron or pg_net is unavailable here; the feed scheduler was not installed.';
 END IF;
END $do$;
