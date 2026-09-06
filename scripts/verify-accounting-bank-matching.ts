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
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT acct_operate($1,$2::jsonb) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  type Review = {
    revision: string;
    remaining_cents: string;
    group: { status: string; entry_id: string };
    drafts: { id: string; version: number }[];
    matches: { id: string; entry_id: string; release: unknown }[];
    candidates: {
      line_id: string;
      entry_id: string;
      available_cents: string;
    }[];
  };
  const review = async (id: string) =>
    (await db.query<{ r: Review }>("SELECT acct_bank_review($1) r", [id]))
      .rows[0].r;
  const opts: CsvOptions = {
    delimiter: ",",
    headerRow: 0,
    dateFormat: "yyyy-mm-dd",
    decimal: ".",
    thousands: "",
  };
  async function source(
    external: string,
    amount: string,
    provider = "csv",
    memo = "Bank receipt",
  ) {
    const csv = `id,date,memo,amount\n${external},2026-01-12,${memo},${amount}`;
    const table = readCsv(csv, opts),
      groups = bankGroups(table, opts, {
        date: "date",
        description: "memo",
        amount: "amount",
        externalId: "id",
        sign: "deposits_positive",
        accountId: account(1),
      }),
      batch = randomUUID(),
      group = randomUUID();
    await cmd({
      type: "import.create",
      id: batch,
      source_system: provider,
      source_scope: "checking",
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
    return { batch, group };
  }
  async function posting(amount: string, memo: string) {
    const id = randomUUID();
    await cmd({
      type: "draft.save",
      id,
      expected_version: 0,
      entry_date: "2026-01-12",
      memo,
      lines: [
        { account_id: account(1), amount_cents: amount },
        { account_id: account(5), amount_cents: (-BigInt(amount)).toString() },
      ],
    });
    await cmd({ type: "entry.post", id, expected_version: 1 });
    return id;
  }
  const match = async (
    group: string,
    line: string,
    amount: string,
    discard: object[] = [],
  ) => ({
    type: "bank.match",
    id: randomUUID(),
    group_id: group,
    expected_revision: (await review(group)).revision,
    allocations: [{ line_id: line, amount_cents: amount }],
    discard_drafts: discard,
    reason: "Reviewed synthetic matching and source overlap",
  });
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === account(1) ? "bank" : "none",
        purpose:
          a.id === account(5)
            ? "uncategorized_income"
            : a.id === account(6)
              ? "uncategorized_expense"
              : undefined,
      })),
    });
    const first = await source("receipt-500", "500.00");
    await cmd({
      type: "import.apply",
      id: first.batch,
      expected_version: 2,
      group_ids: [first.group],
    });
    const originalDraft = (await review(first.group)).drafts[0];
    const a = await posting("20000", "First $200 receipt"),
      b = await posting("30000", "Second $300 receipt");
    let r = await review(first.group);
    const lineA = r.candidates.find((c) => c.entry_id === a)!.line_id,
      lineB = r.candidates.find((c) => c.entry_id === b)!.line_id;
    const partial = await match(first.group, lineA, "20000"),
      key = randomUUID();
    check(await cmd(partial, key), await cmd(partial, key));
    check((await review(first.group)).remaining_cents, "30000");
    await assert.rejects(
      cmd({
        type: "entry.post",
        id: originalDraft.id,
        expected_version: originalDraft.version,
      }),
      /ACCT_BANK_PARTIAL_REVIEW/,
    );
    checks++;
    await assert.rejects(
      cmd(await match(first.group, lineB, "30000")),
      /ACCT_REDUNDANT_DRAFT_APPROVAL/,
    );
    checks++;
    check((await review(first.group)).matches.length, 1);
    r = await review(first.group);
    await cmd(
      await match(
        first.group,
        lineB,
        "30000",
        r.drafts.map((d) => ({ id: d.id, expected_version: d.version })),
      ),
    );
    r = await review(first.group);
    check(r.remaining_cents, "0");
    check(r.drafts.length, 0);
    check(r.group.status, "duplicate");
    const books = (
      await db.query<{ r: { reports: { income_cents: string } } }>(
        "SELECT acct_workspace($1,$2) r",
        ["2026-01-01", "2026-01-31"],
      )
    ).rows[0].r;
    check(books.reports.income_cents, "50000");
    await assert.rejects(
      cmd(await match(first.group, lineB, "1")),
      /ACCT_ALLOCATION_EXCEEDED/,
    );
    checks++;
    const repeated = await source(
      "receipt-500",
      "500.00",
      "csv",
      "Updated description with unchanged financial fields",
    );
    await cmd({
      type: "bank.match",
      id: randomUUID(),
      group_id: repeated.group,
      expected_revision: (await review(repeated.group)).revision,
      allocations: [],
      discard_drafts: [],
      reason:
        "Same provider identity and financial fields, retain revised description as evidence",
    });
    check((await review(repeated.group)).remaining_cents, "0");
    check((await review(repeated.group)).group.status, "duplicate");
    const other = await source("different-id", "100.00");
    await assert.rejects(
      cmd(await match(other.group, lineA, "10000")),
      /ACCT_ALLOCATION_EXCEEDED/,
    );
    checks++;
    const wave = await source("wave-bank-id", "200.00", "wave");
    await cmd(await match(wave.group, lineA, "20000"));
    check((await review(wave.group)).remaining_cents, "0");
    await cmd({
      type: "entry.reverse",
      id: a,
      expected_version: 2,
      entry_date: "2026-01-12",
      reason: "Reverse matched receipt and reopen its evidence",
    });
    check((await review(first.group)).remaining_cents, "20000");
    check((await review(wave.group)).remaining_cents, "20000");
    check((await review(repeated.group)).group.status, "review");
    const replacement = await posting("20000", "Corrected receipt");
    r = await review(first.group);
    await cmd(
      await match(
        first.group,
        r.candidates.find((c) => c.entry_id === replacement)!.line_id,
        "20000",
      ),
    );
    check((await review(first.group)).remaining_cents, "0");
    r = await review(first.group);
    const active = r.matches.find((m) => m.entry_id === b && !m.release)!;
    await cmd({
      type: "bank.release",
      id: randomUUID(),
      match_id: active.id,
      expected_revision: r.revision,
      reason: "Explicit matching correction",
    });
    check((await review(first.group)).remaining_cents, "30000");
    const changed = await source("receipt-500", "501.00");
    await assert.rejects(
      cmd(await match(changed.group, lineB, "30000")),
      /ACCT_BANK_SOURCE_CONFLICT/,
    );
    checks++;
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM acct_journal_entries WHERE id=$1",
          [originalDraft.id],
        )
      ).rows[0].status,
      "discarded",
    );
    await assert.rejects(
      db.query("DELETE FROM acct_bank_matches"),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE anon");
    await assert.rejects(review(first.group), /permission denied/);
    checks++;
    console.log(
      `Partial bank allocation, overlap, draft resolution, and reversal: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
