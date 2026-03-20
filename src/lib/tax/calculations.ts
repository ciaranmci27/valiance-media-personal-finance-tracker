/**
 * Tax calculation engine - all pure functions, no side effects.
 */

import type { TaxBracket, TaxYearConfig, FilingStatus } from "./constants";
import type { TaxIncomeSource, TaxCapitalGainEntry, TaxPaymentEntry } from "@/types/database";
import { getStateTaxConfig } from "./state-taxes";

// ============================================================================
// Result types
// ============================================================================

export interface BracketLine {
  rate: number;
  rangeStart: number;
  rangeEnd: number;
  taxableInBracket: number;
  tax: number;
}

export interface FicaTaxResult {
  ssTax: number;
  medicareTax: number;
  additionalMedicare: number;
  total: number;
}

export interface SelfEmploymentTaxResult {
  netSeIncome: number; // 92.35% of SE income
  ssTax: number;
  medicareTax: number;
  additionalMedicare: number;
  total: number;
  deductibleHalf: number;
}

export interface FederalTaxResult {
  bracketBreakdown: BracketLine[];
  total: number;
}

export interface LTCGTaxResult {
  bracketBreakdown: BracketLine[];
  total: number;
}

export interface CapitalGainsResult {
  grossShortTerm: number;
  grossLongTerm: number;
  netShortTerm: number;
  netLongTerm: number;
  lossDeduction: number;
  hasLosses: boolean;
}

export interface FullTaxBreakdown {
  // Income classification
  totalIncome: number;
  w2Income: number;
  seIncome: number;
  passiveIncome: number;

  // Capital gains
  capitalGains: CapitalGainsResult;

  // SE tax
  selfEmploymentTax: SelfEmploymentTaxResult;

  // W-2 FICA
  ficaTax: FicaTaxResult;

  // Income flow
  grossIncome: number;
  agi: number;

  // Deductions
  standardDeduction: number;
  seDeduction: number;
  qbiDeduction: number;
  additionalDeductions: number;
  totalDeductions: number;
  taxableIncome: number;
  ordinaryTaxableIncome: number;

  // Tax computations
  federalTax: FederalTaxResult;
  ltcgTax: LTCGTaxResult;
  niit: number;
  stateTax: number;
  stateTaxDetail: {
    stateCode: string | null;
    stateName: string | null;
    rate: number | null; // null for progressive
  };

  // Federal credits
  childTaxCredit: number;
  otherDependentCredit: number;
  additionalCredits: number;
  totalCredits: number;
  federalTaxAfterCredits: number;

  // Totals
  totalLiability: number;
  federalLiability: number;
  stateLiability: number;
  totalFederalPaid: number;
  totalStatePaid: number;
  totalPaid: number;
  netRemaining: number;
  federalRemaining: number;
  stateRemaining: number;
}

// ============================================================================
// Core calculation functions
// ============================================================================

/**
 * Walk progressive tax brackets and return per-bracket breakdown.
 */
function walkBrackets(taxableAmount: number, brackets: TaxBracket[]): FederalTaxResult {
  const breakdown: BracketLine[] = [];
  let remaining = Math.max(0, taxableAmount);
  let prevUpTo = 0;

  for (const bracket of brackets) {
    if (remaining <= 0) break;

    const rangeStart = prevUpTo;
    const rangeEnd = bracket.upTo === Infinity ? Infinity : bracket.upTo;
    const bracketSize = bracket.upTo === Infinity ? remaining : bracket.upTo - prevUpTo;
    const taxableInBracket = Math.min(remaining, bracketSize);
    const tax = taxableInBracket * bracket.rate;

    breakdown.push({
      rate: bracket.rate,
      rangeStart,
      rangeEnd,
      taxableInBracket,
      tax,
    });

    remaining -= taxableInBracket;
    prevUpTo = bracket.upTo === Infinity ? prevUpTo : bracket.upTo;
  }

  return {
    bracketBreakdown: breakdown,
    total: breakdown.reduce((sum, b) => sum + b.tax, 0),
  };
}

