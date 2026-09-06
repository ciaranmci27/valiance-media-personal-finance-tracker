import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
  fixtureOwner,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT acct_operate($1,$2::jsonb) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  const lines = (amount = "100000") => [
    { account_id: account(1), amount_cents: amount, memo: "" },
    {
      account_id: account(4),
      amount_cents: (-BigInt(amount)).toString(),
      memo: "",
    },
  ];
  const controls = (amount = "100000") =>
    lines(amount).map(({ account_id, amount_cents }) => ({
      account_id,
      amount_cents,
    }));
  const draft = async (memo = "Supported opening", date = "2025-01-01") => {
    const id = randomUUID();
    await cmd({
      type: "draft.save",
      id,
      expected_version: 0,
      entry_date: date,
      memo,
      lines: lines(),
    });
    return id;
  };
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === account(1) ? "bank" : "none",
        ...(a.id === account(4)
          ? {
              purpose: "opening_retained_earnings",
              name: "Opening retained earnings",
            }
          : {}),
      })),
    });
    const document = randomUUID();
    await cmd({
      type: "document.prepare",
      id: document,
      original_name: "opening-control.csv",
      content_hash: "a".repeat(64),
      size_bytes: "100",
      mime_type: "text/csv",
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [`${document}/${"a".repeat(64)}`],
    );
    await cmd({ type: "document.complete", id: document, expected_version: 1 });
    const opening = await draft();
    await assert.rejects(
      cmd({ type: "entry.post", id: opening, expected_version: 1 }),
      /ACCT_RETAINED_REVIEW_REQUIRED/,
    );
    checks++;
    await assert.rejects(
      cmd({
        type: "retained.post",
        id: opening,
        expected_version: 1,
        document_id: document,
        controls: controls("90000"),
        reason: "Bad controls must not post",
      }),
      /ACCT_RETAINED_CONTROL_DIFFERENCE/,
    );
    checks++;
    const post = {
        type: "retained.post",
        id: opening,
        expected_version: 1,
        document_id: document,
        controls: controls(),
        reason: "Independent opening trial balance agrees on both accounts",
      },
      key = randomUUID();
    check(await cmd(post, key), await cmd(post, key));
    const duplicateOpening = await draft("Duplicate opening must not post");
    await assert.rejects(
      cmd({
        type: "retained.post",
        id: duplicateOpening,
        expected_version: 1,
        document_id: document,
        controls: controls(),
        reason: "A second opening would duplicate existing history",
      }),
      /ACCT_OPENING_HISTORY_EXISTS/,
    );
    checks++;
    const replacement = randomUUID(),
      correction = {
        type: "entry.correct",
        id: opening,
        expected_version: 2,
        replacement_id: replacement,
        reversal_date: "2025-01-01",
        entry_date: "2025-01-01",
        memo: "Correct opening amount",
        reason: "Correct source control to $2000",
        lines: lines("200000"),
      };
    await assert.rejects(cmd(correction), /ACCT_DOCUMENT_UNAVAILABLE/);
    checks++;
    await db.exec("RESET ROLE");
    check(
      (
        await db.query(
          "SELECT id FROM acct_journal_entries WHERE reverses_entry_id=$1",
          [opening],
        )
      ).rows.length,
      0,
    );
    await db.exec("SET ROLE authenticated");
    await cmd({
      ...correction,
      retained_review: { document_id: document, controls: controls("200000") },
    });
    const workspace = (
      await db.query<{
        r: {
          reports: {
            income_cents: string;
            retained_cents: string;
            equity_cents: string;
          };
        };
      }>("SELECT acct_workspace($1,$2) r", ["2025-01-01", "2025-12-31"])
    ).rows[0].r;
    check(workspace.reports.income_cents, "0");
    check(workspace.reports.equity_cents, "200000");
    const nominal = randomUUID();
    await cmd({
      type: "draft.save",
      id: nominal,
      expected_version: 0,
      entry_date: "2025-12-31",
      memo: "An annual closing must not post",
      lines: [
        { account_id: account(5), amount_cents: "10000" },
        { account_id: account(4), amount_cents: "-10000" },
      ],
    });
    await assert.rejects(
      cmd({
        type: "retained.post",
        id: nominal,
        expected_version: 1,
        document_id: document,
        controls: [
          { account_id: account(5), amount_cents: "10000" },
          { account_id: account(4), amount_cents: "-10000" },
        ],
        reason: "Not a supported opening",
      }),
      /ACCT_NOMINAL_CLOSING_FORBIDDEN/,
    );
    checks++;
    await assert.rejects(
      cmd({
        type: "document.archive",
        id: document,
        expected_version: 2,
        reason: "Evidence must remain",
      }),
      /ACCT_DOCUMENT_LINKED/,
    );
    checks++;
    const stale = await draft(
      "Review cannot survive financial edits",
      "2024-12-31",
    );
    await assert.rejects(
      db.query("SELECT acct_retained_review($1,$2,$3,$4::jsonb,$5,$6)", [
        stale,
        "opening",
        document,
        JSON.stringify(controls()),
        "private review",
        fixtureOwner,
      ]),
      /permission denied/,
    );
    checks++;
    await db.exec("RESET ROLE");
    await db.query("SELECT acct_retained_review($1,$2,$3,$4::jsonb,$5,$6)", [
      stale,
      "opening",
      document,
      JSON.stringify(controls()),
      "Synthetic direct invariant test",
      fixtureOwner,
    ]);
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "draft.save",
      id: stale,
      expected_version: 1,
      entry_date: "2025-01-01",
      memo: "Changed after review",
      lines: lines(),
    });
    await assert.rejects(
      cmd({ type: "entry.post", id: stale, expected_version: 2 }),
      /ACCT_RETAINED_REVIEW_REQUIRED/,
    );
    checks++;
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query("DELETE FROM acct_retained_reviews"),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    const backup = (
      await db.query<{ r: { version: number; retained_reviews: unknown[] } }>(
        "SELECT acct_books_backup() r",
      )
    ).rows[0].r;
    check(backup.version, 9);
    check(backup.retained_reviews.length, 3);
    console.log(
      `Retained earnings review and correction: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
