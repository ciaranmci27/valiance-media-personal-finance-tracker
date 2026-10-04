import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentCsv } from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  ASSET_NOTES,
  assetHistory,
  assetLines,
  assetScope,
  assetTies,
  assetTotals,
  assetYears,
  priorScope,
} from "../src/lib/accounting/fixed-assets";
import {
  DEMO_SUPPORT_REPORTS,
  demoRegisters,
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
 * Fixed assets: years and as-of dates, each asset's cost, depreciation and
 * book value, this year's depreciation from the prior year end, the ties to
 * the fixed asset and accumulated depreciation accounts (agreeing with the
 * balance sheet), depreciation by year from posted figures only, the demo
 * books, and the export layout. Set ACCOUNTING_REPORT_ARTIFACT_DIR to also
 * write the PDFs and CSVs.
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
    demoSupportReport({ report_id: "asset-register", from: scope.from, to: scope.to, offset: 0 });

  // As of today in the current year, else the year's end; the prior year end beside it.
  check(assetYears(today), [2026, 2025, 2024, 2023]);
  check(assetScope(2026, today), { report_id: "asset-register", from: "2026-01-01", to: today, offset: 0 });
  check(assetScope(2025, today).to, "2025-12-31");
  check(priorScope(assetScope(2026, today)), { report_id: "asset-register", from: "2025-12-31", to: "2025-12-31", offset: 0 });
  check(supportReportFilterSchema.safeParse(priorScope(assetScope(2026, today))).success, true);

  // The demo register: the laptop and the camera kit.
  const scope = assetScope(2026, today);
  const data = register(scope);
  const prior = register(priorScope(scope));
  const registers = demoRegisters(scope.to);
  const lines = assetLines(data, prior, registers);
  const named = (name: string) => lines.find((l) => l.name === name)!;
  check(lines.map((l) => l.name), ["Laptop", "Studio camera kit"]);
  const laptop = named("Laptop");
  check([laptop.cost, laptop.inService, laptop.method.startsWith("Straight line")], [big(320000), "2025-06-12", true]);
  // The laptop: 15 months of $88.89 through September 2026, 9 of them this year.
  check(laptop.accumulated, big(8889) * big(15));
  check(laptop.thisYear, big(8889) * big(9));
  check(laptop.book, laptop.cost - laptop.accumulated);
  check(laptop.used, Number((laptop.accumulated * big(1000)) / laptop.cost) / 10);
  // The camera kit: bought this year, so all its depreciation is this year's.
  const camera = named("Studio camera kit");
  check(camera.thisYear, camera.accumulated);
  check(camera.accumulated, big(6667) * big(7));
  const t = assetTotals(lines, data);
  check([t.count, t.cost, t.accumulated, t.book], [2, big(560000), laptop.accumulated + camera.accumulated, laptop.book + camera.book]);
  check(t.thisYear, (laptop.thisYear ?? ZERO) + (camera.thisYear ?? ZERO));
  check(assetTotals(assetLines(data, null, null), data).thisYear, null, "without the prior year end, this year is unknown");
  // Without the registers list, the register's own columns still read.
  check(assetLines(data, prior, null).map((l) => [l.cost, l.inService]), [[big(320000), null], [big(240000), null]]);

  // The ties: the monitor arm sits in Equipment outside the register; the
  // accumulated depreciation ties. Both agree with the balance sheet.
  const ties = assetTies(data);
  const equipment = ties.find((x) => x.account === "Equipment")!;
  check(equipment.tone, "look");
  check(equipment.books - equipment.register, big(38000));
  check(equipment.title, "Equipment holds $380.00 more than the register");
  const accumulated = ties.find((x) => x.account === "Accumulated depreciation")!;
  check(accumulated.tone, "good");
  check(accumulated.books, t.accumulated, "read on its usual side, as a positive amount");
  const bs = demoReportData({ from: "1900-01-01", to: today, mode: "posted", offset: 0 });
  check(big(bs.accounts.find((a) => a.name === "Equipment")!.ending_cents), equipment.books);
  check(-big(bs.accounts.find((a) => a.name === "Accumulated depreciation")!.ending_cents), accumulated.books);
  // Before the monitor arm, the register ties everywhere.
  check(assetTies(register(assetScope(2026, "2026-07-31"))).every((x) => x.tone === "good"), true);
  // A register entry missing from the books reads as short, not as extra.
  const short: SupportReportData = {
    ...data,
    controls: { ...data.controls!, rows: [{ ...data.controls!.rows[1], book_cents: "500000", register_cents: "560000", difference_cents: "-60000" }] },
  };
  check(assetTies(short)[0].title.includes("is short $600.00"), true);

  // Depreciation by year, from each year end: posted figures only.
  const history = assetHistory([
    { year: 2025, data: register({ from: "2025-12-31", to: "2025-12-31" }) },
    { year: 2026, data },
  ]);
  check(history.map((h) => h.year), [2025, 2026]);
  check(history[0].depreciation, big(8889) * big(6));
  check(history[1].depreciation, t.thisYear);
  check(history[1].book, t.book);
  check(assetHistory([{ year: 2024, data: register({ from: "2024-12-31", to: "2024-12-31" }) }]), [], "no assets, no years");
  // An asset that left the books does not count as negative depreciation.
  const gone: SupportReportData = { ...data, rows: data.rows.map((r) => (r.cells[0] === "Laptop" ? { ...r, cells: [r.cells[0], r.cells[1], "0", "0", "0"] } : r)) };
  const goneLines = assetLines(gone, prior, null);
  check(goneLines.find((l) => l.name === "Laptop")?.disposed, true);
  check(goneLines.find((l) => l.name === "Laptop")?.thisYear, null);
  check(goneLines.at(-1)?.name, "Laptop", "sold assets list last");
  check(assetHistory([{ year: 2025, data: prior }, { year: 2026, data: gone }])[1].depreciation, camera.accumulated);
  check(DEMO_SUPPORT_REPORTS.includes("asset-register"), true);
  check(ASSET_NOTES.some((n) => /project/i.test(n) && /no future schedule/i.test(n)), true);

  // Exports.
  const snapshot = (report: SupportReportData): SupportReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000f9a1",
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "support_report", export_definition: 1, data: report },
  });
  check(SUPPORT_LAYOUT_2.includes("asset-register"), true);
  const doc = supportStatementDocument(snapshot(data));
  check(doc.title, "Fixed assets");
  check(doc.metadata[0], ["As of", today]);
  check(doc.columns, ["Asset", "Acquired", "Cost", "Accumulated depreciation", "Book value", "Used up"]);
  const csv = documentCsv(doc);
  check(csv.includes("$"), false);
  check(csv.includes(`"Laptop","2025-06-12",3200.00,1333.35,1866.65,"41.6%"`), true);
  check(csv.includes(`"Total","",5600.00,`), true);
  check(csv.includes(`"Equipment: books 5980.00, register 5600.00, difference 380.00."`), true);
  check(csv.includes(`"Accumulated depreciation: books 1800.04, register 1800.04, tied."`), true);
  const st = doc.statement!;
  check(st.periodLabel, "As of Oct 3, 2026");
  check(st.tiles.map((x) => [x.label, x.value]), [
    ["Cost", "$5,600.00"],
    ["Depreciated to date", "$1,800.04"],
    ["Book value", "$3,799.96"],
    ["Ties to the books", "1 off"],
  ]);
  check(st.checks?.items.map((x) => x.title), ["Equipment holds $380.00 more than the register"]);
  check(st.rows.filter((r) => r.kind === "account").length, 2);
  const pdf = await reportPdf(doc);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  check(supportReportDocument(snapshot(data)).columns[0], "Asset", "older downloads keep the original table");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fixed-assets.pdf"), pdf);
    await writeFile(join(dir, "fixed-assets.csv"), csv);
    const tied = supportStatementDocument(snapshot(register({ from: "2025-12-31", to: "2025-12-31" })));
    await writeFile(join(dir, "fixed-assets-2025.pdf"), await reportPdf(tied));
    await writeFile(join(dir, "fixed-assets-2025.csv"), documentCsv(tied));
  }
  console.log(`Fixed assets lines, this year's depreciation, ties, history, demo books and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
