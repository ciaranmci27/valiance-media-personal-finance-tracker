import { isCostOfSales, type ReportModel, type ReportRow } from "./report-model";
import { fiscalPriorEnd, fiscalYearStart } from "./fiscal-year";
import type {
  BreakdownData,
  ReportAccount,
  ReportData,
  ReportFilter,
} from "./reports";

/**
 * The profit and loss as the owner reads it: the shared statement model
 * (buildReportModel) stays the source of every number, and this file only
 * arranges those numbers into the summary the screen and the exports lead
 * with. Pure on purpose, so the screen, the PDF and the CSV agree and the
 * rules can be tested without a browser.
 */

const ZERO = BigInt(0);
const HUNDRED = BigInt(100);
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");
const abs = (value: bigint) => (value < ZERO ? -value : value);

/* ------------------------------------------------------------------------ */
/* Dates                                                                    */
/* ------------------------------------------------------------------------ */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00Z`);
const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Jan 1 to Oct 3, 2026", or both years when the range crosses one. */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return longDate.format(utc(from));
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${shortDate.format(utc(from))} to ${longDate.format(utc(to))}`
    : `${longDate.format(utc(from))} to ${longDate.format(utc(to))}`;
}

export type PeriodPreset = "month" | "quarter" | "year" | "last-year";
export const PERIOD_PRESETS: {
  value: PeriodPreset;
  label: string;
  short: string;
}[] = [
  { value: "month", label: "This month", short: "Month" },
  { value: "quarter", label: "This quarter", short: "Quarter" },
  { value: "year", label: "Year to date", short: "YTD" },
  { value: "last-year", label: "Last year", short: "Last year" },
];

/**
 * The dates a preset covers on `today` (the books' date). "Year to date" and
 * "Last year" follow the fiscal year (the business settings' start month).
 */
export function presetRange(
  preset: PeriodPreset,
  today: string,
  fiscalMonth = 1,
): { from: string; to: string } {
  const d = utc(today),
    y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  switch (preset) {
    case "month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: today };
    case "quarter":
      return {
        from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))),
        to: today,
      };
    case "year":
      return { from: fiscalYearStart(today, fiscalMonth), to: today };
    case "last-year": {
      const end = fiscalPriorEnd(today, fiscalMonth);
      return { from: fiscalYearStart(end, fiscalMonth), to: end };
    }
  }
}

/** Which preset a range is, or "custom". */
export function presetOf(
  from: string,
  to: string,
  today: string,
  fiscalMonth = 1,
): PeriodPreset | "custom" {
  return (
    PERIOD_PRESETS.find((p) => {
      const r = presetRange(p.value, today, fiscalMonth);
      return r.from === from && r.to === to;
    })?.value ?? "custom"
  );
}

/**
 * The period just before: whole months step back by whole months (Q3
 * compares with Q2, September with August), anything else by its length in
 * days, the way accounting.breakdown shifts a comparison.
 */
export function previousPeriod(from: string, to: string) {
  const start = utc(from),
    end = utc(to);
  const endOfMonth =
    new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10) === to;
  if (from.endsWith("-01") && endOfMonth) {
    const months =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      start.getUTCMonth() +
      1;
    return {
      compare_from: iso(
        new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - months, 1)),
      ),
      compare_to: iso(
        new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0)),
      ),
    };
  }
  const duration = end.getTime() - start.getTime() + 86400000;
  return {
    compare_from: iso(new Date(start.getTime() - duration)),
    compare_to: iso(new Date(start.getTime() - 86400000)),
  };
}

