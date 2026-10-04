"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, FileCheck2, ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { reportFilterSchema, type ReportData, type ReportFilter } from "@/lib/accounting/reports";
import { supportReportFilterSchema, type SupportReportData } from "@/lib/accounting/support-reports";
import { reportQuery } from "@/lib/accounting/preload";
import { demoReportData, demoReportDetail } from "@/lib/accounting/demo-reports";
import { accountingHref } from "@/lib/accounting/views";
import {
  CONTRACTOR_GROUPS,
  CONTRACTOR_NOTES,
  KIND_LABELS,
  STATUS_LABELS,
  W9_LABELS,
  contractorDecisions,
  contractorLines,
  contractorRule,
  contractorScope,
  contractorSentence,
  contractorTotals,
  contractorYears,
  type ContractorLine,
  type ContractorStatus,
} from "@/lib/accounting/contractor-worksheet";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { todayInBooks } from "./format";
import {
  CardRow,
  CardTotal,
  ExportMenu,
  ReportSkeleton,
  ScopeNotice,
  SectionCard,
  StatTile,
} from "./report-kit";
import {
  CheckList,
  SupportNotes,
  YearControls,
  useSupportExport,
  useSupportReport,
} from "./support-report-kit";

const ZERO = BigInt(0);

const STATUS_BADGE: Record<ContractorStatus, "success" | "warning" | "default"> = {
  "missing-w9": "warning",
  decide: "warning",
  ready: "success",
  under: "default",
  exempt: "default",
  unpaid: "default",
};

const contactHref = (id: string) => accountingHref("manage", "payees", { contact: id });

/**
 * The contractor worksheet: who needs a 1099 for a calendar year, and what
 * is missing before one can be filed. Calendar years, because 1099s follow
 * the calendar, not the fiscal year. Reviewed transactions only, as the
 * books report it.
 */
