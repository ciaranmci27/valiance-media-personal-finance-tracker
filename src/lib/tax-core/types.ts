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
  /** Per-person personal exemption amount (filers + dependents). */
  personalExemption?: number;
}

// ============================================================================
// Year defaults (single source of truth per tax year)
// ============================================================================

export interface TaxYearDefaults {
  year: number;

  standardDeductions: Record<FilingStatus, number>;

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
    phaseOut: Record<FilingStatus, number>;
  };

  niit: {
    rate: number;
    threshold: Record<FilingStatus, number>;
  };

  childTaxCredit: {
    perChild: number;
    phaseOutStart: Record<FilingStatus, number>;
    phaseOutRate: number;
  };

  otherDependentCredit: {
    perDependent: number;
  };

  capitalLossLimit: Record<FilingStatus, number>;
}
