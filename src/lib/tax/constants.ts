/**
 * Tax constants for the tax estimator.
 * Each tax year has its own config with brackets, deductions, and thresholds.
 */

export type FilingStatus = "single" | "mfj" | "mfs" | "hoh";

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  mfj: "Married Filing Jointly",
  mfs: "Married Filing Separately",
  hoh: "Head of Household",
};

export interface TaxBracket {
  rate: number;
  upTo: number; // Infinity for the top bracket
}

export interface TaxYearConfig {
  year: number;
  standardDeductions: Record<FilingStatus, number>;
  federalBrackets: Record<FilingStatus, TaxBracket[]>;
  ltcgBrackets: Record<FilingStatus, TaxBracket[]>;
  seTax: {
    rate: number; // 15.3%
    ssRate: number; // 12.4%
    medicareRate: number; // 2.9%
    selfEmploymentFactor: number; // 92.35%
    ssWageBase: number;
    additionalMedicareRate: number; // 0.9%
    additionalMedicareThreshold: Record<FilingStatus, number>;
  };
  ficaTax: {
    ssRate: number; // 0.062 (employee 6.2%)
    medicareRate: number; // 0.0145 (employee 1.45%)
    ssWageBase: number; // shared with SE
    additionalMedicareRate: number; // 0.009
    additionalMedicareThreshold: Record<FilingStatus, number>;
  };
  qbi: {
    rate: number; // 20%
    phaseOut: Record<FilingStatus, number>;
  };
  niit: {
    rate: number; // 3.8%
    threshold: Record<FilingStatus, number>;
  };
  childTaxCredit: {
    perChild: number; // $2,000
    phaseOutStart: Record<FilingStatus, number>;
    phaseOutRate: number; // $50 per $1,000 over threshold
  };
  otherDependentCredit: {
    perDependent: number; // $500
  };
  capitalLossLimit: Record<FilingStatus, number>;
}

