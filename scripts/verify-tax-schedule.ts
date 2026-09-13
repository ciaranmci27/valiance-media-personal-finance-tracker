/**
 * Payment schedule regression suite.
 *
 * Run with:  npm run test:tax:schedule
 *
 * Pins the behaviour of `src/lib/tax/payment-schedule.ts`: quarter bucketing,
 * due-quarter selection, the tax-so-far suggestion, the prior-year and
 * overpaid cases, and the meter invariant that the paid segments always sum
 * to the engine's `totalPaid`, with books-sourced withholding split into the
 * actual so far and the projected rest of year.
 */
import {
  annualizationPeriod,
  annualizeRows,
  annualizedRequirement,
  buildMeter,
  buildPaymentSchedule,
  daysBetween,
  estimatedThrough,
  federalDeadlines,
  nominalDeadlines,
  shortfallCost,
  withheldThrough,
} from "@/lib/tax/payment-schedule";
import type { TaxPaymentEntry } from "@/types/database";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
const near = (a: number | null, b: number, tol = 0.005) => a !== null && Math.abs(a - b) < tol;

let seq = 0;
function row(
  type: TaxPaymentEntry["type"],
  category: TaxPaymentEntry["category"],
  amount: number,
  extra: Partial<TaxPaymentEntry> = {},
): TaxPaymentEntry {
  seq += 1;
  return { id: `row-${seq}`, type, category, label: `${type} ${category}`, amount, ...extra };
}

// ---------------------------------------------------------------------------
// 0. The deadline table.
check("2025 deadlines shift the June date off the weekend", federalDeadlines[2025]?.[1] === "2025-06-16");
check("2026 deadlines end on Jan 15 of the following year", federalDeadlines[2026]?.[3] === "2027-01-15");

// ---------------------------------------------------------------------------
// 1. The owner's real 2026 figures (screenshot of 2026-09-11).
const real2026: TaxPaymentEntry[] = [
  row("federal", "withholding", 394.99),
  row("state", "withholding", 187.5),
  row("federal", "payment", 30.6, { quarter: "Q1" }),
  row("state", "payment", 0, { quarter: "Q1" }),
  row("federal", "payment", 1318.67, { quarter: "Q2" }),
  row("state", "payment", 357.8, { quarter: "Q2" }),
];
const realRemaining = { federalRemaining: 5025.79, stateRemaining: 1167.49 };

const s = buildPaymentSchedule({
  year: 2026,
  today: "2026-09-11",
  payments: real2026,
  breakdown: realRemaining,
  deadlines: federalDeadlines[2026],
});

check("2026 uses the deadline table", s.deadlineSource === "table");
check("Q1 is paid with the recorded federal amount",
  s.quarters[0].status === "paid" && near(s.quarters[0].federalPaid, 30.6) && near(s.quarters[0].statePaid, 0));
check("Q2 is paid with both jurisdictions",
  s.quarters[1].status === "paid" && near(s.quarters[1].federalPaid, 1318.67) && near(s.quarters[1].statePaid, 357.8));
check("Q3 is the due quarter", s.quarters[2].status === "due" && s.quarters[2].deadline === "2026-09-15");
check("Q4 is upcoming", s.quarters[3].status === "upcoming" && s.quarters[3].deadline === "2027-01-15");
check("next payment is Q3 in four days",
  s.next?.kind === "quarter" && s.next.quarter === "Q3" && s.next.daysUntil === 4,
  JSON.stringify(s.next));
check("federal suggestion is everything still owed on the year so far, not a share of it",
  near(s.next?.suggestedFederal ?? null, 5025.79), String(s.next?.suggestedFederal));
check("state suggestion is everything still owed on the year so far",
  near(s.next?.suggestedState ?? null, 1167.49), String(s.next?.suggestedState));
check("only the due quarter carries suggestions",
  s.quarters[2].suggestedFederal !== null && s.quarters[3].suggestedFederal === null && s.quarters[0].suggestedFederal === null);
check("no rows land in other", s.other.rows.length === 0 && s.other.federal === 0 && s.other.state === 0);

// ---------------------------------------------------------------------------
// 2. Meter invariant on the same figures.
const meter = buildMeter(
  { totalPaid: 3398.81, netRemaining: 6193.28, ficaAutoCredited: 1109.25, additionalChildTaxCredit: 0 },
  real2026,
);
check("withheld is the two W-2 rows", near(meter.withheld, 582.49));
check("estimated is the four quarterly rows", near(meter.estimated, 1707.07));
check("projected is the assumed FICA credit", near(meter.projected, 1109.25));
check("paid segments sum to the engine's totalPaid", near(meter.withheld + meter.estimated + meter.projected, 3398.81));
check("remaining is what is still owed", near(meter.remaining, 6193.28));
check("total is the four segments", near(meter.total, 9592.09));

