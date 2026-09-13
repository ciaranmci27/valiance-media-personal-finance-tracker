"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { TextInput } from "@/components/ui/inputs/TextInput";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { TransferGroup } from "@/lib/accounting/transfers";
import { parseUsd } from "@/lib/accounting/money";
import { AccountingPicker } from "./accounting-picker";
import { dateLabel, money } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

/**
 * The transfer dialogs. Record a transfer between two of your own accounts,
 * link two posted entries that already describe one, or reverse a transfer
 * group as a unit. Opened from the Transactions ledger and its add menu; the
 * transfer list itself is the ledger.
 */
/** A ledger row that opens the link dialog already fills one side of the pair. */
export interface TransferLeg {
  entry: JournalEntry;
  account: string;
  side: "out" | "in";
}
export function TransferForm({
  mode,
  from,
  to,
  accounts,
  revision,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "link";
  from: string;
  to: string;
  accounts: AccountingAccount[];
  revision: string;
  initial?: TransferLeg;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [fromAccount, setFromAccount] = useState(
      initial?.side === "out" ? initial.account : "",
    ),
    [toAccount, setToAccount] = useState(
      initial?.side === "in" ? initial.account : "",
    ),
    [outDate, setOutDate] = useState(to),
    [inDate, setInDate] = useState(to),
    [amount, setAmount] = useState(""),
    [memo, setMemo] = useState(initial?.entry.memo ?? ""),
    [outEntry, setOutEntry] = useState<JournalEntry | null>(
      initial?.side === "out" ? initial.entry : null,
    ),
    [inEntry, setInEntry] = useState<JournalEntry | null>(
      initial?.side === "in" ? initial.entry : null,
    ),
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
export function TransferEntryPicker({
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
        <div className="divide-y divide-border rounded-xl border border-border sm:max-h-44 sm:overflow-y-auto">
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
export function ReverseTransfer({
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
