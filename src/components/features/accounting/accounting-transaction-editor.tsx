"use client";
import { RadioGroup } from "@/components/ui/inputs/RadioGroup";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { AccountingAccountLogo } from "./accounting-bank-identity";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import {
  defaultEntryContext,
  presentTransaction,
  simpleTransactionLines,
} from "@/lib/accounting/transactions";
import { AccountingPicker } from "./accounting-picker";
import { AccountingContextEditor } from "./accounting-context-editor";
import { EntryEvidenceDisclosure } from "./accounting-entry-evidence";
import {
  commandContext,
  useAccountingCommand,
  type CommandContext,
} from "./use-accounting-command";
import { dateLabel, money } from "./format";

/**
 * The everyday transaction form: how much, what for, which account, which
 * category. Splits, payee and the journal view stay one click away so the
 * common case is four fields and a save.
 */
export function AccountingTransactionEditor({
  entry,
  initialDirection = "out",
  date,
  accounts,
  manage,
  onClose,
  onSaved,
  onJournal,
}: {
  entry?: JournalEntry;
  initialDirection?: "in" | "out";
  date: string;
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onJournal: () => void;
}) {
  const presentation = entry
    ? presentTransaction(entry, manage.profiles)
    : null;
  const [id] = useState(() => entry?.id ?? crypto.randomUUID());
  const [replacementId] = useState(() => crypto.randomUUID());
  const [account, setAccount] = useState(
    presentation?.bankLine?.account_id ?? "",
  );
  const [direction, setDirection] = useState<"in" | "out">(
    presentation?.bankLine
      ? presentation.amount < BigInt(0)
        ? "out"
        : "in"
      : initialDirection,
  );
  const [amount, setAmount] = useState(
    presentation
      ? centsToDecimal(
          presentation.amount < BigInt(0)
            ? -presentation.amount
            : presentation.amount,
        )
      : "",
  );
  const [entryDate, setDate] = useState(entry?.entry_date ?? date);
  const [memo, setMemo] = useState(entry?.memo ?? "");
  const [context, setContext] = useState<CommandContext>(() =>
    entry?.context
      ? commandContext(entry.context)
      : {
          ...defaultEntryContext,
          kind: direction === "in" ? "income" : "expense",
          payee_id: null,
        },
  );
  const [splits, setSplits] = useState(() =>
    presentation?.categoryLines.length
      ? presentation.categoryLines.map((l) => ({
          key: crypto.randomUUID(),
          account: l.account_id,
          amount: centsToDecimal(
            BigInt(l.amount_cents) < BigInt(0)
              ? -BigInt(l.amount_cents)
              : BigInt(l.amount_cents),
          ),
          memo: l.memo,
        }))
      : [{ key: crypto.randomUUID(), account: "", amount: "", memo: "" }],
  );
  const [review, setReview] = useState(false);
  const [remember, setRemember] = useState(false);
  const [reason, setReason] = useState("");
  const descriptor = (entry?.source_description ?? "").trim().slice(0, 250);
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const command = useAccountingCommand(onSaved);
  const { confirm, dialog } = useConfirmationDialog();
  const posted = entry?.status === "posted";
  const bankIds = new Set(
    manage.profiles
      .filter((p) => p.cash_kind !== "none")
      .map((p) => p.account_id),
  );
  const accountOptions = accounts
    .filter((a) => !a.is_archived && bankIds.has(a.id))
    .map((a) => ({
      value: a.id,
      label: a.name,
      icon: <AccountingAccountLogo accountId={a.id} name={a.name} size={20} />,
      group: a.account_type === "liability" ? "Credit cards" : "Cash & bank",
    }));
  const categoryOptions = accounts
    .filter((a) => !a.is_archived && !bankIds.has(a.id))
    .map((a) => ({
      value: a.id,
      label: a.name,
      group: a.account_type[0].toUpperCase() + a.account_type.slice(1),
      keywords: a.code,
    }))
    .sort(
      (a, b) =>
        a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );

  let remaining: bigint | null = null;
  try {
    remaining =
      parseUsd(amount || "0") -
      splits.reduce((sum, s) => sum + parseUsd(s.amount || "0"), BigInt(0));
  } catch {
    /* Invalid money is explained on save. */
  }

  function change(fn: () => void) {
    dirty.current = true;
    fn();
  }

  async function close() {
    if (command.busy) return;
    if (
      !dirty.current ||
      (await confirm({
        title: "Discard changes?",
        description: "Your unsaved edits to this transaction will be lost.",
        confirmLabel: "Discard",
        variant: "warning",
      }))
    )
      onClose();
  }

  async function openJournal() {
    if (
      !dirty.current ||
      (await confirm({
        title: "Open the journal view?",
        description: "Unsaved changes here will be discarded.",
        confirmLabel: "Open journal view",
        variant: "warning",
      }))
    )
      onJournal();
  }

  async function save() {
    setError("");
    try {
      const lines = simpleTransactionLines(
        {
          account,
          direction,
          amount,
          splits: splits.map((s) => ({
            ...s,
            amount: splits.length === 1 ? amount : s.amount,
          })),
        },
        accounts,
        manage.profiles,
      );
      if (!memo.trim()) throw new Error("Add a description.");
      if (posted && !reason.trim())
        throw new Error("Add a reason for this correction.");
      const c: WorkflowCommand = posted
        ? {
            type: "entry.correct",
            id,
            expected_version: entry!.version,
            replacement_id: replacementId,
            entry_date: entryDate,
            reversal_date: entry!.entry_date,
            memo,
            reason,
            lines,
          }
        : {
            type: review ? "transaction.review" : "transaction.save",
            id,
            expected_version: entry?.version ?? 0,
            entry_date: entryDate,
            memo,
            context: commandContext({
              ...context,
              kind: ["manual", "income", "expense"].includes(context.kind)
                ? direction === "in"
                  ? "income"
                  : "expense"
                : context.kind,
            }),
            lines,
          };
      if (await command.execute(c)) {
        if (remember && context.payee_id && descriptor)
          await command.execute({
            type: "alias.save",
            id: crypto.randomUUID(),
            expected_version: 0,
            party_id: context.payee_id,
            match_mode: "exact",
            description: descriptor,
            enabled: true,
          });
        dirty.current = false;
        onClose();
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Check the transaction details.",
      );
    }
  }

  const title = posted
    ? "Correct transaction"
    : entry
      ? "Edit transaction"
      : direction === "in"
        ? "Money in"
        : "Money out";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] max-w-xl flex-col overflow-hidden p-0"
        onEscapeKeyDown={(e) => {
          if (command.busy) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 pb-1 pl-4 pr-12 pt-6 sm:pl-6">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={cn(!posted && "sr-only")}>
            {posted
              ? "Saves a corrected copy and keeps the original in your history."
              : "Amount, description, account and category."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-4 pb-6 pt-4 [scrollbar-gutter:stable] sm:px-6">
          <form
            id="accounting-transaction-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-6"
          >
            <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
              <RadioGroup
                ariaLabel="Direction"
                orientation="horizontal"
                value={direction}
                onChange={(next) => change(() => setDirection(next))}
                options={[
                  {
                    value: "out",
                    label: (
                      <span className="flex items-center gap-2">
                        <ArrowUpRight size={14} aria-hidden="true" />
                        Money out
                      </span>
                    ),
                  },
                  {
                    value: "in",
                    label: (
                      <span className="flex items-center gap-2">
                        <ArrowDownLeft size={14} aria-hidden="true" />
                        Money in
                      </span>
                    ),
                  },
                ]}
              />
              <TextInput
                label="Amount"
                size="lg"
                prefix="$"
                inputMode="decimal"
                value={amount}
                placeholder="0.00"
                required
                inputClassName="font-semibold tabular-nums"
                onChange={(nextValue) =>
                  change(() => {
                    setAmount(nextValue);
                    if (splits.length === 1)
                      setSplits([{ ...splits[0], amount: nextValue }]);
                  })
                }
              />
            </div>
            <TextInput
              label="Description"
              placeholder="What was this for?"
              value={memo}
              required
              maxLength={1000}
              onChange={(nextValue) => change(() => setMemo(nextValue))}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <AccountingPicker
                label={direction === "out" ? "Paid from" : "Deposited to"}
                visibleLabel={
                  direction === "out" ? "Paid from" : "Deposited to"
                }
                value={account}
                options={accountOptions}
                onChange={(v) => change(() => setAccount(v))}
                placeholder="Choose a bank or card"
              />
              {splits.length === 1 ? (
                <AccountingPicker
                  label="Category"
                  visibleLabel="Category"
                  value={splits[0].account}
                  options={categoryOptions}
                  onChange={(v) =>
                    change(() => setSplits([{ ...splits[0], account: v }]))
                  }
                  placeholder="Choose a category"
                />
              ) : (
                <div>
                  <p className="mb-1.5 text-sm font-medium text-foreground">
                    Category
                  </p>
                  <div className="flex h-10 items-center rounded-xl border border-border px-3 text-sm text-muted-foreground">
                    Split across {splits.length} categories
                  </div>
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <DateInput
                label="Date"
                value={entryDate}
                required
                onChange={(nextValue) => change(() => setDate(nextValue))}
              />
              {posted ? (
                <TextInput
                  label="Reason for the correction"
                  value={reason}
                  required
                  placeholder="What changed and why"
                  onChange={(nextValue) => change(() => setReason(nextValue))}
                />
              ) : (
                <AccountingContextEditor
                  className="min-w-0"
                  value={context}
                  manage={manage}
                  onChange={(v) => change(() => setContext(v))}
                />
              )}
            </div>
            {!posted && context.payee_id && descriptor && (
              <Checkbox
                checked={remember}
                onChange={setRemember}
                label="Remember this payee for this bank description"
                description={`Future "${descriptor}" activity gets this payee automatically.`}
              />
            )}
            {splits.length > 1 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Split</h3>
                  <span
                    className={cn(
                      "text-xs",
                      remaining === BigInt(0)
                        ? "text-teal-light"
                        : "text-warning",
                    )}
                  >
                    {remaining !== null ? (
                      <>
                        <MaskedValue value={money(remaining)} /> left to assign
                      </>
                    ) : (
                      "Check amounts"
                    )}
                  </span>
                </div>
                <div className="divide-y divide-border rounded-xl border border-border">
                  {splits.map((s, i) => (
                    <div
                      key={s.key}
                      className="grid grid-cols-[1fr_110px_32px] items-center gap-2 p-3"
                    >
                      <AccountingPicker
                        label={`Split ${i + 1} category`}
                        value={s.account}
                        options={categoryOptions}
                        placeholder="Category"
                        onChange={(v) =>
                          change(() =>
                            setSplits(
                              splits.map((x) =>
                                x.key === s.key ? { ...x, account: v } : x,
                              ),
                            ),
                          )
                        }
                      />
                      <TextInput
                        aria-label={`Split ${i + 1} amount`}
                        inputMode="decimal"
                        placeholder="0.00"
                        inputClassName="tabular-nums"
                        value={s.amount}
                        onChange={(nextValue) =>
                          change(() =>
                            setSplits(
                              splits.map((x) =>
                                x.key === s.key
                                  ? { ...x, amount: nextValue }
                                  : x,
                              ),
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove split ${i + 1}`}
                        onClick={() =>
                          change(() =>
                            setSplits(splits.filter((x) => x.key !== s.key)),
                          )
                        }
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                      <TextInput
                        aria-label={`Split ${i + 1} note`}
                        className="col-span-3"
                        size="sm"
                        placeholder="Note (optional)"
                        value={s.memo}
                        onChange={(nextValue) =>
                          change(() =>
                            setSplits(
                              splits.map((x) =>
                                x.key === s.key ? { ...x, memo: nextValue } : x,
                              ),
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2"
                onClick={() =>
                  change(() =>
                    setSplits([
                      ...splits,
                      {
                        key: crypto.randomUUID(),
                        account: "",
                        amount:
                          remaining !== null && remaining > BigInt(0)
                            ? centsToDecimal(remaining)
                            : "",
                        memo: "",
                      },
                    ]),
                  )
                }
              >
                {splits.length === 1 ? (
                  <Scissors size={14} aria-hidden="true" />
                ) : (
                  <Plus size={14} aria-hidden="true" />
                )}
                {splits.length === 1
                  ? "Split across categories"
                  : "Add category"}
              </Button>
              {!posted && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={command.busy}
                  onClick={() => void openJournal()}
                >
                  Journal view
                </Button>
              )}
            </div>
          </form>
          {entry && (
            <EntryEvidenceDisclosure
              key={entry.id}
              className="mt-6"
              entryId={entry.id}
              accounts={accounts}
              parties={manage.parties}
            />
          )}
          {(error || command.error) && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-error/20 bg-error/5 p-3 text-sm text-error"
            >
              {error || command.error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-[rgba(var(--ink),0.04)] px-6 py-4">
          {!posted ? (
            <Checkbox
              checked={review}
              onChange={setReview}
              label="Mark as reviewed"
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              Original date {dateLabel(entry?.entry_date)}
            </span>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={command.busy}
              onClick={() => void close()}
            >
              Cancel
            </Button>
            <Button
              form="accounting-transaction-form"
              type="submit"
              disabled={command.busy}
            >
              {review && <Check size={15} aria-hidden="true" />}
              {command.busy
                ? "Saving..."
                : posted
                  ? "Save correction"
                  : review
                    ? "Save and review"
                    : "Save"}
            </Button>
          </div>
        </div>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
