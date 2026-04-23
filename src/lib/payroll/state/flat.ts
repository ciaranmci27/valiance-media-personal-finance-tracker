// State tax calculator: "flat" - single flat-rate state (e.g. NC, PA, MI).
// Withholding = gross × rate + employee-elected extra.
//
// If the employee has elected an override rate (unusual for flat states),
// we honor it; otherwise we use the state's configured rate.

import { round2 } from "../rounding";
import type {
  EmployeeStateElectionFlat,
  StateConfigFlat,
} from "@/types/payroll";

export interface FlatIncomeTaxInput {
  grossThisPeriod: number;
  stateConfig: StateConfigFlat;
  /** Employee override (rare for flat states). */
  employeeElection?: EmployeeStateElectionFlat;
}

export interface FlatIncomeTaxResult {
  stateIncomeTax: number;
  rateUsed: number;
}

export function calculateFlatIncomeTax(
  input: FlatIncomeTaxInput,
): FlatIncomeTaxResult {
  const rateUsed =
    typeof input.employeeElection?.rate === "number"
      ? input.employeeElection.rate
      : input.stateConfig.rate;

  const gross = Math.max(0, input.grossThisPeriod || 0);
  const base = gross * rateUsed;
  const extra = input.employeeElection?.extra_withholding ?? 0;

  return {
    stateIncomeTax: round2(base + extra),
    rateUsed,
  };
}
