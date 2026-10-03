-- Finance MCP server (/api/mcp). It is a second front door to the v1 API, not
-- a second API: every tool call runs through the same route handler and
-- withApi, so the key, scopes, member permissions, rate limit and request log
-- are the ones REST uses. Two additions only:
--
-- 1. public.api_key_profile: who a key acts as and which of its scopes still
--    work (on the key AND held by the member), so the server lists only the
--    tools a key can use. It changes nothing and does not count toward the
--    rate limit; each tool call is still authorized by api_authorize.
-- 2. api_requests.via: whether a request came over REST or MCP.

ALTER TABLE public.api_requests ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'rest' CHECK (via IN ('rest', 'mcp'));

-- The key checks of public.api_act, then the member's live scopes. Raises the
-- same API_* codes, so the server answers a bad key the way REST does.
CREATE OR REPLACE FUNCTION public.api_key_profile(p_key_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE k public.api_keys; m public.team_members;
BEGIN
 SELECT * INTO k FROM public.api_keys WHERE key_hash = p_key_hash;
 IF NOT FOUND OR k.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'API_KEY_INVALID'; END IF;
 IF k.disabled_at IS NOT NULL THEN RAISE EXCEPTION 'API_KEY_DISABLED'; END IF;
 IF k.expires_at IS NOT NULL AND k.expires_at <= now() THEN RAISE EXCEPTION 'API_KEY_EXPIRED'; END IF;
 SELECT * INTO m FROM public.team_members WHERE id = k.team_member_id;
 IF NOT FOUND OR m.status <> 'active' OR m.auth_user_id IS NULL THEN RAISE EXCEPTION 'API_MEMBER_INACTIVE'; END IF;
 PERFORM set_config('request.jwt.claim.sub', m.auth_user_id::text, true);
 PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', m.auth_user_id, 'role', 'authenticated')::text, true);
 IF NOT public.has_permission('api.use') THEN RAISE EXCEPTION 'API_MEMBER_NO_API'; END IF;
 RETURN jsonb_build_object(
  'key_id', k.id,
  'member_id', m.id,
  'member_name', m.name,
  'role', m.role,
  'expires_at', k.expires_at,
  'scopes', coalesce((SELECT jsonb_agg(s ORDER BY s) FROM unnest(k.scopes) s WHERE public.has_permission(s)), '[]'::jsonb));
END $fn$;

REVOKE ALL ON FUNCTION public.api_key_profile(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_key_profile(text) TO service_role;
