import assert from "node:assert/strict";
import {
  accountingQueryKey,
  createAccountingReadCache,
} from "../src/lib/accounting/read-cache";

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

  // Subscriptions: a request starting, an answer arriving, a drop.
  const events: string[] = [];
  const watched = createAccountingReadCache(
    (_query, signal) =>
      new Promise((resolve) => requests.push({ signal, resolve })),
  );
  const stop = watched.subscribe(query, () => events.push("notified"));
  const watchedRead = watched.read(query);
  assert.equal(watched.inflight(query), true, "A started request is in flight");
  assert.equal(events.length, 1, "Subscribers hear a request start");
  requests.at(-1)!.resolve({ revision: 10 });
  await watchedRead;
  assert.equal(watched.inflight(query), false, "A settled request is done");
  assert.equal(events.length, 2, "Subscribers hear the answer arrive");
  const before = watched.entry<{ revision: number }>(query);
  assert.deepEqual(before?.value, { revision: 10 });
  assert.equal(before?.stale, false);
  assert.deepEqual(before?.query, query, "Entries remember their query");

  // A soft drop keeps the value readable, marks it stale and abandons any
  // request for it, so a pre-write response never lands after the write.
  const draft = { view: "register", filter: "draft" };
  const droppedFlight = watched.read(draft);
  watched.drop(query);
  watched.drop(draft);
  assert.deepEqual(
    watched.peek(query),
    { revision: 10 },
    "A dropped answer stays readable",
  );
  const after = watched.entry<{ revision: number }>(query);
  assert.equal(after?.stale, true, "A dropped answer is marked stale");
  assert.notEqual(after, before, "A drop replaces the entry object");
  assert.equal(events.length, 3, "Subscribers hear a drop");
  assert.equal(watched.inflight(draft), false, "A dropped request is gone");
  requests.at(-1)!.resolve("late");
  await assert.rejects(droppedFlight, { name: "AbortError" });
  assert.equal(watched.peek(draft), undefined, "A late answer is discarded");
  const renewed = watched.read(query);
  assert.equal(watched.inflight(query), true, "A stale answer is read again");
  requests.at(-1)!.resolve({ revision: 11 });
  assert.deepEqual(await renewed, { revision: 11 });
  assert.equal(
    watched.entry(query)?.stale,
    false,
    "A fresh answer clears the stale mark",
  );

  // Fresh reads bypass the age check and still share one request.
  const freshOne = watched.read(query, undefined, { fresh: true });
  const freshTwo = watched.read(query, undefined, { fresh: true });
  assert.equal(watched.inflight(query), true, "A fresh read always asks");
  requests.at(-1)!.resolve({ revision: 12 });
  assert.deepEqual(await freshOne, await freshTwo);

  // dropWhere touches only the queries its predicate names.
  const manageRead = watched.read({ view: "manage" });
  requests.at(-1)!.resolve("metadata");
  await manageRead;
  watched.dropWhere((q) => q.view === "register");
  assert.equal(watched.entry(query)?.stale, true);
  assert.equal(
    watched.entry({ view: "manage" })?.stale,
    false,
    "dropWhere leaves other queries alone",
  );

  // A removed listener hears nothing; invalidation reaches every listener.
  const heard = events.length;
  stop();
  watched.invalidate();
  assert.equal(events.length, heard, "A removed listener hears nothing");
  const still: string[] = [];
  const stopAgain = watched.subscribe(query, () => still.push("x"));
  watched.invalidate();
  assert.equal(still.length, 1, "Invalidation reaches every listener");
  stopAgain();

  // Keys ignore property order; answers past maxAge are forgotten.
  assert.equal(
    accountingQueryKey({ b: "2", a: "1" }),
    accountingQueryKey({ a: "1", b: "2" }),
  );
  const aged = createAccountingReadCache(async () => "old", 30_000, 24, 0);
  await aged.read(query);
  assert.equal(aged.entry(query), undefined, "An old answer is forgotten");
  assert.equal(aged.peek(query), undefined);
  console.log(
    "Accounting read cache: deduplication, reuse, cancellation, invalidation races, expiry, bounds, isolation, retry, subscriptions, soft drops, fresh reads and max age passed.",
  );
}
void main();
