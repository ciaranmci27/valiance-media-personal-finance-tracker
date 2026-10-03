/**
 * Team access vocabulary, shared by the server guard, the SQL seeds (kept in
 * step by hand) and the client. Owner = everything; the other roles carry the
 * defaults in role_permissions plus per-person exceptions.
 */
import type { Database } from "@/types/database";

export const TEAM_ROLES = ["owner", "admin", "member", "agent"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const MEMBER_STATUSES = ["active", "suspended"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const PERMISSIONS = [
  "team.read",
  "team.manage",
  "income.read",
  "income.manage",
  "expenses.read",
  "expenses.manage",
  "net_worth.read",
  "net_worth.manage",
  "tax.read",
  "tax.manage",
  "automations.manage",
  "settings.manage",
  "accounting.read",
  "accounting.draft",
  "accounting.payroll",
  "accounting.manage",
  "api.use",
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];
export type PermissionEffect = "allow" | "deny";

export type TeamMember = Database["public"]["Tables"]["team_members"]["Row"];
export type RolePermission =
  Database["public"]["Tables"]["role_permissions"]["Row"];
export type TeamMemberPermission =
  Database["public"]["Tables"]["team_member_permissions"]["Row"];

export interface AccessContext {
  member: TeamMember;
  /** Resolved keys for this person, or ["*"] for an owner. */
  permissions: Array<PermissionKey | "*">;
}

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function hasPermission(
  access: AccessContext | null | undefined,
  key: PermissionKey,
): boolean {
  if (!access || access.member.status !== "active") return false;
  return access.permissions.includes("*") || access.permissions.includes(key);
}

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  agent: "Agent",
};

export const ROLE_ORDER: Record<TeamRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  agent: 3,
};

/** Roles whose defaults can be edited; owners always have everything. */
export const EDITABLE_ROLES: TeamRole[] = ["admin", "member", "agent"];

/** Columns a person may change on their own row. */
export const PROFILE_FIELDS = [
  "name",
  "title",
  "theme_preference",
  "privacy_hidden",
  "show_net_worth",
] as const;

export const PERMISSION_GROUPS: Array<{
  id: string;
  label: string;
  permissions: Array<{
    key: PermissionKey;
    label: string;
    description: string;
  }>;
}> = [
  {
    id: "workspace",
    label: "Workspace",
    permissions: [
      {
        key: "team.read",
        label: "View team",
        description: "See who is on the team.",
      },
      {
        key: "team.manage",
        label: "Manage team",
        description:
          "Add members, edit names and titles, suspend and reactivate anyone who is not an owner.",
      },
      {
        key: "settings.manage",
        label: "Business settings",
        description:
          "Business profile, tax years, email accounts, export and trash.",
      },
      {
        key: "automations.manage",
        label: "Automations",
        description: "Create and run their own automations.",
      },
    ],
  },
  {
    id: "money",
    label: "Money",
    permissions: [
      {
        key: "income.read",
        label: "View income",
        description: "Income entries, sources and line items.",
      },
      {
        key: "income.manage",
        label: "Edit income",
        description: "Add, change and delete income and sources.",
      },
      {
        key: "expenses.read",
        label: "View expenses",
        description: "Fixed expenses and their history.",
      },
      {
        key: "expenses.manage",
        label: "Edit expenses",
        description: "Add, change and delete expenses.",
      },
      {
        key: "net_worth.read",
        label: "View net worth",
        description: "Net worth entries over time.",
      },
      {
        key: "net_worth.manage",
        label: "Edit net worth",
        description: "Add, change and delete net worth entries.",
      },
      {
        key: "tax.read",
        label: "View tax estimator",
        description: "Tax years and estimated payments.",
      },
      {
        key: "tax.manage",
        label: "Edit tax estimator",
        description: "Change the figures behind the estimates.",
      },
    ],
  },
  {
    id: "books",
    label: "Books",
    permissions: [
      {
        key: "accounting.read",
        label: "View the books",
        description:
          "Read reports, accounts and transactions through the API (needs Use the API and a key). Cannot change anything.",
      },
      {
        key: "accounting.draft",
        label: "Prepare books drafts",
        description:
          "Through the API: create and edit draft transactions, categorize imports and add rules. Nothing posts until someone with Accounting reviews it.",
      },
      {
        key: "accounting.payroll",
        label: "View payroll and 1099 reports",
        description:
          "Through the API: the payroll register, contractor (1099) worksheet and tax workpapers. Read only, and a key must also include it.",
      },
      {
        key: "accounting.manage",
        label: "Accounting",
        description:
          "Open the books, categorize transactions and post entries. Setting up the books stays with the owner.",
      },
    ],
  },
  {
    id: "api",
    label: "API",
    permissions: [
      {
        key: "api.use",
        label: "Use the API",
        description:
          "Create personal API keys. A key can only read what this person can, and only the parts it was given.",
      },
    ],
  },
];

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
