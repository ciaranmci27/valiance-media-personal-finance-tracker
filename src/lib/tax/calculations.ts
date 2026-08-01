/**
 * Tax calculation engine - all pure functions, no side effects.
 */

import type { TaxBracket, TaxYearConfig, FilingStatus } from "./constants";
import type { TaxIncomeSource, TaxCapitalGainEntry, TaxPaymentEntry, TaxClassification } from "@/types/database";
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
  otherIncome: number;

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
    stateStandardDeduction: number;
    stateTaxableIncome: number;
  };

  // Federal credits
  childTaxCredit: number;
  otherDependentCredit: number;
  additionalCredits: number;
  totalCredits: number;
  federalTaxAfterCredits: number;
  /** Refundable child credit (IRC 24(d)). Treated as a payment, per Form 1040 line 28. */
  additionalChildTaxCredit: number;

  // Totals
  totalLiability: number;
  federalLiability: number;
  stateLiability: number;
  ficaAutoCredited: number;
  /** Over-withheld Social Security across multiple employers, refundable per IRC 31(b). */
  excessSocialSecurityWithheld: number;
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

/** Inputs that do not fit the positional signature, all optional and defaulted. */
export interface TaxEstimateOptions {
  /** Specified service trade or business (IRC 199A(d)(2)): loses QBI above the threshold. */
  isSstb?: boolean;
  /** W-2 wages paid by the business, for the IRC 199A(b)(2)(B) limitation. */
  businessW2Wages?: number;
  /** Unadjusted basis of qualified property (UBIA), for the 2.5% component. */
  businessPropertyBasis?: number;
  taxpayerAge65?: boolean;
  taxpayerBlind?: boolean;
  spouseAge65?: boolean;
  spouseBlind?: boolean;
}

/** IRC 1402(b)(2): below this, self-employment income is not taxed at all. */
const SE_TAX_MINIMUM_NET_EARNINGS = 400;

/** IRC 24(d)(1)(B): the refundable child credit is 15% of earned income over this floor. */
const ACTC_EARNED_INCOME_FLOOR = 2500;
const ACTC_EARNED_INCOME_RATE = 0.15;

/**
 * Walk progressive tax brackets and return per-bracket breakdown.
 */
