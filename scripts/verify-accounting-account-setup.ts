import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { extendedCommandSchema } from "../src/lib/accounting/workflows";
import { statementCents } from "../src/lib/accounting/statement-money";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const equal = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const fail = async (work: () => Promise<unknown>, error: RegExp) => {
    await assert.rejects(work, error);
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  const count = async (id: string) =>
    (
      await db.query<{ r: { accounts: { id: string }[] } }>(
        "SELECT accounting.workspace('2026-01-01','2026-08-31') r",
      )
    ).rows[0].r.accounts.filter((a) => a.id === id).length;
  const make = (overrides: object = {}) => ({
    type: "account.create",
    id: randomUUID(),
    name: "Synthetic new account",
    code: randomUUID().slice(0, 8),
    account_type: "asset",
    normal_side: "debit",
    cash_kind: "bank",
    purpose: null,
    parent_account_id: null,
    subtype: "bank",
    ...overrides,
  });
  try {
    const first = make(),
      key = randomUUID();
    equal(extendedCommandSchema.safeParse(first).success, true);
    const result = await cmd(first, key);
    equal(result, { id: first.id, version: 1 });
    equal(await cmd(first, key), result);
    equal(
      (
        await db.query<{ r: any }>(
          "SELECT accounting.workspace('2026-01-01','2026-08-31') r",
        )
      ).rows[0].r.accounts.find((a: any) => a.id === first.id).cash_kind,
      "bank",
    );
    const card = make({
      account_type: "liability",
      normal_side: "credit",
      cash_kind: "card",
      purpose: null,
      subtype: "card",
    });
    await cmd(card);
    equal(await count(card.id), 1);
    for (const bad of [
      make({ normal_side: "credit" }),
      make({ account_type: "expense" }),
      make({ cash_kind: "card", subtype: "card" }),
      make({ subtype: "loan" }),
      make({ parent_account_id: card.id }),
    ]) {
      await fail(
        () => cmd(bad),
        /ACCT_ACCOUNT_KIND|ACCT_INVALID_ACCOUNT_PARENT/,
      );
      equal(await count(bad.id), 0);
    }
    const used = make({
      account_type: "expense",
      cash_kind: "none",
      purpose: "new_expense",
      subtype: "operating_expense",
    });
    await cmd(used);
    const entry = randomUUID();
    await cmd({
      type: "draft.save",
      id: entry,
      expected_version: 0,
      entry_date: "2026-01-01",
      memo: "Synthetic purpose protection",
      lines: [
        { account_id: first.id, amount_cents: "-1", memo: "" },
        { account_id: used.id, amount_cents: "1", memo: "" },
      ],
    });
    await fail(
      () =>
        cmd({
          type: "account.update",
          id: used.id,
          expected_version: 1,
          name: used.name,
          code: used.code,
          cash_kind: "none",
          purpose: null,
          parent_account_id: null,
          subtype: "",
          is_archived: false,
        }),
      /ACCT_SYSTEM_ACCOUNT/,
    );
    await fail(
      () => cmd({ ...first, name: "Changed payload" }, key),
      /ACCT_IDEMPOTENCY_CONFLICT/,
    );
    for (const raw of [
      "0",
      "12000",
      "-12000",
      "9007199254740993",
      "-9007199254740993",
    ]) {
      equal(statementCents(statementCents(raw, true), true), raw);
      equal(statementCents(raw, false), raw);
    }
    equal(statementCents("-16000", true), "16000");
    equal(statementCents("16000", true), "-16000");
    await db.exec(
      "RESET ROLE; SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false); SET ROLE authenticated",
    );
    await fail(() => cmd(make()), /ACCT_FORBIDDEN/);
    console.log(
      `Account setup: ${checks} assertions passed (atomic profiles, rollback, replay, identity and exact statement signs).`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
