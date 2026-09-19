import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
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
    const refused = async (c: any, code: string) => {
      await assert.rejects(cmd(c), (e: Error) => e.message.includes(code));
      checks++;
    };
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
          "SELECT accounting.workspace('2026-01-01','2026-12-31','working') r",
        )
      ).rows[0].r;
    const chart = (await workspace()).accounts as any[];
    const purpose = (p: string) =>
      chart.find((a) => (a.system_purpose ?? a.purpose) === p).id as string;
    const transit = purpose("transfers_in_transit");
    const software = chart.find((a) => a.name === "Software").id as string;

    const connection = randomUUID();
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic bank",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    const feeds = {
      checking: account(1),
      card: account(3),
      savings: account(9),
    };
    for (const [name, id] of Object.entries(feeds))
      await cmd({
        type: "feed.map",
        id: randomUUID(),
        expected_version: 0,
        account_id: id,
        connection_id: connection,
        provider_account_id: JSON.stringify(["synthetic", name]).replace(
          ",",
          ", ",
        ),
        coverage_from: "2026-01-01",
        movement_sign: 1,
        institution: "Northwind",
        mask: id.slice(-4),
      });
    let serial = 0;
    /** One feed run: `[feed, date, cents, description]` per movement. */
    const sync = async (
      movements: [keyof typeof feeds, string, number, string][],
    ) => {
      await db.exec("RESET ROLE; SET ROLE service_role");
      const run = randomUUID();
      const call = async (c: any) =>
        (
          await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [
            JSON.stringify({ id: connection, run_id: run, ...c }),
          ])
        ).rows[0].r;
      assert.equal((await call({ action: "lease" })).acquired, true);
      const result = await call({
        action: "complete",
        through: 1800000000,
        create_drafts: true,
        accounts: Object.keys(feeds).map((name) => ({
          provider_connection_id: "synthetic",
          provider_account_id: name,
          currency: "USD",
          name: `Synthetic ${name}`,
          institution: "Northwind",
          balance_cents: "10000",
          balance_at: Date.parse("2026-09-20T18:00:00Z") / 1000,
          complete: true,
          transactions: movements
            .filter((m) => m[0] === name)
            .map(([, date, cents, description]) => {
              serial++;
              return {
                external_id: `SYN-${serial}`,
                posted: Date.parse(`${date}T18:00:00Z`) / 1000,
                amount_cents: String(cents),
                description,
                state: "posted",
                hash: serial.toString(16).padStart(64, "0"),
                raw: { synthetic: true },
              };
            }),
        })),
      });
      await db.exec("RESET ROLE; SET ROLE authenticated");
      return result;
    };
    const entries = async () =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.transactions('{}','{\"limit\":100}') r",
        )
      ).rows[0].r.entries as any[];
    const byMemo = async (memo: string) => {
      const found = (await entries()).filter(
        (e) => e.source_description === memo,
      );
      assert.equal(found.length, 1, `one entry for ${memo}`);
      return found[0];
    };
    const category = (e: any) =>
      e.lines.find((l: any) => !Object.values(feeds).includes(l.account_id))
        .account_id;

    // 1. Keyword signal. The first leg waits alone; the second arrival pairs both.
    await sync([["card", "2026-09-17", 3164, "AUTOPAY PAYMENT - THANK YOU"]]);
    let card = await byMemo("AUTOPAY PAYMENT - THANK YOU");
    check(card.pair_entry_id, null);
    check(card.transfer_suggestion, undefined);
    await sync([
      [
        "checking",
        "2026-09-18",
        -3164,
        "Online Transfer / Payment: Debit to CARDCO EPAYMENT",
      ],
    ]);
    card = await byMemo("AUTOPAY PAYMENT - THANK YOU");
    let checking = await byMemo(
      "Online Transfer / Payment: Debit to CARDCO EPAYMENT",
    );
    check(card.pair_entry_id, checking.id);
    check(checking.pair_entry_id, card.id);
    check([card.kind, checking.kind], ["transfer", "transfer"]);
    check([card.status, checking.status], ["draft", "draft"]);
    check([category(card), category(checking)], [transit, transit]);
    check(card.fill, {
      source: "transfer_pair",
      pair_entry_date: "2026-09-18",
      pair_account_id: feeds.checking,
    });
    check(checking.fill.pair_account_id, feeds.card);
    check([card.matches.length, checking.matches.length], [1, 1]);
    check(
      card.audit.find((a: any) => a.action === "transfer.paired").after.signal,
      "keyword",
    );
    // A proposed pair is a balance sheet movement: nothing in income or expenses.
    let books = await workspace();
    check(
      [books.reports.income_cents, books.reports.expense_cents],
      ["0", "0"],
    );

    // 2. One leg can never leave draft alone.
    await refused(
      { type: "entry.post", id: card.id, expected_version: card.version },
      "ACCT_TRANSFER_PAIR_CONFIRM",
    );
    await refused(
      {
        type: "entry.review",
        id: checking.id,
        expected_version: checking.version,
        reviewed: true,
      },
      "ACCT_TRANSFER_PAIR_CONFIRM",
    );
    await refused(
      {
        type: "entry.bulkpost",
        id: randomUUID(),
        entries: [{ id: card.id, expected_version: card.version }],
      },
      "ACCT_TRANSFER_PAIR_CONFIRM",
    );
    await refused(
      {
        type: "transfer.confirm",
        id: card.id,
        expected_version: card.version + 1,
      },
      "ACCT_STALE_VERSION",
    );

    // 3. Confirm posts both legs as one transfer and keeps the bank evidence.
    const confirmed = await cmd({
      type: "transfer.confirm",
      id: checking.id,
      expected_version: checking.version,
    });
    card = await byMemo("AUTOPAY PAYMENT - THANK YOU");
    checking = await byMemo(
      "Online Transfer / Payment: Debit to CARDCO EPAYMENT",
    );
    check([card.status, checking.status], ["posted", "posted"]);
    check(card.transfer_group_id, confirmed.transfer_group_id);
    check(checking.transfer_group_id, confirmed.transfer_group_id);
    check([card.pair_entry_id, card.fill_source], [null, null]);
    check([card.restore_workflow, card.matches.length], ["transfer", 1]);
    // Either posted leg names the own account on the other side.
    check(
      [card.transfer_account_id, checking.transfer_account_id],
      [feeds.checking, feeds.card],
    );
    books = await workspace();
    check(
      books.balances.find((b: any) => b.id === transit)?.ending_cents ?? "0",
      "0",
    );
    check(
      [books.reports.income_cents, books.reports.expense_cents],
      ["0", "0"],
    );
    await refused(
      {
        type: "transfer.confirm",
        id: checking.id,
        expected_version: checking.version,
      },
      "ACCT_TRANSFER_NOT_PAIRED",
    );

    // 4. Learned signal: next month's same two descriptors pair on history, ahead of the keyword.
    await sync([
      ["card", "2026-10-17", 4410, "AUTOPAY PAYMENT - THANK YOU"],
      [
        "checking",
        "2026-10-18",
        -4410,
        "Online Transfer / Payment: Debit to CARDCO EPAYMENT",
      ],
    ]);
    const october = (await entries()).filter(
      (e) => e.entry_date.startsWith("2026-10") && e.pair_entry_id,
    );
    check(october.length, 2);
    check(
      october[0].audit.find((a: any) => a.action === "transfer.paired").after
        .signal,
      "learned",
    );
    // A confirmed transfer never becomes "what you chose last time" for its descriptor.
    check(october[0].fill.source, "transfer_pair");

    // 5. Bank text naming the other account's institution.
    await sync([
      ["checking", "2026-09-10", -7000, "NORTHWIND SAVE 4471"],
      ["savings", "2026-09-10", 7000, "DEPOSIT 4471"],
    ]);
    const named = await byMemo("DEPOSIT 4471");
    check(
      named.audit.find((a: any) => a.action === "transfer.paired").after.signal,
      "names_account",
    );

    // 6. The gate alone only suggests.
    await sync([
      ["checking", "2026-09-03", -1111, "WEB ITEM 88"],
      ["savings", "2026-09-05", 1111, "DEPOSIT 88"],
    ]);
    const bland = await byMemo("WEB ITEM 88");
    const blandOther = await byMemo("DEPOSIT 88");
    check([bland.pair_entry_id, bland.fill], [null, undefined]);
    check(bland.transfer_suggestion, {
      counterpart_id: blandOther.id,
      account_id: feeds.savings,
      entry_date: "2026-09-05",
      ambiguous: false,
      signal: null,
    });

    // 7. Two candidates pair nothing, even with a keyword, and say so.
    await sync([
      ["checking", "2026-09-11", -5000, "ONLINE TRANSFER A"],
      ["checking", "2026-09-12", -5000, "ONLINE TRANSFER B"],
      ["savings", "2026-09-12", 5000, "ONLINE TRANSFER IN"],
    ]);
    for (const memo of [
      "ONLINE TRANSFER A",
      "ONLINE TRANSFER B",
      "ONLINE TRANSFER IN",
    ]) {
      const e = await byMemo(memo);
      check([memo, e.pair_entry_id], [memo, null]);
      check([memo, e.transfer_suggestion.ambiguous], [memo, true]);
    }

    // 8. Outside the window is not a candidate at all.
    await sync([
      ["checking", "2026-09-01", -2222, "TRANSFER OUT 2222"],
      ["savings", "2026-09-09", 2222, "TRANSFER IN 2222"],
    ]);
    check((await byMemo("TRANSFER OUT 2222")).transfer_suggestion, undefined);

    // 9. A known treatment wins over pairing, and the fill says where it came from.
    await sync([["checking", "2026-08-04", -900, "POS TOOLCO #11111"]]);
    const first = await byMemo("POS TOOLCO #11111");
    const chosen = await cmd({
      type: "entry.categorize",
      id: first.id,
      expected_version: first.version,
      account_id: software,
    });
    await cmd({
      type: "entry.post",
      id: first.id,
      expected_version: chosen.version,
    });
    await sync([
      ["checking", "2026-09-14", -900, "POS TOOLCO #22222"],
      ["savings", "2026-09-14", 900, "ONLINE TRANSFER 900"],
    ]);
    let tool = await byMemo("POS TOOLCO #22222");
    check([tool.fill_source, tool.fill], ["prior", { source: "prior" }]);
    check([category(tool), tool.pair_entry_id], [software, null]);
    check((await byMemo("ONLINE TRANSFER 900")).pair_entry_id, null);
    // The owner choosing a category makes it theirs: the marker goes.
    await cmd({
      type: "entry.categorize",
      id: tool.id,
      expected_version: tool.version,
      account_id: software,
    });
    tool = await byMemo("POS TOOLCO #22222");
    check([tool.fill_source, tool.fill], [null, undefined]);

    // 10. Not a transfer: both legs go back and are never proposed again.
    await sync([
      ["checking", "2026-09-15", -6100, "ONLINE TRANSFER 6100"],
      ["savings", "2026-09-15", 6100, "DEPOSIT 6100"],
    ]);
    let out = await byMemo("ONLINE TRANSFER 6100");
    check(out.pair_entry_id, (await byMemo("DEPOSIT 6100")).id);
    await cmd({
      type: "transfer.unpair",
      id: out.id,
      expected_version: out.version,
    });
    out = await byMemo("ONLINE TRANSFER 6100");
    const back = await byMemo("DEPOSIT 6100");
    check([out.pair_entry_id, back.pair_entry_id], [null, null]);
    check([out.kind, back.kind], ["expense", "income"]);
    check(
      [category(out), category(back)],
      [purpose("uncategorized_expense"), purpose("uncategorized_income")],
    );
    check([out.fill_source, out.matches.length], [null, 1]);
    check(
      [out.transfer_suggestion, back.transfer_suggestion],
      [undefined, undefined],
    );

    // 11. Categorizing one leg frees the other.
    await sync([
      ["checking", "2026-09-16", -7300, "ONLINE TRANSFER 7300"],
      ["savings", "2026-09-16", 7300, "DEPOSIT 7300"],
    ]);
    let leg = await byMemo("ONLINE TRANSFER 7300");
    check(leg.pair_entry_id !== null, true);
    await cmd({
      type: "entry.categorize",
      id: leg.id,
      expected_version: leg.version,
      account_id: software,
      kind: "expense",
    });
    leg = await byMemo("ONLINE TRANSFER 7300");
    let freed = await byMemo("DEPOSIT 7300");
    check(
      [category(leg), leg.pair_entry_id, leg.kind],
      [software, null, "expense"],
    );
    check(
      [category(freed), freed.pair_entry_id, freed.kind],
      [purpose("uncategorized_income"), null, "income"],
    );

    // 12. Discarding one leg frees the other.
    await sync([
      ["checking", "2026-09-19", -8400, "ONLINE TRANSFER 8400"],
      ["savings", "2026-09-19", 8400, "DEPOSIT 8400"],
    ]);
    leg = await byMemo("ONLINE TRANSFER 8400");
    await cmd({
      type: "entry.discard",
      id: leg.id,
      expected_version: leg.version,
      reason: "Synthetic duplicate",
    });
    freed = await byMemo("DEPOSIT 8400");
    check(
      [category(freed), freed.pair_entry_id],
      [purpose("uncategorized_income"), null],
    );

    console.log(
      `Transfer pairing, signals, confirm, unpair and fill markers: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
