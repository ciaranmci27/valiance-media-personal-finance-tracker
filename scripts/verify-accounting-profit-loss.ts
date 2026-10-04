import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildReportModel } from "../src/lib/accounting/report-model";
import {
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  centsOfDollar,
  changeOf,
  changeTone,
  compareModeOf,
  concentration,
  dollarSplit,
  expenseByCategory,
  expenseByVendor,
  incomeByContact,
  payrollReason,
  presetOf,
  presetRange,
  previousPeriod,
  profitLossMonths,
  rangeLabel,
  samePeriodLastYear,
  statementRows,
  topMovers,
} from "../src/lib/accounting/profit-loss";
import {
  demoBreakdown,
  demoParties,
  demoReportData,
  demoReportDetail,
} from "../src/lib/accounting/demo-reports";
import {
  reportFilterSchema,
  type DetailedReportSnapshot,
  type ReportData,
} from "../src/lib/accounting/reports";

/**
 * The profit and loss presentation rules (payroll, change against a near-zero
 * base, the statement's hidden cost of sales, the export layout) and the demo
 * fixture's internal consistency. Set ACCOUNTING_REPORT_ARTIFACT_DIR to also
 * write the branded PDFs and CSVs for a visual check.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;

  // Payroll: purpose, then subtype, then the "Payroll" name prefix; never income.
  const account = (over: Partial<Parameters<typeof payrollReason>[0]>) => ({
    account_type: "expense" as const,
    purpose: null,
    subtype: "operating_expense",
    name: "Software",
    ...over,
  });
  check(payrollReason(account({ purpose: "officer_compensation" })), "purpose");
  check(payrollReason(account({ purpose: "employer_payroll_taxes" })), "purpose");
  check(payrollReason(account({ subtype: "payroll_expense" })), "subtype");
  check(payrollReason(account({ name: "Payroll - Salary & Wages" })), "name");
  check(payrollReason(account({ name: "Payroll Employer Taxes" })), "name");
  check(payrollReason(account({ name: "Prepaid payroll service" })), null);
  check(payrollReason(account({ name: "Software" })), null);
  check(
    payrollReason(account({ account_type: "income", name: "Payroll refunds" })),
    null,
  );

  // Change: a percentage against a real base, dollars against almost nothing.
  check(changeOf(big(11000), big(10000)), {
    kind: "percent",
    diff: big(1000),
    percent: 10,
  });
  check(changeOf(big(10836706), big(11838)), {
    kind: "near-zero",
    diff: big(10824868),
  });
  check(changeOf(big(100), big(0)).kind, "near-zero");
  check(changeOf(big(0), big(5000)), {
    kind: "percent",
    diff: big(-5000),
    percent: -100,
  });
  check(changeOf(big(0), big(0)), { kind: "none" });
  // 5% exactly is still a real base.
  check(changeOf(big(10000), big(500)).kind, "percent");
  check(changeTone(big(10), true), "bad");
  check(changeTone(big(-10), true), "good");
  check(changeTone(big(10)), "good");
  check(centsOfDollar(big(7193), big(10000)), "72 cents");
  check(centsOfDollar(big(13200), big(10000)), "$1.32");
  check(centsOfDollar(big(1), big(0)), null);

  // Dates.
  check(rangeLabel("2026-01-01", "2026-10-03"), "Jan 1 to Oct 3, 2026");
  check(rangeLabel("2025-12-01", "2026-01-31"), "Dec 1, 2025 to Jan 31, 2026");
  check(previousPeriod("2026-07-01", "2026-09-30"), {
    compare_from: "2026-04-01",
    compare_to: "2026-06-30",
  });
  check(samePeriodLastYear("2024-02-01", "2024-02-29"), {
    compare_from: "2023-02-01",
    compare_to: "2023-02-28",
  });
  check(presetRange("quarter", "2026-10-03"), {
    from: "2026-10-01",
    to: "2026-10-03",
  });
  check(presetOf("2025-01-01", "2025-12-31", "2026-10-03"), "last-year");
  check(presetOf("2026-02-01", "2026-03-01", "2026-10-03"), "custom");
  check(
    compareModeOf({
      from: "2026-01-01",
      to: "2026-10-03",
      ...samePeriodLastYear("2026-01-01", "2026-10-03"),
    }),
    "year",
  );
  check(
    compareModeOf({
      from: "2026-01-01",
      to: "2026-10-03",
      ...previousPeriod("2026-01-01", "2026-10-03"),
    }),
    "previous",
  );

  // The demo fixture adds up the way the books do.
  const filter = reportFilterSchema.parse({
    from: "2026-01-01",
    to: "2026-10-03",
    mode: "working",
    ...samePeriodLastYear("2026-01-01", "2026-10-03"),
  });
  const data = demoReportData(filter);
  const sum = (values: string[]) =>
    values.reduce((s, v) => s + big(v), big(0)).toString();
  check(sum(data.monthly.map((m) => m.income_cents)), data.totals.income_cents);
  check(sum(data.monthly.map((m) => m.expense_cents)), data.totals.expense_cents);
  check(
    (big(data.totals.income_cents) - big(data.totals.expense_cents)).toString(),
    data.totals.net_cents,
  );
  check(
    sum(data.dimensions.map((d) => d.income_cents)),
    data.totals.income_cents,
  );
  check(
    sum(data.dimensions.map((d) => d.compare_expense_cents)),
    data.comparison.expense_cents,
  );
  check(
    (-big(
      sum(
        data.accounts
          .filter((a) => a.account_type === "income")
          .map((a) => a.period_cents),
      ),
    )).toString(),
    data.totals.income_cents,
  );
  const months = demoBreakdown(filter);
  check(
    sum(months.rows.map((r) => r.compare?.income_cents ?? "0")),
    data.comparison.income_cents,
    "Comparison months add up to the comparison period",
  );
  check(profitLossMonths(data, months).at(-1)?.partial, {
    from: "2026-10-01",
    to: "2026-10-03",
  });
  check(profitLossMonths(data, months)[0].partial, null);
  const reviewed = demoReportData({ ...filter, mode: "posted" });
  check(big(reviewed.totals.income_cents) <= big(data.totals.income_cents), true);
  check(data.quality.draft_count > 0, true);
  const consulting = data.accounts.find((a) => a.name === "Consulting revenue")!;
  const detail = await demoReportDetail({
    ...filter,
    compare_from: undefined,
    compare_to: undefined,
    account_ids: [consulting.id],
  });
  check(detail.total_cents, consulting.period_cents);
  check(detail.revision, data.revision);

  // Every dollar: payroll is the three payroll accounts, the rest is other costs.
  const split = dollarSplit(data);
  check(split.payrollAccounts.length, 3);
  check(split.payroll + split.other, split.expense);
  check(split.loss, false);
  check(split.result, big(data.totals.net_cents));

  // Breakdowns: shares of the right total, roll-up, payroll tags.
  const clients = incomeByContact(data, demoParties);
  check(clients[0].label, "Northwind Traders");
  check(clients[0].tag, "Client");
  // The demo's income is spread past two clients; the rule itself on fixed rows.
  check(concentration(clients), null);
  const row = (key: string, share: number) => ({ key, label: key, amount: big(share), share });
  check(concentration([row("a", 80), row("b", 20)])?.count, 1);
  check(concentration([row("a", 50), row("b", 30), row("c", 20)])?.count, 2);
  check(concentration([row("unassigned", 80), row("b", 20)]), null);
  const categories = expenseByCategory(data);
  check(categories.length, 9);
  check(categories.at(-1)?.key, "rest");
  check(
    categories.reduce((s, r) => s + r.amount, big(0)).toString(),
    data.totals.expense_cents,
  );
  check(categories.find((r) => r.key === "payroll")?.amount, split.payroll);
  check(
    categories.every((r) => reportFilterSchema.safeParse(r.filter ?? filter).success),
    true,
  );
  const vendors = expenseByVendor(data, demoParties);
  check(vendors.find((v) => v.label === "Alex Morgan")?.tag, "Payroll");
  const movers = topMovers(data);
  check(movers.length, 8);
  check(movers.find((m) => m.label === "Retainer revenue")?.tone, "good");
  check(movers.find((m) => m.label === "Insurance")?.tone, "bad");

  // The statement hides an empty cost of sales block and keeps every total.
  const model = buildReportModel("profit-loss", data, false, demoParties);
  const statement = statementRows(model, data);
  check(statement.costOfSalesHidden, true);
  check(
    statement.rows.some((r) => r.label === "Gross profit"),
    false,
  );
  check(statement.rows.at(-1)?.label, "Net profit");
  check(statement.rows.at(-1)?.values[0], data.totals.net_cents);

  // Exports: layout 2 is spreadsheet-ready; older snapshots keep their columns.
  const snapshot = (
    report: ReportData,
    layout?: 2,
    details = true,
  ): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000d001",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: {
      type: "detailed_report",
      export_definition: 1,
      data: report,
      options: {
        report_id: "profit-loss",
        show_zero: false,
        details,
        ...(layout ? { layout } : {}),
      },
    },
  });
  const legacy = reportDocument(snapshot(data));
  check(legacy.columns[0], "Account / category");
  check(legacy.statement, undefined);
  const branded = reportDocument(snapshot(data, 2));
  check(branded.columns, [
    "Section",
    "Account",
    "Amount",
    "% of income",
    "Comparison",
    "Change",
    "Change %",
  ]);
  const csv = documentCsv(branded);
  const net = branded.rows.find((r) => r.cells[0] === "Net profit")!;
  check(net.cells[1], "");
  check(net.cells[2], (Number(data.totals.net_cents) / 100).toFixed(2));
  check(
    csv.includes(`"Income","Total income",${(Number(data.totals.income_cents) / 100).toFixed(2)},100.00,`),
    true,
  );
  check(csv.includes("$"), false, "CSV numbers are plain");
  check(
    documentCsv({ ...branded, rows: [{ key: "x", kind: "account", cells: ["=cmd", "+1", "1.00", "", "", "", ""] }] })
      .includes(`"'=cmd","'+1",1.00`),
    true,
  );
  check(branded.statement?.tiles.map((t) => t.label), [
    "Income",
    "Expenses",
    "Net profit",
    "Margin",
  ]);
  const summary = reportDocument(snapshot(data, 2, false));
  check(
    summary.statement?.rows.some((r) => r.kind === "account"),
    false,
  );
  check(summary.rows.length, branded.rows.length, "CSV keeps every account");
  const plain = demoReportData({ ...filter, compare_from: undefined, compare_to: undefined });
  check(reportDocument(snapshot(plain, 2)).columns.length, 4);

  // A loss: the split reports it as a loss, not as negative profit.
  const february = demoReportData(
    reportFilterSchema.parse({ from: "2026-02-01", to: "2026-02-28", mode: "posted" }),
  );
  check(dollarSplit(february).loss, true);

  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "profit-loss-compare.pdf"), pdf);
    await writeFile(join(dir, "profit-loss-compare.csv"), csv);
    const ytd = reportDocument(snapshot(plain, 2));
    await writeFile(join(dir, "profit-loss.pdf"), await reportPdf(ytd));
    await writeFile(join(dir, "profit-loss.csv"), documentCsv(ytd));
    await writeFile(
      join(dir, "profit-loss-summary.pdf"),
      await reportPdf(reportDocument(snapshot(plain, 2, false))),
    );
    await writeFile(
      join(dir, "profit-loss-loss-month.pdf"),
      await reportPdf(reportDocument(snapshot(february, 2))),
    );
    await writeFile(join(dir, "profit-loss-legacy.pdf"), await reportPdf(legacy));
    // A long chart of accounts: 90 expense accounts under parent groups.
    const many: ReportData = {
      ...data,
      accounts: [
        ...data.accounts,
        ...Array.from({ length: 90 }, (_, i) => ({
          ...data.accounts.find((a) => a.name === "Software")!,
          id: `e0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          code: `7${String(i).padStart(3, "0")}`,
          name: `Synthetic expense account ${i + 1} with a longer descriptive name`,
          parent_account_id: "e0000000-0000-4000-8000-999999999999",
          parent_name: `Group ${Math.floor(i / 15) + 1}`,
          period_cents: String(1000 + i * 37),
          compare_period_cents: String(900 + i * 11),
        })),
      ],
    };
    await writeFile(
      join(dir, "profit-loss-long.pdf"),
      await reportPdf(reportDocument(snapshot(many, 2))),
    );
  }
  console.log(
    `Profit and loss presentation, demo fixture and export layout: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
