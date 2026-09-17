/**
 * Team reads and writes from the browser. Rows go straight to Supabase under
 * RLS and the team_members guard (the same pattern as business-profile.ts);
 * only account creation and email changes need the server routes.
 */
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { siteConfig } from "@/config/site";
import { teamError } from "@/lib/team/errors";
import {
  ROLE_ORDER,
  type PermissionEffect,
  type PermissionKey,
  type RolePermission,
  type TeamMember,
  type TeamMemberPermission,
  type TeamRole,
} from "@/lib/access-control";

export interface AccessPolicy {
  role_permissions: RolePermission[];
  member_permissions: TeamMemberPermission[];
}

export class TeamRequestError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const DEMO_TEAM: TeamMember[] = [
  {
    id: "00000000-0000-4000-8000-000000000000",
    auth_user_id: null,
    name: siteConfig.realName,
    email: "owner@demo.local",
    title: null,
    role: "owner",
    status: "active",
    suspended_at: null,
    theme_preference: null,
    privacy_hidden: false,
    show_net_worth: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000001",
    auth_user_id: null,
    name: "Ada Bookkeeper",
    email: "ada@demo.local",
    title: "Bookkeeper",
    role: "admin",
    status: "active",
    suspended_at: null,
    theme_preference: null,
    privacy_hidden: false,
    show_net_worth: true,
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
  },
];

const DEMO_ADMIN_KEYS = [
  "team.read", "team.manage", "income.read", "income.manage", "expenses.read",
  "expenses.manage", "net_worth.read", "net_worth.manage", "tax.read", "tax.manage",
  "automations.manage", "settings.manage", "accounting.manage",
];
const DEMO_MEMBER_KEYS = ["team.read", "income.read", "expenses.read", "net_worth.read", "tax.read"];
const DEMO_POLICY: AccessPolicy = {
  role_permissions: [
    ...DEMO_ADMIN_KEYS.map(
      (key): RolePermission => ({ role: "admin", permission_key: key, created_at: "2026-01-01T00:00:00Z" }),
    ),
    ...DEMO_MEMBER_KEYS.map(
      (key): RolePermission => ({ role: "member", permission_key: key, created_at: "2026-01-01T00:00:00Z" }),
    ),
  ],
  member_permissions: [],
};

function demoOnly(): never {
  throw new Error("Demo mode is read-only.");
}

export function sortMembers(members: TeamMember[]): TeamMember[] {
  return [...members].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name),
  );
}

export async function loadTeam(): Promise<TeamMember[]> {
  if (isDemoMode()) return DEMO_TEAM;
  const supabase = createClient();
  const { data, error } = await supabase.from("team_members").select("*");
  if (error) throw new Error(teamError(error, "The team could not be loaded."));
  return sortMembers((data ?? []) as TeamMember[]);
}

export type MemberPatch = Partial<
  Pick<TeamMember, "name" | "title" | "status" | "role" | "theme_preference">
>;

export async function updateMember(
  id: string,
  patch: MemberPatch,
): Promise<TeamMember> {
  if (isDemoMode()) demoOnly();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("team_members")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(teamError(error));
  return data as TeamMember;
}

export async function loadAccessPolicy(): Promise<AccessPolicy> {
  if (isDemoMode()) return DEMO_POLICY;
  const supabase = createClient();
  const [roles, members] = await Promise.all([
    supabase.from("role_permissions").select("*"),
    supabase.from("team_member_permissions").select("*"),
  ]);
  if (roles.error) throw new Error(teamError(roles.error, "Permissions could not be loaded."));
  if (members.error) throw new Error(teamError(members.error, "Permissions could not be loaded."));
  return {
    role_permissions: (roles.data ?? []) as RolePermission[],
    member_permissions: (members.data ?? []) as TeamMemberPermission[],
  };
}

export async function setRoleDefault(
  role: TeamRole,
  key: PermissionKey,
  enabled: boolean,
): Promise<void> {
  if (isDemoMode()) demoOnly();
  const supabase = createClient();
  const { error } = enabled
    ? await supabase
        .from("role_permissions")
        .upsert({ role, permission_key: key }, { onConflict: "role,permission_key" })
    : await supabase
        .from("role_permissions")
        .delete()
        .eq("role", role)
        .eq("permission_key", key);
  if (error) throw new Error(teamError(error, "The default could not be saved."));
}

export async function setMemberOverride(
  memberId: string,
  key: PermissionKey,
  effect: PermissionEffect | null,
  createdBy: string,
): Promise<void> {
  if (isDemoMode()) demoOnly();
  const supabase = createClient();
  const { error } = effect
    ? await supabase
        .from("team_member_permissions")
        .upsert(
          { member_id: memberId, permission_key: key, effect, created_by: createdBy },
          { onConflict: "member_id,permission_key" },
        )
    : await supabase
        .from("team_member_permissions")
        .delete()
        .eq("member_id", memberId)
        .eq("permission_key", key);
  if (error) throw new Error(teamError(error, "The exception could not be saved."));
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    details?: Record<string, string[] | string>;
  } & T;
  if (!response.ok) {
    const fields: Record<string, string> = {};
    for (const [field, messages] of Object.entries(payload.details ?? {})) {
      fields[field] = Array.isArray(messages) ? messages[0] : String(messages);
    }
    throw new TeamRequestError(
      payload.error ?? "Something went wrong. Nothing was saved.",
      response.status,
      fields,
    );
  }
  return payload;
}

export async function inviteMember(input: {
  name: string;
  email: string;
  password: string;
  role: TeamRole;
}): Promise<TeamMember> {
  if (isDemoMode()) demoOnly();
  const { member } = await post<{ member: TeamMember }>(
    "/api/admin/team/invite",
    input,
  );
  return member;
}

export async function changeMemberEmail(
  id: string,
  email: string,
): Promise<TeamMember> {
  if (isDemoMode()) demoOnly();
  const { member } = await post<{ member: TeamMember }>(
    `/api/admin/team/${id}/email`,
    { email },
  );
  return member;
}

/** A readable password the owner can hand over out of band. */
export function generatePassword(length = 14): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}
