/**
 * Tax treatment rules regression suite.
 *
 * Run with:  npx --yes tsx@4 scripts/verify-accounting-tax-treatments.ts
 *
 * Pins the deterministic suggestions in `tax-treatment-rules.ts`: rule order,
 * each rule's outcome, the manual-review flags, the account-type guard, the
 * deductible convention, the SQL-to-app concept inversion, and that every
 * suggestion turns into a command the mapping schema accepts.
 */
import {
  conceptsFor,
  deductibleBpsFor,
  sqlConceptToTs,
  suggestTreatments,
  type TaxAccount,
} from "@/lib/accounting/tax-treatment-rules";
import { taxWorkpaperCommandSchema, type TaxSource } from "@/lib/accounting/tax-workpapers";
import type { AccountProfile } from "@/lib/accounting/workflows";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}

let seq = 0;
function account(
  name: string,
  type: "income" | "expense",
  extra: Partial<TaxAccount> = {},
): TaxAccount {
  seq += 1;
  return {
    account_id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    name,
    code: String(4000 + seq),
    account_type: type,
    mapping: null,
    book_cents: "100000",
    ordinary_cents: "0",
    line_count: 3,
    current: false,
    ...extra,
  };
}
function profile(a: TaxAccount, purpose: string | null, subtype = "other", wave?: string): AccountProfile {
  return {
    account_id: a.account_id,
    version: 1,
    purpose,
    cash_kind: "none",
    parent_account_id: null,
    subtype,
    type: a.account_type,
    ...(wave ? { external_names: { wave } } : {}),
  } as AccountProfile;
}
function source(accounts: TaxAccount[], year = 2026): TaxSource {
  return { year, through: `${year}-09-12`, accounts } as TaxSource;
}
function run(accounts: TaxAccount[], profiles: AccountProfile[] = [], prior: TaxSource | null = null) {
  return suggestTreatments({ source: source(accounts), profiles, prior });
}
const one = (accounts: TaxAccount[], profiles: AccountProfile[] = [], prior: TaxSource | null = null) => {
  const out = run(accounts, profiles, prior);
  return { s: out.suggestions[0], r: out.review[0], out };
};

// ---------------------------------------------------------------------------
// 1. Candidates

{
  const mapped = account("Consulting revenue", "income", { current: true });
  const idle = account("Dormant", "expense", { line_count: 0 });
  const live = account("Software", "expense");
  const out = run([mapped, idle, live], [profile(live, "software")]);
  check("mapped and idle accounts are skipped", out.suggestions.length === 1 && out.review.length === 0 && out.suggestions[0].account_id === live.account_id);
}

// ---------------------------------------------------------------------------
// 2. Purpose rule

{
  const a = account("Officer compensation", "expense");
  check("officer compensation purpose maps to officer wages at 100%", (() => { const { s } = one([a], [profile(a, "officer_compensation")]); return s?.concept === "officer_wages" && s.deductible_bps === 10000 && s.confidence === "certain" && s.source === "purpose"; })());
  check("the payroll seed's officer_wages purpose is accepted too", one([a], [profile(a, "officer_wages")]).s?.concept === "officer_wages");
  const m = account("Client lunches", "expense");
  check("meals purpose maps to meals at 50%", (() => { const { s } = one([m], [profile(m, "meals")]); return s?.concept === "meals" && s.deductible_bps === 5000 && /Meals/.test(s.reason); })());
  const t = account("Trips", "expense");
  check("travel purpose maps to travel", one([t], [profile(t, "travel")]).s?.concept === "travel");
  const i = account("Loan interest", "expense");
  check("interest expense purpose is an ordinary expense", one([i], [profile(i, "interest")]).s?.concept === "ordinary_expense");
  const c = account("Consulting revenue", "income");
  check("income purposes map to ordinary income", one([c], [profile(c, "consulting")]).s?.concept === "ordinary_income" && one([c], [profile(c, "consulting")]).s?.deductible_bps === 10000);
  for (const p of ["contractors", "software", "hosting", "ai_api", "marketing", "professional_services", "merchant_fees", "bank_fees", "office_supplies", "insurance", "other_wages", "employer_payroll_taxes", "payroll_fees", "shareholder_health_insurance", "employer_retirement", "taxes_licenses", "education", "depreciation", "fx_differences", "other_expenses"]) {
    const e = account(`Purpose ${p}`, "expense");
    const { s } = one([e], [profile(e, p)]);
    check(`expense purpose ${p} is an ordinary expense`, s?.concept === "ordinary_expense" && s.deductible_bps === 10000 && s.confidence === "certain");
  }
  const u = account("Uncategorized expense", "expense");
  check("uncategorised accounts are flagged, not mapped", (() => { const { s, r } = one([u], [profile(u, "uncategorized_expense")]); return !s && /Categorise/.test(r?.reason ?? ""); })());
  const wrong = account("Meals", "income");
  check("a purpose whose concept does not fit the account type falls through", (() => { const { s } = one([wrong], [profile(wrong, "meals")]); return s?.concept === "ordinary_income" && s.source === "name" || s === undefined || s.concept !== "meals"; })());
}

