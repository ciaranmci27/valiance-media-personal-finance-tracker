// State withholding + employer tax dispatcher.
//
// Combines three independent calculations per run:
//   1. State income tax withholding (employee-side) - dispatched by
//      stateConfig.calculation_method.
//   2. State SUTA (State Unemployment Tax Act) - employer-side, capped at
//      the state's UI wage base.
//   3. State SDI (State Disability Insurance) - splits by state; some
//      states are employee-only (CA), some employer-only, some both.
//
// The dispatcher is the public surface; method-specific files handle only
// income tax math.

import { round2 } from "../rounding";
import { calculateNoneIncomeTax } from "./none";
import { calculateFlatIncomeTax } from "./flat";
import { calculateFlatElectedIncomeTax } from "./flat-employee-elected";
import { calculateProgressiveIncomeTax } from "./progressive";
import { calculateCustomIncomeTax } from "./custom";
import type {
  EmployeeStateElection,
  EmployeeStateElectionFlat,
  EmployeeStateElectionFlatEmployeeElected,
  EmployeeStateElectionProgressive,
  FilingStatus,
  PayFrequency,
  StateConfigFlat,
  StateConfigFlatEmployeeElected,
  StateConfigProgressive,
  StateSdiConfig,
  StateSutaConfig,
  StateTaxConfig,
} from "@/types/payroll";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StateCalcInput {
  /** Base used for state income tax (SIT). For pre-tax-aware callers this
   *  should equal gross - pre_tax_401k - pre_tax_125. */
  grossThisPeriod: number;
  frequency: PayFrequency;
  stateConfig: StateTaxConfig;
  employeeElection: EmployeeStateElection;
  /** Fallback filing status for progressive states (usually employee's W-4). */
  defaultFilingStatus?: FilingStatus;
  /** Cumulative gross wages paid before this run (for SUTA/SDI wage-base
   *  caps). Callers may pass an unadjusted gross; §125 deductions will
   *  slightly over-estimate the cumulative cap basis but the error is
   *  bounded by the per-state wage base (typically $7k-$180k). */
  grossYtd: number;
  /** Optional: base used for SUTA/SDI employment taxes. Most states follow
   *  federal: §125 deductions reduce these wages; 401(k) does not. When
   *  omitted, defaults to grossThisPeriod (pre-pre-tax behavior). */
  employmentBaseThisPeriod?: number;
  /** Optional: SUTA wages YTD pulled from aggregated prior runs. When
   *  omitted, derived from grossYtd (pre-change behavior). */
  sutaWagesYtdOverride?: number;
}

export interface StateCalcResult {
  /** Employee-side state income tax withholding. */
  stateIncomeTax: number;
  /** Employee-side state disability insurance withholding. */
  stateDisabilityEmployee: number;
  /** Employer-side state disability contribution. */
  stateDisabilityEmployer: number;
  /** Employer-side state unemployment tax. */
  suta: number;
  /** The portion of this run's wages subject to SUTA (after cap). */
  sutaTaxableThisPeriod: number;
  /** Calculation method dispatched. */
  methodUsed: StateTaxConfig["calculation_method"];
  /** True if calc fell back to defaults (e.g. no A-4 on file for AZ). */
  usedDefault: boolean;
  /** Any advisory message worth surfacing in the UI. */
  notice?: string;
}

// ─── Income tax dispatcher ────────────────────────────────────────────────────

function dispatchIncomeTax(input: StateCalcInput): { tax: number; usedDefault: boolean } {
  const { stateConfig, employeeElection, frequency, grossThisPeriod } = input;

  switch (stateConfig.calculation_method) {
    case "none": {
      const r = calculateNoneIncomeTax({ grossThisPeriod });
      return { tax: r.stateIncomeTax, usedDefault: false };
    }
    case "flat": {
      const r = calculateFlatIncomeTax({
        grossThisPeriod,
        stateConfig: stateConfig.config as StateConfigFlat,
        employeeElection: employeeElection as EmployeeStateElectionFlat,
      });
      return { tax: r.stateIncomeTax, usedDefault: false };
    }
    case "flat_employee_elected": {
      const r = calculateFlatElectedIncomeTax({
        grossThisPeriod,
        stateConfig: stateConfig.config as StateConfigFlatEmployeeElected,
        employeeElection:
          employeeElection as EmployeeStateElectionFlatEmployeeElected,
      });
      return { tax: r.stateIncomeTax, usedDefault: r.usedDefault };
    }
    case "progressive": {
      const r = calculateProgressiveIncomeTax({
        grossThisPeriod,
        frequency,
        stateConfig: stateConfig.config as StateConfigProgressive,
        employeeElection:
          employeeElection as EmployeeStateElectionProgressive,
        defaultFilingStatus: input.defaultFilingStatus,
      });
      return { tax: r.stateIncomeTax, usedDefault: false };
    }
    case "custom": {
      calculateCustomIncomeTax();
      // Unreachable - custom throws.
      return { tax: 0, usedDefault: false };
    }
  }
}

