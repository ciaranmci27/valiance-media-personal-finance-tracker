"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowUpRight, Receipt, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import {
  ContactReportChart,
  REST_SWATCH,
  STACK_SWATCHES,
  type ContactMetric,
} from "@/components/charts/contact-report-chart";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import {
  reportFilterSchema,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import { defaultReportFilter, reportQuery } from "@/lib/accounting/preload";
import {
  changeOf,
  changeTone,
  compareLabel,
  rangeLabel,
} from "@/lib/accounting/profit-loss";
import {
  VENDOR_NOTES,
  VENDOR_REPORT,
  contactMonths,
  contactRows,
  contactStatement,
  contactSummary,
  isEmptyContactReport,
  primaryRole,
  rankedRows,
  seriesIds,
  spendByRole,
  SERIES_LIMIT,
  type ContactParty,
  type ContactRow,
  type RoleShare,
} from "@/lib/accounting/contact-report";
import {
  CADENCE_WORDS,
  recurringFilterFor,
  recurringQuery,
  recurringSummary,
  type RecurringData,
  type RecurringRow,
  type RecurringSummary,
} from "@/lib/accounting/recurring";
import { contractorNote, contractorScope, contractorYears } from "@/lib/accounting/contractor-worksheet";
import {
  demoParties,
  demoRecurring,
  demoReportData,
  demoReportDetail,
} from "@/lib/accounting/demo-reports";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { useContactSeries } from "./use-contact-series";
import { useReportExport } from "./use-report-export";
import { useSupportReport } from "./support-report-kit";
import { dateLabel, todayInBooks } from "./format";
import { PeriodControls } from "./report-period-controls";
import { useFiscalStartMonth } from "./use-fiscal-year";
import type { BooksMetadata } from "./types";
import {
  CardRow,
  CardTotal,
  CoverageDisclosure,
  ExportMenu,
  HealthLine,
  LegendRow,
  MetricTile,
  RankedList,
  ReportSkeleton,
  ScopeNotice,
  ScrollList,
  SectionCard,
  Segmented,
  StatementTable,
  readReportFilter,
  writeReportFilter,
  type Drill,
  type TileChange,
} from "./report-kit";

const ZERO = BigInt(0);
const config = VENDOR_REPORT;

type VendorMetric = Exclude<ContactMetric, "average">;

const metricCopy: Record<
  VendorMetric,
  { tile: string; title: (top: string) => string; description: string }
> = {
  amount: {
    tile: "Spending",
    title: () => "Spending by month, by payee",
    description: "Each month's expenses, with the payees you paid most stacked first.",
  },
  count: {
    tile: "Contacts paid",
    title: () => "Contacts paid by month",
    description: "How many vendors, contractors and others you paid in each month.",
  },
  share: {
    tile: "Biggest payee's share",
    title: (top) => `${top}'s share of each month's spending`,
    description: "How much of each month's spending went to the payee you paid most.",
  },
  extra: {
    tile: "Repeat charges",
    title: () => "Spending with payees that charge on a schedule",
    description:
      "Each month's spending with the payees whose charges repeat on a steady beat (subscriptions, payroll, plans).",
  },
};

export function AccountingVendorExpenses({
  from,
  to,
  manage,
  onBack,
  onEntry,
  onReview,
  onOpenReport,
  demo = false,
}: {
  from: string;
  to: string;
  manage: BooksMetadata;
  onBack: () => void;
  onEntry: (id: string) => void;
  onReview: () => void;
  /** Opens another report, e.g. the Contractor worksheet. */
  onOpenReport?: (id: "contractor-worksheet") => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  const fallback = demo
    ? defaultReportFilter(`${today.slice(0, 4)}-01-01`, today)
    : defaultReportFilter(from, to);
  // The page is about every contact: a link scoped to one is read without it.
  const filter: ReportFilter = {
    ...readReportFilter(params.get("report_filter"), fallback),
    payee: undefined,
  };
  const signature = JSON.stringify(filter);
  const [metric, setMetric] = useState<VendorMetric>("amount");
  const [detail, setDetail] = useState(false);
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);
  const exporter = useReportExport();
  const fiscalStart = useFiscalStartMonth(demo);
  const { isHidden } = usePrivacy();

  const live = !demo;
  const options = { enabled: live, keepPrevious: true };
  const reportRead = useAccountingRead<ReportData>(reportQuery("vendor-expenses", filter), options);
  // The 1099 note reads the Contractor worksheet itself, for the calendar
  // year of the period's end, so the two always agree.
  const year = Number(filter.to.slice(0, 4));
  const worksheet = useSupportReport(contractorScope(year, today), demo, contractorYears(today).includes(year));
  const recurringRead = useAccountingRead<RecurringData>(
    recurringQuery(recurringFilterFor(filter)),
    options,
  );
  const demoData = useMemo(
    () => (demo ? demoReportData(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const demoRecurringData = useMemo(
    () => (demo ? demoRecurring(recurringFilterFor(filter)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
  const note = worksheet.data && contractorYears(today).includes(year) ? contractorNote(worksheet.data) : null;
  // The worksheet opens on the same calendar year the note counted.
  const openWorksheet = onOpenReport
    ? (id: "contractor-worksheet") => {
        const url = new URL(window.location.href);
        url.searchParams.set("support_filter", JSON.stringify(contractorScope(year, today)));
        window.history.replaceState(null, "", url);
        onOpenReport(id);
      }
    : undefined;
  const recurring = demo ? demoRecurringData : (recurringRead.data ?? null);
  const parties: ContactParty[] = demo ? demoParties : manage.parties;
  const rows = useMemo(
    () => (data ? contactRows(data, parties, config) : []),
    [data, parties],
  );
  const ids = useMemo(() => seriesIds(rows), [rows]);
  const { series, loading: seriesLoading } = useContactSeries(filter, ids, demo);
  const loading = live && reportRead.loading;
  const updating = live && (reportRead.isPlaceholder || reportRead.revalidating || seriesLoading);

  function apply(patch: Partial<ReportFilter>, replace = false) {
    setDrill(null);
    writeReportFilter({ ...filter, ...patch, offset: 0 }, replace);
  }
  const openDetail: Drill = (title, scope) => {
    const parsed = reportFilterSchema.safeParse(scope);
    if (parsed.success) setDrill({ title, filter: parsed.data });
  };
  const roles = new Map(parties.map((p) => [p.id, p.roles ?? []]));
  const contactRoles = rows.flatMap((r) => {
    const role = primaryRole(roles.get(r.id) ?? []);
    return role ? [{ id: r.id, role }] : [];
  });

  const errorMessage = exporter.error || (live && !data && reportRead.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Expenses by vendor"
        subtitle="Who you pay, where the money goes, and what keeps charging you."
        actions={
          <ExportMenu
            label="Export expenses by vendor"
            disabled={!data || loading}
            exporting={exporter.exporting}
            demo={demo}
            onExport={(format) =>
              data &&
              void exporter.run(
                data,
                {
                  report_id: "vendor-expenses",
                  show_zero: false,
                  details: detail,
                  layout: 2,
                  ...(contactRoles.length ? { contact_roles: contactRoles } : {}),
                },
                format,
              )
            }
          />
        }
      />
      <PeriodControls
        filter={filter}
        fiscalMonth={fiscalStart}
        today={today}
        scope="Expenses by contact"
        updating={updating}
        onApply={apply}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing expenses by vendor" />
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", updating && "opacity-70")}
        >
          <ScopeNotice data={data} onReview={onReview} />
          {isEmptyContactReport(data, config) ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <Receipt size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">No expenses in this period</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a longer period, or categorize the payments the business made.
              </p>
            </Card>
          ) : (
            <VendorReport
              data={data}
              rows={rows}
              parties={parties}
              note={note}
              recurring={recurring}
              recurringError={live && !recurring ? recurringRead.error : ""}
              months={contactMonths(data, rows, series, config)}
              series={series}
              metric={metric}
              setMetric={setMetric}
              detail={detail}
              setDetail={setDetail}
              privacy={isHidden}
              demo={demo}
              onDrill={openDetail}
              onOpenReport={openWorksheet}
              onReload={() => void reportRead.reload()}
            />
          )}
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
          onChanged={() => void reportRead.reload()}
        />
      )}
    </div>
  );
}

/** A change in spending: up is bad. */
function spendChange(now: bigint, before: bigint | null, short: string | null): TileChange | null {
  if (before === null || !short) return null;
  const c = changeOf(now, before);
  if (c.kind === "none") return { text: `No change vs ${short}`, tone: "flat" };
  if (c.kind === "near-zero")
    return {
      text: `${c.diff > ZERO ? "+" : ""}${formatCents(c.diff)} vs almost nothing`,
      tone: changeTone(c.diff, true),
    };
  return {
    text: `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${short}`,
    tone: changeTone(c.diff, true),
  };
}

function VendorReport({
  data,
  rows,
  parties,
  note,
  recurring,
  recurringError,
  months,
  series,
  metric,
  setMetric,
  detail,
  setDetail,
  privacy,
  onDrill,
  onOpenReport,
  onReload,
}: {
  data: ReportData;
  rows: ContactRow[];
  parties: ContactParty[];
  note: ReturnType<typeof contractorNote>;
  recurring: RecurringData | null;
  recurringError: string;
  months: ReturnType<typeof contactMonths>;
  series: ReturnType<typeof useContactSeries>["series"];
  metric: VendorMetric;
  setMetric: (m: VendorMetric) => void;
  detail: boolean;
  setDetail: (v: boolean) => void;
  privacy: boolean;
  demo: boolean;
  onDrill: Drill;
  onOpenReport?: (id: "contractor-worksheet") => void;
  onReload: () => void;
}) {
  const compared = compareLabel(data.filter);
  const short = compared?.short ?? null;
  const s = contactSummary(rows, data, config);
  const { isRevealed, hoverProps } = useMaskedHover();
  const topName = s.top?.name ?? "Your biggest payee";
  const points = months.months;
  const repeat = recurring ? recurringSummary(recurring, data.filter) : null;
  // Each month's spending with the payees whose charges repeat; unknown
  // until every one of their month series is in.
  const repeatIds = [
    ...new Set((repeat?.active ?? []).flatMap((r) => (r.contactId ? [r.contactId] : []))),
  ];
  const repeatValues = points.map((p) => {
    if (!repeat || repeatIds.some((id) => !series.has(id) && rows.some((r) => r.id === id && r.amount > ZERO)))
      return null;
    return repeatIds.reduce((sum, id) => {
      const row = series.get(id)?.rows.find((r) => r.key.slice(0, 7) === p.month.slice(0, 7));
      return sum + BigInt(row?.expense_cents ?? "0");
    }, ZERO);
  });
  const count = (now: number, before: number): TileChange | null =>
    short
      ? now === before
        ? { text: `No change vs ${short}`, tone: "flat" }
        : { text: `${now > before ? "+" : ""}${now - before} vs ${short}`, tone: "flat" }
      : null;
  const sharePoints = (now: number | null, before: number | null): TileChange | null => {
    if (!short || now === null || before === null) return null;
    const diff = Math.round((now - before) * 10) / 10;
    if (diff === 0) return { text: `No change vs ${short}`, tone: "flat" };
    return { text: `${diff > 0 ? "+" : ""}${diff.toFixed(1)} pts vs ${short}`, tone: "flat" };
  };
  const tiles: {
    id: VendorMetric;
    value: string;
    change: TileChange | null;
    context: string;
    spark: number[];
  }[] = [
    {
      id: "amount",
      value: formatCents(s.total),
      change: spendChange(s.total, short ? s.previousTotal : null, short),
      context: `Paid to ${s.paying} ${s.paying === 1 ? "contact" : "contacts"}${
        s.noneTotal > ZERO ? " and some with no contact" : ""
      }`,
      spark: points.map((p) => Number(p.total) / 100),
    },
    {
      id: "count",
      value: String(s.paying),
      change: count(s.paying, s.previousPaying),
      context: "Vendors, contractors and others",
      spark: points.map((p) => p.paying ?? 0),
    },
    {
      id: "share",
      value: s.topShare === null ? "None" : `${s.topShare.toFixed(1)}%`,
      change: sharePoints(s.topShare, s.previousTopShare),
      context: s.top ? s.top.name : "Nobody paid yet",
      spark: points.map((p) => p.topShare ?? 0),
    },
    {
      id: "extra",
      value: repeat ? formatCents(repeat.monthly) : "None",
      change: null,
      context: repeat
        ? `A month, from ${repeat.active.length} ${repeat.active.length === 1 ? "charge" : "charges"} that repeat`
        : "Finding charges that repeat",
      spark: repeatValues.map((v) => (v === null ? 0 : Number(v) / 100)),
    },
  ];
  const copy = metricCopy[metric];
  const title = copy.title(topName);
  const periodText = rangeLabel(data.filter.from, data.filter.to);
  const statement = contactStatement(rows, data, config, detail);
  const tied = rows.reduce((sum, r) => sum + r.amount, ZERO) === s.total;
  const uncategorized =
    data.filter.mode === "working"
      ? uncategorizedCents(data.accounts, (a) => a.purpose, (a) => a.period_cents)
      : ZERO;
  const others = rows.filter((r) => r.group !== "main" && r.amount !== ZERO).length;
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {tiles.map((tile) => (
          <MetricTile
            key={tile.id}
            label={metricCopy[tile.id].tile}
            value={tile.value}
            negative={false}
            change={tile.change}
            context={tile.context}
            spark={tile.spark}
            selected={metric === tile.id}
            onSelect={() => setMetric(tile.id)}
          />
        ))}
      </section>

      <SectionCard
        labelledBy="ve-chart"
        title={title}
        description={
          metric !== "amount" && months.capped
            ? `${copy.description} Counts cover the ${SERIES_LIMIT} contacts you paid most.`
            : copy.description
        }
      >
        <div className="px-3 pb-5 sm:px-5 lg:px-6 lg:pb-6" {...hoverProps}>
          <LegendRow
            items={
              metric === "amount"
                ? [
                    ...months.stack.map((c, i) => ({ label: c.name, swatch: STACK_SWATCHES[i] })),
                    {
                      label: "Everyone else",
                      swatch: REST_SWATCH,
                      shown: points.some((p) => p.rest !== ZERO),
                    },
                  ]
                : [
                    {
                      label:
                        metric === "count"
                          ? config.countLabel
                          : metric === "share"
                            ? `${topName}'s share`
                            : "With payees that charge on a schedule",
                      swatch: "bg-teal",
                    },
                  ]
            }
          />
          <ContactReportChart
            data={points}
            stack={months.stack}
            metric={metric}
            title={`${title}, ${periodText}`}
            labels={{ count: config.countLabel, average: config.averageLabel }}
            extra={{ label: "With payees that charge on a schedule", values: repeatValues }}
            revealed={isRevealed}
            masked={privacy}
          />
        </div>
      </SectionCard>

      <CardRow>
        <SectionCard
          labelledBy="ve-payees"
          title="Who you paid"
          description={
            short
              ? `Largest first, with the change vs ${short}.`
              : "Vendors, contractors and others, largest first."
          }
        >
          <RankedList
            label="Who you paid"
            rows={rankedRows(rows, "main", short, config)}
            tone="copper"
            onDrill={onDrill}
            empty="Nobody was paid in this period."
          />
          <CardTotal label={config.mainTotal} amount={s.mainTotal} />
        </SectionCard>
        <RoleCard
          shares={spendByRole(rows, parties, s.total)}
          total={s.total}
          note={note}
          privacy={privacy}
          onOpenReport={onOpenReport}
        />
      </CardRow>

      <RecurringCard
        summary={repeat}
        error={recurringError}
        period={data.filter}
        privacy={privacy}
        onDrill={(row) =>
          row.contactId &&
          onDrill(row.name, {
            from: data.filter.from,
            to: data.filter.to,
            mode: data.filter.mode,
            payee: row.contactId,
            account_types: ["expense"],
            offset: 0,
          })
        }
      />

      {others > 0 && (
        <SectionCard
          labelledBy="ve-other"
          title="Other spending"
          description="Spending with contacts that are only clients (a refund, say), and spending with no contact yet."
        >
          <RankedList
            label="Other spending"
            rows={rankedRows(rows, ["other", "none"], short, config)}
            tone="copper"
            onDrill={onDrill}
            empty="No other spending in this period."
          />
          <CardTotal label="Total other spending" amount={s.otherTotal + s.noneTotal} />
        </SectionCard>
      )}

      <SectionCard
        labelledBy="ve-statement"
        title="Statement"
        description="Expenses by contact. Select a line to see its transactions."
        action={
          <Segmented
            label="Statement detail"
            value={detail ? "all" : "summary"}
            onChange={(v) => setDetail(v === "all")}
            options={[
              { value: "summary", label: "Summary" },
              { value: "all", label: "Every payee" },
            ]}
          />
        }
      >
        <div className="border-t border-border">
          <StatementTable
            model={{
              id: "vendor-expenses",
              title: "Expenses by vendor",
              description: "",
              columns: [],
              rows: statement,
              footnotes: [],
              comparison: !!data.filter.compare_from,
            }}
            rows={statement}
            base={s.total}
            shareHeader="% of spending"
            currentHeader="This period"
            detail
            onDrill={onDrill}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-5 py-3.5 lg:px-6">
          <HealthLine
            data={data}
            uncategorized={uncategorized}
            lead={[
              tied
                ? { tone: "good", text: "Adds up: every dollar of expenses is on a line" }
                : { tone: "warn", text: "The lines do not add up to total expenses" },
            ]}
          />
          <span className="text-xs text-muted-foreground">Revision {data.revision}</span>
        </div>
      </SectionCard>

      <CoverageDisclosure data={data} notes={VENDOR_NOTES} onReload={onReload} />
    </>
  );
}

const ROLE_SWATCHES = [
  "bg-copper-strong",
  "bg-teal",
  "bg-copper-strong/55",
  "bg-teal/50",
  "bg-[rgba(var(--ink),0.35)]",
  "bg-[rgba(var(--ink),0.2)]",
  "bg-[rgba(var(--ink),0.12)]",
  "bg-[rgba(var(--ink),0.08)]",
];

/**
 * Where the money goes by kind of payee: one share bar and a row per role,
 * then the Contractor worksheet's note when a contractor needs a 1099.
 */
function RoleCard({
  shares,
  total,
  note,
  privacy,
  onOpenReport,
}: {
  shares: RoleShare[];
  total: bigint;
  note: ReturnType<typeof contractorNote>;
  privacy: boolean;
  onOpenReport?: (id: "contractor-worksheet") => void;
}) {
  const { showValue, hoverProps } = useMaskedHover();
  const hide = privacy && !showValue;
  const biggest = shares[0];
  return (
    <SectionCard
      labelledBy="ve-roles"
      title="Where the money goes"
      description={
        hide || !biggest
          ? "Spending by kind of payee."
          : `${biggest.label} took ${Math.round(biggest.share)}% of your spending.`
      }
    >
      <div className="flex flex-1 flex-col gap-4 px-5 pb-5 lg:px-6 lg:pb-6" {...hoverProps}>
        <div
          aria-hidden="true"
          className="flex h-3 w-full overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]"
        >
          {shares
            .filter((r) => r.amount > ZERO)
            .map((r, i) => (
              <span
                key={r.role}
                className={cn("h-full", ROLE_SWATCHES[i % ROLE_SWATCHES.length])}
                style={{ width: `${Math.max(0, r.share)}%` }}
              />
            ))}
        </div>
        <ul className="divide-y divide-border border-y border-border">
          {shares.map((r, i) => (
            <li key={r.role} className="flex items-start justify-between gap-4 py-2.5">
              <span className="flex min-w-0 items-start gap-2">
                <span
                  aria-hidden="true"
                  className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-sm", ROLE_SWATCHES[i % ROLE_SWATCHES.length])}
                />
                <span className="min-w-0">
                  <span className="block text-sm">
                    {r.label}
                    {r.role !== "none" && (
                      <span className="ml-1.5 text-xs text-muted-foreground">{r.count}</span>
                    )}
                  </span>
                  {r.role === "none" ? (
                    <span className="block text-xs text-muted-foreground">
                      Depreciation and charges not matched to a vendor yet.
                    </span>
                  ) : (
                    <span className="block truncate text-xs text-muted-foreground" title={r.names.join(", ")}>
                      {r.names.join(", ")}
                      {r.count > r.names.length ? ` and ${r.count - r.names.length} more` : ""}
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-right text-sm tabular-nums">
                <MaskedValue value={formatCents(r.amount)} inheritHover />
                <span className="block text-xs text-muted-foreground">
                  <MaskedValue value={`${r.share.toFixed(1)}%`} inheritHover />
                </span>
              </span>
            </li>
          ))}
        </ul>
        {note && (
          <div className="mt-auto flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-sm leading-relaxed">
            <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0">
              {onOpenReport ? (
                <>
                  {note.lead}; see the{" "}
                  <button
                    type="button"
                    onClick={() => onOpenReport("contractor-worksheet")}
                    className="inline-flex items-center gap-0.5 rounded-sm text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    Contractor worksheet
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                  .
                </>
              ) : (
                note.text
              )}
            </span>
          </div>
        )}
      </div>
      <CardTotal label="Total expenses" amount={total} />
    </SectionCard>
  );
}

/**
 * What keeps charging the business: the charges the books find repeating on
 * a steady beat, as of the period's end, with what each comes to a month,
 * and what started, went up or stopped during the period.
 */
function RecurringCard({
  summary,
  error,
  period,
  privacy,
  onDrill,
}: {
  summary: RecurringSummary | null;
  error: string;
  period: { from: string; to: string };
  privacy: boolean;
  onDrill: (row: RecurringRow) => void;
}) {
  const { showValue, hoverProps } = useMaskedHover();
  const hide = privacy && !showValue;
  if (!summary)
    return (
      <SectionCard labelledBy="ve-recurring" title="What keeps charging you">
        <p className="px-5 pb-5 text-sm text-muted-foreground lg:px-6">
          {error || "Finding charges that repeat."}
        </p>
      </SectionCard>
    );
  const started = new Set(summary.started.map((r) => r.key));
  const changes = [
    ...summary.started.map((r) => ({ row: r, kind: "Started" as const, text: `First charged ${dateLabel(r.firstDate)}` })),
    ...summary.stopped.map((r) => ({ row: r, kind: "Stopped" as const, text: `Last charged ${dateLabel(r.lastDate)}` })),
    // Biggest rise first: a plan going up matters more than a bill wobbling.
    ...[...summary.increases].sort((a, b) => {
      const up = (r: RecurringRow) => r.priceChange!.to - r.priceChange!.from;
      return up(b) > up(a) ? 1 : up(b) < up(a) ? -1 : 0;
    }).map((r) => ({
      row: r,
      kind: "Higher" as const,
      text: `${formatCents(r.priceChange!.from)} to ${formatCents(r.priceChange!.to)} on ${dateLabel(r.priceChange!.on)}`,
    })),
    ...summary.decreases.map((r) => ({
      row: r,
      kind: "Lower" as const,
      text: `${formatCents(r.priceChange!.from)} to ${formatCents(r.priceChange!.to)} on ${dateLabel(r.priceChange!.on)}`,
    })),
  ];
  return (
    <SectionCard
      labelledBy="ve-recurring"
      title="What keeps charging you"
      description={
        hide
          ? "Hover to reveal the amounts."
          : summary.active.length
            ? `${summary.active.length} ${summary.active.length === 1 ? "charge repeats" : "charges repeat"} on a steady beat as of ${dateLabel(period.to)}, about ${formatCents(summary.monthly)} a month.`
            : "No charges repeat on a steady beat yet."
      }
    >
      <div className="grid flex-1 gap-5 px-5 pb-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:px-6 lg:pb-6" {...hoverProps}>
        <div className="flex min-w-0 flex-col">
          <ScrollList label="Charges that repeat" className="-mx-2.5">
            <ul className="space-y-0.5">
              {summary.active.map((r) => {
                const body = (
                  <>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm" title={r.name}>
                          {r.name}
                        </span>
                        {started.has(r.key) && <Badge size="sm" className="shrink-0">New</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {CADENCE_WORDS[r.cadence]}
                        {r.category ? `, ${r.category}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm tabular-nums">
                      <MaskedValue value={formatCents(r.monthly)} inheritHover />
                      <span className="block text-xs text-muted-foreground">a month</span>
                    </span>
                  </>
                );
                const layout =
                  "flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2.5 py-2";
                return (
                  <li key={r.key}>
                    {r.contactId ? (
                      <button
                        type="button"
                        onClick={() => onDrill(r)}
                        className={cn(
                          layout,
                          "text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
                        )}
                      >
                        {body}
                        <span className="sr-only">, show transactions</span>
                      </button>
                    ) : (
                      <div className={layout}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </ScrollList>
        </div>
        <div className="flex min-w-0 flex-col">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Repeat size={14} aria-hidden="true" className="text-muted-foreground" />
            Changes in this period
          </h3>
          {changes.length ? (
            <ScrollList label="Changes in this period">
            <ul className="divide-y divide-border border-y border-border">
              {changes.map((c) => (
                <li key={`${c.kind}-${c.row.key}`} className="flex items-start justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm" title={c.row.name}>
                      {c.row.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {hide ? "Hidden" : c.text}
                    </span>
                  </span>
                  <Badge size="sm" className="shrink-0">
                    {c.kind}
                  </Badge>
                </li>
              ))}
            </ul>
            </ScrollList>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing started, changed price or stopped in this period.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Higher and Lower compare each charge with the one before it, so a bill that varies
            shows up here too.
          </p>
          {summary.partial && (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing the 100 biggest repeat charges.
            </p>
          )}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-5 py-3.5 text-sm font-semibold lg:px-6">
        <span>Repeat charges, a month</span>
        <span className="tabular-nums">
          <MaskedValue value={formatCents(summary.monthly)} />
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            <MaskedValue value={`${formatCents(summary.annual)} a year`} />
          </span>
        </span>
      </div>
    </SectionCard>
  );
}