// ---------------------------------------------------------------------------
// 3. Name rule

{
  const cases: [string, "income" | "expense", string, string][] = [
    ["Interest income", "income", "interest", "interest"],
    ["Qualified dividends", "income", "qualified_dividend", "dividend"],
    ["Municipal bond income", "income", "tax_exempt", "tax-exempt"],
    ["Long-term capital gains", "income", "long_gain", "long-term"],
    ["Short term gain on sale", "income", "short_gain", "short-term"],
    ["Team meals", "expense", "meals", "meals"],
    ["Airfare and lodging", "expense", "travel", "travel"],
    ["IRS penalties", "expense", "nondeductible", "nondeductible"],
    ["Federal income tax", "expense", "nondeductible", "nondeductible"],
    ["Donations", "expense", "charity", "charity"],
    ["Officer salary", "expense", "officer_wages", "officer"],
  ];
  for (const [name, type, concept, why] of cases) {
    const a = account(name, type);
    const { s } = one([a]);
    check(`name "${name}" suggests ${concept}`, s?.concept === concept && s.source === "name" && s.confidence === "likely" && new RegExp(why, "i").test(s.reason), JSON.stringify(s));
  }
  const both = account("Travel meals", "expense");
  check("a name that fits two treatments is flagged", (() => { const { s, r } = one([both]); return !s && /more than one/.test(r?.reason ?? ""); })());
  const gain = account("Capital gains", "income");
  check("gains without a term are flagged", (() => { const { s, r } = one([gain]); return !s && /short- or long-term/.test(r?.reason ?? ""); })());
  const wave = account("4501", "income");
  check("the Wave name is searched too", one([wave], [profile(wave, null, "other", "Interest earned")]).s?.concept === "interest");
  const renamed = account("Meal Expense", "expense");
  check("a rename wins over the Wave name it replaced", (() => { const { s } = one([renamed], [profile(renamed, null, "operating_expense", "Meals and Entertainment")]); return s?.concept === "meals" && /^Name suggests meals/.test(s.reason); })());
  const combined = account("Meals and Entertainment", "expense");
  check("meals and entertainment in one name is still the owner's pick", (() => { const { s, r } = one([combined]); return !s && /^Name fits more than one/.test(r?.reason ?? ""); })());
  const aliasOnly = account("6120", "expense");
  check("a match taken from the Wave name says so", (() => { const { s } = one([aliasOnly], [profile(aliasOnly, null, "other", "Travel")]); return s?.concept === "travel" && /^Wave name suggests travel/.test(s.reason); })());
  const bare = account("Misc", "expense");
  check("an unrecognised name with no purpose or group is flagged", (() => { const { s, r } = one([bare]); return !s && /No rule/.test(r?.reason ?? ""); })());
}

// ---------------------------------------------------------------------------
// 4. Subtype rule and precedence

