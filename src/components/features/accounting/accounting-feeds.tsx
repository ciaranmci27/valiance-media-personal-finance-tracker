"use client";
import { PasswordInput } from "@/components/ui/inputs/PasswordInput";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  EyeOff,
  Landmark,
  Link2,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Select } from "@/components/ui/inputs/Select";
import { Skeleton } from "@/components/ui/skeleton";

import { Toggle } from "@/components/ui/inputs/Toggle";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type { BooksMetadata } from "./types";
import type {
  FeedData,
  FeedConnection,
  FeedIdentity,
  FeedCanonicalAccount,
} from "@/lib/accounting/feeds";
import { dateLabel, enumLabel, money, timestampLabel } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
/** Feed checkpoints are unix stamps; the date input and `dateLabel` take `YYYY-MM-DD`. */
const stampDate = (value: string | number | null) =>
  value ? new Date(Number(value) * 1000).toISOString().slice(0, 10) : "Not yet";
const statusVariant: Record<FeedConnection["status"], BadgeVariant> = {
  active: "success",
  claiming: "default",
  reconnect_required: "warning",
  disconnected: "default",
};
type Configuration = {
  ready: boolean;
  isolated: boolean;
  workerEnabled: boolean;
};
/** A sync run holds the connection until its lease expires or it finishes. */
const leased = (connection: FeedConnection) =>
  !!connection.lease_until && Date.parse(connection.lease_until) > Date.now();
/** Ownership is decided per identity; a company identity also needs a book account. */
// A mapped identity is a decided one even if the read still says unreviewed
// (the map command does not stamp ownership yet).
const needsOwnershipDecision = (identity: FeedIdentity) =>
  identity.ownership === "unreviewed" && identity.feed_account_id === null;
const needsAccountMapping = (identity: FeedIdentity) =>
  identity.ownership === "company" && identity.feed_account_id === null;

