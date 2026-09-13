/**
 * Estimated-payment schedule for the Tax Estimator hero and quarter tiles.
 *
 * Pure: takes the year's payment rows, the remaining balances from the tax
 * engine and the federal deadline table. It never reads the clock or the
 * network, so the same inputs always give the same schedule.
 *
 * The due quarter's suggestion is the tax on the year so far, all of it: the
 * owner pays what has actually been earned into, never a share of a year that
 * has not happened. Beside it the annualization helpers implement the IRS
 * method for uneven income (Form 2210 Schedule AI, Arizona Form 221): income
 * through the period, scaled by a fixed factor, taxed, times a cumulative
 * share. Neither forecasts anything. Rows that came from the books carry an
 * actual-so-far figure and an owner-typed rest of year; the meter shows the
 * rest as projected rather than in hand.
 */
import type { BooksLink, TaxPaymentEntry } from "@/types/database";
import type { FullTaxBreakdown } from "@/lib/tax/calculations";

/** IRS estimated-payment due dates, weekend-shifted as published. */
export const federalDeadlines: Record<number, readonly string[]> = {
  2025: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
  2026: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
};

export type QuarterKey = "Q1" | "Q2" | "Q3" | "Q4";
export const QUARTER_KEYS: readonly QuarterKey[] = ["Q1", "Q2", "Q3", "Q4"];

export type QuarterStatus = "paid" | "due" | "upcoming" | "past";

export interface QuarterSchedule {
  key: QuarterKey;
  /** Federal deadline, `YYYY-MM-DD`. Arizona's estimate dates coincide. */
  deadline: string;
  federalPaid: number;
  statePaid: number;
  /** Estimated-payment rows filed under this quarter. */
  rows: TaxPaymentEntry[];
  status: QuarterStatus;
  /** Only the `due` quarter carries suggestions. */
  suggestedFederal: number | null;
  suggestedState: number | null;
}

export interface NextPayment {
  /** `quarter` is an estimate deadline; `return` is the filing deadline after Q4. */
  kind: "quarter" | "return";
  quarter: QuarterKey | null;
  deadline: string;
  daysUntil: number;
  suggestedFederal: number;
  suggestedState: number;
}

export interface PaymentSchedule {
  deadlineSource: "table" | "nominal";
  quarters: [QuarterSchedule, QuarterSchedule, QuarterSchedule, QuarterSchedule];
  /** Rows filed as `final` or `other`: counted in the totals, outside the tiles. */
  other: { federal: number; state: number; rows: TaxPaymentEntry[] };
  next: NextPayment | null;
}

export interface MeterSegments {
  /** Withholding that has actually happened. */
  withheld: number;
  /** Estimated payments recorded for the year. */
  estimated: number;
  /** Not yet in hand: rest-of-year withholding, the assumed FICA credit, refundable credits. */
  projected: number;
  /** What is still owed, floored at zero (a refund shows as an empty remainder). */
  remaining: number;
  /** The four segments summed, so widths can be expressed as shares of this. */
  total: number;
}

export interface PaymentScheduleInput {
  year: number;
  /** `YYYY-MM-DD` in the books timezone. */
  today: string;
  payments: TaxPaymentEntry[];
  breakdown: Pick<FullTaxBreakdown, "federalRemaining" | "stateRemaining">;
  /** `federalDeadlines[year]`; omitted or malformed falls back to nominal dates. */
  deadlines?: readonly string[];
}

const DAY_MS = 86_400_000;
const CENT = 0.005;

const isEstimated = (row: TaxPaymentEntry) => row.category === "payment";
const toCents = (dollars: number) => Math.round(dollars * 100);

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Apr 15, Jun 15, Sep 15 and Jan 15 of the following year, no weekend shift. */
export function nominalDeadlines(year: number): string[] {
  return [
    `${year}-${pad(4)}-15`,
    `${year}-${pad(6)}-15`,
    `${year}-${pad(9)}-15`,
    `${year + 1}-${pad(1)}-15`,
  ];
}

function utcDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from one `YYYY-MM-DD` to another; negative when `to` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((utcDay(toIso) - utcDay(fromIso)) / DAY_MS);
}

function sum(rows: TaxPaymentEntry[], type?: TaxPaymentEntry["type"]): number {
  let total = 0;
  for (const row of rows) {
    if (type && row.type !== type) continue;
    total += Number(row.amount) || 0;
  }
  return total;
}