{
  const rev = account("Widgets", "income");
  check("revenue report group maps to ordinary income", (() => { const { s } = one([rev], [profile(rev, null, "revenue")]); return s?.concept === "ordinary_income" && s.source === "subtype" && s.confidence === "likely"; })());
  const opx = account("Sundry", "expense");
  check("operating expense report group maps to ordinary expense", one([opx], [profile(opx, null, "Operating expense")]).s?.concept === "ordinary_expense");
  const cogs = account("Parts", "expense");
  check("cogs report group maps to ordinary expense", one([cogs], [profile(cogs, null, "cogs")]).s?.concept === "ordinary_expense");
  const named = account("Client meals", "expense");
  check("a name match beats the report group", one([named], [profile(named, null, "operating_expense")]).s?.concept === "meals");
  const purposed = account("Travel", "expense");
  check("a purpose beats the name", one([purposed], [profile(purposed, "software")]).s?.concept === "ordinary_expense");
}

// ---------------------------------------------------------------------------
// 5. Prior year

{
  const a = account("Meals", "expense");
  const priorSource = { ...source([{ ...a, current: true, mapping: { concept: "meals_50", deductible_bps: 5000 } as unknown as TaxAccount["mapping"] }], 2025), year: 2025 } as TaxSource;
  const { s } = one([a], [profile(a, "software")], priorSource);
  check("last year's mapping wins over the purpose", s?.concept === "meals" && s.source === "prior_year" && /2025/.test(s.reason) && s.deductible_bps === 5000);
  const b = account("Parts", "expense");
  const sqlOnly = { ...source([{ ...b, current: true, mapping: { concept: "cogs", deductible_bps: 10000 } as unknown as TaxAccount["mapping"] }], 2025), year: 2025 } as TaxSource;
  check("a prior concept with no app equivalent falls through to the other rules", one([b], [profile(b, null, "cogs")], sqlOnly).s?.source === "subtype");
}

// ---------------------------------------------------------------------------
// 6. Helpers

check("sql concept inversion", sqlConceptToTs("gross_receipts") === "ordinary_income" && sqlConceptToTs("other_deduction") === "ordinary_expense" && sqlConceptToTs("officer_compensation") === "officer_wages" && sqlConceptToTs("meals_50") === "meals" && sqlConceptToTs("balance_sheet_only") === "excluded_book" && sqlConceptToTs("travel") === "travel" && sqlConceptToTs("rent") === null);
check("deductible convention", deductibleBpsFor("ordinary_income") === 10000 && deductibleBpsFor("meals") === 5000 && deductibleBpsFor("nondeductible") === 0 && deductibleBpsFor("charity") === 0 && deductibleBpsFor("interest") === 0);
check("income and expense concept sets", conceptsFor("income").includes("interest") && !conceptsFor("income").includes("meals") && conceptsFor("expense").includes("meals") && !conceptsFor("expense").includes("ordinary_income"));

// ---------------------------------------------------------------------------
// 7. Every suggestion becomes a valid mapping command

{
  const a1 = account("Officer compensation", "expense");
  const a2 = account("Interest income", "income");
  const a3 = account("Team meals", "expense");
  const out = run([a1, a2, a3], [profile(a1, "officer_compensation")]);
  check("three suggestions", out.suggestions.length === 3);
  for (const s of out.suggestions) {
    const parsed = taxWorkpaperCommandSchema.safeParse({
      id: crypto.randomUUID(),
      year: 2026,
      expected_version: 0,
      document_id: null,
      reason: `Suggested: ${s.reason}. Accepted by owner.`,
      verified: true,
      type: "tax.mapping",
      account_id: s.account_id,
      concept: s.concept,
      deductible_bps: s.deductible_bps,
    });
    check(`command for ${s.name} passes the mapping schema`, parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
  }
}

// ---------------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`  tax treatment rules: ${passed} checks passed`);
  process.exit(0);
} else {
  console.log(`  tax treatment rules: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.log(`   x  ${f}`));
  process.exit(1);
}
