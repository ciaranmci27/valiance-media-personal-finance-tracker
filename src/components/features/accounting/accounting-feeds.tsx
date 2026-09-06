"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Landmark,
  Link2,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type { ManageData } from "@/lib/accounting/workflows";
import type {
  FeedData,
  FeedConnection,
  FeedIdentity,
  FeedCanonicalAccount,
} from "@/lib/accounting/feeds";
import { formatCents } from "@/lib/accounting/money";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
const selectStyle =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
const dateLabel = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not yet";
const stampDate = (value: string | number | null) =>
  value ? new Date(Number(value) * 1000).toISOString().slice(0, 10) : "Not yet";
type Configuration = {
  ready: boolean;
  isolated: boolean;
  workerEnabled: boolean;
};

export function AccountingFeeds({
  data,
  manage,
  demo,
  onRefresh,
  onImports,
}: {
  data: AccountingWorkspace;
  manage: ManageData;
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
      fetch("/api/accounting/feeds", {
        signal: abort.signal,
        cache: "no-store",
      }).then(async (r) => {
        if (!r.ok)
          throw new Error("Unable to read bank connection configuration.");
        return r.json() as Promise<Configuration>;
      }),
    ])
      .then(([feed, configuration]) => {
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
        a.observed_generation === c.generation &&
        (a.ownership === "unreviewed" || a.approved_generation !== c.generation)
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
        <Button
          disabled={demo || !config?.ready || !!busy}
          onClick={() => setConnect("new")}
        >
          <Plus size={16} />
          Connect SimpleFIN
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
        <div className="rounded-xl border border-border bg-secondary/20 p-4">
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
            className="glass-card flex items-center justify-between p-4"
          >
            <div>
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {item.value}
              </p>
            </div>
            <item.icon size={22} className="text-primary/70" />
          </div>
        ))}
      </div>
      {!state && !demo && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading connections...
        </p>
      )}
      {state?.connections.length === 0 && (
        <div className="glass-card flex flex-col items-center px-6 py-12 text-center">
          <Landmark size={30} className="text-muted-foreground" />
          <h3 className="mt-4 font-semibold">Connect your company accounts</h3>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Start with account discovery, then review which accounts belong to
            the company. Historical CSV imports can fill periods your bank no
            longer provides.
          </p>
          <Button variant="outline" className="mt-5" onClick={onImports}>
            Review CSV imports
            <ArrowRight size={15} />
          </Button>
        </div>
      )}
      {state?.connections.map((connection) => {
        const identities = state.identities.filter(
            (a) => a.connection_id === connection.id,
          ),
          running =
            busy === connection.id ||
            (!!connection.lease_until &&
              Date.parse(connection.lease_until) > Date.now()),
          waiting =
            !!connection.retry_at &&
            Date.parse(connection.retry_at) > Date.now();
        return (
          <section key={connection.id} className="glass-card overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
              <div>
                <div className="flex items-center gap-2">
                  <Link2 size={17} className="text-primary" />
                  <h3 className="font-semibold">{connection.name}</h3>
                  <span className="rounded-full bg-secondary px-2 py-1 text-[11px] capitalize">
                    {running
                      ? "Syncing"
                      : connection.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Last complete run: {dateLabel(connection.last_success_at)} ·{" "}
                  {connection.requests_today}/24 requests in the last day
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {connection.status === "active" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!config?.ready || !!busy || running || waiting}
                      onClick={() => sync(connection, true)}
                    >
                      Discover accounts
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        !config?.ready ||
                        !!busy ||
                        running ||
                        waiting ||
                        !identities.some(
                          (a) =>
                            a.ownership === "company" &&
                            a.approved_generation === connection.generation,
                        )
                      }
                      onClick={() => sync(connection)}
                    >
                      <RefreshCw
                        size={14}
                        className={running ? "animate-spin" : ""}
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
            {connection.last_error && (
              <p
                role="status"
                className="border-b border-border bg-amber-500/5 px-5 py-3 text-sm text-amber-500"
              >
                {connection.last_error}
                {waiting && (
                  <span className="block text-xs">
                    Retry after {dateLabel(connection.retry_at)}
                  </span>
                )}
              </p>
            )}
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
                  needsReview =
                    identity.approved_generation !== connection.generation ||
                    identity.ownership === "unreviewed";
                const currentIdentity =
                  identity.observed_generation === connection.generation;
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
                return (
                  <div key={identity.id} className="p-5">
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {identity.name}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {identity.currency}
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {identity.institution} ·{" "}
                          {!currentIdentity
                            ? "Retained prior connection identity"
                            : needsReview
                              ? "Mapping review required"
                              : identity.ownership === "company"
                                ? accountName(mapped!.account_id)
                                : identity.ownership === "personal"
                                  ? "Personal account, excluded"
                                  : "Ignored"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          demo ||
                          cmd.busy ||
                          running ||
                          connection.status !== "active" ||
                          identity.observed_generation !== connection.generation
                        }
                        onClick={() => setMapping(identity)}
                      >
                        Review mapping
                      </Button>
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
                                  : formatCents(
                                      isCard && normalized < BigInt(0)
                                        ? -normalized
                                        : normalized,
                                    )
                              }
                            />
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {identity.balance?.balance_at
                              ? dateLabel(
                                  new Date(
                                    identity.balance.balance_at * 1000,
                                  ).toISOString(),
                                )
                              : "Timestamp unavailable"}
                          </p>
                          {!isCard && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Available:{" "}
                              <MaskedValue
                                value={
                                  identity.balance?.available_cents == null
                                    ? "Unavailable"
                                    : formatCents(
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
                            From {stampDate(mapped.history_start)}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Processed to {stampDate(mapped.checkpoint)}{" "}
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
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                demo ||
                                cmd.busy ||
                                !Number(queue?.ready) ||
                                !currentIdentity
                              }
                              onClick={async () => {
                                setNotice("");
                                const result = await cmd.execute({
                                  type: "feed.prepare",
                                  id: mapped.id,
                                });
                                if (result)
                                  setNotice(
                                    "A batch of up to 50 movements is ready in Imports. Review existing matches and exceptions, then create drafts.",
                                  );
                              }}
                            >
                              Prepare review batch
                            </Button>
                            <button
                              className="text-xs text-muted-foreground underline underline-offset-4"
                              disabled={cmd.busy || running}
                              onClick={() => setSkip(mapped)}
                            >
                              Missing older history
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {!!identity.balance?.issues.length && (
                      <ul className="mt-3 space-y-1 text-xs text-amber-500">
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
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={connection.scheduled}
                    disabled={
                      demo ||
                      cmd.busy ||
                      running ||
                      connection.status !== "active" ||
                      (!config?.workerEnabled && !connection.scheduled)
                    }
                    onChange={(e) =>
                      cmd.execute({
                        type: "feed.schedule",
                        id: connection.id,
                        expected_version: connection.version,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  Daily background sync
                </label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {config?.workerEnabled
                    ? "Runs use a randomized time and keep saved checkpoints."
                    : "The background worker must be configured before it can be enabled."}
                </p>
              </div>
              {connection.status !== "disconnected" && (
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setDisconnect(connection)}
                  disabled={cmd.busy}
                >
                  <Unplug size={13} />
                  Disconnect
                </button>
              )}
            </div>
          </section>
        );
      })}
      {!!state?.gaps.length && (
        <section className="glass-card p-5">
          <h3 className="font-semibold">Historical coverage review</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A successful request does not prove that a bank supplied all its
            older history. Compare these periods with original statements and
            verified imports.
          </p>
          <div className="mt-4 divide-y divide-border">
            {state.gaps.map((gap) => (
              <div key={gap.id} className="py-3">
                <p className="text-sm font-medium">
                  {accountName(
                    state.accounts.find((a) => a.id === gap.feed_account_id)
                      ?.account_id ?? "",
                  )}{" "}
                  · {stampDate(gap.from_stamp)} to {stampDate(gap.to_stamp)}{" "}
                  (exclusive)
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {gap.reason}
                </p>
                <p
                  className={`mt-1 text-xs ${gap.covered ? "text-primary" : "text-amber-500"}`}
                >
                  {gap.covered
                    ? "Covered by current statement or historical verification"
                    : "Independent coverage still needed"}
                </p>
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={onImports}>
            Open imports
            <ArrowRight size={14} />
          </Button>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Sync checkpoints describe received data. Statement reconciliation and
          verified historical reports establish your accounting coverage.
          Pending movements never create drafts.
        </p>
        <Button variant="outline" onClick={onImports}>
          Open import review
          <ArrowRight size={15} />
        </Button>
      </div>
      {!!state?.runs.length && (
        <details className="glass-card p-5">
          <summary className="cursor-pointer text-sm font-medium">
            Recent sync activity
          </summary>
          <div className="mt-4 divide-y divide-border">
            {state.runs.map((run) => (
              <div key={run.id} className="py-3 text-xs">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>
                    {dateLabel(run.started_at)} ·{" "}
                    {run.actor_kind === "worker"
                      ? "Background worker"
                      : "Owner request"}
                  </span>
                  <span className="capitalize">{run.status}</span>
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {current ? "Reconnect SimpleFIN" : "Connect SimpleFIN"}
          </DialogTitle>
          <DialogDescription>
            Create a setup token in SimpleFIN, then paste it here. A token is
            claimed once and its access credentials stay on the server.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="block text-sm">
            Connection name
            <Input
              className="mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              disabled={busy || attempted}
            />
          </label>
          <a
            className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4"
            href="https://bridge.simplefin.org/simplefin/create"
            target="_blank"
            rel="noopener noreferrer"
          >
            Create a SimpleFIN setup token
            <ArrowRight size={14} />
          </a>
          <label className="block text-sm">
            Setup token
            <Input
              className="mt-1 font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              maxLength={12000}
              required
              disabled={busy || attempted}
            />
          </label>
          {current && (
            <p className="text-xs text-muted-foreground">
              Review account mappings again after discovery. Reuse each existing
              book account to preserve its history and opening balances.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {attempted ? "Close and review status" : "Cancel"}
            </Button>
            <Button
              disabled={busy || attempted || !name.trim() || !token.trim()}
            >
              {busy ? "Connecting..." : "Connect securely"}
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
  onClose,
  onSaved,
}: {
  identity: FeedIdentity;
  accounts: AccountingWorkspace["accounts"];
  profiles: ManageData["profiles"];
  canonical: FeedCanonicalAccount[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [ownership, setOwnership] = useState<
      "company" | "personal" | "ignored"
    >(identity.ownership === "unreviewed" ? "company" : identity.ownership),
    [accountId, setAccountId] = useState(identity.account?.account_id ?? ""),
    [start, setStart] = useState(
      stampDate(
        identity.account?.history_start ??
          Math.floor(Date.now() / 1000) - 90 * 86400,
      ),
    ),
    [zone, setZone] = useState<"UTC" | "America/Phoenix">(
      identity.account?.posting_timezone ?? "America/Phoenix",
    ),
    [movement, setMovement] = useState<1 | -1>(
      identity.account?.movement_sign ?? 1,
    ),
    [balance, setBalance] = useState<1 | -1>(
      identity.account?.balance_sign ?? 1,
    ),
    [reason, setReason] = useState(""),
    [reviewed, setReviewed] = useState(false);
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
  function choose(id: string) {
    setAccountId(id);
    setReviewed(false);
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
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review {identity.name}</DialogTitle>
          <DialogDescription>
            Confirm ownership, the matching book account, and the source sign
            and date conventions against an original statement.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
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
              reason,
            });
          }}
        >
          <label className="block text-sm">
            Account ownership
            <select
              className={selectStyle}
              value={ownership}
              onChange={(e) => {
                setOwnership(e.target.value as typeof ownership);
                setReviewed(false);
              }}
            >
              <option value="company">Company account</option>
              <option value="personal">
                Personal, exclude from company books
              </option>
              <option value="ignored">Ignore this account</option>
            </select>
          </label>
          {ownership === "company" && (
            <>
              <label className="block text-sm">
                Book account
                <select
                  className={selectStyle}
                  value={accountId}
                  onChange={(e) => choose(e.target.value)}
                  required
                >
                  <option value="">
                    Choose an existing bank or card account
                  </option>
                  {banks.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              {existing && (
                <p className="rounded-lg bg-primary/5 p-3 text-xs">
                  This account has a saved feed identity. Its original history
                  settings and checkpoint will be reused.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  History begins
                  <Input
                    type="date"
                    className="mt-1"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      setReviewed(false);
                    }}
                    disabled={!!existing && !existing.can_edit_settings}
                    required
                  />
                </label>
                <label className="block text-sm">
                  Posting date timezone
                  <select
                    className={selectStyle}
                    value={zone}
                    onChange={(e) => {
                      setZone(e.target.value as typeof zone);
                      setReviewed(false);
                    }}
                    disabled={!!existing && !existing.can_edit_settings}
                  >
                    <option value="America/Phoenix">America/Phoenix</option>
                    <option value="UTC">UTC</option>
                  </select>
                </label>
              </div>
              <label className="block text-sm">
                Transaction sign
                <select
                  className={selectStyle}
                  value={movement}
                  onChange={(e) => {
                    setMovement(Number(e.target.value) as 1 | -1);
                    setReviewed(false);
                  }}
                  disabled={!!existing && !existing.can_edit_settings}
                >
                  <option value={1}>
                    Keep source sign: deposit/payment +, withdrawal/charge -
                  </option>
                  <option value={-1}>
                    Reverse source sign, supported by statement
                  </option>
                </select>
              </label>
              <label className="block text-sm">
                Balance sign
                <select
                  className={selectStyle}
                  value={balance}
                  onChange={(e) => {
                    setBalance(Number(e.target.value) as 1 | -1);
                    setReviewed(false);
                  }}
                  disabled={!!existing && !existing.can_edit_settings}
                >
                  <option value={1}>
                    Keep source sign: cash +, card debt -
                  </option>
                  <option value={-1}>
                    Reverse source balance, card debt shown positive
                  </option>
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                No opening balance is created from this connection. Longer
                history may need original CSV exports. Only USD accounts are
                supported.
              </p>
            </>
          )}
          <label className="block text-sm">
            Review note
            <Input
              className="mt-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              required
              placeholder="Statement and account ownership checked"
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I reviewed ownership
            {ownership === "company"
              ? ", the book account, posting dates, and signs."
              : "."}
          </label>
          {cmd.error && (
            <p role="alert" className="text-sm text-destructive">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={
                cmd.busy ||
                !reviewed ||
                !reason.trim() ||
                (ownership === "company" &&
                  (!accountId || identity.currency !== "USD"))
              }
            >
              Save reviewed mapping
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Disconnect {connection.name}</DialogTitle>
          <DialogDescription>
            Stop syncs and remove the stored access credential. Transactions,
            account mappings, and source evidence remain in your books. Revoke
            the token in SimpleFIN as well.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
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
          <label className="block text-sm">
            Reason
            <Input
              className="mt-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              required
            />
          </label>
          {cmd.error && (
            <p role="alert" className="text-sm text-destructive">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              type="button"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button disabled={cmd.busy || !reason.trim()}>Disconnect</Button>
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
    [reason, setReason] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue past unavailable bank history</DialogTitle>
          <DialogDescription>
            Use this only when the bank cannot return an older period. The
            skipped range remains a visible coverage gap for statement or
            historical import review.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
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
          <p className="text-sm">
            Current checkpoint:{" "}
            {stampDate(account.checkpoint ?? account.history_start)}
          </p>
          <label className="block text-sm">
            Continue from date
            <Input
              type="date"
              className="mt-1"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setReviewed(false);
              }}
              required
            />
          </label>
          <label className="block text-sm">
            Why this history is unavailable
            <Input
              className="mt-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={1000}
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I will verify this period with independent source evidence.
          </label>
          {cmd.error && (
            <p role="alert" className="text-sm text-destructive">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              type="button"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button disabled={cmd.busy || !reviewed || !date || !reason.trim()}>
              Record gap and continue
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
