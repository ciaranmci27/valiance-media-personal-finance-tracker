"use client";
import { useEffect, useId, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Merge,
  Pencil,
  Archive,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/ui/section-header";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import { groupContacts, type ContactGroup } from "@/lib/accounting/contacts";
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  type ContactRole,
  type Party,
  type RegisterFilter,
} from "@/lib/accounting/workflows";
import { PartyDialog, newParty } from "./accounting-party-form";
import { enumLabel } from "./format";
import { useAccountingCommand } from "./use-accounting-command";

/** Contacts an agent suggested that the owner has not approved yet. */
export function suggestedContacts(parties: Party[]): Party[] {
  return parties.filter(
    (p) => !p.is_archived && p.review_status === "suggested",
  );
}

/** The owner's open or closed choice per contact group, kept in this browser only. */
const GROUP_FOLDS_KEY = "vm-accounting-contact-groups";

/** The fields party.save takes, from a contact read back from the books. */
function saveCommand(p: Party, changes: Partial<Party>) {
  const next = { ...p, ...changes };
  return {
    type: "party.save" as const,
    id: next.id,
    expected_version: next.version,
    name: next.name,
    roles: next.roles,
    email: next.email ?? null,
    phone: next.phone ?? null,
    website: next.website ?? null,
    default_account_id: next.default_account_id,
    tax_classification: next.tax_classification,
    documentation: next.documentation,
    notes: next.notes ?? "",
    is_archived: next.is_archived,
  };
}

/**
 * Manage > Contacts: who the business pays and who pays it, with roles.
 * Contacts an agent suggests wait here for the owner: approve, edit, or merge
 * into the contact that already exists.
 */
