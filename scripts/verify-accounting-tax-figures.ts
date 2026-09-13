/**
 * Books figures regression suite.
 *
 * Run with:  npx --yes tsx@4 scripts/verify-accounting-tax-figures.ts
 *
 * Pins what the books offer the Tax Estimator (`tax-books-figures.ts`), how
 * figures become rows and adopt untouched template rows (`books-rows.ts`),
 * and the refresh rules: cents-exact diff, never zero a row, rest of year
 * cleared only once the books cover the whole year. Also carries the cents
 * converter rounding contract from the retired projection suite.
 */
import { buildBooksFigures, type BooksFigure } from "@/lib/accounting/tax-books-figures";
import type { TaxSource } from "@/lib/accounting/tax-workpapers";
import type { PayrollYear } from "@/lib/accounting/payroll";
import { fromEstimatorDollars, toEstimatorDollars } from "@/lib/accounting/tax-projection";
import {
  applyBooksRefresh,
  booksWageBases,
  rowsFromFigures,
  withRest,
} from "@/lib/tax/books-rows";
import { isTemplateAlreadyAdded } from "@/lib/tax/templates";
import type { TaxIncomeSource, TaxPaymentEntry } from "@/types/database";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
function fails(name: string, fn: () => unknown, pattern: RegExp) {
  try { fn(); check(name, false, "did not throw"); }
  catch (e) { check(name, pattern.test(e instanceof Error ? e.message : String(e)), String(e)); }
}
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) < tol;

// ---------------------------------------------------------------------------
// Fixtures

function source(overrides: Partial<TaxSource> = {}): TaxSource {
  return {
    year: 2026,
    through: "2026-09-11",
    revision: "r1",
    fingerprint: "f1",
    year_settings: { classification: "s_corp" },
    accounts: [],
    adjustments: [],
    basis: null,
    monthly: [],
    separately_stated: { interest: "80000", long_gain: "-300000" },
    book_profit_cents: "7231167",
    mapped_ordinary_cents: "7231167",
    adjusted_ordinary_cents: "7231167",
    book_to_tax_cents: "0",
    unmapped_accounts: 0,
    drafts: 0,
    incomplete_imports: 0,
    unavailable_adjustments: 0,
    ...overrides,
  } as TaxSource;
}

const employee = {
  key: "emp-1",
  name: "Ciaran",
  is_officer: true,
  gross_cash_cents: "1450000",
  federal_taxable_cents: "1450000",
  federal_withheld_cents: "39499",
  state_taxable_cents: "1450000",
  state_withheld_cents: "18750",
  social_security_wages_cents: "1450000",
  medicare_wages_cents: "1450000",
};

function payroll(overrides: Partial<PayrollYear> = {}): PayrollYear {
  return {
    year: 2026,
    through: "2026-09-11",
    revision: "p1",
    fingerprint: "pf1",
    run_count: 8,
    drafts: 0,
    employees: [employee],
    coverage: {
      id: "cov-1",
      tax_year: 2026,
      version: 1,
      through_date: "2026-09-11",
      source_through_date: "2026-08-29",
      current: true,
      employees: [employee],
      document_id: "doc-1",
      reason: "verified",
      created_at: "2026-09-01T00:00:00Z",
    },
    ...overrides,
  };
}

const build = (s: TaxSource | null, p: PayrollYear | null) =>
  buildBooksFigures({ year: 2026, through: "2026-09-11", source: s, sourceError: null, payroll: p, payrollError: null });
const byKey = (figures: BooksFigure[], key: string) => figures.find((f) => f.key === key);

// ---------------------------------------------------------------------------
// 1. What the ledger offers

