"use client";
import { useEffect, useState, useDeferredValue } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Unlink,
  FileCheck2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { formatCents, parseUsd, centsToDecimal } from "@/lib/accounting/money";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { ReconciliationView, Statement } from "@/lib/accounting/close";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { AccountLifecycle } from "./accounting-account-lifecycle";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { StatementCsvImport } from "./accounting-statement-import";
import type { StatementSources } from "@/lib/accounting/statement-files";

const selectStyle =
  "h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
function Money({ value }: { value: string }) {
  return (
    <MaskedValue
      value={formatCents(value)}
      className="font-mono tabular-nums"
    />
  );
}

export function AccountingReconciliation({
  account,
  onBack,
  onEntry,
  onRefresh,
}: {
  account: AccountingAccount;
  onBack: () => void;
  onEntry: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(""),
    [data, setData] = useState<ReconciliationView | null>(null),
    [page, setPage] = useState(0),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0);
  const [create, setCreate] = useState(false),
    [amend, setAmend] = useState(false),
    [csv, setCsv] = useState(false),
    [item, setItem] = useState(false),
    [opening, setOpening] = useState(false),
    [match, setMatch] = useState<ReconciliationView["items"][number] | null>(
      null,
    ),
    [confirm, setConfirm] = useState<"complete" | "cancel" | "reopen" | null>(
      null,
    ),
    [reason, setReason] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [lifecycle, setLifecycle] = useState(false);
  const refresh = async () => {
    setTick((t) => t + 1);
    await onRefresh();
  };
  const command = useAccountingCommand(refresh);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    accountingGet<ReconciliationView>(
      {
        view: "reconciliation",
        account: account.id,
        ...(selected ? { id: selected } : {}),
        offset: String(page * 100),
        query: deferredQuery,
      },
      abort.signal,
    )
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [account.id, selected, page, deferredQuery, tick]);
  const r = data?.statement,
    p = data?.proof,
    editable = r?.status === "in_progress";
  const prior =
    data?.proof?.outstanding.filter(
      (l) => l.entry_date < (r?.from_date ?? ""),
    ) ?? [];
  function choose(id: string) {
    setSelected(id);
    setPage(0);
    setQuery("");
    setData(null);
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={15} />
            All accounts
          </Button>
          <h2 className="mt-3 text-xl font-semibold">
            Reconcile {account.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tie each statement item to the books. Progress is saved after every
            action.
          </p>
        </div>
        <Button onClick={() => setCreate(true)}>
          <Plus size={15} />
          New statement
        </Button>
      </div>
      {(error || command.error) && (
        <div
          role="alert"
          className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error"
        >
          {error || command.error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTick((t) => t + 1)}
          >
            Refresh
          </Button>
        </div>
      )}
      <Button variant="outline" size="sm" onClick={() => setLifecycle(true)}>
        Account opening and closure dates
      </Button>
      {!selected && (
        <section className="glass-card overflow-hidden">
          <div className="border-b border-border p-5 font-medium">
            Statement history
          </div>
          {!data ? (
            <p className="p-6 text-sm text-muted-foreground">
              Loading statements…
            </p>
          ) : !data.statements.length ? (
            <div className="p-8 text-center">
              <FileCheck2 className="mx-auto mb-3 text-muted-foreground" />
              <p className="font-medium">Start with a bank or card statement</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Keep the original file, enter its control totals, then match the
                actual movements.
              </p>
            </div>
          ) : (
            data.statements.map((s) => (
              <button
                key={s.id}
                onClick={() => choose(s.id)}
                className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 text-left last:border-0 hover:bg-secondary/30"
              >
                <div>
                  <p className="font-medium">
                    {s.from_date} to {s.to_date}
                  </p>
                  <p className="mt-1 text-xs capitalize text-muted-foreground">
                    {s.status.replace("_", " ")} · {s.declared_count} items
                  </p>
                </div>
                <Money value={s.ending_cents} />
              </button>
            ))
          )}
        </section>
      )}
      {selected && !r && !error && (
        <p className="text-sm text-muted-foreground">Loading statement…</p>
      )}
      {r && p && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={() => choose("")}>
              <ArrowLeft size={14} />
              Statement history
            </Button>
            <span className="rounded-full border border-border px-3 py-1 text-xs capitalize">
              {r.status.replace("_", " ")}
            </span>
          </div>
          <section className="glass-card p-5">
            <div className="flex flex-wrap justify-between gap-4">
              <div>
                <h3 className="font-semibold">
                  {r.from_date} to {r.to_date}
                </h3>
                <a
                  className="mt-2 inline-block text-sm text-teal-light"
                  href={`/api/accounting/documents?id=${r.document_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open statement file
                </a>
              </div>
              <div className="text-right text-sm">
                <p className="text-muted-foreground">
                  Statement ending balance
                </p>
                <p className="mt-1 text-xl">
                  <Money value={r.ending_cents} />
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {[
                ["Opening difference", p.opening_difference_cents],
                ["Statement difference", p.statement_difference_cents],
                ["Books less outstanding", p.bridge_difference_cents],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-secondary/40 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p
                    className={`mt-2 text-lg ${value === "0" ? "text-teal-light" : ""}`}
                  >
                    {value === null ? (
                      "Predecessor needs review"
                    ) : (
                      <Money value={value} />
                    )}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span>
                Items entered: {p.item_count} / {r.declared_count}
              </span>
              <span>Unmatched items: {p.unmatched_items}</span>
              <span>
                Increases: <Money value={p.debits_cents} /> /{" "}
                <Money value={r.declared_debits_cents} />
              </span>
              <span>
                Decreases: <Money value={p.credits_cents} /> /{" "}
                <Money value={r.declared_credits_cents} />
              </span>
            </div>
            {editable && (
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAmend(true)}
                >
                  Edit statement details
                </Button>
                {!r.predecessor_id && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpening(true)}
                  >
                    Review opening items
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!p.ready || command.busy || loading}
                  onClick={() => {
                    setReason("");
                    setConfirm("complete");
                  }}
                >
                  <Check size={14} />
                  Complete reconciliation
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReason("");
                    setConfirm("cancel");
                  }}
                >
                  Cancel unfinished statement
                </Button>
              </div>
            )}
            {r.status === "completed" && (
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                onClick={() => {
                  setReason("");
                  setConfirm("reopen");
                }}
              >
                Reopen statement
              </Button>
            )}
            {r.status === "superseded" && (
              <p className="mt-4 text-sm text-warning">
                The saved proof is retained. Create a replacement statement and
                review its matches against the current books.
              </p>
            )}
          </section>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="glass-card overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-border p-5">
                <h3 className="font-semibold">Statement items</h3>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCsv(true)}
                    >
                      Import CSV
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={data.next_ordinal === null}
                      onClick={() => setItem(true)}
                    >
                      <Plus size={14} />
                      Add item
                    </Button>
                  </div>
                )}
              </div>
              {!data.items.length ? (
                <p className="p-5 text-sm text-muted-foreground">
                  Enter the movements shown on the statement. Equal missing
                  deposits and withdrawals still need to be entered.
                </p>
              ) : (
                data.items.map((i) => (
                  <div
                    key={i.id}
                    className="border-b border-border p-4 last:border-0"
                  >
                    <div className="flex justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{i.description}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {i.entry_date} · Item {i.ordinal + 1}
                        </p>
                      </div>
                      <div className="text-right text-sm">
                        <Money value={i.amount_cents} />
                        <p className="mt-1 text-xs text-muted-foreground">
                          {i.remaining_cents === "0"
                            ? "Fully matched"
                            : `${formatCents(i.remaining_cents)} remaining`}
                        </p>
                      </div>
                    </div>
                    {i.allocations.map((a) => (
                      <div
                        key={a.id}
                        className="mt-3 flex items-center gap-2 rounded-lg bg-secondary/30 px-3 py-2 text-xs"
                      >
                        <button
                          className="min-w-0 flex-1 truncate text-left hover:underline"
                          onClick={() => onEntry(a.entry_id)}
                        >
                          {a.memo}
                        </button>
                        <Money value={a.amount_cents} />
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove match for ${i.description}`}
                            disabled={command.busy}
                            onClick={() =>
                              void command.execute({
                                type: "reconciliation.unmatch",
                                id: r.id,
                                expected_version: r.version,
                                allocation_id: a.id,
                              })
                            }
                          >
                            <Unlink size={13} />
                          </Button>
                        )}
                      </div>
                    ))}
                    {editable && (
                      <div className="mt-3 flex gap-2">
                        {i.remaining_cents !== "0" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setMatch(i)}
                          >
                            Match a transaction
                          </Button>
                        )}
                        {!i.allocations.length && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={command.busy}
                            onClick={() =>
                              void command.execute({
                                type: "reconciliation.item.remove",
                                id: r.id,
                                expected_version: r.version,
                                item_id: i.id,
                              })
                            }
                          >
                            Remove item
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </section>
            <section className="glass-card overflow-hidden">
              <div className="border-b border-border p-5">
                <h3 className="font-semibold">Posted transactions</h3>
                <div className="relative mt-3">
                  <Search
                    size={15}
                    className="absolute left-3 top-3 text-muted-foreground"
                  />
                  <Input
                    aria-label="Search posted transactions"
                    className="pl-9"
                    placeholder="Search memo or date"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                  />
                </div>
              </div>
              {data.lines.map((l) => (
                <button
                  key={l.id}
                  className="flex w-full justify-between gap-4 border-b border-border p-4 text-left text-sm last:border-0 hover:bg-secondary/30"
                  onClick={() => onEntry(l.entry_id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{l.memo}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {l.entry_date} ·{" "}
                      {l.available_cents === "0"
                        ? "Allocated"
                        : `${formatCents(l.available_cents)} available`}
                    </span>
                  </span>
                  <Money value={l.amount_cents} />
                </button>
              ))}
              {!data.lines.length && (
                <p className="p-5 text-sm text-muted-foreground">
                  No posted transactions in this scope.
                </p>
              )}
            </section>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page + 1} · {data.item_count} statement items ·{" "}
              {data.line_count} posted lines
            </span>
            <div className="flex gap-2">
              <Button
                size="icon"
                variant="outline"
                aria-label="Previous reconciliation page"
                disabled={!page || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft size={15} />
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label="Next reconciliation page"
                disabled={
                  (page + 1) * 100 >=
                    Math.max(data.item_count, data.line_count) || loading
                }
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight size={15} />
              </Button>
            </div>
          </div>
          <details className="glass-card p-5">
            <summary className="cursor-pointer font-medium">
              Outstanding items at statement end ({p.outstanding.length})
            </summary>
            <p className="mt-3 text-sm text-muted-foreground">
              Book balance <Money value={p.book_balance_cents} /> less uncleared
              movements <Money value={p.outstanding_cents} /> must equal the
              statement ending balance.
            </p>
            <div className="mt-4 max-h-80 overflow-y-auto">
              {p.outstanding.map((l) => (
                <button
                  key={l.line_id}
                  className="flex w-full justify-between gap-4 border-t border-border py-3 text-left text-sm"
                  onClick={() => onEntry(l.entry_id)}
                >
                  <span>
                    {l.entry_date} · {l.memo}
                  </span>
                  <Money value={l.outstanding_cents} />
                </button>
              ))}
            </div>
          </details>
          <StatementSourceHistory key={`${r.id}-${r.version}`} id={r.id} />
        </>
      )}
      {create && (
        <StatementCreate
          account={account}
          statements={data?.statements ?? []}
          onClose={() => setCreate(false)}
          onSaved={async (id) => {
            setCreate(false);
            choose(id);
            await refresh();
          }}
        />
      )}
      {amend && r && (
        <StatementCreate
          account={account}
          statements={data?.statements ?? []}
          existing={r}
          onClose={() => setAmend(false)}
          onSaved={async () => {
            setAmend(false);
            await refresh();
          }}
        />
      )}
      {csv && r && (
        <StatementCsvImport
          statement={r}
          onClose={() => {
            setCsv(false);
            void refresh().catch((e) => setError(e.message));
          }}
          onSaved={refresh}
        />
      )}
      {lifecycle && (
        <AccountLifecycle
          account={account}
          onClose={() => setLifecycle(false)}
          onSaved={async () => {
            setLifecycle(false);
            await refresh();
          }}
        />
      )}
      {item && r && data && (
        <StatementItemForm
          statement={r}
          ordinal={data.next_ordinal ?? 0}
          onClose={() => setItem(false)}
          onSaved={async () => {
            setItem(false);
            await refresh();
          }}
        />
      )}
      {match && r && data && (
        <MatchItem
          account={account}
          statement={r}
          item={match}
          onClose={() => setMatch(null)}
          onSaved={async () => {
            setMatch(null);
            await refresh();
          }}
        />
      )}
      {opening && r && data && (
        <OpeningReview
          statement={r}
          revision={data.revision}
          book={data.opening_book_cents}
          prior={prior}
          onClose={() => setOpening(false)}
          onSaved={async () => {
            setOpening(false);
            await refresh();
          }}
        />
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !command.busy) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "complete"
                ? "Complete this reconciliation?"
                : confirm === "reopen"
                  ? "Reopen this statement?"
                  : "Cancel this unfinished statement?"}
            </DialogTitle>
            <DialogDescription>
              {confirm === "complete"
                ? "Save the exact statement items, matches, and independent balance proof. This does not lock a calendar month."
                : confirm === "reopen"
                  ? "The original proof stays in history. Later completed statements on this account also need review. Reopen affected month closes first."
                  : "Keep the unfinished record and its evidence. A new statement can then use this date range."}
            </DialogDescription>
          </DialogHeader>
          {confirm !== "complete" && (
            <Input
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
            />
          )}
          <ErrorText value={command.error} />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={command.busy}
              onClick={() => setConfirm(null)}
            >
              Back
            </Button>
            <Button
              disabled={
                command.busy || (confirm !== "complete" && !reason.trim())
              }
              loading={command.busy}
              onClick={async () => {
                if (!r || !confirm) return;
                const c: WorkflowCommand =
                  confirm === "complete"
                    ? {
                        type: "reconciliation.complete",
                        id: r.id,
                        expected_version: r.version,
                      }
                    : {
                        type:
                          confirm === "reopen"
                            ? "reconciliation.reopen"
                            : "reconciliation.cancel",
                        id: r.id,
                        expected_version: r.version,
                        reason,
                      };
                if (await command.execute(c)) setConfirm(null);
              }}
            >
              Confirm {confirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ErrorText({ value }: { value: string }) {
  return value ? (
    <p role="alert" className="text-sm text-error">
      {value}
    </p>
  ) : null;
}
function StatementCreate({
  account,
  statements,
  existing,
  onClose,
  onSaved,
}: {
  account: AccountingAccount;
  statements: Statement[];
  existing?: Statement;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [id] = useState(() => existing?.id ?? crypto.randomUUID()),
    [from, setFrom] = useState(existing?.from_date ?? ""),
    [to, setTo] = useState(existing?.to_date ?? ""),
    [opening, setOpening] = useState(
      existing ? centsToDecimal(existing.opening_cents) : "0.00",
    ),
    [ending, setEnding] = useState(
      existing ? centsToDecimal(existing.ending_cents) : "",
    ),
    [debits, setDebits] = useState(
      existing ? centsToDecimal(existing.declared_debits_cents) : "",
    ),
    [credits, setCredits] = useState(
      existing ? centsToDecimal(existing.declared_credits_cents) : "",
    ),
    [count, setCount] = useState(
      existing ? String(existing.declared_count) : "",
    ),
    [doc, setDoc] = useState(existing?.document_id ?? ""),
    [notes, setNotes] = useState(existing?.notes ?? ""),
    [reason, setReason] = useState("");
  const cmd = useAccountingCommand(),
    last = existing
      ? statements.find((s) => s.id === existing.predecessor_id)
      : statements
          .filter((s) => s.status === "completed")
          .sort((a, b) => b.to_date.localeCompare(a.to_date))[0];
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit statement details" : "New statement"} ·{" "}
            {account.name}
          </DialogTitle>
          <DialogDescription>
            Copy the dates and totals from your statement. Use signed book
            balances: cash is normally positive, card amounts owed are negative.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const details = {
                id,
                from,
                to,
                opening_cents: parseUsd(opening).toString(),
                ending_cents: parseUsd(ending).toString(),
                declared_count: Number(count),
                declared_debits_cents: parseUsd(debits).toString(),
                declared_credits_cents: parseUsd(credits).toString(),
                document_id: doc,
                predecessor_id: existing
                  ? existing.predecessor_id
                  : (last?.id ?? null),
              };
              const r = await cmd.execute(
                existing
                  ? {
                      ...details,
                      type: "statement.amend",
                      expected_version: existing.version,
                      notes,
                      reason,
                    }
                  : {
                      ...details,
                      type: "reconciliation.create",
                      account_id: account.id,
                    },
              );
              if (r) await onSaved(r.id);
            } catch (e) {
              cmd.setError(
                e instanceof Error ? e.message : "Check the statement amounts.",
              );
            }
          }}
        >
          {last && (
            <p className="rounded-lg bg-secondary/40 p-3 text-sm">
              Previous statement ended {last.to_date} at{" "}
              {formatCents(last.ending_cents)}. Continue with the next day and
              the same opening balance.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Statement starts"
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              label="Statement ends"
              type="date"
              min={from}
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Input
              label="Signed opening balance"
              required
              inputMode="decimal"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
            />
            <Input
              label="Signed ending balance"
              required
              inputMode="decimal"
              value={ending}
              onChange={(e) => setEnding(e.target.value)}
            />
            <Input
              label="Total increases / debits"
              required
              inputMode="decimal"
              placeholder="0.00"
              value={debits}
              onChange={(e) => setDebits(e.target.value)}
            />
            <Input
              label="Total decreases / credits"
              required
              inputMode="decimal"
              placeholder="0.00"
              value={credits}
              onChange={(e) => setCredits(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Bank deposits and card payments are increases. Bank withdrawals and
            card charges are decreases. Enter both control totals as positive
            numbers, including zero.
          </p>
          <Input
            label="Number of statement movements"
            type="number"
            min={0}
            max={50000}
            required
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
          <AccountingDocumentPicker
            value={doc}
            onChange={setDoc}
            label="Original statement"
          />
          {existing && (
            <>
              <Input
                label="Statement notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={3000}
              />
              <p className="text-xs text-muted-foreground">
                The previous details and original file remain in history.
                Changing the opening balance or start date clears the
                opening-item review.
              </p>
              <Input
                label="Reason for this correction"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </>
          )}
          <ErrorText value={cmd.error} />
          <Button
            type="submit"
            className="w-full"
            disabled={cmd.busy || !doc}
            loading={cmd.busy}
          >
            {existing ? "Save statement details" : "Create statement"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function StatementSourceHistory({ id }: { id: string }) {
  const [data, setData] = useState<StatementSources | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    accountingGet<StatementSources>(
      { view: "statement-sources", statement: id },
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [id]);
  return (
    <details className="glass-card p-5">
      <summary className="cursor-pointer font-medium">
        Source files and statement changes
        {data ? ` (${data.files.length + data.amendments.length})` : ""}
      </summary>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      {data && (
        <div className="mt-3 space-y-3 text-sm">
          {!data.files.length && !data.amendments.length && (
            <p className="text-muted-foreground">
              No CSV imports or header changes recorded.
            </p>
          )}
          {data.files.map((f) => (
            <div key={f.id} className="border-t border-border pt-3">
              <a
                className="text-teal-light hover:underline"
                href={`/api/accounting/documents?id=${f.document_id}`}
                target="_blank"
                rel="noreferrer"
              >
                {f.original_name}
              </a>
              <p className="mt-1 text-xs text-muted-foreground">
                {f.rows} source items ·{" "}
                {new Date(f.created_at).toLocaleString()}
              </p>
            </div>
          ))}
          {data.amendments.map((a) => (
            <div key={a.id} className="border-t border-border pt-3">
              <p>{a.reason}</p>
              <dl className="mt-2 space-y-1 text-xs">
                {Object.entries({
                  from_date: "Starts",
                  to_date: "Ends",
                  opening_cents: "Opening",
                  ending_cents: "Ending",
                  declared_count: "Movements",
                  declared_debits_cents: "Increases",
                  declared_credits_cents: "Decreases",
                  notes: "Notes",
                })
                  .filter(([key]) => a.before_value[key] !== a.after_value[key])
                  .map(([key, label]) => (
                    <div key={key} className="flex flex-wrap gap-x-2">
                      <dt className="text-muted-foreground">{label}:</dt>
                      <dd>
                        <MaskedValue
                          value={
                            key.endsWith("_cents")
                              ? formatCents(String(a.before_value[key]))
                              : String(a.before_value[key] ?? "")
                          }
                        />{" "}
                        →{" "}
                        <MaskedValue
                          value={
                            key.endsWith("_cents")
                              ? formatCents(String(a.after_value[key]))
                              : String(a.after_value[key] ?? "")
                          }
                        />
                      </dd>
                    </div>
                  ))}
              </dl>
              <p className="mt-1 text-xs text-muted-foreground">
                Statement details amended ·{" "}
                {new Date(a.created_at).toLocaleString()}
              </p>
              <a
                className="mt-1 inline-block text-xs text-teal-light"
                href={`/api/accounting/documents?id=${a.previous_document_id}`}
                target="_blank"
                rel="noreferrer"
              >
                Previous supporting file
              </a>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
function StatementItemForm({
  statement: r,
  ordinal,
  onClose,
  onSaved,
}: {
  statement: Statement;
  ordinal: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [date, setDate] = useState(r.from_date),
    [description, setDescription] = useState(""),
    [amount, setAmount] = useState(""),
    [direction, setDirection] = useState("increase");
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add statement item {ordinal + 1}</DialogTitle>
          <DialogDescription>
            Enter one movement exactly as it appears on the statement.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const cents = parseUsd(amount);
              if (cents <= BigInt(0))
                throw new Error("Enter a positive movement amount.");
              await cmd.execute({
                type: "reconciliation.items",
                id: r.id,
                expected_version: r.version,
                items: [
                  {
                    id,
                    ordinal,
                    entry_date: date,
                    description,
                    amount_cents: (direction === "increase"
                      ? cents
                      : -cents
                    ).toString(),
                  },
                ],
              });
            } catch (e) {
              cmd.setError(e instanceof Error ? e.message : "Check this item.");
            }
          }}
        >
          <Input
            label="Statement date"
            type="date"
            min={r.from_date}
            max={r.to_date}
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Input
            label="Description"
            required
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="block text-sm">
            Movement
            <select
              className={`${selectStyle} mt-1`}
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="increase">
                Increase: deposit, refund, or card payment
              </option>
              <option value="decrease">
                Decrease: withdrawal or card charge
              </option>
            </select>
          </label>
          <Input
            label="Amount"
            required
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <ErrorText value={cmd.error} />
          <Button type="submit" disabled={cmd.busy} loading={cmd.busy}>
            Save statement item
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function MatchItem({
  account,
  statement: r,
  item,
  onClose,
  onSaved,
}: {
  account: AccountingAccount;
  statement: Statement;
  item: ReconciliationView["items"][number];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [data, setData] = useState<ReconciliationView | null>(null),
    [line, setLine] = useState(""),
    [amount, setAmount] = useState(
      centsToDecimal(
        BigInt(item.remaining_cents) < BigInt(0)
          ? -BigInt(item.remaining_cents)
          : BigInt(item.remaining_cents),
      ),
    ),
    [readError, setReadError] = useState("");
  const cmd = useAccountingCommand(onSaved),
    deferred = useDeferredValue(query);
  useEffect(() => {
    const abort = new AbortController();
    accountingGet<ReconciliationView>(
      {
        view: "reconciliation",
        id: r.id,
        account: account.id,
        offset: String(page * 100),
        query: deferred,
      },
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setReadError(e.message);
      });
    return () => abort.abort();
  }, [r.id, account.id, page, deferred]);
  const candidates =
    data?.lines.filter(
      (l) =>
        l.entry_date <= item.entry_date &&
        BigInt(l.available_cents) !== BigInt(0) &&
        BigInt(l.available_cents) > BigInt(0) ===
          BigInt(item.remaining_cents) > BigInt(0),
    ) ?? [];
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Match {item.description}</DialogTitle>
          <DialogDescription>
            {item.entry_date} · {formatCents(item.remaining_cents)} remains.
            Match all or part of a posted transaction on {account.name}.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Find a matching transaction"
          placeholder="Search memo or exact date"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
            setLine("");
          }}
        />
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {candidates.map((l) => (
            <label
              key={l.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${line === l.id ? "border-teal-light bg-teal-light/5" : "border-border"}`}
            >
              <input
                type="radio"
                name="matched-line"
                value={l.id}
                checked={line === l.id}
                onChange={() => setLine(l.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{l.memo}</span>
                <span className="block text-xs text-muted-foreground">
                  {l.entry_date}
                </span>
              </span>
              <Money value={l.available_cents} />
            </label>
          ))}
          {!candidates.length && (
            <p className="py-4 text-sm text-muted-foreground">
              No available transactions on this page match the direction and
              date. Search another page or post the missing transaction first.
            </p>
          )}
        </div>
        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={!page}
            onClick={() => {
              setPage((p) => p - 1);
              setLine("");
            }}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!data || (page + 1) * 100 >= data.line_count}
            onClick={() => {
              setPage((p) => p + 1);
              setLine("");
            }}
          >
            Next
          </Button>
        </div>
        <Input
          label="Amount to match (positive)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <ErrorText value={cmd.error || readError} />
        <Button
          disabled={!line || cmd.busy}
          loading={cmd.busy}
          onClick={async () => {
            try {
              const n = parseUsd(amount),
                selected = candidates.find((l) => l.id === line);
              if (n <= BigInt(0) || !selected)
                throw new Error("Choose a transaction and positive amount.");
              await cmd.execute({
                type: "reconciliation.allocate",
                id: r.id,
                expected_version: r.version,
                allocations: [
                  {
                    id,
                    statement_item_id: item.id,
                    entry_line_id: line,
                    amount_cents: (BigInt(item.remaining_cents) < BigInt(0)
                      ? -n
                      : n
                    ).toString(),
                  },
                ],
              });
            } catch (e) {
              cmd.setError(
                e instanceof Error ? e.message : "Check the amount.",
              );
            }
          }}
        >
          Save match
        </Button>
      </DialogContent>
    </Dialog>
  );
}
function OpeningReview({
  statement: r,
  revision,
  book,
  prior,
  onClose,
  onSaved,
}: {
  statement: Statement;
  revision: string;
  book: string;
  prior: NonNullable<ReconciliationView["proof"]>["outstanding"];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({}),
    [reviewed, setReviewed] = useState(false),
    [limit, setLimit] = useState(50);
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review the first statement opening</DialogTitle>
          <DialogDescription>
            The prior book balance is {formatCents(book)}. The statement opens
            at {formatCents(r.opening_cents)}. Identify any prior transactions
            that had not yet cleared; all other prior amounts will be recorded
            as already cleared.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Use signed amounts for outstanding portions. Zero means fully cleared
          before this statement. Review all {prior.length} currently outstanding
          prior lines.
        </p>
        <div className="space-y-3">
          {prior.slice(0, limit).map((l) => (
            <div
              key={l.line_id}
              className="grid grid-cols-[1fr_130px] items-center gap-4 border-b border-border pb-3 text-sm"
            >
              <div>
                <p>{l.memo}</p>
                <p className="text-xs text-muted-foreground">
                  {l.entry_date} · Original {formatCents(l.amount_cents)}
                </p>
              </div>
              <Input
                aria-label={`Uncleared amount for ${l.memo} on ${l.entry_date}`}
                inputMode="decimal"
                value={values[l.line_id] ?? "0.00"}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [l.line_id]: e.target.value }));
                  setReviewed(false);
                }}
              />
            </div>
          ))}
        </div>
        {limit < prior.length && (
          <Button variant="outline" onClick={() => setLimit((n) => n + 50)}>
            Show next 50 prior items
          </Button>
        )}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={reviewed}
            disabled={limit < prior.length}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          <span>
            I reviewed the prior items and the opening statement balance.
            Amounts left at zero had already cleared.
          </span>
        </label>
        <ErrorText value={cmd.error} />
        <Button
          disabled={!reviewed || cmd.busy}
          loading={cmd.busy}
          onClick={async () => {
            try {
              const outstanding = Object.entries(values)
                .map(([line_id, value]) => ({
                  line_id,
                  amount_cents: parseUsd(value).toString(),
                }))
                .filter((v) => v.amount_cents !== "0");
              await cmd.execute({
                type: "reconciliation.opening",
                id: r.id,
                expected_version: r.version,
                expected_revision: revision,
                reviewed: true,
                outstanding,
              });
            } catch (e) {
              cmd.setError(
                e instanceof Error
                  ? e.message
                  : "Check the outstanding amounts.",
              );
            }
          }}
        >
          Confirm cleared opening
        </Button>
      </DialogContent>
    </Dialog>
  );
}
