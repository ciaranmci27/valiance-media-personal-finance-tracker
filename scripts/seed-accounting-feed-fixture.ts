import { Client } from "pg";
import { randomUUID } from "node:crypto";
import {
  fixtureOwner,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
import { sourceHash } from "../src/lib/accounting/server/simplefin-data";
// Explicit synthetic acceptance fixture, never an environment-selected database.
async function main() {
  const db = new Client({
    connectionString: "postgresql://postgres@127.0.0.1:5447/accounting_test",
  });
  await db.connect();
  try {
    const marker = await db.query("SELECT label FROM public.acct_test_marker");
    if (
      marker.rows.length !== 1 ||
      marker.rows[0].label !== "synthetic-local-accounting"
    )
      throw new Error("Synthetic database marker is missing.");
    if (
      !(
        await db.query(
          "SELECT to_regclass('public.acct_feed_connections') present",
        )
      ).rows[0].present
    ) {
      throw new Error(
        "Install the accounting migrations in this marked fixture before seeding bank observations.",
      );
    }
    const connection = "60000000-0000-4000-8000-000000000001";
    if (
      (
        await db.query("SELECT id FROM acct_feed_connections WHERE id=$1", [
          connection,
        ])
      ).rowCount
    ) {
      console.log("Synthetic feed fixture already exists.");
      return;
    }
    async function rpc(service: boolean, command: object) {
      await db.query("BEGIN");
      try {
        await db.query(
          service
            ? "SET LOCAL ROLE service_role"
            : "SET LOCAL ROLE authenticated",
        );
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [
          service ? "" : fixtureOwner,
        ]);
        const q = service
          ? await db.query("SELECT acct_feed_server($1::jsonb) r", [
              JSON.stringify(command),
            ])
          : await db.query("SELECT acct_operate($1,$2::jsonb) r", [
              randomUUID(),
              JSON.stringify(command),
            ]);
        await db.query("COMMIT");
        return q.rows[0].r;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }
    const claim = randomUUID();
    await rpc(false, {
      type: "feed.claim",
      id: connection,
      expected_version: 0,
      name: "Synthetic company banking",
      claim_id: claim,
    });
    await rpc(true, { type: "claim.send", id: claim });
    await rpc(true, {
      type: "claim.complete",
      id: claim,
      ciphertext:
        "v1:" + "a".repeat(24) + ":" + "b".repeat(32) + ":" + "c".repeat(100),
    });
    const now = Math.floor(Date.now() / 1000),
      start = Date.parse("2026-06-01T00:00:00Z") / 1000,
      end = Date.parse("2026-07-01T00:00:00Z") / 1000;
    const run = randomUUID(),
      request = randomUUID(),
      hash = sourceHash({ synthetic: true });
    await rpc(true, {
      type: "lease",
      id: connection,
      run_id: run,
      actor_id: fixtureOwner,
    });
    await rpc(true, {
      type: "request",
      run_id: run,
      id: request,
      discovery: true,
      from: start,
      to: end,
    });
    for (const row of [
      {
        provider: "checking",
        name: "Synthetic operating checking",
        balance: "1273725",
      },
      { provider: "card", name: "Synthetic business card", balance: "3000" },
      {
        provider: "personal",
        name: "Synthetic personal savings",
        balance: "80000",
      },
    ]) {
      const w = randomUUID();
      await rpc(true, {
        type: "window.begin",
        run_id: run,
        request_id: request,
        id: w,
        provider_connection_id: "synthetic-bank",
        provider_account_id: row.provider,
        name: row.name,
        institution: "Synthetic Bank",
        currency: "USD",
        protocol: "2.0.0-draft-2026-03-19",
        response_hash: hash,
        account_hash: hash,
        balance_cents: row.balance,
        available_cents: null,
        balance_at: now,
        issues: [],
        complete: true,
        expected_count: 0,
      });
      await rpc(true, { type: "window.finish", run_id: run, id: w });
    }
    await rpc(true, { type: "finish", run_id: run, complete: true });
    const identity = (
      await db.query(
        "SELECT id FROM acct_feed_identities WHERE connection_id=$1 AND provider_account_id='checking'",
        [connection],
      )
    ).rows[0].id;
    await rpc(false, {
      type: "feed.map",
      id: identity,
      expected_version: 1,
      ownership: "company",
      account_id: account(1),
      history_start: String(start),
      posting_timezone: "UTC",
      movement_sign: 1,
      balance_sign: 1,
      reviewed: true,
      reason:
        "Synthetic checking statement and UTC posting-date sample reviewed",
    });
    const run2 = randomUUID(),
      request2 = randomUUID(),
      w = randomUUID();
    await rpc(true, {
      type: "lease",
      id: connection,
      run_id: run2,
      actor_id: fixtureOwner,
    });
    await rpc(true, {
      type: "request",
      run_id: run2,
      id: request2,
      identity_id: identity,
      discovery: false,
      from: start,
      to: end,
    });
    await rpc(true, {
      type: "window.begin",
      run_id: run2,
      request_id: request2,
      id: w,
      provider_connection_id: "synthetic-bank",
      provider_account_id: "checking",
      name: "Synthetic operating checking",
      institution: "Synthetic Bank",
      currency: "USD",
      protocol: "2.0.0-draft-2026-03-19",
      response_hash: hash,
      account_hash: hash,
      balance_cents: "1273725",
      available_cents: null,
      balance_at: now,
      issues: [],
      complete: true,
      expected_count: 2,
    });
    await rpc(true, {
      type: "window.append",
      run_id: run2,
      id: w,
      offset: 0,
      transactions: [
        {
          external_id: "synthetic-feed-movement-1",
          posted: Date.parse("2026-06-18T12:00:00Z") / 1000,
          transacted_at: null,
          amount_cents: "-4275",
          description: "Synthetic cloud hosting source movement",
          state: "posted",
          hash: sourceHash({ id: 1, amount: "-42.75" }),
          raw: {
            id: "synthetic-feed-movement-1",
            amount: "-42.75",
            description: "Synthetic cloud hosting source movement",
          },
        },
        {
          external_id: "synthetic-feed-pending-1",
          posted: 0,
          transacted_at: null,
          amount_cents: "-500",
          description: "Synthetic pending authorization",
          state: "pending",
          hash: sourceHash({ id: 2, pending: true }),
          raw: {
            id: "synthetic-feed-pending-1",
            amount: "-5.00",
            pending: true,
          },
        },
      ],
    });
    await rpc(true, { type: "window.finish", run_id: run2, id: w });
    await rpc(true, { type: "finish", run_id: run2, complete: true });
    console.log(
      "Synthetic bank discovery, one posted source observation and one pending observation saved. No journals created.",
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Synthetic setup failed.");
  process.exitCode = 1;
});
