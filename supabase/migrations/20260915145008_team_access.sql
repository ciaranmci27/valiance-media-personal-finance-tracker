-- Team access: who may sign in to the admin and what each person may touch.
-- team_members is the account row (role, status, theme). role_permissions holds
-- the defaults per role and team_member_permissions the per-person exceptions
-- (allow wins over the default, deny wins over allow). has_permission() is the
-- one predicate every policy and the books gate call. Membership replaces the
-- ADMIN_ALLOWED_EMAILS list; the first person to sign in becomes the owner
-- through bootstrap_team_owner(). Writes to team_members are ruled by the guard
-- trigger, not by RLS, because the rules are per column.
BEGIN;

-- ACCOUNTING TEAM BEGIN
CREATE TABLE IF NOT EXISTS public.team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  title TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspended_at TIMESTAMPTZ,
  theme_preference TEXT CHECK (theme_preference IN ('light','dark')),
  privacy_hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_auth_user_id ON public.team_members(auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_email ON public.team_members(lower(email));

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  permission_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission_key)
);

CREATE TABLE IF NOT EXISTS public.team_member_permissions (
  member_id UUID NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  created_by UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, permission_key)
);
CREATE INDEX IF NOT EXISTS idx_team_member_permissions_member ON public.team_member_permissions(member_id);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_members, public.role_permissions, public.team_member_permissions FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members, public.role_permissions, public.team_member_permissions TO authenticated, service_role;

-- The active member behind the session, or NULL for strangers and suspended accounts.
CREATE OR REPLACE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
 SELECT id FROM public.team_members WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION public.current_team_member_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
 SELECT role FROM public.team_members WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1
$fn$;

