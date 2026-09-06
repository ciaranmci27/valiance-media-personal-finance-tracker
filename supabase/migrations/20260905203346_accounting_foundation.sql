-- First accounting foundation. Provision the owner separately after applying.
BEGIN;

-- ACCOUNTING FOUNDATION BEGIN
-- Declarative accounting definitions. Owner provisioning is an operator action.
CREATE TABLE public.acct_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  books_timezone text NOT NULL DEFAULT 'America/Phoenix',
  financial_revision bigint NOT NULL DEFAULT 0 CHECK (financial_revision >= 0)
);
CREATE TABLE public.acct_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL DEFAULT '' CHECK (length(code) <= 20),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','equity','income','expense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit','credit')),
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX acct_account_code_unique ON public.acct_accounts(code) WHERE code <> '';
CREATE TABLE public.acct_periods (
  month_start date PRIMARY KEY CHECK (extract(day FROM month_start) = 1),
  is_locked boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date date NOT NULL CHECK (entry_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  memo text NOT NULL CHECK (length(btrim(memo)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','discarded')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  primary_origin text NOT NULL DEFAULT 'manual' CHECK (primary_origin IN ('manual','wave','simplefin','csv','internal')),
  reverses_entry_id uuid UNIQUE REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE INDEX acct_entries_date ON public.acct_journal_entries(entry_date, created_at, id);
CREATE TABLE public.acct_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.acct_accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND amount_cents > '-9223372036854775808'::bigint),
  memo text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
  UNIQUE (entry_id, sort_order)
);
CREATE INDEX acct_lines_account ON public.acct_journal_lines(account_id, entry_id);
CREATE TABLE public.acct_command_receipts (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  action text NOT NULL,
  actor_id uuid,
  operation_id text,
  before_value jsonb,
  after_value jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL CHECK (source_system IN ('wave','simplefin','csv','manual','internal')),
  source_scope text NOT NULL,
  external_id text NOT NULL,
  content_hash text NOT NULL,
  raw_payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_system, source_scope, external_id, content_hash)
);
CREATE TABLE public.acct_source_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES public.acct_source_records(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  UNIQUE(source_record_id, entry_id)
);
CREATE TABLE public.acct_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE,
  original_name text NOT NULL,
  content_hash text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.acct_documents(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  UNIQUE(document_id, entry_id)
);

CREATE OR REPLACE FUNCTION public.acct_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM public.acct_settings WHERE owner_user_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.acct_require_owner() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.acct_is_owner() THEN RAISE EXCEPTION 'ACCT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN auth.uid();
END $$;

-- One company's low-volume writes serialize on one row. Period locks use the
-- same row, avoiding lock-order races before taking entry/account locks.
CREATE OR REPLACE FUNCTION public.acct_write_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.acct_settings WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_CONFIGURED'; END IF;
END $$;
-- Acquire the company lock before tuple locks, including privileged direct DML.
CREATE OR REPLACE FUNCTION public.acct_lock_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_accounts','acct_periods','acct_journal_entries','acct_journal_lines'] LOOP
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.acct_require_open(p_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_month date := date_trunc('month',p_date)::date;
BEGIN
  PERFORM public.acct_write_lock();
  INSERT INTO public.acct_periods(month_start) VALUES(v_month) ON CONFLICT DO NOTHING;
  IF (SELECT is_locked FROM public.acct_periods WHERE month_start=v_month) THEN
    RAISE EXCEPTION 'ACCT_PERIOD_LOCKED';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.acct_guard_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
    IF NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.primary_origin <> OLD.primary_origin OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id THEN
      RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY';
    END IF;
    PERFORM public.acct_require_open(OLD.entry_date);
    NEW.version := OLD.version + 1;
  ELSIF NEW.status <> 'draft' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'ACCT_CREATE_DRAFT_FIRST';
  END IF;
  PERFORM public.acct_require_open(NEW.entry_date);
  RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_entry BEFORE INSERT OR UPDATE OR DELETE ON public.acct_journal_entries
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_entry();

CREATE OR REPLACE FUNCTION public.acct_guard_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_entry public.acct_journal_entries;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='UPDATE' AND (NEW.entry_id <> OLD.entry_id OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY';
  END IF;
  SELECT * INTO v_entry FROM public.acct_journal_entries
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END FOR UPDATE;
  IF v_entry.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  PERFORM public.acct_require_open(v_entry.entry_date);
  IF TG_OP <> 'DELETE' AND EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=NEW.account_id AND is_archived) THEN
    RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_line BEFORE INSERT OR UPDATE OR DELETE ON public.acct_journal_lines
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_line();

CREATE OR REPLACE FUNCTION public.acct_assert_balanced(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer; v_sum numeric;
BEGIN
  SELECT count(*),coalesce(sum(amount_cents),0) INTO v_count,v_sum FROM public.acct_journal_lines WHERE entry_id=p_id;
  IF v_count < 2 OR v_count > 100 OR v_sum <> 0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.acct_balance_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF TG_TABLE_NAME='acct_journal_entries' THEN v_id := NEW.id;
  ELSE v_id := CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_id AND status='posted') THEN
    PERFORM public.acct_assert_balanced(v_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER acct_entry_balance AFTER INSERT OR UPDATE ON public.acct_journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_balance_constraint();
CREATE CONSTRAINT TRIGGER acct_line_balance AFTER INSERT OR UPDATE OR DELETE ON public.acct_journal_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_balance_constraint();

CREATE OR REPLACE FUNCTION public.acct_guard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id <> OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
    IF (NEW.account_type <> OLD.account_type OR NEW.normal_side <> OLD.normal_side)
       AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE account_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
    IF NEW.is_archived AND NOT OLD.is_archived AND EXISTS(
      SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=OLD.id AND e.status IN ('draft','posted')
      HAVING coalesce(sum(l.amount_cents) FILTER(WHERE e.status='posted'),0) <> 0 OR count(*) FILTER(WHERE e.status='draft') > 0
    ) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_account BEFORE INSERT OR UPDATE OR DELETE ON public.acct_accounts
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_account();
CREATE OR REPLACE FUNCTION public.acct_guard_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' AND NEW.month_start <> OLD.month_start THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  IF NEW.is_locked AND (TG_OP='INSERT' OR NOT OLD.is_locked) THEN
    IF length(btrim(NEW.reason))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='draft'
      AND entry_date >= NEW.month_start AND entry_date < NEW.month_start + INTERVAL '1 month') THEN
      RAISE EXCEPTION 'ACCT_DRAFTS_REMAIN';
    END IF;
  END IF;
  NEW.changed_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_period BEFORE INSERT OR UPDATE OR DELETE ON public.acct_periods
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_period();

CREATE OR REPLACE FUNCTION public.acct_record_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_before jsonb; v_after jsonb; v_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_before:=to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_after:=to_jsonb(NEW); END IF;
  -- JSON numbers lose bigint precision in browsers, including nested audit values.
  FOREACH v_key IN ARRAY ARRAY['amount_cents','financial_revision','size_bytes'] LOOP
    IF v_before ? v_key THEN v_before:=v_before||jsonb_build_object(v_key,v_before->>v_key); END IF;
    IF v_after ? v_key THEN v_after:=v_after||jsonb_build_object(v_key,v_after->>v_key); END IF;
  END LOOP;
  INSERT INTO public.acct_audit_log(table_name,action,actor_id,operation_id,before_value,after_value)
  VALUES(TG_TABLE_NAME,TG_OP,auth.uid(),nullif(current_setting('acct.operation_id',true),''),
    v_before,v_after);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.acct_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_settings','acct_accounts','acct_periods','acct_journal_entries','acct_journal_lines','acct_source_links','acct_documents','acct_document_links'] LOOP
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_audit()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['acct_audit_log','acct_command_receipts','acct_source_records','acct_source_links','acct_documents','acct_document_links'] LOOP
    EXECUTE format('CREATE TRIGGER acct_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.acct_command(p_key uuid, p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := public.acct_require_owner(); v_receipt public.acct_command_receipts;
  v_type text := p_command->>'type'; v_id uuid := (p_command->>'id')::uuid;
  v_entry public.acct_journal_entries; v_new_id uuid; v_result jsonb; v_line jsonb; v_index integer:=0;
BEGIN
  IF p_key IS NULL OR v_id IS NULL OR p_command IS NULL OR octet_length(p_command::text)>100000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();
  -- Recheck after waiting in case an operator changed the owner meanwhile.
  v_actor:=public.acct_require_owner();
  SELECT * INTO v_receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF v_receipt.actor_id<>v_actor OR v_receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN v_receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF v_type='account.create' THEN
    INSERT INTO public.acct_accounts(id,code,name,account_type,normal_side)
    VALUES(v_id,coalesce(p_command->>'code',''),btrim(p_command->>'name'),p_command->>'account_type',p_command->>'normal_side');
    v_result:=jsonb_build_object('id',v_id);
  ELSIF v_type='draft.save' THEN
    IF jsonb_typeof(p_command->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'lines')>100 THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id FOR UPDATE;
    IF FOUND THEN
      IF v_entry.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
      IF v_entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
      UPDATE public.acct_journal_entries SET entry_date=(p_command->>'entry_date')::date,memo=btrim(p_command->>'memo') WHERE id=v_id;
      DELETE FROM public.acct_journal_lines WHERE entry_id=v_id;
    ELSE
      IF (p_command->>'expected_version')::integer IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,created_by)
      VALUES(v_id,(p_command->>'entry_date')::date,btrim(p_command->>'memo'),v_actor);
    END IF;
    FOR v_line IN SELECT value FROM jsonb_array_elements(p_command->'lines') LOOP
      IF jsonb_typeof(v_line->'amount_cents') IS DISTINCT FROM 'string' OR (v_line->>'amount_cents') !~ '^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
      INSERT INTO public.acct_journal_lines(entry_id,account_id,amount_cents,memo,sort_order)
      VALUES(v_id,(v_line->>'account_id')::uuid,(v_line->>'amount_cents')::bigint,coalesce(v_line->>'memo',''),v_index);
      v_index:=v_index+1;
    END LOOP;
    SELECT jsonb_build_object('id',id,'version',version) INTO v_result FROM public.acct_journal_entries WHERE id=v_id;
  ELSIF v_type IN ('entry.post','draft.discard','entry.reverse') THEN
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF v_entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF v_type='entry.post' THEN
      IF v_entry.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
      PERFORM public.acct_assert_balanced(v_id);
      IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=v_id AND a.is_archived) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
      UPDATE public.acct_journal_entries SET status='posted',posted_at=now() WHERE id=v_id;
    ELSIF v_type='draft.discard' THEN
      IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
      UPDATE public.acct_journal_entries SET status='discarded' WHERE id=v_id;
    ELSE
      IF v_entry.status<>'posted' THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
      IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
      IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=v_id) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
      v_new_id:=gen_random_uuid();
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,created_by,primary_origin,reverses_entry_id)
      VALUES(v_new_id,(p_command->>'entry_date')::date,p_command->>'reason',v_actor,'internal',v_id);
      INSERT INTO public.acct_journal_lines(entry_id,account_id,amount_cents,memo,sort_order)
      SELECT v_new_id,account_id,-amount_cents,memo,sort_order FROM public.acct_journal_lines WHERE entry_id=v_id;
      UPDATE public.acct_journal_entries SET status='posted',posted_at=now() WHERE id=v_new_id;
      v_id:=v_new_id;
    END IF;
    SELECT jsonb_build_object('id',id,'version',version) INTO v_result FROM public.acct_journal_entries WHERE id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,v_actor,p_command,v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_workspace(p_from date, p_to date, p_entry_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_balances jsonb; v_entries jsonb; v_reports jsonb;
BEGIN
  PERFORM public.acct_require_owner();
  IF p_from IS NULL OR p_to IS NULL OR p_from>p_to OR p_from<DATE '1900-01-01' OR p_to>DATE '2100-12-31' THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  WITH b AS (
    SELECT a.*,coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date<p_from),0) AS opening,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=p_from),0) AS period,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=p_from AND l.amount_cents>0),0) AS debit,
      -coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=p_from AND l.amount_cents<0),0) AS credit,
      coalesce(sum(l.amount_cents),0) AS ending,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date<date_trunc('year',p_to)::date),0) AS prior,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=date_trunc('year',p_to)::date),0) AS current_year
    FROM public.acct_accounts a LEFT JOIN
      (public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id AND e.status='posted' AND e.entry_date<=p_to)
      ON l.account_id=a.id GROUP BY a.id
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,'account_type',account_type,'normal_side',normal_side,'is_archived',is_archived,
      'opening_cents',opening::text,'period_cents',period::text,'debit_cents',debit::text,'credit_cents',credit::text,'ending_cents',ending::text) ORDER BY code,name),'[]'),
    jsonb_build_object(
      'income_cents',(-coalesce(sum(period) FILTER(WHERE account_type='income'),0))::text,
      'expense_cents',coalesce(sum(period) FILTER(WHERE account_type='expense'),0)::text,
      'net_income_cents',(-coalesce(sum(period) FILTER(WHERE account_type IN ('income','expense')),0))::text,
      'assets_cents',coalesce(sum(ending) FILTER(WHERE account_type='asset'),0)::text,
      'liabilities_cents',(-coalesce(sum(ending) FILTER(WHERE account_type='liability'),0))::text,
      'equity_cents',(-coalesce(sum(ending) FILTER(WHERE account_type='equity'),0))::text,
      'retained_cents',(-coalesce(sum(prior) FILTER(WHERE account_type IN ('income','expense')),0))::text,
      'year_income_cents',(-coalesce(sum(current_year) FILTER(WHERE account_type IN ('income','expense')),0))::text,
      'balance_difference_cents',coalesce(sum(ending),0)::text,'trial_balance_cents',coalesce(sum(ending),0)::text)
    INTO v_balances,v_reports FROM b;
  IF v_reports->>'trial_balance_cents'<>'0' THEN RAISE EXCEPTION 'ACCT_INTEGRITY_FAILURE'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY entry_date DESC,created_at DESC,id DESC),'[]') INTO v_entries FROM (
    SELECT e.*,(SELECT r.id FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed_by_entry_id,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order)
      FROM public.acct_journal_lines l WHERE l.entry_id=e.id),'[]') AS lines
    FROM public.acct_journal_entries e WHERE (p_entry_id IS NOT NULL AND e.id=p_entry_id)
      OR (p_entry_id IS NULL AND e.entry_date BETWEEN p_from AND p_to AND e.status<>'discarded')
    ORDER BY entry_date DESC,created_at DESC,id DESC LIMIT 200
  ) q;
  RETURN jsonb_build_object('legal_name',(SELECT legal_name FROM public.acct_settings),'revision',(SELECT financial_revision::text FROM public.acct_settings),
    'from',p_from,'to',p_to,'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY code,name),'[]') FROM public.acct_accounts a),
    'entries',v_entries,'entry_count',(SELECT count(*) FROM public.acct_journal_entries WHERE entry_date BETWEEN p_from AND p_to AND status<>'discarded'),
    'draft_count',(SELECT count(*) FROM public.acct_journal_entries WHERE status='draft' AND entry_date BETWEEN p_from AND p_to),
    'balances',v_balances,'reports',v_reports);
