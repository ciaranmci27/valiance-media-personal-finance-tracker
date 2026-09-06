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
  const command = async (value: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT acct_operate($1,$2::jsonb) r",
        [key, JSON.stringify(value)],
      )
    ).rows[0].r;
  const revision = async () =>
    (
      await db.query<{ r: { revision: string } }>(
        "SELECT acct_close_history() r",
      )
    ).rows[0].r.revision;
  const monthly = [
    {
      from: "2026-01-01",
      to: "2026-01-31",
      income_cents: "20000",
      expense_cents: "5000",
      net_income_cents: "15000",
    },
    {
      from: "2026-02-01",
      to: "2026-02-28",
      income_cents: "30000",
      expense_cents: "15000",
      net_income_cents: "15000",
    },
  ];
  const accounts = [
    { account_id: fixtureAccountId(1), amount_cents: "40000" },
    { account_id: fixtureAccountId(5), amount_cents: "-50000" },
    { account_id: fixtureAccountId(6), amount_cents: "20000" },
  ];
  const totals = {
    assets_cents: "40000",
    liabilities_cents: "0",
    equity_total_cents: "40000",
  };
  const preview = async (m = monthly, a = accounts, t = totals) =>
    (
      await db.query<{
        r: { ready: boolean; partial_year: boolean; differences: number };
      }>("SELECT acct_history_preview($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) r", [
        "2026-01-01",
        "2026-02-28",
        JSON.stringify(m),
        JSON.stringify(a),
        JSON.stringify(t),
      ])
    ).rows[0].r;
  try {
    await command({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === fixtureAccountId(1) ? "bank" : "none",
      })),
    });
    for (const [date, amount, other] of [
      ["2025-12-31", "10000", 5],
      ["2026-01-10", "20000", 5],
      ["2026-01-20", "-5000", 6],
      ["2026-02-10", "30000", 5],
      ["2026-02-20", "-15000", 6],
    ] as const) {
      const id = randomUUID();
      await command({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: date,
        memo: "Historical control fixture",
        lines: [
          { account_id: fixtureAccountId(1), amount_cents: amount, memo: "" },
          {
            account_id: fixtureAccountId(other),
            amount_cents: (-BigInt(amount)).toString(),
            memo: "",
          },
        ],
      });
      await command({ type: "entry.post", id, expected_version: 1 });
    }
    check((await preview()).ready, false);
    await command({
      type: "year.configure",
      id: randomUUID(),
      year: 2026,
      classification: "s_corp",
      expected_revision: await revision(),
    });
    check((await preview()).ready, true);
    check((await preview()).partial_year, true);
    check(
      (
        await preview([
          { ...monthly[0], income_cents: "19000" },
          { ...monthly[1], income_cents: "31000" },
        ])
      ).ready,
      false,
    );
    check((await preview(monthly, accounts.slice(1))).ready, false);
    check(
      (
        await preview(monthly, accounts, {
          ...totals,
          equity_total_cents: "30000",
        })
      ).ready,
      false,
    );
    await assert.rejects(
      preview(monthly, [...accounts, accounts[0]]),
      /ACCT_DUPLICATE_CONTROL/,
    );
    checks++;
    const doc = randomUUID();
    await command({
      type: "document.prepare",
      id: doc,
      original_name: "independent-control-report.csv",
      content_hash: "b".repeat(64),
      mime_type: "text/csv",
      size_bytes: "10",
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [`${doc}/${"b".repeat(64)}`],
    );
    await command({ type: "document.complete", id: doc, expected_version: 1 });
    const verify = {
      type: "history.verify",
      id: randomUUID(),
      expected_revision: await revision(),
      from: "2026-01-01",
      to: "2026-02-28",
      cash_basis_confirmed: true,
      document_id: doc,
      monthly,
      accounts,
      totals,
      reason: "Independent monthly P&L and balance sheet controls agree",
    };
    const key = randomUUID();
    check(await command(verify, key), await command(verify, key));
    await command({
      type: "history.lock",
      id: randomUUID(),
      history_id: verify.id,
      expected_revision: await revision(),
    });
    check(
      (
        await db.query<{ r: { periods: { is_locked: boolean }[] } }>(
          "SELECT acct_period_impact('2026-01-01') r",
        )
      ).rows[0].r.periods.length,
      2,
    );
    await command({
      type: "period.reopen",
      id: randomUUID(),
      month: "2026-01-01",
      expected_revision: await revision(),
      reason: "Review a historical correction",
    });
    const late = randomUUID();
    await command({
      type: "draft.save",
      id: late,
      expected_version: 0,
      entry_date: "2026-01-25",
      memo: "Later dated correction",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "1", memo: "" },
        { account_id: fixtureAccountId(5), amount_cents: "-1", memo: "" },
      ],
    });
    await command({ type: "entry.post", id: late, expected_version: 1 });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query(
          "SELECT check_id FROM acct_history_invalidations WHERE check_id=$1",
          [verify.id],
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      db.query("DELETE FROM acct_history_checks WHERE id=$1", [verify.id]),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE anon");
    await assert.rejects(preview(), /permission denied/);
    checks++;
    console.log(`Historical parity controls: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
