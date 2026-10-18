"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileText, Plus, RefreshCw } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { PasswordInput } from "@/components/ui/inputs/PasswordInput";
import { Select } from "@/components/ui/inputs/Select";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Toggle } from "@/components/ui/inputs/Toggle";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import {
  LINE_TYPE_LABELS,
  SOURCE_STATUS_LABELS,
  SUGGESTION_REASONS,
  invoiceChipLabel,
  type InvoiceMatch,
  type InvoiceSource,
  type LineType,
  type ReceivablesView,
  type SourceInvoice,
  type SourceStatus,
} from "@/lib/accounting/receivables";
import { getAccountingDemoReceivables } from "@/lib/accounting/demo";
import type { BooksMetadata } from "./types";
import { AccountingPicker } from "./accounting-picker";
import { dateLabel, money, timestampLabel } from "./format";
import { useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";

const statusVariant: Record<SourceStatus, BadgeVariant> = {
  active: "success",
  paused: "default",
  auth_failed: "danger",
  disconnected: "default",
};
const LINE_TYPES: LineType[] = [
  "hourly",
  "fixed",
  "recurring",
  "reimbursement",
  "tax",
];
/** Accounts the books keep for themselves are never a revenue choice. */
const RESERVED = new Set([
  "uncategorized_income",
  "uncategorized_expense",
  "accounts_receivable",
  "unbilled_revenue",
  "deferred_revenue",
]);

async function postSource(body: object) {
  const response = await fetch("/api/accounting/invoice-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      result.error ?? "The invoice source request did not complete.",
    );
  return result;
}

/**
 * Manage, Invoice sources: the invoicing systems the books read invoices
 * from. Each one maps its line types to revenue accounts and its projects to
 * client contacts, so a deposit can be matched to the invoice it paid and the
 * accrual view knows where earned revenue goes.
 */
export function AccountingInvoiceSources({
  data,
  manage,
  demo,
  onRefresh,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
}) {
  const read = useAccountingRead<ReceivablesView>(
    { view: "receivables", status: "all", limit: "200" },
    { enabled: !demo },
  );
  const [demoView] = useState(() =>
    demo ? getAccountingDemoReceivables() : null,
  );
  const view = demo ? demoView : (read.data ?? null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<InvoiceSource | "new" | null>(null);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    fetch("/api/accounting/invoice-sources", {
      cache: "no-store",
      signal: abort.signal,
    })
      .then((r) =>
        r.ok ? (r.json() as Promise<{ ready: boolean }>) : { ready: false },
      )
      .then((c) => setReady(c.ready))
      .catch(() => undefined);
    return () => abort.abort();
  }, [demo]);
  async function refresh() {
    await read.reload();
    await onRefresh();
  }
  const sources = view?.sources ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Invoice sources</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Connect your invoicing app. A deposit that pays one of its invoices
            marks it paid there, and the accrual view can show what you earned
            before the money arrived.
          </p>
        </div>
        {sources.length === 0 && (
          <Button
            onClick={() => setEditing("new")}
            disabled={demo || ready === false}
          >
            <Plus aria-hidden="true" />
            Connect
          </Button>
        )}
      </div>
      {!demo && ready === false && (
        <p
          role="status"
          className="glass-card rounded-xl p-4 text-sm text-muted-foreground"
        >
          Invoice sources are off on this server. Set
          INVOICE_SOURCE_ENCRYPTION_KEY to turn them on.
        </p>
      )}
      {read.error && !demo && (
        <p role="alert" className="text-sm text-error">
          {read.error}
        </p>
      )}
      {view && sources.length === 0 && (
        <section className="glass-card flex items-start gap-3 rounded-xl p-5">
          <FileText
            size={18}
            aria-hidden="true"
            className="mt-0.5 text-muted-foreground"
          />
          <div className="text-sm text-muted-foreground">
            No invoicing app connected yet. You need its address and an API key
            that can read invoices and record payments.
          </div>
        </section>
      )}
      {view &&
        sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            invoices={view.invoices.filter((i) => i.source_id === source.id)}
            accrualStart={view.accrual_start}
            data={data}
            manage={manage}
            demo={demo}
            onEdit={() => setEditing(source)}
            onRefresh={refresh}
          />
        ))}
      {view && !demo && sources.length > 0 && (
        <BackfillReview accrualStart={view.accrual_start} onRefresh={refresh} />
      )}
      {editing && (
        <SourceDialog
          current={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function SourceCard({
  source,
  invoices,
  accrualStart,
  data,
  manage,
  demo,
  onEdit,
  onRefresh,
}: {
  source: InvoiceSource;
  invoices: SourceInvoice[];
  accrualStart: string | null;
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  onEdit: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [accounts, setAccounts] = useState(source.account_map);
  const [clients, setClients] = useState<Record<string, string>>(
    Object.fromEntries(
      source.projects
        .filter((p) => p.party_id)
        .map((p) => [p.project_ref, p.party_id!]),
    ),
  );
  const [autoLink, setAutoLink] = useState(source.auto_link);
  const [busy, setBusy] = useState<"save" | "sync" | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const flight = useRef(false);
  const retry = useAccountingCommand(onRefresh);
  const purposes = useMemo(
    () => new Map(manage.profiles.map((p) => [p.account_id, p.purpose])),
    [manage.profiles],
  );
  const accountOptions = (type: LineType) =>
    data.accounts
      .filter(
        (a) =>
          !a.is_archived &&
          !RESERVED.has(purposes.get(a.id) ?? "") &&
          (type === "tax"
            ? a.account_type === "liability"
            : a.account_type === "income" ||
              (type === "reimbursement" && a.account_type === "expense")),
      )
      .map((a) => ({
        value: a.id,
        label: a.code ? `${a.code} ${a.name}` : a.name,
        group:
          a.account_type === "income"
            ? "Income"
            : a.account_type === "liability"
              ? "Liability"
              : "Expense",
      }));
  const clientOptions = manage.parties
    .filter(
      (p) =>
        p.roles.includes("client") &&
        !p.is_archived &&
        p.review_status === "confirmed",
    )
    .map((p) => ({ value: p.id, label: p.name }));
  const failed = invoices.flatMap((invoice) =>
    invoice.links
      .filter((l) => l.sync_state === "failed")
      .map((link) => ({ invoice, link })),
  );
  const unmapped = source.projects.filter(
    (p) => !clients[p.project_ref],
  ).length;
  const dirty =
    JSON.stringify(accounts) !== JSON.stringify(source.account_map) ||
    JSON.stringify(clients) !==
      JSON.stringify(
        Object.fromEntries(
          source.projects
            .filter((p) => p.party_id)
            .map((p) => [p.project_ref, p.party_id]),
        ),
      ) ||
    autoLink !== source.auto_link;

  async function act(kind: "save" | "sync") {
    if (flight.current) return;
    flight.current = true;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      if (kind === "save")
        await postSource({
          action: "save",
          key: crypto.randomUUID(),
          source: {
            id: source.id,
            expected_version: source.version,
            account_map: accounts,
            party_map: clients,
            auto_link: autoLink,
          },
        });
      else {
        const result = await postSource({ action: "sync", id: source.id });
        const run = result.sources?.[0];
        if (run?.status === "error") throw new Error(run.error);
        setNotice(
          run?.linked
            ? `Synced. ${run.linked} deposit${run.linked === 1 ? "" : "s"} linked to invoices.`
            : "Synced.",
        );
      }
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request was interrupted.");
    } finally {
      setBusy(null);
      flight.current = false;
    }
  }

  return (
    <section
      className="glass-card space-y-5 rounded-xl p-5"
      aria-labelledby={`source-${source.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`source-${source.id}`} className="font-semibold">
              {source.name}
            </h3>
            <Badge variant={statusVariant[source.status]} dot>
              {SOURCE_STATUS_LABELS[source.status]}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {source.base_url}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {source.last_synced_at
              ? `Synced ${timestampLabel(source.last_synced_at)}`
              : "Not synced yet"}
            {" · "}
            {source.invoice_count} invoice
            {source.invoice_count === 1 ? "" : "s"}
            {source.pending_pushes > 0 &&
              ` · ${source.pending_pushes} waiting to send`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void act("sync")}
            loading={busy === "sync"}
            disabled={demo || busy !== null || source.status !== "active"}
          >
            <RefreshCw aria-hidden="true" />
            Sync now
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={demo}>
            Edit
          </Button>
        </div>
      </div>
      {source.last_error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle
            size={15}
            aria-hidden="true"
            className="mt-0.5 shrink-0"
          />
          {source.last_error}
        </p>
      )}
      {failed.length > 0 && (
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-sm font-medium">
            {failed.length} payment{failed.length === 1 ? "" : "s"} could not be
            sent
          </p>
          <ul className="space-y-2">
            {failed.map(({ invoice, link }) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">
                    {invoice.number || "Invoice"}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {money(link.amount_cents)} from {dateLabel(link.entry_date)}
                    . {link.last_error}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={demo || retry.busy}
                  onClick={() =>
                    void retry.execute({
                      type: "invoice.retry",
                      id: link.id,
                      expected_version: link.version,
                    })
                  }
                >
                  Retry
                </Button>
              </li>
            ))}
          </ul>
          {retry.error && (
            <p role="alert" className="text-sm text-error">
              {retry.error}
            </p>
          )}
        </div>
      )}

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void act("save");
        }}
      >
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Revenue accounts</legend>
          <p className="text-xs text-muted-foreground">
            Where each kind of invoice line counts as income (sales tax is owed,
            so it goes to a liability). Linking a deposit never changes how you
            categorized it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {LINE_TYPES.map((type) => (
              <AccountingPicker
                key={type}
                visibleLabel={LINE_TYPE_LABELS[type]}
                value={accounts[type] ?? ""}
                placeholder="Choose an account"
                options={accountOptions(type)}
                onChange={(value) =>
                  setAccounts((current) => ({ ...current, [type]: value }))
                }
                disabled={demo}
              />
            ))}
          </div>
        </fieldset>
        {source.projects.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              Clients
              {unmapped > 0 && (
                <span className="ml-2 text-xs font-normal text-warning">
                  {unmapped} not matched
                </span>
              )}
            </legend>
            <p className="text-xs text-muted-foreground">
              Which contact pays each project. Deposits from that contact are
              matched to its invoices.
            </p>
            <ul className="divide-y divide-border/60">
              {source.projects.map((project) => (
                <li
                  key={project.project_ref}
                  className="grid items-center gap-2 py-2 sm:grid-cols-[1fr_minmax(0,16rem)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {project.project_name || project.project_ref}
                    </p>
                    {project.customer_name && (
                      <p className="truncate text-xs text-muted-foreground">
                        Billed to {project.customer_name}
                      </p>
                    )}
                  </div>
                  <Select
                    ariaLabel={`Client for ${project.project_name || project.project_ref}`}
                    size="sm"
                    searchable
                    value={clients[project.project_ref] ?? ""}
                    placeholder="Choose a client"
                    options={clientOptions}
                    onChange={(value) =>
                      setClients((current) => ({
                        ...current,
                        [project.project_ref]: value,
                      }))
                    }
                    disabled={demo}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <Toggle
          checked={autoLink}
          onChange={setAutoLink}
          label="Link exact matches automatically"
          description="Same client and exact amount. You can unlink any of them."
          disabled={demo}
        />
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-success">
            {notice}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            disabled={demo || !dirty || busy !== null}
            loading={busy === "save"}
          >
            Save
          </Button>
        </div>
      </form>
      <AccrualStart
        accrualStart={accrualStart}
        manage={manage}
        demo={demo}
        onRefresh={onRefresh}
      />
    </section>
  );
}

/** The first month the accrual view covers. Before it, a single opening balance stands in for everything earlier. */
function AccrualStart({
  accrualStart,
  manage,
  demo,
  onRefresh,
}: {
  accrualStart: string | null;
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [value, setValue] = useState(accrualStart ?? "");
  const command = useAccountingCommand(onRefresh);
  const firstOfMonth = /^\d{4}-\d{2}-01$/.test(value);
  return (
    <Disclosure summary="Advanced" contentClassName="space-y-4">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void command.execute({
            type: "settings.save",
            id: crypto.randomUUID(),
            expected_version: manage.preferences?.version ?? 0,
            accrual_start: value,
          });
        }}
      >
        <DateInput
          label="Accrual view starts"
          description="The first of a month. Invoices and work before it count as one opening balance."
          value={value}
          onChange={(next) => setValue(next)}
          error={
            value && !firstOfMonth ? "Choose the first of a month." : undefined
          }
          disabled={demo}
        />
        {command.error && (
          <p role="alert" className="text-sm text-error">
            {command.error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            disabled={
              demo || command.busy || !firstOfMonth || value === accrualStart
            }
            loading={command.busy}
          >
            Save start
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

function SourceDialog({
  current,
  onClose,
  onSaved,
}: {
  current: InvoiceSource | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(current?.name ?? "Invoices"),
    [url, setUrl] = useState(current?.base_url ?? ""),
    [key, setKey] = useState(""),
    [status, setStatus] = useState<SourceStatus>(
      current?.status === "auth_failed"
        ? "active"
        : (current?.status ?? "active"),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [ids] = useState(() => ({
    key: crypto.randomUUID(),
    id: current?.id ?? crypto.randomUUID(),
  }));
  const flight = useRef(false);
  async function save() {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await postSource({
        action: "save",
        key: ids.key,
        source: {
          id: ids.id,
          expected_version: current?.version ?? 0,
          name: name.trim(),
          base_url: url.trim(),
          ...(key.trim() ? { api_key: key.trim() } : {}),
          ...(current && status !== current.status ? { status } : {}),
        },
      });
      setKey("");
      await onSaved();
    } catch (e) {
      setKey("");
      setError(
        e instanceof Error ? e.message : "The connection could not be saved.",
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
            {current ? "Edit invoice source" : "Connect invoices"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            The invoicing app's address and an API key that can read invoices
            and record payments.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextInput
            label="Address"
            placeholder="https://your-app.example.com"
            value={url}
            onChange={(next) => setUrl(next)}
            maxLength={500}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
          <PasswordInput
            label={current ? "New API key" : "API key"}
            description={
              current
                ? "Leave empty to keep the current key."
                : "Needs invoice read and payment access."
            }
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(next) => setKey(next)}
            maxLength={4000}
            required={!current}
            disabled={busy}
          />
          <Disclosure summary="Advanced" contentClassName="space-y-4">
            <TextInput
              label="Name"
              value={name}
              onChange={(next) => setName(next)}
              maxLength={120}
              required
              disabled={busy}
            />
            {current && (
              <Select
                label="Status"
                value={status}
                onChange={(v) => setStatus(v as SourceStatus)}
                options={[
                  { value: "active", label: "Connected" },
                  { value: "paused", label: "Paused (no syncing)" },
                  { value: "disconnected", label: "Disconnected" },
                ]}
                disabled={busy}
              />
            )}
          </Disclosure>
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
              Cancel
            </Button>
            <Button
              disabled={
                busy || !name.trim() || !url.trim() || (!current && !key.trim())
              }
              loading={busy}
            >
              {current ? "Save" : "Connect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Tells the invoicing app about links made here; the hourly sync catches anything this misses. */
function pushInvoices() {
  void fetch("/api/accounting/invoice-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "push" }),
  }).catch(() => undefined);
}

/**
 * Deposits from before the source was connected, back to the accrual start,
 * that look like invoice payments. The sync never links these on its own:
 * exact matches are confirmed here in one batch, the rest one by one.
 */
function BackfillReview({
  accrualStart,
  onRefresh,
}: {
  accrualStart: string | null;
  onRefresh: () => Promise<void>;
}) {
  const read = useAccountingRead<ReceivablesView>({
    view: "receivables",
    status: "open",
    limit: "1",
    matches: "true",
  });
  const command = useAccountingCommand(async () => {
    pushInvoices();
    await read.reload();
    await onRefresh();
  });
  const matches: InvoiceMatch[] = read.data?.matches ?? [];
  if (!matches.length) return null;
  const exact = matches.filter((m) => m.suggestion.auto);
  const others = matches.filter((m) => !m.suggestion.auto);
  return (
    <section
      className="glass-card space-y-4 rounded-xl p-5"
      aria-labelledby="backfill-review"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="backfill-review" className="font-semibold">
            Past deposits that look like invoice payments
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Since {accrualStart ? dateLabel(accrualStart) : "the accrual start"}
            , before the invoicing app was connected. Linking marks the invoice
            paid there and keeps the accrual view from counting the money twice.
            Your transactions do not change.
          </p>
        </div>
        {exact.length > 0 && (
          <Button
            disabled={command.busy}
            loading={command.busy}
            onClick={() =>
              void command.execute({
                type: "invoice.auto_link",
                id: crypto.randomUUID(),
                ...(accrualStart ? { from: accrualStart } : {}),
              })
            }
          >
            Link {exact.length} exact match{exact.length === 1 ? "" : "es"}
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border/60">
        {[...exact, ...others].map((m) => (
          <li
            key={m.entry_id}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5"
          >
            <div className="min-w-0 text-sm">
              <p className="truncate">
                <span className="font-medium">{money(m.amount_cents)}</span>{" "}
                <span className="text-muted-foreground">
                  · {dateLabel(m.entry_date)} · {m.payee_name ?? m.memo}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Looks like{" "}
                {invoiceChipLabel(m.suggestion.invoices.map((i) => i.number))} (
                {SUGGESTION_REASONS[m.suggestion.reason]}
                {m.suggestion.ambiguous ? ", the oldest of several" : ""})
              </p>
            </div>
            {!m.suggestion.auto && (
              <Button
                size="sm"
                variant="outline"
                disabled={command.busy}
                onClick={() =>
                  void command.execute({
                    type: "invoice.link",
                    id: crypto.randomUUID(),
                    entry_id: m.entry_id,
                    expected_version: m.version,
                    allocations: m.suggestion.invoices.map((i) => ({
                      invoice_id: i.invoice_id,
                      amount_cents: i.amount_cents,
                    })),
                  })
                }
              >
                Link
              </Button>
            )}
          </li>
        ))}
      </ul>
      {command.error && (
        <p role="alert" className="text-sm text-error">
          {command.error}
        </p>
      )}
    </section>
  );
}