// ─── SUTA (employer-only) ─────────────────────────────────────────────────────

function calculateSuta(
  grossThisPeriod: number,
  grossYtd: number,
  config: StateSutaConfig | Record<string, never>,
  sutaWagesYtdOverride?: number,
): { suta: number; taxable: number } {
  const c = config as StateSutaConfig;
  // No wage base or rate configured -> no SUTA (treat as "not set").
  if (c.newEmployerRate == null || c.wageBase == null) {
    return { suta: 0, taxable: 0 };
  }
  // Prefer the pre-tax-aware aggregated YTD when the engine passes it;
  // fall back to deriving from grossYtd for callers that don't split
  // withholdings. `sutaWagesYtdOverride` is already post-§125-adjusted
  // but may exceed the wage base on later runs - clamp it here so the
  // remaining-room math never goes negative.
  const rawYtd =
    sutaWagesYtdOverride != null
      ? Math.max(0, sutaWagesYtdOverride)
      : Math.max(0, grossYtd);
  const sutaWagesYtd = Math.min(rawYtd, c.wageBase);
  const room = Math.max(0, c.wageBase - sutaWagesYtd);
  const taxable = Math.min(Math.max(0, grossThisPeriod), room);
  const suta = taxable * c.newEmployerRate;
  return { suta: round2(suta), taxable: round2(taxable) };
}

// ─── SDI (state disability insurance) ─────────────────────────────────────────

function calculateSdi(
  grossThisPeriod: number,
  grossYtd: number,
  config: StateSdiConfig | Record<string, never>,
): { employee: number; employer: number } {
  const c = config as StateSdiConfig;
  // Rate not set -> state has no SDI.
  if (c.rate == null || c.rate === 0) {
    return { employee: 0, employer: 0 };
  }

  // Apply wage base cap if provided; otherwise treat as uncapped.
  let taxable = Math.max(0, grossThisPeriod || 0);
  if (c.wage_base != null) {
    const sdiWagesYtd = Math.min(Math.max(0, grossYtd), c.wage_base);
    const room = Math.max(0, c.wage_base - sdiWagesYtd);
    taxable = Math.min(taxable, room);
  }

  const amount = taxable * c.rate;
  const side = c.side ?? "employee"; // Most SDI is employee-side by default.

  if (side === "employee") {
    return { employee: round2(amount), employer: 0 };
  }
  if (side === "employer") {
    return { employee: 0, employer: round2(amount) };
  }
  // "both" - each side pays the full rate (not split).
  return { employee: round2(amount), employer: round2(amount) };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function calculateState(input: StateCalcInput): StateCalcResult {
  const { tax, usedDefault } = dispatchIncomeTax(input);
  // SUTA/SDI use the employment-tax base (gross - §125), not the SIT base
  // which also subtracts 401(k). When no adjusted base is provided, fall
  // back to grossThisPeriod for backward compatibility.
  const employmentBase =
    input.employmentBaseThisPeriod != null
      ? Math.max(0, input.employmentBaseThisPeriod)
      : input.grossThisPeriod;
  const suta = calculateSuta(
    employmentBase,
    input.grossYtd,
    input.stateConfig.suta_config,
    input.sutaWagesYtdOverride,
  );
  const sdi = calculateSdi(
    employmentBase,
    input.grossYtd,
    input.stateConfig.sdi_config,
  );

  let notice: string | undefined;
  if (
    input.stateConfig.calculation_method === "flat_employee_elected" &&
    usedDefault
  ) {
    notice =
      "No A-4 election on file - default withholding rate applied. " +
      "Employee should submit A-4 to adjust.";
  }

  return {
    stateIncomeTax: tax,
    stateDisabilityEmployee: sdi.employee,
    stateDisabilityEmployer: sdi.employer,
    suta: suta.suta,
    sutaTaxableThisPeriod: suta.taxable,
    methodUsed: input.stateConfig.calculation_method,
    usedDefault,
    notice,
  };
}
