/**
 * Tax year 2025 defaults.
 *
 * Historical values. Should not change once filing season closes.
 *
 * Sources:
 * - Standard deductions, 1040 brackets, LTCG: Rev. Proc. 2024-40
 *   (with OBBBA amendments for 2025 std deductions)
 * - SS wage base: $176,100 (SSA 2024 COLA fact sheet)
 * - FUTA: 6.0% on first $7,000
 */

import type { TaxYearDefaults } from "../types";

export const TAX_YEAR_2025: TaxYearDefaults = {
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

  payrollFica: {
    ss_rate: 0.062,
    ss_wage_base: 176100,
    medicare_rate: 0.0145,
    additional_medicare_rate: 0.009,
    additional_medicare_threshold: 200000,
  },

  payrollFuta: {
    rate: 0.006,
    wage_base: 7000,
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
};
