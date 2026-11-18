"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Radio } from "@/components/ui/inputs/RadioGroup";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Skeleton } from "@/components/ui/skeleton";
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
import { readCents } from "@/lib/accounting/money";
import {
  isTransactionReversed,
  isTransactionReviewed,
  presentTransaction,
} from "@/lib/accounting/transactions";
import { AccountingAccountLogo } from "./accounting-bank-identity";
import { AccountingPicker } from "./accounting-picker";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { absMoney, dateLabel, monthLabel } from "./format";

type Periods = { month_start: string; is_locked: boolean }[];

const CASH_KINDS = ["bank", "cash", "card"];

/**
 * Whether a transaction can be one side of a converted transfer: one movement
 * on one bank, card or cash account, not already a transfer, a proposed pair,
 * a deleted or replaced version, payroll or an invoice payment. The server
 * checks all of this again.
 */
export function canConvertToTransfer(
  entry: JournalEntry,
  profiles: AccountProfile[],
): boolean {
  if (entry.status !== "draft" && entry.status !== "posted") return false;
  if (isTransactionReversed(entry) || entry.reverses_entry_id) return false;
  if (entry.transfer_group_id || entry.pair_entry_id) return false;
  if (entry.payroll_run_id || entry.invoice_links?.length) return false;
  return !!presentTransaction(entry, profiles).bankLine;
}

/**
 * What a movement did to its account, read the account's own way: money out
 * of a bank account is a withdrawal; on a card, a negative line is a charge or
 * a credit balance paid back out, a positive one a payment or credit received.
 */
function movementLabel(kind: string | undefined, cents: bigint): string {
  if (kind === "card")
    return cents < BigInt(0)
      ? "Charge or credit paid out"
      : "Payment or credit received";
  return cents < BigInt(0) ? "Money out" : "Money in";
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000,
  );
}

/**
 * Owner correction: this transaction and one already in the books on another
 * own account are the two sides of one transfer. Nothing new is recorded. The
 * owner picks the other side at any date distance, sees exactly what changes,
 * and confirms; the server links both in one step or changes nothing.
 */
