/**
 * Tax year 2026 defaults.
 *
 * Single source of truth for 2026 federal constants used by both the estimator
 * and payroll. When the IRS publishes new values, update this file.
 *
 * Sources:
 * - Standard deductions, 1040 brackets, LTCG: Rev. Proc. 2025-38
 * - SS wage base: SSA 2025 COLA fact sheet (2026 base = $184,500)
 * - FUTA: 6.0% on first $7,000 (stable)
 * - FICA rates: IRC §§ 3101(a)/(b), 3111(a)/(b)
 * - Additional Medicare: 0.9% employee-only, employer withholds at flat
 *   $200,000 (regardless of filing status) per IRC § 3101(b)(2); 1040
 *   reconciliation uses per-status thresholds from IRC § 1411(b).
 */

import type { TaxYearDefaults } from "../types";

export const TAX_YEAR_2026: TaxYearDefaults = {
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

  // Pub 15-T percentage method tables (pub15T) are not yet populated.
  // Payroll reads withholding brackets from its DB config; admin-entered
  // values take precedence regardless.

  seTax: {
    rate: 0.153,
    ssRate: 0.124,
    medicareRate: 0.029,
    selfEmploymentFactor: 0.9235,
    ssWageBase: 184500,
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
    ssWageBase: 184500,
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
    ss_wage_base: 184500,
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
