"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { formatCents, parseUsd } from "@/lib/accounting/money";
import { AccountingDocumentPicker } from "./accounting-document-picker";
type Line = { account_id: string; amount_cents: string };
export type RetainedReviewInput = {
  documentId: string;
  amounts: Record<string, string>;
};
export const emptyRetainedReview = (): RetainedReviewInput => ({
  documentId: "",
  amounts: {},
});
function totals(lines: Line[]) {
  const result = new Map<string, bigint>();
  for (const line of lines)
    result.set(
      line.account_id,
      (result.get(line.account_id) ?? BigInt(0)) + BigInt(line.amount_cents),
    );
  return Array.from(result, ([account_id, amount]) => ({ account_id, amount }));
}
function sourceError(raw: string | undefined, expected: bigint) {
  if (!raw) return "";
  try {
    return parseUsd(raw) === expected
      ? ""
      : "Source balance differs from this journal.";
  } catch {
    return "Enter a valid USD amount without commas.";
  }
}
export function readRetainedReview(lines: Line[], value: RetainedReviewInput) {
  if (!value.documentId) return null;
  try {
    const controls = totals(lines).map(({ account_id, amount }) => {
      const actual = parseUsd(value.amounts[account_id] ?? "");
      if (actual !== amount) throw Error("Source difference");
      return { account_id, amount_cents: actual.toString() };
    });
    return { document_id: value.documentId, controls };
  } catch {
    return null;
  }
}
export function RetainedReviewFields({
  lines,
  accounts,
  value,
  onChange,
}: {
  lines: Line[];
  accounts: AccountingAccount[];
  value: RetainedReviewInput;
  onChange: (value: RetainedReviewInput) => void;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-amber-500/30 p-4">
      <div>
        <h3 className="text-sm font-medium">Retained earnings source review</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the supporting report balance for each account. Use positive
          amounts for debits and negative amounts for credits.
        </p>
      </div>
      <AccountingDocumentPicker
        value={value.documentId}
        onChange={(documentId) => onChange({ ...value, documentId })}
        label="Opening or correction evidence"
      />
      <div className="space-y-3">
        {totals(lines).map(({ account_id, amount }) => (
          <div key={account_id} className="grid items-end gap-2 sm:grid-cols-2">
            <div className="text-sm">
              <p>
                {accounts.find((a) => a.id === account_id)?.name ?? "Account"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Journal balance: <MaskedValue value={formatCents(amount)} />
              </p>
            </div>
            <div>
              <Input
                label={`Source balance: ${accounts.find((a) => a.id === account_id)?.name ?? "account"}`}
                id={`retained-source-${account_id}`}
                error={!!sourceError(value.amounts[account_id], amount)}
                aria-invalid={!!sourceError(value.amounts[account_id], amount)}
                aria-describedby={
                  sourceError(value.amounts[account_id], amount)
                    ? `retained-source-error-${account_id}`
                    : undefined
                }
                inputMode="decimal"
                placeholder="Debit + / credit -"
                value={value.amounts[account_id] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    amounts: { ...value.amounts, [account_id]: e.target.value },
                  })
                }
              />
              {sourceError(value.amounts[account_id], amount) && (
                <p
                  id={`retained-source-error-${account_id}`}
                  className="mt-1 text-xs text-destructive"
                >
                  {sourceError(value.amounts[account_id], amount)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Posting retains this comparison with the exact journal and evidence.
        Complete the historical report checks separately to verify year
        coverage.
      </p>
    </section>
  );
}
export function AccountingRetainedPost({
  entry,
  accounts,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  entry: JournalEntry;
  accounts: AccountingAccount[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (command: WorkflowCommand) => Promise<boolean>;
}) {
  const [value, setValue] = useState(emptyRetainedReview),
    [reason, setReason] = useState("");
  const reviewed = readRetainedReview(entry.lines, value);
  const close = () => {
    if (busy) return;
    if (
      (reason || value.documentId || Object.keys(value.amounts).length) &&
      !window.confirm("Discard the unsaved opening-balance review?")
    )
      return;
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review opening retained earnings</DialogTitle>
          <DialogDescription>
            {entry.memo} · {entry.entry_date}. Compare this balance-sheet
            opening to its supporting report before posting.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-4">
          <RetainedReviewFields
            lines={entry.lines}
            accounts={accounts}
            value={value}
            onChange={setValue}
          />
          <Input
            label="Opening balance explanation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={3000}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={close}>
              Back
            </Button>
            <Button
              disabled={busy || !reviewed || !reason.trim()}
              loading={busy}
              onClick={async () => {
                if (
                  reviewed &&
                  (await onSubmit({
                    type: "retained.post",
                    id: entry.id,
                    expected_version: entry.version,
                    ...reviewed,
                    reason,
                  }))
                )
                  onClose();
              }}
            >
              Post reviewed opening
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