function walkBrackets(taxableAmount: number, brackets: TaxBracket[]): FederalTaxResult {
  const breakdown: BracketLine[] = [];
  let remaining = Math.max(0, taxableAmount);
  let prevUpTo = 0;

  for (const bracket of brackets) {
    const rangeStart = prevUpTo;
    const rangeEnd = bracket.upTo === Infinity ? Infinity : bracket.upTo;
    const bracketSize = bracket.upTo === Infinity ? remaining : bracket.upTo - prevUpTo;
    const taxableInBracket = remaining > 0 ? Math.min(remaining, bracketSize) : 0;
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

  // IRC 1402(b)(2) / Schedule SE line 4c: no self-employment tax at all when
  // net earnings from self-employment are under $400.
  if (netSeIncome < SE_TAX_MINIMUM_NET_EARNINGS) {
    return { netSeIncome, ssTax: 0, medicareTax: 0, additionalMedicare: 0, total: 0, deductibleHalf: 0 };
  }

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
 * Most states start from Federal AGI and apply their own standard deduction.
 * A few states (CO, ID, MT, ND, SC) start from Federal Taxable Income.
 */
function calculateStateTax(
  agi: number,
  federalTaxableIncome: number,
  stateCode: string | null,
  filingStatus: FilingStatus,
  federalStandardDeduction: number,
  dependents: number = 0,
  otherDependents: number = 0,
  taxYear?: number,
  includedShortTermGain: number = 0,
  includedLongTermGain: number = 0
): { total: number; rate: number | null; stateName: string | null; stateStandardDeduction: number; stateTaxableIncome: number } {
  const config = getStateTaxConfig(stateCode, taxYear);
  if (!config || config.type === "none") {
    return { total: 0, rate: config?.type === "none" ? 0 : null, stateName: config?.name ?? null, stateStandardDeduction: 0, stateTaxableIncome: 0 };
  }

  // Determine starting amount based on state's starting point
  const baseAmount = config.startingPoint === "federal_taxable" ? federalTaxableIncome : agi;

  // States that tax capital gains more lightly subtract a fraction of the gain
  // that federal income already includes.
  let capitalGainsSubtraction = 0;
  if (config.capitalGainsExclusion) {
    const { pct, appliesTo } = config.capitalGainsExclusion;
    const base =
      appliesTo === "longTerm"
        ? Math.max(0, includedLongTermGain)
        : Math.max(0, includedShortTermGain) + Math.max(0, includedLongTermGain);
    capitalGainsSubtraction = base * pct;
  }
  const startingAmount = Math.max(0, baseAmount - capitalGainsSubtraction);

  // Resolve state standard deduction
  let stateStandardDeduction = 0;
  if (config.startingPoint !== "federal_taxable") {
    if (config.deduction === "federal") {
      stateStandardDeduction = federalStandardDeduction;
    } else if (config.deduction && typeof config.deduction === "object" && "type" in config.deduction) {
      // Income-percentage deduction (e.g., Maryland: 15% of AGI with floor/ceiling)
      const d = config.deduction;
      const rawPct = startingAmount * d.rate;
      const floor = d.min[filingStatus] ?? 0;
      const ceiling = d.max[filingStatus] ?? Infinity;
      stateStandardDeduction = Math.max(floor, Math.min(rawPct, ceiling));
    } else if (config.deduction && typeof config.deduction === "object") {
      stateStandardDeduction = config.deduction[filingStatus] ?? 0;
    }

    // A deduction that shrinks as income rises (Wisconsin-style): flat up to a
    // threshold, then reduced by a fixed fraction of every dollar above it.
    if (config.deductionPhaseOut && stateStandardDeduction > 0) {
      const start = config.deductionPhaseOut.startIncome[filingStatus];
      const rate = config.deductionPhaseOut.ratePerDollar[filingStatus];
      if (start != null && rate != null) {
        const excess = Math.max(0, startingAmount - start);
        let phased = stateStandardDeduction - excess * rate;
        // A second, shallower line the schedule converges onto (Wisconsin HOH).
        const secondary = config.deductionPhaseOut.secondary?.[filingStatus];
        if (secondary) {
          phased = Math.max(phased, secondary.base - excess * secondary.ratePerDollar);
        }
        stateStandardDeduction = Math.max(0, phased);
      }
    }
  }

  // Personal exemptions. A scalar is per person (IN, MI, WV); the object form is
  // a per-return amount by filing status plus a separate per-dependent amount (MS).
  let personalExemptionTotal = 0;
  if (typeof config.personalExemption === "object") {
    const pe = config.personalExemption;
    personalExemptionTotal =
      (pe.byStatus[filingStatus] ?? 0) + (pe.perDependent ?? 0) * (dependents + otherDependents);
  } else if (config.personalExemption) {
    const filers = filingStatus === "mfj" ? 2 : 1;
    personalExemptionTotal = config.personalExemption * (filers + dependents + otherDependents);
  }

  // Combine standard deduction + personal exemptions for display and calculation
  const totalStateDeduction = stateStandardDeduction + personalExemptionTotal;
  const stateTaxableIncome = Math.max(0, startingAmount - totalStateDeduction);

  // Nonrefundable per-dependent credit, applied against the state tax rather
  // than against income. States that grant one typically allow no dependent
  // exemption, so the two are alternatives, not additive.
  let dependentCreditAmount = 0;
  if (config.dependentCredit) {
    const dc = config.dependentCredit;
    const gross = dependents * dc.perChild + otherDependents * dc.perOtherDependent;
    if (gross > 0) {
      const threshold = dc.phaseOutStart[filingStatus];
      const excess = threshold != null ? Math.max(0, agi - threshold) : 0;
      if (excess > dc.phaseOutFullyLostAbove) {
        dependentCreditAmount = 0;
      } else if (excess > 0) {
        const steps = Math.ceil(excess / dc.phaseOutStep);
        dependentCreditAmount = gross * Math.max(0, 1 - steps * dc.phaseOutRatePerStep);
      } else {
        dependentCreditAmount = gross;
      }
    }
  }
  const applyCredit = (tax: number) => Math.max(0, tax - dependentCreditAmount);

  if (config.type === "flat" && config.flatRate != null) {
    return {
      total: applyCredit(stateTaxableIncome * config.flatRate),
      rate: config.flatRate,
      stateName: config.name,
      stateStandardDeduction: totalStateDeduction,
      stateTaxableIncome,
    };
  }

  if (config.type === "progressive" && config.brackets) {
    const brackets = config.brackets[filingStatus];
    const result = walkBrackets(stateTaxableIncome, brackets);
    return {
      total: applyCredit(result.total),
      rate: null,
      stateName: config.name,
      stateStandardDeduction: totalStateDeduction,
      stateTaxableIncome,
    };
  }

  return { total: 0, rate: null, stateName: null, stateStandardDeduction: 0, stateTaxableIncome: 0 };
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
  additionalCredits: number = 0,
  taxClassification: TaxClassification | null = null,
  options: TaxEstimateOptions = {}
): FullTaxBreakdown {
  const {
    isSstb = false,
    businessW2Wages = 0,
    businessPropertyBasis = 0,
    taxpayerAge65 = false,
    taxpayerBlind = false,
    spouseAge65 = false,
    spouseBlind = false,
  } = options;
  // 0. Guard the free-text money inputs. A negative deduction would push taxable
  // income above AGI, and a negative credit would raise tax with no floor.
  const safeAdditionalDeductions = Math.max(0, additionalDeductions);
  const safeAdditionalCredits = Math.max(0, additionalCredits);
  const safeDependents = Math.max(0, Math.floor(dependents));
  const safeOtherDependents = Math.max(0, Math.floor(otherDependents));

  // 1. Classify income
  const sum = (rows: TaxIncomeSource[]) => rows.reduce((acc, s) => acc + s.amount, 0);

  // W-2 wages only (subject to FICA)
  const w2Income = sum(incomeSources.filter((s) => s.income_type === "w2" && !s.subject_to_se));
  const seIncome = sum(incomeSources.filter((s) => s.subject_to_se));
  const passiveIncome = sum(
    incomeSources.filter((s) => s.income_type === "k1" && !s.subject_to_se)
  );
  // Qualified dividends are ordinary income for AGI but taxed at the long-term
  // capital gain rates (IRC 1(h)(11)), so they are tracked separately.
  const qualifiedDividends = sum(
    incomeSources.filter((s) => s.income_type === "qualified_dividend" && !s.subject_to_se)
  );
  // Distributions from qualified plans and IRAs: ordinary rates, but excluded
  // from net investment income by IRC 1411(c)(5).
  const retirementIncome = sum(
    incomeSources.filter((s) => s.income_type === "retirement" && !s.subject_to_se)
  );
  // Remaining non-employment income: interest, ordinary dividends, royalties.
  const otherIncome = sum(
    incomeSources.filter(
      (s) =>
        s.income_type !== "w2" &&
        s.income_type !== "k1" &&
        s.income_type !== "qualified_dividend" &&
        s.income_type !== "retirement" &&
        !s.subject_to_se
    )
  );
  const totalIncome =
    w2Income + seIncome + passiveIncome + qualifiedDividends + retirementIncome + otherIncome;

  // 2. Net capital gains
  const capGains = netCapitalGains(capitalGainEntries, config.capitalLossLimit[filingStatus]);

  // 3. Payroll taxes.
  // The Social Security wage base is per individual (IRC 3121(a)(1)) and each
  // spouse files a separate Schedule SE, so a joint return must compute SS per
  // person rather than pooling both spouses against one base. Additional
  // Medicare is the opposite: Form 8959 applies one joint threshold to combined
  // earnings, so it is computed once on the total.
  const people: ReadonlyArray<"self" | "spouse"> =
    filingStatus === "mfj" ? ["self", "spouse"] : ["self"];
  const rowsFor = (who: "self" | "spouse") =>
    people.length === 1
      ? incomeSources
      : incomeSources.filter((s) => (s.taxpayer ?? "self") === who);

  let seSsTax = 0;
  let seMedicareTax = 0;
  let seNetEarnings = 0;
  let seDeductibleHalf = 0;
  let ficaSsTax = 0;
  let ficaMedicareTax = 0;

  for (const who of people) {
    const rows = rowsFor(who);
    const personW2 = sum(rows.filter((s) => s.income_type === "w2" && !s.subject_to_se));
    const personSe = sum(rows.filter((s) => s.subject_to_se));

    // Reuse the audited single-person helpers, then discard their Additional
    // Medicare component, which is re-derived below against the joint threshold.
    const personSeTax = calculateSelfEmploymentTax(personSe, personW2, filingStatus, config.seTax);
    const personFica = calculateFicaTax(personW2, personSe, filingStatus, config.ficaTax);

    seSsTax += personSeTax.ssTax;
    seMedicareTax += personSeTax.medicareTax;
    seNetEarnings += personSeTax.netSeIncome;
    seDeductibleHalf += personSeTax.deductibleHalf;
    ficaSsTax += personFica.ssTax;
    ficaMedicareTax += personFica.medicareTax;
  }

  const addlMedicareThreshold = config.seTax.additionalMedicareThreshold[filingStatus];
  const combinedEarnings = w2Income + seNetEarnings;
  const totalAdditionalMedicare =
    combinedEarnings > addlMedicareThreshold
      ? (combinedEarnings - addlMedicareThreshold) * config.seTax.additionalMedicareRate
      : 0;
  // Split for reporting: wages are reached before self-employment earnings.
  const w2AdditionalMedicare =
    w2Income > addlMedicareThreshold
      ? (w2Income - addlMedicareThreshold) * config.ficaTax.additionalMedicareRate
      : 0;
  const seAdditionalMedicare = Math.max(0, totalAdditionalMedicare - w2AdditionalMedicare);

  const seTax: SelfEmploymentTaxResult = {
    netSeIncome: seNetEarnings,
    ssTax: seSsTax,
    medicareTax: seMedicareTax,
    additionalMedicare: seAdditionalMedicare,
    total: seSsTax + seMedicareTax + seAdditionalMedicare,
    deductibleHalf: seDeductibleHalf,
  };
  const ficaTax: FicaTaxResult = {
    ssTax: ficaSsTax,
    medicareTax: ficaMedicareTax,
    additionalMedicare: w2AdditionalMedicare,
    total: ficaSsTax + ficaMedicareTax + w2AdditionalMedicare,
  };

  // 4. Gross income = all income + net capital gains (both ST and LT, if positive)
  // Per Form 1040: Schedule D result flows to Line 7, included in total income (Line 9)
  const netStGainForIncome = Math.max(0, capGains.netShortTerm);
  const netLtGainForIncome = Math.max(0, capGains.netLongTerm);
  const grossIncome = totalIncome + netStGainForIncome + netLtGainForIncome;

  // 5. AGI = gross income - half of SE tax - capital loss deduction
  // Capital loss deduction is the limited net loss (up to $3k/$1.5k) when gains are negative
  const agi = grossIncome - seTax.deductibleHalf - capGains.lossDeduction;

  // 6. QBI deduction
  // QBI eligibility is independent of SE tax: pass-through entities (incl. S Corps)
  // get QBI on their business income even when it isn't subject to SE tax.
  // C Corps are non-pass-through and never qualify. When no classification is set,
  // fall back to SE-subject income to preserve legacy estimates.
  const qbiPassThroughClassifications: TaxClassification[] = [
    "sole_prop",
    "disregarded",
    "partnership",
    "s_corp",
  ];
  let qbiBusinessIncome: number;
  if (taxClassification === "c_corp") {
    qbiBusinessIncome = 0;
  } else if (taxClassification && qbiPassThroughClassifications.includes(taxClassification)) {
    // K-1 income is pass-through business income and qualifies even when it is not
    // SE-taxed (an S Corp distribution, for example). A 1099 row only qualifies when
    // it is SE-subject: non-SE 1099 rows are interest and dividends, which
    // IRC 199A(c)(3)(B) excludes from QBI and which this engine already counts as
    // investment income for NIIT below.
    qbiBusinessIncome = incomeSources
      .filter((s) => s.income_type === "k1" || (s.income_type === "1099" && s.subject_to_se))
      .reduce((sum, s) => sum + s.amount, 0);
  } else {
    qbiBusinessIncome = seIncome;
  }
  const qbiEligibleIncome = Math.max(0, qbiBusinessIncome - seTax.deductibleHalf);
  const rawQbi = qbiEligibleIncome * config.qbi.rate;

  // IRC 63(f): an extra standard deduction per qualifying condition, and each
  // taxpayer can qualify twice (65 or older AND blind). The larger unmarried
  // amount applies to anyone who is not married and not a surviving spouse.
  const isMarriedForDeduction = filingStatus === "mfj" || filingStatus === "mfs";
  const agedBlindConditions =
    (taxpayerAge65 ? 1 : 0) +
    (taxpayerBlind ? 1 : 0) +
    (filingStatus === "mfj" ? (spouseAge65 ? 1 : 0) + (spouseBlind ? 1 : 0) : 0);
  const agedBlindPerCondition = isMarriedForDeduction
    ? config.additionalStandardDeduction.perCondition
    : config.additionalStandardDeduction.perConditionUnmarried;
  const additionalStandardDeduction = agedBlindConditions * agedBlindPerCondition;

  const standardDeduction =
    config.standardDeductions[filingStatus] + additionalStandardDeduction;
  const taxableIncomeBeforeQbi = Math.max(0, agi - standardDeduction - safeAdditionalDeductions);
  // IRC 199A(a)(1)(B) caps the deduction at 20% of (taxable income - net capital
  // gain). Net capital gain is defined by IRC 1222(11) as net long-term gain
  // over net short-term loss, so a net SHORT-term gain is ordinary income and
  // must not be subtracted. IRC 199A(e)(1) adds qualified dividends to it.
  const netCapGainForQbi = Math.max(0, capGains.netLongTerm) + Math.max(0, qualifiedDividends);
  const qbiTaxableIncomeCap = config.qbi.rate * Math.max(0, taxableIncomeBeforeQbi - netCapGainForQbi);

  const qbiThreshold = config.qbi.phaseOut[filingStatus];
  const qbiPhaseOutRange = config.qbi.phaseInRange[filingStatus];

  // IRC 199A keys the threshold to taxable income computed without regard to the
  // QBI deduction, not AGI. Using AGI would phase the deduction out roughly one
  // standard deduction too early and overstate the liability.
  const qbiPhaseOutBasis = taxableIncomeBeforeQbi;

  // Above the threshold the statute splits: a specified service business loses
  // the deduction outright (IRC 199A(d)(3)), while any other business is instead
  // limited to the greater of 50% of its W-2 wages, or 25% of wages plus 2.5% of
  // the unadjusted basis of qualified property (IRC 199A(b)(2)(B)). Both phase
  // in linearly across the range. Treating every business as an SSTB, as this
  // did before, zeroed deductions that were actually allowable.
  const overThreshold = Math.max(0, qbiPhaseOutBasis - qbiThreshold);
  const phaseInRatio =
    overThreshold <= 0
      ? 0
      : qbiPhaseOutRange > 0
        ? Math.min(1, overThreshold / qbiPhaseOutRange)
        : 1;

  let qbiAfterPhaseOut: number;
  if (overThreshold <= 0) {
    qbiAfterPhaseOut = rawQbi;
  } else if (isSstb) {
    qbiAfterPhaseOut = rawQbi * (1 - phaseInRatio);
  } else {
    const wageAndPropertyLimit = Math.max(
      0.5 * Math.max(0, businessW2Wages),
      0.25 * Math.max(0, businessW2Wages) + 0.025 * Math.max(0, businessPropertyBasis)
    );
    const excessOverLimit = Math.max(0, rawQbi - wageAndPropertyLimit);
    qbiAfterPhaseOut = rawQbi - excessOverLimit * phaseInRatio;
  }

  const qbiDeduction = Math.max(0, Math.min(qbiAfterPhaseOut, qbiTaxableIncomeCap));

  // 7. Taxable income.
  // totalDeductions is the AGI-to-taxable-income bridge, so it holds below-the-line
  // items only. The SE deduction is an above-the-line adjustment already reflected
  // in AGI and including it here would double-count it in the displayed breakdown.
  const totalDeductions = standardDeduction + qbiDeduction + safeAdditionalDeductions;
  const taxableIncome = Math.max(0, agi - totalDeductions);

  // 8. Ordinary taxable income = taxable income minus net LTCG (if positive).
  // Per the Qualified Dividends and Capital Gain Tax Worksheet line 12, the amount
  // taxed at preferential rates is the SMALLER of taxable income or net capital
  // gain. Without the cap, deductions that exceed ordinary income are discarded
  // instead of reducing the preferentially-taxed amount.
  // Qualified dividends ride the same preferential brackets as long-term gains
  // (IRC 1(h)(11)), so they join net capital gain on worksheet line 6.
  const preferentialIncome = Math.max(0, capGains.netLongTerm) + Math.max(0, qualifiedDividends);
  const ltcgForTax = Math.min(preferentialIncome, taxableIncome);
  const ordinaryTaxableIncome = Math.max(0, taxableIncome - ltcgForTax);

  // 9. Federal income tax on ordinary income
  const federalTax = calculateFederalTax(ordinaryTaxableIncome, config.federalBrackets[filingStatus]);

  // 10. LTCG tax (stacked)
  const ltcgTax = calculateLTCGTax(ltcgForTax, ordinaryTaxableIncome, config.ltcgBrackets[filingStatus]);

  // 11. NIIT: 3.8% on lesser of (net investment income, MAGI - threshold).
  // Form 8960 line 5a reports the net gain or loss as it appears on Form 1040
  // line 7, which can be negative, so the allowed capital loss reduces net
  // investment income rather than being floored away.
  const niitThreshold = config.niit.threshold[filingStatus];
  const netCapitalComponent =
    Math.max(0, capGains.netShortTerm) +
    Math.max(0, capGains.netLongTerm) -
    capGains.lossDeduction;
  // K-1 income from a business the taxpayer materially participates in is NOT
  // net investment income (Reg. 1.1411-4(b)). An S corp shareholder-employee's
  // ordinary income is the classic case: neither SE-taxed nor subject to NIIT.
  // Retirement distributions are excluded outright by IRC 1411(c)(5), so they
  // never appear here.
  const passiveIncomeForNiit = sum(
    incomeSources.filter(
      (s) => s.income_type === "k1" && !s.subject_to_se && !s.materially_participates
    )
  );
  const netInvestmentIncome = Math.max(
    0,
    netCapitalComponent +
      Math.max(0, passiveIncomeForNiit) +
      Math.max(0, qualifiedDividends) +
      Math.max(0, otherIncome)
  );
  const niit =
    agi > niitThreshold
      ? config.niit.rate * Math.min(netInvestmentIncome, agi - niitThreshold)
      : 0;

  // 12. State tax (uses AGI + state's own standard deduction, not federal taxable income)
  const stateResult = calculateStateTax(
    agi,
    taxableIncome,
    stateCode,
    filingStatus,
    standardDeduction,
    safeDependents,
    safeOtherDependents,
    config.year,
    // Gains already included in federal income, split because states differ on
    // whether an exclusion covers all gain or long-term only.
    netStGainForIncome,
    netLtGainForIncome
  );
  const stateTax = stateResult.total;

  // 12b. Section 24 credits (child + other dependent).
  // Schedule 8812 applies ONE phase-out reduction to the COMBINED credit
  // (line 8 minus line 11), not a separate full reduction to each. IRC 24(b)(2)
  // reduces "the aggregate amount of credits allowable under subsection (a)".
  const ctcConfig = config.childTaxCredit;
  const maxChildCredit = safeDependents * ctcConfig.perChild;
  const maxOtherDependentCredit = safeOtherDependents * config.otherDependentCredit.perDependent;
  const section24Excess = Math.max(0, agi - ctcConfig.phaseOutStart[filingStatus]);
  // Reduced by $50 for each $1,000 (or fraction) of AGI over the threshold.
  const section24Reduction = Math.ceil(section24Excess / 1000) * 50;
  const section24AfterPhaseOut = Math.max(
    0,
    maxChildCredit + maxOtherDependentCredit - section24Reduction
  );

  // Nonrefundable: limited to income tax before other credits. Allocated to the
  // child credit first, since only that portion has a refundable counterpart.
  const nonRefundableRoom = federalTax.total + ltcgTax.total;
  const section24Allowed = Math.min(section24AfterPhaseOut, nonRefundableRoom);
  const childTaxCredit = Math.min(section24Allowed, maxChildCredit);
  const otherDependentCredit = section24Allowed - childTaxCredit;

  // 12c. Refundable Additional Child Tax Credit (IRC 24(d), Schedule 8812 part II):
  // 15% of earned income over the floor, capped per child and by the unused
  // nonrefundable child credit.
  const earnedIncome = w2Income + Math.max(0, seIncome);
  const childCreditAfterPhaseOut = Math.min(section24AfterPhaseOut, maxChildCredit);
  const additionalChildTaxCredit = Math.max(
    0,
    Math.min(
      childCreditAfterPhaseOut - childTaxCredit,
      safeDependents * ctcConfig.refundablePerChild,
      ACTC_EARNED_INCOME_RATE * Math.max(0, earnedIncome - ACTC_EARNED_INCOME_FLOOR)
    )
  );

  // 12d. Additional tax credits (user-entered, nonrefundable)
  const cappedAdditionalCredits = Math.min(
    safeAdditionalCredits,
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
  // Employee-side SS (6.2%) and Medicare (1.45%) on W-2 wages are mandatorily
  // withheld by the employer at payroll time and remitted on Form 941, so they
  // are auto-credited as paid here.
  //
  // Additional Medicare (0.9%) is per-source. Employers withhold at a flat
  // single-employer threshold (IRC §3101(b)(2), filing-status-independent).
  // The 1040 reconciles to the filer's actual filing-status threshold on
  // Form 8959, so we credit the employer-withheld portion only; any
  // difference (multi-job aggregation, MFS thresholds, MFJ joint threshold)
  // stays in liability for filing-time reconciliation.
  const w2Sources = incomeSources.filter((s) => s.income_type === "w2" && !s.subject_to_se);
  const employerAddlMedicareThreshold =
    config.payrollFica.additional_medicare_threshold;
  const additionalMedicareEmployerWithheld = w2Sources.reduce(
    (sum, src) =>
      sum +
      Math.max(0, src.amount - employerAddlMedicareThreshold) *
        config.ficaTax.additionalMedicareRate,
    0
  );

  // Social Security is withheld by each employer independently, capped at the
  // wage base per job. With two jobs each under the base, more is withheld than
  // is owed, and the excess is a refundable credit (IRC 31(b), Schedule 3
  // line 11). Crediting the liability figure instead would silently swallow it.
  const socialSecurityWithheld = w2Sources.reduce(
    (sum, src) =>
      sum + Math.min(Math.max(0, src.amount), config.ficaTax.ssWageBase) * config.ficaTax.ssRate,
    0
  );
  const excessSocialSecurityWithheld = Math.max(0, socialSecurityWithheld - ficaTax.ssTax);

  const ficaAutoCredited =
    socialSecurityWithheld + ficaTax.medicareTax + additionalMedicareEmployerWithheld;
  const totalFederalPaid =
    paymentEntries
      .filter((p) => p.type === "federal")
      .reduce((sum, p) => sum + p.amount, 0) +
    ficaAutoCredited +
    additionalChildTaxCredit;
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
    otherIncome,
    capitalGains: capGains,
    selfEmploymentTax: seTax,
    ficaTax,
    grossIncome,
    agi,
    standardDeduction,
    seDeduction: seTax.deductibleHalf,
    qbiDeduction,
    additionalDeductions: safeAdditionalDeductions,
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
      stateStandardDeduction: stateResult.stateStandardDeduction,
      stateTaxableIncome: stateResult.stateTaxableIncome,
    },
    childTaxCredit,
    otherDependentCredit,
    additionalCredits: cappedAdditionalCredits,
    totalCredits,
    federalTaxAfterCredits,
    additionalChildTaxCredit,
    totalLiability,
    federalLiability,
    stateLiability,
    ficaAutoCredited,
    excessSocialSecurityWithheld,
    totalFederalPaid,
    totalStatePaid,
    totalPaid,
    netRemaining,
    federalRemaining,
    stateRemaining,
  };
}
