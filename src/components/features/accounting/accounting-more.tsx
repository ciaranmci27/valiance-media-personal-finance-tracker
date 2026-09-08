"use client";
import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  FileSpreadsheet,
  Landmark,
  Layers,
  Pencil,
  Plus,
  Receipt,
  Repeat2,
  Search,
  Settings2,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/ui/section-header";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type {
  Party,
  RegisterFilter,
  WorkflowCommand,
} from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import { useAccountingCommand } from "./use-accounting-command";
import { enumLabel, todayInBooks } from "./format";

const loading = () => (
  <p role="status" className="p-6 text-sm text-muted-foreground">
    Loading...
  </p>
);
const AccountingImports = dynamic(
  () => import("./accounting-imports").then((m) => m.AccountingImports),
  { loading },
);
const AccountingDocuments = dynamic(
  () => import("./accounting-documents").then((m) => m.AccountingDocuments),
  { loading },
);
const AccountingHistory = dynamic(
  () => import("./accounting-history").then((m) => m.AccountingHistory),
  { loading },
);
const AccountingTransfers = dynamic(
  () => import("./accounting-transfers").then((m) => m.AccountingTransfers),
  { loading },
);
const AccountingRules = dynamic(
  () => import("./accounting-rules").then((m) => m.AccountingRules),
  { loading },
);
const AccountingContractors = dynamic(
  () => import("./accounting-contractors").then((m) => m.AccountingContractors),
  { loading },
);
const AccountingTaxWorkpapers = dynamic(
  () =>
    import("./accounting-tax-workpapers").then(
      (m) => m.AccountingTaxWorkpapers,
    ),
  { loading },
);
const AccountingPayrollRuns = dynamic(
  () => import("./accounting-payroll-run").then((m) => m.AccountingPayrollRuns),
  { loading },
);
const AccountingManualRegisters = dynamic(
  () =>
    import("./accounting-manual-registers").then(
      (m) => m.AccountingManualRegisters,
    ),
  { loading },
);
const AccountingFeeds = dynamic(
  () => import("./accounting-feeds").then((m) => m.AccountingFeeds),
  { loading },
);

export type MoreSection =
  | "feeds"
  | "imports"
  | "transfers"
  | "documents"
  | "rules"
  | "payees"
  | "payroll"
  | "assets"
  | "loans"
  | "contractors"
  | "tax"
  | "history"
  | "settings";

const SECTIONS: {
  id: MoreSection;
  name: string;
  description: string;
  icon: typeof Users;
}[] = [
  {
    id: "feeds",
    name: "Bank feeds",
    description: "Connections and sync",
    icon: Repeat2,
  },
  {
    id: "imports",
    name: "Imports",
    description: "Bank and journal files",
    icon: FileSpreadsheet,
  },
  {
    id: "transfers",
    name: "Transfers",
    description: "Bank moves and card payments",
    icon: Repeat2,
  },
  {
    id: "documents",
    name: "Receipts",
    description: "Receipts and source files",
    icon: Receipt,
  },
  {
    id: "rules",
    name: "Rules & aliases",
    description: "Automatic categorization",
    icon: Settings2,
  },
  {
    id: "payees",
    name: "Payees",
    description: "Vendors, customers, contractors",
    icon: Users,
  },
  {
    id: "payroll",
    name: "Payroll",
    description: "Patriot registers",
    icon: Wallet,
  },
  {
    id: "assets",
    name: "Assets",
    description: "Equipment and depreciation",
    icon: Layers,
  },
  {
    id: "loans",
    name: "Loans",
    description: "Principal and interest",
    icon: Landmark,
  },
  {
    id: "contractors",
    name: "Contractors",
    description: "Year-end 1099 review",
    icon: Users,
  },
  {
    id: "tax",
    name: "Tax",
    description: "Workpapers and estimator link",
    icon: FileSpreadsheet,
  },
  {
    id: "history",
    name: "Wave migration",
    description: "Imported history checks",
    icon: FileSpreadsheet,
  },
  {
    id: "settings",
    name: "Settings",
    description: "Company and books",
    icon: Building2,
  },
];
const GROUPS: { name: string; ids: MoreSection[] }[] = [
  {
    name: "Everyday",
    ids: ["feeds", "imports", "transfers", "documents", "rules", "payees"],
  },
  {
    name: "Records",
    ids: ["payroll", "assets", "loans", "contractors", "tax"],
  },
  { name: "Setup", ids: ["history", "settings"] },
];

