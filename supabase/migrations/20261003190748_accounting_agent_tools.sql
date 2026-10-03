-- Finance tools for agents: sharper reads, a reconciliation, an attention list,
-- and one guarded write for a bank movement the feed missed.
--
-- The finance agent answers the owner's questions through the API. Several
-- common questions took many calls or could not be answered at all: "how much
-- in total", "the five biggest", "does the bank match the books", "since when",
-- "is anything wrong". This migration gives the books what those answers need.
--
-- New table: accounting.balance_observations keeps every balance a bank feed
-- reports (bank account, when the bank reported it, the balance in ledger
-- convention as bank_accounts.observed_balance_cents holds it, and when it was
-- recorded), one row per account and report time. bank_accounts keeps only the
-- latest balance, so "since when has it been off" had no history to read. The
-- table is private to the books (postgres only, row level security on);
-- readers reach it through the books' own functions. Each account's current
-- observed balance is copied in once, so the history starts now.
--
-- sync_server (restated) writes an observation whenever it stores an observed
-- balance; a repeat of the same report time updates the row only if the
-- amount changed.
--
-- New reader functions (accounting.read is enough):
-- - reconciliation_status(params): per bank, card and cash account, the book
--   balance (working and posted), the bank's balance, the gap between them on
--   the day the bank reported, since when the gap has been there without a
--   break (balance_off_since), pending and unmatched bank lines, the feed's
--   status and whether it is stale (no successful sync for a day). Amounts are
--   on each account's normal side: cash held positive, card debt positive.
-- - attention(params): the items that need the owner, each with a stable id
--   (a hash of its kind and subject), alert or info, and an overall alert
--   flag. Alerts: a gap lasting over a day, a feed down or silent for a day,
--   one transaction over $1,000 waiting for review for two days, a likely
--   duplicate (same account, amount and bank description within three days,
--   both reviewed, last 60 days), drafts that do not balance, and bank lines
--   left out of a closed month. Info: the review backlog, contacts waiting for
--   approval, and what still sits in Uncategorized.
-- - balance_off_since(bank_account) and usd_text(cents) are private helpers.
--
-- Restated readers: transactions gains kind and transfers filters and totals
-- over every match (count, money in, money out, net), not just the page;
-- payees_list gains each contact's first and last date and money in and out.
-- public.api_accounting lets keys read reconciliation and attention.
--
-- public.api_books_command (restated) gains missed.create: a draft for a bank,
-- card or cash movement the feed missed. It is the only API command that may
-- write a line on a money account, and it is accepted only while the
-- reconciliation shows a gap on that account right now, only in the direction
-- that shrinks the gap, never by more than the gap, never dated after the
-- bank's balance, in the future, before the books start or in a closed month,
-- and never when the same amount already sits on that account (books or bank
-- records) within ten days. It stays a draft, tagged with the agent's name, and
-- the after-command audit check allows exactly that one new draft and its two
-- lines. Every other API draft command still refuses money account lines.

BEGIN;

-- 1. Every balance the bank reports. Inline NOT NULL: the named form in schema.sql is the Postgres 18
-- dump syntax, and the finance project runs Postgres 17.
CREATE TABLE IF NOT EXISTS accounting.balance_observations (
  "bank_account_id" uuid NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "balance_cents" bigint NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "balance_observations_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES accounting.bank_accounts(id) ON DELETE CASCADE,
  CONSTRAINT "balance_observations_pkey" PRIMARY KEY (bank_account_id, observed_at)
);

ALTER TABLE accounting.balance_observations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE accounting.balance_observations FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.balance_observations TO "postgres";

GRANT SELECT ON TABLE accounting.balance_observations TO "postgres";

GRANT UPDATE ON TABLE accounting.balance_observations TO "postgres";

GRANT DELETE ON TABLE accounting.balance_observations TO "postgres";

GRANT TRUNCATE ON TABLE accounting.balance_observations TO "postgres";

GRANT REFERENCES ON TABLE accounting.balance_observations TO "postgres";

GRANT TRIGGER ON TABLE accounting.balance_observations TO "postgres";

GRANT MAINTAIN ON TABLE accounting.balance_observations TO "postgres";

-- One observation per account from what the feeds last reported, so the history starts today.
INSERT INTO accounting.balance_observations(bank_account_id,observed_at,balance_cents)
 SELECT id,observed_at,observed_balance_cents FROM accounting.bank_accounts WHERE observed_balance_cents IS NOT NULL AND observed_at IS NOT NULL
 ON CONFLICT (bank_account_id,observed_at) DO NOTHING;

-- 2. sync_server keeps each observation (restated in full).
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

-- 3. Since when the books and the bank disagree, and the reconciliation read.
CREATE OR REPLACE FUNCTION accounting.usd_text(cents numeric)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- Cents as the owner reads them, for the words the attention items carry: -123456 is -$1,234.56.
 SELECT CASE WHEN cents<0 THEN '-' ELSE '' END||'$'||to_char(abs(cents)/100.0,'FM999,999,999,990.00');
$function$
;

REVOKE ALL ON FUNCTION accounting.usd_text(numeric) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.usd_text(numeric) TO "postgres";

