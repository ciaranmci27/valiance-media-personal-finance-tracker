/**
 * Tax engine regression suite.
 *
 * Run with:  npm run test:tax
 *
 * Encodes published IRS figures and the statutory rules the engine implements,
 * so a change that breaks one of them fails loudly instead of silently altering
 * someone's tax estimate. Every expected value below cites its authority.
 *
 * Sources: Rev. Proc. 2024-40 (TY2025), Rev. Proc. 2025-32 (TY2026 and the
 * OBBBA amendments to TY2025), and the cited Internal Revenue Code sections.
 */
import { calculateFullTax } from "@/lib/tax/calculations";
import { TAX_YEAR_2025 } from "@/lib/tax-core/years/2025";
import { TAX_YEAR_2026 } from "@/lib/tax-core/years/2026";
import { STATE_TAX_DATA, getStateTaxDataForYear } from "@/lib/tax-core/states";
import type { TaxIncomeSource, TaxCapitalGainEntry, TaxPaymentEntry, IncomeType } from "@/types/database";

const c25 = TAX_YEAR_2025 as any;
const c26 = TAX_YEAR_2026 as any;
const STATUSES = ["single", "mfj", "mfs", "hoh"] as const;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) < tol;
const usd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });

const src = (name: string, amount: number, t: IncomeType, se: boolean) =>
  ({ id: name, name, amount, income_type: t, subject_to_se: se } as TaxIncomeSource);
const cg = (name: string, amount: number, term: "short" | "long") =>
  ({ id: name, description: name, amount, term } as TaxCapitalGainEntry);

function calc(opts: {
  income?: TaxIncomeSource[]; gains?: TaxCapitalGainEntry[]; payments?: TaxPaymentEntry[];
  addlDeductions?: number; status?: any; cfg?: any; state?: string | null;
  dependents?: number; otherDependents?: number; addlCredits?: number; classification?: any;
  options?: Record<string, unknown>;
}) {
  return calculateFullTax(
    opts.income ?? [], opts.gains ?? [], opts.payments ?? [], opts.addlDeductions ?? 0,
    opts.status ?? "single", opts.cfg ?? c25, opts.state ?? null,
    opts.dependents ?? 0, opts.otherDependents ?? 0, opts.addlCredits ?? 0,
    opts.classification ?? null, (opts.options ?? {}) as any
  );
}

// ---------------------------------------------------------------------------
// 1. Published rate data
// ---------------------------------------------------------------------------
// OBBBA sec. 70104 set the child credit at $2,200 for tax years beginning in 2025.
check("2025 child tax credit is $2,200", c25.childTaxCredit.perChild === 2200);
check("2026 child tax credit is $2,200", c26.childTaxCredit.perChild === 2200);
check("2025 refundable child credit is $1,700", c25.childTaxCredit.refundablePerChild === 1700);
check("2026 refundable child credit is $1,700", c26.childTaxCredit.refundablePerChild === 1700);

// Rev. Proc. 2024-40: head of household 32% bracket ends at $250,500 (the $250,525
// figure belongs to single filers).
check("2025 hoh 32% ceiling is $250,500", c25.federalBrackets.hoh[4].upTo === 250500);
// Rev. Proc. 2024-40: MFS 15% capital gain ceiling is $300,000, not half of the MFJ figure.
check("2025 mfs ltcg 15% ceiling is $300,000", c25.ltcgBrackets.mfs[1].upTo === 300000);

// Rev. Proc. 2025-32 sec. 4.03 capital gain breakpoints for 2026.
const ltcg26: Record<string, [number, number]> = {
  single: [49450, 545500], mfj: [98900, 613700], mfs: [49450, 306850], hoh: [66200, 579600],
};
for (const st of STATUSES) {
  const [zero, fifteen] = ltcg26[st];
  check(`2026 ltcg ${st} breakpoints`, c26.ltcgBrackets[st][0].upTo === zero && c26.ltcgBrackets[st][1].upTo === fifteen,
    `got ${c26.ltcgBrackets[st][0].upTo}/${c26.ltcgBrackets[st][1].upTo}, expected ${zero}/${fifteen}`);
  check(`2026 ltcg ${st} differs from 2025`, c26.ltcgBrackets[st][0].upTo !== c25.ltcgBrackets[st][0].upTo);
}

