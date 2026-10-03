import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { API_SCOPE_KEYS, type ApiScope } from "./scopes";

export interface MemberApiAccess {
  id: string;
  name: string;
  role: string;
  status: string;
  /** A key acts as the member's sign-in, so a member without one cannot use a key. */
  has_sign_in: boolean;
  /** Holds 'Use the API'. */
  can_use_api: boolean;
  /** API scopes the member holds, so a key for them can carry them. */
  api_scopes: ApiScope[];
}

/**
 * What each member may do through the API, resolved the way
 * public.has_permission resolves it: the owner holds everything; everyone
 * else gets their role's defaults, where a personal override wins.
 */
export async function membersApiAccess(
  service: SupabaseClient,
  memberIds?: string[],
): Promise<MemberApiAccess[]> {
  let membersQuery = service
    .from("team_members")
    .select("id, name, role, status, auth_user_id");
  if (memberIds) membersQuery = membersQuery.in("id", memberIds);
  const [members, roles, overrides] = await Promise.all([
    membersQuery,
    service.from("role_permissions").select("role, permission_key"),
    service
      .from("team_member_permissions")
      .select("member_id, permission_key, effect"),
  ]);
  if (members.error || roles.error || overrides.error)
    throw new Error("Could not read team access.");

  return (members.data ?? []).map((member) => {
    const holds = (key: string) => {
      if (member.role === "owner") return true;
      const override = (overrides.data ?? []).find(
        (row) => row.member_id === member.id && row.permission_key === key,
      );
      if (override) return override.effect === "allow";
      return (roles.data ?? []).some(
        (row) => row.role === member.role && row.permission_key === key,
      );
    };
    const active = member.status === "active";
    return {
      id: member.id as string,
      name: member.name as string,
      role: member.role as string,
      status: member.status as string,
      has_sign_in: !!member.auth_user_id,
      can_use_api: active && holds("api.use"),
      api_scopes: active ? API_SCOPE_KEYS.filter(holds) : [],
    };
  });
}
