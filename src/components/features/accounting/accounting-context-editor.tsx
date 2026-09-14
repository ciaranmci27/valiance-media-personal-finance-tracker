"use client";
import { useState } from "react";
import { Select } from "@/components/ui/inputs/Select";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { Party } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import type { CommandContext } from "./use-accounting-command";
import { PartyDialog, newParty } from "./accounting-party-form";

const NEW = "__new__";

/**
 * The optional detail on a transaction: who it was with. Everything else on
 * the context (entry kind, payment rail, contractor treatment) is derived or
 * lives on the contact, so the form stays one field. A contact that does not
 * exist yet is created right here, without leaving the transaction.
 */
export function AccountingContextEditor({
  value,
  manage,
  accounts,
  onChange,
  className,
}: {
  value: CommandContext;
  manage: BooksMetadata;
  accounts: AccountingAccount[];
  onChange: (value: CommandContext) => void;
  className?: string;
}) {
  // Contacts created from this editor show up before the books reload.
  const [created, setCreated] = useState<Party[]>([]);
  const [creating, setCreating] = useState<Party | null>(null);
  const known = new Set(manage.parties.map((p) => p.id));
  const payees = [
    ...manage.parties.filter((p) => !p.is_archived || p.id === value.payee_id),
    ...created.filter((p) => !known.has(p.id)),
  ];
  const groupOf = (p: Party) =>
    p.kind === "customer"
      ? "Customers"
      : p.kind === "both"
        ? "Vendors and customers"
        : p.tax_classification !== "unreviewed"
          ? "Contractors"
          : "Vendors";
  return (
    <div className={className ?? "grid gap-4 sm:grid-cols-2"}>
      <Select
        searchable
        label="Contact"
        visibleLabel="Contact"
        value={value.payee_id ?? ""}
        placeholder="No contact"
        emptyText="No contacts match. Choose New contact to add one."
        options={[
          { value: "", label: "No contact" },
          { value: NEW, label: "New contact", keywords: "add create payee" },
          ...payees.map((p) => ({
            value: p.id,
            label: p.name,
            group: groupOf(p),
          })),
        ]}
        onChange={(v) => {
          if (v === NEW) setCreating(newParty());
          else onChange({ ...value, payee_id: v || null });
        }}
      />
      <PartyDialog
        party={creating}
        accounts={accounts}
        onClose={() => setCreating(null)}
        onSaved={(party) => {
          setCreated((list) => [...list, party]);
          onChange({ ...value, payee_id: party.id });
          setCreating(null);
        }}
      />
    </div>
  );
}
