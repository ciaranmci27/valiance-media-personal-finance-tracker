import { accountingReadJson } from "./read-json";

export type AccountingQuery = Record<string, string>;

/**
 * One remembered answer. Entries are replaced, never mutated, so a render can
 * hold one as a stable snapshot.
 */
export type CacheEntry<T> = {
  query: AccountingQuery;
  value: T;
  time: number;
  /**
   * A write has happened since this was read. A screen already showing it
   * keeps it while the fresh answer loads; a screen mounting later treats it
   * as absent, so a pre-mutation value is never the first thing painted.
   */
  stale: boolean;
};

/** The identity of a query: its entries in one fixed order. */
export function accountingQueryKey(query: AccountingQuery): string {
  return JSON.stringify(
    Object.entries(query).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * A bounded, in-memory cache of accounting reads, shared by every screen of
 * the books. Answers are readable during render, a stale answer stays on
 * screen while a fresh one loads behind it, and anyone can warm a key ahead
 * of the click that needs it. Concurrent readers of one key share one
 * request and only their own cancellation rejects them.
 */
export function createAccountingReadCache(
  load: (query: AccountingQuery, signal: AbortSignal) => Promise<unknown> = (
    query,
    signal,
  ) =>
    accountingReadJson(`/api/accounting?${new URLSearchParams(query)}`, signal),
  ttl = 30_000,
  limit = 64,
  maxAge = 10 * 60_000,
) {
  const values = new Map<string, CacheEntry<unknown>>();
  type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
  type Flight = {
    query: AccountingQuery;
    controller: AbortController;
    promise: Promise<Outcome>;
    users: number;
    done: boolean;
  };
  const flights = new Map<string, Flight>();
  const listeners = new Map<string, Set<() => void>>();
  let generation = 0;
  const aborted = () => new DOMException("Request cancelled", "AbortError");
  const notify = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const notifyAll = () => {
    for (const set of listeners.values())
      for (const listener of set) listener();
  };
  /** The live entry for a key; an answer older than maxAge is forgotten. */
  const current = (key: string) => {
    const entry = values.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.time >= maxAge) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  const dropKey = (key: string) => {
    const entry = values.get(key);
    if (entry && !entry.stale) values.set(key, { ...entry, stale: true });
    const flight = flights.get(key);
    if (flight) {
      flights.delete(key);
      flight.controller.abort(aborted());
    }
    if (entry || flight) notify(key);
  };
  return {
    peek<T>(query: AccountingQuery): T | undefined {
      return current(accountingQueryKey(query))?.value as T | undefined;
    },
    entry<T>(query: AccountingQuery): CacheEntry<T> | undefined {
      return current(accountingQueryKey(query)) as CacheEntry<T> | undefined;
    },
    inflight(query: AccountingQuery): boolean {
      return flights.has(accountingQueryKey(query));
    },
    /**
     * Forget one answer softly: it stays readable where it is already shown,
     * marked stale, and any request for it is abandoned so a pre-write
     * response can never land after the write.
     */
    drop(query: AccountingQuery) {
      dropKey(accountingQueryKey(query));
    },
    dropWhere(predicate: (query: AccountingQuery) => boolean) {
      const keys = new Set<string>();
      for (const [key, entry] of values)
        if (predicate(entry.query)) keys.add(key);
      for (const [key, flight] of flights)
        if (predicate(flight.query)) keys.add(key);
      for (const key of keys) dropKey(key);
    },
    /** Forget everything at once, for a change of workspace or user. */
    invalidate() {
      generation++;
      values.clear();
      for (const flight of flights.values()) flight.controller.abort(aborted());
      flights.clear();
      notifyAll();
    },
    /**
     * Hear about one key: an answer arriving, a drop, a full invalidation, and
     * a request starting or settling.
     */
    subscribe(query: AccountingQuery, listener: () => void): () => void {
      const key = accountingQueryKey(query);
      const set = listeners.get(key) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
      };
    },
    read<T>(
      query: AccountingQuery,
      signal?: AbortSignal,
      options: { fresh?: boolean } = {},
    ): Promise<T> {
      if (signal?.aborted) return Promise.reject(aborted());
      const key = accountingQueryKey(query);
      const cached = current(key);
      if (
        cached &&
        !cached.stale &&
        !options.fresh &&
        Date.now() - cached.time < ttl
      )
        return Promise.resolve(cached.value as T);
      let flight = flights.get(key);
      if (!flight) {
        const currentGeneration = generation;
        const controller = new AbortController();
        const next: Flight = {
          query,
          controller,
          users: 0,
          done: false,
          promise: Promise.resolve({ ok: true, value: undefined }),
        };
        flights.set(key, next);
        // The cache owns the network promise, including its cancellation.
        // Only active subscribers receive rejections; the shared task always
        // settles to an outcome, even after every subscriber has navigated away.
        next.promise = (async (): Promise<Outcome> => {
          try {
            const value = await load(query, controller.signal);
            if (controller.signal.aborted || currentGeneration !== generation)
              return { ok: false, error: aborted() };
            values.delete(key);
            values.set(key, { query, value, time: Date.now(), stale: false });
            while (values.size > limit)
              values.delete(values.keys().next().value!);
            return { ok: true, value };
          } catch (error) {
            return { ok: false, error };
          } finally {
            next.done = true;
            if (flights.get(key) === next) flights.delete(key);
            notify(key);
          }
        })();
        flight = next;
        notify(key);
      }
      const shared = flight;
      shared.users++;
      return new Promise<T>((resolve, reject) => {
        let finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", cancel);
          shared.users--;
          if (!shared.users && !shared.done) {
            if (flights.get(key) === shared) flights.delete(key);
            shared.controller.abort(aborted());
          }
        };
        const cancel = () => {
          cleanup();
          reject(aborted());
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        void shared.promise.then((outcome) => {
          if (finished) return;
          cleanup();
          if (outcome.ok) resolve(outcome.value as T);
          else reject(outcome.error);
        });
      });
    },
  };
}
export type AccountingReadCache = ReturnType<typeof createAccountingReadCache>;