/**
 * Calculate self-employment tax with SS wage base cap and additional Medicare.
 */
export function calculateSelfEmploymentTax(
  seIncome: number,
  w2Income: number,
  filingStatus: FilingStatus,
  config: TaxYearConfig["seTax"]
): SelfEmploymentTaxResult {
  if (seIncome <= 0) {
    return { netSeIncome: 0, ssTax: 0, medicareTax: 0, additionalMedicare: 0, total: 0, deductibleHalf: 0 };
  }

  const netSeIncome = seIncome * config.selfEmploymentFactor;

  // SS tax: 12.4% on net SE income, capped at (wage base - W-2 wages)
  const ssWageRoom = Math.max(0, config.ssWageBase - w2Income);
  const ssTaxableIncome = Math.min(netSeIncome, ssWageRoom);
  const ssTax = ssTaxableIncome * config.ssRate;

  // Medicare tax: 2.9% on all net SE income (uncapped)
  const medicareTax = netSeIncome * config.medicareRate;

  // Additional Medicare: 0.9% on combined earnings above threshold
  const threshold = config.additionalMedicareThreshold[filingStatus];
  const combinedEarnings = w2Income + netSeIncome;
  const additionalMedicare =
    combinedEarnings > threshold
      ? Math.min(netSeIncome, combinedEarnings - threshold) * config.additionalMedicareRate
      : 0;

  const total = ssTax + medicareTax + additionalMedicare;

  // Deductible half is 50% of regular SE tax only (SS + Medicare).
  // Additional Medicare Tax (0.9%) is NOT deductible per Form 8959 / Schedule SE.
  const regularSeTax = ssTax + medicareTax;

  return {
    netSeIncome,
    ssTax,
    medicareTax,
    additionalMedicare,
    total,
    deductibleHalf: regularSeTax / 2,
  };
}

/**
 * Calculate W-2 employee FICA tax (SS + Medicare + Additional Medicare).
 * The SS wage base is shared with SE income.
 */
export function calculateFicaTax(
  w2Income: number,
  seIncome: number,
  filingStatus: FilingStatus,
  config: TaxYearConfig["ficaTax"]
): FicaTaxResult {
  if (w2Income <= 0) {
    return { ssTax: 0, medicareTax: 0, additionalMedicare: 0, total: 0 };
  }

  // SS: 6.2% on W-2 wages, capped at shared wage base
  const ssTaxableIncome = Math.min(w2Income, config.ssWageBase);
  const ssTax = ssTaxableIncome * config.ssRate;

  // Medicare: 1.45% on all W-2 wages (no cap)
  const medicareTax = w2Income * config.medicareRate;

  // Additional Medicare: 0.9% on W-2 wages exceeding threshold
  // Only the W-2 portion here; SE calc handles its own Additional Medicare
  const threshold = config.additionalMedicareThreshold[filingStatus];
  const additionalMedicare =
    w2Income > threshold
      ? (w2Income - threshold) * config.additionalMedicareRate
      : 0;

  const total = ssTax + medicareTax + additionalMedicare;

  return { ssTax, medicareTax, additionalMedicare, total };
}

/**
 * Calculate federal income tax on ordinary taxable income.
 */
export function calculateFederalTax(
  ordinaryTaxableIncome: number,
  brackets: TaxBracket[]
): FederalTaxResult {
  return walkBrackets(ordinaryTaxableIncome, brackets);
}

/**
 * Calculate LTCG tax using stacking method.
 * Long-term gains are "stacked" on top of ordinary taxable income
 * to determine which LTCG bracket they fall into.
 */
