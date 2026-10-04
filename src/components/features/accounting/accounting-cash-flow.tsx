"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useMaskedHover } from "@/components/ui/masked-value";
import {
  CashReportChart,
  type CashChartPoint,
  type CashMetric,
} from "@/components/charts/cash-report-chart";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import {
  reportFilterSchema,
  type BreakdownData,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import {
  balanceSeriesQuery,
  defaultReportFilter,
  reportQuery,
} from "@/lib/accounting/preload";
import {
  PERIOD_PRESETS,
  changeOf,
  changeTone,
  compareLabel,
  compareModeOf,
  presetOf,
  presetRange,
  previousPeriod,
  rangeLabel,
  samePeriodLastYear,
  type CompareMode,
  type PeriodPreset,
} from "@/lib/accounting/profit-loss";
import {
  CASH_FLOW_NOTES,
  afterBusinessSentence,
  bridgeSentence,
  cashBridge,
  cashFlowStatement,
  cashFlowTotals,
  cashMonths,
  cashSeriesFilter,
  isEmptyCashFlow,
  profitCashSentence,
  profitToCash,
  type CashFlowTotals,
} from "@/lib/accounting/cash-flow";
import {
  demoBalanceBreakdown,
  demoReportData,
  demoReportDetail,
} from "@/lib/accounting/demo-reports";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { useReportExport } from "./use-report-export";
import { useFiscalStartMonth } from "./use-fiscal-year";
import { dateLabel, todayInBooks } from "./format";
import {
  CardRow,
  CoverageDisclosure,
  ExportMenu,
  FilterChip,
  HealthLine,
  LegendRow,
  MetricTile,
  PresetSegments,
  ReportSkeleton,
  ScopeNotice,
  SectionCard,
  Segmented,
  StatementTable,
  WaterfallList,
  readReportFilter,
  writeReportFilter,
  type Drill,
  type TileChange,
} from "./report-kit";

const ZERO = BigInt(0);

const metricCopy: Record<
  CashMetric,
  { tile: string; title: string; description: string }
> = {
  starting: {
    tile: "Starting cash",
    title: "Cash at the start of each month",
    description: "Bank and cash balances on the first day of each month.",
  },
  in: {
    tile: "Cash in",
    title: "Profit and cash, month by month",
    description:
      "Each month's profit beside its change in cash. A profitable month can still end with less cash.",
  },
  out: {
    tile: "Cash out",
    title: "Profit and cash, month by month",
    description:
      "Each month's profit beside its change in cash. A profitable month can still end with less cash.",
  },
  ending: {
    tile: "Ending cash",
    title: "Cash at the end of each month",
    description: "Bank and cash balances on the last day of each month.",
  },
};

export function AccountingCashFlow({
  from,
  to,
  onBack,
  onEntry,
  onReview,
  demo = false,
}: {
  from: string;
  to: string;
  onBack: () => void;
  onEntry: (id: string) => void;
  onReview: () => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  // The fiscal year (business settings) shapes the year presets and drills.
  const fiscalStart = useFiscalStartMonth(demo);
  const fallback = demo
    ? defaultReportFilter(`${today.slice(0, 4)}-01-01`, today)
    : defaultReportFilter(from, to);
  const raw = readReportFilter(params.get("report_filter"), fallback);
  // Cash is not split by contact: a link that carries one is read without it.
  const filter: ReportFilter = { ...raw, payee: undefined };
  const signature = JSON.stringify(filter);
  const preset = presetOf(filter.from, filter.to, today, fiscalStart);
  const compareMode = compareModeOf(filter);

  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const [range, setRange] = useState({ from: filter.from, to: filter.to });
  const [rangeError, setRangeError] = useState("");
  const [metric, setMetric] = useState<CashMetric>("ending");
  const [detail, setDetail] = useState(false);
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);
  const exporter = useReportExport();
  const { isHidden } = usePrivacy();

  useEffect(() => {
    setRange({ from: filter.from, to: filter.to });
    if (presetOf(filter.from, filter.to, today, fiscalStart) === "custom") setCustomOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.from, filter.to]);
  useEffect(() => {
    if (!customOpen) return;
    if (range.from === filter.from && range.to === filter.to) return;
    const timer = setTimeout(() => {
      if (!range.from || !range.to) return;
      if (range.from > range.to) {
        setRangeError("The start date is after the end date.");
        return;
      }
      setRangeError("");
      apply({ from: range.from, to: range.to }, true);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, customOpen]);

  const live = !demo;
  const comparison: ReportFilter | null =
    filter.compare_from && filter.compare_to
      ? { from: filter.compare_from, to: filter.compare_to, mode: filter.mode, offset: 0 }
      : null;
  const options = { enabled: live, keepPrevious: true };
  const reportRead = useAccountingRead<ReportData>(reportQuery("cash-flow", filter), options);
  const compareRead = useAccountingRead<ReportData>(
    comparison ? reportQuery("cash-flow", comparison) : null,
    options,
  );
  const seriesRead = useAccountingRead<BreakdownData>(
    balanceSeriesQuery(cashSeriesFilter(filter)),
    options,
  );
  const demoData = useMemo(
    () => (demo ? demoReportData(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const demoCompare = useMemo(
    () => (demo && comparison ? demoReportData(comparison) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const demoSeries = useMemo(
    () => (demo ? demoBalanceBreakdown(cashSeriesFilter(filter)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
  const previousData = demo ? demoCompare : (compareRead.data ?? null);
  const series = demo ? demoSeries : (seriesRead.data ?? null);
  const loading = live && reportRead.loading;
  const updating = live && (reportRead.isPlaceholder || reportRead.revalidating);

  function apply(patch: Partial<ReportFilter>, replace = false) {
    const next: ReportFilter = { ...filter, ...patch, offset: 0 };
    if (patch.from || patch.to) {
      if (compareMode === "previous") Object.assign(next, previousPeriod(next.from, next.to));
      if (compareMode === "year") Object.assign(next, samePeriodLastYear(next.from, next.to));
    }
    setDrill(null);
    writeReportFilter(next, replace);
  }
  function choosePreset(value: PeriodPreset | "custom") {
    if (value === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setRangeError("");
    apply(presetRange(value, today, fiscalStart));
  }
  function chooseCompare(mode: CompareMode) {
    if (mode === "none") apply({ compare_from: undefined, compare_to: undefined });
    else if (mode === "previous") apply(previousPeriod(filter.from, filter.to));
    else if (mode === "year") apply(samePeriodLastYear(filter.from, filter.to));
  }
  const openDetail: Drill = (title, scope) => {
    const parsed = reportFilterSchema.safeParse(scope);
    if (parsed.success) setDrill({ title, filter: parsed.data });
  };
  const compared = compareLabel(filter);
  const periodText = rangeLabel(filter.from, filter.to);

  const header = (
    <AccountingPageHeader
      back={{ label: "All reports", onClick: onBack }}
      title="Cash flow"
      subtitle="Where your cash came from, and where it went."
      actions={
        <ExportMenu
          label="Export cash flow"
          disabled={!data || loading}
          exporting={exporter.exporting}
          demo={demo}
          onExport={(format) =>
            data &&
            void exporter.run(
              data,
              { report_id: "cash-flow", show_zero: false, details: detail, layout: 2 },
              format,
            )
          }
        />
      }
    />
  );

  const controls = (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <PresetSegments
          label="Period"
          options={[
            ...PERIOD_PRESETS,
            { value: "custom" as const, label: "Custom", short: "Custom" },
          ]}
          value={customOpen ? "custom" : preset}
          onChoose={choosePreset}
        />
        {customOpen && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
              <DateInput
                ariaLabel="From"
                size="sm"
                minDate="1900-01-01"
                maxDate="2100-12-31"
                value={range.from}
                onChange={(value) => setRange((r) => ({ ...r, from: value }))}
              />
            </div>
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              to
            </span>
            <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
              <DateInput
                ariaLabel="Through"
                size="sm"
                minDate="1900-01-01"
                maxDate="2100-12-31"
                value={range.to}
                onChange={(value) => setRange((r) => ({ ...r, to: value }))}
              />
            </div>
          </div>
        )}
        <FilterChip
          label="Compare"
          value={compareMode}
          onChange={(v) => chooseCompare(v as CompareMode)}
          options={[
            { value: "none", label: "No comparison" },
            { value: "previous", label: "Previous period" },
            { value: "year", label: "Same period last year" },
            ...(compareMode === "custom" ? [{ value: "custom", label: "Custom dates" }] : []),
          ]}
        />
        <FilterChip
          label="Includes"
          value={filter.mode}
          onChange={(v) => apply({ mode: v as ReportFilter["mode"] })}
          options={[
            { value: "working", label: "All activity" },
            { value: "posted", label: "Reviewed only" },
          ]}
        />
      </div>
      {rangeError && (
        <p role="alert" className="text-xs text-error">
          {rangeError}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{periodText}</span>
        <span aria-hidden="true">·</span>
        <span>Bank and cash accounts</span>
        <span aria-hidden="true">·</span>
        <span>USD</span>
        {compared && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Compared with {compared.long.charAt(0).toLowerCase() + compared.long.slice(1)}
            </span>
          </>
        )}
        <span role="status" className="inline-flex items-center gap-1.5">
          {updating && (
            <>
              <RefreshCw size={12} aria-hidden="true" className="motion-safe:animate-spin" />
              Updating
            </>
          )}
        </span>
      </p>
    </div>
  );

  const errorMessage = exporter.error || (live && !data && reportRead.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      {header}
      {controls}
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing cash flow" />
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", updating && "opacity-70")}
        >
          <ScopeNotice data={data} onReview={onReview} />
          {isEmptyCashFlow(data) ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <Wallet size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">No cash on the books for this period</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a longer period, or add the opening balances for your bank accounts.
              </p>
            </Card>
          ) : (
            <CashReport
              data={data}
              previous={previousData}
              series={series}
              metric={metric}
              setMetric={setMetric}
              detail={detail}
              setDetail={setDetail}
              comparedShort={compared?.short ?? null}
              periodText={periodText}
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

function change(
  now: bigint,
  before: bigint | undefined,
  invert: boolean,
  short: string | null,
): TileChange | null {
  if (before === undefined || !short) return null;
  const c = changeOf(now, before);
  if (c.kind === "none") return { text: `No change vs ${short}`, tone: "flat" };
  if (c.kind === "near-zero")
    return {
      text: `${c.diff > ZERO ? "+" : ""}${formatCents(c.diff)} vs almost nothing`,
      tone: changeTone(c.diff, invert),
    };
  return {
    text: `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${short}`,
    tone: changeTone(c.diff, invert),
  };
}

function CashReport({
  data,
  previous,
  series,
  metric,
  setMetric,
  detail,
  setDetail,
  comparedShort,
  periodText,
  privacy,
  onDrill,
  onReload,
}: {
  data: ReportData;
  previous: ReportData | null;
  series: BreakdownData | null;
  metric: CashMetric;
  setMetric: (m: CashMetric) => void;
  detail: boolean;
  setDetail: (v: boolean) => void;
  comparedShort: string | null;
  periodText: string;
  privacy: boolean;
  onDrill: Drill;
  onReload: () => void;
}) {
  const bridge = cashBridge(data);
  const t = bridge.totals;
  const then: CashFlowTotals | null = previous ? cashFlowTotals(previous) : null;
  const story = profitToCash(data);
  const months = cashMonths(data, series);
  const points: CashChartPoint[] = months.map((m, i) => ({
    month: m.month,
    at: m.at,
    starting: i === 0 ? t.starting : months[i - 1].ending,
    ending: m.ending,
    change: m.change,
    profit: m.profit,
    partial: m.partial,
  }));
  const { isRevealed, hoverProps } = useMaskedHover();
  const bridgeHover = useMaskedHover();
  const storyHover = useMaskedHover();
  const net = t.change;
  const tiles: {
    id: CashMetric;
    value: bigint;
    change: TileChange | null;
    context: string;
    spark: number[];
  }[] = [
    {
      id: "starting",
      value: t.starting,
      change: change(t.starting, then?.starting, false, comparedShort),
      context: `On ${dateLabel(data.filter.from)}`,
      spark: points.map((p) => Number(p.starting) / 100),
    },
    {
      id: "in",
      value: t.cashIn,
      change: change(t.cashIn, then?.cashIn, false, comparedShort),
      context: "From the business, owner and loans",
      spark: points.map((p) => (p.change > ZERO ? Number(p.change) / 100 : 0)),
    },
    {
      id: "out",
      value: -t.cashOut,
      change: change(-t.cashOut, then ? -then.cashOut : undefined, true, comparedShort),
      context: "To the owner, loans and equipment",
      spark: points.map((p) => (p.change < ZERO ? Number(-p.change) / 100 : 0)),
    },
    {
      id: "ending",
      value: t.ending,
      // Ending cash carries the period's net change, not a comparison.
      change: {
        text: `${net > ZERO ? "+" : ""}${formatCents(net)} this period`,
        tone: net > ZERO ? "good" : net < ZERO ? "bad" : "flat",
      },
      context: `On ${dateLabel(data.filter.to)}`,
      spark: points.map((p) => Number(p.ending) / 100),
    },
  ];
  const cashIds = data.accounts
    .filter((a) => a.cash_kind === "bank" || a.cash_kind === "cash")
    .map((a) => a.id);
  const cashScope = (to: string): Partial<ReportFilter> | undefined =>
    cashIds.length
      ? { from: "1900-01-01", to, mode: data.filter.mode, account_ids: cashIds, offset: 0 }
      : undefined;
  const dayBefore = new Date(Date.parse(`${data.filter.from}T12:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const rows = cashFlowStatement(data, detail);
  const bookCash = data.accounts
    .filter((a) => a.cash_kind === "bank" || a.cash_kind === "cash")
    .reduce((s, a) => s + BigInt(a.ending_cents), ZERO);
  const tied = t.difference === ZERO && bookCash === t.ending;
  const uncategorized =
    data.filter.mode === "working"
      ? uncategorizedCents(data.accounts, (a) => a.purpose, (a) => a.period_cents)
      : ZERO;
  const copy = metricCopy[metric];
  const after = afterBusinessSentence(t);
  const hideBridge = privacy && !bridgeHover.showValue;
  const hideStory = privacy && !storyHover.showValue;
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {tiles.map((tile) => (
          <MetricTile
            key={tile.id}
            label={metricCopy[tile.id].tile}
            value={formatCents(tile.value)}
            negative={tile.value < ZERO}
            change={tile.change}
            context={tile.context}
            spark={tile.spark}
            selected={metric === tile.id}
            onSelect={() => setMetric(tile.id)}
          />
        ))}
      </section>

      <SectionCard labelledBy="cf-chart" title={copy.title} description={copy.description}>
        <div className="px-3 pb-5 sm:px-5 lg:px-6 lg:pb-6" {...hoverProps}>
          <LegendRow
            items={
              metric === "in" || metric === "out"
                ? [
                    { label: "Profit", swatch: "bg-[rgba(var(--ink),0.2)]" },
                    { label: "Change in cash", swatch: "bg-teal" },
                    {
                      label: "Cash went down",
                      swatch: "bg-error",
                      shown: points.some((p) => p.change < ZERO),
                    },
                  ]
                : [
                    { label: "Bank and cash", swatch: "bg-teal" },
                    {
                      label: "Below zero",
                      swatch: "bg-error",
                      shown: points.some(
                        (p) => (metric === "starting" ? p.starting : p.ending) < ZERO,
                      ),
                    },
                  ]
            }
          />
          <CashReportChart
            data={points}
            metric={metric}
            title={`${copy.title}, ${periodText}`}
            revealed={isRevealed}
            masked={privacy}
          />
        </div>
      </SectionCard>

      <CardRow wide>
        <SectionCard
          labelledBy="cf-bridge"
          title="Where your cash came from and went"
          description={
            hideBridge
              ? "Hover to reveal the amounts."
              : bridgeSentence(t)
          }
        >
          <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6" {...bridgeHover.hoverProps}>
            <WaterfallList
              label="Where cash came from and went"
              start={{ label: "Starting cash", amount: t.starting, filter: cashScope(dayBefore) }}
              lines={bridge.lines}
              total={{ label: "Ending cash", amount: t.ending }}
              onDrill={onDrill}
              hide={hideBridge}
            />
          </div>
        </SectionCard>

        <SectionCard
          labelledBy="cf-profit"
          title="Profit vs cash, explained"
          description={hideStory ? "Hover to reveal the explanation." : profitCashSentence(t, story.lines)}
        >
          <div className="flex flex-1 flex-col gap-3 px-5 pb-5 lg:px-6 lg:pb-6" {...storyHover.hoverProps}>
            <WaterfallList
              label="Profit turned into cash"
              start={{
                label: "Profit this period",
                amount: story.profit,
                hint: "Income less expenses, from the profit and loss.",
                filter: { from: data.filter.from, to: data.filter.to, mode: data.filter.mode, account_types: ["income", "expense"], offset: 0 },
              }}
              lines={story.lines}
              total={{ label: "Cash from running the business", amount: story.operating }}
              onDrill={onDrill}
              hide={hideStory}
            />
            {after && !hideStory && (
              <p className="text-sm leading-relaxed text-muted-foreground">{after}</p>
            )}
          </div>
        </SectionCard>
      </CardRow>

      <SectionCard
        labelledBy="cf-statement"
        title="Statement"
        description="The formal statement of cash flows, built from profit and the change in each balance. Select a line to see its transactions."
        action={
          <Segmented
            label="Statement detail"
            value={detail ? "all" : "summary"}
            onChange={(v) => setDetail(v === "all")}
            options={[
              { value: "summary", label: "Summary" },
              { value: "all", label: "Every account" },
            ]}
          />
        }
      >
        <div className="border-t border-border">
          <StatementTable
            model={{
              id: "cash-flow",
              title: "Cash flow",
              description: "",
              columns: [],
              rows,
              footnotes: [],
              comparison: !!data.filter.compare_from,
            }}
            rows={rows}
            base={ZERO}
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
                ? {
                    tone: "good",
                    text: "Ties out: ending cash matches the bank and cash balances on the balance sheet",
                  }
                : {
                    tone: "warn",
                    text: `Does not tie out by ${formatCents(t.difference !== ZERO ? t.difference : bookCash - t.ending)}`,
                  },
            ]}
          />
          <span className="text-xs text-muted-foreground">Revision {data.revision}</span>
        </div>
      </SectionCard>

      <CoverageDisclosure data={data} notes={CASH_FLOW_NOTES} onReload={onReload} />
    </>
  );
}
