"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CreditCard, Landmark, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { MaskedValue } from "@/components/ui/masked-value";
import { SectionHeader } from "@/components/ui/section-header";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { BalanceRow } from "@/lib/accounting/contracts";
import type { FeedData } from "@/lib/accounting/feeds";
import { accountingGet } from "./use-accounting-command";
import { money, timestampLabel } from "./format";

type Status = "connected" | "reconnect" | "disconnected" | "none";

const STATUS: Record<Status, { label: string; variant: BadgeVariant }> = {
  connected: { label: "Connected", variant: "success" },
  reconnect: { label: "Reconnect", variant: "warning" },
  disconnected: { label: "Disconnected", variant: "default" },
  none: { label: "No feed", variant: "default" },
};

const ZERO = BigInt(0);

/**
 * Bank and card accounts with the book balance beside the balance the bank
 * reported, the last sync and a Sync now. This is the daily "do the books
 * match the bank" glance; the chart of accounts sits below it.
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

  const rows = accounts.map((a) => {
    const feedAccount =
      feeds?.accounts.find((f) => f.account_id === a.id) ?? null;
    // A bank account can keep identities from earlier connections; the one on
    // a live connection is the one to show.
    const candidates = feedAccount
      ? (feeds?.identities ?? [])
          .filter((i) => i.feed_account_id === feedAccount.id)
          .map((i) => ({
            identity: i,
            connection:
              feeds?.connections.find((c) => c.id === i.connection_id) ?? null,
          }))
      : [];
    const best =
      candidates.find((c) => c.connection?.status === "active") ??
      candidates.find((c) => c.connection?.status === "reconnect_required") ??
      candidates[0] ??
      null;
    const identity = best?.identity ?? null;
    const connection = best?.connection ?? null;
    const status: Status = !connection
      ? "none"
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
    return { account: a, connection, identity, status, book, difference };
  });

  return (
    <section>
      <SectionHeader
        label="Bank and cards"
        count={accounts.length}
        description={
          demo
            ? "Book balances from reviewed transactions."
            : "Book balance beside what the bank last reported."
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
        {rows.map((r) => (
          <div
            key={r.account.id}
            className={cn(
              "glass-card flex flex-col gap-3 rounded-xl p-4",
              r.difference !== null &&
                r.difference !== ZERO &&
                "border-warning/30",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => onLedger(r.account)}
                className="flex min-w-0 items-center gap-2.5 rounded text-left transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-teal-light">
                  {isCard(r.account) ? (
                    <CreditCard size={15} aria-hidden="true" />
                  ) : (
                    <Landmark size={15} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {r.account.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {r.identity?.institution || r.account.code}
                  </span>
                </span>
              </button>
              {(!demo || r.status !== "none") && (
                <Badge variant={STATUS[r.status].variant} size="sm" dot>
                  {STATUS[r.status].label}
                </Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  Books
                </p>
                <p className="mt-0.5 font-mono text-lg tracking-tight">
                  <MaskedValue value={money(r.book)} />
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  Bank
                </p>
                <p className="mt-0.5 font-mono text-lg tracking-tight">
                  {r.difference !== null ? (
                    <MaskedValue value={money(r.book - r.difference)} />
                  ) : (
                    <span className="font-sans text-sm text-muted-foreground">
                      {demo ? "Live only" : "Not reported"}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {r.difference !== null && r.difference !== ZERO ? (
                  <span className="text-warning">
                    Off by <MaskedValue value={money(r.difference)} />
                  </span>
                ) : r.connection?.last_success_at ? (
                  `Synced ${timestampLabel(r.connection.last_success_at)}`
                ) : r.status === "none" ? (
                  demo ? (
                    "Connect a feed after go-live"
                  ) : (
                    "Connect this account in Bank feeds"
                  )
                ) : (
                  "Never synced"
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {!demo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => onReconcile(r.account)}
                  >
                    Reconcile
                  </Button>
                )}
                {r.connection && !demo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
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
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
