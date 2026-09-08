import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildReportModel,
  reportCatalog,
  ratioPercent,
} from "../src/lib/accounting/report-model";
import {
  reportDocument,
  documentCsv,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  reportFilterSchema,
  type DetailedReportSnapshot,
} from "../src/lib/accounting/reports";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import type { ReportData, ReportDetail } from "../src/lib/accounting/reports";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const read = async <T>(fn: string, arg: any) => {
    const names: Record<string, string> = {
      acct_report: "accounting.report('summary',$1)",
      acct_ledger_report: "accounting.report('general_ledger',$1)",
      acct_report_detail: `accounting.report_lines('${arg?.cash_class ? "cash_movements" : "general_ledger"}',$1)`,
      acct_snapshot_read: "accounting.snapshot_read($1)",
      acct_register: "accounting.transactions($1)",
    };
    return (
      await db.query<{ r: T }>(`SELECT ${names[fn]} r`, [
        typeof arg === "object" ? JSON.stringify(arg) : arg,
      ])
    ).rows[0].r;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb)) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  const filter = {
    from: "2026-01-01",
    to: "2026-02-28",
    mode: "posted",
    compare_from: "2025-01-01",
    compare_to: "2025-12-31",
  };
  try {
    check(
      (await read<ReportData>("acct_report", filter)).totals.net_cents,
      "0",
    );
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        subtype: a.id === fixtureAccountId(2) ? "transit" : undefined,
        cash_kind: [fixtureAccountId(1), fixtureAccountId(9)].includes(a.id)
          ? "bank"
          : a.id === fixtureAccountId(3)
            ? "card"
            : "none",
      })),
    });
    for (const fixture of fixtureEntries) {
      const entry = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: fixture.date,
        memo: fixture.memo,
        lines: fixture.lines.map(([a, cents]) => ({
          account_id: fixtureAccountId(Number(a)),
          amount_cents: cents,
          memo: "",
        })),
      });
      await cmd({
        type: "entry.post",
        id: entry.id,
        expected_version: entry.version,
      });
    }
    const r = await read<ReportData>("acct_report", filter);
    for (const compare of [true, false]) {
      const data = {
        ...r,
        filter: reportFilterSchema.parse({
          ...r.filter,
          compare_from: compare ? r.filter.compare_from : undefined,
          compare_to: compare ? r.filter.compare_to : undefined,
        }),
      };
      for (const meta of reportCatalog) {
        const model = buildReportModel(meta.id, data, true);
        check(
          model.rows.every(
            (row) =>
              row.kind === "heading" ||
              row.values.length === model.columns.length,
          ),
          true,
        );
        check(
          model.rows.every(
            (row) =>
              row.detail?.every(
                (d) => !d || reportFilterSchema.safeParse(d).success,
              ) ?? true,
          ),
          true,
        );
      }
      const balance = buildReportModel("balance-sheet", data);
      check(
        balance.rows.find((row) => row.label === "Total liabilities & equity")
          ?.values[0],
        "1278000",
      );
    }
    check(ratioPercent("75000", "190000"), "39.47%");
    check(ratioPercent("1", "0"), null);
    const captureId = randomUUID(),
      captureKey = randomUUID();
    const capture = {
      type: "report.capture",
      id: captureId,
      expected_revision: r.revision,
      filter: r.filter,
      options: { report_id: "profit-loss", show_zero: false, details: true },
    };
    await cmd(capture, captureKey);
    check((await cmd(capture, captureKey)).id, captureId);
    check((await read<ReportData>("acct_report", filter)).revision, r.revision);
    const retained = await read<DetailedReportSnapshot>(
      "acct_snapshot_read",
      captureId,
    );
    const document = reportDocument(retained);
    check(
      document.rows
        .find((row) => row.cells[0] === "Net profit")
        ?.cells.slice(1),
      ["750.00", "2000.00", "-1250.00"],
    );
    const csv = documentCsv({ ...document, company: '=HYPERLINK("unsafe")' });
    check(csv.includes('"Company","\'=HYPERLINK(""unsafe"")"'), true);
    check(csv.includes('"Net profit",750.00,2000.00,-1250.00'), true);
    const pdf = await reportPdf(document);
    check(pdf.subarray(0, 5).toString(), "%PDF-");
    if (process.env.ACCOUNTING_REPORT_ARTIFACT_DIR) {
      await mkdir(process.env.ACCOUNTING_REPORT_ARTIFACT_DIR, {
        recursive: true,
      });
      await writeFile(
        join(process.env.ACCOUNTING_REPORT_ARTIFACT_DIR, "profit-loss.pdf"),
        pdf,
      );
      await writeFile(
        join(process.env.ACCOUNTING_REPORT_ARTIFACT_DIR, "profit-loss.csv"),
        csv,
      );
      const longDoc = {
        ...document,
        title: "Synthetic pagination acceptance",
        rows: Array.from({ length: 12 }, (_, i) =>
          document.rows.map((row) => ({ ...row, key: `${i}-${row.key}` })),
        ).flat(),
      };
      await writeFile(
        join(process.env.ACCOUNTING_REPORT_ARTIFACT_DIR, "pagination.pdf"),
        await reportPdf(longDoc),
      );
    }
    await assert.rejects(
      db.query("UPDATE accounting.report_snapshots SET data=$1 WHERE id=$2", [
        JSON.stringify({}),
        captureId,
      ]),
      /permission denied/,
    );
    checks++;
    const ledgerId = randomUUID();
    await cmd({
      ...capture,
      id: ledgerId,
      options: { ...capture.options, report_id: "general-ledger" },
    });
    const ledgerSnapshot = await read<DetailedReportSnapshot>(
      "acct_snapshot_read",
      ledgerId,
    );
    check(ledgerSnapshot.payload.ledger?.length, 18);
    check(reportDocument(ledgerSnapshot).rows.length, 18);
    const scopedFilter = { ...filter, account_ids: [fixtureAccountId(6)] };
    const scoped = await read<ReportData>("acct_ledger_report", scopedFilter);
    check(scoped.filter.account_ids, [fixtureAccountId(6)]);
    const scopedId = randomUUID();
    await cmd({
      ...capture,
      id: scopedId,
      filter: scopedFilter,
      options: { ...capture.options, report_id: "general-ledger" },
    });
    const scopedSnapshot = await read<DetailedReportSnapshot>(
      "acct_snapshot_read",
      scopedId,
    );
    check(scopedSnapshot.payload.ledger?.length, 2);
    check(
      scopedSnapshot.payload.ledger?.every(
        (l) => l.account_id === fixtureAccountId(6),
      ),
      true,
    );
    check(
      reportDocument(scopedSnapshot).metadata.find(
        ([key]) => key === "Accounts",
      )?.[1],
      "Software",
    );
    await assert.rejects(
      cmd({ ...capture, id: randomUUID(), filter: scopedFilter }),
      /ACCT_INVALID_FILTER/,
    );
    checks++;
    await assert.rejects(
      read("acct_ledger_report", { ...filter, account_ids: [randomUUID()] }),
      /ACCT_INVALID_FILTER/,
    );
    checks++;
    await assert.rejects(
      read("acct_ledger_report", { ...filter, account_ids: "wrong" }),
      /ACCT_INVALID_FILTER/,
    );
    checks++;
    check(r.totals.income_cents, "190000");
    check(r.totals.expense_cents, "115000");
    check(r.totals.net_cents, "75000");
    check(r.totals.difference_cents, "0");
    check(r.totals.cash_opening_cents, "1200000");
    check(r.totals.cash_ending_cents, "1278000");
    check(r.comparison.income_cents, "200000");
    check(r.totals.prior_cents, "200000");
    check(r.totals.year_cents, "75000");
    check(
      r.monthly.map((m) => m.net_cents),
      ["75000", "0"],
    );
    check(
      r.cash.reduce((s, c) => s + BigInt(c.amount_cents), BigInt(0)),
      BigInt(78000),
    );
    check(
      r.cash.find((c) => c.classification === "internal_transfer")
        ?.amount_cents,
      "0",
    );
    check(r.quality.unclassified_cash_lines, 0);
    const expenses = await read<ReportDetail>("acct_report_detail", {
      ...filter,
      account_types: ["expense"],
    });
    check(expenses.total_cents, r.totals.expense_cents);
    check(expenses.rows.at(-1)?.running_cents, "15000");
    const transit = await read<ReportDetail>("acct_report_detail", {
      ...filter,
      cash_class: "internal_transfer",
    });
    check(transit.total_cents, "0");
    check(transit.rows.length, 2);
    const draft = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-02-11",
      memo: "Working report only",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "100", memo: "" },
        { account_id: fixtureAccountId(5), amount_cents: "-100", memo: "" },
      ],
    });
    check(
      (await read<DetailedReportSnapshot>("acct_snapshot_read", captureId))
        .payload.data.totals.net_cents,
      "75000",
    );
    await assert.rejects(
      cmd({ ...capture, id: randomUUID() }),
      /ACCT_STALE_REVISION/,
    );
    checks++;
    check(
      (await read<ReportData>("acct_report", filter)).totals.income_cents,
      "190000",
    );
    check(
      (await read<ReportData>("acct_report", { ...filter, mode: "working" }))
        .totals.income_cents,
      "190100",
    );
    await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-02-12",
      memo: "Incomplete draft excluded from working totals",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "999", memo: "" },
      ],
    });
    const working = await read<ReportData>("acct_report", {
      ...filter,
      mode: "working",
    });
    check(working.quality.unbalanced_drafts, 1);
    check(working.totals.income_cents, "190100");
    const cash = await read<ReportDetail>("acct_report_detail", {
      ...filter,
      cash_class: "operating",
    });
    const card = cash.rows.find((l) => l.memo === "Pay business card")!;
    check(card.amount_cents, "-12000");
    check(
      cash.rows.find((l) => l.memo === "Net pay clears liability")!
        .amount_cents,
      "-100000",
    );
    check(
      (await read<ReportData>("acct_report", filter)).quality
        .unclassified_cash_lines,
      0,
    );
    await assert.rejects(
      db.query(
        "UPDATE accounting.journal_lines SET cash_class='financing' WHERE id=$1",
        [card.id],
      ),
      /permission denied/,
    );
    checks++;
    const cardEntry = await read<{
      entries: { id: string; version: number }[];
    }>("acct_register", { entry_id: card.entry_id });
    await cmd({
      type: "entry.reverse",
      id: card.entry_id,
      expected_version: cardEntry.entries[0].version,
      entry_date: "2026-02-13",
      reason: "Synthetic reversal of reviewed cash classification",
    });
    const reverted = await read<ReportData>("acct_report", filter);
    check(
      reverted.cash.find((c) => c.classification === "unclassified"),
      undefined,
    );
    check(
      reverted.cash.find((c) => c.classification === "operating")?.amount_cents,
      "90000",
    );
    // Both previously unclassified payments now derive operating treatment.
    check(
      (
        BigInt(
          reverted.cash.find((c) => c.classification === "operating")!
            .amount_cents,
        ) + BigInt("100000")
      ).toString(),
      "190000",
    );
    const party = randomUUID();
    await cmd({
      type: "party.save",
      id: party,
      expected_version: 0,
      name: "Synthetic customer",
      kind: "customer",
      is_archived: false,
      contractor_classification: "unknown",
      w9_status: "not_requested",
      tin_last4: "",
      notes: "",
    });
    const attributed = await cmd({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-02-15",
      memo: "Attributed receipt",
      context: {
        kind: "income",
        payee_id: party,
        payment_rail: "ach",
        contractor_treatment: "unreviewed",
        contractor_reason: "",
      },
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "275", memo: "" },
        { account_id: fixtureAccountId(5), amount_cents: "-275", memo: "" },
      ],
    });
    check(
      (await read<ReportData>("acct_report", { ...filter, payee: party }))
        .totals.income_cents,
      "275",
    );
    await cmd({
      type: "entry.reverse",
      id: attributed.id,
      expected_version: attributed.version,
      entry_date: "2026-02-16",
      reason: "Reverse attributed receipt",
    });
    check(
      (await read<ReportData>("acct_report", { ...filter, payee: party }))
        .totals.income_cents,
      "0",
    );
    check(
      (await read<ReportData>("acct_report", { ...filter, payee: party }))
        .totals.difference_cents,
      "0",
    );
    await assert.rejects(
      read("acct_report", { ...filter, mode: "bad" }),
      /ACCT_REPORT_RANGE/,
    );
    checks++;
    await assert.rejects(
      read("acct_report", { ...filter, from: "2026-03-01" }),
      /ACCT_REPORT_RANGE/,
    );
    checks++;
    await cmd({
      type: "draft.discard",
      id: draft.id,
      expected_version: draft.version,
      reason: "Synthetic working draft complete",
    });
    console.log(
      `Detailed reports, exact comparisons, cash classifications and payee reversals: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
