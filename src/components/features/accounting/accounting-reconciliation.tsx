"use client";
import { useEffect, useState, useDeferredValue } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Plus, Search, FileCheck2 } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { SectionHeader } from "@/components/ui/section-header";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import { parseUsd, centsToDecimal } from "@/lib/accounting/money";
import { statementCents } from "@/lib/accounting/statement-money";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { ReconciliationView, Statement } from "@/lib/accounting/close";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { AccountingDocumentPicker } from "./accounting-document-picker";

import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { countLabel, dateLabel, enumLabel, money } from "./format";

type StatementItem = ReconciliationView["items"][number];
type PostedLine = ReconciliationView["lines"][number];
/** The actions that need a confirmation; removing and reopening need a reason. */
type Confirm =
  | { kind: "complete" }
  | { kind: "reopen" }
  | { kind: "remove"; item: StatementItem };

const statusVariant: Record<Statement["status"], BadgeVariant> = {
  in_progress: "info",
  completed: "success",
};
const confirmCopy: Record<
  Confirm["kind"],
  { title: string; description: string; action: string }
> = {
  complete: {
    title: "Complete this reconciliation?",
    description:
      "Saves the selected transactions and the statement totals as this statement's proof. This does not lock a calendar month.",
    action: "Complete",
  },
  reopen: {
    title: "Reopen this statement?",
    description:
      "The statement goes back to in progress so its selection can change. Reopen any affected month close first.",
    action: "Reopen",
  },
  remove: {
    title: "Remove this item?",
    description:
      "The transaction stays posted. It is only taken off this statement.",
    action: "Remove item",
  },
};
const linkClass =
  "rounded text-left transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Masked statement money; card accounts show amounts owed as positive. */
