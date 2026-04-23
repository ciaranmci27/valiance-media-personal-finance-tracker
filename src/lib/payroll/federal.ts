// Federal payroll tax calculations.
//
// Three independent pure functions:
//   - calculateFederalIncomeTax: Pub 15-T percentage method (Worksheet 1A).
//   - calculateFica: Social Security + Medicare + Additional Medicare 0.9%.
//   - calculateFuta: 0.6% FUTA (net of state UI credit) on first $7,000/employee.
//
// Methodology reference: IRS Publication 15-T (2026), Worksheet 1A
// (percentage method). Calculations are driven by the federal_tax_configs
// row for the run's tax year, so new years are added via admin UI rather
// than code changes.
//
// All amounts are returned rounded to cents via round2().

import { round2 } from "./rounding";
import type {
  FederalBracket,
  FederalBrackets,
  FederalBracketsByStatus,
  FicaConfig,
  FilingStatus,
  FutaConfig,
  PayFrequency,
} from "@/types/payroll";

// ─── Pay periods per year ─────────────────────────────────────────────────────

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
};

// ─── Federal income tax (Pub 15-T Worksheet 1A) ───────────────────────────────

export interface W4Inputs {
  filing_status: FilingStatus;
  /** Step 2 checkbox - "higher withholding" / multiple jobs. */
  multiple_jobs: boolean;
  /** Employee wrote "Exempt" below Step 4(c). Zeroes federal income tax
   *  withholding; wages are still taxable and still reported on 941/W-2. */
  exempt?: boolean;
  /** Step 3 - annual dependent credit TOTAL in dollars. */
  dependents_amount: number;
  /** Step 4a - other annual income (not from jobs). */
  other_income: number;
  /** Step 4b - annual deductions above the standard. */
  deductions: number;
  /** Step 4c - extra withholding PER PERIOD (not annualized). */
  extra_withholding: number;
}

export interface FederalIncomeTaxInput {
  grossThisPeriod: number;
  frequency: PayFrequency;
  brackets: FederalBrackets;
  w4: W4Inputs;
}

export interface FederalIncomeTaxResult {
  federalIncomeTax: number;
  /** Annualized taxable wage amount (Worksheet 1A Step 1j). Includes the
   *  Step 1j additive if applied. */
  annualAdjustedWage: number;
  /** Bracket used, for audit / UI display. */
  bracketUsed: FederalBracket | null;
  /** True when W-4 Step 2(c) is checked but the config provides neither
   *  `w4_step2_checked` brackets nor `step2_additive`, so standard brackets
   *  were used without any higher-withholding adjustment. This is a config
   *  gap that will under-withhold the employee. */
  fellBackToStep2Unchecked: boolean;
  /** Pub 15-T Worksheet 1A Step 1j additive applied to annual wages. Nonzero
   *  only when `step2_additive` is configured AND `w4_step2_checked` table is
   *  absent AND `w4.multiple_jobs` is true. */
  step1jAddedAmount: number;
}

function selectBracketTable(
  brackets: FederalBrackets,
  w4Checked: boolean,
  status: FilingStatus,
): { table: FederalBracket[]; fellBack: boolean } {
  let source: FederalBracketsByStatus | undefined;
  let fellBack = false;
  if (w4Checked && brackets.w4_step2_checked) {
    source = brackets.w4_step2_checked;
  } else {
    if (w4Checked && !brackets.w4_step2_checked) {
      fellBack = true;
    }
    source = brackets.w4_step2_unchecked;
  }
  return { table: source[status], fellBack };
}

function applyBracket(amount: number, table: FederalBracket[]): FederalBracket | null {
  // Bracket.max is exclusive; the last bracket has max = null (no upper bound).
  for (const b of table) {
    const inBracket = amount >= b.min && (b.max === null || amount < b.max);
    if (inBracket) return b;
  }
  // Above the highest explicit bracket - use the last.
  return table.length > 0 ? table[table.length - 1] : null;
}

