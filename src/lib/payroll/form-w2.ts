// Form W-2 per-employee aggregator. Pure. No IO.
//
// Sources
// -------
// SSA/IRS 2025 W-2 instructions. https://www.irs.gov/pub/irs-pdf/iw2w3.pdf
//
// Scope
// -----
// Aggregates a single employee's year of runs into the box values that go on
// the W-2 (and on the SSA EFW2 electronic filing format). Shape:
//
//   Box 1  - Wages, tips, other compensation
//            Gross - pre-tax 401(k) (Box 12D) - pre-tax §125 (Box 14)
//   Box 2  - Federal income tax withheld
//   Box 3  - Social Security wages  (persisted on the run, post-§125)
//   Box 4  - Social Security tax withheld
//   Box 5  - Medicare wages and tips (persisted on the run, post-§125)
//   Box 6  - Medicare tax withheld (includes Additional Medicare 0.9%)
//   Box 12 - D for 401(k) elective deferrals (other codes manual)
//   Box 14 - Section 125 cafeteria plan total (optional, informational)
//   Box 15-17 - State, state wages, state income tax — per state
//
// Box 15/16/17 per-state grouping
// -------------------------------
// IRS prints two state rows on a paper W-2; a third requires a supplemental
// copy. We emit `states[]` with one entry per distinct state the employee
// worked in during the year. The per-run state is read from
// `employee_snapshot.state_code` (immutable at finalize time) so an employee
// who relocates mid-year gets wages split between old and new states.
//
// Box 16 = state_taxable_wages (persisted per run as of the
// 20260419_payroll_runs_state_taxable_wages migration). For runs finalized
// before that migration, state_taxable_wages is zero; we fall back to the
// run's per-run contribution to Box 1 (gross - pre-tax 401(k) - pre-tax §125)
// and surface a warning so the admin knows the value is a best-effort
// reconstruction. This matches IRS guidance for conforming states like AZ.

import { splitWithholdings } from "./withholdings";
import { round2 } from "./rounding";
import type {
  FormW2Data,
  PayrollEmployee,
  PayrollRun,
} from "@/types/payroll";

export interface AggregateFormW2Input {
  tax_year: number;
  /** Finalized/paid runs for this employee with pay_date in the tax year. */
  runs: PayrollRun[];
  /** Employee row (live or snapshot). Used for name + SSN last 4. */
  employee: PayrollEmployee;
}

export interface AggregateFormW2Result {
  data: FormW2Data;
  warnings: string[];
}

