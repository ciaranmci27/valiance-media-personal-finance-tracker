"use client";
import { NumberInput } from "@/components/ui/inputs/NumberInput";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { TableSkeleton } from "@/components/ui/skeleton";
import type { BooksMetadata } from "./types";
import {
  contractorFilterSchema,
  contractorYearRules,
  type ContractorFilter,
  type ContractorItem,
  type ContractorView,
} from "@/lib/accounting/contractors";
import { AccountingPicker } from "./accounting-picker";
import {
  countLabel,
  dateLabel,
  enumLabel,
  money,
  todayInBooks,
} from "./format";
import { accountingGet } from "./use-accounting-command";

/** The contractors read pages by 100 parties. */
const PAGE = 100;
const classificationLabels: Record<string, string> = {
  unknown: "Not classified",
  individual: "Individual",
  corporation: "Corporation",
  foreign: "Foreign",
  other: "Other",
};
const documentationBadges: Record<
  string,
  { label: string; variant: BadgeVariant }
> = {
  missing: { label: "W-9 missing", variant: "warning" },
  received: { label: "W-9 received", variant: "success" },
  not_required: { label: "Not required", variant: "default" },
};
const totalCents = (row: ContractorItem) =>
  (BigInt(row.paid_cents) + BigInt(row.card_cents)).toString();

