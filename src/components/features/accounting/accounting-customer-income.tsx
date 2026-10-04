"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CircleCheck, Users } from "lucide-react";
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
  CUSTOMER_NOTES,
  CUSTOMER_REPORT,
  concentrationOf,
  dependencyOf,
  contactMonths,
  contactRows,
  contactStatement,
  contactSummary,
  isEmptyContactReport,
  rankedRows,
  seriesIds,
  SERIES_LIMIT,
  type ContactParty,
  type ContactRow,
  type ContactSummary,
  type Dependency,
} from "@/lib/accounting/contact-report";
import {
  demoParties,
  demoReportData,
  demoReportDetail,
} from "@/lib/accounting/demo-reports";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { useContactSeries } from "./use-contact-series";
import { useReportExport } from "./use-report-export";
import { todayInBooks } from "./format";
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
  SectionCard,
  Segmented,
  StatementTable,
  readReportFilter,
  writeReportFilter,
  type Drill,
  type TileChange,
} from "./report-kit";

const ZERO = BigInt(0);
const config = CUSTOMER_REPORT;

type CustomerMetric = Exclude<ContactMetric, "extra">;

const metricCopy: Record<
  CustomerMetric,
  { tile: string; title: (top: string) => string; description: string }
> = {
  amount: {
    tile: "Income",
    title: () => "Income by month, by client",
    description: "Each month's income, with your biggest clients stacked first.",
  },
  count: {
    tile: "Paying clients",
    title: () => "Paying clients by month",
    description: "How many clients paid you in each month.",
  },
  share: {
    tile: "Top client's share",
    title: (top) => `${top}'s share of each month's income`,
    description: "How much of each month's income came from your biggest client.",
  },
  average: {
    tile: "Average per client",
    title: () => "Income per paying client, by month",
    description: "Each month's client income divided by the clients who paid that month.",
  },
};

