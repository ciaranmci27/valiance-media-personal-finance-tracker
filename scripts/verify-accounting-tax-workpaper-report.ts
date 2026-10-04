import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentCsv } from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  TAX_NOTES,
  classificationPhrase,
  taxAdjustments,
  taxBridge,
  taxGroups,
  taxLines,
  taxReadiness,
  taxScope,
  taxSentence,
  taxSeparately,
  taxSourceOf,
  taxTotals,
  taxYears,
} from "../src/lib/accounting/tax-workpaper-report";
import {
  DEMO_SUPPORT_REPORTS,
  demoReportData,
  demoSupportReport,
  demoTaxSource,
} from "../src/lib/accounting/demo-reports";
import { SUPPORT_LAYOUT_2, supportStatementDocument } from "../src/lib/accounting/support-report-document";
import {
  supportReportDocument,
  supportReportFilterSchema,
  type SupportReportData,
  type SupportReportSnapshot,
} from "../src/lib/accounting/support-reports";
import type { TaxSource } from "../src/lib/accounting/tax-workpapers";

/**
 * The tax workpapers report: the tax years and scope, each account's book
 * and tax amounts by treatment, the bridge from book profit to the books'
 * ordinary income (always ending on the books' figure), what is not ready,
 * the demo books, and the export layout (a CSV for a preparer and the
 * branded PDF). Set ACCOUNTING_REPORT_ARTIFACT_DIR to also write the PDFs
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
  const report = (to: string) =>
    demoSupportReport({ report_id: "tax-workpapers", from: `${to.slice(0, 4)}-01-01`, to, offset: 0 });

  // Calendar tax years, this one and three before; the scope runs to today.
  check(taxYears("2026-10-03"), [2026, 2025, 2024, 2023]);
  check(taxScope(2026, "2026-10-03"), { report_id: "tax-workpapers", from: "2026-01-01", to: "2026-10-03", offset: 0 });
  check(taxScope(2025, "2026-10-03").to, "2025-12-31");
  check(supportReportFilterSchema.safeParse(taxScope(2026, "2026-10-03")).success, true);

  // The demo books, as accounting.tax_source builds them.
  for (const to of ["2026-10-03", "2026-06-30", "2025-12-31", "2024-12-31"]) {
    const data = report(to);
    const source = taxSourceOf(data)!;
    check(!!source, true);
    check(data.count, data.rows.length);
    const lines = taxLines(source);
    // Book profit is the profit and loss's, reviewed only.
    const pl = demoReportData({ from: `${to.slice(0, 4)}-01-01`, to, mode: "posted", offset: 0 });
    check(big(source.book_profit_cents), big(pl.totals.net_cents), `${to} book profit is the P&L's`);
    check(lines.reduce((s, l) => s + l.book, ZERO), big(source.book_profit_cents), `${to} lines add up to book profit`);
    check(lines.reduce((s, l) => s + l.tax, ZERO), big(source.mapped_ordinary_cents), `${to} lines add up to the treated figure`);
    check(lines.every((l) => l.adjustment === l.tax - l.book), true);
    // The bridge always lands on the books' ordinary income.
    const bridge = taxBridge(source);
    check(bridge.start + bridge.lines.reduce((s, l) => s + l.amount, ZERO), bridge.end, `${to} the bridge adds up`);
    check(bridge.end, big(source.adjusted_ordinary_cents));
    check(bridge.lines.some((l) => l.key === "other"), false, `${to} every difference is explained`);
    // Groups hold every account once, untreated last.
    const groups = taxGroups(lines);
    check(groups.reduce((n, g) => n + g.lines.length, 0), lines.length);
    if (groups.some((g) => g.key === "none")) check(groups.at(-1)?.key, "none");
    // The support rows the books return carry the same totals.
    check(data.total_cells.slice(2), [source.book_profit_cents, source.adjusted_ordinary_cents, source.book_to_tax_cents]);
  }

  // 2026 so far: two accounts without a treatment, an adjustment without its
  // document, transactions awaiting review and months not closed.
  const ytd = taxSourceOf(report("2026-10-03"))!;
  const lines = taxLines(ytd);
  const named = (name: string) => lines.find((l) => l.name === name)!;
  check(named("Meals").percent, 50);
  // Half of each line, rounded line by line as the books do.
  const halfGap = named("Meals").tax * big(2) - named("Meals").book;
  check(halfGap >= big(-100) && halfGap <= big(100), true, "meals count at half");
  check(named("Interest income").separately, true);
  check(named("Interest income").tax, ZERO);
  check(named("Education").treatment, null);
  check(named("Education").tax, ZERO, "an untreated account is left out");
  check(named("Consulting revenue").tax, named("Consulting revenue").book);
  const readiness = taxReadiness(ytd);
  check(readiness.map((c) => c.key), [
    `untreated-${named("Education").id}`,
    `untreated-${named("Uncategorized expense").id}`,
    "drafts",
    readiness[3].key,
    "months",
  ]);
  check(readiness[3].title, 'Attach a document to "State late-filing penalty added back"');
  check(readiness.filter((c) => c.tone === "look").length, 4);
  check(readiness.find((c) => c.key === "months")?.tone, "info");
  check(readiness.map((c) => c.fix), ["accounts", "accounts", "review", "adjustments", null]);
  const t = taxTotals(ytd, readiness);
  check([t.notReady, t.untreated], [4, 2]);
  check(t.difference, t.taxable - t.book);
  const bridge = taxBridge(ytd);
  check(bridge.lines.map((l) => l.key).slice(0, 3), ["untreated", "meals", "separate"]);
  check(bridge.lines.find((l) => l.key === "untreated")?.amount, -(named("Education").book + named("Uncategorized expense").book));
  check(bridge.lines.find((l) => l.key === "untreated")?.accounts.length, 2);
  check(bridge.lines.filter((l) => l.key.startsWith("adj-")).map((l) => l.label), [
    "State late-filing penalty added back",
    "Tax depreciation above book on the laptop",
  ]);
  // The charitable gift is stated separately, not in the ordinary figure.
  check(taxAdjustments(ytd).find((a) => a.concept === "charity")?.ordinary, false);
  check(taxSeparately(ytd).map((s) => [s.label, s.amount]), [
    ["Interest, separately stated", named("Interest income").book],
    ["Charitable contributions", big(50000)],
  ]);
  check(classificationPhrase(ytd), "an S corporation");
  check(taxSentence(ytd, t, true).startsWith(`The books show ${"$"}`), true);
  check(taxSentence(ytd, t, true).endsWith("4 things need you before the workpapers are complete."), true);
  // The sentence and the checks never claim a tax result.
  check(
    [taxSentence(ytd, t, true), ...readiness.map((c) => `${c.title} ${c.detail}`), ...TAX_NOTES].some((s) =>
      /you owe|refund due|tax due|will pay|liability is/i.test(s),
    ),
    false,
  );
  // 2025: everything treated and supported, every month closed.
  const last = taxSourceOf(report("2025-12-31"))!;
  check(taxReadiness(last).filter((c) => c.tone === "look"), []);
  check(taxSentence(last, taxTotals(last, taxReadiness(last)), false).endsWith("Nothing is missing."), true);
  // A year with no classification asks for it; a missing document is counted.
  const bare: TaxSource = { ...ytd, year_settings: null, unavailable_adjustments: 2, drafts: 0 };
  check(taxReadiness(bare).some((c) => c.key === "classification" && c.fix === "settings"), true);
  check(taxReadiness(bare).find((c) => c.key === "unavailable")?.title, "2 adjustments point at a missing document");
  check(classificationPhrase(bare), null);
  // A difference the lines cannot explain still shows, so the bridge ends on the books' figure.
  const odd: TaxSource = { ...last, adjusted_ordinary_cents: (big(last.adjusted_ordinary_cents) + big(7)).toString() };
  check(taxBridge(odd).lines.at(-1)?.key, "other");
  check(taxBridge(odd).lines.at(-1)?.amount, big(7));
  check(DEMO_SUPPORT_REPORTS.includes("tax-workpapers"), true);
  check(demoTaxSource(2026, "2026-10-03").fingerprint, ytd.fingerprint);

  // Exports: a CSV for the preparer and the branded PDF.
  const snapshot = (data: SupportReportData): SupportReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000d7a1",
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "support_report", export_definition: 1, data },
  });
  check(SUPPORT_LAYOUT_2.includes("tax-workpapers"), true);
  const doc = supportStatementDocument(snapshot(report("2026-10-03")));
  check(doc.title, "Tax workpapers");
  check(doc.columns, ["Treatment", "Account number", "Account or adjustment", "Book amount", "Adjustment", "Tax amount", "Counted", "Note"]);
  check(doc.metadata.find(([k]) => k === "Taxed as")?.[1], "an S corporation");
  const csv = documentCsv(doc);
  check(csv.includes("$"), false);
  const money = (v: bigint) => (Number(v) / 100).toFixed(2);
  const meals = named("Meals");
  check(csv.includes(`"Meals, 50% deductible","5610","Meals",${money(meals.book)},${money(meals.adjustment)},${money(meals.tax)},"50%",""`), true);
  check(csv.includes(`"No tax treatment yet","6600","Education",`), true);
  check(csv.includes(`"Adjustment: State late-filing penalty added back",0.00,150.00,150.00,"","2026-03-20, no document attached"`), true);
  check(csv.includes(`"Charitable contributions","","Adjustment: Donation to the local food bank",0.00,0.00,0.00,"Separately stated"`), true);
  check(csv.includes(`"Total","","Ordinary income, books' figure",${money(t.book)},${money(t.difference)},${money(t.taxable)}`), true);
  check(doc.rows.filter((r) => r.kind === "account").length, lines.length + ytd.adjustments.length);
  const st = doc.statement!;
  check(st.tiles.map((x) => x.label), ["Book profit", "Adjustments", "Ordinary income", "Not ready"]);
  check(st.tiles[3].value, "4");
  check(st.panels.length, 1);
  check(st.panels[0].lines.length, bridge.lines.length);
  check(st.checks?.items.length, readiness.length);
  check(st.rows.at(-1)?.cells, [st.tiles[0].value, st.tiles[1].value, st.tiles[2].value]);
  check(st.rows.every((r) => r.kind === "heading" || r.cells.length === 3), true);
  check(st.scopeNote?.includes("not a tax result"), true);
  const pdf = await reportPdf(doc);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  // Older downloads keep the original table; a snapshot without its source is refused.
  check(supportReportDocument(snapshot(report("2026-10-03"))).columns[0], "Account or adjustment");
  assert.throws(() => supportStatementDocument(snapshot({ ...report("2026-10-03"), tax_workpaper: undefined })));
  checks++;

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tax-workpapers.pdf"), pdf);
    await writeFile(join(dir, "tax-workpapers.csv"), csv);
    const prior = supportStatementDocument(snapshot(report("2025-12-31")));
    await writeFile(join(dir, "tax-workpapers-2025.pdf"), await reportPdf(prior));
    await writeFile(join(dir, "tax-workpapers-2025.csv"), documentCsv(prior));
  }
  console.log(`Tax workpapers treatments, bridge, readiness, demo books and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
