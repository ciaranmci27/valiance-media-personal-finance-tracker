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
        }>(
          "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
          [key, JSON.stringify(c)],
        )
        .catch((e) => {
          throw new Error(`${JSON.stringify(c)}: ${e.message}`);
        })
    ).rows[0].r;
  const rev = async () =>
    (
      await db.query<{ r: { revision: string } }>(
        "SELECT accounting.workspace('2026-01-01','2026-03-31') r",
      )
    ).rows[0].r.revision;
  const balance = async (date: string) =>
    (
      await db.query<{
        r: {
          balances: { id: string; ending_cents: string }[];
          reports: { income_cents: string; expense_cents: string };
        };
      }>("SELECT accounting.workspace($1,$2) r", ["2026-01-01", date])
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
      })),
    });
    const transit = (
      await db.query<{ r: any }>(
        "SELECT accounting.workspace('2026-01-01','2026-03-31') r",
      )
    ).rows[0].r.accounts.find(
      (a: any) => a.purpose === "transfers_in_transit",
    ).id;
    const same = await cmd(await create("2026-01-10", "2026-01-10"));
    check(same.outgoing_entry_id, same.incoming_entry_id);
    const crossCommand = await create("2026-01-31", "2026-02-02"),
      key = randomUUID(),
      cross = await cmd(crossCommand, key);
    check(await cmd(crossCommand, key), cross);
    check(
      (await balance("2026-01-31")).balances.find((a) => a.id === transit)
        ?.ending_cents,
      "50000",
    );
    check(
      (await balance("2026-02-02")).balances.find((a) => a.id === transit)
        ?.ending_cents,
      "0",
    );
    await cmd(await create("2026-03-02", "2026-02-28", 3));
    const early = await balance("2026-02-28");
    check(early.balances.find((a) => a.id === transit)?.ending_cents, "-50000");
    check(
      early.balances.find((a) => a.id === account(3))?.ending_cents,
      "50000",
    );
    check(early.reports.expense_cents, "0");
    const invalid = await create("2026-03-03", "2026-03-03");
    await assert.rejects(
      cmd({ ...invalid, to_account_id: account(5) }),
      /ACCT_INVALID_TRANSFER/,
    );
    checks++;
    check((await balance("2026-03-03")).reports.income_cents, "0");
    await assert.rejects(
      cmd({
        type: "entry.reverse",
        id: cross.outgoing_entry_id,
        expected_version: (
          await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
            cross.outgoing_entry_id,
          ])
        ).rows[0].r.version,
        entry_date: "2026-01-31",
        reason: "A single-leg reversal must roll back",
      }),
      /ACCT_TRANSFER_REVERSE_TOGETHER/,
    );
    checks++;
    check(
      (await balance("2026-01-31")).balances.find((a) => a.id === transit)
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
      (await balance("2026-01-31")).balances.find((a) => a.id === transit)
        ?.ending_cents,
      "0",
    );
    check(
      Boolean(
        (
          await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
            cross.outgoing_entry_id,
          ])
        ).rows[0].r.reversed_by_entry_id,
      ),
      true,
    );
    await assert.rejects(
      cmd({ ...crossCommand, id: randomUUID() }),
      /ACCT_STALE_REVISION/,
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
      db.query(
        "UPDATE accounting.journal_entries SET transfer_group_id=gen_random_uuid() WHERE transfer_group_id=$1",
        [same.id],
      ),
      /ACCT_TRANSFER_GROUP_IMMUTABLE|ACCT_IMMUTABLE_TRANSFER/,
    );
    checks++;
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("SELECT accounting.workspace($1,$2)", [
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