export function AccountingContacts({
  parties,
  accounts,
  demo,
  focusId,
  onRefresh,
  onFilter,
}: {
  parties: Party[];
  accounts: AccountingAccount[];
  demo: boolean;
  /** A contact a link points at (review_url); the list opens on it. */
  focusId?: string | null;
  onRefresh: () => Promise<void>;
  onFilter: (filter: Partial<RegisterFilter>) => void;
}) {
  const [query, setQuery] = useState(
    () => parties.find((p) => p.id === focusId)?.name ?? "",
  );
  const [role, setRole] = useState<ContactRole | "">("");
  const [onlySuggested, setOnlySuggested] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [merging, setMerging] = useState<Party | null>(null);
  const command = useAccountingCommand(() => onRefresh());
  const suggested = suggestedContacts(parties);
  const search = query.trim().toLowerCase();
  const rows = parties.filter(
    (p) =>
      p.name.toLowerCase().includes(search) &&
      (!role || p.roles.includes(role)) &&
      (!onlySuggested || (!p.is_archived && p.review_status === "suggested")),
  );
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  const groups = groupContacts(rows, (id) => accountNames.get(id));
  const groupIds = useId();
  // The owner's choices outside a search, remembered per group.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  // Groups closed during the current search; a new search opens them again.
  const [searchFolds, setSearchFolds] = useState<{
    query: string;
    closed: string[];
  }>({ query: "", closed: [] });
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GROUP_FOLDS_KEY);
      const stored: unknown = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === "object" && !Array.isArray(stored))
        setFolds(
          Object.fromEntries(
            Object.entries(stored).filter(
              (entry): entry is [string, boolean] =>
                typeof entry[1] === "boolean",
            ),
          ),
        );
    } catch {
      // Blocked or unreadable storage: every group starts at its default.
    }
  }, []);

  function isOpen(group: ContactGroup<Party>) {
    if (search)
      return !(
        searchFolds.query === search && searchFolds.closed.includes(group.key)
      );
    if (group.key in folds) return folds[group.key];
    return (
      group.contacts.length <= 5 ||
      (onlySuggested &&
        group.contacts.some(
          (p) => !p.is_archived && p.review_status === "suggested",
        ))
    );
  }

  function toggle(group: ContactGroup<Party>, open: boolean) {
    if (search) {
      const closed = searchFolds.query === search ? searchFolds.closed : [];
      setSearchFolds({
        query: search,
        closed: open
          ? [...closed, group.key]
          : closed.filter((key) => key !== group.key),
      });
      return;
    }
    const next = { ...folds, [group.key]: !open };
    setFolds(next);
    try {
      window.localStorage.setItem(GROUP_FOLDS_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage: the choice lasts until the page reloads.
    }
  }

  function contactRow(p: Party) {
    const pending = !p.is_archived && p.review_status === "suggested";
    return (
      <div
        key={p.id}
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
      >
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="truncate">{p.name}</span>
            {p.is_archived && <Badge size="sm">Archived</Badge>}
            {pending && (
              <Badge size="sm" variant="warning">
                {p.suggested_by_name
                  ? `Suggested by ${p.suggested_by_name}`
                  : "Suggested"}
              </Badge>
            )}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {CONTACT_ROLES.filter((r) => p.roles.includes(r)).map((r) => (
              <Badge key={r} size="sm" variant="info">
                {CONTACT_ROLE_LABELS[r]}
              </Badge>
            ))}
            {p.roles.includes("contractor") && (
              <span className="text-xs text-muted-foreground">
                {p.tax_classification === "unreviewed"
                  ? "Type not reviewed"
                  : enumLabel(p.tax_classification)}
                . W-9 {enumLabel(p.documentation).toLowerCase()}.
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {pending && (
            <Button
              variant="secondary"
              size="sm"
              disabled={demo || command.busy}
              aria-label={`Approve ${p.name}`}
              onClick={() => void approve([p])}
            >
              <Check size={14} aria-hidden="true" />
              Approve
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFilter({ payee: p.id })}
          >
            Transactions
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
          {!demo && (
            <RowActionsMenu
              label={`Actions for ${p.name}`}
              actions={[
                {
                  label: "Edit",
                  icon: <Pencil size={14} aria-hidden="true" />,
                  onSelect: () => setEditing(p),
                },
                {
                  label: "Merge into...",
                  icon: <Merge size={14} aria-hidden="true" />,
                  disabled: parties.every(
                    (o) => o.id === p.id || o.is_archived,
                  ),
                  onSelect: () => setMerging(p),
                },
                p.is_archived
                  ? {
                      label: "Restore",
                      icon: <RotateCcw size={14} aria-hidden="true" />,
                      separator: true,
                      onSelect: () =>
                        void command.execute(
                          saveCommand(p, { is_archived: false }),
                        ),
                    }
                  : {
                      label: "Archive",
                      icon: <Archive size={14} aria-hidden="true" />,
                      separator: true,
                      onSelect: () =>
                        void command.execute(
                          saveCommand(p, { is_archived: true }),
                        ),
                    },
              ]}
            />
          )}
        </div>
      </div>
    );
  }

  async function approve(list: Party[]) {
    await command.execute({
      type: "party.approve",
      id: crypto.randomUUID(),
      ids: list.map((p) => p.id),
      expected_versions: Object.fromEntries(list.map((p) => [p.id, p.version])),
    });
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        label="Contacts"
        count={parties.length}
        description="Who the business pays and who pays it. Roles drive the client, vendor and 1099 reports."
        action={
          <Button
            size="sm"
            disabled={demo}
            onClick={() => setEditing(newParty())}
          >
            <Plus size={15} aria-hidden="true" />
            Add contact
          </Button>
        }
      />
      {command.error && (
        <p role="alert" className="text-sm text-error">
          {command.error}
        </p>
      )}
      <div className="glass-card overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center gap-3 p-4">
          <TextInput
            className="min-w-[200px] flex-1"
            prefix={<Search size={15} aria-hidden="true" />}
            aria-label="Find contact"
            placeholder="Find a contact"
            value={query}
            onChange={(nextValue) => setQuery(nextValue)}
          />
          <Select
            className="w-44"
            ariaLabel="Role"
            value={role}
            onChange={(v) => setRole(v as ContactRole | "")}
            options={[
              { value: "", label: "All roles" },
              ...CONTACT_ROLES.map((r) => ({
                value: r,
                label: CONTACT_ROLE_LABELS[r],
              })),
            ]}
          />
          {suggested.length > 0 && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={onlySuggested ? "secondary" : "outline"}
                aria-pressed={onlySuggested}
                onClick={() => setOnlySuggested((on) => !on)}
              >
                Suggested ({suggested.length})
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={demo || command.busy}
                onClick={() => void approve(suggested)}
              >
                <Check size={15} aria-hidden="true" />
                Approve all
              </Button>
            </div>
          )}
        </div>
        <div>
          {groups.map((group, index) => {
            const open = isOpen(group);
            const panelId = `${groupIds}-${index}`;
            return (
              <div key={group.key} className="border-t border-border">
                <h3>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => toggle(group, open)}
                    className="h-auto w-full justify-start gap-2 whitespace-normal rounded-none px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground focus-visible:ring-inset focus-visible:ring-offset-0"
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "transition-transform motion-reduce:transition-none",
                        !open && "-rotate-90",
                      )}
                    />
                    <span>
                      {group.label} · {group.contacts.length}
                    </span>
                  </Button>
                </h3>
                <div
                  id={panelId}
                  hidden={!open}
                  className="divide-y divide-border border-t border-border"
                >
                  {group.contacts.map((p) => contactRow(p))}
                </div>
              </div>
            );
          })}
          {!parties.length && (
            <p className="px-5 pb-8 pt-4 text-sm text-muted-foreground">
              No contacts yet. Add who you pay and who pays you, then choose
              them on transactions.
            </p>
          )}
          {parties.length > 0 && !rows.length && (
            <p className="px-5 pb-8 pt-4 text-sm text-muted-foreground">
              No contacts match.
            </p>
          )}
        </div>
      </div>
      <PartyDialog
        party={editing}
        accounts={accounts}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await onRefresh();
          setEditing(null);
        }}
      />
      <MergeDialog
        from={merging}
        parties={parties}
        onClose={() => setMerging(null)}
        onMerged={async () => {
          await onRefresh();
          setMerging(null);
        }}
      />
    </section>
  );
}

