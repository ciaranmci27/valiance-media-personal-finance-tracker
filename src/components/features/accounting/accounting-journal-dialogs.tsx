"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { Party, WorkflowCommand } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import { AccountingContextEditor } from "./accounting-context-editor";
import { AccountingEvidence } from "./accounting-evidence";
import { commandContext, type CommandContext } from "./use-accounting-command";
import { absMoney, dateLabel, enumLabel, money } from "./format";

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
};

export type Approval = {
  entry: JournalEntry;
  type: "entry.post" | "entry.reverse" | "draft.discard";
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

/** The full journal view of one entry, with every action it supports. */
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
  onCopy,
  onCorrect,
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
  onCopy: (entry: JournalEntry) => void;
  onCorrect: (entry: JournalEntry) => void;
}) {
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entry?.memo}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{dateLabel(entry?.entry_date)}</span>
              {entry && (
                <Badge variant={STATUS_VARIANT[entry.status]} size="sm">
                  {entry.status === "posted"
                    ? "Reviewed"
                    : enumLabel(entry.status)}
                </Badge>
              )}
              <span>Source: {enumLabel(entry?.primary_origin)}</span>
            </div>
          </DialogDescription>
        </DialogHeader>
        {entry && (
          <>
            <div className="divide-y divide-border glass-card rounded-xl">
              {entry.lines.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
                >
                  <span className="min-w-0">
                    {accounts.get(l.account_id)?.name ?? "Account"}
                    {l.memo && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {l.memo}
                      </span>
                    )}
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    <span className="mr-1.5 text-xs text-muted-foreground">
                      {BigInt(l.amount_cents) > ZERO ? "Dr" : "Cr"}
                    </span>
                    <MaskedValue value={absMoney(l.amount_cents)} />
                  </span>
                </div>
              ))}
            </div>
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
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {entry.status === "draft" && (
                <>
                  <Button disabled={demo} onClick={() => onEdit(entry)}>
                    Edit draft
                  </Button>
                  <Button
                    disabled={demo}
                    variant="outline"
                    onClick={() => onPost(entry)}
                  >
                    <Check size={15} aria-hidden="true" />
                    Mark reviewed
                  </Button>
                  <Button
                    disabled={demo}
                    variant="ghost"
                    onClick={() => onDiscard(entry)}
                  >
                    Discard draft
                  </Button>
                </>
              )}
              {entry.status === "posted" && !entry.reversed_by_entry_id && (
                <>
                  <Button
                    disabled={demo}
                    variant="outline"
                    onClick={() => onCorrect(entry)}
                  >
                    Correct and replace
                  </Button>
                  <Button
                    disabled={demo}
                    variant="ghost"
                    onClick={() => onReverse(entry)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    Reverse
                  </Button>
                </>
              )}
              <Button
                disabled={demo}
                variant="ghost"
                onClick={() => onCopy(entry)}
              >
                <Copy size={14} aria-hidden="true" />
                Copy as draft
              </Button>
              {!demo && (
                <Link
                  className="self-center text-sm text-teal-light underline-offset-4 hover:underline"
                  href={`/accounting?${range}&entry=${entry.id}`}
                >
                  Open entry link
                </Link>
              )}
            </div>
            {!demo && (
              <AccountingEvidence
                entryId={entry.id}
                accounts={[...accounts.values()]}
                parties={parties}
              />
            )}
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
      lines: editor.lines.map((l) =>
        l.key === key ? { ...l, [field]: value } : l,
      ),
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

  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editor?.corrects
              ? "Prepare replacement"
              : editor?.version
                ? "Edit journal draft"
                : "New journal entry"}
          </DialogTitle>
          <DialogDescription>
            {editor?.corrects
              ? "Review the replacement before applying. The original, its reversal and the corrected entry stay linked."
              : "Save a draft first. Reviewing requires balanced debits and credits."}
          </DialogDescription>
        </DialogHeader>
        {editor && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
              <DateInput
                label="Date"
                required
                value={editor.date}
                onChange={(nextValue) =>
                  setEditor({ ...editor, date: nextValue })
                }
              />
              <TextInput
                label="Memo"
                required
                maxLength={1000}
                placeholder="What does this entry record?"
                value={editor.memo}
                onChange={(nextValue) =>
                  setEditor({ ...editor, memo: nextValue })
                }
              />
            </div>
            {editor.corrects && (
              <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
                <DateInput
                  label="Reverse original on"
                  required
                  value={editor.reversalDate ?? editor.corrects.entry_date}
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
                    setEditor({ ...editor, correctionReason: nextValue })
                  }
                />
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  To fix a misdated entry, reverse it on its original date and
                  use the correct date for the replacement.
                </p>
              </div>
            )}
            {!editor.corrects && (
              <AccountingContextEditor
                value={editor.context}
                manage={manage}
                onChange={(context) => setEditor({ ...editor, context })}
              />
            )}
            <div className="space-y-3">
              {editor.lines.map((l, index) => (
                <div
                  key={l.key}
                  className="grid grid-cols-[1fr_1fr_auto] gap-2 border-b border-border pb-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
                >
                  <div className="col-span-3 sm:col-span-1">
                    <Select
                      searchable
                      label={`Account ${index + 1}`}
                      visibleLabel={`Account ${index + 1}`}
                      value={l.account}
                      options={options}
                      placeholder="Choose account"
                      onChange={(v) => updateLine(l.key, "account", v)}
                    />
                  </div>
                  <TextInput
                    label="Debit"
                    inputMode="decimal"
                    placeholder="0.00"
                    className="tabular-nums"
                    value={l.debit}
                    onChange={(nextValue) =>
                      updateLine(l.key, "debit", nextValue)
                    }
                  />
                  <TextInput
                    label="Credit"
                    inputMode="decimal"
                    placeholder="0.00"
                    className="tabular-nums"
                    value={l.credit}
                    onChange={(nextValue) =>
                      updateLine(l.key, "credit", nextValue)
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="self-end"
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() =>
                      setEditor({
                        ...editor,
                        lines: editor.lines.filter((row) => row.key !== l.key),
                      })
                    }
                  >
                    <X size={15} aria-hidden="true" />
                  </Button>
                  <TextInput
                    aria-label={`Line ${index + 1} memo`}
                    placeholder="Line memo (optional)"
                    maxLength={500}
                    className="col-span-3 sm:col-span-4"
                    value={l.memo}
                    onChange={(nextValue) =>
                      updateLine(l.key, "memo", nextValue)
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
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
              <p
                className={cn(
                  "text-sm",
                  debit === credit ? "text-muted-foreground" : "text-warning",
                )}
              >
                {amountError || (
                  <>
                    Difference: <Money value={debit - credit} />
                  </>
                )}
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
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
              ? "Mark this entry reviewed?"
              : kind === "entry.reverse"
                ? "Reverse this entry"
                : "Discard this draft"}
          </DialogTitle>
          <DialogDescription>
            {approval?.entry.memo}.{" "}
            {kind === "entry.post"
              ? "Reviewed lines are locked and included in reports."
              : kind === "entry.reverse"
                ? "An equal and opposite entry is created. The original stays in the books."
                : "The draft stays in the audit history and leaves the active journal."}
          </DialogDescription>
        </DialogHeader>
        {approval && (
          <ApprovalForm
            key={approval.entry.id}
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
  const [date, setDate] = useState(defaultDate);
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
            : kind === "entry.reverse"
              ? {
                  ...common,
                  type: "entry.reverse",
                  entry_date: date,
                  reason,
                }
              : { ...common, type: "draft.discard", reason };
        if (await onSubmit(command)) onClose();
      }}
    >
      <div className="divide-y divide-border glass-card rounded-xl">
        {approval.entry.lines.map((l) => (
          <div
            key={l.id}
            className="flex justify-between gap-3 px-3 py-2 text-sm"
          >
            <span>{accounts.get(l.account_id)?.name}</span>
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
      {kind === "entry.reverse" && (
        <DateInput
          label="Reversal date"
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
            : kind === "entry.reverse"
              ? "Create reversal"
              : "Discard draft"}
        </Button>
      </div>
    </form>
  );
}

/** Final look at a correction before the reversal and replacement post together. */
export function ReplacementReviewDialog({
  review,
  accounts,
  busy,
  error,
  onApply,
  onBack,
}: {
  review: Extract<WorkflowCommand, { type: "entry.correct" }> | null;
  accounts: Map<string, AccountingAccount>;
  busy: boolean;
  error: string;
  onApply: () => void;
  onBack: () => void;
}) {
  return (
    <Dialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onBack();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply this correction?</DialogTitle>
          <DialogDescription>
            The original stays reviewed. One operation creates its reversal and
            the replacement below. If either fails, neither is applied.
          </DialogDescription>
        </DialogHeader>
        {review && (
          <div className="space-y-4">
            <div className="rounded-lg bg-[rgba(var(--ink),0.04)] p-4 text-sm">
              <p className="font-medium">{review.memo}</p>
              <p className="mt-1 text-muted-foreground">
                Reverse original on {dateLabel(review.reversal_date)}.
                Replacement dated {dateLabel(review.entry_date)}.
              </p>
              <p className="mt-1 text-muted-foreground">{review.reason}</p>
            </div>
            <div className="divide-y divide-border glass-card rounded-xl">
              {review.lines.map((l, i) => (
                <div key={i} className="flex justify-between px-3 py-2 text-sm">
                  <span>{accounts.get(l.account_id)?.name}</span>
                  <Money value={l.amount_cents} />
                </div>
              ))}
            </div>
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={onBack}>
                Back to editing
              </Button>
              <Button loading={busy} disabled={busy} onClick={onApply}>
                Apply correction
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