export function calculateFederalIncomeTax(
  input: FederalIncomeTaxInput,
): FederalIncomeTaxResult {
  const periods = PERIODS_PER_YEAR[input.frequency];

  // Worksheet 1A Steps 1a-1g (annualized adjusted wages).
  const annualWages = input.grossThisPeriod * periods;
  const annualTotal = annualWages + (input.w4.other_income || 0);
  const adjusted = annualTotal - (input.w4.deductions || 0);
  // Clamp to 0 - you cannot have negative taxable wages.
  const wage1g = adjusted < 0 ? 0 : adjusted;

  // W-4 "Exempt" short-circuit: IRS Pub 15 says withhold zero FIT. We still
  // compute annualAdjustedWage above so the audit trail reflects the wage
  // basis; extra_withholding is intentionally ignored since an exempt W-4
  // instructs Step 4(c) to be blank.
  if (input.w4.exempt) {
    return {
      federalIncomeTax: 0,
      annualAdjustedWage: round2(wage1g),
      bracketUsed: null,
      fellBackToStep2Unchecked: false,
      step1jAddedAmount: 0,
    };
  }

  // Pub 15-T brackets are annual; our config stores them keyed by period.
  // If the config declares a non-annual period, scale the thresholds to annual.
  // (For the standard seed with period="annual", this is a no-op.)
  const scale = scaleFactorToAnnual(input.brackets.period, input.frequency);

  // Pub 15-T Worksheet 1A Step 1j: when Step 2(c) is checked, the IRS
  // provides two equivalent paths:
  //   (a) Use the dedicated "higher withholding" bracket table
  //       (`w4_step2_checked`). No wage adjustment needed.
  //   (b) Use the standard table but add a fixed amount to annual wages
  //       ($12,900 MFJ / $8,600 others in Pub 15-T 2025).
  // We prefer (a) when the config provides it, otherwise fall back to (b).
  // When neither is configured, we use the standard table with no adjustment
  // and report `fellBackToStep2Unchecked = true` so the UI can flag the
  // misconfiguration.
  let step1jAdded = 0;
  if (
    input.w4.multiple_jobs &&
    !input.brackets.w4_step2_checked &&
    input.brackets.step2_additive
  ) {
    step1jAdded =
      input.w4.filing_status === "mfj"
        ? input.brackets.step2_additive.mfj
        : input.brackets.step2_additive.other;
  }
  const annualAdjustedWage = wage1g + step1jAdded;

  const { table, fellBack } = selectBracketTable(
    input.brackets,
    input.w4.multiple_jobs,
    input.w4.filing_status,
  );

  // When Step 2(c) is checked and we covered it with the additive, the
  // fallback is intentional and should not surface as a config warning.
  const unresolvedFallback = fellBack && step1jAdded === 0;

  // If the config brackets are in a per-period basis, we need to compare
  // per-period amounts. Simpler: scale table thresholds to annual instead.
  const annualTable = scaleTableToAnnual(table, scale);
  const bracket = applyBracket(annualAdjustedWage, annualTable);

  let annualTax = 0;
  if (bracket) {
    const over = annualAdjustedWage - bracket.min;
    annualTax = bracket.base_tax + over * bracket.rate;
    if (annualTax < 0) annualTax = 0;
  }

  // Worksheet 1A Step 3 - dependent credit, annualized.
  const annualDependentCredit = Math.max(0, input.w4.dependents_amount || 0);
  const taxAfterCredit = Math.max(0, annualTax - annualDependentCredit);

  // Divide back to per-period, add per-period extra withholding (Step 4c).
  const perPeriodTax = taxAfterCredit / periods;
  const extra = input.w4.extra_withholding || 0;
  const total = perPeriodTax + extra;

  return {
    federalIncomeTax: round2(total),
    annualAdjustedWage: round2(annualAdjustedWage),
    bracketUsed: bracket,
    fellBackToStep2Unchecked: unresolvedFallback,
    step1jAddedAmount: step1jAdded,
  };
}

function scaleFactorToAnnual(
  bracketPeriod: FederalBrackets["period"],
  payFrequency: PayFrequency,
): number {
  // If brackets are annual, no scaling needed.
  if (bracketPeriod === "annual") return 1;
  // Otherwise brackets are keyed to a specific pay period; convert by
  // multiplying by periods-per-year of that period (weekly brackets × 52
  // gives annual thresholds). We do this regardless of employee frequency.
  const periodsForBracket: Record<Exclude<FederalBrackets["period"], "annual">, number> = {
    weekly: 52,
    biweekly: 26,
    semimonthly: 24,
    monthly: 12,
  };
  return periodsForBracket[bracketPeriod];
}

function scaleTableToAnnual(
  table: FederalBracket[],
  factor: number,
): FederalBracket[] {
  if (factor === 1) return table;
  return table.map((b) => ({
    min: b.min * factor,
    max: b.max === null ? null : b.max * factor,
    rate: b.rate,
    base_tax: b.base_tax * factor,
  }));
}

// ─── FICA (Social Security + Medicare + Additional Medicare) ─────────────────

export interface FicaInput {
  grossThisPeriod: number;
  /** Sum of SS-taxable wages already paid this year BEFORE this run. Usually
   *  derived as min(grossYtd, ss_wage_base) for a single-employer scenario. */
  ssWagesYtd: number;
  /** Sum of Medicare-taxable wages already paid this year BEFORE this run.
   *  Usually equal to grossYtd since Medicare has no cap. */
  medicareWagesYtd: number;
  fica: FicaConfig;
}

export interface FicaResult {
  /** Social Security employee-side (6.2% on capped wages). */
  ssEmployee: number;
  /** Social Security employer-side (matches employee). */
  ssEmployer: number;
  /** Medicare employee-side (1.45% on all wages). */
  medicareEmployee: number;
  /** Medicare employer-side (matches employee). */
  medicareEmployer: number;
  /** Additional Medicare 0.9% employee-side only (no employer match). */
  additionalMedicare: number;
  /** SS-taxable wages included in this run (after cap). */
  ssTaxableThisPeriod: number;
  /** Medicare-taxable wages included in this run (no cap). */
  medicareTaxableThisPeriod: number;
  /** Portion of this run's wages that exceeded the 0.9% threshold. */
  additionalMedicareWagesThisPeriod: number;
}

