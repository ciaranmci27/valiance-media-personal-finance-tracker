import assert from "node:assert/strict";
import { createAccountingReadCache } from "../src/lib/accounting/read-cache";

async function main() {
  const requests: { signal: AbortSignal; resolve: (value: unknown) => void }[] =
    [];
  const cache = createAccountingReadCache(
    (_query, signal) =>
      new Promise((resolve) => requests.push({ signal, resolve })),
  );
  const query = { view: "register", filter: "all" };
  const first = cache.read(query);
  const duplicate = cache.read({ filter: "all", view: "register" });
  assert.equal(
    requests.length,
    1,
    "Identical concurrent reads share one request",
  );
  requests[0].resolve({ revision: 1 });
  assert.deepEqual(await first, await duplicate);
  assert.deepEqual(await cache.read(query), { revision: 1 });
  assert.equal(requests.length, 1, "Returning to a fresh page uses memory");

  const one = new AbortController(),
    two = new AbortController();
  const cancelled = cache.read(
    { view: "register", filter: "draft" },
    one.signal,
  );
  const retained = cache.read(
    { view: "register", filter: "draft" },
    two.signal,
  );
  one.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(
    requests[1].signal.aborted,
    false,
    "One subscriber must not cancel another",
  );
  requests[1].resolve({ revision: 2 });
  assert.deepEqual(await retained, { revision: 2 });

  const last = new AbortController();
  const superseded = cache.read(
    { view: "register", filter: "old-search" },
    last.signal,
  );
  last.abort();
  await assert.rejects(superseded, { name: "AbortError" });
  assert.equal(
    requests[2].signal.aborted,
    true,
    "Superseded searches cancel their network request",
  );
  requests[2].resolve("ignored");

  const stale = cache.read({ view: "register", filter: "stale" });
  cache.invalidate();
  assert.equal(cache.peek(query), undefined, "Writes invalidate cached pages");
  const fresh = cache.read({ view: "register", filter: "stale" });
  requests[4].resolve("fresh");
  assert.equal(await fresh, "fresh");
  requests[3].resolve("stale");
  await assert.rejects(stale, { name: "AbortError" });
  assert.equal(
    cache.peek({ view: "register", filter: "stale" }),
    "fresh",
    "Old responses cannot overwrite post-mutation data",
  );

  let calls = 0;
  const expired = createAccountingReadCache(async () => ++calls, 0);
  assert.equal(await expired.read(query), 1);
  assert.equal(await expired.read(query), 2, "Expired reads revalidate");
  const bounded = createAccountingReadCache(async (q) => q.filter, 30_000, 2);
  for (const filter of ["one", "two", "three"]) await bounded.read({ filter });
  assert.equal(bounded.peek({ filter: "one" }), undefined);
  assert.equal(bounded.peek({ filter: "three" }), "three");
  const isolated = createAccountingReadCache(async () => "different workspace");
  assert.equal(
    isolated.peek({ view: "register", filter: "stale" }),
    undefined,
    "No cache survives into another workspace",
  );
  let attempts = 0;
  const retry = createAccountingReadCache(async () => {
    if (++attempts === 1) throw new Error("offline");
    return "recovered";
  });
  await assert.rejects(retry.read(query), /offline/);
  assert.equal(await retry.read(query), "recovered", "Failures are not cached");
  const interrupted = new AbortController();
  const interruptedDuringSetup = createAccountingReadCache(async () => {
    interrupted.abort();
    return "too late";
  });
  await assert.rejects(
    interruptedDuringSetup.read(query, interrupted.signal),
    { name: "AbortError" },
    "Cancellation during loader setup must not deliver a stale result",
  );
  const synchronousFailure = createAccountingReadCache(() => {
    throw new Error("Loader failed before returning a promise");
  });
  await assert.rejects(synchronousFailure.read(query), /Loader failed/);
  console.log(
    "Accounting read cache: deduplication, reuse, cancellation, invalidation races, expiry, bounds, isolation, and retry passed.",
  );
}
void main();
