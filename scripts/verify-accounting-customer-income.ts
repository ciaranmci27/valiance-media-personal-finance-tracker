import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  CUSTOMER_REPORT,
  NO_CONTACT,
  concentrationOf,
  contactMonths,
  contactRows,
  contactStatement,
  contactSummary,
  dependencyOf,
  isEmptyContactReport,
  rankedRows,
  rowChange,
  seriesFilter,
  seriesIds,
  type ContactSummary,
} from "../src/lib/accounting/contact-report";
import { percentOf, previousPeriod } from "../src/lib/accounting/profit-loss";
import {
  demoBreakdown,
  demoParties,
  demoReportData,
  demoReportDetail,
} from "../src/lib/accounting/demo-reports";
import {
  reportFilterSchema,
  reportOptionsSchema,
  type DetailedReportSnapshot,
  type ReportData,
  type ReportFilter,
} from "../src/lib/accounting/reports";

/**
 * Income by customer: who counts as a client by role, the lines adding up
 * to total income on every period, the summary and concentration, new and
 * lost clients against a comparison, the month series, the statement, and
 * the export layout. Set ACCOUNTING_REPORT_ARTIFACT_DIR to also write the
 * PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);
  const config = CUSTOMER_REPORT;
  const filterOf = (
    from: string,
    to: string,
    mode: ReportFilter["mode"] = "working",
    compare?: { compare_from: string; compare_to: string },
  ): ReportFilter => ({ from, to, mode, offset: 0, ...(compare ?? {}) });

  // Roles decide the groups; a contact with no role yet counts as a client.
  check(config.isMain(["client"]), true);
  check(config.isMain([]), true);
  check(config.isMain(["client", "vendor"]), true);
  check(config.isMain(["financial"]), false);
  check(config.isMain(["owner", "employee"]), false);

  // Every period adds up: the lines are total income, by group too.
  for (const [from, to] of [
    ["2024-01-01", "2024-12-31"],
    ["2025-01-01", "2025-12-31"],
    ["2026-01-01", "2026-10-03"],
    ["2026-07-01", "2026-09-30"],
    ["2026-10-01", "2026-10-03"],
  ] as const) {
    for (const mode of ["working", "posted"] as const) {
      const label = `${from} ${mode}`;
      const data = demoReportData(filterOf(from, to, mode, previousPeriod(from, to)));
      const rows = contactRows(data, demoParties, config);
      const s = contactSummary(rows, data, config);
      check(rows.reduce((t, r) => t + r.amount, ZERO), s.total, `${label} rows add up`);
      check(s.mainTotal + s.otherTotal + s.noneTotal, s.total, `${label} groups add up`);
      check(rows.reduce((t, r) => t + r.previous, ZERO), s.previousTotal, `${label} comparison adds up`);
      check(s.total, big(data.totals.income_cents));
      const statement = contactStatement(rows, data, config, false);
      const sections = new Map<string, bigint>();
      for (const r of statement)
        if (r.kind === "account")
          sections.set(r.section, (sections.get(r.section) ?? ZERO) + big(r.values[0]));
      for (const r of statement)
        if (r.kind === "subtotal") check(big(r.values[0]), sections.get(r.section), `${label} ${r.section}`);
      check(big(statement.at(-1)!.values[0]), s.total);
      check(big(statement.at(-1)!.values[1]), s.previousTotal);
      check(
        statement
          .filter((r) => r.kind !== "heading")
          .every((r) => big(r.values[2]) === big(r.values[0]) - big(r.values[1])),
        true,
      );
      check(
        statement.every((r) => !r.detail || r.detail.every((d) => !d || reportFilterSchema.safeParse(d).success)),
        true,
      );
      // The month series: stacked plus everyone else is each month's income.
      const series = new Map(
        seriesIds(rows).map((id) => [id, demoBreakdown(seriesFilter(data.filter, id))]),
      );
      const months = contactMonths(data, rows, series, config);
      check(months.complete, true);
      check(
        months.months.every((m) => m.stacked.reduce((t, v) => t + v, m.rest) === m.total),
        true,
        `${label} stacks add up`,
      );
      check(months.months.reduce((t, m) => t + m.total, ZERO), s.total);
      check(months.stack.map((c) => c.id), rows.filter((r) => r.group === "main" && r.amount > ZERO).slice(0, 4).map((r) => r.id));
    }
  }

  // The year to date, in detail.
  const ytd = demoReportData(filterOf("2026-01-01", "2026-10-03"));
  const rows = contactRows(ytd, demoParties, config);
  const s = contactSummary(rows, ytd, config);
  check(rows[0].name, "Northwind Traders");
  check(rows.find((r) => r.name === "Online store payouts")?.group, "other");
  check(rows.find((r) => r.name === "Online store payouts")?.tag, "Bank");
  const none = rows.find((r) => r.id === NO_CONTACT)!;
  check(none.name, "No client assigned");
  check(none.group, "none");
  check(rows.at(-1)?.id, NO_CONTACT, "No client assigned comes last");
  check(none.filter.payee, NO_CONTACT);
  check(s.top?.name, "Northwind Traders");
  check(s.topShare, percentOf(s.top!.amount, s.total));
  check(s.paying, rows.filter((r) => r.group === "main" && r.amount > ZERO).length);
  check(s.average, s.mainTotal / big(s.paying));
  check(rows.some((r) => r.name.startsWith("Fourth Coffee Roasters")), true);
  // Without roles every named contact is a client; the money still adds up.
  const unroled = contactRows(ytd, [], config);
  check(unroled.filter((r) => r.group === "other").length, 0);
  check(contactSummary(unroled, ytd, config).mainTotal + none.amount, s.total);

  // The month series for the year to date.
  const series = new Map(seriesIds(rows).map((id) => [id, demoBreakdown(seriesFilter(ytd.filter, id))]));
  const months = contactMonths(ytd, rows, series, config);
  check(months.months.length, 10);
  check(months.months.at(-1)?.partial, { from: "2026-10-01", to: "2026-10-03" });
  check(months.months[0].paying, 5, "January: five clients paid (the referral partner pays in even months)");
  check(months.months[7].paying, 7, "August: Adventure Works and Fourth Coffee paid, Litware had stopped");
  check(months.months.every((m) => m.topShare === null || (m.topShare >= 0 && m.topShare <= 100)), true);
  check(seriesFilter(filterOf("2026-01-01", "2026-03-31", "working", previousPeriod("2026-01-01", "2026-03-31")), "x").compare_from, undefined);
  // A missing series leaves counts unknown rather than wrong.
  const partial = contactMonths(ytd, rows, new Map([[rows[0].id, series.get(rows[0].id)!]]), config);
  check(partial.complete, false);
  check(partial.months.every((m) => m.paying === null && m.average === null), true);
  check(partial.stack.length, 1);

  // New, returning and gone against the previous quarter.
  const q3 = demoReportData(filterOf("2026-07-01", "2026-09-30", "working", previousPeriod("2026-07-01", "2026-09-30")));
  const q3rows = contactRows(q3, demoParties, config);
  const q3s = contactSummary(q3rows, q3, config);
  check(q3s.newcomers.map((r) => r.name), ["Fourth Coffee Roasters and Hospitality Group of the Pacific Northwest"]);
  check(q3s.gone.map((r) => r.name), ["Litware Inc."]);
  check(q3s.newcomers.length + q3s.returning.length, q3s.paying);
  check(q3s.returning.length + q3s.gone.length, q3s.previousPaying);
  const litware = q3rows.find((r) => r.name === "Litware Inc.")!;
  check(rowChange(litware, "previous period")?.startsWith("Nothing this period, $"), true);
  check(rowChange(q3s.newcomers[0], "previous period"), "New this period");
  check(rowChange(rows[0], null), undefined);
  check(/^[+-]\d+\.\d% vs previous period$/.test(rowChange(q3s.top!, "previous period") ?? ""), true);

  // Concentration and dependency in plain words.
  const fake = (topShare: number, three: number | null = null, paying = 2): ContactSummary => ({
    ...s,
    topShare,
    topThreeShare: three,
    paying,
  });
  check(concentrationOf(fake(62), config)?.level, "high");
  check(concentrationOf(fake(30), config)?.level, "moderate");
  check(concentrationOf(fake(12), config)?.level, "spread");
  check(
    concentrationOf(fake(41.4, 82, 5), config)?.sentence,
    "Northwind Traders brought in 41% of your income, and your top 3 clients brought in 82%.",
  );
  check(concentrationOf({ ...s, top: null, topShare: null }, config), null);
  const dependency = dependencyOf(rows, s);
  check(dependency.half, 2, "Northwind and Contoso make up half");
  check(dependency.withoutTop, s.total - s.top!.amount);
  check(dependency.small, rows.filter((r) => r.group === "main" && r.amount > ZERO && r.share < 5).length);

  // Ranked rows fold the tail and keep every dollar.
  const folded = rankedRows(rows, "main", null, config, 3);
  check(folded.length, 4);
  check(folded.at(-1)?.key, "rest");
  check(folded.reduce((t, r) => t + r.amount, ZERO), s.mainTotal);
  const other = rankedRows(rows, ["other", "none"], null, config);
  check(other.at(-1)?.hint, config.noneHint);
  // A long statement folds to the biggest ten in Summary and lists all in Every client.
  const many: ReportData = {
    ...ytd,
    dimensions: [
      ...ytd.dimensions,
      ...Array.from({ length: 14 }, (_, i) => ({
        kind: "payee" as const,
        id: `c0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        name: `Synthetic client ${i + 1}`,
        income_cents: "0",
        expense_cents: "0",
        compare_income_cents: String(1000 + i),
        compare_expense_cents: "0",
      })),
    ],
  };
  const manyRows = contactRows(many, demoParties, config);
  check(manyRows.filter((r) => r.name.startsWith("Synthetic")).length, 0, "no money this period and no comparison: no line");
  const busy: ReportData = {
    ...ytd,
    dimensions: [
      ...ytd.dimensions.map((d) => d),
      ...Array.from({ length: 14 }, (_, i) => ({
        kind: "payee" as const,
        id: `c0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        name: `Synthetic client ${i + 1} with a longer name`,
        income_cents: String(1000 + i * 10),
        expense_cents: "0",
        compare_income_cents: "0",
        compare_expense_cents: "0",
      })),
    ],
    totals: {
      ...ytd.totals,
      income_cents: (big(ytd.totals.income_cents) + big(14 * 1000 + 910)).toString(),
    },
  };
  const busyRows = contactRows(busy, demoParties, config);
  const summary = contactStatement(busyRows, busy, config, false);
  const everyLine = contactStatement(busyRows, busy, config, true);
  check(summary.filter((r) => r.section === "Clients" && r.kind === "account").length, 11);
  check(summary.find((r) => r.key === "rest-Clients")?.label, `${busyRows.filter((r) => r.group === "main").length - 10} more clients`);
  check(everyLine.filter((r) => r.section === "Clients" && r.kind === "account").length, busyRows.filter((r) => r.group === "main").length);
  check(
    summary.find((r) => r.key === "t-Clients")?.values[0],
    everyLine.find((r) => r.key === "t-Clients")?.values[0],
  );

  // Drill-downs open the client's income lines.
  const detail = await demoReportDetail(reportFilterSchema.parse(rows[0].filter));
  check(big(detail.total_cents), -rows[0].amount, "income lines are credits");
  check(isEmptyContactReport(demoReportData(filterOf("2019-01-01", "2019-12-31")), config), true);
  check(isEmptyContactReport(ytd, config), false);

  // Exports: the role grouping travels with the snapshot.
  const otherContacts = rows
    .filter((r) => r.group === "other")
    .map((r) => ({ id: r.id, role: demoParties.find((p) => p.id === r.id)!.roles[0] }));
  const options = {
    report_id: "customer-income" as const,
    show_zero: false,
    details: true,
    layout: 2 as const,
    other_contacts: otherContacts,
  };
  check(reportOptionsSchema.safeParse(options).success, true);
  check(reportOptionsSchema.safeParse({ ...options, other_contacts: [{ id: "x", role: "bank" }] }).success, false);
  const snapshot = (report: ReportData, opts: Record<string, unknown> = options): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000e001",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: {
      type: "detailed_report",
      export_definition: 1,
      data: report,
      options: reportOptionsSchema.parse(opts),
    },
  });
  const compared = demoReportData(filterOf("2026-07-01", "2026-09-30", "working", previousPeriod("2026-07-01", "2026-09-30")));
  const branded = reportDocument(snapshot(compared));
  check(branded.title, "Income by customer");
  check(branded.columns, ["Section", "Contact", "Income", "% of income", "Comparison", "Change", "Change %"]);
  const csv = documentCsv(branded);
  check(csv.includes("$"), false);
  check(csv.includes(`"Other income","Online store payouts",`), true);
  check(csv.includes(`"Other income","No client assigned",`), true);
  check(csv.includes(`"Total","Total income",${(Number(compared.totals.income_cents) / 100).toFixed(2)},100.00,`), true);
  check(csv.includes("Contribution means"), false);
  check(branded.statement?.tiles.map((t) => t.label), ["Income", "Paying clients", "Top client's share", "Average per client"]);
  check(branded.statement?.ranked?.map((p) => p.title), ["Who paid you", "Other income"]);
  check(branded.statement?.ranked?.[0].note?.length ? true : false, true);
  // Without the role list every named contact reads as a client, as on a screen with no roles.
  const unrolled = reportDocument(snapshot(compared, { ...options, other_contacts: undefined }));
  check(unrolled.rows.some((r) => r.cells[0] === "Clients" && r.cells[1] === "Online store payouts"), true);
  const plain = reportDocument(snapshot(ytd));
  check(plain.columns, ["Section", "Contact", "Income", "% of income"]);
  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  // Exports without a layout keep the older contribution columns.
  check(
    reportDocument(snapshot(ytd, { report_id: "customer-income", show_zero: false, details: true })).columns[0],
    "Account / category",
  );

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "customer-income-compare.pdf"), pdf);
    await writeFile(join(dir, "customer-income-compare.csv"), csv);
    await writeFile(join(dir, "customer-income.pdf"), await reportPdf(plain));
    await writeFile(join(dir, "customer-income.csv"), documentCsv(plain));
    await writeFile(
      join(dir, "customer-income-summary.pdf"),
      await reportPdf(reportDocument(snapshot(busy, { ...options, details: false }))),
    );
    await writeFile(join(dir, "customer-income-long.pdf"), await reportPdf(reportDocument(snapshot(busy))));
  }
  console.log(
    `Income by customer presentation, roles, months and export layout: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
