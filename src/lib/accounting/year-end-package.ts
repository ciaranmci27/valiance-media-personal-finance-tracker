import { formatCents } from "./money";
import { uncategorizedCents } from "./account-balances";
import { trialLines, trialTotals } from "./trial-balance";
import { taxReadiness, taxSourceOf } from "./tax-workpaper-report";
import { contractorLines, contractorTotals } from "./contractor-worksheet";
import { assetTies } from "./fixed-assets";
import { loanTies } from "./loan-balances";
import { registerRuns } from "./payroll-register";
import type { ReportData } from "./reports";
import type { SupportReportData } from "./support-reports";

/**
 * The year-end package: is the year ready to hand to a tax preparer, and
 * everything in one download. The package is the calendar (tax) year from
 * January 1, reviewed transactions only, as the books capture it
 * (report.books.capture): the statements, the ledger, the support reports
 * and the schedules, all at one book revision. Readiness reuses the checks
 * each report already makes; nothing here is recomputed another way.
 */

const ZERO = BigInt(0);

export type PackageGroup = "Financial statements" | "Transactions" | "Payroll and year end" | "Tax and support";

export interface PackageItem {
  id: string;
  title: string;
  /** The question the report answers. */
  answers: string;
  group: PackageGroup;
  /** Whether the package carries a PDF as well as the CSV. */
  pdf: boolean;
  /** The report page to open, when it has one. */
  page: string | null;
}

/** Everything the package holds, in the order the cover lists it. */
export const PACKAGE_CONTENTS: PackageItem[] = [
  { id: "profit-loss", title: "Profit & loss", answers: "What the business earned, spent and kept.", group: "Financial statements", pdf: true, page: "profit-loss" },
  { id: "balance-sheet", title: "Balance sheet", answers: "What it owns and owes at the year's end.", group: "Financial statements", pdf: true, page: "balance-sheet" },
  { id: "cash-flow", title: "Cash flow", answers: "Where the cash came from and went.", group: "Financial statements", pdf: true, page: "cash-flow" },
  { id: "trial-balance", title: "Trial balance", answers: "Every account's balance; do the books balance?", group: "Financial statements", pdf: true, page: "trial-balance" },
  { id: "general-ledger", title: "General ledger", answers: "Every line in every account.", group: "Transactions", pdf: true, page: "general-ledger" },
  { id: "owner-activity", title: "Owner activity", answers: "What you put in and took out.", group: "Transactions", pdf: true, page: "owner-activity" },
  { id: "customer-income", title: "Income by customer", answers: "Who paid the business.", group: "Transactions", pdf: true, page: "customer-income" },
  { id: "vendor-expenses", title: "Expenses by vendor", answers: "Who the business paid.", group: "Transactions", pdf: true, page: "vendor-expenses" },
  { id: "payroll-register", title: "Payroll register", answers: "What payroll cost and what was taken home.", group: "Payroll and year end", pdf: true, page: "payroll-register" },
  { id: "contractor-worksheet", title: "Contractor worksheet", answers: "Who needs a 1099, and what is missing.", group: "Payroll and year end", pdf: true, page: "contractor-worksheet" },
  { id: "asset-register", title: "Fixed assets", answers: "What the business owns and its depreciation.", group: "Payroll and year end", pdf: true, page: "asset-register" },
  { id: "loan-register", title: "Loan balances", answers: "What is owed on each loan.", group: "Payroll and year end", pdf: true, page: "loan-register" },
  { id: "tax-workpapers", title: "Tax workpapers", answers: "Book profit to the books' ordinary income.", group: "Tax and support", pdf: true, page: "tax-workpapers" },
  { id: "account-mappings", title: "Account mappings", answers: "How each account is classified and treated.", group: "Tax and support", pdf: true, page: null },
  { id: "officer-payroll-reconciliation", title: "Officer and payroll reconciliation", answers: "Recorded wages against the provider's figures.", group: "Tax and support", pdf: true, page: null },
  { id: "source-document-index", title: "Source document index", answers: "Every receipt and statement on file, by hash.", group: "Tax and support", pdf: false, page: null },
];
export const PACKAGE_GROUPS: PackageGroup[] = ["Financial statements", "Transactions", "Payroll and year end", "Tax and support"];

