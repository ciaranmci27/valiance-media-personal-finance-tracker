"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import {
  createAccountingReadCache,
  type AccountingReadCache,
  type PreloadedReads,
} from "@/lib/accounting/read-cache";

/**
 * One cache for the whole books, alive for the session. Every visit to the
 * accounting page remounts its shell, so a cache owned by the shell would be
 * cold each time. This one keeps the last answers, so coming back is instant
 * and the sidebar can warm a screen before it opens.
 */
export const sharedAccountingCache: AccountingReadCache =
  createAccountingReadCache();

let scope: string | null = null;

/** Forget everything, for sign-out. */
export function resetAccountingCache() {
  scope = null;
  sharedAccountingCache.invalidate();
}

/**
 * Name the books being shown. Different books (a different owner, the demo,
 * the test database) empty the cache first so nothing crosses over. Safe to
 * call on every render: it acts only on a change.
 */
export function claimAccountingCache(next: string) {
  if (scope === next) return;
  if (scope !== null) sharedAccountingCache.invalidate();
  scope = next;
}

const CacheContext = createContext<AccountingReadCache>(sharedAccountingCache);

export function AccountingCacheProvider({
  scope: next,
  preloaded,
  children,
}: {
  scope: string;
  /** Answers the server read with the page (see `seed`). */
  preloaded?: PreloadedReads;
  children: ReactNode;
}) {
  // During render, so no child can read another workspace's answer first.
  claimAccountingCache(next);
  // Seeded after render, never during it: hydration has to render what the
  // server rendered (an empty cache), and the server's module cache is shared
  // by every request, so it must never hold anyone's answers. Layout effects
  // all run before any passive effect, so the screens' first reads find these.
  useLayoutEffect(() => {
    if (!preloaded) return;
    for (const { query, value } of preloaded.reads)
      sharedAccountingCache.seed(query, value, preloaded.at);
  }, [preloaded]);
  return (
    <CacheContext.Provider value={sharedAccountingCache}>
      {children}
    </CacheContext.Provider>
  );
}

/** The books' cache; outside the shell (previews, tests) the shared one. */
export function useAccountingCache(): AccountingReadCache {
  return useContext(CacheContext);
}
