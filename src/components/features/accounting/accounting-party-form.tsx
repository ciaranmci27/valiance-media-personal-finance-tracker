"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { Textarea } from "@/components/ui/inputs/Textarea";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { RadioGroup } from "@/components/ui/inputs/RadioGroup";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { Party } from "@/lib/accounting/workflows";
import { enumLabel } from "./format";
import { useAccountingCommand } from "./use-accounting-command";

/** A contact with nothing filled in yet. */
export function newParty(): Party {
  return {
    id: crypto.randomUUID(),
    version: 0,
    name: "",
    kind: "vendor",
    default_account_id: null,
    tax_classification: "unreviewed",
    documentation: "missing",
    notes: "",
    is_archived: false,
  };
}

/** How the owner relates to a contact, read from the stored kind and contractor status. */
export function partyRelationship(
  party: Pick<Party, "kind" | "tax_classification">,
): "vendor" | "customer" | "contractor" | "both" {
  return party.kind === "customer"
    ? "customer"
    : party.kind === "both"
      ? "both"
      : party.tax_classification !== "unreviewed"
        ? "contractor"
        : "vendor";
}

const RELATIONSHIP_LABEL = {
  vendor: "Vendor",
  customer: "Customer",
  contractor: "Contractor",
  both: "Vendor and customer",
} as const;

/** The relationship in plain words, for places that only show a contact. */
export function partyRelationshipLabel(
  party: Pick<Party, "kind" | "tax_classification">,
): string {
  return RELATIONSHIP_LABEL[partyRelationship(party)];
}

/**
 * What a list shows beside a description: the relationship, plus the
 * contact's name unless the description already says it.
 */
export function contactAffiliation(
  description: string,
  party: Pick<Party, "name" | "kind" | "tax_classification">,
): string {
  const label = partyRelationshipLabel(party);
  const name = party.name.trim();
  const named = !name || description.toLowerCase().includes(name.toLowerCase());
  return named ? label : `${label}, ${name}`;
}

/**
 * The one contact form: the Contacts page and the transaction editors share
 * it. The relationship decides what else the form asks: only someone you pay
 * can be a contractor, so customers never see the 1099 fields.
 */
export function PartyForm({
  party,
  accounts,
  onCancel,
  onSaved,
}: {
  party: Party;
  accounts: AccountingAccount[];
  onCancel: () => void;
  onSaved: (party: Party) => Promise<void> | void;
}) {
  const [value, setValue] = useState(party);
  const command = useAccountingCommand();
  // The relationship the owner picks maps onto the stored kind and contractor status.
  const contractor = value.tax_classification !== "unreviewed";
  const relationship = partyRelationship(value);
  return (
    <form
      className="mt-4 space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        // The dialog can sit inside a transaction form; its save is its own.
        e.stopPropagation();
        // Field by field: a contact read back from the books carries its raw
        // table columns too, which the strict command schema rejects.
        const saved = await command.execute({
          type: "party.save",
          id: value.id,
          expected_version: value.version,
          name: value.name,
          kind: value.kind,
          default_account_id: value.default_account_id,
          tax_classification: value.tax_classification,
          documentation: value.documentation,
          notes: value.notes,
          is_archived: value.is_archived,
          is_contractor: value.tax_classification !== "unreviewed",
        });
        if (saved)
          await onSaved({
            ...value,
            version:
              (saved as { version?: number }).version ?? value.version + 1,
          });
      }}
    >
      <TextInput
        label="Name"
        value={value.name}
        onChange={(nextValue) => setValue({ ...value, name: nextValue })}
        required
        maxLength={120}
        placeholder="Who the money goes to, or comes from"
      />
      <RadioGroup
        label="Relationship"
        orientation="horizontal"
        value={relationship}
        onChange={(next) =>
          setValue({
            ...value,
            kind:
              next === "customer"
                ? "customer"
                : next === "both"
                  ? "both"
                  : "vendor",
            tax_classification:
              next === "contractor"
                ? contractor
                  ? value.tax_classification
                  : "individual"
                : "unreviewed",
          })
        }
        options={[
          { value: "vendor", label: "Vendor / Payee" },
          { value: "customer", label: "Customer" },
          { value: "contractor", label: "Contractor" },
          // Only a contact already saved as both keeps that choice.
          ...(value.kind === "both" ? [{ value: "both", label: "Both" }] : []),
        ]}
      />
      <Select
        searchable
        label="Default category"
        visibleLabel="Default category"
        value={value.default_account_id ?? ""}
        placeholder="No default"
        options={[
          { value: "", label: "No default" },
          ...accounts
            .filter((a) => !a.is_archived)
            .map((a) => ({
              value: a.id,
              label: a.name,
              group: enumLabel(a.account_type),
              keywords: a.code,
            })),
        ]}
        onChange={(v) => setValue({ ...value, default_account_id: v || null })}
        helperText="Fills new bank activity from this contact."
      />
      {contractor && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Contractor type"
            value={value.tax_classification}
            onChange={(v) =>
              setValue({
                ...value,
                tax_classification: v as Party["tax_classification"],
              })
            }
            options={[
              { value: "individual", label: "Individual" },
              { value: "corporation", label: "Corporation" },
              { value: "foreign", label: "Foreign" },
              { value: "other", label: "Other" },
            ]}
          />
          <Select
            label="W-9 on file"
            value={value.documentation}
            onChange={(v) =>
              setValue({
                ...value,
                documentation: v as Party["documentation"],
              })
            }
            options={[
              { value: "missing", label: "Missing" },
              { value: "received", label: "Received" },
              { value: "not_required", label: "Not required" },
            ]}
          />
        </div>
      )}
      <Disclosure summary="Advanced" contentClassName="space-y-4">
        <Textarea
          label="Notes"
          maxLength={3000}
          value={value.notes}
          onChange={(nextValue) => setValue({ ...value, notes: nextValue })}
        />
        <Checkbox
          checked={value.is_archived}
          onChange={(v) => setValue({ ...value, is_archived: v })}
          label="Archive from new selections"
        />
      </Disclosure>
      {command.error && (
        <p className="text-sm text-error" role="alert">
          {command.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={command.busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button disabled={command.busy} loading={command.busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Add or edit a contact in a dialog; the same one everywhere. */
export function PartyDialog({
  party,
  accounts,
  onClose,
  onSaved,
}: {
  party: Party | null;
  accounts: AccountingAccount[];
  onClose: () => void;
  onSaved: (party: Party) => Promise<void> | void;
}) {
  return (
    <Dialog
      open={!!party}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {party?.version ? "Edit contact" : "Add contact"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Name, relationship and default category for this contact.
          </DialogDescription>
        </DialogHeader>
        {party && (
          <PartyForm
            party={party}
            accounts={accounts}
            onCancel={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
