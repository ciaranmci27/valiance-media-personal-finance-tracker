"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  RowActionsMenu,
  type RowAction,
} from "@/components/ui/row-actions-menu";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Badge } from "@/components/ui/badge";
import { MaskedValue } from "@/components/ui/masked-value";
import { Select } from "@/components/ui/inputs/Select";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  centsToDecimal,
  journalTotals,
  parseUsd,
} from "@/lib/accounting/money";
import { JournalTotals } from "./accounting-journal-totals";
import { correctionImpact } from "@/lib/accounting/correction-impact";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { Party, WorkflowCommand } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import { AccountingContextEditor } from "./accounting-context-editor";
import { EntryEvidenceDisclosure } from "./accounting-entry-evidence";
import { EntryNotes } from "./accounting-entry-notes";
import { commandContext, type CommandContext } from "./use-accounting-command";
import {
  absMoney,
  booksToday,
  dateLabel,
  enumLabel,
  money,
  originLabel,
  signedMoney,
} from "./format";
import {
  isTransactionReviewed,
  isTransactionReversed,
  canRestoreTransaction,
} from "@/lib/accounting/transactions";
import {
  AccountingAccountLabel,
  useAccountingBankIdentity,
} from "./accounting-bank-identity";

const ZERO = BigInt(0);

export type Editor = {
  context: CommandContext;
  corrects?: JournalEntry;
  correctionReason?: string;
  reversalDate?: string;
  id: string;
  version: number;
  date: string;
  memo: string;
  lines: {
    key: string;
    account: string;
    debit: string;
    credit: string;
    memo: string;
  }[];
  /** A note typed before the entry exists; the save sends it once there is an id. */
  note?: string;
};

export type Approval = {
  entry: JournalEntry;
  type: "entry.post" | "entry.reverse" | "entry.restore" | "draft.discard";
};

export function makeEditor(
  date: string,
  entry?: JournalEntry,
  copy = false,
): Editor {
  return {
    context: entry?.context
      ? commandContext(entry.context)
      : { kind: "manual", payee_id: null },
    id: copy || !entry ? crypto.randomUUID() : entry.id,
    version: copy ? 0 : (entry?.version ?? 0),
    date: copy ? date : (entry?.entry_date ?? date),
    memo: entry?.memo ?? "",
    lines:
      entry?.lines.map((l) => ({
        key: crypto.randomUUID(),
        account: l.account_id,
        debit:
          BigInt(l.amount_cents) > ZERO ? centsToDecimal(l.amount_cents) : "",
        credit:
          BigInt(l.amount_cents) < ZERO
            ? centsToDecimal(-BigInt(l.amount_cents))
            : "",
        memo: l.memo,
      })) ??
      [0, 1].map(() => ({
        key: crypto.randomUUID(),
        account: "",
        debit: "",
        credit: "",
        memo: "",
      })),
  };
}

function Money({ value }: { value: string | bigint }) {
  return <MaskedValue value={money(value)} className="tabular-nums" />;
}

const STATUS_VARIANT = {
  draft: "warning",
  posted: "success",
  discarded: "default",
} as const;