-- Owner: everything. Otherwise the person's own exception decides, and the
-- role default applies when there is none.
CREATE OR REPLACE FUNCTION public.has_permission(p_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
 WITH actor AS (SELECT id, role FROM public.team_members WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1)
 SELECT coalesce((SELECT role = 'owner' FROM actor), false)
  OR coalesce(
   (SELECT o.effect = 'allow' FROM public.team_member_permissions o, actor WHERE o.member_id = actor.id AND o.permission_key = p_key),
   EXISTS (SELECT 1 FROM public.role_permissions r, actor WHERE r.role = actor.role AND r.permission_key = p_key)
  )
$fn$;

-- The session's account and resolved permission list, for the layout and the
-- API guard. Suspended members get their row and no permissions; a signed-in
-- person with no row gets NULL.
CREATE OR REPLACE FUNCTION public.my_access() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE m public.team_members; perms jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO m FROM public.team_members WHERE auth_user_id = auth.uid() LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF m.status <> 'active' THEN perms := '[]'::jsonb;
 ELSIF m.role = 'owner' THEN perms := '["*"]'::jsonb;
 ELSE
  SELECT coalesce(jsonb_agg(k.key ORDER BY k.key), '[]'::jsonb) INTO perms FROM (
   SELECT r.permission_key AS key FROM public.role_permissions r
   WHERE r.role = m.role
    AND NOT EXISTS (SELECT 1 FROM public.team_member_permissions d WHERE d.member_id = m.id AND d.permission_key = r.permission_key AND d.effect = 'deny')
   UNION
   SELECT a.permission_key FROM public.team_member_permissions a WHERE a.member_id = m.id AND a.effect = 'allow'
  ) k;
 END IF;
 RETURN jsonb_build_object('member', to_jsonb(m), 'permissions', perms);
END $fn$;

-- First sign-in claims the workspace. Any later caller without a row is a
-- stranger and is refused, so the client can tell "not a member" from "empty".
CREATE OR REPLACE FUNCTION public.bootstrap_team_owner(p_name text, p_email text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE actor uuid := auth.uid(); m public.team_members;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'TEAM_FORBIDDEN'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(64219072);
 IF EXISTS (SELECT 1 FROM public.team_members) THEN RAISE EXCEPTION 'TEAM_NOT_MEMBER'; END IF;
 IF length(btrim(coalesce(p_name, ''))) = 0 OR length(btrim(coalesce(p_email, ''))) = 0 THEN RAISE EXCEPTION 'TEAM_INVALID'; END IF;
 PERFORM set_config('team.bootstrap', '1', true);
 INSERT INTO public.team_members(auth_user_id, name, email, role) VALUES (actor, btrim(p_name), lower(btrim(p_email)), 'owner') RETURNING * INTO m;
 PERFORM set_config('team.bootstrap', '', true);
 RETURN to_jsonb(m);
END $fn$;

-- Column-level rules for team_members. Owners may do anything except remove
-- the last active owner. People with team.manage may add members and edit or
-- suspend non-owners. Everyone may edit their own name, title, theme and
-- privacy eye.
-- The service role (invite route), the bootstrap function and a direct database
-- session (migrations, the SQL editor) skip the actor rules; the last-owner rule
-- holds for them too.
CREATE OR REPLACE FUNCTION public.team_members_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE actor_id uuid; actor_role text; manager boolean; others integer;
BEGIN
 IF TG_LEVEL = 'STATEMENT' THEN
  PERFORM pg_catalog.pg_advisory_xact_lock(64219072);
  RETURN NULL;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  NEW.email := lower(btrim(NEW.email));
  NEW.name := btrim(NEW.name);
  IF length(NEW.name) = 0 OR length(NEW.email) = 0 THEN RAISE EXCEPTION 'TEAM_INVALID'; END IF;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  NEW.updated_at := now();
  IF NEW.status = 'suspended' AND OLD.status <> 'suspended' THEN NEW.suspended_at := now(); END IF;
  IF NEW.status = 'active' THEN NEW.suspended_at := NULL; END IF;
 END IF;
 IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'owner' AND OLD.status = 'active'
    AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.status <> 'active') THEN
  SELECT count(*) INTO others FROM public.team_members WHERE role = 'owner' AND status = 'active' AND id <> OLD.id;
  IF others = 0 THEN RAISE EXCEPTION 'TEAM_LAST_OWNER'; END IF;
 END IF;
 IF current_setting('role', true) = 'service_role' OR current_setting('team.bootstrap', true) = '1'
    OR (auth.uid() IS NULL AND coalesce(current_setting('role', true), 'none') NOT IN ('authenticated', 'anon')) THEN
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
 END IF;
 actor_id := public.current_team_member_id();
 actor_role := coalesce(public.current_team_member_role(), '');
 IF actor_role = 'owner' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
 IF actor_id IS NULL THEN RAISE EXCEPTION 'TEAM_FORBIDDEN'; END IF;
 manager := public.has_permission('team.manage');
 IF TG_OP = 'INSERT' THEN
  IF NOT manager OR NEW.role <> 'member' THEN RAISE EXCEPTION 'TEAM_FORBIDDEN'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'TEAM_FORBIDDEN'; END IF;
 IF OLD.id = actor_id THEN
  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'TEAM_FORBIDDEN';
  END IF;
  RETURN NEW;
 END IF;
 IF manager AND OLD.role <> 'owner' THEN
  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.theme_preference IS DISTINCT FROM OLD.theme_preference OR NEW.privacy_hidden IS DISTINCT FROM OLD.privacy_hidden
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'TEAM_FORBIDDEN';
  END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'TEAM_FORBIDDEN';
END $fn$;

REVOKE ALL ON FUNCTION public.team_members_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_team_member_id(), public.current_team_member_role(), public.has_permission(text), public.my_access(), public.bootstrap_team_owner(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_team_member_id(), public.current_team_member_role(), public.has_permission(text), public.my_access(), public.bootstrap_team_owner(text, text) TO authenticated, service_role;

CREATE OR REPLACE TRIGGER team_members_lock BEFORE INSERT OR UPDATE OR DELETE ON public.team_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.team_members_guard();
CREATE OR REPLACE TRIGGER team_members_guard BEFORE INSERT OR UPDATE OR DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_guard();

DROP POLICY IF EXISTS team_members_select ON public.team_members;
DROP POLICY IF EXISTS team_members_insert ON public.team_members;
DROP POLICY IF EXISTS team_members_update ON public.team_members;
DROP POLICY IF EXISTS team_members_delete ON public.team_members;
CREATE POLICY team_members_select ON public.team_members FOR SELECT TO authenticated USING (auth_user_id = auth.uid() OR (SELECT public.has_permission('team.read')));
CREATE POLICY team_members_insert ON public.team_members FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY team_members_update ON public.team_members FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY team_members_delete ON public.team_members FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS role_permissions_select ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_owner ON public.role_permissions;
CREATE POLICY role_permissions_select ON public.role_permissions FOR SELECT TO authenticated USING (public.current_team_member_id() IS NOT NULL);
CREATE POLICY role_permissions_owner ON public.role_permissions FOR ALL TO authenticated USING (public.current_team_member_role() = 'owner') WITH CHECK (public.current_team_member_role() = 'owner');

DROP POLICY IF EXISTS team_member_permissions_select ON public.team_member_permissions;
DROP POLICY IF EXISTS team_member_permissions_owner ON public.team_member_permissions;
CREATE POLICY team_member_permissions_select ON public.team_member_permissions FOR SELECT TO authenticated USING (member_id = public.current_team_member_id() OR (SELECT public.has_permission('team.read')));
CREATE POLICY team_member_permissions_owner ON public.team_member_permissions FOR ALL TO authenticated USING (public.current_team_member_role() = 'owner') WITH CHECK (public.current_team_member_role() = 'owner');

INSERT INTO public.role_permissions(role, permission_key) VALUES
  ('admin', 'team.read'), ('admin', 'team.manage'),
  ('admin', 'income.read'), ('admin', 'income.manage'),
  ('admin', 'expenses.read'), ('admin', 'expenses.manage'),
  ('admin', 'net_worth.read'), ('admin', 'net_worth.manage'),
  ('admin', 'tax.read'), ('admin', 'tax.manage'),
  ('admin', 'automations.manage'), ('admin', 'settings.manage'), ('admin', 'accounting.manage'),
  ('member', 'team.read'), ('member', 'income.read'), ('member', 'expenses.read'),
  ('member', 'net_worth.read'), ('member', 'tax.read')
ON CONFLICT DO NOTHING;
-- ACCOUNTING TEAM END

-- Finance tables: reads need the module's read key, writes its manage key.
-- Tables absent from a database (the isolated accounting fixtures) are skipped.
DO $rls$
DECLARE t record; old_name text;
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('income_sources', 'income.read', 'income.manage'),
   ('income_entries', 'income.read', 'income.manage'),
   ('income_amounts', 'income.read', 'income.manage'),
   ('income_line_items', 'income.read', 'income.manage'),
   ('expenses', 'expenses.read', 'expenses.manage'),
   ('expense_history', 'expenses.read', 'expenses.manage'),
   ('net_worth', 'net_worth.read', 'net_worth.manage'),
   ('tax_estimates', 'tax.read', 'tax.manage'),
   ('email_accounts', 'settings.manage', 'settings.manage')
 ) AS v(name, read_key, manage_key) LOOP
  IF to_regclass('public.' || t.name) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.name);
  FOREACH old_name IN ARRAY ARRAY[
    'Authenticated users can view ' || t.name, 'Authenticated users can insert ' || t.name,
    'Authenticated users can update ' || t.name, 'Authenticated users can delete ' || t.name,
    t.name || '_all', t.name || '_select', t.name || '_insert', t.name || '_update', t.name || '_delete'
  ] LOOP
   EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', old_name, t.name);
  END LOOP;
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.has_permission(%L)))', t.name || '_select', t.name, t.read_key);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_permission(%L)))', t.name || '_insert', t.name, t.manage_key);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.has_permission(%L))) WITH CHECK ((SELECT public.has_permission(%L)))', t.name || '_update', t.name, t.manage_key, t.manage_key);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT public.has_permission(%L)))', t.name || '_delete', t.name, t.manage_key);
 END LOOP;
 IF to_regclass('public.webhook_receipts') IS NOT NULL THEN
  DROP POLICY IF EXISTS "Authenticated users can view webhook_receipts" ON public.webhook_receipts;
  DROP POLICY IF EXISTS webhook_receipts_select ON public.webhook_receipts;
  CREATE POLICY webhook_receipts_select ON public.webhook_receipts FOR SELECT TO authenticated USING ((SELECT public.has_permission('income.read')));
 END IF;
 IF to_regclass('public.automations') IS NOT NULL THEN
  DROP POLICY IF EXISTS "Users can view their own automations" ON public.automations;
  DROP POLICY IF EXISTS "Users can insert their own automations" ON public.automations;
  DROP POLICY IF EXISTS "Users can update their own automations" ON public.automations;
  DROP POLICY IF EXISTS "Users can delete their own automations" ON public.automations;
  DROP POLICY IF EXISTS "Service role can select all automations" ON public.automations;
  DROP POLICY IF EXISTS "Service role can update all automations" ON public.automations;
  DROP POLICY IF EXISTS automations_select ON public.automations;
  DROP POLICY IF EXISTS automations_insert ON public.automations;
  DROP POLICY IF EXISTS automations_update ON public.automations;
  DROP POLICY IF EXISTS automations_delete ON public.automations;
  CREATE POLICY automations_select ON public.automations FOR SELECT TO authenticated USING (auth.uid() = user_id AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automations_insert ON public.automations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automations_update ON public.automations FOR UPDATE TO authenticated USING (auth.uid() = user_id AND (SELECT public.has_permission('automations.manage'))) WITH CHECK (auth.uid() = user_id AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automations_delete ON public.automations FOR DELETE TO authenticated USING (auth.uid() = user_id AND (SELECT public.has_permission('automations.manage')));
 END IF;
 IF to_regclass('public.automation_actions') IS NOT NULL THEN
  DROP POLICY IF EXISTS "Users can view actions of their automations" ON public.automation_actions;
  DROP POLICY IF EXISTS "Users can insert actions for their automations" ON public.automation_actions;
  DROP POLICY IF EXISTS "Users can update actions of their automations" ON public.automation_actions;
  DROP POLICY IF EXISTS "Users can delete actions of their automations" ON public.automation_actions;
  DROP POLICY IF EXISTS "Service role can select all automation actions" ON public.automation_actions;
  DROP POLICY IF EXISTS automation_actions_select ON public.automation_actions;
  DROP POLICY IF EXISTS automation_actions_insert ON public.automation_actions;
  DROP POLICY IF EXISTS automation_actions_update ON public.automation_actions;
  DROP POLICY IF EXISTS automation_actions_delete ON public.automation_actions;
  CREATE POLICY automation_actions_select ON public.automation_actions FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_actions.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automation_actions_insert ON public.automation_actions FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_actions.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automation_actions_update ON public.automation_actions FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_actions.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage'))) WITH CHECK (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_actions.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automation_actions_delete ON public.automation_actions FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_actions.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage')));
 END IF;
 IF to_regclass('public.automation_runs') IS NOT NULL THEN
  DROP POLICY IF EXISTS "Users can view runs of their automations" ON public.automation_runs;
  DROP POLICY IF EXISTS "Users can insert runs for their automations" ON public.automation_runs;
  DROP POLICY IF EXISTS "Service role can insert automation runs" ON public.automation_runs;
  DROP POLICY IF EXISTS "Service role can update automation runs" ON public.automation_runs;
  DROP POLICY IF EXISTS automation_runs_select ON public.automation_runs;
  DROP POLICY IF EXISTS automation_runs_insert ON public.automation_runs;
  CREATE POLICY automation_runs_select ON public.automation_runs FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_runs.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage')));
  CREATE POLICY automation_runs_insert ON public.automation_runs FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_runs.automation_id AND a.user_id = auth.uid()) AND (SELECT public.has_permission('automations.manage')));
 END IF;
 IF to_regclass('public.notifications') IS NOT NULL THEN
  DROP POLICY IF EXISTS "Service role can insert notifications" ON public.notifications;
 END IF;
