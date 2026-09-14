"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  FileSpreadsheet,
  Layers,
  Pencil,
  Plus,
  Receipt,
  Repeat2,
  Search,
  Settings2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";

import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type { Party, RegisterFilter } from "@/lib/accounting/workflows";
import type { RegisterKind } from "@/lib/accounting/registers";
import {
  resolveManageSection,
  type ManageSection,
} from "@/lib/accounting/views";
import type { BooksMetadata } from "./types";
import { PartyDialog, newParty } from "./accounting-party-form";
import { useAccountingCache } from "./accounting-cache";
import { ManagePanelSkeleton } from "./accounting-skeletons";
import { enumLabel } from "./format";
import type { AccountingQuery } from "@/lib/accounting/read-cache";

/** Each section's chunk, so the rail can warm one before it is clicked. */
const SECTION_CHUNKS = {
  imports: () => import("./accounting-imports"),
  documents: () => import("./accounting-documents"),
  rules: () => import("./accounting-rules"),
  tax: () => import("./accounting-tax-workpapers"),
  registers: () => import("./accounting-manual-registers"),
  feeds: () => import("./accounting-feeds"),
};
/** The first read of the sections that take one, keyed as they ask for it. */
const SECTION_READS: Partial<Record<ManageSection, AccountingQuery>> = {
  documents: { view: "documents" },
  rules: { view: "rules" },
  feeds: { view: "feeds" },
};
const loading = () => <ManagePanelSkeleton />;
const AccountingImports = dynamic(
  () => SECTION_CHUNKS.imports().then((m) => m.AccountingImports),
  { loading },
);
const AccountingDocuments = dynamic(
  () => SECTION_CHUNKS.documents().then((m) => m.AccountingDocuments),
  { loading },
);
const AccountingRules = dynamic(
  () => SECTION_CHUNKS.rules().then((m) => m.AccountingRules),
  { loading },
);
const AccountingTaxWorkpapers = dynamic(
  () => SECTION_CHUNKS.tax().then((m) => m.AccountingTaxWorkpapers),
  { loading },
);
const AccountingManualRegisters = dynamic(
  () => SECTION_CHUNKS.registers().then((m) => m.AccountingManualRegisters),
  { loading },
);
const AccountingFeeds = dynamic(
  () => SECTION_CHUNKS.feeds().then((m) => m.AccountingFeeds),
  { loading },
);

export type MoreSection = ManageSection;

const SECTIONS: {
  id: MoreSection;
  name: string;
  description: string;
  icon: typeof Users;
}[] = [
  {
    id: "feeds",
    name: "Bank connections",
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
    id: "documents",
    name: "Receipts",
    description: "Receipts and source files",
    icon: Receipt,
  },
  {
    id: "registers",
    name: "Assets & loans",
    description: "Equipment, depreciation and loan balances",
    icon: Layers,
  },
  {
    id: "tax",
    name: "Tax",
    description: "Workpapers and adjustments",
    icon: FileSpreadsheet,
  },
  {
    id: "payees",
    name: "Contacts",
    description: "Vendors, customers, contractors",
    icon: Users,
  },
  {
    id: "rules",
    name: "Rules",
    description: "Automatic categorization",
    icon: Settings2,
  },
];
const GROUPS: { name: string; ids: MoreSection[] }[] = [
  { name: "Money in and out", ids: ["feeds", "imports", "documents"] },
  { name: "Registers", ids: ["registers"] },
  { name: "Reference", ids: ["payees", "rules"] },
  { name: "Year end", ids: ["tax"] },
];

/**
 * The Manage screen: everything that is not the ledger, the chart, payroll
 * or a report. One rail on wide screens, one select on narrow ones. Old
 * Records and Settings section ids still resolve to their new homes.
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
  const candidate = params.get("section") ?? initialSection ?? null;
  const section: MoreSection =
    resolveManageSection(candidate) ?? GROUPS[0].ids[0];
  // The register kind rides in the URL; the retired assets and loans ids still name one.
  const registerKind: RegisterKind =
    params.get("kind") === "loan" || candidate === "loans" ? "loan" : "asset";
  function setSection(next: MoreSection) {
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    url.searchParams.delete("kind");
    url.searchParams.delete("register");
    window.history.pushState(null, "", url);
  }
  function setRegisterKind(next: RegisterKind) {
    const url = new URL(window.location.href);
    url.searchParams.set("section", "registers");
    url.searchParams.set("kind", next);
    url.searchParams.delete("register");
    window.history.pushState(null, "", url);
  }
  const [party, setParty] = useState<Party | null>(null);
  const [query, setQuery] = useState("");
  const cache = useAccountingCache();
  // Pointing at a section warms its chunk and its first read.
  function warm(id: ManageSection) {
    if (demo) return;
    if (id in SECTION_CHUNKS)
      void SECTION_CHUNKS[id as keyof typeof SECTION_CHUNKS]();
    const read = SECTION_READS[id];
    if (read) void cache.read(read).catch(() => undefined);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Manage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Bank connections, imports, receipts, registers, contacts, rules and
          year end.
        </p>
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[208px_1fr]">
        <nav aria-label="Manage sections" className="min-w-0">
          <div className="xl:hidden">
            <Select
              label="Section"
              value={section}
              onChange={(v) => {
                setSection(v as MoreSection);
                setQuery("");
              }}
              options={GROUPS.flatMap((g) => [
                {
                  value: `group-${g.name}`,
                  label: g.name,
                  isGroupHeader: true,
                },
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
                      onPointerEnter={() => warm(s.id)}
                      onFocus={() => warm(s.id)}
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
          {section === "registers" && (
            <div className="space-y-5">
              <div
                role="group"
                aria-label="Register"
                className="seg-track seg-sm w-fit"
              >
                {(["asset", "loan"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={registerKind === kind}
                    className={cn(
                      "seg-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      registerKind === kind && "is-active",
                    )}
                    onClick={() => setRegisterKind(kind)}
                  >
                    {kind === "asset" ? "Assets" : "Loans"}
                  </button>
                ))}
              </div>
              <AccountingManualRegisters
                key={registerKind}
                kind={registerKind}
                accounts={data.accounts}
                manage={manage}
                demo={demo}
                onRefresh={onRefresh}
                onEntry={onEntry}
              />
            </div>
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

          {section === "payees" && (
            <section className="space-y-3">
              <SectionHeader
                label="Contacts"
                count={manage.parties.length}
                description="Vendors and customers, with the contractor flag for year-end reporting."
                action={
                  <Button
                    size="sm"
                    disabled={demo}
                    onClick={() => setParty(newParty())}
                  >
                    <Plus size={15} aria-hidden="true" />
                    Add contact
                  </Button>
                }
              />
              <div className="glass-card overflow-hidden rounded-xl">
                <div className="p-4">
                  <TextInput
                    prefix={<Search size={15} aria-hidden="true" />}
                    aria-label="Find contact"
                    placeholder="Find a vendor or customer"
                    value={query}
                    onChange={(nextValue) => setQuery(nextValue)}
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
                      No contacts yet. Add recurring vendors and customers, then
                      choose them on transactions.
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>

        <PartyDialog
          party={party}
          accounts={data.accounts}
          onClose={() => setParty(null)}
          onSaved={async () => {
            await onRefresh();
            setParty(null);
          }}
        />
      </div>
    </div>
  );
}
