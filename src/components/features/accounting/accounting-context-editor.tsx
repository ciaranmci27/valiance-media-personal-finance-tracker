"use client";
import { Select } from "@/components/ui/inputs/Select";
import type { BooksMetadata } from "./types";
import type { CommandContext } from "./use-accounting-command";

/**
 * The optional detail on a transaction: who it was with. Everything else on
 * the context (entry kind, payment rail, contractor treatment) is derived or
 * lives on the payee, so the form stays one field. The values not shown are
 * passed through untouched.
 */
export function AccountingContextEditor({
  value,
  manage,
  onChange,
  className,
}: {
  value: CommandContext;
  manage: BooksMetadata;
  onChange: (value: CommandContext) => void;
  className?: string;
}) {
  const payees = manage.parties.filter(
    (p) => !p.is_archived || p.id === value.payee_id,
  );
  return (
    <div className={className ?? "grid gap-4 sm:grid-cols-2"}>
      <Select
        searchable
        label="Payee"
        visibleLabel="Payee"
        value={value.payee_id ?? ""}
        placeholder="No payee"
        emptyText="No payees match. Add one under Rules & payees."
        options={[
          { value: "", label: "No payee" },
          ...payees.map((p) => ({
            value: p.id,
            label: p.name,
            group: p.kind === "customer" ? "Customers" : "Vendors",
          })),
        ]}
        onChange={(v) => onChange({ ...value, payee_id: v || null })}
      />
    </div>
  );
}
