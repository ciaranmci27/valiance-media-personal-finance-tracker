import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  equityRollForward,
  isEmptyOwnerReport,
  ownerAccounts,
  ownerLines,
  ownerLinesFilter,
  ownerMonths,
  ownerNotes,
  ownerSentence,
  ownerStatement,
  ownerTotals,
  salaryAccounts,
  type OwnerTotals,
} from "../src/lib/accounting/owner-activity";
import { balanceFilter, balanceTotals } from "../src/lib/accounting/balance-sheet";
import { previousPeriod } from "../src/lib/accounting/profit-loss";
import {
  demoAccountActivity,
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
 * Owner activity: money put in and taken out of the owner equity accounts
 * (a mixed account split by its credits and debits), salary through
 * payroll, the equity roll-forward tying to the balance sheet at both ends,
 * the plain notes, the month series from the journal lines, the statement,
 * and the export layout. Set ACCOUNTING_REPORT_ARTIFACT_DIR to also write
 * the PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);
  const filterOf = (
    from: string,
    to: string,
    mode: ReportFilter["mode"] = "working",
    compare?: { compare_from: string; compare_to: string },
  ): ReportFilter => ({ from, to, mode, offset: 0, ...(compare ?? {}) });
  const dayBefore = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

  // Every period: the roll-forward ties to the balance sheet at both ends.
  for (const [from, to] of [
    ["2024-01-01", "2024-12-31"],
    ["2025-01-01", "2025-12-31"],
    ["2026-01-01", "2026-10-03"],
    ["2025-07-01", "2025-09-30"],
    ["2026-04-01", "2026-06-30"],
  ] as const) {
    for (const mode of ["working", "posted"] as const) {
      const label = `${from} ${mode}`;
      const data = demoReportData(filterOf(from, to, mode, previousPeriod(from, to)));
      const t = ownerTotals(data);
      const end = balanceTotals(demoReportData(balanceFilter(to, mode))).current.equity;
      const start = balanceTotals(demoReportData(balanceFilter(dayBefore(from), mode))).current.equity;
      check(t.endingEquity, end, `${label} ending equity is the balance sheet's`);
      check(t.startingEquity, start, `${label} starting equity is the balance sheet's the day before`);
      const roll = equityRollForward(data);
      check(roll.start + roll.lines.reduce((s, l) => s + l.amount, ZERO), roll.end, `${label} roll-forward adds up`);
      check(
        roll.lines.every((l) => !l.filter || reportFilterSchema.safeParse(l.filter).success),
        true,
      );
      // The comparison column is the comparison period's own roll-forward.
      const before = demoReportData(filterOf(data.filter.compare_from!, data.filter.compare_to!, mode));
      const statement = ownerStatement(data, true);
      const row = (key: string) => statement.find((r) => r.key === key)!;
      check(big(row("end").values[0]), t.endingEquity);
      check(big(row("end").values[1]), ownerTotals(before).endingEquity, `${label} comparison ending`);
      check(big(row("start").values[1]), ownerTotals(before).startingEquity, `${label} comparison starting`);
      check(big(row("net").values[1]), ownerTotals(before).putIn - ownerTotals(before).takenOut);
      check(
        big(row("start").values[0]) + big(row("net").values[0]) + big(row("profit").values[0]) + big(statement.find((r) => r.key === "opening")?.values[0] ?? "0"),
        big(row("end").values[0]),
        `${label} statement adds up`,
      );
      check(
        statement.filter((r) => r.kind !== "heading").every((r) => big(r.values[2]) === big(r.values[0]) - big(r.values[1])),
        true,
      );
      // Every account's movement adds up to the net line.
      check(
        statement.filter((r) => r.indent && r.section === "Your equity").reduce((s, r) => s + big(r.values[0]), ZERO),
        big(row("net").values[0]),
      );
      // The journal lines on the owner accounts are the tiles' put in and taken out.
      const scope = ownerLinesFilter(data)!;
      check(reportFilterSchema.safeParse(scope).success, true);
      const detail = await demoReportDetail(scope);
      const lines = ownerLines(detail.rows);
      check(lines.filter((l) => l.amount > ZERO).reduce((s, l) => s + l.amount, ZERO), t.putIn, `${label} lines put in`);
      check(-lines.filter((l) => l.amount < ZERO).reduce((s, l) => s + l.amount, ZERO), t.takenOut, `${label} lines taken out`);
      const salaryIds = salaryAccounts(data).map((a) => a.id);
      const salary = demoAccountActivity({ from, to, mode, group_by: "month", measure: "activity", account_ids: salaryIds });
      const months = ownerMonths(data, lines, salary.rows);
      check(months.reduce((s, m) => s + (m.salary ?? ZERO), ZERO), t.salary, `${label} salary by month`);
      check(months.at(-1)?.takenSoFar, t.takenOut);
      check(months.at(-1)?.profitSoFar, t.profit);
    }
  }

  // The year 2025 in detail: a mixed account, salary and draws.
  const y2025 = demoReportData(filterOf("2025-01-01", "2025-12-31"));
  const t = ownerTotals(y2025);
  const mixed = y2025.accounts.find((a) => a.name === "Owner Investment / Drawings")!;
  check(t.mixed.map((a) => a.name), ["Owner Investment / Drawings"]);
  check(t.putIn, ownerAccounts(y2025).reduce((s, a) => s + big(a.credit_cents), ZERO));
  check(t.putIn >= big(mixed.credit_cents), true);
  check(t.salary, big(y2025.accounts.find((a) => a.purpose === "officer_compensation")!.period_cents));
  check(t.salaryTracked, true);
  check(t.takenShare, Number((t.takenOut * big(10000)) / t.profit) / 100);
  check(
    ownerSentence(t),
    `You put in $6,000 and took out $52,500, while the business made $${(t.profit / big(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} in profit.`,
  );
  const notes = ownerNotes(t);
  check(notes.some((n) => n.text.startsWith("Owner Investment / Drawings holds money both ways")), true);
  check(notes.some((n) => n.text.startsWith("For information only: S corporation owners")), true);
  check(notes.some((n) => /will|must|owe tax/i.test(n.text)), false, "no tax outcome is claimed");
  // The notes on fixed totals.
  const base: OwnerTotals = { ...t, mixed: [] };
  check(ownerNotes({ ...base, takenOut: big(500), profit: big(300) })[0].text.startsWith("You took out $2 more"), true);
  check(ownerNotes({ ...base, takenOut: big(500), profit: big(-100) })[0].tone, "look");
  check(ownerNotes({ ...base, salary: ZERO }).some((n) => n.text.includes("S corporation")), false, "no salary, no S corporation line");
  check(ownerNotes({ ...base, takenOut: ZERO }).some((n) => n.text.includes("S corporation")), false);
  check(ownerSentence({ ...base, putIn: ZERO, takenOut: ZERO, profit: ZERO }), "No money moved between you and the business.");
  // Without an officer pay account, salary is not tracked rather than zero.
  const unpaid: ReportData = { ...y2025, accounts: y2025.accounts.filter((a) => a.purpose !== "officer_compensation") };
  check(ownerTotals(unpaid).salaryTracked, false);
  check(isEmptyOwnerReport(demoReportData(filterOf("2019-01-01", "2019-12-31"))), true);
  check(isEmptyOwnerReport(y2025), false);
  // Summary keeps the net line; Every account adds each owner account.
  check(ownerStatement(y2025, false).some((r) => r.indent), false);
  check(ownerStatement(y2025, true).filter((r) => r.indent).map((r) => r.label).includes("Owner Investment / Drawings"), true);

  // Exports.
  const options = { report_id: "owner-activity" as const, show_zero: false, details: true, layout: 2 as const };
  const snapshot = (report: ReportData, opts: Record<string, unknown> = options): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000a0a1",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: { type: "detailed_report", export_definition: 1, data: report, options: reportOptionsSchema.parse(opts) },
  });
  const compared = demoReportData(filterOf("2025-01-01", "2025-12-31", "working", previousPeriod("2025-01-01", "2025-12-31")));
  const branded = reportDocument(snapshot(compared));
  check(branded.title, "Owner activity");
  check(branded.columns, ["Section", "Line", "Amount", "Comparison", "Change"]);
  const csv = documentCsv(branded);
  check(csv.includes("$"), false);
  check(csv.includes(`"Your equity","Ending equity",${(Number(ownerTotals(compared).endingEquity) / 100).toFixed(2)},`), true);
  check(csv.includes(`"Your equity","Owner Investment / Drawings",`), true);
  check(csv.includes("Opening and closing balances use"), false);
  check(branded.statement?.tiles.map((x) => x.label), ["Money put in", "Money taken out", "Paid as salary", "Taken out vs profit"]);
  check(branded.statement?.panels.map((p) => p.title), ["Where your equity went"]);
  check(branded.statement?.ranked?.[0].title, "Salary and draws");
  const panel = branded.statement!.panels[0];
  check(
    Math.round((panel.start?.amount ?? 0) * 100) + panel.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0),
    Math.round(panel.total.amount * 100),
  );
  const plain = reportDocument(snapshot(demoReportData(filterOf("2026-01-01", "2026-10-03"))));
  check(plain.columns, ["Section", "Line", "Amount"]);
  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  check(reportDocument(snapshot(y2025, { report_id: "owner-activity", show_zero: false, details: true })).columns[0], "Account / category");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "owner-activity-compare.pdf"), pdf);
    await writeFile(join(dir, "owner-activity-compare.csv"), csv);
    await writeFile(join(dir, "owner-activity.pdf"), await reportPdf(plain));
    await writeFile(join(dir, "owner-activity.csv"), documentCsv(plain));
    await writeFile(
      join(dir, "owner-activity-summary.pdf"),
      await reportPdf(reportDocument(snapshot(compared, { ...options, details: false }))),
    );
  }
  console.log(`Owner activity presentation, roll-forward, notes and export layout: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