export function AccountingContractors({
  manage,
  demo,
  onRefresh,
}: {
  manage: BooksMetadata;
  demo: boolean;
  onRefresh: () => Promise<void>;
  /** Shared section contract; the worksheet has no entry rows to open. */
  onEntry: (id: string) => void;
}) {
  const today = todayInBooks(),
    params = useSearchParams(),
    currentYear = Number(today.slice(0, 4));
  let applied: ContractorFilter = {
    year: currentYear,
    through: today,
    offset: 0,
    query: "",
  };
  try {
    const parsed = contractorFilterSchema.safeParse(
      JSON.parse(params.get("contractor_filter") ?? "{}"),
    );
    if (parsed.success) applied = parsed.data;
  } catch {
    /* Invalid saved filters fall back to the current year. */
  }
  const signature = JSON.stringify(applied),
    [draft, setDraft] = useState(applied),
    [data, setData] = useState<ContractorView | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0);
  useEffect(() => setDraft(JSON.parse(signature)), [signature]);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    accountingGet<ContractorView>(
      { view: "contractors", filter: signature },
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [signature, tick, demo]);
  function apply(filter: ContractorFilter) {
    const result = contractorFilterSchema.safeParse(filter);
    if (!result.success || filter.through > today) {
      setError("Choose a valid year and cutoff through today.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("contractor_filter", JSON.stringify(result.data));
    window.history.pushState(null, "", url);
    if (JSON.stringify(result.data) === signature) setTick((n) => n + 1);
  }
  async function refresh() {
    await onRefresh();
    setTick((n) => n + 1);
  }
  const rule = contractorYearRules[applied.year],
    partyName = manage.parties.find((p) => p.id === applied.party)?.name,
    partyOptions = [
      { value: "", label: "All contractors" },
      ...manage.parties
        .filter((p) => !p.is_archived || p.id === draft.party)
        .map((p) => ({ value: p.id, label: p.name })),
    ];
  const paymentsHref = (row: ContractorItem) =>
    `/accounting?view=reports&report=vendor-expenses&report_filter=${encodeURIComponent(
      JSON.stringify({
        from: `${applied.year}-01-01`,
        to: applied.through,
        mode: "posted",
        offset: 0,
        payee: row.id,
      }),
    )}`;
  const classification = (row: ContractorItem) =>
    classificationLabels[row.contractor_classification] ??
    enumLabel(row.contractor_classification);
  const documentation = (row: ContractorItem) => {
    const badge = documentationBadges[row.documentation_status] ?? {
      label: enumLabel(row.documentation_status),
      variant: "default" as BadgeVariant,
    };
    return <Badge variant={badge.variant}>{badge.label}</Badge>;
  };
  const threshold = (row: ContractorItem) =>
    row.meets_threshold ? (
      <Badge variant="copper">Reaches minimum</Badge>
    ) : (
      <Badge>Below minimum</Badge>
    );
  const amount = (cents: string) => (
    <MaskedValue value={money(cents)} className="tabular-nums" />
  );
  const paymentsLink = (row: ContractorItem) => (
    <Button variant="ghost" size="sm" asChild>
      <a href={paymentsHref(row)}>
        Payments
        <ArrowUpRight aria-hidden="true" />
      </a>
    </Button>
  );
  const columns: DataTableColumn<ContractorItem>[] = [
    {
      key: "name",
      header: "Contractor",
      render: (row) => (
        <span className="block max-w-xs truncate font-medium">{row.name}</span>
      ),
    },
    {
      key: "classification",
      header: "Classification",
      render: classification,
    },
    { key: "documentation", header: "Documentation", render: documentation },
    {
      key: "cash",
      header: "Cash paid",
      align: "right",
      numeric: true,
      render: (row) => amount(row.paid_cents),
    },
    {
      key: "card",
      header: "Card paid",
      align: "right",
      numeric: true,
      render: (row) => amount(row.card_cents),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      numeric: true,
      render: (row) => amount(totalCents(row)),
    },
    { key: "threshold", header: "Minimum", render: threshold },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: paymentsLink,
    },
  ];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Contractor worksheet</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Posted payments to each contractor for the year, with classification
            and documentation status, through the cutoff you choose.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading || demo}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          <Button variant="outline" asChild>
            <a
              href={`/accounting?view=reports&report=contractor-worksheet&support_filter=${encodeURIComponent(JSON.stringify({ report_id: "contractor-worksheet", from: `${applied.year}-01-01`, to: applied.through, offset: 0 }))}`}
            >
              Year worksheet
            </a>
          </Button>
        </div>
      </header>
      <form
        className="glass-card grid items-end gap-3 rounded-xl p-4 sm:grid-cols-2 xl:grid-cols-[130px_170px_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ ...draft, offset: 0 });
        }}
      >
        <NumberInput
          step={1}
          label="Tax year"
          min={1900}
          max={currentYear}
          value={draft.year}
          onChange={(nextValue) => {
            const year = Number(String(nextValue));
            setDraft((d) => ({
              ...d,
              year,
              through: year === currentYear ? today : `${year}-12-31`,
            }));
          }}
        />
        <DateInput
          id="contractor-through"
          label="Through"
          minDate={`${draft.year}-01-01`}
          maxDate={today}
          value={draft.through}
          onChange={(nextValue) =>
            setDraft((d) => ({ ...d, through: nextValue }))
          }
        />
        <TextInput
          label="Search contractors"
          value={draft.query}
          onChange={(nextValue) =>
            setDraft((d) => ({ ...d, query: nextValue }))
          }
        />
        <AccountingPicker
          label="Contractor"
          visibleLabel="Contractor"
          triggerId="contractor-party"
          value={draft.party ?? ""}
          options={partyOptions}
          onChange={(id) => setDraft((d) => ({ ...d, party: id || undefined }))}
        />
        <Button type="submit" disabled={loading || demo}>
          Apply
        </Button>
      </form>
      {applied.party && (
        <div className="flex items-center gap-3 text-sm">
          <span>Contractor: {partyName ?? "Selected contractor"}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => apply({ ...applied, party: undefined, offset: 0 })}
          >
            Show all contractors
          </Button>
        </div>
      )}
      {data && (
        <p className="text-sm text-muted-foreground">
          {countLabel(data.count, "contractor")} paid through{" "}
          {dateLabel(data.through)}. {data.year} minimum:{" "}
          <MaskedValue
            value={money(data.threshold_cents)}
            className="tabular-nums"
          />
          {rule && (
            <>
              {" "}
              (
              <a
                className="text-teal-light hover:underline"
                href={rule.source}
                target="_blank"
                rel="noreferrer"
              >
                source, revision {rule.revision}
              </a>
              )
            </>
          )}
          . The minimum test counts cash and bank payments; card payments are
          listed separately and remain subject to reporting exceptions.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-3 text-sm text-error"
        >
          {error}
        </p>
      )}
      {demo ? (
        <p className="py-10 text-sm text-muted-foreground">
          Contractor totals become available in configured books.
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={data?.rows ?? []}
          keyExtractor={(row) => row.id}
          busy={loading}
          emptyState={
            loading && !data ? (
              <div role="status" aria-label="Loading contractors...">
                <TableSkeleton rows={4} />
              </div>
            ) : (
              "No contractors in this scope."
            )
          }
          mobileCard={(row) => (
            <div className="glass-card space-y-3 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {classification(row)}
                  </p>
                </div>
                {documentation(row)}
              </div>
              <dl className="grid grid-cols-3 gap-3 text-xs">
                {(
                  [
                    ["Cash", row.paid_cents],
                    ["Card", row.card_cents],
                    ["Total", totalCents(row)],
                  ] as const
                ).map(([label, cents]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-1 text-sm">{amount(cents)}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {threshold(row)}
                {paymentsLink(row)}
              </div>
            </div>
          )}
          after={
            data ? (
              <Pagination
                offset={data.offset}
                limit={PAGE}
                total={data.count}
                onChange={(next) => apply({ ...applied, offset: next })}
                noun="contractors"
                busy={loading}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}
