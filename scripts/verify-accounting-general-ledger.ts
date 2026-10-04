import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LEDGER_PDF_LINES,
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  basisSentence,
  ledgerAccounts,
  ledgerLines,
  ledgerOffset,
  ledgerScope,
  ledgerSections,
  ledgerTotals,
  lineText,
  matchLines,
  oneFiscalYear,
  usualSide,
} from "../src/lib/accounting/general-ledger";
import { demoReportData, demoReportDetail } from "../src/lib/accounting/demo-reports";
import {
  reportFilterSchema,
  reportOptionsSchema,
  type DetailedReportSnapshot,
  type ReportData,
  type ReportDetail,
  type ReportFilter,
} from "../src/lib/accounting/reports";

/**
 * The general ledger: each account's opening, debits, credits and closing
 * tie out; every line's running balance is on the ledger's basis (balance
 * sheet accounts from the start of the books, income and expenses from the
 * fiscal year, including a fiscal year that does not start in January);
 * the line search; and the export layout (every line in the CSV, one
 * section per account in the PDF). Set ACCOUNTING_REPORT_ARTIFACT_DIR to
 * also write the PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);
  const filterOf = (from: string, to: string, mode: "working" | "posted" = "working"): ReportFilter => ({
    from,
    to,
    mode,
    offset: 0,
  });
  /** Every line in scope, paged the way the screen and the capture read them. */
  const allLines = async (filter: ReportFilter) => {
    const first = await demoReportDetail(filter);
    const rows = [...first.rows];
    while (rows.length < first.total)
      rows.push(...(await demoReportDetail({ ...filter, offset: rows.length })).rows);
    return { ...first, rows } as ReportDetail;
  };

  // Each account ties out, both modes, a year, a quarter and a span of years.
  for (const [from, to] of [
    ["2026-01-01", "2026-10-03"],
    ["2026-04-01", "2026-06-30"],
    ["2025-03-01", "2026-02-28"],
  ]) {
    for (const mode of ["working", "posted"] as const) {
      const label = `${from}..${to} ${mode}`;
      const data = demoReportData(filterOf(from, to, mode));
      const accounts = ledgerAccounts(data);
      check(accounts.length > 0, true, label);
      for (const a of accounts) check(a.opening + usualSide(a.type) * (a.debit - a.credit), a.closing, `${label} ${a.name} ties`);
      const t = ledgerTotals(accounts);
      check(t.debits, t.credits, `${label} debits equal credits`);
      const detail = await allLines(filterOf(from, to, mode));
      const lines = ledgerLines(detail.rows, data);
      check(lines.reduce((s, l) => s + l.debit, ZERO), t.debits, `${label} lines add up to the debits`);
      check(lines.reduce((s, l) => s + l.credit, ZERO), t.credits, `${label} lines add up to the credits`);
      // Each account's lines run from its opening to its closing.
      for (const { account: a, lines: own } of ledgerSections(accounts, lines)) {
        let balance = a.opening;
        for (const l of own) {
          balance += usualSide(a.type) * (l.debit - l.credit);
          check(l.change, usualSide(a.type) * (l.debit - l.credit));
          check(l.balance, balance, `${label} ${a.name} running balance on ${l.date}`);
        }
        check(balance, a.closing, `${label} ${a.name} ends at its closing`);
      }
      check(
        accounts.every((a) => reportFilterSchema.safeParse(ledgerScope(data, a.id)).success),
        true,
      );
      check(reportFilterSchema.safeParse(ledgerScope(data, null)).success, true);
    }
  }

  // Basis: balance sheet accounts carry their balance; income and expenses
  // start at the fiscal year, or show the period's activity across years.
  const year = demoReportData(filterOf("2026-04-01", "2026-06-30"));
  const checking = ledgerAccounts(year).find((a) => a.name === "Operating checking")!;
  check(checking.opening, big(checking.account.opening_cents), "a bank account opens at its balance");
  const income = ledgerAccounts(year).find((a) => a.type === "income" && a.debit + a.credit > ZERO)!;
  check(income.opening, big(income.account.prior_cents) - big(income.account.opening_cents), "income opens at the year to date, as a credit");
  check(income.closing > ZERO, true, "income reads positive on its usual side");
  check(ledgerAccounts(year).find((a) => a.name === "Business card")!.closing > ZERO, true, "a card balance owed reads positive");
  check(ledgerAccounts(year).find((a) => a.name === "Accumulated depreciation")!.closing < ZERO, true, "a contra account reads negative");
  check(basisSentence(year.filter), "The balance runs from the start of the fiscal year.");
  const span = demoReportData(filterOf("2025-03-01", "2026-02-28"));
  check(ledgerAccounts(span).filter((a) => a.type === "income" || a.type === "expense").every((a) => a.opening === ZERO), true, "across years income and expenses open at zero");
  check(basisSentence(span.filter).startsWith("This period spans fiscal years"), true);

  // A fiscal year starting in July. The books report the balance before the
  // fiscal year as prior; the demo books use January, so this sets it from
  // a report that starts on July 1.
  const july = 7;
  check(oneFiscalYear({ from: "2025-08-01", to: "2026-03-31" }, july), true);
  check(oneFiscalYear({ from: "2026-05-01", to: "2026-08-31" }, july), false);
  check(oneFiscalYear({ from: "2025-08-01", to: "2026-03-31" }), false, "January years split at New Year");
  const fy = demoReportData(filterOf("2025-08-01", "2026-03-31"));
  const fromJuly = demoReportData(filterOf("2025-07-01", "2026-03-31"));
  const fiscal: ReportData = {
    ...fy,
    accounts: fy.accounts.map((a) => ({
      ...a,
      prior_cents: fromJuly.accounts.find((b) => b.id === a.id)!.opening_cents,
    })),
  };
  const fyLines = ledgerLines((await allLines(fy.filter)).rows, fiscal, july);
  const julyLines = (await allLines(fromJuly.filter)).rows;
  for (const a of ledgerAccounts(fiscal, july).filter((x) => x.type === "income" || x.type === "expense")) {
    const before = julyLines
      .filter((r) => r.account_id === a.id && r.entry_date < "2025-08-01")
      .reduce((s, r) => s + big(r.amount_cents), ZERO);
    check(a.opening, usualSide(a.type) * before, `${a.name} opens at July's activity`);
    check(ledgerOffset(a.account, fiscal, july), big(a.account.prior_cents));
    const own = fyLines.filter((l) => l.accountId === a.id);
    if (own.length) check(own.at(-1)!.balance, a.closing, `${a.name} closes on the July year`);
  }
  check(ledgerAccounts(fiscal, 1).some((a, i) => a.opening !== ledgerAccounts(fiscal, july)[i].opening), true, "the fiscal month changes the basis");

  // A single signed line amount moves the balance the way it reads: a credit
  // grows income, a debit shrinks it; a credit shrinks a bank account; a
  // contra account moves by its own side.
  {
    const quarter = ledgerLines((await allLines(year.filter)).rows, year);
    const named = (name: string) => quarter.filter((l) => l.account === name);
    const incomeLine = quarter.find((l) => l.accountId === income.id && l.credit > ZERO)!;
    check(incomeLine.change, incomeLine.credit, "a credit to income shows +");
    check(named("Operating checking").find((l) => l.credit > ZERO)!.change < ZERO, true, "a credit to a bank account shows -");
    check(named("Business card").find((l) => l.credit > ZERO)!.change > ZERO, true, "a charge on a card shows +");
    const contra = named("Accumulated depreciation").find((l) => l.credit > ZERO)!;
    check(contra.change < ZERO, true, "depreciation moves a contra asset further negative");
    for (const list of [quarter])
      for (const [i, l] of list.entries()) {
        const before = list.slice(0, i).reverse().find((x) => x.accountId === l.accountId);
        if (before) check(l.balance - before.balance, l.change, `${l.account} moves by its signed amount`);
      }
  }

  // The line search: words, the note, the account and amounts.
  const sample = ledgerLines((await allLines(year.filter)).rows, year);
  const target = sample.find((l) => l.debit > big(10000))!;
  const word = target.description.split(/[\s,]+/).find((w) => w.length > 4)!;
  check(matchLines(sample, word).every((l) => `${l.description} ${l.note} ${l.account}`.toLowerCase().includes(word.toLowerCase()) || false), true);
  check(matchLines(sample, word).includes(target), true);
  const dollars = Number(target.debit) / 100;
  for (const q of [dollars.toFixed(2), `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2 })}`])
    check(matchLines(sample, q).includes(target), true, `finds ${q}`);
  check(matchLines(sample, "  ").length, sample.length);
  check(matchLines(sample, "zzzz-no-such-line").length, 0);
  check(lineText({ description: "Rent", note: "October" }), "Rent / October");
  check(lineText({ description: "Rent", note: "Rent" }), "Rent");
  check(lineText({ description: "", note: "" }), "No description");

  // Exports: every line in the CSV, one section per account in the PDF.
  const options = { report_id: "general-ledger" as const, show_zero: false, details: true, layout: 2 as const, fiscal_start_month: 1 };
  const snapshot = (report: ReportData, ledger: ReportDetail["rows"], opts: Record<string, unknown> = options): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000a6c1",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "detailed_report", export_definition: 1, data: report, options: reportOptionsSchema.parse(opts), ledger },
  });
  const quarterRows = (await allLines(year.filter)).rows;
  const doc = reportDocument(snapshot(year, quarterRows));
  check(doc.title, "General ledger");
  check(doc.columns, ["Date", "Entry", "Description", "Account number", "Account", "Debit", "Credit", "Running balance"]);
  const accounts = ledgerAccounts(year);
  check(doc.rows.filter((r) => r.kind === "account").length, quarterRows.length, "the CSV lists every line");
  check(doc.rows.filter((r) => r.kind === "subtotal").length, accounts.length * 2, "each account opens and closes");
  const csv = documentCsv(doc);
  check(csv.includes("$"), false);
  check(csv.includes("Opening and closing balances use"), false);
  const money = (v: bigint) => (Number(v) / 100).toFixed(2);
  check(csv.includes(`"2026-04-01","","Opening balance","1000","Operating checking","","",${money(checking.opening)}`), true);
  check(csv.includes(`"2026-06-30","","Closing balance","1000","Operating checking","","",${money(checking.closing)}`), true);
  const firstChecking = ledgerLines(quarterRows, year).find((l) => l.accountId === checking.id)!;
  check(
    csv.includes(`"${firstChecking.date}","${firstChecking.entryId}","${lineText(firstChecking)}${firstChecking.draft ? " (awaiting review)" : ""}","1000","Operating checking",`),
    true,
  );
  // Grouped by account in the ledger's order, each account's lines by date.
  const order = doc.rows.filter((r) => r.kind === "account").map((r) => r.cells[4]);
  check(order.filter((name, i) => i === 0 || name !== order[i - 1]).length, accounts.filter((a) => a.debit + a.credit > ZERO).length);
  const st = doc.statement!;
  check(st.tiles.map((x) => x.label), ["Lines", "Debits", "Credits", "Accounts with activity"]);
  check(st.tiles[0].value, quarterRows.length.toLocaleString("en-US"));
  check(st.columns, ["Debit", "Credit", "Balance"]);
  check(st.statementTitle, "Ledger");
  check(st.rows.filter((r) => r.kind === "heading").length, accounts.length);
  check(st.rows.filter((r) => r.kind === "account").length, quarterRows.length);
  check(st.rows[1].label.startsWith("Opening balance"), true);
  check(st.rows.every((r) => r.kind === "heading" || r.cells.length === 3), true);
  check(st.scopeNote?.includes("CSV lists every line") ?? false, false);
  const pdf = await reportPdf(doc);
  check(pdf.subarray(0, 5).toString(), "%PDF-");

  // The PDF stops listing lines at its cap and says so; the CSV does not.
  const many = Array.from({ length: LEDGER_PDF_LINES + 25 }, (_, i) => ({
    ...quarterRows[i % quarterRows.length],
    id: `line-many-${i}`,
  }));
  const capped = reportDocument(snapshot(year, many));
  check(capped.rows.filter((r) => r.kind === "account").length, many.length);
  check(capped.statement!.rows.filter((r) => r.kind === "account" && !r.label.includes("listed in the CSV")).length, LEDGER_PDF_LINES);
  check(capped.statement!.rows.some((r) => r.label.endsWith("more lines, listed in the CSV")), true);
  check(capped.statement!.scopeNote?.includes(`first ${LEDGER_PDF_LINES.toLocaleString("en-US")} of ${many.length.toLocaleString("en-US")} lines`), true);

  // The July fiscal year reaches the export through the options.
  const fyDoc = reportDocument(snapshot(fiscal, (await allLines(fy.filter)).rows, { ...options, fiscal_start_month: july }));
  const firstIncome = ledgerAccounts(fiscal, july).find((a) => a.type === "income" && a.opening !== ZERO);
  if (firstIncome)
    check(fyDoc.rows.some((r) => r.key === `open-${firstIncome.id}` && r.cells[7] === money(firstIncome.opening)), true);
  // Older captures keep their original columns, and a missing ledger is refused.
  const legacy = reportDocument(snapshot(year, quarterRows, { report_id: "general-ledger", show_zero: false, details: true }));
  check(legacy.columns[1], "Description / source");
  assert.throws(() => reportDocument({ ...snapshot(year, quarterRows), payload: { ...snapshot(year, quarterRows).payload, ledger: undefined } }));
  checks++;

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "general-ledger.pdf"), pdf);
    await writeFile(join(dir, "general-ledger.csv"), csv);
    const ytd = demoReportData(filterOf("2026-01-01", "2026-10-03"));
    const ytdDoc = reportDocument(snapshot(ytd, (await allLines(ytd.filter)).rows));
    await writeFile(join(dir, "general-ledger-ytd.pdf"), await reportPdf(ytdDoc));
    await writeFile(join(dir, "general-ledger-ytd.csv"), documentCsv(ytdDoc));
  }
  console.log(`General ledger balances, basis, search and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
