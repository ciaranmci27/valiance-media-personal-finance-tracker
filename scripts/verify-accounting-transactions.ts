import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import {
  presentTransaction,
  simpleTransactionLines,
} from "../src/lib/accounting/transactions";
import type {
  JournalEntry,
  AccountingAccount,
} from "../src/lib/accounting/contracts";
import type { AccountProfile } from "../src/lib/accounting/workflows";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const read = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, args)).rows[0].r;
  const cmd = (c: object, key = randomUUID()) =>
    read<{ id: string; version: number }>(
      "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
      [key, JSON.stringify(c)],
    );
  await db.exec("RESET ROLE");
  const uncategorized = (
    await db.query<{ id: string }>(
      "SELECT id FROM accounting.accounts WHERE system_purpose='uncategorized_expense'",
    )
  ).rows[0].id;
  await db.exec("SET ROLE authenticated");
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: [
        ...fixtureAccounts.map((a) => ({
          ...a,
          cash_kind:
            a.id === fixtureAccountId(1)
              ? "bank"
              : a.id === fixtureAccountId(3)
                ? "card"
                : "none",
        })),
      ],
    });
    const first = {
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-06-01",
      memo: "Synthetic expense",
      context: {
        kind: "expense",
        payment_rail: "card",
        contractor_treatment: "unreviewed",
        contractor_reason: "",
      },
      lines: [
        { account_id: fixtureAccountId(3), amount_cents: "-4275", memo: "" },
        { account_id: fixtureAccountId(6), amount_cents: "4275", memo: "" },
      ],
    };
    const key = randomUUID(),
      saved = await cmd(first, key);
    check(await cmd(first, key), saved);
    const entry = await read<JournalEntry>(
      "SELECT accounting.transactions($1)->'entries'->0 r",
      [JSON.stringify({ entry_id: saved.id })],
    );
    check(entry.status, "posted");
    check(entry.context?.kind, "expense");
    await assert.rejects(
      cmd({ ...first, memo: "Changed payload" }, key),
      /ACCT_IDEMPOTENCY_CONFLICT/,
    );
    checks++;
    const rejected = {
      ...first,
      id: randomUUID(),
      lines: [first.lines[0], { ...first.lines[1], account_id: uncategorized }],
    };
    await assert.rejects(cmd(rejected), /ACCT_CATEGORY_REQUIRED/);
    checks++;
    check(
      await read<number>(
        "SELECT (accounting.transactions($1)->>'total')::int r",
        [JSON.stringify({ entry_id: rejected.id })],
      ),
      0,
    );
    await assert.rejects(
      db.query("SELECT accounting.ledger_command($1)", [JSON.stringify(first)]),
      /permission denied/,
    );
    checks++;
    const draft = await cmd({
      ...first,
      type: "transaction.save",
      id: randomUUID(),
      memo: "A pending movement",
    });
    await cmd({
      ...first,
      id: draft.id,
      expected_version: draft.version,
      memo: "A reviewed movement",
    });
    await assert.rejects(
      cmd({ ...first, id: draft.id, expected_version: draft.version }),
      /ACCT_STALE_VERSION|ACCT_IMMUTABLE|ACCT_POSTED/,
    );
    checks++;
    const discarded = await cmd({
      ...first,
      type: "transaction.save",
      id: randomUUID(),
      context: undefined,
    });
    await cmd({
      type: "draft.discard",
      id: discarded.id,
      expected_version: discarded.version,
      reason: "Synthetic unused draft",
    });
    check(
      (
        await read<{ entries: JournalEntry[] }>(
          "SELECT accounting.transactions($1) r",
          [JSON.stringify({ entry_id: discarded.id })],
        )
      ).entries[0].status,
      "discarded",
    );
    const third = await cmd({
      ...first,
      id: randomUUID(),
      memo: "Largest transaction",
      entry_date: "2026-05-01",
      lines: first.lines.map((l) => ({
        ...l,
        amount_cents: l.amount_cents.startsWith("-") ? "-9900" : "9900",
      })),
    });
    const ordered = await read<{ entries: JournalEntry[]; total: number }>(
      "SELECT accounting.transactions($1) r",
      [JSON.stringify({ sort: "amount_desc", limit: 1 })],
    );
    check(ordered.total, 3);
    check(ordered.entries[0].id, third.id);
    const rest = await read<{ entries: JournalEntry[] }>(
      "SELECT accounting.transactions($1) r",
      [JSON.stringify({ sort: "amount_desc", offset: 1 })],
    );
    check(
      new Set([ordered.entries[0].id, ...rest.entries.map((e) => e.id)]).size,
      3,
    );
    check(
      (
        await read<{ entries: JournalEntry[] }>(
          "SELECT accounting.transactions($1) r",
          [JSON.stringify({ sort: "date_asc" })],
        )
      ).entries[0].id,
      third.id,
    );
    check(
      (
        await read<{ entries: JournalEntry[] }>(
          "SELECT accounting.transactions($1) r",
          [JSON.stringify({ sort: "description" })],
        )
      ).entries[0].memo,
      "A reviewed movement",
    );
    check(
      (
        await read<{ total: number }>("SELECT accounting.transactions($1) r", [
          JSON.stringify({ min_cents: "5000" }),
        ])
      ).total,
      1,
    );
    await assert.rejects(
      db.query("SELECT accounting.transactions($1)", [
        JSON.stringify({ sort: "random" }),
      ]),
      /ACCT_INVALID_FILTER/,
    );
    checks++;
    const accounts = fixtureAccounts.map((account) => ({
      ...account,
      is_archived: false,
      version: 1,
    })) as AccountingAccount[];
    const profiles: AccountProfile[] = accounts.map((a) => ({
      account_id: a.id,
      version: 1,
      purpose: null,
      cash_kind:
        a.id === fixtureAccountId(1)
          ? "bank"
          : a.id === fixtureAccountId(3)
            ? "card"
            : "none",
      parent_account_id: null,
      subtype: "",
    }));
    const view = presentTransaction(entry, profiles);
    check(view.amount, BigInt(-4275));
    check(view.editable, true);
    check(view.categorized, true);
    const split = simpleTransactionLines(
      {
        account: fixtureAccountId(1),
        direction: "out",
        amount: "10.01",
        splits: [
          { account: fixtureAccountId(6), amount: "4.01", memo: "A" },
          { account: fixtureAccountId(6), amount: "6", memo: "B" },
        ],
      },
      accounts,
      profiles,
    );
    check(
      split.map((l) => l.amount_cents),
      ["-1001", "401", "600"],
    );
    assert.throws(
      () =>
        simpleTransactionLines(
          {
            account: fixtureAccountId(1),
            direction: "out",
            amount: "10.01",
            splits: [{ account: fixtureAccountId(6), amount: "10", memo: "" }],
          },
          accounts,
          profiles,
        ),
      /equal/,
    );
    checks++;
    assert.throws(
      () =>
        simpleTransactionLines(
          {
            account: fixtureAccountId(1),
            direction: "out",
            amount: "10",
            splits: [{ account: fixtureAccountId(3), amount: "10", memo: "" }],
          },
          accounts,
          profiles,
        ),
      /Transfer/,
    );
    checks++;
    const transfer = {
      ...entry,
      lines: [
        {
          id: "a",
          account_id: fixtureAccountId(1),
          amount_cents: "-200",
          memo: "",
        },
        {
          id: "b",
          account_id: fixtureAccountId(3),
          amount_cents: "200",
          memo: "",
        },
      ],
    };
    check(presentTransaction(transfer, profiles).transfer, true);
    check(presentTransaction(transfer, profiles).movement, false);
    check(
      presentTransaction(transfer, profiles, fixtureAccountId(3)).amount,
      BigInt(200),
    );
    const fee = {
      ...entry,
      lines: [
        {
          id: "a",
          account_id: fixtureAccountId(1),
          amount_cents: "490000",
          memo: "",
        },
        {
          id: "b",
          account_id: fixtureAccountId(5),
          amount_cents: "-500000",
          memo: "",
        },
        {
          id: "c",
          account_id: fixtureAccountId(6),
          amount_cents: "10000",
          memo: "",
        },
      ],
    };
    check(presentTransaction(fee, profiles).editable, false);
    check(presentTransaction(fee, profiles).amount, BigInt(490000));
    console.log(
      `Transaction review, sorting, exact split and presentation: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
