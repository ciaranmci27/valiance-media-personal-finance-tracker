/**
 * Shared tax types for estimator + payroll.
 *
 * Single source of truth. Estimator and payroll are independent consumers;
 * neither feature requires the other to function.
 */

// ============================================================================
// Filing status
// ============================================================================

export type FilingStatus = "single" | "mfj" | "mfs" | "hoh";

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  mfj: "Married Filing Jointly",
  mfs: "Married Filing Separately",
  hoh: "Head of Household",
};

// ============================================================================
// Bracket shapes
// ============================================================================

/**
 * 1040 annual bracket shape used by the tax estimator.
 * Cumulative thresholds; the last bracket uses `upTo: Infinity`.
 */
export interface TaxBracket {
  rate: number;
  upTo: number;
}

/**
 * IRS Pub 15-T percentage method bracket used by payroll withholding.
 * These tables are per pay-period (annual/monthly/biweekly/weekly/semimonthly)
 * and carry a precomputed base_tax for the bracket floor.
 */
export interface Pub15TBracket {
  min: number;
  max: number | null;
  rate: number;
  base_tax: number;
}

export interface Pub15TBracketsByStatus {
  single: Pub15TBracket[];
  mfj: Pub15TBracket[];
  mfs: Pub15TBracket[];
  hoh: Pub15TBracket[];
}

export type Pub15TPeriod =
  | "annual"
  | "monthly"
  | "semimonthly"
  | "biweekly"
  | "weekly";

export interface Pub15TTable {
  period: Pub15TPeriod;
  source: string;
  w4_step2_unchecked: Pub15TBracketsByStatus;
  w4_step2_checked?: Pub15TBracketsByStatus;
}

// ============================================================================
// Payroll-shaped federal defaults (mirror payroll DB JSONB shape)
// ============================================================================

export interface PayrollFicaDefaults {
  ss_rate: number;
  ss_wage_base: number;
  medicare_rate: number;
  additional_medicare_rate: number;
  /** Flat withholding threshold used by employers (not per-status). */
  additional_medicare_threshold: number;
}

export interface PayrollFutaDefaults {
  rate: number;
  wage_base: number;
}

export interface PayrollStdDeductions {
  single: number;
  mfj: number;
  mfs: number;
  hoh: number;
}

// ============================================================================
// State tax (shared; estimator consumes directly)
// ============================================================================

export interface StateTaxConfig {
  code: string;
  name: string;
  type: "none" | "flat" | "progressive";
  flatRate?: number;
  brackets?: Record<FilingStatus, TaxBracket[]>;
  /** Whether the state starts from Federal AGI or Federal Taxable Income. Default: "agi" */
  startingPoint?: "agi" | "federal_taxable";
  /** State standard deduction. "federal" = use federal amounts. Object = state-specific amounts. Omit = no deduction. */
  deduction?:
    | "federal"
    | Partial<Record<FilingStatus, number>>
    | {
        type: "pct_of_agi";
        rate: number;
        min: Partial<Record<FilingStatus, number>>;
        max: Partial<Record<FilingStatus, number>>;
      };
  /**
   * State personal exemption, which reduces taxable income.
   *
   * A plain number is a PER-PERSON amount, multiplied by filers plus dependents
   * (Indiana, Michigan, West Virginia). Some states instead set a per-return
   * amount that varies by filing status and add a separate per-dependent
   * amount, which is what the object form expresses (Mississippi).
   */
  personalExemption?:
    | number
    | {
        byStatus: Partial<Record<FilingStatus, number>>;
        perDependent?: number;
      };
  /**
   * Portion of capital gain the state excludes from income.
   *
   * Missouri excludes 100% of ALL capital gain for individuals from TY2025;
   * North Dakota excludes 40% of net LONG-TERM gain only. The base matters, so
   * it is explicit rather than assumed.
   */
  capitalGainsExclusion?: {
    /** Fraction excluded, 0 to 1. */
    pct: number;
    appliesTo: "all" | "longTerm";
  };
  /**
   * Standard deduction that shrinks as income rises, rather than a fixed amount.
   *
   * Wisconsin is the clearest case: flat up to a threshold, then falling by a
   * fixed fraction of every dollar above it until it reaches zero. Applying the
   * maximum at every income level understates tax materially.
   */
  deductionPhaseOut?: {
    /** Income above which the deduction begins to shrink. */
    startIncome: Partial<Record<FilingStatus, number>>;
    /** Reduction per dollar of income above `startIncome`. */
    ratePerDollar: Partial<Record<FilingStatus, number>>;
    /**
     * Optional second linear segment; the deduction is the GREATER of the two.
     * Wisconsin's head-of-household schedule starts on a steeper slope and then
     * converges onto the single-filer line, which one slope cannot express.
     */
    secondary?: Partial<Record<FilingStatus, { base: number; ratePerDollar: number }>>;
  };
  /**
   * Nonrefundable per-dependent credit applied against the state tax.
   *
   * Distinct from `personalExemption`, which reduces taxable income. Arizona,
   * for example, allows no dependent exemption at all and instead grants a
   * credit of $100 per dependent under 17 and $25 per older dependent.
   */
  dependentCredit?: {
    perChild: number;
    perOtherDependent: number;
    /** Credit phases out above this federal AGI, by filing status. */
    phaseOutStart: Partial<Record<FilingStatus, number>>;
    /** Credit is reduced by this fraction for each `phaseOutStep` (or part) of excess AGI. */
    phaseOutRatePerStep: number;
    phaseOutStep: number;
    /** Excess AGI above this eliminates the credit entirely. */
    phaseOutFullyLostAbove: number;
  };
}

