"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  createAccountingReadCache,
  type AccountingReadCache,
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
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  // During render, so no child can read another workspace's answer first.
  claimAccountingCache(next);
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