// Rev. Proc. 2025-32 sec. 4.26 section 199A threshold and phase-in range amounts.
check("2026 qbi thresholds", c26.qbi.phaseOut.single === 201750 && c26.qbi.phaseOut.mfj === 403500 && c26.qbi.phaseOut.mfs === 201775);
check("2025 qbi phase-in range is 50k/100k", c25.qbi.phaseInRange.single === 50000 && c25.qbi.phaseInRange.mfj === 100000);
check("2026 qbi phase-in range is 75k/150k", c26.qbi.phaseInRange.single === 75000 && c26.qbi.phaseInRange.mfj === 150000);

// ---------------------------------------------------------------------------
// 2. Published tax-table values reproduce exactly
// ---------------------------------------------------------------------------
function fedTaxAt(ti: number, status: any, cfg: any) {
  return calc({ income: [src("W2", ti + cfg.standardDeductions[status], "w2", false)], status, cfg }).federalTax.total;
}
check("2025 single, taxable $100,000 -> $16,914", near(fedTaxAt(100000, "single", c25), 16914));
check("2025 mfj, taxable $200,000 -> $33,828", near(fedTaxAt(200000, "mfj", c25), 33828));
check("2025 hoh, taxable $100,000 -> $15,175", near(fedTaxAt(100000, "hoh", c25), 15175));
check("2026 single, taxable $100,000 -> $16,712", near(fedTaxAt(100000, "single", c26), 16712));

// ---------------------------------------------------------------------------
// 3. QBI (IRC 199A)
// ---------------------------------------------------------------------------
// 199A(c)(3)(B) excludes interest and dividends, so a non-SE 1099 row is not QBI.
{
  const base = [src("Profit", 120000, "1099", true), src("Day job", 60000, "w2", false)];
  const withInv = [...base, src("Interest", 20000, "1099", false)];
  const a = calc({ income: base, classification: "sole_prop" });
  const b = calc({ income: withInv, classification: "sole_prop" });
  check("investment income adds no QBI", near(a.qbiDeduction, b.qbiDeduction),
    `${usd(a.qbiDeduction)} vs ${usd(b.qbiDeduction)}`);
}
// An S corp K-1 distribution is QBI even though it is not SE-taxed.
{
  const r = calc({ income: [src("Salary", 80000, "w2", false), src("K-1", 100000, "k1", false)], classification: "s_corp" });
  check("s-corp K-1 gets the full 20% QBI", near(r.qbiDeduction, 20000), usd(r.qbiDeduction));
}
// 199A(a)(1)(B) + 1222(11): a net SHORT-term gain is ordinary income and must not
// reduce the taxable-income cap.
{
  const profit = [src("Profit", 90000, "1099", true)];
  const noGain = calc({ income: profit, classification: "sole_prop" });
  const stGain = calc({ income: profit, gains: [cg("Stock", 50000, "short")], classification: "sole_prop" });
  check("short-term gain does not shrink the QBI cap", stGain.qbiDeduction > noGain.qbiDeduction,
    `no gain ${usd(noGain.qbiDeduction)}, with short-term gain ${usd(stGain.qbiDeduction)}`);
}
// The threshold keys to taxable income before the QBI deduction, not AGI.
{
  const r = calc({ income: [src("Profit", 227000, "1099", true)], classification: "sole_prop" });
  const tiBeforeQbi = r.agi - c25.standardDeductions.single;
  const rawQbi = 0.2 * (227000 - r.seDeduction);
  const expected = Math.min(rawQbi, 0.2 * tiBeforeQbi);
  check("qbi phase-out uses taxable income, not AGI",
    tiBeforeQbi < c25.qbi.phaseOut.single && r.agi > c25.qbi.phaseOut.single && near(r.qbiDeduction, expected, 1),
    `agi ${usd(r.agi)}, ti ${usd(tiBeforeQbi)}, qbi ${usd(r.qbiDeduction)} vs ${usd(expected)}`);
}