export function calculateLTCGTax(
  ltcgAmount: number,
  ordinaryTaxableIncome: number,
  ltcgBrackets: TaxBracket[]
): LTCGTaxResult {
  if (ltcgAmount <= 0) {
    return { bracketBreakdown: [], total: 0 };
  }

  const breakdown: BracketLine[] = [];
  let remaining = ltcgAmount;
  let prevUpTo = 0;

  for (const bracket of ltcgBrackets) {
    if (remaining <= 0) break;

    const rangeStart = prevUpTo;
    const rangeEnd = bracket.upTo === Infinity ? Infinity : bracket.upTo;
    const bracketCeiling = bracket.upTo === Infinity ? Infinity : bracket.upTo;

    // How much room is left in this bracket after ordinary income fills it?
    const roomInBracket =
      bracketCeiling === Infinity
        ? remaining
        : Math.max(0, bracketCeiling - Math.max(ordinaryTaxableIncome, prevUpTo));

    const taxableInBracket = Math.min(remaining, roomInBracket);

    if (taxableInBracket > 0) {
      breakdown.push({
        rate: bracket.rate,
        rangeStart,
        rangeEnd,
        taxableInBracket,
        tax: taxableInBracket * bracket.rate,
      });
    }

    remaining -= taxableInBracket;
    prevUpTo = bracket.upTo === Infinity ? prevUpTo : bracket.upTo;
  }

  return {
    bracketBreakdown: breakdown,
    total: breakdown.reduce((sum, b) => sum + b.tax, 0),
  };
}

/**
 * Calculate state income tax based on state config.
 */
function calculateStateTax(
  taxableIncome: number,
  stateCode: string | null,
  filingStatus: FilingStatus
): { total: number; rate: number | null; stateName: string | null } {
  const config = getStateTaxConfig(stateCode);
  if (!config || config.type === "none") {
    return { total: 0, rate: config?.type === "none" ? 0 : null, stateName: config?.name ?? null };
  }

  if (config.type === "flat" && config.flatRate != null) {
    return {
      total: Math.max(0, taxableIncome) * config.flatRate,
      rate: config.flatRate,
      stateName: config.name,
    };
  }

  if (config.type === "progressive" && config.brackets) {
    const brackets = config.brackets[filingStatus];
    const result = walkBrackets(Math.max(0, taxableIncome), brackets);
    return {
      total: result.total,
      rate: null, // progressive, no single rate
      stateName: config.name,
    };
  }

  return { total: 0, rate: null, stateName: null };
}

/**
 * Net capital gains with loss offset logic.
 */
export function netCapitalGains(
  entries: TaxCapitalGainEntry[],
  lossLimit: number
): CapitalGainsResult {
  const grossShortTerm = entries
    .filter((e) => e.term === "short")
    .reduce((sum, e) => sum + e.amount, 0);
  const grossLongTerm = entries
    .filter((e) => e.term === "long")
    .reduce((sum, e) => sum + e.amount, 0);

  // Net each type independently first
  let netShortTerm = grossShortTerm;
  let netLongTerm = grossLongTerm;

  // If one type has a loss and the other has a gain, offset cross-type
  if (netShortTerm < 0 && netLongTerm > 0) {
    const offset = Math.min(-netShortTerm, netLongTerm);
    netShortTerm += offset;
    netLongTerm -= offset;
  } else if (netLongTerm < 0 && netShortTerm > 0) {
    const offset = Math.min(-netLongTerm, netShortTerm);
    netLongTerm += offset;
    netShortTerm -= offset;
  }

  // Combined net loss deduction capped at limit
  const combinedNetLoss = Math.min(0, netShortTerm) + Math.min(0, netLongTerm);
  const lossDeduction = combinedNetLoss < 0 ? Math.min(-combinedNetLoss, lossLimit) : 0;

  return {
    grossShortTerm,
    grossLongTerm,
    netShortTerm,
    netLongTerm,
    lossDeduction,
    hasLosses: combinedNetLoss < 0,
  };
}

/**
 * Master calculation orchestrator.
 */