/** The package's scope for a calendar year: January 1 through today, or the year's end. */
export function packageScope(year: number, today: string) {
  return { year, through: String(year) === today.slice(0, 4) ? today : `${year}-12-31` };
}

/** This year and the three before it. */
export function packageYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return [year, year - 1, year - 2, year - 3];
}

export interface PackageCheck {
  key: string;
  status: "ready" | "look" | "info" | "waiting";
  title: string;
  detail: string;
  /** The report page that shows it or fixes it. */
  report: string | null;
  /** Fixed by reviewing transactions rather than on a report. */
  review?: boolean;
}

export interface PackageInputs {
  core: ReportData | null;
  tax: SupportReportData | null;
  contractor: SupportReportData | null;
  payroll: SupportReportData | null;
  asset: SupportReportData | null;
  loan: SupportReportData | null;
  /** The books' own package review items (accounting.books_package), when read. */
  reviewItems?: { kind: string; message: string }[];
}

const waiting = (key: string, title: string, report: string | null): PackageCheck => ({
  key,
  status: "waiting",
  title,
  detail: "Reading the books.",
  report,
});

/**
 * Whether the year is ready, check by check: the books balance, nothing
 * is awaiting review or a category, the tax workpapers have nothing open,
 * every contractor who needs a 1099 has a W-9, the asset and loan
 * registers tie to the books, the payroll runs add up, and the months are
 * closed. Each check is the one its report makes.
 */