END $rls$;

-- Business profile: any active member reads it (the books, the estimator and
-- the dashboard need it); writing it is a settings job.
DROP POLICY IF EXISTS business_profile_read ON public.business_profile;
DROP POLICY IF EXISTS business_profile_insert ON public.business_profile;
DROP POLICY IF EXISTS business_profile_update ON public.business_profile;
DROP POLICY IF EXISTS business_profile_delete ON public.business_profile;
CREATE POLICY business_profile_read ON public.business_profile FOR SELECT TO authenticated USING ((public.current_team_member_id() IS NOT NULL));
CREATE POLICY business_profile_insert ON public.business_profile FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_permission('settings.manage')));
CREATE POLICY business_profile_update ON public.business_profile FOR UPDATE TO authenticated USING ((SELECT public.has_permission('settings.manage'))) WITH CHECK ((SELECT public.has_permission('settings.manage')));
CREATE POLICY business_profile_delete ON public.business_profile FOR DELETE TO authenticated USING ((SELECT public.has_permission('settings.manage')));

CREATE OR REPLACE FUNCTION public.business_profile_get() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ACCT_AUTH_REQUIRED'; END IF;
  IF public.current_team_member_id() IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  RETURN (SELECT to_jsonb(p) FROM public.business_profile p WHERE id=1);
