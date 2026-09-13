import type {
  AccountingAccount,
  EntryContext,
  JournalEntry,
} from "./contracts";
import type { AccountProfile } from "./workflows";

/**
 * The category menu for a bank movement. Money in leads with income, money
 * out with expenses; the other side of the chart stays reachable under
 * closed groups named for what choosing them means (a refund, an owner
 * movement). System and suspense accounts never appear: they are picked by
 * the books, not by the owner. Pure, so both pickers and the tests share it.
 */
export type CategoryDirection = "in" | "out" | "any";
/** The kinds a category choice can set; invoice receipts come only from the invoice sync. */
export type CategoryKind = Exclude<EntryContext["kind"], "invoice_receipt">;
export interface CategoryOption {
  value: string;
  label: string;
  keywords: string;
  detail?: string;
}
export type CategoryGroupId =
  | "suggested"
  | "income"
  | "expense"
  | "refund"
  | "owner"
  | "asset"
  | "liability"
  | "equity"
  | "current";
export interface CategoryGroup {
  id: CategoryGroupId;
  label: string;
  collapsed: boolean;
  options: CategoryOption[];
}
/** The picker row that opens the transfer dialog instead of choosing an account. */
export const TRANSFER_CATEGORY = "__transfer__";

const HIDDEN_SUBTYPES = new Set([
  "uncategorized",
  "transit",
  "undeposited",
  "accumulated_depreciation",
  "opening_balance",
  "retained_earnings",
]);
const HIDDEN_PURPOSES = new Set([
  "uncategorized_income",
  "uncategorized_expense",
  "opening_balance_equity",
  "opening_retained_earnings",
  "transfers_in_transit",
]);

/** An account the owner can put a movement against. Cash accounts are transfers, not categories. */
export function isCategoryAccount(
  account: AccountingAccount,
  profile: AccountProfile | undefined,
): boolean {
  if (account.is_archived) return false;
  if (!profile) return true;
  if (profile.cash_kind !== "none") return false;
  if (HIDDEN_SUBTYPES.has(profile.subtype)) return false;
  if (profile.purpose && HIDDEN_PURPOSES.has(profile.purpose)) return false;
  return true;
}

type Bucket = "income" | "expense" | "owner" | "asset" | "liability" | "equity";

function bucketOf(
  account: AccountingAccount,
  profile: AccountProfile | undefined,
): Bucket {
  if (profile?.subtype === "owner_equity") return "owner";
  return account.account_type;
}

function option(account: AccountingAccount): CategoryOption {
  return { value: account.id, label: account.name, keywords: account.code };
}

function byName(a: CategoryOption, b: CategoryOption) {
  return a.label.localeCompare(b.label);
}

/** The base menu for a direction. Memoize per direction; the row-specific parts come from `categoryMenu`. */
export function categoryGroups(
  accounts: AccountingAccount[],
  profiles: AccountProfile[],
  direction: CategoryDirection,
): CategoryGroup[] {
  const profileById = new Map(profiles.map((p) => [p.account_id, p]));
  const buckets: Record<Bucket, CategoryOption[]> = {
    income: [],
    expense: [],
    owner: [],
    asset: [],
    liability: [],
    equity: [],
  };
  for (const account of accounts) {
    const profile = profileById.get(account.id);
    if (!isCategoryAccount(account, profile)) continue;
    buckets[bucketOf(account, profile)].push(option(account));
  }
  for (const list of Object.values(buckets)) list.sort(byName);
  const group = (
    id: CategoryGroupId,
    label: string,
    collapsed: boolean,
    options: CategoryOption[],
  ): CategoryGroup[] =>
    options.length ? [{ id, label, collapsed, options }] : [];
  if (direction === "any")
    return [
      ...group("income", "Income", false, buckets.income),
      ...group("expense", "Expenses", false, buckets.expense),
      ...group("asset", "Assets", true, buckets.asset),
      ...group("liability", "Liabilities", true, buckets.liability),
      ...group(
        "equity",
        "Equity",
        true,
        [...buckets.owner, ...buckets.equity].sort(byName),
      ),
    ];
  const money = direction === "in";
  return [
    ...group(
      money ? "income" : "expense",
      money ? "Income" : "Expenses",
      false,
      money ? buckets.income : buckets.expense,
    ),
    ...group(
      "refund",
      money ? "Refund of an expense" : "Refund to a customer",
      true,
      money ? buckets.expense : buckets.income,
    ),
    ...group(
      "owner",
      money ? "Owner contribution" : "Owner draw",
      true,
      buckets.owner,
    ),
    ...group("asset", "Assets", true, buckets.asset),
    ...group("liability", "Liabilities", true, buckets.liability),
    ...group("equity", "Other equity", true, buckets.equity),
  ];
}

/**
 * The menu for one movement: a short Suggested group from what the books
 * already know, the base groups, and the entry's current category when the
 * filter would otherwise hide it (it must stay visible to be changed).
 */
export function categoryMenu(
  base: CategoryGroup[],
  accounts: AccountingAccount[],
  context: {
    current?: string | null;
    prior?: JournalEntry["prior_treatment"];
    payeeDefault?: string | null;
  },
): CategoryGroup[] {
  const visible = new Map<string, CategoryOption>();
  for (const g of base) for (const o of g.options) visible.set(o.value, o);
  const suggested: CategoryOption[] = [];
  const prior = context.prior;
  if (
    prior?.last_category &&
    prior.count > 0 &&
    visible.has(prior.last_category)
  )
    suggested.push({
      ...visible.get(prior.last_category)!,
      detail:
        prior.count === 1
          ? "Chosen once before"
          : `Chosen ${prior.count} times before`,
    });
  if (
    context.payeeDefault &&
    visible.has(context.payeeDefault) &&
    !suggested.some((o) => o.value === context.payeeDefault)
  )
    suggested.push({
      ...visible.get(context.payeeDefault)!,
      detail: "Payee default",
    });
  const groups: CategoryGroup[] = [
    ...(suggested.length
      ? [
          {
            id: "suggested" as const,
            label: "Suggested",
            collapsed: false,
            options: suggested,
          },
        ]
      : []),
    ...base,
  ];
  // An archived account still on the entry stays choosable so the entry can be
  // saved as it is. A suspense placeholder (Uncategorized) is not a choice at
  // all: the trigger names it, the list offers what replaces it.
  const current = context.current
    ? accounts.find((a) => a.id === context.current)
    : undefined;
  if (current && !visible.has(current.id) && current.is_archived)
    groups.push({
      id: "current",
      label: "Archived",
      collapsed: false,
      options: [{ ...option(current), detail: "No longer in use" }],
    });
  return groups;
}

/**
 * What choosing an account means for the entry's kind. A function of the
 * account and the direction, so it always agrees with the groups above;
 * null when the account is unknown or hidden, and the caller keeps the kind.
 */
export function categoryKind(
  accountId: string,
  accounts: AccountingAccount[],
  profiles: AccountProfile[],
  direction: "in" | "out",
): CategoryKind | null {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const profile = profiles.find((p) => p.account_id === accountId);
  if (!isCategoryAccount(account, profile)) return null;
  const bucket = bucketOf(account, profile);
  if (bucket === "owner") return "owner";
  if (bucket === "income") return direction === "in" ? "income" : "refund";
  if (bucket === "expense") return direction === "out" ? "expense" : "refund";
  if (profile?.subtype === "loan") return "loan";
  if (profile?.subtype === "fixed_asset") return "asset";
  return direction === "in" ? "income" : "expense";
}
