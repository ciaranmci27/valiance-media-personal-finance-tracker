import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  PRIOR_PROFIT,
  byType,
  sideLabel,
  trialBalanceOf,
  trialChecks,
  trialLines,
  trialScope,
  trialTotals,
} from "../src/lib/accounting/trial-balance";
import {
  asOfDate,
  asOfPresetOf,
  balanceCompareLabel,
  balanceCompareOf,
  balanceFilter,
  balanceTotals,
  compareDate,
} from "../src/lib/accounting/balance-sheet";
import { presetOf, presetRange } from "../src/lib/accounting/profit-loss";
import { demoReportData, demoReportDetail } from "../src/lib/accounting/demo-reports";
import { fiscalPriorEnd, fiscalYearStart, normalizeMonth } from "../src/lib/accounting/fiscal-year";
import { buildReportModel } from "../src/lib/accounting/report-model";
import {
  reportFilterSchema,
  reportOptionsSchema,
  type DetailedReportSnapshot,
  type ReportAccount,
  type ReportData,
} from "../src/lib/accounting/reports";

/**
 * The trial balance: every account's balance through a date in a debit or
 * credit column (income and expenses this year to date, earlier years'
 * profit on its own line), debits equal to credits on every date, the type
 * totals, the checks an accountant would ask about, the drill-downs, and the
 * export layout. Set ACCOUNTING_REPORT_ARTIFACT_DIR to also write the PDFs
 * and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);

  // Balanced on every date, both modes, and in agreement with the balance sheet.
  for (const asOf of ["2024-03-31", "2024-12-31", "2025-06-30", "2025-12-31", "2026-02-28", "2026-10-03"]) {
    for (const mode of ["working", "posted"] as const) {
      const label = `${asOf} ${mode}`;
      const data = demoReportData(balanceFilter(asOf, mode, compareDate("year-end", asOf)));
      const lines = trialLines(data);
      const t = trialTotals(lines);
      check(t.difference, ZERO, `${label} debits equal credits`);
      check(t.compareDebits, t.compareCredits, `${label} comparison balances too`);
      check(lines.every((l) => (l.debit === ZERO) !== (l.credit === ZERO) || l.balance === ZERO), true);
      const types = byType(lines);
      check(types.reduce((s, x) => s + x.debit, ZERO), t.debits);
      check(types.reduce((s, x) => s + x.credit, ZERO), t.credits);
      // Assets less liabilities is equity plus this year's profit, as on the balance sheet.
      const net = (type: string) => lines.filter((l) => l.type === type).reduce((s, l) => s + l.balance, ZERO);
      const bs = balanceTotals(data).current;
      check(net("asset"), bs.assets, `${label} assets match`);
      check(-net("liability"), bs.liabilities, `${label} liabilities match`);
      check(-net("equity") - net("income") - net("expense"), bs.equity, `${label} equity and profit match`);
      check(
        lines.every((l) => !l.account || reportFilterSchema.safeParse(trialScope(data, l)).success),
        true,
      );
    }
  }

  // The rules on one date.
  const data = demoReportData(balanceFilter("2026-10-03", "working", "2025-12-31"));
  const lines = trialLines(data);
  const named = (name: string) => lines.find((l) => l.name === name)!;
  // Income and expenses are this year to date; balance sheet accounts are through the date.
  const software = data.accounts.find((a) => a.name === "Software")!;
  check(named("Software").balance, big(software.year_cents));
  check(named("Operating checking").balance, big(data.accounts.find((a) => a.name === "Operating checking")!.ending_cents));
  check(trialBalanceOf(software, true), big(software.compare_year_cents));
  // Earlier years' profit is its own credit line under equity.
  const prior = lines.find((l) => l.id === PRIOR_PROFIT)!;
  check(prior.type, "equity");
  check(prior.credit, big(data.totals.prior_cents));
  check(prior.account, null);
  check(trialScope(data, prior), undefined);
  // Contra and owner accounts sit where they belong.
  check(named("Accumulated depreciation").credit > ZERO, true);
  check(named("Owner distributions").debit > ZERO, true);
  // Sorted by type, then account number.
  const order = ["asset", "liability", "equity", "income", "expense"];
  check(lines.every((l, i) => i === 0 || order.indexOf(lines[i - 1].type) <= order.indexOf(l.type)), true);
  check(lines.filter((l) => l.type === "asset").map((l) => l.code), ["1000", "1010", "1500", "1590"]);
  // Drill-downs: an income or expense account opens this year; others from the start of the books.
  check(trialScope(data, named("Software"))?.from, "2026-01-01");
  check(trialScope(data, named("Operating checking"))?.from, "1900-01-01");
  const detail = await demoReportDetail(reportFilterSchema.parse(trialScope(data, named("Software"))));
  check(big(detail.total_cents), named("Software").balance);
  const cash = await demoReportDetail(reportFilterSchema.parse(trialScope(data, named("Operating checking"))));
  check(big(cash.total_cents), named("Operating checking").balance);
  // A fiscal year that starts in July: the drill opens the fiscal year, not January.
  check(fiscalYearStart("2026-10-03", 7), "2026-07-01");
  check(fiscalYearStart("2026-03-15", 7), "2025-07-01");
  check(fiscalYearStart("2026-07-01", 7), "2026-07-01");
  check(fiscalYearStart("2026-10-03", 1), "2026-01-01");
  check(fiscalYearStart("2026-10-03", undefined), "2026-01-01");
  check(fiscalPriorEnd("2026-03-15", 7), "2025-06-30");
  check(fiscalPriorEnd("2026-10-03", 1), "2025-12-31");
  check(normalizeMonth(13), 1);
  check(normalizeMonth(null), 1);
  check(trialScope(data, named("Software"), 7)?.from, "2026-07-01");
  check(trialScope(data, named("Operating checking"), 7)?.from, "1900-01-01");
  check(trialScope(demoReportData(balanceFilter("2026-02-28", "working")), named("Software"), 4)?.from, "2025-04-01");
  // The year presets and comparisons follow the fiscal year too.
  check(presetRange("year", "2026-10-03", 7), { from: "2026-07-01", to: "2026-10-03" });
  check(presetRange("last-year", "2026-10-03", 7), { from: "2025-07-01", to: "2026-06-30" });
  check(presetRange("last-year", "2026-03-15", 7), { from: "2024-07-01", to: "2025-06-30" });
  check(presetRange("year", "2026-10-03"), { from: "2026-01-01", to: "2026-10-03" });
  check(presetOf("2026-07-01", "2026-10-03", "2026-10-03", 7), "year");
  check(presetOf("2026-01-01", "2026-10-03", "2026-10-03", 7), "custom");
  check(asOfDate("year", "2026-10-03", 7), "2026-06-30");
  check(asOfDate("year", "2026-10-03"), "2025-12-31");
  check(asOfPresetOf("2026-06-30", "2026-10-03", 7), "year");
  check(compareDate("year-end", "2026-10-03", 7), "2026-06-30");
  check(balanceCompareOf({ to: "2026-10-03", compare_to: "2026-06-30" }, 7), "year-end");
  check(balanceCompareOf({ to: "2026-10-03", compare_to: "2026-06-30" }), "custom");
  check(balanceCompareLabel({ to: "2026-10-03", compare_to: "2026-06-30" }, 7)?.long, "Jun 30, 2026 (end of the previous fiscal year)");
  // The balance sheet's current-year and prior-year profit lines follow it too.
  const april = buildReportModel("balance-sheet", data, false, undefined, 4);
  const rowOf = (m: typeof april, label: string) => m.rows.find((r) => r.label === label)!;
  check(rowOf(april, "Current-year profit").detail?.[0]?.from, "2026-04-01");
  check(rowOf(april, "Profit from prior years").detail?.[0]?.to, "2026-03-31");
  check(rowOf(april, "Current-year profit").detail?.[1]?.from, "2025-04-01", "the comparison date's fiscal year");
  check(rowOf(buildReportModel("balance-sheet", data), "Current-year profit").detail?.[0]?.from, "2026-01-01");
  check(sideLabel(big(12345)), "$123.45 Dr");
  check(sideLabel(big(-12345)), "$123.45 Cr");
  check(sideLabel(ZERO), "$0.00");

  // What an accountant would ask about.
  const found = trialChecks(data, lines);
  check(found.some((c) => c.title === "Net salary payable has a debit balance of $250.00"), true);
  check(found.some((c) => c.title === "Uncategorized expense holds $187.50"), true);
  check(found.some((c) => c.key === "drafts"), true);
  check(found.some((c) => c.title.includes("Owner distributions")), false, "a draw account in debit is normal");
  check(found.some((c) => c.title.includes("Accumulated depreciation")), false, "a contra account is on its usual side");
  check(trialChecks(demoReportData(balanceFilter("2026-10-03", "posted")), trialLines(demoReportData(balanceFilter("2026-10-03", "posted")))).some((c) => c.key === "drafts"), false);
  // Synthetic accounts for the other checks.
  const like = (name: string, patch: Partial<ReportAccount>) => ({ ...data.accounts.find((a) => a.name === name)!, ...patch });
  const odd: ReportData = {
    ...data,
    accounts: [
      like("Operating checking", { id: "a0000000-0000-4000-8000-000000000001", name: "Overdrawn checking", ending_cents: "-5000" }),
      like("Business card", { id: "a0000000-0000-4000-8000-000000000002", name: "Refunded card", ending_cents: "2500" }),
      like("Software", { id: "a0000000-0000-4000-8000-000000000003", name: "Refunded software", year_cents: "-1000" }),
      like("Owner's Equity", { id: "a0000000-0000-4000-8000-000000000004", name: "Opening balance equity", subtype: "opening_balance", purpose: "opening_balance_equity", ending_cents: "-7000" }),
      like("Transfers in transit", { id: "a0000000-0000-4000-8000-000000000005", ending_cents: "500000" }),
    ],
    totals: { ...data.totals, prior_cents: "0" },
  };
  const oddChecks = trialChecks(odd, trialLines(odd));
  check(oddChecks.find((c) => c.title.startsWith("Debits and credits differ"))?.tone, "look");
  check(oddChecks.find((c) => c.title.startsWith("Overdrawn checking"))?.detail.startsWith("A bank or cash account in credit"), true);
  check(oddChecks.find((c) => c.title.startsWith("Refunded card"))?.detail.startsWith("A card with a debit balance"), true);
  check(oddChecks.find((c) => c.title.startsWith("Refunded software"))?.detail.startsWith("An expense with a credit balance"), true);
  check(oddChecks.find((c) => c.title.startsWith("Opening balance equity"))?.tone, "info");
  check(oddChecks.find((c) => c.title === "$5,000.00 is between your own accounts")?.tone, "info");
  check(oddChecks.some((c) => /wrong|error|fraud/i.test(c.title)), false, "checks state what the books show");

  // Exports: the accountant's sheet.
  const options = { report_id: "trial-balance" as const, show_zero: false, details: true, layout: 2 as const };
  const snapshot = (report: ReportData, opts: Record<string, unknown> = options): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000b7b1",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "detailed_report", export_definition: 1, data: report, options: reportOptionsSchema.parse(opts) },
  });
  const branded = reportDocument(snapshot(data));
  check(branded.title, "Trial balance");
  check(branded.metadata[0], ["As of", "2026-10-03"]);
  check(branded.columns, ["Account number", "Account", "Type", "Debit", "Credit", "Comparison debit", "Comparison credit", "Change"]);
  const csv = documentCsv(branded);
  check(csv.includes("$"), false);
  check(csv.includes(`"1000","Operating checking","Asset",${(Number(named("Operating checking").balance) / 100).toFixed(2)},"",`), true);
  check(csv.includes(`"","Profit from earlier years","Equity","",${(Number(prior.credit) / 100).toFixed(2)},`), true);
  const t = trialTotals(lines);
  check(csv.includes(`"","Total","",${(Number(t.debits) / 100).toFixed(2)},${(Number(t.credits) / 100).toFixed(2)},`), true);
  check(csv.includes("Opening and closing balances use"), false);
  check(branded.statement?.tiles.map((x) => x.label), ["Total debits", "Total credits", "Difference", "Accounts with a balance"]);
  check(branded.statement?.tiles[2].value, "Balanced");
  check(branded.statement?.checks?.items.length, found.length);
  check(branded.statement?.rows.at(-1)?.label, "Total");
  const plain = reportDocument(snapshot(demoReportData(balanceFilter("2026-10-03", "posted"))));
  check(plain.columns, ["Account number", "Account", "Type", "Debit", "Credit"]);
  const summary = reportDocument(snapshot(data, { ...options, details: false }));
  check(summary.statement?.rows.some((r) => r.kind === "account"), false);
  check(summary.rows.length, branded.rows.length, "the CSV always lists every account");
  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  check(reportDocument(snapshot(data, { report_id: "trial-balance", show_zero: false, details: true })).columns[0], "Account / category");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trial-balance-compare.pdf"), pdf);
    await writeFile(join(dir, "trial-balance-compare.csv"), csv);
    await writeFile(join(dir, "trial-balance.pdf"), await reportPdf(plain));
    await writeFile(join(dir, "trial-balance.csv"), documentCsv(plain));
    await writeFile(join(dir, "trial-balance-summary.pdf"), await reportPdf(summary));
  }
  console.log(`Trial balance presentation, checks and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