{
  const out = build(source(), null);
  const profit = byKey(out.figures, "business_profit");
  check("business profit is offered from adjusted ordinary income", !!profit && profit.available && profit.amount_cents === "7231167");
  check("business profit carries the ledger cutoff", profit?.through === "2026-09-11");
  check("interest is listed when present", byKey(out.figures, "interest")?.available === true);
  check("a long-term loss is listed as a gain figure", byKey(out.figures, "long_gain")?.kind === "gain" && byKey(out.figures, "long_gain")?.term === "long");
  check("zero or absent concepts are not listed", !byKey(out.figures, "qualified_dividend") && !byKey(out.figures, "short_gain"));
  check("the books classification is passed through", out.classification === "s_corp");
  check("no notes on a clean source", out.notes.length === 0);
}
{
  const out = build(source({ year_settings: { classification: "c_corp" } }), null);
  const profit = byKey(out.figures, "business_profit");
  check("C-Corp profit is held back with the reason", profit?.available === false && /company/.test(profit.reason ?? ""));
  check("investments are still offered for a C-Corp", byKey(out.figures, "interest")?.available === true);
}
{
  const out = build(source({ unmapped_accounts: 2 }), null);
  check("unmapped accounts hold every ledger figure back", out.figures.filter((f) => f.group !== "payroll").every((f) => !f.available));
  check("the reason counts the accounts", /2 accounts/.test(byKey(out.figures, "business_profit")?.reason ?? ""));
}
{
  const out = build(source({ year_settings: null }), null);
  check("no classification holds the profit back", /classification/.test(byKey(out.figures, "business_profit")?.reason ?? ""));
}
{
  const out = build(source({ drafts: 3, adjusted_ordinary_cents: "-120000" }), null);
  check("unreviewed activity is a count with a way in, never a gate or a sentence", byKey(out.figures, "business_profit")?.available === true && out.unreviewed === 3 && !out.notes.some((n) => /draft/.test(n)));
  check("a loss is offered with a basis caveat", /Loss so far/.test(byKey(out.figures, "business_profit")?.detail ?? ""));
}
{
  const out = build(source({ incomplete_imports: 1 }), null);
  check("an unverified import is neither a gate nor a note: parity is not something the owner can act on", byKey(out.figures, "business_profit")?.available === true && !out.notes.some((n) => /import/.test(n)));
}
{
  const out = buildBooksFigures({ year: 2026, through: "2026-09-11", source: null, sourceError: "The books could not be read.", payroll: null, payrollError: null });
  check("a failed ledger read is a note with no ledger figures", out.figures.length === 0 && out.notes[0] === "The books could not be read.");
}

// ---------------------------------------------------------------------------
// 2. What payroll offers

{
  const out = build(null, payroll());
  const wages = byKey(out.figures, "payroll:wages:emp-1");
  check("wages come from federal taxable with all three bases", !!wages?.available && wages.wage_bases_cents?.social_security === "1450000" && wages.wage_bases_cents?.state === "1450000");
  check("payroll figures carry the verified pay date and document", wages?.through === "2026-08-29" && wages?.document_id === "doc-1" && /verified register/.test(wages?.detail ?? ""));
  check("federal and state withholding are offered", byKey(out.figures, "payroll:federal_withheld:emp-1")?.available === true && byKey(out.figures, "payroll:state_withheld:emp-1")?.jurisdiction === "state");
}
{
  const out = build(null, payroll({ coverage: { ...payroll().coverage!, employees: [{ ...employee, state_withheld_cents: null, state_taxable_cents: null }] } }));
  check("a null fact holds only that figure back", byKey(out.figures, "payroll:state_withheld:emp-1")?.available === false && byKey(out.figures, "payroll:federal_withheld:emp-1")?.available === true);
  check("wages drop the state base when the register lacks it", byKey(out.figures, "payroll:wages:emp-1")?.wage_bases_cents?.state === undefined);
}
{
  const out = build(null, payroll({ coverage: null }));
  check("no verified register still offers the posted-run sums, labelled", out.figures.length === 3 && out.figures.every((f) => f.available && f.document_id === null && /posted payroll runs/.test(f.detail)) && !out.notes.some((n) => /posted runs/.test(n)));
  check("posted-run figures carry the payroll cutoff", out.figures.every((f) => f.through === "2026-09-11"));
}
{
  const out = build(null, payroll({ coverage: null, employees: [{ ...employee, federal_taxable_cents: null, social_security_wages_cents: null, medicare_wages_cents: null }] }));
  const wages = byKey(out.figures, "payroll:wages:emp-1");
  check("gross pay stands in when taxable wages were never reported", wages?.available === true && wages.amount_cents === "1450000" && /Gross pay/.test(wages.detail) && wages.wage_bases_cents?.social_security === "1450000");
}
{
  const out = build(null, payroll({ coverage: null, employees: [{ ...employee, gross_cash_cents: "0", federal_taxable_cents: null, social_security_wages_cents: null, medicare_wages_cents: null }] }));
  check("zero gross with no taxable wages still offers a zero wages row rather than hiding it", byKey(out.figures, "payroll:wages:emp-1")?.available === true);
}
{
  const out = build(null, payroll({ run_count: 0, employees: [], coverage: null }));
  check("no payroll this year offers nothing and says nothing", out.figures.length === 0 && out.notes.length === 0);
}
{
  const out = build(null, payroll({ coverage: { ...payroll().coverage!, current: false } }));
  check("a missing provider document keeps the figures and drops the link", byKey(out.figures, "payroll:wages:emp-1")?.available === true && byKey(out.figures, "payroll:wages:emp-1")?.document_id === null && out.notes.some((n) => /no longer in storage/.test(n)));
}

