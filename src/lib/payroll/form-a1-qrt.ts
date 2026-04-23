// Arizona Form A1-QRT quarterly aggregator. Pure. No IO.
//
// Sources
// -------
// AZ Department of Revenue Form A1-QRT (Arizona Quarterly Withholding Tax
// Return), 2025 revision and instructions. Filed via AZTaxes.gov alongside
// quarterly A1-WP deposits.
//
// Scope
// -----
// Aggregates Arizona state income tax withheld from this employer's payroll
// for the quarter. Line A is the engine-computed withholding; Line B is the
// sum of paid A1-WP deposits. The quarterly return reconciles the two and
// produces a balance due or overpayment.
//
// This is the Arizona analog of Form 941 Part 1. The deposit schedule (per
// AZ rules) is independent of the federal schedule: quarterly is the default
// for small employers, monthly/semiweekly kick in at higher withholding
// thresholds.

import { round2 } from "./rounding";
import type {
  FormA1QrtData,
  PayrollRun,
  PayrollTaxDeposit,
  StateDepositSchedule,
} from "@/types/payroll";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AggregateFormA1QrtInput {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Runs with pay_date in the quarter. Caller filters to
   *  finalized/paid + deleted_at IS NULL + state_code = 'AZ'. */
  runs: PayrollRun[];
  /** state_withholding deposits for this employer in this quarter. Only
   *  paid deposits count toward Line B. */
  deposits: PayrollTaxDeposit[];
  /** Deposit schedule in effect for this employer in this quarter. */
  state_deposit_schedule: StateDepositSchedule;
}

export interface AggregateFormA1QrtResult {
  data: FormA1QrtData;
  warnings: string[];
}

// ─── Quarter calendar helpers ─────────────────────────────────────────────────

interface QuarterBounds {
  start: Date;
  end: Date;
  months: [number, number, number];
}

function quarterBounds(year: number, quarter: 1 | 2 | 3 | 4): QuarterBounds {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    start: new Date(Date.UTC(year, startMonth - 1, 1)),
    end: new Date(Date.UTC(year, endMonth, 0)),
    months: [startMonth, startMonth + 1, endMonth],
  };
}

function parseYmdUtc(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isWithinQuarter(dateYmd: string, bounds: QuarterBounds): boolean {
  const d = parseYmdUtc(dateYmd).getTime();
  return d >= bounds.start.getTime() && d <= bounds.end.getTime();
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

export function aggregateFormA1Qrt(
  input: AggregateFormA1QrtInput,
): AggregateFormA1QrtResult {
  const bounds = quarterBounds(input.tax_year, input.quarter);
  const warnings: string[] = [];

  const runs = input.runs.filter((r) => isWithinQuarter(r.pay_date, bounds));
  if (runs.length !== input.runs.length) {
    warnings.push(
      `Ignored ${input.runs.length - runs.length} run(s) whose pay date falls outside Q${input.quarter} ${input.tax_year}.`,
    );
  }
  if (runs.length === 0) {
    warnings.push(
      `No approved or paid Arizona runs in Q${input.quarter} ${input.tax_year}. A zero-activity A1-QRT may be filed to keep the quarterly history intact.`,
    );
  }

  const employees = new Set(runs.map((r) => r.employee_id)).size;
  const total_az_wages = round2(sum(runs, (r) => Number(r.gross_pay || 0)));
  const line_a_az_tax_withheld = round2(
    sum(runs, (r) => Number(r.state_income_tax || 0)),
  );

  const paidStateDeposits = input.deposits.filter(
    (d) =>
      d.deposit_type === "state_withholding" &&
      d.status === "paid" &&
      isWithinQuarter(d.period_end, bounds),
  );
  const line_b_az_tax_paid = round2(
    sum(paidStateDeposits, (d) => Number(d.amount || 0)),
  );

  const line_c_overpayment = round2(
    Math.max(0, line_b_az_tax_paid - line_a_az_tax_withheld),
  );
  const line_d_balance_due = round2(
    Math.max(0, line_a_az_tax_withheld - line_b_az_tax_paid),
  );

  if (line_d_balance_due > 0) {
    warnings.push(
      `Balance due of $${line_d_balance_due.toFixed(2)} - either you have undeposited AZ withholding for this quarter, or A1-WP deposits are not yet marked as paid in the system.`,
    );
  }

  let monthly_liability: FormA1QrtData["monthly_liability"] | undefined;
  let schedule_a: FormA1QrtData["schedule_a"] | undefined;

  if (input.state_deposit_schedule === "monthly") {
    monthly_liability = buildMonthlyLiability(runs, bounds);
  } else if (input.state_deposit_schedule === "semiweekly") {
    schedule_a = buildScheduleA(runs);
  }

  if (monthly_liability) {
    const m = monthly_liability;
    const sumMonthly = round2(m.month1 + m.month2 + m.month3);
    if (sumMonthly !== line_a_az_tax_withheld) {
      warnings.push(
        `Monthly liability sums to $${sumMonthly.toFixed(2)} but Line A is $${line_a_az_tax_withheld.toFixed(2)}. Difference must be reconciled before filing.`,
      );
    }
  }
  if (schedule_a) {
    const sumSchedule = round2(schedule_a.reduce((s, e) => s + e.amount, 0));
    if (sumSchedule !== line_a_az_tax_withheld) {
      warnings.push(
        `Schedule A per-day liability sums to $${sumSchedule.toFixed(2)} but Line A is $${line_a_az_tax_withheld.toFixed(2)}. Difference must be reconciled before filing.`,
      );
    }
  }

  const data: FormA1QrtData = {
    tax_year: input.tax_year,
    quarter: input.quarter,
    employees,
    total_az_wages,
    line_a_az_tax_withheld,
    line_b_az_tax_paid,
    line_c_overpayment,
    line_d_balance_due,
    deposit_schedule: input.state_deposit_schedule,
    ...(monthly_liability ? { monthly_liability } : {}),
    ...(schedule_a ? { schedule_a } : {}),
  };

  return { data, warnings };
}

// ─── Part 2 builders ──────────────────────────────────────────────────────────

function buildMonthlyLiability(
  runs: PayrollRun[],
  bounds: QuarterBounds,
): { month1: number; month2: number; month3: number } {
  const [m1, m2, m3] = bounds.months;
  let raw1 = 0;
  let raw2 = 0;
  let raw3 = 0;
  for (const r of runs) {
    const liability = Number(r.state_income_tax || 0);
    const m = parseYmdUtc(r.pay_date).getUTCMonth() + 1;
    if (m === m1) raw1 += liability;
    else if (m === m2) raw2 += liability;
    else if (m === m3) raw3 += liability;
  }
  return {
    month1: round2(raw1),
    month2: round2(raw2),
    month3: round2(raw3),
  };
}

function buildScheduleA(
  runs: PayrollRun[],
): Array<{ date: string; amount: number }> {
  const byDate = new Map<string, number>();
  for (const r of runs) {
    const existing = byDate.get(r.pay_date) ?? 0;
    byDate.set(r.pay_date, existing + Number(r.state_income_tax || 0));
  }
  return Array.from(byDate.entries())
    .map(([date, amount]) => ({ date, amount: round2(amount) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Small utilities ──────────────────────────────────────────────────────────

function sum<T>(items: T[], get: (t: T) => number): number {
  let total = 0;
  for (const i of items) total += get(i);
  return total;
}