function Money({ value, card = false }: { value: string; card?: boolean }) {
  return (
    <MaskedValue
      value={money(statementCents(value, card))}
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
  const card = account.account_type === "liability";
  const params = useSearchParams();
  const [selected, setSelected] = useState(params.get("statement") ?? ""),
    [data, setData] = useState<ReconciliationView | null>(null),
    [page, setPage] = useState(0),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0);
  const [create, setCreate] = useState(false),
    [pick, setPick] = useState(false),
    [confirm, setConfirm] = useState<Confirm | null>(null),
    [reason, setReason] = useState("");
  const deferredQuery = useDeferredValue(query);
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
        if (r.statement && r.statement.account_id !== account.id)
          throw new Error(
            "This statement belongs to a different account. Return to the statement list.",
          );
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
  function choose(id: string) {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set("reconcile", account.id);
    if (id) url.searchParams.set("statement", id);
    else url.searchParams.delete("statement");
    window.history.replaceState(null, "", url);
    setPage(0);
    setQuery("");
    setData(null);
  }
  function ask(next: Confirm) {
    setReason("");
    setConfirm(next);
  }
  const lineState = (l: PostedLine) =>
    l.remaining_cents === "0"
      ? "Selected"
      : `${money(statementCents(l.remaining_cents, card))} unselected`;
  const statementColumns: DataTableColumn<Statement>[] = [
    {
      key: "period",
      header: "Period",
      render: (s) => (
        <button
          type="button"
          className={cn(linkClass, "font-medium")}
          onClick={(e) => {
            e.stopPropagation();
            choose(s.id);
          }}
        >
          {dateLabel(s.from_date)} to {dateLabel(s.to_date)}
        </button>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (s) => (
        <Badge variant={statusVariant[s.status]}>{enumLabel(s.status)}</Badge>
      ),
    },
    {
      key: "ending",
      header: "Ending balance",
      align: "right",
      numeric: true,
      render: (s) => <Money value={s.ending_cents} card={card} />,
    },
  ];
  const lineColumns: DataTableColumn<PostedLine>[] = [
    {
      key: "memo",
      header: "Transaction",
      render: (l) => (
        <button
          type="button"
          className={linkClass}
          onClick={(e) => {
            e.stopPropagation();
            onEntry(l.entry_id);
          }}
        >
          {l.memo}
          <span className="mt-1 block text-xs text-muted-foreground">
            {dateLabel(l.entry_date)} · {lineState(l)}
          </span>
        </button>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      render: (l) => <Money value={l.amount_cents} card={card} />,
    },
  ];
  const copy = confirm ? confirmCopy[confirm.kind] : null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={15} aria-hidden="true" />
            All accounts
          </Button>
          <h2 className="mt-3 text-xl font-semibold">
            Reconcile {account.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Select the posted transactions that appear on each statement.
            Progress is saved after every action.
            {card &&
              " Card balances and charges are positive amounts owed; payments and refunds reduce that amount."}
          </p>
        </div>
        <Button onClick={() => setCreate(true)}>
          <Plus size={15} aria-hidden="true" />
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
      {!selected && (
        <section>
          <SectionHeader
            label="Statement history"
            count={data ? data.statements.length : undefined}
          />
          {!data ? (
            <p className="text-sm text-muted-foreground">Loading statements…</p>
          ) : (
            <DataTable
              columns={statementColumns}
              data={data.statements}
              keyExtractor={(s) => s.id}
              onRowClick={(s) => choose(s.id)}
              busy={loading}
              emptyState={
                <div>
                  <FileCheck2
                    aria-hidden="true"
                    className="mx-auto mb-3 text-muted-foreground"
                  />
                  <p className="font-medium text-foreground">
                    Start with a bank or card statement
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Enter its dates and balances, then select the posted
                    transactions it shows.
                  </p>
                </div>
              }
              mobileCard={(s) => (
                <div className="glass-card flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
                  <div className="min-w-0">
                    <button
                      type="button"
                      className={cn(linkClass, "text-sm font-medium")}
                      onClick={(e) => {
                        e.stopPropagation();
                        choose(s.id);
                      }}
                    >
                      {dateLabel(s.from_date)} to {dateLabel(s.to_date)}
                    </button>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge size="sm" variant={statusVariant[s.status]}>
                        {enumLabel(s.status)}
                      </Badge>
                    </div>
                  </div>
                  <Money value={s.ending_cents} card={card} />
                </div>
              )}
            />
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
              <ArrowLeft size={14} aria-hidden="true" />
              Statement history
            </Button>
            <Badge variant={statusVariant[r.status]} dot>
              {enumLabel(r.status)}
            </Badge>
          </div>
          <section className="glass-card rounded-xl p-5">
            <div className="flex flex-wrap justify-between gap-4">
              <div>
                <h3 className="font-semibold">
                  {dateLabel(r.from_date)} to {dateLabel(r.to_date)}
                </h3>
                <div className="mt-2 flex flex-wrap gap-4 text-sm">
                  {r.document_id ? (
                    <a
                      className="text-teal-light"
                      href={`/api/accounting/documents?id=${r.document_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open statement file
                    </a>
                  ) : (
                    <span className="text-muted-foreground">
                      No statement file attached
                    </span>
                  )}
                  {r.status === "completed" && (
                    <a
                      className="text-teal-light"
                      href={`/accounting?view=close&month=${r.from_date.slice(0, 7)}`}
                    >
                      Review calendar close
                    </a>
                  )}
                </div>
              </div>
              <div className="text-right text-sm">
                <p className="text-muted-foreground">
                  Statement ending balance
                </p>
                <p className="mt-1 text-xl">
                  <Money value={r.ending_cents} card={card} />
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-secondary/40 p-3">
                <p className="text-xs text-muted-foreground">Opening balance</p>
                <p className="mt-2 text-lg">
                  <Money value={r.opening_cents} card={card} />
                </p>
              </div>
              <div className="rounded-lg bg-secondary/40 p-3">
                <p className="text-xs text-muted-foreground">
                  Selected transactions
                </p>
                <p className="mt-2 text-lg">{p.item_count}</p>
              </div>
              <div className="rounded-lg bg-secondary/40 p-3">
                <p className="text-xs text-muted-foreground">Difference</p>
                <p className={cn("mt-2 text-lg", p.ready && "text-teal-light")}>
                  <Money value={p.statement_difference_cents} card={card} />
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Opening balance plus the selected transactions must equal the
              ending balance. Completing needs a zero difference. A transaction
              posted inside these dates later reopens the statement.
            </p>
            {editable && (
              <div className="mt-5">
                <Button
                  size="sm"
                  disabled={!p.ready || command.busy || loading}
                  onClick={() => ask({ kind: "complete" })}
                >
                  <Check size={14} aria-hidden="true" />
                  Complete reconciliation
                </Button>
              </div>
            )}
            {r.status === "completed" && (
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                onClick={() => ask({ kind: "reopen" })}
              >
                Reopen statement
              </Button>
            )}
          </section>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="glass-card overflow-hidden rounded-xl">
              <div className="flex items-center justify-between gap-3 border-b border-border p-5">
                <h3 className="font-semibold">Statement items</h3>
                {editable && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPick(true)}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Add item
                  </Button>
                )}
              </div>
              {!data.items.length ? (
                <p className="p-5 text-sm text-muted-foreground">
                  Select the posted transactions that appear on the statement.
                  Their total explains the change from the opening to the ending
                  balance.
                </p>
              ) : (
                data.items.map((i) => (
                  <div
                    key={i.id}
                    className="flex items-center justify-between gap-3 border-b border-border p-4 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {i.description}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dateLabel(i.entry_date)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-sm">
                      <Money value={i.amount_cents} card={card} />
                      {editable && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={command.busy}
                          onClick={() => ask({ kind: "remove", item: i })}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </section>
            <section className="glass-card overflow-hidden rounded-xl">
              <div className="border-b border-border p-5">
                <h3 className="font-semibold">Posted transactions</h3>
                <div className="mt-3">
                  <Input
                    aria-label="Search posted transactions"
                    icon={<Search size={15} aria-hidden="true" />}
                    placeholder="Search memo or date"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                  />
                </div>
              </div>
              <div className="p-4 lg:p-0">
                <DataTable
                  columns={lineColumns}
                  data={data.lines}
                  keyExtractor={(l) => l.id}
                  onRowClick={(l) => onEntry(l.entry_id)}
                  busy={loading}
                  framed={false}
                  emptyState="No posted transactions in this scope."
                  mobileCard={(l) => (
                    <div className="glass-card flex items-start justify-between gap-4 rounded-xl p-4 text-sm">
                      <div className="min-w-0">
                        <button
                          type="button"
                          className={cn(linkClass, "block max-w-full truncate")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEntry(l.entry_id);
                          }}
                        >
                          {l.memo}
                        </button>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {dateLabel(l.entry_date)} · {lineState(l)}
                        </span>
                      </div>
                      <Money value={l.amount_cents} card={card} />
                    </div>
                  )}
                />
              </div>
            </section>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {countLabel(data.item_count, "statement item")} ·{" "}
              {countLabel(data.line_count, "posted line")}
            </span>
            <Pagination
              offset={page * 100}
              limit={100}
              total={Math.max(data.item_count, data.line_count)}
              busy={loading}
              onChange={(offset) => setPage(Math.floor(offset / 100))}
              className="px-0 py-0"
            />
          </div>
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
      {pick && r && data && (
        <SelectLine
          account={account}
          statement={r}
          onClose={() => setPick(false)}
          onSaved={async () => {
            setPick(false);
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
            <DialogTitle>{copy?.title}</DialogTitle>
            <DialogDescription>
              {confirm?.kind === "remove" &&
                `${confirm.item.description}, ${dateLabel(confirm.item.entry_date)}. `}
              {copy?.description}
            </DialogDescription>
          </DialogHeader>
          {confirm && confirm.kind !== "complete" && (
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
                command.busy || (confirm?.kind !== "complete" && !reason.trim())
              }
              loading={command.busy}
              onClick={async () => {
                if (!r || !confirm) return;
                const base = { id: r.id, expected_version: r.version };
                const c: WorkflowCommand =
                  confirm.kind === "complete"
                    ? { ...base, type: "reconciliation.complete" }
                    : confirm.kind === "reopen"
                      ? { ...base, type: "reconciliation.reopen", reason }
                      : {
                          ...base,
                          type: "reconciliation.item.remove",
                          item_id: confirm.item.id,
                          reason,
                        };
                if (await command.execute(c)) setConfirm(null);
              }}
            >
              {copy?.action}
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
  onClose,
  onSaved,
}: {
  account: AccountingAccount;
  statements: Statement[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const card = account.account_type === "liability";
  const [id] = useState(() => crypto.randomUUID()),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [opening, setOpening] = useState("0.00"),
    [ending, setEnding] = useState(""),
    [doc, setDoc] = useState("");
  const cmd = useAccountingCommand(),
    last = statements
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
          <DialogTitle>New statement · {account.name}</DialogTitle>
          <DialogDescription>
            Copy the dates and balances from your statement.{" "}
            {card
              ? "Enter amounts owed as positive, and a credit balance as negative."
              : "Enter money held as positive, and an overdraft as negative."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await cmd.execute({
                type: "reconciliation.create",
                id,
                account_id: account.id,
                from,
                to,
                opening_cents: statementCents(parseUsd(opening), card),
                ending_cents: statementCents(parseUsd(ending), card),
                document_id: doc || null,
              });
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
              Previous statement ended {dateLabel(last.to_date)} at{" "}
              {money(statementCents(last.ending_cents, card))}. Continue with
              the next day and the same opening balance.
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
              label={card ? "Opening amount owed" : "Opening balance"}
              required
              inputMode="decimal"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
            />
            <Input
              label={card ? "Ending amount owed" : "Ending balance"}
              required
              inputMode="decimal"
              value={ending}
              onChange={(e) => setEnding(e.target.value)}
            />
          </div>
          <AccountingDocumentPicker
            value={doc}
            onChange={setDoc}
            label="Original statement (optional)"
          />
          <p className="text-xs text-muted-foreground">
            Attach the statement file when you have it. The proof is the
            selected posted transactions against these balances.
          </p>
          <ErrorText value={cmd.error} />
          <Button
            type="submit"
            className="w-full"
            disabled={cmd.busy}
            loading={cmd.busy}
          >
            Create statement
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
/** Pick a posted transaction on the account and add all or part of it to the statement. */
function SelectLine({
  account,
  statement: initialStatement,
  onClose,
  onSaved,
}: {
  account: AccountingAccount;
  statement: Statement;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [r] = useState(initialStatement);
  const card = account.account_type === "liability";
  const [id] = useState(() => crypto.randomUUID()),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [data, setData] = useState<ReconciliationView | null>(null),
    [line, setLine] = useState<PostedLine | null>(null),
    [amount, setAmount] = useState(""),
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
    data?.lines.filter((l) => BigInt(l.remaining_cents) !== BigInt(0)) ?? [];
  function pick(l: PostedLine) {
    setLine(l);
    const remaining = BigInt(l.remaining_cents);
    setAmount(centsToDecimal(remaining < BigInt(0) ? -remaining : remaining));
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a statement item</DialogTitle>
          <DialogDescription>
            Choose the posted transaction on {account.name} that appears on this
            statement, dated on or before {dateLabel(r.to_date)}. Part of a
            transaction can be selected when the statement shows only part of
            it.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Find a posted transaction"
          placeholder="Search memo or exact date"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
            setLine(null);
          }}
        />
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {candidates.map((l) => (
            <label
              key={l.id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm",
                line?.id === l.id
                  ? "border-teal-light bg-teal-light/5"
                  : "border-border",
              )}
            >
              <input
                type="radio"
                name="statement-line"
                value={l.id}
                checked={line?.id === l.id}
                onChange={() => pick(l)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{l.memo}</span>
                <span className="block text-xs text-muted-foreground">
                  {dateLabel(l.entry_date)}
                </span>
              </span>
              <Money value={l.remaining_cents} card={card} />
            </label>
          ))}
          {!candidates.length && (
            <p className="py-4 text-sm text-muted-foreground">
              No unselected posted transactions on this page. Search another
              page or post the missing transaction first.
            </p>
          )}
        </div>
        <Pagination
          offset={page * 100}
          limit={100}
          total={data?.line_count ?? 0}
          onChange={(offset) => {
            setPage(Math.floor(offset / 100));
            setLine(null);
          }}
          className="px-0"
        />
        <Input
          label="Amount on the statement (positive)"
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
              const n = parseUsd(amount);
              if (n <= BigInt(0) || !line)
                throw new Error("Choose a transaction and a positive amount.");
              await cmd.execute({
                type: "reconciliation.allocate",
                id: r.id,
                expected_version: r.version,
                allocations: [
                  {
                    id,
                    entry_line_id: line.id,
                    amount_cents: (BigInt(line.remaining_cents) < BigInt(0)
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
          Add to statement
        </Button>
      </DialogContent>
    </Dialog>
  );
}
