-- Daily bookkeeping, source imports, and private evidence.
BEGIN;

-- ACCOUNTING WORKFLOWS BEGIN
-- This module extends the immutable ledger; all writes use acct_execute.
CREATE OR REPLACE FUNCTION public.acct_record_workflow_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_before jsonb;v_after jsonb;v_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN v_before:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN v_after:=to_jsonb(NEW); END IF;
  FOR v_key IN SELECT key FROM jsonb_each(coalesce(v_after,v_before)) WHERE key LIKE '%\_cents' ESCAPE '\' OR key IN ('revision','financial_revision','size_bytes') LOOP
    IF v_before ? v_key THEN v_before:=v_before||jsonb_build_object(v_key,v_before->>v_key); END IF;
    IF v_after ? v_key THEN v_after:=v_after||jsonb_build_object(v_key,v_after->>v_key); END IF;
  END LOOP;
  INSERT INTO public.acct_audit_log(table_name,action,actor_id,operation_id,before_value,after_value) VALUES(TG_TABLE_NAME,TG_OP,auth.uid(),nullif(current_setting('acct.operation_id',true),''),v_before,v_after);
  RETURN NULL;
END $$;
CREATE TABLE public.acct_account_profiles (
  account_id uuid PRIMARY KEY REFERENCES public.acct_accounts(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  purpose text UNIQUE,
  cash_kind text NOT NULL DEFAULT 'none' CHECK(cash_kind IN ('none','bank','cash','card')),
  parent_account_id uuid REFERENCES public.acct_accounts(id) ON DELETE RESTRICT,
  subtype text NOT NULL DEFAULT '' CHECK(length(subtype)<=100),
  CHECK(parent_account_id IS DISTINCT FROM account_id)
);
CREATE TABLE public.acct_book_preferences (
  singleton boolean PRIMARY KEY DEFAULT true REFERENCES public.acct_settings(singleton),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  authority_mode text NOT NULL DEFAULT 'wave_primary' CHECK(authority_mode IN ('wave_primary','parallel_pilot','admin_primary')),
  primary_from date,
  history_start date,
  transfer_window_days integer NOT NULL DEFAULT 5 CHECK(transfer_window_days BETWEEN 0 AND 30),
  transit_alert_days integer NOT NULL DEFAULT 14 CHECK(transit_alert_days BETWEEN 1 AND 365),
  CHECK(authority_mode<>'admin_primary' OR primary_from IS NOT NULL)
);
CREATE TABLE public.acct_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('vendor','customer','both')),
  default_account_id uuid REFERENCES public.acct_accounts(id),
  tax_classification text NOT NULL DEFAULT 'unreviewed' CHECK(tax_classification IN ('unreviewed','individual','corporation','partnership','foreign','other')),
  documentation text NOT NULL DEFAULT 'missing' CHECK(documentation IN ('missing','requested','received','not_required')),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=3000),
  is_archived boolean NOT NULL DEFAULT false
);
CREATE TABLE public.acct_dimensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('project','business_line')),
  customer_id uuid REFERENCES public.acct_parties(id),
  is_archived boolean NOT NULL DEFAULT false
);
CREATE TABLE public.acct_entry_context (
  entry_id uuid PRIMARY KEY REFERENCES public.acct_journal_entries(id),
  kind text NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','income','expense','transfer','payroll','opening','owner','loan','asset','invoice_receipt','refund')),
  payee_id uuid REFERENCES public.acct_parties(id),
  customer_id uuid REFERENCES public.acct_parties(id),
  project_id uuid REFERENCES public.acct_dimensions(id),
  business_line_id uuid REFERENCES public.acct_dimensions(id),
  payment_rail text NOT NULL DEFAULT 'unknown' CHECK(payment_rail IN ('unknown','ach','check','cash','card','third_party','wire','other')),
  contractor_treatment text NOT NULL DEFAULT 'unreviewed' CHECK(contractor_treatment IN ('unreviewed','reportable','excluded')),
  contractor_reason text NOT NULL DEFAULT '' CHECK(length(contractor_reason)<=1000)
);
CREATE TABLE public.acct_entry_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_entry_id uuid NOT NULL UNIQUE REFERENCES public.acct_journal_entries(id),
  reversal_entry_id uuid NOT NULL UNIQUE REFERENCES public.acct_journal_entries(id),
  replacement_entry_id uuid UNIQUE REFERENCES public.acct_journal_entries(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_journal_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL UNIQUE CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  memo text NOT NULL CHECK(length(btrim(memo)) BETWEEN 1 AND 1000),
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 2 AND 100),
  is_archived boolean NOT NULL DEFAULT false
);
CREATE TABLE public.acct_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL UNIQUE CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object')
);
CREATE TABLE public.acct_report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('report','close','filing','restatement','historical_baseline')),
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  revision bigint NOT NULL,
  report_version integer NOT NULL DEFAULT 2,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);

CREATE OR REPLACE FUNCTION public.acct_context_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='UPDATE' AND NEW.entry_id<>OLD.entry_id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  v_id:=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_id AND status='draft') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  IF TG_OP<>'DELETE' THEN
    IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_dimensions WHERE id=NEW.project_id AND kind='project' AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_DIMENSION'; END IF;
    IF NEW.business_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_dimensions WHERE id=NEW.business_line_id AND kind='business_line' AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_DIMENSION'; END IF;
    IF NEW.contractor_treatment='excluded' AND length(btrim(NEW.contractor_reason))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER acct_context_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_entry_context FOR EACH ROW EXECUTE FUNCTION public.acct_context_guard();

