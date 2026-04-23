// Payroll calculation engine - the single public entry point for producing
// the numbers that populate a payroll_runs row.
//
// Flow:
//   1. Resolve base period amount (pay_amount or supplementalAmount).
//   2. Prorate if hire/termination falls inside the pay period.
//   3. Split other_withholdings into pre-tax 401(k), pre-tax §125, post-tax.
//   4. Compute adjusted taxable-wage bases per tax type.
//   5. Compute federal income tax (Pub 15-T for regular, 22%/37% flat for
//      off-cycle supplemental) on FIT base.
//   6. Compute FICA (SS + Medicare + Additional Medicare 0.9%) on FICA base.
//   7. Compute FUTA on FICA base.
//   8. Compute state taxes on SIT base (income tax) and employment base
//      (SUTA/SDI).
//   9. Produce net_pay = gross - all taxes - all withholdings (pre + post).
//
// Pre-tax handling:
//   pre_tax_401k: reduces FIT + SIT wages only.
//   pre_tax_125:  reduces FIT + SIT + FICA + FUTA + SUTA + SDI wages.
//   post_tax:     reduces net pay only (no tax base impact).
//   Missing category: treated as post_tax (legacy behavior).
//
// Annual-limit enforcement (e.g. 401(k) $23,500 for 2026) is not yet
// implemented; the engine emits a notice when preTax401kYtd passes a
// conservative threshold so admins can manually adjust.

import { round2 } from "./rounding";
import {
  calculateFederalIncomeTax,
  calculateFica,
  calculateFuta,
  FUTA_PLAUSIBLE_NET_CEILING,
  type W4Inputs,
} from "./federal";
import {
  federalBracketsSchema,
  ficaConfigSchema,
  formatZodError,
  futaConfigSchema,
  parseStateConfigByMethod,
  stateSdiConfigSchema,
  stateSutaConfigSchema,
  stdDeductionsSchema,
  type StateCalculationMethod,
} from "./schemas";
import { calculateState } from "./state";
import { calculateSupplementalFederal } from "./supplemental";
import { prorate } from "./proration";
import { splitWithholdings } from "./withholdings";
import type { YtdTotals } from "./ytd";
import type {
  FederalTaxConfig,
  PayrollEmployee,
  RunType,
  StateTaxConfig,
  WithholdingLineItem,
} from "@/types/payroll";

// ─── Input / output ───────────────────────────────────────────────────────────

export interface CalculateRunInput {
  employee: PayrollEmployee;
  federalConfig: FederalTaxConfig;
  stateConfig: StateTaxConfig;
  period: {
    period_start: string;
    period_end: string;
    pay_date: string;
  };
  /** YTD totals BEFORE this run (contributors only - finalized/paid). */
  ytd: YtdTotals;
  /** Pre-filter of contributing runs so far in year, used to derive caps. */
  runType: RunType;
  /** Off-cycle / supplemental gross. Ignored for regular runs. */
  supplementalAmount?: number;
  /** Cumulative supplemental wages YTD (for the $1M flat-vs-37% threshold).
   *  Required for off_cycle runs. */
  supplementalYtd?: number;
  /** Extra post-tax deductions (garnishments, insurance, etc.). */
  otherWithholdings?: WithholdingLineItem[];
  /** Freeze the period gross at this value and skip pay_amount /
   *  supplementalAmount resolution AND proration. Taxes are then recomputed
   *  against this fixed gross using the given ytd and configs.
   *
   *  Used by finalize (and recalc of an existing draft when no new base is
   *  supplied) to preserve the gross the admin already reviewed while
   *  refreshing tax lines with current configs. Without this escape hatch,
   *  finalize would double-prorate a mid-period hire/termination because the
   *  stored gross_pay is already post-proration. */
  grossOverride?: number;
}

export interface CalculatedRun {
  // Gross + employee withholdings
  gross_pay: number;
  federal_income_tax: number;
  state_income_tax: number;
  social_security_employee: number;
  medicare_employee: number;
  additional_medicare: number;
  state_disability_employee: number;
  other_withholdings: WithholdingLineItem[];
  net_pay: number;

  // Employer liabilities
  social_security_employer: number;
  medicare_employer: number;
  futa: number;
  suta: number;
  state_disability_employer: number;

