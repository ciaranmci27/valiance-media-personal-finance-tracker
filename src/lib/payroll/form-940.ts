// Form 940 annual FUTA aggregator. Pure. No IO.
//
// Sources
// -------
// IRS Form 940 (Employer's Annual Federal Unemployment Tax Return), 2025
// revision and instructions. https://www.irs.gov/pub/irs-pdf/f940.pdf and
// https://www.irs.gov/pub/irs-pdf/i940.pdf
//
// Scope
// -----
// Aggregates annual FUTA liability from a year's finalized/paid runs. Works
// off the per-run FUTA columns populated by the engine (futa_wages is the
// taxable base post-7k-cap, futa is the tax applied at the effective rate
// after the credit for timely state unemployment contributions).
//
// Line mapping
// ------------
// Line 3  - Total payments to all employees (gross wages, before any exempts)
// Line 4  - Payments exempt from FUTA (we surface a manual-override here;
//           there's no per-run exempt flag today so the aggregator emits 0)
// Line 5  - Total of payments made to each employee in excess of $7,000
// Line 7  - Total taxable FUTA wages (Line 3 - Line 4 - Line 5)
// Line 8  - FUTA tax before adjustments (Line 7 * 0.006)
// Line 12 - Total FUTA tax after adjustments (== Line 8 for non-credit-
//           -reduction states; AZ is not a credit-reduction state)
// Line 13 - FUTA deposits already paid (from payroll_tax_deposits)
// Line 14 - Balance due
// Line 15 - Overpayment
//
// Part 5 - Quarterly liability breakdown. IRS requires Part 5 only when FUTA
// liability exceeds $500 for the year; we always emit it for completeness.

