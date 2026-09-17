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
  const rejects = async (p: Promise<unknown>, r: RegExp) => {
    await assert.rejects(p, r);
    checks++;
  };
  const cmd = async (command: object) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key: randomUUID(), command }),
      ])
    ).rows[0].r;
  const connection = randomUUID(),
    bank = randomUUID();
  let run = randomUUID();
  const worker = async (command: object) => {
    await db.exec("RESET ROLE; SET ROLE service_role");
    try {
      return (
        await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [
          JSON.stringify({ id: connection, run_id: run, ...command }),
        ])
      ).rows[0].r;
    } finally {
      await db.exec("RESET ROLE; SET ROLE authenticated");
    }
  };
  const inspect = async () => {
    await db.exec("RESET ROLE");
    try {
      return (
        await db.query<any>(
          "SELECT * FROM accounting.bank_connections WHERE id=$1",
          [connection],
        )
      ).rows[0];
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const raw = async (sql: string, params: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return (await db.query<any>(sql, params)).rows;
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const minutesUntilNextSync = async () =>
    (
      await raw(
        "SELECT round(extract(epoch FROM (next_sync_at-now()))/60)::int m FROM accounting.bank_connections WHERE id=$1",
        [connection],
      )
    )[0].m;
  const providerKey = '["synthetic", "checking"]',
    stamp = Date.parse("2026-06-20T12:00:00Z") / 1000;
  const tx = {
    external_id: "synthetic-1",
    posted: stamp,
    amount_cents: "-1234",
    description: "SYNTHETIC SOFTWARE",
    state: "posted",
    hash: "a".repeat(64),
    raw: { synthetic: true },
  };
  const account = (transactions: object[], extra: object = {}) => ({
    provider_connection_id: "synthetic",
    provider_account_id: "checking",
    currency: "USD",
    name: "Synthetic checking",
    institution: "Synthetic bank",
    balance_cents: "10000",
    balance_at: stamp,
    complete: true,
    through: String(stamp + 1),
    transactions,
    ...extra,
  });
  try {
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: a.id === fixtureAccountId(1) ? "bank" : "none",
      });
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic connection",
      access_url_encrypted: "synthetic-encrypted-access",
      expected_version: 0,
    });
    await cmd({
      type: "feed.map",
      id: bank,
      expected_version: 0,
      account_id: fixtureAccountId(1),
      connection_id: connection,
      provider_account_id: providerKey,
      coverage_from: "2026-01-01",
    });
    await rejects(
      db.query<Record<string, unknown>>("SELECT accounting.sync_server($1)", [
        JSON.stringify({ action: "due" }),
      ]),
      /permission denied/,
    );
    check(await worker({ action: "due", source: "fixture" }), [connection]);
    check(
      await raw("SELECT source,last_tick_due FROM accounting.feed_worker"),
      [{ source: "fixture", last_tick_due: 1 }],
    );
    let lease = await worker({ action: "lease" });
    check(lease.acquired, true);
    check(lease.identities[0].provider_account_id, "checking");
    check(lease.identities[0].checkpoint, null);
    check(
      (await worker({ action: "lease", run_id: randomUUID() })).acquired,
      false,
    );
    await rejects(
      worker({ action: "complete", run_id: randomUUID(), accounts: [] }),
      /ACCT_STALE_LEASE/,
    );
    let result = await worker({
      action: "complete",
      partial: true,
      accounts: [account([tx], { chunk_partial: true })],
    });
    check(result.new, 1);
    check(result.complete, true);
    check((await inspect()).checkpoint[providerKey], undefined);
    check((await inspect()).lease_run_id, run);
    check((await inspect()).last_success_at, null);
    result = await worker({
      action: "complete",
      partial: true,
      accounts: [account([tx])],
    });
    check(result.new, 0);
    check((await inspect()).checkpoint[providerKey], String(stamp + 1));
    result = await worker({ action: "complete", accounts: [] });
    check(result.complete, true);
    check((await inspect()).lease_run_id, null);
    check(!!(await inspect()).last_success_at, true);
    // A complete run is due again after 110 minutes: the two-hour cadence on the hourly tick.
    check(await minutesUntilNextSync(), 110);
    await rejects(
      worker({ action: "complete", accounts: [] }),
      /ACCT_STALE_LEASE/,
    );
    run = randomUUID();
    await worker({ action: "lease" });
    result = await worker({
      action: "complete",
      partial: true,
      accounts: [
        account([{ ...tx, amount_cents: "-2000", hash: "b".repeat(64) }], {
          chunk_partial: true,
          through: String(stamp + 2),
        }),
      ],
    });
    check(result.conflicts, 1);
    check(result.complete, false);
    await worker({
      action: "complete",
      partial: true,
      accounts: [account([], { through: String(stamp + 2) })],
    });
    check((await inspect()).checkpoint[providerKey], String(stamp + 1));
    check((await worker({ action: "complete", accounts: [] })).complete, false);
    run = randomUUID();
    await worker({ action: "lease" });
    check((await worker({ action: "complete", accounts: [] })).complete, false);
    run = randomUUID();
    await worker({ action: "lease" });
    await worker({
      action: "complete",
      discovery: true,
      accounts: [account([], { through: null })],
    });
    check((await inspect()).checkpoint[providerKey], String(stamp + 1));
    run = randomUUID();
    await worker({ action: "lease" });
    await worker({
      action: "complete",
      partial: true,
      accounts: [
        account([{ ...tx, external_id: "synthetic-2", hash: "c".repeat(64) }], {
          through: String(stamp + 3),
        }),
      ],
    });
    await worker({
      action: "fail",
      error: "Synthetic interrupted provider response",
      retry_seconds: 7200,
    });
    check((await inspect()).checkpoint[providerKey], String(stamp + 3));
    check((await inspect()).lease_run_id, null);
    // A failed run waits the provider's Retry-After when that is longer than an hour.
    check(await minutesUntilNextSync(), 120);
    run = randomUUID();
    await worker({ action: "lease" });
    await worker({ action: "fail", error: "Synthetic outage" });
    check(await minutesUntilNextSync(), 60);
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<Record<string, unknown>>(
          "SELECT count(*)::int n FROM accounting.bank_transactions",
        )
      ).rows[0].n,
      2,
    );
    check(
      (
        await db.query<Record<string, unknown>>(
          "SELECT amount_cents::text amount FROM accounting.bank_transactions WHERE external_id=$1",
          ["synthetic-1"],
        )
      ).rows[0].amount,
      "-1234",
    );
    await db.exec("SET ROLE authenticated");
    run = randomUUID();
    await worker({ action: "lease" });
    check(
      (
        await worker({
          action: "complete",
          accounts: [
            account([], { currency: "EUR", through: String(stamp + 4) }),
          ],
        })
      ).complete,
      false,
    );
    check((await inspect()).checkpoint[providerKey], String(stamp + 3));
    await cmd({ type: "feed.prepare", id: bank });
    const pendingId = randomUUID(),
      claimId = randomUUID();
    await cmd({
      type: "feed.claim",
      id: pendingId,
      name: "Synthetic claim boundary",
      claim_id: claimId,
      expected_version: 0,
    });
    await worker({ action: "claim.send", id: pendingId, claim_id: claimId });
    await rejects(
      worker({ action: "claim.send", id: pendingId, claim_id: claimId }),
      /ACCT_FEED_CLAIM/,
    );
    await rejects(
      worker({
        action: "claim.complete",
        id: pendingId,
        claim_id: randomUUID(),
        ciphertext: "synthetic-encrypted-access",
      }),
      /ACCT_FEED_CLAIM/,
    );
    await worker({
      action: "claim.complete",
      id: pendingId,
      claim_id: claimId,
      ciphertext: "synthetic-encrypted-access",
    });
    await rejects(
      worker({
        action: "claim.fail",
        id: pendingId,
        claim_id: claimId,
        error: "late failure",
      }),
      /ACCT_FEED_CLAIM/,
    );
    const feeds = (
      await db.query<{ r: any }>("SELECT accounting.context('feeds') r")
    ).rows[0].r;
    check(
      feeds.connections.find((c: any) => c.id === pendingId).status,
      "active",
    );
    check(JSON.stringify(feeds).includes("synthetic-encrypted-access"), false);
    check(feeds.worker.source, "fixture");
    check(typeof feeds.worker.last_tick_at, "string");
    console.log(
      `SimpleFIN durable chunks, checkpoints and worker isolation: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
