import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import {
  readCsv,
  journalGroups,
  type CsvOptions,
} from "../src/lib/accounting/imports/csv";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  type State = {
    batches: {
      id: string;
      status: string;
      version: number;
      coverage_verified: boolean;
    }[];
    groups: { id: string; status: string; version: number; entry_id: string }[];
  };
  const cmd = async (value: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT acct_operate($1,$2::jsonb) r",
        [key, JSON.stringify(value)],
      )
    ).rows[0].r;
  const state = async (id: string) =>
    (await db.query<{ r: State }>("SELECT acct_imports($1) r", [id])).rows[0].r;
  const rev = async () =>
    (
      await db.query<{ r: { revision: string } }>(
        "SELECT acct_close_history() r",
      )
    ).rows[0].r.revision;
  const sha = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const options: CsvOptions = {
    delimiter: ",",
    headerRow: 0,
    dateFormat: "yyyy-mm-dd",
    decimal: ".",
    thousands: "",
  };
  const mapping = {
    group: "group",
    date: "date",
    memo: "memo",
    account: "account",
    amount: "amount",
    stableGroupIds: true,
    accounts: {
      Bank: fixtureAccountId(1),
      Retained: fixtureAccountId(4),
      Income: fixtureAccountId(5),
      Expense: fixtureAccountId(6),
    },
  };
  const source =
    "group,date,memo,account,amount\nopening,2025-01-01,Opening balances,Bank,1000.00\nopening,2025-01-01,Opening balances,Retained,-1000.00\nreceipt,2025-01-10,Receipt,Bank,100.00\nreceipt,2025-01-10,Receipt,Income,-100.00\nexpense,2025-01-20,Expense,Bank,-20.00\nexpense,2025-01-20,Expense,Expense,20.00\nclosing,2025-12-31,Annual closing,Income,100.00\nclosing,2025-12-31,Annual closing,Expense,-20.00\nclosing,2025-12-31,Annual closing,Retained,-80.00";
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    from: `2025-${String(i + 1).padStart(2, "0")}-01`,
    to: `2025-${String(i + 1).padStart(2, "0")}-${new Date(Date.UTC(2025, i + 1, 0)).getUTCDate()}`,
    income_cents: i === 0 ? "10000" : "0",
    expense_cents: i === 0 ? "2000" : "0",
    net_income_cents: i === 0 ? "8000" : "0",
  }));
  const accounts = [
      { account_id: fixtureAccountId(1), amount_cents: "108000" },
      { account_id: fixtureAccountId(5), amount_cents: "-10000" },
      { account_id: fixtureAccountId(6), amount_cents: "2000" },
    ],
    totals = {
      assets_cents: "108000",
      liabilities_cents: "0",
      equity_total_cents: "108000",
    };
  const preview = async () =>
    (
      await db.query<{ r: { ready: boolean; source_errors: number } }>(
        "SELECT acct_history_preview($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) r",
        [
          "2025-01-01",
          "2025-12-31",
          JSON.stringify(monthly),
          JSON.stringify(accounts),
          JSON.stringify(totals),
        ],
      )
    ).rows[0].r;
  async function document(text: string) {
    const id = randomUUID(),
      hash = sha(text);
    await cmd({
      type: "document.prepare",
      id,
      original_name: "synthetic-source.csv",
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
  async function create(text: string, doc: string, scope: string) {
    const table = readCsv(text, options),
      groups = journalGroups(table, options, mapping).map((g, ordinal) => ({
        ...g,
        id: randomUUID(),
        ordinal,
      }));
    const batch = randomUUID();
    await cmd({
      type: "import.create",
      id: batch,
      source_system: "wave",
      source_scope: scope,
      file_hash: table.fileHash,
      mapping_hash: sha(JSON.stringify(mapping)),
      file_name: "synthetic-source.csv",
      source_document_id: doc,
      mode: "journal",
      basis: "cash",
      expected_groups: groups.length,
      from: "2025-01-01",
      to: "2025-12-31",
    });
    return { batch, groups };
  }
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === fixtureAccountId(1) ? "bank" : "none",
        ...(a.id === fixtureAccountId(4)
          ? {
              purpose: "opening_retained_earnings",
              name: "Opening retained earnings",
            }
          : {}),
      })),
    });
    await cmd({
      type: "year.configure",
      id: randomUUID(),
      year: 2025,
      classification: "s_corp",
      expected_revision: await rev(),
    });
    const doc = await document(source),
      imported = await create(source, doc, "history-import-fixture");
    await cmd({
      type: "import.stage",
      id: imported.batch,
      expected_version: 1,
      groups: imported.groups.slice(0, 2),
    });
    await cmd({
      type: "import.cancel",
      id: imported.batch,
      expected_version: 2,
      reason: "Pause interrupted staging",
    });
    check(
      (await state(imported.batch)).batches.find((b) => b.id === imported.batch)
        ?.status,
      "cancelled",
    );
    const resume = {
        type: "import.resume",
        id: imported.batch,
        expected_version: 3,
      },
      key = randomUUID();
    check(await cmd(resume, key), await cmd(resume, key));
    check(
      (await state(imported.batch)).batches.find((b) => b.id === imported.batch)
        ?.status,
      "staging",
    );
    await cmd({
      type: "import.stage",
      id: imported.batch,
      expected_version: 4,
      groups: imported.groups.slice(2),
    });
    await cmd({
      type: "import.apply",
      id: imported.batch,
      expected_version: 5,
      group_ids: imported.groups.slice(0, 3).map((g) => g.id),
    });
    const closing = imported.groups[3];
    await cmd({
      type: "import.resolve",
      id: closing.id,
      expected_version: 1,
      resolution: "exclude",
      reason: "Annual nominal closing retained as normalization evidence",
    });
    const latest = (await state(imported.batch)).batches.find(
      (b) => b.id === imported.batch,
    )!;
    await cmd({
      type: "import.finish",
      id: imported.batch,
      expected_version: latest.version,
    });
    check((await preview()).ready, false);
    await cmd({
      type: "history.disposition",
      id: randomUUID(),
      expected_revision: await rev(),
      group_id: closing.id,
      kind: "unsupported",
      document_id: doc,
      reason: "Keep unresolved until all source closing controls are checked",
    });
    check((await preview()).ready, false);
    await cmd({
      type: "history.disposition",
      id: randomUUID(),
      expected_revision: await rev(),
      group_id: closing.id,
      kind: "annual_closing",
      document_id: doc,
      reason:
        "Closing lines exactly reverse every nominal balance; ordinary economic groups remain posted",
    });
    check((await preview()).ready, true);
    await cmd({
      type: "history.verify",
      id: randomUUID(),
      expected_revision: await rev(),
      from: "2025-01-01",
      to: "2025-12-31",
      monthly,
      accounts,
      totals,
      cash_basis_confirmed: true,
      document_id: doc,
      reason:
        "Annual and monthly source controls agree after explicit closing normalization",
    });
    check(
      (await state(imported.batch)).batches.find((b) => b.id === imported.batch)
        ?.coverage_verified,
      true,
    );
    const final = (await state(imported.batch)).batches.find(
      (b) => b.id === imported.batch,
    )!;
    await assert.rejects(
      cmd({
        type: "import.cancel",
        id: imported.batch,
        expected_version: final.version,
        reason: "Must not cancel accepted history",
      }),
      /ACCT_IMPORT_FINAL/,
    );
    checks++;
    const badSource =
        "group,date,memo,account,amount\nbad,2025-12-31,Economic bank movement,Bank,80.00\nbad,2025-12-31,Economic bank movement,Retained,-80.00",
      badDoc = await document(badSource),
      bad = await create(badSource, badDoc, "not-a-closing");
    await cmd({
      type: "import.stage",
      id: bad.batch,
      expected_version: 1,
      groups: bad.groups,
    });
    await cmd({
      type: "import.resolve",
      id: bad.groups[0].id,
      expected_version: 1,
      resolution: "exclude",
      reason: "Test an invalid normalization",
    });
    await assert.rejects(
      cmd({
        type: "history.disposition",
        id: randomUUID(),
        expected_revision: await rev(),
        group_id: bad.groups[0].id,
        kind: "annual_closing",
        document_id: badDoc,
        reason: "An asset movement cannot be an annual nominal close",
      }),
      /ACCT_CLOSING_NORMALIZATION/,
    );
    checks++;
    check((await preview()).ready, false);
    await db.exec("RESET ROLE");
    check(
      (
        await db.query(
          "SELECT id FROM acct_history_dispositions WHERE group_id=$1",
          [closing.id],
        )
      ).rows.length,
      2,
    );
    await db.exec("SET ROLE authenticated");
    const backup = (
      await db.query<{
        r: { version: number; history_dispositions: unknown[] };
      }>("SELECT acct_books_backup() r")
    ).rows[0].r;
    check(backup.version, 9);
    check(backup.history_dispositions.length, 2);
    console.log(
      `Historical import coverage and normalization: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
