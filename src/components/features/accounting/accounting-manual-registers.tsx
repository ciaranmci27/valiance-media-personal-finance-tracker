"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, ArrowUpRight, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { SectionHeader } from "@/components/ui/section-header";
import { Tooltip } from "@/components/ui/tooltip";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { BooksMetadata } from "./types";
import {
  registerActionLabels,
  type RegisterKind,
  type RegisterView,
  type RegisterDetail,
  type RegisterAction,
  type RegisterMovement,
  type RegisterRow,
} from "@/lib/accounting/registers";
import { InvoiceDialog } from "./accounting-dialog";
import { dateLabel, money, timestampLabel, todayInBooks } from "./format";
import { accountingGet } from "./use-accounting-command";
import { AccountingRegisterForm } from "./accounting-register-form";
import { AccountingRegisterAction } from "./accounting-register-action";
export function AccountingManualRegisters({
  kind,
  accounts,
  manage,
  demo,
  onRefresh,
  onEntry,
}: {
  kind: RegisterKind;
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const today = todayInBooks(),
    params = useSearchParams(),
    linked = params.get("register");
  const [date, setDate] = useState(today),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0),
    [data, setData] = useState<RegisterView | null>(null),
    [record, setRecord] = useState<RegisterDetail | null>(null),
    [loading, setLoading] = useState(false),
    [opening, setOpening] = useState(false),
    [error, setError] = useState(""),
    [historyOffset, setHistoryOffset] = useState(0),
    [form, setForm] = useState<{ record?: RegisterDetail } | null>(null),
    [action, setAction] = useState<{
      kind: RegisterAction["kind"] | "void";
      movement?: RegisterMovement;
    } | null>(null);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      accountingGet<RegisterView>(
        { view: "registers", kind, date, query, offset: String(offset) },
        abort.signal,
      )
        .then(setData)
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 160);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [kind, date, query, offset, tick, demo]);
  useEffect(() => {
    if (!linked || demo) return;
    const abort = new AbortController();
    setOpening(true);
    accountingGet<RegisterDetail>(
      {
        view: "register-detail",
        id: linked,
        date,
        offset: String(historyOffset),
      },
      abort.signal,
    )
      .then((r) => {
        if (r.kind !== kind)
          throw new Error(
            "This link belongs to the other register. Choose Assets or Loans.",
          );
        setRecord(r);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setOpening(false);
      });
    return () => abort.abort();
  }, [linked, kind, date, historyOffset, tick, demo]);
  function open(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("register", id);
    window.history.pushState(null, "", url);
    setHistoryOffset(0);
  }
  function close() {
    const url = new URL(window.location.href);
    url.searchParams.delete("register");
    window.history.replaceState(null, "", url);
    setRecord(null);
    setHistoryOffset(0);
  }
  async function refresh() {
    await onRefresh();
    setTick((n) => n + 1);
  }
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const balanceLabel =
    kind === "asset" ? "Book value" : "Principal outstanding";
  const balance = (r: RegisterRow) =>
    kind === "asset" ? r.state.carrying_cents : r.state.principal_cents;
  const status = (r: RegisterRow) =>
    !r.state.initialized
      ? "Needs initial journal"
      : r.state.disposed
        ? "Disposed"
        : "";
  const columns: DataTableColumn<RegisterRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) => (
        <div className="min-w-0">
          <button
            type="button"
            className="text-left font-medium hover:text-teal-light"
            onClick={(e) => {
              e.stopPropagation();
              open(r.id);
            }}
          >
            {r.body.name}
          </button>
          <p className="mt-1 text-xs text-muted-foreground">
            {names.get(r.body.account_id)} · {dateLabel(r.body.started_on)}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) =>
        status(r) ? (
          <Badge variant={r.state.initialized ? "default" : "warning"}>
            {status(r)}
          </Badge>
        ) : null,
    },
    {
      key: "balance",
      header: balanceLabel,
      align: "right",
      numeric: true,
      render: (r) => <MaskedValue value={money(balance(r))} />,
    },
  ];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">
            {kind === "asset" ? "Assets" : "Loans"}
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {kind === "asset"
              ? "Keep purchases, book depreciation and disposals connected to their source schedules."
              : "Track principal, lender statements and the actual split of each payment."}
          </p>
        </div>
        <Button disabled={demo} onClick={() => setForm({})}>
          <Plus size={16} aria-hidden="true" />
          New {kind}
        </Button>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Balances as of"
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="min-w-48 flex-1">
          <Input
            label={`Find ${kind === "asset" ? "an asset" : "a loan"}`}
            placeholder="Search by name"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <Tooltip content="Refresh registers">
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh registers"
            disabled={loading}
            onClick={() => setTick((n) => n + 1)}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {(error || opening) && (
        <p
          role={error ? "alert" : "status"}
          className={`text-sm ${error ? "text-error" : "text-muted-foreground"}`}
        >
          {error || "Opening register..."}
        </p>
      )}
      <DataTable
        columns={columns}
        data={data?.rows ?? []}
        keyExtractor={(r) => r.id}
        onRowClick={(r) => open(r.id)}
        busy={loading}
        emptyState={
          loading
            ? "Loading registers..."
            : demo
              ? "Registers are available in your owner books."
              : `No ${kind === "asset" ? "assets" : "loans"} in this view. Create a register to connect its entries and evidence.`
        }
        mobileCard={(r) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              open(r.id);
            }}
            className="glass-card glass-card-interactive flex w-full flex-wrap items-center justify-between gap-4 rounded-xl p-5 text-left hover:border-primary/30"
          >
            <div>
              <p className="font-medium">{r.body.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {names.get(r.body.account_id)} · {dateLabel(r.body.started_on)}
                {status(r) ? ` · ${status(r)}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="mb-1 text-xs text-muted-foreground">
                  {balanceLabel}
                </p>
                <MaskedValue
                  value={money(balance(r))}
                  className="tabular-nums"
                />
              </div>
              <ArrowUpRight
                size={16}
                className="text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          </button>
        )}
        after={
          data ? (
            <Pagination
              offset={offset}
              limit={50}
              total={data.count}
              onChange={setOffset}
              noun="records"
            />
          ) : null
        }
      />
      {record && (
        <InvoiceDialog
          title={record.record.body.name}
          description={`${kind === "asset" ? "Asset" : "Loan"} register · balances as of ${dateLabel(date)}`}
          onClose={close}
          busy={opening}
        >
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setForm({ record })}>
                Edit details
              </Button>
              {(kind === "asset"
                ? !record.state.initialized
                  ? ["acquisition"]
                  : record.state.disposed
                    ? []
                    : ["depreciation", "disposal"]
                : ["draw", "payment"]
              ).map((k) => (
                <Button
                  key={k}
                  variant="outline"
                  onClick={() =>
                    setAction({ kind: k as RegisterAction["kind"] })
                  }
                >
                  {registerActionLabels[k as RegisterAction["kind"]]}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4 border-y border-border py-4 sm:grid-cols-3">
              {(kind === "asset"
                ? [
                    ["Recorded cost", record.state.cost_cents],
                    [
                      "Accumulated depreciation",
                      record.state.depreciation_cents,
                    ],
                    ["Book value", record.state.carrying_cents],
                  ]
                : [
                    [
                      "Original schedule principal",
                      record.record.body.initial_cents,
                    ],
                    ["Principal outstanding", record.state.principal_cents],
                  ]
              ).map(([label, value]) => (
                <div key={label}>
                  <p className="mb-2 text-xs text-muted-foreground">{label}</p>
                  <MaskedValue value={money(value)} className="tabular-nums" />
                </div>
              ))}
            </div>
            <div className="space-y-2 text-sm">
              <p>{names.get(record.record.body.account_id)}</p>
              <p className="text-muted-foreground">
                {"method" in record.record.body
                  ? record.record.body.method
                  : record.record.body.lender}
              </p>
              {record.record.body.terms && (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {record.record.body.terms}
                </p>
              )}
              {record.record.document_id && (
                <a
                  className="inline-block text-teal-light hover:underline"
                  href={`/api/accounting/documents?id=${record.record.document_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open register source schedule
                </a>
              )}
            </div>
            <section className="space-y-3">
              <SectionHeader
                label="Entries and evidence"
                count={record.movement_count}
              />
              {record.movements.map((m) => (
                <div
                  key={m.id}
                  className="space-y-3 rounded-xl border border-border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-sm font-medium"
                        onClick={() => onEntry(m.entry_id)}
                      >
                        {registerActionLabels[m.kind].replace("Record ", "")} ·{" "}
                        {dateLabel(m.effective_date)}
                      </Button>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {m.mode === "historical"
                          ? "Linked existing transaction"
                          : "Posted from this register"}
                        {m.void
                          ? ` · ${m.mode === "historical" ? "Unlinked" : "Reversed"} ${dateLabel(m.void.effective_date)}`
                          : ""}
                      </p>
                    </div>
                    {!m.void && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAction({ kind: "void", movement: m })}
                      >
                        {m.mode === "historical" ? "Unlink" : "Reverse"}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {m.reason}
                  </p>
                  <details>
                    <summary className="cursor-pointer text-xs text-teal-light">
                      Journal amounts
                    </summary>
                    <div className="mt-2 space-y-2">
                      {m.lines.map((l) => (
                        <div
                          key={l.account_id}
                          className="flex justify-between gap-3 text-xs"
                        >
                          <span>{names.get(l.account_id)}</span>
                          <MaskedValue
                            value={money(l.amount_cents)}
                            className="tabular-nums"
                          />
                        </div>
                      ))}
                    </div>
                  </details>
                  <a
                    className="inline-block text-xs text-teal-light hover:underline"
                    href={`/api/accounting/documents?id=${m.document_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Supporting document
                  </a>
                  {m.void && (
                    <p className="text-xs text-muted-foreground">
                      {m.void.reason}
                    </p>
                  )}
                </div>
              ))}
              {!record.movement_count && (
                <p className="text-sm text-muted-foreground">
                  No journal is linked yet. Record the{" "}
                  {kind === "asset" ? "acquisition" : "loan proceeds"} or link
                  the original transaction.
                </p>
              )}
            </section>
            <details className="rounded-xl border border-border p-4">
              <summary className="cursor-pointer text-sm">
                Register revision history ({record.revision_count})
              </summary>
              <div className="mt-3 space-y-3">
                {record.revisions.map((v) => (
                  <div
                    key={v.revision}
                    className="border-t border-border pt-3 text-xs"
                  >
                    <p>
                      Revision {v.revision} · {timestampLabel(v.created_at)}
                    </p>
                    <p className="mt-1 text-muted-foreground">{v.reason}</p>
                    <p className="mt-1 text-muted-foreground">
                      {v.body.name} · original amount{" "}
                      <MaskedValue
                        value={money(v.body.initial_cents)}
                        className="tabular-nums"
                      />
                    </p>
                    {v.document_id && (
                      <a
                        className="mt-1 inline-block text-teal-light hover:underline"
                        href={`/api/accounting/documents?id=${v.document_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Original evidence
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </details>
            <Pagination
              offset={historyOffset}
              limit={50}
              total={Math.max(record.movement_count, record.revision_count)}
              onChange={setHistoryOffset}
            />
          </div>
        </InvoiceDialog>
      )}
      {form && (
        <AccountingRegisterForm
          kind={kind}
          record={form.record}
          accounts={accounts}
          manage={manage}
          today={today}
          onSaved={refresh}
          onClose={() => setForm(null)}
          onOpen={open}
        />
      )}
      {record && action && (
        <AccountingRegisterAction
          record={record}
          kind={action.kind}
          movement={action.movement}
          accounts={accounts}
          manage={manage}
          today={today}
          onSaved={refresh}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}
