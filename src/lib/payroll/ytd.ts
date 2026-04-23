// Year-to-date aggregator.
//
// Pure aggregation: takes an array of prior runs (caller filters) and returns
// cumulative totals. Used during calculation to enforce:
//   - Social Security wage-base cap (e.g. $184,500 for 2026)
//   - Additional Medicare 0.9% threshold ($200,000 on employee side)
//   - FUTA $7,000 per-employee cap
//
// IMPORTANT: SS taxable wages are derived from gross, not stored. For a
// salaried employee at a single employer, SS wages == min(gross, ss_wage_base).
// Medicare wages == gross (no cap). The aggregator tracks *gross* YTD and
// the caller applies the per-run caps.
//
// Which runs to include:
//   - status in ('finalized', 'paid') - draft runs don't count against caps
//   - voided runs do NOT count; corrections (reverses_run_id) are negative
//     offsets that naturally net out when summed with the originals
//   - pay_date within the target tax year (1/1 - 12/31)
//   - pay_date strictly BEFORE the current run's pay_date
//
// The caller is responsible for passing runs that match these filters;
// this module is pure TS and does no DB I/O.

import { round2 } from "./rounding";
import { splitWithholdings } from "./withholdings";
import type { PayrollRun } from "@/types/payroll";

export interface YtdTotals {
  /** Count of contributing runs (for sanity checks / UI). */
  runCount: number;
  /** Sum of gross_pay. */
  grossYtd: number;
  /** Sum of federal_income_tax. */
  federalIncomeTaxYtd: number;
  /** Sum of state_income_tax. */
  stateIncomeTaxYtd: number;
  /** Sum of social_security_employee (employee-side only). */
  socialSecurityEmployeeYtd: number;
  /** Sum of medicare_employee. */
  medicareEmployeeYtd: number;
  /** Sum of additional_medicare (employee-side 0.9%). */
  additionalMedicareYtd: number;
  /** Sum of state_disability_employee. */
  stateDisabilityEmployeeYtd: number;
  /** Sum of social_security_employer. */
  socialSecurityEmployerYtd: number;
  /** Sum of medicare_employer. */
  medicareEmployerYtd: number;
  /** Sum of futa. */
  futaYtd: number;
  /** Sum of suta. */
  sutaYtd: number;
  /** Sum of state_disability_employer. */
  stateDisabilityEmployerYtd: number;
  /** Sum of net_pay. */
  netPayYtd: number;
  /** Sum of social_security_wages - post-cap, post-pre-tax-§125 adjustment. */
  ssWagesYtd: number;
  /** Sum of medicare_wages - post-pre-tax-§125 adjustment. */
  medicareWagesYtd: number;
  /** Sum of additional_medicare_wages - portion over the $200k threshold. */
  additionalMedicareWagesYtd: number;
  /** Sum of futa_wages - post-cap, post-pre-tax-§125 adjustment. */
  futaWagesYtd: number;
  /** Sum of suta_wages - post-cap, post-pre-tax-§125 adjustment. */
  sutaWagesYtd: number;
  /** Sum of pre-tax 401(k)/403(b)/457 contributions pulled from
   *  other_withholdings. Useful for annual-limit monitoring. */
  preTax401kYtd: number;
  /** Sum of pre-tax §125 contributions (health, HSA via cafeteria, FSA). */
  preTax125Ytd: number;
}

export const ZERO_YTD: YtdTotals = {
  runCount: 0,
  grossYtd: 0,
  federalIncomeTaxYtd: 0,
  stateIncomeTaxYtd: 0,
  socialSecurityEmployeeYtd: 0,
  medicareEmployeeYtd: 0,
  additionalMedicareYtd: 0,
  stateDisabilityEmployeeYtd: 0,
  socialSecurityEmployerYtd: 0,
  medicareEmployerYtd: 0,
  futaYtd: 0,
  sutaYtd: 0,
  stateDisabilityEmployerYtd: 0,
  netPayYtd: 0,
  ssWagesYtd: 0,
  medicareWagesYtd: 0,
  additionalMedicareWagesYtd: 0,
  futaWagesYtd: 0,
  sutaWagesYtd: 0,
  preTax401kYtd: 0,
  preTax125Ytd: 0,
};

/**
 * Aggregate an array of runs into YtdTotals.
 *
 * Numeric fields are summed and round2()-normalized. Caller is responsible
 * for filtering by employee, year, and status.
 */
