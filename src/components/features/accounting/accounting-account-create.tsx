"use client";
import { useState } from "react";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { defaultChart } from "@/lib/accounting/chart";
import { AccountingPicker } from "./accounting-picker";
import { WorkflowDialog, WorkflowActions } from "./accounting-dialog";
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
  // Only assets and liabilities can be a bank, cash or card account.
  const useOptions = [
    { value: "none", label: "General category" },
    ...(type === "asset"
      ? [
          { value: "bank", label: "Bank account" },
          { value: "cash", label: "Cash / undeposited funds" },
        ]
      : []),
    ...(type === "liability" ? [{ value: "card", label: "Credit card" }] : []),
  ];
  return (
    <WorkflowDialog
      title="Add account"
      busy={cmd.busy}
      onClose={onClose}
      form
      size="sm"
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
        <TextInput
          label="Name"
          name="name"
          required
          maxLength={120}
          placeholder="For example: Website hosting"
        />
        {/* data-form-change keeps the dialog's discard guard aware of picks
            made through the portal-rendered select. */}
        <div data-form-change>
          <Select
            label="Type"
            value={type}
            options={accountTypes.map((t) => ({
              value: t,
              label: enumLabel(t),
            }))}
            onChange={(value) => {
              const next = value as AccountingAccount["account_type"];
              setType(next);
              setSide(["asset", "expense"].includes(next) ? "debit" : "credit");
              setCash("none");
              setPurpose("");
              setParent("");
            }}
          />
        </div>
        {useOptions.length > 1 && (
          <div data-form-change>
            <Select
              label="Account use"
              value={cash}
              options={useOptions}
              onChange={(value) => {
                const next = value as AccountProfile["cash_kind"];
                setCash(next);
                if (next !== "none")
                  setSide(next === "card" ? "credit" : "debit");
              }}
            />
          </div>
        )}
        <details className="group rounded-xl border border-border">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
            Advanced
          </summary>
          <div className="space-y-4 border-t border-border p-4">
            <TextInput label="Account code" name="code" maxLength={20} />
            <AccountingPicker
              label="Purpose"
              visibleLabel="Purpose"
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
            <TextInput
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
              <Select
                label="Normal balance"
                value={side}
                disabled={cash !== "none"}
                helperText="Change only for a contra account."
                options={[
                  { value: "debit", label: "Debit" },
                  { value: "credit", label: "Credit" },
                ]}
                onChange={(value) => setSide(value as "debit" | "credit")}
              />
            </div>
          </div>
        </details>
        <WorkflowActions
          busy={cmd.busy}
          error={cmd.error}
          label="Add"
          onClose={onClose}
        />
      </form>
    </WorkflowDialog>
  );
}
