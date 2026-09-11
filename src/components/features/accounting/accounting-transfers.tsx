"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowLeftRight, Plus, Link2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Pagination } from "@/components/ui/pagination";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import type { TransferGroup, TransfersView } from "@/lib/accounting/transfers";
import { parseUsd } from "@/lib/accounting/money";
import { AccountingPicker } from "./accounting-picker";
import { dateLabel, money } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

const TRANSFERS_PAGE = 50;

export function AccountingTransfers({
  from,
  to,
  accounts,
  profiles,
  demo,
  onRefresh,
  onEntry,
}: {
  from: string;
  to: string;
  accounts: AccountingAccount[];
  profiles: AccountProfile[];
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const [data, setData] = useState<TransfersView | null>(null),
    [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0),
    [error, setError] = useState(""),
    [form, setForm] = useState<"create" | "link" | null>(null),
    [reverse, setReverse] = useState<TransferGroup | null>(null);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    setData(null);
    accountingGet<TransfersView>(
      { view: "transfers", from, to, offset: String(offset) },
      abort.signal,
    )
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [from, to, offset, tick, demo]);
  const refresh = async () => {
    setTick((t) => t + 1);
    await onRefresh();
  };
  const available = accounts.filter((a) =>
    profiles.some(
      (p) =>
        p.account_id === a.id && ["bank", "cash", "card"].includes(p.cash_kind),
    ),
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Transfers & card payments</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Keep both sides together, with the date each account actually
            posted. Card payments reduce card debt.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={demo || !data}
            onClick={() => setForm("link")}
          >
            <Link2 size={15} aria-hidden="true" />
            Link existing
          </Button>
          <Button disabled={demo || !data} onClick={() => setForm("create")}>
            <Plus size={15} aria-hidden="true" />
            Record transfer
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <section className="glass-card overflow-hidden rounded-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="text-sm font-medium">
            Transfers touching this date range
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={demo}
            onClick={() => setTick((t) => t + 1)}
          >
            Refresh
          </Button>
        </div>
        {!data && !demo && !error ? (
          <div role="status" aria-label="Loading transfers…" className="p-5">
            <TableSkeleton rows={4} />
          </div>
        ) : !data?.groups.length ? (
          <div className="p-10 text-center">
            <ArrowLeftRight
              size={24}
              aria-hidden="true"
              className="mx-auto mb-3 text-muted-foreground"
            />
            <h3 className="font-medium">No linked transfers in this range</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Record a new movement or link matching entries already in your
              books. Existing income and expense entries need a reviewed
              correction first.
            </p>
          </div>
        ) : (
          data.groups.map((g) => (
            <div
              key={g.id}
              className="border-b border-border p-5 last:border-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{g.memo}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{g.from_name}</span>
                    <ArrowRight size={14} aria-hidden="true" />
                    <span>{g.to_name}</span>
                  </div>
                </div>
                <div className="text-right">
                  <MaskedValue
                    value={money(g.amount_cents)}
                    className="tabular-nums"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {g.status === "corrected"
                      ? "Reversed, history retained"
                      : g.in_transit
                        ? "In transit at range end"
                        : "Posted transfer"}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                <Button
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => onEntry(g.outgoing_entry_id)}
                >
                  Out {dateLabel(g.outgoing_date)}
                </Button>
                {g.outgoing_entry_id !== g.incoming_entry_id && (
                  <Button
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() => onEntry(g.incoming_entry_id)}
                  >
                    In {dateLabel(g.incoming_date)}
                  </Button>
                )}
                {g.status === "posted" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setReverse(g)}
                  >
                    <Undo2 size={14} aria-hidden="true" />
                    Reverse transfer
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
        {data && (
          <Pagination
            className="border-t border-border"
            offset={offset}
            limit={TRANSFERS_PAGE}
            total={data.total}
            onChange={setOffset}
          />
        )}
      </section>
      {form && data && (
        <TransferForm
          mode={form}
          from={from}
          to={to}
          accounts={available}
          revision={data.revision}
          onClose={() => setForm(null)}
          onSaved={refresh}
        />
      )}
      {reverse && data && (
        <ReverseTransfer
          group={reverse}
          revision={data.revision}
          onClose={() => setReverse(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
function TransferForm({
  mode,
  from,
  to,
  accounts,
  revision,
  onClose,
  onSaved,
}: {
  mode: "create" | "link";
  from: string;
  to: string;
  accounts: AccountingAccount[];
  revision: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [fromAccount, setFromAccount] = useState(""),
    [toAccount, setToAccount] = useState(""),
    [outDate, setOutDate] = useState(to),
    [inDate, setInDate] = useState(to),
    [amount, setAmount] = useState(""),
    [memo, setMemo] = useState(""),
    [outEntry, setOutEntry] = useState<JournalEntry | null>(null),
    [inEntry, setInEntry] = useState<JournalEntry | null>(null),
    [dirty, setDirty] = useState(false);
  const command = useAccountingCommand();
  const { confirm, dialog } = useConfirmationDialog();
  const close = async () => {
    if (command.busy) return;
    if (dirty) {
      const ok = await confirm({
        title: "Discard this unsaved transfer?",
        description: "Nothing has been posted yet.",
        confirmLabel: "Discard",
        variant: "warning",
      });
      if (!ok) return;
    }
    onClose();
  };
  let cents: bigint | null = null;
  try {
    cents = parseUsd(amount);
  } catch {}
  const outAmount = outEntry?.lines.find(
      (l) => l.account_id === fromAccount,
    )?.amount_cents,
    inAmount = inEntry?.lines.find(
      (l) => l.account_id === toAccount,
    )?.amount_cents;
  const linkValid =
    outAmount &&
    inAmount &&
    BigInt(outAmount) < BigInt(0) &&
    BigInt(inAmount) === -BigInt(outAmount);
  const valid =
    !!fromAccount &&
    !!toAccount &&
    fromAccount !== toAccount &&
    !!memo.trim() &&
    (mode === "create"
      ? cents !== null && cents > BigInt(0) && !!outDate && !!inDate
      : linkValid);
  const accountOptions = (exclude?: string) =>
    accounts
      .filter((a) => a.id !== exclude && (mode === "link" || !a.is_archived))
      .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  async function save() {
    if (!valid) return;
    const common = {
      id,
      expected_revision: revision,
      from_account_id: fromAccount,
      to_account_id: toAccount,
      memo,
      amount_cents:
        mode === "link" ? (-BigInt(outAmount!)).toString() : cents!.toString(),
    };
    const result = await command.execute(
      mode === "create"
        ? {
            ...common,
            type: "transfer.create",
            outgoing_date: outDate,
            incoming_date: inDate,
          }
        : {
            ...common,
            type: "transfer.link",
            outgoing_entry_id: outEntry!.id,
            incoming_entry_id: inEntry!.id,
          },
    );
    if (result) {
      setDirty(false);
      onClose();
      await onSaved();
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Record transfer" : "Link transfer"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {mode === "create"
              ? "Move money between two of your accounts."
              : "Pair two posted entries as one transfer."}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-5" onChange={() => setDirty(true)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <AccountingPicker
              label="From"
              visibleLabel="From"
              placeholder="Choose account"
              value={fromAccount}
              options={accountOptions()}
              onChange={(value) => {
                setFromAccount(value);
                setOutEntry(null);
                setDirty(true);
              }}
            />
            <AccountingPicker
              label="To"
              visibleLabel="To"
              placeholder="Choose account"
              value={toAccount}
              options={accountOptions(fromAccount)}
              onChange={(value) => {
                setToAccount(value);
                setInEntry(null);
                setDirty(true);
              }}
            />
          </div>
          {mode === "create" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <DateInput
                  label="Outgoing date"
                  value={outDate}
                  onChange={(nextValue) => setOutDate(nextValue)}
                />
                <DateInput
                  label="Incoming date"
                  value={inDate}
                  onChange={(nextValue) => setInDate(nextValue)}
                />
              </div>
              <TextInput
                label="Amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(nextValue) => setAmount(nextValue)}
              />
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <TransferEntryPicker
                label="Outgoing entry"
                account={fromAccount}
                direction="out"
                from={from}
                to={to}
                selected={outEntry}
                onSelect={(entry) => {
                  setOutEntry(entry);
                  setDirty(true);
                }}
              />
              <TransferEntryPicker
                label="Incoming entry"
                account={toAccount}
                direction="in"
                from={from}
                to={to}
                selected={inEntry}
                onSelect={(entry) => {
                  setInEntry(entry);
                  setDirty(true);
                }}
              />
            </div>
          )}
          <TextInput
            label="Description"
            placeholder="Operating account to savings"
            maxLength={1000}
            value={memo}
            onChange={(nextValue) => setMemo(nextValue)}
          />
          {mode === "link" && outEntry && inEntry && !linkValid && (
            <p role="alert" className="text-sm text-error">
              Choose an outgoing decrease and an equal incoming increase.
            </p>
          )}
          {command.error && (
            <p role="alert" className="text-sm text-error">
              {command.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={command.busy}
              onClick={() => void close()}
            >
              Cancel
            </Button>
            <Button
              disabled={!valid || command.busy}
              loading={command.busy}
              onClick={() =>
                void save().catch((e) => command.setError(e.message))
              }
            >
              {mode === "create" ? "Record" : "Link"}
            </Button>
          </div>
        </div>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
function TransferEntryPicker({
  label,
  account,
  direction,
  from,
  to,
  selected,
  onSelect,
}: {
  label: string;
  account: string;
  direction: "in" | "out";
  from: string;
  to: string;
  selected: JournalEntry | null;
  onSelect: (entry: JournalEntry | null) => void;
}) {
  const [query, setQuery] = useState(""),
    [data, setData] = useState<{
      entries: JournalEntry[];
      total: number;
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    if (!account) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      accountingGet<{ entries: JournalEntry[]; total: number }>(
        {
          view: "register",
          filter: JSON.stringify({
            account,
            from,
            to,
            status: "posted",
            query,
            limit: 50,
          }),
        },
        abort.signal,
      )
        .then((r) => {
          setData(r);
          setError("");
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [account, from, to, query]);
  const candidates =
    data?.entries.filter(
      (e) =>
        !e.reverses_entry_id &&
        !e.reversed_by_entry_id &&
        e.lines.some(
          (l) =>
            l.account_id === account &&
            (direction === "in"
              ? BigInt(l.amount_cents) > BigInt(0)
              : BigInt(l.amount_cents) < BigInt(0)),
        ),
    ) ?? [];
  return (
    <div className="space-y-2">
      <TextInput
        label={label}
        placeholder="Search posted descriptions"
        value={query}
        disabled={!account}
        onChange={(nextValue) => setQuery(nextValue)}
      />
      {selected ? (
        <div className="flex items-start justify-between gap-2 rounded-xl border border-border p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{selected.memo}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {dateLabel(selected.entry_date)}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="max-h-44 divide-y divide-border overflow-y-auto rounded-xl border border-border">
          {candidates.map((e) => (
            <Button
              type="button"
              key={e.id}
              variant="ghost"
              className="h-auto w-full flex-col items-stretch gap-1 whitespace-normal rounded-none p-3 text-left font-normal"
              onClick={() => onSelect(e)}
            >
              <span className="block">{e.memo}</span>
              <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{dateLabel(e.entry_date)}</span>
                <MaskedValue
                  className="tabular-nums"
                  value={money(
                    e.lines.find((l) => l.account_id === account)!.amount_cents,
                  )}
                />
              </span>
            </Button>
          ))}
          {!candidates.length &&
            (account && !data && !error ? (
              <div
                role="status"
                aria-label="Loading entries…"
                className="space-y-2 p-3"
              >
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : (
              <p className="p-3 text-xs text-muted-foreground">
                {!account
                  ? "Choose an account first."
                  : "No matching movements in this date range."}
              </p>
            ))}
        </div>
      )}
      {data && data.total > 50 && (
        <p className="text-xs text-muted-foreground">
          First 50 shown; narrow the search.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
function ReverseTransfer({
  group,
  revision,
  onClose,
  onSaved,
}: {
  group: TransferGroup;
  revision: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [outDate, setOutDate] = useState(group.outgoing_date),
    [inDate, setInDate] = useState(group.incoming_date),
    [reason, setReason] = useState("");
  const command = useAccountingCommand();
  const separate = group.outgoing_entry_id !== group.incoming_entry_id;
  async function save() {
    const result = await command.execute({
      type: "transfer.reverse",
      id: group.id,
      expected_revision: revision,
      outgoing_date: outDate,
      incoming_date: separate ? inDate : outDate,
      reason,
    });
    if (result) {
      onClose();
      await onSaved();
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reverse transfer</DialogTitle>
          <DialogDescription>
            {group.memo},{" "}
            <MaskedValue
              value={money(group.amount_cents)}
              className="tabular-nums"
            />
            .
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-5">
          {separate ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <DateInput
                label="Outgoing date"
                value={outDate}
                onChange={(nextValue) => setOutDate(nextValue)}
              />
              <DateInput
                label="Incoming date"
                value={inDate}
                onChange={(nextValue) => setInDate(nextValue)}
              />
            </div>
          ) : (
            <DateInput
              label="Reversal date"
              value={outDate}
              onChange={(nextValue) => setOutDate(nextValue)}
            />
          )}
          <TextInput
            label="Reason"
            required
            value={reason}
            maxLength={1000}
            onChange={(nextValue) => setReason(nextValue)}
          />
          {command.error && (
            <p role="alert" className="text-sm text-error">
              {command.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={command.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || !outDate || !inDate || command.busy}
              loading={command.busy}
              onClick={() =>
                void save().catch((e) => command.setError(e.message))
              }
            >
              Reverse
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
