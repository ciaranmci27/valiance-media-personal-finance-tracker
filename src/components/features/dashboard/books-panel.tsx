"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import {
  CashFlowChart,
  CashFlowLegend,
  type CashFlowPoint,
} from "@/components/charts/cash-flow-chart";
import { useAccountingRead } from "@/components/features/accounting/use-accounting-read";
import {
  booksToday,
  dateShortLabel,
  money,
} from "@/components/features/accounting/format";
import { dashboardQueries } from "@/lib/accounting/preload";
import { getAccountingDemo } from "@/lib/accounting/demo";
import { accountBalances } from "@/lib/accounting/account-balances";
import { presentTransaction } from "@/lib/accounting/transactions";
import type {
  AccountingWorkspace,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { FeedData } from "@/lib/accounting/feeds";
import type { ManageData } from "@/lib/accounting/workflows";
import type { ReportData } from "@/lib/accounting/reports";
import { cn } from "@/lib/utils";

const ZERO = BigInt(0);

export function cents(value: string | null | undefined) {
  return Number(value ?? "0") / 100;
}

export interface DashboardBooks {
  month: string;
  demo: boolean;
  workspace: AccountingWorkspace | null;
  report: ReportData | null;
  reportLoading: boolean;
  /** This month and last month from the twelve-month report, when present. */
  current: ReportData["monthly"][number] | null;
  previous: ReportData["monthly"][number] | null;
  /** Cash across bank accounts, bank-reported where a feed has it; null while loading. */
  cash: bigint | null;
  cashLabel: string;
  profiles: ManageData["profiles"];
  recent: JournalEntry[] | null;
  /** The books refused or failed: leave the dashboard alone. */
  unavailable: boolean;
  /**
   * A first read has neither answered nor failed, so a books figure would be
   * a guess. Cached answers make this false on the very first render.
   */
  pending: boolean;
}

/**
 * The books on the dashboard. Every read is keyed exactly as the accounting
 * shell warms it, so the same cache answers both screens. Reads are silent
 * on failure: a dashboard never blocks on the books. `enabled` false makes
 * every read a no-op.
 */
export function useDashboardBooks({
  demo,
  enabled,
}: {
  demo: boolean;
  enabled: boolean;
}): DashboardBooks {
  const today = booksToday();
  const month = today.slice(0, 7);
  const live = enabled && !demo;
  const [workspaceQuery, reportQueryKey, manageQuery, feedsQuery, recentQuery] =
    React.useMemo(() => dashboardQueries(today), [today]);
  const workspaceRead = useAccountingRead<AccountingWorkspace>(workspaceQuery, {
    enabled: live,
  });
  const reportRead = useAccountingRead<ReportData>(reportQueryKey, {
    enabled: live,
    revalidateOnFocus: true,
  });
  const manageRead = useAccountingRead<ManageData>(manageQuery, {
    enabled: live,
  });
  const feedsRead = useAccountingRead<FeedData>(feedsQuery, { enabled: live });
  const recentRead = useAccountingRead<{ entries: JournalEntry[] }>(
    recentQuery,
    { enabled: live },
  );
  // Once the workspace read fails the books are off the dashboard entirely,
  // so nothing else is worth waiting for.
  const pending =
    live &&
    !workspaceRead.error &&
    [workspaceRead, reportRead, manageRead, feedsRead, recentRead].some(
      (read) => read.data === undefined && !read.error,
    );
  const demoData = React.useMemo(
    () => (demo && enabled ? getAccountingDemo() : null),
    [demo, enabled],
  );
  const workspace = demoData ?? workspaceRead.data ?? null;
  const report = reportRead.data ?? null;
  const profiles = manageRead.data?.profiles ?? [];
  const monthIndex = (report?.monthly ?? []).findIndex(
    (m) => m.month.slice(0, 7) === month,
  );
  const current = monthIndex >= 0 ? report!.monthly[monthIndex] : null;
  const previous = monthIndex > 0 ? report!.monthly[monthIndex - 1] : null;

  // Cash the way the Transactions screen sums it: every bank account that is
  // not a card, bank-reported where a feed has a balance, book otherwise.
  const { cash, cashLabel } = React.useMemo(() => {
    if (!workspace) return { cash: null, cashLabel: "Loading balances" };
    if (demoData) {
      const total = workspace.balances
        .filter((b) => b.account_type === "asset")
        .reduce((sum, b) => sum + BigInt(b.ending_cents), ZERO);
      return { cash: total, cashLabel: "Sample book balances" };
    }
    if (!manageRead.data || (feedsRead.loading && !feedsRead.data))
      return { cash: null, cashLabel: "Loading balances" };
    const balances = accountBalances(
      workspace.balances,
      profiles,
      feedsRead.data ?? null,
    );
    const cashProfiles = profiles.filter(
      (p) => p.cash_kind !== "none" && p.cash_kind !== "card",
    );
    const rows = workspace.balances.filter((b) =>
      cashProfiles.some((p) => p.account_id === b.id),
    );
    const total = rows.reduce(
      (sum, b) => sum + (balances.get(b.id)?.amount ?? ZERO),
      ZERO,
    );
    const fromBank = rows.filter(
      (b) => balances.get(b.id)?.bank !== null,
    ).length;
    return {
      cash: total,
      cashLabel:
        rows.length > 0 && fromBank === rows.length
          ? "Latest bank balances"
          : fromBank > 0
            ? "Bank balances + unconnected book balances"
            : "Book balances",
    };
  }, [
    workspace,
    demoData,
    manageRead.data,
    feedsRead.loading,
    feedsRead.data,
    profiles,
  ]);

  const recent: JournalEntry[] | null = demoData
    ? demoData.entries.filter((e) => e.status === "posted").slice(0, 6)
    : (recentRead.data?.entries.slice(0, 6) ?? (recentRead.error ? [] : null));

  return {
    month,
    demo,
    workspace,
    report,
    reportLoading: reportRead.loading,
    current,
    previous,
    cash,
    cashLabel,
    profiles,
    recent,
    unavailable: live && Boolean(workspaceRead.error),
    pending,
  };
}

/** A card whose header carries a title plus a right slot, matching the dashboard's chart cards. */
export function Panel({
  title,
  right,
  className,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
  children: (isRevealed: boolean) => React.ReactNode;
}) {
  const { isRevealed, hoverProps } = useMaskedHover();
  return (
    <Card className={cn("flex min-w-0 flex-col", className)} {...hoverProps}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {right}
        </div>
      </CardHeader>
      <CardContent className="flex-1">{children(isRevealed)}</CardContent>
    </Card>
  );
}

/** The 6mo / 12mo switch, in the dashboard's toggle style. */
export function RangeToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-[rgba(var(--ink),0.05)] p-0.5 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "px-2 py-1 text-xs font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            value === option.value
              ? "bg-[rgba(var(--ink),0.09)] text-foreground shadow-[inset_0_1px_0_rgba(var(--ink),0.16)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Income against expenses from the books, six or twelve months. */
export function CashFlowCard({
  books,
  className,
}: {
  books: DashboardBooks;
  className?: string;
}) {
  const [range, setRange] = React.useState<"6mo" | "12mo">("6mo");
  const monthly: CashFlowPoint[] = React.useMemo(
    () =>
      (books.report?.monthly ?? [])
        .map((m) => ({
          month: m.month.length === 7 ? `${m.month}-01` : m.month.slice(0, 10),
          income: cents(m.income_cents),
          expenses: Math.abs(cents(m.expense_cents)),
          net: cents(m.net_cents),
        }))
        .slice(range === "6mo" ? -6 : -12),
    [books.report, range],
  );
  return (
    <Panel
      title="Cash flow"
      className={className}
      right={
        <div className="flex items-center gap-3">
          <span className="hidden sm:block">
            <CashFlowLegend />
          </span>
          <RangeToggle
            value={range}
            onChange={setRange}
            options={[
              { value: "6mo", label: "6mo" },
              { value: "12mo", label: "12mo" },
            ]}
          />
        </div>
      }
    >
      {(isRevealed) =>
        books.demo ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Sample books carry no monthly history. Real books chart income
            against expenses here.
          </p>
        ) : books.reportLoading || !books.report ? (
          <div role="status" aria-label="Loading cash flow">
            <Skeleton className="h-[220px] w-full rounded-lg" />
          </div>
        ) : (
          <>
            <CashFlowChart data={monthly} isRevealed={isRevealed} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 sm:hidden">
              <CashFlowLegend />
            </div>
          </>
        )
      }
    </Panel>
  );
}

