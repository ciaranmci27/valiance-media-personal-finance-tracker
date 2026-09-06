import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
import {
  readCsv,
  bankGroups,
  type CsvOptions,
} from "../src/lib/accounting/imports/csv";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{
        r: {
          id: string;
          version: number;
          added: number;
          skipped: number;
          restored: number;
        };
      }>("SELECT acct_operate($1,$2::jsonb) r", [key, JSON.stringify(c)])
    ).rows[0].r;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const options: CsvOptions = {
      delimiter: ",",
      headerRow: 0,
      dateFormat: "yyyy-mm-dd",
      decimal: ".",
      thousands: "",
    },
    mapping = {
      date: "date",
      description: "memo",
      amount: "amount",
      externalId: "id",
      sign: "deposits_positive" as const,
      accountId: account(1),
    };
  const csv =
    "id,date,memo,amount\na,2026-04-10,Deposit,20.00\nb,2026-04-10,Deposit,20.00\nc,2026-04-11,Fee,-10.00";
  const items = (text: string) =>
    bankGroups(readCsv(text, options), options, mapping).map((g, i) => ({
      external_id: g.external_id,
      fingerprint: g.fingerprint,
      source_row: i + 2,
      entry_date: g.entry_date,
      description: g.memo,
      amount_cents: g.bank_amount_cents!,
      raw: g.raw[0],
    }));
  async function document(text: string) {
    const id = randomUUID(),
      hash = sha(text);
    await cmd({
      type: "document.prepare",
      id,
      original_name: "synthetic-statement.csv",
      mime_type: "text/csv",
      content_hash: hash,
      size_bytes: String(Buffer.byteLength(text)),
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [`${id}/${hash}`],
    );
    await cmd({ type: "document.complete", id, expected_version: 1 });
    return id;
  }
  const id = randomUUID();
  type View = {
    revision: string;
    statement: { version: number; declared_count: number };
    items: { id: string; ordinal: number; amount_cents: string }[];
    item_count: number;
  };
  const view = async () =>
    (await db.query<{ r: View }>("SELECT acct_reconciliation_view($1) r", [id]))
      .rows[0].r;
  async function importRows(
    doc: string,
    text: string,
    rows = items(text),
    restore = false,
  ) {
    return {
      type: "statement.import",
      id,
      expected_version: (await view()).statement.version,
      document_id: doc,
      file_hash: sha(text),
      mapping_hash: sha(JSON.stringify(mapping)),
      mapping: { options, columns: mapping },
      items: rows,
      restore_removed: restore,
    };
  }
  try {
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === account(1) ? "bank" : "none",
      })),
    });
    const doc = await document(csv);
    await cmd({
      type: "reconciliation.create",
      id,
      account_id: account(1),
      from: "2026-04-01",
      to: "2026-04-30",
      opening_cents: "0",
      ending_cents: "3000",
      declared_count: 3,
      declared_debits_cents: "4000",
      declared_credits_cents: "1000",
      document_id: doc,
    });
    const initial = await importRows(doc, csv, items(csv).slice(0, 2)),
      key = randomUUID();
    check(await cmd(initial, key), await cmd(initial, key));
    check((await view()).item_count, 2);
    await cmd(await importRows(doc, csv, items(csv).slice(2)));
    check(
      (await view()).items.map((i) => i.amount_cents),
      ["2000", "2000", "-1000"],
    );
    const reordered =
        "id,date,memo,amount\nc,2026-04-11,Fee,-10.00\nb,2026-04-10,Deposit,20.00\na,2026-04-10,Deposit,20.00",
      secondDoc = await document(reordered);
    check((await cmd(await importRows(secondDoc, reordered))).skipped, 3);
    check((await view()).item_count, 3);
    const first = (await view()).items[0];
    await cmd({
      type: "reconciliation.item.remove",
      id,
      expected_version: (await view()).statement.version,
      item_id: first.id,
    });
    await assert.rejects(
      cmd(await importRows(doc, csv)),
      /ACCT_STATEMENT_ITEM_REMOVED/,
    );
    checks++;
    check(
      (await cmd(await importRows(doc, csv, items(csv), true))).restored,
      1,
    );
    check(
      (await view()).items.some((i) => i.id === first.id),
      true,
    );
    const modified = items(csv);
    modified[0] = { ...modified[0], amount_cents: "2100" };
    await assert.rejects(
      cmd(await importRows(doc, csv, modified)),
      /ACCT_STATEMENT_SOURCE_CHANGED/,
    );
    checks++;
    await assert.rejects(
      cmd({ ...(await importRows(doc, csv)), file_hash: "f".repeat(64) }),
      /ACCT_STATEMENT_SOURCE_FILE/,
    );
    checks++;
    const amend = {
      type: "statement.amend",
      id,
      expected_version: (await view()).statement.version,
      document_id: secondDoc,
      from: "2026-04-01",
      to: "2026-04-30",
      opening_cents: "0",
      ending_cents: "3000",
      declared_count: 3,
      declared_debits_cents: "4000",
      declared_credits_cents: "1000",
      predecessor_id: null,
      notes: "Statement controls checked",
      reason: "Retain the replacement original statement and corrected note",
    };
    await assert.rejects(
      cmd({ ...amend, declared_count: 2 }),
      /ACCT_STATEMENT_SCOPE/,
    );
    checks++;
    await cmd(amend);
    const sources = (
      await db.query<{
        r: {
          files: unknown[];
          amendments: {
            before_value: { opening_cents: string };
            after_value: { document_id: string };
          }[];
        };
      }>("SELECT acct_statement_sources($1) r", [id])
    ).rows[0].r;
    check(sources.files.length, 2);
    check(sources.amendments.length, 1);
    check(sources.amendments[0].before_value.opening_cents, "0");
    check(sources.amendments[0].after_value.document_id, secondDoc);
    await assert.rejects(
      cmd({
        type: "document.archive",
        id: doc,
        expected_version: 2,
        reason: "Source must remain available",
      }),
      /ACCT_DOCUMENT_LINKED/,
    );
    checks++;
    await db.exec("RESET ROLE");
    check(
      (await db.query("SELECT id FROM acct_journal_entries")).rows.length,
      0,
    );
    await assert.rejects(
      db.query("DELETE FROM acct_statement_item_sources"),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    const openingEntry = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-03-31",
      memo: "Independent opening balance",
      lines: [
        { account_id: account(1), amount_cents: "1000", memo: "" },
        { account_id: account(4), amount_cents: "-1000", memo: "" },
      ],
    });
    await cmd({
      type: "entry.post",
      id: openingEntry.id,
      expected_version: openingEntry.version,
    });
    await cmd({
      ...amend,
      expected_version: (await view()).statement.version,
      opening_cents: "1000",
      ending_cents: "4000",
      reason: "Correct independently documented opening",
    });
    await cmd({
      type: "reconciliation.opening",
      id,
      expected_version: (await view()).statement.version,
      expected_revision: (await view()).revision,
      reviewed: true,
      outstanding: [],
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query(
          "SELECT * FROM acct_reconciliation_opening WHERE reconciliation_id=$1",
          [id],
        )
      ).rows.length,
      1,
    );
    await db.exec("SET ROLE authenticated");
    await cmd({
      ...amend,
      expected_version: (await view()).statement.version,
      opening_cents: "2000",
      ending_cents: "5000",
      reason: "New source control requires opening review again",
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query(
          "SELECT * FROM acct_reconciliation_opening WHERE reconciliation_id=$1",
          [id],
        )
      ).rows.length,
      0,
    );
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("SELECT acct_statement_sources($1)", [id]),
      /permission denied/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "reconciliation.cancel",
      id,
      expected_version: (await view()).statement.version,
      reason: "End synthetic draft statement test",
    });
    await assert.rejects(
      cmd(await importRows(doc, csv)),
      /ACCT_RECONCILIATION_FINAL/,
    );
    checks++;
    const backup = (
      await db.query<{
        r: { version: number; statement_item_sources: unknown[] };
      }>("SELECT acct_books_backup() r")
    ).rows[0].r;
    check(backup.version, 9);
    check(backup.statement_item_sources.length, 3);
    console.log(
      `Statement source imports, retry, restoration, and header history: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
