"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { fieldLabelClass } from "@/components/ui/inputs/_shared";
import { useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { ReviewCheck } from "./accounting-review-check";
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
import { AccountingCategoryPicker } from "./accounting-category-picker";
import {
  categoryGroups,
  categoryKind,
  categoryMenu,
} from "@/lib/accounting/categories";
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
  // The category menu follows the direction; the entry's own category stays
  // visible only while the direction it was saved with is still selected.
  const baseGroups = useMemo(
    () => categoryGroups(accounts, manage.profiles, direction),
    [accounts, manage.profiles, direction],
  );
  const savedDirection = presentation?.bankLine
    ? presentation.amount < BigInt(0)
      ? "out"
      : "in"
    : null;
  const menu = categoryMenu(baseGroups, accounts, {
    current:
      direction === savedDirection
        ? presentation?.categoryLines[0]?.account_id
        : null,
    prior: entry?.prior_treatment,
    payeeDefault: manage.parties.find((p) => p.id === context.payee_id)
      ?.default_account_id,
  });

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
        title: "Edit as a journal entry?",
        description: "Unsaved changes here will be discarded.",
        confirmLabel: "Open journal editor",
        variant: "warning",
      }))
    )
      onJournal();
  }

  /** Accounts, amounts and memos as one comparable key, order independent. */
  function lineKey(
    lines: { account_id: string; amount_cents: string; memo?: string }[],
  ) {
    return lines
      .map((l) => `${l.account_id}|${BigInt(l.amount_cents)}|${l.memo ?? ""}`)
      .sort()
      .join("\n");
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
      // A reviewed transaction keeps its version when only the words change;
      // a money, date or category change saves a new version.
      const sameMoney =
        posted &&
        entryDate === entry!.entry_date &&
        lineKey(lines) === lineKey(entry!.lines);
      const c: WorkflowCommand = posted
        ? sameMoney
          ? {
              type: "entry.context",
              id,
              expected_version: entry!.version,
              memo,
              // The stored kind goes back unchanged: a reviewed transaction
              // only takes new words and a payee in place.
              kind: commandContext(entry!.context ?? defaultEntryContext).kind,
              payee_id: context.payee_id ?? null,
            }
          : {
              type: "entry.correct",
              id,
              expected_version: entry!.version,
              replacement_id: replacementId,
              entry_date: entryDate,
              reversal_date: entry!.entry_date,
              memo,
              reason: reason.trim() || "Edited in Transactions",
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
              // The chosen category decides the kind (a refund, an owner
              // movement); a split falls back to the direction.
              kind: [
                "manual",
                "income",
                "expense",
                "refund",
                "owner",
                "loan",
                "asset",
              ].includes(context.kind)
                ? ((splits.length === 1
                    ? categoryKind(
                        splits[0].account,
                        accounts,
                        manage.profiles,
                        direction,
                      )
                    : null) ?? (direction === "in" ? "income" : "expense"))
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

  const title = entry
    ? "Edit transaction"
    : direction === "in"
      ? "Deposit"
      : "Withdrawal";

  function chooseDirection(next: "in" | "out") {
    if (next === direction) return;
    change(() => {
      setDirection(next);
      // A category the new direction does not offer is cleared, not guessed.
      const offered = new Set(
        categoryGroups(accounts, manage.profiles, next).flatMap((g) =>
          g.options.map((o) => o.value),
        ),
      );
      setSplits(
        splits.map((s) => (offered.has(s.account) ? s : { ...s, account: "" })),
      );
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden p-0"
        onEscapeKeyDown={(e) => {
          if (command.busy) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-14 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={cn(!posted && "sr-only")}>
            {posted
              ? "Amount, date or category changes save a new version. The earlier version stays in your history."
              : "Amount, description, account and category."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-6 py-6 [scrollbar-gutter:stable]">
          <form
            id="accounting-transaction-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-5"
          >
            {/* Which way the money went and when, then how much, large. */}
            <div className="flex flex-wrap items-end justify-between gap-4">
              {/* Same shape as the field beside it: a caption, then the control. */}
              <div className="space-y-1.5">
                <p
                  id="accounting-transaction-type"
                  className={fieldLabelClass()}
                >
                  Type
                </p>
                <div
                  role="group"
                  aria-labelledby="accounting-transaction-type"
                  className="seg-track"
                >
                  {(["in", "out"] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={direction === d}
                      onClick={() => chooseDirection(d)}
                      className={cn(
                        "seg-item gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        direction === d && "is-active",
                      )}
                    >
                      {d === "in" ? (
                        <ArrowDownLeft size={14} aria-hidden="true" />
                      ) : (
                        <ArrowUpRight size={14} aria-hidden="true" />
                      )}
                      {d === "in" ? "Deposit" : "Withdrawal"}
                    </button>
                  ))}
                </div>
              </div>
              <DateInput
                label="Date"
                className="w-44"
                value={entryDate}
                required
                onChange={(nextValue) => change(() => setDate(nextValue))}
              />
            </div>
            <TextInput
              label="Amount"
              size="lg"
              prefix="$"
              inputMode="decimal"
              value={amount}
              placeholder="0.00"
              required
              // The number itself is the headline; the field's own size class sits on the input, so the override targets it.
              className="[&_input]:text-2xl [&_input]:font-semibold [&_input]:tabular-nums"
              onChange={(nextValue) =>
                change(() => {
                  setAmount(nextValue);
                  if (splits.length === 1)
                    setSplits([{ ...splits[0], amount: nextValue }]);
                })
              }
            />
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
                <AccountingCategoryPicker
                  label="Category"
                  visibleLabel="Category"
                  value={splits[0].account}
                  groups={menu}
                  direction={direction}
                  onChange={(v) =>
                    change(() => setSplits([{ ...splits[0], account: v }]))
                  }
                  placeholder="Choose a category"
                />
              ) : (
                <TextInput
                  label="Category"
                  value={`Split across ${splits.length} categories`}
                  readOnly
                  onChange={() => {}}
                />
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <AccountingContextEditor
                className="min-w-0"
                value={context}
                manage={manage}
                accounts={accounts}
                onChange={(v) => change(() => setContext(v))}
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:self-end sm:pb-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
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
                  {splits.length === 1 ? "Split entry" : "Add category"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={command.busy}
                  onClick={() => void openJournal()}
                >
                  <BookOpen size={14} aria-hidden="true" />
                  Journal view
                </Button>
              </div>
            </div>
            {posted && (
              <TextInput
                label="Note"
                value={reason}
                maxLength={1000}
                placeholder="Optional"
                onChange={(nextValue) => change(() => setReason(nextValue))}
              />
            )}
            {!posted && context.payee_id && descriptor && (
              <Checkbox
                checked={remember}
                onChange={setRemember}
                label="Remember this contact for this bank description"
                description={`Future "${descriptor}" activity gets this contact automatically.`}
              />
            )}
            {splits.length > 1 && (
              <section className="space-y-2" aria-label="Split">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Split
                  </h3>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
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
                      className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] items-center gap-2 p-3"
                    >
                      <AccountingCategoryPicker
                        label={`Split ${i + 1} category`}
                        value={s.account}
                        groups={categoryMenu(baseGroups, accounts, {
                          current: s.account,
                        })}
                        direction={direction}
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
                        inputClassName="text-right tabular-nums"
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
              </section>
            )}
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
            <div className="flex items-center gap-2">
              <ReviewCheck
                reviewed={review}
                categorized={
                  splits.length > 0 &&
                  splits.every(
                    (s) =>
                      s.account !== "" &&
                      !manage.profiles.some(
                        (p) =>
                          p.account_id === s.account &&
                          p.purpose?.startsWith("uncategorized"),
                      ),
                  )
                }
                name={memo || "this transaction"}
                disabled={command.busy}
                onToggle={() => change(() => setReview(!review))}
              />
              <span className="text-sm">
                {review ? "Reviewed on save" : "Mark as reviewed"}
              </span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              Original date {dateLabel(entry?.entry_date)}
            </span>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
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
                  ? "Save changes"
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
