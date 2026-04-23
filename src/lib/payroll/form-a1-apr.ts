// Arizona Form A1-APR annual payment / reconciliation aggregator. Pure. No IO.
//
// Sources
// -------
// AZ Department of Revenue Form A1-APR (Arizona Annual Payment Withholding
// Tax Return), 2025 revision and instructions.
//
// Scope
// -----
// Reconciles the four A1-QRT returns with the actual annual Arizona
// withholding (as reported on W-2 Box 17). Surfaces any under/over-reporting
// for admin review before filing.
//
// This aggregator is purely a rollup of already-aggregated values:
//   - Four FormA1QrtData inputs (one per quarter)
//   - The aggregated FormW3Data for the year (provides total AZ Box 17)

import { round2 } from "./rounding";
import type {
  FormA1AprData,
  FormA1QrtData,
  FormW3Data,
} from "@/types/payroll";

export interface AggregateFormA1AprInput {
  tax_year: number;
  quarters: {
    q1?: FormA1QrtData;
    q2?: FormA1QrtData;
    q3?: FormA1QrtData;
    q4?: FormA1QrtData;
  };
  /** W-3 rollup for the year; provides the total AZ Box 17 ground truth. */
  w3?: FormW3Data;
  /** Count of W-2s to attach / electronically file with the APR. */
  w2_count: number;
  /** Distinct employee count paid at any time during the year. */
  total_employees: number;
}

export interface AggregateFormA1AprResult {
  data: FormA1AprData;
  warnings: string[];
}

export function aggregateFormA1Apr(
  input: AggregateFormA1AprInput,
): AggregateFormA1AprResult {
  const warnings: string[] = [];
  const quarters = input.quarters;

  for (const q of [1, 2, 3, 4] as const) {
    const key = `q${q}` as const;
    const stored = quarters[key];
    if (!stored) {
      warnings.push(
        `Q${q} A1-QRT has not been generated for ${input.tax_year}. The APR reconciliation is incomplete until all four quarters exist.`,
      );
    } else if (stored.tax_year !== input.tax_year) {
      warnings.push(
        `Q${q} A1-QRT tax year does not match ${input.tax_year}; skipping it in the rollup.`,
      );
    }
  }

  const quarterly = {
    q1: quarterSummary(quarters.q1),
    q2: quarterSummary(quarters.q2),
    q3: quarterSummary(quarters.q3),
    q4: quarterSummary(quarters.q4),
  };

  const total_az_wages = round2(
    quarterly.q1.wages +
      quarterly.q2.wages +
      quarterly.q3.wages +
      quarterly.q4.wages,
  );
  const a1_qrt_line_a_sum = round2(
    quarterly.q1.reported +
      quarterly.q2.reported +
      quarterly.q3.reported +
      quarterly.q4.reported,
  );
  const a1_qrt_line_b_sum = round2(
    quarterly.q1.deposited +
      quarterly.q2.deposited +
      quarterly.q3.deposited +
      quarterly.q4.deposited,
  );

  // Ground truth: W-2 Box 17 filtered to AZ. Resolution order:
  //   1. W-3 per-state breakdown with AZ present → use that AZ tax.
  //   2. W-3 per-state breakdown without AZ → AZ withheld is 0 (the W-3
  //      authoritatively reports no AZ activity, don't fall back to flat).
  //   3. W-3 present but no per-state breakdown (pre-multi-state data) →
  //      trust the flat box_17 total, which is correct when every employee
  //      was AZ-only.
  //   4. No W-3 at all → reconcile against the quarterly Line A sum.
  let total_az_withheld: number;
  if (input.w3) {
    if (input.w3.states && input.w3.states.length > 0) {
      total_az_withheld = round2(
        input.w3.states.find((s) => s.code === "AZ")?.tax ?? 0,
      );
    } else {
      total_az_withheld = round2(input.w3.box_17_state_income_tax);
    }
  } else {
    total_az_withheld = round2(a1_qrt_line_a_sum);
  }

  const adjustment = round2(total_az_withheld - a1_qrt_line_a_sum);

  if (Math.abs(adjustment) > 0.5) {
    warnings.push(
      `W-2 Box 17 total ($${total_az_withheld.toFixed(2)}) differs from the sum of A1-QRT Line A ($${a1_qrt_line_a_sum.toFixed(2)}) by $${Math.abs(adjustment).toFixed(2)}. Adjust quarterly returns before filing the APR if this is not a rounding difference.`,
    );
  }

  const data: FormA1AprData = {
    tax_year: input.tax_year,
    total_az_wages,
    total_az_withheld,
    a1_qrt_line_a_sum,
    a1_qrt_line_b_sum,
    adjustment,
    quarterly,
    w2_count: input.w2_count,
    total_employees: input.total_employees,
  };

  return { data, warnings };
}

function quarterSummary(q?: FormA1QrtData): {
  wages: number;
  withheld: number;
  reported: number;
  deposited: number;
} {
  if (!q) return { wages: 0, withheld: 0, reported: 0, deposited: 0 };
  return {
    wages: q.total_az_wages,
    // "withheld" and "reported" are the same value on a stand-alone A1-QRT;
    // the APR keeps both columns to catch drift if the quarterly was edited
    // separately from the raw tax calc.
    withheld: q.line_a_az_tax_withheld,
    reported: q.line_a_az_tax_withheld,
    deposited: q.line_b_az_tax_paid,
  };
}