export function aggregateFormW2(
  input: AggregateFormW2Input,
): AggregateFormW2Result {
  const warnings: string[] = [];
  const yearStr = String(input.tax_year);
  const runs = input.runs.filter((r) => r.pay_date.startsWith(yearStr));
  if (runs.length !== input.runs.length) {
    warnings.push(
      `Ignored ${input.runs.length - runs.length} run(s) outside ${input.tax_year}.`,
    );
  }
  if (runs.length === 0) {
    warnings.push(
      `No approved or paid runs for this employee in ${input.tax_year}. A W-2 is only required if the employee received wages.`,
    );
  }

  // Pre-tax splits across the year.
  let preTax401k = 0;
  let preTax125 = 0;
  for (const r of runs) {
    const split = splitWithholdings(r.other_withholdings);
    preTax401k += split.preTax401k;
    preTax125 += split.preTax125;
  }
  preTax401k = round2(preTax401k);
  preTax125 = round2(preTax125);

  const gross = round2(sum(runs, (r) => Number(r.gross_pay || 0)));
  // Box 1 = gross - pre-tax 401(k) - pre-tax §125. Box 1 also excludes any
  // other employer-sponsored tax-favored reductions; we do not track those
  // separately yet, so the admin must adjust in UI if applicable.
  const box_1_wages = round2(gross - preTax401k - preTax125);
  const box_2_federal_income_tax = round2(
    sum(runs, (r) => Number(r.federal_income_tax || 0)),
  );
  const box_3_ss_wages = round2(
    sum(runs, (r) => Number(r.social_security_wages || 0)),
  );
  const box_4_ss_tax = round2(
    sum(runs, (r) => Number(r.social_security_employee || 0)),
  );
  const box_5_medicare_wages = round2(
    sum(runs, (r) => Number(r.medicare_wages || 0)),
  );
  // Box 6 includes both the base 1.45% Medicare and the 0.9% additional
  // Medicare withholding. Employer-side Medicare is NOT reported on W-2.
  const box_6_medicare_tax = round2(
    sum(
      runs,
      (r) =>
        Number(r.medicare_employee || 0) + Number(r.additional_medicare || 0),
    ),
  );

  const box_12: Array<{ code: string; amount: number }> = [];
  if (preTax401k > 0) {
    box_12.push({ code: "D", amount: preTax401k });
  }

  // ── State grouping (Box 15/16/17) ──────────────────────────────────────
  // Group runs by employee_snapshot.state_code (falls back to the live
  // employee row when the snapshot is missing, e.g. pre-migration runs).
  // Each state gets one entry in `states` with aggregated wages + tax.
  const stateBuckets = new Map<
    string,
    { wages: number; tax: number; preMigrationFallback: boolean }
  >();
  let missingStateRuns = 0;
  let fallbackRuns = 0;
  for (const r of runs) {
    const stateCode = resolveRunState(r, input.employee);
    if (!stateCode) {
      missingStateRuns += 1;
      continue;
    }
    const persistedStateWages = Number(r.state_taxable_wages || 0);
    // Pre-migration runs store 0. Reconstruct per-run contribution to Box 1
    // as the best-effort state taxable wage for conforming states (AZ).
    let runStateWages = persistedStateWages;
    let usedFallback = false;
    if (persistedStateWages === 0 && Number(r.gross_pay || 0) > 0) {
      const split = splitWithholdings(r.other_withholdings);
      runStateWages = Math.max(
        0,
        Number(r.gross_pay || 0) - split.preTax401k - split.preTax125,
      );
      if (runStateWages > 0) {
        usedFallback = true;
        fallbackRuns += 1;
      }
    }
    const bucket = stateBuckets.get(stateCode) ?? {
      wages: 0,
      tax: 0,
      preMigrationFallback: false,
    };
    bucket.wages += runStateWages;
    bucket.tax += Number(r.state_income_tax || 0);
    if (usedFallback) bucket.preMigrationFallback = true;
    stateBuckets.set(stateCode, bucket);
  }

  const states = Array.from(stateBuckets.entries())
    .map(([code, b]) => ({
      code,
      wages: round2(b.wages),
      tax: round2(b.tax),
      preMigrationFallback: b.preMigrationFallback,
    }))
    // Stable order: descending wages, then state code for determinism.
    .sort((a, b) =>
      b.wages === a.wages ? a.code.localeCompare(b.code) : b.wages - a.wages,
    );

  if (missingStateRuns > 0) {
    warnings.push(
      `${missingStateRuns} run(s) have no state code on the employee snapshot; Box 15/16/17 may be incomplete.`,
    );
  }
  if (fallbackRuns > 0) {
    warnings.push(
      `${fallbackRuns} run(s) were finalized before the state_taxable_wages column existed; Box 16 falls back to per-run Box 1 (correct for AZ and other federal-conforming states).`,
    );
  }
  if (states.length > 2) {
    warnings.push(
      `Employee worked in ${states.length} states during ${input.tax_year}. IRS W-2 fits two state rows; split across multiple W-2 forms when filing.`,
    );
  }

  // Flat box_15/16/17 preserve the prior single-W-2-aggregate shape used by
  // Form W-3 rollups and the single-state UI. For multi-state, Box 16/17 are
  // the grand totals across states; box_15_state is the primary (highest-
  // wages) state, with the full per-state detail on `states`.
  const primaryState = states[0]?.code ?? input.employee.state_code ?? "";
  const totalStateWages = round2(sum(states, (s) => s.wages));
  const totalStateTax = round2(sum(states, (s) => s.tax));

  const ssn = input.employee.ssn_encrypted;
  // SSN last 4 is not derivable from the encrypted blob here (we would need
  // the decrypt routine which requires the server env). Leave undefined; the
  // viewer/action layer can populate after calling the encryption service.
  const employee_ssn_last4 = undefined;

  const data: FormW2Data = {
    tax_year: input.tax_year,
    employee_id: input.employee.id,
    employee_name:
      `${input.employee.first_name} ${input.employee.last_name}`.trim(),
    ...(employee_ssn_last4 ? { employee_ssn_last4 } : {}),
    box_1_wages,
    box_2_federal_income_tax,
    box_3_ss_wages,
    box_4_ss_tax,
    box_5_medicare_wages,
    box_6_medicare_tax,
    ...(box_12.length > 0 ? { box_12 } : {}),
    ...(preTax125 > 0 ? { box_14_section_125: preTax125 } : {}),
    box_15_state: primaryState,
    box_16_state_wages: totalStateWages,
    box_17_state_income_tax: totalStateTax,
    states: states.map(({ code, wages, tax }) => ({ code, wages, tax })),
  };

  // Sanity checks.
  if (box_3_ss_wages === 0 && runs.some((r) => Number(r.social_security_employee || 0) > 0)) {
    warnings.push(
      "Social Security wages (Box 3) are zero despite SS tax being withheld. Recalculate and re-approve pre-wage-base-migration runs.",
    );
  }
  if (ssn == null) {
    warnings.push(
      "Employee has no stored SSN. Add one before filing W-2 with SSA.",
    );
  }

  return { data, warnings };
}

/** Resolve the state this run was processed under. The snapshot is the
 *  authoritative source (immutable at finalize); fall back to the live
 *  employee row when a run predates snapshotting or has a malformed blob. */
function resolveRunState(
  run: PayrollRun,
  employee: PayrollEmployee,
): string | null {
  const snap = run.employee_snapshot as
    | { state_code?: unknown }
    | null
    | undefined;
  const snapState =
    snap && typeof snap === "object" && typeof snap.state_code === "string"
      ? snap.state_code.trim()
      : "";
  if (snapState) return snapState;
  const liveState = (employee.state_code || "").trim();
  return liveState || null;
}

function sum<T>(items: T[], get: (t: T) => number): number {
  let total = 0;
  for (const i of items) total += get(i);
  return total;
}
