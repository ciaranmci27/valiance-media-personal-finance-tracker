import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import type { JournalEntry } from "../src/lib/accounting/contracts";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const query = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, args)).rows[0].r;
  const cmd = (c: object, key = randomUUID()) =>
    query<{ id: string; version: number; reversal_id?: string }>(
      "SELECT acct_execute($1,$2::jsonb) r",
      [key, JSON.stringify(c)],
    );
  const rejects = async (c: object, pattern: RegExp) => {
    await assert.rejects(cmd(c), pattern);
    checks++;
  };
  try {
    const seed = {
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts,
    };
    const key = randomUUID();
    check(await cmd(seed, key), await cmd(seed, key));
    await rejects({ ...seed, id: randomUUID() }, /ACCT_CHART_EXISTS/);
    const checking = fixtureAccountId(1);
    const profile = {
      type: "account.update",
      id: checking,
      expected_version: 1,
      name: "Operating checking",
      code: "1000",
      cash_kind: "bank",
      is_archived: false,
    };
    check((await cmd(profile)).version, 2);
    await rejects(profile, /ACCT_STALE_VERSION/);
    await rejects(
      { ...profile, expected_version: 2, cash_kind: "card" },
      /ACCT_ACCOUNT_KIND/,
    );
    const ids: string[] = [];
    for (const e of fixtureEntries) {
      const id = randomUUID();
      ids.push(id);
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: e.date,
        memo: e.memo,
        lines: e.lines.map(([n, c]) => ({
          account_id: fixtureAccountId(n),
          amount_cents: c,
          memo: "",
        })),
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
    }
    await rejects(
      { ...profile, expected_version: 2, cash_kind: "cash" },
      /ACCT_ACCOUNT_IN_USE/,
    );
    type Register = { entries: JournalEntry[]; total: number; offset: number };
    const first = await query<Register>("SELECT acct_register($1) r", [
      JSON.stringify({ limit: 3 }),
    ]);
    const second = await query<Register>("SELECT acct_register($1) r", [
      JSON.stringify({ limit: 3, offset: 3 }),
    ]);
    check(first.total, 11);
    check(first.entries.length, 3);
    check(
      first.entries.some((e) => second.entries.some((s) => s.id === e.id)),
      false,
    );
    check(
      (
        await query<Register>("SELECT acct_register($1) r", [
          JSON.stringify({ query: "software" }),
        ])
      ).total,
      2,
    );
    const ledger = await query<{
      opening_cents: string;
      rows: { running_cents: string }[];
    }>("SELECT acct_account_ledger($1,'2026-01-01','2026-02-28') r", [
      checking,
    ]);
    check(ledger.opening_cents, "1200000");
    check(ledger.rows.at(-1)?.running_cents, "1228000");
    const replacementId = randomUUID();
    const correction = {
      type: "entry.correct",
      id: ids[3],
      expected_version: 2,
      replacement_id: replacementId,
      entry_date: "2026-02-15",
      reason: "Correct purchase classification",
      memo: "Corrected purchase",
      lines: [
        { account_id: fixtureAccountId(6), amount_cents: "13000", memo: "" },
        { account_id: fixtureAccountId(3), amount_cents: "-13000", memo: "" },
      ],
    };
    const correctionKey = randomUUID();
    const corrected = await cmd(correction, correctionKey);
    check(await cmd(correction, correctionKey), corrected);
    check(corrected.id, replacementId);
    check(
      (
        await query<{ reports: { net_income_cents: string } }>(
          "SELECT acct_workspace('2026-01-01','2026-02-28') r",
        )
      ).reports.net_income_cents,
      "74000",
    );
    await rejects(
      { ...correction, replacement_id: randomUUID() },
      /ACCT_ALREADY_REVERSED/,
    );
    // Invalid replacement rolls back the preceding reversal as one transaction.
    const failed = {
      ...correction,
      id: ids[4],
      replacement_id: randomUUID(),
      memo: "",
    };
    await rejects(failed, /check constraint/);
    check(
      (
        await query<Register>("SELECT acct_register($1) r", [
          JSON.stringify({ entry_id: ids[4] }),
        ])
      ).entries[0].reversed_by_entry_id,
      null,
    );
    const noteId = randomUUID();
    await cmd({
      type: "entry.annotate",
      id: noteId,
      entry_id: ids[0],
      note: "Late evidence note",
    });
    check(
      (
        await query<{ notes: { id: string }[] }>(
          "SELECT acct_entry_evidence($1) r",
          [ids[0]],
        )
      ).notes[0].id,
      noteId,
    );
    const draftId = randomUUID();
    await cmd({
      type: "draft.save",
      id: draftId,
      expected_version: 0,
      entry_date: "2026-03-01",
      memo: "Context draft",
      lines: [],
    });
    check(
      (
        await cmd({
          type: "entry.context",
          id: draftId,
          expected_version: 1,
          kind: "expense",
          payment_rail: "card",
        })
      ).version,
      2,
    );
    await rejects(
      {
        type: "entry.context",
        id: ids[0],
        expected_version: 2,
        kind: "expense",
      },
      /ACCT_IMMUTABLE/,
    );
    await rejects(
      {
        type: "entry.context",
        id: draftId,
        expected_version: 2,
        contractor_treatment: "excluded",
        contractor_reason: "",
      },
      /ACCT_REASON_REQUIRED/,
    );
    const snapshotId = randomUUID();
    const payeeId = randomUUID(),
      projectId = randomUUID();
    await cmd({
      type: "party.save",
      id: payeeId,
      expected_version: 0,
      name: "Fixture customer",
      kind: "customer",
    });
    await cmd({
      type: "dimension.save",
      id: projectId,
      expected_version: 0,
      name: "Fixture project",
      kind: "project",
      customer_id: payeeId,
    });
    const atomicId = randomUUID();
    const transaction = {
      type: "transaction.save",
      id: atomicId,
      expected_version: 0,
      entry_date: "2026-03-02",
      memo: "Atomic context save",
      lines: [],
      context: {
        kind: "expense",
        project_id: projectId,
        payee_id: payeeId,
        payment_rail: "ach",
      },
    };
    check((await cmd(transaction)).version, 2);
    check(
      (
        await query<Register>("SELECT acct_register($1) r", [
          JSON.stringify({ project: projectId }),
        ])
      ).total,
      1,
    );
    const rollbackId = randomUUID();
    await rejects(
      { ...transaction, id: rollbackId, context: { project_id: randomUUID() } },
      /ACCT_INVALID_DIMENSION/,
    );
    check(
      (
        await query<Register>("SELECT acct_register($1) r", [
          JSON.stringify({ entry_id: rollbackId }),
        ])
      ).total,
      0,
    );
    await rejects(
      {
        type: "dimension.save",
        id: projectId,
        expected_version: 1,
        name: "Changed kind",
        kind: "business_line",
      },
      /ACCT_IMMUTABLE_IDENTITY/,
    );
    await rejects(
      {
        type: "preferences.save",
        id: randomUUID(),
        expected_version: 0,
        legal_name: "Fixture",
        authority_mode: "admin_primary",
      },
      /ACCT_PRIMARY_REQUIRES_ACCEPTANCE/,
    );
    const bulkId = randomUUID();
    await cmd({
      ...transaction,
      id: bulkId,
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "10", memo: "" },
        { account_id: fixtureAccountId(2), amount_cents: "-10", memo: "" },
      ],
    });
    await rejects(
      {
        type: "entry.bulkpost",
        id: randomUUID(),
        entries: [
          { id: bulkId, expected_version: 2 },
          { id: atomicId, expected_version: 2 },
        ],
      },
      /ACCT_UNBALANCED/,
    );
    check(
      (
        await query<Register>("SELECT acct_register($1) r", [
          JSON.stringify({ entry_id: bulkId }),
        ])
      ).entries[0].status,
      "draft",
    );
    await cmd({
      type: "report.snapshot",
      id: snapshotId,
      from: "2026-01-01",
      to: "2026-02-28",
    });
    const exported = await query<{
      version: number;
      entry_context: unknown[];
      report_snapshots: { revision: string }[];
      import_batches: unknown[];
    }>("SELECT acct_books_export() r");
    check(exported.version, 2);
    check(exported.entry_context.length, 3);
    check(typeof exported.report_snapshots[0].revision, "string");
    check(exported.import_batches, []);
    await db.exec("RESET ROLE;");
    await assert.rejects(
      db.query("DELETE FROM acct_report_snapshots WHERE id=$1", [snapshotId]),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE anon;");
    await assert.rejects(
      db.query("SELECT acct_register('{}')"),
      /permission denied/,
    );
    checks++;
    console.log(`Accounting workflows: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