export function buildPaymentSchedule(input: PaymentScheduleInput): PaymentSchedule {
  const { year, today, payments, breakdown } = input;
  const tableDeadlines =
    input.deadlines && input.deadlines.length === 4 ? [...input.deadlines] : null;
  const deadlines = tableDeadlines ?? nominalDeadlines(year);
  const deadlineSource: PaymentSchedule["deadlineSource"] = tableDeadlines
    ? "table"
    : "nominal";

  // Bucket estimated payments by their quarter label, the only per-quarter
  // signal the rows carry.
  const buckets: Record<QuarterKey, TaxPaymentEntry[]> = { Q1: [], Q2: [], Q3: [], Q4: [] };
  const otherRows: TaxPaymentEntry[] = [];
  for (const row of payments) {
    if (!isEstimated(row)) continue;
    const key = row.quarter ?? "Q1";
    if (key === "Q1" || key === "Q2" || key === "Q3" || key === "Q4") buckets[key].push(row);
    else otherRows.push(row);
  }

  // First pass: status per quarter.
  let dueAssigned = false;
  const quarters = QUARTER_KEYS.map((key, i): QuarterSchedule => {
    const rows = buckets[key];
    const deadline = deadlines[i];
    const federalPaid = sum(rows, "federal");
    const statePaid = sum(rows, "state");
    const paidAny = federalPaid > CENT || statePaid > CENT;
    const ahead = deadline >= today;

    let status: QuarterStatus;
    if (!ahead) status = paidAny ? "paid" : "past";
    else if (paidAny) status = "paid";
    else if (!dueAssigned) {
      status = "due";
      dueAssigned = true;
    } else status = "upcoming";

    return {
      key,
      deadline,
      federalPaid,
      statePaid,
      rows,
      status,
      suggestedFederal: null,
      suggestedState: null,
    };
  }) as PaymentSchedule["quarters"];

  // Second pass: the due quarter's suggestion is everything still owed on the
  // year so far. Later deadlines get their own figure when their income exists.
  const dueIndex = quarters.findIndex((q) => q.status === "due");
  let next: NextPayment | null = null;

  if (dueIndex >= 0) {
    const due = quarters[dueIndex];
    const suggestedFederal = Math.max(toCents(breakdown.federalRemaining), 0) / 100;
    const suggestedState = Math.max(toCents(breakdown.stateRemaining), 0) / 100;
    due.suggestedFederal = suggestedFederal;
    due.suggestedState = suggestedState;
    next = {
      kind: "quarter",
      quarter: due.key,
      deadline: due.deadline,
      daysUntil: daysBetween(today, due.deadline),
      suggestedFederal,
      suggestedState,
    };
  } else {
    // Every estimate deadline is behind us or settled. What is left is due
    // with the return.
    const returnDeadline = `${year + 1}-04-15`;
    const owed = breakdown.federalRemaining > CENT || breakdown.stateRemaining > CENT;
    if (owed && returnDeadline >= today) {
      next = {
        kind: "return",
        quarter: null,
        deadline: returnDeadline,
        daysUntil: daysBetween(today, returnDeadline),
        suggestedFederal: Math.max(breakdown.federalRemaining, 0),
        suggestedState: Math.max(breakdown.stateRemaining, 0),
      };
    }
  }

  return {
    deadlineSource,
    quarters,
    other: { federal: sum(otherRows, "federal"), state: sum(otherRows, "state"), rows: otherRows },
    next,
  };
}

/**
 * Splits `totalPaid` into what has happened, what is recorded, and what is
 * only projected, then adds the balance still owed. The first three always sum
 * to `breakdown.totalPaid` because the engine counts every payment row's full
 * amount plus the assumed FICA credit and the refundable child credit.
 */
export function buildMeter(
  breakdown: Pick<
    FullTaxBreakdown,
    "totalPaid" | "netRemaining" | "ficaAutoCredited" | "additionalChildTaxCredit"
  >,
  payments: TaxPaymentEntry[],
): MeterSegments {
  let withheld = 0;
  let estimated = 0;
  let restOfYear = 0;
  for (const row of payments) {
    const amount = Number(row.amount) || 0;
    if (isEstimated(row)) {
      estimated += amount;
    } else if (row.books) {
      withheld += row.books.actual;
      restOfYear += amount - row.books.actual;
    } else {
      withheld += amount;
    }
  }
  const projected =
    restOfYear + breakdown.ficaAutoCredited + breakdown.additionalChildTaxCredit;
  const remaining = Math.max(breakdown.netRemaining, 0);
  return {
    withheld,
    estimated,
    projected,
    remaining,
    total: withheld + estimated + projected + remaining,
  };
}

