"use client";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  FileSpreadsheet,
  Layers,
  Receipt,
  Repeat2,
  Settings2,
  Users,
} from "lucide-react";
import { Select } from "@/components/ui/inputs/Select";

import { cn } from "@/lib/utils";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type { RegisterFilter } from "@/lib/accounting/workflows";
import type { RegisterKind } from "@/lib/accounting/registers";
import {
  resolveManageSection,
  type ManageSection,
} from "@/lib/accounting/views";
import type { BooksMetadata } from "./types";
import { AccountingContacts, suggestedContacts } from "./accounting-contacts";
import { useAccountingCache } from "./accounting-cache";
import { ManagePanelSkeleton } from "./accounting-skeletons";
import type { AccountingQuery } from "@/lib/accounting/read-cache";
import {
  AccountingPageHeader,
  accountingHeader,
} from "./accounting-page-header";

/** Each section's chunk, so the rail can warm one before it is clicked. */
const SECTION_CHUNKS = {
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
    description: "Clients, vendors, contractors",
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
  { name: "Money in and out", ids: ["feeds", "documents"] },
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
  const cache = useAccountingCache();
  // Suggestions from an agent wait for the owner; the rail says how many.
  const suggestedCount = suggestedContacts(manage.parties).length;
  const sectionName = (id: MoreSection) => {
    const name = SECTIONS.find((s) => s.id === id)!.name;
    return id === "payees" && suggestedCount
      ? `${name} (${suggestedCount} suggested)`
      : name;
  };
  // Pointing at a section warms its chunk and its first read.
  function warm(id: ManageSection) {
    if (demo) return;
    if (id in SECTION_CHUNKS)
      void SECTION_CHUNKS[id as keyof typeof SECTION_CHUNKS]();
    const read = SECTION_READS[id];
    if (read) void cache.read(read).catch(() => undefined);
  }

  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader {...accountingHeader("manage", data.legal_name)} />
      <div className="grid items-start gap-6 xl:grid-cols-[208px_1fr]">
        <nav aria-label="Manage sections" className="min-w-0">
          <div className="xl:hidden">
            <Select
              label="Section"
              value={section}
              onChange={(v) => setSection(v as MoreSection)}
              options={GROUPS.flatMap((g) => [
                {
                  value: `group-${g.name}`,
                  label: g.name,
                  isGroupHeader: true,
                },
                ...g.ids.map((id) => ({
                  value: id,
                  label: sectionName(id),
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
                      onClick={() => setSection(s.id)}
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
                      {s.id === "payees" && suggestedCount > 0 && (
                        <span
                          className="ml-auto rounded-full bg-warning/14 px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-warning"
                          aria-label={`${suggestedCount} suggested`}
                        >
                          {suggestedCount}
                        </span>
                      )}
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
          {section === "documents" && (
            <AccountingDocuments demo={demo} onEntry={onEntry} />
          )}

          {section === "payees" && (
            <AccountingContacts
              parties={manage.parties}
              accounts={data.accounts}
              demo={demo}
              focusId={params.get("contact")}
              onRefresh={onRefresh}
              onFilter={onFilter}
            />
          )}
        </div>
      </div>
    </div>
  );
}