export function AccountingContractorWorksheet({
  onBack,
  onEntry,
  onReview,
  demo = false,
}: {
  onBack: () => void;
  onEntry: (id: string) => void;
  onReview: () => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  const years = contractorYears(today);
  const saved = (() => {
    try {
      const parsed = supportReportFilterSchema.safeParse(JSON.parse(params.get("support_filter") ?? "{}"));
      return parsed.success ? Number(parsed.data.to.slice(0, 4)) : null;
    } catch {
      return null;
    }
  })();
  const year = saved && years.includes(saved) ? saved : (years[0] ?? Number(today.slice(0, 4)));
  const filter = contractorScope(year, today);
  const read = useSupportReport(filter, demo);
  const data = read.data;
  const exporter = useSupportExport();
  const { isHidden } = usePrivacy();
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);

  // What the worksheet leaves out: reviewed transactions only, so say how
  // many are still waiting for review in the year.
  const yearScope: ReportFilter = { from: filter.from, to: filter.to, mode: "posted", offset: 0 };
  const scopeRead = useAccountingRead<ReportData>(reportQuery("vendor-expenses", yearScope), {
    enabled: !demo,
    keepPrevious: true,
  });
  const demoScope = useMemo(
    () => (demo ? demoReportData(yearScope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, year],
  );
  const scopeData = demo ? demoScope : (scopeRead.data ?? null);

  function chooseYear(next: number) {
    setDrill(null);
    const url = new URL(window.location.href);
    url.searchParams.set("support_filter", JSON.stringify(contractorScope(next, today)));
    window.history.pushState(null, "", url);
  }
  function openPayments(l: ContractorLine) {
    const parsed = reportFilterSchema.safeParse({
      from: filter.from,
      to: filter.to,
      mode: "posted",
      payee: l.id,
      // The money side of each payment: the bank or cash account lines are
      // what count, the card lines are what is left out.
      account_types: ["asset", "liability"],
      offset: 0,
    });
    if (parsed.success) setDrill({ title: `Payments to ${l.name}, ${year}`, filter: parsed.data });
  }

  const errorMessage = exporter.error || (!data && read.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Contractor worksheet"
        subtitle="Who needs a 1099, and what's missing before you can file."
        actions={
          <ExportMenu
            label="Export the contractor worksheet"
            disabled={!data || read.loading}
            exporting={exporter.exporting}
            demo={demo}
            pdfDescription="Branded worksheet for your accountant"
            csvDescription="One row per contractor, ready for filing"
            onExport={(format) => data && void exporter.run(data, format)}
          />
        }
      />
      <YearControls
        years={years}
        year={year}
        from={filter.from}
        to={filter.to}
        scope="Reviewed contractor payments"
        updating={read.updating}
        onYear={chooseYear}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {read.loading && !data ? (
        <ReportSkeleton label="Preparing the contractor worksheet" />
      ) : data ? (
        <div
          aria-busy={read.updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", read.updating && "opacity-70")}
        >
          {scopeData && <ScopeNotice data={scopeData} onReview={onReview} />}
          <Worksheet
            data={data}
            complete={read.complete}
            privacy={isHidden}
            onPayments={openPayments}
            onReload={read.reload}
          />
        </div>
      ) : null}
      {drill && data && (
        <AccountingReportDetail
          key={JSON.stringify(drill)}
          title={drill.title}
          filter={drill.filter}
          revision={data.revision}
          load={demo ? demoReportDetail : undefined}
          onClose={() => setDrill(null)}
          onEntry={(id) => {
            setDrill(null);
            onEntry(id);
          }}
          onChanged={read.reload}
        />
      )}
    </div>
  );
}

function Worksheet({
  data,
  complete,
  privacy,
  onPayments,
  onReload,
}: {
  data: SupportReportData;
  complete: boolean;
  privacy: boolean;
  onPayments: (l: ContractorLine) => void;
  onReload: () => void;
}) {
  const year = Number(data.filter.to.slice(0, 4));
  const inProgress = data.filter.to < `${year}-12-31`;
  const rule = contractorRule(year);
  const lines = contractorLines(data);
  const t = contractorTotals(lines);
  const decisions = contractorDecisions(lines);
  const paid = lines.filter((l) => l.status !== "unpaid");
  const lineText = rule.line === null ? "No line" : formatCents(rule.line);
  if (!lines.length)
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <ListChecks size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No contractors yet</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Give the people and businesses you hire the contractor role in Manage, Contacts, and their payments appear here.
        </p>
      </Card>
    );
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="Contractors paid"
          value={String(t.paid)}
          context={t.unpaid ? `${t.unpaid} more not paid in ${year}` : `In ${year}${inProgress ? " so far" : ""}`}
        />
        <StatTile label="Need a 1099" value={String(t.needs1099)} context={`Paid ${lineText} or more`} />
        <StatTile
          label="Missing W-9 or details"
          value={String(t.missing)}
          context={t.missing ? "Before you can file" : "Nothing missing"}
          tone={t.missing ? "bad" : t.needs1099 ? "good" : "neutral"}
        />
        <StatTile
          label="Paid to contractors"
          value={formatCents(t.total)}
          context={privacy ? "Bank and cash payments count" : `${formatCents(t.reportable)} counts`}
        />
      </section>

      <CardRow>
        <SectionCard
          labelledBy="cw-decisions"
          title="Needs a decision"
          description={contractorSentence(t, year, inProgress)}
        >
          <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6">
            <CheckList
              empty="Nothing to decide: every contractor you paid has a type and a W-9 setting that fit."
              items={decisions.map((d) => ({
                ...d,
                action: (
                  <a
                    href={contactHref(d.contactId)}
                    className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    Open the contact
                    <ArrowUpRight size={12} aria-hidden="true" />
                    <span className="sr-only">, {d.title}</span>
                  </a>
                ),
              }))}
            />
          </div>
        </SectionCard>
        <LineCard year={year} rule={rule} t={t} inProgress={inProgress} />
      </CardRow>

      <section aria-labelledby="cw-cards" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="cw-cards" className="text-base font-semibold">
            Each contractor
          </h2>
          <p className="text-xs text-muted-foreground">
            {t.unpaid
              ? `${t.unpaid} more ${t.unpaid === 1 ? "contractor was" : "contractors were"} not paid in ${year}; see the statement.`
              : "Needs first, then ready, then the rest."}
          </p>
        </div>
        {paid.length ? (
          <ul className="grid items-stretch gap-3 md:grid-cols-2 lg:gap-4 2xl:grid-cols-3">
            {paid.map((l) => (
              <li key={l.id} className="min-w-0">
                <ContractorCard line={l} year={year} onPayments={() => onPayments(l)} />
              </li>
            ))}
          </ul>
        ) : (
          <Card className="px-5 py-6 text-sm text-muted-foreground">No contractor was paid in {year}.</Card>
        )}
      </section>

      <Statement lines={lines} t={t} complete={complete} count={data.count} onPayments={onPayments} />

      <SupportNotes data={data} notes={CONTRACTOR_NOTES} onReload={onReload} />
    </>
  );
}

