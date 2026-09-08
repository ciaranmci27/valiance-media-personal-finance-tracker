import assert from "node:assert/strict";
import {
  syncSimpleFin,
  type FeedRpc,
} from "../src/lib/accounting/server/simplefin-sync";
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
  const identity = (n: number) => ({
    id: String(n),
    provider_connection_id: "institution-" + n,
    provider_account_id: "bank-" + n,
    history_start: String(start),
    checkpoint: null,
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
  let transport: ProviderTransport = async (url) => {
    networkCalls++;
    check(calls[0]?.action, "lease");
    check(url.searchParams.get("version"), "1");
    check(url.searchParams.get("account"), "bank-" + networkCalls);
    return {
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        connections: [conn(1), conn(2)],
        accounts: [account(networkCalls)],
        errlist:
          networkCalls === 1
            ? [
                {
                  code: "act.unavailable",
                  msg: "Institution needs attention",
                  conn_id: "institution-1",
                  account_id: "bank-1",
                },
              ]
            : [],
      }),
    };
  };
  let result = await syncSimpleFin({ ...options, transport });
  check(result.complete, false);
  check(result.received, 2);
  check(
    calls
      .filter((c) => c.partial)
      .map((c) => (c.accounts as { complete: boolean }[])[0].complete),
    [false, true],
  );
  check(calls.filter((c) => c.partial).length, 2);
  check(JSON.stringify(result).includes("secret"), false);
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
  transport = async () => ({
    status: 200,
    retryAfter: null,
    body: JSON.stringify({
      connections: [conn(1)],
      accounts: [account(1)],
      errlist: [],
    }),
  });
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
  transport = async (url) => ({
    status: 200,
    retryAfter: null,
    body: JSON.stringify({
      connections: [conn(1), conn(2)],
      accounts: [account(Number(url.searchParams.get("account")!.slice(-1)))],
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
    process.env[base] = "wrong key";
    assert.throws(() => decryptWith(base, one));
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