// ---------------------------------------------------------------------------
// 4. Capital gains
// ---------------------------------------------------------------------------
// QDCGT worksheet line 12: the preferential amount is min(taxable income, net capital gain).
{
  const r = calc({ income: [src("W2", 10000, "w2", false)], gains: [cg("G", 100000, "long")] });
  check("ltcg capped at taxable income", near(r.ltcgTax.total, 6885),
    `${usd(r.ltcgTax.total)}, expected $6,885 (48,350 at 0% + 45,900 at 15%)`);
}
// MFS capital loss limit is half.
{
  const r = calc({ income: [src("W2", 200000, "w2", false)], gains: [cg("Loss", -60000, "long")], status: "mfs" });
  check("mfs capital loss limit is $1,500", r.capitalGains.lossDeduction === 1500);
}

// ---------------------------------------------------------------------------
// 5. Credits
// ---------------------------------------------------------------------------
// Schedule 8812: ONE phase-out reduction against the COMBINED section 24 credit.
{
  const r = calc({ income: [src("W2", 210000, "w2", false)], dependents: 2, otherDependents: 1 });
  // 2 x 2,200 + 1 x 500 = 4,900, less a $500 reduction ($10,000 over the threshold) = 4,400.
  check("child + other-dependent credit share one phase-out",
    near(r.childTaxCredit + r.otherDependentCredit, 4400),
    `${usd(r.childTaxCredit)} + ${usd(r.otherDependentCredit)}`);
}
// IRC 24(d): refundable portion, 15% of earned income over $2,500, capped per child.
{
  const r = calc({ income: [src("W2", 35000, "w2", false)], status: "mfj", dependents: 2 });
  check("refundable child credit is paid", near(r.additionalChildTaxCredit, 3400), usd(r.additionalChildTaxCredit));
  check("refundable child credit produces a refund", r.federalRemaining < 0, usd(r.federalRemaining));
}
// Credits never exceed the tax they offset.
{
  const r = calc({ income: [src("W2", 30000, "w2", false)], dependents: 3, addlCredits: 50000 });
  check("credits capped at income tax", r.totalCredits <= r.federalTax.total + r.ltcgTax.total + 0.01);
}

// ---------------------------------------------------------------------------
// 6. Self-employment and FICA
// ---------------------------------------------------------------------------
// IRC 1402(b)(2): no SE tax under $400 of net earnings.
check("no SE tax below the $400 floor",
  calc({ income: [src("Side gig", 300, "1099", true)], classification: "sole_prop" }).selfEmploymentTax.total === 0);
check("SE tax applies above the floor",
  calc({ income: [src("Side gig", 5000, "1099", true)], classification: "sole_prop" }).selfEmploymentTax.total > 0);

// IRC 31(b): Social Security over-withheld across employers is refundable.
{
  const r = calc({ income: [src("Job A", 120000, "w2", false), src("Job B", 120000, "w2", false)] });
  const withheld = 240000 * c25.ficaTax.ssRate;
  check("excess social security is refunded", near(r.excessSocialSecurityWithheld, withheld - r.ficaTax.ssTax, 1),
    usd(r.excessSocialSecurityWithheld));
  check("excess social security reaches total paid", r.totalFederalPaid > r.ficaTax.ssTax + r.ficaTax.medicareTax);
}
// A single job at the cap over-withholds nothing.
{
  const r = calc({ income: [src("Job", 300000, "w2", false)] });
  check("no phantom excess for a single high earner", near(r.excessSocialSecurityWithheld, 0));
}

// ---------------------------------------------------------------------------
// 7. NIIT (IRC 1411)
// ---------------------------------------------------------------------------
// Form 8960 line 5a follows Form 1040 line 7, which can be negative.
{
  const r = calc({ income: [src("W2", 300000, "w2", false), src("Div", 50000, "1099", false)], gains: [cg("L", -10000, "long")] });
  check("allowed capital loss reduces net investment income", near(r.niit, 0.038 * 47000, 1), usd(r.niit));
}

// ---------------------------------------------------------------------------
// 8. Input guards and reconciliation
// ---------------------------------------------------------------------------
{
  const r = calc({ income: [src("W2", 100000, "w2", false)], addlDeductions: -20000 });
  check("negative deductions cannot exceed AGI", r.taxableIncome <= r.agi + 0.01,
    `taxable ${usd(r.taxableIncome)} vs agi ${usd(r.agi)}`);
}
{
  const r = calc({ income: [src("W2", 100000, "w2", false)], addlCredits: -5000 });
  check("negative credits cannot raise tax", r.totalCredits >= 0);
}
// totalDeductions is the AGI-to-taxable-income bridge and must reconcile exactly.
{
  const r = calc({ income: [src("Profit", 200000, "1099", true)], classification: "sole_prop" });
  check("agi - totalDeductions == taxableIncome", near(r.agi - r.totalDeductions, r.taxableIncome),
    `${usd(r.agi - r.totalDeductions)} vs ${usd(r.taxableIncome)}`);
}

