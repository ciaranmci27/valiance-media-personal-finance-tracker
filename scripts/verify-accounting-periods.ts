import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const cmd = async (command: object) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key: randomUUID(), command }),
      ])
    ).rows[0].r;
  const checklist = async (month: string) =>
    (
      await db.query<{ r: any }>("SELECT accounting.close_checklist($1) r", [
        month,
      ])
    ).rows[0].r;
  const admin = async <T>(sql: string, params: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const locked = async () =>
    (
      await admin<{ n: number }>(
        "SELECT count(*)::integer n FROM accounting.periods WHERE status='locked'",
      )
    ).at(0)!.n;
  try {
    await cmd({ type: "chart.seed", accounts: fixtureAccounts });
    check((await checklist("2024-01-01")).ready, true);
    await cmd({ type: "period.lock", month: "2024-01-01" });
    const january = (await checklist("2024-01-01")).period.close_snapshot;
    check(january.profit_loss.net_income_cents, "0");
    check(january.balance_sheet.balance_difference_cents, "0");
    await cmd({ type: "period.lock", month: "2024-02-01" });
    check(await locked(), 2);
    // Refused at draft creation, before it can compromise a later locked snapshot.
    await assert.rejects(
      cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: "2023-12-31",
        memo: "Backdated journal",
        lines: [
          { account_id: fixtureAccountId(1), amount_cents: "100" },
          { account_id: fixtureAccountId(4), amount_cents: "-100" },
        ],
      }),
      /ACCT_LATER_PERIOD_LOCKED/,
    );
    checks++;
    await assert.rejects(
      cmd({ type: "period.reopen", month: "2024-01-01", reason: "" }),
      /ACCT_REASON_REQUIRED/,
    );
    checks++;
    await cmd({
      type: "period.reopen",
      month: "2024-01-01",
      reason: "Investigate opening balances",
    });
    check(await locked(), 0);
    const retained = await admin<{ before: any }>(
      "SELECT before FROM accounting.audit_log WHERE table_name='periods' AND action='period.reopen' AND before->>'month'='2024-01-01'",
    );
    check(retained[0].before.close_snapshot, january);
    for (let m = 1; m <= 12; m++)
      await cmd({
        type: "period.lock",
        month: `2024-${String(m).padStart(2, "0")}-01`,
      });
    check(await locked(), 12);
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-filed-return.pdf",
      content_hash: "f".repeat(64),
      mime_type: "application/pdf",
      size_bytes: "10",
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    // Filed-year and restatement state machines are removed. The original package stays immutable.
    const filing = await cmd({
      type: "report.books.capture",
      id: randomUUID(),
      year: 2024,
      through: "2024-12-31",
      document_id: doc.id,
    });
    const snapshot = async (id: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.snapshot_read($1) r", [
          id,
        ])
      ).rows[0].r;
    const filed = await snapshot(filing.id);
    await cmd({
      type: "period.reopen",
      month: "2024-01-01",
      reason: "Document a reviewed correction",
    });
    check(await locked(), 0);
    for (let m = 1; m <= 12; m++)
      await cmd({
        type: "period.lock",
        month: `2024-${String(m).padStart(2, "0")}-01`,
      });
    const revised = await cmd({
      type: "report.books.capture",
      id: randomUUID(),
      year: 2024,
      through: "2024-12-31",
      document_id: doc.id,
    });
    check(typeof revised.id, "string");
    check(await snapshot(filing.id), filed);
    const locks = await admin<{ n: number }>(
      "SELECT count(*)::integer n FROM accounting.audit_log WHERE table_name='periods' AND action='period.lock' AND after->>'status'='locked'",
    );
    check(locks[0].n, 26);
    check(typeof (await snapshot(revised.id)).revision, "string");
    await db.exec("RESET ROLE; SET ROLE anon");
    await assert.rejects(checklist("2024-01-01"), /permission denied/);
    checks++;
    console.log(
      `Period locks, dependent reopen and retained filing packages: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
