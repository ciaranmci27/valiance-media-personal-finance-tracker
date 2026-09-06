import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
  fixtureOwner,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const cmd = async (command: object) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT acct_execute($1,$2::jsonb) r",
        [randomUUID(), JSON.stringify(command)],
      )
    ).rows[0].r;
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        ...(a.id === fixtureAccountId(8)
          ? { purpose: "net_salary_payable" }
          : {}),
      })),
    });
    async function journal(date: string, amount: string) {
      const id = randomUUID();
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: date,
        memo: "Clearing fixture",
        lines: [
          { account_id: fixtureAccountId(8), amount_cents: amount, memo: "" },
          {
            account_id: fixtureAccountId(1),
            amount_cents: (-BigInt(amount)).toString(),
            memo: "",
          },
        ],
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
      await db.exec("RESET ROLE");
      const line = (
        await db.query<{ id: string }>(
          "SELECT id FROM acct_journal_lines WHERE entry_id=$1 AND account_id=$2",
          [id, fixtureAccountId(8)],
        )
      ).rows[0].id;
      await db.exec("SET ROLE authenticated");
      return { id, line };
    }
    const obligation = await journal("2026-01-01", "-10000"),
      first = await journal("2026-01-15", "6000"),
      second = await journal("2026-01-20", "4000"),
      extra = await journal("2026-01-25", "1000");
    await db.exec("RESET ROLE");
    const allocate = (id: string, line: string, amount: string, date: string) =>
      db.query(
        "INSERT INTO acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by) VALUES($1,$2,$3,$4,$5,'Verified fixture payment',$6)",
        [id, obligation.line, line, amount, date, fixtureOwner],
      );
    const firstAllocation = randomUUID();
    await allocate(firstAllocation, first.line, "6000", "2026-01-15");
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_residual($1,'2026-01-16')::text r",
          [obligation.line],
        )
      ).rows[0].r,
      "-4000",
    );
    await allocate(randomUUID(), second.line, "4000", "2026-01-20");
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_residual($1,'2026-01-21')::text r",
          [obligation.line],
        )
      ).rows[0].r,
      "0",
    );
    await assert.rejects(
      allocate(randomUUID(), extra.line, "1", "2026-01-25"),
      /ACCT_ALLOCATION_EXCEEDED/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "entry.reverse",
      id: first.id,
      expected_version: 2,
      entry_date: "2026-03-01",
      reason: "Payment returned",
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_residual($1,'2026-02-28')::text r",
          [obligation.line],
        )
      ).rows[0].r,
      "0",
    );
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_residual($1,'2026-03-01')::text r",
          [obligation.line],
        )
      ).rows[0].r,
      "-6000",
    );
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_residual($1,'2026-03-01')::text r",
          [first.line],
        )
      ).rows[0].r,
      "0",
    );
    // March's release cannot create capacity for a January allocation.
    await assert.rejects(
      allocate(randomUUID(), extra.line, "1", "2026-01-25"),
      /ACCT_ALLOCATION_EXCEEDED/,
    );
    checks++;
    await assert.rejects(
      db.query("DELETE FROM acct_clearing_releases WHERE allocation_id=$1", [
        firstAllocation,
      ]),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    const view = (
      await db.query<{
        r: {
          rows: { line_id: string; residual_cents: string }[];
          allocations: { id: string }[];
        };
      }>("SELECT acct_clearing_view('2026-03-01') r")
    ).rows[0].r;
    check(
      view.rows.find((r) => r.line_id === obligation.line)?.residual_cents,
      "-6000",
    );
    check(view.allocations.length, 3);
    const futureObligation = await journal("2026-06-01", "-1000"),
      futureSettlement = await journal("2026-07-01", "1000");
    await db.exec("RESET ROLE");
    const futureAllocation = randomUUID();
    await db.query(
      "INSERT INTO acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by) VALUES($1,$2,$3,1000,'2026-07-01','Future settlement test',$4)",
      [
        futureAllocation,
        futureObligation.line,
        futureSettlement.line,
        fixtureOwner,
      ],
    );
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "entry.reverse",
      id: futureSettlement.id,
      expected_version: 2,
      entry_date: "2026-06-10",
      reason: "Cancellation before future effective date",
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_capacity($1,'2026-06-10')::text r",
          [futureObligation.line],
        )
      ).rows[0].r,
      "1000",
    );
    check(
      (
        await db.query<{ r: string }>(
          "SELECT acct_clearing_residual($1,'2026-07-01')::text r",
          [futureSettlement.line],
        )
      ).rows[0].r,
      "0",
    );
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("SELECT * FROM acct_clearing_allocations"),
      /permission denied/,
    );
    checks++;
    console.log(`Clearing allocation timelines: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
