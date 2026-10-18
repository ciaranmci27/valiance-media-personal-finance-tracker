-- Invoice sources and deposit links. The books connect to any invoicing system
-- through a documented contract (an HTTPS base URL and an API key) and keep a
-- read-only mirror of its invoices and of the work it reports as earned but
-- not yet invoiced. A deposit is linked to the invoice or invoices it paid;
-- the link is its own record and NEVER changes the journal entry, so cash
-- basis books stay exactly as the owner categorized them. Whether a link
-- still counts is computed, never stored: it stops counting when its deposit
-- is discarded or reversed, or its invoice is voided or removed at the source.
--
-- Matching is rule based with a named reason (no AI): one open invoice for the
-- deposit's client at exactly the remaining amount links on its own when the
-- source allows it; a set of that client's invoices that sums to the amount,
-- or a unique amount from an unknown payer, is only suggested.
--
-- The accrual view's three balance sheet lines (Invoices receivable, Unbilled
-- work, Billed in advance) are created by the first invoice_source.save and
-- the guard keeps every real journal line off them.
BEGIN;

ALTER TABLE accounting.settings ADD COLUMN IF NOT EXISTS "accrual_start" date;

ALTER TABLE accounting.settings DROP CONSTRAINT IF EXISTS "settings_accrual_start_check";

ALTER TABLE accounting.settings ADD CONSTRAINT "settings_accrual_start_check" CHECK (((accrual_start IS NULL) OR (EXTRACT(day FROM accrual_start) = (1)::numeric)));

CREATE TABLE IF NOT EXISTS accounting.invoice_sources (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  "api_key_encrypted" text NOT NULL,
  "key_version" smallint DEFAULT 1 NOT NULL,
  "account_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "party_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "auto_link" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "last_synced_at" timestamp with time zone,
  "last_error" text DEFAULT ''::text NOT NULL,
  "lease_run_id" uuid,
  "lease_until" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "invoice_sources_account_map_check" CHECK ((jsonb_typeof(account_map) = 'object'::text)),
  CONSTRAINT "invoice_sources_base_url_check" CHECK (((base_url ~ '^https://[^[:space:]/?#]+(/[^[:space:]?#]*[^[:space:]?#/])?$'::text) AND (length(base_url) <= 500))),
  CONSTRAINT "invoice_sources_base_url_key" UNIQUE (base_url),
  CONSTRAINT "invoice_sources_key_version_check" CHECK ((key_version > 0)),
  CONSTRAINT "invoice_sources_last_error_check" CHECK ((length(last_error) <= 1000)),
  CONSTRAINT "invoice_sources_lease_check" CHECK (((lease_run_id IS NULL) = (lease_until IS NULL))),
  CONSTRAINT "invoice_sources_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT "invoice_sources_party_map_check" CHECK ((jsonb_typeof(party_map) = 'object'::text)),
  CONSTRAINT "invoice_sources_pkey" PRIMARY KEY (id),
  CONSTRAINT "invoice_sources_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'auth_failed'::text, 'disconnected'::text]))),
  CONSTRAINT "invoice_sources_version_check" CHECK ((version > 0))
);

ALTER TABLE accounting.invoice_sources ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS accounting.invoices (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "number" text DEFAULT ''::text NOT NULL,
  "project_ref" text NOT NULL,
  "project_name" text DEFAULT ''::text NOT NULL,
  "customer_name" text DEFAULT ''::text NOT NULL,
  "issue_date" date NOT NULL,
  "due_date" date,
  "status" text NOT NULL,
  "total_cents" bigint NOT NULL,
  "lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "payments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_updated_at" timestamp with time zone,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "invoices_customer_name_check" CHECK ((length(customer_name) <= 200)),
  CONSTRAINT "invoices_external_id_check" CHECK (((length(external_id) >= 1) AND (length(external_id) <= 200))),
  CONSTRAINT "invoices_lines_check" CHECK ((jsonb_typeof(lines) = 'array'::text)),
  CONSTRAINT "invoices_number_check" CHECK ((length(number) <= 100)),
  CONSTRAINT "invoices_payments_check" CHECK ((jsonb_typeof(payments) = 'array'::text)),
  CONSTRAINT "invoices_pkey" PRIMARY KEY (id),
  CONSTRAINT "invoices_project_name_check" CHECK ((length(project_name) <= 200)),
  CONSTRAINT "invoices_project_ref_check" CHECK (((length(project_ref) >= 1) AND (length(project_ref) <= 200))),
  CONSTRAINT "invoices_source_id_external_id_key" UNIQUE (source_id, external_id),
  CONSTRAINT "invoices_source_id_fkey" FOREIGN KEY (source_id) REFERENCES accounting.invoice_sources(id) ON DELETE RESTRICT,
  CONSTRAINT "invoices_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'paid'::text, 'void'::text]))),
  CONSTRAINT "invoices_total_cents_check" CHECK ((total_cents >= 0)),
  CONSTRAINT "invoices_version_check" CHECK ((version > 0))
);