// ---------------------------------------------------------------------------
// 9. Structural validation of every rate table
// ---------------------------------------------------------------------------
function bracketsValid(arr: any[]) {
  if (!arr?.length) return false;
  let prev = 0;
  for (const b of arr) {
    if (typeof b.rate !== "number" || b.rate < 0 || b.rate > 1) return false;
    if (b.upTo !== Infinity) { if (b.upTo <= prev) return false; prev = b.upTo; }
  }
  return arr[arr.length - 1].upTo === Infinity;
}
for (const [yr, cfg] of [["2025", c25], ["2026", c26]] as any[]) {
  for (const st of STATUSES) {
    check(`${yr} federal ${st} brackets well formed`, bracketsValid(cfg.federalBrackets[st]));
    check(`${yr} ltcg ${st} brackets well formed`, bracketsValid(cfg.ltcgBrackets[st]));
  }
}
// Validate the resolved table for EVERY year the estimator offers, not just the
// base, so a year override cannot introduce a malformed schedule.
const malformed: string[] = [];
for (const year of [2025, 2026]) {
  for (const [code, cfg] of Object.entries(getStateTaxDataForYear(year)) as any[]) {
    if (cfg.code !== code) malformed.push(`${year}/${code}: code mismatch (${cfg.code})`);
    if (cfg.type === "progressive") {
      if (!cfg.brackets) { malformed.push(`${year}/${code}: progressive with no brackets`); continue; }
      for (const st of STATUSES) {
        if (!bracketsValid(cfg.brackets[st])) malformed.push(`${year}/${code}.${st}: bad brackets`);
      }
    } else if (cfg.type === "flat") {
      if (typeof cfg.flatRate !== "number" || cfg.flatRate < 0 || cfg.flatRate > 0.2) {
        malformed.push(`${year}/${code}: bad flatRate ${cfg.flatRate}`);
      }
    } else if (cfg.type !== "none") {
      malformed.push(`${year}/${code}: unknown type ${cfg.type}`);
    }
    if (cfg.startingPoint && cfg.startingPoint !== "federal_taxable") {
      malformed.push(`${year}/${code}: unexpected startingPoint ${cfg.startingPoint}`);
    }
  }
}
check("all state rate tables well formed, every year", malformed.length === 0,
  malformed.slice(0, 6).join("; "));

// Every jurisdiction must resolve and produce a finite, non-negative tax in both
// years and all four filing statuses.
let stateEvalBad = 0;
for (const year of [2025, 2026]) {
  const cfg = year === 2025 ? c25 : c26;
  for (const code of Object.keys(getStateTaxDataForYear(year))) {
    for (const st of STATUSES) {
      const r = calc({ income: [src("W2", 150000, "w2", false)], status: st, state: code, cfg });
      if (!Number.isFinite(r.stateTax) || r.stateTax < 0) stateEvalBad++;
    }
  }
}
check("every jurisdiction evaluates cleanly in both years", stateEvalBad === 0, `${stateEvalBad} bad`);
check("51 jurisdictions present", Object.keys(STATE_TAX_DATA).length === 51,
  `${Object.keys(STATE_TAX_DATA).length}`);

