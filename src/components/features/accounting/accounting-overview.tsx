"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Landmark,
  LockKeyhole,
  Plus,
  TrendingUp,
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import {
  CashFlowChart,
  CashFlowLegend,
  type CashFlowPoint,
} from "@/components/charts/cash-flow-chart";
import { cn } from "@/lib/utils";
import type {
  AccountingWorkspace,
  BalanceRow,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { FeedData } from "@/lib/accounting/feeds";
import type { ReportData } from "@/lib/accounting/reports";
import type { CloseChecklist } from "@/lib/accounting/close";
import { presentTransaction } from "@/lib/accounting/transactions";
import type { BooksMetadata } from "./types";
import { accountingGet } from "./use-accounting-command";
import {
  countLabel,
  dateShortLabel,
  money,
  monthLabel,
  timestampLabel,
} from "./format";

type Range = "6mo" | "12mo";

const ZERO = BigInt(0);

function cents(value: string | null | undefined) {
  return Number(value ?? "0") / 100;
}

/** First day of the month `months` before the month that holds `date`. */
function monthsBefore(date: string, months: number) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 - months;
  const d = new Date(Date.UTC(year, month, 1));
  return d.toISOString().slice(0, 10);
}

function RangeToggle({
  value,
  onChange,
}: {
  value: Range;
  onChange: (next: Range) => void;
}) {
  const options: { value: Range; label: string }[] = [
    { value: "6mo", label: "6mo" },
    { value: "12mo", label: "12mo" },
  ];
  return (
    <div
      role="group"
      aria-label="Chart range"
      className="flex items-center gap-0.5 rounded-lg bg-[rgba(var(--ink),0.05)] p-0.5 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

/** A card whose header carries a title plus an optional right slot, matching the dashboard. */
function PanelCard({
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
    <Card className={cn("flex flex-col", className)} {...hoverProps}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {right}
        </div>
      </CardHeader>
      <CardContent className="flex-1">{children(isRevealed)}</CardContent>
    </Card>
  );
}

function RowSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * The accounting home: where the money stands, what still needs a look, the
 * accounts behind it and the month in progress. Everything here links into
 * the deeper screens; nothing is edited in place except the review queue.
 */
export function AccountingOverview({
  data,
  manage,
  feeds: feedsProp,
  metadataLoading,
  demo,
  onReview,
  onTransactions,
  onAccounts,
  onFeeds,
  onMonthEnd,
  onReport,
  onEntry,
  onAdd,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
  /** Feed state when the shell already holds it; the page fetches its own otherwise. */
  feeds?: FeedData | null;
  metadataLoading: boolean;
  demo: boolean;
  onReview: () => void;
  onTransactions: () => void;
  onAccounts: () => void;
  onFeeds: () => void;
  onMonthEnd: () => void;
  onReport: (id: "profit-loss" | "balance-sheet") => void;
  onEntry: (entry: JournalEntry) => void;
  onAdd: (direction: "in" | "out") => void;
}) {
  const [range, setRange] = useState<Range>("12mo");
  const [report, setReport] = useState<ReportData | null>(null);
  const [feeds, setFeeds] = useState<FeedData | null>(feedsProp ?? null);
  const fetchFeeds = feedsProp === undefined;
  useEffect(() => {
    if (feedsProp !== undefined) setFeeds(feedsProp);
  }, [feedsProp]);
  const [drafts, setDrafts] = useState<JournalEntry[] | null>(null);
  const [recent, setRecent] = useState<JournalEntry[] | null>(null);
  const [close, setClose] = useState<CloseChecklist | null>(null);
  const [loaded, setLoaded] = useState(demo);

  const profiles = manage.profiles;
  const accounts = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a])),
    [data.accounts],
  );
  const profileMap = useMemo(
    () => new Map(profiles.map((p) => [p.account_id, p])),
    [profiles],
  );
  const bankAccounts = useMemo(
    () =>
      data.balances.filter(
        (a) => (profileMap.get(a.id)?.cash_kind ?? "none") !== "none",
      ),
    [data.balances, profileMap],
  );
  const isCard = (a: BalanceRow) => profileMap.get(a.id)?.cash_kind === "card";
  const bookBalance = (a: BalanceRow) =>
    isCard(a) ? -BigInt(a.ending_cents) : BigInt(a.ending_cents);
  const cash = bankAccounts
    .filter((a) => !isCard(a))
    .reduce((s, a) => s + BigInt(a.ending_cents), ZERO);
  const cardDebt = bankAccounts
    .filter(isCard)
    .reduce((s, a) => s - BigInt(a.ending_cents), ZERO);

  useEffect(() => {
    if (demo) {
      setDrafts(data.entries.filter((e) => e.status === "draft").slice(0, 5));
      setRecent(data.entries.filter((e) => e.status === "posted").slice(0, 8));
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const swallow = () => undefined;
    const from = monthsBefore(data.to, 11);
    void Promise.allSettled([
      accountingGet<ReportData>(
        {
          view: "report",
          report: "profit-loss",
          filter: JSON.stringify({
            from,
            to: data.to,
            mode: "posted",
            offset: 0,
          }),
        },
        signal,
      )
        .then(setReport)
        .catch(swallow),
      ...(fetchFeeds
        ? [
            accountingGet<FeedData>({ view: "feeds" }, signal)
              .then(setFeeds)
              .catch(swallow),
          ]
        : []),
      accountingGet<{ entries: JournalEntry[] }>(
        {
          view: "register",
          filter: JSON.stringify({
            status: "draft",
            sort: "date_desc",
            offset: 0,
            limit: 5,
          }),
        },
        signal,
      )
        .then((r) => setDrafts(r.entries))
        .catch(() => setDrafts([])),
      accountingGet<{ entries: JournalEntry[] }>(
        {
          view: "register",
          filter: JSON.stringify({
            status: "posted",
            sort: "date_desc",
            offset: 0,
            limit: 8,
          }),
        },
        signal,
      )
        .then((r) => setRecent(r.entries))
        .catch(() => setRecent([])),
      accountingGet<CloseChecklist>(
        { view: "close", date: `${data.to.slice(0, 7)}-01` },
        signal,
      )
        .then(setClose)
        .catch(swallow),
    ]).then(() => {
      if (!signal.aborted) setLoaded(true);
    });
    return () => controller.abort();
  }, [demo, data.revision, data.to, data.entries, fetchFeeds]);

  const monthly = useMemo<CashFlowPoint[]>(() => {
    const points = (report?.monthly ?? []).map((m) => ({
      month: m.month.length === 7 ? `${m.month}-01` : m.month.slice(0, 10),
      income: cents(m.income_cents),
      expenses: Math.abs(cents(m.expense_cents)),
      net: cents(m.net_cents),
    }));
    return points.slice(range === "6mo" ? -6 : -12);
  }, [report, range]);
  const thisMonth = data.to.slice(0, 7);
  const monthIndex = (report?.monthly ?? []).findIndex(
    (m) => m.month.slice(0, 7) === thisMonth,
  );
  const current = monthIndex >= 0 ? report!.monthly[monthIndex] : null;
  const previous = monthIndex > 0 ? report!.monthly[monthIndex - 1] : null;

  const connections = feeds?.connections ?? [];
  const institutionByAccount = new Map<string, string>();
  for (const identity of feeds?.identities ?? []) {
    const feedAccount = feeds?.accounts.find(
      (f) => f.id === identity.feed_account_id,
    );
    if (feedAccount && identity.institution)
      institutionByAccount.set(feedAccount.account_id, identity.institution);
  }
  const lastSync = connections
    .map((c) => c.last_success_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const feedAttention = connections.some(
    (c) =>
      c.status === "reconnect_required" ||
      (c.status === "active" && !c.last_success_at && c.last_error),
  );
  const activeConnection = connections.some((c) => c.status === "active");
  const unmappedIdentities = (feeds?.identities ?? []).filter(
    (i) => i.ownership === "unreviewed" && !i.feed_account_id,
  ).length;
  // Nothing syncs until at least one discovered account is mapped.
  const needsMapping =
    activeConnection &&
    unmappedIdentities > 0 &&
    (feeds?.accounts.length ?? 0) === 0;

  const accountCards = bankAccounts.map((a) => {
    const feedAccount = feeds?.accounts.find((f) => f.account_id === a.id);
    const identities = feedAccount
      ? (feeds?.identities ?? []).filter(
          (i) => i.feed_account_id === feedAccount.id,
        )
      : [];
    const identity =
      identities.find(
        (i) =>
          connections.find((c) => c.id === i.connection_id)?.status ===
          "active",
      ) ??
      identities[0] ??
      null;
    const connection = identity
      ? (connections.find((c) => c.id === identity.connection_id) ?? null)
      : null;
    const bank =
      identity?.balance?.balance_cents != null && feedAccount
        ? BigInt(identity.balance.balance_cents) *
          BigInt(feedAccount.balance_sign)
        : null;
    return { account: a, identity, connection, bank, book: bookBalance(a) };
  });

  const reviewCount = data.needs_review_count ?? data.draft_count;
  const closeDrafts = close?.drafts ?? reviewCount;
  const offBanks = (close?.banks ?? []).filter(
    (b) => b.difference_cents !== null && BigInt(b.difference_cents) !== ZERO,
  ).length;
  const observedBanks = (close?.banks ?? []).filter(
    (b) => b.observed_balance_cents !== null,
  ).length;
  const locked = close?.period?.status === "locked";

  function categoryLabel(
    entry: JournalEntry,
    p: ReturnType<typeof presentTransaction>,
  ) {
    if (p.transfer) return "Transfer";
    if (p.categoryLines.length > 1) return "Split";
    const id = p.categoryLines[0]?.account_id;
    const name = id ? accounts.get(id)?.name : undefined;
    if (!name)
      return entry.lines.length > 2 ? "Journal entry" : "Uncategorized";
    return profileMap.get(id!)?.purpose?.startsWith("uncategorized")
      ? "Uncategorized"
      : name;
  }

  function entryRow(entry: JournalEntry, emphasizeReview = false) {
    const p = presentTransaction(entry, profiles);
    const bank = p.bankLine ? accounts.get(p.bankLine.account_id) : undefined;
    const category = categoryLabel(entry, p);
    const uncategorized = category === "Uncategorized";
    return (
      <button
        key={entry.id}
        type="button"
        onClick={() => onEntry(entry)}
        className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <InstitutionLogo
          institution={bank ? institutionByAccount.get(bank.id) : undefined}
          name={bank?.name ?? entry.source_description ?? entry.memo}
          size={32}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {entry.memo}
          </span>
          <span
            className={cn(
              "block truncate text-xs",
              emphasizeReview && uncategorized
                ? "text-warning"
                : "text-muted-foreground",
            )}
          >
            {dateShortLabel(entry.entry_date)}
            <span aria-hidden="true"> · </span>
            {category}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            p.amount > ZERO ? "text-success" : "text-foreground",
          )}
        >
          <MaskedValue value={money(p.amount)} />
        </span>
      </button>
    );
  }

  if (data.accounts.length === 0)
    return (
      <div className="glass-card mx-auto max-w-xl rounded-xl px-6 py-14 text-center">
        <Landmark
          size={28}
          aria-hidden="true"
          className="mx-auto mb-4 text-teal"
        />
        <h2 className="text-lg font-semibold">Your books are empty</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Connect a bank to pull activity in automatically, or add your first
          transaction by hand.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button disabled={demo} onClick={onFeeds}>
            Connect a bank
          </Button>
          <Button
            variant="outline"
            disabled={demo}
            onClick={() => onAdd("out")}
          >
            <Plus size={15} aria-hidden="true" />
            Add transaction
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-5 lg:space-y-6">
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4 lg:gap-4">
        <StatCard
          title="Cash in bank"
          value={metadataLoading ? 0 : Number(cash) / 100}
          icon={<Landmark className="h-5 w-5" />}
          className="stagger-1"
          subtitle={
            metadataLoading
              ? "Loading balances"
              : cardDebt > ZERO
                ? `Card balance ${money(cardDebt)} · through ${dateShortLabel(data.to)}`
                : `${countLabel(bankAccounts.filter((a) => !isCard(a)).length, "account")} · through ${dateShortLabel(data.to)}`
          }
        />
        <StatCard
          title="Income this month"
          value={cents(current?.income_cents)}
          previousValue={previous ? cents(previous.income_cents) : undefined}
          icon={<ArrowDownLeft className="h-5 w-5" />}
          className="stagger-2"
          subtitle={monthLabel(`${thisMonth}-01`)}
        />
        <StatCard
          title="Expenses this month"
          value={Math.abs(cents(current?.expense_cents))}
          previousValue={
            previous ? Math.abs(cents(previous.expense_cents)) : undefined
          }
          invertTrend
          icon={<ArrowUpRight className="h-5 w-5" />}
          className="stagger-3"
          subtitle={monthLabel(`${thisMonth}-01`)}
        />
        <StatCard
          title="Net profit this month"
          value={cents(current?.net_cents)}
          previousValue={previous ? cents(previous.net_cents) : undefined}
          icon={<TrendingUp className="h-5 w-5" />}
          className="stagger-4"
          subtitle={monthLabel(`${thisMonth}-01`)}
        />
      </div>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <PanelCard
          title="Cash flow"
          className="stagger-5 lg:col-span-2"
          right={
            <div className="flex items-center gap-3">
              <span className="hidden sm:block">
                <CashFlowLegend />
              </span>
              <RangeToggle value={range} onChange={setRange} />
            </div>
          }
        >
          {(isRevealed) =>
            !loaded && !report ? (
              <div role="status" aria-label="Loading cash flow">
                <Skeleton className="h-[220px] w-full rounded-lg" />
              </div>
            ) : (
              <>
                <CashFlowChart data={monthly} isRevealed={isRevealed} />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 sm:hidden">
                  <CashFlowLegend />
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs">
                  <button
                    type="button"
                    onClick={() => onReport("profit-loss")}
                    className="inline-flex items-center gap-1 text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Profit & loss
                    <ArrowRight size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onReport("balance-sheet")}
                    className="inline-flex items-center gap-1 text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Balance sheet
                    <ArrowRight size={12} aria-hidden="true" />
                  </button>
                </div>
              </>
            )
          }
        </PanelCard>

        <PanelCard
          title="Needs review"
          className="stagger-6"
          right={
            reviewCount > 0 ? (
              <span className="rounded-full bg-copper/20 px-2 py-0.5 text-xs font-semibold tabular-nums text-copper">
                {reviewCount}
              </span>
            ) : undefined
          }
        >
          {() =>
            drafts === null ? (
              <RowSkeleton rows={4} />
            ) : drafts.length === 0 ? (
              <div className="flex h-full min-h-[180px] flex-col items-center justify-center text-center">
                <CheckCircle2
                  size={26}
                  aria-hidden="true"
                  className="mb-3 text-teal-light"
                />
                <p className="text-sm font-medium">All caught up</p>
                <p className="mt-1 max-w-[220px] text-xs leading-relaxed text-muted-foreground">
                  {lastSync
                    ? `New bank activity lands here. Synced ${timestampLabel(lastSync)}.`
                    : connections.length
                      ? "New bank activity lands here once the feed accounts are mapped."
                      : "New bank activity lands here once a feed is connected."}
                </p>
              </div>
            ) : (
              <div className="-mx-2 space-y-0.5">
                {drafts.map((e) => entryRow(e, true))}
                <div className="px-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={onReview}
                  >
                    Review all
                    <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )
          }
        </PanelCard>
      </div>

      <section className="stagger-6 animate-fade-up">
        <SectionHeader
          label="Accounts"
          count={bankAccounts.length}
          description={
            demo
              ? "Book balances from reviewed transactions."
              : needsMapping
                ? `Bank feed connected. Map ${countLabel(unmappedIdentities, "discovered account")} to your accounts to start syncing.`
                : feedAttention
                  ? "A bank connection needs attention."
                  : lastSync
                    ? `Synced ${timestampLabel(lastSync)}.`
                    : connections.length
                      ? "Connected. Map the discovered accounts to start syncing."
                      : "Connect a bank to keep these in step with the bank."
          }
          dotColor={
            needsMapping || feedAttention ? "var(--warning)" : undefined
          }
          action={
            needsMapping || feedAttention ? (
              <Button variant="outline" size="sm" onClick={onFeeds}>
                {needsMapping ? "Map accounts" : "Bank feeds"}
                <ArrowRight size={14} aria-hidden="true" />
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onAccounts}>
                All accounts
                <ArrowRight size={14} aria-hidden="true" />
              </Button>
            )
          }
        />
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden">
          {accountCards.map((c) => (
            <button
              key={c.account.id}
              type="button"
              onClick={onAccounts}
              className="glass-card glass-card-interactive flex min-w-[240px] shrink-0 snap-start flex-col gap-3 rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0"
            >
              <span className="flex items-center gap-3">
                <InstitutionLogo
                  institution={c.identity?.institution}
                  name={c.account.name}
                  size={36}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {c.account.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {isCard(c.account) ? "Credit card" : "Bank account"}
                    {c.identity?.institution
                      ? ` · ${c.identity.institution}`
                      : ""}
                  </span>
                </span>
              </span>
              <span className="text-2xl font-semibold tracking-tight tabular-nums">
                {metadataLoading ? (
                  <Skeleton className="h-7 w-28" />
                ) : (
                  <MaskedValue value={money(c.book)} />
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {c.bank !== null ? (
                  c.bank === c.book ? (
                    <span className="inline-flex items-center gap-1 text-teal-light">
                      <CheckCircle2 size={12} aria-hidden="true" />
                      Matches the bank
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <CircleAlert size={12} aria-hidden="true" />
                      Bank shows <MaskedValue value={money(c.bank)} />
                    </span>
                  )
                ) : c.connection?.last_success_at ? (
                  `Synced ${timestampLabel(c.connection.last_success_at)}`
                ) : activeConnection ? (
                  <span className="inline-flex items-center gap-1 text-warning">
                    <CircleAlert size={12} aria-hidden="true" />
                    Not mapped
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <CircleDashed size={12} aria-hidden="true" />
                    Not connected
                  </span>
                )}
              </span>
            </button>
          ))}
          {!demo && (
            <button
              type="button"
              onClick={onFeeds}
              className="flex min-w-[240px] shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[rgba(var(--ink),0.18)] p-4 text-center text-sm text-muted-foreground transition-colors hover:border-teal-light hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-teal-light">
                <Plus size={17} aria-hidden="true" />
              </span>
              {connections.length ? "Bank feeds" : "Connect a bank"}
            </button>
          )}
        </div>
      </section>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <PanelCard
          title="Recent activity"
          className="lg:col-span-2"
          right={
            <Button variant="ghost" size="sm" onClick={onTransactions}>
              See all
              <ArrowRight size={14} aria-hidden="true" />
            </Button>
          }
        >
          {() =>
            recent === null ? (
              <RowSkeleton rows={6} />
            ) : recent.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Reviewed transactions show up here.
              </p>
            ) : (
              <div className="-mx-2 space-y-0.5">
                {recent.map((e) => entryRow(e))}
              </div>
            )
          }
        </PanelCard>

        <PanelCard
          title={monthLabel(`${thisMonth}-01`)}
          right={
            locked ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <LockKeyhole size={12} aria-hidden="true" />
                Locked
              </span>
            ) : undefined
          }
        >
          {() =>
            !close && !demo && !loaded ? (
              <RowSkeleton rows={3} />
            ) : (
              <div className="flex h-full flex-col">
                <ul className="space-y-3 text-sm">
                  <li className="flex items-start gap-2.5">
                    {closeDrafts === 0 ? (
                      <CheckCircle2
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-teal-light"
                      />
                    ) : (
                      <CircleAlert
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-warning"
                      />
                    )}
                    <span>
                      {closeDrafts === 0
                        ? "Nothing left to review"
                        : countLabel(closeDrafts, "transaction") + " to review"}
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    {observedBanks === 0 ? (
                      <CircleDashed
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-muted-foreground"
                      />
                    ) : offBanks === 0 ? (
                      <CheckCircle2
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-teal-light"
                      />
                    ) : (
                      <CircleAlert
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-warning"
                      />
                    )}
                    <span>
                      {observedBanks === 0
                        ? "No bank balances reported yet"
                        : offBanks === 0
                          ? "Balances match the bank"
                          : countLabel(offBanks, "account") +
                            " off from the bank"}
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    {locked ? (
                      <CheckCircle2
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-teal-light"
                      />
                    ) : (
                      <LockKeyhole
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span>
                      {locked
                        ? "Month locked"
                        : close?.month_ended
                          ? "Ready to lock"
                          : "Lock after the last day of the month"}
                    </span>
                  </li>
                </ul>
                <div className="mt-auto pt-5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={demo}
                    onClick={onMonthEnd}
                  >
                    Month end
                    <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )
          }
        </PanelCard>
      </div>
    </div>
  );
}
