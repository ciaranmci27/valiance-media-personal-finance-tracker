"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/select";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { defaultChart } from "@/lib/accounting/chart";
import { AccountingPicker } from "./accounting-picker";
import { InvoiceDialog, InvoiceActions } from "./accounting-dialog";
import { useAccountingCommand } from "./use-accounting-command";
import { enumLabel } from "./format";

const accountTypes = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;

export function AccountingAccountCreate({
  accounts,
  profiles,
  onClose,
  onSaved,
}: {
  accounts: AccountingAccount[];
  profiles: AccountProfile[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [type, setType] =
    useState<AccountingAccount["account_type"]>("expense");
  const [side, setSide] = useState<"debit" | "credit">("debit");
  const [cash, setCash] = useState<AccountProfile["cash_kind"]>("none");
  const [purpose, setPurpose] = useState("");
  const [parent, setParent] = useState("");
  const cmd = useAccountingCommand(onSaved);
  const purposes = defaultChart.filter(
    (a) =>
      a.account_type === type && !profiles.some((p) => p.purpose === a.purpose),
  );
  return (
    <InvoiceDialog
      title="Add account"
      description="Create a category or a bank account, ready to use in your books."
      busy={cmd.busy}
      onClose={onClose}
      form
    >
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          const values = new FormData(e.currentTarget);
          const saved = await cmd.execute({
            type: "account.create",
            id,
            name: String(values.get("name")),
            code: String(values.get("code")),
            account_type: type,
            normal_side: side,
            cash_kind: cash,
            purpose: purpose || null,
            parent_account_id: parent || null,
            subtype: String(values.get("subtype") ?? ""),
          });
          if (saved) onClose();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Account name"
            name="name"
            required
            maxLength={120}
            placeholder="For example: Website hosting"
          />
          <Input label="Account code (optional)" name="code" maxLength={20} />
          {/* data-form-change keeps the dialog's discard guard aware of picks
              made through the portal-rendered select. */}
          <div data-form-change>
            <CustomSelect
              label="Type"
              value={type}
              options={accountTypes.map((t) => ({
                value: t,
                label: enumLabel(t),
              }))}
              onChange={(value) => {
                const next = value as AccountingAccount["account_type"];
                setType(next);
                setSide(
                  ["asset", "expense"].includes(next) ? "debit" : "credit",
                );
                setCash("none");
                setPurpose("");
                setParent("");
              }}
            />
          </div>
          <div data-form-change>
            <CustomSelect
              label="Account use"
              value={cash}
              options={[
                { value: "none", label: "General category" },
                ...(type === "asset"
                  ? [
                      { value: "bank", label: "Bank account" },
                      { value: "cash", label: "Cash / undeposited funds" },
                    ]
                  : []),
                ...(type === "liability"
                  ? [{ value: "card", label: "Credit card" }]
                  : []),
              ]}
              onChange={(value) => {
                const next = value as AccountProfile["cash_kind"];
                setCash(next);
                if (next !== "none")
                  setSide(next === "card" ? "credit" : "debit");
              }}
            />
          </div>
        </div>
        <div>
          <AccountingPicker
            label="Accounting purpose"
            visibleLabel="Accounting purpose"
            value={purpose}
            options={[
              { value: "", label: "General category" },
              ...purposes.map((a) => ({ value: a.purpose!, label: a.name })),
            ]}
            onChange={(value) => {
              setPurpose(value);
              const definition = purposes.find((a) => a.purpose === value);
              if (definition) {
                setCash(definition.cash_kind);
                setSide(definition.normal_side);
              }
            }}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Choose a purpose for payroll, transfers or other specialized tools.
            Purposes already assigned to another account are omitted.
          </p>
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Report grouping and advanced options
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Input
              label="Report group"
              name="subtype"
              maxLength={100}
              placeholder="For example: Operating expenses"
            />
            <AccountingPicker
              label="Parent account"
              visibleLabel="Parent account"
              value={parent}
              options={[
                { value: "", label: "No parent" },
                ...accounts
                  .filter(
                    (a) =>
                      a.account_type === type &&
                      !a.is_archived &&
                      !profiles.find((p) => p.account_id === a.id)
                        ?.parent_account_id,
                  )
                  .map((a) => ({ value: a.id, label: a.name })),
              ]}
              onChange={setParent}
            />
            <div data-form-change>
              <CustomSelect
                label="Normal balance"
                value={side}
                disabled={cash !== "none"}
                options={[
                  { value: "debit", label: "Debit" },
                  { value: "credit", label: "Credit" },
                ]}
                onChange={(value) => setSide(value as "debit" | "credit")}
              />
            </div>
            <p className="self-end text-xs leading-relaxed text-muted-foreground">
              The normal balance follows the account type. Change it only for a
              contra account, such as accumulated depreciation.
            </p>
          </div>
        </details>
        <InvoiceActions
          busy={cmd.busy}
          error={cmd.error}
          label="Create account"
          onClose={onClose}
        />
      </form>
    </InvoiceDialog>
  );
}