export function aggregateYtd(runs: PayrollRun[]): YtdTotals {
  const t: YtdTotals = { ...ZERO_YTD };

  for (const r of runs) {
    t.runCount += 1;
    t.grossYtd += Number(r.gross_pay) || 0;
    t.federalIncomeTaxYtd += Number(r.federal_income_tax) || 0;
    t.stateIncomeTaxYtd += Number(r.state_income_tax) || 0;
    t.socialSecurityEmployeeYtd += Number(r.social_security_employee) || 0;
    t.medicareEmployeeYtd += Number(r.medicare_employee) || 0;
    t.additionalMedicareYtd += Number(r.additional_medicare) || 0;
    t.stateDisabilityEmployeeYtd += Number(r.state_disability_employee) || 0;
    t.socialSecurityEmployerYtd += Number(r.social_security_employer) || 0;
    t.medicareEmployerYtd += Number(r.medicare_employer) || 0;
    t.futaYtd += Number(r.futa) || 0;
    t.sutaYtd += Number(r.suta) || 0;
    t.stateDisabilityEmployerYtd += Number(r.state_disability_employer) || 0;
    t.netPayYtd += Number(r.net_pay) || 0;

    // Taxable-wage bases. Stored per-run on finalize; aggregate directly so
    // pre-tax deductions applied in prior runs are honored by downstream
    // cap logic (SS wage base, FUTA base, etc.). For runs finalized before
    // pre-tax support existed, these columns equal the capped gross, which
    // is the same number the old derive-from-grossYtd path produced.
    t.ssWagesYtd += Number(r.social_security_wages) || 0;
    t.medicareWagesYtd += Number(r.medicare_wages) || 0;
    t.additionalMedicareWagesYtd += Number(r.additional_medicare_wages) || 0;
    t.futaWagesYtd += Number(r.futa_wages) || 0;
    t.sutaWagesYtd += Number(r.suta_wages) || 0;

    // Pre-tax contribution tracking is not stored in its own column; we
    // reconstruct it from the persisted other_withholdings JSONB. Legacy
    // items (no `category`) are treated as post_tax by splitWithholdings.
    const split = splitWithholdings(r.other_withholdings);
    t.preTax401kYtd += split.preTax401k;
    t.preTax125Ytd += split.preTax125;
  }

  // Normalize any floating-point drift introduced by summation.
  t.grossYtd = round2(t.grossYtd);
  t.federalIncomeTaxYtd = round2(t.federalIncomeTaxYtd);
  t.stateIncomeTaxYtd = round2(t.stateIncomeTaxYtd);
  t.socialSecurityEmployeeYtd = round2(t.socialSecurityEmployeeYtd);
  t.medicareEmployeeYtd = round2(t.medicareEmployeeYtd);
  t.additionalMedicareYtd = round2(t.additionalMedicareYtd);
  t.stateDisabilityEmployeeYtd = round2(t.stateDisabilityEmployeeYtd);
  t.socialSecurityEmployerYtd = round2(t.socialSecurityEmployerYtd);
  t.medicareEmployerYtd = round2(t.medicareEmployerYtd);
  t.futaYtd = round2(t.futaYtd);
  t.sutaYtd = round2(t.sutaYtd);
  t.stateDisabilityEmployerYtd = round2(t.stateDisabilityEmployerYtd);
  t.netPayYtd = round2(t.netPayYtd);
  t.ssWagesYtd = round2(t.ssWagesYtd);
  t.medicareWagesYtd = round2(t.medicareWagesYtd);
  t.additionalMedicareWagesYtd = round2(t.additionalMedicareWagesYtd);
  t.futaWagesYtd = round2(t.futaWagesYtd);
  t.sutaWagesYtd = round2(t.sutaWagesYtd);
  t.preTax401kYtd = round2(t.preTax401kYtd);
  t.preTax125Ytd = round2(t.preTax125Ytd);

  return t;
}

/** Predicate: does this run count toward YTD (finalized or paid, not deleted, not voided)? */
export function isYtdContributingRun(run: PayrollRun): boolean {
  if (run.deleted_at) return false;
  return run.status === "finalized" || run.status === "paid";
}

/**
 * Given a run's pay_date string, return true if it belongs to tax year `year`
 * AND falls strictly before `cutoff` (exclusive). Cutoff null means "any time
 * in that year".
 *
 * The pay date (not the period end) determines the tax year the wages are
 * reported in - this matches IRS rules (wages are taxed in the year paid,
 * not the year earned).
 */
export function isInTaxYearBefore(
  payDate: string,
  year: number,
  cutoff?: string | null,
): boolean {
  const [y] = payDate.split("-").map(Number);
  if (y !== year) return false;
  if (!cutoff) return true;
  return payDate < cutoff;
}

/**
 * Convenience: filter + aggregate in one pass. Caller passes all of an
 * employee's runs for the year; this returns totals for contributors with
 * pay_date < cutoff.
 */
export function computeYtdThrough(
  runs: PayrollRun[],
  taxYear: number,
  cutoffPayDate?: string | null,
): YtdTotals {
  const filtered = runs.filter(
    (r) =>
      isYtdContributingRun(r) &&
      isInTaxYearBefore(r.pay_date, taxYear, cutoffPayDate),
  );
  return aggregateYtd(filtered);
}
