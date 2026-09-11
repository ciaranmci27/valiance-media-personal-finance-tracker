"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useState } from "react";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Textarea } from "@/components/ui/inputs/Textarea";
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
  EvidencePicker,
  WorkflowActions,
  WorkflowDialog,
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
    asset = kind === "asset",
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
      const body = asset
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
        // The revision note is optional here; the command still needs one.
        reason:
          reason.trim() ||
          (record ? "Register details updated" : "Register created"),
      });
      if (result) {
        onClose();
        onOpen(result.id);
      }
    } catch (e) {
      setError(
        e instanceof Error && e.name === "ZodError"
          ? "Complete the required fields and accounts."
          : (e as Error).message,
      );
    }
  }
  return (
    <WorkflowDialog
      title={`${record ? "Edit" : "New"} ${kind}`}
      onClose={onClose}
      busy={command.busy}
      form
      size="sm"
    >
      <form className="space-y-5" onSubmit={save}>
        <fieldset disabled={command.busy} className="space-y-5">
          <TextInput
            label={asset ? "Asset name" : "Loan name"}
            required
            maxLength={160}
            value={values.name}
            onChange={(nextValue) => set("name", nextValue)}
          />
          {!asset && (
            <TextInput
              label="Lender"
              required
              maxLength={160}
              value={values.lender}
              onChange={(nextValue) => set("lender", nextValue)}
            />
          )}
          <fieldset disabled={fixed} className="space-y-5 disabled:opacity-70">
            <div className="grid gap-4 sm:grid-cols-2">
              <DateInput
                label={asset ? "Acquired on" : "Start date"}
                required
                value={values.started_on}
                onChange={(nextValue) => set("started_on", nextValue)}
              />
              <TextInput
                label={asset ? "Original cost" : "Original principal"}
                inputMode="decimal"
                placeholder="0.00"
                required
                value={values.amount}
                onChange={(nextValue) => set("amount", nextValue)}
              />
            </div>
            {asset && (
              <DateInput
                label="Placed in service"
                required
                value={values.in_service_on}
                onChange={(nextValue) => set("in_service_on", nextValue)}
              />
            )}
            <AccountingPicker
              label={asset ? "Asset account" : "Loan account"}
              visibleLabel={asset ? "Asset account" : "Loan account"}
              value={values.account_id}
              options={options(asset ? "asset" : "liability")}
              onChange={(v) => set("account_id", v)}
              disabled={fixed}
              placeholder="Choose an account"
            />
            <AccountingPicker
              label={asset ? "Depreciation expense" : "Interest expense"}
              visibleLabel={asset ? "Depreciation expense" : "Interest expense"}
              value={values.expense_account_id}
              options={options("expense")}
              onChange={(v) => set("expense_account_id", v)}
              disabled={fixed}
              placeholder="Choose an expense account"
            />
            {asset ? (
              <AccountingPicker
                label="Accumulated depreciation"
                visibleLabel="Accumulated depreciation"
                value={values.accumulated_account_id}
                options={options("asset", true)}
                onChange={(v) => set("accumulated_account_id", v)}
                disabled={fixed}
                placeholder="Choose a contra asset account"
              />
            ) : (
              <AccountingPicker
                label="Loan fee expense"
                visibleLabel="Loan fee expense"
                value={values.fee_account_id}
                options={options("expense")}
                onChange={(v) => set("fee_account_id", v)}
                disabled={fixed}
                placeholder="Choose a fee expense account"
              />
            )}
          </fieldset>
          {asset && (
            <TextInput
              label="Depreciation method"
              required
              maxLength={1000}
              placeholder="Straight line over five years"
              value={values.method}
              onChange={(nextValue) => set("method", nextValue)}
            />
          )}
          <details className="group rounded-xl border border-border">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
              Advanced
            </summary>
            <div className="space-y-4 border-t border-border p-4">
              <Textarea
                label={asset ? "Details" : "Terms"}
                maxLength={4000}
                rows={3}
                value={values.terms}
                onChange={(nextValue) => set("terms", nextValue)}
                placeholder={
                  asset
                    ? "Location, serial number or disposal notes"
                    : "Maturity, payment schedule and statement used for splits"
                }
              />
              <EvidencePicker value={doc} onChange={setDoc} />
              <TextInput
                label="Revision note"
                maxLength={1000}
                placeholder="Optional"
                value={reason}
                onChange={(nextValue) => setReason(nextValue)}
              />
            </div>
          </details>
        </fieldset>
        <WorkflowActions
          busy={command.busy}
          error={error || command.error}
          label="Save"
          onClose={onClose}
        />
      </form>
    </WorkflowDialog>
  );
}