const TAX_YEARS: Record<number, TaxYearConfig> = {
  2026: {
    year: 2026,
    standardDeductions: {
      single: 16100,
      mfj: 32200,
      mfs: 16100,
      hoh: 24150,
    },
    federalBrackets: {
      single: [
        { rate: 0.10, upTo: 12400 },
        { rate: 0.12, upTo: 50400 },
        { rate: 0.22, upTo: 105700 },
        { rate: 0.24, upTo: 201775 },
        { rate: 0.32, upTo: 256225 },
        { rate: 0.35, upTo: 640600 },
        { rate: 0.37, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.10, upTo: 24800 },
        { rate: 0.12, upTo: 100800 },
        { rate: 0.22, upTo: 211400 },
        { rate: 0.24, upTo: 403550 },
        { rate: 0.32, upTo: 512450 },
        { rate: 0.35, upTo: 768700 },
        { rate: 0.37, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.10, upTo: 12400 },
        { rate: 0.12, upTo: 50400 },
        { rate: 0.22, upTo: 105700 },
        { rate: 0.24, upTo: 201775 },
        { rate: 0.32, upTo: 256225 },
        { rate: 0.35, upTo: 384350 },
        { rate: 0.37, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.10, upTo: 17700 },
        { rate: 0.12, upTo: 67450 },
        { rate: 0.22, upTo: 105700 },
        { rate: 0.24, upTo: 201750 },
        { rate: 0.32, upTo: 256200 },
        { rate: 0.35, upTo: 640600 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
    ltcgBrackets: {
      single: [
        { rate: 0.00, upTo: 48350 },
        { rate: 0.15, upTo: 533400 },
        { rate: 0.20, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.00, upTo: 96700 },
        { rate: 0.15, upTo: 600050 },
        { rate: 0.20, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.00, upTo: 48350 },
        { rate: 0.15, upTo: 300025 },
        { rate: 0.20, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.00, upTo: 64750 },
        { rate: 0.15, upTo: 566700 },
        { rate: 0.20, upTo: Infinity },
      ],
    },
    seTax: {
      rate: 0.153,
      ssRate: 0.124,
      medicareRate: 0.029,
      selfEmploymentFactor: 0.9235,
      ssWageBase: 176100,
      additionalMedicareRate: 0.009,
      additionalMedicareThreshold: {
        single: 200000,
        mfj: 250000,
        mfs: 125000,
        hoh: 200000,
      },
    },
    ficaTax: {
      ssRate: 0.062,
      medicareRate: 0.0145,
      ssWageBase: 176100,
      additionalMedicareRate: 0.009,
      additionalMedicareThreshold: {
        single: 200000,
        mfj: 250000,
        mfs: 125000,
        hoh: 200000,
      },
    },
    qbi: {
      rate: 0.20,
      phaseOut: {
        single: 202550,
        mfj: 405100,
        mfs: 202550,
        hoh: 202550,
      },
    },
    niit: {
      rate: 0.038,
      threshold: {
        single: 200000,
        mfj: 250000,
        mfs: 125000,
        hoh: 200000,
      },
    },
    childTaxCredit: {
      perChild: 2000,
      phaseOutStart: {
        single: 200000,
        mfj: 400000,
        mfs: 200000,
        hoh: 200000,
      },
      phaseOutRate: 0.05, // $50 per $1,000 = 5%
    },
    otherDependentCredit: {
      perDependent: 500,
    },
    capitalLossLimit: {
      single: 3000,
      mfj: 3000,
      mfs: 1500,
      hoh: 3000,
    },
  },
  2025: {
    year: 2025,
    standardDeductions: {
      single: 15750,
      mfj: 31500,
      mfs: 15750,
      hoh: 23625,
    },
    federalBrackets: {
      single: [
        { rate: 0.10, upTo: 11925 },
        { rate: 0.12, upTo: 48475 },
        { rate: 0.22, upTo: 103350 },
        { rate: 0.24, upTo: 197300 },
        { rate: 0.32, upTo: 250525 },
        { rate: 0.35, upTo: 626350 },
        { rate: 0.37, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.10, upTo: 23850 },
        { rate: 0.12, upTo: 96950 },
        { rate: 0.22, upTo: 206700 },
        { rate: 0.24, upTo: 394600 },
        { rate: 0.32, upTo: 501050 },
        { rate: 0.35, upTo: 751600 },
        { rate: 0.37, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.10, upTo: 11925 },
        { rate: 0.12, upTo: 48475 },
        { rate: 0.22, upTo: 103350 },
        { rate: 0.24, upTo: 197300 },
        { rate: 0.32, upTo: 250525 },
        { rate: 0.35, upTo: 375800 },
        { rate: 0.37, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.10, upTo: 17000 },
        { rate: 0.12, upTo: 64850 },
        { rate: 0.22, upTo: 103350 },
        { rate: 0.24, upTo: 197300 },
        { rate: 0.32, upTo: 250525 },
        { rate: 0.35, upTo: 626350 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
    ltcgBrackets: {
      single: [
        { rate: 0.00, upTo: 48350 },
        { rate: 0.15, upTo: 533400 },
        { rate: 0.20, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.00, upTo: 96700 },
        { rate: 0.15, upTo: 600050 },
        { rate: 0.20, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.00, upTo: 48350 },
        { rate: 0.15, upTo: 300025 },
        { rate: 0.20, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.00, upTo: 64750 },
        { rate: 0.15, upTo: 566700 },
        { rate: 0.20, upTo: Infinity },
      ],
    },
    seTax: {
      rate: 0.153,
      ssRate: 0.124,
      medicareRate: 0.029,
      selfEmploymentFactor: 0.9235,
      ssWageBase: 176100,
      additionalMedicareRate: 0.009,
      additionalMedicareThreshold: {
        single: 200000,
        mfj: 250000,
        mfs: 125000,
        hoh: 200000,
      },
    },
    ficaTax: {
      ssRate: 0.062,
      medicareRate: 0.0145,
      ssWageBase: 176100,
      additionalMedicareRate: 0.009,
      additionalMedicareThreshold: {
        single: 200000,
        mfj: 250000,
        mfs: 125000,
        hoh: 200000,
      },
    },
    qbi: {
      rate: 0.20,
      phaseOut: {
        single: 197300,
        mfj: 394600,
        mfs: 197300,
        hoh: 197300,
      },
    },
    niit: {
      rate: 0.038,
      threshold: {
        single: 200000,
        mfj: 250000,
        mfs: 125000,
        hoh: 200000,
      },
    },
    childTaxCredit: {
      perChild: 2000,
      phaseOutStart: {
        single: 200000,
        mfj: 400000,
        mfs: 200000,
        hoh: 200000,
      },
      phaseOutRate: 0.05,
    },
    otherDependentCredit: {
      perDependent: 500,
    },
    capitalLossLimit: {
      single: 3000,
      mfj: 3000,
      mfs: 1500,
      hoh: 3000,
    },
  },
};

export function getAvailableTaxYears(): number[] {
  return Object.keys(TAX_YEARS)
    .map(Number)
    .sort((a, b) => b - a);
}

export function getTaxYearConfig(year: number): TaxYearConfig | undefined {
  return TAX_YEARS[year];
}