CREATE OR REPLACE FUNCTION public.acct_profile_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_type text; v_parent uuid;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  SELECT account_type INTO v_type FROM public.acct_accounts WHERE id=NEW.account_id;
  IF (NEW.cash_kind IN ('bank','cash') AND v_type<>'asset') OR (NEW.cash_kind='card' AND v_type<>'liability') THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id<>OLD.account_id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
    IF (NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.cash_kind<>OLD.cash_kind) AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE account_id=NEW.account_id) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
    NEW.version:=OLD.version+1;
  END IF;
  v_parent:=NEW.parent_account_id;
  WHILE v_parent IS NOT NULL LOOP
    IF v_parent=NEW.account_id THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CYCLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=v_parent AND account_type=v_type) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_PARENT'; END IF;
    SELECT parent_account_id INTO v_parent FROM public.acct_account_profiles WHERE account_id=v_parent;
    IF v_parent IS NOT NULL THEN RAISE EXCEPTION 'ACCT_ACCOUNT_PARENT_DEPTH'; END IF;
  END LOOP;
  IF NEW.parent_account_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE parent_account_id=NEW.account_id) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_PARENT_DEPTH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_account_profiles FOR EACH ROW EXECUTE FUNCTION public.acct_profile_guard();

CREATE OR REPLACE FUNCTION public.acct_validate_template(p_lines jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l jsonb; total numeric:=0; n integer:=0; v_amount bigint;
BEGIN
  IF jsonb_typeof(p_lines)<>'array' THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(l->'amount_cents') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
    v_amount:=(l->>'amount_cents')::bigint;
    IF v_amount=0 OR v_amount='-9223372036854775808'::bigint THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=(l->>'account_id')::uuid AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
    total:=total+v_amount;n:=n+1;
  END LOOP;
  IF total<>0 OR n<2 OR n>100 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
END $$;

-- Extended command dispatcher. The original command remains the primitive for
-- draft/post operations, including nested operations in one outer transaction.
CREATE OR REPLACE FUNCTION public.acct_execute(p_key uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=public.acct_require_owner(); receipt public.acct_command_receipts;
  op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid;
  v_result jsonb; v_profile public.acct_account_profiles; v_account public.acct_accounts;
  v_template public.acct_journal_templates; v_entry public.acct_journal_entries;
  reversal jsonb; replacement jsonb; v_version integer; x jsonb;
BEGIN
  IF p_key IS NULL OR p_command IS NULL OR v_id IS NULL OR octet_length(p_command::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();actor:=public.acct_require_owner();
  SELECT * INTO receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF op IN ('account.create','draft.save','entry.post','draft.discard','entry.reverse') THEN
    RETURN public.acct_command(p_key,p_command);
  ELSIF op='entry.bulkpost' THEN
    IF jsonb_typeof(p_command->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'entries') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'entries') LOOP
      PERFORM public.acct_command(gen_random_uuid(),x||jsonb_build_object('type','entry.post'));
    END LOOP;
    v_result:=jsonb_build_object('id',v_id,'posted',jsonb_array_length(p_command->'entries'));
  ELSIF op='transaction.save' THEN
    replacement:=public.acct_command(gen_random_uuid(),(p_command-'context')||jsonb_build_object('type','draft.save'));
    IF p_command ? 'context' THEN
      replacement:=public.acct_execute(gen_random_uuid(),(p_command->'context')||jsonb_build_object('type','entry.context','id',v_id,'expected_version',replacement->'version'));
    END IF;
    v_result:=replacement;
  ELSIF op='dimension.save' THEN
    SELECT version INTO v_version FROM public.acct_dimensions WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_dimensions WHERE id=v_id AND kind<>p_command->>'kind') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
    IF nullif(p_command->>'customer_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=(p_command->>'customer_id')::uuid AND kind IN ('customer','both') AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_CUSTOMER'; END IF;
    INSERT INTO public.acct_dimensions(id,name,kind,customer_id,is_archived) VALUES(v_id,btrim(p_command->>'name'),p_command->>'kind',nullif(p_command->>'customer_id','')::uuid,coalesce((p_command->>'is_archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,customer_id=excluded.customer_id,is_archived=excluded.is_archived,version=acct_dimensions.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='preferences.save' THEN
    SELECT version INTO v_version FROM public.acct_book_preferences WHERE singleton;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF p_command->>'authority_mode' NOT IN ('wave_primary','parallel_pilot') THEN RAISE EXCEPTION 'ACCT_PRIMARY_REQUIRES_ACCEPTANCE'; END IF;
    UPDATE public.acct_settings SET legal_name=btrim(p_command->>'legal_name') WHERE singleton;
    INSERT INTO public.acct_book_preferences(singleton,authority_mode,history_start,transfer_window_days,transit_alert_days)
    VALUES(true,p_command->>'authority_mode',nullif(p_command->>'history_start','')::date,(p_command->>'transfer_window_days')::integer,(p_command->>'transit_alert_days')::integer)
    ON CONFLICT(singleton) DO UPDATE SET authority_mode=excluded.authority_mode,history_start=excluded.history_start,transfer_window_days=excluded.transfer_window_days,transit_alert_days=excluded.transit_alert_days,version=acct_book_preferences.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='account.update' THEN
    SELECT * INTO v_account FROM public.acct_accounts WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    SELECT * INTO v_profile FROM public.acct_account_profiles WHERE account_id=v_id;
    IF coalesce(v_profile.version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    UPDATE public.acct_accounts SET name=btrim(p_command->>'name'),code=btrim(coalesce(p_command->>'code','')),is_archived=coalesce((p_command->>'is_archived')::boolean,false) WHERE id=v_id;
    INSERT INTO public.acct_account_profiles(account_id,purpose,cash_kind,parent_account_id,subtype)
    VALUES(v_id,nullif(p_command->>'purpose',''),coalesce(p_command->>'cash_kind','none'),nullif(p_command->>'parent_account_id','')::uuid,coalesce(p_command->>'subtype',''))
    ON CONFLICT(account_id) DO UPDATE SET purpose=excluded.purpose,cash_kind=excluded.cash_kind,parent_account_id=excluded.parent_account_id,subtype=excluded.subtype;
    SELECT jsonb_build_object('id',v_id,'version',version) INTO v_result FROM public.acct_account_profiles WHERE account_id=v_id;
  ELSIF op='chart.seed' THEN
    IF EXISTS(SELECT 1 FROM public.acct_accounts) THEN RAISE EXCEPTION 'ACCT_CHART_EXISTS'; END IF;
    IF jsonb_typeof(p_command->'accounts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'accounts') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'accounts') LOOP
      PERFORM public.acct_command(gen_random_uuid(),(x-'purpose'-'cash_kind')||jsonb_build_object('type','account.create'));
      INSERT INTO public.acct_account_profiles(account_id,purpose,cash_kind) VALUES((x->>'id')::uuid,nullif(x->>'purpose',''),coalesce(x->>'cash_kind','none'));
    END LOOP;
    v_result:=jsonb_build_object('id',v_id,'count',jsonb_array_length(p_command->'accounts'));
  ELSIF op='entry.context' THEN
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF v_entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    UPDATE public.acct_journal_entries SET memo=memo WHERE id=v_id;
    INSERT INTO public.acct_entry_context(entry_id,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason)
    VALUES(v_id,coalesce(p_command->>'kind','manual'),nullif(p_command->>'payee_id','')::uuid,nullif(p_command->>'customer_id','')::uuid,nullif(p_command->>'project_id','')::uuid,nullif(p_command->>'business_line_id','')::uuid,coalesce(p_command->>'payment_rail','unknown'),coalesce(p_command->>'contractor_treatment','unreviewed'),coalesce(p_command->>'contractor_reason',''))
    ON CONFLICT(entry_id) DO UPDATE SET kind=excluded.kind,payee_id=excluded.payee_id,customer_id=excluded.customer_id,project_id=excluded.project_id,business_line_id=excluded.business_line_id,payment_rail=excluded.payment_rail,contractor_treatment=excluded.contractor_treatment,contractor_reason=excluded.contractor_reason;
    v_result:=jsonb_build_object('id',v_id,'version',v_entry.version+1);
  ELSIF op='entry.correct' THEN
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    PERFORM public.acct_validate_template(p_command->'lines');
    reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',v_id,'expected_version',p_command->'expected_version','entry_date',p_command->'entry_date','reason',p_command->'reason'));
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',p_command->'replacement_id','expected_version',0,'entry_date',p_command->'entry_date','memo',p_command->'memo','lines',p_command->'lines'));
    INSERT INTO public.acct_entry_context SELECT (replacement->>'id')::uuid,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason FROM public.acct_entry_context WHERE entry_id=v_id;
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by)
    VALUES(v_id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    v_result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',v_id);
  ELSIF op='entry.annotate' THEN
    INSERT INTO public.acct_annotations(id,entry_id,note,created_by) VALUES(v_id,(p_command->>'entry_id')::uuid,p_command->>'note',actor);
    v_result:=jsonb_build_object('id',v_id);
  ELSIF op='party.save' THEN
    SELECT version INTO v_version FROM public.acct_parties WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_parties(id,name,kind,default_account_id,tax_classification,documentation,notes,is_archived)
    VALUES(v_id,btrim(p_command->>'name'),p_command->>'kind',nullif(p_command->>'default_account_id','')::uuid,coalesce(p_command->>'tax_classification','unreviewed'),coalesce(p_command->>'documentation','missing'),coalesce(p_command->>'notes',''),coalesce((p_command->>'is_archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,default_account_id=excluded.default_account_id,tax_classification=excluded.tax_classification,documentation=excluded.documentation,notes=excluded.notes,is_archived=excluded.is_archived,version=acct_parties.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='template.save' THEN
    PERFORM public.acct_validate_template(p_command->'lines');
    SELECT version INTO v_version FROM public.acct_journal_templates WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_journal_templates(id,name,memo,lines,is_archived) VALUES(v_id,btrim(p_command->>'name'),p_command->>'memo',p_command->'lines',coalesce((p_command->>'is_archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,memo=excluded.memo,lines=excluded.lines,is_archived=excluded.is_archived,version=acct_journal_templates.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='view.save' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_command->'filters') k WHERE k NOT IN ('from','to','account','status','source','query','payee','project','business_line','missing_receipt','min_cents','max_cents')) THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
    SELECT version INTO v_version FROM public.acct_saved_views WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_saved_views(id,name,filters) VALUES(v_id,btrim(p_command->>'name'),p_command->'filters')
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters=excluded.filters,version=acct_saved_views.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='report.snapshot' THEN
    x:=public.acct_workspace((p_command->>'from')::date,(p_command->>'to')::date);
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by)
    VALUES(v_id,'report',(p_command->>'from')::date,(p_command->>'to')::date,(x->>'revision')::bigint,x,actor);
    v_result:=jsonb_build_object('id',v_id);
  ELSIF op LIKE 'import.%' THEN
    v_result:=public.acct_import_command(p_command,actor);
  ELSIF op LIKE 'document.%' THEN
    v_result:=public.acct_document_command(p_command,actor);
  ELSE
    RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,actor,p_command,v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_register(p_filter jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb; v_total bigint; v_offset integer:=coalesce((p_filter->>'offset')::integer,0); v_limit integer:=coalesce((p_filter->>'limit')::integer,50);
BEGIN
  PERFORM public.acct_require_owner();
  IF v_offset<0 OR v_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  WITH matches AS (
    SELECT e.id FROM public.acct_journal_entries e LEFT JOIN public.acct_entry_context c ON c.entry_id=e.id
    WHERE (p_filter->>'from' IS NULL OR e.entry_date>=(p_filter->>'from')::date)
      AND (p_filter->>'to' IS NULL OR e.entry_date<=(p_filter->>'to')::date)
      AND (coalesce(p_filter->>'status','all')='all' OR e.status=p_filter->>'status')
      AND (p_filter->>'entry_id' IS NULL OR e.id=(p_filter->>'entry_id')::uuid)
      AND (p_filter->>'account' IS NULL OR EXISTS(SELECT 1 FROM public.acct_journal_lines l WHERE l.entry_id=e.id AND l.account_id=(p_filter->>'account')::uuid))
      AND (p_filter->>'payee' IS NULL OR c.payee_id=(p_filter->>'payee')::uuid)
      AND (p_filter->>'project' IS NULL OR c.project_id=(p_filter->>'project')::uuid)
      AND (p_filter->>'business_line' IS NULL OR c.business_line_id=(p_filter->>'business_line')::uuid)
      AND (p_filter->>'source' IS NULL OR e.primary_origin=p_filter->>'source' OR EXISTS(SELECT 1 FROM public.acct_source_links sl JOIN public.acct_source_records s ON s.id=sl.source_record_id WHERE sl.entry_id=e.id AND s.source_system=p_filter->>'source'))
      AND (NOT coalesce((p_filter->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM public.acct_document_links dl WHERE dl.entry_id=e.id))
      AND (p_filter->>'query' IS NULL OR e.memo ILIKE '%'||(p_filter->>'query')||'%' OR EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND (l.memo||' '||a.name) ILIKE '%'||(p_filter->>'query')||'%'))
      AND (p_filter->>'min_cents' IS NULL OR (SELECT coalesce(sum(amount_cents) FILTER(WHERE amount_cents>0),0) FROM public.acct_journal_lines WHERE entry_id=e.id)>=(p_filter->>'min_cents')::numeric)
      AND (p_filter->>'max_cents' IS NULL OR (SELECT coalesce(sum(amount_cents) FILTER(WHERE amount_cents>0),0) FROM public.acct_journal_lines WHERE entry_id=e.id)<=(p_filter->>'max_cents')::numeric)
  ), page AS (
    SELECT e.*,(SELECT r.id FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed_by_entry_id,
      (SELECT to_jsonb(c) FROM public.acct_entry_context c WHERE c.entry_id=e.id) AS context,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order),'[]') FROM public.acct_journal_lines l WHERE l.entry_id=e.id) AS lines
    FROM public.acct_journal_entries e JOIN matches m ON m.id=e.id ORDER BY e.entry_date DESC,e.created_at DESC,e.id DESC LIMIT v_limit OFFSET v_offset
  ) SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY entry_date DESC,created_at DESC,id DESC) FROM page p),'[]'),
    'total',(SELECT count(*) FROM matches),'offset',v_offset,'limit',v_limit,'revision',(SELECT financial_revision::text FROM public.acct_settings)) INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_account_ledger(p_account uuid,p_from date,p_to date,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric; v_result jsonb;
BEGIN
  PERFORM public.acct_require_owner();
  IF p_from>p_to OR p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  SELECT coalesce(sum(l.amount_cents),0) INTO v_open FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=p_account AND e.status='posted' AND e.entry_date<p_from;
  WITH running AS (
    SELECT l.id,l.entry_id,e.entry_date,e.created_at,l.sort_order,e.memo,l.memo AS line_memo,l.amount_cents::text AS amount_cents,
      (v_open+sum(l.amount_cents) OVER(ORDER BY e.entry_date,e.created_at,e.id,l.sort_order ROWS UNBOUNDED PRECEDING))::text AS running_cents
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=p_account AND e.status='posted' AND e.entry_date BETWEEN p_from AND p_to
  ), page AS (SELECT * FROM running ORDER BY entry_date,created_at,entry_id,sort_order,id LIMIT 100 OFFSET p_offset)
  SELECT jsonb_build_object('opening_cents',v_open::text,'total',(SELECT count(*) FROM running),'rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]')) INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_manage() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object(
    'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_account_profiles x),
    'parties',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM public.acct_parties x),
    'dimensions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY kind,name),'[]') FROM public.acct_dimensions x),
    'templates',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM public.acct_journal_templates x),
    'views',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM public.acct_saved_views x),
    'periods',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY month_start DESC),'[]') FROM public.acct_periods x),
    'preferences',(SELECT to_jsonb(x) FROM public.acct_book_preferences x));
END $$;

CREATE OR REPLACE FUNCTION public.acct_entry_evidence(p_entry uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object(
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY observed_at),'[]') FROM public.acct_source_records s JOIN public.acct_source_links l ON l.source_record_id=s.id WHERE l.entry_id=p_entry),
    'notes',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at),'[]') FROM public.acct_annotations a WHERE entry_id=p_entry),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('size_bytes',d.size_bytes::text)),'[]') FROM public.acct_documents d JOIN public.acct_document_links l ON l.document_id=d.id WHERE l.entry_id=p_entry),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY recorded_at,id),'[]') FROM public.acct_audit_log a WHERE
      coalesce(a.after_value->>'id',a.before_value->>'id')=p_entry::text OR coalesce(a.after_value->>'entry_id',a.before_value->>'entry_id')=p_entry::text));
