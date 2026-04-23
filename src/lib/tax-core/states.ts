/**
 * US state income tax data for all 50 states + DC.
 *
 * Consumed by the tax estimator directly. Payroll stores state config in the
 * database (admin-editable with audit trail), so state data here is reference
 * material rather than a default source for payroll.
 */

import type { StateTaxConfig } from "./types";

// All 50 states + DC
export const STATE_TAX_DATA: Record<string, StateTaxConfig> = {
  // No income tax states
  AK: { code: "AK", name: "Alaska", type: "none" },
  FL: { code: "FL", name: "Florida", type: "none" },
  NV: { code: "NV", name: "Nevada", type: "none" },
  NH: { code: "NH", name: "New Hampshire", type: "none" },
  SD: { code: "SD", name: "South Dakota", type: "none" },
  TN: { code: "TN", name: "Tennessee", type: "none" },
  TX: { code: "TX", name: "Texas", type: "none" },
  WA: { code: "WA", name: "Washington", type: "none" },
  WY: { code: "WY", name: "Wyoming", type: "none" },

  // Flat tax states
  AZ: { code: "AZ", name: "Arizona", type: "flat", flatRate: 0.025, deduction: "federal" },
  CO: { code: "CO", name: "Colorado", type: "flat", flatRate: 0.044, startingPoint: "federal_taxable" },
  GA: { code: "GA", name: "Georgia", type: "flat", flatRate: 0.0519, deduction: { single: 12000, mfj: 24000, mfs: 12000, hoh: 12000 } },
  ID: { code: "ID", name: "Idaho", type: "flat", flatRate: 0.058, startingPoint: "federal_taxable" },
  IL: { code: "IL", name: "Illinois", type: "flat", flatRate: 0.0495 },
  IN: { code: "IN", name: "Indiana", type: "flat", flatRate: 0.0305, personalExemption: 1000 },
  IA: { code: "IA", name: "Iowa", type: "flat", flatRate: 0.038, deduction: "federal" },
  KY: { code: "KY", name: "Kentucky", type: "flat", flatRate: 0.04, deduction: { single: 3270, mfj: 6540, mfs: 3270, hoh: 3270 } },
  MI: { code: "MI", name: "Michigan", type: "flat", flatRate: 0.0425, personalExemption: 5800 },
  MS: { code: "MS", name: "Mississippi", type: "flat", flatRate: 0.044, deduction: { single: 2300, mfj: 4600, mfs: 2300, hoh: 3400 } },
  NC: { code: "NC", name: "North Carolina", type: "flat", flatRate: 0.0425, deduction: { single: 12750, mfj: 25500, mfs: 12750, hoh: 19125 } },
  PA: { code: "PA", name: "Pennsylvania", type: "flat", flatRate: 0.0307 },
  UT: { code: "UT", name: "Utah", type: "flat", flatRate: 0.0465 },

  // Progressive tax states
  AL: {
    code: "AL", name: "Alabama", type: "progressive",
    deduction: { single: 3000, mfj: 8500, mfs: 3750, hoh: 4700 },
    brackets: {
      single: [
        { rate: 0.02, upTo: 500 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.05, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.02, upTo: 1000 },
        { rate: 0.04, upTo: 6000 },
        { rate: 0.05, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.02, upTo: 500 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.05, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.02, upTo: 500 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.05, upTo: Infinity },
      ],
    },
  },
  AR: {
    code: "AR", name: "Arkansas", type: "progressive",
    deduction: { single: 2410, mfj: 4820, mfs: 2410, hoh: 2410 },
    brackets: {
      single: [
        { rate: 0.02, upTo: 4400 },
        { rate: 0.04, upTo: 8800 },
        { rate: 0.044, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.02, upTo: 4400 },
        { rate: 0.04, upTo: 8800 },
        { rate: 0.044, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.02, upTo: 4400 },
        { rate: 0.04, upTo: 8800 },
        { rate: 0.044, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.02, upTo: 4400 },
        { rate: 0.04, upTo: 8800 },
        { rate: 0.044, upTo: Infinity },
      ],
    },
  },
  CA: {
    code: "CA", name: "California", type: "progressive",
    deduction: { single: 5706, mfj: 11412, mfs: 5706, hoh: 11412 },
    brackets: {
      single: [
        { rate: 0.01, upTo: 10412 },
        { rate: 0.02, upTo: 24684 },
        { rate: 0.04, upTo: 38959 },
        { rate: 0.06, upTo: 54081 },
        { rate: 0.08, upTo: 68350 },
        { rate: 0.093, upTo: 349137 },
        { rate: 0.103, upTo: 418961 },
        { rate: 0.113, upTo: 698271 },
        { rate: 0.123, upTo: 1000000 },
        { rate: 0.133, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.01, upTo: 20824 },
        { rate: 0.02, upTo: 49368 },
        { rate: 0.04, upTo: 77918 },
        { rate: 0.06, upTo: 108162 },
        { rate: 0.08, upTo: 136700 },
        { rate: 0.093, upTo: 698274 },
        { rate: 0.103, upTo: 837922 },
        { rate: 0.113, upTo: 1000000 },
        { rate: 0.123, upTo: 1396542 },
        { rate: 0.133, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.01, upTo: 10412 },
        { rate: 0.02, upTo: 24684 },
        { rate: 0.04, upTo: 38959 },
        { rate: 0.06, upTo: 54081 },
        { rate: 0.08, upTo: 68350 },
        { rate: 0.093, upTo: 349137 },
        { rate: 0.103, upTo: 418961 },
        { rate: 0.113, upTo: 698271 },
        { rate: 0.123, upTo: 1000000 },
        { rate: 0.133, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.01, upTo: 20839 },
        { rate: 0.02, upTo: 49371 },
        { rate: 0.04, upTo: 63644 },
        { rate: 0.06, upTo: 78765 },
        { rate: 0.08, upTo: 93037 },
        { rate: 0.093, upTo: 474824 },
        { rate: 0.103, upTo: 569790 },
        { rate: 0.113, upTo: 949649 },
        { rate: 0.123, upTo: 1000000 },
        { rate: 0.133, upTo: Infinity },
      ],
    },
  },
  CT: {
    code: "CT", name: "Connecticut", type: "progressive",
    brackets: {
      single: [
        { rate: 0.03, upTo: 10000 },
        { rate: 0.05, upTo: 50000 },
        { rate: 0.055, upTo: 100000 },
        { rate: 0.06, upTo: 200000 },
        { rate: 0.065, upTo: 250000 },
        { rate: 0.069, upTo: 500000 },
        { rate: 0.0699, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.03, upTo: 20000 },
        { rate: 0.05, upTo: 100000 },
        { rate: 0.055, upTo: 200000 },
        { rate: 0.06, upTo: 400000 },
        { rate: 0.065, upTo: 500000 },
        { rate: 0.069, upTo: 1000000 },
        { rate: 0.0699, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.03, upTo: 10000 },
        { rate: 0.05, upTo: 50000 },
        { rate: 0.055, upTo: 100000 },
        { rate: 0.06, upTo: 200000 },
        { rate: 0.065, upTo: 250000 },
        { rate: 0.069, upTo: 500000 },
        { rate: 0.0699, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.03, upTo: 16000 },
        { rate: 0.05, upTo: 80000 },
        { rate: 0.055, upTo: 160000 },
        { rate: 0.06, upTo: 320000 },
        { rate: 0.065, upTo: 400000 },
        { rate: 0.069, upTo: 800000 },
        { rate: 0.0699, upTo: Infinity },
      ],
    },
  },
  DE: {
    code: "DE", name: "Delaware", type: "progressive",
    deduction: { single: 3250, mfj: 6500, mfs: 3250, hoh: 3250 },
    brackets: {
      single: [
        { rate: 0.0, upTo: 2000 },
        { rate: 0.022, upTo: 5000 },
        { rate: 0.039, upTo: 10000 },
        { rate: 0.048, upTo: 20000 },
        { rate: 0.052, upTo: 25000 },
        { rate: 0.0555, upTo: 60000 },
        { rate: 0.066, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0, upTo: 2000 },
        { rate: 0.022, upTo: 5000 },
        { rate: 0.039, upTo: 10000 },
        { rate: 0.048, upTo: 20000 },
        { rate: 0.052, upTo: 25000 },
        { rate: 0.0555, upTo: 60000 },
        { rate: 0.066, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0, upTo: 2000 },
        { rate: 0.022, upTo: 5000 },
        { rate: 0.039, upTo: 10000 },
        { rate: 0.048, upTo: 20000 },
        { rate: 0.052, upTo: 25000 },
        { rate: 0.0555, upTo: 60000 },
        { rate: 0.066, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0, upTo: 2000 },
        { rate: 0.022, upTo: 5000 },
        { rate: 0.039, upTo: 10000 },
        { rate: 0.048, upTo: 20000 },
        { rate: 0.052, upTo: 25000 },
        { rate: 0.0555, upTo: 60000 },
        { rate: 0.066, upTo: Infinity },
      ],
    },
  },
  DC: {
    code: "DC", name: "District of Columbia", type: "progressive",
    deduction: "federal",
    brackets: {
      single: [
        { rate: 0.04, upTo: 10000 },
        { rate: 0.06, upTo: 40000 },
        { rate: 0.065, upTo: 60000 },
        { rate: 0.085, upTo: 250000 },
        { rate: 0.0925, upTo: 500000 },
        { rate: 0.0975, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.04, upTo: 10000 },
        { rate: 0.06, upTo: 40000 },
        { rate: 0.065, upTo: 60000 },
        { rate: 0.085, upTo: 250000 },
        { rate: 0.0925, upTo: 500000 },
        { rate: 0.0975, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.04, upTo: 10000 },
        { rate: 0.06, upTo: 40000 },
        { rate: 0.065, upTo: 60000 },
        { rate: 0.085, upTo: 250000 },
        { rate: 0.0925, upTo: 500000 },
        { rate: 0.0975, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.04, upTo: 10000 },
        { rate: 0.06, upTo: 40000 },
        { rate: 0.065, upTo: 60000 },
        { rate: 0.085, upTo: 250000 },
        { rate: 0.0925, upTo: 500000 },
        { rate: 0.0975, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
    },
  },
  HI: {
    code: "HI", name: "Hawaii", type: "progressive",
    deduction: { single: 4400, mfj: 8800, mfs: 4400, hoh: 6424 },
    brackets: {
      single: [
        { rate: 0.014, upTo: 2400 },
        { rate: 0.032, upTo: 4800 },
        { rate: 0.055, upTo: 9600 },
        { rate: 0.064, upTo: 14400 },
        { rate: 0.068, upTo: 19200 },
        { rate: 0.072, upTo: 24000 },
        { rate: 0.076, upTo: 36000 },
        { rate: 0.079, upTo: 48000 },
        { rate: 0.0825, upTo: 150000 },
        { rate: 0.09, upTo: 175000 },
        { rate: 0.10, upTo: 200000 },
        { rate: 0.11, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.014, upTo: 4800 },
        { rate: 0.032, upTo: 9600 },
        { rate: 0.055, upTo: 19200 },
        { rate: 0.064, upTo: 28800 },
        { rate: 0.068, upTo: 38400 },
        { rate: 0.072, upTo: 48000 },
        { rate: 0.076, upTo: 72000 },
        { rate: 0.079, upTo: 96000 },
        { rate: 0.0825, upTo: 300000 },
        { rate: 0.09, upTo: 350000 },
        { rate: 0.10, upTo: 400000 },
        { rate: 0.11, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.014, upTo: 2400 },
        { rate: 0.032, upTo: 4800 },
        { rate: 0.055, upTo: 9600 },
        { rate: 0.064, upTo: 14400 },
        { rate: 0.068, upTo: 19200 },
        { rate: 0.072, upTo: 24000 },
        { rate: 0.076, upTo: 36000 },
        { rate: 0.079, upTo: 48000 },
        { rate: 0.0825, upTo: 150000 },
        { rate: 0.09, upTo: 175000 },
        { rate: 0.10, upTo: 200000 },
        { rate: 0.11, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.014, upTo: 3600 },
        { rate: 0.032, upTo: 7200 },
        { rate: 0.055, upTo: 14400 },
        { rate: 0.064, upTo: 21600 },
        { rate: 0.068, upTo: 28800 },
        { rate: 0.072, upTo: 36000 },
        { rate: 0.076, upTo: 54000 },
        { rate: 0.079, upTo: 72000 },
        { rate: 0.0825, upTo: 225000 },
        { rate: 0.09, upTo: 262500 },
        { rate: 0.10, upTo: 300000 },
        { rate: 0.11, upTo: Infinity },
      ],
    },
  },
  KS: {
    code: "KS", name: "Kansas", type: "progressive",
    deduction: { single: 3605, mfj: 8240, mfs: 4120, hoh: 6180 },
    brackets: {
      single: [
        { rate: 0.052, upTo: 23000 },
        { rate: 0.0558, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.052, upTo: 46000 },
        { rate: 0.0558, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.052, upTo: 23000 },
        { rate: 0.0558, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.052, upTo: 23000 },
        { rate: 0.0558, upTo: Infinity },
      ],
    },
  },
  LA: {
    code: "LA", name: "Louisiana", type: "progressive",
    deduction: { single: 12500, mfj: 25000, mfs: 12500, hoh: 25000 },
    brackets: {
      single: [
        { rate: 0.0185, upTo: 12500 },
        { rate: 0.035, upTo: 50000 },
        { rate: 0.0425, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0185, upTo: 25000 },
        { rate: 0.035, upTo: 100000 },
        { rate: 0.0425, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0185, upTo: 12500 },
        { rate: 0.035, upTo: 50000 },
        { rate: 0.0425, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0185, upTo: 12500 },
        { rate: 0.035, upTo: 50000 },
        { rate: 0.0425, upTo: Infinity },
      ],
    },
  },
  ME: {
    code: "ME", name: "Maine", type: "progressive",
    deduction: "federal",
    brackets: {
      single: [
        { rate: 0.058, upTo: 26050 },
        { rate: 0.0675, upTo: 61600 },
        { rate: 0.0715, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.058, upTo: 52100 },
        { rate: 0.0675, upTo: 123250 },
        { rate: 0.0715, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.058, upTo: 26050 },
        { rate: 0.0675, upTo: 61600 },
        { rate: 0.0715, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.058, upTo: 39100 },
        { rate: 0.0675, upTo: 92400 },
        { rate: 0.0715, upTo: Infinity },
      ],
    },
  },
  MD: {
    code: "MD", name: "Maryland", type: "progressive",
    deduction: {
      type: "pct_of_agi",
      rate: 0.15,
      min: { single: 1800, mfj: 3650, mfs: 1800, hoh: 3650 },
      max: { single: 3350, mfj: 6700, mfs: 3350, hoh: 6700 },
    },
    brackets: {
      single: [
        { rate: 0.02, upTo: 1000 },
        { rate: 0.03, upTo: 2000 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.0475, upTo: 100000 },
        { rate: 0.05, upTo: 125000 },
        { rate: 0.0525, upTo: 150000 },
        { rate: 0.055, upTo: 250000 },
        { rate: 0.0575, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.02, upTo: 1000 },
        { rate: 0.03, upTo: 2000 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.0475, upTo: 150000 },
        { rate: 0.05, upTo: 175000 },
        { rate: 0.0525, upTo: 225000 },
        { rate: 0.055, upTo: 300000 },
        { rate: 0.0575, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.02, upTo: 1000 },
        { rate: 0.03, upTo: 2000 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.0475, upTo: 100000 },
        { rate: 0.05, upTo: 125000 },
        { rate: 0.0525, upTo: 150000 },
        { rate: 0.055, upTo: 250000 },
        { rate: 0.0575, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.02, upTo: 1000 },
        { rate: 0.03, upTo: 2000 },
        { rate: 0.04, upTo: 3000 },
        { rate: 0.0475, upTo: 100000 },
        { rate: 0.05, upTo: 125000 },
        { rate: 0.0525, upTo: 150000 },
        { rate: 0.055, upTo: 250000 },
        { rate: 0.0575, upTo: Infinity },
      ],
    },
  },
  MA: {
    code: "MA", name: "Massachusetts", type: "progressive",
    brackets: {
      single: [
        { rate: 0.05, upTo: 1083150 },
        { rate: 0.09, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.05, upTo: 1083150 },
        { rate: 0.09, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.05, upTo: 1083150 },
        { rate: 0.09, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.05, upTo: 1083150 },
        { rate: 0.09, upTo: Infinity },
      ],
    },
  },
  MN: {
    code: "MN", name: "Minnesota", type: "progressive",
    deduction: { single: 14950, mfj: 29900, mfs: 14950, hoh: 22500 },
    brackets: {
      single: [
        { rate: 0.0535, upTo: 31690 },
        { rate: 0.068, upTo: 104090 },
        { rate: 0.0785, upTo: 183340 },
        { rate: 0.0985, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0535, upTo: 46330 },
        { rate: 0.068, upTo: 184040 },
        { rate: 0.0785, upTo: 321450 },
        { rate: 0.0985, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0535, upTo: 23165 },
        { rate: 0.068, upTo: 92020 },
        { rate: 0.0785, upTo: 160725 },
        { rate: 0.0985, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0535, upTo: 39010 },
        { rate: 0.068, upTo: 144060 },
        { rate: 0.0785, upTo: 252400 },
        { rate: 0.0985, upTo: Infinity },
      ],
    },
  },
  MO: {
    code: "MO", name: "Missouri", type: "progressive",
    deduction: "federal",
    brackets: {
      single: [
        { rate: 0.02, upTo: 1207 },
        { rate: 0.025, upTo: 2414 },
        { rate: 0.03, upTo: 3621 },
        { rate: 0.035, upTo: 4828 },
        { rate: 0.04, upTo: 6035 },
        { rate: 0.045, upTo: 7242 },
        { rate: 0.048, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.02, upTo: 1207 },
        { rate: 0.025, upTo: 2414 },
        { rate: 0.03, upTo: 3621 },
        { rate: 0.035, upTo: 4828 },
        { rate: 0.04, upTo: 6035 },
        { rate: 0.045, upTo: 7242 },
        { rate: 0.048, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.02, upTo: 1207 },
        { rate: 0.025, upTo: 2414 },
        { rate: 0.03, upTo: 3621 },
        { rate: 0.035, upTo: 4828 },
        { rate: 0.04, upTo: 6035 },
        { rate: 0.045, upTo: 7242 },
        { rate: 0.048, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.02, upTo: 1207 },
        { rate: 0.025, upTo: 2414 },
        { rate: 0.03, upTo: 3621 },
        { rate: 0.035, upTo: 4828 },
        { rate: 0.04, upTo: 6035 },
        { rate: 0.045, upTo: 7242 },
        { rate: 0.048, upTo: Infinity },
      ],
    },
  },
  MT: {
    code: "MT", name: "Montana", type: "progressive",
    startingPoint: "federal_taxable",
    brackets: {
      single: [
        { rate: 0.047, upTo: 20500 },
        { rate: 0.059, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.047, upTo: 41000 },
        { rate: 0.059, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.047, upTo: 20500 },
        { rate: 0.059, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.047, upTo: 20500 },
        { rate: 0.059, upTo: Infinity },
      ],
    },
  },
  NE: {
    code: "NE", name: "Nebraska", type: "progressive",
    deduction: { single: 8600, mfj: 17200, mfs: 8600, hoh: 12600 },
    brackets: {
      single: [
        { rate: 0.0246, upTo: 3700 },
        { rate: 0.0351, upTo: 22170 },
        { rate: 0.0501, upTo: 35730 },
        { rate: 0.0584, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0246, upTo: 7400 },
        { rate: 0.0351, upTo: 44350 },
        { rate: 0.0501, upTo: 71460 },
        { rate: 0.0584, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0246, upTo: 3700 },
        { rate: 0.0351, upTo: 22170 },
        { rate: 0.0501, upTo: 35730 },
        { rate: 0.0584, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0246, upTo: 5550 },
        { rate: 0.0351, upTo: 33260 },
        { rate: 0.0501, upTo: 53600 },
        { rate: 0.0584, upTo: Infinity },
      ],
    },
  },
  ND: {
    code: "ND", name: "North Dakota", type: "progressive",
    startingPoint: "federal_taxable",
    brackets: {
      single: [
        { rate: 0.0, upTo: 48475 },
        { rate: 0.0195, upTo: 244825 },
        { rate: 0.025, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0, upTo: 80975 },
        { rate: 0.0195, upTo: 298075 },
        { rate: 0.025, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0, upTo: 40475 },
        { rate: 0.0195, upTo: 149025 },
        { rate: 0.025, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0, upTo: 64950 },
        { rate: 0.0195, upTo: 271450 },
        { rate: 0.025, upTo: Infinity },
      ],
    },
  },
  NJ: {
    code: "NJ", name: "New Jersey", type: "progressive",
    brackets: {
      single: [
        { rate: 0.014, upTo: 20000 },
        { rate: 0.0175, upTo: 35000 },
        { rate: 0.035, upTo: 40000 },
        { rate: 0.05525, upTo: 75000 },
        { rate: 0.0637, upTo: 500000 },
        { rate: 0.0897, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.014, upTo: 20000 },
        { rate: 0.0175, upTo: 50000 },
        { rate: 0.0245, upTo: 70000 },
        { rate: 0.035, upTo: 80000 },
        { rate: 0.05525, upTo: 150000 },
        { rate: 0.0637, upTo: 500000 },
        { rate: 0.0897, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.014, upTo: 20000 },
        { rate: 0.0175, upTo: 35000 },
        { rate: 0.035, upTo: 40000 },
        { rate: 0.05525, upTo: 75000 },
        { rate: 0.0637, upTo: 500000 },
        { rate: 0.0897, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.014, upTo: 20000 },
        { rate: 0.0175, upTo: 50000 },
        { rate: 0.0245, upTo: 70000 },
        { rate: 0.035, upTo: 80000 },
        { rate: 0.05525, upTo: 150000 },
        { rate: 0.0637, upTo: 500000 },
        { rate: 0.0897, upTo: 1000000 },
        { rate: 0.1075, upTo: Infinity },
      ],
    },
  },
  NM: {
    code: "NM", name: "New Mexico", type: "progressive",
    deduction: "federal",
    brackets: {
      single: [
        { rate: 0.017, upTo: 5500 },
        { rate: 0.032, upTo: 11000 },
        { rate: 0.047, upTo: 16000 },
        { rate: 0.049, upTo: 210000 },
        { rate: 0.059, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.017, upTo: 8000 },
        { rate: 0.032, upTo: 16000 },
        { rate: 0.047, upTo: 24000 },
        { rate: 0.049, upTo: 315000 },
        { rate: 0.059, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.017, upTo: 4000 },
        { rate: 0.032, upTo: 8000 },
        { rate: 0.047, upTo: 12000 },
        { rate: 0.049, upTo: 157500 },
        { rate: 0.059, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.017, upTo: 6750 },
        { rate: 0.032, upTo: 13500 },
        { rate: 0.047, upTo: 20000 },
        { rate: 0.049, upTo: 262500 },
        { rate: 0.059, upTo: Infinity },
      ],
    },
  },
  NY: {
    code: "NY", name: "New York", type: "progressive",
    deduction: { single: 8000, mfj: 16050, mfs: 8000, hoh: 11200 },
    brackets: {
      single: [
        { rate: 0.04, upTo: 8500 },
        { rate: 0.045, upTo: 11700 },
        { rate: 0.0525, upTo: 13900 },
        { rate: 0.0585, upTo: 80650 },
        { rate: 0.0625, upTo: 215400 },
        { rate: 0.0685, upTo: 1077550 },
        { rate: 0.0965, upTo: 5000000 },
        { rate: 0.103, upTo: 25000000 },
        { rate: 0.109, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.04, upTo: 17150 },
        { rate: 0.045, upTo: 23600 },
        { rate: 0.0525, upTo: 27900 },
        { rate: 0.0585, upTo: 161550 },
        { rate: 0.0625, upTo: 323200 },
        { rate: 0.0685, upTo: 2155350 },
        { rate: 0.0965, upTo: 5000000 },
        { rate: 0.103, upTo: 25000000 },
        { rate: 0.109, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.04, upTo: 8500 },
        { rate: 0.045, upTo: 11700 },
        { rate: 0.0525, upTo: 13900 },
        { rate: 0.0585, upTo: 80650 },
        { rate: 0.0625, upTo: 215400 },
        { rate: 0.0685, upTo: 1077550 },
        { rate: 0.0965, upTo: 5000000 },
        { rate: 0.103, upTo: 25000000 },
        { rate: 0.109, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.04, upTo: 12800 },
        { rate: 0.045, upTo: 17650 },
        { rate: 0.0525, upTo: 20900 },
        { rate: 0.0585, upTo: 107650 },
        { rate: 0.0625, upTo: 269300 },
        { rate: 0.0685, upTo: 1616450 },
        { rate: 0.0965, upTo: 5000000 },
        { rate: 0.103, upTo: 25000000 },
        { rate: 0.109, upTo: Infinity },
      ],
    },
  },
  OH: {
    code: "OH", name: "Ohio", type: "progressive",
    brackets: {
      single: [
        { rate: 0.0, upTo: 26050 },
        { rate: 0.0275, upTo: 100000 },
        { rate: 0.03125, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0, upTo: 26050 },
        { rate: 0.0275, upTo: 100000 },
        { rate: 0.03125, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0, upTo: 26050 },
        { rate: 0.0275, upTo: 100000 },
        { rate: 0.03125, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0, upTo: 26050 },
        { rate: 0.0275, upTo: 100000 },
        { rate: 0.03125, upTo: Infinity },
      ],
    },
  },
  OK: {
    code: "OK", name: "Oklahoma", type: "progressive",
    deduction: { single: 6350, mfj: 12700, mfs: 6350, hoh: 9350 },
    brackets: {
      single: [
        { rate: 0.0025, upTo: 1000 },
        { rate: 0.0075, upTo: 2500 },
        { rate: 0.0175, upTo: 3750 },
        { rate: 0.0275, upTo: 4900 },
        { rate: 0.0375, upTo: 7200 },
        { rate: 0.0475, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0025, upTo: 2000 },
        { rate: 0.0075, upTo: 5000 },
        { rate: 0.0175, upTo: 7500 },
        { rate: 0.0275, upTo: 9800 },
        { rate: 0.0375, upTo: 12200 },
        { rate: 0.0475, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0025, upTo: 1000 },
        { rate: 0.0075, upTo: 2500 },
        { rate: 0.0175, upTo: 3750 },
        { rate: 0.0275, upTo: 4900 },
        { rate: 0.0375, upTo: 7200 },
        { rate: 0.0475, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0025, upTo: 2000 },
        { rate: 0.0075, upTo: 5000 },
        { rate: 0.0175, upTo: 7500 },
        { rate: 0.0275, upTo: 9800 },
        { rate: 0.0375, upTo: 12200 },
        { rate: 0.0475, upTo: Infinity },
      ],
    },
  },
  OR: {
    code: "OR", name: "Oregon", type: "progressive",
    deduction: { single: 2835, mfj: 5670, mfs: 2835, hoh: 4560 },
    brackets: {
      single: [
        { rate: 0.0475, upTo: 4050 },
        { rate: 0.0675, upTo: 10200 },
        { rate: 0.0875, upTo: 125000 },
        { rate: 0.099, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0475, upTo: 8100 },
        { rate: 0.0675, upTo: 20400 },
        { rate: 0.0875, upTo: 250000 },
        { rate: 0.099, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0475, upTo: 4050 },
        { rate: 0.0675, upTo: 10200 },
        { rate: 0.0875, upTo: 125000 },
        { rate: 0.099, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0475, upTo: 8100 },
        { rate: 0.0675, upTo: 20400 },
        { rate: 0.0875, upTo: 250000 },
        { rate: 0.099, upTo: Infinity },
      ],
    },
  },
  RI: {
    code: "RI", name: "Rhode Island", type: "progressive",
    deduction: { single: 10900, mfj: 21800, mfs: 10900, hoh: 16350 },
    brackets: {
      single: [
        { rate: 0.0375, upTo: 77450 },
        { rate: 0.0475, upTo: 176050 },
        { rate: 0.0599, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0375, upTo: 77450 },
        { rate: 0.0475, upTo: 176050 },
        { rate: 0.0599, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0375, upTo: 77450 },
        { rate: 0.0475, upTo: 176050 },
        { rate: 0.0599, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0375, upTo: 77450 },
        { rate: 0.0475, upTo: 176050 },
        { rate: 0.0599, upTo: Infinity },
      ],
    },
  },
  SC: {
    code: "SC", name: "South Carolina", type: "progressive",
    startingPoint: "federal_taxable",
    brackets: {
      single: [
        { rate: 0.0, upTo: 3460 },
        { rate: 0.03, upTo: 17330 },
        { rate: 0.064, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0, upTo: 3460 },
        { rate: 0.03, upTo: 17330 },
        { rate: 0.064, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0, upTo: 3460 },
        { rate: 0.03, upTo: 17330 },
        { rate: 0.064, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0, upTo: 3460 },
        { rate: 0.03, upTo: 17330 },
        { rate: 0.064, upTo: Infinity },
      ],
    },
  },
  VT: {
    code: "VT", name: "Vermont", type: "progressive",
    deduction: { single: 7650, mfj: 15300, mfs: 7650, hoh: 11450 },
    brackets: {
      single: [
        { rate: 0.0335, upTo: 45400 },
        { rate: 0.066, upTo: 110050 },
        { rate: 0.076, upTo: 229550 },
        { rate: 0.0875, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0335, upTo: 75800 },
        { rate: 0.066, upTo: 183400 },
        { rate: 0.076, upTo: 279450 },
        { rate: 0.0875, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0335, upTo: 37900 },
        { rate: 0.066, upTo: 91700 },
        { rate: 0.076, upTo: 139725 },
        { rate: 0.0875, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0335, upTo: 60600 },
        { rate: 0.066, upTo: 146700 },
        { rate: 0.076, upTo: 254500 },
        { rate: 0.0875, upTo: Infinity },
      ],
    },
  },
  VA: {
    code: "VA", name: "Virginia", type: "progressive",
    deduction: { single: 8750, mfj: 17500, mfs: 8750, hoh: 8750 },
    brackets: {
      single: [
        { rate: 0.02, upTo: 3000 },
        { rate: 0.03, upTo: 5000 },
        { rate: 0.05, upTo: 17000 },
        { rate: 0.0575, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.02, upTo: 3000 },
        { rate: 0.03, upTo: 5000 },
        { rate: 0.05, upTo: 17000 },
        { rate: 0.0575, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.02, upTo: 3000 },
        { rate: 0.03, upTo: 5000 },
        { rate: 0.05, upTo: 17000 },
        { rate: 0.0575, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.02, upTo: 3000 },
        { rate: 0.03, upTo: 5000 },
        { rate: 0.05, upTo: 17000 },
        { rate: 0.0575, upTo: Infinity },
      ],
    },
  },
  WV: {
    code: "WV", name: "West Virginia", type: "progressive",
    personalExemption: 2000,
    brackets: {
      single: [
        { rate: 0.0236, upTo: 10000 },
        { rate: 0.0315, upTo: 25000 },
        { rate: 0.0354, upTo: 40000 },
        { rate: 0.0472, upTo: 60000 },
        { rate: 0.0512, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.0236, upTo: 10000 },
        { rate: 0.0315, upTo: 25000 },
        { rate: 0.0354, upTo: 40000 },
        { rate: 0.0472, upTo: 60000 },
        { rate: 0.0512, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.0236, upTo: 10000 },
        { rate: 0.0315, upTo: 25000 },
        { rate: 0.0354, upTo: 40000 },
        { rate: 0.0472, upTo: 60000 },
        { rate: 0.0512, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.0236, upTo: 10000 },
        { rate: 0.0315, upTo: 25000 },
        { rate: 0.0354, upTo: 40000 },
        { rate: 0.0472, upTo: 60000 },
        { rate: 0.0512, upTo: Infinity },
      ],
    },
  },
  WI: {
    code: "WI", name: "Wisconsin", type: "progressive",
    deduction: { single: 14260, mfj: 26510, mfs: 12550, hoh: 18300 },
    brackets: {
      single: [
        { rate: 0.035, upTo: 14320 },
        { rate: 0.044, upTo: 28640 },
        { rate: 0.053, upTo: 315310 },
        { rate: 0.0765, upTo: Infinity },
      ],
      mfj: [
        { rate: 0.035, upTo: 19090 },
        { rate: 0.044, upTo: 38190 },
        { rate: 0.053, upTo: 420420 },
        { rate: 0.0765, upTo: Infinity },
      ],
      mfs: [
        { rate: 0.035, upTo: 9545 },
        { rate: 0.044, upTo: 19095 },
        { rate: 0.053, upTo: 210210 },
        { rate: 0.0765, upTo: Infinity },
      ],
      hoh: [
        { rate: 0.035, upTo: 14320 },
        { rate: 0.044, upTo: 28640 },
        { rate: 0.053, upTo: 315310 },
        { rate: 0.0765, upTo: Infinity },
      ],
    },
  },
};

// Display-friendly rate string for a state (top marginal rate for progressive).
function stateRateLabel(s: StateTaxConfig): string {
  if (s.type === "none") return "0%";
  if (s.type === "flat" && s.flatRate != null) return `${(s.flatRate * 100).toFixed(1)}%`;
  if (s.type === "progressive" && s.brackets) {
    const topRate = s.brackets.single[s.brackets.single.length - 1].rate;
    return `up to ${(topRate * 100).toFixed(1)}%`;
  }
  return "";
}

export const STATE_OPTIONS: { value: string; label: string }[] = Object.values(STATE_TAX_DATA)
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((s) => ({
    value: s.code,
    label: `${s.code} - ${s.name} (${stateRateLabel(s)})`,
  }));

export function getStateTaxConfig(stateCode: string | null): StateTaxConfig | null {
  if (!stateCode) return null;
  return STATE_TAX_DATA[stateCode] ?? null;
}
