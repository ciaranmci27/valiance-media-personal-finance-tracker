import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The one-off backfill lives only in its migration, between two markers; the suite runs that exact SQL. */
async function backfillSql() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = (await readdir(dir)).find((f) =>
    f.endsWith("_accounting_transfer_pairing.sql"),
  );
  assert.ok(file, "transfer pairing migration");
  const sql = (await readFile(new URL(file, dir), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const start = sql.indexOf("-- >>> transfer link backfill");
  const end = sql.indexOf("-- <<< transfer link backfill");
  assert.ok(start >= 0 && end > start, "backfill markers");
  return sql.slice(start, end);
}

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, note?: string) => {
    assert.deepEqual(actual, expected, note);
    checks++;
  };
  try {
    const cmd = async (c: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key: randomUUID(), command: c }),
        ])
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: [1, 9].some((n) => account(n) === a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      });
    const workspace = async () =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.workspace('2026-01-01','2026-12-31') r",
        )
      ).rows[0].r;
    const transit = ((await workspace()).accounts as any[]).find(
      (a) => (a.system_purpose ?? a.purpose) === "transfers_in_transit",
    ).id as string;
    const [checking, card, savings] = [account(1), account(3), account(9)];
    // Account numbers the bank text can name: 0001 checking, 0003 card, 0009 savings.
    const connection = randomUUID();
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic bank",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    for (const id of [checking, card, savings])
      await cmd({
        type: "feed.map",
        id: randomUUID(),
        expected_version: 0,
        account_id: id,
        connection_id: connection,
        provider_account_id: JSON.stringify(["synthetic", id]).replace(
          ",",
          ", ",
        ),
        coverage_from: "2020-01-01",
        movement_sign: 1,
        mask: id.slice(-4),
      });

    /** One side of a transfer as Wave history holds it: a posted entry against the in-transit account. */
    const leg = async (
      bank: string,
      date: string,
      cents: number,
      memo = `Imported transfer ${date} ${cents}`,
    ) => {
      const id = randomUUID();
      const saved = await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: date,
        memo,
        origin: "wave",
        lines: [
          { account_id: bank, amount_cents: String(cents) },
          { account_id: transit, amount_cents: String(-cents) },
        ],
      });
      await cmd({ type: "entry.post", id, expected_version: saved.version });
      return id;
    };
    // One candidate each way.
    const aOut = await leg(checking, "2026-03-01", -50000);
    const aIn = await leg(savings, "2026-03-02", 50000);
    // Twins between the same two accounts: date order decides.
    const b1Out = await leg(checking, "2026-04-01", -20000);
    const b1In = await leg(card, "2026-04-02", 20000);
    const b2Out = await leg(checking, "2026-04-03", -20000);
    const b2In = await leg(card, "2026-04-04", 20000);
    // Same amount toward two different accounts: a wrong link would mislabel a row, so none.
    const cLegs = [
      await leg(checking, "2026-05-01", -30000),
      await leg(checking, "2026-05-02", -30000),
      await leg(savings, "2026-05-02", 30000),
      await leg(card, "2026-05-03", 30000),
    ];
    // Outside the window, and a side with no counterpart.
    const dLegs = [
      await leg(checking, "2026-06-01", -70000),
      await leg(savings, "2026-06-20", 70000),
      await leg(checking, "2026-07-01", -1234),
    ];
    // A chain through one account: the bank text names the account numbers, which settles the first hop and leaves the second with one candidate.
    const eOut = await leg(
      checking,
      "2026-08-28",
      -20783,
      "Transfer to Checking *0009",
    );
    const eIn = await leg(
      savings,
      "2026-08-28",
      20783,
      "Received from Checking *0001",
    );
    const eOut2 = await leg(
      savings,
      "2026-08-27",
      -20783,
      "Debit to CARD EPAYMENT",
    );
    const eIn2 = await leg(
      card,
      "2026-08-26",
      20783,
      "AUTOPAY PAYMENT - THANK YOU",
    );
    // Two identical payments into one card on one day, from two accounts: the twins are interchangeable.
    const fLegs = [
      await leg(
        checking,
        "2026-09-14",
        -26390,
        "Online Transfer / Payment: Debit",
      ),
      await leg(
        savings,
        "2026-09-14",
        -26390,
        "Online Transfer / Payment: Debit",
      ),
      await leg(card, "2026-09-13", 26390, "AUTOPAY PAYMENT - THANK YOU"),
      await leg(card, "2026-09-13", 26390, "AUTOPAY PAYMENT - THANK YOU"),
    ];
    // Two identical debits from one account on one day, to two accounts.
    const gLegs = [
      await leg(
        checking,
        "2026-10-18",
        -20000,
        "Online Transfer / Payment: Debit",
      ),
      await leg(
        checking,
        "2026-10-18",
        -20000,
        "Online Transfer / Payment: Debit",
      ),
      await leg(savings, "2026-10-17", 20000, "Payment Thank You-Mobile"),
      await leg(card, "2026-10-17", 20000, "Payment Thank You-Mobile"),
    ];
    const groups = async (ids: string[]) =>
      (
        await db.query<{ id: string; g: string | null }>(
          "SELECT id,transfer_group_id g FROM accounting.journal_entries WHERE id=ANY($1)",
          [ids],
        )
      ).rows;
    const groupOf = async (id: string) => (await groups([id]))[0].g;
    const everyone = [
      ...[aOut, aIn, b1Out, b1In, b2Out, b2In, eOut, eIn, eOut2, eIn2],
      ...cLegs,
      ...dLegs,
      ...fLegs,
      ...gLegs,
    ];
    const before = await workspace();

    await db.exec("RESET ROLE");
    await db.exec(await backfillSql());
    const run = async (apply: boolean) =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.transfer_link_backfill($1) r",
          [apply],
        )
      ).rows[0].r;

    // Preview reports exactly what apply would do and leaves nothing behind.
    const preview = await run(false);
    check(
      [
        preview.applied,
        preview.linked_one_candidate,
        preview.linked_named_account,
        preview.linked_same_day_twins,
        preview.linked_same_accounts_in_date_order,
        preview.left_unlinked,
      ],
      [false, 4, 1, 2, 2, 7],
    );
    check(preview.left_sample.length, 7);
    check((await groups(everyone)).filter((r) => r.g).length, 0);

    const applied = await run(true);
    check(
      [
        applied.applied,
        applied.linked_one_candidate,
        applied.linked_named_account,
        applied.linked_same_day_twins,
        applied.linked_same_accounts_in_date_order,
        applied.left_unlinked,
      ],
      [true, 4, 1, 2, 2, 7],
    );
    check((await groupOf(aOut)) !== null, true);
    check(await groupOf(aOut), await groupOf(aIn));
    check(await groupOf(b1Out), await groupOf(b1In));
    check(await groupOf(b2Out), await groupOf(b2In));
    check((await groupOf(b1Out)) !== (await groupOf(b2Out)), true);
    // The chain links hop by hop, never across it.
    check(await groupOf(eOut), await groupOf(eIn));
    check(await groupOf(eOut2), await groupOf(eIn2));
    check((await groupOf(eOut)) !== (await groupOf(eOut2)), true);
    // Twins: everyone linked, two distinct groups each, one out and one in per group.
    for (const set of [fLegs, gLegs]) {
      const g = (await groups(set)).map((r) => r.g);
      check(g.every(Boolean), true);
      check(new Set(g).size, 2);
      // The first two of each set are the money-out sides: one per group.
      check((await groupOf(set[0])) !== (await groupOf(set[1])), true);
    }
    check((await groups([...cLegs, ...dLegs])).filter((r) => r.g).length, 0);
    // Running it again finds nothing new.
    const again = await run(true);
    check(
      [again.linked_one_candidate, again.linked_same_accounts_in_date_order],
      [0, 0],
    );
    await db.exec(
      "DROP FUNCTION accounting.transfer_link_backfill(boolean); DROP FUNCTION accounting.transfer_link_legs(); SET ROLE authenticated",
    );

    // Each linked leg now names the other account; nothing financial moved.
    const detail = async (id: string) =>
      (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
        .rows[0].r;
    const out = await detail(aOut);
    check(
      [out.transfer_account_id, (await detail(aIn)).transfer_account_id],
      [savings, checking],
    );
    check((await detail(b2In)).transfer_account_id, checking);
    check([out.status, out.restore_workflow], ["posted", "transfer"]);
    check(
      out.audit.some((a: any) => a.action === "transfer.link"),
      true,
    );
    const after = await workspace();
    check(after.reports, before.reports);
    check(
      after.balances.map((b: any) => [b.id, b.ending_cents]),
      before.balances.map((b: any) => [b.id, b.ending_cents]),
    );

    console.log(
      `Imported transfer link backfill, preview and apply: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