END $$;

DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_account_profiles','acct_book_preferences','acct_parties','acct_dimensions','acct_entry_context','acct_entry_corrections','acct_annotations','acct_journal_templates','acct_saved_views','acct_report_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['acct_entry_corrections','acct_annotations','acct_report_snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER acct_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'acct\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.acct_is_owner(),public.acct_command(uuid,jsonb),public.acct_workspace(date,date,uuid),public.acct_export(),public.acct_execute(uuid,jsonb),public.acct_register(jsonb),public.acct_account_ledger(uuid,date,date,integer),public.acct_manage(),public.acct_entry_evidence(uuid) TO authenticated;
-- ACCOUNTING WORKFLOWS END


-- ACCOUNTING IMPORTS BEGIN
CREATE TABLE public.acct_import_batches (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  source_system text NOT NULL CHECK(source_system IN ('wave','csv','simplefin')),
  source_scope text NOT NULL CHECK(length(source_scope) BETWEEN 1 AND 250),
  file_hash text NOT NULL CHECK(length(file_hash)=64),
  mapping_hash text NOT NULL CHECK(length(mapping_hash)=64),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 250),
  source_document_id uuid REFERENCES public.acct_documents(id),
  mode text NOT NULL CHECK(mode IN ('journal','bank')),
  basis text NOT NULL CHECK(basis IN ('cash','unconfirmed')),
  status text NOT NULL DEFAULT 'staging' CHECK(status IN ('staging','review','applying','completed','cancelled','failed')),
  expected_groups integer NOT NULL CHECK(expected_groups BETWEEN 1 AND 50000),
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  coverage_verified boolean NOT NULL DEFAULT false,
  error text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_system,source_scope,file_hash,mapping_hash)
);
CREATE TABLE public.acct_import_groups (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES public.acct_import_batches(id),
  ordinal integer NOT NULL CHECK(ordinal>=0),
  version integer NOT NULL DEFAULT 1,
  source_record_id uuid NOT NULL REFERENCES public.acct_source_records(id),
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  identity_kind text NOT NULL CHECK(identity_kind IN ('provider_id','fingerprint_multiplicity')),
  entry_date date NOT NULL,
  memo text NOT NULL,
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
  bank_account_id uuid REFERENCES public.acct_accounts(id),
  bank_amount_cents bigint CHECK(bank_amount_cents<>0 AND bank_amount_cents>'-9223372036854775808'::bigint),
  status text NOT NULL CHECK(status IN ('new','duplicate','review','exception','applied','excluded')),
  entry_id uuid REFERENCES public.acct_journal_entries(id),
  candidate_entry_id uuid REFERENCES public.acct_journal_entries(id),
  reason text NOT NULL DEFAULT '',
  UNIQUE(batch_id,ordinal),UNIQUE(batch_id,source_record_id)
);
CREATE INDEX acct_import_groups_batch_status ON public.acct_import_groups(batch_id,status,ordinal);
CREATE TABLE public.acct_bank_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL UNIQUE REFERENCES public.acct_source_records(id),
  entry_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);

