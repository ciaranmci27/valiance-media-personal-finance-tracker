// Form 941 quarterly aggregator. Pure. No IO.
//
// Sources
// -------
// IRS Form 941 (Employer's Quarterly Federal Tax Return), 2025 revision and
// accompanying instructions. https://www.irs.gov/pub/irs-pdf/f941.pdf and
// https://www.irs.gov/pub/irs-pdf/i941.pdf
//
// Scope
// -----
// The aggregator walks a quarter's finalized/paid runs and produces the numbers
// that fill every editable field on Form 941. The caller is responsible for:
//   - Filtering `runs` to finalized + paid, within the quarter's calendar
//     range, not deleted.
//   - Filtering `deposits` to federal_941, status=paid, within the quarter.
//   - Passing the organization's current federal_deposit_schedule. For
//     historical quarters, caller should hydrate from the snapshot instead.
//
// Line 1 employee count
// ---------------------
// IRS instruction: count employees who received wages in the pay period
// INCLUDING the 12th day of the last month of the quarter. The reference dates
// are Mar 12, Jun 12, Sep 12, Dec 12.
//
// Line 7 (fractions of cents)
// ---------------------------
// Line 5a/5c/5d report the aggregate wages multiplied by the statutory rates
// (12.4 / 2.9 / 0.9%). Per-paycheck FICA is rounded to two decimals, so summing
// those rounded values rarely equals the aggregate recomputation exactly. The
// difference is reported on Line 7 so the IRS sees a consistent total. This is
// typically a few pennies (sometimes a few dollars for large payrolls).
//
// Line 16 / Part 2 deposit schedule
// ---------------------------------
// Monthly depositors fill Box B with Month 1 / Month 2 / Month 3 liability
// (must sum to Line 12). Semiweekly depositors fill Box C and attach Schedule
// B (daily liability by date). We produce both shapes so the UI can render the
// right one based on deposit_schedule.

