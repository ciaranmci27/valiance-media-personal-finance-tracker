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
  | "reports"
  | "close"
  | "settings"
  | "records";

/** The sidebar entries, in order. Month end has no entry: it opens from Overview. */
export const ACCOUNTING_NAV: { view: AccountingView; label: string }[] = [
  { view: "overview", label: "Overview" },
  { view: "journal", label: "Transactions" },
  { view: "accounts", label: "Accounts" },
  { view: "reports", label: "Reports" },
  { view: "records", label: "Records" },
  { view: "settings", label: "Settings" },
];

const VIEWS = new Set<string>([...ACCOUNTING_NAV.map((n) => n.view), "close"]);

/** Sections that used to live under "More" and now belong to Records. */
const RECORD_SECTIONS = new Set([
  "transfers",
  "documents",
  "payroll",
  "assets",
  "loans",
  "contractors",
  "tax",
]);

/** Old "More" links keep working: the section decides whether they land in Settings or Records. */
export function resolveAccountingView(
  candidate: string | null,
  section: string | null,
): AccountingView {
  if (candidate === "manage")
    return RECORD_SECTIONS.has(section ?? "") ? "records" : "settings";
  if (candidate && VIEWS.has(candidate)) return candidate as AccountingView;
  return "overview";
}

/** The sidebar entry that owns a view (Month end belongs to Overview). */
export function accountingNavFor(view: AccountingView): AccountingView {
  return view === "close" ? "overview" : view;
}

export function accountingHref(view: AccountingView) {
  return `/accounting?view=${view}`;
}
