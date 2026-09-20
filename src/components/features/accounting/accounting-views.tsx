"use client";

import { useSyncExternalStore, type ComponentType } from "react";
import {
  bootQueries,
  dashboardQueries,
  preloadContextFromLocation,
  viewQueries,
  type PreloadContext,
} from "@/lib/accounting/preload";
import type { AccountingReadCache } from "@/lib/accounting/read-cache";
import type { AccountingView } from "@/lib/accounting/views";
import type { RegisterFilter } from "@/lib/accounting/workflows";
import { sharedAccountingCache } from "./accounting-cache";
import { AccountingTransactions } from "./accounting-transactions";
import { todayInBooks } from "./format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ViewComponent = ComponentType<any>;

/**
 * The screens of the books, one chunk each, loaded on demand and then kept
 * so a screen mounts synchronously. A lazy component would show its fallback
 * for a commit even when its chunk is already here; this registry is what
 * lets a warmed screen paint whole on its first frame. The ledger ships with
 * the shell, so it is always here.
 */
const CHUNKS: Record<AccountingView, () => Promise<ViewComponent>> = {
  overview: () =>
    import("./accounting-overview").then((m) => m.AccountingOverview),
  journal: () => Promise.resolve(AccountingTransactions),
  accounts: () =>
    import("./accounting-accounts").then((m) => m.AccountingAccounts),
  payroll: () =>
    import("./accounting-payroll-run").then((m) => m.AccountingPayrollRuns),
  reports: () =>
    import("./accounting-reports").then((m) => m.AccountingReports),
  manage: () => import("./accounting-more").then((m) => m.AccountingMore),
  close: () => import("./accounting-close").then((m) => m.AccountingClose),
};

const loaded = new Map<AccountingView, ViewComponent>([
  ["journal", AccountingTransactions],
]);
const pending = new Map<AccountingView, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

export function peekView(view: AccountingView): ViewComponent | undefined {
  return loaded.get(view);
}

/** Bring a screen's chunk in; concurrent callers share one load. */
export function loadView(view: AccountingView): Promise<void> {
  if (loaded.has(view)) return Promise.resolve();
  let load = pending.get(view);
  if (!load) {
    load = CHUNKS[view]()
      .then((component) => {
        loaded.set(view, component);
        version++;
        for (const listener of listeners) listener();
      })
      .finally(() => pending.delete(view));
    pending.set(view, load);
  }
  return load;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The screen's component once its chunk is here; undefined until then. */
export function useViewComponent(
  view: AccountingView,
): ViewComponent | undefined {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return loaded.get(view);
}

/** The one line the loader reads while a screen is on its way. */
export const VIEW_STEPS: Record<AccountingView, string> = {
  overview: "Preparing overview",
  journal: "Loading transactions",
  accounts: "Loading accounts",
  payroll: "Loading payroll",
  reports: "Preparing reports",
  manage: "Loading settings",
  close: "Checking the month",
};

/** Warm a screen's chunk and first reads so a later click mounts it whole. */
export function warmAccountingView(
  view: AccountingView,
  ctx: PreloadContext,
  cache: AccountingReadCache,
  initialFilter?: Partial<RegisterFilter>,
): Promise<void> {
  return Promise.allSettled([
    loadView(view),
    ...viewQueries(view, ctx, initialFilter).map((query) => cache.read(query)),
  ]).then(() => undefined);
}

/** Warm the dashboard's books reads from the sidebar. Failures are the dashboard's to report. */
export function warmDashboard(): Promise<void> {
  return Promise.allSettled(
    dashboardQueries(todayInBooks()).map((query) =>
      sharedAccountingCache.read(query),
    ),
  ).then(() => undefined);
}

/**
 * Warm a screen from the sidebar, before the page is even open: the shell's
 * own first reads and the screen's, keyed exactly as the page will key them.
 */
export function warmAccountingViewFromLocation(
  view: AccountingView,
  search: string,
  reviewCount: number,
): Promise<void> {
  const ctx = preloadContextFromLocation(
    new URLSearchParams(search),
    todayInBooks(),
    reviewCount,
  );
  return Promise.allSettled([
    ...bootQueries(ctx).map((query) => sharedAccountingCache.read(query)),
    warmAccountingView(view, ctx, sharedAccountingCache),
  ]).then(() => undefined);
}