END
$fn$;

-- The books: the owner of record, or an active member with accounting.manage
-- once the books exist. Before setup nobody passes, so the setup panel still shows.
CREATE OR REPLACE FUNCTION accounting.require_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=actor OR public.has_permission('accounting.manage'))) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $fn$;

CREATE OR REPLACE FUNCTION accounting.document_access(path text, uploading boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
 SELECT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=auth.uid() OR public.has_permission('accounting.manage'))) AND EXISTS(SELECT 1 FROM accounting.documents WHERE storage_path=path AND status<>'archived') AND (NOT uploading OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=path))
$fn$;

-- Only the team owner may claim the books when no owner of record exists yet.
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
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
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
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t IN ('settings.save','preferences.save') THEN
  SELECT version INTO current_version FROM accounting.settings WHERE id=1;
  IF (c->>'expected_version')::integer IS DISTINCT FROM current_version AND NOT (initialized AND coalesce((c->>'expected_version')::integer,0)=0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.settings SET primary_system=coalesce(c->>'primary_system',CASE c->>'authority_mode' WHEN 'admin_primary' THEN 'admin' WHEN 'wave_primary' THEN 'wave' WHEN 'parallel_pilot' THEN 'wave' END,primary_system),
   primary_system_since=CASE WHEN c?'primary_system_since' THEN (c->>'primary_system_since')::date ELSE primary_system_since END,
   transfer_window_days=coalesce((c->>'transfer_window_days')::smallint,transfer_window_days),version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
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
 ELSIF t LIKE 'import.%' OR t LIKE 'history.%' THEN result:=accounting.history_command(c);
 ELSIF t LIKE 'period.%' OR t LIKE 'reconciliation.%' THEN result:=accounting.close_command(c);
 ELSIF t LIKE 'payroll.%' OR t LIKE 'register.%' THEN result:=accounting.register_command(c);
 ELSIF t LIKE 'tax.%' THEN result:=accounting.tax_command(c);
 ELSIF t LIKE 'report.%' OR t LIKE 'package.%' THEN result:=accounting.report_command(c);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 INSERT INTO accounting.command_receipts(idempotency_key,payload_hash,actor_user_id,result) VALUES(key,hash,actor,result);
 RETURN result;
END $function$
;

COMMIT;