CREATE OR REPLACE FUNCTION accounting.balance_off_since(bank_account uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE ledger uuid; zone text; result timestamptz;
BEGIN
 -- Since when the books and the bank have disagreed without a break. Each balance the bank reported is compared
 -- with the working book balance (posted and balanced drafts) at the end of that day in the books time zone; the
 -- answer is the first observation after the last one that matched, or null when the latest one matches.
 SELECT b.account_id INTO ledger FROM accounting.bank_accounts b WHERE b.id=bank_account;
 IF ledger IS NULL THEN RETURN NULL; END IF;
 zone:=coalesce((SELECT books_timezone FROM public.business_profile WHERE id=1),'America/Phoenix');
 WITH events AS (
  SELECT e.entry_date AS day,0 AS ord,NULL::timestamptz AS observed_at,l.amount_cents::numeric AS moved,NULL::numeric AS bank
  FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
  WHERE l.account_id=ledger AND (e.status='posted' OR (e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
  UNION ALL
  SELECT (o.observed_at AT TIME ZONE zone)::date,1,o.observed_at,0,o.balance_cents::numeric FROM accounting.balance_observations o WHERE o.bank_account_id=bank_account
 ), running AS (
  -- A day's lines come before that day's observations, so each observation meets the balance at the end of its day.
  SELECT observed_at,bank,sum(moved) OVER (ORDER BY day,ord,observed_at ROWS UNBOUNDED PRECEDING) AS book FROM events
 ), gaps AS (SELECT observed_at,book<>bank AS off FROM running WHERE observed_at IS NOT NULL)
 SELECT CASE WHEN (SELECT g.off FROM gaps g ORDER BY g.observed_at DESC LIMIT 1)
  THEN (SELECT min(g.observed_at) FROM gaps g WHERE g.observed_at>coalesce((SELECT max(z.observed_at) FROM gaps z WHERE NOT z.off),'-infinity'::timestamptz)) END INTO result;
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION accounting.balance_off_since(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.balance_off_since(uuid) TO "postgres";

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
   (b.observed_at AT TIME ZONE zone)::date AS observed_day,b.connection_id,CASE WHEN a.subtype='card' THEN -1 ELSE 1 END AS sign
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
   'account',jsonb_build_object('id',r.id,'name',r.name,'code',nullif(r.code,''),'kind',r.subtype,'institution',nullif(r.institution,''),'mask',nullif(r.mask,'')),
   'book_cents',(r.book*r.sign)::text,'book_posted_cents',(r.book_posted*r.sign)::text,
   'bank_cents',(r.observed*r.sign)::text,'bank_observed_at',r.observed_at,
   'gap_cents',((r.book_observed-r.observed)*r.sign)::text,
   'off_since',CASE WHEN r.observed IS NOT NULL AND r.book_observed<>r.observed THEN coalesce(accounting.balance_off_since(r.bank_id),r.observed_at) END,
   'pending_count',(SELECT count(*) FROM accounting.bank_transactions t WHERE t.bank_account_id=r.bank_id AND t.state='pending'),
   'unmatched',(SELECT jsonb_build_object('count',count(*),'amount_cents',coalesce(sum(t.amount_cents),0)::text,'oldest',min(t.posted_date)) FROM accounting.bank_transactions t WHERE t.bank_account_id=r.bank_id AND t.state='posted' AND t.review='unmatched'),
   'last_reconciled_through',(SELECT max(x.statement_end) FROM accounting.reconciliations x WHERE x.bank_account_id=r.bank_id AND x.status='completed'),
   'feed',CASE WHEN r.connection_id IS NULL THEN NULL ELSE jsonb_build_object('connection_id',r.connection_id,'connection',r.connection_name,'status',r.connection_status,'last_success_at',r.last_success_at,'last_error',nullif(r.last_error,''),'stale',r.stale) END,
   'status',CASE WHEN r.connection_id IS NULL THEN 'no_feed' WHEN r.stale THEN 'stale_feed' WHEN r.observed IS NOT NULL AND r.book_observed<>r.observed THEN 'gap' ELSE 'ok' END)
  ORDER BY r.subtype,r.code,r.name,r.id),'[]'::jsonb)) INTO result FROM measured r;
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION accounting.reconciliation_status(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.reconciliation_status(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.reconciliation_status(jsonb) TO "authenticated";

-- 4. What needs the owner now.
CREATE OR REPLACE FUNCTION accounting.attention(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE zone text; today date; recon jsonb; info boolean; result jsonb;
BEGIN
 PERFORM accounting.require_reader();
 IF jsonb_typeof(params) IS DISTINCT FROM 'object' OR coalesce(params->>'include_info','true') NOT IN ('true','false') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 info:=coalesce((params->>'include_info')::boolean,true);
 zone:=coalesce((SELECT books_timezone FROM public.business_profile WHERE id=1),'America/Phoenix');
 today:=(now() AT TIME ZONE zone)::date;
 recon:=accounting.reconciliation_status('{}'::jsonb);
 -- Each item's id is a hash of its kind and its subject, so the same issue keeps its id from one check to the next.
 -- Alerts are what justifies telling the owner now; info items are the standing backlog.
 WITH accounts AS (SELECT value AS r FROM jsonb_array_elements(recon->'accounts')),
 live AS (
  -- What the register lists: not discarded and not part of a reversed pair, with its one bank, card or cash line.
  SELECT e.id,e.entry_date,e.status,e.review_pending,e.memo,e.source_description,e.descriptor_key,e.transfer_group_id,e.created_at,m.bank_count,m.bank_amount,m.bank_account,m.debits,m.uncategorized,m.unbalanced
  FROM accounting.journal_entries e CROSS JOIN LATERAL (
   SELECT count(*) FILTER(WHERE a.subtype IN ('bank','card','cash')) AS bank_count,
    sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','card','cash')) AS bank_amount,
    (min(l.account_id::text) FILTER(WHERE a.subtype IN ('bank','card','cash')))::uuid AS bank_account,
    coalesce(sum(l.amount_cents) FILTER(WHERE l.amount_cents>0),0) AS debits,
    coalesce(bool_or(a.subtype='uncategorized' OR coalesce(a.system_purpose,'') IN ('uncategorized_income','uncategorized_expense')),false) AS uncategorized,
    count(*)<2 OR coalesce(sum(l.amount_cents),0)<>0 AS unbalanced
   FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
  WHERE e.status<>'discarded' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)
 ), waiting AS (
  SELECT w.*,CASE WHEN w.bank_count=1 THEN abs(w.bank_amount) ELSE w.debits END AS magnitude FROM live w WHERE w.status='draft' OR (w.status='posted' AND w.review_pending)
 ), items AS (
  -- The books and the bank disagree: an alert once it has lasted a day, info before that (often a sync in flight).
  SELECT 'recon_gap' AS kind,CASE WHEN (x.r->>'off_since')::timestamptz<now()-interval '24 hours' THEN 'alert' ELSE 'info' END AS severity,
   (x.r->'account'->>'id')||':'||coalesce(extract(epoch FROM (x.r->>'off_since')::timestamptz)::text,'') AS subject,
   (x.r->'account'->>'name')||' does not match the bank' AS title,
   'The bank reports '||accounting.usd_text((x.r->>'bank_cents')::numeric)||' and the books show '||accounting.usd_text((x.r->>'bank_cents')::numeric+(x.r->>'gap_cents')::numeric)
    ||' for the same day, a difference of '||accounting.usd_text(abs((x.r->>'gap_cents')::numeric))||'. A transaction the feed missed, or one recorded twice, can cause this.' AS detail,
   x.r->'off_since' AS since,(x.r->>'gap_cents')::numeric AS amount,'/accounting?view=accounts' AS link
  FROM accounts x WHERE x.r->>'gap_cents' IS NOT NULL AND (x.r->>'gap_cents')::numeric<>0
  UNION ALL
  -- A bank feed that is disconnected or has not synced for a day: new bank activity is not reaching the books.
  SELECT 'feed_down','alert',c.id::text||':'||coalesce(extract(epoch FROM c.last_success_at)::text,'never'),
   c.name||CASE WHEN c.status<>'active' THEN ' bank feed needs reconnecting' ELSE ' bank feed has not synced for over a day' END,
   'Last successful sync: '||coalesce(to_char(c.last_success_at AT TIME ZONE zone,'Mon FMDD, YYYY HH24:MI'),'never')
    ||CASE WHEN c.last_error<>'' THEN '. Last error: '||left(c.last_error,200) ELSE '' END||'. New bank transactions do not reach the books until it syncs.',
   to_jsonb(coalesce(c.last_success_at,c.created_at)),NULL::numeric,'/accounting?view=manage&section=feeds'
  FROM accounting.bank_connections c
  WHERE EXISTS(SELECT 1 FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed)
   AND (c.status<>'active' OR coalesce(c.last_success_at,c.created_at)<now()-interval '24 hours')
  UNION ALL
  -- One large transaction still waiting for review after two days.
  (SELECT 'large_unreviewed','alert',w.id::text,
   'Unreviewed '||accounting.usd_text(w.magnitude)||CASE WHEN w.uncategorized THEN ' uncategorized' ELSE '' END||' transaction',
   left(coalesce(nullif(w.source_description,''),w.memo),80)||', dated '||to_char(w.entry_date,'Mon FMDD, YYYY')||', waiting for review since '||to_char(w.created_at AT TIME ZONE zone,'Mon FMDD')||'.',
   to_jsonb(w.created_at),CASE WHEN w.bank_count=1 THEN w.bank_amount ELSE w.magnitude END,'/accounting?view=journal&entry='||w.id::text
  FROM waiting w WHERE w.magnitude>100000 AND w.created_at<now()-interval '2 days' ORDER BY w.magnitude DESC,w.id LIMIT 25)
  UNION ALL
  -- Two reviewed movements on the same account with the same amount and bank description, three days apart or less.
  (SELECT 'possible_duplicate','alert',x.id::text||':'||y.id::text,
   'Possible duplicate '||accounting.usd_text(abs(x.bank_amount))||' on '||a.name,
   'Two reviewed transactions with the same bank description ('||left(x.descriptor_key,60)||') and amount, dated '||to_char(x.entry_date,'Mon FMDD')||' and '||to_char(y.entry_date,'Mon FMDD, YYYY')||'.',
   to_jsonb(y.entry_date),x.bank_amount,'/accounting?view=journal&entry='||y.id::text
  FROM live x JOIN live y ON y.bank_account=x.bank_account AND y.bank_amount=x.bank_amount AND y.descriptor_key=x.descriptor_key AND y.id<>x.id
   AND (y.entry_date>x.entry_date OR (y.entry_date=x.entry_date AND y.id>x.id)) AND y.entry_date-x.entry_date<=3
   JOIN accounting.accounts a ON a.id=x.bank_account
  WHERE x.status='posted' AND y.status='posted' AND x.bank_count=1 AND y.bank_count=1 AND x.descriptor_key IS NOT NULL
   AND x.transfer_group_id IS NULL AND y.transfer_group_id IS NULL AND y.entry_date>=today-60
  ORDER BY y.entry_date DESC,x.id LIMIT 25)
  UNION ALL
  -- Drafts whose lines do not add up to zero: they stay out of every report until fixed.
  SELECT 'unbalanced_drafts','alert',string_agg(u.id::text,',' ORDER BY u.id),
   count(*)||CASE WHEN count(*)=1 THEN ' draft does not balance' ELSE ' drafts do not balance' END,
   'Their lines do not add up to zero, so they are left out of every report until fixed.',
   to_jsonb(min(u.created_at)),NULL::numeric,'/accounting?view=journal'
  FROM live u WHERE u.status='draft' AND u.unbalanced HAVING count(*)>0
  UNION ALL
  -- A closed month with bank activity the books never took in.
  SELECT 'closed_month_unmatched','alert',p.month::text,
   to_char(p.month,'FMMonth YYYY')||' is closed but has bank transactions not in the books',
   count(*)||' bank transaction(s), '||accounting.usd_text(sum(t.amount_cents))||' in total, arrived after the month was closed.',
   to_jsonb(p.month),sum(t.amount_cents)::numeric,'/accounting?view=close'
  FROM accounting.periods p JOIN accounting.bank_transactions t ON t.state='posted' AND t.review='unmatched' AND date_trunc('month',t.posted_date)::date=p.month
  WHERE p.status='locked' GROUP BY p.month
  UNION ALL
  SELECT 'review_backlog','info','all',
   count(*)||CASE WHEN count(*)=1 THEN ' transaction is' ELSE ' transactions are' END||' waiting for review',
   accounting.usd_text(sum(w.magnitude))||' in total; the oldest is dated '||to_char(min(w.entry_date),'Mon FMDD, YYYY')||'.',
   to_jsonb(min(w.entry_date)),sum(w.magnitude),'/accounting?view=journal'
  FROM waiting w HAVING count(*)>0
  UNION ALL
  SELECT 'suggested_contacts','info','all',
   count(*)||CASE WHEN count(*)=1 THEN ' suggested contact is' ELSE ' suggested contacts are' END||' waiting for approval',
   'Agents suggested them; the owner approves or merges them on the Contacts screen.',
   to_jsonb(min(p.created_at)),NULL::numeric,'/accounting?view=manage&section=payees'
  FROM accounting.parties p WHERE p.review_status='suggested' AND NOT p.is_archived HAVING count(*)>0
  UNION ALL
  SELECT 'uncategorized','info','all',
   count(DISTINCT u.id)||CASE WHEN count(DISTINCT u.id)=1 THEN ' transaction is' ELSE ' transactions are' END||' still uncategorized',
   accounting.usd_text(-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income'),0))||' money in and '||accounting.usd_text(coalesce(sum(l.amount_cents) FILTER(WHERE a.type<>'income'),0))||' money out are parked in Uncategorized.',
   to_jsonb(min(u.entry_date)),-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income'),0)+coalesce(sum(l.amount_cents) FILTER(WHERE a.type<>'income'),0),'/accounting?view=journal'
  FROM live u JOIN accounting.journal_lines l ON l.entry_id=u.id JOIN accounting.accounts a ON a.id=l.account_id
  WHERE u.uncategorized AND (a.subtype='uncategorized' OR coalesce(a.system_purpose,'') IN ('uncategorized_income','uncategorized_expense')) HAVING count(*)>0
 )
 SELECT jsonb_build_object('as_of',today,'checked_at',now(),'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1),
  'alert',coalesce(bool_or(i.severity='alert'),false),
  'counts',jsonb_build_object('alert',count(*) FILTER(WHERE i.severity='alert'),'info',count(*) FILTER(WHERE i.severity='info')),
  'items',coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',left(md5(i.kind||':'||i.subject),16),'severity',i.severity,'kind',i.kind,'title',i.title,'detail',i.detail,
   'since',i.since,'amount_cents',i.amount::text,'link',i.link)) ORDER BY i.severity='info',i.kind,i.since::text,i.subject) FILTER(WHERE info OR i.severity='alert'),'[]'::jsonb)) INTO result FROM items i;
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION accounting.attention(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.attention(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.attention(jsonb) TO "authenticated";

-- 5. The register: kind and transfer filters, totals over every match (restated in full).
CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc'); q text:=nullif(btrim(coalesce(f->>'query','')),''); transfers text:=coalesce(f->>'transfers','include');
BEGIN
 PERFORM accounting.require_reader();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded','reversed') OR (f->>'review' IS NOT NULL AND f->>'review' NOT IN ('needs_review','reviewed')) OR (f->>'from')::date>(f->>'to')::date
  OR (f->>'kind' IS NOT NULL AND f->>'kind' NOT IN ('manual','income','expense','transfer','payroll','opening','owner','asset','loan','refund','correction')) OR transfers NOT IN ('include','exclude','only') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH terms AS MATERIALIZED (SELECT kind,pattern,cents,op FROM accounting.search_terms(q)),
 candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude,m.amounts,m.bank_count,m.bank_amount,
 -- The register's transfer flag: a linked or proposed pair, or every line on two or more of the business's own money accounts.
 (e.transfer_group_id IS NOT NULL OR e.pair_entry_id IS NOT NULL OR (m.bank_accounts>1 AND m.bank_count=m.line_count)) is_transfer,
 CASE WHEN q IS NULL THEN NULL ELSE lower(concat_ws(' ',e.memo,e.source_description,e.kind,to_char(e.entry_date,'YYYY-MM-DD'),to_char(e.entry_date,'Mon FMDD, YYYY'),to_char(e.entry_date,'FMMonth FMDD, YYYY'),to_char(e.entry_date,'FMMM/FMDD/YYYY'),
  (SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),m.labels,
  (SELECT string_agg(bt.description,' ') FROM accounting.bank_matches bm JOIN accounting.journal_lines bl ON bl.id=bm.journal_line_id JOIN accounting.bank_transactions bt ON bt.id=bm.bank_transaction_id WHERE bl.entry_id=e.id))) END document
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits,array_agg(abs(l.amount_cents)) amounts,count(DISTINCT l.account_id) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_accounts,count(*) line_count,
  CASE WHEN q IS NULL THEN NULL ELSE string_agg(concat_ws(' ',a.code,a.name,l.memo,to_char(abs(l.amount_cents)/100.0,'FM999999999999990.00'),to_char(abs(l.amount_cents)/100.0,'FM999,999,999,999,990.00'),
   (SELECT string_agg(concat_ws(' ',b.institution,b.mask),' ') FROM accounting.bank_accounts b WHERE b.account_id=a.id)),' ') END labels
  FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (f->>'entry_id' IS NOT NULL OR CASE WHEN f->>'status'='reversed' THEN e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) ELSE e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) END)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) WHEN f->>'status'='reversed' THEN e.status='posted' ELSE e.status=f->>'status' END)
 AND (f->>'review' IS NULL OR CASE WHEN f->>'review'='reviewed' THEN e.status='posted' AND NOT e.review_pending ELSE e.status='draft' OR (e.status='posted' AND e.review_pending) END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR (f->>'payee'='unassigned' AND e.payee_id IS NULL) OR e.payee_id::text=f->>'payee')
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (f->>'kind' IS NULL OR e.kind=f->>'kind') AND (transfers='include' OR e.is_transfer=(transfers='only'))
 AND (q IS NULL OR (SELECT coalesce(bool_and(coalesce(CASE t.kind
  WHEN 'compare' THEN CASE t.op WHEN '>' THEN e.magnitude>t.cents WHEN '>=' THEN e.magnitude>=t.cents WHEN '<' THEN e.magnitude<t.cents ELSE e.magnitude<=t.cents END
  WHEN 'amount' THEN t.cents=ANY(e.amounts) OR t.cents=e.magnitude OR e.document ~ t.pattern
  WHEN 'dollars' THEN EXISTS(SELECT 1 FROM unnest(e.amounts||e.magnitude) v WHERE v/100=t.cents/100) OR e.document ~ t.pattern
  ELSE e.document LIKE '%'||t.pattern||'%' END,false)),true) FROM terms t))
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)),
 -- Totals over every match, not the page: each match's amount_cents (its one bank, card or cash line, money in positive).
 -- A match without exactly one such line (an adjustment, or a transfer kept as one entry) counts but adds to neither side.
 'totals',(SELECT jsonb_build_object('count',count(*),'in_cents',coalesce(sum(bank_amount) FILTER(WHERE bank_count=1 AND bank_amount>0),0)::text,
  'out_cents',(-coalesce(sum(bank_amount) FILTER(WHERE bank_count=1 AND bank_amount<0),0))::text,'net_cents',coalesce(sum(bank_amount) FILTER(WHERE bank_count=1),0)::text,
  'without_bank_line',count(*) FILTER(WHERE bank_count<>1)) FROM matches)) INTO result;
 RETURN result;