/** One year back; Feb 29 lands on Feb 28. */
function yearBefore(date: string) {
  const year = Number(date.slice(0, 4)) - 1,
    month = date.slice(5, 7);
  const day = Math.min(
    Number(date.slice(8, 10)),
    new Date(Date.UTC(year, Number(month), 0)).getUTCDate(),
  );
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

/** The same dates one year earlier. */
export function samePeriodLastYear(from: string, to: string) {
  return { compare_from: yearBefore(from), compare_to: yearBefore(to) };
}

export type CompareMode = "none" | "previous" | "year" | "custom";
export function compareModeOf(filter: {
  from: string;
  to: string;
  compare_from?: string;
  compare_to?: string;
}): CompareMode {
  if (!filter.compare_from || !filter.compare_to) return "none";
  const prior = previousPeriod(filter.from, filter.to),
    year = samePeriodLastYear(filter.from, filter.to);
  if (
    prior.compare_from === filter.compare_from &&
    prior.compare_to === filter.compare_to
  )
    return "previous";
  if (
    year.compare_from === filter.compare_from &&
    year.compare_to === filter.compare_to
  )
    return "year";
  return "custom";
}

/** The comparison in a few words, for column heads and tile footers. */
export function compareLabel(filter: {
  from: string;
  to: string;
  compare_from?: string;
  compare_to?: string;
}): { short: string; long: string } | null {
  const mode = compareModeOf(filter);
  if (mode === "none") return null;
  const dates = rangeLabel(filter.compare_from!, filter.compare_to!);
  if (mode === "year")
    return {
      short: "last year",
      long: `Same period last year (${dates})`,
    };
  if (mode === "previous")
    return { short: "previous period", long: `Previous period (${dates})` };
  return { short: "comparison", long: dates };
}

/* ------------------------------------------------------------------------ */
/* Classification                                                           */
/* ------------------------------------------------------------------------ */

/** Chart purposes that are payroll cost (see lib/accounting/chart.ts). */
export const PAYROLL_PURPOSES = new Set([
  "officer_compensation",
  "officer_wages",
  "other_wages",
  "employer_payroll_taxes",
  "payroll_fees",
  "shareholder_health_insurance",
  "employer_retirement",
]);

type Classifiable = Pick<
  ReportAccount,
  "account_type" | "purpose" | "subtype" | "name"
>;

/**
 * Why an expense account counts as payroll, or null. Purpose first (the
 * reviewed chart), then the payroll_expense subtype, then a name that starts
 * with "Payroll" (imported charts carry names like "Payroll - Salary & Wages").
 */
export function payrollReason(a: Classifiable): string | null {
  if (a.account_type !== "expense") return null;
  if (a.purpose && PAYROLL_PURPOSES.has(a.purpose)) return "purpose";
  if ((a.subtype ?? "").toLowerCase() === "payroll_expense") return "subtype";
  if (/^\s*payroll\b/i.test(a.name)) return "name";
  return null;
}
export const isPayrollAccount = (a: Classifiable) => payrollReason(a) !== null;

/** Income accounts carry credits (negative); the statement shows them positive. */
export function accountAmount(
  a: Pick<ReportAccount, "account_type" | "period_cents">,
): bigint {
  return a.account_type === "income" ? -big(a.period_cents) : big(a.period_cents);
}
export function accountCompareAmount(
  a: Pick<ReportAccount, "account_type" | "compare_period_cents">,
): bigint {
  return a.account_type === "income"
    ? -big(a.compare_period_cents)
    : big(a.compare_period_cents);
}

/* ------------------------------------------------------------------------ */
/* Ratios and change                                                        */
/* ------------------------------------------------------------------------ */

/** value / base as a percent number (two decimals), or null without a base. */
export function percentOf(value: bigint, base: bigint): number | null {
  if (base === ZERO) return null;
  return Number((value * BigInt(10000)) / base) / 100;
}

/** "12.3%" or "<0.1%"; null without a base. */
export function percentLabel(
  value: bigint,
  base: bigint,
  digits = 1,
): string | null {
  const p = percentOf(value, base);
  if (p === null) return null;
  if (value !== ZERO && Math.abs(p) < 0.1 && digits === 1)
    return value > ZERO === base > ZERO ? "<0.1%" : "-<0.1%";
  return `${p.toFixed(digits)}%`;
}

/** Profit margin as a percent, or null when there is no income to measure it on. */
export function marginOf(net: bigint, income: bigint): number | null {
  return income > ZERO ? percentOf(net, income) : null;
}

export type Change =
  | { kind: "none" }
  | { kind: "percent"; diff: bigint; percent: number }
  | { kind: "near-zero"; diff: bigint };

/**
 * How the period moved against the comparison. When the comparison is under
 * 5% of the current figure a percentage is meaningless (a jump from $90 to
 * $90,000 reads as +99,900%), so it becomes a dollar change "vs almost nothing".
 */
export function changeOf(current: bigint, previous: bigint): Change {
  const diff = current - previous;
  if (current === ZERO && previous === ZERO) return { kind: "none" };
  if (abs(previous) * BigInt(20) < abs(current))
    return { kind: "near-zero", diff };
  return {
    kind: "percent",
    diff,
    percent: Number((diff * BigInt(1000)) / abs(previous)) / 10,
  };
}

/** Whether a move is good news. Expenses rising (or profit falling) is bad. */
export function changeTone(
  diff: bigint,
  invert = false,
): "good" | "bad" | "flat" {
  if (diff === ZERO) return "flat";
  return diff > ZERO !== invert ? "good" : "bad";
}

/* ------------------------------------------------------------------------ */
/* Totals                                                                    */
/* ------------------------------------------------------------------------ */

export interface ProfitLossTotals {
  income: bigint;
  expense: bigint;
  net: bigint;
  margin: number | null;
}

export function profitLossTotals(data: ReportData): {
  current: ProfitLossTotals;
  previous: ProfitLossTotals | null;
} {
  const make = (income: bigint, expense: bigint, net: bigint) => ({
    income,
    expense,
    net,
    margin: marginOf(net, income),
  });
  const t = data.totals,
    p = data.comparison;
  return {
    current: make(big(t.income_cents), big(t.expense_cents), big(t.net_cents)),
    previous: data.filter.compare_from
      ? make(big(p.income_cents), big(p.expense_cents), big(p.net_cents))
      : null,
  };
}

/** True when nothing touched income or expense in either period. */
export function isEmptyProfitLoss(data: ReportData): boolean {
  return !data.accounts.some(
    (a) =>
      (a.account_type === "income" || a.account_type === "expense") &&
      (big(a.period_cents) !== ZERO ||
        (!!data.filter.compare_from && big(a.compare_period_cents) !== ZERO)),
  );
}

/* ------------------------------------------------------------------------ */
/* Monthly series                                                           */
/* ------------------------------------------------------------------------ */

export interface ProfitLossMonth {
  /** First of the month, YYYY-MM-DD. */
  month: string;
  income: bigint;
  expense: bigint;
  net: bigint;
  compare: { income: bigint; expense: bigint; net: bigint } | null;
  /** The days covered when the period starts or ends inside this month. */
  partial: { from: string; to: string } | null;
}

/**
 * The period month by month. Comparison months come from the breakdown read,
 * which shifts each comparison date onto the month it compares with.
 */
export function profitLossMonths(
  data: ReportData,
  breakdown?: BreakdownData | null,
): ProfitLossMonth[] {
  const compared = new Map(
    (breakdown?.rows ?? []).map((r) => [r.key.slice(0, 7), r.compare] as const),
  );
  const { from, to } = data.filter;
  return data.monthly.map((m) => {
    const month = `${m.month.slice(0, 7)}-01`;
    const last = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
    );
    const monthEnd = iso(last);
    const start = from > month ? from : month,
      end = to < monthEnd ? to : monthEnd;
    const c = compared.get(month.slice(0, 7));
    return {
      month,
      income: big(m.income_cents),
      expense: big(m.expense_cents),
      net: big(m.net_cents),
      compare:
        data.filter.compare_from && breakdown
          ? {
              income: big(c?.income_cents),
              expense: big(c?.expense_cents),
              net: big(c?.net_cents),
            }
          : null,
      partial: start !== month || end !== monthEnd ? { from: start, to: end } : null,
    };
  });
}