// ---------------------------------------------------------------------------
// 3. Books withholding splits into actual and rest of year; final/other stay out of the tiles.
const withExtras: TaxPaymentEntry[] = [
  ...real2026.slice(1),
  row("federal", "withholding", 894.99, {
    books: { key: "payroll:federal_withheld:e1", actual: 394.99, rest: 500, through: "2026-08-29" },
  }),
  row("federal", "payment", 100, { quarter: "final" }),
  row("state", "payment", 25, { quarter: "other" }),
];
const s3 = buildPaymentSchedule({
  year: 2026, today: "2026-09-11", payments: withExtras, breakdown: realRemaining, deadlines: federalDeadlines[2026],
});
check("final and other rows are summed outside the quarters",
  s3.other.rows.length === 2 && near(s3.other.federal, 100) && near(s3.other.state, 25));
check("quarter totals ignore final/other rows", near(s3.quarters[0].federalPaid, 30.6) && near(s3.quarters[1].federalPaid, 1318.67));
const m3 = buildMeter(
  { totalPaid: 3398.81 + 500 + 125, netRemaining: 5568.28, ficaAutoCredited: 1109.25, additionalChildTaxCredit: 0 },
  withExtras,
);
check("the books actual counts as withheld and the rest as projected",
  near(m3.withheld, 582.49) && near(m3.projected, 1609.25) && near(m3.estimated, 1832.07));
check("meter invariant holds with books and other rows", near(m3.withheld + m3.estimated + m3.projected, 4023.81));

// ---------------------------------------------------------------------------
// 4. Rows without a category count as withholding (legacy rows).
const legacy: TaxPaymentEntry[] = [{ id: "legacy", type: "federal", label: "Old row", amount: 250 }];
const m4 = buildMeter({ totalPaid: 250, netRemaining: 0, ficaAutoCredited: 0, additionalChildTaxCredit: 0 }, legacy);
check("legacy rows with no category are withholding", near(m4.withheld, 250) && near(m4.estimated, 0));

// ---------------------------------------------------------------------------
// 5. Prior-year tab: every deadline behind us.
const prior: TaxPaymentEntry[] = [
  row("federal", "payment", 5000, { quarter: "Q1" }),
  row("federal", "payment", 5000, { quarter: "Q2" }),
  row("federal", "payment", 5000, { quarter: "Q3" }),
  row("federal", "payment", 5000, { quarter: "Q4" }),
];
const s5 = buildPaymentSchedule({
  year: 2025, today: "2026-09-11", payments: prior, breakdown: { federalRemaining: 1200, stateRemaining: 0 }, deadlines: federalDeadlines[2025],
});
check("prior year: all quarters read as paid", s5.quarters.every((q) => q.status === "paid"));
check("prior year after the filing deadline has no next payment", s5.next === null);
const s5b = buildPaymentSchedule({
  year: 2025, today: "2026-03-01", payments: prior.slice(0, 3), breakdown: { federalRemaining: 1200, stateRemaining: 0 }, deadlines: federalDeadlines[2025],
});
check("prior year before the filing deadline points at the return",
  s5b.next?.kind === "return" && s5b.next.deadline === "2026-04-15" && s5b.next.daysUntil === 45 && near(s5b.next.suggestedFederal, 1200),
  JSON.stringify(s5b.next));
check("an unpaid past quarter reads as past", s5b.quarters[3].status === "past");

// ---------------------------------------------------------------------------
// 6. Overpaid jurisdiction suggests zero; the other still gets its share.
const s6 = buildPaymentSchedule({
  year: 2026, today: "2026-09-11", payments: real2026, breakdown: { federalRemaining: -500, stateRemaining: 100 }, deadlines: federalDeadlines[2026],
});
check("overpaid federal suggests nothing", near(s6.next?.suggestedFederal ?? null, 0));
check("the other jurisdiction still shows its full balance", near(s6.next?.suggestedState ?? null, 100));
const m6 = buildMeter({ totalPaid: 4000, netRemaining: -400, ficaAutoCredited: 0, additionalChildTaxCredit: 0 }, real2026.slice(0, 2));
check("a refund leaves no remaining segment", near(m6.remaining, 0));

// ---------------------------------------------------------------------------
// 7. Years outside the deadline table use nominal dates.
const s7 = buildPaymentSchedule({ year: 2027, today: "2027-02-01", payments: [], breakdown: { federalRemaining: 4000, stateRemaining: 0 } });
check("missing table falls back to nominal deadlines",
  s7.deadlineSource === "nominal" && s7.quarters.map((q) => q.deadline).join(",") === nominalDeadlines(2027).join(","));
check("with nothing paid the first quarter is due and the rest upcoming",
  s7.quarters[0].status === "due" && s7.quarters.slice(1).every((q) => q.status === "upcoming"));