CREATE OR REPLACE FUNCTION public.acct_import_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid;
  batch public.acct_import_batches; g public.acct_import_groups; x jsonb; src uuid; candidate uuid; v_status text;
  result jsonb; saved jsonb; v_entry uuid; v_line uuid; v_uncategorized uuid; v_lines jsonb;
  v_count integer; v_posted integer:=0; v_drafted integer:=0;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='import.create' THEN
    SELECT * INTO batch FROM public.acct_import_batches WHERE source_system=p_command->>'source_system' AND source_scope=p_command->>'source_scope' AND file_hash=p_command->>'file_hash' AND mapping_hash=p_command->>'mapping_hash';
    IF FOUND THEN RETURN jsonb_build_object('id',batch.id,'version',batch.version,'existing',true); END IF;
    INSERT INTO public.acct_import_batches(id,source_system,source_scope,file_hash,mapping_hash,file_name,source_document_id,mode,basis,expected_groups,from_date,to_date,created_by)
    VALUES(v_id,p_command->>'source_system',p_command->>'source_scope',p_command->>'file_hash',p_command->>'mapping_hash',p_command->>'file_name',nullif(p_command->>'source_document_id','')::uuid,p_command->>'mode',p_command->>'basis',(p_command->>'expected_groups')::integer,(p_command->>'from')::date,(p_command->>'to')::date,p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1);
  END IF;
  IF op IN ('import.stage','import.apply','import.cancel','import.finish') THEN
    SELECT * INTO batch FROM public.acct_import_batches WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF batch.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF batch.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  END IF;
  IF op='import.stage' THEN
    IF batch.status<>'staging' OR jsonb_typeof(p_command->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'groups') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_STAGE'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'groups') LOOP
      IF (x->>'ordinal')::integer<>(SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id) THEN RAISE EXCEPTION 'ACCT_IMPORT_CHECKPOINT'; END IF;
      IF (x->>'ordinal')::integer>=batch.expected_groups OR (x->>'entry_date')::date NOT BETWEEN batch.from_date AND batch.to_date THEN RAISE EXCEPTION 'ACCT_IMPORT_SCOPE'; END IF;
      INSERT INTO public.acct_source_records(source_system,source_scope,external_id,content_hash,raw_payload)
      VALUES(batch.source_system,batch.source_scope,x->>'external_id',x->>'source_hash',x->'raw')
      ON CONFLICT(source_system,source_scope,external_id,content_hash) DO NOTHING;
      SELECT id INTO src FROM public.acct_source_records WHERE source_system=batch.source_system AND source_scope=batch.source_scope AND external_id=x->>'external_id' AND content_hash=x->>'source_hash';
      SELECT l.entry_id INTO candidate FROM public.acct_source_links l JOIN public.acct_journal_entries e ON e.id=l.entry_id
        JOIN public.acct_source_records s ON s.id=l.source_record_id JOIN public.acct_import_groups previous ON previous.source_record_id=s.id
        WHERE s.source_system=batch.source_system AND s.source_scope=batch.source_scope AND s.external_id=x->>'external_id' AND previous.fingerprint=x->>'fingerprint' AND e.status<>'discarded' ORDER BY e.created_at LIMIT 1;
      v_status:=CASE WHEN candidate IS NOT NULL THEN 'duplicate' ELSE 'new' END;
      IF candidate IS NULL AND EXISTS(SELECT 1 FROM public.acct_source_records s JOIN public.acct_source_links l ON l.source_record_id=s.id WHERE s.source_system=batch.source_system AND s.source_scope=batch.source_scope AND s.external_id=x->>'external_id') THEN v_status:='exception'; END IF;
      IF batch.mode='bank' THEN
        IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id=(x->>'bank_account_id')::uuid AND p.cash_kind IN ('bank','cash','card') AND NOT a.is_archived) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
        IF candidate IS NULL THEN
          SELECT e.id INTO candidate FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
          WHERE l.account_id=(x->>'bank_account_id')::uuid AND l.amount_cents=(x->>'bank_amount_cents')::bigint AND e.status<>'discarded' AND abs(e.entry_date-(x->>'entry_date')::date)<=5 ORDER BY abs(e.entry_date-(x->>'entry_date')::date),e.id LIMIT 1;
          IF candidate IS NOT NULL AND v_status='new' THEN v_status:='review'; END IF;
        END IF;
      ELSE
        PERFORM public.acct_validate_template(x->'lines');
      END IF;
      IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=date_trunc('month',(x->>'entry_date')::date)::date AND is_locked) AND v_status<>'duplicate' THEN v_status:='exception'; END IF;
      INSERT INTO public.acct_import_groups(id,batch_id,ordinal,source_record_id,fingerprint,identity_kind,entry_date,memo,lines,bank_account_id,bank_amount_cents,status,entry_id,candidate_entry_id,reason)
      VALUES((x->>'id')::uuid,v_id,(x->>'ordinal')::integer,src,x->>'fingerprint',x->>'identity_kind',(x->>'entry_date')::date,x->>'memo',coalesce(x->'lines','[]'),nullif(x->>'bank_account_id','')::uuid,nullif(x->>'bank_amount_cents','')::bigint,v_status,CASE WHEN v_status='duplicate' THEN candidate ELSE NULL END,candidate,CASE WHEN v_status='exception' THEN 'Changed source identity or locked financial period requires review.' ELSE '' END);
      IF v_status='duplicate' THEN INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(src,candidate) ON CONFLICT DO NOTHING; END IF;
    END LOOP;
    SELECT count(*) INTO v_count FROM public.acct_import_groups WHERE batch_id=v_id;
    UPDATE public.acct_import_batches SET version=version+1,status=CASE WHEN v_count=expected_groups THEN 'review' ELSE 'staging' END WHERE id=v_id;
  ELSIF op='import.resolve' THEN
    SELECT * INTO g FROM public.acct_import_groups WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    SELECT * INTO batch FROM public.acct_import_batches WHERE id=g.batch_id;
    IF batch.status NOT IN ('review','applying') OR g.status IN ('applied','duplicate','excluded') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
    IF g.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF p_command->>'resolution'='new' THEN
      IF g.status='exception' THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION'; END IF;
      UPDATE public.acct_import_groups SET status='new',version=version+1,candidate_entry_id=NULL,reason=p_command->>'reason' WHERE id=v_id;
    ELSIF p_command->>'resolution'='exclude' THEN
      UPDATE public.acct_import_groups SET status='excluded',version=version+1,reason=p_command->>'reason' WHERE id=v_id;
    ELSIF p_command->>'resolution'='match' THEN
      v_entry:=(p_command->>'entry_id')::uuid;
      IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_entry AND status='posted') THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
      IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=v_entry) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
      IF batch.mode='bank' THEN
        SELECT id INTO v_line FROM public.acct_journal_lines WHERE entry_id=v_entry AND account_id=g.bank_account_id AND amount_cents=g.bank_amount_cents ORDER BY sort_order LIMIT 1;
        IF v_line IS NULL THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
        IF EXISTS(SELECT 1 FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=g.source_record_id
          WHERE m.entry_line_id=v_line AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id<>current_source.external_id) THEN RAISE EXCEPTION 'ACCT_MATCH_ALREADY_USED'; END IF;
        INSERT INTO public.acct_bank_matches(source_record_id,entry_line_id,amount_cents,created_by) VALUES(g.source_record_id,v_line,g.bank_amount_cents,p_actor);
      ELSE
        -- Journal evidence can attach only to the same date and complete line set.
        IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_entry AND entry_date=g.entry_date) OR
          (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM public.acct_journal_lines WHERE entry_id=v_entry) IS DISTINCT FROM
          (SELECT jsonb_agg(jsonb_build_array((j->>'account_id')::uuid,j->>'amount_cents') ORDER BY (j->>'account_id')::uuid,(j->>'amount_cents')::bigint) FROM jsonb_array_elements(g.lines) j) THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
      END IF;
      INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(g.source_record_id,v_entry) ON CONFLICT DO NOTHING;
      UPDATE public.acct_import_groups SET status='duplicate',entry_id=v_entry,version=version+1,reason=p_command->>'reason' WHERE id=v_id;
    ELSE RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    UPDATE public.acct_import_batches SET version=version+1 WHERE id=g.batch_id;
    RETURN jsonb_build_object('id',g.batch_id,'group_id',v_id);
  ELSIF op='import.apply' THEN
    IF batch.status NOT IN ('review','applying') OR batch.basis<>'cash' OR jsonb_array_length(p_command->'group_ids') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'group_ids') LOOP
      SELECT * INTO g FROM public.acct_import_groups WHERE id=(x#>>'{}')::uuid AND batch_id=v_id;
      IF NOT FOUND OR g.status<>'new' THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
      v_entry:=gen_random_uuid();
      IF batch.mode='bank' THEN
        SELECT account_id INTO v_uncategorized FROM public.acct_account_profiles WHERE purpose=CASE WHEN g.bank_amount_cents>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
        IF v_uncategorized IS NULL THEN RAISE EXCEPTION 'ACCT_UNCATEGORIZED_ACCOUNT_REQUIRED'; END IF;
        v_lines:=jsonb_build_array(jsonb_build_object('account_id',g.bank_account_id,'amount_cents',g.bank_amount_cents::text,'memo',''),jsonb_build_object('account_id',v_uncategorized,'amount_cents',(-g.bank_amount_cents)::text,'memo',''));
      ELSE v_lines:=g.lines; END IF;
      -- Set provenance at creation, before any financial content is posted.
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,primary_origin,created_by) VALUES(v_entry,g.entry_date,g.memo,batch.source_system,p_actor);
      saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',v_entry,'expected_version',1,'entry_date',g.entry_date,'memo',g.memo,'lines',v_lines));
      IF batch.mode='journal' THEN
        PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',v_entry,'expected_version',saved->'version'));v_posted:=v_posted+1;
      ELSE v_drafted:=v_drafted+1; END IF;
      INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(g.source_record_id,v_entry);
      UPDATE public.acct_import_groups SET status='applied',entry_id=v_entry,version=version+1 WHERE id=g.id;
    END LOOP;
    UPDATE public.acct_import_batches SET version=version+1,status='applying' WHERE id=v_id;
  ELSIF op='import.finish' THEN
    IF batch.status NOT IN ('review','applying') OR (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id)<>batch.expected_groups OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=v_id AND status NOT IN ('applied','duplicate','excluded')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
    UPDATE public.acct_import_batches SET status='completed',version=version+1 WHERE id=v_id;
  ELSIF op='import.cancel' THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_import_batches SET status='cancelled',version=version+1,error=p_command->>'reason' WHERE id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  SELECT jsonb_build_object('id',id,'version',version,'posted',v_posted,'drafted',v_drafted) INTO result FROM public.acct_import_batches WHERE id=v_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_imports(p_batch uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  IF p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  RETURN jsonb_build_object('batches',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY created_at DESC),'[]') FROM public.acct_import_batches b),
    'groups',(SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('bank_amount_cents',g.bank_amount_cents::text) ORDER BY ordinal),'[]') FROM (SELECT * FROM public.acct_import_groups WHERE batch_id=p_batch ORDER BY ordinal LIMIT 100 OFFSET p_offset) g),
    'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM public.acct_import_groups WHERE batch_id=p_batch GROUP BY status) s),
    'total',(SELECT count(*) FROM public.acct_import_groups WHERE batch_id=p_batch));
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_import_batches','acct_import_groups','acct_bank_matches'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  END LOOP;
END $$;
CREATE TRIGGER acct_bank_match_immutable BEFORE UPDATE OR DELETE ON public.acct_bank_matches FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
REVOKE ALL ON FUNCTION public.acct_import_command(jsonb,uuid),public.acct_imports(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_imports(uuid,integer) TO authenticated;
-- ACCOUNTING IMPORTS END


-- ACCOUNTING DOCUMENTS BEGIN
CREATE TABLE public.acct_document_states (
  document_id uuid PRIMARY KEY REFERENCES public.acct_documents(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','available','missing','archived')),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.acct_document_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid; state public.acct_document_states; v_exists boolean;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='document.prepare' THEN
    IF p_command->>'content_hash' !~ '^[a-f0-9]{64}$' OR (p_command->>'size_bytes')::bigint NOT BETWEEN 1 AND 20971520 OR length(p_command->>'original_name') NOT BETWEEN 1 AND 250 OR p_command->>'mime_type' NOT IN ('application/pdf','image/png','image/jpeg','image/webp','text/csv') THEN RAISE EXCEPTION 'ACCT_INVALID_DOCUMENT'; END IF;
    INSERT INTO public.acct_documents(id,storage_path,original_name,content_hash,mime_type,size_bytes) VALUES(v_id,v_id::text||'/'||(p_command->>'content_hash'),p_command->>'original_name',p_command->>'content_hash',p_command->>'mime_type',(p_command->>'size_bytes')::bigint);
    INSERT INTO public.acct_document_states(document_id,uploaded_by) VALUES(v_id,p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1,'storage_path',v_id::text||'/'||(p_command->>'content_hash'));
  END IF;
  SELECT * INTO state FROM public.acct_document_states WHERE document_id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF state.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='document.complete' THEN
    IF state.state<>'uploading' THEN RAISE EXCEPTION 'ACCT_DOCUMENT_STATE'; END IF;
    IF to_regclass('storage.objects') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS(SELECT 1 FROM storage.objects o JOIN public.acct_documents d ON d.storage_path=o.name WHERE o.bucket_id=''accounting-private'' AND d.id=$1)' INTO v_exists USING v_id;
      IF NOT v_exists THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    END IF;
    UPDATE public.acct_document_states SET state='available',version=version+1,updated_at=now() WHERE document_id=v_id;
  ELSIF op='document.link' THEN
    IF state.state<>'available' THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=(p_command->>'entry_id')::uuid AND status<>'discarded') THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    INSERT INTO public.acct_document_links(document_id,entry_id) VALUES(v_id,(p_command->>'entry_id')::uuid) ON CONFLICT DO NOTHING;
    UPDATE public.acct_document_states SET version=version+1,updated_at=now() WHERE document_id=v_id;
  ELSIF op='document.archive' THEN
    IF EXISTS(SELECT 1 FROM public.acct_document_links WHERE document_id=v_id) OR EXISTS(SELECT 1 FROM public.acct_import_batches WHERE source_document_id=v_id) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_document_states SET state='archived',version=version+1,updated_at=now() WHERE document_id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  RETURN jsonb_build_object('id',v_id,'version',state.version+1);
END $$;
CREATE OR REPLACE FUNCTION public.acct_documents_read(p_id uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  IF p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  RETURN jsonb_build_object('documents',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,id),'[]') FROM (
    SELECT d.id,d.storage_path,d.original_name,d.content_hash,d.mime_type,d.size_bytes::text,d.created_at,s.version,s.state,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'entry_date',e.entry_date)),'[]') FROM public.acct_document_links l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.document_id=d.id) AS entries
    FROM public.acct_documents d JOIN public.acct_document_states s ON s.document_id=d.id WHERE (p_id IS NULL AND s.state<>'archived') OR d.id=p_id ORDER BY d.created_at DESC,d.id LIMIT 100 OFFSET p_offset
  ) x),'total',(SELECT count(*) FROM public.acct_document_states WHERE state<>'archived'));
