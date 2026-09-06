import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
  fixtureOwner,
} from "../src/lib/accounting/fixtures";
import { sourceHash } from "../src/lib/accounting/server/simplefin-data";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const rejects = async (p: Promise<unknown>, pattern: RegExp) => {
    await assert.rejects(p, pattern);
    checks++;
  };
  const owner = async () => {
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
  };
  const cmd = async (c: object, key = randomUUID()): Promise<any> =>
    (
      await db.query<{ r: any }>("SELECT acct_operate($1,$2::jsonb) r", [
        key,
        JSON.stringify(c),
      ])
    ).rows[0].r;
  const server = async (c: object): Promise<any> => {
    await db.exec("RESET ROLE; SET ROLE service_role");
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    try {
      return (
        await db.query<{ r: any }>("SELECT acct_feed_server($1::jsonb) r", [
          JSON.stringify(c),
        ])
      ).rows[0].r;
    } finally {
      await owner();
    }
  };
  const view = async (): Promise<any> =>
    (await db.query<{ r: any }>("SELECT acct_feed_view() r")).rows[0].r;
  const now = Math.floor(Date.now() / 1000),
    start = now - 86400 * 10,
    end = now - 10,
    hash = "a".repeat(64),
    cipher =
      "v1:" + "a".repeat(24) + ":" + "b".repeat(32) + ":" + "c".repeat(100);
  const conn = randomUUID(),
    claim = randomUUID();
  try {
    await db.exec("RESET ROLE");
    await owner();
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: [
        ...fixtureAccounts.map((a) => ({
          ...a,
          cash_kind:
            a.id === account(1)
              ? "bank"
              : a.id === account(3)
                ? "card"
                : "none",
        })),
        {
          id: account(11),
          code: "5999",
          name: "Uncategorized expense",
          account_type: "expense",
          normal_side: "debit",
          purpose: "uncategorized_expense",
          cash_kind: "none",
        },
      ],
    });
    await rejects(
      db.query("SELECT * FROM acct_feed_secrets"),
      /permission denied/,
    );
    await rejects(
      db.query('SELECT acct_feed_server(\'{"type":"due"}\')'),
      /permission denied/,
    );
    await cmd({
      type: "feed.claim",
      id: conn,
      expected_version: 0,
      name: "Synthetic Bridge",
      claim_id: claim,
    });
    await rejects(
      server({ type: "claim.complete", id: claim, ciphertext: cipher }),
      /ACCT_FEED_CLAIM/,
    );
    await server({ type: "claim.send", id: claim });
    await rejects(server({ type: "claim.send", id: claim }), /ACCT_FEED_CLAIM/);
    await server({ type: "claim.complete", id: claim, ciphertext: cipher });
    await server({ type: "claim.complete", id: claim, ciphertext: cipher });
    check((await view()).connections[0].status, "active");
    check(JSON.stringify(await view()).includes(cipher), false);
    const backup = (await db.query<{ r: any }>("SELECT acct_books_backup() r"))
      .rows[0].r;
    check(backup.version, 9);
    check(Array.isArray(backup.feed_connections), true);
    check(backup.feed_secrets, undefined);
    check(JSON.stringify(backup).includes(cipher), false);
    await rejects(
      server({ type: "lease", id: conn, run_id: randomUUID() }),
      /ACCT_FORBIDDEN/,
    );
    const run = randomUUID();
    const leased = await server({
      type: "lease",
      id: conn,
      run_id: run,
      actor_id: fixtureOwner,
    });
    check(leased.ciphertext, cipher);
    await rejects(
      server({
        type: "lease",
        id: conn,
        run_id: randomUUID(),
        actor_id: fixtureOwner,
      }),
      /ACCT_FEED_BUSY/,
    );
    const discovery = randomUUID();
    await server({
      type: "request",
      run_id: run,
      id: discovery,
      discovery: true,
      from: start,
      to: end,
    });
    const begin = async (
      request_id: string,
      run_id: string,
      extra: Record<string, unknown> = {},
    ) => {
      const id = randomUUID();
      await server({
        type: "window.begin",
        run_id,
        request_id,
        id,
        provider_connection_id: "institution-a",
        provider_account_id: "checking",
        name: "Checking",
        institution: "Synthetic institution",
        currency: "USD",
        protocol: "2.0.0-draft-2026-03-19",
        response_hash: hash,
        account_hash: hash,
        balance_cents: "10000",
        available_cents: null,
        balance_at: now,
        issues: [],
        complete: true,
        expected_count: 0,
        ...extra,
      });
      return id;
    };
    const discoveryWindow = await begin(discovery, run);
    await server({ type: "window.finish", run_id: run, id: discoveryWindow });
    await server({ type: "finish", run_id: run, complete: true });
    let v = await view();
    const identity = v.identities[0].id;
    check(v.identities[0].ownership, "unreviewed");
    check(v.identities[0].balance.available_cents, null);
    await cmd({
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
      reason: "Verified against synthetic checking statement",
    });
    v = await view();
    const feed = v.identities[0].feed_account_id;
    check(v.identities[0].account.checkpoint, null);
    check(v.identities[0].account.can_edit_settings, true);
    await db.exec('BEGIN');
    await cmd({type:'feed.map',id:identity,expected_version:2,expected_feed_version:1,ownership:'company',account_id:account(1),history_start:String(start),posting_timezone:'UTC',movement_sign:1,balance_sign:-1,reviewed:true,reason:'Correct setup before receiving financial observations'});
    check((await view()).identities[0].account.balance_sign,-1);
    await rejects(cmd({type:'feed.map',id:identity,expected_version:3,expected_feed_version:1,ownership:'company',account_id:account(1),history_start:String(start),posting_timezone:'UTC',movement_sign:1,balance_sign:1,reviewed:true,reason:'Stale settings review'}),/ACCT_STALE_VERSION/);
    await db.exec('ROLLBACK');
    const run2 = randomUUID();
    check(
      (
        await server({
          type: "lease",
          id: conn,
          run_id: run2,
          actor_id: fixtureOwner,
        })
      ).identities.length,
      1,
    );
    const req = randomUUID();
    await server({
      type: "request",
      run_id: run2,
      id: req,
      identity_id: identity,
      discovery: false,
      from: start,
      to: end,
    });
    const w = await begin(req, run2, { expected_count: 2 });
    await rejects(
      server({ type: "window.finish", run_id: run2, id: w }),
      /ACCT_IMPORT_INCOMPLETE/,
    );
    const tx = [
      {
        external_id: "posted-1",
        state: "posted",
        posted: now - 86400,
        transacted_at: null,
        amount_cents: "-1234",
        description: "Synthetic cloud bill",
        hash,
        raw: { id: "posted-1", amount: "-12.34" },
      },
      {
        external_id: "pending-1",
        state: "pending",
        posted: 0,
        transacted_at: null,
        amount_cents: "-200",
        description: "Pending authorization",
        hash,
        raw: { id: "pending-1", pending: true },
      },
    ];
    await server({
      type: "window.append",
      run_id: run2,
      id: w,
      offset: 0,
      transactions: tx,
    });
    await rejects(
      server({
        type: "window.append",
        run_id: run2,
        id: w,
        offset: 0,
        transactions: tx,
      }),
      /ACCT_IMPORT_CHECKPOINT/,
    );
    check((await view()).identities[0].account.checkpoint, null);
    await server({ type: "window.finish", run_id: run2, id: w });
    check((await view()).identities[0].account.checkpoint, String(end));
    await server({ type: "finish", run_id: run2, complete: true });
    await db.exec("RESET ROLE; SET ROLE service_role");
    await rejects(
      db.query("SELECT * FROM acct_journal_entries"),
      /permission denied/,
    );
    await rejects(
      db.query(
        'SELECT acct_operate(gen_random_uuid(),\'{"type":"feed.prepare"}\')',
      ),
      /permission denied/,
    );
    await owner();
    const month = new Date(now * 1000).toISOString().slice(0, 7) + "-01";
    const close = async () =>
      (await db.query<{ r: any }>("SELECT acct_close_checklist($1) r", [month]))
        .rows[0].r;
    check((await close()).unreviewed_feed_movements, 1);
    let batch = await cmd({ type: "feed.prepare", id: feed });
    check(batch.count, 1);
    check((await close()).unreviewed_feed_movements, 0);
    check((await cmd({ type: "feed.prepare", id: feed })).count, 0);
    let imports = (
      await db.query<{ r: any }>("SELECT acct_imports($1,0) r", [batch.id])
    ).rows[0].r;
    check(imports.groups[0].bank_amount_cents, "-1234");
    check(imports.groups[0].status, "new");
    await cmd({
      type: "import.apply",
      id: batch.id,
      expected_version: batch.version,
      group_ids: [imports.groups[0].id],
    });
    check((await close()).unverified_imports, 1);
    // Routine bank review needs posted movements and independent statements.
    await db.exec("BEGIN");
    const staged = (
      await db.query<{ r: any }>("SELECT acct_imports($1,0) r", [batch.id])
    ).rows[0].r;
    const entryId = staged.groups[0].entry_id;
    const saved = await cmd({
      type: "draft.save",
      id: entryId,
      expected_version: 2,
      entry_date: staged.groups[0].entry_date,
      memo: "Reviewed synthetic movement",
      lines: [
        { account_id: account(1), amount_cents: "-1234", memo: "" },
        { account_id: account(6), amount_cents: "1234", memo: "" },
      ],
    });
    await cmd({
      type: "entry.post",
      id: entryId,
      expected_version: saved.version,
    });
    await cmd({
      type: "import.finish",
      id: batch.id,
      expected_version: staged.batches.find((b: any) => b.id === batch.id)
        .version,
    });
    check((await close()).unverified_imports, 0);
    check((await close()).unreconciled_accounts, 1);
    await db.exec("ROLLBACK");
    const run3 = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: run3,
      actor_id: fixtureOwner,
    });
    const req3 = randomUUID();
    await server({
      type: "request",
      run_id: run3,
      id: req3,
      identity_id: identity,
      discovery: false,
      from: end - 432000,
      to: end + 1,
    });
    const w3 = await begin(req3, run3, {
      expected_count: 1,
      complete: false,
      issues: [{ code: "act.incomplete", message: "Institution incomplete" }],
    });
    await server({
      type: "window.append",
      run_id: run3,
      id: w3,
      offset: 0,
      transactions: [
        {
          ...tx[0],
          hash: sourceHash({ metadata: 2 }),
          raw: { ...tx[0].raw, description: "Updated metadata" },
        },
      ],
    });
    await server({ type: "window.finish", run_id: run3, id: w3 });
    check((await view()).identities[0].account.checkpoint, String(end));
    check(
      (await server({ type: "finish", run_id: run3, complete: true })).complete,
      false,
    );
    batch = await cmd({ type: "feed.prepare", id: feed });
    imports = (
      await db.query<{ r: any }>("SELECT acct_imports($1,0) r", [batch.id])
    ).rows[0].r;
    check(imports.groups[0].status, "duplicate");
    // Changed amount keeps the earlier draft and becomes an explicit exception.
    const run4 = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: run4,
      actor_id: fixtureOwner,
    });
    const req4 = randomUUID();
    await server({
      type: "request",
      run_id: run4,
      id: req4,
      identity_id: identity,
      discovery: false,
      from: end - 432000,
      to: end + 2,
    });
    const w4 = await begin(req4, run4, { expected_count: 1 });
    await server({
      type: "window.append",
      run_id: run4,
      id: w4,
      offset: 0,
      transactions: [
        {
          ...tx[0],
          amount_cents: "-1300",
          hash: sourceHash({ changed: 1 }),
          raw: { id: "posted-1", amount: "-13.00" },
        },
      ],
    });
    await server({ type: "window.finish", run_id: run4, id: w4 });
    await server({ type: "finish", run_id: run4, complete: true });
    batch = await cmd({ type: "feed.prepare", id: feed });
    imports = (
      await db.query<{ r: any }>("SELECT acct_imports($1,0) r", [batch.id])
    ).rows[0].r;
    check(imports.groups[0].status, "exception");
    await rejects(
      cmd({
        type: "feed.map",
        id: identity,
        expected_version: 2,
        ownership: "company",
        account_id: account(1),
        history_start: String(start),
        posting_timezone: "UTC",
        movement_sign: -1,
        balance_sign: 1,
        reviewed: true,
        reason: "Should be refused",
      }),
      /ACCT_FEED_MAPPING_IMMUTABLE/,
    );
    const repeatRun = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: repeatRun,
      actor_id: fixtureOwner,
    });
    const repeatReq = randomUUID();
    await server({
      type: "request",
      run_id: repeatRun,
      id: repeatReq,
      identity_id: identity,
      discovery: false,
      from: end + 2 - 432000,
      to: end + 3,
    });
    const repeatWindow = await begin(repeatReq, repeatRun, {
      expected_count: 1,
    });
    await server({
      type: "window.append",
      run_id: repeatRun,
      id: repeatWindow,
      offset: 0,
      transactions: [
        {
          ...tx[0],
          amount_cents: "-1300",
          hash: sourceHash({ changed: 1 }),
          raw: { id: "posted-1", amount: "-13.00" },
        },
      ],
    });
    await server({
      type: "window.finish",
      run_id: repeatRun,
      id: repeatWindow,
    });
    await server({ type: "finish", run_id: repeatRun, complete: true });
    check((await cmd({ type: "feed.prepare", id: feed })).count, 0);
    check(Number((await view()).queue[0].ready), 0);
    const missingRun = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: missingRun,
      actor_id: fixtureOwner,
    });
    await server({
      type: "request",
      run_id: missingRun,
      id: randomUUID(),
      identity_id: identity,
      discovery: false,
      from: end + 3 - 432000,
      to: end + 4,
    });
    check(
      (await server({ type: "finish", run_id: missingRun, complete: true }))
        .complete,
      false,
    );
    check((await view()).identities[0].account.checkpoint, String(end + 3));
    const regressRun = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: regressRun,
      actor_id: fixtureOwner,
    });
    const regressReq = randomUUID();
    await server({
      type: "request",
      run_id: regressRun,
      id: regressReq,
      identity_id: identity,
      discovery: false,
      from: end + 3 - 432000,
      to: end + 4,
    });
    const regressWindow = await begin(regressReq, regressRun, {
      expected_count: 1,
    });
    await server({
      type: "window.append",
      run_id: regressRun,
      id: regressWindow,
      offset: 0,
      transactions: [
        {
          ...tx[0],
          state: "pending",
          posted: 0,
          hash: sourceHash({ regressed: 1 }),
          raw: { pending: true },
        },
      ],
    });
    await server({
      type: "window.finish",
      run_id: regressRun,
      id: regressWindow,
    });
    check(
      (await server({ type: "finish", run_id: regressRun, complete: true }))
        .complete,
      false,
    );
    check((await view()).identities[0].account.checkpoint, String(end + 3));
    check(
      (await view()).identities[0].balance.issues[0].code,
      "source_regression",
    );
    const run5 = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: run5,
      actor_id: fixtureOwner,
    });
    v = await view();
    await cmd({
      type: "feed.disconnect",
      id: conn,
      expected_version: v.connections[0].version,
      reason: "Synthetic disconnect test",
    });
    await rejects(
      server({ type: "finish", run_id: run5, complete: true }),
      /ACCT_FEED_LEASE/,
    );
    check((await view()).connections[0].scheduled, false);
    v = await view();
    const claim2 = randomUUID();
    await cmd({
      type: "feed.claim",
      id: conn,
      expected_version: v.connections[0].version,
      name: "Reconnected synthetic Bridge",
      claim_id: claim2,
    });
    await server({ type: "claim.send", id: claim2 });
    await server({ type: "claim.complete", id: claim2, ciphertext: cipher });
    const reconnectRun = randomUUID();
    check(
      (
        await server({
          type: "lease",
          id: conn,
          run_id: reconnectRun,
          actor_id: fixtureOwner,
        })
      ).identities.length,
      0,
    );
    const reconnectReq = randomUUID();
    await server({
      type: "request",
      run_id: reconnectRun,
      id: reconnectReq,
      discovery: true,
      from: start,
      to: end,
    });
    const reconnectWindow = await begin(reconnectReq, reconnectRun, {
      provider_connection_id: "institution-new",
      provider_account_id: "checking-new",
    });
    await server({
      type: "window.finish",
      run_id: reconnectRun,
      id: reconnectWindow,
    });
    await server({ type: "finish", run_id: reconnectRun, complete: true });
    v = await view();
    const newIdentity = v.identities.find(
      (a: any) => a.provider_account_id === "checking-new",
    );
    await cmd({
      type: "feed.map",
      id: newIdentity.id,
      expected_version: 1,
      ownership: "company",
      account_id: account(1),
      history_start: String(start),
      posting_timezone: "UTC",
      movement_sign: 1,
      balance_sign: 1,
      reviewed: true,
      reason: "Same existing account after reconnect",
    });
    v = await view();
    check(v.accounts.length, 1);
    check(
      v.identities.find((a: any) => a.id === newIdentity.id).feed_account_id,
      feed,
    );
    check(v.accounts[0].checkpoint, String(end + 3));
    await cmd({
      type: "feed.skip",
      id: feed,
      expected_version: v.accounts[0].version,
      through: String(now - 1),
      reason: "Institution cannot provide this old range, retain evidence gap",
    });
    v = await view();
    check(v.gaps.length, 1);
    check(v.accounts[0].checkpoint, String(now - 1));
    await cmd({
      type: "feed.schedule",
      id: conn,
      expected_version: v.connections[0].version,
      enabled: true,
    });
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE acct_feed_connections SET next_sync_at=now()-interval '1 second' WHERE id=$1",
      [conn],
    );
    await owner();
    const workerRun = randomUUID();
    const workerLease = await server({
      type: "lease",
      id: conn,
      run_id: workerRun,
    });
    check(workerLease.identities.length, 1);
    check(workerLease.identities[0].resume_floor, String(now - 1));
    check((await view()).runs[0].actor_kind, "worker");
    await rejects(
      server({
        type: "request",
        run_id: workerRun,
        id: randomUUID(),
        discovery: true,
        from: start,
        to: end,
      }),
      /ACCT_FORBIDDEN/,
    );
    const workerReq = randomUUID();
    await server({
      type: "request",
      run_id: workerRun,
      id: workerReq,
      identity_id: newIdentity.id,
      discovery: false,
      from: now - 1,
      to: now,
    });
    await server({
      type: "fail",
      run_id: workerRun,
      code: "rate_limited",
      error: "Synthetic rate limit",
      retry_seconds: 3600,
    });
    await rejects(
      server({
        type: "lease",
        id: conn,
        run_id: randomUUID(),
        actor_id: fixtureOwner,
      }),
      /ACCT_FEED_BACKOFF/,
    );
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE acct_feed_connections SET retry_at=NULL WHERE id=$1",
      [conn],
    );
    await owner();
    const expireRun = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: expireRun,
      actor_id: fixtureOwner,
    });
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE acct_feed_connections SET lease_until=now()-interval '1 second' WHERE id=$1",
      [conn],
    );
    await owner();
    await rejects(
      server({ type: "finish", run_id: expireRun, complete: true }),
      /ACCT_FEED_LEASE/,
    );
    const fenceRun = randomUUID();
    await server({
      type: "lease",
      id: conn,
      run_id: fenceRun,
      actor_id: fixtureOwner,
    });
    check(
      (await view()).runs.find((r: any) => r.id === expireRun).status,
      "expired",
    );
    await rejects(
      server({ type: "finish", run_id: expireRun, complete: true }),
      /ACCT_FEED_LEASE/,
    );
    await db.exec("RESET ROLE");
    const requestCount = Number(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM acct_feed_requests",
        )
      ).rows[0].n,
    );
    for (let i = requestCount; i < 24; i++)
      await db.query(
        "INSERT INTO acct_feed_requests(id,run_id,from_stamp,to_stamp,discovery) VALUES($1,$2,$3,$4,true)",
        [randomUUID(), fenceRun, start, end],
      );
    await owner();
    await rejects(
      server({
        type: "request",
        run_id: fenceRun,
        id: randomUUID(),
        identity_id: newIdentity.id,
        discovery: false,
        from: now - 1,
        to: now,
      }),
      /ACCT_FEED_QUOTA/,
    );
    v = await view();
    await cmd({
      type: "feed.disconnect",
      id: conn,
      expected_version: v.connections[0].version,
      reason: "Final synthetic credential cleanup",
    });
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM acct_feed_secrets",
        )
      ).rows[0].n,
      0,
    );
    check(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM acct_journal_entries WHERE status='posted'",
        )
      ).rows[0].n,
      0,
    );
    check(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM acct_audit_log WHERE before_value::text LIKE $1 OR after_value::text LIKE $1",
          ["%" + cipher + "%"],
        )
      ).rows[0].n,
      0,
    );
    await rejects(
      db.query("DELETE FROM acct_feed_observations"),
      /ACCT_APPEND_ONLY/,
    );
    await rejects(
      db.query("UPDATE acct_feed_windows SET balance_cents=0 WHERE id=$1", [w]),
      /ACCT_APPEND_ONLY/,
    );
    console.log(
      `SimpleFIN leases, ingestion, review, isolation and recovery: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
