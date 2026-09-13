"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import { MaskedValue } from "@/components/ui/masked-value";
import { SectionHeader } from "@/components/ui/section-header";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { BalanceRow } from "@/lib/accounting/contracts";
import type { FeedData } from "@/lib/accounting/feeds";
import { bankIdentitiesByAccount } from "@/lib/accounting/bank-identity";
import { accountingGet } from "./use-accounting-command";
import { money, timestampLabel } from "./format";

type Status = "connected" | "reconnect" | "disconnected" | "unmapped" | "none";

const STATUS: Record<Status, { label: string; variant: BadgeVariant }> = {
  connected: { label: "Connected", variant: "success" },
  reconnect: { label: "Reconnect", variant: "warning" },
  disconnected: { label: "Disconnected", variant: "default" },
  unmapped: { label: "Not mapped", variant: "warning" },
  none: { label: "No feed", variant: "default" },
};

const ZERO = BigInt(0);

/**
 * Bank and card accounts as tiles: the institution mark, the book balance in
 * large type, and one quiet line saying whether the bank agrees. This is the
 * daily "do the books match the bank" glance; the chart of accounts sits
 * below it.
 */
export function AccountingBankPanel({
  accounts,
  bookBalance,
  isCard,
  demo,
  onFeeds,
  onLedger,
  onReconcile,
  onRefresh,
}: {
  accounts: BalanceRow[];
  bookBalance: (a: BalanceRow) => bigint;
  isCard: (a: BalanceRow) => boolean;
  demo: boolean;
  onFeeds: () => void;
  onLedger: (a: BalanceRow) => void;
  onReconcile: (a: BalanceRow) => void;
  onRefresh: () => Promise<void>;
}) {
  const [feeds, setFeeds] = useState<FeedData | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function load(signal?: AbortSignal) {
    try {
      setFeeds(await accountingGet<FeedData>({ view: "feeds" }, signal));
    } catch {
      /* Book balances still render without feed data. */
    }
  }

  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [demo]);

  async function sync(connectionId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncing(connectionId);
    try {
      const response = await fetch("/api/accounting/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", id: connectionId }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(result.error ?? "The sync could not finish.");
      toast("success", result.message ?? "Bank feed synced.");
      await load();
      await onRefresh();
    } catch (e) {
      toast(
        "error",
        e instanceof Error ? e.message : "The sync was interrupted.",
      );
    } finally {
      setSyncing(null);
      inFlight.current = false;
    }
  }

  if (accounts.length === 0) return null;

  const identities = bankIdentitiesByAccount(feeds);
  const rows = accounts.map((a) => {
    const feedAccount =
      feeds?.accounts.find((f) => f.account_id === a.id) ?? null;
    const identity = identities.get(a.id) ?? null;
    const connection =
      feeds?.connections.find((c) => c.id === identity?.connection_id) ?? null;
    const status: Status = !connection
      ? feeds?.connections.some((c) => c.status === "active")
        ? "unmapped"
        : "none"
      : connection.status === "active"
        ? "connected"
        : connection.status === "reconnect_required"
          ? "reconnect"
          : "disconnected";
    const book = bookBalance(a);
    const observed =
      identity?.balance?.balance_cents != null && feedAccount
        ? BigInt(identity.balance.balance_cents) *
          BigInt(feedAccount.balance_sign)
        : null;
    const difference = observed !== null ? book - observed : null;
    return {
      account: a,
      connection,
      identity,
      status,
      book,
      difference,
      observed,
    };
  });

  return (
    <section>
      <SectionHeader
        label="Bank and cards"
        count={accounts.length}
        description={
          demo
            ? "Book balances from posted transactions."
            : "Latest bank-reported balances, independent of transaction review."
        }
        action={
          !demo && (
            <Button variant="ghost" size="sm" onClick={onFeeds}>
              Bank feeds
              <ArrowUpRight size={14} aria-hidden="true" />
            </Button>
          )
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => {
          const off = r.difference !== null && r.difference !== ZERO;
          return (
            <div
              key={r.account.id}
              className={cn(
                "glass-card flex min-w-0 flex-col gap-4 rounded-xl p-4",
                off && "border-warning/30",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onLedger(r.account)}
                  className="flex min-w-0 items-center gap-3 rounded text-left transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <InstitutionLogo
                    institution={r.identity?.institution}
                    name={r.account.name}
                    size={36}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {r.account.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {isCard(r.account) ? "Credit card" : "Bank account"}
                      {r.identity?.institution
                        ? ` · ${r.identity.institution}`
                        : ""}
                    </span>
                  </span>
                </button>
                {(!demo || r.status !== "none") && (
                  <Badge variant={STATUS[r.status].variant} size="sm" dot>
                    {STATUS[r.status].label}
                  </Badge>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-semibold tracking-tight tabular-nums">
                  <MaskedValue value={money(r.observed ?? r.book)} />
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.observed !== null
                    ? `Bank reported${r.identity?.balance?.balance_at ? ` · ${timestampLabel(new Date(r.identity.balance.balance_at * 1000).toISOString())}` : ""}`
                    : "Book balance (no bank balance available)"}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {off ? (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <CircleAlert size={12} aria-hidden="true" />
                      Reviewed books: <MaskedValue value={money(r.book)} />
                    </span>
                  ) : r.difference !== null ? (
                    <span className="inline-flex items-center gap-1 text-teal-light">
                      <CheckCircle2 size={12} aria-hidden="true" />
                      Books match
                      {r.connection?.last_success_at
                        ? ` · synced ${timestampLabel(r.connection.last_success_at)}`
                        : ""}
                    </span>
                  ) : r.connection?.last_success_at ? (
                    `Synced ${timestampLabel(r.connection.last_success_at)}`
                  ) : r.status === "unmapped" ? (
                    <button
                      type="button"
                      onClick={onFeeds}
                      className="inline-flex items-center gap-1 rounded text-warning hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CircleAlert size={12} aria-hidden="true" />
                      Connected, not mapped yet. Map it in Bank feeds
                    </button>
                  ) : r.status === "none" ? (
                    <span className="inline-flex items-center gap-1">
                      <CircleDashed size={12} aria-hidden="true" />
                      {demo ? "Connect a feed after go-live" : "Not connected"}
                    </span>
                  ) : (
                    "Never synced"
                  )}
                </p>
              </div>
              {!demo && (
                <div className="-mx-2 -mb-1 flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    onClick={() => onReconcile(r.account)}
                  >
                    Reconcile
                  </Button>
                  {r.connection && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      disabled={syncing !== null || r.status === "disconnected"}
                      onClick={() => void sync(r.connection!.id)}
                    >
                      <RefreshCw
                        size={13}
                        aria-hidden="true"
                        className={cn(
                          syncing === r.connection.id && "animate-spin",
                        )}
                      />
                      Sync now
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