export function AccountingTransferConvert({
  entry,
  accounts,
  profiles,
  periods,
  onClose,
  onSaved,
}: {
  entry: JournalEntry;
  accounts: AccountingAccount[];
  profiles: AccountProfile[];
  periods: Periods;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const radioName = useId();
  const kinds = useMemo(
    () => new Map(profiles.map((p) => [p.account_id, p.cash_kind])),
    [profiles],
  );
  const names = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );
  const own = presentTransaction(entry, profiles);
  const ownAccount = own.bankLine?.account_id ?? "";
  const ownCents = own.bankLine
    ? readCents(own.bankLine.amount_cents)
    : BigInt(0);
  const amount = ownCents < BigInt(0) ? -ownCents : ownCents;
  const [other, setOther] = useState("");
  const [picked, setPicked] = useState<JournalEntry | null>(null);
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [reason, setReason] = useState(
    "Two sides of one transfer between the business's own accounts",
  );
  const [found, setFound] = useState<JournalEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const command = useAccountingCommand(async () => undefined);

  const otherOptions = accounts
    .filter(
      (a) =>
        a.id !== ownAccount &&
        !a.is_archived &&
        CASH_KINDS.includes(kinds.get(a.id) ?? "none"),
    )
    .map((a) => ({
      value: a.id,
      label: a.name,
      icon: <AccountingAccountLogo accountId={a.id} name={a.name} size={20} />,
    }));

  // The other side: same amount, the opposite way, on the chosen account, any date.
  useEffect(() => {
    if (!other) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    accountingGet<{ entries: JournalEntry[] }>(
      {
        view: "register",
        filter: JSON.stringify({
          account: other,
          min_cents: amount.toString(),
          max_cents: amount.toString(),
          status: "all",
          sort: "date_asc",
          limit: 100,
        }),
      },
      controller.signal,
    )
      .then((result) => {
        const want = -ownCents;
        const matches = result.entries.filter((e) => {
          if (e.id === entry.id || !canConvertToTransfer(e, profiles))
            return false;
          const line = presentTransaction(e, profiles).bankLine;
          return (
            line?.account_id === other && readCents(line.amount_cents) === want
          );
        });
        // Nearest in time first; the owner can still pick one months away.
        matches.sort(
          (a, b) =>
            Math.abs(daysBetween(entry.entry_date, a.entry_date)) -
              Math.abs(daysBetween(entry.entry_date, b.entry_date)) ||
            a.entry_date.localeCompare(b.entry_date),
        );
        setFound(matches);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [other, amount, ownCents, entry.id, entry.entry_date, profiles]);

  const outgoing = ownCents < BigInt(0) ? entry : picked;
  const incoming = ownCents < BigInt(0) ? picked : entry;
  const fromAccount = ownCents < BigInt(0) ? ownAccount : other;
  const toAccount = ownCents < BigInt(0) ? other : ownAccount;

  /** Months a correction would touch that are closed: a side's own month, or any later closed month. */
  const closedMonths = (() => {
    if (!picked) return [];
    const earliest = [entry.entry_date, picked.entry_date]
      .sort()[0]
      .slice(0, 7);
    return periods
      .filter((p) => p.is_locked && p.month_start.slice(0, 7) >= earliest)
      .map((p) => p.month_start);
  })();

  const sideSummary = (e: JournalEntry) => {
    const p = presentTransaction(e, profiles);
    const cents = p.bankLine ? readCents(p.bankLine.amount_cents) : BigInt(0);
    const account = p.bankLine?.account_id ?? "";
    return {
      account,
      name: names.get(account) ?? "Account",
      label: movementLabel(kinds.get(account), cents),
      removed: p.categoryLines.map((l) => ({
        id: l.id,
        name: names.get(l.account_id) ?? "Category",
        cents: readCents(l.amount_cents),
      })),
      reviewed: isTransactionReviewed(e),
      draft: e.status === "draft",
    };
  };

  async function confirm() {
    if (!outgoing || !incoming || !reason.trim()) return;
    const ok = await command.execute({
      type: "transfer.convert",
      id: crypto.randomUUID(),
      outgoing_entry_id: outgoing.id,
      outgoing_version: outgoing.version,
      incoming_entry_id: incoming.id,
      incoming_version: incoming.version,
      from_account_id: fromAccount,
      to_account_id: toAccount,
      amount_cents: amount.toString(),
      reason: reason.trim(),
    });
    if (!ok) return;
    const waiting = [outgoing, incoming].some((e) => !isTransactionReviewed(e));
    await onSaved(
      waiting
        ? "Converted to a transfer. The side that needed review still waits in Review."
        : "Converted to a transfer.",
    );
  }

  const sideCard = (e: JournalEntry, heading: string) => {
    const s = sideSummary(e);
    return (
      <div className="min-w-0 rounded-xl bg-[rgba(var(--ink),0.03)] p-3">
        <p className="text-xs text-muted-foreground">{heading}</p>
        <div className="mt-2 flex items-center gap-2">
          <AccountingAccountLogo
            accountId={s.account}
            name={s.name}
            size={20}
          />
          <span className="truncate text-sm font-medium">{s.name}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {dateLabel(e.entry_date)} | {s.label}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{e.memo}</p>
      </div>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.busy) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Convert to transfer</DialogTitle>
          <DialogDescription>
            Link this transaction with its other side on another of your
            accounts. Nothing new is recorded.
          </DialogDescription>
        </DialogHeader>

        {step === "choose" ? (
          <div className="mt-2 space-y-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                <MaskedValue value={absMoney(amount)} />
              </p>
              <p className="text-right text-xs text-muted-foreground">
                {names.get(ownAccount)} | {dateLabel(entry.entry_date)}
                <br />
                {movementLabel(kinds.get(ownAccount), ownCents)}
              </p>
            </div>
            <AccountingPicker
              label="Other account"
              visibleLabel="Other side is on"
              value={other}
              options={otherOptions}
              placeholder="Choose the other account"
              onChange={(value) => {
                setOther(value);
                setPicked(null);
              }}
            />
            {other && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {ownCents < BigInt(0)
                    ? `Where the ${absMoney(amount)} arrived`
                    : `Where the ${absMoney(amount)} came from`}
                </legend>
                {loadError && (
                  <p role="alert" className="text-sm text-error">
                    {loadError}
                  </p>
                )}
                <div
                  className="max-h-64 overflow-auto glass-card rounded-xl"
                  aria-busy={loading}
                >
                  {loading && !found?.length ? (
                    <div
                      role="status"
                      aria-label="Finding matching transactions..."
                      className="space-y-3 px-3 py-3"
                    >
                      {Array.from({ length: 2 }).map((_, i) => (
                        <div key={i} className="space-y-2">
                          <Skeleton className="h-4 w-2/3" />
                          <Skeleton className="h-3 w-1/2" />
                        </div>
                      ))}
                    </div>
                  ) : found?.length ? (
                    found.map((e) => {
                      const s = sideSummary(e);
                      const days = daysBetween(entry.entry_date, e.entry_date);
                      return (
                        <label
                          key={e.id}
                          className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 last:border-0 hover:bg-secondary/40"
                        >
                          <Radio
                            name={radioName}
                            checked={picked?.id === e.id}
                            onChange={() => setPicked(e)}
                            className="mt-1"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {e.memo}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {dateLabel(e.entry_date)} |{" "}
                              {days === 0
                                ? "same day"
                                : `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"}`}{" "}
                              | {s.reviewed ? "Reviewed" : "Needs review"} |{" "}
                              {s.removed.map((r) => r.name).join(", ") ||
                                "No category"}
                            </span>
                          </span>
                        </label>
                      );
                    })
                  ) : (
                    <p className="p-4 text-sm text-muted-foreground">
                      No {absMoney(amount)}{" "}
                      {ownCents < BigInt(0) ? "arriving in" : "leaving"}{" "}
                      {names.get(other)} that can be linked. It must already be
                      in the books, not part of another transfer.
                    </p>
                  )}
                </div>
              </fieldset>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!picked}
                onClick={() => setStep("confirm")}
              >
                Review change
              </Button>
            </div>
          </div>
        ) : (
          outgoing &&
          incoming && (
            <form
              className="mt-2 space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                <MaskedValue value={absMoney(amount)} />
              </p>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
                {sideCard(outgoing, "From")}
                <ArrowRight
                  size={16}
                  aria-hidden="true"
                  className="hidden justify-self-center text-muted-foreground sm:block"
                />
                {sideCard(incoming, "To")}
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">What changes</p>
                <ul className="space-y-2 text-sm">
                  {[outgoing, incoming].map((e) => {
                    const s = sideSummary(e);
                    return (
                      <li
                        key={e.id}
                        className="rounded-xl bg-[rgba(var(--ink),0.03)] px-3 py-2"
                      >
                        <span className="font-medium">
                          {dateLabel(e.entry_date)}, {s.name}:
                        </span>{" "}
                        {s.removed.length
                          ? `removes ${s.removed
                              .map((r) => `${r.name} ${absMoney(r.cents)}`)
                              .join(", ")}`
                          : "no category to remove"}
                        .{" "}
                        <span className="text-muted-foreground">
                          {s.draft
                            ? "Stays in Review for your tick."
                            : `${s.reviewed ? "Reviewed" : "Needs review"}: the original stays in history as the earlier version, corrected on the same date.${s.reviewed ? "" : " Stays in Review for your tick."}`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Both bank movements, dates and bank descriptions stay as they
                  are. No contact. Neither side counts as income, expense or
                  owner activity after this.
                </p>
              </div>
              {closedMonths.length > 0 && (
                <p role="alert" className="text-sm text-error">
                  {closedMonths.map(monthLabel).join(", ")}{" "}
                  {closedMonths.length === 1 ? "is" : "are"} closed. Reopen it
                  in Month-end first, then convert.
                </p>
              )}
              <TextInput
                label="Reason, kept in the history"
                value={reason}
                onChange={setReason}
                maxLength={1000}
                required
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
                  onClick={() => setStep("choose")}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={
                    command.busy || !reason.trim() || closedMonths.length > 0
                  }
                  loading={command.busy}
                >
                  Convert to transfer
                </Button>
              </div>
            </form>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
