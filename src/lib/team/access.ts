import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { siteConfig } from "@/config/site";
import {
  ADMIN_ALLOWED_EMAILS,
  DISABLE_ADMIN_AUTH,
  isLocalOrTestEnv,
} from "@/lib/env";
import {
  hasPermission,
  type AccessContext,
  type PermissionKey,
  type TeamMember,
} from "@/lib/access-control";

export type ResolvedAccess =
  | {
      state: "ok";
      access: AccessContext;
      /** Supabase auth user id; null for the demo and the local auth bypass. */
      userId: string | null;
      synthetic: boolean;
    }
  | { state: "signed_out" }
  | { state: "not_member"; email: string | null }
  | { state: "suspended"; access: AccessContext };

const SYNTHETIC_OWNER: TeamMember = {
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
};

function isInstallError(error: { code?: string; message?: string }) {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.code === "42P01" ||
    /does not exist|schema cache/i.test(error.message ?? "")
  );
}

function allowedByEnv(email: string | null | undefined) {
  if (!ADMIN_ALLOWED_EMAILS) return true;
  const list = ADMIN_ALLOWED_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes((email ?? "").toLowerCase());
}

/**
 * Who is signed in and what they may touch, once per request. The layout,
 * the module pages and the API guard all read this. The first person to sign
 * in claims the workspace as its owner; later strangers are refused. When the
 * optional ADMIN_ALLOWED_EMAILS list is set it still applies on top.
 */
export const resolveAccess = cache(async (): Promise<ResolvedAccess> => {
  if (isDemoMode() || (DISABLE_ADMIN_AUTH && isLocalOrTestEnv)) {
    return {
      state: "ok",
      access: { member: SYNTHETIC_OWNER, permissions: ["*"] },
      userId: null,
      synthetic: true,
    };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { state: "signed_out" };
  if (!allowedByEnv(user.email))
    return { state: "not_member", email: user.email ?? null };

  const { data, error } = await supabase.rpc("my_access");
  if (error) {
    if (isInstallError(error))
      throw new Error(
        "Team access is not installed. Apply supabase/migrations/20260915145008_team_access.sql and reload.",
      );
    throw error;
  }
  let payload = data as AccessContext | null;
  if (!payload) {
    const metadata = user.user_metadata as { display_name?: string } | null;
    const name =
      metadata?.display_name?.trim() ||
      user.email?.split("@")[0] ||
      "Owner";
    const { data: created, error: bootError } = await supabase.rpc(
      "bootstrap_team_owner",
      { p_name: name, p_email: user.email ?? "" },
    );
    if (bootError) {
      if (/TEAM_NOT_MEMBER/.test(bootError.message))
        return { state: "not_member", email: user.email ?? null };
      throw bootError;
    }
    payload = { member: created as TeamMember, permissions: ["*"] };
  }
  if (payload.member.status !== "active")
    return { state: "suspended", access: payload };
  return { state: "ok", access: payload, userId: user.id, synthetic: false };
});

/** Page gate: may the signed-in member open a screen behind this key? */
export async function canAccess(key: PermissionKey): Promise<boolean> {
  const resolved = await resolveAccess();
  return resolved.state === "ok" && hasPermission(resolved.access, key);
}
