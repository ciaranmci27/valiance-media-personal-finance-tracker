import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureOwner } from "../src/lib/accounting/fixtures";
import type { JournalEntry } from "../src/lib/accounting/contracts";
import { commandSchema } from "../src/lib/accounting/contracts";
import { registerFilterSchema } from "../src/lib/accounting/workflows";
import { isTransactionReviewed } from "../src/lib/accounting/transactions";

async function main() {
  const source = process.argv.includes("--canonical")
    ? "canonical"
    : "migrations";
  const db = await accountingTestDb(source);
  const read = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, args)).rows[0].r;
  const cmd = (command: object, key = randomUUID()) =>
    read<{ id: string; version: number }>(
      "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
      [key, JSON.stringify(command)],
    );
  const detail = (id: string) =>
    read<JournalEntry>("SELECT accounting.entry_detail($1) r", [id]);
  const counts = () =>
    read<{ draft_count: number; needs_review_count: number }>(
      "SELECT accounting.workspace('2026-06-01','2026-06-30') r",
    );
  const register = (filter: object) =>
    read<{ entries: JournalEntry[]; total: number }>(
      "SELECT accounting.transactions($1) r",
      [JSON.stringify(filter)],
    );
  const balances = () =>
    read(
      'SELECT accounting.report(\'summary\',\'{"from":"2026-06-01","to":"2026-06-30"}\')->\'accounts\' r',
    );
  try {
    await db.exec("RESET ROLE");
    const account = async (name: string) =>
      read<string>("SELECT id r FROM accounting.accounts WHERE name=$1", [
        name,
      ]);
    const bank = await account("Business checking");
    const income = await account("Service revenue");
    const uncategorized = await account("Uncategorized income");
    await db.exec("SET ROLE authenticated");
    const input = {
      type: "transaction.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-06-01",
      memo: "Synthetic review toggle deposit",
      lines: [
        { account_id: bank, amount_cents: "1494103" },
        { account_id: uncategorized, amount_cents: "-1494103" },
      ],
    };
    let saved = await cmd(input);
    const review = (reviewed: boolean, version = saved.version) => ({
      type: "entry.review",
      id: saved.id,
      expected_version: version,
      reviewed,
    });
    assert(commandSchema.safeParse(review(true)).success);
    assert(
      !commandSchema.safeParse({ ...review(true), reviewed: "true" }).success,
    );
    assert(registerFilterSchema.safeParse({ review: "needs_review" }).success);
    assert(!registerFilterSchema.safeParse({ review: "unknown" }).success);
    await assert.rejects(cmd(review(true)), /ACCT_CATEGORY_REQUIRED/);
    assert.equal(isTransactionReviewed(await detail(saved.id)), false);
    assert.equal((await counts()).needs_review_count, 1);
    assert.deepEqual(await cmd(review(false)), saved);
    saved = await cmd({
      ...input,
      expected_version: saved.version,
      lines: [input.lines[0], { ...input.lines[1], account_id: income }],
    });
    saved = await cmd(review(true));
    const posted = await detail(saved.id);
    assert.equal(isTransactionReviewed(posted), true);
    assert.equal(
      isTransactionReviewed({ ...posted, review_pending: undefined }),
      true,
    );
    const before = await balances();
    const linesBefore = posted.lines;
    const toggle = review(false),
      key = randomUUID();
    saved = await cmd(toggle, key);
    assert.deepEqual(await cmd(toggle, key), saved);
    const pending = await detail(saved.id);
    assert.equal(pending.status, "posted");
    assert.equal(pending.review_pending, true);
    assert.equal(isTransactionReviewed(pending), false);
    assert.deepEqual(pending.lines, linesBefore);
    assert.deepEqual(await balances(), before);
    assert.equal((await counts()).draft_count, 0);
    assert.equal((await counts()).needs_review_count, 1);
    assert.equal(
      (await register({ review: "needs_review" })).entries[0].id,
      saved.id,
    );
    assert.equal((await register({ review: "reviewed" })).total, 0);
    assert.equal((await register({ status: "draft" })).total, 0);
    assert.equal((await register({ status: "posted" })).total, 1);
    await assert.rejects(
      cmd(review(true, posted.version)),
      /ACCT_STALE_VERSION/,
    );
    await assert.rejects(
      cmd({ ...review(true), reviewed: null }),
      /ACCT_INVALID_COMMAND/,
    );
    await assert.rejects(
      cmd({ ...input, expected_version: saved.version }),
      /ACCT_POSTED_IMMUTABLE/,
    );
    // Review remains metadata even after the accounting period is locked.
    await db.exec(
      "RESET ROLE; UPDATE accounting.periods SET status='locked',locked_at=now() WHERE month='2026-06-01'; SET ROLE authenticated;",
    );
    saved = await cmd(review(true));
    assert.equal((await counts()).needs_review_count, 0);
    assert.equal((await register({ review: "reviewed" })).total, 1);
    assert.deepEqual(await balances(), before);
    saved = await cmd(review(false));
    assert.equal((await counts()).needs_review_count, 1);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      randomUUID(),
    ]);
    await assert.rejects(cmd(review(true)), /ACCT_FORBIDDEN/);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
    const audit = await read<
      Array<{ action: string; after: { review_pending: boolean } }>
    >("SELECT accounting.entry_detail($1)->'audit' r", [saved.id]);
    assert(
      audit.some(
        (row) => row.action === "entry.review" && row.after.review_pending,
      ),
    );
    // Discarded drafts never re-enter the queue or become reviewable.
    const discarded = await cmd({
      ...input,
      id: randomUUID(),
      entry_date: "2026-07-01",
    });
    const removed = await cmd({
      type: "draft.discard",
      ...discarded,
      expected_version: discarded.version,
      reason: "Synthetic cleanup",
    });
    await assert.rejects(
      cmd({
        type: "entry.review",
        id: removed.id,
        expected_version: removed.version,
        reviewed: true,
      }),
      /ACCT_DISCARDED/,
    );
    assert.equal((await register({ review: "needs_review" })).total, 1);
    console.log(
      `Accounting review verified (${source}): reversible review, category guard, filters/counts, immutable balances/lines, locked periods, audit, idempotency, stale writes, owner access.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