check("with four open quarters the suggestion is still the whole balance so far", near(s7.next?.suggestedFederal ?? null, 4000));

// ---------------------------------------------------------------------------
// 8. Date arithmetic.
check("daysBetween counts whole days", daysBetween("2026-09-11", "2026-09-15") === 4 && daysBetween("2026-09-15", "2026-09-11") === -4);
check("a deadline on today's date counts as ahead",
  buildPaymentSchedule({ year: 2026, today: "2026-09-15", payments: real2026, breakdown: realRemaining, deadlines: federalDeadlines[2026] }).next?.daysUntil === 0);

// ---------------------------------------------------------------------------
// 9. Annualized income instalments (Form 2210 Schedule AI).
const q3 = annualizationPeriod(2026, "Q3");
check("Q3 looks at income through Aug 31, scaled by 1.5, with 67.5% due",
  q3.end === "2026-08-31" && q3.factor === 1.5 && near(q3.share, 0.675) && q3.months === 8);
check("the four periods follow the IRS table",
  annualizationPeriod(2026, "Q1").factor === 4 && annualizationPeriod(2026, "Q2").factor === 2.4 && annualizationPeriod(2026, "Q4").factor === 1 &&
  annualizationPeriod(2026, "Q1").end === "2026-03-31" && annualizationPeriod(2026, "Q2").end === "2026-05-31" && annualizationPeriod(2026, "Q4").end === "2026-12-31" &&
  near(annualizationPeriod(2026, "Q1").share, 0.225) && near(annualizationPeriod(2026, "Q2").share, 0.45) && near(annualizationPeriod(2026, "Q4").share, 0.9));

const booksLink = (key: string, actual: number) => ({ key: key as never, actual, through: "2026-09-12", rest: 0 });
const income = [
  { id: "a", amount: 1500, books: undefined },
  { id: "b", amount: 69859.11, books: booksLink("business_profit", 69859.11) },
];
const scaled = annualizeRows(income, 1.5, { business_profit: 62000 });
check("books rows take the period actual times the factor", near(scaled[1].amount, 93000));
check("rows with no dates pass through untouched, since evenly spread income annualizes to itself", scaled[0].amount === 1500 && scaled[0] === income[0]);
check("without a period actual the row's own actual is scaled", near(annualizeRows(income, 1.5, {})[1].amount, 104788.67));

const withholdingRows: TaxPaymentEntry[] = [
  row("federal", "withholding", 911.65, { books: booksLink("payroll:federal_withheld:e1", 911.65) as never }),
  row("state", "withholding", 362.5, { books: booksLink("payroll:state_withheld:e1", 362.5) as never }),
  row("federal", "withholding", 1200),
];
const withheld = withheldThrough(withholdingRows, q3, { "payroll:federal_withheld:e1": 800 });
check("books withholding counts the period actual; undated withholding is prorated by months",
  near(withheld.federal, 800 + 800) && near(withheld.state, 362.5));

const paid = estimatedThrough(real2026, "Q3");
check("estimated payments through the quarter include earlier quarters, nothing later",
  near(paid.federal, 1349.27) && near(paid.state, 357.8) && near(estimatedThrough(real2026, "Q1").federal, 30.6));
check("final and other payments are not quarterly instalments",
  near(estimatedThrough([row("federal", "payment", 500, { quarter: "final" })], "Q4").federal, 0));

const req = annualizedRequirement({ period: q3, annualizedTax: { federal: 20000, state: 2500 }, paidToDate: { federal: 4000, state: 700 } });
check("the requirement is the cumulative share less what is paid, in whole cents", near(req.federal, 9500) && near(req.state, 987.5));
check("the full instalment drops the 10% cushion: a quarter of the year per deadline",
  q3.paceShare === 0.75 && annualizationPeriod(2026, "Q1").paceShare === 0.25 && annualizationPeriod(2026, "Q4").paceShare === 1 &&
  near(annualizedRequirement({ period: q3, annualizedTax: { federal: 20000, state: 2500 }, paidToDate: { federal: 4000, state: 700 }, share: q3.paceShare }).federal, 11000));
check("a requirement already met is zero, never negative",
  near(annualizedRequirement({ period: q3, annualizedTax: { federal: 1000, state: 0 }, paidToDate: { federal: 5000, state: 0 } }).federal, 0));

check("a shortfall costs the underpayment rate for the days until the next deadline",
  near(shortfallCost(1000, "2026-09-15", "2027-01-15"), 23.4) && shortfallCost(0, "2026-09-15", "2027-01-15") === 0 && shortfallCost(1000, "2027-01-15", "2026-09-15") === 0);

// ---------------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`  payment schedule: ${passed} checks passed`);
  process.exit(0);
} else {
  console.log(`  payment schedule: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.log(`   x  ${f}`));
  process.exit(1);
}