ALTER TABLE accounting.invoices ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS accounting.invoice_payments (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "invoice_id" uuid NOT NULL,
  "entry_id" uuid NOT NULL,
  "amount_cents" bigint NOT NULL,
  "matched_by" text NOT NULL,
  "sync_state" text DEFAULT 'pending'::text NOT NULL,
  "attempts" smallint DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "external_payment_id" text,
  "last_error" text DEFAULT ''::text NOT NULL,
  "removed_at" timestamp with time zone,
  "removed_reason" text DEFAULT ''::text NOT NULL,
  "created_by" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "invoice_payments_amount_cents_check" CHECK ((amount_cents > 0)),
  CONSTRAINT "invoice_payments_attempts_check" CHECK ((attempts >= 0)),
  CONSTRAINT "invoice_payments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "invoice_payments_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES accounting.invoices(id) ON DELETE RESTRICT,
  CONSTRAINT "invoice_payments_last_error_check" CHECK ((length(last_error) <= 1000)),
  CONSTRAINT "invoice_payments_matched_by_check" CHECK ((matched_by = ANY (ARRAY['rule'::text, 'owner'::text]))),
  CONSTRAINT "invoice_payments_pkey" PRIMARY KEY (id),
  CONSTRAINT "invoice_payments_removed_check" CHECK ((((sync_state <> ALL (ARRAY['removing'::text, 'removed'::text])) OR (removed_at IS NOT NULL)) AND ((removed_at IS NULL) OR (length(btrim(removed_reason)) > 0)))),
  CONSTRAINT "invoice_payments_sync_state_check" CHECK ((sync_state = ANY (ARRAY['pending'::text, 'synced'::text, 'removing'::text, 'removed'::text, 'failed'::text]))),
  CONSTRAINT "invoice_payments_version_check" CHECK ((version > 0))
);

ALTER TABLE accounting.invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS accounting.earned_work (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "external_ref" text NOT NULL,
  "project_ref" text NOT NULL,
  "earned_from" date NOT NULL,
  "earned_to" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "earned_work_amount_cents_check" CHECK ((amount_cents > 0)),
  CONSTRAINT "earned_work_dates_check" CHECK ((earned_to >= earned_from)),
  CONSTRAINT "earned_work_external_ref_check" CHECK (((length(external_ref) >= 1) AND (length(external_ref) <= 200))),
  CONSTRAINT "earned_work_kind_check" CHECK ((kind = ANY (ARRAY['time'::text, 'scheduled'::text]))),
  CONSTRAINT "earned_work_pkey" PRIMARY KEY (id),
  CONSTRAINT "earned_work_project_ref_check" CHECK (((length(project_ref) >= 1) AND (length(project_ref) <= 200))),
  CONSTRAINT "earned_work_source_id_fkey" FOREIGN KEY (source_id) REFERENCES accounting.invoice_sources(id) ON DELETE RESTRICT,
  CONSTRAINT "earned_work_source_id_kind_external_ref_key" UNIQUE (source_id, kind, external_ref)
);

ALTER TABLE accounting.earned_work ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS earned_work_dates ON accounting.earned_work USING btree (source_id, earned_from);

