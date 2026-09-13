import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  try {
    const check = (a: unknown, b: unknown) => {
      assert.deepEqual(a, b);
      n++;
    };
    const cmd = async (command: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key: randomUUID(), command }),
        ])
      ).rows[0].r;
    const source = async () =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.tax_source(2026,'2026-08-31') r",
        )
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({ type: "account.create", ...a });
    const meals = randomUUID();
    await cmd({
      type: "account.create",
      id: meals,
      name: "Synthetic meals",
      account_type: "expense",
      expected_version: 0,
    });
    const post = async (date: string, lines: any[]) => {
      const d = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "Synthetic tax evidence",
        lines,
      });
      return cmd({ type: "entry.post", id: d.id, expected_version: d.version });
    };
    await post("2026-01-05", [
      { account_id: account(1), amount_cents: "89999" },
      { account_id: account(5), amount_cents: "-100000" },
      { account_id: meals, amount_cents: "10001" },
    ]);
    check((await source()).book_profit_cents, "89999");
    check((await source()).unmapped_accounts, 2);
    await cmd({
      type: "tax.mapping",
      id: randomUUID(),
      year: 2026,
      account_id: account(5),
      expected_version: 0,
      concept: "ordinary_income",
      deductible_bps: 10000,
    });
    await cmd({
      type: "tax.mapping.save",
      id: randomUUID(),
      tax_year: 2026,
      account_id: meals,
      expected_version: 0,
      concept: "meals_50",
    });
    check((await source()).adjusted_ordinary_cents, "94999");
    check((await source()).book_to_tax_cents, "5000");
    check((await source()).monthly[0].ordinary_cents, "94999");
    const adj = await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-02-01",
      amount_cents: "100",
      reason: "Synthetic adjustment",
    });
    check((await source()).adjusted_ordinary_cents, "95099");
    await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-02-01",
      amount_cents: "-100",
      reason: "Offset synthetic adjustment",
    });
    check((await source()).adjusted_ordinary_cents, "94999");
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query(
        "UPDATE accounting.tax_adjustments SET amount_cents=1 WHERE id=$1",
        [adj.id],
      ),
      /ACCT_IMMUTABLE/,
    );
    n++;
    await db.exec("SET ROLE authenticated");
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "Synthetic adjustment.pdf",
      mime_type: "application/pdf",
      size_bytes: "10",
      content_hash: "2".repeat(64),
    });
    await assert.rejects(
      cmd({
        type: "tax.adjustment.save",
        tax_year: 2026,
        concept: "ordinary_adjustment",
        effective_date: "2026-09-01",
        amount_cents: "10",
        document_id: doc.id,
        reason: "Not uploaded yet",
      }),
      /ACCT_DOCUMENT_UNAVAILABLE/,
    );
    n++;
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-08-01",
      amount_cents: "10",
      document_id: doc.id,
      reason: "Uploaded support",
    });
    await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-08-01",
      amount_cents: "-10",
      document_id: doc.id,
      reason: "Offset with support",
    });
    check((await source()).unavailable_adjustments, 0);
    console.log("Tax workpaper inputs integration:", n, "checks passed");
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    e.message,
    e.where,
    "position",
    e.position,
    e.query?.slice(Number(e.position) - 100, Number(e.position) + 150),
  );
  process.exitCode = 1;
});