// ---------------------------------------------------------------------------
// Annualized income instalments (Form 2210 Schedule AI; Arizona Form 221).

export interface AnnualizationPeriod {
  quarter: QuarterKey;
  /** Last day of income the instalment looks at, `YYYY-MM-DD`. */
  end: string;
  /** Scales the period's income to a full year. */
  factor: number;
  /** Cumulative share of the annualized tax that must be in by the deadline: the instalments so far, at the 90% rule. */
  share: number;
  /** The same instalments without the 10% cushion: a quarter of the year each. */
  paceShare: number;
  /** Months in the period, for spreading undated amounts. */
  months: number;
}

const PERIODS: Record<QuarterKey, Omit<AnnualizationPeriod, "quarter" | "end"> & { end: string }> = {
  Q1: { end: "03-31", factor: 4, share: 0.225, paceShare: 0.25, months: 3 },
  Q2: { end: "05-31", factor: 2.4, share: 0.45, paceShare: 0.5, months: 5 },
  Q3: { end: "08-31", factor: 1.5, share: 0.675, paceShare: 0.75, months: 8 },
  Q4: { end: "12-31", factor: 1, share: 0.9, paceShare: 1, months: 12 },
};

/** IRC 6621 underpayment rate: the federal short-term rate plus three points, 7% through 2026. */
export const UNDERPAYMENT_RATE = 0.07;

export function annualizationPeriod(year: number, quarter: QuarterKey): AnnualizationPeriod {
  const p = PERIODS[quarter];
  return { quarter, end: `${year}-${p.end}`, factor: p.factor, share: p.share, paceShare: p.paceShare, months: p.months };
}

/**
 * Books rows take their actual through the period end, scaled to a year.
 * Rows with no dates are spread evenly, and an evenly spread amount
 * annualizes to itself, so they pass through untouched.
 */
export function annualizeRows<T extends { amount: number; books?: BooksLink }>(
  rows: T[],
  factor: number,
  actuals: Record<string, number>,
): T[] {
  return rows.map((row) => {
    if (!row.books) return row;
    const actual = actuals[row.books.key] ?? row.books.actual;
    return { ...row, amount: toCents(actual * factor) / 100 };
  });
}

/** Withholding through the period: books rows at their actual, undated rows prorated by months. */
export function withheldThrough(
  payments: TaxPaymentEntry[],
  period: AnnualizationPeriod,
  actuals: Record<string, number>,
): { federal: number; state: number } {
  const out = { federal: 0, state: 0 };
  for (const row of payments) {
    if (isEstimated(row)) continue;
    const amount = row.books
      ? (actuals[row.books.key] ?? row.books.actual)
      : ((Number(row.amount) || 0) * period.months) / 12;
    out[row.type] += amount;
  }
  return out;
}

/** Estimated payments recorded under this quarter and the ones before it. */
export function estimatedThrough(
  payments: TaxPaymentEntry[],
  quarter: QuarterKey,
): { federal: number; state: number } {
  const limit = QUARTER_KEYS.indexOf(quarter);
  const out = { federal: 0, state: 0 };
  for (const row of payments) {
    if (!isEstimated(row)) continue;
    const index = QUARTER_KEYS.indexOf((row.quarter ?? "Q1") as QuarterKey);
    if (index < 0 || index > limit) continue;
    out[row.type] += Number(row.amount) || 0;
  }
  return out;
}

/**
 * What must be in by the deadline: a share of the annualized tax, less what
 * is paid, never negative. The period's own share is the penalty-free
 * minimum; pass `period.paceShare` for the full instalment without the cushion.
 */
export function annualizedRequirement(input: {
  period: AnnualizationPeriod;
  annualizedTax: { federal: number; state: number };
  paidToDate: { federal: number; state: number };
  share?: number;
}): { federal: number; state: number } {
  const share = input.share ?? input.period.share;
  const owed = (tax: number, paid: number) =>
    Math.max(toCents(share * tax) - toCents(paid), 0) / 100;
  return {
    federal: owed(input.annualizedTax.federal, input.paidToDate.federal),
    state: owed(input.annualizedTax.state, input.paidToDate.state),
  };
}

/** Roughly what a shortfall costs if it stays unpaid from one deadline to the next. */
export function shortfallCost(
  gap: number,
  fromIso: string,
  toIso: string,
  rate = UNDERPAYMENT_RATE,
): number {
  if (gap <= CENT) return 0;
  const days = Math.max(daysBetween(fromIso, toIso), 0);
  return toCents((gap * rate * days) / 365) / 100;
}
