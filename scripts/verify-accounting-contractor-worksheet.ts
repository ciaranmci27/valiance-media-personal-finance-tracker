import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentCsv } from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  CONTRACTOR_GROUPS,
  contractorDecisions,
  contractorLine,
  contractorLines,
  contractorRule,
  contractorScope,
  contractorSentence,
  contractorTotals,
  contractorYears,
} from "../src/lib/accounting/contractor-worksheet";
import { contractorYearRules } from "../src/lib/accounting/contractors";
import { DEMO_SUPPORT_REPORTS, demoReportData, demoSupportReport } from "../src/lib/accounting/demo-reports";
import {
  SUPPORT_LAYOUT_2,
  supportStatementDocument,
} from "../src/lib/accounting/support-report-document";
import {
  supportReportCatalog,
  supportReportDocument,
  supportReportFilterSchema,
  type SupportReportData,
  type SupportReportSnapshot,
} from "../src/lib/accounting/support-reports";

/**
 * The contractor worksheet: each contractor's standing for a calendar year
 * (who needs a 1099, what is missing, what is left out), the decisions the
 * owner still has to make, the totals, the demo books, and the export
 * layout (a filing-ready CSV and the branded PDF). Set
 * ACCOUNTING_REPORT_ARTIFACT_DIR to also write the PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);
  const worksheet = (to: string) =>
    demoSupportReport({ report_id: "contractor-worksheet", from: `${to.slice(0, 4)}-01-01`, to, offset: 0 });

  // Calendar years from the rules, never past this year; the scope runs
  // January 1 through today in the current year, or the whole year.
  check(contractorYears("2026-10-03"), [2026, 2025, 2024, 2023, 2022]);
  check(contractorYears("2024-05-01"), [2024, 2023, 2022]);
  check(contractorScope(2026, "2026-10-03"), { report_id: "contractor-worksheet", from: "2026-01-01", to: "2026-10-03", offset: 0 });
  check(contractorScope(2025, "2026-10-03").to, "2025-12-31");
  check(supportReportFilterSchema.safeParse(contractorScope(2026, "2026-10-03")).success, true);
  check(contractorRule(2026).line, big(200000), "the 2026 line is $2,000");
  check(contractorRule(2025).line, big(60000), "before 2026 it is $600");
  check(contractorRule(2030).line, null);
  for (const year of Object.keys(contractorYearRules).map(Number))
    check(contractorRule(year).line, big(contractorYearRules[year].minimum_cents));

  // One contractor at a time: each case the worksheet decides.
  const rule = contractorRule(2026);
  const row = (kind: string, w9: string, cash: number, card = 0) => ({
    id: "c",
    contractor_party_id: "00000000-0000-4000-8000-0000000000c1",
    cells: ["Synthetic contractor", kind, w9, String(cash), String(card)],
  });
  const at = (kind: string, w9: string, cash: number, card = 0, inProgress = false) =>
    contractorLine(row(kind, w9, cash, card), rule, inProgress);
  check(at("individual", "received", 250000).status, "ready");
  check(at("individual", "received", 200000).status, "ready", "exactly the line counts");
  check(at("individual", "received", 199999).status, "under");
  check(at("individual", "missing", 250000).status, "missing-w9");
  check(at("individual", "missing", 250000).step, "Ask for a W-9");
  check(at("unknown", "missing", 250000).status, "missing-w9", "the W-9 settles the type too");
  check(at("unknown", "received", 250000).status, "decide");
  check(at("individual", "not_required", 250000).status, "decide");
  check(at("other", "received", 250000).status, "decide");
  check(at("corporation", "missing", 900000).status, "exempt");
  check(at("corporation", "missing", 900000).needs1099, false);
  check(at("foreign", "not_required", 900000).step, "No 1099; keep a W-8BEN");
  check(at("individual", "missing", 100000, 0, true).step, "Under so far; ask for a W-9");
  check(at("individual", "missing", 100000, 0, false).step, "Under the 2026 line");
  check(at("individual", "received", 0, 0).status, "unpaid");
  // Card payments never count toward the line.
  const carded = at("individual", "received", 50000, 900000);
  check([carded.status, carded.reportable, carded.card, carded.total], ["under", big(50000), big(900000), big(950000)]);
  // Refunds larger than payments count as nothing.
  const refunded = at("individual", "received", -30000);
  check([refunded.status, refunded.reportable], ["unpaid", ZERO]);
  check(contractorDecisions([refunded]).map((d) => d.key), [`refund-${refunded.id}`]);
  check(contractorLine(row("individual", "received", 900000), contractorRule(2030), false).status, "decide");
  // The id is the contact, for the links and the drill.
  check(at("individual", "received", 1).id, "00000000-0000-4000-8000-0000000000c1");
  // Decisions: plain wording, the contact to open, look before info.
  const decisions = contractorDecisions([
    at("unknown", "received", 250000),
    at("unknown", "missing", 1000),
    at("individual", "not_required", 250000),
    at("other", "received", 250000),
    at("individual", "received", 250000),
  ]);
  check(decisions.map((d) => [d.tone, d.title]), [
    ["look", "Is Synthetic contractor a person or a business?"],
    ["info", "Is Synthetic contractor a person or a business?"],
    ["look", "Synthetic contractor is marked as not needing a W-9"],
    ["look", "Synthetic contractor's type is Other"],
  ]);
  check(decisions.some((d) => /error|wrong|illegal|penalt/i.test(`${d.title} ${d.detail}`)), false, "decisions say what the books show");

  // The demo books: every case appears in 2026 so far.
  const ytd = worksheet("2026-10-03");
  check(ytd.count, ytd.rows.length);
  check(ytd.filter.from, "2026-01-01");
  const lines = contractorLines(ytd);
  const named = (name: string) => lines.find((l) => l.name === name)!;
  check(lines.map((l) => l.status), [
    "missing-w9",
    "missing-w9",
    "decide",
    "ready",
    "under",
    "under",
    "exempt",
    "exempt",
    "unpaid",
  ]);
  check(named("Sam Lee Development").status, "missing-w9");
  check(named("Jordan Rivera Design").status, "ready");
  check(named("Northbeam Analytics LLC").status, "exempt");
  check(named("Lucia Ortega Translation").status, "exempt");
  check(named("Harbor Bookkeeping Help").status, "unpaid");
  const maya = named("Maya Chen Photography");
  check([maya.reportable, maya.card, maya.status], [big(65000), big(185000), "under"], "card payments keep her under the line");
  check(maya.total >= rule.line!, true, "her total is over the line, card included");
  // Jordan's refund comes off what counts.
  const vendorYear = demoReportData({ from: "2026-01-01", to: "2026-10-03", mode: "posted", offset: 0 });
  const jordan = vendorYear.dimensions.find((d) => d.name === "Jordan Rivera Design")!;
  check(named("Jordan Rivera Design").reportable, big(jordan.expense_cents), "bank payments net of the refund equal the expense");
  // Reasons and steps carry no amounts but the public line, so privacy mode
  // hides every figure that is the owner's.
  check(lines.every((l) => !/\$[\d,]+\.\d\d/.test(`${l.step} ${l.reason}`.replaceAll("$2,000.00", ""))), true);
  // Totals and the sentence.
  const t = contractorTotals(lines);
  check([t.paid, t.needs1099, t.missing, t.ready, t.unpaid], [8, 4, 3, 1, 1]);
  check(t.reportable, lines.reduce((s, l) => s + l.reportable, ZERO));
  check(t.card, big(185000));
  check(t.total, t.reportable + t.card);
  check(big(ytd.total_cells[3]) + big(ytd.total_cells[4]), t.total, "the books' totals agree");
  check(contractorSentence(t, 2026, true), "4 contractors need a 1099 for 2026; 1 is ready, 3 need something first.");
  check(contractorDecisions(lines).map((d) => d.title), [
    "Is Sam Lee Development a person or a business?",
    "Quill and Pine Editing's type is Other",
  ]);
  // 2025 had the $600 line: Riverside's $900 needs a 1099 that year.
  const last = contractorLines(worksheet("2025-12-31"));
  check(last.find((l) => l.name === "Riverside Copywriting")?.status, "ready");
  check(contractorSentence(contractorTotals(last), 2025, false), "3 contractors need a 1099 for 2025; 2 are ready, 1 needs something first.");
  // Paging: the demo answers in pages of 100 like the books.
  check(demoSupportReport({ report_id: "contractor-worksheet", from: "2026-01-01", to: "2026-10-03", offset: 100 }).rows.length, 0);
  check(DEMO_SUPPORT_REPORTS.includes("contractor-worksheet"), true);
  // Every support report has demo books; an unknown id is refused.
  check(DEMO_SUPPORT_REPORTS.length, 5);
  assert.throws(() => demoSupportReport({ report_id: "unknown-report" as never, from: "2026-01-01", to: "2026-10-03", offset: 0 }));
  checks++;
  // Groups cover every contractor once.
  check(CONTRACTOR_GROUPS.reduce((n, g) => n + lines.filter(g.match).length, 0), lines.length);

  // Exports: a CSV for filing and the branded PDF.
  const snapshot = (data: SupportReportData): SupportReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000c3c1",
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "support_report", export_definition: 1, data },
  });
  check(SUPPORT_LAYOUT_2.includes("contractor-worksheet"), true);
  const doc = supportStatementDocument(snapshot(ytd));
  check(doc.title, "Contractor worksheet");
  check(doc.columns, [
    "Contact",
    "Contractor type",
    "W-9",
    "Reportable payments",
    "Card payments (left out)",
    "Total paid",
    "Needs a 1099",
    "Next step",
  ]);
  check(doc.metadata.find(([k]) => k === "Reporting line")?.[1], "2000.00 (2026)");
  check(doc.rows.length, lines.length + 1);
  const csv = documentCsv(doc);
  check(csv.includes("$"), false);
  check(csv.includes(`"Maya Chen Photography","Individual","Missing",650.00,1850.00,2500.00,"No","Under so far; ask for a W-9"`), true);
  check(csv.includes(`"Northbeam Analytics LLC","Corporation","Received",4800.00,0.00,4800.00,"No","No 1099 for a corporation"`), true);
  check(csv.includes(`"Sam Lee Development","Not reviewed","Missing",`), true);
  check(csv.includes(`"Total","","",${(Number(t.reportable) / 100).toFixed(2)},1850.00,${(Number(t.total) / 100).toFixed(2)},"4",""`), true);
  const st = doc.statement!;
  check(st.tiles.map((x) => [x.label, x.value]), [
    ["Contractors paid", "8"],
    ["Need a 1099", "4"],
    ["Missing W-9 or details", "3"],
    ["Paid to contractors", "$36,176.12"],
  ]);
  check(st.columns, ["Reportable", "By card", "Total paid", "Status"]);
  check(st.rows.filter((r) => r.kind === "heading").map((r) => r.label), ["Need a 1099", "No 1099 needed", "Not paid this year"]);
  check(st.rows.filter((r) => r.kind === "account").length, lines.length);
  check(st.rows.at(-1)?.label, "All contractors");
  check(st.checks?.title, "Needs a decision");
  check(st.checks?.items.length, 2);
  check(st.rows.every((r) => r.kind === "heading" || r.cells.length === 4), true);
  const pdf = await reportPdf(doc);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  // The original table stays for older downloads and the books package.
  check(supportReportDocument(snapshot(ytd)).columns[0], "Payee");
  // The payroll amounts payable report is gone: the reads refuse its id.
  check(supportReportFilterSchema.safeParse({ report_id: "payroll-liabilities", from: "2026-01-01", to: "2026-10-03", offset: 0 }).success, false);
  check(supportReportCatalog.some((r) => (r.id as string) === "payroll-liabilities"), false);
  // Every support report in the catalog has its layout 2.
  check([...supportReportCatalog.map((r) => r.id)].sort(), [...SUPPORT_LAYOUT_2].sort());
  assert.throws(() => supportStatementDocument(snapshot({ ...ytd, count: ytd.count + 1 })));
  checks++;
  const quiet = supportStatementDocument(snapshot(worksheet("2024-12-31")));
  check(quiet.statement?.checks?.items.length, 0);

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "contractor-worksheet.pdf"), pdf);
    await writeFile(join(dir, "contractor-worksheet.csv"), csv);
    const prior = supportStatementDocument(snapshot(worksheet("2025-12-31")));
    await writeFile(join(dir, "contractor-worksheet-2025.pdf"), await reportPdf(prior));
    await writeFile(join(dir, "contractor-worksheet-2025.csv"), documentCsv(prior));
  }
  console.log(`Contractor worksheet statuses, decisions, demo books and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
