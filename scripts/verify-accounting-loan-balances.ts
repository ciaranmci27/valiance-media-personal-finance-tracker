import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentCsv } from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  LOAN_NOTES,
  isShareholderLoan,
  loanHistory,
  loanLines,
  loanMovements,
  loanScope,
  loanSentence,
  loanTies,
  loanTotals,
  loanYears,
} from "../src/lib/accounting/loan-balances";
import {
  DEMO_SUPPORT_REPORTS,
  demoLoanDetail,
  demoLoanRegisters,
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
import type { RegisterDetail } from "../src/lib/accounting/registers";

/**
 * Loan balances: years and as-of dates, each loan's balance against what
 * was borrowed, principal repaid and interest recorded this year from the
 * posted movements, shareholder loans, the ties to the loan accounts
 * (agreeing with the balance sheet), principal by year from posted figures
 * only, the demo books, and the export layout. Set
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
  const today = "2026-10-03";
  const register = (to: string) => demoSupportReport({ report_id: "loan-register", from: `${to.slice(0, 4)}-01-01`, to, offset: 0 });
  const detailsAt = (data: SupportReportData) =>
    new Map(data.rows.map((r) => [r.register_id!, demoLoanDetail(r.register_id!, data.filter.to)] as [string, RegisterDetail]));

  check(loanYears(today), [2026, 2025, 2024, 2023]);
  check(loanScope(2026, today), { report_id: "loan-register", from: "2026-01-01", to: today, offset: 0 });
  check(loanScope(2025, today).to, "2025-12-31");
  check(supportReportFilterSchema.safeParse(loanScope(2026, today)).success, true);

  // The demo: the equipment loan ($500 left) and the owner's loan.
  const data = register(today);
  const details = detailsAt(data);
  const owners = ["Alex Morgan"];
  const lines = loanLines(data, demoLoanRegisters(today), details, owners);
  const named = (name: string) => lines.find((l) => l.name === name)!;
  const equipment = named("Equipment loan");
  check(equipment.balance, big(50000), "the equipment loan has $500 left");
  check([equipment.original, equipment.lender, equipment.started], [big(1000000), "Demo Community Bank", "2025-02-03"]);
  check(equipment.repaid, big(950000));
  check(equipment.repaidThisYear, big(50000) * big(9), "January through September 2026");
  check(equipment.interestThisYear, ZERO, "the bank loan's payments record no interest");
  check(equipment.paidShare, 95);
  check(equipment.shareholder, false);
  const owner = named("Shareholder loan from Alex Morgan");
  check(owner.shareholder, true);
  check(owner.balance, big(500000) - big(50000) * big(5));
  check(owner.repaidThisYear, big(250000));
  check(owner.interestThisYear, big(2500 + 2250 + 2000 + 1750 + 1500), "interest on what was still owed, May to September");
  // The register's balance and the movements agree.
  for (const l of lines) {
    const moves = loanMovements(details.get(l.id)!, today);
    check(moves.reduce((s, m) => s + m.drawn - m.repaid, ZERO), l.balance, `${l.name} movements add up to its balance`);
  }
  const t = loanTotals(lines, data);
  check([t.count, t.open, t.owed], [2, 2, big(300000)]);
  check(t.repaidThisYear, big(450000) + big(250000));
  check(t.interestThisYear, big(10000));
  check(loanTotals(loanLines(data, null, null), data).repaidThisYear, null, "without the movements, paid down is unknown");
  check(loanSentence(t, "Oct 3, 2026"), "$3,000.00 owed on 2 loans.");
  // Larger loans first, by what is owed.
  check(lines.map((l) => l.name), ["Shareholder loan from Alex Morgan", "Equipment loan"]);
  // Shareholder loans: by the lender being an owner, or the name.
  check(isShareholderLoan("Working capital", "alex morgan", owners), true);
  check(isShareholderLoan("Loan from officer", "", []), true);
  check(isShareholderLoan("Equipment loan", "Demo Community Bank", owners), false);
  // A reversed payment drops out once its reversal date has passed.
  const reversed: RegisterDetail = {
    ...details.get(equipment.id)!,
    movements: details.get(equipment.id)!.movements.map((m, i) =>
      i === 0 ? { ...m, void: { effective_date: "2026-09-30", reason: "Synthetic", reversal_entry_id: null } } : m,
    ),
  };
  check(loanMovements(reversed, today).length, loanMovements(details.get(equipment.id)!, today).length - 1);
  check(loanMovements(reversed, "2026-09-29").length, loanMovements(details.get(equipment.id)!, "2026-09-29").length);
  // Paid off a year later: the equipment loan's last payment is in October.
  check(loanLines(register("2026-12-31"), null, null).find((l) => l.name === "Equipment loan")?.balance, ZERO);

  // Ties: both loan accounts hold what the register explains, as the balance sheet shows.
  const ties = loanTies(data);
  check(ties.every((x) => x.tone === "good"), true);
  const bs = demoReportData({ from: "1900-01-01", to: today, mode: "posted", offset: 0 });
  check(-big(bs.accounts.find((a) => a.name === "Equipment loan")!.ending_cents), ties.find((x) => x.account === "Equipment loan")?.books);
  check(-big(bs.accounts.find((a) => a.name === "Loan from shareholder")!.ending_cents), ties.find((x) => x.account === "Loan from shareholder")?.books);
  const off: SupportReportData = {
    ...data,
    controls: { ...data.controls!, rows: [{ ...data.controls!.rows[0], book_cents: "-60000", register_cents: "-50000", difference_cents: "-10000" }] },
  };
  check(loanTies(off)[0].title, "Equipment loan holds $100.00 more than the register");
  check(loanTies(off)[0].detail.endsWith("record it in the loan's register, or move it."), true);

  // Principal by year, from posted movements.
  const history = loanHistory([...details.values()], today);
  check(history.map((h) => h.year), [2025, 2026]);
  check([history[0].borrowed, history[0].repaid, history[0].owed], [big(1000000), big(500000), big(500000)]);
  check([history[1].borrowed, history[1].repaid, history[1].interest, history[1].owed], [big(500000), big(700000), big(10000), big(300000)]);
  check(history.at(-1)?.owed, t.owed);
  check(loanHistory([], today), []);
  check(DEMO_SUPPORT_REPORTS.includes("loan-register"), true);
  check(LOAN_NOTES.some((n) => /no rate or payment schedule/.test(n)), true);

  // Exports.
  const snapshot = (report: SupportReportData): SupportReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000a1b2",
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "support_report", export_definition: 1, data: report },
  });
  check(SUPPORT_LAYOUT_2.includes("loan-register"), true);
  const doc = supportStatementDocument(snapshot(data));
  check(doc.title, "Loan balances");
  check(doc.columns, ["Loan", "Originated", "Principal balance"]);
  const csv = documentCsv(doc);
  check(csv.includes("$"), false);
  check(csv.includes(`"Equipment loan","2025-02-03",500.00`), true);
  check(csv.includes(`"Total","",3000.00`), true);
  check(csv.includes(`"Equipment loan: books 500.00, register 500.00, tied."`), true);
  const st = doc.statement!;
  check(st.tiles.map((x) => [x.label, x.value]), [
    ["Owed now", "$3,000.00"],
    ["Loans", "2"],
    ["Paid off", "0"],
    ["Ties to the books", "Yes"],
  ]);
  check(st.rows.find((r) => r.key === owner.id)?.label, "Shareholder loan from Alex Morgan", "its name already says whose it is");
  const renamed = { ...data, rows: data.rows.map((r) => (r.register_id === owner.id ? { ...r, cells: ["Working capital from Alex", ...r.cells.slice(1)] } : r)) };
  check(supportStatementDocument(snapshot(renamed)).statement?.rows.find((r) => r.key === owner.id)?.label, "Working capital from Alex");
  check(st.checks?.items.length, 0);
  const pdf = await reportPdf(doc);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  check(supportReportDocument(snapshot(data)).columns[0], "Loan", "older downloads keep the original table");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "loan-balances.pdf"), pdf);
    await writeFile(join(dir, "loan-balances.csv"), csv);
    const prior = supportStatementDocument(snapshot(register("2025-12-31")));
    await writeFile(join(dir, "loan-balances-2025.pdf"), await reportPdf(prior));
    await writeFile(join(dir, "loan-balances-2025.csv"), documentCsv(prior));
  }
  console.log(`Loan balances, payments, interest, ties, history, demo books and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
