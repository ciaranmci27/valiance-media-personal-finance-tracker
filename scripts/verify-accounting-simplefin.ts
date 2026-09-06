import assert from "node:assert/strict";
import {
  bridgeUrl,
  claimSimpleFin,
  publicAddress,
  requestSimpleFin,
  safeProviderMessage,
  setupClaimUrl,
  SimpleFinError,
  type ProviderTransport,
} from "../src/lib/accounting/server/simplefin-transport";
import {
  parseSimpleFin,
  postingDate,
  sourceHash,
  syncWindow,
  SYNC_WINDOW_SECONDS,
} from "../src/lib/accounting/server/simplefin-data";
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const rejects = async (fn: () => unknown, code: string) => {
    await assert.rejects(
      async () => fn(),
      (e: unknown) => e instanceof SimpleFinError && e.code === code,
    );
    checks++;
  };
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "0.1.2.3",
    "169.254.169.254",
    "192.168.2.1",
    "172.31.0.1",
    "100.64.2.2",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.2",
    "203.0.113.5",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:0db8::1",
    "2001:db8::1",
    "2001::1",
    "2001:0100::1",
    "2002:7f00:1::",
    "3fff::1",
    "not an IP",
  ])
    check(publicAddress(ip), false);
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    check(publicAddress(ip), true);
  for (const url of [
    "http://bridge.simplefin.org/simplefin",
    "https://evil.test/simplefin",
    "https://bridge.simplefin.org.evil.test/simplefin",
    "https://bridge.simplefin.org:1234/simplefin",
    "https://bridge.simplefin.org./simplefin",
  ])
    await rejects(() => bridgeUrl(url, "access"), "invalid_host");
  for (const url of [
    "https://u:p@bridge.simplefin.org/simplefin?x=y",
    "https://u:p@bridge.simplefin.org/simplefin/else",
    "https://u%3Aa:p@bridge.simplefin.org/simplefin",
    "https://u:p%0Axx@bridge.simplefin.org/simplefin",
  ])
    await rejects(() => bridgeUrl(url, "access"), "invalid_access");
  check(
    bridgeUrl("https://u:p%3Aq@beta-bridge.simplefin.org/simplefin", "access")
      .hostname,
    "beta-bridge.simplefin.org",
  );
  const token = Buffer.from(
    "https://bridge.simplefin.org/simplefin/claim/example",
  ).toString("base64");
  check(setupClaimUrl(token).pathname, "/simplefin/claim/example");
  await rejects(() => setupClaimUrl("bad token"), "invalid_token");
  await rejects(
    () =>
      setupClaimUrl(
        Buffer.from("http://localhost/simplefin/claim/test").toString("base64"),
      ),
    "invalid_host",
  );
  check(
    safeProviderMessage(
      "Error https://u:secret@host.test/path Basic abc123\nRetry",
    ),
    "Error [provider URL] [credentials] Retry",
  );
  let calls = 0;
  const transport: ProviderTransport = async (url, method, auth) => {
    calls++;
    check(method, "GET");
    check(url.username, "");
    check(url.password, "");
    check(url.searchParams.get("version"), "2");
    check(auth, `Basic ${Buffer.from("u:p:q").toString("base64")}`);
    return { status: 200, body: '{"ok":true}', retryAfter: null };
  };
  check(
    await requestSimpleFin(
      "https://u:p%3Aq@bridge.simplefin.org/simplefin",
      { version: "1", "end-date": "123" },
      transport,
    ),
    { ok: true },
  );
  check(calls, 1);
  const response =
    (status: number, body = "no"): ProviderTransport =>
    async () => ({ status, body, retryAfter: "12" });
  await rejects(() => claimSimpleFin(token, response(403)), "claim_rejected");
  await rejects(() => claimSimpleFin(token, response(302)), "redirect_refused");
  await rejects(
    () =>
      claimSimpleFin(token, response(200, "https://u:p@evil.test/simplefin")),
    "invalid_host",
  );
  for (const [status, code] of [
    [403, "access_revoked"],
    [402, "subscription_required"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [200, "invalid_json"],
  ] as const)
    await rejects(
      () =>
        requestSimpleFin(
          "https://u:p@bridge.simplefin.org/simplefin",
          {},
          response(status),
        ),
      code,
    );
  const day = 86400,
    now = 180 * day,
    w = { start: 100 * day, end: 150 * day };
  check(syncWindow(0, null, now), {
    start: 0,
    end: SYNC_WINDOW_SECONDS,
    catchingUp: true,
  });
  check(syncWindow(0, 90 * day, now), {
    start: 85 * day,
    end: 175 * day,
    catchingUp: true,
  });
  check(syncWindow(0, now, now), {
    start: 175 * day,
    end: now + 1,
    catchingUp: false,
  });
  await rejects(() => syncWindow(now + 1, null, now), "invalid_window");
  check(
    postingDate(Date.parse("2026-01-01T01:00:00Z") / 1000, "America/Phoenix"),
    "2025-12-31",
  );
  check(
    postingDate(Date.parse("2026-01-01T01:00:00Z") / 1000, "UTC"),
    "2026-01-01",
  );
  await rejects(() => postingDate(0, "UTC"), "invalid_date");
  const conn = (id: string) => ({
    conn_id: id,
    name: "Synthetic institution",
    org_id: "org",
    sfin_url: "https://untrusted.example/metadata",
  });
  const account = (id = "a", conn_id = "c") => ({
    id,
    conn_id,
    name: "Checking",
    currency: "USD",
    balance: "123.45",
    "balance-date": now,
    transactions: [
      {
        id: "T1",
        posted: 110 * day,
        amount: "-12.34",
        description: "Merchant",
      },
    ],
  });
  const feed = (
    accounts: unknown[] = [account()],
    errlist: unknown[] = [],
  ) => ({ connections: [conn("c"), conn("d")], accounts, errlist });
  let p = parseSimpleFin(feed(), w, now);
  check(p.complete, true);
  check(p.accounts[0].balance_cents, "12345");
  check(p.accounts[0].available_cents, null);
  check(p.accounts[0].transactions[0].amount_cents, "-1234");
  p = parseSimpleFin(
    feed(
      [account("same", "c"), account("same", "d")],
      [
        {
          code: "act.future_code",
          msg: "Failure https://u:secret@host.test",
          conn_id: "c",
          account_id: "same",
        },
      ],
    ),
    w,
    now,
  );
  check(
    p.accounts.map((a) => a.complete),
    [false, true],
  );
  check(p.accounts[0].issues[0].message, "Failure [provider URL]");
  for (const err of [
    { code: "act.bad", msg: "Missing conn", account_id: "not-this-account" },
    { code: "con.bad", msg: "Missing conn", account_id: "x" },
    { code: "new.unknown", msg: "Unknown scope", conn_id: "d" },
    { code: "gen.bad", msg: "Global", conn_id: "d" },
  ])
    check(
      parseSimpleFin(feed([account()], [err]), w, now).accounts[0].complete,
      false,
    );
  p = parseSimpleFin(
    feed([
      {
        ...account(),
        transactions: [
          { id: "p", posted: 0, amount: "1", description: "pending" },
          {
            id: "q",
            posted: 110 * day,
            amount: "2",
            description: "pending",
            pending: true,
          },
          { id: "z", posted: 110 * day, amount: "0.00", description: "zero" },
        ],
      },
    ]),
    w,
    now,
  );
  check(
    p.accounts[0].transactions.map((t) => t.state),
    ["pending", "pending", "nonfinancial"],
  );
  check(p.complete, true);
  for (const a of [
    { ...account(), transactions: undefined },
    { ...account(), currency: "EUR" },
    { ...account(), balance: "1.001" },
    { ...account(), "balance-date": 0 },
    {
      ...account(),
      transactions: [
        { id: "T1", posted: w.end, amount: "1", description: "outside" },
      ],
    },
    {
      ...account(),
      transactions: [...account().transactions, ...account().transactions],
    },
  ])
    check(parseSimpleFin(feed([a]), w, now).accounts[0].complete, false);
  check(
    parseSimpleFin(feed([account(), account()]), w, now).accounts[0].complete,
    false,
  );
  await rejects(
    () => parseSimpleFin({ accounts: [] }, w, now),
    "protocol_mismatch",
  );
  check(
    sourceHash({ b: 1, a: { z: 2, x: 3 } }),
    sourceHash({ a: { x: 3, z: 2 }, b: 1 }),
  );
  let nested: unknown = {};
  for (let i = 0; i < 42; i++) nested = { nested };
  await rejects(() => sourceHash(nested), "response_depth");
  console.log(
    `SimpleFIN protocol, scope, transport and security: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