export function calculateFica(input: FicaInput): FicaResult {
  const g = Math.max(0, input.grossThisPeriod || 0);

  // Social Security: capped at ss_wage_base per employee per year.
  const ssCapRemaining = Math.max(0, input.fica.ss_wage_base - input.ssWagesYtd);
  const ssTaxableThisPeriod = Math.min(g, ssCapRemaining);
  const ssAmount = ssTaxableThisPeriod * input.fica.ss_rate;

  // Medicare: no cap, applies to all wages.
  const medicareTaxableThisPeriod = g;
  const medicareAmount = medicareTaxableThisPeriod * input.fica.medicare_rate;

  // Additional Medicare 0.9% on wages above threshold ($200k). Employer
  // ignores filing status per IRS Pub 15. Employer does NOT match.
  const threshold = input.fica.additional_medicare_threshold;
  const medicareYtdAfter = input.medicareWagesYtd + g;
  const overAfter = Math.max(0, medicareYtdAfter - threshold);
  const overBefore = Math.max(0, input.medicareWagesYtd - threshold);
  const additionalMedicareWagesThisPeriod = Math.max(0, overAfter - overBefore);
  const additionalMedicare =
    additionalMedicareWagesThisPeriod * input.fica.additional_medicare_rate;

  return {
    ssEmployee: round2(ssAmount),
    ssEmployer: round2(ssAmount),
    medicareEmployee: round2(medicareAmount),
    medicareEmployer: round2(medicareAmount),
    additionalMedicare: round2(additionalMedicare),
    ssTaxableThisPeriod: round2(ssTaxableThisPeriod),
    medicareTaxableThisPeriod: round2(medicareTaxableThisPeriod),
    additionalMedicareWagesThisPeriod: round2(additionalMedicareWagesThisPeriod),
  };
}

// ─── FUTA (employer-only, 0.6% on first $7,000) ──────────────────────────────

export interface FutaInput {
  grossThisPeriod: number;
  /** Cumulative FUTA-taxable wages before this run; usually
   *  min(grossYtd, futa.wage_base). */
  futaWagesYtd: number;
  futa: FutaConfig;
  /** Employee's work-state code. When that state appears in
   *  futa.credit_reduction_states, the effective rate for this run is
   *  futa.rate + reduction. Ignored when undefined. */
  stateCode?: string;
}

export interface FutaResult {
  futa: number;
  futaTaxableThisPeriod: number;
  /** Effective rate used (= futa.rate + credit-reduction when applicable).
   *  Exposed so the UI can show "+0.3% credit reduction" where relevant. */
  effectiveRate: number;
  /** Non-zero when a credit reduction applied for this run's state. */
  creditReductionRate: number;
  /** True when effectiveRate would have exceeded the 6% statutory ceiling
   *  and was clamped. Indicates FUTA config is almost certainly
   *  misentered - usually a decimal-point mistake (6% vs 0.6%). */
  rateClamped: boolean;
}

/** Statutory maximum FUTA rate: 6.0% gross before state UI credit. Nothing
 *  an employer can pay in FUTA should exceed this ceiling. */
export const FUTA_MAX_STATUTORY_RATE = 0.06;
/** Net rate ceiling under normal configuration (0.6% base + maximum observed
 *  credit reduction, ~3%). Anything above this is likely a misconfig even if
 *  below the statutory ceiling. */
export const FUTA_PLAUSIBLE_NET_CEILING = 0.036;

export function calculateFuta(input: FutaInput): FutaResult {
  const g = Math.max(0, input.grossThisPeriod || 0);
  const room = Math.max(0, input.futa.wage_base - input.futaWagesYtd);
  const taxable = Math.min(g, room);
  const creditReductionRate =
    (input.stateCode &&
      input.futa.credit_reduction_states?.[input.stateCode]) ||
    0;
  const requestedRate = Math.max(0, input.futa.rate) + creditReductionRate;
  const effectiveRate = Math.min(requestedRate, FUTA_MAX_STATUTORY_RATE);
  const rateClamped = requestedRate > FUTA_MAX_STATUTORY_RATE;
  const futa = taxable * effectiveRate;
  return {
    futa: round2(futa),
    futaTaxableThisPeriod: round2(taxable),
    effectiveRate,
    creditReductionRate,
    rateClamped,
  };
}


// ─── Derivation helpers the engine calls with grossYtd ────────────────────────

/** For a single-employer salaried scenario, SS wages equal gross capped at wage base. */
export function deriveSsWagesYtd(grossYtd: number, ficaConfig: FicaConfig): number {
  return Math.min(Math.max(0, grossYtd), ficaConfig.ss_wage_base);
}

/** Medicare has no cap - all gross is medicare-taxable. */
export function deriveMedicareWagesYtd(grossYtd: number): number {
  return Math.max(0, grossYtd);
}

/** FUTA wages are gross capped at the FUTA wage base ($7,000). */
export function deriveFutaWagesYtd(grossYtd: number, futaConfig: FutaConfig): number {
  return Math.min(Math.max(0, grossYtd), futaConfig.wage_base);
}
