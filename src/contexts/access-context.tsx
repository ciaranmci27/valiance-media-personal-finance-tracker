"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import {
  hasPermission as resolvePermission,
  type AccessContext as AccessData,
  type PermissionKey,
  type TeamMember,
  type TeamRole,
} from "@/lib/access-control";

type ProfilePatch = Partial<
  Pick<
    TeamMember,
    "name" | "title" | "theme_preference" | "privacy_hidden" | "show_net_worth"
  >
>;

interface AccessContextValue {
  access: AccessData;
  member: TeamMember;
  role: TeamRole;
  /** Demo mode or the local auth bypass: nothing is saved anywhere. */
  synthetic: boolean;
  hasPermission: (key: PermissionKey) => boolean;
  /** Saves the signed-in person's own name, title, theme or privacy eye. Throws on failure. */
  updateMe: (patch: ProfilePatch) => Promise<TeamMember>;
}

const AccessContext = React.createContext<AccessContextValue | undefined>(
  undefined,
);

/**
 * The signed-in member and their permissions, resolved by the dashboard
 * server layout so the first paint is already correct. Also keeps the DOM
 * theme in step with the account: the inline script in the layout handles
 * hard loads, this effect handles client navigation (a login redirect, a
 * change made on another device).
 */
export function AccessProvider({
  initialAccess,
  synthetic = false,
  children,
}: {
  initialAccess: AccessData;
  synthetic?: boolean;
  children: React.ReactNode;
}) {
  const [access, setAccess] = React.useState<AccessData>(initialAccess);
  React.useEffect(() => {
    setAccess(initialAccess);
  }, [initialAccess]);

  const theme = access.member.theme_preference;
  React.useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    if (root.getAttribute("data-theme") !== theme) {
      root.setAttribute("data-theme", theme);
    }
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* Private mode: the account still remembers. */
    }
  }, [theme]);

  const updateMe = React.useCallback(
    async (patch: ProfilePatch) => {
      if (synthetic) {
        const next = { ...access.member, ...patch };
        setAccess((current) => ({ ...current, member: next }));
        return next;
      }
      const supabase = createClient();
      const { data, error } = await supabase
        .from("team_members")
        .update(patch)
        .eq("id", access.member.id)
        .select("*")
        .single();
      if (error) throw error;
      const next = data as TeamMember;
      setAccess((current) => ({ ...current, member: next }));
      return next;
    },
    [access.member, synthetic],
  );

  const value = React.useMemo<AccessContextValue>(
    () => ({
      access,
      member: access.member,
      role: access.member.role,
      synthetic,
      hasPermission: (key) => resolvePermission(access, key),
      updateMe,
    }),
    [access, synthetic, updateMe],
  );

  return (
    <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
  );
}

export function useAccess() {
  const context = React.useContext(AccessContext);
  if (context === undefined) {
    throw new Error("useAccess must be used within an AccessProvider");
  }
  return context;
}
