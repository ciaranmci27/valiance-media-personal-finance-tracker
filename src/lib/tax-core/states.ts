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
  // Alaska: repealed 1980. Alaska DOR confirms no individual income tax
  // and no state withholding requirement.
  AK: { code: "AK", name: "Alaska", type: "none" },
  // Florida: Fla. Const. Art. VII sec. 5(a) effectively bars it, and the
  // DOR list of administered taxes contains no personal income tax.
  FL: { code: "FL", name: "Florida", type: "none" },
  // Nevada: Nev. Const. Art. 10 sec. 1(9) prohibits any tax on the wages or
  // personal income of natural persons.
  NV: { code: "NV", name: "Nevada", type: "none" },
  // New Hampshire: RSA ch. 77 (Interest and Dividends Tax) was REPEALED
  // effective January 1 2025, accelerated from 2027 by 2023 HB 2. So TY2025 is
  // the first clean year; a config that taxed New Hampshire in 2025 would be
  // wrong. Rate history before repeal: 5 percent, then 4, then 3.
  NH: { code: "NH", name: "New Hampshire", type: "none" },
  // South Dakota: SD DOR states it is one of seven states with no income tax.
  SD: { code: "SD", name: "South Dakota", type: "none" },
  // Tennessee: the Hall income tax was repealed for tax years beginning on
  // or after January 1 2021.
  TN: { code: "TN", name: "Tennessee", type: "none" },
  // Texas: Tex. Const. Art. VIII sec. 24-a bars a tax on individual net
  // income. A new sec. 24-b (adopted November 2025) also bars any tax on
  // realized or unrealized individual capital gains.
  TX: { code: "TX", name: "Texas", type: "none" },
  // Washington: no tax on wages, but Washington DOES levy a capital gains
  // excise tax (RCW 82.87): 7 percent above a 278,000 standard deduction for
  // 2025, plus 2.9 percent above 1,000,000, giving 9.9 percent at the top. The
  // deduction is per individual OR per couple, never doubled for joint filers,
  // and the 1,000,000 tier is not indexed. That is a separate excise on a
  // different base and is not modelled here, so a Washington filer with large
  // long-term gains will show 0 state tax when real liability can be six
  // figures. Note also that ESSB 6346 (2026) enacts a genuine 9.9 percent
  // individual income tax from TY2028, which will need its own entry.
  WA: { code: "WA", name: "Washington", type: "none" },
  // Wyoming: the constitution permits an income tax (Art. 15 sec. 18) but
  // none has ever been enacted; LSO reports a 0 percent rate and zero receipts.
  WY: { code: "WY", name: "Wyoming", type: "none" },

  // Flat tax states
  // Arizona: verified against the 2025 Form 140 instructions.
  // - Rate 2.5% (line 46, "Multiply line 45 by 2.5% (.025)").
  // - Standard deduction $15,750 / $31,500 / $15,750 / $23,625, identical to the
  //   federal amounts, so federal conformity models it exactly.
  // - No personal or dependent exemption. Dependents give a nonrefundable credit
  //   instead (line 49): $100 per dependent under 17, $25 per dependent 17 or
  //   older, reduced 5% per $1,000 (or part) of federal AGI over $200,000
  //   (single/MFS/HoH) or $400,000 (MFJ), and lost entirely once the excess
  //   passes $19,000.
  AZ: {
    code: "AZ", name: "Arizona", type: "flat", flatRate: 0.025, deduction: "federal",
    dependentCredit: {
      perChild: 100,
      perOtherDependent: 25,
      phaseOutStart: { single: 200000, mfs: 200000, hoh: 200000, mfj: 400000 },
      phaseOutRatePerStep: 0.05,
      phaseOutStep: 1000,
      phaseOutFullyLostAbove: 19000,
    },
  },
  // Colorado: DR 0104 line 1 takes federal taxable income from Form 1040 line
  // 15 directly, so there is no state deduction or exemption. The rate is 4.40
  // percent for BOTH years: the TABOR reduction ladder in C.R.S. 39-22-627 did
  // not trigger for 2025, and Legislative Council Staff project no trigger for
  // 2026 or 2027 either (revenue is running below the Referendum C cap). The
  // 2026 DR 1098 withholding worksheet already uses 4.40 percent.
  // Note two bills often reported as enacted were NOT: HB24-1065 (4.0 percent)
  // and SB25-138 (permanent 4.25) were both postponed indefinitely.
  // Not modelled: the federal deduction ADDBACK above 300,000 of AGI, which
  // runs opposite to a deduction and tightens sharply for 2026 (the excess
  // allowance drops from 12,000/16,000 to 1,000/2,000 under Proposition MM);
  // the state income tax addback; and the refundable child credit, which is
  // cliff-tiered by AGI and limited to children under 6.
  CO: { code: "CO", name: "Colorado", type: "flat", flatRate: 0.044, startingPoint: "federal_taxable" },
  // Georgia: 2025 IT-511 booklet. Flat 5.19 percent for 2025, cut to 4.99 for
  // 2026 by HB 463 with a larger standard deduction. Starts from federal AGI.
  // Not modelled: the dependent deduction (4,000 in 2025, 5,000 in 2026) is for
  // DEPENDENTS ONLY, since Georgia eliminated the filer and spouse exemption
  // under HB 1437, so personalExemption would wrongly grant it to filers. Also
  // unmodelled: the retirement income exclusion of 35,000 (age 62 to 64) or
  // 65,000 (65 and older) per person.
  GA: {
    code: "GA", name: "Georgia", type: "flat", flatRate: 0.0519,
    deduction: { single: 12000, mfj: 24000, mfs: 12000, hoh: 12000 },
  },
  // Idaho: HB 40 (2025, ch. 13) set 5.3 percent effective January 1 2025, and
  // the post-2026-session statute still reads 5.3 percent.
  // Two things here are easy to get wrong and were wrong before:
  //  1. Form 40 line 7 starts from federal AGI, not federal taxable income, and
  //     line 16 then subtracts the federal standard deduction. Idaho conforms to
  //     the IRC as of January 1 2026 (H0559), so it picked up the larger OBBBA
  //     amounts. Hence AGI plus deduction: "federal".
  //  2. There is a zero-rate band ON TOP of that deduction: the line 20 worksheet
  //     subtracts a further 4,811 (single and MFS) or 9,622 before applying the
  //     rate. Head of household takes the JOINT amount, because 63-3024(2)(b)
  //     treats a head-of-household return as a joint return. The withholding
  //     tables group HOH with single, but that is a withholding simplification,
  //     not the return rule.
  // The child credit is 205 per child aged 16 or under with no income
  // phase-out, and it SUNSET after TY2025 under 63-3029L, so 2026 removes it.
  // Not modelled: the 155 per person Food Tax Credit, and the requirement that
  // itemizers strip state and local taxes out of Schedule A first.
  ID: {
    code: "ID", name: "Idaho", type: "progressive",
    deduction: "federal",
    dependentCredit: {
      perChild: 205,
      perOtherDependent: 0,
      phaseOutStart: {},
      phaseOutRatePerStep: 0,
      phaseOutStep: 1,
      phaseOutFullyLostAbove: Number.POSITIVE_INFINITY,
    },
    brackets: {
      single: [{ rate: 0, upTo: 4811 }, { rate: 0.053, upTo: Infinity }],
      mfs: [{ rate: 0, upTo: 4811 }, { rate: 0.053, upTo: Infinity }],
      mfj: [{ rate: 0, upTo: 9622 }, { rate: 0.053, upTo: Infinity }],
      hoh: [{ rate: 0, upTo: 9622 }, { rate: 0.053, upTo: Infinity }],
    },
  },
  // Illinois: flat 4.95 percent since July 2017, from federal AGI, no standard
  // deduction. The per-person exemption (filer, spouse, each dependent) was
  // missing entirely, overstating Illinois tax by about 141 per person.
  // Source: IDOR Informational Bulletin FY 2026-15.
  // Not modelled: the exemption is disallowed OUTRIGHT above 500,000 of federal
  // AGI for joint filers or 250,000 otherwise, a cliff rather than a phase-out.
  IL: { code: "IL", name: "Illinois", type: "flat", flatRate: 0.0495, personalExemption: 2850 },
  // Indiana: Departmental Notice #1. The rate steps down 3.00 percent (2025),
  // 2.95 (2026), 2.90 (2027 and later). Indiana has no standard deduction and
  // uses exemptions instead, which do not phase out with income.
  // Not modelled: the extra 1,500 (or 3,000 in a child's first qualifying year)
  // child exemption, the 3,000 adopted-child exemption, age and blindness
  // exemptions, and county income tax, which is mandatory in all 92 counties
  // and runs from 0.5 to 3.0 percent based on county of residence on January 1.
  IN: { code: "IN", name: "Indiana", type: "flat", flatRate: 0.03, personalExemption: 1000 },
  // Iowa: flat 3.8% for 2025 and 2026 (SF 2442 accelerated this; 3.9% for 2026
  // is the superseded figure). IA 1040 line 2 takes federal taxable income from
  // Form 1040 line 15 directly, so Iowa has no standard deduction of its own.
  IA: { code: "IA", name: "Iowa", type: "flat", flatRate: 0.038, startingPoint: "federal_taxable" },
  // Kentucky: 2025 Form 740 packet. Kentucky has no head-of-household status
  // (federal HOH filers use Single), and no personal exemption.
  // The joint figure assumes both spouses have income: Kentucky's combined
  // return gives each spouse their own deduction, so a single-earner couple
  // captures only half of it.
  // Not modelled: the Family Size Tax Credit, a percentage-of-tax credit that
  // can wipe out the entire liability for low-income families.
  KY: {
    code: "KY", name: "Kentucky", type: "flat", flatRate: 0.04,
    deduction: { single: 3270, mfj: 6540, mfs: 3270, hoh: 3270 },
  },
  // Michigan: MI-1040 Book TY2025 and Form 446 Withholding Guide (Rev. 01-25).
  // Starts from federal AGI with no standard deduction, only exemption
  // allowances. The MCL 206.51 rate rollback was NOT triggered for 2025 or 2026.
  // The "Tier 2/Tier 3 Michigan Standard Deduction" on Schedule 1 is a
  // birth-year retirement subtraction, not a general deduction, so it is not
  // modelled here.
  MI: { code: "MI", name: "Michigan", type: "flat", flatRate: 0.0425, personalExemption: 5800 },
  // Mississippi: Form 80-100-25 resident instructions. The first $10,000 of
  // taxable income is exempt, which a flat rate cannot express, so this is
  // progressive with a 0% band. Exemptions are per-return by status plus $1,500
  // per dependent, and they are DEDUCTIONS, not credits.
  MS: {
    code: "MS", name: "Mississippi", type: "progressive",
    deduction: { single: 2300, mfj: 4600, mfs: 2300, hoh: 3400 },
    personalExemption: {
      byStatus: { single: 6000, mfj: 12000, mfs: 6000, hoh: 9500 },
      perDependent: 1500,
    },
    brackets: {
      single: [{ rate: 0, upTo: 10000 }, { rate: 0.044, upTo: Infinity }],
      mfj: [{ rate: 0, upTo: 10000 }, { rate: 0.044, upTo: Infinity }],
      mfs: [{ rate: 0, upTo: 10000 }, { rate: 0.044, upTo: Infinity }],
      hoh: [{ rate: 0, upTo: 10000 }, { rate: 0.044, upTo: Infinity }],
    },
  },
  // North Carolina: NCDOR rate schedules and G.S. 105-153.5(a)(1). Flat 4.25
  // percent for 2025, falling to 3.99 for 2026 under S.L. 2023-134. The
  // standard deduction is statutory and unchanged across both years.
  // Not modelled: the child deduction of 500 to 3,000 per qualifying child,
  // tiered by AGI and phasing to zero above 140,000 joint / 70,000 single.
  // North Carolina has no personal exemption.
  NC: {
    code: "NC", name: "North Carolina", type: "flat", flatRate: 0.0425,
    deduction: { single: 12750, mfj: 25500, mfs: 12750, hoh: 19125 },
  },
  // Pennsylvania: 72 P.S. sec. 7302. Flat 3.07 percent since 2004, IDENTICAL
  // for 2026. The PA-40 instructions state plainly that Pennsylvania allows no
  // standard deduction, no personal exemptions and no itemized deductions.
  // Not modelled, and this is a real accuracy limit: Pennsylvania has no AGI.
  // It taxes eight separate income classes with no cross-class loss offset,
  // and normal-retirement pension, IRA and 401(k) distributions, Social
  // Security and unemployment are entirely untaxed, so applying 3.07 percent to
  // federal AGI materially overstates tax for retirees. Also unmodelled: local
  // earned income tax (about 1 percent typical, up to 3.75) and the
  // Philadelphia wage tax (3.735 percent resident from July 1 2026).
  PA: { code: "PA", name: "Pennsylvania", type: "flat", flatRate: 0.0307 },
  // Utah: HB 106 (2025) set 4.5 percent for TY2025. TC-40 line 4 starts from
  // federal AGI. Utah has no standard deduction and no personal exemption.
  // Not modelled: the taxpayer tax credit, which is 6 percent of the federal
  // standard deduction plus Utah exemptions, less 1.3 percent of Utah taxable
  // income over a base. It is worth up to about 1,900 for joint filers and
  // phases out entirely by roughly 182k of Utah taxable income.
  UT: { code: "UT", name: "Utah", type: "flat", flatRate: 0.045 },

  // Alabama: Form 40 booklet TY2025; TY2026 confirmed identical in the January
  // 2026 withholding booklet. Head of household uses the single schedule.
  // The personal exemption is per-return by status (1,500 single/MFS,
  // 3,000 MFJ/HOH), not per person.
  // Not modelled: the uncapped deduction for federal income tax paid, by far
  // Alabama's largest deduction; the 21-step income-phased standard deduction,
  // which falls to 5,000 MFJ and 2,500 for others above about 35,500 of AGI;
  // and the income-phased dependent exemption.
  AL: {
    code: "AL", name: "Alabama", type: "progressive",
    deduction: { single: 3000, mfj: 8500, mfs: 4250, hoh: 5200 },
    personalExemption: { byStatus: { single: 1500, mfs: 1500, mfj: 3000, hoh: 3000 } },
    brackets: { single: [{ rate: 0.02, upTo: 500 }, { rate: 0.04, upTo: 3000 }, { rate: 0.05, upTo: Infinity }], mfs: [{ rate: 0.02, upTo: 500 }, { rate: 0.04, upTo: 3000 }, { rate: 0.05, upTo: Infinity }], hoh: [{ rate: 0.02, upTo: 500 }, { rate: 0.04, upTo: 3000 }, { rate: 0.05, upTo: Infinity }], mfj: [{ rate: 0.02, upTo: 1000 }, { rate: 0.04, upTo: 6000 }, { rate: 0.05, upTo: Infinity }] },
  },
  // Arkansas: DFA "State of Arkansas Indexed Tax Brackets, Tax Year 2025".
  // ONE schedule for every filing status. DFA publishes it as "percentage minus
  // adjustment" rather than as cumulative brackets, but below 94,700 the two are
  // algebraically identical: at 26,399, 3.4 percent of income minus 287.97 gives
  // 609.60, exactly what the cumulative bands produce. Verified at every
  // boundary.
  // Above 94,700 the adjustment falls 10 dollars per 100 of income, which is a
  // 10 point surcharge on top of the top rate, so the phase-down is encoded as
  // an explicit 13.9 percent band. Once the adjustment bottoms out the schedule
  // reverts to the top rate.
  // KNOWN SHORTFALL: DFA's own table jumps 20.66 at 94,701 (the adjustment drops
  // from 419.96 to 399.30 in one step). A continuous bracket walk cannot
  // reproduce a discontinuity, so Arkansas tax is understated by that 20.66
  // above 94,700. Encoding a fabricated 14.57 percent band would hide the real
  // marginal rate in the UI, which is the worse trade.
  // Not modelled: the Low Income Tax Tables, which replace this schedule
  // entirely below roughly 17,500 (single) and can produce zero tax, and the
  // 60 dollar additional credit for qualified individuals.
  AR: {
    code: "AR", name: "Arkansas", type: "progressive",
    deduction: { single: 2470, mfj: 4940, mfs: 2470, hoh: 2470 },
    brackets: { single: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.039, upTo: 94700 }, { rate: 0.139, upTo: 97800 }, { rate: 0.039, upTo: Infinity }], mfj: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.039, upTo: 94700 }, { rate: 0.139, upTo: 97800 }, { rate: 0.039, upTo: Infinity }], mfs: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.039, upTo: 94700 }, { rate: 0.139, upTo: 97800 }, { rate: 0.039, upTo: Infinity }], hoh: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.039, upTo: 94700 }, { rate: 0.139, upTo: 97800 }, { rate: 0.039, upTo: Infinity }] },
  },
  // California: 2025 Form 540 tax rate schedules (FTB). The previous thresholds
  // here were TY2023 while the standard deduction was TY2025, so the entry
  // disagreed with itself.
  // The 1 percent Behavioral Health Services Tax (formerly the Mental Health
  // Services Tax) applies over 1,000,000 of taxable income for EVERY filing
  // status. That threshold is never indexed and is NOT doubled for joint
  // filers, while the 12.3 percent band start IS indexed, which is why the
  // joint and head-of-household schedules carry an extra segment. Treating it
  // as a flat 13.3 percent over 1M overstates joint tax by up to about 4,859.
  // TY2026 is NOT published: the 2026 rate schedule 404s and the 2026 Form
  // 540-ES directs filers to the 2025 tables, so there is no 2026 override.
  // Not modelled: exemption CREDITS (153 personal, 475 per dependent), phased
  // out above 252,203 of federal AGI.
  CA: {
    code: "CA", name: "California", type: "progressive",
    deduction: { single: 5706, mfj: 11412, mfs: 5706, hoh: 11412 },
    brackets: { single: [{ rate: 0.01, upTo: 11079 }, { rate: 0.02, upTo: 26264 }, { rate: 0.04, upTo: 41452 }, { rate: 0.06, upTo: 57542 }, { rate: 0.08, upTo: 72724 }, { rate: 0.093, upTo: 371479 }, { rate: 0.103, upTo: 445771 }, { rate: 0.113, upTo: 742953 }, { rate: 0.123, upTo: 1000000 }, { rate: 0.133, upTo: Infinity }], mfs: [{ rate: 0.01, upTo: 11079 }, { rate: 0.02, upTo: 26264 }, { rate: 0.04, upTo: 41452 }, { rate: 0.06, upTo: 57542 }, { rate: 0.08, upTo: 72724 }, { rate: 0.093, upTo: 371479 }, { rate: 0.103, upTo: 445771 }, { rate: 0.113, upTo: 742953 }, { rate: 0.123, upTo: 1000000 }, { rate: 0.133, upTo: Infinity }], mfj: [{ rate: 0.01, upTo: 22158 }, { rate: 0.02, upTo: 52528 }, { rate: 0.04, upTo: 82904 }, { rate: 0.06, upTo: 115084 }, { rate: 0.08, upTo: 145448 }, { rate: 0.093, upTo: 742958 }, { rate: 0.103, upTo: 891542 }, { rate: 0.113, upTo: 1000000 }, { rate: 0.123, upTo: 1485906 }, { rate: 0.133, upTo: Infinity }], hoh: [{ rate: 0.01, upTo: 22173 }, { rate: 0.02, upTo: 52530 }, { rate: 0.04, upTo: 67716 }, { rate: 0.06, upTo: 83805 }, { rate: 0.08, upTo: 98990 }, { rate: 0.093, upTo: 505208 }, { rate: 0.103, upTo: 606251 }, { rate: 0.113, upTo: 1000000 }, { rate: 0.123, upTo: 1010417 }, { rate: 0.133, upTo: Infinity }] },
  },
  // Connecticut: Form CT-1040 TCS (Rev. 12/25), Tables A and B, confirmed
  // identical for 2026 in Form CT-1040ES (Rev. 01/26).
  // The bottom two rates here were 3 and 5 percent, which PA 23-204 sec. 376
  // cut to 2 and 4.5 percent effective TY2024. Thresholds were already right.
  // Connecticut has no standard deduction; what sits in `deduction` is the
  // personal exemption, which is the only thing reducing income, so it is
  // modelled there in order to use the phase-out mechanism.
  // The exemption falls by 1,000 for every 1,000 (or part) of Connecticut AGI
  // over twice the exemption. That is a step function; modelling it as a
  // straight 1-for-1 reduction matches at every full step and differs only
  // inside the final 1,000 band.
  // Not modelled: the 2 percent rate phase-out add-back (Table C), the tax
  // recapture (Table D), which together claw back the benefit of the lower
  // brackets and reach 3,400 for single filers and 6,800 for joint, and the
  // personal tax credit of 1 to 75 percent (Table E) applied after all of that.
  // For a high-income Connecticut filer this understates tax materially.
  CT: {
    code: "CT", name: "Connecticut", type: "progressive",
    deduction: { single: 15000, mfj: 24000, mfs: 12000, hoh: 19000 },
    deductionPhaseOut: {
      startIncome: { single: 30000, mfj: 48000, mfs: 24000, hoh: 38000 },
      ratePerDollar: { single: 1, mfj: 1, mfs: 1, hoh: 1 },
    },
    brackets: { single: [{ rate: 0.02, upTo: 10000 }, { rate: 0.045, upTo: 50000 }, { rate: 0.055, upTo: 100000 }, { rate: 0.06, upTo: 200000 }, { rate: 0.065, upTo: 250000 }, { rate: 0.069, upTo: 500000 }, { rate: 0.0699, upTo: Infinity }], mfs: [{ rate: 0.02, upTo: 10000 }, { rate: 0.045, upTo: 50000 }, { rate: 0.055, upTo: 100000 }, { rate: 0.06, upTo: 200000 }, { rate: 0.065, upTo: 250000 }, { rate: 0.069, upTo: 500000 }, { rate: 0.0699, upTo: Infinity }], mfj: [{ rate: 0.02, upTo: 20000 }, { rate: 0.045, upTo: 100000 }, { rate: 0.055, upTo: 200000 }, { rate: 0.06, upTo: 400000 }, { rate: 0.065, upTo: 500000 }, { rate: 0.069, upTo: 1000000 }, { rate: 0.0699, upTo: Infinity }], hoh: [{ rate: 0.02, upTo: 16000 }, { rate: 0.045, upTo: 80000 }, { rate: 0.055, upTo: 160000 }, { rate: 0.06, upTo: 320000 }, { rate: 0.065, upTo: 400000 }, { rate: 0.069, upTo: 800000 }, { rate: 0.0699, upTo: Infinity }] },
  },
  // Delaware: 30 Del. C. 1102(a)(14), unchanged since TY2014, plus the TY2025
  // PIT-RES instructions. Brackets are NOT doubled for joint filers. The
  // proposed 6.75/6.95 brackets in HS 2 for HB 13 never passed and are not law.
  // Not modelled: the 110 per-exemption nonrefundable CREDIT, which covers the
  // filers as well as dependents; the extra 110 age-60 credit; and the 2,500
  // additional deduction per 65-or-older / blind box.
  DE: {
    code: "DE", name: "Delaware", type: "progressive",
    deduction: { single: 3250, mfs: 3250, mfj: 6500, hoh: 3250 },
    brackets: { single: [{ rate: 0, upTo: 2000 }, { rate: 0.022, upTo: 5000 }, { rate: 0.039, upTo: 10000 }, { rate: 0.048, upTo: 20000 }, { rate: 0.052, upTo: 25000 }, { rate: 0.0555, upTo: 60000 }, { rate: 0.066, upTo: Infinity }], mfs: [{ rate: 0, upTo: 2000 }, { rate: 0.022, upTo: 5000 }, { rate: 0.039, upTo: 10000 }, { rate: 0.048, upTo: 20000 }, { rate: 0.052, upTo: 25000 }, { rate: 0.0555, upTo: 60000 }, { rate: 0.066, upTo: Infinity }], mfj: [{ rate: 0, upTo: 2000 }, { rate: 0.022, upTo: 5000 }, { rate: 0.039, upTo: 10000 }, { rate: 0.048, upTo: 20000 }, { rate: 0.052, upTo: 25000 }, { rate: 0.0555, upTo: 60000 }, { rate: 0.066, upTo: Infinity }], hoh: [{ rate: 0, upTo: 2000 }, { rate: 0.022, upTo: 5000 }, { rate: 0.039, upTo: 10000 }, { rate: 0.048, upTo: 20000 }, { rate: 0.052, upTo: 25000 }, { rate: 0.0555, upTo: 60000 }, { rate: 0.066, upTo: Infinity }] },
  },
  // District of Columbia: OTR individual income tax rate schedule, unchanged
  // for tax years beginning after 2021, so 2025 and 2026 share it. One schedule
  // for every filing status. DC conforms to the federal standard deduction.
  // Verified correct as it stood; annotated rather than changed.
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
  // Hawaii: Act 46 (SLH 2024) phases changes in on alternating years. Bracket
  // thresholds widen in 2025, 2027 and 2029; the standard deduction rises in
  // 2024, 2026, 2028, 2030 and 2031. So 2026 shares these brackets but has a
  // much larger deduction. Exemption is 1,144 per person (HRS 235-54(a)).
  // Not modelled: the extra 1,144 exemption for a taxpayer or spouse 65 or
  // older, and the 7,000 exemption for blind, deaf or totally disabled filers
  // which replaces rather than adds to the ordinary one.
  HI: {
    code: "HI", name: "Hawaii", type: "progressive",
    deduction: { single: 4400, mfj: 8800, mfs: 4400, hoh: 6424 },
    personalExemption: 1144,
    brackets: { single: [{ rate: 0.014, upTo: 9600 }, { rate: 0.032, upTo: 14400 }, { rate: 0.055, upTo: 19200 }, { rate: 0.064, upTo: 24000 }, { rate: 0.068, upTo: 36000 }, { rate: 0.072, upTo: 48000 }, { rate: 0.076, upTo: 125000 }, { rate: 0.079, upTo: 175000 }, { rate: 0.0825, upTo: 225000 }, { rate: 0.09, upTo: 275000 }, { rate: 0.1, upTo: 325000 }, { rate: 0.11, upTo: Infinity }], mfs: [{ rate: 0.014, upTo: 9600 }, { rate: 0.032, upTo: 14400 }, { rate: 0.055, upTo: 19200 }, { rate: 0.064, upTo: 24000 }, { rate: 0.068, upTo: 36000 }, { rate: 0.072, upTo: 48000 }, { rate: 0.076, upTo: 125000 }, { rate: 0.079, upTo: 175000 }, { rate: 0.0825, upTo: 225000 }, { rate: 0.09, upTo: 275000 }, { rate: 0.1, upTo: 325000 }, { rate: 0.11, upTo: Infinity }], mfj: [{ rate: 0.014, upTo: 19200 }, { rate: 0.032, upTo: 28800 }, { rate: 0.055, upTo: 38400 }, { rate: 0.064, upTo: 48000 }, { rate: 0.068, upTo: 72000 }, { rate: 0.072, upTo: 96000 }, { rate: 0.076, upTo: 250000 }, { rate: 0.079, upTo: 350000 }, { rate: 0.0825, upTo: 450000 }, { rate: 0.09, upTo: 550000 }, { rate: 0.1, upTo: 650000 }, { rate: 0.11, upTo: Infinity }], hoh: [{ rate: 0.014, upTo: 14400 }, { rate: 0.032, upTo: 21600 }, { rate: 0.055, upTo: 28800 }, { rate: 0.064, upTo: 36000 }, { rate: 0.068, upTo: 54000 }, { rate: 0.072, upTo: 72000 }, { rate: 0.076, upTo: 187500 }, { rate: 0.079, upTo: 262500 }, { rate: 0.0825, upTo: 337500 }, { rate: 0.09, upTo: 412500 }, { rate: 0.1, upTo: 487500 }, { rate: 0.11, upTo: Infinity }] },
  },
  // Kansas: SB 1 (2024 Special Session). Fixed dollar amounts with no inflation
  // indexing anywhere, so 2025 and 2026 are identical. The revenue trigger in
  // K.S.A. 79-32,110c was tested on 2025-08-15 and did NOT fire, so there is no
  // 2026 rate cut (KDOR Notice 25-06).
  // The exemption is per-return by status, not per person: head of household
  // gets the single amount plus one extra 2,320 dependent-style exemption.
  // Not modelled: the additional standard deduction for 65-or-older and blind
  // filers, and the full exclusion of Social Security from Kansas AGI.
  KS: {
    code: "KS", name: "Kansas", type: "progressive",
    deduction: { single: 3605, mfj: 8240, mfs: 4120, hoh: 6180 },
    personalExemption: {
      byStatus: { single: 9160, mfs: 9160, mfj: 18320, hoh: 11480 },
      perDependent: 2320,
    },
    brackets: { single: [{ rate: 0.052, upTo: 23000 }, { rate: 0.0558, upTo: Infinity }], mfs: [{ rate: 0.052, upTo: 23000 }, { rate: 0.0558, upTo: Infinity }], hoh: [{ rate: 0.052, upTo: 23000 }, { rate: 0.0558, upTo: Infinity }], mfj: [{ rate: 0.052, upTo: 46000 }, { rate: 0.0558, upTo: Infinity }] },
  },
  // Louisiana: Act 11 of the 2024 Third Extraordinary Session repealed the
  // graduated 1.85 / 3.5 / 4.25 percent brackets and replaced them with a FLAT
  // 3 percent from January 1 2025, folding the old personal exemption into a
  // much larger standard deduction. The previous entry here was still modelled
  // as progressive with the repealed rates while already carrying the new
  // deduction, so it disagreed with itself.
  // Source: LDR Revenue Information Bulletin 25-012 and the 2025 IT-540
  // instructions. The 2026 standard deduction is indexed but LDR has published
  // only provisional withholding-table values (12,875 / 25,750), so 2025
  // amounts are carried forward rather than guessed.
  LA: {
    code: "LA", name: "Louisiana", type: "flat", flatRate: 0.03,
    deduction: { single: 12500, mfj: 25000, mfs: 12500, hoh: 25000 },
  },
  // Maine: 2025 individual income tax rate schedules. Form 1040ME line 14 takes
  // federal AGI. Maine sets its own standard deduction and did NOT conform to
  // the OBBBA increase, so it is deliberately not federal conformity.
  // Both the standard deduction and the personal exemption phase out linearly
  // to zero; the deduction phase-out is expressible, the exemption one is not.
  // Not modelled: the personal exemption phase-out above about 333k of AGI, the
  // additional deduction for 65-or-older and blind filers, and the itemized cap.
  ME: {
    code: "ME", name: "Maine", type: "progressive",
    deduction: { single: 15000, mfj: 30000, mfs: 15000, hoh: 22500 },
    deductionPhaseOut: {
      startIncome: { single: 100000, mfs: 100000, hoh: 150000, mfj: 200050 },
      ratePerDollar: { single: 0.2, mfs: 0.2, hoh: 0.2, mfj: 0.2 },
    },
    personalExemption: 5150,
    brackets: { single: [{ rate: 0.058, upTo: 26800 }, { rate: 0.0675, upTo: 63450 }, { rate: 0.0715, upTo: Infinity }], mfs: [{ rate: 0.058, upTo: 26800 }, { rate: 0.0675, upTo: 63450 }, { rate: 0.0715, upTo: Infinity }], hoh: [{ rate: 0.058, upTo: 40200 }, { rate: 0.0675, upTo: 95150 }, { rate: 0.0715, upTo: Infinity }], mfj: [{ rate: 0.058, upTo: 53600 }, { rate: 0.0675, upTo: 126900 }, { rate: 0.0715, upTo: Infinity }] },
  },
  // Maryland: HB 352 (Ch. 604, 2025) repealed the percentage-of-AGI standard
  // deduction entirely and replaced it with flat amounts, and added 6.25 and
  // 6.50 percent top bands. Single/MFS and MFJ/HOH use different schedules.
  // Not modelled here: the mandatory county income tax (2.25 to 3.30 percent),
  // the personal exemption phase-out above 100k FAGI, the 2 percent capital
  // gain surtax above 350k FAGI, and the 7.5 percent itemized reduction.
  MD: {
    code: "MD", name: "Maryland", type: "progressive",
    deduction: { single: 3350, mfs: 3350, mfj: 6700, hoh: 6700 },
    personalExemption: 3200,
    brackets: { single: [{ rate: 0.02, upTo: 1000 }, { rate: 0.03, upTo: 2000 }, { rate: 0.04, upTo: 3000 }, { rate: 0.0475, upTo: 100000 }, { rate: 0.05, upTo: 125000 }, { rate: 0.0525, upTo: 150000 }, { rate: 0.055, upTo: 250000 }, { rate: 0.0575, upTo: 500000 }, { rate: 0.0625, upTo: 1000000 }, { rate: 0.065, upTo: Infinity }], mfs: [{ rate: 0.02, upTo: 1000 }, { rate: 0.03, upTo: 2000 }, { rate: 0.04, upTo: 3000 }, { rate: 0.0475, upTo: 100000 }, { rate: 0.05, upTo: 125000 }, { rate: 0.0525, upTo: 150000 }, { rate: 0.055, upTo: 250000 }, { rate: 0.0575, upTo: 500000 }, { rate: 0.0625, upTo: 1000000 }, { rate: 0.065, upTo: Infinity }], mfj: [{ rate: 0.02, upTo: 1000 }, { rate: 0.03, upTo: 2000 }, { rate: 0.04, upTo: 3000 }, { rate: 0.0475, upTo: 150000 }, { rate: 0.05, upTo: 175000 }, { rate: 0.0525, upTo: 225000 }, { rate: 0.055, upTo: 300000 }, { rate: 0.0575, upTo: 600000 }, { rate: 0.0625, upTo: 1200000 }, { rate: 0.065, upTo: Infinity }], hoh: [{ rate: 0.02, upTo: 1000 }, { rate: 0.03, upTo: 2000 }, { rate: 0.04, upTo: 3000 }, { rate: 0.0475, upTo: 150000 }, { rate: 0.05, upTo: 175000 }, { rate: 0.0525, upTo: 225000 }, { rate: 0.055, upTo: 300000 }, { rate: 0.0575, upTo: 600000 }, { rate: 0.0625, upTo: 1200000 }, { rate: 0.065, upTo: Infinity }] },
  },
  // Massachusetts: flat 5 percent plus the 4 percent surtax above an indexed
  // threshold, modelled as two bands. Massachusetts has no standard deduction;
  // the personal exemptions live in deduction because head of household gets
  // 6,800 rather than twice the single amount, which a per-person exemption
  // could not express.
  // Not modelled: 1,000 per dependent, 700 per filer 65 or older, 2,200 for
  // blindness, and the separate 8.5 percent rate on short-term capital gains.
  MA: {
    code: "MA", name: "Massachusetts", type: "progressive",
    deduction: { single: 4400, mfj: 8800, mfs: 4400, hoh: 6800 },
    brackets: { single: [{ rate: 0.05, upTo: 1083150 }, { rate: 0.09, upTo: Infinity }], mfj: [{ rate: 0.05, upTo: 1083150 }, { rate: 0.09, upTo: Infinity }], mfs: [{ rate: 0.05, upTo: 1083150 }, { rate: 0.09, upTo: Infinity }], hoh: [{ rate: 0.05, upTo: 1083150 }, { rate: 0.09, upTo: Infinity }] },
  },
  // Minnesota: MN DOR inflation-adjusted amounts for 2025. Form M1 line 1 takes
  // federal AGI, and Minnesota sets its own deduction amounts, not federal ones.
  // Minnesota has NO personal exemption for filers, only a 5,200 per-dependent
  // exemption, which is why the object form is used with a zero base.
  // Not modelled: the standard deduction limitation above 238,950 of AGI, the
  // dependent exemption phase-out, and the child credit (whose phase-out depends
  // on child count and interacts with the Working Family Credit).
  MN: {
    code: "MN", name: "Minnesota", type: "progressive",
    deduction: { single: 14950, mfs: 14950, mfj: 29900, hoh: 22500 },
    personalExemption: { byStatus: { single: 0, mfs: 0, mfj: 0, hoh: 0 }, perDependent: 5200 },
    brackets: { single: [{ rate: 0.0535, upTo: 32570 }, { rate: 0.068, upTo: 106990 }, { rate: 0.0785, upTo: 198630 }, { rate: 0.0985, upTo: Infinity }], mfj: [{ rate: 0.0535, upTo: 47620 }, { rate: 0.068, upTo: 189180 }, { rate: 0.0785, upTo: 330410 }, { rate: 0.0985, upTo: Infinity }], mfs: [{ rate: 0.0535, upTo: 23810 }, { rate: 0.068, upTo: 94590 }, { rate: 0.0785, upTo: 165205 }, { rate: 0.0985, upTo: Infinity }], hoh: [{ rate: 0.0535, upTo: 40100 }, { rate: 0.068, upTo: 161130 }, { rate: 0.0785, upTo: 264050 }, { rate: 0.0985, upTo: Infinity }] },
  },
  // Missouri: verified against the official 2025 Tax Chart and the DOR summary
  // of 2025 legislative changes.
  // - ONE schedule for every filing status. MO-1040 splits income between the
  //   spouses (lines 29Y/29S) and runs each half through the same chart, so the
  //   brackets are NOT doubled for a joint return.
  // - First $1,313 of Missouri taxable income is untaxed.
  // - HB 594 / HB 508 (Section 143.121): 100% of the income reported as capital
  //   gain for federal purposes is subtracted in determining Missouri AGI, for
  //   individuals, effective January 1 2025.
  // - Missouri uses the federal standard deduction amounts.
  MO: {
    code: "MO", name: "Missouri", type: "progressive",
    deduction: "federal",
    capitalGainsExclusion: { pct: 1, appliesTo: "all" },
    brackets: {
      single: [
        { rate: 0, upTo: 1313 },
        { rate: 0.02, upTo: 2626 },
        { rate: 0.025, upTo: 3939 },
        { rate: 0.03, upTo: 5252 },
        { rate: 0.035, upTo: 6565 },
        { rate: 0.04, upTo: 7878 },
        { rate: 0.045, upTo: 9191 },
        { rate: 0.047, upTo: Infinity },
      ],
      mfj: [
        { rate: 0, upTo: 1313 },
        { rate: 0.02, upTo: 2626 },
        { rate: 0.025, upTo: 3939 },
        { rate: 0.03, upTo: 5252 },
        { rate: 0.035, upTo: 6565 },
        { rate: 0.04, upTo: 7878 },
        { rate: 0.045, upTo: 9191 },
        { rate: 0.047, upTo: Infinity },
      ],
      mfs: [
        { rate: 0, upTo: 1313 },
        { rate: 0.02, upTo: 2626 },
        { rate: 0.025, upTo: 3939 },
        { rate: 0.03, upTo: 5252 },
        { rate: 0.035, upTo: 6565 },
        { rate: 0.04, upTo: 7878 },
        { rate: 0.045, upTo: 9191 },
        { rate: 0.047, upTo: Infinity },
      ],
      hoh: [
        { rate: 0, upTo: 1313 },
        { rate: 0.02, upTo: 2626 },
        { rate: 0.025, upTo: 3939 },
        { rate: 0.03, upTo: 5252 },
        { rate: 0.035, upTo: 6565 },
        { rate: 0.04, upTo: 7878 },
        { rate: 0.045, upTo: 9191 },
        { rate: 0.047, upTo: Infinity },
      ],
    },
  },
  // Montana: 2025 Form 2 instructions p.12 and HB 337 (2025) for 2026.
  // SB 399 conformed Montana to the federal deduction, so it has neither its own
  // standard deduction nor a personal exemption. HB 337 suspends bracket
  // indexing until TY2028, so the 2026 figures are literal statutory amounts.
  MT: {
    code: "MT", name: "Montana", type: "progressive",
    startingPoint: "federal_taxable",
    brackets: {
      single: [{ rate: 0.047, upTo: 21100 }, { rate: 0.059, upTo: Infinity }],
      mfj: [{ rate: 0.047, upTo: 42200 }, { rate: 0.059, upTo: Infinity }],
      mfs: [{ rate: 0.047, upTo: 21100 }, { rate: 0.059, upTo: Infinity }],
      hoh: [{ rate: 0.047, upTo: 31700 }, { rate: 0.059, upTo: Infinity }],
    },
  },
  // Nebraska: 2025 Tax Calculation Schedule (8-460-2025) and the individual
  // income tax booklet. Nebraska sets its own indexed standard deduction, so
  // this is not federal conformity. Brackets are CPI-indexed annually.
  // Not modelled: the per-exemption nonrefundable CREDIT (171 in 2025, 176 in
  // 2026, covering filers and dependents) and the additional standard deduction
  // for 65-or-older and blind filers.
  NE: {
    code: "NE", name: "Nebraska", type: "progressive",
    deduction: { single: 8600, mfj: 17200, mfs: 8600, hoh: 12600 },
    brackets: { single: [{ rate: 0.0246, upTo: 4030 }, { rate: 0.0351, upTo: 24120 }, { rate: 0.0501, upTo: 38870 }, { rate: 0.052, upTo: Infinity }], mfs: [{ rate: 0.0246, upTo: 4030 }, { rate: 0.0351, upTo: 24120 }, { rate: 0.0501, upTo: 38870 }, { rate: 0.052, upTo: Infinity }], mfj: [{ rate: 0.0246, upTo: 8040 }, { rate: 0.0351, upTo: 48250 }, { rate: 0.0501, upTo: 77730 }, { rate: 0.052, upTo: Infinity }], hoh: [{ rate: 0.0246, upTo: 7510 }, { rate: 0.0351, upTo: 38590 }, { rate: 0.0501, upTo: 57630 }, { rate: 0.052, upTo: Infinity }] },
  },
  // North Dakota: 2025 individual income tax booklet p.27. ND-1 line 1b takes
  // federal taxable income from Form 1040 line 15 directly. No state standard
  // deduction or personal exemption; the 0% band serves that role. 40% of net
  // long-term capital gain is excluded (ND-1 line 6).
  ND: {
    code: "ND", name: "North Dakota", type: "progressive",
    startingPoint: "federal_taxable",
    capitalGainsExclusion: { pct: 0.4, appliesTo: "longTerm" },
    brackets: {
      single: [{ rate: 0, upTo: 48475 }, { rate: 0.0195, upTo: 244825 }, { rate: 0.025, upTo: Infinity }],
      mfj: [{ rate: 0, upTo: 80975 }, { rate: 0.0195, upTo: 298075 }, { rate: 0.025, upTo: Infinity }],
      mfs: [{ rate: 0, upTo: 40475 }, { rate: 0.0195, upTo: 149025 }, { rate: 0.025, upTo: Infinity }],
      hoh: [{ rate: 0, upTo: 64950 }, { rate: 0.0195, upTo: 271450 }, { rate: 0.025, upTo: Infinity }],
    },
  },
  // New Jersey: 2025 NJ-1040 instructions p.63, Tables A and B. Rates unchanged
  // since 2020 and IDENTICAL for 2026 (2026 NJ-1040-ES). No standard deduction.
  // Not modelled: exemptions are not uniform per person (1,000 filer and spouse
  // but 1,500 per dependent, plus 6,000 veteran and 1,000 college additions);
  // New Jersey gross income is NOT federal AGI (403(b) and 457 contributions
  // are taxed when earned, Social Security and military pensions are exempt);
  // and there is no cross-category loss offset and no 3,000 capital loss
  // allowance.
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
  // New Mexico: section 7-2-7 NMSA 1978 as amended by HB 252 (2024). The
  // schedule is stated in fixed dollars with NO inflation-adjustment clause, so
  // 2025 and 2026 are identical. Head of household uses the joint schedule and
  // MFS is exactly half of joint, both per the statute.
  // PIT-1 starts at federal AGI and then subtracts the federal standard or
  // itemized deduction, so this is genuine federal conformity.
  // Not modelled: the low- and middle-income exemption (up to 2,500 per
  // exemption, phased out by AGI), the 4,000-per-extra-dependent deduction for
  // joint and head-of-household filers, and the refundable child credit.
  NM: {
    code: "NM", name: "New Mexico", type: "progressive",
    deduction: "federal",
    brackets: { single: [{ rate: 0.015, upTo: 5500 }, { rate: 0.032, upTo: 16500 }, { rate: 0.043, upTo: 33500 }, { rate: 0.047, upTo: 66500 }, { rate: 0.049, upTo: 210000 }, { rate: 0.059, upTo: Infinity }], mfj: [{ rate: 0.015, upTo: 8000 }, { rate: 0.032, upTo: 25000 }, { rate: 0.043, upTo: 50000 }, { rate: 0.047, upTo: 100000 }, { rate: 0.049, upTo: 315000 }, { rate: 0.059, upTo: Infinity }], hoh: [{ rate: 0.015, upTo: 8000 }, { rate: 0.032, upTo: 25000 }, { rate: 0.043, upTo: 50000 }, { rate: 0.047, upTo: 100000 }, { rate: 0.049, upTo: 315000 }, { rate: 0.059, upTo: Infinity }], mfs: [{ rate: 0.015, upTo: 4000 }, { rate: 0.032, upTo: 12500 }, { rate: 0.043, upTo: 25000 }, { rate: 0.047, upTo: 50000 }, { rate: 0.049, upTo: 157500 }, { rate: 0.059, upTo: Infinity }] },
  },
  // New York: 2025 Form IT-201-I p.33. The fourth and fifth rates here were
  // 5.85 and 6.25 percent, repealed after TY2022; the correct 2025 figures are
  // 5.5 and 6.0 percent. Thresholds were already right.
  // Not modelled: the tax benefit recapture above 107,650 of New York AGI,
  // which converts the schedule to a flat rate plus a recapture base and is
  // worth tens of thousands at the top; NYC resident tax of 3.078 to 3.876
  // percent; and the Yonkers surcharge of 16.75 percent of net state tax.
  // The 1,000 dependent exemption covers dependents only, not the filer, so it
  // cannot use personalExemption.
  NY: {
    code: "NY", name: "New York", type: "progressive",
    deduction: { single: 8000, mfj: 16050, mfs: 8000, hoh: 11200 },
    brackets: { single: [{ rate: 0.04, upTo: 8500 }, { rate: 0.045, upTo: 11700 }, { rate: 0.0525, upTo: 13900 }, { rate: 0.055, upTo: 80650 }, { rate: 0.06, upTo: 215400 }, { rate: 0.0685, upTo: 1077550 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }], mfs: [{ rate: 0.04, upTo: 8500 }, { rate: 0.045, upTo: 11700 }, { rate: 0.0525, upTo: 13900 }, { rate: 0.055, upTo: 80650 }, { rate: 0.06, upTo: 215400 }, { rate: 0.0685, upTo: 1077550 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }], mfj: [{ rate: 0.04, upTo: 17150 }, { rate: 0.045, upTo: 23600 }, { rate: 0.0525, upTo: 27900 }, { rate: 0.055, upTo: 161550 }, { rate: 0.06, upTo: 323200 }, { rate: 0.0685, upTo: 2155350 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }], hoh: [{ rate: 0.04, upTo: 12800 }, { rate: 0.045, upTo: 17650 }, { rate: 0.0525, upTo: 20900 }, { rate: 0.055, upTo: 107650 }, { rate: 0.06, upTo: 269300 }, { rate: 0.0685, upTo: 1616450 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }] },
  },
  // Ohio: 2025 IT 1040 booklet p.18 and ORC 5747.02. One schedule for every
  // filing status, starting from federal AGI. Ohio has no standard deduction.
  // KNOWN SHORTFALL: Ohio's published schedule carries lump base amounts (342
  // for 2025 above the 26,050 threshold, 332 for 2026) that a pure bracket walk
  // cannot reproduce, so Ohio tax is understated by roughly that amount for any
  // income above the threshold. Expressing it would need a base-amount field.
  // Not modelled: the tiered personal and dependent exemption, which is 2,400
  // below 40,000 of modified AGI, 2,150 to 80,000, 1,900 to 749,999 and zero
  // above that; the business income deduction and its flat 3 percent rate; and
  // mandatory municipal and school district income taxes.
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
  // Oklahoma: 2025 Form 511 packet. Standard deduction is fixed statutory
  // dollars, not federal conformity, and is not indexed. $1,000 per exemption.
  OK: {
    code: "OK", name: "Oklahoma", type: "progressive",
    deduction: { single: 6350, mfs: 6350, hoh: 9350, mfj: 12700 },
    personalExemption: 1000,
    brackets: {
      single: [{ rate: 0.0025, upTo: 1000 }, { rate: 0.0075, upTo: 2500 }, { rate: 0.0175, upTo: 3750 }, { rate: 0.0275, upTo: 4900 }, { rate: 0.0375, upTo: 7200 }, { rate: 0.0475, upTo: Infinity }],
      mfs: [{ rate: 0.0025, upTo: 1000 }, { rate: 0.0075, upTo: 2500 }, { rate: 0.0175, upTo: 3750 }, { rate: 0.0275, upTo: 4900 }, { rate: 0.0375, upTo: 7200 }, { rate: 0.0475, upTo: Infinity }],
      mfj: [{ rate: 0.0025, upTo: 2000 }, { rate: 0.0075, upTo: 5000 }, { rate: 0.0175, upTo: 7500 }, { rate: 0.0275, upTo: 9800 }, { rate: 0.0375, upTo: 14400 }, { rate: 0.0475, upTo: Infinity }],
      hoh: [{ rate: 0.0025, upTo: 2000 }, { rate: 0.0075, upTo: 5000 }, { rate: 0.0175, upTo: 7500 }, { rate: 0.0275, upTo: 9800 }, { rate: 0.0375, upTo: 14400 }, { rate: 0.0475, upTo: Infinity }],
    },
  },
  // Oregon: Form OR-40 starts from FEDERAL AGI and applies Oregon's own small
  // standard deduction, so federal conformity would be badly wrong here. The
  // federal income tax subtraction (up to $8,500 in 2025) and the per-exemption
  // CREDIT ($256) are separate line items the schema cannot express; both are
  // documented in the audit rather than approximated.
  OR: {
    code: "OR", name: "Oregon", type: "progressive",
    deduction: { single: 2835, mfs: 2835, hoh: 4560, mfj: 5670 },
    brackets: {
      single: [{ rate: 0.0475, upTo: 4400 }, { rate: 0.0675, upTo: 11100 }, { rate: 0.0875, upTo: 125000 }, { rate: 0.099, upTo: Infinity }],
      mfs: [{ rate: 0.0475, upTo: 4400 }, { rate: 0.0675, upTo: 11100 }, { rate: 0.0875, upTo: 125000 }, { rate: 0.099, upTo: Infinity }],
      mfj: [{ rate: 0.0475, upTo: 8800 }, { rate: 0.0675, upTo: 22200 }, { rate: 0.0875, upTo: 250000 }, { rate: 0.099, upTo: Infinity }],
      hoh: [{ rate: 0.0475, upTo: 8800 }, { rate: 0.0675, upTo: 22200 }, { rate: 0.0875, upTo: 250000 }, { rate: 0.099, upTo: Infinity }],
    },
  },
  // Rhode Island: ADV 2024-26 inflation adjustments. ONE uniform schedule for
  // every filing status, stated verbatim on the rate schedule. Rhode Island
  // does not conform to the federal standard deduction and does not allow
  // itemizing. Exemption is per person (filers plus dependents).
  // Not modelled: the four-step cliff phase-out that erases BOTH the standard
  // deduction and the exemptions between about 254k and 283k of modified AGI.
  RI: {
    code: "RI", name: "Rhode Island", type: "progressive",
    deduction: { single: 10900, mfj: 21800, mfs: 10900, hoh: 16350 },
    personalExemption: 5100,
    brackets: { single: [{ rate: 0.0375, upTo: 79900 }, { rate: 0.0475, upTo: 181650 }, { rate: 0.0599, upTo: Infinity }], mfj: [{ rate: 0.0375, upTo: 79900 }, { rate: 0.0475, upTo: 181650 }, { rate: 0.0599, upTo: Infinity }], mfs: [{ rate: 0.0375, upTo: 79900 }, { rate: 0.0475, upTo: 181650 }, { rate: 0.0599, upTo: Infinity }], hoh: [{ rate: 0.0375, upTo: 79900 }, { rate: 0.0475, upTo: 181650 }, { rate: 0.0599, upTo: Infinity }] },
  },
  // South Carolina: SC1040TT 2025 and the SCDOR policy manual. Top rate for
  // TY2025 is 6.0% (the legislature accelerated the reduction by budget proviso).
  // ONE schedule for every filing status, stated verbatim on SC1040TT p.4.
  // Thresholds reproduce the printed table exactly (0.06 x income - 642).
  // 44% of net long-term capital gain is deducted (12-6-1150).
  SC: {
    code: "SC", name: "South Carolina", type: "progressive",
    startingPoint: "federal_taxable",
    capitalGainsExclusion: { pct: 0.44, appliesTo: "longTerm" },
    brackets: {
      single: [{ rate: 0, upTo: 3550 }, { rate: 0.03, upTo: 17850 }, { rate: 0.06, upTo: Infinity }],
      mfj: [{ rate: 0, upTo: 3550 }, { rate: 0.03, upTo: 17850 }, { rate: 0.06, upTo: Infinity }],
      mfs: [{ rate: 0, upTo: 3550 }, { rate: 0.03, upTo: 17850 }, { rate: 0.06, upTo: Infinity }],
      hoh: [{ rate: 0, upTo: 3550 }, { rate: 0.03, upTo: 17850 }, { rate: 0.06, upTo: Infinity }],
    },
  },
  // Vermont: 2025 Vermont Tax Rate Schedules and IN-111 instructions. Since
  // Act 11 (TY2018) IN-111 line 1 is federal AGI, not federal taxable income.
  // Vermont sets its own standard deduction and a per-person exemption.
  // The child credit is 1,000 per child aged 6 or under, reduced 20 per 1,000
  // of AGI over 125,000 and gone at 175,000, which the schema can express.
  // Not modelled: the 3 percent minimum tax on federal AGI above 150,000, the
  // 1,250 additional deduction per 65-or-older / blind box, and the child
  // credit's age test (it applies to children 6 and under, not the federal
  // definition, so the count entered here may be too high).
  // TY2026 filing schedules are NOT published; the 2026 rate schedule PDF 404s.
  VT: {
    code: "VT", name: "Vermont", type: "progressive",
    deduction: { single: 7650, mfj: 15300, mfs: 7650, hoh: 11450 },
    personalExemption: 5300,
    dependentCredit: {
      perChild: 1000, perOtherDependent: 0,
      phaseOutStart: { single: 125000, mfj: 125000, mfs: 125000, hoh: 125000 },
      phaseOutRatePerStep: 20 / 1000, phaseOutStep: 1000, phaseOutFullyLostAbove: 50000,
    },
    brackets: { single: [{ rate: 0.0335, upTo: 49400 }, { rate: 0.066, upTo: 119700 }, { rate: 0.076, upTo: 249700 }, { rate: 0.0875, upTo: Infinity }], mfj: [{ rate: 0.0335, upTo: 82500 }, { rate: 0.066, upTo: 199450 }, { rate: 0.076, upTo: 304000 }, { rate: 0.0875, upTo: Infinity }], mfs: [{ rate: 0.0335, upTo: 41250 }, { rate: 0.066, upTo: 99725 }, { rate: 0.076, upTo: 152000 }, { rate: 0.0875, upTo: Infinity }], hoh: [{ rate: 0.0335, upTo: 66200 }, { rate: 0.066, upTo: 171000 }, { rate: 0.076, upTo: 276850 }, { rate: 0.0875, upTo: Infinity }] },
  },
  // Virginia: one rate schedule for every filing status, unchanged both years.
  // Virginia has no head-of-household status, so HOH maps to single. The 930
  // per-person exemption was missing.
  // Note the elevated standard deduction is scheduled to sunset after TY2026
  // and revert to 3,000 / 6,000, so 2026 values must not carry into 2027.
  // Not modelled: the extra 800 exemption for 65 or older and for blindness,
  // and the Spouse Tax Adjustment worth up to 259 for joint filers.
  VA: {
    code: "VA", name: "Virginia", type: "progressive",
    deduction: { single: 8750, mfj: 17500, mfs: 8750, hoh: 8750 },
    personalExemption: 930,
    brackets: { single: [{ rate: 0.02, upTo: 3000 }, { rate: 0.03, upTo: 5000 }, { rate: 0.05, upTo: 17000 }, { rate: 0.0575, upTo: Infinity }], mfj: [{ rate: 0.02, upTo: 3000 }, { rate: 0.03, upTo: 5000 }, { rate: 0.05, upTo: 17000 }, { rate: 0.0575, upTo: Infinity }], mfs: [{ rate: 0.02, upTo: 3000 }, { rate: 0.03, upTo: 5000 }, { rate: 0.05, upTo: 17000 }, { rate: 0.0575, upTo: Infinity }], hoh: [{ rate: 0.02, upTo: 3000 }, { rate: 0.03, upTo: 5000 }, { rate: 0.05, upTo: 17000 }, { rate: 0.0575, upTo: Infinity }] },
  },
  // West Virginia: 2025 IT-140 booklet p.35, Rate Schedules I and II, and
  // W. Va. Code 11-21-4i. Married filing separately uses exactly half the
  // thresholds. There is no standard deduction; the exemption is 2,000 per
  // person (500 if no exemptions are claimed).
  // Not modelled: the Family Tax Credit, which can zero out the whole liability
  // for low-income filers, the low-income earned income exclusion, and the
  // 8,000 senior modification.
  WV: {
    code: "WV", name: "West Virginia", type: "progressive",
    personalExemption: 2000,
    brackets: { single: [{ rate: 0.0222, upTo: 10000 }, { rate: 0.0296, upTo: 25000 }, { rate: 0.0333, upTo: 40000 }, { rate: 0.0444, upTo: 60000 }, { rate: 0.0482, upTo: Infinity }], mfj: [{ rate: 0.0222, upTo: 10000 }, { rate: 0.0296, upTo: 25000 }, { rate: 0.0333, upTo: 40000 }, { rate: 0.0444, upTo: 60000 }, { rate: 0.0482, upTo: Infinity }], hoh: [{ rate: 0.0222, upTo: 10000 }, { rate: 0.0296, upTo: 25000 }, { rate: 0.0333, upTo: 40000 }, { rate: 0.0444, upTo: 60000 }, { rate: 0.0482, upTo: Infinity }], mfs: [{ rate: 0.0222, upTo: 5000 }, { rate: 0.0296, upTo: 12500 }, { rate: 0.0333, upTo: 20000 }, { rate: 0.0444, upTo: 30000 }, { rate: 0.0482, upTo: Infinity }] },
  },
  // Wisconsin: 2025 Form 1-ES instructions (D-101A R. 1-25), including the
  // 2025 Act 15 update that raised the second/third bracket boundary.
  // The standard deduction is NOT flat: it is the maximum up to a threshold and
  // then falls by a fixed fraction of every dollar above it, reaching zero
  // around $132,549 for a single filer. Head of household starts on a steeper
  // slope and converges onto the single-filer line, hence the secondary segment.
  WI: {
    code: "WI", name: "Wisconsin", type: "progressive",
    deduction: { single: 13560, mfj: 25110, mfs: 11930, hoh: 17520 },
    deductionPhaseOut: {
      startIncome: { single: 19550, mfj: 28210, mfs: 13390, hoh: 19550 },
      ratePerDollar: { single: 0.12, mfj: 0.19778, mfs: 0.19778, hoh: 0.22515 },
      secondary: { hoh: { base: 13560, ratePerDollar: 0.12 } },
    },
    personalExemption: 700,
    brackets: {
      single: [{ rate: 0.035, upTo: 14680 }, { rate: 0.044, upTo: 50480 }, { rate: 0.053, upTo: 323290 }, { rate: 0.0765, upTo: Infinity }],
      mfj: [{ rate: 0.035, upTo: 19580 }, { rate: 0.044, upTo: 67300 }, { rate: 0.053, upTo: 431060 }, { rate: 0.0765, upTo: Infinity }],
      mfs: [{ rate: 0.035, upTo: 9790 }, { rate: 0.044, upTo: 33650 }, { rate: 0.053, upTo: 215530 }, { rate: 0.0765, upTo: Infinity }],
      hoh: [{ rate: 0.035, upTo: 14680 }, { rate: 0.044, upTo: 50480 }, { rate: 0.053, upTo: 323290 }, { rate: 0.0765, upTo: Infinity }],
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

// ============================================================================
// Year dimension
// ============================================================================
//
// STATE_TAX_DATA above is the TY2025 table. States change rates far more often
// than the federal government, so a single year-agnostic table cannot be right
// for both years the estimator offers: New York, Georgia, North Carolina,
// Indiana, Utah, South Carolina, Mississippi, Kentucky, Ohio, Montana,
// Nebraska, Oklahoma and Michigan all moved between 2025 and 2026.
//
// Rather than duplicate 51 jurisdictions per year, each later year declares
// only what differs and is merged over the base. An entry here is a complete
// replacement for that state, not a deep merge, so partial edits are explicit.
//
// UNVERIFIED states carry their TY2025 values into later years by default. That
// is not a claim they are correct: it is the previous behaviour, now at least
// scoped so a verified year can be corrected without disturbing the other.

const STATE_TAX_OVERRIDES: Record<number, Record<string, StateTaxConfig>> = {
  2026: {
    // Arizona verified against AZDOR for TY2026 and unchanged from TY2025:
    // - Rate is still 2.5%: 2026 Form 140ES states "the tax rate for estimating
    //   your tax liability is 2.5%", and worksheet line 19 multiplies by .025.
    // - Standard deduction: AZDOR has not published TY2026 amounts and tells
    //   filers to use the 2025 figure for estimating. Arizona sets its own
    //   amounts under A.R.S. 43-1041 but indexes by the same method as IRC 63,
    //   and published amounts have tracked the federal figures exactly, so
    //   federal conformity stays the best available model.
    // - Dependent credit amounts and thresholds are statutory, not indexed.
    // Spread rather than restated so the two years cannot silently drift.
    AZ: { ...STATE_TAX_DATA.AZ },

    // Michigan: Form 446 Withholding Guide (Rev. 02-26) gives rate 4.25% and
    // personal exemption $5,900. The Treasury rate determination published
    // 2026-04-15 found revenue fell, so the MCL 206.51 rollback did not trigger.
    MI: { ...STATE_TAX_DATA.MI, personalExemption: 5900 },

    // Mississippi: Pub 89-700-25-1 (revised 2026-01-13) sets the rate above the
    // $10,000 exempt band at 4.0% for 2026, per HB 1 (2025). Deductions and
    // exemptions are fixed in statute and unchanged.
    MS: {
      ...STATE_TAX_DATA.MS,
      brackets: {
        single: [{ rate: 0, upTo: 10000 }, { rate: 0.04, upTo: Infinity }],
        mfj: [{ rate: 0, upTo: 10000 }, { rate: 0.04, upTo: Infinity }],
        mfs: [{ rate: 0, upTo: 10000 }, { rate: 0.04, upTo: Infinity }],
        hoh: [{ rate: 0, upTo: 10000 }, { rate: 0.04, upTo: Infinity }],
      },
    },


    // South Carolina restructured entirely for TY2026 under Act 110 (H.4216):
    // the starting point moves from federal taxable income to AGI, the schedule
    // becomes two-tier 1.99% / 5.21% at $30,000 of SC taxable income, and a new
    // SC Income Adjusted Deduction replaces federal deduction conformity.
    // The SCIAD phases out linearly to zero over a fixed range, so it is
    // expressible as base/range per dollar: 15,000/55,000 = 30,000/110,000.
    SC: {
      code: "SC", name: "South Carolina", type: "progressive",
      capitalGainsExclusion: { pct: 0.44, appliesTo: "longTerm" },
      deduction: { single: 15000, mfj: 30000, mfs: 15000, hoh: 22500 },
      deductionPhaseOut: {
        startIncome: { single: 40000, mfj: 80000, mfs: 40000, hoh: 60000 },
        ratePerDollar: { single: 15000 / 55000, mfj: 30000 / 110000, mfs: 15000 / 55000, hoh: 22500 / 82500 },
      },
      brackets: {
        single: [{ rate: 0.0199, upTo: 30000 }, { rate: 0.0521, upTo: Infinity }],
        mfj: [{ rate: 0.0199, upTo: 30000 }, { rate: 0.0521, upTo: Infinity }],
        mfs: [{ rate: 0.0199, upTo: 30000 }, { rate: 0.0521, upTo: Infinity }],
        hoh: [{ rate: 0.0199, upTo: 30000 }, { rate: 0.0521, upTo: Infinity }],
      },
    },


    // Oklahoma restructured for TY2026 under HB 2764 (2025): six brackets become
    // four, with a 0% band and a 4.5% top rate. Deduction and exemption unchanged.
    OK: {
      ...STATE_TAX_DATA.OK,
      brackets: {
        single: [{ rate: 0, upTo: 3750 }, { rate: 0.025, upTo: 4900 }, { rate: 0.035, upTo: 7200 }, { rate: 0.045, upTo: Infinity }],
        mfs: [{ rate: 0, upTo: 3750 }, { rate: 0.025, upTo: 4900 }, { rate: 0.035, upTo: 7200 }, { rate: 0.045, upTo: Infinity }],
        mfj: [{ rate: 0, upTo: 7500 }, { rate: 0.025, upTo: 9800 }, { rate: 0.035, upTo: 14400 }, { rate: 0.045, upTo: Infinity }],
        hoh: [{ rate: 0, upTo: 7500 }, { rate: 0.025, upTo: 9800 }, { rate: 0.035, upTo: 14400 }, { rate: 0.045, upTo: Infinity }],
      },
    },

    // Oregon 2026: rates and the 9.9% thresholds are statutory and unchanged;
    // the two lower breakpoints and the standard deductions are indexed.
    // Head of household 2026 is NOT yet published (the 2026 OR-40 instructions
    // do not exist), so it carries the 2025 amount rather than a guess.
    OR: {
      ...STATE_TAX_DATA.OR,
      deduction: { single: 2910, mfs: 2910, hoh: 4560, mfj: 5820 },
      brackets: {
        single: [{ rate: 0.0475, upTo: 4550 }, { rate: 0.0675, upTo: 11400 }, { rate: 0.0875, upTo: 125000 }, { rate: 0.099, upTo: Infinity }],
        mfs: [{ rate: 0.0475, upTo: 4550 }, { rate: 0.0675, upTo: 11400 }, { rate: 0.0875, upTo: 125000 }, { rate: 0.099, upTo: Infinity }],
        mfj: [{ rate: 0.0475, upTo: 9100 }, { rate: 0.0675, upTo: 22800 }, { rate: 0.0875, upTo: 250000 }, { rate: 0.099, upTo: Infinity }],
        hoh: [{ rate: 0.0475, upTo: 9100 }, { rate: 0.0675, upTo: 22800 }, { rate: 0.0875, upTo: 250000 }, { rate: 0.099, upTo: Infinity }],
      },
    },


    // Maryland 2026: brackets and personal exemption unchanged. Only the single
    // and MFS standard deduction is published as indexed (3,400, per the 2026
    // Employer Withholding Guide). The joint figure is NOT published and the
    // 2026 PV worksheet still shows the stale 6,700, so it carries forward
    // rather than being guessed at.
    MD: { ...STATE_TAX_DATA.MD, deduction: { single: 3400, mfs: 3400, mfj: 6700, hoh: 6700 } },

    // Minnesota 2026: published by MN DOR on 2025-12-16. Every bracket
    // threshold, the standard deductions and the dependent exemption all moved.
    MN: {
      ...STATE_TAX_DATA.MN,
      deduction: { single: 15300, mfs: 15300, mfj: 30600, hoh: 23000 },
      personalExemption: { byStatus: { single: 0, mfs: 0, mfj: 0, hoh: 0 }, perDependent: 5300 },
      brackets: { single: [{ rate: 0.0535, upTo: 33310 }, { rate: 0.068, upTo: 109430 }, { rate: 0.0785, upTo: 203150 }, { rate: 0.0985, upTo: Infinity }], mfj: [{ rate: 0.0535, upTo: 48700 }, { rate: 0.068, upTo: 193480 }, { rate: 0.0785, upTo: 337930 }, { rate: 0.0985, upTo: Infinity }], mfs: [{ rate: 0.0535, upTo: 24350 }, { rate: 0.068, upTo: 96740 }, { rate: 0.0785, upTo: 168965 }, { rate: 0.0985, upTo: Infinity }], hoh: [{ rate: 0.0535, upTo: 41010 }, { rate: 0.068, upTo: 164800 }, { rate: 0.0785, upTo: 270060 }, { rate: 0.0985, upTo: Infinity }] },
    },


    // Nebraska 2026: LB 754 cuts the top rate to 4.55 percent, which collapses
    // the old third and fourth tiers into one. Brackets and the standard
    // deduction are CPI-indexed. Source: 2026 Form 1040N-ES (Rev. 11-2025).
    NE: {
      ...STATE_TAX_DATA.NE,
      deduction: { single: 8850, mfj: 17700, mfs: 8850, hoh: 12950 },
      brackets: { single: [{ rate: 0.0246, upTo: 4130 }, { rate: 0.0351, upTo: 24760 }, { rate: 0.0455, upTo: Infinity }], mfs: [{ rate: 0.0246, upTo: 4130 }, { rate: 0.0351, upTo: 24760 }, { rate: 0.0455, upTo: Infinity }], mfj: [{ rate: 0.0246, upTo: 8250 }, { rate: 0.0351, upTo: 49530 }, { rate: 0.0455, upTo: Infinity }], hoh: [{ rate: 0.0246, upTo: 7700 }, { rate: 0.0351, upTo: 39620 }, { rate: 0.0455, upTo: Infinity }] },
    },


    // Rhode Island 2026: ADV 2025-22. All thresholds, the standard deduction
    // and the exemption are indexed upward.
    RI: {
      ...STATE_TAX_DATA.RI,
      deduction: { single: 11200, mfj: 22400, mfs: 11200, hoh: 16800 },
      personalExemption: 5250,
      brackets: { single: [{ rate: 0.0375, upTo: 82050 }, { rate: 0.0475, upTo: 186450 }, { rate: 0.0599, upTo: Infinity }], mfj: [{ rate: 0.0375, upTo: 82050 }, { rate: 0.0475, upTo: 186450 }, { rate: 0.0599, upTo: Infinity }], mfs: [{ rate: 0.0375, upTo: 82050 }, { rate: 0.0475, upTo: 186450 }, { rate: 0.0599, upTo: Infinity }], hoh: [{ rate: 0.0375, upTo: 82050 }, { rate: 0.0475, upTo: 186450 }, { rate: 0.0599, upTo: Infinity }] },
    },

    // Utah 2026: SB 60 (2026 General Session, enrolled) cuts the rate to 4.45
    // percent, retrospective to January 1 2026, and Publication 14 (Rev. 4/26)
    // already withholds at that rate.
    UT: { ...STATE_TAX_DATA.UT, flatRate: 0.0445 },


    // West Virginia 2026: SB 392 (signed 2026-03-31, retroactive to January 1)
    // cut every rate by about 5 percent. Thresholds and the exemption are
    // unchanged. Codified at W. Va. Code 11-21-4j.
    WV: {
      ...STATE_TAX_DATA.WV,
      brackets: { single: [{ rate: 0.0211, upTo: 10000 }, { rate: 0.0281, upTo: 25000 }, { rate: 0.0316, upTo: 40000 }, { rate: 0.0422, upTo: 60000 }, { rate: 0.0458, upTo: Infinity }], mfj: [{ rate: 0.0211, upTo: 10000 }, { rate: 0.0281, upTo: 25000 }, { rate: 0.0316, upTo: 40000 }, { rate: 0.0422, upTo: 60000 }, { rate: 0.0458, upTo: Infinity }], hoh: [{ rate: 0.0211, upTo: 10000 }, { rate: 0.0281, upTo: 25000 }, { rate: 0.0316, upTo: 40000 }, { rate: 0.0422, upTo: 60000 }, { rate: 0.0458, upTo: Infinity }], mfs: [{ rate: 0.0211, upTo: 5000 }, { rate: 0.0281, upTo: 12500 }, { rate: 0.0316, upTo: 20000 }, { rate: 0.0422, upTo: 30000 }, { rate: 0.0458, upTo: Infinity }] },
    },


    // Hawaii 2026: same brackets, but Act 46's standard deduction step lands
    // (HRS 235-2.4(a)(2)(F)), nearly doubling it.
    HI: {
      ...STATE_TAX_DATA.HI,
      deduction: { single: 8000, mfj: 16000, mfs: 8000, hoh: 12000 },
    },


    // Kentucky 2026: HB 1 (2025 Regular Session, Acts Ch. 1) cuts the rate to
    // 3.5 percent, and the standard deduction is indexed to 3,360.
    KY: {
      ...STATE_TAX_DATA.KY,
      flatRate: 0.035,
      deduction: { single: 3360, mfj: 6720, mfs: 3360, hoh: 3360 },
    },

    // Maine 2026: brackets indexed, and a NEW 2 percent surcharge applies above
    // 1,000,000 (single) / 750,000 (separate) / 1,500,000 (joint and head of
    // household). Because it is 2 percent on the excess over a threshold it is
    // exactly equivalent to a fourth bracket at 9.15 percent.
    ME: {
      ...STATE_TAX_DATA.ME,
      deduction: { single: 15700, mfj: 31400, mfs: 15700, hoh: 23550 },
      deductionPhaseOut: {
        startIncome: { single: 102250, mfs: 102250, hoh: 153400, mfj: 204550 },
        ratePerDollar: { single: 15700 / 75000, mfs: 15700 / 75000, hoh: 23550 / 112500, mfj: 31400 / 150000 },
      },
      personalExemption: 5300,
      brackets: { single: [{ rate: 0.058, upTo: 27400 }, { rate: 0.0675, upTo: 64850 }, { rate: 0.0715, upTo: 1000000 }, { rate: 0.0915, upTo: Infinity }], mfs: [{ rate: 0.058, upTo: 27400 }, { rate: 0.0675, upTo: 64850 }, { rate: 0.0715, upTo: 750000 }, { rate: 0.0915, upTo: Infinity }], hoh: [{ rate: 0.058, upTo: 41100 }, { rate: 0.0675, upTo: 97300 }, { rate: 0.0715, upTo: 1500000 }, { rate: 0.0915, upTo: Infinity }], mfj: [{ rate: 0.058, upTo: 54850 }, { rate: 0.0675, upTo: 129750 }, { rate: 0.0715, upTo: 1500000 }, { rate: 0.0915, upTo: Infinity }] },
    },


    // New York 2026: Chapter 59, Laws of 2025, Part A cuts the bottom five
    // rates by 0.1 point each. Thresholds and the standard deduction unchanged.
    // Source: 2026 Form IT-2105-I p.10.
    NY: { ...STATE_TAX_DATA.NY, brackets: { single: [{ rate: 0.039, upTo: 8500 }, { rate: 0.044, upTo: 11700 }, { rate: 0.0515, upTo: 13900 }, { rate: 0.054, upTo: 80650 }, { rate: 0.059, upTo: 215400 }, { rate: 0.0685, upTo: 1077550 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }], mfs: [{ rate: 0.039, upTo: 8500 }, { rate: 0.044, upTo: 11700 }, { rate: 0.0515, upTo: 13900 }, { rate: 0.054, upTo: 80650 }, { rate: 0.059, upTo: 215400 }, { rate: 0.0685, upTo: 1077550 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }], mfj: [{ rate: 0.039, upTo: 17150 }, { rate: 0.044, upTo: 23600 }, { rate: 0.0515, upTo: 27900 }, { rate: 0.054, upTo: 161550 }, { rate: 0.059, upTo: 323200 }, { rate: 0.0685, upTo: 2155350 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }], hoh: [{ rate: 0.039, upTo: 12800 }, { rate: 0.044, upTo: 17650 }, { rate: 0.0515, upTo: 20900 }, { rate: 0.054, upTo: 107650 }, { rate: 0.059, upTo: 269300 }, { rate: 0.0685, upTo: 1616450 }, { rate: 0.0965, upTo: 5000000 }, { rate: 0.103, upTo: 25000000 }, { rate: 0.109, upTo: Infinity }] } },

    // Illinois 2026: exemption indexed to 2,925 (IDOR Bulletin FY 2026-15).
    IL: { ...STATE_TAX_DATA.IL, personalExemption: 2925 },

    // Indiana 2026: rate steps down to 2.95 percent (Departmental Notice #1,
    // effective January 1 2026).
    IN: { ...STATE_TAX_DATA.IN, flatRate: 0.0295 },

    // Massachusetts 2026: only the surtax threshold moves, to 1,107,750.
    MA: { ...STATE_TAX_DATA.MA, brackets: { single: [{ rate: 0.05, upTo: 1107750 }, { rate: 0.09, upTo: Infinity }], mfj: [{ rate: 0.05, upTo: 1107750 }, { rate: 0.09, upTo: Infinity }], mfs: [{ rate: 0.05, upTo: 1107750 }, { rate: 0.09, upTo: Infinity }], hoh: [{ rate: 0.05, upTo: 1107750 }, { rate: 0.09, upTo: Infinity }] } },

    // Georgia 2026: HB 463 (signed 2026-05-11, retroactive to January 1) cuts
    // the rate to 4.99 percent and raises the standard deduction.
    GA: {
      ...STATE_TAX_DATA.GA,
      flatRate: 0.0499,
      deduction: { single: 15000, mfj: 30000, mfs: 15000, hoh: 15000 },
    },

    // North Carolina 2026: rate falls to 3.99 percent under S.L. 2023-134. The
    // standard deduction is statutory and unchanged (confirmed in NC-30 2026).
    NC: { ...STATE_TAX_DATA.NC, flatRate: 0.0399 },

    // Ohio 2026: ORC 5747.02(A)(3)(c) collapses the schedule to a single band
    // above 26,050. The statutory lump base of 332 cannot be expressed by a
    // bracket walk, so Ohio tax is understated by that amount.
    OH: { ...STATE_TAX_DATA.OH, brackets: { single: [{ rate: 0.0, upTo: 26050 }, { rate: 0.0275, upTo: Infinity }], mfj: [{ rate: 0.0, upTo: 26050 }, { rate: 0.0275, upTo: Infinity }], mfs: [{ rate: 0.0, upTo: 26050 }, { rate: 0.0275, upTo: Infinity }], hoh: [{ rate: 0.0, upTo: 26050 }, { rate: 0.0275, upTo: Infinity }] } },


    // Idaho 2026: rate unchanged at 5.3 percent, but the child credit SUNSET
    // under Idaho Code 63-3029L (which ran only through TY2025), and two
    // extension bills died in the 2026 session. The zero-band thresholds are
    // indexed and the 2026 figures are NOT yet published, so 2025 values carry
    // forward rather than being projected.
    ID: {
      ...STATE_TAX_DATA.ID,
      dependentCredit: undefined,
    },


    // Arkansas 2026: Act 2 of the 2026 First Extraordinary Session cuts the top
    // rate from 3.9 to 3.7 percent (DFA withholding formula effective
    // 2026-01-01, adjustment 367.16). The phase-down band shortens accordingly
    // because the adjustment has less distance to fall.
    AR: { ...STATE_TAX_DATA.AR, brackets: { single: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.037, upTo: 94700 }, { rate: 0.137, upTo: 97700 }, { rate: 0.037, upTo: Infinity }], mfj: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.037, upTo: 94700 }, { rate: 0.137, upTo: 97700 }, { rate: 0.037, upTo: Infinity }], mfs: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.037, upTo: 94700 }, { rate: 0.137, upTo: 97700 }, { rate: 0.037, upTo: Infinity }], hoh: [{ rate: 0, upTo: 5599 }, { rate: 0.02, upTo: 11199 }, { rate: 0.03, upTo: 15999 }, { rate: 0.034, upTo: 26399 }, { rate: 0.037, upTo: 94700 }, { rate: 0.137, upTo: 97700 }, { rate: 0.037, upTo: Infinity }] } },

    // Missouri: DOR 2026 withholding formula. Same 4.7% top rate, brackets
    // indexed from $1,313 steps to $1,348 steps. The 100% capital gains
    // subtraction carries forward.
    MO: {
      ...STATE_TAX_DATA.MO,
      brackets: (() => {
        const rates = [0, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045];
        const schedule = [
          ...rates.map((rate, i) => ({ rate, upTo: 1348 * (i + 1) })),
          { rate: 0.047, upTo: Infinity },
        ];
        return { single: schedule, mfj: schedule, mfs: schedule, hoh: schedule };
      })(),
    },
  },
};

/** Resolved state table for a tax year: the base table with that year's overrides applied. */
export function getStateTaxDataForYear(year: number): Record<string, StateTaxConfig> {
  const overrides = STATE_TAX_OVERRIDES[year];
  if (!overrides) return STATE_TAX_DATA;
  return { ...STATE_TAX_DATA, ...overrides };
}

/**
 * Look up a state's configuration for a tax year.
 *
 * `year` is optional only so existing callers keep compiling; omitting it falls
 * back to the base table and will be wrong for any state that changed.
 */
export function getStateTaxConfig(
  stateCode: string | null,
  year?: number
): StateTaxConfig | null {
  if (!stateCode) return null;
  const table = year != null ? getStateTaxDataForYear(year) : STATE_TAX_DATA;
  return table[stateCode] ?? null;
}
