"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  accountingQueryKey,
  type AccountingQuery,
} from "@/lib/accounting/read-cache";
import { useAccountingCache } from "./accounting-cache";

export type AccountingRead<T> = {
  data: T | undefined;
  /** Nothing to show yet: paint a skeleton, never a guess. */
  loading: boolean;
  /** An answer is on screen while a newer one loads behind it. */
  revalidating: boolean;
  /** The answer belongs to the previous query, kept so a filter change does not blank the screen. */
  isPlaceholder: boolean;
  error: string;
  /** Forget the cached answer and read it again. */
  reload: () => Promise<void>;
};

const noop = () => {};

/**
 * A cached accounting read, readable on the first render. A cached answer
 * paints at once and refreshes behind itself when it has aged; a write
 * elsewhere marks it stale and this hook reads again while keeping it on
 * screen. An answer that was already stale when this screen mounted is not
 * shown at all, so a pre-write value is never the first thing painted.
 */
export function useAccountingRead<T>(
  query: AccountingQuery | null,
  options: {
    enabled?: boolean;
    keepPrevious?: boolean;
    revalidateOnFocus?: boolean;
  } = {},
): AccountingRead<T> {
  const {
    enabled = true,
    keepPrevious = false,
    revalidateOnFocus = false,
  } = options;
  const cache = useAccountingCache();
  const key = query && enabled ? accountingQueryKey(query) : null;
  // The key is the identity: a caller that rebuilds the object each render
  // must not restart the read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableQuery = useMemo(() => (key ? query : null), [key]);

  const subscribe = useCallback(
    (listener: () => void) =>
      stableQuery ? cache.subscribe(stableQuery, listener) : noop,
    [cache, stableQuery],
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (stableQuery ? cache.entry<T>(stableQuery) : undefined),
    () => undefined,
  );
  const inflight = useSyncExternalStore(
    subscribe,
    () => (stableQuery ? cache.inflight(stableQuery) : false),
    () => false,
  );

  // Stale at mount is absent. The key it applies to is remembered so a
  // fresh answer for the same key lifts it and a new key starts over.
  const [hidden, setHidden] = useState<string | null>(() =>
    entry?.stale ? key : null,
  );
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setHidden(entry?.stale ? key : null);
  }
  if (hidden !== null && hidden === key && entry && !entry.stale)
    setHidden(null);
  const value = entry && hidden !== key ? entry.value : undefined;

  const previous = useRef<{ key: string | null; value: T } | null>(null);
  useEffect(() => {
    if (value !== undefined) previous.current = { key, value };
  });

  const [error, setError] = useState("");
  useEffect(() => {
    if (!stableQuery) return;
    const controller = new AbortController();
    let failed = false;
    const go = (fresh = false) => {
      cache.read<T>(stableQuery, controller.signal, { fresh }).then(
        () => {
          if (!controller.signal.aborted) setError("");
        },
        (e: unknown) => {
          if (controller.signal.aborted) return;
          // The cache abandoned the request after a write; its notice
          // starts the next read.
          if (e instanceof DOMException && e.name === "AbortError") return;
          failed = true;
          setError(
            e instanceof Error ? e.message : "Unable to load accounting data.",
          );
        },
      );
    };
    setError("");
    go();
    const unsubscribe = cache.subscribe(stableQuery, () => {
      if (failed || cache.inflight(stableQuery)) return;
      const current = cache.entry(stableQuery);
      if (!current || current.stale) go();
    });
    const onFocus = () => {
      if (document.visibilityState === "visible") go(true);
    };
    if (revalidateOnFocus) window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      if (revalidateOnFocus) window.removeEventListener("focus", onFocus);
      controller.abort();
    };
  }, [cache, stableQuery, revalidateOnFocus]);

  const reload = useCallback(async () => {
    if (!stableQuery) return;
    cache.drop(stableQuery);
    try {
      await cache.read<T>(stableQuery, undefined, { fresh: true });
    } catch {
      /* The mounted read reports the failure. */
    }
  }, [cache, stableQuery]);

  const placeholder =
    value === undefined &&
    keepPrevious &&
    previous.current &&
    previous.current.key !== key
      ? previous.current
      : null;
  const data = value !== undefined ? value : placeholder?.value;
  return {
    data,
    loading: stableQuery !== null && data === undefined && !error,
    revalidating: value !== undefined && (!!entry?.stale || inflight),
    isPlaceholder: placeholder !== null,
    error,
    reload,
  };
}