export function AccountingFeeds({
  data,
  manage,
  demo,
  onRefresh,
  onImports,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onImports: () => void;
}) {
  const [state, setState] = useState<FeedData | null>(null),
    [config, setConfig] = useState<Configuration | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null),
    inFlight = useRef(false);
  const [connect, setConnect] = useState<FeedConnection | "new" | null>(null),
    [mapping, setMapping] = useState<FeedIdentity | null>(null),
    [disconnect, setDisconnect] = useState<FeedConnection | null>(null),
    [skip, setSkip] = useState<FeedCanonicalAccount | null>(null);
  async function refresh() {
    setState(await accountingGet<FeedData>({ view: "feeds" }));
    await onRefresh();
  }
  const cmd = useAccountingCommand(refresh);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    Promise.all([
      accountingGet<FeedData>({ view: "feeds" }, abort.signal),
      fetch("/api/accounting/feeds", { cache: "no-store" }).then(async (r) => {
        if (!r.ok)
          throw new Error("Unable to read bank connection configuration.");
        return r.json() as Promise<Configuration>;
      }),
    ])
      .then(([feed, configuration]) => {
        // A superseded request is dropped rather than aborted.
        if (abort.signal.aborted) return;
        setState(feed);
        setConfig(configuration);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [demo]);
  async function sync(connection: FeedConnection, discover = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(connection.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/accounting/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: discover ? "discover" : "sync",
          id: connection.id,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "The sync could not finish.");
      setNotice(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sync was interrupted.");
    } finally {
      try {
        await refresh();
      } catch {
        setError("Refresh to see the latest sync result.");
      }
      setBusy(null);
      inFlight.current = false;
    }
  }
  const ready = state?.queue.reduce((n, q) => n + Number(q.ready), 0) ?? 0,
    pending = state?.queue.reduce((n, q) => n + Number(q.pending), 0) ?? 0;
  const accountName = (id: string) =>
    data.accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  const unreviewed =
    state?.identities.filter((a) => {
      const c = state.connections.find((c) => c.id === a.connection_id);
      return (
        c?.status === "active" &&
        (needsOwnershipDecision(a) || needsAccountMapping(a))
      );
    }).length ?? 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Bank feeds</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Bring company bank activity into your review queue. Each movement
            keeps its source, date, and original evidence.
          </p>
        </div>
        {/* One SimpleFIN connection is the norm; once it exists, adding another steps back. */}
        <Button
          variant={state?.connections.length ? "ghost" : "default"}
          disabled={demo || !config?.ready || !!busy}
          onClick={() => setConnect("new")}
        >
          <Plus size={16} aria-hidden="true" />
          {state?.connections.length
            ? "Add another connection"
            : "Connect SimpleFIN"}
        </Button>
      </div>
      {(error || cmd.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error || cmd.error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"
        >
          {notice}
        </p>
      )}
      {demo && (
        <p className="text-sm text-muted-foreground">
          Bank connections are unavailable in the public demo.
        </p>
      )}
      {config && !config.ready && (
        <div className="glass-card rounded-xl p-4">
          <p className="font-medium">Live bank access is off</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {config.isolated
              ? "This environment uses synthetic data. You can review the workflow without contacting a bank."
              : "Configure the separate SimpleFIN encryption key and server connection to enable setup."}
          </p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: "Ready for import review",
            value: ready,
            icon: CheckCircle2,
          },
          { label: "Accounts to review", value: unreviewed, icon: Landmark },
          { label: "Pending observations", value: pending, icon: Clock3 },
        ].map((item) => (
          <div
            key={item.label}
            className="glass-card flex items-center justify-between rounded-xl p-4"
          >
            <div>
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {item.value}
              </p>
            </div>
            <item.icon
              size={22}
              className="text-primary/70"
              aria-hidden="true"
            />
          </div>
        ))}
      </div>
      {!state && !demo && !error && (
        <div
          role="status"
          aria-label="Loading connections..."
          className="glass-card overflow-hidden rounded-xl"
        >
          <div className="space-y-2 border-b border-border p-5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-72" />
          </div>
          <div className="space-y-3 p-5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </div>
      )}
      {state?.connections.length === 0 && (
        <div className="glass-card flex flex-col items-center rounded-xl px-6 py-12 text-center">
          <Landmark
            size={30}
            className="text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="mt-4 font-semibold">Connect your company accounts</h3>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Start with account discovery, then review which accounts belong to
            the company. Historical CSV imports can fill periods your bank no
            longer provides.
          </p>
          <Button variant="outline" className="mt-5" onClick={onImports}>
            Review CSV imports
            <ArrowRight size={15} aria-hidden="true" />
          </Button>
        </div>
      )}
      {state?.connections.map((connection) => {
        const identities = state.identities.filter(
            (a) => a.connection_id === connection.id,
          ),
          running = busy === connection.id || leased(connection),
          mapped = identities.some((a) => a.feed_account_id !== null);
        return (
          <section
            key={connection.id}
            className="glass-card overflow-hidden rounded-xl"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
              <div>
                <div className="flex items-center gap-2">
                  <Link2
                    size={17}
                    className="text-primary"
                    aria-hidden="true"
                  />
                  <h3 className="font-semibold">{connection.name}</h3>
                  <Badge
                    variant={
                      running ? "info" : statusVariant[connection.status]
                    }
                  >
                    {running ? "Syncing" : enumLabel(connection.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Last complete run:{" "}
                  {connection.last_success_at
                    ? timestampLabel(connection.last_success_at)
                    : "Not yet"}{" "}
                  ·{" "}
                  {leased(connection)
                    ? `Sync lease held until ${timestampLabel(connection.lease_until)}`
                    : connection.scheduled
                      ? `Next background sync: ${
                          connection.next_sync_at
                            ? timestampLabel(connection.next_sync_at)
                            : "when the worker next runs"
                        }`
                      : "Background sync off"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {connection.status === "active" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!config?.ready || !!busy || running}
                      onClick={() => sync(connection, true)}
                    >
                      Discover accounts
                    </Button>
                    <Button
                      size="sm"
                      disabled={!config?.ready || !!busy || running || !mapped}
                      onClick={() => sync(connection)}
                    >
                      <RefreshCw
                        size={14}
                        className={running ? "animate-spin" : ""}
                        aria-hidden="true"
                      />
                      {running ? "Syncing..." : "Sync now"}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={!config?.ready || !!busy}
                    onClick={() => setConnect(connection)}
                  >
                    Reconnect
                  </Button>
                )}
              </div>
            </div>
            {connection.last_error.startsWith("Discover and review") ? (
              <p
                role="status"
                className="border-b border-border bg-[rgba(var(--ink),0.04)] px-5 py-3 text-sm"
              >
                <span className="font-medium">
                  {identities.filter((i) => i.feed_account_id).length} of{" "}
                  {identities.length} accounts mapped.
                </span>{" "}
                <span className="text-muted-foreground">
                  Nothing syncs until each account below is mapped to a book
                  account, or marked personal or ignored.
                </span>
              </p>
            ) : connection.last_error ? (
              <p
                role="status"
                className="border-b border-border bg-warning/10 px-5 py-3 text-sm text-warning"
              >
                {connection.last_error}
              </p>
            ) : null}
            {connection.status === "claiming" && (
              <p className="px-5 py-3 text-sm text-muted-foreground">
                A one-time setup attempt is recorded. If it stopped
                unexpectedly, disable that token in SimpleFIN and reconnect with
                a new token.
              </p>
            )}
            <div className="divide-y divide-border">
              {identities.map((identity) => {
                const mapped = identity.account,
                  queue = state.queue.find(
                    (q) => q.feed_account_id === mapped?.id,
                  ),
                  undecided = needsOwnershipDecision(identity),
                  unmapped = needsAccountMapping(identity);
                const isCard = manage.profiles.some(
                  (p) =>
                    p.account_id === mapped?.account_id &&
                    p.cash_kind === "card",
                );
                const balance = identity.balance?.balance_cents,
                  normalized =
                    balance !== null && balance !== undefined && mapped
                      ? BigInt(balance) * BigInt(mapped.balance_sign)
                      : null;
                const twin = identities.some(
                  (o) =>
                    o.id !== identity.id &&
                    o.name === identity.name &&
                    o.institution === identity.institution,
                );
                const locked =
                  demo || cmd.busy || running || connection.status !== "active";
                const ignore = () =>
                  void cmd.execute({
                    type: "feed.map",
                    id: identity.id,
                    expected_version: identity.version,
                    ownership: "ignored",
                    account_id: null,
                    history_start: String(Math.floor(Date.now() / 1000)),
                    posting_timezone: "America/Phoenix",
                    movement_sign: 1,
                    balance_sign: 1,
                    reviewed: true,
                    reason: "Ignored from Bank feeds",
                  });
                return (
                  <div key={identity.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <InstitutionLogo
                          institution={identity.institution}
                          name={identity.name}
                          size={36}
                        />
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            <span className="truncate">{identity.name}</span>
                            {undecided || unmapped ? (
                              <Badge variant="warning" size="sm" dot>
                                Needs mapping
                              </Badge>
                            ) : mapped ? (
                              <Badge variant="success" size="sm" dot>
                                Mapped
                              </Badge>
                            ) : (
                              <Badge size="sm">
                                {identity.ownership === "personal"
                                  ? "Personal"
                                  : "Ignored"}
                              </Badge>
                            )}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {identity.institution}
                            {identity.currency !== "USD"
                              ? ` · ${identity.currency}`
                              : ""}
                            {" · "}
                            {undecided
                              ? "Not mapped yet"
                              : unmapped
                                ? "Choose the book account it feeds"
                                : mapped
                                  ? `Feeds ${accountName(mapped.account_id)}`
                                  : identity.ownership === "personal"
                                    ? "Personal, left out of the books"
                                    : "Ignored"}
                          </p>
                          {twin && (
                            <p className="mt-1 text-xs text-warning">
                              The bank lists this account more than once. Map
                              one entry and ignore the other.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {undecided && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={locked}
                            onClick={ignore}
                          >
                            <EyeOff size={14} aria-hidden="true" />
                            Ignore
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant={
                            undecided || unmapped ? "default" : "outline"
                          }
                          disabled={locked}
                          onClick={() => setMapping(identity)}
                        >
                          {undecided
                            ? "Map account"
                            : unmapped
                              ? "Choose account"
                              : "Edit mapping"}
                          {(undecided || unmapped) && (
                            <ArrowRight size={14} aria-hidden="true" />
                          )}
                        </Button>
                      </div>
                    </div>
                    {mapped && (
                      <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
                        <div>
                          <p className="text-xs text-muted-foreground">
                            {isCard
                              ? normalized !== null && normalized > BigInt(0)
                                ? "Card credit balance"
                                : "Card balance owed"
                              : "Latest bank balance"}
                          </p>
                          <p className="mt-1 font-medium tabular-nums">
                            <MaskedValue
                              value={
                                normalized === null
                                  ? "Unavailable"
                                  : money(
                                      isCard && normalized < BigInt(0)
                                        ? -normalized
                                        : normalized,
                                    )
                              }
                            />
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {identity.balance?.balance_at
                              ? timestampLabel(
                                  new Date(
                                    identity.balance.balance_at * 1000,
                                  ).toISOString(),
                                )
                              : "Timestamp unavailable"}
                          </p>
                          {!isCard && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Available:{" "}
                              <MaskedValue
                                value={
                                  identity.balance?.available_cents == null
                                    ? "Unavailable"
                                    : money(
                                        BigInt(
                                          identity.balance.available_cents,
                                        ) * BigInt(mapped.balance_sign),
                                      )
                                }
                              />
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">
                            Requested history
                          </p>
                          <p className="mt-1">
                            From {dateLabel(stampDate(mapped.history_start))}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Processed to{" "}
                            {dateLabel(stampDate(mapped.checkpoint))}{" "}
                            (exclusive)
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">
                            Bank observations
                          </p>
                          <p className="mt-1">
                            {queue?.ready ?? 0} ready · {queue?.pending ?? 0}{" "}
                            pending
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Ready movements stay in Imports until matched or
                            applied.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="link"
                              disabled={demo || cmd.busy || running}
                              onClick={() => setSkip(mapped)}
                            >
                              Missing older history
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                    {!!identity.balance?.issues.length && (
                      <ul className="mt-3 space-y-1 text-xs text-warning">
                        {identity.balance.issues.map((issue, index) => (
                          <li key={index}>{issue.message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              {!identities.length && (
                <p className="p-5 text-sm text-muted-foreground">
                  Discover accounts to review their ownership and connection to
                  your books.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-secondary/10 px-5 py-3">
              <div>
                <Toggle
                  checked={connection.scheduled}
                  label="Daily background sync"
                  disabled={
                    demo ||
                    cmd.busy ||
                    running ||
                    connection.status !== "active" ||
                    (!config?.workerEnabled && !connection.scheduled)
                  }
                  onChange={(enabled) =>
                    void cmd.execute({
                      type: "feed.schedule",
                      id: connection.id,
                      expected_version: connection.version,
                      enabled,
                    })
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {config?.workerEnabled
                    ? "The worker resumes from saved checkpoints when the next sync is due."
                    : "The background worker must be configured before it can be enabled."}
                </p>
              </div>
              {connection.status !== "disconnected" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setDisconnect(connection)}
                  disabled={cmd.busy}
                >
                  <Unplug size={13} aria-hidden="true" />
                  Disconnect
                </Button>
              )}
            </div>
          </section>
        );
      })}
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Sync checkpoints describe received data. Statement reconciliation and
          verified historical reports establish your accounting coverage.
          Pending movements never create drafts.
        </p>
        <Button variant="outline" onClick={onImports}>
          Open import review
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </div>
      {!!state?.runs.length && (
        <details className="glass-card rounded-xl p-5">
          <summary className="cursor-pointer text-sm font-medium">
            Recent sync activity
          </summary>
          <div className="mt-4 divide-y divide-border">
            {/* The view lists one row per audit update of a run; show each run once, latest first. */}
            {state.runs
              .filter(
                (run, i, all) => all.findIndex((r) => r.id === run.id) === i,
              )
              .map((run) => (
                <div key={run.id} className="py-3 text-xs">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>
                      {timestampLabel(run.started_at)} ·{" "}
                      {run.actor_kind === "worker"
                        ? "Background worker"
                        : "Owner request"}
                    </span>
                    <span>{enumLabel(run.status)}</span>
                  </div>
                  {run.error && (
                    <p className="mt-1 text-muted-foreground">{run.error}</p>
                  )}
                </div>
              ))}
          </div>
        </details>
      )}
      {connect && (
        <ConnectFeed
          current={connect === "new" ? null : connect}
          onClose={() => setConnect(null)}
          onSaved={async () => {
            await refresh();
            setConnect(null);
            setNotice(
              "Connected. Use Discover accounts, then review each company mapping.",
            );
          }}
        />
      )}
      {mapping && state && (
        <MapFeed
          identity={mapping}
          accounts={data.accounts}
          profiles={manage.profiles}
          canonical={state.accounts}
          defaultStart={manage.preferences?.primary_system_since ?? null}
          onClose={() => setMapping(null)}
          onSaved={async () => {
            await refresh();
            setMapping(null);
          }}
        />
      )}
      {disconnect && (
        <DisconnectFeed
          connection={disconnect}
          onClose={() => setDisconnect(null)}
          onSaved={async () => {
            await refresh();
            setDisconnect(null);
          }}
        />
      )}
      {skip && (
        <SkipHistory
          account={skip}
          onClose={() => setSkip(null)}
          onSaved={async () => {
            await refresh();
            setSkip(null);
          }}
        />
      )}
    </div>
  );
}

function ConnectFeed({
  current,
  onClose,
  onSaved,
}: {
  current: FeedConnection | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(current?.name ?? "Company banking"),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [ids] = useState(() => ({
      key: crypto.randomUUID(),
      id: current?.id ?? crypto.randomUUID(),
      claim: crypto.randomUUID(),
    })),
    [attempted, setAttempted] = useState(false);
  const flight = useRef(false);
  async function save() {
    if (flight.current || attempted) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setAttempted(true);
    try {
      const response = await fetch("/api/accounting/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          key: ids.key,
          command: {
            type: "feed.claim",
            id: ids.id,
            claim_id: ids.claim,
            expected_version: current?.version ?? 0,
            name,
          },
          token,
        }),
      });
      setToken("");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to connect.");
      await onSaved();
    } catch (e) {
      setToken("");
      setError(
        e instanceof Error
          ? e.message
          : "The one-time setup request was interrupted. Refresh the connection before creating another token.",
      );
    } finally {
      setBusy(false);
      flight.current = false;
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {current ? "Reconnect SimpleFIN" : "Connect SimpleFIN"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Paste a SimpleFIN setup token to connect your bank.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="space-y-2">
            <PasswordInput
              label="Setup token"
              placeholder="Paste your setup token"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(nextValue) => setToken(nextValue)}
              maxLength={12000}
              required
              disabled={busy || attempted}
            />
            <a
              className="inline-flex items-center gap-1 text-xs text-teal-light underline-offset-4 hover:underline"
              href="https://bridge.simplefin.org/simplefin/create"
              target="_blank"
              rel="noopener noreferrer"
            >
              Create a setup token in SimpleFIN
              <ArrowRight size={12} aria-hidden="true" />
            </a>
          </div>
          <details className="group rounded-xl border border-border">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
              Advanced
            </summary>
            <div className="space-y-4 border-t border-border p-4">
              <TextInput
                label="Connection name"
                value={name}
                onChange={(nextValue) => setName(nextValue)}
                maxLength={120}
                required
                disabled={busy || attempted}
              />
            </div>
          </details>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onClose}
            >
              {attempted ? "Close" : "Cancel"}
            </Button>
            <Button
              disabled={busy || attempted || !name.trim() || !token.trim()}
            >
              {busy ? "Connecting..." : "Connect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function MapFeed({
  identity,
  accounts,
  profiles,
  canonical,
  defaultStart,
  onClose,
  onSaved,
}: {
  identity: FeedIdentity;
  accounts: AccountingWorkspace["accounts"];
  profiles: BooksMetadata["profiles"];
  canonical: FeedCanonicalAccount[];
  /** The day these books became primary; history begins there so nothing already in the books is pulled twice. */
  defaultStart: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [ownership, setOwnership] = useState<
      "company" | "personal" | "ignored"
    >(identity.ownership === "unreviewed" ? "company" : identity.ownership),
    [accountId, setAccountId] = useState(identity.account?.account_id ?? ""),
    [start, setStart] = useState(
      identity.account
        ? stampDate(identity.account.history_start)
        : (defaultStart ??
            stampDate(Math.floor(Date.now() / 1000) - 90 * 86400)),
    ),
    [zone, setZone] = useState<"UTC" | "America/Phoenix">(
      identity.account?.posting_timezone ?? "America/Phoenix",
    ),
    [movement, setMovement] = useState<1 | -1>(
      identity.account?.movement_sign ?? 1,
    ),
    [balance, setBalance] = useState<1 | -1>(
      identity.account?.balance_sign ?? 1,
    );
  const cmd = useAccountingCommand(onSaved),
    existing = canonical.find((a) => a.account_id === accountId),
    banks = accounts.filter(
      (a) =>
        !a.is_archived &&
        profiles.some(
          (p) =>
            p.account_id === a.id &&
            ["bank", "card", "cash"].includes(p.cash_kind),
        ),
    );
  const locked = !!existing && !existing.can_edit_settings,
    usd = identity.currency === "USD";
  function choose(id: string) {
    setAccountId(id);
    const saved = canonical.find((a) => a.account_id === id);
    if (saved) {
      setStart(stampDate(saved.history_start));
      setZone(saved.posting_timezone);
      setMovement(saved.movement_sign);
      setBalance(saved.balance_sign);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Map {identity.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Choose whose account this is and which book account it feeds.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            const historyStart =
              (existing && !existing.can_edit_settings
                ? existing.history_start
                : null) ??
              String(
                Date.parse(
                  `${start}T00:00:00${zone === "America/Phoenix" ? "-07:00" : "Z"}`,
                ) / 1000,
              );
            void cmd.execute({
              type: "feed.map",
              id: identity.id,
              expected_version: identity.version,
              expected_feed_version: existing?.version,
              ownership,
              account_id: ownership === "company" ? accountId : null,
              history_start: historyStart,
              posting_timezone: zone,
              movement_sign: movement,
              balance_sign: balance,
              reviewed: true,
              reason: "Mapped from Bank feeds",
            });
          }}
        >
          <Select
            label="This account is"
            value={ownership}
            onChange={(value) => {
              setOwnership(value as typeof ownership);
            }}
            options={[
              { value: "company", label: "Company account" },
              { value: "personal", label: "Personal, leave it out" },
              { value: "ignored", label: "Ignore it" },
            ]}
          />
          {ownership === "company" && (
            <>
              <Select
                searchable
                label="Feeds book account"
                visibleLabel="Feeds book account"
                value={accountId}
                onChange={choose}
                placeholder="Choose a bank or card account"
                required
                options={banks.map((a) => ({ value: a.id, label: a.name }))}
                error={
                  usd ? undefined : "Only USD accounts can feed the books."
                }
              />
              <DateInput
                label="History begins"
                value={start}
                onChange={setStart}
                disabled={locked}
                required
                description={
                  locked
                    ? "Kept from this account's saved feed."
                    : defaultStart
                      ? "Starts where these books became primary, so nothing is pulled twice."
                      : undefined
                }
              />
              <details className="group rounded-xl border border-border">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
                  Advanced
                </summary>
                <div className="space-y-4 border-t border-border p-4">
                  <Select
                    label="Transaction sign"
                    value={String(movement)}
                    onChange={(value) => {
                      setMovement(Number(value) as 1 | -1);
                    }}
                    disabled={locked}
                    options={[
                      {
                        value: "1",
                        label: "Keep source sign (deposit +, charge -)",
                      },
                      { value: "-1", label: "Reverse source sign" },
                    ]}
                  />
                  <Select
                    label="Balance sign"
                    value={String(balance)}
                    onChange={(value) => {
                      setBalance(Number(value) as 1 | -1);
                    }}
                    disabled={locked}
                    options={[
                      {
                        value: "1",
                        label: "Keep source sign (cash +, card debt -)",
                      },
                      {
                        value: "-1",
                        label: "Reverse source sign (card debt +)",
                      },
                    ]}
                  />
                </div>
              </details>
            </>
          )}
          {cmd.error && (
            <p role="alert" className="text-sm text-destructive">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={
                cmd.busy || (ownership === "company" && (!accountId || !usd))
              }
            >
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function DisconnectFeed({
  connection,
  onClose,
  onSaved,
}: {
  connection: FeedConnection;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect feed</DialogTitle>
          <DialogDescription>
            {connection.name} stops syncing. Revoke its token in SimpleFIN too.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void cmd.execute({
              type: "feed.disconnect",
              id: connection.id,
              expected_version: connection.version,
              reason,
            });
          }}
        >
          <TextInput
            label="Reason"
            placeholder="Why this feed is going away"
            value={reason}
            onChange={(nextValue) => setReason(nextValue)}
            maxLength={1000}
            required
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-destructive">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={cmd.busy || !reason.trim()}>
              Disconnect
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function SkipHistory({
  account,
  onClose,
  onSaved,
}: {
  account: FeedCanonicalAccount;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [date, setDate] = useState(""),
    [reason, setReason] = useState("");
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Skip unavailable history</DialogTitle>
          <DialogDescription className="sr-only">
            Move the sync checkpoint past a period the bank cannot return.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void cmd.execute({
              type: "feed.skip",
              id: account.id,
              expected_version: account.version,
              through: String(
                Date.parse(
                  `${date}T00:00:00${account.posting_timezone === "America/Phoenix" ? "-07:00" : "Z"}`,
                ) / 1000,
              ),
              reason,
            });
          }}
        >
          <DateInput
            label="Continue from"
            value={date}
            onChange={setDate}
            required
            description={`The checkpoint is at ${dateLabel(
              stampDate(account.checkpoint ?? account.history_start),
            )}.`}
          />
          <TextInput
            label="Reason"
            placeholder="Why the bank cannot return this period"
            value={reason}
            onChange={(nextValue) => setReason(nextValue)}
            required
            maxLength={1000}
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-destructive">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button disabled={cmd.busy || !date || !reason.trim()}>Skip</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