/** One entry in full: the amount, the accounts it moved between, and what can happen to it next. */
export function EntryDetailDialog({
  entry,
  accounts,
  parties,
  demo,
  range,
  onClose,
  onEdit,
  onPost,
  onDiscard,
  onReverse,
  onRestore,
  onCopy,
  onCorrect,
  busy = false,
  error = "",
  canReview = true,
}: {
  entry: JournalEntry | null;
  accounts: Map<string, AccountingAccount>;
  parties: Party[];
  demo: boolean;
  range: string;
  onClose: () => void;
  onEdit: (entry: JournalEntry) => void;
  onPost: (entry: JournalEntry) => void;
  onDiscard: (entry: JournalEntry) => void;
  onReverse: (entry: JournalEntry) => void;
  onRestore: (entry: JournalEntry) => void;
  onCopy: (entry: JournalEntry) => void;
  onCorrect: (entry: JournalEntry) => void;
  busy?: boolean;
  error?: string;
  canReview?: boolean;
}) {
  const bankIdentity = useAccountingBankIdentity();
  const reviewed = !!entry && isTransactionReviewed(entry);
  const totals = journalTotals(entry?.lines ?? []);
  const more: RowAction[] = entry
    ? [
        {
          label: "Copy as draft",
          icon: <Copy size={14} aria-hidden="true" />,
          onSelect: () => onCopy(entry),
          disabled: demo,
        },
        ...(entry.status === "posted" && !isTransactionReversed(entry)
          ? [
              {
                label: entry.payroll_run_id
                  ? "Open payroll to undo"
                  : "Reverse",
                icon: <RotateCcw size={14} aria-hidden="true" />,
                onSelect: () => onReverse(entry),
                disabled: demo,
                variant: "danger" as const,
                separator: true,
              },
            ]
          : []),
        ...(canRestoreTransaction(entry)
          ? [
              {
                label: "Restore transaction",
                icon: <RotateCcw size={14} />,
                onSelect: () => onRestore(entry),
                disabled: demo,
              },
            ]
          : []),
        ...(entry.status === "draft"
          ? [
              {
                label: "Discard draft",
                icon: <X size={14} aria-hidden="true" />,
                onSelect: () => onDiscard(entry),
                disabled: demo,
                variant: "danger" as const,
                separator: true,
              },
            ]
          : []),
      ]
    : [];
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pb-2 pt-6 pr-12">
          <DialogTitle className="leading-snug">{entry?.memo}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{dateLabel(entry?.entry_date)}</span>
              {entry && (
                <Badge
                  variant={
                    entry.status === "posted" && !reviewed
                      ? "warning"
                      : STATUS_VARIANT[entry.status]
                  }
                  size="sm"
                >
                  {isTransactionReversed(entry)
                    ? "Reversed"
                    : entry.status === "posted"
                      ? reviewed
                        ? "Reviewed"
                        : "Needs review"
                      : enumLabel(entry.status)}
                </Badge>
              )}
              <span>{originLabel(entry?.primary_origin)}</span>
            </div>
          </DialogDescription>
        </DialogHeader>
        {entry && (
          <>
            <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6 pt-3 [scrollbar-gutter:stable]">
              {error && (
                <p role="alert" className="text-sm text-error">
                  {error}
                </p>
              )}
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                <MaskedValue value={absMoney(totals.debit)} />
              </p>
              <div className="divide-y divide-border rounded-xl border border-border">
                {entry.lines.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="min-w-0">
                      {bankIdentity.accountIds.has(l.account_id) ? (
                        <AccountingAccountLabel
                          accountId={l.account_id}
                          name={accounts.get(l.account_id)?.name ?? "Account"}
                          size={32}
                          showInstitution
                        />
                      ) : (
                        <span className="block truncate">
                          {accounts.get(l.account_id)?.name ?? "Account"}
                        </span>
                      )}
                      {l.memo && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {l.memo}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "whitespace-nowrap tabular-nums",
                        BigInt(l.amount_cents) < ZERO &&
                          "text-muted-foreground",
                      )}
                    >
                      <MaskedValue value={signedMoney(l.amount_cents)} />
                    </span>
                  </div>
                ))}
              </div>
              <JournalTotals {...totals} />
              {entry.reverses_entry_id && (
                <p className="text-xs text-muted-foreground">
                  This reverses an earlier entry.{" "}
                  <Link
                    className="text-teal-light underline-offset-4 hover:underline"
                    href={`/accounting?${range}&entry=${entry.reverses_entry_id}`}
                  >
                    View original entry
                  </Link>
                </p>
              )}
              {entry.reversed_by_entry_id && (
                <p className="text-xs text-muted-foreground">
                  This entry has been reversed.{" "}
                  <Link
                    className="text-teal-light underline-offset-4 hover:underline"
                    href={`/accounting?${range}&entry=${entry.reversed_by_entry_id}`}
                  >
                    View reversal
                  </Link>
                  . Both stay in the books.
                </p>
              )}
              {entry.restored_by_entry_id && (
                <p className="text-sm text-muted-foreground">
                  Restored as a replacement transaction.{" "}
                  <Link
                    className="underline"
                    href={`/accounting?${range}&entry=${entry.restored_by_entry_id}`}
                  >
                    View restored transaction
                  </Link>
                </p>
              )}
              {entry.restore_workflow && isTransactionReversed(entry) && (
                <p className="text-sm text-muted-foreground">
                  This entry belongs to a {entry.restore_workflow} record.
                  {entry.restore_workflow === "transfer" ? (
                    " Record the transfer again from Transactions."
                  ) : (
                    <>
                      {" "}
                      <Link
                        className="underline"
                        href={
                          entry.restore_workflow === "payroll"
                            ? "/accounting?view=payroll"
                            : "/accounting?view=manage&section=registers"
                        }
                      >
                        {entry.restore_workflow === "payroll"
                          ? "Open Payroll"
                          : "Open Assets & loans"}
                      </Link>
                      {entry.restore_workflow === "payroll"
                        ? " to import the payroll report again."
                        : " to manage the linked activity."}
                    </>
                  )}
                </p>
              )}
              {!demo && (
                <EntryEvidenceDisclosure
                  key={entry.id}
                  entryId={entry.id}
                  accounts={[...accounts.values()]}
                  parties={parties}
                />
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-[rgba(var(--ink),0.04)] px-6 py-4">
              <div className="flex items-center gap-2">
                <RowActionsMenu
                  label={`More actions for ${entry.memo}`}
                  align="start"
                  actions={more.map((action) => ({
                    ...action,
                    disabled: busy || action.disabled,
                  }))}
                />
                {!demo && (
                  <Link
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    href={`/accounting?${range}&entry=${entry.id}`}
                  >
                    Entry link
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2">
                {entry.status === "draft" && (
                  <>
                    <Button
                      disabled={demo || busy}
                      variant="outline"
                      onClick={() => onEdit(entry)}
                    >
                      Edit draft
                    </Button>
                  </>
                )}
                {entry.status === "posted" && !isTransactionReversed(entry) && (
                  <Button
                    disabled={demo || busy}
                    variant="outline"
                    onClick={() => onCorrect(entry)}
                  >
                    Correct
                  </Button>
                )}
                {entry.status !== "discarded" &&
                  !isTransactionReversed(entry) && (
                    <Button
                      disabled={demo || busy || (!reviewed && !canReview)}
                      variant={reviewed ? "outline" : "default"}
                      aria-pressed={reviewed}
                      title={
                        !reviewed && !canReview
                          ? "Choose a category before reviewing"
                          : undefined
                      }
                      onClick={() => onPost(entry)}
                    >
                      {busy ? (
                        <Loader2
                          size={15}
                          aria-hidden="true"
                          className="animate-spin"
                        />
                      ) : (
                        <Check size={15} aria-hidden="true" />
                      )}
                      {busy
                        ? "Saving..."
                        : reviewed
                          ? "Mark unreviewed"
                          : "Mark reviewed"}
                    </Button>
                  )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Balanced multi-line journal editor, also used to prepare a correction. */
export function JournalEditorDialog({
  editor,
  setEditor,
  accounts,
  manage,
  busy,
  error,
  onSave,
  onClose,
}: {
  editor: Editor | null;
  setEditor: (next: Editor | null) => void;
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  busy: boolean;
  error: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const { confirm, dialog } = useConfirmationDialog();
  /**
   * The state the current editing session opened with. A session starts when
   * the dialog opens with an editor it has not shown before; the same editor
   * coming back after the replacement review continues its session.
   */
  const session = useRef<{
    last: Editor | null;
    open: boolean;
    initial: string;
  }>({ last: null, open: false, initial: "" });
  useEffect(() => {
    const s = session.current;
    if (editor) {
      if (!s.open && s.last !== editor) s.initial = JSON.stringify(editor);
      s.last = editor;
    }
    s.open = editor !== null;
  }, [editor]);
  // Edit the lines, or read and add notes. Every new session opens on the lines.
  const [tab, setTab] = useState<"edit" | "notes">("edit");
  const editorId = editor?.id;
  useEffect(() => setTab("edit"), [editorId]);
  const options = accounts
    .filter((a) => !a.is_archived)
    .map((a) => ({
      value: a.id,
      label: a.name,
      group: enumLabel(a.account_type),
      keywords: a.code,
    }))
    .sort(
      (a, b) =>
        a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );

  let debit = ZERO;
  let credit = ZERO;
  let amountError = "";
  if (editor) {
    try {
      for (const l of editor.lines) {
        const d = l.debit ? parseUsd(l.debit) : ZERO;
        const c = l.credit ? parseUsd(l.credit) : ZERO;
        if (d < ZERO || c < ZERO || (d > ZERO && c > ZERO))
          throw new Error("Use one positive debit or credit per line.");
        debit += d;
        credit += c;
      }
    } catch (e) {
      amountError = e instanceof Error ? e.message : "Check the amounts.";
    }
  }

  function updateLine(
    key: string,
    field: "account" | "debit" | "credit" | "memo",
    value: string,
  ) {
    if (!editor) return;
    setEditor({
      ...editor,
      lines: editor.lines.map((l) => {
        if (l.key !== key) return l;
        // A line is one side or the other: typing a debit clears the credit, and the reverse.
        if (field === "debit" && value.trim())
          return { ...l, debit: value, credit: "" };
        if (field === "credit" && value.trim())
          return { ...l, credit: value, debit: "" };
        return { ...l, [field]: value };
      }),
    });
  }

  async function close() {
    if (busy) return;
    const dirty =
      editor !== null && JSON.stringify(editor) !== session.current.initial;
    if (
      !dirty ||
      (await confirm({
        title: "Discard journal changes?",
        description: "Unsaved lines and amounts will be lost.",
        confirmLabel: "Discard",
        variant: "warning",
      }))
    )
      onClose();
  }

  // One row per line: what it was for, the account, and either a debit or a credit.
  const columns =
    "md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_8.5rem_8.5rem_2.25rem]";

  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className={cn(
          // The whole viewport: a working surface, not a prompt.
          "inset-0 left-0 top-0 flex h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0",
          "data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0",
        )}
      >
        <DialogHeader className="border-b border-border px-6 py-4 text-left sm:px-8">
          <DialogTitle>
            {editor?.corrects
              ? "Correct entry"
              : editor?.version
                ? "Edit journal entry"
                : "New journal entry"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Date, description and one line per debit or credit, with notes
            beside them.
          </DialogDescription>
        </DialogHeader>
        {editor && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
              <div className="mx-auto max-w-5xl space-y-6">
                <div
                  role="group"
                  aria-label="Editor section"
                  className="seg-track seg-sm mx-auto w-fit"
                >
                  {(["edit", "notes"] as const).map((section) => (
                    <button
                      key={section}
                      type="button"
                      aria-pressed={tab === section}
                      onClick={() => setTab(section)}
                      className={cn(
                        "seg-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        tab === section && "is-active",
                      )}
                    >
                      {section === "edit" ? "Edit" : "Notes"}
                    </button>
                  ))}
                </div>
                {tab === "notes" && (
                  <EntryNotes
                    entryId={editor.version > 0 ? editor.id : null}
                    pending={editor.note ?? ""}
                    onPending={(note) => setEditor({ ...editor, note })}
                  />
                )}
                {tab === "edit" && (
                  <>
                    <div className="grid gap-4 md:grid-cols-[11rem_minmax(0,1fr)_18rem]">
                      <DateInput
                        label="Date"
                        required
                        value={editor.date}
                        onChange={(nextValue) =>
                          setEditor({ ...editor, date: nextValue })
                        }
                      />
                      <TextInput
                        label="Description"
                        required
                        maxLength={1000}
                        placeholder="What does this entry record?"
                        value={editor.memo}
                        onChange={(nextValue) =>
                          setEditor({ ...editor, memo: nextValue })
                        }
                      />
                      {!editor.corrects && (
                        <AccountingContextEditor
                          className="min-w-0"
                          value={editor.context}
                          manage={manage}
                          onChange={(context) =>
                            setEditor({ ...editor, context })
                          }
                        />
                      )}
                    </div>
                    {editor.corrects && (
                      <div className="grid gap-4 md:grid-cols-[11rem_minmax(0,1fr)]">
                        <DateInput
                          label="Reverse original on"
                          required
                          value={
                            editor.reversalDate ?? editor.corrects.entry_date
                          }
                          onChange={(nextValue) =>
                            setEditor({ ...editor, reversalDate: nextValue })
                          }
                        />
                        <TextInput
                          label="Correction reason"
                          required
                          maxLength={1000}
                          value={editor.correctionReason ?? ""}
                          onChange={(nextValue) =>
                            setEditor({
                              ...editor,
                              correctionReason: nextValue,
                            })
                          }
                        />
                      </div>
                    )}
                    <div>
                      <div
                        aria-hidden="true"
                        className={cn(
                          "hidden gap-3 px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:grid",
                          columns,
                        )}
                      >
                        <span>Description</span>
                        <span>Account</span>
                        <span className="text-right">Debit</span>
                        <span className="text-right">Credit</span>
                        <span />
                      </div>
                      <div className="divide-y divide-border border-y border-border">
                        {editor.lines.map((l, index) => (
                          <div
                            key={l.key}
                            className={cn(
                              "grid gap-3 py-3 md:items-center md:px-3",
                              columns,
                            )}
                          >
                            <TextInput
                              aria-label={`Line ${index + 1} description`}
                              placeholder="Description"
                              maxLength={500}
                              value={l.memo}
                              onChange={(nextValue) =>
                                updateLine(l.key, "memo", nextValue)
                              }
                            />
                            <Select
                              searchable
                              label={`Line ${index + 1} account`}
                              value={l.account}
                              options={options}
                              placeholder="Choose account"
                              onChange={(v) => updateLine(l.key, "account", v)}
                            />
                            {/* Side by side on a phone, with their own captions; the table header names them on wide screens. */}
                            <div className="grid grid-cols-2 gap-3 md:contents">
                              {(["debit", "credit"] as const).map(
                                (sideName) => (
                                  <div key={sideName} className="min-w-0">
                                    <span
                                      aria-hidden="true"
                                      className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:hidden"
                                    >
                                      {sideName}
                                    </span>
                                    <TextInput
                                      aria-label={`Line ${index + 1} ${sideName}`}
                                      inputMode="decimal"
                                      placeholder="0.00"
                                      inputClassName="text-right tabular-nums"
                                      value={l[sideName]}
                                      onChange={(nextValue) =>
                                        updateLine(l.key, sideName, nextValue)
                                      }
                                    />
                                  </div>
                                ),
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="justify-self-end md:justify-self-center"
                              aria-label={`Remove line ${index + 1}`}
                              disabled={editor.lines.length <= 2}
                              onClick={() =>
                                setEditor({
                                  ...editor,
                                  lines: editor.lines.filter(
                                    (row) => row.key !== l.key,
                                  ),
                                })
                              }
                            >
                              <X size={15} aria-hidden="true" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={editor.lines.length >= 100}
                        onClick={() =>
                          setEditor({
                            ...editor,
                            lines: [
                              ...editor.lines,
                              {
                                key: crypto.randomUUID(),
                                account: "",
                                debit: "",
                                credit: "",
                                memo: "",
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={15} aria-hidden="true" />
                        Add line
                      </Button>
                      <div className="w-full md:w-80">
                        {amountError ? (
                          <p role="alert" className="text-sm text-error">
                            {amountError}
                          </p>
                        ) : (
                          <JournalTotals
                            compact
                            debit={debit}
                            credit={credit}
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
                {error && (
                  <p role="alert" className="text-sm text-error">
                    {error}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4 sm:px-8">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void close()}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || Boolean(amountError)}
                loading={busy}
              >
                {editor.corrects ? "Review correction" : "Save draft"}
              </Button>
            </div>
          </form>
        )}
        {dialog}
      </DialogContent>
    </Dialog>
  );
}

/** Confirm a post, reversal or discard with the lines in view. */
export function ApprovalDialog({
  approval,
  accounts,
  busy,
  error,
  defaultDate,
  onSubmit,
  onClose,
}: {
  approval: Approval | null;
  accounts: Map<string, AccountingAccount>;
  busy: boolean;
  error: string;
  defaultDate: string;
  onSubmit: (command: WorkflowCommand) => Promise<boolean>;
  onClose: () => void;
}) {
  const kind = approval?.type;
  return (
    <Dialog
      open={approval !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "entry.post"
              ? "Mark reviewed?"
              : kind === "entry.restore"
                ? "Restore transaction?"
                : kind === "entry.reverse"
                  ? "Reverse transaction?"
                  : "Discard draft"}
          </DialogTitle>
          <DialogDescription>{approval?.entry.memo}</DialogDescription>
        </DialogHeader>
        {approval && (
          <ApprovalForm
            key={`${approval.type}:${approval.entry.id}`}
            approval={approval}
            accounts={accounts}
            busy={busy}
            error={error}
            defaultDate={defaultDate}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Keyed on the entry id by the dialog, so date and reason start fresh per entry. */
function ApprovalForm({
  approval,
  accounts,
  busy,
  error,
  defaultDate,
  onSubmit,
  onClose,
}: {
  approval: Approval;
  accounts: Map<string, AccountingAccount>;
  busy: boolean;
  error: string;
  defaultDate: string;
  onSubmit: (command: WorkflowCommand) => Promise<boolean>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(
    approval.type === "entry.reverse" ? booksToday() : defaultDate,
  );
  const kind = approval.type;
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const common = {
          id: approval.entry.id,
          expected_version: approval.entry.version,
        };
        const command: WorkflowCommand =
          kind === "entry.post"
            ? { ...common, type: "entry.post" }
            : kind === "entry.reverse" || kind === "entry.restore"
              ? {
                  ...common,
                  type: kind,
                  entry_date: date,
                  reason,
                }
              : { ...common, type: "draft.discard", reason };
        if (await onSubmit(command)) onClose();
      }}
    >
      <div className="divide-y divide-border rounded-xl border border-border">
        {approval.entry.lines.map((l) => (
          <div
            key={l.id}
            className="flex justify-between gap-3 px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">
              {accounts.get(l.account_id)?.name}
            </span>
            <Money
              value={
                kind === "entry.reverse"
                  ? -BigInt(l.amount_cents)
                  : l.amount_cents
              }
            />
          </div>
        ))}
      </div>
      <JournalTotals
        {...journalTotals(
          approval.entry.lines.map((line) => ({
            amount_cents:
              kind === "entry.reverse"
                ? (-BigInt(line.amount_cents)).toString()
                : line.amount_cents,
          })),
        )}
      />
      {kind === "entry.reverse" && (
        <p className="text-sm text-muted-foreground">
          Creates an opposite entry on {dateLabel(date)}. The transaction moves
          to Reversed; reports before that date keep the original effect. Linked
          bank activity will not be automatically imported again.
        </p>
      )}
      {kind === "entry.restore" && (
        <p className="text-sm text-muted-foreground">
          Creates a replacement on {dateLabel(date)} and reconnects available
          bank evidence. The original and reversal remain in history. Choose a
          date on or after the reversal.
        </p>
      )}
      {kind === "draft.discard" && (
        <p className="text-sm text-muted-foreground">
          Removes this draft from the transaction list. Its history is retained.
        </p>
      )}
      {(kind === "entry.reverse" || kind === "entry.restore") && (
        <DateInput
          label={
            kind === "entry.restore" ? "Restoration date" : "Reversal date"
          }
          required
          value={date}
          onChange={(nextValue) => setDate(nextValue)}
        />
      )}
      {kind !== "entry.post" && (
        <TextInput
          label="Reason"
          required
          maxLength={1000}
          value={reason}
          onChange={(nextValue) => setReason(nextValue)}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={busy}>
          {kind === "entry.post"
            ? "Mark reviewed"
            : kind === "entry.restore"
              ? "Restore transaction"
              : kind === "entry.reverse"
                ? "Reverse transaction"
                : "Discard draft"}
        </Button>
      </div>
    </form>
  );
}

/** Final look at a correction before the reversal and replacement post together. */
export function ReplacementReviewDialog({
  review,
  original,
  accounts,
  busy,
  error,
  onApply,
  onBack,
}: {
  review: Extract<WorkflowCommand, { type: "entry.correct" }> | null;
  original: JournalEntry | null;
  accounts: Map<string, AccountingAccount>;
  busy: boolean;
  error: string;
  onApply: () => void;
  onBack: () => void;
}) {
  const impact =
    review && original
      ? correctionImpact(original.lines, review.lines, accounts)
      : [];
  const linked =
    !!original &&
    (!!original.matches?.length ||
      !!original.payroll_run_id ||
      !!original.restore_workflow);
  return (
    <Dialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onBack();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Apply correction?</DialogTitle>
          <DialogDescription>{review?.memo}</DialogDescription>
        </DialogHeader>
        {review && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Reverses the original on {dateLabel(review.reversal_date)} and
              posts the replacement on {dateLabel(review.entry_date)}.
              {review.reason ? ` Reason: ${review.reason}` : ""}
            </p>
            {!!impact.length && (
              <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
                <table className="w-full text-sm">
                  <caption className="px-3 py-2 text-left font-medium">
                    Effect on account balances
                  </caption>
                  <thead>
                    <tr className="border-y border-border bg-secondary/40">
                      <th className="p-3 text-left">Account</th>
                      <th className="p-3 text-right">Original</th>
                      <th className="p-3 text-right">Replacement</th>
                      <th className="p-3 text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-border last:border-0"
                      >
                        <td className="p-3">{row.name}</td>
                        <td className="p-3 text-right tabular-nums">
                          <Money value={row.before} />
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          <Money value={row.after} />
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {row.change === ZERO ? (
                            "Unchanged"
                          ) : (
                            <Money value={row.change} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!impact.length && (
              <section
                className="space-y-2 sm:hidden"
                aria-label="Effect on account balances"
              >
                <h3 className="text-sm font-medium">
                  Effect on account balances
                </h3>
                {impact.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-xl border border-border p-3 text-sm"
                  >
                    <p className="mb-2 font-medium">{row.name}</p>
                    <dl className="space-y-1">
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Original</dt>
                        <dd>
                          <Money value={row.before} />
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Replacement</dt>
                        <dd>
                          <Money value={row.after} />
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3 border-t border-border pt-1">
                        <dt>Change</dt>
                        <dd>
                          {row.change === ZERO ? (
                            "Unchanged"
                          ) : (
                            <Money value={row.change} />
                          )}
                        </dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </section>
            )}
            {original && (
              <p className="text-sm text-muted-foreground">
                {review.reversal_date !== original.entry_date
                  ? `The original remains effective from ${dateLabel(original.entry_date)} until its reversal on ${dateLabel(review.reversal_date)}. `
                  : `The original effect is canceled on ${dateLabel(original.entry_date)}. `}
                {review.entry_date.slice(0, 7) !==
                original.entry_date.slice(0, 7)
                  ? "The replacement affects a different month. "
                  : "The replacement stays in the same month. "}
                These are journal effects, not transfers of money at your bank.
                Both entries save together, and receipts remain attached.
              </p>
            )}
            {linked && (
              <p role="alert" className="text-sm text-warning">
                This entry has linked records. Resolve its bank matches or use
                its payroll, transfer, or register workflow before correcting
                it.
              </p>
            )}
            <div className="divide-y divide-border rounded-xl border border-border">
              {review.lines.map((l, i) => (
                <div
                  key={i}
                  className="flex justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {accounts.get(l.account_id)?.name}
                  </span>
                  <Money value={l.amount_cents} />
                </div>
              ))}
            </div>
            <JournalTotals {...journalTotals(review.lines)} />
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={onBack}>
                Back to editing
              </Button>
              <Button
                loading={busy}
                disabled={busy || linked || !original}
                onClick={onApply}
              >
                Apply correction
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