import { round2 } from "./rounding";
import { splitWithholdings } from "./withholdings";
import type {
  FederalDepositSchedule,
  Form941Data,
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";

// ─── Statutory rates (mirrors payroll engine constants) ───────────────────────

/** Combined employer + employee social security rate per IRS. */
const SS_COMBINED_RATE = 0.124;
/** Combined employer + employee medicare rate per IRS. */
const MEDICARE_COMBINED_RATE = 0.029;
/** Additional medicare tax withheld from the employee only. */
const ADDITIONAL_MEDICARE_RATE = 0.009;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AggregateForm941Input {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Runs with pay_date in this quarter. Caller must pre-filter to
   *  finalized/paid, deleted_at IS NULL. */
  runs: PayrollRun[];
  /** Federal 941 deposits covering this quarter. Caller must pre-filter to
   *  deposit_type='federal_941'. Both paid and scheduled are accepted; only
   *  paid count toward Line 13a. */
  deposits: PayrollTaxDeposit[];
  /** Employer's deposit schedule for this quarter. Determines whether Line
   *  16 Box B (monthly) or Box C (semiweekly / Schedule B) is populated. */
  federal_deposit_schedule: FederalDepositSchedule;
  /** Employees paid at any point in the quarter. Optional but strongly
   *  recommended: supplying it lets Line 1 count an employee who was active
   *  on the reference date (e.g. Mar 12) even when no regular-run period
   *  happened to span that date (common for off-cycle-only or one-day runs).
   *  Without it, Line 1 only counts runs whose period includes the 12th. */
  employees?: Array<{
    id: string;
    hire_date?: string | null;
    termination_date?: string | null;
  }>;
}

export interface AggregateForm941Result {
  data: Form941Data;
  /** Non-blocking advisories the UI should display. Examples: "2 runs have
   *  zero taxable wages (pre-migration data)", "deposit total is less than
   *  tax liability - balance due on Line 14". */
  warnings: string[];
}

// ─── Quarter calendar helpers ─────────────────────────────────────────────────

interface QuarterBounds {
  start: Date;
  end: Date;
  /** Last month of the quarter, 1..12. */
  lastMonth: number;
  /** Line 1 reference date: 12th of the last month of the quarter. */
  referenceDate: Date;
  /** [startMonth, midMonth, endMonth] — 1-indexed months for Part 2. */
  months: [number, number, number];
}

function quarterBounds(year: number, quarter: 1 | 2 | 3 | 4): QuarterBounds {
  const startMonth = (quarter - 1) * 3 + 1; // 1, 4, 7, 10
  const endMonth = startMonth + 2; // 3, 6, 9, 12
  const start = new Date(Date.UTC(year, startMonth - 1, 1));
  const end = new Date(Date.UTC(year, endMonth, 0)); // last day of endMonth
  return {
    start,
    end,
    lastMonth: endMonth,
    referenceDate: new Date(Date.UTC(year, endMonth - 1, 12)),
    months: [startMonth, startMonth + 1, endMonth],
  };
}

function parseYmdUtc(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isWithinQuarter(
  dateYmd: string,
  bounds: QuarterBounds,
): boolean {
  const d = parseYmdUtc(dateYmd).getTime();
  return d >= bounds.start.getTime() && d <= bounds.end.getTime();
}

// ─── Liability math ───────────────────────────────────────────────────────────

/** Total 941-reportable federal liability for a single run. This is the
 *  IRS definition: federal income tax withheld + both halves of FICA +
 *  additional medicare. Used for Line 16 / Schedule B daily liability. */
function runFederal941Liability(run: PayrollRun): number {
  return round2(
    Number(run.federal_income_tax || 0) +
      Number(run.social_security_employee || 0) +
      Number(run.social_security_employer || 0) +
      Number(run.medicare_employee || 0) +
      Number(run.medicare_employer || 0) +
      Number(run.additional_medicare || 0),
  );
}

/** Sum of per-run FICA actually withheld/matched. Used to compute the
 *  Line 7 fractions-of-cents adjustment against the aggregate rate math. */
function totalRunFicaCollected(runs: PayrollRun[]): number {
  let total = 0;
  for (const r of runs) {
    total +=
      Number(r.social_security_employee || 0) +
      Number(r.social_security_employer || 0) +
      Number(r.medicare_employee || 0) +
      Number(r.medicare_employer || 0) +
      Number(r.additional_medicare || 0);
  }
  return round2(total);
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

export function aggregateForm941(
  input: AggregateForm941Input,
): AggregateForm941Result {
  const bounds = quarterBounds(input.tax_year, input.quarter);
  const warnings: string[] = [];

  // Only runs with pay_date in the quarter. Caller is expected to have
  // pre-filtered, but we double-guard since this feeds the IRS.
  const runs = input.runs.filter((r) => isWithinQuarter(r.pay_date, bounds));
  if (runs.length !== input.runs.length) {
    warnings.push(
      `Ignored ${input.runs.length - runs.length} run(s) whose pay date falls outside Q${input.quarter} ${input.tax_year}.`,
    );
  }

  // No activity in the quarter: still produce an all-zero return so the
  // admin can file for compliance. Surface a gentle advisory so this is
  // a deliberate choice rather than a mistake.
  if (runs.length === 0) {
    warnings.push(
      `No approved or paid runs in Q${input.quarter} ${input.tax_year}. A zero-activity 941 can be filed to keep the quarterly filing history intact.`,
    );
  }

  // Line 1: employees in pay period including the 12th of the last month.
  // Per IRS, we count distinct employees whose period_start <= ref <= period_end.
  // When `employees` is supplied, we additionally include anyone who was
  // actively employed on the reference date, which covers cases where an
  // employee was paid only via a one-day off-cycle run that doesn't span
  // the 12th but they were on the payroll that day.
  const refYmd = ymd(bounds.referenceDate);
  const referenceEmployees = new Set<string>();
  for (const r of runs) {
    if (r.period_start <= refYmd && refYmd <= r.period_end) {
      referenceEmployees.add(r.employee_id);
    }
  }
  if (input.employees) {
    const paidEmployeeIds = new Set(runs.map((r) => r.employee_id));
    for (const emp of input.employees) {
      if (!paidEmployeeIds.has(emp.id)) continue;
      const hiredBy = !emp.hire_date || emp.hire_date <= refYmd;
      const notYetTerminated =
        !emp.termination_date || emp.termination_date >= refYmd;
      if (hiredBy && notYetTerminated) {
        referenceEmployees.add(emp.id);
      }
    }
  }
  const line_1_employees = referenceEmployees.size;

  // Line 2: wages, tips, and other compensation. Mirrors W-2 Box 1 semantics
  // (gross - pre-tax 401(k) - pre-tax §125). IRS i941 aligns Line 2 with the
  // sum of Box 1 across all W-2s issued for the year, so we subtract the same
  // pre-tax buckets here. See `splitWithholdings` for category rules.
  let preTax401kTotal = 0;
  let preTax125Total = 0;
  for (const r of runs) {
    const split = splitWithholdings(r.other_withholdings);
    preTax401kTotal += split.preTax401k;
    preTax125Total += split.preTax125;
  }
  const grossTotal = sum(runs, (r) => Number(r.gross_pay || 0));
  const line_2_wages = round2(grossTotal - preTax401kTotal - preTax125Total);

  // Line 3: Federal income tax withheld.
  const line_3_federal_income_tax = round2(
    sum(runs, (r) => Number(r.federal_income_tax || 0)),
  );

  // Line 5a / 5c / 5d taxable wage bases are summed directly from the
  // persisted per-run taxable wage columns. These were introduced in
  // migration 20260421_payroll_runs_taxable_wages. Runs finalized before
  // that migration have zeroed bases and will under-report - we surface
  // a warning if we see a finalized run with nonzero SS tax but zero SS wages.
  const line_5a_ss_wages = round2(
    sum(runs, (r) => Number(r.social_security_wages || 0)),
  );
  const line_5c_medicare_wages = round2(
    sum(runs, (r) => Number(r.medicare_wages || 0)),
  );
  const line_5d_additional_medicare_wages = round2(
    sum(runs, (r) => Number(r.additional_medicare_wages || 0)),
  );

  // Detect legacy runs with FICA amounts but zero taxable-wage base.
  const zeroBaseWithTax = runs.filter(
    (r) =>
      Number(r.social_security_wages || 0) === 0 &&
      (Number(r.social_security_employee || 0) > 0 ||
        Number(r.medicare_employee || 0) > 0),
  ).length;
  if (zeroBaseWithTax > 0) {
    warnings.push(
      `${zeroBaseWithTax} run(s) have FICA amounts but no stored taxable wage base. Recalculate and re-approve those runs so Lines 5a/5c report correctly.`,
    );
  }

  // Tax values computed from aggregate wages × statutory rates. IRS prefers
  // this form on the return; the per-paycheck rounding slippage is handled
  // on Line 7.
  const line_5a_ss_tax = round2(line_5a_ss_wages * SS_COMBINED_RATE);
  const line_5c_medicare_tax = round2(
    line_5c_medicare_wages * MEDICARE_COMBINED_RATE,
  );
  const line_5d_additional_medicare_tax = round2(
    line_5d_additional_medicare_wages * ADDITIONAL_MEDICARE_RATE,
  );

  const line_5e_total_ss_medicare = round2(
    line_5a_ss_tax + line_5c_medicare_tax + line_5d_additional_medicare_tax,
  );

  const line_6_total_taxes_before_adjustments = round2(
    line_3_federal_income_tax + line_5e_total_ss_medicare,
  );

  // Line 7: fractions-of-cents adjustment.
  // Aggregate FICA (employer + employee + additional medicare) per the rates
  // vs the sum of per-paycheck rounded FICA. The difference reconciles.
  const actualFicaCollected = totalRunFicaCollected(runs);
  const line_7_fractions_of_cents = round2(
    line_5e_total_ss_medicare - actualFicaCollected,
  );

  const line_10_total_taxes_after_adjustments = round2(
    line_6_total_taxes_before_adjustments + line_7_fractions_of_cents,
  );

  // Line 12 = Line 10 minus Line 11d credits. We don't automate credits here;
  // admin can override in the UI if they're claiming the research credit.
  const line_12_total_taxes = line_10_total_taxes_after_adjustments;

  // Line 13a: total deposits for the quarter. Only status=paid counts.
  const paidFederalDeposits = input.deposits.filter(
    (d) =>
      d.deposit_type === "federal_941" &&
      d.status === "paid" &&
      isWithinQuarter(d.period_end, bounds),
  );
  const line_13a_total_deposits = round2(
    sum(paidFederalDeposits, (d) => Number(d.amount || 0)),
  );

  const line_14_balance_due = round2(
    Math.max(0, line_12_total_taxes - line_13a_total_deposits),
  );
  const line_15_overpayment = round2(
    Math.max(0, line_13a_total_deposits - line_12_total_taxes),
  );

  if (line_14_balance_due > 0) {
    warnings.push(
      `Balance due of $${line_14_balance_due.toFixed(2)} - either you have undeposited liability for this quarter, or deposits are not yet marked as paid in the system.`,
    );
  }

  // Part 2 deposit schedule breakdown.
  let monthly_liability: Form941Data["monthly_liability"] | undefined;
  let schedule_b: Form941Data["schedule_b"] | undefined;

  if (input.federal_deposit_schedule === "monthly") {
    monthly_liability = buildMonthlyLiability(
      runs,
      bounds,
      line_12_total_taxes,
    );
  } else {
    schedule_b = buildScheduleB(runs, line_12_total_taxes);
  }

  // Post-condition safety nets. Under normal circumstances these cannot fire
  // because buildMonthlyLiability / buildScheduleB plug the Line 7 reconcile
  // into the final bucket. They exist to catch regressions in those builders
  // and mirrored rounding drift. IRS requires both monthly (Line 16B) and
  // Schedule B per-day totals to equal Line 12 exactly, so a mismatch here is
  // blocking.
  if (monthly_liability) {
    const m = monthly_liability;
    const sumMonthly = round2(m.month1 + m.month2 + m.month3);
    if (sumMonthly !== line_12_total_taxes) {
      warnings.push(
        `Monthly liability (Line 16B) sums to $${sumMonthly.toFixed(2)} but Line 12 is $${line_12_total_taxes.toFixed(2)}. Difference of $${(line_12_total_taxes - sumMonthly).toFixed(2)} must be reconciled before filing.`,
      );
    }
    // IRS won't accept a negative Line 16B cell. If a large negative Line 7
    // pushed month3 below zero, the admin must redistribute manually.
    if (m.month1 < 0 || m.month2 < 0 || m.month3 < 0) {
      warnings.push(
        "One or more Line 16B monthly liability cells went negative after fractions-of-cents reconciliation. Redistribute the adjustment across months before filing.",
      );
    }
  }
  if (schedule_b) {
    const sumSchedule = round2(
      schedule_b.reduce((s, e) => s + e.amount, 0),
    );
    if (sumSchedule !== line_12_total_taxes) {
      warnings.push(
        `Schedule B per-day liability sums to $${sumSchedule.toFixed(2)} but Line 12 is $${line_12_total_taxes.toFixed(2)}. Difference of $${(line_12_total_taxes - sumSchedule).toFixed(2)} must be reconciled before filing.`,
      );
    }
    // IRS won't accept negative per-day liability on Schedule B either.
    if (schedule_b.some((e) => e.amount < 0)) {
      warnings.push(
        "Schedule B has a negative per-day liability after fractions-of-cents reconciliation. Redistribute the adjustment across liability days before filing.",
      );
    }
  }

  const data: Form941Data = {
    tax_year: input.tax_year,
    quarter: input.quarter,
    line_1_employees,
    line_2_wages,
    line_3_federal_income_tax,
    line_5a_ss_wages,
    line_5a_ss_tax,
    line_5c_medicare_wages,
    line_5c_medicare_tax,
    line_5d_additional_medicare_wages,
    line_5d_additional_medicare_tax,
    line_5e_total_ss_medicare,
    line_6_total_taxes_before_adjustments,
    line_7_fractions_of_cents,
    line_10_total_taxes_after_adjustments,
    line_12_total_taxes,
    line_13a_total_deposits,
    line_14_balance_due,
    line_15_overpayment,
    deposit_schedule: input.federal_deposit_schedule,
    ...(monthly_liability ? { monthly_liability } : {}),
    ...(schedule_b ? { schedule_b } : {}),
  };

  return { data, warnings };
}

// ─── Part 2 builders ──────────────────────────────────────────────────────────

/** Distributes 941 liability into the three months of the quarter. The
 *  fractions-of-cents adjustment lands in the month where the reconciliation
 *  is most natural (the last month of the quarter) so the three months sum
 *  to Line 12 exactly. */
function buildMonthlyLiability(
  runs: PayrollRun[],
  bounds: QuarterBounds,
  line12: number,
): { month1: number; month2: number; month3: number } {
  const [m1, m2, m3] = bounds.months;
  let raw1 = 0;
  let raw2 = 0;
  let raw3 = 0;
  for (const r of runs) {
    const liability = runFederal941Liability(r);
    const m = parseYmdUtc(r.pay_date).getUTCMonth() + 1;
    if (m === m1) raw1 += liability;
    else if (m === m2) raw2 += liability;
    else if (m === m3) raw3 += liability;
  }
  raw1 = round2(raw1);
  raw2 = round2(raw2);
  raw3 = round2(raw3);

  // Sum of raw per-month liabilities equals Line 6 (before fractions). Plug
  // the Line 7 reconciliation into the last month so totals tie to Line 12.
  const rawSum = round2(raw1 + raw2 + raw3);
  const reconcile = round2(line12 - rawSum);
  return {
    month1: raw1,
    month2: raw2,
    month3: round2(raw3 + reconcile),
  };
}

/** Schedule B: per-day 941 liability. One entry per pay date where liability
 *  was incurred. The Schedule B form has a grid of months/days; the UI
 *  formats this list into that grid.
 *
 *  Per IRS Schedule B instructions, the per-day total must equal Form 941
 *  Line 12. Per-run liability sums to Line 6 (before Line 7). We plug the
 *  Line 7 reconciliation into the latest liability day so the grand total
 *  ties to Line 12. When no liability days exist but Line 12 is nonzero
 *  (shouldn't happen for a valid quarter), we surface via an empty list and
 *  the caller's warning system catches the mismatch. */
function buildScheduleB(
  runs: PayrollRun[],
  line12: number,
): Array<{ date: string; amount: number }> {
  const byDate = new Map<string, number>();
  for (const r of runs) {
    const existing = byDate.get(r.pay_date) ?? 0;
    byDate.set(r.pay_date, existing + runFederal941Liability(r));
  }
  const entries = Array.from(byDate.entries())
    .map(([date, amount]) => ({ date, amount: round2(amount) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (entries.length === 0) return entries;

  const rawSum = round2(entries.reduce((s, e) => s + e.amount, 0));
  const reconcile = round2(line12 - rawSum);
  if (reconcile !== 0) {
    const last = entries[entries.length - 1];
    entries[entries.length - 1] = {
      date: last.date,
      amount: round2(last.amount + reconcile),
    };
  }
  return entries;
}

// ─── Small utilities ──────────────────────────────────────────────────────────

function sum<T>(items: T[], get: (t: T) => number): number {
  let total = 0;
  for (const i of items) total += get(i);
  return total;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