/** Merge one contact into another: everything moves, the merged one is archived. */
function MergeDialog({
  from,
  parties,
  onClose,
  onMerged,
}: {
  from: Party | null;
  parties: Party[];
  onClose: () => void;
  onMerged: () => Promise<void>;
}) {
  const [into, setInto] = useState("");
  const command = useAccountingCommand();
  const target = parties.find((p) => p.id === into);
  return (
    <Dialog
      open={!!from}
      onOpenChange={(open) => {
        if (!open) {
          setInto("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Merge {from?.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the contact to keep. Transactions, bank descriptions,
            receipts and rules move to it, and this contact is archived.
          </DialogDescription>
        </DialogHeader>
        {from && (
          <form
            className="mt-4 space-y-5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!target) return;
              const merged = await command.execute({
                type: "party.merge",
                id: crypto.randomUUID(),
                from_id: from.id,
                into_id: target.id,
                from_version: from.version,
                into_version: target.version,
              });
              if (merged) {
                setInto("");
                await onMerged();
              }
            }}
          >
            <Select
              searchable
              label="Keep"
              visibleLabel="Keep"
              value={into}
              placeholder="Choose a contact"
              emptyText="No other contacts match."
              options={parties
                .filter((p) => p.id !== from.id && !p.is_archived)
                .map((p) => ({ value: p.id, label: p.name }))}
              onChange={setInto}
              helperText={`${from.name}'s transactions, bank descriptions, receipts and rules move to the contact you keep, and ${from.name} is archived.`}
            />
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
                onClick={() => {
                  setInto("");
                  onClose();
                }}
              >
                Cancel
              </Button>
              <Button disabled={!target || command.busy} loading={command.busy}>
                Merge
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
