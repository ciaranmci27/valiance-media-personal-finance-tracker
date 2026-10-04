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
  asOfDate,
  asOfPresetOf,
  balanceCompareOf,
  balanceFilter,
  balanceMonths,
  balanceSeriesFilters,
  balanceStatementRows,
  balanceTotals,
  compareDate,
  equityKind,
  equityLines,
  lifetimeOf,
  ownershipSentence,
  whatYouOwe,
  whatYouOwn,
} from "../src/lib/accounting/balance-sheet";
import {
  demoBalanceBreakdown,
  demoReportData,
  demoReportDetail,
} from "../src/lib/accounting/demo-reports";
import {
  reportFilterSchema,
  type DetailedReportSnapshot,
  type ReportData,
} from "../src/lib/accounting/reports";

/**
 * The balance sheet presentation rules (as-of dates and comparisons, what
 * is owned and owed, equity in plain lines, month-end series), the demo
 * fixture balancing on every date, and the export layout. Set
 * ACCOUNTING_REPORT_ARTIFACT_DIR to also write the PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;

  // Dates: presets from the books' today, comparisons from the as-of date.
  check(asOfDate("today", "2026-10-03"), "2026-10-03");
  check(asOfDate("month", "2026-10-03"), "2026-09-30");
  check(asOfDate("quarter", "2026-10-03"), "2026-09-30");
  check(asOfDate("quarter", "2026-08-15"), "2026-06-30");
  check(asOfDate("year", "2026-10-03"), "2025-12-31");
  check(asOfPresetOf("2025-12-31", "2026-10-03"), "year");
  check(asOfPresetOf("2026-05-05", "2026-10-03"), "custom");
  check(compareDate("month", "2026-10-03"), "2026-09-30");
  check(compareDate("month", "2026-09-30"), "2026-08-31");
  check(compareDate("year-end", "2026-10-03"), "2025-12-31");
  check(compareDate("year", "2024-02-29"), "2023-02-28");
  const filter = balanceFilter("2026-10-03", "working", "2025-12-31");
  // A balance reads from the start of the books, so debits and credits are lifetime.
  check(filter.from, "1900-01-01");
  check(filter.compare_from, "1900-01-01");
  check(balanceCompareOf(filter), "year-end");
  check(reportFilterSchema.safeParse(filter).success, true);

  // Equity accounts land on plain lines by purpose, subtype, then name.
  const kind = (name: string, purpose: string | null = null, subtype = "owner_equity") =>
    equityKind({ name, purpose, subtype }).kind;
  check(kind("Owner contributions", "contributions"), "in");
  check(kind("Shareholder distributions", "distributions"), "out");
  check(kind("Opening retained earnings", "opening_retained_earnings"), "kept");
  check(kind("Retained Earnings", null, "other"), "kept");
  check(kind("Owner Investment / Drawings"), "named");
  check(
    equityKind({ name: "Owner Investment / Drawings", purpose: null, subtype: "owner_equity" }).reason,
    "both",
  );
  check(equityKind({ name: "Owner's Equity", purpose: null, subtype: "owner_equity" }).reason, "ambiguous");
  check(kind("Owner's Equity"), "named");
  check(kind("Owner Drawings"), "out");
  check(kind("Capital contributions"), "in");
  check(kind("Opening balance equity", "opening_balance_equity", "opening_balance"), "named");

  // The demo books balance on every date, and the parts add up.
  for (const asOf of ["2024-03-31", "2024-12-31", "2025-06-30", "2026-02-28", "2026-10-03"]) {
    for (const mode of ["working", "posted"] as const) {
      const data = demoReportData(balanceFilter(asOf, mode, compareDate("year", asOf)));
      check(data.totals.difference_cents, "0", `${asOf} ${mode} balances`);
      check(data.comparison.difference_cents, "0", `${asOf} ${mode} comparison balances`);
      const { current } = balanceTotals(data);
      check(current.assets - current.liabilities, current.equity);
      const equity = equityLines(data);
      check(equity.total, current.equity, `${asOf} equity lines add up`);
      // The comparison date splits from its own lifetime read, and still adds up.
      const then = demoReportData(balanceFilter(compareDate("year", asOf), mode));
      const compared = equityLines(data, true, lifetimeOf(then));
      check(compared.total, balanceTotals(data).previous!.equity, `${asOf} compared equity lines add up`);
      check(
        compared.lines.some((l) => l.label === "Owner Investment / Drawings"),
        false,
        `${asOf} the mixed account never stands alone once it has history`,
      );
      // Without lifetime history the mixed account keeps its name; the sum holds.
      check(equityLines(data, true).total, balanceTotals(data).previous!.equity);
    }
  }
  const data = demoReportData(filter);
  const { current, previous } = balanceTotals(data);
  check(previous !== null, true);
  // Cash position: bank and cash less what the card owes.
  const named = (name: string) => data.accounts.find((a) => a.name === name)!;
  check(
    current.cash,
    big(named("Operating checking").ending_cents) +
      big(named("Reserve savings").ending_cents) +
      big(named("Business card").ending_cents),
  );
  check(current.cash < current.assets, true);

  const lines = equityLines(data).lines;
  check(lines.map((l) => l.kind), ["in", "out", "kept", "year", "named"]);
  check(lines.find((l) => l.kind === "named")?.label, "Owner's Equity");
  // The mixed owner account split: its credits join money put in, its debits money taken out.
  const contributions = -big(named("Owner contributions").ending_cents),
    distributions = -big(named("Owner distributions").ending_cents);
  check(lines.find((l) => l.kind === "in")?.amount, contributions + big(150000 + 1200000 + 600000));
  check(lines.find((l) => l.kind === "out")?.amount, distributions - big(450000 + 900000 + 350000));
  const mixed = named("Owner Investment / Drawings");
  check(
    lines.find((l) => l.kind === "in")!.amount + lines.find((l) => l.kind === "out")!.amount,
    contributions + distributions - big(mixed.ending_cents),
  );
  check(lines.find((l) => l.kind === "in")?.filter?.account_ids?.includes(mixed.id), true);
  check(lines.find((l) => l.kind === "out")?.filter?.account_ids?.includes(mixed.id), true);
  // A report that does not start at the books' start never splits on partial history.
  const yearOnly = demoReportData({ ...filter, from: "2026-01-01" });
  check(lifetimeOf(yearOnly).has(mixed.id), false);
  check(
    equityLines(yearOnly).lines.some((l) => l.label === "Owner Investment / Drawings"),
    true,
  );
  check(equityLines(yearOnly).total, current.equity);
  check(lines.find((l) => l.kind === "out")!.amount < big(0), true);
  check(lines.find((l) => l.kind === "year")?.amount, big(data.totals.year_cents));
  check(
    lines.find((l) => l.kind === "kept")?.amount,
    -big(named("Opening retained earnings").ending_cents) + big(data.totals.prior_cents),
  );
  check(/^Of everything the business owns, \d+% is owed to others and \d+% is yours\.$/.test(ownershipSentence(current)), true);
  check(
    ownershipSentence({ assets: big(100), liabilities: big(150), equity: big(-50), cash: big(0) }).startsWith("The business owes more than it owns"),
    true,
  );

  // What you own and owe: ranked, shared of the totals, the negative kept with a hint.
  const own = whatYouOwn(data);
  check(own[0].label, "Operating checking");
  check(own[0].tag, "Bank");
  check(own.reduce((s, r) => s + r.amount, big(0)), current.assets);
  const owe = whatYouOwe(data);
  const advance = owe.find((r) => r.label === "Net salary payable")!;
  check(advance.amount < big(0), true);
  check(advance.hint, "Paid more than was owed: the business is owed this back");
  check(
    own.find((r) => r.label === "Accumulated depreciation")?.hint,
    "Equipment wear to date, subtracted from what you own",
  );
  check(owe.at(-1)?.label, "Net salary payable", "Negative balances sort last");
  check(owe.reduce((s, r) => s + r.amount, big(0)), current.liabilities);
  check(owe.every((r) => reportFilterSchema.safeParse(r.filter).success), true);
  const detail = await demoReportDetail(reportFilterSchema.parse(own[0].filter));
  check(detail.total_cents, named("Operating checking").ending_cents);

  // Month-end balances: twelve months ending at the as-of date.
  const series = balanceSeriesFilters("2026-10-03", "working", data.accounts);
  // Accumulated depreciation is read apart and subtracted, never added.
  check(series.contraAssets?.account_ids, [named("Accumulated depreciation").id]);
  check(series.assets?.account_ids?.includes(named("Accumulated depreciation").id), false);
  const months = balanceMonths("2026-10-03", {
    assets: demoBalanceBreakdown(series.assets!),
    contraAssets: demoBalanceBreakdown(series.contraAssets!),
    liabilities: demoBalanceBreakdown(series.liabilities!),
    cash: demoBalanceBreakdown(series.cash!),
    cards: demoBalanceBreakdown(series.cards!),
  });
  check(months.length, 12);
  check(months[0].month, "2025-11-01");
  check(months.at(-1)?.at, "2026-10-03");
  check(months.at(-1)?.assets, current.assets);
  check(months.at(-1)?.equity, current.equity);
  check(months.at(-1)?.cash, current.cash);
  check(months[1].at, "2025-12-31");
  check(months[1].assets, previous!.assets);

  // The statement: sections and sides for change colors.
  const model = buildReportModel("balance-sheet", data);
  const rows = balanceStatementRows(model);
  check(rows.find((r) => r.label === "Business card")?.side, "expense");
  check(rows.find((r) => r.label === "Total assets")?.section, "Assets");
  check(rows.find((r) => r.label === "Total liabilities & equity")?.section, "Liabilities & equity");

  // Exports: layout 2 is a flat sheet with % of total assets.
  const snapshot = (report: ReportData, layout?: 2, details = true): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000b001",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: {
      type: "detailed_report",
      export_definition: 1,
      data: report,
      options: { report_id: "balance-sheet", show_zero: false, details, ...(layout ? { layout } : {}) },
    },
  });
  const legacy = reportDocument(snapshot(data));
  check(legacy.columns[0], "Account / category");
  const branded = reportDocument(snapshot(data, 2));
  check(branded.columns, ["Section", "Account", "Balance", "% of total assets", "Comparison", "Change"]);
  check(branded.metadata[0], ["As of", "2026-10-03"]);
  const csv = documentCsv(branded);
  check(
    csv.includes(`"Assets","Total assets",${(Number(data.totals.assets_cents) / 100).toFixed(2)},100.00,`),
    true,
  );
  check(csv.includes("$"), false);
  check(branded.statement?.panels[0]?.lines.length, lines.length);
  check(branded.statement?.tiles.map((t) => t.label), ["Assets", "Liabilities", "Equity", "Cash position"]);
  const plain = demoReportData(balanceFilter("2026-10-03", "working"));
  check(reportDocument(snapshot(plain, 2)).columns.length, 4);
  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "balance-sheet-compare.pdf"), pdf);
    await writeFile(join(dir, "balance-sheet-compare.csv"), csv);
    const solo = reportDocument(snapshot(plain, 2));
    await writeFile(join(dir, "balance-sheet.pdf"), await reportPdf(solo));
    await writeFile(join(dir, "balance-sheet.csv"), documentCsv(solo));
    await writeFile(
      join(dir, "balance-sheet-summary.pdf"),
      await reportPdf(reportDocument(snapshot(plain, 2, false))),
    );
    await writeFile(join(dir, "balance-sheet-legacy.pdf"), await reportPdf(legacy));
    const many: ReportData = {
      ...data,
      accounts: [
        ...data.accounts,
        ...Array.from({ length: 60 }, (_, i) => ({
          ...named("Equipment"),
          id: `f0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          code: `15${String(i).padStart(2, "0")}`,
          name: `Synthetic asset account ${i + 1} with a longer descriptive name`,
          parent_account_id: "f0000000-0000-4000-8000-999999999999",
          parent_name: `Asset group ${Math.floor(i / 12) + 1}`,
          ending_cents: String(5000 + i * 113),
          compare_ending_cents: String(4000 + i * 97),
        })),
      ],
    };
    await writeFile(
      join(dir, "balance-sheet-long.pdf"),
      await reportPdf(reportDocument(snapshot(many, 2))),
    );
  }
  console.log(
    `Balance sheet presentation, demo fixture and export layout: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
