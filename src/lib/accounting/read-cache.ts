import { accountingReadJson } from "./read-json";

/** A bounded, in-memory cache owned by one mounted accounting workspace. */
export function createAccountingReadCache(
  load: (
    query: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<unknown> = (query, signal) =>
    accountingReadJson(`/api/accounting?${new URLSearchParams(query)}`, signal),
  ttl = 30_000,
  limit = 24,
) {
  const values = new Map<string, { value: unknown; time: number }>();
  type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
  type Flight = {
    controller: AbortController;
    promise: Promise<Outcome>;
    users: number;
    done: boolean;
  };
  const flights = new Map<string, Flight>();
  const keyOf = (query: Record<string, string>) =>
    JSON.stringify(
      Object.entries(query).sort(([a], [b]) => a.localeCompare(b)),
    );
  let generation = 0;
  const aborted = () => new DOMException("Request cancelled", "AbortError");
  return {
    peek<T>(query: Record<string, string>): T | undefined {
      return values.get(keyOf(query))?.value as T | undefined;
    },
    invalidate() {
      generation++;
      values.clear();
      for (const flight of flights.values()) flight.controller.abort(aborted());
      flights.clear();
    },
    read<T>(query: Record<string, string>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(aborted());
      const key = keyOf(query);
      const cached = values.get(key);
      if (cached && Date.now() - cached.time < ttl)
        return Promise.resolve(cached.value as T);
      let flight = flights.get(key);
      if (!flight) {
        const currentGeneration = generation;
        const controller = new AbortController();
        const next: Flight = {
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
            values.set(key, { value, time: Date.now() });
            while (values.size > limit)
              values.delete(values.keys().next().value!);
            return { ok: true, value };
          } catch (error) {
            return { ok: false, error };
          } finally {
            next.done = true;
            if (flights.get(key) === next) flights.delete(key);
          }
        })();
        flight = next;
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