/** The year's line and what counts toward it, with the amounts. */
function LineCard({
  year,
  rule,
  t,
  inProgress,
}: {
  year: number;
  rule: ReturnType<typeof contractorRule>;
  t: ReturnType<typeof contractorTotals>;
  inProgress: boolean;
}) {
  const hover = useMaskedHover();
  const rows: { label: string; hint: string; amount: bigint | null }[] = [
    {
      label: "Counts toward the line",
      hint: "Paid from a bank or cash account, less refunds",
      amount: t.reportable,
    },
    { label: "Left out: card payments", hint: "The card company reports these on a 1099-K", amount: t.card },
    { label: "Not split out: reimbursements", hint: "Expenses billed to you count as paid; check them", amount: null },
  ];
  return (
    <SectionCard
      labelledBy="cw-line"
      title={`The ${year} line`}
      description={
        rule.line === null
          ? `The contractor rules do not cover ${year} yet.`
          : `A contractor paid ${formatCents(rule.line)} or more in ${year} needs a 1099-NEC${year >= 2026 ? ", up from $600.00 before 2026" : ""}.${inProgress ? " The year is not over, so totals can still pass it." : ""}`
      }
    >
      <div className="flex flex-1 flex-col px-5 pb-4 lg:px-6" {...hover.hoverProps}>
        <dl className="divide-y divide-border border-y border-border text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex items-start justify-between gap-4 py-2.5">
              <dt className="min-w-0">
                <span className="block">{r.label}</span>
                <span className="block text-xs text-muted-foreground">{r.hint}</span>
              </dt>
              <dd className="shrink-0 text-right tabular-nums">
                {r.amount === null ? (
                  <span className="text-muted-foreground">Not tracked</span>
                ) : (
                  <MaskedValue value={formatCents(r.amount)} inheritHover />
                )}
              </dd>
            </div>
          ))}
        </dl>
        {rule.source && (
          <a
            href={rule.source}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 self-start rounded-md text-xs text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            The IRS rule for {year}
            <ArrowUpRight size={12} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
      <CardTotal label="Paid to contractors" amount={t.total} />
    </SectionCard>
  );
}

