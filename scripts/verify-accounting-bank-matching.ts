import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
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
  const connection = randomUUID();
  let serial = 0;
  /** A bank feed run with one posted movement: the books record it and draft its entry. */
  const synced = async (external: string, cents: string) => {
    await db.exec("RESET ROLE; SET ROLE service_role");
    const run = randomUUID();
    const call = async (c: object) =>
      (
        await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [
          JSON.stringify({ id: connection, run_id: run, ...c }),
        ])
      ).rows[0].r;
    assert.equal((await call({ action: "lease" })).acquired, true);
    serial++;
    await call({
      action: "complete",
      through: 1800000000,
      create_drafts: true,
      accounts: [
        {
          provider_connection_id: "synthetic",
          provider_account_id: "checking",
          currency: "USD",
          name: "Synthetic checking",
          institution: "Synthetic bank",
          balance_cents: "10000",
          balance_at: Date.parse("2026-01-12T18:00:00Z") / 1000,
          complete: true,
          transactions: [
            {
              external_id: external,
              posted: Date.parse("2026-01-12T18:00:00Z") / 1000,
              amount_cents: cents,
              description: "Synthetic bank receipt",
              state: "posted",
              hash: serial.toString(16).padStart(64, "0"),
              raw: { synthetic: true },
            },
          ],
        },
      ],
    });
    await db.exec("RESET ROLE; SET ROLE authenticated");
    return (await all()).transactions.find(
      (o: any) => o.external_id === external,
    ).id as string;
  };
  /** A second source for the same movement (a bank CSV or Wave export row), recorded with no draft. */
  const observed = async (external: string, cents: string, source: string) => {
    const id = randomUUID();
    await db.exec("RESET ROLE");
    await db.query(
      `INSERT INTO accounting.bank_transactions(id,bank_account_id,source,external_id,posted_date,amount_cents,description,descriptor_key,content_hash,raw_payload,state)
       SELECT $1,id,$2,$3,'2026-01-12',$4,'Synthetic bank receipt','',repeat('e',64),'{}','posted' FROM accounting.bank_accounts WHERE account_id=$5`,
      [id, source, external, cents, account(1)],
    );
    await db.exec("SET ROLE authenticated");
    return id;
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
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic bank",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    await cmd({
      type: "feed.map",
      id: randomUUID(),
      expected_version: 0,
      account_id: account(1),
      connection_id: connection,
      provider_account_id: JSON.stringify(["synthetic", "checking"]).replace(
        ",",
        ", ",
      ),
      coverage_from: "2026-01-01",
      movement_sign: 1,
    });
    const first = await synced("receipt-500", "50000");
    const drawer = async () =>
      (
        await db.query<{ r: any }>("SELECT accounting.bank_review($1) r", [
          JSON.stringify({ id: first }),
        ])
      ).rows[0].r;
    check((await drawer()).group.id, first);
    check((await drawer()).group.bank_transaction_id, first);
    check("source_conflict" in (await drawer()), false);
    // The feed drafted the movement; that draft owns the observation.
    check((await drawer()).drafts.length, 1);
    check((await drawer()).remaining_cents, "0");
    const original = (await drawer()).drafts[0];
    check(original.status, "draft");
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
      async () => cmd(await match(first, lineA, "20000")),
      /ACCT_MATCH_OVERALLOCATED/,
    );
    const partial = await match(first, lineA, "20000", [
      { id: original.id, expected_version: original.version },
    ]);
    const key = randomUUID();
    check(await cmd(partial, key), await cmd(partial, key));
    check((await drawer()).remaining_cents, "30000");
    check(await remaining(first), "30000");
    check((await detail(original.id)).status, "discarded");
    await cmd(await match(first, lineB, "30000"));
    check(await remaining(first), "0");
    check((await review(first)).review, "matched");
    check((await review(first)).matches.length, 2);
    check(
      (
        await db.query<{ r: any }>(
          "SELECT accounting.workspace('2026-01-01','2026-01-31') r",
        )
      ).rows[0].r.reports.income_cents,
      "50000",
    );
    await fail(
      async () => cmd(await match(first, lineB, "1")),
      /ACCT_MATCH_OVERALLOCATED|duplicate key/,
    );
    const other = await observed("different-id", "10000", "csv");
    await fail(
      async () => cmd(await match(other, lineA, "10000")),
      /ACCT_MATCH_OVERALLOCATED/,
    );
    // A bank transaction id the books do not hold is refused, not looked up elsewhere.
    await fail(
      async () => cmd(await match(randomUUID(), lineA, "1")),
      /ACCT_NOT_FOUND/,
    );
    await cmd({
      type: "entry.reverse",
      id: a.id,
      expected_version: a.version,
      entry_date: "2026-01-12",
      reason: "Reverse matched synthetic receipt",
    });
    check(await remaining(first), "20000");
    check((await review(first)).review, "unmatched");
    const replacement = await posting("20000"),
      replacementLine = (await detail(replacement.id)).lines.find(
        (l: any) => l.account_id === account(1),
      ).id;
    await cmd(await match(first, replacementLine, "20000"));
    check(await remaining(first), "0");
    const active = (await review(first)).matches.find(
      (m: any) => m.journal_line_id === lineB,
    );
    await cmd({
      type: "bank.release",
      id: randomUUID(),
      match_id: active.id,
      expected_revision: (await all()).revision,
      reason: "Synthetic explicit release",
    });
    check(await remaining(first), "30000");
    // Independent corroboration has zero allocation and does not spend a line twice.
    const standalone = await posting("15000"),
      standaloneLine = (await detail(standalone.id)).lines.find(
        (l: any) => l.account_id === account(1),
      ).id;
    const csv = await observed("csv-150", "15000", "csv"),
      wave = await observed("wave-150", "15000", "wave");
    await cmd(await match(csv, standaloneLine, "15000"));
    await cmd(await match(wave, standaloneLine, "0"));
    check((await review(wave)).review, "matched");
    check((await review(wave)).matches[0].amount_cents, "0");
    const primary = (await review(csv)).matches[0];
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
    check((await review(csv)).review, "excluded");
    check((await review(wave)).review, "excluded");
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
