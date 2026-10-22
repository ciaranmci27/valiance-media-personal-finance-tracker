-- The tracker's records are never permanently deleted.
--
-- Income sources and entries, expenses and their history, net worth, tax
-- estimates and automations already go to Trash (deleted_at) and come back
-- with Restore. The Trash page also offered "Delete permanently", which
-- really removed rows. That button is gone, and the database now refuses
-- DELETE and TRUNCATE on these tables for every role, the same rule the
-- accounting books and the PM app follow.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.forbid_tracker_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are never permanently deleted. Move them to Trash instead.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'income_sources', 'income_entries', 'expenses', 'expense_history', 'net_worth', 'tax_estimates', 'automations'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_hard_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.forbid_tracker_hard_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_tracker_hard_delete()', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.forbid_tracker_hard_delete() FROM PUBLIC, anon;
