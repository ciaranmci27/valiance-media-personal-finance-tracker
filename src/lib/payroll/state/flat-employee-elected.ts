// State tax calculator: "flat_employee_elected" - state imposes a flat income
// tax but employees elect a withholding rate from a menu (AZ Form A-4).
//
// AZ 2026 example:
//   actualTaxRate: 0.025 (Arizona's real flat income tax)
//   rates: [0.005, 0.010, 0.015, 0.020, 0.025, 0.030, 0.035]
//   defaultRate: 0.020 (applied when no A-4 is on file)
//
// Withholding = gross * employee-elected rate. The actualTaxRate is
// informational and is not used in paycheck withholding math - over-
// or under-withholding is reconciled on the state return.

import { round2 } from "../rounding";
import type {
  EmployeeStateElectionFlatEmployeeElected,
  StateConfigFlatEmployeeElected,
} from "@/types/payroll";

export interface FlatElectedIncomeTaxInput {
  grossThisPeriod: number;
  stateConfig: StateConfigFlatEmployeeElected;
  employeeElection?: EmployeeStateElectionFlatEmployeeElected;
}

export interface FlatElectedIncomeTaxResult {
  stateIncomeTax: number;
  /** Rate that was actually applied (elected, or default if none). */
  rateUsed: number;
  /** True when we fell back to the default rate because no election was on file. */
  usedDefault: boolean;
}

export function calculateFlatElectedIncomeTax(
  input: FlatElectedIncomeTaxInput,
): FlatElectedIncomeTaxResult {
  const elected = input.employeeElection?.rate;
  const hasElection = typeof elected === "number";
  const rateUsed = hasElection ? elected : input.stateConfig.defaultRate;

  const gross = Math.max(0, input.grossThisPeriod || 0);
  const base = gross * rateUsed;
  const extra = input.employeeElection?.extra_withholding ?? 0;

  return {
    stateIncomeTax: round2(base + extra),
    rateUsed,
    usedDefault: !hasElection,
  };
}