END $$;
CREATE OR REPLACE FUNCTION public.acct_document_object_allowed(p_path text,p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.acct_is_owner() AND EXISTS(SELECT 1 FROM public.acct_documents d JOIN public.acct_document_states s ON s.document_id=d.id WHERE d.storage_path=p_path AND (NOT p_write OR s.state='uploading'));
$$;
ALTER TABLE public.acct_document_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_document_states FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_document_states FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
REVOKE ALL ON FUNCTION public.acct_document_command(jsonb,uuid),public.acct_documents_read(uuid,integer),public.acct_document_object_allowed(text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_documents_read(uuid,integer),public.acct_document_object_allowed(text,boolean) TO authenticated;
DO $$ BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'CREATE POLICY acct_private_evidence_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id=''accounting-private'' AND public.acct_document_object_allowed(name,false))';
    EXECUTE 'CREATE POLICY acct_private_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id=''accounting-private'' AND public.acct_document_object_allowed(name,true))';
  END IF;
END $$;
-- ACCOUNTING DOCUMENTS END


-- ACCOUNTING EXPORTS BEGIN
CREATE OR REPLACE FUNCTION public.acct_books_export() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN public.acct_export()||jsonb_build_object('format','valiance-accounting-books','version',2,
    'coverage_status',CASE WHEN EXISTS(SELECT 1 FROM public.acct_import_batches WHERE status<>'completed' OR NOT coverage_verified) THEN 'unverified_imports' ELSE 'unverified' END,
    'account_profiles',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_account_profiles x),
    'book_preferences',(SELECT to_jsonb(x) FROM public.acct_book_preferences x),
    'parties',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_parties x),
    'dimensions',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_dimensions x),
    'entry_context',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_entry_context x),
    'entry_corrections',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_entry_corrections x),
    'annotations',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_annotations x),
    'journal_templates',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_journal_templates x),
    'saved_views',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_saved_views x),
    'report_snapshots',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('revision',x.revision::text)),'[]') FROM public.acct_report_snapshots x),
    'import_batches',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_import_batches x),
    'import_groups',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('bank_amount_cents',x.bank_amount_cents::text)),'[]') FROM public.acct_import_groups x),
    'bank_matches',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_cents',x.amount_cents::text)),'[]') FROM public.acct_bank_matches x),
    'document_states',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_document_states x));
END $$;
REVOKE ALL ON FUNCTION public.acct_books_export() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_books_export() TO authenticated;
-- ACCOUNTING EXPORTS END


-- Private evidence bucket. Existing buckets must already be private.
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM storage.buckets WHERE id='accounting-private' AND public) THEN RAISE EXCEPTION 'Accounting evidence bucket must be private'; END IF;
    INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
    VALUES('accounting-private','accounting-private',false,20971520,ARRAY['application/pdf','image/png','image/jpeg','image/webp','text/csv'])
    ON CONFLICT(id) DO NOTHING;
  END IF;
END $$;
COMMIT;
