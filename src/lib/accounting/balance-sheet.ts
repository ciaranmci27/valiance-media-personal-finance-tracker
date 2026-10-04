import type { ReportModel } from "./report-model";
import { fiscalPriorEnd } from "./fiscal-year";
import type {
  BreakdownData,
  BreakdownFilter,
  ReportAccount,
  ReportData,
  ReportFilter,
} from "./reports";
import {
  percentOf,
  rollUp,
  type BreakdownRow,
  type StatementRow,
} from "./profit-loss";

/**
 * The balance sheet as the owner reads it: what the business has, what it
 * owes and what is left as of a date, how that moved month to month, what
 * equity means in plain words, and whether the numbers can be trusted. The
 * shared statement model (buildReportModel) stays the source of every
 * figure; this file arranges them, pure, for the screen, the PDF and the CSV.
 */

const ZERO = BigInt(0);
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00Z`);
const longDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
export const dateText = (date: string) => longDate.format(utc(date));

/* ------------------------------------------------------------------------ */
/* Dates                                                                    */
/* ------------------------------------------------------------------------ */

export type AsOfPreset = "today" | "month" | "quarter" | "year";
export const AS_OF_PRESETS: {
  value: AsOfPreset;
  label: string;
  short: string;
}[] = [
  { value: "today", label: "Today", short: "Today" },
  { value: "month", label: "End of last month", short: "Last month" },
  { value: "quarter", label: "End of last quarter", short: "Last qtr" },
  { value: "year", label: "End of last year", short: "Last year" },
];

/** The last day of the month before the month of `date`. */
function endOfPreviousMonth(date: string) {
  const d = utc(date);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)));
}

/** "End of last year" is the end of the last fiscal year (business settings). */
export function asOfDate(preset: AsOfPreset, today: string, fiscalMonth = 1): string {
  const d = utc(today),
    y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  switch (preset) {
    case "today":
      return today;
    case "month":
      return endOfPreviousMonth(today);
    case "quarter":
      return iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 0)));
    case "year":
      return fiscalPriorEnd(today, fiscalMonth);
  }
}

export function asOfPresetOf(
  asOf: string,
  today: string,
  fiscalMonth = 1,
): AsOfPreset | "custom" {
  return (
    AS_OF_PRESETS.find((p) => asOfDate(p.value, today, fiscalMonth) === asOf)?.value ??
    "custom"
  );
}

export type BalanceCompare = "none" | "month" | "year-end" | "year" | "custom";
export const BALANCE_COMPARES: { value: BalanceCompare; label: string }[] = [
  { value: "none", label: "No comparison" },
  { value: "month", label: "End of previous month" },
  { value: "year-end", label: "End of previous year" },
  { value: "year", label: "Same date last year" },
];

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

export function compareDate(
  mode: Exclude<BalanceCompare, "none" | "custom">,
  asOf: string,
  fiscalMonth = 1,
): string {
  if (mode === "month") return endOfPreviousMonth(asOf);
  if (mode === "year-end") return fiscalPriorEnd(asOf, fiscalMonth);
  return yearBefore(asOf);
}

/** Where a cumulative read starts: before anything the books can hold. */
export const BOOKS_START = "1900-01-01";

/**
 * The report filter for a balance as of a date. A balance is cumulative, so
 * the period runs from the start of the books: the balances do not depend on
 * `from` (the current-year profit split follows the as-of date's fiscal
 * year), and each account's debits and credits then cover its whole life,
 * which is what splits a mixed owner account into money in and money out.
 * The owner never chooses a second date.
 */
export function balanceFilter(
  asOf: string,
  mode: ReportFilter["mode"],
  compareTo?: string,
): ReportFilter {
  return {
    from: BOOKS_START,
    to: asOf,
    mode,
    ...(compareTo ? { compare_from: BOOKS_START, compare_to: compareTo } : {}),
    offset: 0,
  };
}

export function balanceCompareOf(
  filter: {
    to: string;
    compare_to?: string;
  },
  fiscalMonth = 1,
): BalanceCompare {
  if (!filter.compare_to) return "none";
  return (
    (["month", "year-end", "year"] as const).find(
      (m) => compareDate(m, filter.to, fiscalMonth) === filter.compare_to,
    ) ?? "custom"
  );
}

/** "Sep 30, 2026": what the comparison is, for column heads and tiles. */
export function balanceCompareLabel(
  filter: {
    to: string;
    compare_to?: string;
  },
  fiscalMonth = 1,
): { short: string; long: string } | null {
  const mode = balanceCompareOf(filter, fiscalMonth);
  if (mode === "none") return null;
  const date = dateText(filter.compare_to!);
  const what =
    mode === "month"
      ? "end of the previous month"
      : mode === "year-end"
        ? fiscalMonth === 1
          ? "end of the previous year"
          : "end of the previous fiscal year"
        : mode === "year"
          ? "same date last year"
          : "comparison date";
  return { short: date, long: `${date} (${what})` };
}

/* ------------------------------------------------------------------------ */
/* Totals                                                                    */
/* ------------------------------------------------------------------------ */

const isCash = (a: Pick<ReportAccount, "cash_kind">) =>
  ["bank", "cash", "card"].includes(a.cash_kind);

export interface BalanceTotals {
  assets: bigint;
  liabilities: bigint;
  /** Equity accounts plus profit from prior years and this year. */
  equity: bigint;
  /** Bank and cash less what is owed on cards, the Transactions net figure. */
  cash: bigint;
}

export function balanceTotals(data: ReportData): {
  current: BalanceTotals;
  previous: BalanceTotals | null;
  /** Assets less liabilities and equity; zero when the books balance. */
  difference: bigint;
} {
  const t = data.totals,
    p = data.comparison;
  const cash = (field: "ending_cents" | "compare_ending_cents") =>
    data.accounts.filter(isCash).reduce((s, a) => s + big(a[field]), ZERO);
  return {
    current: {
      assets: big(t.assets_cents),
      liabilities: big(t.liabilities_cents),
      equity: big(t.equity_cents) + big(t.prior_cents) + big(t.year_cents),
      cash: cash("ending_cents"),
    },
    previous: data.filter.compare_to
      ? {
          assets: big(p.assets_cents),
          liabilities: big(p.liabilities_cents),
          equity: big(p.equity_cents) + big(p.prior_cents) + big(p.year_cents),
          cash: cash("compare_ending_cents"),
        }
      : null,
    difference: big(t.difference_cents),
  };
}

/** True when the books hold no balance at all on either date. */
export function isEmptyBalance(data: ReportData): boolean {
  return !data.accounts.some(
    (a) =>
      ["asset", "liability", "equity"].includes(a.account_type) &&
      (big(a.ending_cents) !== ZERO ||
        (!!data.filter.compare_to && big(a.compare_ending_cents) !== ZERO)),
  );
}

/** "Of everything the business owns, X% is owed to others and Y% is yours." */
export function ownershipSentence(totals: BalanceTotals): string {
  const { assets, liabilities, equity } = totals;
  if (assets <= ZERO)
    return liabilities > ZERO
      ? "The business owns nothing yet, so everything it owes is ahead of the owner."
      : "The business owns nothing and owes nothing yet.";
  if (equity < ZERO)
    return `The business owes more than it owns: liabilities are ${percentOf(liabilities, assets)!.toFixed(0)}% of everything it has.`;
  const owed = percentOf(liabilities, assets) ?? 0;
  const owedText = owed > 0 && owed < 1 ? "under 1" : owed.toFixed(0);
  const yoursText = owed > 0 && owed < 1 ? "over 99" : (100 - Math.round(owed)).toFixed(0);
  return `Of everything the business owns, ${owedText}% is owed to others and ${yoursText}% is yours.`;
}

/* ------------------------------------------------------------------------ */
/* What you own, what you owe                                               */
/* ------------------------------------------------------------------------ */

/** The journal scope of one account's balance: every line through the date. */
export function balanceScope(
  data: ReportData,
  accountIds: string[],
  previous = false,
): Partial<ReportFilter> {
  return {
    from: "1900-01-01",
    to: previous ? data.filter.compare_to! : data.filter.to,
    mode: data.filter.mode,
    account_ids: accountIds,
    offset: 0,
  };
}

export type BalanceRow = BreakdownRow & {
  hint?: string;
  accountId?: string;
  cashKind?: string;
};

const SUBTYPE_TAGS: Record<string, string> = {
  bank: "Bank",
  cash: "Cash",
  card: "Card",
  receivable: "Receivable",
  fixed_asset: "Equipment",
  payroll_liability: "Payroll",
  loan: "Loan",
  transit: "In transit",
  undeposited: "Undeposited",
};

function ranked(
  data: ReportData,
  accounts: ReportAccount[],
  amount: (a: ReportAccount) => bigint,
  total: bigint,
  hint: (a: ReportAccount, value: bigint) => string | undefined,
): BalanceRow[] {
  const rows = accounts
    .map((a) => ({ a, value: amount(a) }))
    .filter(({ value }) => value !== ZERO)
    // Largest first; anything below zero sits at the end, shown, not hidden.
    .sort((x, y) =>
      x.value < ZERO !== y.value < ZERO
        ? x.value < ZERO
          ? 1
          : -1
        : y.value > x.value
          ? 1
          : y.value < x.value
            ? -1
            : 0,
    )
    .map(({ a, value }) => ({
      key: a.id,
      label: a.name,
      amount: value,
      share: percentOf(value, total) ?? 0,
      tag: SUBTYPE_TAGS[a.cash_kind !== "none" ? a.cash_kind : a.subtype],
      hint: hint(a, value),
      accountId: a.id,
      cashKind: a.cash_kind,
      filter: balanceScope(data, [a.id]),
    }));
  return rollUp(rows, 8, (n) => `${n} more accounts`, (rest) => {
    const ids = rest.flatMap((r) => r.filter?.account_ids ?? []);
    return ids.length ? balanceScope(data, ids) : undefined;
  });
}

/**
 * What a contra account is, in words that do not lean on its own name: the
 * balance that reduces another one, and which way.
 */
function contraHint(
  a: Pick<ReportAccount, "purpose" | "subtype" | "name">,
  side: "asset" | "liability",
): string {
  const kind = `${a.purpose ?? ""} ${a.subtype ?? ""} ${a.name}`.toLowerCase();
  if (side === "liability") return "Lowers what you owe, for example a loan fee paid up front";
  if (kind.includes("depreciation"))
    return "Equipment wear to date, subtracted from what you own";
  if (kind.includes("amortization"))
    return "Wear on software, licenses and similar to date, subtracted from what you own";
  if (kind.includes("doubtful") || kind.includes("allowance") || kind.includes("bad debt"))
    return "Customer balances you may not collect, subtracted from what you own";
  return "Subtracted from another asset's value";
}

/** Asset accounts by balance; a contra or overdrawn account stays, with a hint. */
export function whatYouOwn(data: ReportData): BalanceRow[] {
  return ranked(
    data,
    data.accounts.filter((a) => a.account_type === "asset"),
    (a) => big(a.ending_cents),
    big(data.totals.assets_cents),
    (a, value) =>
      value >= ZERO
        ? undefined
        : a.normal_side === "credit"
          ? contraHint(a, "asset")
          : isCash(a)
            ? "Overdrawn: more went out than was in the account"
            : "Below zero: more was recorded out than in",
  );
}

/** Liability accounts by what is owed; an overpaid one stays, with a hint. */
export function whatYouOwe(data: ReportData): BalanceRow[] {
  return ranked(
    data,
    data.accounts.filter((a) => a.account_type === "liability"),
    (a) => -big(a.ending_cents),
    big(data.totals.liabilities_cents),
    (a, value) =>
      value >= ZERO
        ? undefined
        : a.normal_side === "debit"
          ? contraHint(a, "liability")
          : a.cash_kind === "card"
            ? "Overpaid: the card owes the business a credit"
            : "Paid more than was owed: the business is owed this back",
  );
}

/* ------------------------------------------------------------------------ */
/* Equity, explained                                                         */
/* ------------------------------------------------------------------------ */

export type EquityKind = "in" | "out" | "kept" | "year" | "named";
export interface EquityLine {
  key: string;
  kind: EquityKind;
  label: string;
  amount: bigint;
  /** Why the account landed on this line, for the tooltip and tests. */
  reason: string;
  filter?: Partial<ReportFilter>;
}

const IN_PURPOSES = new Set(["contributions", "shareholder_capital"]);
const OUT_PURPOSES = new Set(["distributions", "draws", "owner_draws"]);
const KEPT_PURPOSES = new Set([
  "opening_retained_earnings",
  "retained_earnings",
]);

/**
 * Which plain-language line an equity account belongs to, by purpose, then
 * subtype, then name. An account whose name says both (an "Investment /
 * Drawings" account) or neither keeps its own name rather than a guess.
 */
export function equityKind(
  a: Pick<ReportAccount, "purpose" | "subtype" | "name">,
): { kind: EquityKind; reason: string } {
  if (a.purpose && IN_PURPOSES.has(a.purpose))
    return { kind: "in", reason: "purpose" };
  if (a.purpose && OUT_PURPOSES.has(a.purpose))
    return { kind: "out", reason: "purpose" };
  if (
    (a.purpose && KEPT_PURPOSES.has(a.purpose)) ||
    (a.subtype ?? "").toLowerCase() === "retained_earnings"
  )
    return { kind: "kept", reason: a.purpose ? "purpose" : "subtype" };
  const name = a.name.toLowerCase();
  const putIn = /contribut|paid[- ]in|capital stock|common stock|investment/.test(name);
  const tookOut = /distribut|drawing|\bdraws?\b/.test(name);
  if (putIn && !tookOut) return { kind: "in", reason: "name" };
  if (tookOut && !putIn) return { kind: "out", reason: "name" };
  // Both directions in one account ("Owner Investment / Drawings"): its own
  // history says how much went each way, so equityLines splits it.
  if (putIn && tookOut) return { kind: "named", reason: "both" };
  if (/retained/.test(name)) return { kind: "kept", reason: "name" };
  return { kind: "named", reason: "ambiguous" };
}

/** An account's lifetime credits and debits through a date (credit positive). */
export type Lifetime = Map<string, { credits: bigint; debits: bigint }>;

/**
 * Lifetime credits and debits per account, from a report whose period starts
 * at the start of the books. An account counts only when its opening is zero
 * and its debits less credits equal its ending balance, so a report that
 * starts later can never pass partial history off as the whole.
 */
export function lifetimeOf(data: ReportData): Lifetime {
  const out: Lifetime = new Map();
  for (const a of data.accounts) {
    const debits = big(a.debit_cents),
      credits = big(a.credit_cents);
    if (big(a.opening_cents) === ZERO && debits - credits === big(a.ending_cents))
      out.set(a.id, { credits, debits });
  }
  return out;
}

const EQUITY_LABELS: Record<Exclude<EquityKind, "named">, string> = {
  in: "Money you put in",
  out: "Money you took out",
  kept: "Profits kept from earlier years",
  year: "This year's profit",
};

/**
 * Total equity as plain lines that add up to it: money put in, money taken
 * out, profits kept from earlier years (retained earnings accounts plus the
 * books' computed profit from prior years), this year's profit, and every
 * other equity account under its own name.
 */
export function equityLines(
  data: ReportData,
  previous = false,
  /**
   * Lifetime credits and debits for a mixed owner account. The current date
   * reads them from the report itself (a balance sheet starts at the books'
   * start); a comparison date needs its own lifetime read.
   */
  lifetime: Lifetime = previous ? new Map() : lifetimeOf(data),
): { lines: EquityLine[]; total: bigint } {
  const field = previous ? "compare_ending_cents" : "ending_cents";
  const t = previous ? data.comparison : data.totals;
  const year = big(t.year_cents),
    prior = big(t.prior_cents);
  const grouped = new Map<string, EquityLine & { ids: string[] }>();
  const add = (
    key: string,
    kind: EquityKind,
    label: string,
    reason: string,
    amount: bigint,
    id: string,
  ) => {
    const line = grouped.get(key) ?? {
      key,
      kind,
      label,
      amount: ZERO,
      reason,
      ids: [],
    };
    line.amount += amount;
    if (!line.ids.includes(id)) line.ids.push(id);
    grouped.set(key, line);
  };
  for (const a of data.accounts.filter((a) => a.account_type === "equity")) {
    const amount = -big(a[field]);
    const { kind, reason } = equityKind(a);
    const history = lifetime.get(a.id);
    // A mixed owner account splits into what went in (its credits) and what
    // came out (its debits); together they are exactly its balance.
    if (reason === "both" && history && history.credits - history.debits === amount) {
      if (history.credits !== ZERO)
        add("in", "in", EQUITY_LABELS.in, "split", history.credits, a.id);
      if (history.debits !== ZERO)
        add("out", "out", EQUITY_LABELS.out, "split", -history.debits, a.id);
      continue;
    }
    if (amount === ZERO && kind === "named") continue;
    add(
      kind === "named" ? a.id : kind,
      kind,
      kind === "named" ? a.name : EQUITY_LABELS[kind],
      reason,
      amount,
      a.id,
    );
  }
  const kept = grouped.get("kept") ?? {
    key: "kept",
    kind: "kept" as const,
    label: EQUITY_LABELS.kept,
    amount: ZERO,
    reason: "computed",
    ids: [],
  };
  kept.amount += prior;
  grouped.set("kept", kept);
  const ordered: (EquityLine & { ids: string[] })[] = [
    ...(["in", "out", "kept"] as const)
      .map((k) => grouped.get(k))
      .filter((l): l is EquityLine & { ids: string[] } => !!l && l.amount !== ZERO),
    {
      key: "year",
      kind: "year",
      label: year < ZERO ? "This year's loss" : EQUITY_LABELS.year,
      amount: year,
      reason: "computed",
      ids: [],
    },
    ...[...grouped.values()].filter((l) => l.kind === "named"),
  ];
  const lines: EquityLine[] = ordered.map(({ ids, ...line }) => ({
    ...line,
    filter: ids.length ? balanceScope(data, ids, previous) : undefined,
  }));
  return { lines, total: lines.reduce((s, l) => s + l.amount, ZERO) };
}

/* ------------------------------------------------------------------------ */
/* Month-end balances                                                       */
/* ------------------------------------------------------------------------ */

export interface BalanceMonth {
  /** First of the month, YYYY-MM-DD. */
  month: string;
  /** The day the balance is taken: the month end, or the as-of date. */
  at: string;
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  cash: bigint;
}

/** The first of the month eleven months before the as-of date. */
export function seriesStart(asOf: string): string {
  const d = utc(asOf);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1)));
}

export type BalanceSeries =
  | "assets"
  | "contraAssets"
  | "liabilities"
  | "contraLiabilities"
  | "cash"
  | "cards";

/**
 * The month-end series the chart and sparklines need, as breakdown reads.
 * The books sign each account on its own normal side, so a contra account
 * (accumulated depreciation) would add to a type total instead of reducing
 * it; assets and liabilities are therefore read as their ordinary accounts
 * and their contra accounts apart, and the contra series is subtracted.
 * Bank and cash is the books' default for a balance; cards are owed,
 * positive. Cash position is bank and cash less cards owed.
 */
export function balanceSeriesFilters(
  asOf: string,
  mode: ReportFilter["mode"],
  accounts: Pick<ReportAccount, "id" | "account_type" | "normal_side" | "cash_kind">[],
): Record<BalanceSeries, BreakdownFilter | null> {
  const base = {
    from: seriesStart(asOf),
    to: asOf,
    mode,
    group_by: "month" as const,
    measure: "balance" as const,
  };
  const ids = (match: (a: (typeof accounts)[number]) => boolean) => {
    const list = accounts.filter(match).map((a) => a.id);
    return list.length ? { ...base, account_ids: list.slice(0, 500) } : null;
  };
  return {
    assets: ids((a) => a.account_type === "asset" && a.normal_side === "debit"),
    contraAssets: ids((a) => a.account_type === "asset" && a.normal_side === "credit"),
    liabilities: ids((a) => a.account_type === "liability" && a.normal_side === "credit"),
    contraLiabilities: ids((a) => a.account_type === "liability" && a.normal_side === "debit"),
    cash: base,
    cards: ids((a) => a.cash_kind === "card"),
  };
}

export function balanceMonths(
  asOf: string,
  series: Partial<Record<BalanceSeries, BreakdownData | null>>,
): BalanceMonth[] {
  const pick = (data: BreakdownData | null | undefined) =>
    new Map((data?.rows ?? []).map((r) => [r.key.slice(0, 7), big(r.balance_cents)]));
  const ordinaryAssets = pick(series.assets),
    contraAssets = pick(series.contraAssets),
    ordinaryLiabilities = pick(series.liabilities),
    contraLiabilities = pick(series.contraLiabilities),
    cash = pick(series.cash),
    cards = pick(series.cards);
  const net = (main: Map<string, bigint>, contra: Map<string, bigint>) =>
    new Map(
      [...new Set([...main.keys(), ...contra.keys()])].map((k) => [
        k,
        (main.get(k) ?? ZERO) - (contra.get(k) ?? ZERO),
      ]),
    );
  const assets = net(ordinaryAssets, contraAssets),
    liabilities = net(ordinaryLiabilities, contraLiabilities);
  const months: BalanceMonth[] = [];
  for (
    let m = utc(seriesStart(asOf));
    iso(m).slice(0, 7) <= asOf.slice(0, 7);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
  ) {
    const key = iso(m).slice(0, 7);
    const end = iso(new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)));
    const a = assets.get(key) ?? ZERO,
      l = liabilities.get(key) ?? ZERO;
    months.push({
      month: `${key}-01`,
      at: end < asOf ? end : asOf,
      assets: a,
      liabilities: l,
      equity: a - l,
      cash: (cash.get(key) ?? ZERO) - (cards.get(key) ?? ZERO),
    });
  }
  return months;
}

/* ------------------------------------------------------------------------ */
/* The statement                                                            */
/* ------------------------------------------------------------------------ */

const SECTIONS = new Set(["Assets", "Liabilities", "Equity"]);

/**
 * The balance sheet rows of the shared model, labelled with their section.
 * A rise is good news for assets and equity and bad for liabilities, which
 * the statement colours by `side` (liabilities read as "expense").
 */
export function balanceStatementRows(model: ReportModel): StatementRow[] {
  let section = "";
  return model.rows.map((row) => {
    if (row.kind === "heading" && SECTIONS.has(row.label)) section = row.label;
    const total = row.kind === "total";
    const owner =
      total && /liabilities & equity/i.test(row.label) ? "Liabilities & equity" : section;
    return {
      ...row,
      section: owner,
      side: section === "Liabilities" && row.label !== "Total liabilities & equity"
        ? "expense"
        : total
          ? "result"
          : "income",
    };
  });
}
