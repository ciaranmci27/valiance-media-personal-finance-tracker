// Form W-3 rollup aggregator. Pure. No IO.
//
// Sources
// -------
// SSA/IRS 2025 W-2/W-3 instructions. https://www.irs.gov/pub/irs-pdf/iw2w3.pdf
//
// Scope
// -----
// W-3 is the employer-side transmittal that accompanies paper W-2 filings
// with SSA. It sums the corresponding W-2 box values across all employees.
// SSA electronic filing via BSO uses EFW2 format instead, but W-3 is still
// produced as the paper equivalent / admin sanity check.

import { round2 } from "./rounding";
import type { FormW2Data, FormW3Data } from "@/types/payroll";

export interface AggregateFormW3Input {
  tax_year: number;
  /** W-2 aggregations produced by aggregateFormW2 for each employee. */
  w2s: FormW2Data[];
}

export interface AggregateFormW3Result {
  data: FormW3Data;
  warnings: string[];
}

export function aggregateFormW3(
  input: AggregateFormW3Input,
): AggregateFormW3Result {
  const warnings: string[] = [];
  const w2s = input.w2s.filter((w) => w.tax_year === input.tax_year);
  if (w2s.length !== input.w2s.length) {
    warnings.push(
      `Ignored ${input.w2s.length - w2s.length} W-2(s) from a different tax year.`,
    );
  }
  if (w2s.length === 0) {
    warnings.push(
      `No W-2s available for ${input.tax_year}. Generate the per-employee W-2s first.`,
    );
  }

  const box_12_d = w2s.reduce((acc, w) => {
    const d = (w.box_12 ?? []).find((c) => c.code === "D");
    return acc + (d?.amount ?? 0);
  }, 0);

  // Per-state rollup: merge each W-2's `states` array into a single map.
  // State-specific reconciliations (e.g., AZ A1-APR) read the state they
  // care about from this list rather than the cross-state flat totals.
  //
  // Pre-multi-state W-2s stored in the DB won't have `states`; we synthesize
  // a single-state entry from the flat box_15/16/17 fields so their totals
  // still flow into the per-state rollup. Admins can regenerate individual
  // W-2s to get the authoritative per-state breakdown from source runs.
  const stateMap = new Map<string, { wages: number; tax: number }>();
  let syntheticW2s = 0;
  for (const w of w2s) {
    const ws =
      w.states && w.states.length > 0
        ? w.states
        : w.box_15_state
          ? [
              {
                code: w.box_15_state,
                wages: w.box_16_state_wages,
                tax: w.box_17_state_income_tax,
              },
            ]
          : [];
    if ((!w.states || w.states.length === 0) && ws.length > 0) {
      syntheticW2s += 1;
    }
    for (const s of ws) {
      const existing = stateMap.get(s.code) ?? { wages: 0, tax: 0 };
      existing.wages += s.wages;
      existing.tax += s.tax;
      stateMap.set(s.code, existing);
    }
  }
  if (syntheticW2s > 0) {
    warnings.push(
      `${syntheticW2s} stored W-2(s) predate multi-state support; per-state totals were reconstructed from their single-state flat fields. Regenerate those W-2s for the authoritative per-state breakdown.`,
    );
  }
  const states = Array.from(stateMap.entries())
    .map(([code, v]) => ({
      code,
      wages: round2(v.wages),
      tax: round2(v.tax),
    }))
    .sort((a, b) =>
      b.wages === a.wages ? a.code.localeCompare(b.code) : b.wages - a.wages,
    );

  const data: FormW3Data = {
    tax_year: input.tax_year,
    w2_count: w2s.length,
    box_1_wages: round2(sum(w2s, (w) => w.box_1_wages)),
    box_2_federal_income_tax: round2(sum(w2s, (w) => w.box_2_federal_income_tax)),
    box_3_ss_wages: round2(sum(w2s, (w) => w.box_3_ss_wages)),
    box_4_ss_tax: round2(sum(w2s, (w) => w.box_4_ss_tax)),
    box_5_medicare_wages: round2(sum(w2s, (w) => w.box_5_medicare_wages)),
    box_6_medicare_tax: round2(sum(w2s, (w) => w.box_6_medicare_tax)),
    box_12_d_elective_deferrals: round2(box_12_d),
    box_16_state_wages: round2(sum(w2s, (w) => w.box_16_state_wages)),
    box_17_state_income_tax: round2(sum(w2s, (w) => w.box_17_state_income_tax)),
    states,
  };

  return { data, warnings };
}

function sum<T>(items: T[], get: (t: T) => number): number {
  let total = 0;
  for (const i of items) total += get(i);
  return total;
}
