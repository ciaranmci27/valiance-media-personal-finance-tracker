"use client";
import { useState } from "react";
import { Select } from "@/components/ui/inputs/Select";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { RadioGroup } from "@/components/ui/inputs/RadioGroup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Party } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import {
  useAccountingCommand,
  type CommandContext,
} from "./use-accounting-command";

const NEW = "__new__";

/**
 * The optional detail on a transaction: who it was with. Everything else on
 * the context (entry kind, payment rail, contractor treatment) is derived or
 * lives on the payee, so the form stays one field. A payee that does not
 * exist yet is created right here, without leaving the transaction.
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
  // Payees created from this editor show up before the books reload.
  const [created, setCreated] = useState<Party[]>([]);
  const [creating, setCreating] = useState(false);
  const known = new Set(manage.parties.map((p) => p.id));
  const payees = [
    ...manage.parties.filter((p) => !p.is_archived || p.id === value.payee_id),
    ...created.filter((p) => !known.has(p.id)),
  ];
  const groupOf = (kind: Party["kind"]) =>
    kind === "customer"
      ? "Customers"
      : kind === "both"
        ? "Vendors and customers"
        : "Vendors";
  return (
    <div className={className ?? "grid gap-4 sm:grid-cols-2"}>
      <Select
        searchable
        label="Payee"
        visibleLabel="Payee"
        value={value.payee_id ?? ""}
        placeholder="No payee"
        emptyText="No payees match. Choose New payee to add one."
        options={[
          { value: "", label: "No payee" },
          { value: NEW, label: "New payee", keywords: "add create" },
          ...payees.map((p) => ({
            value: p.id,
            label: p.name,
            group: groupOf(p.kind),
          })),
        ]}
        onChange={(v) => {
          if (v === NEW) setCreating(true);
          else onChange({ ...value, payee_id: v || null });
        }}
      />
      {creating && (
        <NewPayeeDialog
          onClose={() => setCreating(false)}
          onCreated={(party) => {
            setCreated((list) => [...list, party]);
            onChange({ ...value, payee_id: party.id });
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function NewPayeeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (party: Party) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Party["kind"]>("vendor");
  const command = useAccountingCommand();
  const party: Party = {
    id: crypto.randomUUID(),
    version: 0,
    name: name.trim(),
    kind,
    default_account_id: null,
    tax_classification: "unreviewed",
    documentation: "missing",
    notes: "",
    is_archived: false,
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New payee</DialogTitle>
          <DialogDescription className="sr-only">
            Name and relationship for the new payee.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-2 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!party.name) return;
            const { version, ...fields } = party;
            if (
              await command.execute({
                type: "party.save",
                ...fields,
                expected_version: version,
                is_contractor: false,
              })
            )
              onCreated({ ...party, version: 1 });
          }}
        >
          <TextInput
            label="Name"
            value={name}
            onChange={setName}
            required
            maxLength={120}
            placeholder="Who the money went to, or came from"
          />
          <RadioGroup
            label="Relationship"
            orientation="horizontal"
            value={kind}
            onChange={setKind}
            options={[
              { value: "vendor", label: "Vendor" },
              { value: "customer", label: "Customer" },
              { value: "both", label: "Both" },
            ]}
          />
          {command.error && (
            <p role="alert" className="text-sm text-error">
              {command.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={command.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={command.busy || !party.name}
              loading={command.busy}
            >
              Add payee
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