END $$;

CREATE OR REPLACE FUNCTION public.acct_export() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object('format','valiance-accounting-foundation','version',1,'generated_at',now(),
    'coverage_status','unverified','includes_document_files',false,
    'settings',(SELECT (to_jsonb(s)-'owner_user_id')||jsonb_build_object('financial_revision',s.financial_revision::text) FROM public.acct_settings s),
    'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM public.acct_accounts a),
    'entries',(SELECT coalesce(jsonb_agg(to_jsonb(e)),'[]') FROM public.acct_journal_entries e),
    'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text)),'[]') FROM public.acct_journal_lines l),
    'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM public.acct_periods p),
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM public.acct_source_records s),
    'source_links',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM public.acct_source_links s),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('size_bytes',d.size_bytes::text)),'[]') FROM public.acct_documents d),
    'document_links',(SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]') FROM public.acct_document_links d),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text)),'[]') FROM public.acct_audit_log a),
    'command_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM public.acct_command_receipts c));
END $$;

DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_settings','acct_accounts','acct_periods','acct_journal_entries','acct_journal_lines',
    'acct_command_receipts','acct_audit_log','acct_source_records','acct_source_links','acct_documents','acct_document_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role',t);
    -- Read through exact-cent functions only. Table grants stay revoked.
    EXECUTE format('CREATE POLICY acct_owner_read ON public.%I FOR SELECT TO authenticated USING (public.acct_is_owner())',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'acct\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.acct_is_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_command(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_workspace(date,date,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_export() TO authenticated;
-- ACCOUNTING FOUNDATION END

COMMIT;