  // Audit / debug metadata (not persisted directly; useful for preview UI)
  meta: {
    baseAmount: number;
    wasProrated: boolean;
    daysWorked: number;
    daysInPeriod: number;
    ssTaxableThisPeriod: number;
    medicareTaxableThisPeriod: number;
    additionalMedicareWagesThisPeriod: number;
    futaTaxableThisPeriod: number;
    sutaTaxableThisPeriod: number;
    /** Wages subject to state income tax this period. Matches the base fed
     *  into `calculateState` (fitBase for conforming states like AZ). Persisted
     *  to `payroll_runs.state_taxable_wages` for W-2 Box 16 aggregation. */
    stateTaxableThisPeriod: number;
    federalMethod: "percentage_method" | "supplemental_flat";
    stateMethod: StateTaxConfig["calculation_method"];
    notices: string[];
  };
}

// ─── Config validation ────────────────────────────────────────────────────────

/**
 * Defensive parse of the JSONB blobs that feed the engine. Guards against a
 * corrupted / manually-edited DB row producing silently-wrong payroll numbers.
 * Called at the top of `calculateRun`; exported so other entry points (UI
 * preview, finalize action) can pre-validate before any calculation work.
 */
export function validateEngineConfigs(
  federalConfig: FederalTaxConfig,
  stateConfig: StateTaxConfig,
): void {
  const federalLabel = `Federal config ${federalConfig.tax_year}`;
  const federalChecks = [
    ["brackets", federalBracketsSchema.safeParse(federalConfig.brackets)],
    ["fica", ficaConfigSchema.safeParse(federalConfig.fica)],
    ["futa", futaConfigSchema.safeParse(federalConfig.futa)],
    [
      "std_deductions",
      stdDeductionsSchema.safeParse(federalConfig.std_deductions),
    ],
  ] as const;
  for (const [field, result] of federalChecks) {
    if (!result.success) {
      throw new Error(
        `${federalLabel} has invalid ${field}: ${formatZodError(result.error)}`,
      );
    }
  }

  const stateLabel = `State config ${stateConfig.state_code}/${stateConfig.tax_year}`;
  const sdi = stateSdiConfigSchema.safeParse(stateConfig.sdi_config);
  if (!sdi.success) {
    throw new Error(
      `${stateLabel} has invalid sdi_config: ${formatZodError(sdi.error)}`,
    );
  }
  const suta = stateSutaConfigSchema.safeParse(stateConfig.suta_config);
  if (!suta.success) {
    throw new Error(
      `${stateLabel} has invalid suta_config: ${formatZodError(suta.error)}`,
    );
  }
  const cfg = parseStateConfigByMethod(
    stateConfig.calculation_method as StateCalculationMethod,
    stateConfig.config,
  );
  if (!cfg.success) {
    throw new Error(
      `${stateLabel} (${stateConfig.calculation_method}) has invalid config: ${formatZodError(cfg.error)}`,
    );
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function calculateRun(input: CalculateRunInput): CalculatedRun {
  const { employee, federalConfig, stateConfig, period, ytd, runType } = input;
  validateEngineConfigs(federalConfig, stateConfig);
  const notices: string[] = [];

  // ── 1. Resolve base period amount ───────────────────────────────────────
  let baseAmount: number;
  let gross: number;
  let prorationMeta: {
    wasProrated: boolean;
    daysWorked: number;
    daysInPeriod: number;
  };

  if (input.grossOverride != null) {
    // Caller (finalize, or recalc without a new base) has provided the
    // already-resolved period gross. Do not touch pay_amount /
    // supplementalAmount and do not prorate - the incoming value is the
    // final gross and further proration would double-count a mid-period
    // hire or termination.
    gross = Math.max(0, Number(input.grossOverride) || 0);
    baseAmount = gross;
    prorationMeta = {
      wasProrated: false,
      daysWorked: 0,
      daysInPeriod: 0,
    };
  } else if (runType === "off_cycle") {
    // Off-cycle runs (bonus, severance, commission, final paycheck) are
    // explicit lump-sum payouts. The caller chose the amount and the pay
    // date; proration would silently zero out a severance where
    // period_start > termination_date, which is the common case for
    // post-termination final pay.
    baseAmount = Math.max(0, input.supplementalAmount ?? 0);
    gross = baseAmount;
    prorationMeta = {
      wasProrated: false,
      daysWorked: 0,
      daysInPeriod: 0,
    };
  } else {
    baseAmount = Number(employee.pay_amount) || 0;

    // ── 2. Prorate for hire/termination (regular runs only) ───────────────
    const proration = prorate({
      basePeriodAmount: baseAmount,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      hireDate: employee.hire_date,
      terminationDate: employee.termination_date,
    });
    gross = proration.proratedAmount;
    prorationMeta = {
      wasProrated: proration.wasProrated,
      daysWorked: proration.daysWorked,
      daysInPeriod: proration.daysInPeriod,
    };
  }

  // ── 3. Split withholdings by tax treatment ──────────────────────────────
  const splits = splitWithholdings(input.otherWithholdings);

  // Adjusted bases:
  //   FIT / SIT: subtract 401(k) + §125
  //   FICA / FUTA / SUTA / SDI: subtract §125 only (401(k) is NOT pre-tax
  //     for employment taxes per IRS rules)
  const fitBase = Math.max(0, gross - splits.preTax401k - splits.preTax125);
  const ficaBase = Math.max(0, gross - splits.preTax125);

  // ── 4. Federal income tax ───────────────────────────────────────────────
  const w4: W4Inputs = {
    filing_status: employee.w4_filing_status,
    multiple_jobs: employee.w4_multiple_jobs,
    exempt: employee.w4_exempt ?? false,
    dependents_amount: Number(employee.w4_dependents_amount) || 0,
    other_income: Number(employee.w4_other_income) || 0,
    deductions: Number(employee.w4_deductions) || 0,
    extra_withholding: Number(employee.w4_extra_withholding) || 0,
  };

  let fit: number;
  let federalMethod: "percentage_method" | "supplemental_flat";
  if (runType === "off_cycle") {
    // Supplemental flat (22% / 37% over $1M). W-4 exempt still zeros FIT
    // per Pub 15; short-circuit before the rate calc so we don't emit the
    // $1M notice on a zero withholding.
    if (w4.exempt) {
      fit = 0;
      federalMethod = "supplemental_flat";
    } else {
      const sup = calculateSupplementalFederal({
        grossThisPeriod: gross,
        taxableThisPeriod: fitBase,
        supplementalYtd: Math.max(0, input.supplementalYtd ?? 0),
      });
      fit = sup.federalIncomeTax;
      federalMethod = "supplemental_flat";
      if (sup.amountAtHighRate > 0) {
        notices.push(
          `$${sup.amountAtHighRate.toFixed(2)} withheld at 37% (supplemental over $1M annual threshold)`,
        );
      }
    }
  } else {
    const fitResult = calculateFederalIncomeTax({
      grossThisPeriod: fitBase,
      frequency: employee.pay_frequency,
      brackets: federalConfig.brackets,
      w4,
    });
    fit = fitResult.federalIncomeTax;
    federalMethod = "percentage_method";
    if (fitResult.fellBackToStep2Unchecked) {
      notices.push(
        "W-4 Step 2(c) is checked but federal config provides neither a " +
          "`w4_step2_checked` bracket table nor a `step2_additive` amount; " +
          "standard withholding was used, which under-withholds this employee.",
      );
    }
  }

  // ── 5. FICA (SS + Medicare + Additional Medicare) ───────────────────────
  // Use taxable-wages YTD directly from aggregated runs. For runs finalized
  // before pre-tax support existed those columns equal the old derived
  // value (min(grossYtd, cap) / grossYtd), so the result is identical.
  const fica = calculateFica({
    grossThisPeriod: ficaBase,
    ssWagesYtd: ytd.ssWagesYtd,
    medicareWagesYtd: ytd.medicareWagesYtd,
    fica: federalConfig.fica,
  });

  // ── 6. FUTA (employer only) ─────────────────────────────────────────────
  const futa = calculateFuta({
    grossThisPeriod: ficaBase,
    futaWagesYtd: ytd.futaWagesYtd,
    futa: federalConfig.futa,
    stateCode: employee.state_code,
  });
  if (futa.creditReductionRate > 0) {
    notices.push(
      `FUTA credit reduction applied for ${employee.state_code}: +${(futa.creditReductionRate * 100).toFixed(1)}% (effective ${(futa.effectiveRate * 100).toFixed(1)}%)`,
    );
  }
  if (futa.rateClamped) {
    notices.push(
      `FUTA effective rate exceeded the 6% statutory ceiling and was clamped. Likely a decimal-point mistake in federal config (0.6% = 0.006, not 6%). Review federal_tax_configs.futa.rate.`,
    );
  } else if (futa.effectiveRate > FUTA_PLAUSIBLE_NET_CEILING) {
    notices.push(
      `FUTA effective rate ${(futa.effectiveRate * 100).toFixed(2)}% exceeds the typical 0.6-3.6% range. Verify federal_tax_configs.futa.rate is the net rate (post state UI credit), not the 6.0% statutory gross.`,
    );
  }

  // ── 7. State taxes ──────────────────────────────────────────────────────
  //   SIT uses fitBase (gross - 401k - §125)
  //   SUTA/SDI use ficaBase (gross - §125)
  // SDI wage-base YTD still derives from grossYtd since SDI wages aren't
  // stored on runs - this slightly over-estimates the cap basis but the
  // error is bounded by per-state SDI wage bases.
  const state = calculateState({
    grossThisPeriod: fitBase,
    employmentBaseThisPeriod: ficaBase,
    sutaWagesYtdOverride: ytd.sutaWagesYtd,
    frequency: employee.pay_frequency,
    stateConfig,
    employeeElection: employee.state_config,
    defaultFilingStatus: employee.w4_filing_status,
    grossYtd: ytd.grossYtd,
  });
  if (state.notice) notices.push(state.notice);

  // ── 8. 401(k) annual-limit advisory ────────────────────────────────────
  // IRS 2026 elective-deferral limit: $23,500 (catch-up +$7,500 at 50+,
  // enhanced +$11,250 at 60-63). Engine doesn't know the employee's age,
  // so we flag at the base limit. Admins should catch overages manually.
  const FOUR01K_BASE_LIMIT = 23500;
  const newPreTax401kYtd = ytd.preTax401kYtd + splits.preTax401k;
  if (splits.preTax401k > 0 && newPreTax401kYtd > FOUR01K_BASE_LIMIT) {
    notices.push(
      `Pre-tax 401(k) YTD $${newPreTax401kYtd.toFixed(2)} exceeds the ` +
        `$${FOUR01K_BASE_LIMIT.toLocaleString()} base limit (catch-up ` +
        `contributions may raise this for age 50+; verify manually).`,
    );
  }

  // ── 9. Net pay ──────────────────────────────────────────────────────────
  // Gross - all taxes - all withholdings (pre-tax amounts go to the plan,
  // post-tax amounts to creditors/insurers/etc.). Pre-tax already reduced
  // the tax bases above; here they reduce take-home.
  const totalTaxes =
    fit +
    state.stateIncomeTax +
    fica.ssEmployee +
    fica.medicareEmployee +
    fica.additionalMedicare +
    state.stateDisabilityEmployee;
  const net = gross - totalTaxes - splits.total;

  return {
    gross_pay: round2(gross),
    federal_income_tax: round2(fit),
    state_income_tax: round2(state.stateIncomeTax),
    social_security_employee: round2(fica.ssEmployee),
    medicare_employee: round2(fica.medicareEmployee),
    additional_medicare: round2(fica.additionalMedicare),
    state_disability_employee: round2(state.stateDisabilityEmployee),
    other_withholdings: input.otherWithholdings ?? [],
    net_pay: round2(net),

    social_security_employer: round2(fica.ssEmployer),
    medicare_employer: round2(fica.medicareEmployer),
    futa: round2(futa.futa),
    suta: round2(state.suta),
    state_disability_employer: round2(state.stateDisabilityEmployer),

    meta: {
      baseAmount: round2(baseAmount),
      wasProrated: prorationMeta.wasProrated,
      daysWorked: prorationMeta.daysWorked,
      daysInPeriod: prorationMeta.daysInPeriod,
      ssTaxableThisPeriod: fica.ssTaxableThisPeriod,
      medicareTaxableThisPeriod: fica.medicareTaxableThisPeriod,
      additionalMedicareWagesThisPeriod: fica.additionalMedicareWagesThisPeriod,
      futaTaxableThisPeriod: futa.futaTaxableThisPeriod,
      sutaTaxableThisPeriod: state.sutaTaxableThisPeriod,
      stateTaxableThisPeriod: round2(fitBase),
      federalMethod,
      stateMethod: state.methodUsed,
      notices,
    },
  };
}

// ─── Re-exports for convenience ───────────────────────────────────────────────

export type { YtdTotals } from "./ytd";
export { aggregateYtd, computeYtdThrough, ZERO_YTD } from "./ytd";
export {
  getNextPayPeriod,
  getPeriodForPayDate,
  getPayPeriodsInRange,
  getPayDatesForYear,
  isLegalPayDate,
  type PayPeriod,
  type PayScheduleInput,
} from "./schedule";