export function calculateFullTax(
  incomeSources: TaxIncomeSource[],
  capitalGainEntries: TaxCapitalGainEntry[],
  paymentEntries: TaxPaymentEntry[],
  additionalDeductions: number,
  filingStatus: FilingStatus,
  config: TaxYearConfig,
  stateCode: string | null = null,
  dependents: number = 0,
  otherDependents: number = 0,
  additionalCredits: number = 0
): FullTaxBreakdown {
  // 1. Classify income
  const w2Income = incomeSources
    .filter((s) => !s.subject_to_se && s.income_type !== "k1")
    .reduce((sum, s) => sum + s.amount, 0);
  const seIncome = incomeSources
    .filter((s) => s.subject_to_se)
    .reduce((sum, s) => sum + s.amount, 0);
  const passiveIncome = incomeSources
    .filter((s) => s.income_type === "k1" && !s.subject_to_se)
    .reduce((sum, s) => sum + s.amount, 0);
  const totalIncome = w2Income + seIncome + passiveIncome;

  // 2. Net capital gains
  const capGains = netCapitalGains(capitalGainEntries, config.capitalLossLimit[filingStatus]);

  // 3. SE tax
  const seTax = calculateSelfEmploymentTax(seIncome, w2Income, filingStatus, config.seTax);

  // 3b. W-2 FICA tax
  const ficaTax = calculateFicaTax(w2Income, seIncome, filingStatus, config.ficaTax);

  // 4. Gross income = all income + net capital gains (both ST and LT, if positive)
  // Per Form 1040: Schedule D result flows to Line 7, included in total income (Line 9)
  const netStGainForIncome = Math.max(0, capGains.netShortTerm);
  const netLtGainForIncome = Math.max(0, capGains.netLongTerm);
  const grossIncome = totalIncome + netStGainForIncome + netLtGainForIncome;

  // 5. AGI = gross income - half of SE tax - capital loss deduction
  // Capital loss deduction is the limited net loss (up to $3k/$1.5k) when gains are negative
  const agi = grossIncome - seTax.deductibleHalf - capGains.lossDeduction;

  // 6. QBI deduction
  const qbiEligibleIncome = Math.max(0, seIncome - seTax.deductibleHalf);
  const rawQbi = qbiEligibleIncome * config.qbi.rate;

  const standardDeduction = config.standardDeductions[filingStatus];
  const taxableIncomeBeforeQbi = Math.max(0, agi - standardDeduction - additionalDeductions);
  const netCapGainForQbi = Math.max(0, capGains.netLongTerm) + Math.max(0, capGains.netShortTerm);
  const qbiTaxableIncomeCap = config.qbi.rate * Math.max(0, taxableIncomeBeforeQbi - netCapGainForQbi);

  const qbiThreshold = config.qbi.phaseOut[filingStatus];
  const qbiPhaseOutRange = filingStatus === "mfj" ? 100000 : 50000;

  let qbiAfterPhaseOut: number;
  if (agi <= qbiThreshold) {
    qbiAfterPhaseOut = rawQbi;
  } else if (agi >= qbiThreshold + qbiPhaseOutRange) {
    qbiAfterPhaseOut = 0;
  } else {
    qbiAfterPhaseOut = rawQbi * (1 - (agi - qbiThreshold) / qbiPhaseOutRange);
  }

  const qbiDeduction = Math.min(qbiAfterPhaseOut, qbiTaxableIncomeCap);

  // 7. Taxable income
  const totalDeductions = standardDeduction + seTax.deductibleHalf + qbiDeduction + additionalDeductions;
  const taxableIncome = Math.max(0, agi - standardDeduction - qbiDeduction - additionalDeductions);

  // 8. Ordinary taxable income = taxable income minus net LTCG (if positive)
  const ltcgForTax = Math.max(0, capGains.netLongTerm);
  const ordinaryTaxableIncome = Math.max(0, taxableIncome - ltcgForTax);

  // 9. Federal income tax on ordinary income
  const federalTax = calculateFederalTax(ordinaryTaxableIncome, config.federalBrackets[filingStatus]);

  // 10. LTCG tax (stacked)
  const ltcgTax = calculateLTCGTax(ltcgForTax, ordinaryTaxableIncome, config.ltcgBrackets[filingStatus]);

  // 11. NIIT: 3.8% on lesser of (net investment income, MAGI - threshold)
  const niitThreshold = config.niit.threshold[filingStatus];
  const netInvestmentIncome =
    Math.max(0, capGains.netShortTerm) +
    Math.max(0, capGains.netLongTerm) +
    Math.max(0, passiveIncome);
  const niit =
    agi > niitThreshold
      ? config.niit.rate * Math.min(netInvestmentIncome, agi - niitThreshold)
      : 0;

  // 12. State tax
  const stateResult = calculateStateTax(taxableIncome, stateCode, filingStatus);
  const stateTax = stateResult.total;

  // 12b. Child Tax Credit ($2,000/child, phases out above AGI threshold)
  let childTaxCredit = 0;
  if (dependents > 0) {
    const ctcConfig = config.childTaxCredit;
    const maxCredit = dependents * ctcConfig.perChild;
    const threshold = ctcConfig.phaseOutStart[filingStatus];
    const excessAgi = Math.max(0, agi - threshold);
    // Reduce by $50 for each $1,000 (or fraction) over threshold
    const phaseOutReduction = Math.ceil(excessAgi / 1000) * 50;
    const creditAfterPhaseOut = Math.max(0, maxCredit - phaseOutReduction);
    // Nonrefundable: can't exceed federal income tax + LTCG tax
    childTaxCredit = Math.min(creditAfterPhaseOut, federalTax.total + ltcgTax.total);
  }

  // 12c. Other Dependent Credit ($500/dependent, same phase-out as CTC)
  let otherDependentCredit = 0;
  if (otherDependents > 0) {
    const maxCredit = otherDependents * config.otherDependentCredit.perDependent;
    const threshold = config.childTaxCredit.phaseOutStart[filingStatus];
    const excessAgi = Math.max(0, agi - threshold);
    const phaseOutReduction = Math.ceil(excessAgi / 1000) * 50;
    const creditAfterPhaseOut = Math.max(0, maxCredit - phaseOutReduction);
    const remainingTax = federalTax.total + ltcgTax.total - childTaxCredit;
    otherDependentCredit = Math.min(creditAfterPhaseOut, Math.max(0, remainingTax));
  }

  // 12d. Additional tax credits (user-entered, nonrefundable)
  const cappedAdditionalCredits = Math.min(
    additionalCredits,
    Math.max(0, federalTax.total + ltcgTax.total - childTaxCredit - otherDependentCredit)
  );
  const totalCredits = childTaxCredit + otherDependentCredit + cappedAdditionalCredits;

  // 13. Federal tax after credits
  const federalTaxAfterCredits = federalTax.total + ltcgTax.total - totalCredits;

  // 14. Total liability
  const federalLiability = federalTaxAfterCredits + seTax.total + ficaTax.total + niit;
  const stateLiability = stateTax;
  const totalLiability = federalLiability + stateLiability;

  // 14. Payments
  const totalFederalPaid = paymentEntries
    .filter((p) => p.type === "federal")
    .reduce((sum, p) => sum + p.amount, 0);
  const totalStatePaid = paymentEntries
    .filter((p) => p.type === "state")
    .reduce((sum, p) => sum + p.amount, 0);
  const totalPaid = totalFederalPaid + totalStatePaid;
  const netRemaining = totalLiability - totalPaid;
  const federalRemaining = federalLiability - totalFederalPaid;
  const stateRemaining = stateLiability - totalStatePaid;

  return {
    totalIncome,
    w2Income,
    seIncome,
    passiveIncome,
    capitalGains: capGains,
    selfEmploymentTax: seTax,
    ficaTax,
    grossIncome,
    agi,
    standardDeduction,
    seDeduction: seTax.deductibleHalf,
    qbiDeduction,
    additionalDeductions,
    totalDeductions,
    taxableIncome,
    ordinaryTaxableIncome,
    federalTax,
    ltcgTax,
    niit,
    stateTax,
    stateTaxDetail: {
      stateCode,
      stateName: stateResult.stateName,
      rate: stateResult.rate,
    },
    childTaxCredit,
    otherDependentCredit,
    additionalCredits: cappedAdditionalCredits,
    totalCredits,
    federalTaxAfterCredits,
    totalLiability,
    federalLiability,
    stateLiability,
    totalFederalPaid,
    totalStatePaid,
    totalPaid,
    netRemaining,
    federalRemaining,
    stateRemaining,
  };
}