// ---------------------------------------------------------------------------
// 3. Figures become rows

const empty = { income: [], gains: [], payments: [] };
const NOW = "2026-09-12T00:00:00Z";
const all = build(source(), payroll()).figures;

{
  const out = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  const profit = out.income.find((r) => r.books?.key === "business_profit");
  const wages = out.income.find((r) => r.books?.key === "payroll:wages:emp-1");
  const fed = out.payments.find((r) => r.books?.key === "payroll:federal_withheld:emp-1");
  const st = out.payments.find((r) => r.books?.key === "payroll:state_withheld:emp-1");
  const loss = out.gains.find((r) => r.books?.key === "long_gain");
  check("S-Corp profit is a K-1 row, active, not SE", profit?.income_type === "k1" && profit.subject_to_se === false && profit.materially_participates === true && near(profit.amount, 72311.67));
  check("interest is a 1099 row without SE", out.income.find((r) => r.books?.key === "interest")?.subject_to_se === false);
  check("wages are W-2 with wage bases including the state", wages?.income_type === "w2" && wages.wage_bases?.social_security === 14500 && wages.wage_bases?.state_code === "AZ");
  check("withholding rows are paired to the wages row", fed?.linked_income_id === wages?.id && st?.linked_income_id === wages?.id && fed?.category === "withholding");
  check("withholding rows carry evidence", fed?.document_id === "doc-1" && fed?.verified_through === "2026-08-29" && near(fed?.amount ?? 0, 394.99));
  check("the loss becomes a long-term gain entry", loss?.term === "long" && near(loss.amount, -3000));
  check("rest of year starts at zero and amount equals the actual", out.income.every((r) => r.books?.rest === 0 && near(r.amount, r.books.actual)));
  check("firstId points at the first added row", out.firstId === out.income[0]?.id);
}
{
  const out = rowsFromFigures(all, { taxClassification: "sole_prop", state: null, now: NOW, existing: empty });
  const profit = out.income.find((r) => r.books?.key === "business_profit");
  check("sole prop profit is 1099 subject to SE", profit?.income_type === "1099" && profit.subject_to_se === true);
  check("without a state the wage bases omit the state override", out.income.find((r) => r.books?.key === "payroll:wages:emp-1")?.wage_bases?.state_code === undefined);
}
{
  const template: TaxIncomeSource = { id: "tpl", name: "Business Profit", amount: 0, subject_to_se: false, income_type: "k1" };
  const out = rowsFromFigures(all.filter((f) => f.key === "business_profit"), { taxClassification: "s_corp", state: "AZ", now: NOW, existing: { ...empty, income: [template] } });
  check("an untouched template row is adopted, not duplicated", out.income.length === 1 && out.income[0].id === "tpl" && out.income[0].books?.key === "business_profit" && near(out.income[0].amount, 72311.67));
  check("the template keeps its name", out.income[0].name === "Business Profit");
}
{
  const manual: TaxIncomeSource = { id: "m", name: "Business Profit", amount: 5000, subject_to_se: false, income_type: "k1" };
  const out = rowsFromFigures(all.filter((f) => f.key === "business_profit"), { taxClassification: "s_corp", state: "AZ", now: NOW, existing: { ...empty, income: [manual] } });
  check("a row with an amount is left alone and a new row is added", out.income.length === 2 && out.income[0].amount === 5000 && !out.income[0].books);
}
{
  const synced: TaxIncomeSource = { id: "s", name: "Business Profit", amount: 0, subject_to_se: false, income_type: "k1", linked_source_id: "src-1", linked_amount: 0 };
  const out = rowsFromFigures(all.filter((f) => f.key === "business_profit"), { taxClassification: "s_corp", state: "AZ", now: NOW, existing: { ...empty, income: [synced] } });
  check("a tracker-synced row is never adopted", out.income.length === 2 && !out.income[0].books);
}
{
  const first = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  const again = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: first });
  check("adding the same figures twice adds nothing", again.addedIds.length === 0 && again.income.length === first.income.length);
  const unavailable = rowsFromFigures(build(source({ unmapped_accounts: 1 }), null).figures, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  check("unavailable figures are skipped", unavailable.addedIds.length === 0);
}
{
  const withBooks = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  const chip: TaxIncomeSource = { id: "c", name: "Business Profit", amount: 0, subject_to_se: false, income_type: "k1" };
  const salary: TaxIncomeSource = { id: "o", name: "Officer Salary", amount: 0, subject_to_se: false, income_type: "w2" };
  const interest: TaxIncomeSource = { id: "i", name: "Interest & Dividends", amount: 0, subject_to_se: false, income_type: "1099" };
  check("template dedupe treats books rows as covering their role", isTemplateAlreadyAdded(chip, withBooks.income) && isTemplateAlreadyAdded(salary, withBooks.income) && isTemplateAlreadyAdded(interest, withBooks.income));
  check("template dedupe still ignores unrelated templates", !isTemplateAlreadyAdded({ id: "f", name: "Freelance / Side Income", amount: 0, subject_to_se: true, income_type: "1099" }, withBooks.income));
}