// ============================================================================
// Year defaults (single source of truth per tax year)
// ============================================================================

export interface TaxYearDefaults {
  year: number;

  standardDeductions: Record<FilingStatus, number>;

  /**
   * IRC 63(f) additional standard deduction for the aged and the blind. Each
   * taxpayer may qualify twice (65 or older AND blind).
   */
  additionalStandardDeduction: {
    /** Per qualifying condition, married filers and surviving spouses. */
    perCondition: number;
    /** Higher amount when unmarried and not a surviving spouse. */
    perConditionUnmarried: number;
  };

  /** IRS 1040 annual brackets used by the estimator. */
  federalBrackets: Record<FilingStatus, TaxBracket[]>;

  /** Long-term capital gains brackets. */
  ltcgBrackets: Record<FilingStatus, TaxBracket[]>;

  /**
   * IRS Pub 15-T percentage method withholding tables.
   * Optional; payroll may fall back to computing from annual brackets.
   */
  pub15T?: Pub15TTable;

  seTax: {
    rate: number;
    ssRate: number;
    medicareRate: number;
    selfEmploymentFactor: number;
    ssWageBase: number;
    additionalMedicareRate: number;
    additionalMedicareThreshold: Record<FilingStatus, number>;
  };

  /** Estimator-style FICA (per-status Additional Medicare threshold for 1040 reconciliation). */
  ficaTax: {
    ssRate: number;
    medicareRate: number;
    ssWageBase: number;
    additionalMedicareRate: number;
    additionalMedicareThreshold: Record<FilingStatus, number>;
  };

  /** Payroll-style FICA defaults (flat Additional Medicare threshold per IRS employer rules). */
  payrollFica: PayrollFicaDefaults;

  payrollFuta: PayrollFutaDefaults;

  qbi: {
    rate: number;
    /** IRC 199A(e)(2) threshold amount, keyed to taxable income before the QBI deduction. */
    phaseOut: Record<FilingStatus, number>;
    /**
     * Width of the IRC 199A(b)(3)(B) phase-in range, i.e. the published
     * "phase-in range amount" minus the threshold amount. OBBBA widened this
     * from 50,000/100,000 (2025) to 75,000/150,000 (2026), so it has to vary
     * by year rather than being hardcoded in the engine.
     */
    phaseInRange: Record<FilingStatus, number>;
  };

  niit: {
    rate: number;
    threshold: Record<FilingStatus, number>;
  };

  childTaxCredit: {
    perChild: number;
    /** IRC 24(d)(1)(A) refundable cap per qualifying child (the ACTC). */
    refundablePerChild: number;
    phaseOutStart: Record<FilingStatus, number>;
    phaseOutRate: number;
  };

  otherDependentCredit: {
    perDependent: number;
  };

  capitalLossLimit: Record<FilingStatus, number>;
}