/** One contractor: ready or not, the amounts, the W-9 and type, and the next step. */
function ContractorCard({
  line: l,
  year,
  onPayments,
}: {
  line: ContractorLine;
  year: number;
  onPayments: () => void;
}) {
  const titleId = `cw-c-${l.id}`;
  return (
    <Card className="flex h-full min-w-0 flex-col" role="group" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-3 p-4 pb-3 lg:p-5 lg:pb-3">
        <h3 id={titleId} className="min-w-0 truncate text-sm font-semibold" title={l.name}>
          {l.name}
        </h3>
        <Badge size="sm" variant={STATUS_BADGE[l.status]} dot className="shrink-0">
          {STATUS_LABELS[l.status]}
        </Badge>
      </div>
      <dl className="mx-4 divide-y divide-border border-y border-border text-sm lg:mx-5">
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">Counts toward the line</dt>
          <dd className="tabular-nums font-medium">
            <MaskedValue value={formatCents(l.reportable)} />
          </dd>
        </div>
        {l.card > ZERO && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-muted-foreground">Paid by card, left out</dt>
            <dd className="tabular-nums">
              <MaskedValue value={formatCents(l.card)} />
            </dd>
          </div>
        )}
        {l.cash < ZERO && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-muted-foreground">Refunded more than paid</dt>
            <dd className="tabular-nums">
              <MaskedValue value={formatCents(-l.cash)} />
            </dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">Type, W-9</dt>
          <dd className="text-right">
            {KIND_LABELS[l.kind]}, {W9_LABELS[l.w9].toLowerCase()}
          </dd>
        </div>
      </dl>
      <div className="flex flex-1 flex-col px-4 pt-3 pb-4 lg:px-5 lg:pb-5">
        <p className="flex items-start gap-2 text-sm">
          <FileCheck2
            size={16}
            aria-hidden="true"
            className={cn(
              "mt-0.5 shrink-0",
              l.status === "ready" ? "text-success" : l.status === "missing-w9" || l.status === "decide" ? "text-warning" : "text-muted-foreground",
            )}
          />
          <span className="min-w-0">
            <span className="block font-medium">{l.step}</span>
            <span className="block text-xs leading-relaxed text-muted-foreground">{l.reason}</span>
          </span>
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          <Button variant="outline" size="sm" onClick={onPayments}>
            Payments in {year}
            <span className="sr-only">, {l.name}</span>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={contactHref(l.id)}>
              Contact
              <ArrowUpRight aria-hidden="true" />
              <span className="sr-only">, {l.name}</span>
            </a>
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Every contractor by group: what counts, what is left out, the total and the status. */
function Statement({
  lines,
  t,
  complete,
  count,
  onPayments,
}: {
  lines: ContractorLine[];
  t: ReturnType<typeof contractorTotals>;
  complete: boolean;
  count: number;
  onPayments: (l: ContractorLine) => void;
}) {
  const grid =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 @2xl:grid-cols-[minmax(0,1fr)_7.5rem_7rem_7.5rem_9rem]";
  return (
    <SectionCard
      labelledBy="cw-statement"
      title="Statement"
      description="Every contractor on file for the year. Select one to see the payments."
    >
      <div className="@container border-t border-border">
        <div
          aria-hidden="true"
          className={cn(
            grid,
            "hidden px-5 pt-3 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid lg:px-6",
          )}
        >
          <span>Contact</span>
          <span className="text-right">Counts</span>
          <span className="text-right">By card</span>
          <span className="text-right">Total paid</span>
          <span className="text-right">Status</span>
        </div>
        {CONTRACTOR_GROUPS.map((g) => {
          const list = lines.filter(g.match);
          if (!list.length) return null;
          return (
            <div key={g.key} className="px-2.5 pb-2 lg:px-3.5">
              <p className="px-2.5 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.12em] text-teal-light">
                {g.label}
              </p>
              <ul className="space-y-0.5">
                {list.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => onPayments(l)}
                      className={cn(
                        grid,
                        "w-full items-baseline rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate" title={l.name}>
                          {l.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {KIND_LABELS[l.kind]}, W-9 {W9_LABELS[l.w9].toLowerCase()}
                          <span className="@2xl:hidden"> · {STATUS_LABELS[l.status]}</span>
                        </span>
                      </span>
                      <span className="text-right tabular-nums">
                        <MaskedValue value={formatCents(l.reportable)} />
                        {l.card > ZERO && (
                          <span className="block text-xs text-muted-foreground @2xl:hidden">
                            <MaskedValue value={`+${formatCents(l.card)} by card`} />
                          </span>
                        )}
                      </span>
                      <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                        {l.card > ZERO ? <MaskedValue value={formatCents(l.card)} /> : ""}
                      </span>
                      <span className="hidden text-right tabular-nums @2xl:block">
                        <MaskedValue value={formatCents(l.total)} />
                      </span>
                      <span
                        className={cn(
                          "hidden text-right text-xs @2xl:block",
                          l.status === "ready"
                            ? "text-success"
                            : l.status === "missing-w9" || l.status === "decide"
                              ? "text-warning"
                              : "text-muted-foreground",
                        )}
                      >
                        {STATUS_LABELS[l.status]}
                      </span>
                      <span className="sr-only">, show the payments</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {!complete && (
          <p className="px-5 pb-2 text-xs text-muted-foreground lg:px-6">
            Showing the first {lines.length} of {count} contractors. The export lists every one.
          </p>
        )}
      </div>
      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-border px-5 py-3.5 text-sm lg:px-6">
        <span className="text-muted-foreground">Left out, by card</span>
        <span className="text-right tabular-nums">
          <MaskedValue value={formatCents(t.card)} />
        </span>
        <span className="font-semibold">Counts toward 1099s</span>
        <span className="text-right font-semibold tabular-nums">
          <MaskedValue value={formatCents(t.reportable)} />
        </span>
      </div>
    </SectionCard>
  );
}
