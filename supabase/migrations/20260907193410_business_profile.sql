BEGIN;
-- ACCOUNTING BUSINESS PROFILE BEGIN
CREATE TABLE public.business_profile (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  dba text,
  entity_type text NOT NULL CHECK (entity_type IN ('llc','corporation','sole_proprietorship','partnership')),
  ein text CHECK (ein IS NULL OR ein ~ '^[0-9]{2}-?[0-9]{7}$'),
  formation_date date,
  state_of_formation text,
  address jsonb CHECK (address IS NULL OR jsonb_typeof(address) = 'object'),
  phone text,
  email text,
  tax_classification text NOT NULL CHECK (tax_classification IN ('disregarded','s_corp','c_corp','partnership')),
  tax_classification_since smallint CHECK (tax_classification_since BETWEEN 1900 AND 2100),
  home_state text,
  is_sstb boolean NOT NULL DEFAULT false,
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  books_timezone text NOT NULL DEFAULT 'America/Phoenix',
  earliest_history_date date NOT NULL DEFAULT '2022-12-31',
  owner_name text,
  owner_title text,
  accountant_name text,
  accountant_email text,
  default_email_account_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.business_profile ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_profile FROM PUBLIC, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_profile TO authenticated;
CREATE POLICY business_profile_read ON public.business_profile FOR SELECT TO authenticated USING (true);
CREATE POLICY business_profile_insert ON public.business_profile FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY business_profile_update ON public.business_profile FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY business_profile_delete ON public.business_profile FOR DELETE TO authenticated USING (true);

CREATE FUNCTION public.business_profile_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE has_observations boolean;
BEGIN
  IF TG_LEVEL = 'STATEMENT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(64219071);
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ACCT_PROFILE_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.books_timezone) THEN
    RAISE EXCEPTION 'ACCT_INVALID_TIMEZONE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
    IF NEW.books_timezone IS DISTINCT FROM OLD.books_timezone AND to_regclass('accounting.bank_transactions') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS(SELECT 1 FROM accounting.bank_transactions)' INTO has_observations;
      IF has_observations THEN RAISE EXCEPTION 'ACCT_TIMEZONE_FROZEN'; END IF;
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_profile_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER business_profile_lock BEFORE INSERT OR UPDATE OR DELETE ON public.business_profile
  FOR EACH STATEMENT EXECUTE FUNCTION public.business_profile_guard();
CREATE TRIGGER business_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON public.business_profile
  FOR EACH ROW EXECUTE FUNCTION public.business_profile_guard();

CREATE FUNCTION public.business_profile_get() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ACCT_AUTH_REQUIRED'; END IF;
  RETURN (SELECT to_jsonb(p) FROM public.business_profile p WHERE id=1);
END
$fn$;
REVOKE ALL ON FUNCTION public.business_profile_get() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.business_profile_get() TO authenticated;
-- ACCOUNTING BUSINESS PROFILE END
DO $seed$
DECLARE existing_name text;
BEGIN
  IF to_regclass('public.acct_settings') IS NOT NULL THEN
    EXECUTE 'SELECT legal_name FROM public.acct_settings LIMIT 1' INTO existing_name;
  END IF;
  INSERT INTO public.business_profile(legal_name,entity_type,tax_classification)
    VALUES(coalesce(nullif(btrim(existing_name),''),'Valiance Media LLC'),'llc','s_corp');
END
$seed$;
COMMIT;