END $function$
;

-- 6. Contacts: first and last seen, money in and out (restated in full).
CREATE OR REPLACE FUNCTION accounting.payees_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 -- Each contact's live entries as the register lists them (not discarded, not part of a reversed pair): first and
 -- last date, and money in and out on each entry's one bank, card or cash line, as the register's totals add them.
 RETURN (WITH money AS (
  SELECT e.id,e.payee_id,e.entry_date,CASE WHEN count(*) FILTER(WHERE a.subtype IN ('bank','cash','card'))=1 THEN sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) END bank_amount
  FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id
  WHERE e.payee_id IS NOT NULL AND e.status<>'discarded' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)
  GROUP BY e.id,e.payee_id,e.entry_date
 ), seen AS (
  SELECT payee_id,min(entry_date) first_date,max(entry_date) last_date,coalesce(sum(bank_amount) FILTER(WHERE bank_amount>0),0) in_cents,-coalesce(sum(bank_amount) FILTER(WHERE bank_amount<0),0) out_cents FROM money GROUP BY payee_id
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'roles',to_jsonb(p.roles),'email',p.email,'phone',p.phone,'website',p.website,'notes',p.notes,
  'default_account_id',p.default_account_id,'review_status',p.review_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by),
  'is_archived',p.is_archived,'version',p.version,'transaction_count',(SELECT count(*) FROM accounting.journal_entries e WHERE e.payee_id=p.id AND e.status<>'discarded'),'top_category',CASE WHEN t.account_id IS NULL THEN NULL ELSE jsonb_build_object('id',t.account_id,'name',t.account_name) END,
  'first_date',s.first_date,'last_date',s.last_date,'in_cents',coalesce(s.in_cents,0)::text,'out_cents',coalesce(s.out_cents,0)::text) ORDER BY lower(p.name),p.id),'[]'::jsonb)
  FROM accounting.parties p LEFT JOIN accounting.contact_top_categories() t ON t.party_id=p.id LEFT JOIN seen s ON s.payee_id=p.id);