/* ------------------------------------------------------------------------ */
/* Every dollar earned                                                      */
/* ------------------------------------------------------------------------ */

export interface DollarSplit {
  income: bigint;
  expense: bigint;
  payroll: bigint;
  other: bigint;
  /** Net profit, or the loss as a positive number when `loss`. */
  result: bigint;
  loss: boolean;
  payrollAccounts: string[];
}

export function dollarSplit(data: ReportData): DollarSplit {
  const payrollAccounts = data.accounts.filter(isPayrollAccount);
  const payroll = payrollAccounts.reduce((s, a) => s + accountAmount(a), ZERO);
  const income = big(data.totals.income_cents),
    expense = big(data.totals.expense_cents),
    net = big(data.totals.net_cents);
  return {
    income,
    expense,
    payroll,
    other: expense - payroll,
    result: abs(net),
    loss: net < ZERO,
    payrollAccounts: payrollAccounts.map((a) => a.id),
  };
}

/** "72 cents" or "$1.32": what a dollar of income became. */
export function centsOfDollar(part: bigint, income: bigint): string | null {
  if (income <= ZERO) return null;
  const cents = Number((part * HUNDRED * BigInt(10) + income * BigInt(5)) / (income * BigInt(10)));
  return cents >= 100
    ? `$${(cents / 100).toFixed(2)}`
    : `${cents} ${cents === 1 ? "cent" : "cents"}`;
}

