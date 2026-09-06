import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db
        .query<{
          r: {
            id: string;
            outgoing_entry_id: string;
            incoming_entry_id: string;
          };
        }>("SELECT acct_operate($1,$2::jsonb) r", [key, JSON.stringify(c)])
        .catch((e) => {
          throw new Error(`${JSON.stringify(c)}: ${e.message}`);
        })
    ).rows[0].r;
  const rev = async () =>
    (
      await db.query<{ r: { revision: string } }>(
        "SELECT acct_close_history() r",
      )
    ).rows[0].r.revision;
  const balance = async (date: string) =>
    (
      await db.query<{
        r: {
          balances: { id: string; ending_cents: string }[];
          reports: { income_cents: string; expense_cents: string };
        };
      }>("SELECT acct_workspace($1,$2) r", ["2026-01-01", date])
    ).rows[0].r;
  const create = async (
    outgoing_date: string,
    incoming_date: string,
    to = 9,
  ) => ({
    type: "transfer.create",
    id: randomUUID(),
    expected_revision: await rev(),
    from_account_id: account(1),
    to_account_id: account(to),
    outgoing_date,
    incoming_date,
    amount_cents: "50000",
    memo: "Synthetic transfer",
  });
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: [1, 9].some((n) => account(n) === a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
        ...(a.id === account(2) ? { purpose: "transfers_in_transit" } : {}),
      })),
    });
    const same = await cmd(await create("2026-01-10", "2026-01-10"));
    check(same.outgoing_entry_id, same.incoming_entry_id);
    const crossCommand = await create("2026-01-31", "2026-02-02"),
      key = randomUUID(),
      cross = await cmd(crossCommand, key);
    check(await cmd(crossCommand, key), cross);
    check(
      (await balance("2026-01-31")).balances.find((a) => a.id === account(2))
        ?.ending_cents,
      "50000",
    );
    check(
      (await balance("2026-02-02")).balances.find((a) => a.id === account(2))
        ?.ending_cents,
      "0",
    );
    const clearing = (
      await db.query<{ r: { rows: { residual_cents: string }[] } }>(
        "SELECT acct_clearing_view($1,$2) r",
        ["2026-01-31", account(2)],
      )
    ).rows[0].r;
    check(
      clearing.rows.map((r) => r.residual_cents),
      ["50000"],
    );
    check(
      (
        await db.query<{ r: { rows: unknown[] } }>(
          "SELECT acct_clearing_view($1,$2) r",
          ["2026-02-02", account(2)],
        )
      ).rows[0].r.rows.length,
      0,
    );
    await cmd(await create("2026-03-02", "2026-02-28", 3));
    const early = await balance("2026-02-28");
    check(
      early.balances.find((a) => a.id === account(2))?.ending_cents,
      "-50000",
    );
    check(
      early.balances.find((a) => a.id === account(3))?.ending_cents,
      "50000",
    );
    check(early.reports.expense_cents, "0");
    const invalid = await create("2026-03-03", "2026-03-03");
    await assert.rejects(
      cmd({ ...invalid, to_account_id: account(5) }),
      /ACCT_BANK_ACCOUNT_REQUIRED/,
    );
    checks++;
    check((await balance("2026-03-03")).reports.income_cents, "0");
    await assert.rejects(
      cmd({
        type: "entry.reverse",
        id: cross.outgoing_entry_id,
        expected_version: 2,
        entry_date: "2026-01-31",
        reason: "A single-leg reversal must roll back",
      }),
      /ACCT_TRANSFER_REVERSE_TOGETHER/,
    );
    checks++;
    check(
      (await balance("2026-01-31")).balances.find((a) => a.id === account(2))
        ?.ending_cents,
      "50000",
    );
    await cmd({
      type: "transfer.reverse",
      id: cross.id,
      expected_revision: await rev(),
      outgoing_date: "2026-01-31",
      incoming_date: "2026-02-02",
      reason: "Reverse both original bank movements atomically",
    });
    check(
      (await balance("2026-01-31")).balances.find((a) => a.id === account(2))
        ?.ending_cents,
      "0",
    );
    const groups = (
      await db.query<{ r: { groups: { id: string; status: string }[] } }>(
        "SELECT acct_transfers_view($1,$2) r",
        ["2026-01-01", "2026-03-31"],
      )
    ).rows[0].r.groups;
    check(groups.find((g) => g.id === cross.id)?.status, "corrected");
    await assert.rejects(
      cmd({ ...crossCommand, id: randomUUID() }),
      /ACCT_STALE_VERSION/,
    );
    checks++;
    await assert.rejects(
      cmd({
        type: "transfer.link",
        id: randomUUID(),
        expected_revision: await rev(),
        from_account_id: account(1),
        to_account_id: account(9),
        outgoing_entry_id: same.outgoing_entry_id,
        incoming_entry_id: same.incoming_entry_id,
        amount_cents: "50000",
        memo: "Duplicate group",
      }),
      /ACCT_TRANSFER_ALREADY_LINKED/,
    );
    checks++;
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query("UPDATE acct_transfer_groups SET amount_cents=1 WHERE id=$1", [
        same.id,
      ]),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("SELECT acct_transfers_view($1,$2)", [
        "2026-01-01",
        "2026-03-31",
      ]),
      /permission denied/,
    );
    checks++;
    console.log(
      `Dated transfers, card payments, and atomic reversal: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
