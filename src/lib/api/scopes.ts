import type { PermissionKey } from "@/lib/access-control";

/**
 * Permissions a key can carry. A key works only for scopes its member also
 * holds (checked in SQL by public.api_act on every call). Books writes are
 * drafts only: nothing an agent writes reaches the official numbers until the
 * owner reviews and posts it in the app.
 */
export const API_SCOPES = [
  {
    key: "accounting.read",
    access: "read",
    label: "Books",
    description:
      "Reports, accounts and transactions. The official business numbers.",
  },
  {
    key: "accounting.draft",
    access: "write",
    label: "Books drafts",
    description:
      "Prepare draft transactions, categorize imports and add rules. You review and post every draft in the app.",
  },
  {
    key: "income.read",
    access: "read",
    label: "Income tracker",
    description: "Your manual monthly take-home record and its sources.",
  },
  {
    key: "income.manage",
    access: "write",
    label: "Edit income tracker",
    description: "Add, change and delete income items.",
  },
  {
    key: "expenses.read",
    access: "read",
    label: "Expenses",
    description: "Known fixed monthly costs and subscriptions.",
  },
  {
    key: "expenses.manage",
    access: "write",
    label: "Edit expenses",
    description: "Add, change, pause and delete expenses and subscriptions.",
  },
  {
    key: "net_worth.read",
    access: "read",
    label: "Net worth",
    description: "Net worth entries over time.",
  },
  {
    key: "net_worth.manage",
    access: "write",
    label: "Edit net worth",
    description: "Add, change and delete net worth entries.",
  },
  {
    key: "tax.read",
    access: "read",
    label: "Tax estimator",
    description: "Tax years and estimated payments.",
  },
] as const satisfies ReadonlyArray<{
  key: PermissionKey;
  access: "read" | "write";
  label: string;
  description: string;
}>;

export type ApiScope = (typeof API_SCOPES)[number]["key"];

export const API_SCOPE_KEYS: readonly ApiScope[] = API_SCOPES.map(
  (scope) => scope.key,
);

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPE_KEYS as readonly string[]).includes(value);
}

/** Lifetimes offered when creating a key; 90 days unless the person picks another. */
export const API_KEY_LIFETIMES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;

export const DEFAULT_API_KEY_DAYS = 90;
