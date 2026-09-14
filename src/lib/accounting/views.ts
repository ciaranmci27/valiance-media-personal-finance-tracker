/**
 * The accounting screens as the URL names them. Shared by the sidebar (which
 * links to them) and the accounting shell (which renders them), so the two
 * can never disagree about which view a link opens. No heavy imports here:
 * the sidebar is on every page.
 */
export type AccountingView =
  | "overview"
  | "journal"
  | "accounts"
  | "payroll"
  | "reports"
  | "manage"
  | "close";

/** The sidebar entries, in order. Month end has no entry: it opens from Overview. */
export const ACCOUNTING_NAV: { view: AccountingView; label: string }[] = [
  { view: "overview", label: "Overview" },
  { view: "journal", label: "Transactions" },
  { view: "accounts", label: "Accounts" },
  { view: "payroll", label: "Payroll" },
  { view: "reports", label: "Reports" },
  { view: "manage", label: "Manage" },
];

const VIEWS = new Set<string>([...ACCOUNTING_NAV.map((n) => n.view), "close"]);

/** The Manage sections, in rail order. */
export type ManageSection =
  | "feeds"
  | "imports"
  | "documents"
  | "registers"
  | "tax"
  | "payees"
  | "rules";

const MANAGE_SECTIONS = new Set<string>([
  "feeds",
  "imports",
  "documents",
  "registers",
  "tax",
  "payees",
  "rules",
]);

/**
 * Sections that used to have their own rail entry under Records or Settings.
 * Each maps to where that work lives now, so an old link still lands somewhere
 * sensible. Payroll became its own view; transfers moved into Transactions.
 */
const LEGACY_SECTIONS: Record<string, ManageSection | null> = {
  assets: "registers",
  loans: "registers",
  contractors: "payees",
  history: "imports",
  transfers: null,
  payroll: null,
  settings: "feeds",
};

/** Old Records and Settings links keep working: every one of them lands on Manage, Payroll or Transactions. */
export function resolveAccountingView(
  candidate: string | null,
  section: string | null,
): AccountingView {
  if (
    candidate === "manage" ||
    candidate === "records" ||
    candidate === "settings"
  ) {
    if (section === "payroll") return "payroll";
    if (section === "transfers") return "journal";
    return "manage";
  }
  if (candidate && VIEWS.has(candidate)) return candidate as AccountingView;
  return "overview";
}

/** The Manage section a `section` param names, translating retired ids; null when it names none. */
export function resolveManageSection(
  section: string | null | undefined,
): ManageSection | null {
  if (!section) return null;
  if (MANAGE_SECTIONS.has(section)) return section as ManageSection;
  return LEGACY_SECTIONS[section] ?? null;
}

/** The sidebar entry that owns a view (Month end belongs to Overview). */
export function accountingNavFor(view: AccountingView): AccountingView {
  return view === "close" ? "overview" : view;
}

/** `/accounting?view=...`, with a Manage section and any extra params. */
export function accountingHref(
  view: AccountingView,
  section?: string,
  params?: Record<string, string>,
) {
  const query = new URLSearchParams({ view });
  if (section) query.set("section", section);
  for (const [key, value] of Object.entries(params ?? {}))
    query.set(key, value);
  return `/accounting?${query}`;
}