export function packageChecks(i: PackageInputs): PackageCheck[] {
  const out: PackageCheck[] = [];
  if (i.core) {
    const t = trialTotals(trialLines(i.core));
    out.push(
      t.difference === ZERO
        ? { key: "balanced", status: "ready", title: "The books balance", detail: "Debits equal credits in the trial balance.", report: "trial-balance" }
        : {
            key: "balanced",
            status: "look",
            title: "The books do not balance",
            detail: `Debits and credits differ by ${formatCents(t.difference < ZERO ? -t.difference : t.difference)}. Open the trial balance.`,
            report: "trial-balance",
          },
    );
    const drafts = i.core.quality.draft_count;
    out.push(
      drafts > 0
        ? {
            key: "drafts",
            status: "look",
            title: `${drafts} ${drafts === 1 ? "transaction is" : "transactions are"} awaiting review`,
            detail: "The package counts reviewed transactions only. Review them so the year is complete.",
            report: null,
            review: true,
          }
        : { key: "drafts", status: "ready", title: "Every transaction is reviewed", detail: "Nothing is waiting for review in the year.", report: null },
    );
    const uncategorized = uncategorizedCents(i.core.accounts, (a) => a.purpose, (a) => a.period_cents);
    const lines = i.core.quality.uncategorized_lines;
    out.push(
      uncategorized > ZERO || lines > 0
        ? {
            key: "categories",
            status: "look",
            title: uncategorized > ZERO ? `${formatCents(uncategorized)} is still uncategorized` : `${lines} reviewed ${lines === 1 ? "line needs" : "lines need"} a category`,
            detail: "Give it a category so it lands on the right line of the return.",
            report: null,
            review: true,
          }
        : { key: "categories", status: "ready", title: "Everything has a category", detail: "No spending or income is left uncategorized.", report: null },
    );
  } else out.push(waiting("balanced", "The books balance", "trial-balance"));
  const source = i.tax ? taxSourceOf(i.tax) : null;
  if (i.tax && source) {
    const open = taxReadiness(source).filter((c) => c.key !== "drafts" && c.key !== "months");
    const look = open.filter((c) => c.tone === "look");
    out.push(
      look.length
        ? {
            key: "tax",
            status: "look",
            title: `${look.length} ${look.length === 1 ? "thing is" : "things are"} open in the tax workpapers`,
            detail: look.map((c) => c.title).slice(0, 3).join("; ") + (look.length > 3 ? "; and more." : "."),
            report: "tax-workpapers",
          }
        : { key: "tax", status: "ready", title: "The tax workpapers are complete", detail: "Every account has a treatment and every adjustment its document.", report: "tax-workpapers" },
    );
    const months = source.monthly;
    const openMonths = months.filter((m) => !m.complete).length;
    if (months.length)
      out.push(
        openMonths
          ? {
              key: "months",
              status: "info",
              title: `${openMonths} of ${months.length} ${months.length === 1 ? "month is" : "months are"} not closed`,
              detail: "Closing a month locks it, so the figures you hand over cannot change.",
              report: null,
            }
          : { key: "months", status: "ready", title: "Every month is closed", detail: "The year's figures are locked.", report: null },
      );
  } else out.push(waiting("tax", "The tax workpapers", "tax-workpapers"));
  if (i.contractor) {
    const t = contractorTotals(contractorLines(i.contractor));
    out.push(
      t.missing
        ? {
            key: "contractors",
            status: "look",
            title: `${t.missing} ${t.missing === 1 ? "contractor needs" : "contractors need"} a W-9 or a decision`,
            detail: `${t.needs1099} need a 1099; ${t.ready} ${t.ready === 1 ? "is" : "are"} ready to file.`,
            report: "contractor-worksheet",
          }
        : {
            key: "contractors",
            status: "ready",
            title: t.needs1099 ? `${t.needs1099} ${t.needs1099 === 1 ? "1099 is" : "1099s are"} ready` : "No 1099 is due",
            detail: t.needs1099 ? "Every contractor who needs one has a W-9 on file." : "No contractor passed the line.",
            report: "contractor-worksheet",
          },
    );
  } else out.push(waiting("contractors", "Contractor 1099s", "contractor-worksheet"));
  const ties = (key: string, data: SupportReportData | null, list: ReturnType<typeof assetTies>, noun: string, report: string) => {
    if (!data) return out.push(waiting(key, `The ${noun} register`, report));
    if (!data.rows.length && !list.some((x) => x.books !== ZERO)) return;
    const off = list.filter((x) => x.tone === "look");
    out.push(
      off.length
        ? { key, status: "look", title: off[0].title, detail: `The ${noun} register and the books differ. Open the ${noun === "asset" ? "Fixed assets" : "Loan balances"} report.`, report }
        : { key, status: "ready", title: `The ${noun} register ties to the books`, detail: "Each account holds what the register explains.", report },
    );
  };
  ties("assets", i.asset, i.asset ? assetTies(i.asset) : [], "asset", "asset-register");
  ties("loans", i.loan, i.loan ? loanTies(i.loan) : [], "loan", "loan-register");
  if (i.payroll) {
    const runs = registerRuns(i.payroll);
    const off = runs.filter((r) => r.gross !== r.net + r.withholding);
    const evidence = (i.reviewItems ?? []).find((x) => x.kind === "payroll");
    if (runs.length || evidence)
      out.push(
        off.length
          ? { key: "payroll", status: "look", title: `${off.length} payroll ${off.length === 1 ? "run does" : "runs do"} not add up`, detail: "Gross wages should equal net pay plus withholding.", report: "payroll-register" }
          : evidence
            ? { key: "payroll", status: "info", title: "The provider's year-to-date figures are not on file", detail: "Attach the provider's year-to-date report to the latest run so W-2 figures can be checked.", report: "payroll-register" }
            : { key: "payroll", status: "ready", title: "Every payroll run adds up", detail: `${runs.length} ${runs.length === 1 ? "run" : "runs"}, each posted to the books.`, report: "payroll-register" },
      );
  } else out.push(waiting("payroll", "The payroll register", "payroll-register"));
  return out;
}

/** "Ready", or how many things need a look. */
export function packageSummary(checks: PackageCheck[]): { ready: boolean; look: number; text: string } {
  const look = checks.filter((c) => c.status === "look").length;
  const waitingCount = checks.filter((c) => c.status === "waiting").length;
  if (waitingCount) return { ready: false, look, text: "Checking the year." };
  return look
    ? { ready: false, look, text: `${look} ${look === 1 ? "thing needs" : "things need"} a look before you hand the year over.` }
    : { ready: true, look: 0, text: "The year is ready to hand to your tax preparer." };
}

/** Whether a package item is affected by an open check. */
export function itemReady(item: PackageItem, checks: PackageCheck[]): boolean {
  return !checks.some((c) => c.status === "look" && c.report === item.id);
}

export const PACKAGE_NOTES = [
  "The package is the calendar (tax) year from January 1 through the cutoff, reviewed transactions only. Every report in it is at the same book revision.",
  "PDFs are the branded statements; CSVs hold every line. The ZIP also carries the retained data and a manifest of file hashes.",
  "This supports accounting and tax preparation. It is not a filed return or a substitute for reviewing tax treatment.",
];
