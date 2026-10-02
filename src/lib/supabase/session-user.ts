import type { SupabaseClient } from "@supabase/supabase-js";

export type SessionUser = {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown> | null;
};

/**
 * The signed-in user, read from the session's access token. The project signs
 * tokens with an asymmetric key, so the signature is checked locally against
 * its published keys (fetched once and cached) instead of asking Supabase
 * Auth on every request; a token signed with a legacy symmetric secret still
 * falls back to that network check. An expired session is refreshed first,
 * exactly as `getUser` did. This is the same check PostgREST applies to every
 * query, so it trusts nothing the database would not. Null when signed out or
 * when the token does not verify.
 */
export async function sessionUser(
  client: SupabaseClient,
): Promise<SessionUser | null> {
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const { sub, email, user_metadata } = data.claims;
  return {
    id: sub,
    email: email ?? null,
    user_metadata: user_metadata ?? null,
  };
}