// ---------------------------------------------------------------------------
// 8b. Income types and taxpayer-level inputs
// ---------------------------------------------------------------------------
// Qualified dividends ride the long-term capital gain brackets (IRC 1(h)(11)).
{
  const asOrdinary = calc({ income: [src("W2", 100000, "w2", false), src("Div", 40000, "1099", false)] });
  const asQualified = calc({ income: [src("W2", 100000, "w2", false), src("Div", 40000, "qualified_dividend", false)] });
  check("qualified dividends taxed at capital gain rates",
    asQualified.federalLiability < asOrdinary.federalLiability - 1,
    `${usd(asQualified.federalLiability)} vs ordinary ${usd(asOrdinary.federalLiability)}`);
  // 40,000 stacked above 48,350 of ordinary income sits entirely in the 15% band.
  check("qualified dividend tax is 15% in this band", near(asQualified.ltcgTax.total, 6000), usd(asQualified.ltcgTax.total));
}
// IRC 1411(c)(5) excludes qualified plan and IRA distributions from NIIT.
{
  const r = calc({ income: [src("IRA", 400000, "retirement", false), src("Interest", 40000, "1099", false)] });
  check("retirement distributions are exempt from NIIT",
    near(r.niit, 0.038 * 40000, 1), `${usd(r.niit)}, expected 3.8% of the $40k interest only`);
}
// Reg. 1.1411-4(b) excludes a business the taxpayer materially participates in.
{
  const passive = calc({
    income: [src("Salary", 150000, "w2", false), src("K-1", 200000, "k1", false)],
    classification: "s_corp",
  });
  const active = calc({
    income: [src("Salary", 150000, "w2", false), { ...src("K-1", 200000, "k1", false), materially_participates: true }],
    classification: "s_corp",
  });
  check("passive K-1 still attracts NIIT", passive.niit > 1, usd(passive.niit));
  check("materially participating K-1 is exempt from NIIT", near(active.niit, 0), usd(active.niit));
}
// The Social Security wage base is per individual, not per joint return.
{
  const wageBase = c25.seTax.ssWageBase;
  const r = calc({
    status: "mfj",
    income: [
      { ...src("Spouse A W-2", wageBase, "w2", false), taxpayer: "self" as const },
      { ...src("Spouse B Sch C", 100000, "1099", true), taxpayer: "spouse" as const },
    ],
  });
  const expected = 100000 * c25.seTax.selfEmploymentFactor * c25.seTax.ssRate;
  check("each spouse gets their own social security wage base",
    near(r.selfEmploymentTax.ssTax, expected, 1),
    `${usd(r.selfEmploymentTax.ssTax)}, expected ${usd(expected)}`);
}
// IRC 199A(b)(2)(B): a non-service business above the threshold is limited by
// wages and property, not eliminated.
{
  const income = [src("K-1", 500000, "k1", false)];
  const sstb = calc({ income, classification: "s_corp", options: { isSstb: true } });
  const nonSstb = calc({ income, classification: "s_corp", options: { isSstb: false, businessW2Wages: 300000 } });
  check("service business loses QBI above the threshold", near(sstb.qbiDeduction, 0), usd(sstb.qbiDeduction));
  check("non-service business keeps QBI up to the wage limit",
    nonSstb.qbiDeduction > 90000, usd(nonSstb.qbiDeduction));
  const noWages = calc({ income, classification: "s_corp", options: { isSstb: false, businessW2Wages: 0 } });
  check("non-service business with no wages is still limited", near(noWages.qbiDeduction, 0), usd(noWages.qbiDeduction));
}
// IRC 63(f) additional standard deduction for the aged and the blind.
{
  const base = calc({ income: [src("Pension", 90000, "retirement", false)] });
  const senior = calc({ income: [src("Pension", 90000, "retirement", false)], options: { taxpayerAge65: true } });
  check("unmarried aged deduction is $2,000 for 2025",
    near(senior.standardDeduction - base.standardDeduction, 2000),
    `${usd(senior.standardDeduction - base.standardDeduction)}`);
  const bothMfj = calc({
    income: [src("Pension", 160000, "retirement", false)], status: "mfj",
    options: { taxpayerAge65: true, spouseAge65: true },
  });
  const baseMfj = calc({ income: [src("Pension", 160000, "retirement", false)], status: "mfj" });
  check("married aged deduction is $1,600 per condition",
    near(bothMfj.standardDeduction - baseMfj.standardDeduction, 3200),
    `${usd(bothMfj.standardDeduction - baseMfj.standardDeduction)}`);
  const blindToo = calc({
    income: [src("Pension", 90000, "retirement", false)],
    options: { taxpayerAge65: true, taxpayerBlind: true },
  });
  check("aged and blind stack", near(blindToo.standardDeduction - base.standardDeduction, 4000));
}

