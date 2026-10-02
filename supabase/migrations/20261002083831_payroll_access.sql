-- Payroll tables follow the permission system.
--
-- The payroll module (20260417_create_payroll_and_email.sql) gave every
-- signed-in person full read and write on its ten tables and read/insert on
-- payroll_audit_events. Team access (20260915145008_team_access.sql) gated
-- every other public table but left these open, so any member, including one
-- with no money permissions, could read or rewrite employee pay, the FEIN,
-- deposits and forms through PostgREST. The module is hidden behind
-- NEXT_PUBLIC_PAYROLL_ENABLED; the tables were not.
--
-- Payroll is books data, so accounting.manage guards it, for reads and writes.
-- The three history tables and the audit trail become append-only: select and
-- insert, never update or delete (no code edits or removes their rows). The
-- history triggers run as the caller, so they write under the insert policy.
-- process-automations uses the service role and is unaffected.

DO $$
DECLARE
 t record;
 old_name text;
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('organization_config', false),
   ('federal_tax_configs', false),
   ('state_tax_configs', false),
   ('config_change_history', true),
   ('payroll_employees', false),
   ('payroll_runs', false),
   ('payroll_run_history', true),
   ('payroll_tax_deposits', false),
   ('payroll_deposit_history', true),
   ('payroll_forms', false),
   ('payroll_audit_events', true)
 ) AS v(name, append_only) LOOP
  IF to_regclass('public.' || t.name) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.name);
  FOREACH old_name IN ARRAY ARRAY[
    'Authenticated users can view ' || t.name, 'Authenticated users can insert ' || t.name,
    'Authenticated users can update ' || t.name, 'Authenticated users can delete ' || t.name,
    t.name || '_select', t.name || '_insert', t.name || '_update', t.name || '_delete'
  ] LOOP
   EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', old_name, t.name);
  END LOOP;
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.has_permission(%L)))', t.name || '_select', t.name, 'accounting.manage');
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_permission(%L)))', t.name || '_insert', t.name, 'accounting.manage');
  IF NOT t.append_only THEN
   EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.has_permission(%L))) WITH CHECK ((SELECT public.has_permission(%L)))', t.name || '_update', t.name, 'accounting.manage', 'accounting.manage');
   EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT public.has_permission(%L)))', t.name || '_delete', t.name, 'accounting.manage');
  END IF;
 END LOOP;
END $$;