/**
 * Everything that is not daily work: connections, imports, registers, tax
 * and setup. One rail on wide screens, one select on narrow ones.
 */
export function AccountingMore({
  data,
  manage,
  demo,
  onRefresh,
  onEntry,
  onFilter,
  initialSection,
}: {
  initialSection?: string;
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
  onFilter: (filter: Partial<RegisterFilter>) => void;
}) {
  const params = useSearchParams();
  const candidate = params.get("section") ?? initialSection;
  const section: MoreSection = SECTIONS.some((s) => s.id === candidate)
    ? (candidate as MoreSection)
    : "feeds";
  function setSection(next: MoreSection) {
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    window.history.pushState(null, "", url);
  }
  const [party, setParty] = useState<Party | null>(null);
  const [query, setQuery] = useState("");
  const today = todayInBooks();

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[208px_1fr]">
      <nav aria-label="More accounting sections" className="min-w-0">
        <div className="xl:hidden">
          <CustomSelect
            label="Section"
            value={section}
            onChange={(v) => {
              setSection(v as MoreSection);
              setQuery("");
            }}
            options={GROUPS.flatMap((g) => [
              { value: `group-${g.name}`, label: g.name, isGroupHeader: true },
              ...g.ids.map((id) => ({
                value: id,
                label: SECTIONS.find((s) => s.id === id)!.name,
              })),
            ])}
          />
        </div>
        <div className="hidden space-y-5 xl:block">
          {GROUPS.map((group) => (
            <div key={group.name}>
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {group.name}
              </p>
              {group.ids
                .map((id) => SECTIONS.find((s) => s.id === id)!)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={s.id === section ? "page" : undefined}
                    onClick={() => {
                      setSection(s.id);
                      setQuery("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      section === s.id
                        ? "border-primary/30 bg-primary/5 text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    <s.icon
                      size={15}
                      aria-hidden="true"
                      className={section === s.id ? "text-teal-light" : ""}
                    />
                    {s.name}
                  </button>
                ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="min-w-0">
        {section === "tax" && (
          <AccountingTaxWorkpapers demo={demo} onRefresh={onRefresh} />
        )}
        {section === "contractors" && (
          <AccountingContractors
            manage={manage}
            demo={demo}
            onRefresh={onRefresh}
            onEntry={onEntry}
          />
        )}
        {(section === "assets" || section === "loans") && (
          <AccountingManualRegisters
            key={section}
            kind={section === "assets" ? "asset" : "loan"}
            accounts={data.accounts}
            manage={manage}
            demo={demo}
            onRefresh={onRefresh}
            onEntry={onEntry}
          />
        )}
        {section === "payroll" && (
          <AccountingPayrollRuns
            accounts={data.accounts}
            manage={manage}
            today={today}
            demo={demo}
            onRefresh={onRefresh}
            onEntry={onEntry}
          />
        )}
        {section === "feeds" && (
          <AccountingFeeds
            data={data}
            manage={manage}
            demo={demo}
            onRefresh={onRefresh}
            onImports={() => setSection("imports")}
          />
        )}
        {section === "rules" && (
          <AccountingRules
            data={data}
            manage={manage}
            demo={demo}
            onRefresh={onRefresh}
            onEntry={onEntry}
          />
        )}
        {section === "transfers" && (
          <AccountingTransfers
            from={data.from}
            to={data.to}
            accounts={data.accounts}
            profiles={manage.profiles}
            demo={demo}
            onRefresh={onRefresh}
            onEntry={onEntry}
          />
        )}
        {section === "imports" && (
          <AccountingImports
            accounts={data.accounts}
            profiles={manage.profiles}
            demo={demo}
            onRefresh={onRefresh}
            onEntry={onEntry}
          />
        )}
        {section === "documents" && (
          <AccountingDocuments demo={demo} onEntry={onEntry} />
        )}
        {section === "history" && (
          <AccountingHistory date={data.to} demo={demo} onRefresh={onRefresh} />
        )}

        {section === "payees" && (
          <section className="space-y-3">
            <SectionHeader
              label="Payees"
              count={manage.parties.length}
              description="Vendors and customers, with the contractor flag for year-end reporting."
              action={
                <Button
                  size="sm"
                  disabled={demo}
                  onClick={() =>
                    setParty({
                      id: crypto.randomUUID(),
                      version: 0,
                      name: "",
                      kind: "vendor",
                      default_account_id: null,
                      tax_classification: "unreviewed",
                      documentation: "missing",
                      notes: "",
                      is_archived: false,
                    })
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  Add payee
                </Button>
              }
            />
            <div className="glass-card overflow-hidden rounded-xl">
              <div className="p-4">
                <Input
                  icon={<Search size={15} aria-hidden="true" />}
                  aria-label="Find payee"
                  placeholder="Find a payee or customer"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="divide-y divide-border">
                {manage.parties
                  .filter((p) =>
                    p.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          <span className="truncate">{p.name}</span>
                          {p.is_archived && <Badge size="sm">Archived</Badge>}
                          {p.tax_classification !== "unreviewed" && (
                            <Badge size="sm" variant="copper">
                              {enumLabel(p.tax_classification)}
                            </Badge>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {enumLabel(p.kind)}. Documentation{" "}
                          {enumLabel(p.documentation).toLowerCase()}.
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onFilter({ payee: p.id })}
                        >
                          Transactions
                          <ArrowRight size={14} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${p.name}`}
                          disabled={demo}
                          onClick={() => setParty(p)}
                        >
                          <Pencil size={15} aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  ))}
                {!manage.parties.length && (
                  <p className="px-5 pb-8 pt-4 text-sm text-muted-foreground">
                    No payees yet. Add recurring vendors and customers, then
                    choose them on transactions.
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {section === "settings" && (
          <BookSettings
            key={manage.preferences?.version ?? 0}
            data={data}
            manage={manage}
            demo={demo}
            onRefresh={onRefresh}
          />
        )}
      </div>

      <Dialog
        open={!!party}
        onOpenChange={(open) => {
          if (!open) setParty(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {party?.version ? "Edit payee" : "Add payee"}
            </DialogTitle>
            <DialogDescription>
              Defaults help with review. They do not rewrite past entries.
            </DialogDescription>
          </DialogHeader>
          {party && (
            <PartyForm
              party={party}
              data={data}
              onSaved={async () => {
                await onRefresh();
                setParty(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PartyForm({
  party,
  data,
  onSaved,
}: {
  party: Party;
  data: AccountingWorkspace;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(party);
  const command = useAccountingCommand(onSaved);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const { version, ...fields } = value;
        void command.execute({
          type: "party.save",
          ...fields,
          expected_version: version,
        });
      }}
    >
      <Input
        label="Name"
        value={value.name}
        onChange={(e) => setValue({ ...value, name: e.target.value })}
        required
        maxLength={120}
      />
      <CustomSelect
        label="Relationship"
        value={value.kind}
        onChange={(v) => setValue({ ...value, kind: v as Party["kind"] })}
        options={[
          { value: "vendor", label: "Vendor or payee" },
          { value: "customer", label: "Customer" },
          { value: "both", label: "Vendor and customer" },
        ]}
      />
      <SearchableSelect
        label="Default category"
        visibleLabel="Default category"
        value={value.default_account_id ?? ""}
        placeholder="No default"
        options={[
          { value: "", label: "No default" },
          ...data.accounts
            .filter((a) => !a.is_archived)
            .map((a) => ({
              value: a.id,
              label: a.name,
              group: enumLabel(a.account_type),
              keywords: a.code,
            })),
        ]}
        onChange={(v) => setValue({ ...value, default_account_id: v || null })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <CustomSelect
          label="Contractor status"
          value={value.tax_classification}
          onChange={(v) =>
            setValue({
              ...value,
              tax_classification: v as Party["tax_classification"],
            })
          }
          options={[
            { value: "unreviewed", label: "Not a contractor / unreviewed" },
            { value: "individual", label: "Individual contractor" },
            { value: "corporation", label: "Corporation" },
            { value: "partnership", label: "Partnership" },
            { value: "foreign", label: "Foreign" },
            { value: "other", label: "Other" },
          ]}
        />
        <CustomSelect
          label="W-9 on file"
          value={value.documentation}
          onChange={(v) =>
            setValue({ ...value, documentation: v as Party["documentation"] })
          }
          options={[
            { value: "missing", label: "Missing" },
            { value: "requested", label: "Requested" },
            { value: "received", label: "Received" },
            { value: "not_required", label: "Not required" },
          ]}
        />
      </div>
      <Textarea
        label="Notes"
        maxLength={3000}
        value={value.notes}
        onChange={(e) => setValue({ ...value, notes: e.target.value })}
      />
      <Checkbox
        checked={value.is_archived}
        onChange={(v) => setValue({ ...value, is_archived: v })}
        label="Archive from new selections"
      />
      {command.error && (
        <p className="text-sm text-error" role="alert">
          {command.error}
        </p>
      )}
      <div className="flex justify-end">
        <Button disabled={command.busy} loading={command.busy}>
          Save payee
        </Button>
      </div>
    </form>
  );
}

function BookSettings({
  data,
  manage,
  demo,
  onRefresh,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<
    Extract<WorkflowCommand, { type: "preferences.save" }>
  >(() => ({
    type: "preferences.save",
    id: crypto.randomUUID(),
    expected_version: manage.preferences?.version ?? 0,
    legal_name: data.legal_name,
    primary_system: manage.preferences?.primary_system ?? "wave",
    primary_system_since: manage.preferences?.primary_system_since ?? null,
    history_start: manage.preferences?.history_start ?? null,
    transfer_window_days: manage.preferences?.transfer_window_days ?? 5,
  }));
  const command = useAccountingCommand(onRefresh);
  const primary = manage.preferences?.primary_system === "admin";
  return (
    <div className="space-y-6">
      <section className="glass-card rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Business details</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Legal name, EIN, tax classification, fiscal year and contacts live
              in one place shared with the tax estimator.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/business">
              Open Business settings
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </section>
      <form
        className="glass-card space-y-5 rounded-xl p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void command.execute(form);
        }}
      >
        <div>
          <h2 className="font-semibold">Books</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            USD, cash basis, one company.
          </p>
        </div>
        <Input
          label="Name on reports"
          value={form.legal_name}
          onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
          required
          maxLength={200}
        />
        <CustomSelect
          label="System of record"
          value={form.primary_system ?? "wave"}
          disabled={primary}
          onChange={(v) =>
            setForm({
              ...form,
              primary_system: v as "wave" | "admin",
              primary_system_since:
                v === "admin" ? (form.primary_system_since ?? data.to) : null,
            })
          }
          options={[
            { value: "wave", label: "Wave stays primary" },
            { value: "admin", label: "These books are primary" },
          ]}
          helperText={
            primary
              ? `These books have been primary since ${manage.preferences?.primary_system_since ?? "the recorded date"}.`
              : "Switch to these books after the parallel months tie out. Nothing here creates a cutover entry."
          }
        />
        {form.primary_system === "admin" && !primary && (
          <Input
            label="Primary from"
            type="date"
            required
            value={form.primary_system_since ?? ""}
            onChange={(e) =>
              setForm({
                ...form,
                primary_system_since: e.target.value || null,
              })
            }
          />
        )}
        <Input
          label="Books start on"
          type="date"
          value={form.history_start ?? ""}
          disabled={primary}
          onChange={(e) =>
            setForm({ ...form, history_start: e.target.value || null })
          }
        />
        <Input
          label="Transfer matching window (days)"
          type="number"
          min={0}
          max={30}
          value={form.transfer_window_days}
          onChange={(e) =>
            setForm({ ...form, transfer_window_days: Number(e.target.value) })
          }
          className="sm:w-64"
        />
        {command.error && (
          <p role="alert" className="text-sm text-error">
            {command.error}
          </p>
        )}
        <div className="flex justify-end">
          <Button disabled={demo || command.busy} loading={command.busy}>
            Save settings
          </Button>
        </div>
      </form>
      <section className="glass-card rounded-xl p-5">
        <h2 className="font-semibold">Exports</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A complete, portable copy of the books: accounts, every journal line,
          matches, documents index and audit history.
        </p>
        {demo ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Exports are available in your own books.
          </p>
        ) : (
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href="/api/accounting?export=true">Download full export</a>
          </Button>
        )}
      </section>
    </div>
  );
}