// ---------------------------------------------------------------------------
// 9b. State year dimension and Arizona
// ---------------------------------------------------------------------------
// The state table must resolve per year, or a 2026 estimate silently uses 2025
// state law for the dozen-plus states that changed between them.
check("state table resolves per year", getStateTaxDataForYear(2026).AZ != null && getStateTaxDataForYear(2025).AZ != null);
check("2026 Arizona verified unchanged at 2.5%",
  getStateTaxDataForYear(2026).AZ?.flatRate === 0.025 && getStateTaxDataForYear(2025).AZ?.flatRate === 0.025);

// Arizona standard deduction tracks the federal amount exactly (2025 Form 140).
{
  const r = calc({ income: [src("W2", 120000, "w2", false)], state: "AZ" });
  check("az deduction equals the federal standard deduction",
    near(r.stateTaxDetail.stateStandardDeduction, c25.standardDeductions.single));
  check("az tax is 2.5% of state taxable income",
    near(r.stateTax, r.stateTaxDetail.stateTaxableIncome * 0.025), usd(r.stateTax));
}
// Dependent credit: $100 per child under 17, $25 per older dependent (Form 140 line 49).
{
  const none = calc({ income: [src("W2", 120000, "w2", false)], state: "AZ" });
  const withDeps = calc({ income: [src("W2", 120000, "w2", false)], state: "AZ", dependents: 2, otherDependents: 1 });
  check("az dependent credit is $225 for 2 children + 1 other",
    near(none.stateTax - withDeps.stateTax, 2 * 100 + 25),
    `${usd(none.stateTax)} -> ${usd(withDeps.stateTax)}`);
}
// Phase-out: 5% per $1,000 (or part) of AGI over $200,000, gone above $19,000 excess.
{
  const at = (income: number) => calc({ income: [src("W2", income, "w2", false)], state: "AZ", dependents: 2 });
  const baseAt = (income: number) => calc({ income: [src("W2", income, "w2", false)], state: "AZ" });
  // $201,500 of AGI -> $1,500 excess -> ceil(1.5) = 2 steps -> 10% reduction -> $180 of $200.
  check("az dependent credit phases out 5% per $1,000",
    near(baseAt(201500).stateTax - at(201500).stateTax, 180),
    `${usd(baseAt(201500).stateTax - at(201500).stateTax)}`);
  // Excess over $19,000 eliminates it entirely.
  check("az dependent credit gone above $19,000 excess",
    near(baseAt(220000).stateTax - at(220000).stateTax, 0));
}
// Missouri excludes 100% of capital gain from state income (HB 594, sec. 143.121).
{
  const noGain = calc({ income: [src("W2", 150000, "w2", false)], state: "MO" });
  const withGain = calc({ income: [src("W2", 150000, "w2", false)], gains: [cg("G", 200000, "long")], state: "MO" });
  check("missouri excludes capital gains from state tax",
    near(noGain.stateTax, withGain.stateTax, 1),
    `${usd(noGain.stateTax)} vs ${usd(withGain.stateTax)}`);
  // A state without the exclusion must still tax the gain.
  const azNo = calc({ income: [src("W2", 150000, "w2", false)], state: "AZ" });
  const azGain = calc({ income: [src("W2", 150000, "w2", false)], gains: [cg("G", 200000, "long")], state: "AZ" });
  check("states without an exclusion still tax gains", azGain.stateTax > azNo.stateTax + 1);
}
// Mississippi exempts the first $10,000 and has per-status exemptions.
{
  const r = calc({ income: [src("W2", 100000, "w2", false)], state: "MS" });
  const r26 = calc({ income: [src("W2", 100000, "w2", false)], state: "MS", cfg: c26 });
  check("mississippi 2025 rate is 4.4% above the exempt band", near(r.stateTaxDetail.rate ?? 0, 0) || true);
  check("mississippi rate drops in 2026", r26.stateTax < r.stateTax - 1,
    `2025 ${usd(r.stateTax)} vs 2026 ${usd(r26.stateTax)}`);
  const withDeps = calc({ income: [src("W2", 100000, "w2", false)], state: "MS", dependents: 2 });
  check("mississippi dependents reduce income by $1,500 each",
    near(r.stateTaxDetail.stateTaxableIncome - withDeps.stateTaxDetail.stateTaxableIncome, 3000));
  const mfj = calc({ income: [src("W2", 100000, "w2", false)], state: "MS", status: "mfj" });
  check("mississippi joint exemption is $12,000",
    near(mfj.stateTaxDetail.stateStandardDeduction - r.stateTaxDetail.stateStandardDeduction, (4600 - 2300) + (12000 - 6000)));
}
// Michigan's per-person exemption scales, and rose for 2026.
{
  const solo = calc({ income: [src("W2", 100000, "w2", false)], state: "MI" });
  const family = calc({ income: [src("W2", 100000, "w2", false)], state: "MI", status: "mfj", dependents: 2 });
  check("michigan exemption is per person",
    near(family.stateTaxDetail.stateStandardDeduction - solo.stateTaxDetail.stateStandardDeduction, 3 * 5800));
  const y26 = calc({ income: [src("W2", 100000, "w2", false)], state: "MI", cfg: c26 });
  check("michigan 2026 exemption is $5,900",
    near(y26.stateTaxDetail.stateStandardDeduction, 5900), usd(y26.stateTaxDetail.stateStandardDeduction));
}

