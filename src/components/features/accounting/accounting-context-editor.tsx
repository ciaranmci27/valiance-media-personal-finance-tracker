"use client";
import type { EntryContext } from "@/lib/accounting/contracts";
import type { ManageData } from "@/lib/accounting/workflows";
import { Input } from "@/components/ui/input";
const select =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
export function AccountingContextEditor({
  value,
  manage,
  onChange,
}: {
  value: EntryContext;
  manage: ManageData;
  onChange: (value: EntryContext) => void;
}) {
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Payee, project & treatment
      </summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          Entry kind
          <select
            className={select}
            value={value.kind}
            onChange={(e) =>
              onChange({
                ...value,
                kind: e.target.value as EntryContext["kind"],
              })
            }
          >
            {[
              "manual",
              "income",
              "expense",
              "transfer",
              "payroll",
              "opening",
              "owner",
              "loan",
              "asset",
              "invoice_receipt",
              "refund",
            ].map((v) => (
              <option key={v} value={v}>
                {v.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Payee
          <select
            className={select}
            value={value.payee_id ?? ""}
            onChange={(e) =>
              onChange({ ...value, payee_id: e.target.value || null })
            }
          >
            <option value="">No payee</option>
            {manage.parties
              .filter((p) => !p.is_archived || p.id === value.payee_id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label className="text-sm">
          Customer
          <select
            className={select}
            value={value.customer_id ?? ""}
            onChange={(e) =>
              onChange({ ...value, customer_id: e.target.value || null })
            }
          >
            <option value="">No customer</option>
            {manage.parties
              .filter(
                (p) =>
                  p.kind !== "vendor" &&
                  (!p.is_archived || p.id === value.customer_id),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        {(["project", "business_line"] as const).map((kind) => (
          <label key={kind} className="text-sm">
            {kind === "project" ? "Project" : "Business line"}
            <select
              className={select}
              value={value[`${kind}_id`] ?? ""}
              onChange={(e) =>
                onChange({ ...value, [`${kind}_id`]: e.target.value || null })
              }
            >
              <option value="">None</option>
              {manage.dimensions
                .filter(
                  (d) =>
                    d.kind === kind &&
                    (!d.is_archived || d.id === value[`${kind}_id`]),
                )
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <label className="text-sm">
          Payment method
          <select
            className={select}
            value={value.payment_rail}
            onChange={(e) =>
              onChange({
                ...value,
                payment_rail: e.target.value as EntryContext["payment_rail"],
              })
            }
          >
            {[
              "unknown",
              "ach",
              "check",
              "cash",
              "card",
              "third_party",
              "wire",
              "other",
            ].map((v) => (
              <option key={v} value={v}>
                {v.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Contractor worksheet treatment
          <select
            className={select}
            value={value.contractor_treatment}
            onChange={(e) =>
              onChange({
                ...value,
                contractor_treatment: e.target
                  .value as EntryContext["contractor_treatment"],
              })
            }
          >
            <option value="unreviewed">Unreviewed</option>
            <option value="reportable">Include in reviewed worksheet</option>
            <option value="excluded">Exclude with explanation</option>
          </select>
        </label>
        {value.contractor_treatment === "excluded" && (
          <Input
            label="Exclusion reason"
            value={value.contractor_reason}
            required
            maxLength={1000}
            onChange={(e) =>
              onChange({ ...value, contractor_reason: e.target.value })
            }
          />
        )}
      </div>
    </details>
  );
}