CREATE INDEX IF NOT EXISTS invoice_payments_entry ON accounting.invoice_payments USING btree (entry_id);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_live ON accounting.invoice_payments USING btree (invoice_id, entry_id) WHERE (removed_at IS NULL);

CREATE INDEX IF NOT EXISTS invoice_payments_outbox ON accounting.invoice_payments USING btree (next_attempt_at) WHERE (sync_state = ANY (ARRAY['pending'::text, 'removing'::text]));

CREATE INDEX IF NOT EXISTS invoices_project ON accounting.invoices USING btree (source_id, project_ref);

REVOKE ALL ON TABLE accounting.invoice_sources FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.invoice_sources TO "postgres";

GRANT SELECT ON TABLE accounting.invoice_sources TO "postgres";

GRANT UPDATE ON TABLE accounting.invoice_sources TO "postgres";

GRANT DELETE ON TABLE accounting.invoice_sources TO "postgres";

GRANT TRUNCATE ON TABLE accounting.invoice_sources TO "postgres";

GRANT REFERENCES ON TABLE accounting.invoice_sources TO "postgres";

GRANT TRIGGER ON TABLE accounting.invoice_sources TO "postgres";

GRANT MAINTAIN ON TABLE accounting.invoice_sources TO "postgres";

REVOKE ALL ON TABLE accounting.invoices FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.invoices TO "postgres";

GRANT SELECT ON TABLE accounting.invoices TO "postgres";

GRANT UPDATE ON TABLE accounting.invoices TO "postgres";

GRANT DELETE ON TABLE accounting.invoices TO "postgres";

GRANT TRUNCATE ON TABLE accounting.invoices TO "postgres";

GRANT REFERENCES ON TABLE accounting.invoices TO "postgres";

GRANT TRIGGER ON TABLE accounting.invoices TO "postgres";

GRANT MAINTAIN ON TABLE accounting.invoices TO "postgres";

REVOKE ALL ON TABLE accounting.invoice_payments FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.invoice_payments TO "postgres";

GRANT SELECT ON TABLE accounting.invoice_payments TO "postgres";

GRANT UPDATE ON TABLE accounting.invoice_payments TO "postgres";

GRANT DELETE ON TABLE accounting.invoice_payments TO "postgres";

GRANT TRUNCATE ON TABLE accounting.invoice_payments TO "postgres";

GRANT REFERENCES ON TABLE accounting.invoice_payments TO "postgres";

GRANT TRIGGER ON TABLE accounting.invoice_payments TO "postgres";

GRANT MAINTAIN ON TABLE accounting.invoice_payments TO "postgres";

REVOKE ALL ON TABLE accounting.earned_work FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.earned_work TO "postgres";

GRANT SELECT ON TABLE accounting.earned_work TO "postgres";

GRANT UPDATE ON TABLE accounting.earned_work TO "postgres";

GRANT DELETE ON TABLE accounting.earned_work TO "postgres";

GRANT TRUNCATE ON TABLE accounting.earned_work TO "postgres";

GRANT REFERENCES ON TABLE accounting.earned_work TO "postgres";

GRANT TRIGGER ON TABLE accounting.earned_work TO "postgres";

GRANT MAINTAIN ON TABLE accounting.earned_work TO "postgres";

CREATE OR REPLACE FUNCTION accounting.live_invoice_payments()
 RETURNS TABLE(id uuid, invoice_id uuid, entry_id uuid, amount_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- A link counts while it is not removed, its deposit is neither discarded nor reversed, and its invoice is neither voided nor gone from the source.
 SELECT p.id,p.invoice_id,p.entry_id,p.amount_cents
 FROM accounting.invoice_payments p
 JOIN accounting.journal_entries e ON e.id=p.entry_id
 JOIN accounting.invoices i ON i.id=p.invoice_id
 WHERE p.removed_at IS NULL AND e.status<>'discarded' AND i.removed_at IS NULL AND i.status<>'void'
  AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id=e.id)
$function$
;