// ---------------------------------------------------------------------------
// 4. Rest of year and wage bases

{
  const rows = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  const wages = rows.income.find((r) => r.books?.key === "payroll:wages:emp-1")!;
  const bumped = withRest(wages, 5000, "AZ");
  check("rest of year adds to the amount", near(bumped.amount, 19500) && bumped.books?.rest === 5000);
  check("rest of year adds to every wage base", bumped.wage_bases?.social_security === 19500 && bumped.wage_bases?.medicare === 19500 && bumped.wage_bases?.state === 19500);
  check("rest is rounded to the cent", withRest(wages, 10.075, "AZ").books?.rest === 10.08);
  check("wage bases are undefined for non-payroll rows", booksWageBases(rows.income.find((r) => r.books?.key === "interest")!.books!, "AZ") === undefined);
}

// ---------------------------------------------------------------------------
// 5. Refresh

{
  const rows = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  const same = applyBooksRefresh(rows, all, { state: "AZ", now: "2026-09-13T00:00:00Z" });
  check("refreshing with identical figures changes nothing", same.changed === false && same.moved.length === 0 && same.problems.length === 0);
  check("unchanged rows keep their identity", same.income[0] === rows.income[0]);

  const wagesRow = rows.income.find((r) => r.books?.key === "payroll:wages:emp-1")!;
  const withRestRows = { ...rows, income: rows.income.map((r) => (r.id === wagesRow.id ? withRest(r, 3000, "AZ") : r)) };
  const movedFigures = all.map((f) => (f.key === "payroll:wages:emp-1" ? { ...f, amount_cents: "1600000", through: "2026-09-12" } : f));
  const moved = applyBooksRefresh(withRestRows, movedFigures, { state: "AZ", now: "2026-09-13T00:00:00Z" });
  const next = moved.income.find((r) => r.id === wagesRow.id)!;
  check("a moved figure updates the actual and keeps the rest", moved.changed && next.books?.actual === 16000 && next.books?.rest === 3000 && near(next.amount, 19000));
  check("the move is reported by name", moved.moved.some((m) => m.id === wagesRow.id && near(m.from, 17500) && near(m.to, 19000)));
  check("wage bases follow the refreshed actual", next.wage_bases?.social_security === 17500);

  const missing = applyBooksRefresh(rows, all.filter((f) => f.key !== "business_profit"), { state: "AZ", now: NOW });
  const profit = missing.income.find((r) => r.books?.key === "business_profit")!;
  check("a figure that disappears never zeroes the row", near(profit.amount, 72311.67) && missing.problems.some((p) => /no longer offered/.test(p)));

  const gated = applyBooksRefresh(rows, all.map((f) => (f.key === "business_profit" ? { ...f, available: false, reason: "2 accounts still need a tax treatment" } : f)), { state: "AZ", now: NOW });
  check("an unavailable figure keeps the row and reports the reason", near(gated.income.find((r) => r.books?.key === "business_profit")!.amount, 72311.67) && gated.problems.some((p) => /2 accounts/.test(p)));

  const yearEnd = applyBooksRefresh(withRestRows, all.map((f) => ({ ...f, through: "2026-12-31" })), { state: "AZ", now: NOW });
  const done = yearEnd.income.find((r) => r.id === wagesRow.id)!;
  check("once the books cover the year the rest is cleared and reported", done.books?.rest === 0 && near(done.amount, 14500) && yearEnd.moved.some((m) => m.id === wagesRow.id && near(m.from, 17500) && near(m.to, 14500)));

  const manualOnly = applyBooksRefresh({ income: [{ id: "x", name: "Manual", amount: 10, subject_to_se: false, income_type: "1099" }], gains: [], payments: [] }, all, { state: "AZ", now: NOW });
  check("manual rows are untouched by a refresh", manualOnly.changed === false && manualOnly.income[0].amount === 10);
}

