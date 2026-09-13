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
  const fail = async (work: () => Promise<unknown>, pattern: RegExp) => {
    await assert.rejects(work, pattern);
    checks++;
  };
  const cmd = async (command: object, key = randomUUID()) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key, command }),
      ])
    ).rows[0].r;
  const all = async () =>
    (await db.query<{ r: any }>("SELECT accounting.bank_review() r")).rows[0].r;
  const review = async (id: string) =>
    (await all()).transactions.find((o: any) => o.id === id);
  const detail = async (id: string) =>
    (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
      .rows[0].r;
  const remaining = async (id: string) => {
    const o = await review(id);
    return (
      BigInt(o.amount_cents) -
      o.matches.reduce(
        (n: bigint, m: any) => n + BigInt(m.amount_cents),
        BigInt("0"),
      )
    ).toString();
  };
  const opts: CsvOptions = {
    delimiter: ",",
    headerRow: 0,
    dateFormat: "yyyy-mm-dd",
    decimal: ".",
    thousands: "",
  };
  const source = async (
    external: string,
    amount: string,
    provider = "csv",
    description = "Synthetic bank receipt",
  ) => {
    const csv = `id,date,memo,amount\n${external},2026-01-12,${description},${amount}`;
    const table = readCsv(csv, opts),
      groups = bankGroups(table, opts, {
        date: "date",
        description: "memo",
        amount: "amount",
        externalId: "id",
        sign: "deposits_positive",
        accountId: account(1),
      });
    const batch = randomUUID(),
      group = randomUUID();
    await cmd({
      type: "import.create",
      id: batch,
      source_system: provider,
      source_scope: "synthetic-checking",
      file_hash: table.fileHash,
      mapping_hash: createHash("sha256").update("mapping").digest("hex"),
      file_name: "synthetic.csv",
      mode: "bank",
      basis: "cash",
      expected_groups: 1,
      from: "2026-01-01",
      to: "2026-01-31",
    });
    await cmd({
      type: "import.stage",
      id: batch,
      expected_version: 1,
      groups: [{ ...groups[0], id: group, ordinal: 0 }],
    });
    return {
      batch,
      group,
      observation: (await all()).transactions.find(
        (o: any) => o.external_id === external,
      ).id,
    };
  };
  const posting = async (amount: string) =>
    cmd({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-01-12",
      memo: "Synthetic receipt",
      lines: [
        { account_id: account(1), amount_cents: amount },
        { account_id: account(5), amount_cents: (-BigInt(amount)).toString() },
      ],
    });
  const match = async (
    id: string,
    line_id: string,
    amount_cents: string,
    discard_drafts: object[] = [],
  ) => ({
    type: "bank.match",
    id: randomUUID(),
    bank_transaction_id: id,
    expected_revision: (await all()).revision,
    allocations: [{ line_id, amount_cents }],
    discard_drafts,
    reason: "Reviewed synthetic evidence",
  });
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === account(1) ? "bank" : "none",
      })),
    });
    const first = await source("receipt-500", "500.00");
    const drawer = async () =>
      (
        await db.query<{ r: any }>("SELECT accounting.bank_review($1) r", [
          JSON.stringify({ id: first.group }),
        ])
      ).rows[0].r;
    check((await drawer()).group.id, first.group);
    check((await drawer()).group.bank_transaction_id, first.observation);
    check((await drawer()).remaining_cents, "50000");
    check((await drawer()).drafts.length, 0);
    await cmd({
      type: "import.apply",
      id: first.batch,
      expected_version: 2,
      group_ids: [first.group],
    });
    const imported = (
      await db.query<{ r: any }>("SELECT accounting.imports($1) r", [
        first.batch,
      ])
    ).rows[0].r.groups[0];
    const original = await detail(imported.entry_id);
    check((await drawer()).drafts[0].id, original.id);
    const a = await posting("20000"),
      b = await posting("30000");
    const lineA = (await detail(a.id)).lines.find(
        (l: any) => l.account_id === account(1),
      ).id,
      lineB = (await detail(b.id)).lines.find(
        (l: any) => l.account_id === account(1),
      ).id;
    // The draft owns the observation until it is explicitly discarded, even for partial replacement.
    await fail(
      async () => cmd(await match(first.observation, lineA, "20000")),
      /ACCT_MATCH_OVERALLOCATED/,
    );
    const partial = await match(first.observation, lineA, "20000", [
      { id: original.id, expected_version: original.version },
    ]);
    const key = randomUUID();
    const { bank_transaction_id: _observation, ...legacyPartial } = partial;
    const groupPartial = { ...legacyPartial, group_id: first.group };
    check(await cmd(groupPartial, key), await cmd(groupPartial, key));
    check((await drawer()).remaining_cents, "30000");
    check(await remaining(first.observation), "30000");
    check((await detail(original.id)).status, "discarded");
    await cmd(await match(first.observation, lineB, "30000"));
    check(await remaining(first.observation), "0");
    check((await review(first.observation)).review, "matched");
    check((await review(first.observation)).matches.length, 2);
    check(
      (
        await db.query<{ r: any }>(
          "SELECT accounting.workspace('2026-01-01','2026-01-31') r",
        )
      ).rows[0].r.reports.income_cents,
      "50000",
    );
    await fail(
      async () => cmd(await match(first.observation, lineB, "1")),
      /ACCT_MATCH_OVERALLOCATED|duplicate key/,
    );
    const other = await source("different-id", "100.00");
    await fail(
      async () => cmd(await match(other.observation, lineA, "10000")),
      /ACCT_MATCH_OVERALLOCATED/,
    );
    const changed = await source("receipt-500", "501.00");
    const changes = (
      await db.query<{ r: any }>("SELECT accounting.imports($1) r", [
        changed.batch,
      ])
    ).rows[0].r;
    check(changes.groups[0].status, "exception");
    check((await review(first.observation)).amount_cents, "50000");
    await cmd({
      type: "entry.reverse",
      id: a.id,
      expected_version: a.version,
      entry_date: "2026-01-12",
      reason: "Reverse matched synthetic receipt",
    });
    check(await remaining(first.observation), "20000");
    check((await review(first.observation)).review, "unmatched");
    const replacement = await posting("20000"),
      replacementLine = (await detail(replacement.id)).lines.find(
        (l: any) => l.account_id === account(1),
      ).id;
    await cmd(await match(first.observation, replacementLine, "20000"));
    check(await remaining(first.observation), "0");
    const active = (await review(first.observation)).matches.find(
      (m: any) => m.journal_line_id === lineB,
    );
    await cmd({
      type: "bank.release",
      id: randomUUID(),
      match_id: active.id,
      expected_revision: (await all()).revision,
      reason: "Synthetic explicit release",
    });
    check(await remaining(first.observation), "30000");
    // Independent corroboration has zero allocation and does not spend a line twice.
    const standalone = await posting("15000"),
      standaloneLine = (await detail(standalone.id)).lines.find(
        (l: any) => l.account_id === account(1),
      ).id;
    const csv = await source("csv-150", "150.00"),
      wave = await source("wave-150", "150.00", "wave");
    await cmd(await match(csv.observation, standaloneLine, "15000"));
    await cmd(await match(wave.observation, standaloneLine, "0"));
    check((await review(wave.observation)).review, "matched");
    check((await review(wave.observation)).matches[0].amount_cents, "0");
    const primary = (await review(csv.observation)).matches[0];
    await fail(
      () =>
        cmd({
          type: "bank.release",
          id: randomUUID(),
          match_id: primary.id,
          reason: "Cannot strand corroboration",
        }),
      /ACCT_RELEASE_CORROBORATION_FIRST/,
    );
    await cmd({
      type: "entry.reverse",
      id: standalone.id,
      expected_version: standalone.version,
      entry_date: "2026-01-13",
      reason: "Suppress both evidence sources",
    });
    check((await review(csv.observation)).review, "excluded");
    check((await review(wave.observation)).review, "excluded");
    await fail(
      () => db.query("DELETE FROM accounting.bank_matches"),
      /permission denied/,
    );
    await db.exec("SET ROLE anon");
    await fail(() => all(), /permission denied/);
    console.log(
      `Partial bank matching, draft replacement and corroborated reversals: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.stack, e.where);
  process.exitCode = 1;
});
