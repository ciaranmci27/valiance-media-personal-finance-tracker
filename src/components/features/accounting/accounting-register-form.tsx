"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { BooksMetadata } from "./types";
import {
  assetBodySchema,
  loanBodySchema,
  type RegisterDetail,
  type RegisterKind,
} from "@/lib/accounting/registers";
import { centsToDecimal } from "@/lib/accounting/money";
import { AccountingPicker } from "./accounting-picker";
import {
  InvoiceDialog,
  InvoiceEvidence,
  InvoiceActions,
  usdCents,
} from "./accounting-dialog";
import { useAccountingCommand } from "./use-accounting-command";
export function AccountingRegisterForm({
  kind,
  record,
  accounts,
  manage,
  today,
  onSaved,
  onClose,
  onOpen,
}: {
  kind: RegisterKind;
  record?: RegisterDetail;
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  today: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const original = record?.record.body as Record<string, string> | undefined;
  const [id] = useState(() => record?.id ?? crypto.randomUUID()),
    [values, setValues] = useState<Record<string, string>>(() => ({
      ...original,
      name: original?.name ?? "",
      started_on: original?.started_on ?? today,
      in_service_on: original?.in_service_on ?? today,
      amount: original ? centsToDecimal(original.initial_cents) : "",
      account_id: original?.account_id ?? "",
      expense_account_id: original?.expense_account_id ?? "",
      accumulated_account_id: original?.accumulated_account_id ?? "",
      fee_account_id: original?.fee_account_id ?? "",
      terms: original?.terms ?? "",
      method: original?.method ?? "",
      lender: original?.lender ?? "",
    })),
    [doc, setDoc] = useState(record?.record.document_id ?? ""),
    [reason, setReason] = useState(""),
    [error, setError] = useState("");
  const command = useAccountingCommand(onSaved),
    fixed = Boolean(record?.movement_count),
    profiles = new Map(manage.profiles.map((p) => [p.account_id, p]));
  const set = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const options = (type: string, credit = false) =>
    accounts
      .filter(
        (a) =>
          !a.is_archived &&
          a.account_type === type &&
          (profiles.get(a.id)?.cash_kind ?? "none") === "none" &&
          a.normal_side ===
            (credit || type === "liability" ? "credit" : "debit") &&
          ![
            "uncategorized_income",
            "uncategorized_expense",
            "opening_balance_equity",
            "opening_retained_earnings",
          ].includes(profiles.get(a.id)?.purpose ?? ""),
      )
      .map((a) => ({ value: a.id, label: a.name, keywords: a.code }));
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const base = {
        name: values.name,
        started_on: values.started_on,
        initial_cents: usdCents(values.amount).toString(),
        account_id: values.account_id,
        expense_account_id: values.expense_account_id,
        terms: values.terms,
      };
      const body =
        kind === "asset"
          ? assetBodySchema.parse({
              ...base,
              in_service_on: values.in_service_on,
              accumulated_account_id: values.accumulated_account_id,
              method: values.method,
            })
          : loanBodySchema.parse({
              ...base,
              lender: values.lender,
              fee_account_id: values.fee_account_id,
            });
      const result = await command.execute({
        type: "register.save",
        id,
        expected_version: record?.version ?? 0,
        kind,
        body,
        document_id: doc || null,
        reason,
      });
      if (result) {
        onClose();
        onOpen(result.id);
      }
    } catch (e) {
      setError(
        e instanceof Error && e.name === "ZodError"
          ? "Complete the dates, source details and required account mappings."
          : (e as Error).message,
      );
    }
  }
  const termsLabel =
    kind === "asset" ? "Asset notes" : "Terms and source schedule";
  return (
    <InvoiceDialog
      title={`${record ? "Edit" : "New"} ${kind === "asset" ? "asset" : "loan"}`}
      description="Save the register details, then record or link its reviewed journal entries. Saving these details alone changes no account balance."
      onClose={onClose}
      busy={command.busy}
    >
      <form className="space-y-5" onSubmit={save}>
        <fieldset disabled={command.busy} className="space-y-5">
          <Input
            label={kind === "asset" ? "Asset name" : "Loan name"}
            required
            maxLength={160}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
          />
          {fixed && (
            <p className="text-xs text-muted-foreground">
              Dates, original amounts and accounts are retained with the journal
              history. Descriptive details and source notes can be updated.
            </p>
          )}
          <fieldset disabled={fixed} className="space-y-4 disabled:opacity-70">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={
                  kind === "asset" ? "Acquisition date" : "Loan start date"
                }
                type="date"
                required
                value={values.started_on}
                onChange={(e) => set("started_on", e.target.value)}
              />
              <Input
                label={
                  kind === "asset"
                    ? "Original cost"
                    : "Original principal on schedule"
                }
                inputMode="decimal"
                required
                value={values.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
              {kind === "asset" && (
                <Input
                  label="Placed in service"
                  type="date"
                  required
                  value={values.in_service_on}
                  onChange={(e) => set("in_service_on", e.target.value)}
                />
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <AccountingPicker
                label={
                  kind === "asset" ? "Asset account" : "Loan principal account"
                }
                value={values.account_id}
                options={options(kind === "asset" ? "asset" : "liability")}
                onChange={(v) => set("account_id", v)}
                disabled={fixed}
                placeholder="Choose an account"
              />
              <AccountingPicker
                label={
                  kind === "asset"
                    ? "Depreciation expense account"
                    : "Interest expense account"
                }
                value={values.expense_account_id}
                options={options("expense")}
                onChange={(v) => set("expense_account_id", v)}
                disabled={fixed}
                placeholder="Choose an expense account"
              />
              {kind === "asset" ? (
                <AccountingPicker
                  label="Accumulated depreciation account"
                  value={values.accumulated_account_id}
                  options={options("asset", true)}
                  onChange={(v) => set("accumulated_account_id", v)}
                  disabled={fixed}
                  placeholder="Choose a credit-balance asset account"
                />
              ) : (
                <AccountingPicker
                  label="Loan fee expense account"
                  value={values.fee_account_id}
                  options={options("expense")}
                  onChange={(v) => set("fee_account_id", v)}
                  disabled={fixed}
                  placeholder="Choose a fee expense account"
                />
              )}
            </div>
          </fieldset>
          <a
            className="inline-block text-xs text-teal-light hover:underline"
            href="/accounting?view=accounts"
            target="_blank"
            rel="noreferrer"
          >
            Manage accounts
          </a>
          {kind === "asset" ? (
            <Input
              label="Depreciation method and source schedule"
              required
              maxLength={1000}
              placeholder="For example: annual amounts from the reviewed book schedule"
              value={values.method}
              onChange={(e) => set("method", e.target.value)}
            />
          ) : (
            <Input
              label="Lender"
              required
              maxLength={160}
              value={values.lender}
              onChange={(e) => set("lender", e.target.value)}
            />
          )}
          <Textarea
            label={termsLabel}
            aria-label={termsLabel}
            className="min-h-24"
            maxLength={4000}
            value={values.terms}
            onChange={(e) => set("terms", e.target.value)}
            placeholder={
              kind === "asset"
                ? "Location, identifying details or disposal considerations"
                : "Maturity, payment terms and the lender statement used for splits"
            }
          />
          <InvoiceEvidence value={doc} onChange={setDoc} />
          <Input
            label="Reason and source notes"
            required
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </fieldset>
        <InvoiceActions
          busy={command.busy}
          error={error || command.error}
          label="Save register"
          onClose={onClose}
        />
      </form>
    </InvoiceDialog>
  );
}