// ---------------------------------------------------------------------------
// 6. Withholding evidence follows the refresh

{
  const rows = rowsFromFigures(all, { taxClassification: "s_corp", state: "AZ", now: NOW, existing: empty });
  const fed = rows.payments.find((r) => r.books?.key === "payroll:federal_withheld:emp-1")!;
  const lost = applyBooksRefresh(rows, all.map((f) => (f.group === "payroll" ? { ...f, document_id: null } : f)), { state: "AZ", now: NOW });
  const next = lost.payments.find((r) => r.id === fed.id) as TaxPaymentEntry;
  check("a dropped provider document is removed from the withholding row", lost.changed && next.document_id === undefined && next.books?.document_id === null);
}

// ---------------------------------------------------------------------------
// 7. Cents converters (carried over from the projection suite)

for (const cents of ["0", "1", "-1", "12345", "-12345", "1000000000000", "-1000000000000"]) {
  check(`round trip ${cents}`, fromEstimatorDollars(toEstimatorDollars(cents)) === cents);
}
for (const cents of ["1.2", "1e3", "01", "1000000000001", "-1000000000001"]) {
  fails(`rejects ${cents}`, () => toEstimatorDollars(cents), /Invalid|range/);
}
fails("rejects Infinity", () => fromEstimatorDollars(Infinity), /invalid/);
fails("rejects NaN", () => fromEstimatorDollars(NaN), /invalid/);
fails("rejects out of range dollars", () => fromEstimatorDollars(10000000001), /range/);
check("rounds decimal halves away from zero", fromEstimatorDollars(-1.005) === "-101" && fromEstimatorDollars(1.005) === "101");
check("rounds 10.075 without float error", fromEstimatorDollars(10.075) === "1008" && fromEstimatorDollars(-10.075) === "-1008");
check("tiny amounts round to zero cents", fromEstimatorDollars(1e-7) === "0");
check("999.995 rounds up", fromEstimatorDollars(999.995) === "100000");

// ---------------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`  books figures: ${passed} checks passed`);
  process.exit(0);
} else {
  console.log(`  books figures: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.log(`   x  ${f}`));
  process.exit(1);
}
