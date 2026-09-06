"use client";
import { useState } from "react";
import {
  Users,
  FileSpreadsheet,
  Layers,
  Repeat2,
  Settings2,
  ArrowRight,
  Plus,
  Pencil,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type {
  ManageData,
  Party,
  JournalTemplate,
  RegisterFilter,
  WorkflowCommand,
} from "@/lib/accounting/workflows";
import { AccountingImports } from "./accounting-imports";
import { useAccountingCommand } from "./use-accounting-command";
import { AccountingDocuments } from "./accounting-documents";
import { AccountingHistory } from "./accounting-history";
import { AccountingTransfers } from "./accounting-transfers";
import { AccountingRules } from "./accounting-rules";
import { AccountingFeeds } from "./accounting-feeds";

const selectStyle =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
type Dimension = ManageData["dimensions"][number];
type Section =
  | "feeds"
  | "rules"
  | "imports"
  | "history"
  | "transfers"
  | "payees"
  | "dimensions"
  | "templates"
  | "settings"
  | "documents";
const sections = [
  {
    id: "feeds" as const,
    name: "Bank feeds",
    description: "Connections and received activity",
    icon: Repeat2,
  },
  {
    id: "rules" as const,
    name: "Rules & aliases",
    description: "Consistent draft categorization",
    icon: Settings2,
  },
  {
    id: "transfers" as const,
    name: "Transfers",
    description: "Bank moves and card payments",
    icon: Repeat2,
  },
  {
    id: "imports" as const,
    name: "Imports",
    description: "Wave history and bank files",
    icon: FileSpreadsheet,
  },
  {
    id: "payees" as const,
    name: "Payees & customers",
    description: "Defaults and contractor records",
    icon: Users,
  },
  {
    id: "history" as const,
    name: "Verify history",
    description: "Independent report comparisons",
    icon: FileSpreadsheet,
  },
  {
    id: "dimensions" as const,
    name: "Projects & business lines",
    description: "A clearer view of your work",
    icon: Layers,
  },
  {
    id: "templates" as const,
    name: "Journal templates",
    description: "Repeat a reviewed entry",
    icon: Repeat2,
  },
  {
    id: "settings" as const,
    name: "Book settings",
    description: "Company and parallel operation",
    icon: Settings2,
  },
];
export function AccountingManage({
  data,
  manage,
  demo,
  onRefresh,
  onEntry,
  onTemplate,
  onFilter,
}: {
  data: AccountingWorkspace;
  manage: ManageData;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
  onTemplate: (template: JournalTemplate) => void;
  onFilter: (filter: Partial<RegisterFilter>) => void;
}) {
  const [section, setSection] = useState<Section>("imports"),
    [party, setParty] = useState<Party | null>(null),
    [dimension, setDimension] = useState<Dimension | null>(null),
    [query, setQuery] = useState("");
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[240px_1fr]">
      <nav
        aria-label="Manage accounting"
        className="flex gap-2 overflow-x-auto xl:flex-col"
      >
        {[
          ...sections,
          {
            id: "documents" as const,
            name: "Documents",
            description: "Receipts and original source files",
            icon: FileSpreadsheet,
          },
        ].map((s) => (
          <button
            key={s.id}
            aria-current={s.id === section ? "page" : undefined}
            onClick={() => {
              setSection(s.id);
              setQuery("");
            }}
            className={`flex shrink-0 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${section === s.id ? "border-primary/30 bg-primary/5" : "border-transparent hover:bg-secondary/30"}`}
          >
            <s.icon
              size={18}
              className={
                section === s.id ? "text-primary" : "text-muted-foreground"
              }
            />
            <span>
              <span className="block text-sm font-medium">{s.name}</span>
              <span className="mt-1 hidden text-xs text-muted-foreground xl:block">
                {s.description}
              </span>
            </span>
          </button>
        ))}
      </nav>
      <div className="min-w-0">
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
          <section className="glass-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 className="font-semibold">Payees & customers</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Keep consistent names and reviewed contractor treatment.
                </p>
              </div>
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
                <Plus size={15} />
                Add payee
              </Button>
            </div>
            <div className="p-4">
              <Input
                icon={<Search size={15} />}
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
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                  >
                    <div>
                      <p className="font-medium">
                        {p.name}{" "}
                        {p.is_archived && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            Archived
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-xs capitalize text-muted-foreground">
                        {p.kind} · Documentation:{" "}
                        {p.documentation.replace("_", " ")}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onFilter({ payee: p.id })}
                      >
                        Transactions
                        <ArrowRight size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${p.name}`}
                        disabled={demo}
                        onClick={() => setParty(p)}
                      >
                        <Pencil size={15} />
                      </Button>
                    </div>
                  </div>
                ))}
              {!manage.parties.length && (
                <p className="px-5 pb-8 pt-4 text-sm text-muted-foreground">
                  No payees yet. Add your recurring vendors and customers, then
                  choose them on transaction drafts.
                </p>
              )}
            </div>
          </section>
        )}
        {section === "dimensions" && (
          <section className="glass-card overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 className="font-semibold">Projects & business lines</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional attribution without changing your chart of accounts.
                </p>
              </div>
              <Button
                size="sm"
                disabled={demo}
                onClick={() =>
                  setDimension({
                    id: crypto.randomUUID(),
                    version: 0,
                    name: "",
                    kind: "project",
                    customer_id: null,
                    is_archived: false,
                  })
                }
              >
                <Plus size={15} />
                Add
              </Button>
            </div>
            <div className="divide-y divide-border">
              {manage.dimensions.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-3 p-5"
                >
                  <div>
                    <p className="font-medium">{d.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {d.kind === "project" ? "Project" : "Business line"}
                      {d.is_archived ? " · Archived" : ""}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onFilter(
                          d.kind === "project"
                            ? { project: d.id }
                            : { business_line: d.id },
                        )
                      }
                    >
                      Transactions
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={demo}
                      aria-label={`Edit ${d.name}`}
                      onClick={() => setDimension(d)}
                    >
                      <Pencil size={15} />
                    </Button>
                  </div>
                </div>
              ))}
              {!manage.dimensions.length && (
                <p className="p-6 text-sm text-muted-foreground">
                  Add projects or business lines when you need separate profit
                  views.
                </p>
              )}
            </div>
          </section>
        )}
        {section === "templates" && (
          <section className="glass-card overflow-hidden">
            <div className="border-b border-border p-5">
              <h2 className="font-semibold">Journal templates</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Save a balanced transaction as a template from its detail panel.
                Templates always open a new draft for review.
              </p>
            </div>
            <div className="divide-y divide-border">
              {manage.templates
                .filter((t) => !t.is_archived)
                .map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-4 p-5"
                  >
                    <div>
                      <p className="font-medium">{t.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.memo} · {t.lines.length} lines
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={demo}
                      onClick={() => onTemplate(t)}
                    >
                      Use template
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                ))}
              {!manage.templates.some((t) => !t.is_archived) && (
                <p className="p-6 text-sm text-muted-foreground">
                  Your recurring journals will appear here after you save a
                  template.
                </p>
              )}
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
              These defaults help review. They do not rewrite past entries.
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
      <Dialog
        open={!!dimension}
        onOpenChange={(open) => {
          if (!open) setDimension(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dimension?.version ? "Edit dimension" : "Add dimension"}
            </DialogTitle>
            <DialogDescription>
              Use stable labels for your projects and business lines.
            </DialogDescription>
          </DialogHeader>
          {dimension && (
            <DimensionForm
              value={dimension}
              parties={manage.parties}
              onSaved={async () => {
                await onRefresh();
                setDimension(null);
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
      <label className="block text-sm">
        Relationship
        <select
          className={selectStyle}
          value={value.kind}
          onChange={(e) =>
            setValue({ ...value, kind: e.target.value as Party["kind"] })
          }
        >
          <option value="vendor">Vendor / payee</option>
          <option value="customer">Customer</option>
          <option value="both">Vendor and customer</option>
        </select>
      </label>
      <label className="block text-sm">
        Default category
        <select
          className={selectStyle}
          value={value.default_account_id ?? ""}
          onChange={(e) =>
            setValue({ ...value, default_account_id: e.target.value || null })
          }
        >
          <option value="">No default</option>
          {data.accounts
            .filter((a) => !a.is_archived)
            .map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          Tax classification
          <select
            className={selectStyle}
            value={value.tax_classification}
            onChange={(e) =>
              setValue({
                ...value,
                tax_classification: e.target
                  .value as Party["tax_classification"],
              })
            }
          >
            {[
              "unreviewed",
              "individual",
              "corporation",
              "partnership",
              "foreign",
              "other",
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Documentation
          <select
            className={selectStyle}
            value={value.documentation}
            onChange={(e) =>
              setValue({
                ...value,
                documentation: e.target.value as Party["documentation"],
              })
            }
          >
            {["missing", "requested", "received", "not_required"].map((x) => (
              <option key={x} value={x}>
                {x.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        Notes
        <textarea
          className={`${selectStyle} h-24 py-2`}
          maxLength={3000}
          value={value.notes}
          onChange={(e) => setValue({ ...value, notes: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.is_archived}
          onChange={(e) =>
            setValue({ ...value, is_archived: e.target.checked })
          }
        />
        Archive from new selections
      </label>
      {command.error && (
        <p className="text-sm text-destructive" role="alert">
          {command.error}
        </p>
      )}
      <Button disabled={command.busy}>Save payee</Button>
    </form>
  );
}
function DimensionForm({
  value,
  parties,
  onSaved,
}: {
  value: Dimension;
  parties: Party[];
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState(value);
  const command = useAccountingCommand(onSaved);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const { version, ...fields } = form;
        void command.execute({
          type: "dimension.save",
          ...fields,
          expected_version: version,
        });
      }}
    >
      <Input
        label="Name"
        value={form.name}
        required
        maxLength={120}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <label className="block text-sm">
        Type
        <select
          className={selectStyle}
          disabled={form.version > 0}
          value={form.kind}
          onChange={(e) =>
            setForm({ ...form, kind: e.target.value as Dimension["kind"] })
          }
        >
          <option value="project">Project</option>
          <option value="business_line">Business line</option>
        </select>
      </label>
      <label className="block text-sm">
        Customer (optional)
        <select
          className={selectStyle}
          value={form.customer_id ?? ""}
          onChange={(e) =>
            setForm({ ...form, customer_id: e.target.value || null })
          }
        >
          <option value="">No customer</option>
          {parties
            .filter((p) => p.kind !== "vendor" && !p.is_archived)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.is_archived}
          onChange={(e) => setForm({ ...form, is_archived: e.target.checked })}
        />
        Archive from new selections
      </label>
      {command.error && (
        <p className="text-sm text-destructive" role="alert">
          {command.error}
        </p>
      )}
      <Button disabled={command.busy}>Save dimension</Button>
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
  manage: ManageData;
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
    authority_mode:
      manage.preferences?.authority_mode === "parallel_pilot"
        ? "parallel_pilot"
        : "wave_primary",
    history_start: manage.preferences?.history_start ?? null,
    transfer_window_days: manage.preferences?.transfer_window_days ?? 5,
    transit_alert_days: manage.preferences?.transit_alert_days ?? 14,
  }));
  const command = useAccountingCommand(onRefresh);
  return (
    <form
      className="glass-card space-y-5 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void command.execute(form);
      }}
    >
      <div>
        <h2 className="font-semibold">Book settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          USD · Calendar year · One company
        </p>
      </div>
      <Input
        label="Legal company name"
        value={form.legal_name}
        onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
        required
        maxLength={200}
      />
      <label className="block text-sm">
        Operating mode
        <select
          className={selectStyle}
          value={form.authority_mode}
          onChange={(e) =>
            setForm({
              ...form,
              authority_mode: e.target.value as typeof form.authority_mode,
            })
          }
        >
          <option value="wave_primary">Wave remains primary</option>
          <option value="parallel_pilot">Parallel pilot with Wave</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        Switching the primary system requires verified history and completed
        parallel closes. Importing does not create a cutover date or a second
        opening balance.
      </p>
      <Input
        label="Earliest intended history date"
        type="date"
        value={form.history_start ?? ""}
        onChange={(e) =>
          setForm({ ...form, history_start: e.target.value || null })
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Transfer matching window (days)"
          type="number"
          min={0}
          max={30}
          value={form.transfer_window_days}
          onChange={(e) =>
            setForm({ ...form, transfer_window_days: Number(e.target.value) })
          }
        />
        <Input
          label="Transit follow-up after (days)"
          type="number"
          min={1}
          max={365}
          value={form.transit_alert_days}
          onChange={(e) =>
            setForm({ ...form, transit_alert_days: Number(e.target.value) })
          }
        />
      </div>
      {command.error && (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      )}
      <Button disabled={demo || command.busy}>Save settings</Button>
    </form>
  );
}