/* ------------------------------------------------------------------------ */
/* Where income came from, where it went                                    */
/* ------------------------------------------------------------------------ */

export interface BreakdownRow {
  key: string;
  label: string;
  amount: bigint;
  /** Share of the card's total, percent. */
  share: number;
  tag?: string;
  /** How many groups a rolled-up row stands for. */
  count?: number;
  /** The journal filter behind the row, when it has one. */
  filter?: Partial<ReportFilter>;
}

type Party = { id: string; roles?: string[] };

const ROLE_LABELS: Record<string, string> = {
  client: "Client",
  vendor: "Vendor",
  contractor: "Contractor",
  employee: "Payroll",
  owner: "Owner",
  government: "Government",
  financial: "Bank",
};

/** The journal scope of the period with the comparison removed. */
export function periodScope(data: ReportData): Partial<ReportFilter> {
  const scope: Partial<ReportFilter> = { ...data.filter, offset: 0 };
  delete scope.compare_from;
  delete scope.compare_to;
  delete scope.account_ids;
  delete scope.account_types;
  delete scope.cash_class;
  return scope;
}

function withShares(rows: Omit<BreakdownRow, "share">[], total: bigint) {
  return rows.map((r) => ({ ...r, share: percentOf(r.amount, total) ?? 0 }));
}

/** Keep the first `limit` rows; fold the rest into one row. */
export function rollUp(
  rows: BreakdownRow[],
  limit: number,
  label: (count: number) => string,
  filter?: (rest: BreakdownRow[]) => Partial<ReportFilter> | undefined,
): BreakdownRow[] {
  if (rows.length <= limit + 1) return rows;
  const rest = rows.slice(limit);
  const amount = rest.reduce((s, r) => s + r.amount, ZERO);
  return [
    ...rows.slice(0, limit),
    {
      key: "rest",
      label: label(rest.length),
      amount,
      share: rest.reduce((s, r) => s + r.share, 0),
      count: rest.length,
      filter: filter?.(rest),
    },
  ];
}

const tagFor = (roles: string[] | undefined, prefer: string[]) => {
  const role = prefer.find((r) => roles?.includes(r)) ?? roles?.[0];
  return role ? ROLE_LABELS[role] : undefined;
};

