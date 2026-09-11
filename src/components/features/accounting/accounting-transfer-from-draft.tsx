"use client";
import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import { MaskedValue } from "@/components/ui/masked-value";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { presentTransaction } from "@/lib/accounting/transactions";
import { AccountingPicker } from "./accounting-picker";
import { useAccountingCommand } from "./use-accounting-command";
import { absMoney, dateLabel } from "./format";

/**
 * A bank draft that is really money moving between two of the owner's own
 * accounts (a card payment, a transfer to savings). Records the transfer
 * with the drafts' own dates so the books claim both bank movements and
 * retire the drafts, instead of counting one side as income and the other
 * as an expense.
 */
export function AccountingTransferFromDraft({
  entry,
  counterpart,
  accounts,
  profiles,
  revision,
  onClose,
  onSaved,
}: {
  entry: JournalEntry;
  counterpart: JournalEntry | null;
  accounts: AccountingAccount[];
  profiles: AccountProfile[];
  revision: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const p = presentTransaction(entry, profiles);
  const q = counterpart ? presentTransaction(counterpart, profiles) : null;
  const outgoing = p.amount < BigInt(0);
  const own = p.bankLine?.account_id ?? "";
  const otherDefault = q?.bankLine?.account_id ?? "";
  const [other, setOther] = useState(otherDefault);
  const [ownDate, setOwnDate] = useState(entry.entry_date);
  const [otherDate, setOtherDate] = useState(
    counterpart?.entry_date ?? entry.entry_date,
  );
  const cashKind = new Map(profiles.map((x) => [x.account_id, x.cash_kind]));
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? "";
  const toIsCard = cashKind.get(outgoing ? other : own) === "card";
  const [memo, setMemo] = useState(() =>
    toIsCard ? "Card payment" : "Transfer between accounts",
  );
  const command = useAccountingCommand(onSaved);
  const amount = p.amount < BigInt(0) ? -p.amount : p.amount;
  const fromId = outgoing ? own : other;
  const toId = outgoing ? other : own;
  const options = accounts
    .filter(
      (a) =>
        a.id !== own &&
        !a.is_archived &&
        ["bank", "cash", "card"].includes(cashKind.get(a.id) ?? "none"),
    )
    .map((a) => ({
      value: a.id,
      label: a.name,
      icon: <InstitutionLogo name={a.name} size={20} />,
    }));

  async function save() {
    if (!fromId || !toId || fromId === toId) return;
    const ok = await command.execute({
      type: "transfer.create",
      id: crypto.randomUUID(),
      expected_revision: revision,
      from_account_id: fromId,
      to_account_id: toId,
      amount_cents: amount.toString(),
      memo: memo.trim() || "Transfer between accounts",
      outgoing_date: outgoing ? ownDate : otherDate,
      incoming_date: outgoing ? otherDate : ownDate,
    });
    if (ok) onClose();
  }

  const side = (label: string, id: string, fixed: boolean) => (
    <div>
      <p className="mb-1.5 text-sm font-medium">{label}</p>
      {fixed ? (
        <div className="flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm">
          <InstitutionLogo name={name(id)} size={20} />
          <span className="truncate">{name(id)}</span>
        </div>
      ) : (
        <AccountingPicker
          label={label}
          value={other}
          options={options}
          placeholder="Choose the other account"
          onChange={setOther}
        />
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record transfer</DialogTitle>
          <DialogDescription>
            {counterpart
              ? "Both bank movements become one transfer."
              : "The other side is claimed when its movement arrives."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-2 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-3xl font-semibold tracking-tight tabular-nums">
            <MaskedValue value={absMoney(amount)} />
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            {side("From", fromId, outgoing)}
            <ArrowLeftRight
              size={16}
              aria-hidden="true"
              className="hidden self-center justify-self-center text-muted-foreground sm:block sm:pb-3"
            />
            {side("To", toId, !outgoing)}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <DateInput
              label={outgoing ? "Left the account on" : "Arrived on"}
              value={ownDate}
              required
              onChange={setOwnDate}
            />
            <DateInput
              label={outgoing ? "Arrived on" : "Left the account on"}
              value={otherDate}
              required
              onChange={setOtherDate}
            />
          </div>
          <TextInput
            label="Description"
            value={memo}
            onChange={setMemo}
            maxLength={1000}
            required
          />
          <p className="text-xs text-muted-foreground">
            {counterpart
              ? `Replaces "${entry.memo}" (${dateLabel(entry.entry_date)}) and "${counterpart.memo}" (${dateLabel(counterpart.entry_date)}).`
              : `Replaces "${entry.memo}" (${dateLabel(entry.entry_date)}).`}
          </p>
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
              type="submit"
              disabled={command.busy || !fromId || !toId || fromId === toId}
              loading={command.busy}
            >
              Record transfer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
