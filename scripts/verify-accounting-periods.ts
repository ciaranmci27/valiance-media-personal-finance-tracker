import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const rpc = async (name: string, args: unknown[] = []) =>
    (
      await db.query<{ r: any }>(
        `SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) r`,
        args.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)),
      )
    ).rows[0].r;
  const revision = async () =>
    (await rpc("acct_workspace", ["2024-01-01", "2024-12-31"]))
      .revision as string;
  const command = async (c: object) =>
    rpc("acct_operate", [
      randomUUID(),
      { id: randomUUID(), expected_revision: await revision(), ...c },
    ]);
  try {
    await command({ type: "chart.seed", accounts: fixtureAccounts });
    check((await rpc("acct_close_checklist", ["2024-01-01"])).ready, true);
    await assert.rejects(
      command({ type: "period.close", month: "2024-01-01" }),
      /ACCT_YEAR_CLASSIFICATION_REQUIRED/,
    );
    checks++;
    await command({
      type: "year.configure",
      year: 2024,
      classification: "s_corp",
    });
    const jan = await command({ type: "period.close", month: "2024-01-01" });
    await command({ type: "period.close", month: "2024-02-01" });
    check((await rpc("acct_period_impact", ["2024-01-01"])).periods.length, 2);
    const earlier = randomUUID();
    await command({
      type: "draft.save",
      id: earlier,
      expected_version: 0,
      entry_date: "2023-12-31",
      memo: "Backdated journal",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "100", memo: "" },
        { account_id: fixtureAccountId(4), amount_cents: "-100", memo: "" },
      ],
    });
    await assert.rejects(
      command({ type: "entry.post", id: earlier, expected_version: 1 }),
      /ACCT_LATER_PERIOD_LOCKED/,
    );
    checks++;
    await command({
      type: "draft.discard",
      id: earlier,
      expected_version: 1,
      reason: "Discard blocked test draft",
    });
    await command({
      type: "period.reopen",
      month: "2024-01-01",
      reason: "Investigate opening balances",
    });
    check((await rpc("acct_period_impact", ["2024-01-01"])).periods.length, 0);
    await db.exec("RESET ROLE");
    check(
      (
        await db.query("SELECT id FROM acct_report_snapshots WHERE id=$1", [
          jan.snapshot_id,
        ])
      ).rows.length,
      1,
    );
    await db.exec("SET ROLE authenticated");
    for (let m = 1; m <= 12; m++)
      await command({
        type: "period.close",
        month: `2024-${String(m).padStart(2, "0")}-01`,
      });
    const doc = randomUUID();
    await command({
      type: "document.prepare",
      id: doc,
      original_name: "filed-return.pdf",
      content_hash: "f".repeat(64),
      mime_type: "application/pdf",
      size_bytes: "10",
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [`${doc}/${"f".repeat(64)}`],
    );
    await command({ type: "document.complete", id: doc, expected_version: 1 });
    const filing = await command({
      type: "year.file",
      year: 2024,
      document_id: doc,
      filed_on: "2025-03-01",
    });
    await assert.rejects(
      command({
        type: "period.reopen",
        month: "2024-01-01",
        reason: "Ordinary reopen",
      }),
      /ACCT_RESTATEMENT_REQUIRED/,
    );
    checks++;
    await assert.rejects(
      command({ type: "year.configure", year: 2024, classification: "other" }),
      /ACCT_FILED_YEAR/,
    );
    checks++;
    const restatement = await command({
      type: "year.restatement.begin",
      month: "2024-01-01",
      reason: "Document a reviewed correction",
      document_id: doc,
      external_return_review: "required",
      return_review_explanation:
        "Owner will review amendment requirements with preparer",
    });
    check((await rpc("acct_period_impact", ["2024-01-01"])).periods.length, 0);
    await assert.rejects(
      command({ type: "year.restatement.complete", id: restatement.id }),
      /ACCT_YEAR_CLOSE_REQUIRED/,
    );
    checks++;
    for (let m = 1; m <= 12; m++)
      await command({
        type: "period.close",
        month: `2024-${String(m).padStart(2, "0")}-01`,
      });
    const revised = await command({
      type: "year.restatement.complete",
      id: restatement.id,
    });
    check(typeof revised.snapshot_id, "string");
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<{ filed_snapshot_id: string }>(
          "SELECT filed_snapshot_id FROM acct_fiscal_years WHERE year=2024",
        )
      ).rows[0].filed_snapshot_id,
      filing.snapshot_id,
    );
    await assert.rejects(
      db.query(
        "UPDATE acct_periods SET is_locked=false WHERE month_start='2024-01-01'",
      ),
      /ACCT_RESTATEMENT_REQUIRED/,
    );
    checks++;
    const backup = await rpc("acct_books_backup");
    check(backup.version, 9);
    check(backup.close_records.length, 26);
    check(
      backup.restatement_cases[0].replacement_snapshot_id,
      revised.snapshot_id,
    );
    check(typeof backup.report_snapshots[0].revision, "string");
    await db.exec("SET ROLE anon");
    await assert.rejects(
      rpc("acct_close_checklist", ["2024-01-01"]),
      /permission denied/,
    );
    checks++;
    console.log(
      `Period close and filed-year controls: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