CREATE OR REPLACE FUNCTION accounting.open_invoices()
 RETURNS TABLE(invoice_id uuid, source_id uuid, party_id uuid, number text, project_name text, issue_date date, outstanding_cents bigint, auto_link boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- Issued invoices the books still see money owed on: the total less every link that counts. The client is the contact the source project maps to.
 SELECT i.id,i.source_id,
  CASE WHEN s.party_map->>i.project_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (s.party_map->>i.project_ref)::uuid END,
  i.number,i.project_name,i.issue_date,i.total_cents-coalesce(l.linked,0),s.auto_link AND s.status='active'
 FROM accounting.invoices i
 JOIN accounting.invoice_sources s ON s.id=i.source_id
 LEFT JOIN (SELECT p.invoice_id,sum(p.amount_cents)::bigint linked FROM accounting.live_invoice_payments() p GROUP BY p.invoice_id) l ON l.invoice_id=i.id
 WHERE i.removed_at IS NULL AND i.status IN ('issued','paid') AND s.status<>'disconnected' AND i.total_cents-coalesce(l.linked,0)>0
$function$
;

CREATE OR REPLACE FUNCTION accounting.invoice_payment_live(link uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT EXISTS(SELECT 1 FROM accounting.live_invoice_payments() p WHERE p.id=link)
$function$
;

CREATE OR REPLACE FUNCTION accounting.accrual_accounts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb:='{}'; p record; found_id uuid;
BEGIN
 -- The accrual view's own balance sheet lines, created once. No real journal line ever posts to them: the guard refuses it.
 FOR p IN SELECT * FROM (VALUES('accounts_receivable','Invoices receivable','asset','receivable',1),('unbilled_revenue','Unbilled work','asset','receivable',2),('deferred_revenue','Billed in advance','liability','deferred_revenue',3)) v(purpose,name,type,subtype,n) ORDER BY n LOOP
  SELECT id INTO found_id FROM accounting.accounts WHERE system_purpose=p.purpose;
  IF found_id IS NULL THEN INSERT INTO accounting.accounts(name,type,subtype,system_purpose) VALUES(p.name,p.type,p.subtype,p.purpose) RETURNING id INTO found_id; END IF;
  result:=result||jsonb_build_object(p.purpose,found_id);
 END LOOP;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.invoice_candidates(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE dep record; remaining bigint; reason text; picked uuid[]; n integer:=0; auto boolean:=false;
BEGIN
 -- Only a deposit into a bank or cash account can pay an invoice: never a transfer, a discarded draft or a reversed entry.
 SELECT e.id,e.entry_date,e.payee_id,
  (SELECT sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash')) bank_cents,
  (SELECT -sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype NOT IN ('bank','cash','card') AND l.amount_cents<0) credit_cents
 INTO dep FROM accounting.journal_entries e
 WHERE e.id=entry AND e.status<>'discarded' AND e.reverses_entry_id IS NULL AND e.transfer_group_id IS NULL AND e.pair_entry_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id=e.id);
 IF dep.id IS NULL OR coalesce(dep.bank_cents,0)<=0 OR coalesce(dep.credit_cents,0)<=0 THEN RETURN NULL; END IF;
 remaining:=dep.credit_cents-coalesce((SELECT sum(p.amount_cents) FROM accounting.live_invoice_payments() p WHERE p.entry_id=entry),0);
 IF remaining<=0 THEN RETURN NULL; END IF;
 IF dep.payee_id IS NOT NULL THEN
  -- The deposit's client has an open invoice for exactly what is left. Two of the same amount suggest the oldest and never link on their own.
  SELECT count(*),(array_agg(o.invoice_id ORDER BY o.issue_date,o.number,o.invoice_id))[1:1],bool_and(o.auto_link) INTO n,picked,auto
  FROM accounting.open_invoices() o WHERE o.party_id=dep.payee_id AND o.outstanding_cents=remaining AND o.issue_date<=dep.entry_date;
  IF n>=1 THEN reason:='exact_client'; auto:=n=1 AND coalesce(auto,false);
  ELSE
   -- Two to six of the client's invoices, the six oldest, that together come to exactly what is left.
   WITH RECURSIVE pool AS (
    SELECT row_number() OVER (ORDER BY o.issue_date,o.number,o.invoice_id)::integer n,o.invoice_id,o.outstanding_cents
    FROM (SELECT * FROM accounting.open_invoices() x WHERE x.party_id=dep.payee_id AND x.issue_date<=dep.entry_date ORDER BY x.issue_date,x.number,x.invoice_id LIMIT 6) o),
   sets(last_n,path,ids,total) AS (
    SELECT p.n,ARRAY[p.n],ARRAY[p.invoice_id],p.outstanding_cents FROM pool p WHERE p.outstanding_cents<remaining
    UNION ALL
    SELECT p.n,s.path||p.n,s.ids||p.invoice_id,s.total+p.outstanding_cents FROM sets s JOIN pool p ON p.n>s.last_n WHERE s.total+p.outstanding_cents<=remaining)
   SELECT count(*) OVER (),s.ids INTO n,picked FROM sets s WHERE s.total=remaining AND cardinality(s.ids)>=2 ORDER BY s.path LIMIT 1;
   IF coalesce(n,0)>=1 THEN reason:='sum_client'; auto:=false; END IF;
  END IF;
 ELSE
  -- An unknown payer: only one open invoice anywhere at exactly this amount is worth suggesting.
  SELECT count(*),(array_agg(o.invoice_id))[1:1] INTO n,picked FROM accounting.open_invoices() o WHERE o.outstanding_cents=remaining AND o.issue_date<=dep.entry_date;
  IF n=1 THEN reason:='exact_amount'; END IF;
  auto:=false;
 END IF;
 IF reason IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('reason',reason,'auto',coalesce(auto,false),'ambiguous',coalesce(n,0)>1,'remaining_cents',remaining::text,
  'invoices',(SELECT coalesce(jsonb_agg(jsonb_build_object('invoice_id',o.invoice_id,'number',o.number,'project_name',o.project_name,'issue_date',o.issue_date,'amount_cents',o.outstanding_cents::text) ORDER BY o.issue_date,o.number,o.invoice_id),'[]')
   FROM accounting.open_invoices() o WHERE o.invoice_id=ANY(picked)));
END $function$
;

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
  -- Each line type goes to one revenue account (a reimbursement may reduce an expense instead), never a suspense or accrual account.
  IF c ? 'account_map' THEN
   IF jsonb_typeof(c->'account_map') IS DISTINCT FROM 'object' OR EXISTS(
    SELECT 1 FROM jsonb_each(c->'account_map') m LEFT JOIN accounting.accounts a ON a.id::text=lower(m.value#>>'{}')
    WHERE m.key NOT IN ('hourly','fixed','recurring','reimbursement') OR jsonb_typeof(m.value) IS DISTINCT FROM 'string' OR a.id IS NULL OR a.is_archived
     OR NOT (a.type='income' OR (m.key='reimbursement' AND a.type='expense'))
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

CREATE OR REPLACE FUNCTION accounting.invoice_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE syncing boolean:=coalesce(current_setting('accounting.action',true),'')='invoice_source.sync'; counts boolean;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 -- The mirror and earned work are the source's word: only a sync writes them, and earned work is replaced whole each time.
 IF TG_TABLE_NAME IN ('invoices','earned_work') AND NOT syncing THEN RAISE EXCEPTION 'ACCT_SOURCE_ONLY'; END IF;
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='earned_work' THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; RETURN OLD; END IF;
  RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  -- Each branch names only its own table's columns: a record field is resolved when the expression runs.
  IF TG_TABLE_NAME='invoices' THEN
   IF (NEW.source_id,NEW.external_id) IS DISTINCT FROM (OLD.source_id,OLD.external_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  ELSIF TG_TABLE_NAME='earned_work' THEN
   IF (NEW.source_id,NEW.kind,NEW.external_ref) IS DISTINCT FROM (OLD.source_id,OLD.kind,OLD.external_ref) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  ELSIF TG_TABLE_NAME='invoice_payments' THEN
   -- A link is fixed once made: it can only end, and an ended link never comes back.
   IF (NEW.invoice_id,NEW.entry_id,NEW.amount_cents,NEW.matched_by,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.invoice_id,OLD.entry_id,OLD.amount_cents,OLD.matched_by,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'ACCT_LINK_IMMUTABLE'; END IF;
   IF OLD.removed_at IS NOT NULL AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_reason IS DISTINCT FROM OLD.removed_reason) THEN RAISE EXCEPTION 'ACCT_LINK_IMMUTABLE'; END IF;
  END IF;
 END IF;
 -- What the accrual view reads moved, so the books revision moves with it. Push bookkeeping and sync times do not count.
 IF TG_OP='INSERT' OR TG_TABLE_NAME NOT IN ('invoice_payments','invoice_sources') THEN counts:=true;
 ELSIF TG_TABLE_NAME='invoice_payments' THEN counts:=NEW.removed_at IS DISTINCT FROM OLD.removed_at;
 ELSE counts:=(NEW.account_map,NEW.party_map,NEW.status) IS DISTINCT FROM (OLD.account_map,OLD.party_map,OLD.status);
 END IF;
 IF counts THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'earned_work' THEN NEW.version:=OLD.version+1; NEW.updated_at:=now(); END IF;
 RETURN NEW;
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

CREATE OR REPLACE FUNCTION accounting.record_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE b jsonb; a jsonb; payload jsonb; actor uuid:=auth.uid(); op uuid; kind text; identity text; action_name text; money_key text;
BEGIN
 b:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END; a:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='settings' AND TG_OP='UPDATE' AND (b-'financial_revision')=(a-'financial_revision') THEN RETURN NULL; END IF;
 FOR money_key IN SELECT unnest(ARRAY['amount_cents','financial_revision','size_bytes','observed_balance_cents','gross_cents','net_cents','employee_withholding_cents','employer_tax_cents','difference_cents','opening_balance_cents','ending_balance_cents','total_cents']) LOOP
  IF b?money_key AND b->money_key<>'null'::jsonb THEN b:=jsonb_set(b,ARRAY[money_key],to_jsonb(b->>money_key)); END IF;
  IF a?money_key AND a->money_key<>'null'::jsonb THEN a:=jsonb_set(a,ARRAY[money_key],to_jsonb(a->>money_key)); END IF;
 END LOOP;
 IF TG_TABLE_NAME='bank_connections' THEN
  b:=b-ARRAY['access_url_encrypted','checkpoint','last_error']; a:=a-ARRAY['access_url_encrypted','checkpoint','last_error'];
 END IF;
 IF TG_TABLE_NAME='bank_transactions' THEN b:=b-'raw_payload'; a:=a-'raw_payload'; END IF;
 IF TG_TABLE_NAME='invoice_sources' THEN b:=b-ARRAY['api_key_encrypted','lease_run_id','lease_until']; a:=a-ARRAY['api_key_encrypted','lease_run_id','lease_until']; END IF;
 IF TG_TABLE_NAME='tax_links' THEN b:=b-ARRAY['inputs','results','forecast_inputs']; a:=a-ARRAY['inputs','results','forecast_inputs']; END IF;
 op:=coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid());
 kind:=coalesce(nullif(current_setting('accounting.actor_kind',true),''),CASE WHEN actor IS NULL THEN 'system' ELSE 'owner' END);
 IF kind NOT IN ('owner','api') THEN actor:=NULL; END IF;
 payload:=coalesce(a,b); identity:=coalesce(payload->>'id',payload->>'month',payload->>'idempotency_key','1');
 action_name:=coalesce(nullif(current_setting('accounting.action',true),''),lower(TG_OP));
 INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after,reason)
 VALUES(actor,kind,op,TG_TABLE_NAME,CASE WHEN identity ~ '^[0-9a-f-]{36}$' THEN identity::uuid ELSE md5(TG_TABLE_NAME||':'||identity)::uuid END,action_name,b,a,coalesce(nullif(current_setting('accounting.reason',true),''),payload->>'reason',''));
 IF TG_TABLE_NAME IN ('accounts','journal_entries','journal_lines','tax_mappings','tax_adjustments','payroll_runs','registers') THEN
  UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 END IF;
 RETURN NULL;
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
   -- Who or what categorized a posted entry is fixed with it; only the one-time history backfill may fill a source the books never recorded.
   IF OLD.status='posted' AND (to_jsonb(NEW)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']-CASE WHEN OLD.category_source IS NULL AND current_setting('accounting.action',true)='entry.source.backfill' THEN ARRAY['category_source','category_actor'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','review_pending','version','updated_at']-CASE WHEN OLD.category_source IS NULL AND current_setting('accounting.action',true)='entry.source.backfill' THEN ARRAY['category_source','category_actor'] ELSE ARRAY[]::text[] END) THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
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
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind',CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'api' ELSE 'owner' END,true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t='settings.save' AND NOT EXISTS(SELECT 1 FROM accounting.settings) THEN
  IF actor IS NULL OR (EXISTS(SELECT 1 FROM public.team_members) AND coalesce(public.current_team_member_role(),'')<>'owner') THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO accounting.settings(owner_user_id) VALUES(actor); initialized:=true;
 END IF;
 actor:=accounting.require_owner(); hash:=encode(sha256(convert_to(c::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM accounting.command_receipts WHERE idempotency_key=key;
 IF FOUND THEN
  IF receipt.actor_user_id<>actor OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 IF c?'expected_revision' AND (c->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM accounting.settings WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_REVISION'; END IF;
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind',CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'api' ELSE 'owner' END,true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t IN ('settings.save','preferences.save') THEN
  SELECT version INTO current_version FROM accounting.settings WHERE id=1;
  IF (c->>'expected_version')::integer IS DISTINCT FROM current_version AND NOT (initialized AND coalesce((c->>'expected_version')::integer,0)=0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF c ? 'accrual_start' AND c->>'accrual_start' IS NOT NULL AND extract(day FROM (c->>'accrual_start')::date)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_ACCRUAL_START'; END IF;
  UPDATE accounting.settings SET primary_system=coalesce(c->>'primary_system',CASE c->>'authority_mode' WHEN 'admin_primary' THEN 'admin' WHEN 'wave_primary' THEN 'wave' WHEN 'parallel_pilot' THEN 'wave' END,primary_system),
   primary_system_since=CASE WHEN c?'primary_system_since' THEN (c->>'primary_system_since')::date ELSE primary_system_since END,
   transfer_window_days=coalesce((c->>'transfer_window_days')::smallint,transfer_window_days),accrual_start=CASE WHEN c ? 'accrual_start' THEN (c->>'accrual_start')::date ELSE accrual_start END,financial_revision=financial_revision+CASE WHEN c ? 'accrual_start' AND (c->>'accrual_start')::date IS DISTINCT FROM accrual_start THEN 1 ELSE 0 END,version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
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
 ELSIF t LIKE 'period.%' OR t LIKE 'reconciliation.%' THEN result:=accounting.close_command(c);
 ELSIF t LIKE 'payroll.%' OR t LIKE 'register.%' THEN result:=accounting.register_command(c);
 ELSIF t LIKE 'tax.%' THEN result:=accounting.tax_command(c);
 ELSIF t LIKE 'report.%' OR t LIKE 'package.%' THEN result:=accounting.report_command(c);
 ELSIF t LIKE 'invoice.%' OR t LIKE 'invoice_source.%' THEN result:=accounting.invoice_command(c);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 INSERT INTO accounting.command_receipts(idempotency_key,payload_hash,actor_user_id,result) VALUES(key,hash,actor,result);
 RETURN result;
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
 PERFORM accounting.require_reader();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'restored_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE restores_entry_id=e.id),
  'replacement_entry_id',(SELECT id FROM accounting.journal_entries WHERE replaces_entry_id=e.id LIMIT 1),
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted' ORDER BY pay_date,id LIMIT 1),
  'payroll_run_ids',(SELECT coalesce(jsonb_agg(id ORDER BY pay_date,id),'[]'::jsonb) FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (coalesce(p.ytd->'patriot_import',p.ytd->'gusto_import')->>'original_entry_id'=e.id::text AND coalesce(p.ytd->'patriot_import',p.ytd->'gusto_import')->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
  -- The own account on the other side of a linked transfer, so either leg can name where the money went or came from.
  'transfer_account_id',CASE WHEN e.transfer_group_id IS NOT NULL THEN (SELECT l.account_id FROM accounting.journal_entries g JOIN accounting.journal_lines l ON l.entry_id=g.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE g.transfer_group_id=e.transfer_group_id AND g.id<>e.id AND g.reverses_entry_id IS NULL AND a.subtype IN ('bank','card','cash') ORDER BY g.entry_date,l.sort_order LIMIT 1) END,
  'payee_name',(SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),
  -- Who or what chose the category, kept through review: a person, an API key's member, a rule, the books' own fill, a matched transfer or an import.
  'categorized_by',CASE WHEN e.category_source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('source',e.category_source,
   'self',CASE WHEN e.category_actor IS NOT NULL THEN e.category_actor=auth.uid() END,
   'actor_name',(SELECT m.name FROM public.team_members m WHERE m.auth_user_id=e.category_actor),
   'actor_role',(SELECT m.role FROM public.team_members m WHERE m.auth_user_id=e.category_actor),
   'rule_name',CASE WHEN e.category_source='rule' THEN (SELECT r.name FROM accounting.rules r WHERE r.id=e.applied_rule_id) END)) END,
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
 -- The invoices this deposit pays, and the open invoices it looks like it pays while some of it is still unapplied.
 result:=result||jsonb_build_object('invoice_links',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'invoice_id',i.id,'number',i.number,'project_name',i.project_name,'amount_cents',p.amount_cents::text,'matched_by',p.matched_by,'sync_state',p.sync_state,'last_error',p.last_error,'live',accounting.invoice_payment_live(p.id)) ORDER BY i.issue_date,i.number,p.id),'[]') FROM accounting.invoice_payments p JOIN accounting.invoices i ON i.id=p.invoice_id WHERE p.entry_id=entry AND p.removed_at IS NULL));
 extra:=accounting.invoice_candidates(entry);
 IF extra IS NOT NULL THEN result:=result||jsonb_build_object('invoice_suggestion',extra); END IF;
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION accounting.live_invoice_payments() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.live_invoice_payments() TO "postgres";

REVOKE ALL ON FUNCTION accounting.open_invoices() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.open_invoices() TO "postgres";

REVOKE ALL ON FUNCTION accounting.invoice_payment_live(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.invoice_payment_live(uuid) TO "postgres";

REVOKE ALL ON FUNCTION accounting.accrual_accounts() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.accrual_accounts() TO "postgres";

REVOKE ALL ON FUNCTION accounting.invoice_candidates(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.invoice_candidates(uuid) TO "postgres";

REVOKE ALL ON FUNCTION accounting.invoice_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.invoice_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.invoice_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.invoice_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.receivables(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.receivables(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.receivables(jsonb) TO "authenticated";

DROP TRIGGER IF EXISTS audit ON accounting.invoice_sources;

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.invoice_sources FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

DROP TRIGGER IF EXISTS guard ON accounting.invoice_sources;

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.invoice_sources FOR EACH ROW EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS write_lock ON accounting.invoice_sources;

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.invoice_sources FOR EACH STATEMENT EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS audit ON accounting.invoices;

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.invoices FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

DROP TRIGGER IF EXISTS guard ON accounting.invoices;

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.invoices FOR EACH ROW EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS write_lock ON accounting.invoices;

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.invoices FOR EACH STATEMENT EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS audit ON accounting.invoice_payments;

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.invoice_payments FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

DROP TRIGGER IF EXISTS guard ON accounting.invoice_payments;

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.invoice_payments FOR EACH ROW EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS write_lock ON accounting.invoice_payments;

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.invoice_payments FOR EACH STATEMENT EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS guard ON accounting.earned_work;

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.earned_work FOR EACH ROW EXECUTE FUNCTION accounting.invoice_guard();

DROP TRIGGER IF EXISTS write_lock ON accounting.earned_work;

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.earned_work FOR EACH STATEMENT EXECUTE FUNCTION accounting.invoice_guard();

COMMIT;