/** The latest posted transactions, each a door into the ledger. */
export function BooksRecent({
  books,
  className,
}: {
  books: DashboardBooks;
  className?: string;
}) {
  const accounts = React.useMemo(
    () => new Map((books.workspace?.accounts ?? []).map((a) => [a.id, a])),
    [books.workspace],
  );
  const { profiles, recent } = books;

  function categoryLabel(
    entry: JournalEntry,
    p: ReturnType<typeof presentTransaction>,
  ) {
    // Without account profiles (the demo) the lines cannot be sorted into
    // bank and category, so name the accounts the entry touches instead.
    if (profiles.length === 0)
      return (
        entry.lines
          .map((line) => accounts.get(line.account_id)?.name)
          .filter(Boolean)
          .slice(0, 2)
          .join(" · ") || "Journal entry"
      );
    if (p.transfer) return "Transfer";
    if (p.categoryLines.length > 1) return "Split";
    const id = p.categoryLines[0]?.account_id;
    const name = id ? accounts.get(id)?.name : undefined;
    if (!name)
      return entry.lines.length > 2 ? "Journal entry" : "Uncategorized";
    return name;
  }

  function amountOf(
    entry: JournalEntry,
    p: ReturnType<typeof presentTransaction>,
  ) {
    if (profiles.length > 0) return p.amount;
    return entry.lines.reduce((sum, line) => {
      const value = BigInt(line.amount_cents);
      return value > ZERO ? sum + value : sum;
    }, ZERO);
  }

  return (
    <Panel
      title="Recent transactions"
      className={className}
      right={
        <Link
          href="/accounting?view=journal"
          className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          All transactions
          <ArrowRight size={12} aria-hidden="true" />
        </Link>
      }
    >
      {() =>
        recent === null ? (
          <div
            role="status"
            aria-label="Loading transactions"
            className="space-y-2"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing posted yet.
          </p>
        ) : (
          <ul className="-mx-2 divide-y divide-border/60">
            {recent.map((entry) => {
              const p = presentTransaction(entry, profiles);
              const amount = amountOf(entry, p);
              return (
                <li key={entry.id}>
                  <Link
                    href={`/accounting?entry=${entry.id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {entry.memo}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {dateShortLabel(entry.entry_date)}
                        <span aria-hidden="true"> · </span>
                        {categoryLabel(entry, p)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-sm font-medium tabular-nums",
                        profiles.length > 0 && amount > ZERO
                          ? "text-success"
                          : "text-foreground",
                      )}
                    >
                      <MaskedValue value={money(amount)} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      }
    </Panel>
  );
}