export function incomeByContact(
  data: ReportData,
  parties: Party[],
  limit = 8,
): BreakdownRow[] {
  const roles = new Map(parties.map((p) => [p.id, p.roles ?? []]));
  const scope = periodScope(data);
  const rows = data.dimensions
    .filter((d) => d.kind === "payee" && big(d.income_cents) > ZERO)
    .map((d) => ({
      key: d.id,
      label: d.id === "unassigned" ? "No contact" : d.name,
      amount: big(d.income_cents),
      tag:
        d.id === "unassigned"
          ? undefined
          : tagFor(roles.get(d.id), ["client", "financial"]),
      filter: { ...scope, payee: d.id, account_types: ["income" as const] },
    }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  return rollUp(
    withShares(rows, big(data.totals.income_cents)),
    limit,
    (n) => `${n} more contacts`,
  );
}

function byAccount(
  data: ReportData,
  accounts: ReportAccount[],
  total: bigint,
): BreakdownRow[] {
  const scope = periodScope(data);
  return withShares(
    accounts
      .map((a) => ({
        key: a.id,
        label: a.name,
        amount: accountAmount(a),
        filter: { ...scope, account_ids: [a.id] },
      }))
      .filter((r) => r.amount > ZERO)
      .sort((a, b) =>
        b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0,
      ),
    total,
  );
}

const accountsFilter =
  (data: ReportData) =>
  (rest: BreakdownRow[]): Partial<ReportFilter> | undefined => {
    const ids = rest.flatMap((r) => r.filter?.account_ids ?? []);
    return ids.length ? { ...periodScope(data), account_ids: ids } : undefined;
  };

export function incomeByCategory(data: ReportData, limit = 8): BreakdownRow[] {
  return rollUp(
    byAccount(
      data,
      data.accounts.filter((a) => a.account_type === "income"),
      big(data.totals.income_cents),
    ),
    limit,
    (n) => `${n} more categories`,
    accountsFilter(data),
  );
}

/** Expense categories with every payroll account folded into one Payroll row. */
export function expenseByCategory(data: ReportData, limit = 8): BreakdownRow[] {
  const expense = big(data.totals.expense_cents);
  const payroll = data.accounts.filter(isPayrollAccount);
  const payrollAmount = payroll.reduce((s, a) => s + accountAmount(a), ZERO);
  const rows = byAccount(
    data,
    data.accounts.filter(
      (a) => a.account_type === "expense" && !isPayrollAccount(a),
    ),
    expense,
  );
  if (payrollAmount > ZERO)
    rows.push({
      key: "payroll",
      label: "Payroll",
      amount: payrollAmount,
      share: percentOf(payrollAmount, expense) ?? 0,
      tag: "Wages and taxes",
      count: payroll.length,
      filter: { ...periodScope(data), account_ids: payroll.map((a) => a.id) },
    });
  rows.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  return rollUp(rows, limit, (n) => `${n} more categories`, accountsFilter(data));
}

export function expenseByVendor(
  data: ReportData,
  parties: Party[],
  limit = 8,
): BreakdownRow[] {
  const roles = new Map(parties.map((p) => [p.id, p.roles ?? []]));
  const scope = periodScope(data);
  const rows = data.dimensions
    .filter((d) => d.kind === "payee" && big(d.expense_cents) > ZERO)
    .map((d) => ({
      key: d.id,
      label: d.id === "unassigned" ? "No contact" : d.name,
      amount: big(d.expense_cents),
      // Someone paid through payroll reads as Payroll, not as a vendor.
      tag:
        d.id === "unassigned"
          ? undefined
          : tagFor(roles.get(d.id), ["employee", "contractor", "government"]),
      filter: { ...scope, payee: d.id, account_types: ["expense" as const] },
    }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  return rollUp(
    withShares(rows, big(data.totals.expense_cents)),
    limit,
    () => "Everyone else",
  );
}

/**
 * When one or two clients bring in most of the income. Only named contacts
 * count; "No contact" is not a client.
 */
export function concentration(
  rows: BreakdownRow[],
): { count: 1 | 2; share: number; smallest: number } | null {
  const named = rows.filter((r) => r.key !== "unassigned" && r.key !== "rest");
  if (named[0] && named[0].share > 75)
    return { count: 1, share: named[0].share, smallest: named[0].share };
  if (named.length >= 2 && named[0].share + named[1].share > 75)
    return {
      count: 2,
      share: named[0].share + named[1].share,
      smallest: named[1].share,
    };
  return null;
}

/* ------------------------------------------------------------------------ */
/* What changed                                                             */
/* ------------------------------------------------------------------------ */

export interface Mover {
  id: string;
  label: string;
  type: "income" | "expense";
  current: bigint;
  previous: bigint;
  diff: bigint;
  tone: "good" | "bad" | "flat";
  filter: Partial<ReportFilter>;
}

/** The accounts that moved most against the comparison, by absolute dollars. */
export function topMovers(data: ReportData, limit = 8): Mover[] {
  if (!data.filter.compare_from) return [];
  const scope = periodScope(data);
  return data.accounts
    .filter((a) => a.account_type === "income" || a.account_type === "expense")
    .map((a) => {
      const current = accountAmount(a),
        previous = accountCompareAmount(a),
        diff = current - previous;
      return {
        id: a.id,
        label: a.name,
        type: a.account_type as "income" | "expense",
        current,
        previous,
        diff,
        tone: changeTone(diff, a.account_type === "expense"),
        filter: { ...scope, account_ids: [a.id] },
      };
    })
    .filter((m) => m.diff !== ZERO)
    .sort((a, b) =>
      abs(b.diff) > abs(a.diff) ? 1 : abs(b.diff) < abs(a.diff) ? -1 : 0,
    )
    .slice(0, limit);
}

/* ------------------------------------------------------------------------ */
/* The statement                                                            */
/* ------------------------------------------------------------------------ */

export interface StatementRow extends ReportRow {
  /** Section the row belongs to, for the CSV and for change coloring. */
  section: string;
  /**
   * Income rows rise well; expense rows rise badly; results follow income.
   * Neutral rows (money between the owner and the business) are not colored.
   */
  side: "income" | "expense" | "result" | "neutral";
}

const COST_OF_SALES = new Set([
  "Cost of sales",
  "Total cost of sales",
  "Gross profit",
]);

/**
 * The statement rows of the shared model, labelled with their section, with
 * the cost of sales block dropped when the books have none in either period
 * (gross profit then equals income and only repeats it).
 */
export function statementRows(
  model: ReportModel,
  data: ReportData,
): { rows: StatementRow[]; costOfSalesHidden: boolean } {
  const comparing = !!data.filter.compare_from;
  const hasCostOfSales =
    data.accounts.some(
      (a) =>
        isCostOfSales(a) &&
        (big(a.period_cents) !== ZERO ||
          (comparing && big(a.compare_period_cents) !== ZERO)),
    ) ||
    big(data.totals.cogs_cents) !== ZERO ||
    (comparing && big(data.comparison.cogs_cents) !== ZERO);
  let section = "";
  const rows: StatementRow[] = [];
  for (const row of model.rows) {
    if (row.kind === "heading" && !row.indent) {
      // Top-level headings name the section; parent-account headings sit inside one.
      if (["Income", "Cost of sales", "Operating expenses"].includes(row.label))
        section = row.label;
    }
    if (row.kind === "total") section = row.label;
    if (!hasCostOfSales && COST_OF_SALES.has(row.label)) continue;
    if (!hasCostOfSales && section === "Cost of sales") continue;
    rows.push({
      ...row,
      section,
      side:
        row.kind === "total"
          ? "result"
          : section === "Income"
            ? "income"
            : "expense",
    });
  }
  return { rows, costOfSalesHidden: !hasCostOfSales };
}
