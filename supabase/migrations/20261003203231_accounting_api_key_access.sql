-- Edit a finance API key's access in place (Settings > API > Edit access).
--
-- Until now a key could only be created or revoked, so adding a scope (say
-- "Payroll and 1099 reports" to an agent's key) meant a new secret pasted into
-- the agent again. This migration lets the server replace a key's scopes; the
-- secret, prefix, member and creation time stay as they are.
--
-- 1. public.api_key_changes: one row per change of a key's scopes, before and
--    after, and who made it. Written by public.api_keys_guard, so every scope
--    change is recorded whichever path makes it. Append only: the server may
--    insert and read, nobody may update or delete; signed-in people read the
--    rows for the keys they can see.
-- 2. public.api_keys_guard, restated in full: a revoked key's scopes cannot
--    change either, a scope change writes its api_key_changes row, and
--    updated_at moves only when the key's settings change. Before, the
--    last_used_at stamp of every API request moved it too, so updated_at could
--    not tell two edits apart from an agent's polling.
-- 3. public.api_key_set_scopes: the server's one write path. It locks the key,
--    refuses an unknown, revoked or expired key, refuses when updated_at is no
--    longer what the editor saw (two edits never silently overwrite each
--    other), and records who made the change. Which scopes are allowed (known
--    API scopes the key's member holds) is decided by the server before the
--    call, the same check as creating a key; public.api_act still checks both
--    the key and the member on every request, so a change applies from the
--    key's next request.

CREATE TABLE IF NOT EXISTS public.api_key_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  changed_by UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  scopes_before TEXT[] NOT NULL,
  scopes_after TEXT[] NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_key_changes_key ON public.api_key_changes(api_key_id, at DESC);

ALTER TABLE public.api_key_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_key_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.api_key_changes TO authenticated;
GRANT SELECT, INSERT ON public.api_key_changes TO service_role;

DROP POLICY IF EXISTS api_key_changes_select ON public.api_key_changes;
CREATE POLICY api_key_changes_select ON public.api_key_changes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.api_keys k WHERE k.id = api_key_id
    AND (k.team_member_id = public.current_team_member_id() OR k.created_by = public.current_team_member_id()
      OR public.current_team_member_role() = 'owner')));

-- A revoke is final, the secret and creation time never change, and a key
-- never moves to another member. team_member_id and created_by may still
-- become NULL: their foreign keys are ON DELETE SET NULL, which runs as an
-- UPDATE and fires this trigger. Scopes may change (Edit access) until the
-- key is revoked, and each change is recorded. updated_at is when the key's
-- settings last changed: the last use stamp alone does not move it.
CREATE OR REPLACE FUNCTION public.api_keys_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
  RAISE EXCEPTION 'API key % is revoked; a revoke cannot be changed', OLD.id USING ERRCODE = '42501';
 END IF;
 IF NEW.key_hash IS DISTINCT FROM OLD.key_hash OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'API key % secret and creation time cannot change', OLD.id USING ERRCODE = '42501';
 END IF;
 IF (NEW.team_member_id IS DISTINCT FROM OLD.team_member_id AND NEW.team_member_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
  RAISE EXCEPTION 'API key % cannot move to another member', OLD.id USING ERRCODE = '42501';
 END IF;
 IF NEW.scopes IS DISTINCT FROM OLD.scopes THEN
  IF OLD.revoked_at IS NOT NULL THEN
   RAISE EXCEPTION 'API key % is revoked; its access cannot change', OLD.id USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.api_key_changes(api_key_id, changed_by, scopes_before, scopes_after)
   VALUES (OLD.id, nullif(current_setting('api.changed_by', true), '')::uuid, OLD.scopes, NEW.scopes);
 END IF;
 IF (to_jsonb(NEW) - 'last_used_at' - 'updated_at') = (to_jsonb(OLD) - 'last_used_at' - 'updated_at') THEN
  NEW.updated_at := OLD.updated_at;
 ELSE
  NEW.updated_at := now();
 END IF;
 RETURN NEW;
END $fn$;

-- Replaces a key's scopes for the server (Settings > API > Edit access).
-- p_expected_updated_at is the updated_at the editor saw; anything else is
-- API_KEY_CHANGED. The same set in another order is not a change. Answers
-- with the key, every column but key_hash.
CREATE OR REPLACE FUNCTION public.api_key_set_scopes(p_key uuid, p_scopes jsonb, p_expected_updated_at timestamptz, p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE k public.api_keys; next_scopes text[];
BEGIN
 IF jsonb_typeof(p_scopes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'API_KEY_SCOPES_EMPTY'; END IF;
 SELECT coalesce(array_agg(s ORDER BY n), '{}') INTO next_scopes
  FROM (SELECT s, min(n) n FROM jsonb_array_elements_text(p_scopes) WITH ORDINALITY AS e(s, n) GROUP BY s) d;
 IF cardinality(next_scopes) = 0 THEN RAISE EXCEPTION 'API_KEY_SCOPES_EMPTY'; END IF;
 SELECT * INTO k FROM public.api_keys WHERE id = p_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'API_KEY_NOT_FOUND'; END IF;
 IF k.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'API_KEY_REVOKED'; END IF;
 IF k.expires_at IS NOT NULL AND k.expires_at <= now() THEN RAISE EXCEPTION 'API_KEY_EXPIRED'; END IF;
 IF p_expected_updated_at IS NULL OR k.updated_at <> p_expected_updated_at THEN RAISE EXCEPTION 'API_KEY_CHANGED'; END IF;
 IF (SELECT array_agg(s ORDER BY s) FROM unnest(k.scopes) s) IS DISTINCT FROM (SELECT array_agg(s ORDER BY s) FROM unnest(next_scopes) s) THEN
  PERFORM set_config('api.changed_by', coalesce(p_actor::text, ''), true);
  UPDATE public.api_keys SET scopes = next_scopes WHERE id = p_key RETURNING * INTO k;
  PERFORM set_config('api.changed_by', '', true);
 END IF;
 RETURN to_jsonb(k) - 'key_hash';
END $fn$;

REVOKE ALL ON FUNCTION public.api_key_set_scopes(uuid, jsonb, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_key_set_scopes(uuid, jsonb, timestamptz, uuid) TO service_role;
