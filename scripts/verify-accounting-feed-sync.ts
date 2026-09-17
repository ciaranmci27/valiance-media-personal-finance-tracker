import assert from "node:assert/strict";
import {
  planRequests,
  runDueFeeds,
  syncSimpleFin,
  type FeedRpc,
} from "../supabase/functions/_shared/feeds/sync.ts";
import { decryptVersioned } from "../supabase/functions/_shared/feeds/aes-gcm.ts";
import {
  SimpleFinError,
  type ProviderTransport,
} from "../src/lib/accounting/server/simplefin-transport";
import { encryptWith, decryptWith } from "../src/lib/crypto/aes";
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const now = Date.parse("2026-06-20T12:00:00Z") / 1000,
    start = now - 864000,
    connection = "00000000-0000-4000-8000-000000000001";
  const identity = (
    n: number,
    checkpoint: string | null = null,
    historyStart = start,
  ) => ({
    id: String(n),
    provider_connection_id: "institution-" + n,
    provider_account_id: "bank-" + n,
    history_start: String(historyStart),
    checkpoint,
    resume_floor: null,
  });
  const conn = (n: number) => ({
    conn_id: "institution-" + n,
    name: "Synthetic bank " + n,
    org_id: "org" + n,
    sfin_url: "https://metadata.invalid/no-network",
  });
  const account = (n: number) => ({
    id: "bank-" + n,
    conn_id: "institution-" + n,
    name: "Account " + n,
    currency: "USD",
    balance: "123.45",
    "balance-date": now,
    transactions: [
      {
        id: "T1",
        posted: now - 86400,
        amount: "-10.00",
        description: "Synthetic movement",
      },
    ],
  });
  let calls: Record<string, unknown>[] = [],
    identities = [identity(1), identity(2)],
    networkCalls = 0;
  const rpc: FeedRpc = async (command) => {
    calls.push(command);
    if (command.action === "lease")
      return {
        id: command.run_id,
        acquired: true,
        access_url_encrypted: "opaque ciphertext",
        identities,
      };
    if (command.action === "complete")
      return { complete: command.complete ?? true };
    return { id: command.id };
  };
  const options = {
    connectionId: connection,
    actorId: "owner",
    rpc,
    decrypt: () => "https://synthetic:secret@bridge.simplefin.org/simplefin",
    now: () => now,
  };
  // Two mapped accounts with the same window share one all-accounts request:
  // SimpleFIN budgets requests per day, so a connection costs one per run.
  let transport: ProviderTransport = async (url) => {
    networkCalls++;
    check(calls[0]?.action, "lease");
    check(url.searchParams.get("version"), "1");
    check(url.searchParams.get("account"), null);
    check(url.searchParams.get("pending"), "1");
    check(url.searchParams.get("end-date"), String(now + 1));
    return {
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        connections: [conn(1), conn(2)],
        accounts: [account(1), account(2)],
        errlist: [
          {
            code: "act.unavailable",
            msg: "Institution needs attention",
            conn_id: "institution-1",
            account_id: "bank-1",
          },
        ],
      }),
    };
  };
  let result = await syncSimpleFin({ ...options, transport });
  check(networkCalls, 1);
  check(result.complete, false);
  check(result.received, 2);
  check(
    calls
      .filter((c) => c.partial)
      .map((c) => (c.accounts as { complete: boolean }[])[0].complete),
    [false, true],
  );
  check(
    calls
      .filter((c) => c.partial)
      .map((c) => (c.accounts as { through: string }[])[0].through),
    [String(now + 1), String(now + 1)],
  );
  check(calls.filter((c) => c.partial).length, 2);
  check(JSON.stringify(result).includes("secret"), false);
  // Windows that cannot share a 90-day request are split; the rest group.
  const farBehind = identity(3, String(now - 200 * 86400), now - 400 * 86400);
  const plans = planRequests([identity(1), farBehind, identity(2)], now);
  check(plans.length, 2);
  check(
    plans.map((p) => p.identities.map((i) => i.id)),
    [["3"], ["1", "2"]],
  );
  check(plans[0].window.end - plans[0].window.start <= 90 * 86400, true);
  check(plans[1].window.end, now + 1);
  check(
    planRequests([identity(1, String(now - 3600)), identity(2)], now).length,
    1,
  );
  calls = [];
  networkCalls = 0;
  identities = [identity(1)];
  transport = async () => ({
    status: 200,
    retryAfter: null,
    body: JSON.stringify({
      connections: [conn(1), conn(2)],
      accounts: [account(2)],
      errlist: [],
    }),
  });
  result = await syncSimpleFin({ ...options, transport });
  check(result.complete, false);
  check(
    calls.some((c) => c.partial),
    false,
  );
  check(calls.at(-1)?.action, "complete");
  calls = [];
  transport = async (url) => {
    check(url.searchParams.get("balances-only"), "1");
    return {
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        connections: [conn(1)],
        accounts: [account(1)],
        errlist: [],
      }),
    };
  };
  result = await syncSimpleFin({ ...options, discover: true, transport });
  check(result.received, 0);
  check(
    calls.some(
      (c) =>
        c.partial &&
        (c.accounts as { transactions: unknown[] }[])[0].transactions.length >
          0,
    ),
    false,
  );
  check(
    (calls.find((c) => c.partial)?.accounts as { transactions: unknown[] }[])[0]
      .transactions.length,
    0,
  );
  calls = [];
  transport = async () => ({
    status: 200,
    retryAfter: null,
    body: JSON.stringify({
      connections: [conn(1)],
      accounts: [{ ...account(1), currency: "EUR" }],
      errlist: [],
    }),
  });
  result = await syncSimpleFin({ ...options, transport });
  check(result.complete, false);
  check(
    calls.some(
      (c) =>
        c.partial &&
        (c.accounts as { transactions: unknown[] }[])[0].transactions.length >
          0,
    ),
    false,
  );
  calls = [];
  transport = async () => ({
    status: 403,
    body: "https://user:credential@provider.invalid",
    retryAfter: null,
  });
  await assert.rejects(
    syncSimpleFin({ ...options, transport }),
    (e: unknown) => e instanceof SimpleFinError && e.code === "access_revoked",
  );
  checks++;
  check(calls.at(-1)?.action, "fail");
  check(JSON.stringify(calls).includes("credential"), false);
  calls = [];
  // A rate limit carries the provider's wait into the fail record.
  transport = async () => ({ status: 429, body: "", retryAfter: "7200" });
  await assert.rejects(
    syncSimpleFin({ ...options, transport }),
    (e: unknown) => e instanceof SimpleFinError && e.code === "rate_limited",
  );
  checks++;
  check(calls.at(-1)?.retry_seconds, 7200);
  calls = [];
  await assert.rejects(
    syncSimpleFin({
      ...options,
      transport,
      decrypt: () => {
        throw new Error("private key content must never leak");
      },
    }),
    (e: unknown) =>
      e instanceof SimpleFinError && e.code === "decryption_failed",
  );
  checks++;
  check(JSON.stringify(calls).includes("private key content"), false);
  check(
    calls.some((c) => c.partial),
    false,
  );
  calls = [];
  identities = [identity(1), identity(2)];
  transport = async () => ({
    status: 200,
    retryAfter: null,
    body: JSON.stringify({
      connections: [conn(1), conn(2)],
      accounts: [account(1), account(2)],
      errlist: [],
    }),
  });
  const failStorage: FeedRpc = async (c) => {
    if (c.partial && calls.filter((c) => c.partial).length === 1)
      throw new Error("storage failure");
    return rpc(c);
  };
  await assert.rejects(
    syncSimpleFin({ ...options, rpc: failStorage, transport }),
    /Saved observations and checkpoints were retained/,
  );
  checks++;
  check(calls.filter((c) => c.partial).length, 1);
  check(calls.at(-1)?.action, "fail");
  // A worker tick names its source, runs every due connection, keeps going
  // past one that fails, and stops when the budget is spent.
  calls = [];
  identities = [identity(1)];
  const second = "00000000-0000-4000-8000-000000000002";
  const dueRpc: FeedRpc = async (command) => {
    calls.push(command);
    if (command.action === "due") return [connection, second];
    if (command.action === "lease" && command.id === second)
      return { id: command.run_id, acquired: false };
    return rpc(command);
  };
  const tick = await runDueFeeds({
    rpc: dueRpc,
    decrypt: options.decrypt,
    transport,
    source: "fixture",
    now: () => now,
  });
  check(calls[0], { action: "due", source: "fixture" });
  check(tick.due, 2);
  check(tick.processed, 2);
  check(
    tick.runs.map((r) => [r.connection_id, r.ok]),
    [
      [connection, true],
      [second, false],
    ],
  );
  check(tick.runs[1].error?.includes("already running"), true);
  let elapsed = 0;
  const slowTick = await runDueFeeds({
    rpc: dueRpc,
    decrypt: options.decrypt,
    transport,
    source: "fixture",
    budgetSeconds: 10,
    now: () => now + (elapsed += 6),
  });
  check(slowTick.due, 2);
  check(slowTick.processed, 1);
  const base = "ACCOUNTING_SYNTHETIC_CRYPTO_KEY";
  process.env[base] = "synthetic-test-only-key-material-111111111111";
  process.env[base + "_V2"] = "synthetic-test-only-key-material-222222222222";
  try {
    const one = encryptWith(base, "synthetic access secret"),
      two = encryptWith(base, "synthetic access secret", 2);
    check(one.startsWith("v1:"), true);
    check(two.startsWith("v2:"), true);
    check(decryptWith(base, one), "synthetic access secret");
    check(decryptWith(base, two), "synthetic access secret");
    check(one === encryptWith(base, "synthetic access secret"), false);
    assert.throws(() =>
      decryptWith(base, one.slice(0, -2) + (one.endsWith("00") ? "01" : "00")),
    );
    checks++;
    // The edge function reads the same ciphertext with Web Crypto.
    const secretFor = (version: number) =>
      process.env[version === 1 ? base : `${base}_V${version}`];
    check(await decryptVersioned(one, secretFor), "synthetic access secret");
    check(await decryptVersioned(two, secretFor), "synthetic access secret");
    check(
      await decryptVersioned(one.slice(3), secretFor),
      "synthetic access secret",
    );
    await assert.rejects(
      decryptVersioned(
        one.slice(0, -2) + (one.endsWith("00") ? "01" : "00"),
        secretFor,
      ),
    );
    checks++;
    await assert.rejects(
      decryptVersioned(two, () => undefined),
      /not set/,
    );
    checks++;
    process.env[base] = "wrong key";
    assert.throws(() => decryptWith(base, one));
    checks++;
    await assert.rejects(decryptVersioned(one, secretFor));
    checks++;
  } finally {
    delete process.env[base];
    delete process.env[base + "_V2"];
  }
  console.log(
    `SimpleFIN worker failure boundaries and encryption: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
