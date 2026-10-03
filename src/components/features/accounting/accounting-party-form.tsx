"use client";
import { useId, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { Textarea } from "@/components/ui/inputs/Textarea";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  type ContactRole,
  type Party,
} from "@/lib/accounting/workflows";
import { enumLabel } from "./format";
import { useAccountingCommand } from "./use-accounting-command";

/** A contact with nothing filled in yet; a vendor unless the caller knows better. */
export function newParty(roles: ContactRole[] = ["vendor"]): Party {
  return {
    id: crypto.randomUUID(),
    version: 0,
    name: "",
    roles,
    email: null,
    phone: null,
    website: null,
    review_status: "confirmed",
    default_account_id: null,
    tax_classification: "unreviewed",
    documentation: "missing",
    notes: "",
    is_archived: false,
  };
}

/** A contact's roles in plain words, in the books' own order. */
export function partyRolesLabel(party: Pick<Party, "roles">): string {
  const roles = party.roles ?? [];
  return roles.length
    ? CONTACT_ROLES.filter((r) => roles.includes(r))
        .map((r) => CONTACT_ROLE_LABELS[r])
        .join(", ")
    : "Contact";
}

/**
 * What a list shows beside a description: the contact's roles, plus its name
 * unless the description already says it.
 */
export function contactAffiliation(
  description: string,
  party: Pick<Party, "name" | "roles">,
): string {
  const label = partyRolesLabel(party);
  const name = party.name.trim();
  const named = !name || description.toLowerCase().includes(name.toLowerCase());
  return named ? label : `${label}, ${name}`;
}

/** Role chips that toggle; one group, one label, each chip a pressed button. */
export function RoleChips({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: ContactRole[];
  onChange: (roles: ContactRole[]) => void;
  error?: string;
}) {
  const labelId = useId();
  const errorId = useId();
  return (
    <div>
      <p id={labelId} className="mb-2 text-sm font-medium">
        {label}
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={error ? errorId : undefined}
        className="flex flex-wrap gap-2"
      >
        {CONTACT_ROLES.map((role) => {
          const on = value.includes(role);
          return (
            <Button
              key={role}
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={on}
              className={cn(
                "rounded-full",
                on &&
                  "border-primary/50 bg-primary/14 text-teal-light hover:bg-primary/20 hover:text-teal-light",
              )}
              onClick={() =>
                onChange(
                  on
                    ? value.filter((r) => r !== role)
                    : CONTACT_ROLES.filter(
                        (r) => r === role || value.includes(r),
                      ),
                )
              }
            >
              {/* The check says "chosen" without relying on color alone. */}
              {on && <Check aria-hidden="true" />}
              {CONTACT_ROLE_LABELS[role]}
            </Button>
          );
        })}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The one contact form: the Contacts page and the transaction editors share
 * it. Roles decide what else the form asks: only a contractor sees the 1099
 * fields.
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
  const [rolesError, setRolesError] = useState("");
  const command = useAccountingCommand();
  const contractor = value.roles.includes("contractor");
  const suggested = party.version > 0 && party.review_status === "suggested";
  const text = (v: string | null) => (v?.trim() ? v.trim() : null);
  return (
    <form
      className="mt-4 space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        // The dialog can sit inside a transaction form; its save is its own.
        e.stopPropagation();
        if (!value.roles.length) {
          setRolesError("Choose at least one role.");
          return;
        }
        // Field by field: a contact read back from the books carries its raw
        // table columns too, which the strict command schema rejects.
        const saved = await command.execute({
          type: "party.save",
          id: value.id,
          expected_version: value.version,
          name: value.name,
          roles: value.roles,
          email: text(value.email),
          phone: text(value.phone),
          website: text(value.website),
          default_account_id: value.default_account_id,
          tax_classification: value.tax_classification,
          documentation: value.documentation,
          notes: value.notes,
          is_archived: value.is_archived,
        });
        if (saved)
          await onSaved({
            ...value,
            review_status: "confirmed",
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
      <RoleChips
        label="Roles"
        value={value.roles}
        error={rolesError}
        onChange={(roles) => {
          setRolesError("");
          setValue({ ...value, roles });
        }}
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
              { value: "unreviewed", label: "Not reviewed" },
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
        <TextInput
          label="Email"
          type="email"
          autoComplete="off"
          maxLength={254}
          value={value.email ?? ""}
          onChange={(nextValue) => setValue({ ...value, email: nextValue })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Phone"
            type="tel"
            autoComplete="off"
            maxLength={40}
            value={value.phone ?? ""}
            onChange={(nextValue) => setValue({ ...value, phone: nextValue })}
          />
          <TextInput
            label="Website"
            autoComplete="off"
            maxLength={300}
            placeholder="example.com"
            value={value.website ?? ""}
            onChange={(nextValue) => setValue({ ...value, website: nextValue })}
          />
        </div>
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
          {suggested ? "Save and approve" : "Save"}
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
            Name, roles and default category for this contact.
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
