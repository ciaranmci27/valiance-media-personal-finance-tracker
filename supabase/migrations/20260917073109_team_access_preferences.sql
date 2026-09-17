-- Display preferences on the member row: show_net_worth hides the Net Worth
-- tab and its dashboard figures for one person (for example while sharing a
-- screen). It is a preference, not a permission: the pages stay reachable and
-- RLS is unchanged. The guard keeps it self-only, like the theme and privacy eye.
BEGIN;

ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS show_net_worth BOOLEAN NOT NULL DEFAULT true;

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
     OR NEW.show_net_worth IS DISTINCT FROM OLD.show_net_worth OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'TEAM_FORBIDDEN';
  END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'TEAM_FORBIDDEN';
END $fn$;

COMMIT;
