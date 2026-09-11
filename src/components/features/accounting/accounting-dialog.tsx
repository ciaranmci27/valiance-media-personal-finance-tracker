"use client";
import { createContext, useContext, useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { cn } from "@/lib/utils";
import { parseUsd } from "@/lib/accounting/money";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { BooksMetadata } from "./types";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { accountingGet } from "./use-accounting-command";
import { money } from "./format";

/**
 * Shared chrome for accounting workflow dialogs: a scrolling body, a sticky
 * action footer, evidence picker, money display and the small helpers the
 * forms share. Feature files import from here so no screen depends on
 * another feature's module.
 */

export function DialogMoney({
  cents,
  className = "",
}: {
  cents: string | bigint | null;
  className?: string;
}) {
  if (cents === null)
    return <span className={cn("text-muted-foreground", className)}>...</span>;
  return (
    <MaskedValue
      value={money(cents)}
      className={cn("tabular-nums", className)}
    />
  );
}

const CloseContext = createContext<(() => void) | null>(null);

export function WorkflowDialog({
  title,
  description,
  children,
  busy,
  onClose,
  form = false,
  size = "lg",
}: {
  title: string;
  /** One short line only when it changes what the owner will do; otherwise omit it. */
  description?: string;
  children: ReactNode;
  busy?: boolean;
  onClose: () => void;
  /** Track edits inside the body and confirm before discarding them. */
  form?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const dirty = useRef(false);
  const { confirm, dialog } = useConfirmationDialog();
  async function close() {
    if (busy) return;
    if (
      !dirty.current ||
      (await confirm({
        title: "Discard changes?",
        description: "Your unsaved edits will be lost.",
        confirmLabel: "Discard",
        variant: "warning",
      }))
    )
      onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className={cn(
          "flex max-h-[92vh] flex-col overflow-hidden p-0",
          size === "lg"
            ? "max-w-4xl"
            : size === "md"
              ? "max-w-2xl"
              : "max-w-md",
        )}
      >
        <CloseContext.Provider value={() => void close()}>
          <DialogHeader className="shrink-0 px-6 pb-1 pt-6 pr-12">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className={cn(!description && "sr-only")}>
              {description ?? title}
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 overflow-y-auto px-6 pb-5 pt-4 [scrollbar-gutter:stable]"
            onClickCapture={(e) => {
              if (
                form &&
                (e.target as HTMLElement).closest(
                  '[role="menuitem"], [role="option"], [data-form-change]',
                )
              )
                dirty.current = true;
            }}
            onChange={() => {
              if (form) dirty.current = true;
            }}
          >
            {children}
          </div>
          {dialog}
        </CloseContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

export function EvidencePicker({
  value,
  onChange,
  required = false,
}: {
  value: string;
  onChange: (id: string) => void;
  required?: boolean;
}) {
  return (
    <AccountingDocumentPicker
      value={value}
      onChange={onChange}
      required={required}
      label={
        required
          ? "Supporting document (required)"
          : "Supporting document (optional)"
      }
    />
  );
}

export function WorkflowActions({
  busy,
  error,
  label,
  onClose,
  disabled = false,
}: {
  busy: boolean;
  disabled?: boolean;
  error: string;
  label: string;
  onClose: () => void;
}) {
  const guardedClose = useContext(CloseContext);
  return (
    <div className="sticky -bottom-5 z-10 -mx-6 -mb-5 space-y-3 border-t border-border bg-[var(--background-subtle)] px-6 py-4">
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
          onClick={guardedClose ?? onClose}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy || disabled}>
          {busy ? "Saving..." : label}
        </Button>
      </div>
    </div>
  );
}

export function accountOptions(
  accounts: AccountingAccount[],
  manage: BooksMetadata,
  kind: "bank" | "income" | "expense" | "liability" | "reimbursement",
) {
  const profiles = new Map(manage.profiles.map((p) => [p.account_id, p]));
  return accounts
    .filter(
      (a) =>
        !a.is_archived &&
        !profiles.get(a.id)?.purpose?.startsWith("uncategorized") &&
        (kind === "bank"
          ? ["bank", "cash"].includes(profiles.get(a.id)?.cash_kind ?? "none")
          : kind === "reimbursement"
            ? a.account_type === "income" ||
              (a.account_type === "asset" &&
                (profiles.get(a.id)?.cash_kind ?? "none") === "none")
            : a.account_type === kind),
    )
    .map((a) => ({
      value: a.id,
      label: a.name,
      group: a.account_type[0].toUpperCase() + a.account_type.slice(1),
      keywords: a.code,
    }));
}

export function usdCents(value: string, positive = false) {
  const cents = parseUsd(value || "0");
  if (cents < BigInt(0) || (positive && cents === BigInt(0)))
    throw new Error(
      positive
        ? "Enter an amount greater than zero."
        : "Amounts cannot be negative.",
    );
  return cents;
}

export async function linkedEntry(id: string): Promise<JournalEntry> {
  if (!id) throw new Error("Choose the existing reviewed transaction.");
  const result = await accountingGet<{ entries: JournalEntry[] }>({
    view: "register",
    filter: JSON.stringify({ entry_id: id, limit: 1 }),
  });
  const entry = result.entries[0];
  if (!entry || entry.status !== "posted" || entry.reversed_by_entry_id)
    throw new Error(
      "Choose a reviewed transaction that has not been reversed.",
    );
  return entry;
}

// Former names, so screens can move over one import line at a time.
export {
  DialogMoney as InvoiceMoney,
  WorkflowDialog as InvoiceDialog,
  EvidencePicker as InvoiceEvidence,
  WorkflowActions as InvoiceActions,
  accountOptions as invoiceAccountOptions,
  linkedEntry as invoiceLinkedEntry,
};
