import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { hasPermission, type AccessContext } from "@/lib/access-control";
import { API_KEY_COLUMNS, type ApiKeyRow } from "./keys";
import { membersApiAccess } from "./member-access";
import { API_SCOPE_KEYS, isApiScope } from "./scopes";

/** The scopes a key asks for, as creating a key and editing its access both send them. */
export const keyScopesField = z.array(z.string()).min(1, "Choose at least one scope");

export type KeyHolder =
  | {
      ok: true;
      /** The team member the key acts as. */
      memberId: string;
      /** The key acts as the signed-in person. */
      self: boolean;
      /** Whether a key for this member may carry the scope: a known API scope they hold. */
      holds: (scope: string) => boolean;
    }
  | { ok: false; status: number; error: string };

/**
 * Who a key acts as and what it may carry, decided the same way when a key is
 * created and when its access is edited. Your own key carries what you hold.
 * The owner may also manage an agent's key, which carries what the agent
 * holds, and only while the agent can sign in and use the API. People manage
 * their own keys: a key for a person would record their name on work they did
 * not do.
 */
export async function keyHolder(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string | null | undefined,
  verb: "create" | "edit",
): Promise<KeyHolder> {
  const me = access.member;
  if (!memberId || memberId === me.id) {
    if (!me.auth_user_id)
      return {
        ok: false,
        status: 403,
        error: `Sign in with your own account to ${verb === "create" ? "create" : "edit"} a key.`,
      };
    return {
      ok: true,
      memberId: me.id,
      self: true,
      holds: (scope) => isApiScope(scope) && hasPermission(access, scope),
    };
  }
  if (me.role !== "owner")
    return {
      ok: false,
      status: 403,
      error:
        verb === "create"
          ? "Only the owner can create keys for agents."
          : "Only the owner can edit another member's key.",
    };
  const [target] = await membersApiAccess(service, [memberId]).catch(() => []);
  if (!target) return { ok: false, status: 422, error: "That person is not on the team." };
  if (target.role !== "agent")
    return {
      ok: false,
      status: 422,
      error: `${target.name} is not an agent. People ${verb === "create" ? "create" : "edit"} their own keys.`,
    };
  if (target.status !== "active" || !target.has_sign_in)
    return {
      ok: false,
      status: 422,
      error: `${target.name} needs an active sign-in before a key can act as them.`,
    };
  if (!target.can_use_api)
    return {
      ok: false,
      status: 422,
      error: `${target.name} does not hold 'Use the API'. Grant it in Team > Access first.`,
    };
  return {
    ok: true,
    memberId: target.id,
    self: false,
    holds: (scope) => isApiScope(scope) && target.api_scopes.includes(scope),
  };
}

/** The refusal for scopes the key's member cannot give it, or null when every scope is allowed. */
export function refusedScopes(scopes: string[], holder: Extract<KeyHolder, { ok: true }>): string | null {
  const refused = scopes.filter((scope) => !holder.holds(scope));
  if (refused.length === 0) return null;
  return `Scopes ${holder.self ? "not available to you" : "this person does not hold"}: ${refused.join(", ")}`;
}

export const keyAccessSchema = z.object({
  scopes: keyScopesField,
  /** The key's updated_at as the editor saw it; a key changed since is refused. */
  expected_updated_at: z.string().min(1, "Reload the page and try again."),
});

export type KeyAccessResult =
  | { status: 200; body: { data: ApiKeyRow } }
  | { status: 409; body: { error: string; data: ApiKeyRow } }
  | { status: 403 | 404 | 422 | 500; body: { error: string } };

const NOT_FOUND = { status: 404, body: { error: "API key not found." } } as const;

/**
 * Replaces a key's scopes; the secret, prefix and member never change. Anyone
 * who can see a key may try, and then the create rules decide (keyHolder): you
 * edit your own keys, the owner also an agent's. The scopes must be known API
 * scopes the key's member holds, at least one. A revoked or expired key cannot
 * be edited, and a key changed since the editor loaded it is a 409 that
 * carries the key as it is now. public.api_key_set_scopes writes the change
 * and its api_key_changes row in one transaction.
 */
export async function editKeyAccess(
  service: SupabaseClient,
  access: AccessContext,
  id: string,
  input: unknown,
): Promise<KeyAccessResult> {
  if (!z.guid().safeParse(id).success) return NOT_FOUND;
  const parsed = keyAccessSchema.safeParse(input);
  if (!parsed.success)
    return { status: 422, body: { error: parsed.error.issues[0]?.message ?? "Check the form." } };
  const me = access.member;

  const { data: key, error: readError } = await service
    .from("api_keys")
    .select("id, team_member_id, created_by, revoked_at, expires_at")
    .eq("id", id)
    .maybeSingle();
  if (readError) return { status: 500, body: { error: "Could not edit the key." } };
  // Hidden from whoever cannot see it, as revoke does.
  if (!key || !(key.team_member_id === me.id || key.created_by === me.id || me.role === "owner"))
    return NOT_FOUND;
  if (key.revoked_at)
    return { status: 422, body: { error: "This key is revoked. Make a new key instead." } };
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now())
    return { status: 422, body: { error: "This key has expired. Make a new key instead." } };
  if (!key.team_member_id)
    return { status: 422, body: { error: "This key's member has left the team. Revoke it instead." } };

  const holder = await keyHolder(service, access, key.team_member_id, "edit");
  if (!holder.ok) return { status: holder.status as 403 | 422, body: { error: holder.error } };
  const wanted = new Set(parsed.data.scopes);
  const refusal = refusedScopes([...wanted], holder);
  if (refusal) return { status: 422, body: { error: refusal } };

  const { data, error } = await service.rpc("api_key_set_scopes", {
    p_key: id,
    // Stored in the order the API lists them, so every key reads the same way.
    p_scopes: API_SCOPE_KEYS.filter((scope) => wanted.has(scope)),
    p_expected_updated_at: parsed.data.expected_updated_at,
    p_actor: me.id,
  });
  if (!error && data) return { status: 200, body: { data: data as ApiKeyRow } };

  const message = error?.message ?? "";
  if (/API_KEY_CHANGED/.test(message)) {
    const { data: current } = await service.from("api_keys").select(API_KEY_COLUMNS).eq("id", id).single();
    if (current)
      return {
        status: 409,
        body: {
          error: "This key's access changed while you were editing. It now shows the latest; check it and save again.",
          data: current as unknown as ApiKeyRow,
        },
      };
  }
  if (/API_KEY_NOT_FOUND/.test(message)) return NOT_FOUND;
  if (/API_KEY_REVOKED/.test(message))
    return { status: 422, body: { error: "This key is revoked. Make a new key instead." } };
  if (/API_KEY_EXPIRED/.test(message))
    return { status: 422, body: { error: "This key has expired. Make a new key instead." } };
  if (/invalid input syntax|out of range/i.test(message))
    return { status: 422, body: { error: "Reload the page and try again." } };
  return { status: 500, body: { error: "Could not edit the key." } };
}
