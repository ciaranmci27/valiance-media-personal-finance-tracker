/**
 * Tax year 2026 defaults.
 *
 * Single source of truth for 2026 federal constants used by both the estimator
 * and payroll. When the IRS publishes new values, update this file.
 *
 * Sources:
 * - Standard deductions, 1040 brackets, LTCG, QBI, CTC: Rev. Proc. 2025-32
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

  // Rev. Proc. 2025-32 sec. 4.14(3): $1,650, increased to $2,050 if the
  // individual is also unmarried and not a surviving spouse.
  additionalStandardDeduction: {
    perCondition: 1650,
    perConditionUnmarried: 2050,
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
      { rate: 0.00, upTo: 49450 },
      { rate: 0.15, upTo: 545500 },
      { rate: 0.20, upTo: Infinity },
    ],
    mfj: [
      { rate: 0.00, upTo: 98900 },
      { rate: 0.15, upTo: 613700 },
      { rate: 0.20, upTo: Infinity },
    ],
    mfs: [
      { rate: 0.00, upTo: 49450 },
      { rate: 0.15, upTo: 306850 },
      { rate: 0.20, upTo: Infinity },
    ],
    hoh: [
      { rate: 0.00, upTo: 66200 },
      { rate: 0.15, upTo: 579600 },
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
    // Rev. Proc. 2025-32 sec. 4.26. Note these do NOT track the top of the 24%
    // bracket the way the 2025 figures did, so they must be read from the
    // Revenue Procedure directly rather than derived.
    phaseOut: {
      single: 201750,
      mfj: 403500,
      mfs: 201775,
      hoh: 201750,
    },
    // Published phase-in range amounts are 553,500 (MFJ), 276,775 (MFS) and
    // 276,750 (all others). OBBBA widened these to 150k/75k for 2026.
    phaseInRange: {
      single: 75000,
      mfj: 150000,
      mfs: 75000,
      hoh: 75000,
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
    // Rev. Proc. 2025-32 sec. 4.05: maximum credit $2,200, refundable portion $1,700.
    perChild: 2200,
    refundablePerChild: 1700,
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
