import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { booksPackageDocuments } from "../src/lib/accounting/books-package-document";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  try {
    const check = (a: unknown, b: unknown) => {
      assert.deepEqual(a, b);
      n++;
    };
    const cmd = async (command: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key: randomUUID(), command }),
        ])
      ).rows[0].r;
    const report = async (kind: string, params: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.report($1,$2) r", [
          kind,
          JSON.stringify(params),
        ])
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        subtype:
          a.id === account(2)
            ? "transit"
            : a.id === account(8)
              ? "payroll_liability"
              : undefined,
        cash_kind: [account(1), account(9)].includes(a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      });
    for (const f of fixtureEntries) {
      const e = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: f.date,
        memo: f.memo,
        lines: f.lines.map(([id, amount]) => ({
          account_id: account(Number(id)),
          amount_cents: amount,
        })),
      });
      await cmd({ type: "entry.post", id: e.id, expected_version: e.version });
    }
    const r = await report("profit_loss", {
      from: "2026-01-01",
      to: "2026-02-28",
      compare_from: "2025-01-01",
      compare_to: "2025-12-31",
    });
    check(r.totals.income_cents, "190000");
    check(r.totals.expense_cents, "115000");
    check(r.totals.net_cents, "75000");
    check(r.totals.assets_cents, "1278000");
    check(r.totals.liabilities_cents, "3000");
    check(r.totals.equity_cents, "1000000");
    check(r.totals.prior_cents, "200000");
    check(r.totals.year_cents, "75000");
    check(r.totals.cash_opening_cents, "1200000");
    check(r.totals.cash_ending_cents, "1278000");
    check(r.totals.difference_cents, "0");
    check(r.comparison.net_cents, "200000");
    check(
      r.cash.reduce(
        (sum: bigint, c: any) => sum + BigInt(c.amount_cents),
        BigInt("0"),
      ),
      BigInt("78000"),
    );
    const detail = async (kind: string, params: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.report_lines($1,$2) r", [
          kind,
          JSON.stringify(params),
        ])
      ).rows[0].r;
    const scope = { from: "2026-01-01", to: "2026-02-28" };
    const lines = await detail("general_ledger", scope);
    check(lines.total, 18);
    check(lines.total_cents, "0");
    const bankDetail = await detail("general_ledger", {
      ...scope,
      account_ids: [account(1)],
    });
    check(bankDetail.opening_cents, "1200000");
    check(bankDetail.rows.at(-1).running_cents, "1228000");
    check(bankDetail.total_cents, "28000");
    check(
      (
        await detail("general_ledger", { ...scope, limit: 7, offset: 7 })
      ).rows.map((row: any) => row.id),
      lines.rows.slice(7, 14).map((row: any) => row.id),
    );
    check(
      (await report("profit_loss", { ...scope, account_ids: [account(6)] }))
        .monthly[0].expense_cents,
      "15000",
    );
    const cashDetail = await detail("cash_movements", {
      ...scope,
      cash_class: "operating",
    });
    check(cashDetail.total_cents, "78000");
    check(
      r.cash.find((c: any) => c.classification === "operating").amount_cents,
      "78000",
    );
    const capture = await cmd({
      type: "report.capture",
      id: randomUUID(),
      expected_revision: r.revision,
      filter: scope,
      options: { report_id: "profit-loss", show_zero: false, details: true },
    });
    const snap = async (id: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.snapshot_read($1) r", [
          id,
        ])
      ).rows[0].r;
    check((await snap(capture.id)).payload.data.totals.net_cents, "75000");
    const packageCapture = await cmd({
      type: "report.books.capture",
      id: randomUUID(),
      year: 2026,
      through: "2026-02-28",
      expected_revision: r.revision,
    });
    const packageData = await snap(packageCapture.id);
    check(packageData.payload.ledger_count, 18);
    check(booksPackageDocuments(packageData).length, 14);
    const yearHistory = (
      await db.query<{ r: any }>(
        'SELECT accounting.books_package(\'{"view":"history","year":2026}\') r',
      )
    ).rows[0].r;
    check(yearHistory.count, 1);
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "UPDATE accounting.report_snapshots SET data='{}' WHERE id=$1",
        [capture.id],
      ),
      /ACCT_IMMUTABLE_SNAPSHOT/,
    );
    n++;
    await db.exec("SET ROLE authenticated");
    const checklist = (
      await db.query<{ r: any }>(
        "SELECT accounting.close_checklist('2026-01-01') r",
      )
    ).rows[0].r;
    check(checklist.ready, true);
    await cmd({ type: "period.lock", id: randomUUID(), month: "2026-01-01" });
    await assert.rejects(
      cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: "2026-01-31",
        memo: "Locked fixture",
        lines: [],
      }),
      /ACCT_PERIOD_LOCKED/,
    );
    n++;
    await db.exec("RESET ROLE");
    const snapshot = (
      await db.query<Record<string, unknown>>(
        "SELECT close_snapshot FROM accounting.periods WHERE month='2026-01-01'",
      )
    ).rows[0].close_snapshot as any;
    check(snapshot.profit_loss.totals.net_cents, "75000");
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "period.reopen",
      id: randomUUID(),
      month: "2026-01-01",
      reason: "Synthetic reopen",
    });

    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-parity.csv",
      mime_type: "text/csv",
      size_bytes: "12",
      content_hash: "9".repeat(64),
    });
    await db.query<Record<string, unknown>>(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    const history = await cmd({
      type: "history.check",
      id: randomUUID(),
      fiscal_year: 2026,
      kind: "annual_totals",
      from: "2026-01-01",
      to: "2026-02-28",
      document_id: doc.id,
      expected: {
        income_cents: "190000",
        expense_cents: "115000",
        net_income_cents: "75000",
        assets_cents: "1278000",
        liabilities_cents: "3000",
        equity_total_cents: "1275000",
      },
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<Record<string, unknown>>(
          "SELECT status FROM accounting.history_checks WHERE id=$1",
          [history.id],
        )
      ).rows[0].status,
      "matches",
    );
    await db.exec("SET ROLE authenticated");
    const priorEntries = (
      await db.query<{ r: any }>("SELECT accounting.transactions() r")
    ).rows[0].r.entries;
    const receipt = priorEntries.find(
      (e: any) => e.entry_date === "2026-01-05",
    );
    const bankLine = receipt.lines.find(
      (l: any) => l.account_id === account(1),
    );
    let rec = await cmd({
      type: "reconciliation.create",
      id: randomUUID(),
      account_id: account(1),
      from: "2026-01-01",
      to: "2026-01-31",
      opening_cents: "0",
      ending_cents: "200000",
    });
    await assert.rejects(
      cmd({
        type: "reconciliation.complete",
        id: rec.id,
        expected_version: rec.version,
      }),
      /ACCT_RECONCILIATION_DIFFERENCE/,
    );
    n++;
    rec = await cmd({
      type: "reconciliation.allocate",
      id: rec.id,
      expected_version: rec.version,
      allocations: [
        {
          id: randomUUID(),
          entry_line_id: bankLine.id,
          amount_cents: "200000",
        },
      ],
    });
    rec = await cmd({
      type: "reconciliation.complete",
      id: rec.id,
      expected_version: rec.version,
    });
    const late = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-01-30",
      memo: "Synthetic later posting",
      lines: [
        { account_id: account(1), amount_cents: "1" },
        { account_id: account(5), amount_cents: "-1" },
      ],
    });
    await cmd({
      type: "entry.post",
      id: late.id,
      expected_version: late.version,
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<Record<string, unknown>>(
          "SELECT status FROM accounting.reconciliations WHERE id=$1",
          [rec.id],
        )
      ).rows[0].status,
      "in_progress",
    );
    check(
      (
        await db.query<Record<string, unknown>>(
          "SELECT status FROM accounting.history_checks WHERE id=$1",
          [history.id],
        )
      ).rows[0].status,
      "mismatch",
    );
    await db.exec("SET ROLE authenticated");
    check((await snap(capture.id)).payload.data.totals.net_cents, "75000");
    const incomplete = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-03-01",
      memo: "Synthetic incomplete preview",
      lines: [{ account_id: account(5), amount_cents: "-500" }],
    });
    check(
      (
        await report("profit_loss", {
          from: "2026-03-01",
          to: "2026-03-31",
          mode: "working",
        })
      ).income_cents,
      "0",
    );
    await cmd({
      type: "draft.discard",
      id: incomplete.id,
      expected_version: incomplete.version,
      reason: "Incomplete fixture finished",
    });
    let fraction = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-03-02",
      memo: "Synthetic exact cash allocation",
      lines: [
        { account_id: account(1), amount_cents: "1" },
        { account_id: account(2), amount_cents: "1" },
        { account_id: account(5), amount_cents: "-1" },
        { account_id: account(4), amount_cents: "-1" },
      ],
    });
    fraction = await cmd({
      type: "entry.post",
      id: fraction.id,
      expected_version: fraction.version,
    });
    const fractional = await report("cash_movements", {
      from: "2026-03-01",
      to: "2026-03-31",
    });
    check(
      fractional.cash.reduce(
        (sum: bigint, c: any) => sum + BigInt(c.amount_cents),
        BigInt("0"),
      ),
      BigInt("1"),
    );
    check(
      fractional.cash.find((c: any) => c.classification === "operating")
        .amount_cents,
      "1",
    );
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "SELECT * FROM accounting.report_snapshots",
      ),
      /permission denied/,
    );
    n++;
    console.log(
      "Report, close and retained package integration:",
      n,
      "checks passed",
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    e.message,
    e.where,
    "position",
    e.position,
    e.query?.slice(Number(e.position) - 120, Number(e.position) + 160),
  );
  process.exitCode = 1;
});
