import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  NO_CONTACT,
  VENDOR_REPORT,
  contactMonths,
  contactRows,
  contactStatement,
  contactSummary,
  primaryRole,
  rankedRows,
  seriesFilter,
  seriesIds,
  spendByRole,
  spendRoleOf,
} from "../src/lib/accounting/contact-report";
import {
  recurringFilterFor,
  recurringFilterSchema,
  recurringQuery,
  recurringRow,
  recurringSummary,
} from "../src/lib/accounting/recurring";
import {
  contractorLines,
  contractorNote,
  contractorScope,
  contractorTotals,
  contractorYears,
} from "../src/lib/accounting/contractor-worksheet";
import { previousPeriod } from "../src/lib/accounting/profit-loss";
import {
  demoBreakdown,
  demoParties,
  demoRecurring,
  demoReportData,
  demoReportDetail,
  demoSupportReport,
} from "../src/lib/accounting/demo-reports";
import {
  reportFilterSchema,
  reportOptionsSchema,
  type DetailedReportSnapshot,
  type ReportData,
  type ReportFilter,
} from "../src/lib/accounting/reports";

/**
 * Expenses by vendor: who counts as a payee and how they are tagged, the
 * lines adding up to total expenses on every period, spending by role, the
 * contractor reporting line, repeat charges (the demo's port of
 * accounting.recurring and the summary the page shows), the month series,
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
  const config = VENDOR_REPORT;
  const filterOf = (
    from: string,
    to: string,
    mode: ReportFilter["mode"] = "working",
    compare?: { compare_from: string; compare_to: string },
  ): ReportFilter => ({ from, to, mode, offset: 0, ...(compare ?? {}) });

  // Everyone the business pays is a payee; a contact that is only a client is not.
  check(config.isMain(["vendor"]), true);
  check(config.isMain(["contractor"]), true);
  check(config.isMain(["employee", "owner"]), true);
  check(config.isMain([]), true);
  check(config.isMain(["client"]), false);
  check(config.isMain(["client", "vendor"]), true);
  check(primaryRole(["owner", "employee"]), "employee");
  check(primaryRole(["vendor", "client"]), "vendor");
  check(primaryRole([]), null);
  check(spendRoleOf({ group: "main" }, ["employee"]), "payroll");
  check(spendRoleOf({ group: "main" }, ["contractor", "vendor"]), "contractor");
  check(spendRoleOf({ group: "main" }, []), "unroled");
  check(spendRoleOf({ group: "other" }, ["client"]), "clients");
  check(spendRoleOf({ group: "none" }, []), "none");

  // Every period adds up, by contact, by group and by role.
  for (const [from, to] of [
    ["2024-01-01", "2024-12-31"],
    ["2025-01-01", "2025-12-31"],
    ["2026-01-01", "2026-10-03"],
    ["2026-07-01", "2026-09-30"],
  ] as const) {
    for (const mode of ["working", "posted"] as const) {
      const label = `${from} ${mode}`;
      const data = demoReportData(filterOf(from, to, mode, previousPeriod(from, to)));
      const rows = contactRows(data, demoParties, config);
      const s = contactSummary(rows, data, config);
      check(s.total, big(data.totals.expense_cents));
      check(rows.reduce((t, r) => t + r.amount, ZERO), s.total, `${label} rows add up`);
      check(s.mainTotal + s.otherTotal + s.noneTotal, s.total);
      check(rows.reduce((t, r) => t + r.previous, ZERO), s.previousTotal);
      const roles = spendByRole(rows, demoParties, s.total);
      check(roles.reduce((t, r) => t + r.amount, ZERO), s.total, `${label} roles add up`);
      const statement = contactStatement(rows, data, config, false);
      check(big(statement.at(-1)!.values[0]), s.total);
      check(statement.at(-1)!.label, "Total expenses");
      check(statement.find((r) => r.kind === "heading")?.label, "Paid to");
      check(
        statement.every((r) => !r.detail || r.detail.every((d) => !d || reportFilterSchema.safeParse(d).success)),
        true,
      );
      const series = new Map(seriesIds(rows).map((id) => [id, demoBreakdown(seriesFilter(data.filter, id))]));
      const months = contactMonths(data, rows, series, config);
      check(
        months.months.every((m) => m.stacked.reduce((t, v) => t + v, m.rest) === m.total),
        true,
        `${label} stacks add up`,
      );
    }
  }

  // The year to date in detail.
  const ytd = demoReportData(filterOf("2026-01-01", "2026-10-03"));
  const rows = contactRows(ytd, demoParties, config);
  const s = contactSummary(rows, ytd, config);
  check(rows[0].name, "Alex Morgan");
  check(rows[0].tag, "Payroll");
  check(rows.find((r) => r.name === "Jordan Rivera Design")?.tag, "Contractor");
  check(rows.find((r) => r.name === "Federal tax deposits")?.tag, "Government");
  check(rows.find((r) => r.name === "Demo Community Bank")?.tag, "Bank");
  check(rows.find((r) => r.name === "Pixel Software")?.tag, "Vendor");
  const none = rows.find((r) => r.id === NO_CONTACT)!;
  check(none.name, "No vendor assigned");
  check(rows.at(-1)?.id, NO_CONTACT);
  // Owner draws and transfers are not expenses: no equity or bank account reaches the lines.
  check(rows.some((r) => r.name === "Owner distributions"), false);
  check(s.total, ytd.accounts.filter((a) => a.account_type === "expense").reduce((t, a) => t + big(a.period_cents), ZERO));
  const roles = spendByRole(rows, demoParties, s.total);
  check(roles[0].role, "vendor");
  check(roles.find((r) => r.role === "payroll")?.names, ["Alex Morgan"]);
  check(roles.find((r) => r.role === "none")?.label, "No vendor assigned");
  // Ranked rows fold the tail and keep every dollar.
  const folded = rankedRows(rows, "main", null, config, 5);
  check(folded.at(-1)?.label, `${rows.filter((r) => r.group === "main" && r.amount !== ZERO).length - 5} more payees`);
  check(folded.reduce((t, r) => t + r.amount, ZERO), s.mainTotal);

  // The 1099 note: the Contractor worksheet's own count, never a second
  // rule. Card payments, corporations and foreign contractors stay out.
  const sheet = (to: string) =>
    demoSupportReport({ report_id: "contractor-worksheet", from: `${to.slice(0, 4)}-01-01`, to, offset: 0 });
  const note = contractorNote(sheet("2026-10-03"));
  const needs = contractorLines(sheet("2026-10-03")).filter((l) => l.needs1099);
  check(note?.count, needs.length);
  check(note?.count, contractorTotals(contractorLines(sheet("2026-10-03"))).needs1099);
  check(needs.map((l) => l.name).sort(), ["Jordan Rivera Design", "Orbit Event Staffing", "Quill and Pine Editing", "Sam Lee Development"]);
  check(note?.text, "4 contractors need a 1099 for 2026 so far; see the Contractor worksheet.");
  check(contractorNote(sheet("2025-12-31"))?.text, "3 contractors need a 1099 for 2025; see the Contractor worksheet.");
  check(contractorNote(sheet("2024-06-30"))?.text, "1 contractor needs a 1099 for 2024 so far; see the Contractor worksheet.");
  // Paid over the line by card or as a corporation is not counted.
  for (const name of ["Maya Chen Photography", "Northbeam Analytics LLC", "Lucia Ortega Translation"])
    check(needs.some((l) => l.name === name), false, `${name} needs no 1099`);
  // The vendor page reads the same scope the worksheet opens with.
  check(contractorScope(2026, "2026-10-03"), sheet("2026-10-03").filter);
  check(contractorYears("2026-10-03").includes(2027), false, "no note for a year the rules do not cover");

  // Repeat charges: the read's filter, the demo's port, and the summary.
  const recurringFilter = recurringFilterFor({ to: "2026-10-03", mode: "working" });
  check(recurringFilterSchema.safeParse(recurringFilter).success, true);
  check(recurringFilterSchema.safeParse({ ...recurringFilter, limit: 500 }).success, false);
  check(JSON.parse(recurringQuery(recurringFilter).filter), recurringFilter);
  const recurring = demoRecurring(recurringFilter);
  check(recurring.total, recurring.series.length);
  check(recurring.totals.active + recurring.totals.stopped, recurring.total);
  check(
    big(recurring.totals.active_annual_cents),
    recurring.series.filter((x) => x.status === "active").reduce((t, x) => t + big(x.annual_cents), ZERO),
  );
  const projectly = recurring.series.find((x) => x.contact?.name === "Projectly")!;
  check(projectly.cadence, "monthly");
  check(projectly.price_change, { on: "2026-07-08", from_cents: "2900", to_cents: "3900" });
  check(recurringRow(projectly).monthly, big(3900));
  const insurance = recurringRow(recurring.series.find((x) => x.contact?.name === "Shield Insurance")!);
  check(insurance.cadence, "annual");
  check(insurance.monthly, insurance.last / big(12));
  // Transfers and card payments never repeat as charges.
  check(recurring.series.some((x) => /transfer|card payment/i.test(x.descriptor_key ?? "")), false);
  const summary = recurringSummary(recurring, { from: "2026-01-01", to: "2026-10-03" });
  check(summary.started.map((r) => r.name), ["Canvas Studio Apps"]);
  check(summary.increases.some((r) => r.name === "Projectly"), true);
  check(summary.stopped.map((r) => r.name), ["Ledger & Co. CPAs"]);
  check(summary.active.every((r, i, a) => i === 0 || a[i - 1].monthly >= r.monthly), true);
  check(summary.monthly, big(recurring.totals.active_monthly_cents));
  check(summary.partial, false);
  const q2 = recurringSummary(demoRecurring(recurringFilterFor({ to: "2026-06-30", mode: "working" })), {
    from: "2026-04-01",
    to: "2026-06-30",
  });
  // By the end of June the new plan has charged twice: not a pattern yet.
  check(q2.started.map((r) => r.name), []);
  check(q2.increases.some((r) => r.name === "Projectly"), false, "the plan went up in July, not in Q2");
  check(demoRecurring({ ...recurringFilter, status: "stopped" }).series.every((x) => x.status === "stopped"), true);
  check(demoRecurring({ ...recurringFilter, limit: 2 }).series.length, 2);

  // Drill-downs open the payee's expense lines.
  const detail = await demoReportDetail(reportFilterSchema.parse(rows[0].filter));
  check(big(detail.total_cents), rows[0].amount);

  // Exports: the roles travel with the snapshot.
  const contactRoles = rows.flatMap((r) => {
    const role = primaryRole(demoParties.find((p) => p.id === r.id)?.roles ?? []);
    return role ? [{ id: r.id, role }] : [];
  });
  const options = {
    report_id: "vendor-expenses" as const,
    show_zero: false,
    details: true,
    layout: 2 as const,
    contact_roles: contactRoles,
  };
  check(reportOptionsSchema.safeParse(options).success, true);
  const snapshot = (report: ReportData, opts: Record<string, unknown> = options): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000f001",
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
  check(branded.title, "Expenses by vendor");
  check(branded.columns, ["Section", "Contact", "Role", "Expenses", "% of spending", "Comparison", "Change", "Change %"]);
  const csv = documentCsv(branded);
  check(csv.includes("$"), false);
  check(csv.includes(`"Paid to","Alex Morgan","Payroll",`), true);
  check(csv.includes(`"Paid to","Jordan Rivera Design","Contractor",`), true);
  check(csv.includes(`"Other spending","No vendor assigned","",`), true);
  check(csv.includes(`"Total","Total expenses","",${(Number(compared.totals.expense_cents) / 100).toFixed(2)},100.00,`), true);
  check(csv.includes("Owner draws, transfers between your own accounts and card payments are not expenses"), true);
  check(branded.statement?.tiles.map((t) => t.label), ["Spending", "Contacts paid", "Biggest payee's share", "Contractors"]);
  // Less spending reads as good, more as bad.
  check(
    branded.statement?.tiles[0].tone,
    big(compared.totals.expense_cents) < big(compared.comparison.expense_cents) ? "good" : "bad",
  );
  check(branded.statement?.ranked?.map((p) => p.title), ["Who you paid", "Where the money goes", "Other spending"]);
  check(branded.statement?.ranked?.[1].rows.reduce((t, r) => t + Math.round(r.amount * 100), 0), Number(compared.totals.expense_cents));
  const plain = reportDocument(snapshot(ytd));
  check(plain.columns, ["Section", "Contact", "Role", "Expenses", "% of spending"]);
  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  // Exports without a layout keep the older columns.
  check(
    reportDocument(snapshot(ytd, { report_id: "vendor-expenses", show_zero: false, details: true })).columns[0],
    "Account / category",
  );

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "vendor-expenses-compare.pdf"), pdf);
    await writeFile(join(dir, "vendor-expenses-compare.csv"), csv);
    await writeFile(join(dir, "vendor-expenses.pdf"), await reportPdf(plain));
    await writeFile(join(dir, "vendor-expenses.csv"), documentCsv(plain));
    await writeFile(
      join(dir, "vendor-expenses-summary.pdf"),
      await reportPdf(reportDocument(snapshot(ytd, { ...options, details: false }))),
    );
  }
  console.log(
    `Expenses by vendor presentation, roles, repeat charges and export layout: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
