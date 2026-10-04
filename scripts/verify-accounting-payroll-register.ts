import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentCsv } from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  PAYROLL_NOTES,
  payrollBreakdown,
  payrollMonths,
  payrollQuarters,
  payrollScope,
  payrollTies,
  payrollTotals,
  payrollYears,
  quarterOf,
  quarterSummaries,
  registerRuns,
  runEmployees,
  type PayrollYearRead,
} from "../src/lib/accounting/payroll-register";
import {
  DEMO_SUPPORT_REPORTS,
  demoPayrollYear,
  demoReportData,
  demoSupportReport,
} from "../src/lib/accounting/demo-reports";
import { SUPPORT_LAYOUT_2, supportStatementDocument } from "../src/lib/accounting/support-report-document";
import {
  supportReportDocument,
  supportReportFilterSchema,
  type SupportReportData,
  type SupportReportSnapshot,
} from "../src/lib/accounting/support-reports";

/**
 * The payroll register: calendar years and quarters, each run's figures,
 * the totals and where the money went, the months, the quarter wage facts
 * (only when every run reports them), whether every run ties to the books,
 * the demo books, and the export layout. Set ACCOUNTING_REPORT_ARTIFACT_DIR
 * to also write the PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);
  const today = "2026-10-03";
  const register = (scope: { from: string; to: string }) =>
    demoSupportReport({ report_id: "payroll-register", from: scope.from, to: scope.to, offset: 0 });

  // Calendar years and the quarters that have started.
  check(payrollYears(today), [2026, 2025, 2024, 2023]);
  check(payrollScope(2026, today), { report_id: "payroll-register", from: "2026-01-01", to: today, offset: 0 });
  check(payrollScope(2026, today, 2), { report_id: "payroll-register", from: "2026-04-01", to: "2026-06-30", offset: 0 });
  check(payrollScope(2026, today, 4).to, today, "a quarter in progress runs to today");
  check(payrollScope(2025, today, 4).to, "2025-12-31");
  check(payrollQuarters(2026, today), [1, 2, 3, 4]);
  check(payrollQuarters(2026, "2026-05-10"), [1, 2]);
  check(payrollQuarters(2025, today), [1, 2, 3, 4]);
  check(quarterOf(payrollScope(2026, today, 3)), 3);
  check(quarterOf(payrollScope(2025, today)), null);
  check(quarterOf(payrollScope(2026, today)), null);
  check(quarterOf(payrollScope(2026, "2026-02-10")), 1, "early in the year, the year is the first quarter");
  for (const q of [1, 2, 3, 4] as const) check(supportReportFilterSchema.safeParse(payrollScope(2026, today, q)).success, true);

  // The demo books: a run a month for the owner; October's is still a draft.
  const scope = payrollScope(2026, today);
  const data = register(scope);
  const runs = registerRuns(data);
  const year = demoPayrollYear(2026, today);
  check(runs.length, 9);
  check(runs.map((r) => r.date.slice(5, 7)), ["01", "02", "03", "04", "05", "06", "07", "08", "09"]);
  check(year.drafts, 1);
  check(year.rows.some((r) => r.status === "void"), true);
  check(runs.every((r) => r.gross === r.net + r.withholding), true);
  check(runEmployees(runs[0], year), ["Alex Morgan"]);
  check(runEmployees(runs[0], null), []);
  // Totals: the register's own, then the components' other employer costs.
  const plain = payrollTotals(runs, null);
  const t = payrollTotals(runs, year);
  check(plain.detailed, false);
  check(t.detailed, true);
  check([t.gross, t.withholding, t.employerTax, t.net], [big(6750000), big(1350000), big(516375), big(5400000)]);
  check(t.employerOther, big(40500), "the payroll service fee is an employer cost");
  check(t.cost, t.gross + t.employerTax + t.employerOther);
  check(plain.cost, plain.gross + plain.employerTax);
  check([big(data.total_cells[2]), big(data.total_cells[3]), big(data.total_cells[4]), big(data.total_cells[5])], [t.gross, t.withholding, t.employerTax, t.net]);
  // Where it went: withholding by type adds up to the register's figure.
  const b = payrollBreakdown(runs, year);
  check(b.withholding.map((w) => w.label), ["Federal income tax", "Social Security", "State income tax", "Medicare"]);
  check(b.withholding.reduce((s, w) => s + w.amount, ZERO), t.withholding);
  check(b.employer.reduce((s, e) => s + e.amount, ZERO), t.employerTax + t.employerOther);
  check(payrollBreakdown(runs, null), {
    withholding: [{ label: "Withheld from pay", amount: t.withholding }],
    employer: [{ label: "Employer taxes", amount: t.employerTax }],
  });
  // A component total short of the register shows as its own line.
  const short: PayrollYearRead = {
    ...year,
    rows: year.rows.map((r) => (r.id === runs[0].id ? { ...r, components: r.components.filter((c) => c.label !== "Medicare") } : r)),
  };
  check(payrollBreakdown(runs, short).withholding.at(-1)?.label, "Other withholding");
  check(payrollBreakdown(runs, short).withholding.reduce((s, w) => s + w.amount, ZERO), t.withholding);
  // Months: every month of the scope, October partial with no posted run.
  const months = payrollMonths(runs, scope, year);
  check(months.length, 10);
  check(months.at(-1)?.partial, { from: "2026-10-01", to: today });
  check(months.at(-1)?.runs, 0);
  check(months.reduce((s, m) => s + m.net + m.withholding, ZERO), t.gross);
  check(months.reduce((s, m) => s + m.employer, ZERO), t.employerTax + t.employerOther);
  // Quarters: the provider's facts when every run has them, never otherwise.
  const quarters = quarterSummaries(runs, year);
  check(quarters.map((q) => q.quarter), [1, 2, 3]);
  check(quarters.every((q) => q.facts !== null), true);
  check(quarters[0].facts?.federalWithheld, (big(750000) * big(1000) / big(10000)) * big(3));
  check(quarters[0].facts?.socialSecurityWages, quarters[0].gross);
  check(quarterSummaries(runs, null).every((q) => q.facts === null), true, "without the details, no wage facts");
  const partial: PayrollYearRead = {
    ...year,
    rows: year.rows.map((r) =>
      r.id === runs[3].id ? { ...r, ytd: { run_employees: [{ ...r.ytd!.run_employees![0], medicare_wages_cents: null }] } } : r,
    ),
  };
  check(quarterSummaries(runs, partial).map((q) => q.facts === null), [false, true, false], "one run without facts hides its quarter's");
  check(quarters.reduce((s, q) => s + q.gross, ZERO), t.gross);
  // Ties: each run has its journal, the accounts hold what the runs posted.
  const books = demoReportData({ from: scope.from, to: scope.to, mode: "posted", offset: 0 });
  const ties = payrollTies(runs, year, books);
  check(ties.find((x) => x.key === "math")?.tone, "good");
  check(ties.find((x) => x.key === "journal")?.tone, "good");
  const officer = ties.find((x) => x.title.startsWith("Officer compensation"));
  check(officer?.tone, "good");
  // October's taxes and fee are posted, its salary run is a draft.
  const employerTie = ties.find((x) => x.title.startsWith("Employer payroll taxes"));
  check(employerTie?.tone, "look");
  check(employerTie?.detail.endsWith("The extra may belong to a draft run, or was booked outside payroll."), true);
  check(ties.find((x) => x.key === "drafts")?.tone, "look");
  check(ties.find((x) => x.key === "voided")?.tone, "info");
  check(payrollTies(runs, null, null).map((x) => x.key), ["math"]);
  // A run that does not add up is named, with its entry.
  const broken = { ...data, rows: data.rows.map((r, i) => (i === 2 ? { ...r, cells: [...r.cells.slice(0, 5), "1"] } : r)) };
  const brokenTies = payrollTies(registerRuns(broken), year, books);
  check(brokenTies[0].tone, "look");
  check(brokenTies[0].detail.includes(runs[2].run), true);
  check(brokenTies[0].entryId, year.rows.find((r) => r.id === runs[2].id)?.entry_id);
  // A quarter scope holds only its runs, and ties for its own period.
  const q3 = registerRuns(register(payrollScope(2026, today, 3)));
  check(q3.map((r) => r.date.slice(5, 7)), ["07", "08", "09"]);
  check(
    payrollTies(q3, year, demoReportData({ from: "2026-07-01", to: "2026-09-30", mode: "posted", offset: 0 })).find((x) =>
      x.title.startsWith("Officer compensation"),
    )?.tone,
    "good",
  );
  // 2025: a full year, every run posted.
  const prior = registerRuns(register(payrollScope(2025, today)));
  check(prior.length, 12);
  check(demoPayrollYear(2025, "2025-12-31").drafts, 0);
  check(DEMO_SUPPORT_REPORTS.includes("payroll-register"), true);
  // Never a filing amount the data does not hold.
  check(PAYROLL_NOTES.some((n) => /you owe|amount due|file this/i.test(n)), false);

  // Exports: a CSV for W-2 and quarterly checks and the branded PDF.
  const snapshot = (report: SupportReportData): SupportReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000e8b1",
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "support_report", export_definition: 1, data: report },
  });
  check(SUPPORT_LAYOUT_2.includes("payroll-register"), true);
  const doc = supportStatementDocument(snapshot(data));
  check(doc.title, "Payroll register");
  check(doc.columns, ["Quarter", "Pay date", "Provider run", "Gross wages", "Employee withholding", "Employer taxes", "Net pay", "Total cost"]);
  check(doc.rows.filter((r) => r.kind === "account").length, runs.length);
  check(doc.rows.filter((r) => r.kind === "subtotal").length, 3);
  const csv = documentCsv(doc);
  check(csv.includes("$"), false);
  check(csv.includes(`"Q1 2026","2026-01-01","PR-2026-01",7500.00,1500.00,573.75,6000.00,8073.75`), true);
  check(csv.includes(`"Q3 2026","","Total, 3 runs",22500.00,4500.00,1721.25,18000.00,24221.25`), true);
  check(csv.includes(`"2026","","Total, 9 runs",67500.00,13500.00,5163.75,54000.00,72663.75`), true);
  const st = doc.statement!;
  check(st.tiles.map((x) => [x.label, x.value]), [
    ["Gross wages", "$67,500.00"],
    ["Employer taxes", "$5,163.75"],
    ["Net pay", "$54,000.00"],
    ["Total payroll cost", "$72,663.75"],
  ]);
  check(st.rows.filter((r) => r.kind === "heading").map((r) => r.label), ["Q1 2026", "Q2 2026", "Q3 2026"]);
  check(st.rows.find((r) => r.kind === "account")?.date, "Jan 1");
  check(st.panels[0].total.value, "$54,000.00");
  check(st.checks?.items.length, 0);
  check(supportStatementDocument(snapshot(broken)).statement?.checks?.items.length, 1);
  const pdf = await reportPdf(doc);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  check(supportReportDocument(snapshot(data)).columns[0], "Pay date", "older downloads keep the original table");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "payroll-register.pdf"), pdf);
    await writeFile(join(dir, "payroll-register.csv"), csv);
    const full = supportStatementDocument(snapshot(register(payrollScope(2025, today))));
    await writeFile(join(dir, "payroll-register-2025.pdf"), await reportPdf(full));
    await writeFile(join(dir, "payroll-register-2025.csv"), documentCsv(full));
  }
  console.log(`Payroll register runs, totals, quarters, ties, demo books and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