import { round2 } from "./rounding";
import type {
  Form940Data,
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AggregateForm940Input {
  tax_year: number;
  /** Finalized/paid runs with pay_date in the tax year. */
  runs: PayrollRun[];
  /** federal_940 deposits for the tax year. Only paid count toward Line 13. */
  deposits: PayrollTaxDeposit[];
  /** Admin-entered total for Line 4 (payments exempt from FUTA, e.g.
   *  group-term life over $50K, dependent care over $5K, 401(k) employer
   *  match, certain fringe benefits). We do not classify per-run today, so
   *  the admin supplies the annual total in the UI. Defaults to 0. */
  exempt_override?: number;
}

export interface AggregateForm940Result {
  data: Form940Data;
  warnings: string[];
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

export function aggregateForm940(
  input: AggregateForm940Input,
): AggregateForm940Result {
  const warnings: string[] = [];
  const runs = input.runs.filter(
    (r) => r.pay_date.startsWith(String(input.tax_year)),
  );
  if (runs.length !== input.runs.length) {
    warnings.push(
      `Ignored ${input.runs.length - runs.length} run(s) whose pay date falls outside ${input.tax_year}.`,
    );
  }
  if (runs.length === 0) {
    warnings.push(
      `No approved or paid runs in ${input.tax_year}. A zero-activity 940 may be filed, but only if you had at least one employee at some point in the year.`,
    );
  }

  // Line 3: gross wages for the year.
  const line_3_total_payments = round2(
    sum(runs, (r) => Number(r.gross_pay || 0)),
  );

  // Line 4: exempt payments. We don't classify exempt categories (group-term
  // life, dependent care, etc.) per-run today, so admins enter the annual
  // total in the UI. The override is clamped to [0, Line 3] to keep Line 5
  // and Line 7 non-negative.
  const line_4_payments_exempt = round2(
    Math.min(
      Math.max(0, Number(input.exempt_override || 0)),
      line_3_total_payments,
    ),
  );

  // Line 5: per-employee excess over $7,000 FUTA wage base. The engine
  // already caps FUTA wages per run, so Line 5 = gross - futa_wages - exempt,
  // clamped to zero (an exempt_override greater than the excess would
  // otherwise produce a negative Line 5).
  const totalFutaWages = round2(sum(runs, (r) => Number(r.futa_wages || 0)));
  const line_5_payments_over_7000 = round2(
    Math.max(
      0,
      line_3_total_payments - line_4_payments_exempt - totalFutaWages,
    ),
  );

  // Line 7: taxable FUTA wages. Line 3 - Line 4 - Line 5, clamped to zero.
  // Prior behavior assumed exempt=0, so Line 7 == totalFutaWages. When the
  // admin enters an exempt override, Line 7 must reflect it: exempt payments
  // that were already capped-out against the $7,000 base contribute to Line 5
  // not Line 4, so subtracting Line 4 shrinks Line 7 (and Line 8) accordingly.
  const line_7_total_taxable = round2(
    Math.max(
      0,
      line_3_total_payments - line_4_payments_exempt - line_5_payments_over_7000,
    ),
  );

  // Line 8: pre-adjustment FUTA tax. We recompute from the taxable base at
  // the statutory 0.6% rate for cleanliness on the return.
  const line_8_futa_before_adjustments = round2(line_7_total_taxable * 0.006);

  // Line 12: final FUTA tax per IRS instructions = Line 8 + Line 11 (credit
  // reduction). No credit reductions for AZ yet, so Line 12 == Line 8. Using
  // the derived value (rather than the persisted per-run sum) means the
  // exempt_override on Line 4 actually reduces tax owed on the filed form.
  const line_12_futa_after_adjustments = line_8_futa_before_adjustments;

  // Sanity check: the sum of per-run FUTA (computed at runtime) should match
  // Line 12 within rounding. When it doesn't, the most likely causes are
  // exempt_override moving wages out of FUTA, a credit-reduction rate that
  // wasn't in effect at run time, or a config change between runs. Surface
  // the delta so admins can reconcile before filing.
  const totalPersistedFuta = round2(sum(runs, (r) => Number(r.futa || 0)));
  if (
    Math.abs(totalPersistedFuta - line_12_futa_after_adjustments) >
    Math.max(5, line_12_futa_after_adjustments * 0.02)
  ) {
    warnings.push(
      `Persisted FUTA across runs ($${totalPersistedFuta.toFixed(2)}) differs from Line 12 ($${line_12_futa_after_adjustments.toFixed(2)}). Likely caused by an exempt override or config change since the runs were finalized; reconcile before filing.`,
    );
  }

  // Part 5: quarterly liability. Distributes Line 12 across the four quarters
  // based on when FUTA liability was incurred (pay_date). IRS requires the
  // four quarters to sum to Line 12 exactly. Per-run persisted FUTA sums to
  // totalPersistedFuta, which may differ from Line 12 when an exempt_override
  // is in play - we plug the delta into the last nonzero quarter, mirroring
  // the fractions-of-cents pattern used on Form 941 Line 16B / Schedule B.
  const quarterly = buildQuarterlyLiability(
    runs,
    line_12_futa_after_adjustments,
  );

  // Post-condition: Part 5 must reconcile to Line 12 and cannot hold a
  // negative quarter (IRS won't accept it). Under normal use buildQuarterly
  // plugs the reconciliation into the last nonzero quarter, so these are
  // safety nets for regressions and unusual distributions.
  const sumQuarterly = round2(
    quarterly.q1 + quarterly.q2 + quarterly.q3 + quarterly.q4,
  );
  if (sumQuarterly !== line_12_futa_after_adjustments) {
    warnings.push(
      `Part 5 quarterly liability sums to $${sumQuarterly.toFixed(2)} but Line 12 is $${line_12_futa_after_adjustments.toFixed(2)}. Difference of $${(line_12_futa_after_adjustments - sumQuarterly).toFixed(2)} must be reconciled before filing.`,
    );
  }
  if (
    quarterly.q1 < 0 ||
    quarterly.q2 < 0 ||
    quarterly.q3 < 0 ||
    quarterly.q4 < 0
  ) {
    warnings.push(
      "One or more Part 5 quarterly liability cells went negative after reconciliation. Redistribute the adjustment across quarters before filing.",
    );
  }

  // Line 13: deposits.
  const paidFutaDeposits = input.deposits.filter(
    (d) =>
      d.deposit_type === "federal_940" &&
      d.status === "paid" &&
      d.period_end.startsWith(String(input.tax_year)),
  );
  const totalDeposited = round2(
    sum(paidFutaDeposits, (d) => Number(d.amount || 0)),
  );

  const line_14_balance_due = round2(
    Math.max(0, line_12_futa_after_adjustments - totalDeposited),
  );
  const line_15_overpayment = round2(
    Math.max(0, totalDeposited - line_12_futa_after_adjustments),
  );

  if (line_14_balance_due > 0) {
    warnings.push(
      `Balance due of $${line_14_balance_due.toFixed(2)} - either you have undeposited FUTA for this year, or 940 deposits are not yet marked as paid in the system.`,
    );
  }

  const data: Form940Data = {
    tax_year: input.tax_year,
    line_3_total_payments,
    line_4_payments_exempt,
    line_5_payments_over_7000,
    line_7_total_taxable,
    line_8_futa_before_adjustments,
    line_12_futa_after_adjustments,
    line_14_balance_due,
    line_15_overpayment,
    quarterly_liability: quarterly,
  };

  return { data, warnings };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildQuarterlyLiability(
  runs: PayrollRun[],
  line12: number,
): { q1: number; q2: number; q3: number; q4: number } {
  const raw = { q1: 0, q2: 0, q3: 0, q4: 0 };
  for (const r of runs) {
    const m = Number(r.pay_date.slice(5, 7));
    const futa = Number(r.futa || 0);
    if (m <= 3) raw.q1 += futa;
    else if (m <= 6) raw.q2 += futa;
    else if (m <= 9) raw.q3 += futa;
    else raw.q4 += futa;
  }
  const q = {
    q1: round2(raw.q1),
    q2: round2(raw.q2),
    q3: round2(raw.q3),
    q4: round2(raw.q4),
  };

  // Plug the delta (line12 - sum) into the last nonzero quarter so Part 5
  // ties to Line 12 exactly. When no quarter has liability but line12 > 0
  // (exempt override pushed zero-activity runs into positive tax - pathological
  // but possible), land the reconciliation in Q4.
  const rawSum = round2(q.q1 + q.q2 + q.q3 + q.q4);
  const reconcile = round2(line12 - rawSum);
  if (reconcile === 0) return q;

  const keys: Array<keyof typeof q> = ["q4", "q3", "q2", "q1"];
  const target = keys.find((k) => q[k] !== 0) ?? "q4";
  q[target] = round2(q[target] + reconcile);
  return q;
}

function sum<T>(items: T[], get: (t: T) => number): number {
  let total = 0;
  for (const i of items) total += get(i);
  return total;
}
