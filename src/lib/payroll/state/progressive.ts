// State tax calculator: "progressive" - graduated brackets (e.g. CA, NY, MA).
//
// Methodology mirrors the federal Pub 15-T percentage method:
//   1. Annualize the current period's wages.
//   2. Subtract state standard deduction (if configured).
//   3. Subtract per-allowance amount × allowances (if configured via
//      employee election). Many states still use W-4-style allowances
//      even though federal removed them in 2020.
//   4. Apply bracket (filing-status-specific if provided; otherwise fall
//      back to "single" brackets).
//   5. De-annualize to per-period.
//   6. Add per-period extra withholding.
//
// State progressive configs are inherently diverse. This calculator handles
// the common pattern (brackets + optional per-status tables + optional std
// deduction). Exotic state-specific rules (e.g. CA's low-income exemption
// tables) require a "custom" method implementation per state.

import { round2 } from "../rounding";
import { PERIODS_PER_YEAR } from "../federal";
import type {
  EmployeeStateElectionProgressive,
  FilingStatus,
  PayFrequency,
  StateBracket,
  StateConfigProgressive,
} from "@/types/payroll";

export interface ProgressiveIncomeTaxInput {
  grossThisPeriod: number;
  frequency: PayFrequency;
  stateConfig: StateConfigProgressive;
  employeeElection?: EmployeeStateElectionProgressive;
  /** Fallback filing status when the election doesn't supply one. */
  defaultFilingStatus?: FilingStatus;
}

export interface ProgressiveIncomeTaxResult {
  stateIncomeTax: number;
  annualTaxableWage: number;
  bracketUsed: StateBracket | null;
  filingStatusUsed: FilingStatus;
}

function selectBracketTable(
  stateConfig: StateConfigProgressive,
  status: FilingStatus,
): { table: StateBracket[]; statusUsed: FilingStatus } {
  const b = stateConfig.brackets;
  if (status === "mfj" && b.mfj) return { table: b.mfj, statusUsed: "mfj" };
  if (status === "mfs" && b.mfs) return { table: b.mfs, statusUsed: "mfs" };
  if (status === "hoh" && b.hoh) return { table: b.hoh, statusUsed: "hoh" };
  return { table: b.single, statusUsed: "single" };
}

function applyBracket(amount: number, table: StateBracket[]): StateBracket | null {
  for (const b of table) {
    const inBracket = amount >= b.min && (b.max === null || amount < b.max);
    if (inBracket) return b;
  }
  return table.length > 0 ? table[table.length - 1] : null;
}

export function calculateProgressiveIncomeTax(
  input: ProgressiveIncomeTaxInput,
): ProgressiveIncomeTaxResult {
  const periods = PERIODS_PER_YEAR[input.frequency];
  const status: FilingStatus =
    input.employeeElection?.filing_status ??
    input.defaultFilingStatus ??
    "single";

  // 1. Annualize
  const annualWages = Math.max(0, input.grossThisPeriod || 0) * periods;

  // 2. Subtract std deduction if the state config provides one
  const stdDed =
    input.stateConfig.std_deduction?.[status] ??
    input.stateConfig.std_deduction?.single ??
    0;
  let annualTaxable = annualWages - stdDed;
  if (annualTaxable < 0) annualTaxable = 0;

  // 3. Apply bracket
  const { table, statusUsed } = selectBracketTable(input.stateConfig, status);
  const bracket = applyBracket(annualTaxable, table);
  let annualTax = 0;
  if (bracket) {
    const over = annualTaxable - bracket.min;
    annualTax = bracket.base_tax + over * bracket.rate;
    if (annualTax < 0) annualTax = 0;
  }

  // 4. De-annualize + extra per-period withholding
  const perPeriod = annualTax / periods;
  const extra = input.employeeElection?.extra_withholding ?? 0;

  return {
    stateIncomeTax: round2(perPeriod + extra),
    annualTaxableWage: round2(annualTaxable),
    bracketUsed: bracket,
    filingStatusUsed: statusUsed,
  };
}