export function AccountingCustomerIncome({
  from,
  to,
  manage,
  onBack,
  onEntry,
  onReview,
  demo = false,
}: {
  from: string;
  to: string;
  manage: BooksMetadata;
  onBack: () => void;
  onEntry: (id: string) => void;
  onReview: () => void;
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
  const [metric, setMetric] = useState<CustomerMetric>("amount");
  const [detail, setDetail] = useState(false);
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);
  const exporter = useReportExport();
  const fiscalStart = useFiscalStartMonth(demo);
  const { isHidden } = usePrivacy();

  const live = !demo;
  const reportRead = useAccountingRead<ReportData>(reportQuery("customer-income", filter), {
    enabled: live,
    keepPrevious: true,
  });
  const demoData = useMemo(
    () => (demo ? demoReportData(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
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
  const otherContacts = rows
    .filter((r) => r.group === "other")
    .map((r) => ({ id: r.id, role: roles.get(r.id)?.[0] ?? "other" }));

  const errorMessage = exporter.error || (live && !data && reportRead.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Income by customer"
        subtitle="Who pays you, how much, and how much rides on any one client."
        actions={
          <ExportMenu
            label="Export income by customer"
            disabled={!data || loading}
            exporting={exporter.exporting}
            demo={demo}
            onExport={(format) =>
              data &&
              void exporter.run(
                data,
                {
                  report_id: "customer-income",
                  show_zero: false,
                  details: detail,
                  layout: 2,
                  ...(otherContacts.length ? { other_contacts: otherContacts } : {}),
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
        scope="Income by contact"
        updating={updating}
        onApply={apply}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing income by customer" />
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", updating && "opacity-70")}
        >
          <ScopeNotice data={data} onReview={onReview} />
          {isEmptyContactReport(data, config) ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <Users size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">No income in this period</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a longer period, or record the payments clients made.
              </p>
            </Card>
          ) : (
            <CustomerReport
              data={data}
              rows={rows}
              months={contactMonths(data, rows, series, config)}
              metric={metric}
              setMetric={setMetric}
              detail={detail}
              setDetail={setDetail}
              privacy={isHidden}
              onDrill={openDetail}
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

function percentChange(
  now: bigint | null,
  before: bigint | null,
  short: string | null,
): TileChange | null {
  if (now === null || before === null || !short) return null;
  const c = changeOf(now, before);
  if (c.kind === "none") return { text: `No change vs ${short}`, tone: "flat" };
  if (c.kind === "near-zero")
    return {
      text: `${c.diff > ZERO ? "+" : ""}${formatCents(c.diff)} vs almost nothing`,
      tone: changeTone(c.diff),
    };
  return {
    text: `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${short}`,
    tone: changeTone(c.diff),
  };
}

function CustomerReport({
  data,
  rows,
  months,
  metric,
  setMetric,
  detail,
  setDetail,
  privacy,
  onDrill,
  onReload,
}: {
  data: ReportData;
  rows: ContactRow[];
  months: ReturnType<typeof contactMonths>;
  metric: CustomerMetric;
  setMetric: (m: CustomerMetric) => void;
  detail: boolean;
  setDetail: (v: boolean) => void;
  privacy: boolean;
  onDrill: Drill;
  onReload: () => void;
}) {
  const compared = compareLabel(data.filter);
  const short = compared?.short ?? null;
  const s = contactSummary(rows, data, config);
  const others = rows.filter((r) => r.group !== "main" && r.amount !== ZERO).length;
  // Income with no contact is not a source; it is named in Other income.
  const sources = rows.filter((r) => r.group === "other" && r.amount !== ZERO).length;
  const { isRevealed, hoverProps } = useMaskedHover();
  const topName = s.top?.name ?? "Your top client";
  const points = months.months;
  const count = (now: number, before: number): TileChange | null =>
    short
      ? now === before
        ? { text: `No change vs ${short}`, tone: "flat" }
        : {
            text: `${now > before ? "+" : ""}${now - before} vs ${short}`,
            tone: now > before ? "good" : "bad",
          }
      : null;
  const points_ = (now: number | null, before: number | null): TileChange | null => {
    if (!short || now === null || before === null) return null;
    const diff = Math.round((now - before) * 10) / 10;
    if (diff === 0) return { text: `No change vs ${short}`, tone: "flat" };
    // A bigger share for one client is more risk, so up reads as bad.
    return {
      text: `${diff > 0 ? "+" : ""}${diff.toFixed(1)} pts vs ${short}`,
      tone: diff > 0 ? "bad" : "good",
    };
  };
  const tiles: {
    id: CustomerMetric;
    value: string;
    negative: boolean;
    change: TileChange | null;
    context: string;
    spark: number[];
  }[] = [
    {
      id: "amount",
      value: formatCents(s.total),
      negative: s.total < ZERO,
      change: percentChange(s.total, short ? s.previousTotal : null, short),
      context: `From ${s.paying} ${s.paying === 1 ? "client" : "clients"}${
        sources ? ` and ${sources} other ${sources === 1 ? "source" : "sources"}` : ""
      }`,
      spark: points.map((p) => Number(p.total) / 100),
    },
    {
      id: "count",
      value: String(s.paying),
      negative: false,
      change: count(s.paying, s.previousPaying),
      context: s.paying === 1 ? "One client paid you" : "Clients who paid you",
      spark: points.map((p) => p.paying ?? 0),
    },
    {
      id: "share",
      value: s.topShare === null ? "None" : `${s.topShare.toFixed(1)}%`,
      negative: false,
      change: points_(s.topShare, s.previousTopShare),
      context: s.top ? s.top.name : "No client paid yet",
      spark: points.map((p) => p.topShare ?? 0),
    },
    {
      id: "average",
      value: s.average === null ? "None" : formatCents(s.average),
      negative: false,
      change: percentChange(s.average, s.previousAverage, short),
      context: "Client income per paying client",
      spark: points.map((p) => (p.average === null ? 0 : Number(p.average) / 100)),
    },
  ];
  const copy = metricCopy[metric];
  const title = copy.title(topName);
  const periodText = rangeLabel(data.filter.from, data.filter.to);
  const statement = contactStatement(rows, data, config, detail);
  const tied =
    rows.reduce((sum, r) => sum + r.amount, ZERO) === s.total;
  const uncategorized =
    data.filter.mode === "working"
      ? uncategorizedCents(data.accounts, (a) => a.purpose, (a) => a.period_cents)
      : ZERO;
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {tiles.map((tile) => (
          <MetricTile
            key={tile.id}
            label={metricCopy[tile.id].tile}
            value={tile.value}
            negative={tile.negative}
            change={tile.change}
            context={tile.context}
            spark={tile.spark}
            selected={metric === tile.id}
            onSelect={() => setMetric(tile.id)}
          />
        ))}
      </section>

      <SectionCard
        labelledBy="ci-chart"
        title={title}
        description={
          metric !== "amount" && months.capped
            ? `${copy.description} Counts cover your ${SERIES_LIMIT} biggest clients.`
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
                          ? "Paying clients"
                          : metric === "share"
                            ? `${topName}'s share`
                            : "Per paying client",
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
            revealed={isRevealed}
            masked={privacy}
          />
        </div>
      </SectionCard>

      <CardRow>
        <SectionCard
          labelledBy="ci-clients"
          title="Who paid you"
          description={
            short ? `Clients, largest first, with the change vs ${short}.` : "Clients, largest first."
          }
        >
          <RankedList
            label="Clients who paid you"
            rows={rankedRows(rows, "main", short, config)}
            tone="teal"
            onDrill={onDrill}
            empty="No client paid you in this period."
          />
          <CardTotal label="Total from clients" amount={s.mainTotal} />
        </SectionCard>
        <ConcentrationCard
          summary={s}
          dependency={dependencyOf(rows, s)}
          short={short}
          privacy={privacy}
          onDrill={onDrill}
        />
      </CardRow>

      {others > 0 && (
        <SectionCard
          labelledBy="ci-other"
          title="Other income"
          description="Money from contacts that are not clients, and income with no contact yet."
        >
          <RankedList
            label="Other income"
            rows={rankedRows(rows, ["other", "none"], short, config)}
            tone="teal"
            onDrill={onDrill}
            empty="No other income in this period."
          />
          <CardTotal label="Total other income" amount={s.otherTotal + s.noneTotal} />
        </SectionCard>
      )}

      <SectionCard
        labelledBy="ci-statement"
        title="Statement"
        description="Income by contact. Select a line to see its transactions."
        action={
          <Segmented
            label="Statement detail"
            value={detail ? "all" : "summary"}
            onChange={(v) => setDetail(v === "all")}
            options={[
              { value: "summary", label: "Summary" },
              { value: "all", label: "Every client" },
            ]}
          />
        }
      >
        <div className="border-t border-border">
          <StatementTable
            model={{
              id: "customer-income",
              title: "Income by customer",
              description: "",
              columns: [],
              rows: statement,
              footnotes: [],
              comparison: !!data.filter.compare_from,
            }}
            rows={statement}
            base={s.total}
            shareHeader="% of income"
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
                ? { tone: "good", text: "Adds up: every dollar of income is on a line" }
                : { tone: "warn", text: "The lines do not add up to total income" },
            ]}
          />
          <span className="text-xs text-muted-foreground">Revision {data.revision}</span>
        </div>
      </SectionCard>

      <CoverageDisclosure data={data} notes={CUSTOMER_NOTES} onReload={onReload} />
    </>
  );
}

/**
 * How much rides on one client: the top client's and top three's share as
 * one bar, a plain note on the risk, and, when comparing, who is new, who
 * came back and who stopped paying.
 */
function ConcentrationCard({
  summary: s,
  dependency: d,
  short,
  privacy,
  onDrill,
}: {
  summary: ContactSummary;
  dependency: Dependency;
  short: string | null;
  privacy: boolean;
  onDrill: Drill;
}) {
  const { showValue, hoverProps } = useMaskedHover();
  const hide = privacy && !showValue;
  const focus = concentrationOf(s, config);
  const share = (v: bigint) => (s.total > ZERO ? Number((v * BigInt(10000)) / s.total) / 100 : 0);
  const topAmount = s.top?.amount ?? ZERO;
  const nextTwo = s.topThreeShare !== null && s.topShare !== null
    ? (s.topThreeShare - s.topShare) : 0;
  const segments = [
    { label: s.top?.name ?? "Top client", value: s.topShare ?? 0, swatch: "bg-teal" },
    ...(s.paying > 1
      ? [{ label: s.paying > 2 ? "Next two clients" : "Next client", value: nextTwo, swatch: "bg-teal/50" }]
      : []),
    {
      label: "Other clients",
      value: Math.max(0, share(s.mainTotal) - (s.topThreeShare ?? 0)),
      swatch: "bg-copper-strong",
    },
    { label: "Other income", value: share(s.otherTotal + s.noneTotal), swatch: REST_SWATCH },
  ].filter((x) => x.value > 0.05);
  const names = (list: ContactRow[]) =>
    list.length <= 3
      ? list.map((r) => r.name).join(", ")
      : `${list.slice(0, 2).map((r) => r.name).join(", ")} and ${list.length - 2} more`;
  const sum = (list: ContactRow[], previous = false) =>
    list.reduce((t, r) => t + (previous ? r.previous : r.amount), ZERO);
  const moves = short
    ? [
        {
          key: "new",
          label: "New clients",
          list: s.newcomers,
          amount: sum(s.newcomers),
          note: "Paid this period, not in the comparison",
        },
        {
          key: "back",
          label: "Paid both periods",
          list: s.returning,
          amount: sum(s.returning),
          note: `Also paid ${short}`,
        },
        {
          key: "gone",
          label: "Stopped paying",
          list: s.gone,
          amount: sum(s.gone, true),
          note: `Paid ${short}, nothing this period`,
        },
      ]
    : [];
  return (
    <SectionCard
      labelledBy="ci-focus"
      title="How much rides on one client"
      description={hide ? "Hover to reveal the shares." : (focus?.sentence ?? "No client paid you in this period.")}
    >
      <div className="flex flex-1 flex-col gap-4 px-5 pb-5 lg:px-6 lg:pb-6" {...hoverProps}>
        {segments.length > 0 && (
          <div>
            <div
              aria-hidden="true"
              className="flex h-3 w-full overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]"
            >
              {segments.map((seg) => (
                <span
                  key={seg.label}
                  className={cn("h-full first:rounded-l-full last:rounded-r-full", seg.swatch)}
                  style={{ width: `${seg.value}%` }}
                />
              ))}
            </div>
            <ul className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs text-muted-foreground min-[420px]:grid-cols-2">
              {segments.map((seg) => (
                <li key={seg.label} className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", seg.swatch)} />
                  <span className="truncate" title={seg.label}>
                    {seg.label}
                  </span>
                  <span className="ml-auto pl-2 tabular-nums">
                    <MaskedValue value={`${seg.value.toFixed(1)}%`} inheritHover />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <dl className="divide-y divide-border border-y border-border text-sm">
          {d.half !== null && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Clients that make up half your income</dt>
              <dd className="shrink-0 font-semibold tabular-nums">{d.half}</dd>
            </div>
          )}
          {s.top && d.withoutTop !== null && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="min-w-0 text-muted-foreground">
                Income without <span className="break-words">{s.top.name}</span>
              </dt>
              <dd className="shrink-0 text-right tabular-nums">
                <MaskedValue value={formatCents(d.withoutTop)} inheritHover />
              </dd>
            </div>
          )}
          {d.small > 0 && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">
                Smaller clients, each under 5% of income
              </dt>
              <dd className="shrink-0 text-right tabular-nums">
                {d.small}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  <MaskedValue value={`${d.smallShare.toFixed(1)}% together`} inheritHover />
                </span>
              </dd>
            </div>
          )}
        </dl>
        {moves.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {moves.map((m) => (
              <li key={m.key} className="flex items-start justify-between gap-4 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm">
                    {m.label}: <span className="font-semibold tabular-nums">{m.list.length}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground" title={m.list.length ? names(m.list) : m.note}>
                    {m.list.length ? names(m.list) : m.note}
                  </span>
                </span>
                {m.list.length > 0 && (
                  <span className="shrink-0 text-right text-sm tabular-nums">
                    <MaskedValue value={formatCents(m.amount)} inheritHover />
                    <span className="block text-xs text-muted-foreground">
                      {m.key === "gone" ? short : "this period"}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {focus && (
          <p
            className={cn(
              "mt-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm leading-relaxed",
              focus.level === "high"
                ? "border-warning/40 bg-warning/5"
                : "border-border bg-[rgba(var(--ink),0.03)]",
            )}
          >
            {focus.level === "spread" ? (
              <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
            ) : (
              <AlertTriangle
                size={16}
                aria-hidden="true"
                className={cn("mt-0.5 shrink-0", focus.level === "high" ? "text-warning" : "text-muted-foreground")}
              />
            )}
            <span>{focus.note}</span>
          </p>
        )}
        {s.top && topAmount > ZERO && (
          <button
            type="button"
            onClick={() => onDrill(s.top!.name, s.top!.filter)}
            className="self-start rounded-sm text-xs text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            See {s.top.name}&apos;s payments
          </button>
        )}
      </div>
    </SectionCard>
  );
}