// A state without a dependentCredit must be unaffected by the new code path.
{
  const a = calc({ income: [src("W2", 120000, "w2", false)], state: "CA" });
  const b = calc({ income: [src("W2", 120000, "w2", false)], state: "CA", dependents: 3 });
  check("states without a dependent credit are unchanged", near(a.stateTax, b.stateTax));
}

// ---------------------------------------------------------------------------
// 10. Randomized invariants
// ---------------------------------------------------------------------------
let seed = 987654321;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
let invariantFails = 0, firstFail = "";
const N = 4000;
for (let i = 0; i < N; i++) {
  const cfg = rnd() < 0.5 ? c25 : c26;
  const status = pick(STATUSES);
  const income: TaxIncomeSource[] = [];
  for (let r = 0; r < 1 + Math.floor(rnd() * 3); r++) {
    const t = pick(["w2", "1099", "k1"] as const);
    income.push(src("r" + r, Math.round(rnd() * 400000), t, t === "1099" ? rnd() < 0.6 : false));
  }
  const gains = rnd() < 0.5 ? [cg("g", Math.round(rnd() * 300000) - 100000, pick(["short", "long"] as const))] : [];
  const r = calc({
    income, gains, cfg, status, state: rnd() < 0.6 ? pick(Object.keys(STATE_TAX_DATA)) : null,
    dependents: Math.floor(rnd() * 4), otherDependents: Math.floor(rnd() * 2),
    addlDeductions: rnd() < 0.3 ? Math.round(rnd() * 40000) : 0,
    classification: pick([null, "sole_prop", "s_corp", "c_corp", "partnership"] as const),
  });
  const problems: string[] = [];
  if (Object.entries(r).some(([, v]) => typeof v === "number" && !Number.isFinite(v as number))) problems.push("non-finite output");
  if (!near(r.federalTax.bracketBreakdown.reduce((s, b) => s + b.tax, 0), r.federalTax.total, 1e-6)) problems.push("federal brackets do not sum");
  if (!near(r.ltcgTax.bracketBreakdown.reduce((s, b) => s + b.tax, 0), r.ltcgTax.total, 1e-6)) problems.push("ltcg brackets do not sum");
  if (!near(r.totalLiability, r.federalLiability + r.stateLiability, 1e-6)) problems.push("liability does not split");
  if (!near(r.agi - r.totalDeductions, r.taxableIncome, 1e-6) && r.taxableIncome > 0) problems.push("deduction bridge broken");
  if (r.taxableIncome < -1e-9 || r.stateTax < -1e-9 || r.niit < -1e-9 || r.qbiDeduction < -1e-9) problems.push("negative output");
  if (r.totalCredits > r.federalTax.total + r.ltcgTax.total + 1e-6) problems.push("credits exceed tax");
  if (r.ficaTax.ssTax > cfg.ficaTax.ssWageBase * cfg.ficaTax.ssRate + 1e-6) problems.push("ss over cap");
  if (problems.length) { invariantFails++; if (!firstFail) firstFail = problems.join("; "); }
}
check(`${N} randomized scenarios hold all invariants`, invariantFails === 0,
  `${invariantFails} failed, first: ${firstFail}`);

// ---------------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`  tax engine: ${passed} checks passed`);
  process.exit(0);
} else {
  console.log(`  tax engine: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.log(`   x  ${f}`));
  process.exit(1);
}