END $function$
;

-- 7. The API reads the two new reads (restated in full).
CREATE OR REPLACE FUNCTION public.api_accounting(p_key_hash text, p_name text, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE a jsonb := coalesce(p_args, '{}'::jsonb);
BEGIN
 IF p_name IS NULL OR p_name NOT IN ('workspace', 'transactions', 'entry_detail', 'report', 'report_lines', 'ledger', 'revision', 'payees', 'rules', 'reconciliation', 'attention') THEN
  RAISE EXCEPTION 'API_OPERATION_NOT_ALLOWED';
 END IF;
 PERFORM public.api_act(p_key_hash, 'accounting.read');
 RETURN CASE p_name
  WHEN 'workspace' THEN accounting.workspace((a->>'from_date')::date, (a->>'to_date')::date, coalesce(a->>'mode', 'posted'))
  WHEN 'transactions' THEN accounting.transactions(coalesce(a->'filter', '{}'::jsonb), coalesce(a->'page', '{}'::jsonb))
  WHEN 'entry_detail' THEN accounting.entry_detail((a->>'entry')::uuid)
  WHEN 'report' THEN accounting.report(a->>'kind', coalesce(a->'params', '{}'::jsonb))
  WHEN 'report_lines' THEN accounting.report_lines(a->>'kind', coalesce(a->'params', '{}'::jsonb), (a->>'account')::uuid)
  WHEN 'ledger' THEN accounting.ledger((a->>'account')::uuid, (a->>'from_date')::date, (a->>'to_date')::date)
  WHEN 'revision' THEN jsonb_build_object('revision', accounting.revision())
  WHEN 'payees' THEN jsonb_build_object('payees', accounting.payees_list())
  WHEN 'rules' THEN jsonb_build_object('rules', accounting.rules_list())
  WHEN 'reconciliation' THEN accounting.reconciliation_status(coalesce(a->'params', '{}'::jsonb))
  WHEN 'attention' THEN accounting.attention(coalesce(a->'params', '{}'::jsonb))
 END;
END $fn$;


-- 8. The API's books writes gain missed.create (restated in full).
CREATE OR REPLACE FUNCTION public.api_books_command(p_key_hash text, p_operation text, p_key uuid, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
 a jsonb := coalesce(p_args, '{}'::jsonb);
 kinds text[] := ARRAY['manual', 'income', 'expense', 'refund', 'owner', 'loan', 'asset'];
 keys uuid[] := ARRAY[]::uuid[];
 cmd jsonb; result jsonb; results jsonb := '[]'::jsonb; item jsonb; i integer := 0; k uuid; bad text;
 current_status text; current_kind text; current_payee uuid; cash_sign integer;
 lines jsonb; splits jsonb; conditions jsonb; actions jsonb; matcher text;
 -- Records, not table row types: this block is created before the accounting schema.
 contact record; contact_id uuid; e record; descriptor text; alias_owner jsonb;
 remembered jsonb := '[]'::jsonb; already jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
 -- missed.create: a bank, card or cash movement the feed missed.
 bank_id uuid; category_id uuid; amount bigint; missed_date date; missed_id uuid; missed_kind text; gap bigint; recon jsonb; candidate jsonb; agent text; zone text;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN ('draft.create', 'draft.update', 'categorize', 'split', 'categorize.bulk', 'rule.create', 'contact.create', 'contact.update', 'contact.assign', 'missed.create') THEN
  RAISE EXCEPTION 'API_COMMAND_NOT_ALLOWED';
 END IF;
 IF p_key IS NULL THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
 PERFORM public.api_act(p_key_hash, 'accounting.draft');
 PERFORM set_config('api.command', 'drafts', true);
 IF a ? 'lines' THEN
  SELECT jsonb_agg(jsonb_build_object('account_id', l->>'account_id', 'amount_cents', l->>'amount_cents', 'memo', coalesce(l->>'memo', '')) ORDER BY n)
   INTO lines FROM jsonb_array_elements(a->'lines') WITH ORDINALITY AS t(l, n);
 END IF;

 IF p_operation IN ('draft.create', 'draft.update') THEN
  IF a ? 'kind' AND jsonb_typeof(a->'kind') <> 'null' AND NOT ((a->>'kind') = ANY (kinds)) THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  IF p_operation = 'draft.update' THEN
   SELECT status, kind, payee_id INTO current_status, current_kind, current_payee FROM accounting.journal_entries WHERE id = (a->>'id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF current_status <> 'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   -- A bank or card transaction is categorized or split, never rewritten.
   IF EXISTS (SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts acc ON acc.id = l.account_id
      WHERE l.entry_id = (a->>'id')::uuid AND acc.subtype IN ('bank', 'card', 'cash')) THEN RAISE EXCEPTION 'API_DRAFTS_NO_CASH'; END IF;
  END IF;
  -- Journal entries from the API are adjustments. Bank, card and cash
  -- movements come only from the feeds and imports.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(lines, '[]'::jsonb)) AS t(l) JOIN accounting.accounts acc ON acc.id = (l->>'account_id')::uuid
     WHERE acc.subtype IN ('bank', 'card', 'cash')) THEN RAISE EXCEPTION 'API_DRAFTS_NO_CASH'; END IF;
  -- An update keeps the kind and payee the caller leaves out.
  cmd := jsonb_build_object('type', 'draft.save',
   'id', CASE WHEN p_operation = 'draft.create' THEN md5('draft:' || p_key::text)::uuid ELSE (a->>'id')::uuid END,
   'expected_version', CASE WHEN p_operation = 'draft.create' THEN 0 ELSE (a->>'expected_version')::integer END,
   'entry_date', a->>'entry_date', 'memo', a->>'memo', 'lines', coalesce(lines, '[]'::jsonb),
   'kind', CASE WHEN a ? 'kind' AND jsonb_typeof(a->'kind') <> 'null' THEN a->>'kind' ELSE coalesce(current_kind, 'manual') END,
   'payee_id', CASE WHEN a ? 'payee_id' THEN a->'payee_id' ELSE to_jsonb(current_payee) END);
  IF p_operation = 'draft.create' THEN cmd := cmd || jsonb_build_object('origin', 'manual'); END IF;
 ELSIF p_operation = 'categorize' THEN
  PERFORM public.api_books_ref('category', a->>'account_id');
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  -- The category sets the kind, as the Transactions screen does.
  cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.categorize', 'id', (a->>'id')::uuid,
   'expected_version', (a->>'expected_version')::integer, 'account_id', (a->>'account_id')::uuid,
   'kind', public.api_category_kind((a->>'id')::uuid, (a->>'account_id')::uuid),
   'payee_id', a->'payee_id', 'memo', a->'memo')) || jsonb_build_object('remember', false);
 ELSIF p_operation = 'split' THEN
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  -- Callers send amounts as positive cents. Category lines take the opposite
  -- sign of the bank line, so a deposit's amounts are flipped here.
  SELECT sign(sum(l.amount_cents)) INTO cash_sign FROM accounting.journal_lines l JOIN accounting.accounts acc ON acc.id = l.account_id
   WHERE l.entry_id = (a->>'id')::uuid AND acc.subtype IN ('bank', 'card', 'cash');
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('account_id', public.api_books_ref('category', s->>'account_id'),
    'amount_cents', CASE WHEN s ? 'amount_cents' AND coalesce(cash_sign, 0) > 0 THEN to_jsonb((-((s->>'amount_cents')::bigint))::text) ELSE s->'amount_cents' END,
    'share_bps', s->'share_bps')) ORDER BY n)
   INTO splits FROM jsonb_array_elements(a->'splits') WITH ORDINALITY AS t(s, n);
  cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.split', 'id', (a->>'id')::uuid,
   'expected_version', (a->>'expected_version')::integer, 'splits', splits, 'payee_id', a->'payee_id', 'memo', a->'memo'));
 ELSIF p_operation = 'rule.create' THEN
  -- Conditions and actions are rebuilt from the allowed fields, and every
  -- account and payee they name must exist and fit.
  IF jsonb_typeof(a->'conditions') <> 'object' OR jsonb_typeof(a->'actions') <> 'object'
     OR jsonb_typeof(a->'conditions'->'descriptor_key') <> 'object' THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  SELECT key INTO matcher FROM jsonb_object_keys(a->'conditions'->'descriptor_key') AS key LIMIT 1;
  IF matcher IS NULL OR matcher NOT IN ('equals', 'prefix', 'contains')
     OR (SELECT count(*) FROM jsonb_object_keys(a->'conditions'->'descriptor_key')) <> 1
     OR length(btrim(coalesce(a->'conditions'->'descriptor_key'->>matcher, ''))) = 0 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  conditions := jsonb_strip_nulls(jsonb_build_object(
   'descriptor_key', jsonb_build_object(matcher, btrim(a->'conditions'->'descriptor_key'->>matcher)),
   'bank_account_id', public.api_books_ref('bank', a->'conditions'->>'bank_account_id'),
   'direction', a->'conditions'->>'direction',
   'amount_min', a->'conditions'->>'amount_min',
   'amount_max', a->'conditions'->>'amount_max',
   'payee_id', public.api_books_ref('payee', a->'conditions'->>'payee_id')));
  IF a->'actions' ? 'splits' THEN
   SELECT jsonb_agg(jsonb_build_object('account_id', public.api_books_ref('category', s->>'account_id'), 'share_bps', (s->>'share_bps')::integer) ORDER BY n)
    INTO splits FROM jsonb_array_elements(a->'actions'->'splits') WITH ORDINALITY AS t(s, n);
   actions := jsonb_build_object('splits', coalesce(splits, '[]'::jsonb));
  ELSE
   actions := jsonb_build_object('account_id', public.api_books_ref('category', a->'actions'->>'account_id'));
  END IF;
  actions := actions || jsonb_strip_nulls(jsonb_build_object(
   'payee_id', public.api_books_ref('payee', a->'actions'->>'payee_id'), 'memo', a->'actions'->>'memo'));
  cmd := jsonb_build_object('type', 'rule.save', 'id', md5('rule:' || p_key::text)::uuid, 'expected_version', 0,
   'reason', coalesce(nullif(a->>'reason', ''), 'Created through the API'), 'name', a->>'name',
   'priority', coalesce((a->>'priority')::integer, 100), 'enabled', false,
   'auto_post', false, 'conditions', conditions, 'actions', actions);
 ELSIF p_operation = 'contact.create' THEN
  -- A retry of a create that already ran replays its receipt in operate, so
  -- the duplicate guard only looks at a new request.
  IF NOT EXISTS (SELECT 1 FROM accounting.command_receipts WHERE idempotency_key = p_key) THEN
   PERFORM public.api_contact_check(a->>'name', NULL, a->'not_duplicate_of');
  END IF;
  cmd := jsonb_build_object('type', 'party.save', 'id', md5('contact:' || p_key::text)::uuid, 'expected_version', 0,
   'name', a->>'name', 'roles', a->'roles', 'email', a->>'email', 'phone', a->>'phone', 'website', a->>'website',
   'default_account_id', public.api_books_ref('category', a->>'default_account_id'),
   'notes', coalesce(a->>'notes', ''), 'is_archived', false);
 ELSIF p_operation = 'contact.update' THEN
  SELECT * INTO contact FROM accounting.parties WHERE id = (a->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  -- Once the owner confirms a contact it is theirs.
  IF contact.review_status <> 'suggested' THEN RAISE EXCEPTION 'API_CONTACT_CONFIRMED'; END IF;
  IF a ? 'name' THEN PERFORM public.api_contact_check(a->>'name', contact.id, a->'not_duplicate_of'); END IF;
  -- An update keeps every field the caller leaves out, and the owner's contractor details.
  cmd := jsonb_build_object('type', 'party.save', 'id', contact.id, 'expected_version', (a->>'expected_version')::integer,
   'name', coalesce(a->>'name', contact.name), 'roles', coalesce(a->'roles', to_jsonb(contact.roles)),
   'email', CASE WHEN a ? 'email' THEN a->>'email' ELSE contact.email END,
   'phone', CASE WHEN a ? 'phone' THEN a->>'phone' ELSE contact.phone END,
   'website', CASE WHEN a ? 'website' THEN a->>'website' ELSE contact.website END,
   'notes', CASE WHEN a ? 'notes' THEN coalesce(a->>'notes', '') ELSE contact.notes END,
   'default_account_id', CASE WHEN a ? 'default_account_id' THEN public.api_books_ref('category', a->>'default_account_id') ELSE contact.default_account_id END,
   'contractor_classification', contact.contractor_classification, 'documentation_status', contact.documentation_status,
   'is_archived', contact.is_archived);
 ELSIF p_operation = 'contact.assign' THEN
  contact_id := public.api_books_ref('payee', a->>'contact_id');
  IF contact_id IS NULL OR jsonb_typeof(a->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'entries') NOT BETWEEN 1 AND 100
     OR (SELECT count(DISTINCT lower(value->>'id')) FROM jsonb_array_elements(a->'entries')) <> jsonb_array_length(a->'entries') THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  -- All or nothing: the first entry that does not fit refuses the whole call.
  FOR item IN SELECT value FROM jsonb_array_elements(a->'entries') LOOP
   i := i + 1;
   SELECT * INTO e FROM accounting.journal_entries WHERE id = (item->>'id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF e.status = 'discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   -- Money between the business's own accounts has no contact.
   IF e.transfer_group_id IS NOT NULL OR e.pair_entry_id IS NOT NULL OR e.kind = 'transfer' THEN
    RAISE EXCEPTION 'API_CONTACT_TRANSFER %', jsonb_build_object('entry_id', e.id);
   END IF;
   -- Only a blank contact is filled; one already chosen stays the owner's call.
   IF e.payee_id IS NOT NULL THEN
    RAISE EXCEPTION 'API_CONTACT_ALREADY_SET %', jsonb_build_object('entry_id', e.id,
     'contact', (SELECT jsonb_build_object('id', p.id, 'name', p.name) FROM accounting.parties p WHERE p.id = e.payee_id));
   END IF;
   IF (item->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   -- A posted entry changes no lock of its own here, so the closed months are checked first.
   PERFORM accounting.require_open(e.entry_date);
   k := md5(p_key::text || ':' || i)::uuid;
   keys := array_append(keys, k);
   result := accounting.operate(jsonb_build_object('key', k, 'command',
    jsonb_build_object('type', 'entry.context', 'id', e.id, 'expected_version', e.version, 'payee_id', contact_id)));
   results := results || jsonb_build_array(jsonb_build_object('id', e.id, 'version', result->'version'));
  END LOOP;
  -- Remember: each bank description in the set fills this contact on future
  -- feed transactions, unless another contact already owns it.
  IF coalesce((a->>'remember')::boolean, false) THEN
   FOR descriptor IN SELECT DISTINCT je.descriptor_key FROM accounting.journal_entries je
     WHERE je.id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(a->'entries')) AND nullif(btrim(je.descriptor_key), '') IS NOT NULL ORDER BY 1 LOOP
    SELECT jsonb_build_object('id', p.id, 'name', p.name) INTO alias_owner FROM accounting.payee_aliases al JOIN accounting.parties p ON p.id = al.party_id
     WHERE al.match_kind = 'key' AND al.pattern = descriptor;
    IF alias_owner IS NULL THEN
     k := md5(p_key::text || ':alias:' || descriptor)::uuid;
     keys := array_append(keys, k);
     PERFORM accounting.operate(jsonb_build_object('key', k, 'command', jsonb_build_object('type', 'alias.save',
      'id', md5('alias:' || p_key::text || ':' || descriptor)::uuid, 'expected_version', 0, 'party_id', contact_id,
      'match_kind', 'key', 'pattern', descriptor, 'enabled', true)));
     remembered := remembered || to_jsonb(descriptor);
    ELSIF alias_owner->>'id' = contact_id::text THEN
     already := already || to_jsonb(descriptor);
    ELSE
     skipped := skipped || jsonb_build_array(jsonb_build_object('descriptor_key', descriptor, 'contact', alias_owner));
    END IF;
   END LOOP;
  END IF;
  result := jsonb_build_object('id', contact_id, 'entries', results, 'remembered', remembered,
   'already_remembered', already, 'not_remembered', skipped);
 ELSIF p_operation = 'missed.create' THEN
  -- A bank, card or cash movement the feed missed: the one draft the API may write on a money account. It is
  -- accepted only while the reconciliation shows a gap on that account, only in the direction that shrinks the
  -- gap and never by more than the gap, never on top of a movement already recorded or imported, and it stays a
  -- draft for the owner. A retry replays its receipt in operate, so the checks only look at a new request.
  bank_id := public.api_books_ref('bank', a->>'bank_account_id');
  category_id := public.api_books_ref('category', a->>'account_id');
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  IF coalesce(a->>'amount_cents', '') !~ '^-?[0-9]{1,13}$' OR coalesce(a->>'entry_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  amount := (a->>'amount_cents')::bigint;
  missed_date := (a->>'entry_date')::date;
  IF bank_id IS NULL OR category_id IS NULL OR amount = 0 OR length(btrim(coalesce(a->>'description', ''))) = 0 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  missed_id := md5('missed:' || p_key::text)::uuid;
  zone := coalesce((SELECT books_timezone FROM public.business_profile WHERE id = 1), 'America/Phoenix');
  SELECT m.name INTO agent FROM public.team_members m WHERE m.auth_user_id = auth.uid();
  IF NOT EXISTS (SELECT 1 FROM accounting.command_receipts WHERE idempotency_key = p_key) THEN
   -- Not in the future, not before the books (or this account's feed coverage) start, and in an open month.
   IF missed_date > (now() AT TIME ZONE zone)::date
      OR missed_date < coalesce((SELECT earliest_history_date FROM public.business_profile WHERE id = 1), missed_date)
      OR missed_date < coalesce((SELECT b.coverage_from FROM accounting.bank_accounts b WHERE b.account_id = bank_id AND NOT b.is_closed), missed_date) THEN
    RAISE EXCEPTION 'API_MISSED_DATE';
   END IF;
   PERFORM accounting.require_open(missed_date);
   recon := accounting.reconciliation_status(jsonb_build_object('account', bank_id))->'accounts'->0;
   -- The gap as the ledger signs it (books minus bank, debit positive): the line added here moves it by its own amount.
   gap := (recon->>'gap_cents')::bigint * CASE WHEN recon->'account'->>'kind' = 'card' THEN -1 ELSE 1 END;
   candidate := jsonb_build_object('gap_cents', recon->'gap_cents', 'bank_cents', recon->'bank_cents', 'bank_observed_at', recon->'bank_observed_at',
    'closes_with_cents', CASE WHEN gap IS NULL THEN NULL ELSE (-gap)::text END);
   IF gap IS NULL OR gap = 0 THEN RAISE EXCEPTION 'API_MISSED_NO_GAP %', candidate; END IF;
   IF sign(amount) = sign(gap) THEN RAISE EXCEPTION 'API_MISSED_WRONG_DIRECTION %', candidate; END IF;
   IF abs(amount) > abs(gap) THEN RAISE EXCEPTION 'API_MISSED_EXCEEDS_GAP %', candidate; END IF;
   IF missed_date > ((recon->>'bank_observed_at')::timestamptz AT TIME ZONE zone)::date THEN RAISE EXCEPTION 'API_MISSED_AFTER_BALANCE %', candidate; END IF;
   -- The same amount on this account within ten days, in the books or among the bank's own records, is probably it.
   SELECT jsonb_build_object('entry_id', je.id, 'date', je.entry_date, 'amount_cents', jl.amount_cents::text, 'memo', je.memo, 'status', je.status) INTO candidate
    FROM accounting.journal_lines jl JOIN accounting.journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_id = bank_id AND jl.amount_cents = amount AND je.status <> 'discarded' AND abs(je.entry_date - missed_date) <= 10
    ORDER BY abs(je.entry_date - missed_date), je.id LIMIT 1;
   IF candidate IS NULL THEN
    SELECT jsonb_build_object('bank_transaction_id', t.id, 'date', t.posted_date, 'amount_cents', t.amount_cents::text, 'description', t.description, 'state', t.state) INTO candidate
     FROM accounting.bank_transactions t JOIN accounting.bank_accounts b ON b.id = t.bank_account_id
     WHERE b.account_id = bank_id AND t.amount_cents = amount AND abs(t.posted_date - missed_date) <= 10
     ORDER BY abs(t.posted_date - missed_date), t.id LIMIT 1;
   END IF;
   IF candidate IS NOT NULL THEN RAISE EXCEPTION 'API_MISSED_DUPLICATE %', jsonb_build_object('candidate', candidate); END IF;
  END IF;
  -- The kind follows the category and the direction, by the rule public.api_category_kind applies to a categorized draft.
  SELECT CASE
    WHEN acc.subtype = 'owner_equity' THEN 'owner'
    WHEN acc.type = 'income' THEN CASE WHEN amount > 0 THEN 'income' ELSE 'refund' END
    WHEN acc.type = 'expense' THEN CASE WHEN amount > 0 THEN 'refund' ELSE 'expense' END
    WHEN acc.subtype = 'loan' THEN 'loan'
    WHEN acc.subtype = 'fixed_asset' THEN 'asset'
    WHEN amount > 0 THEN 'income' ELSE 'expense' END INTO missed_kind
   FROM accounting.accounts acc WHERE acc.id = category_id;
  cmd := jsonb_build_object('type', 'draft.save', 'id', missed_id, 'expected_version', 0, 'entry_date', missed_date,
   'memo', left(btrim(a->>'description'), 400) || ' (missed by the bank feed, added by ' || coalesce(agent, 'an agent') || ')',
   'source_description', btrim(a->>'description'), 'origin', 'manual', 'kind', missed_kind, 'payee_id', a->'payee_id',
   'reason', 'Added by ' || coalesce(agent, 'an agent') || ': missed by bank feed' || coalesce('. ' || nullif(btrim(a->>'note'), ''), ''),
   'lines', jsonb_build_array(jsonb_build_object('account_id', bank_id, 'amount_cents', amount::text, 'memo', ''),
    jsonb_build_object('account_id', category_id, 'amount_cents', (-amount)::text, 'memo', '')));
 END IF;

 IF p_operation = 'categorize.bulk' THEN
  IF jsonb_typeof(a->'items') <> 'array' OR jsonb_array_length(a->'items') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(a->'items') LOOP
   i := i + 1;
   k := md5(p_key::text || ':' || i)::uuid;
   keys := array_append(keys, k);
   PERFORM public.api_books_ref('category', item->>'account_id');
   IF item ? 'payee_id' THEN PERFORM public.api_books_ref('payee', item->>'payee_id'); END IF;
   cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.categorize', 'id', (item->>'id')::uuid,
    'expected_version', (item->>'expected_version')::integer, 'account_id', (item->>'account_id')::uuid,
    'kind', public.api_category_kind((item->>'id')::uuid, (item->>'account_id')::uuid),
    'payee_id', item->'payee_id')) || jsonb_build_object('remember', false);
   results := results || jsonb_build_array(accounting.operate(jsonb_build_object('key', k, 'command', cmd)));
  END LOOP;
  result := jsonb_build_object('results', results);
 ELSIF p_operation <> 'contact.assign' THEN
  keys := ARRAY[p_key];
  result := accounting.operate(jsonb_build_object('key', p_key, 'command', cmd));
 END IF;

 SELECT string_agg(DISTINCT l.table_name || ':' || l.action, ', ') INTO bad
 FROM accounting.audit_log l
 WHERE l.operation_id = ANY (keys) AND (
  l.table_name NOT IN ('journal_entries', 'journal_lines', 'rules', 'parties', 'payee_aliases', 'command_receipts', 'periods')
  -- A draft in a month with no period row opens one; it must stay open.
  OR (l.table_name = 'periods' AND (coalesce(l.after->>'status', 'open') <> 'open' OR coalesce(l.before->>'status', 'open') <> 'open'))
  OR (l.table_name = 'journal_entries' AND p_operation <> 'contact.assign' AND (coalesce(l.after->>'status', 'draft') <> 'draft' OR coalesce(l.before->>'status', 'draft') <> 'draft'))
  -- Assigning a contact changes exactly one thing on an entry: a blank contact becomes set.
  OR (l.table_name = 'journal_entries' AND p_operation = 'contact.assign' AND NOT (l.before IS NOT NULL AND l.after IS NOT NULL
   AND l.before->>'payee_id' IS NULL AND l.after->>'payee_id' IS NOT NULL
   AND (l.after - ARRAY['payee_id', 'version', 'updated_at']) = (l.before - ARRAY['payee_id', 'version', 'updated_at'])))
  OR (l.table_name = 'journal_lines' AND p_operation = 'contact.assign')
  OR (l.table_name = 'rules' AND (l.before IS NOT NULL OR coalesce((l.after->>'auto_post')::boolean, false) OR coalesce((l.after->>'enabled')::boolean, false)))
  -- A contact from the API is a suggestion, and only a suggestion changes.
  OR (l.table_name = 'parties' AND (coalesce(l.after->>'review_status', '') <> 'suggested'
   OR (l.before IS NOT NULL AND (p_operation <> 'contact.update' OR l.before->>'review_status' <> 'suggested'))))
  -- An alias is only ever added, and only by remember.
  OR (l.table_name = 'payee_aliases' AND (l.before IS NOT NULL OR p_operation <> 'contact.assign'))
  -- A missed bank movement inserts exactly one draft and its lines, and touches nothing else.
  OR (p_operation = 'missed.create' AND (l.table_name IN ('rules', 'parties', 'payee_aliases')
   OR (l.table_name = 'journal_entries' AND (l.before IS NOT NULL OR l.row_id IS DISTINCT FROM missed_id))
   OR (l.table_name = 'journal_lines' AND (l.before IS NOT NULL OR l.after->>'entry_id' IS DISTINCT FROM missed_id::text)))));
 IF p_operation = 'missed.create' AND (SELECT count(*) FROM accounting.audit_log l WHERE l.operation_id = ANY (keys) AND l.table_name = 'journal_lines') <> 2 THEN
  bad := concat_ws(', ', bad, 'journal_lines:count');
 END IF;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'API_DRAFTS_ONLY (%)', bad; END IF;
 RETURN result;
END $fn$;

COMMIT;
