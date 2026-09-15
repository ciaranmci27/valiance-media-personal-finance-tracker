import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import { presentTransaction } from "../src/lib/accounting/transactions";
import {
  entryMatchesSearch,
  parseSearchTerms,
  type SearchLookups,
} from "../src/lib/accounting/search";
import type { JournalEntry } from "../src/lib/accounting/contracts";
import type { AccountProfile } from "../src/lib/accounting/workflows";

/**
 * The ledger search: the tokenizer, then every kind of term against a small
 * seeded ledger, in the database and in the TypeScript mirror the demo books
 * use, which must agree on every query.
 */
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown, label?: string) => {
    assert.deepEqual(a, b, label);
    checks++;
  };
  const read = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, args)).rows[0].r;
  const cmd = (c: object, key = randomUUID()) =>
    read<{ id: string; version: number }>(
      "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
      [key, JSON.stringify(c)],
    );
  try {
    // The tokenizer on its own.
    await db.exec("RESET ROLE");
    const terms = async (query: string) =>
      (
        await db.query<{
          kind: string;
          pattern: string;
          cents: string | null;
          op: string | null;
        }>(
          "SELECT kind,pattern,cents::text cents,op FROM accounting.search_terms($1)",
          [query],
        )
      ).rows;
    check(await terms("Uber Eats"), [
      { kind: "text", pattern: "uber", cents: null, op: null },
      { kind: "text", pattern: "eats", cents: null, op: null },
    ]);
    const digits = (number: string) =>
      `(^|[^0-9])${number.replace(".", "\\.")}([^0-9]|$)`;
    check(await terms('"uber eats" 42.75'), [
      { kind: "text", pattern: "uber eats", cents: null, op: null },
      { kind: "amount", pattern: digits("42.75"), cents: "4275", op: null },
    ]);
    check(await terms("$1,234.5 -42 >100 <=2,000"), [
      { kind: "amount", pattern: digits("1234.5"), cents: "123450", op: null },
      { kind: "dollars", pattern: digits("42"), cents: "4200", op: null },
      { kind: "compare", pattern: digits("100"), cents: "10000", op: ">" },
      { kind: "compare", pattern: digits("2000"), cents: "200000", op: "<=" },
    ]);
    check(await terms("100% a_b back\\slash"), [
      { kind: "text", pattern: "100\\%", cents: null, op: null },
      { kind: "text", pattern: "a\\_b", cents: null, op: null },
      { kind: "text", pattern: "back\\\\slash", cents: null, op: null },
    ]);
    check(await terms('  "" "  " 4242424242424242'), [
      { kind: "text", pattern: "4242424242424242", cents: null, op: null },
    ]);
    check((await terms("")).length, 0);
    check((await terms("a b c d e f g h i j k l m n")).length, 12);
    // The mirror tokenizes the same way (its text is unescaped).
    check(parseSearchTerms('"uber eats" $1,234.5 -42 >100 <=2,000 100%'), [
      { kind: "text", text: "uber eats" },
      { kind: "amount", text: "1234.5", cents: BigInt(123450) },
      { kind: "dollars", text: "42", cents: BigInt(4200) },
      { kind: "compare", text: "100", cents: BigInt(10000), op: ">" },
      { kind: "compare", text: "2000", cents: BigInt(200000), op: "<=" },
      { kind: "text", text: "100%" },
    ]);
    check(parseSearchTerms("a b c d e f g h i j k l m n").length, 12);

    // A small ledger: a card purchase with a contact, a checking subscription
    // with a line memo, and a client deposit. Checking has a bank feed mask.
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind:
          a.id === fixtureAccountId(1)
            ? "bank"
            : a.id === fixtureAccountId(3)
              ? "card"
              : "none",
      })),
    });
    const uber = await cmd({
      type: "party.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Uber Technologies",
      kind: "vendor",
    });
    await db.exec("RESET ROLE");
    await db.query(
      "INSERT INTO accounting.bank_accounts(account_id,institution,mask) VALUES($1,'Chase','4242')",
      [fixtureAccountId(1)],
    );
    await db.exec("SET ROLE authenticated");
    const review = (
      memo: string,
      entry_date: string,
      lines: { account_id: string; amount_cents: string; memo?: string }[],
      extra: Record<string, unknown> = {},
    ) =>
      cmd({
        type: "transaction.review",
        id: randomUUID(),
        expected_version: 0,
        entry_date,
        memo,
        context: { kind: "expense", ...(extra.context as object) },
        lines: lines.map((l) => ({ memo: "", ...l })),
        ...extra,
      });
    const a = await review(
      "UBER *EATS SF",
      "2026-06-01",
      [
        { account_id: fixtureAccountId(3), amount_cents: "-4275" },
        { account_id: fixtureAccountId(6), amount_cents: "4275" },
      ],
      {
        source_description: "UBER *EATS 8005928996 CA",
        context: { kind: "expense", payee_id: uber.id },
      },
    );
    const b = await review("Notion subscription", "2026-05-15", [
      { account_id: fixtureAccountId(1), amount_cents: "-123456" },
      {
        account_id: fixtureAccountId(6),
        amount_cents: "123456",
        memo: "Team plan",
      },
    ]);
    const c = await review(
      "Client payment 100% deposit",
      "2026-04-02",
      [
        { account_id: fixtureAccountId(1), amount_cents: "250000" },
        { account_id: fixtureAccountId(5), amount_cents: "-250000" },
      ],
      { context: { kind: "income" } },
    );
    const A = a.id,
      B = b.id,
      C = c.id;

    const everything = await read<{ entries: JournalEntry[]; total: number }>(
      "SELECT accounting.transactions('{}') r",
    );
    check(everything.total, 3);
    const found = async (query: string, filter: object = {}) => {
      const page = await read<{ entries: JournalEntry[]; total: number }>(
        "SELECT accounting.transactions($1) r",
        [JSON.stringify({ query, ...filter })],
      );
      check(page.entries.length, page.total, `count for ${query}`);
      return page.entries.map((e) => e.id).sort();
    };
    const ids = (...list: string[]) => [...list].sort();

    // The TypeScript mirror, fed the same lookups the database joins.
    const profiles: AccountProfile[] = fixtureAccounts.map((account) => ({
      account_id: account.id,
      version: 1,
      purpose: null,
      cash_kind:
        account.id === fixtureAccountId(1)
          ? "bank"
          : account.id === fixtureAccountId(3)
            ? "card"
            : "none",
      parent_account_id: null,
      subtype: "",
    }));
    const lookups: SearchLookups = {
      partyName: (id) => (id === uber.id ? "Uber Technologies" : undefined),
      account: (id) => fixtureAccounts.find((account) => account.id === id),
      bankLabel: (id) =>
        id === fixtureAccountId(1) ? "Chase 4242" : undefined,
    };
    const mirrored = (query: string) =>
      everything.entries
        .filter((entry) =>
          entryMatchesSearch(
            entry,
            parseSearchTerms(query),
            lookups,
            presentTransaction(entry, profiles).amount,
          ),
        )
        .map((entry) => entry.id)
        .sort();

    const cases: [string, string[]][] = [
      // Words, in any order; a quoted phrase in that order only.
      ["uber eats", ids(A)],
      ["eats uber", ids(A)],
      ['"eats uber"', []],
      ['"uber *eats"', ids(A)],
      ["UBER", ids(A)],
      ["8005928996", ids(A)],
      // Amounts: exact cents, whole dollars, with or without $ and commas.
      ["42.75", ids(A)],
      ["$42.75", ids(A)],
      ["42", ids(A)],
      ["43", []],
      ["1,234.56", ids(B)],
      ["1234.56", ids(B)],
      ["1234", ids(B)],
      ["$1,234", ids(B)],
      ["2500", ids(C)],
      // The card mask and institution behind a cash account.
      ["4242", ids(B, C)],
      ["chase", ids(B, C)],
      ["chase 4242", ids(B, C)],
      // The contact, the category and a line memo.
      ["uber technologies", ids(A)],
      ["technologies", ids(A)],
      ["software", ids(A, B)],
      ["consulting", ids(C)],
      ["team plan", ids(B)],
      ['"team plan"', ids(B)],
      // Dates in the spellings the ledger shows.
      ["2026-05-15", ids(B)],
      ["may 15", ids(B)],
      ["may 15, 2026", ids(B)],
      ['"may 15, 2026"', ids(B)],
      ["5/15/2026", ids(B)],
      ["june", ids(A)],
      ["2026", ids(A, B, C)],
      // Comparisons against the row's amount, combined with words.
      [">1000", ids(B, C)],
      ["<100", ids(A)],
      [">=2500", ids(C)],
      ["<=42.75", ids(A)],
      [">100 <2000", ids(B)],
      ["software >100", ids(B)],
      ["software <100", ids(A)],
      // The kind of movement.
      ["income", ids(C)],
      ["expense", ids(A, B)],
      // LIKE wildcards are plain text.
      ["100%", ids(C)],
      ["%", ids(C)],
      ["_", []],
      // Every term must match; blank searches match everything.
      ["notion 2500", []],
      ["   ", ids(A, B, C)],
      ['""', ids(A, B, C)],
    ];
    for (const [query, expected] of cases) {
      check(await found(query), expected, `database: ${query}`);
      check(mirrored(query), expected, `mirror: ${query}`);
    }
    // Search composes with the structured filters.
    check(await found("software", { account: fixtureAccountId(1) }), ids(B));
    check(await found("software", { min_cents: "100000" }), ids(B));
    check(await found("software", { from: "2026-06-01" }), ids(A));
    console.log(`Transaction search: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
