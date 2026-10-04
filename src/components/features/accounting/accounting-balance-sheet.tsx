"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Landmark, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import {
  BalanceSheetChart,
  assetsUnderwater,
  type BalanceMetric,
} from "@/components/charts/balance-sheet-chart";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { buildReportModel } from "@/lib/accounting/report-model";
import {
  reportFilterSchema,
  type BreakdownData,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import { balanceSeriesQuery, reportQuery } from "@/lib/accounting/preload";
import { changeOf, changeTone } from "@/lib/accounting/profit-loss";
import {
  AS_OF_PRESETS,
  BALANCE_COMPARES,
  asOfDate,
  asOfPresetOf,
  balanceCompareLabel,
  balanceCompareOf,
  balanceFilter,
  balanceMonths,
  balanceSeriesFilters,
  balanceStatementRows,
  balanceTotals,
  compareDate,
  dateText,
  equityLines,
  isEmptyBalance,
  whatYouOwe,
  whatYouOwn,
  type AsOfPreset,
  type BalanceCompare,
  type BalanceMonth,
  type BalanceRow,
} from "@/lib/accounting/balance-sheet";
import {
  demoBalanceBreakdown,
  demoReportData,
  demoReportDetail,
} from "@/lib/accounting/demo-reports";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { AccountingAccountLogo } from "./accounting-bank-identity";
import { useAccountingRead } from "./use-accounting-read";
import { useReportExport } from "./use-report-export";
import { todayInBooks } from "./format";
import { EquityCard } from "./balance-sheet-sections";
import {
  CoverageDisclosure,
  ExportMenu,
  FilterChip,
  HealthLine,
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
  type RankedRow,
  type TileChange,
} from "./report-kit";

const ZERO = BigInt(0);

const metricCopy: Record<
  BalanceMetric,
  { tile: string; title: string; description: string; context: string }
> = {
  assets: {
    tile: "Assets",
    title: "What the business has, month by month",
    description:
      "Each bar is everything the business has at month end: the copper part is owed to others, the teal part is yours.",
    context: "What the business has",
  },
  liabilities: {
    tile: "Liabilities",
    title: "What the business owes, month by month",
    description: "Cards, payroll and taxes not yet paid, and loans, at each month end.",
    context: "What it owes",
  },
  equity: {
    tile: "Equity",
    title: "Equity at each month end",
    description: "What is left for you: everything the business has, less what it owes.",
    context: "What is left for you",
  },
  cash: {
    tile: "Cash position",
    title: "Cash position at each month end",
    description: "Bank and cash balances, less what the business cards owe.",
    context: "Bank and cash less cards",
  },
};

export function AccountingBalanceSheet({
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
  const filter = readReportFilter(
    params.get("report_filter"),
    balanceFilter(today, "working"),
  );
  // A link from elsewhere may carry any start date; a balance only needs its year.
  const asOf = filter.to;
  const normalized = balanceFilter(asOf, filter.mode, filter.compare_to);
  const signature = JSON.stringify(normalized);
  const preset = asOfPresetOf(asOf, today);
  const compareMode = balanceCompareOf(normalized);

  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const [custom, setCustom] = useState(asOf);
  const [metric, setMetric] = useState<BalanceMetric>("assets");
  const [detail, setDetail] = useState(true);
  const [drill, setDrill] = useState<{
    title: string;
    filter: ReportFilter;
  } | null>(null);
  const exporter = useReportExport();
  const { isHidden } = usePrivacy();

  useEffect(() => {
    setCustom(asOf);
    if (asOfPresetOf(asOf, today) === "custom") setCustomOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf]);
  // A typed date applies once the owner pauses.
  useEffect(() => {
    if (!customOpen || !custom || custom === asOf) return;
    const timer = setTimeout(() => setAsOf(custom, true), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom, customOpen]);

  const live = !demo;
  const reportRead = useAccountingRead<ReportData>(
    reportQuery("balance-sheet", normalized),
    { enabled: live, keepPrevious: true },
  );
  const demoData = useMemo(
    () => (demo ? demoReportData(normalized) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
  const cardIds = useMemo(
    () =>
      (data?.accounts ?? [])
        .filter((a) => a.cash_kind === "card")
        .map((a) => a.id),
    [data],
  );
  const seriesFilters = balanceSeriesFilters(asOf, normalized.mode, cardIds);
  const assetsRead = useAccountingRead<BreakdownData>(
    balanceSeriesQuery(seriesFilters.assets!),
    { enabled: live, keepPrevious: true },
  );
  const liabilitiesRead = useAccountingRead<BreakdownData>(
    balanceSeriesQuery(seriesFilters.liabilities!),
    { enabled: live, keepPrevious: true },
  );
  const cashRead = useAccountingRead<BreakdownData>(
    balanceSeriesQuery(seriesFilters.cash!),
    { enabled: live, keepPrevious: true },
  );
  const cardsRead = useAccountingRead<BreakdownData>(
    seriesFilters.cards ? balanceSeriesQuery(seriesFilters.cards) : null,
    { enabled: live && !!data, keepPrevious: true },
  );
  const seriesKey = JSON.stringify(seriesFilters);
  const months = useMemo<BalanceMonth[]>(
    () =>
      demo
        ? balanceMonths(asOf, {
            assets: demoBalanceBreakdown(seriesFilters.assets!),
            liabilities: demoBalanceBreakdown(seriesFilters.liabilities!),
            cash: demoBalanceBreakdown(seriesFilters.cash!),
            cards: seriesFilters.cards
              ? demoBalanceBreakdown(seriesFilters.cards)
              : null,
          })
        : balanceMonths(asOf, {
            assets: assetsRead.data,
            liabilities: liabilitiesRead.data,
            cash: cashRead.data,
            cards: cardsRead.data,
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, seriesKey, assetsRead.data, liabilitiesRead.data, cashRead.data, cardsRead.data],
  );
  const seriesLoading =
    live &&
    (assetsRead.loading || liabilitiesRead.loading || cashRead.loading);
  const loading = live && reportRead.loading;
  const updating =
    live && (reportRead.isPlaceholder || reportRead.revalidating);

  function apply(next: ReportFilter, replace = false) {
    setDrill(null);
    writeReportFilter(next, replace);
  }
  function setAsOf(date: string, replace = false) {
    // A comparison keeps its meaning (end of previous month, and so on) as the date moves.
    const compare =
      compareMode === "none" || compareMode === "custom"
        ? normalized.compare_to
        : compareDate(compareMode, date);
    apply(balanceFilter(date, normalized.mode, compare), replace);
  }
  function choosePreset(value: AsOfPreset | "custom") {
    if (value === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setAsOf(asOfDate(value, today));
  }
  function chooseCompare(mode: BalanceCompare) {
    apply(
      balanceFilter(
        asOf,
        normalized.mode,
        mode === "none" || mode === "custom" ? undefined : compareDate(mode, asOf),
      ),
    );
  }
  const openDetail: Drill = (title, scope) => {
    const parsed = reportFilterSchema.safeParse(scope);
    if (parsed.success) setDrill({ title, filter: parsed.data });
  };

  const model = useMemo(
    () => (data ? buildReportModel("balance-sheet", data) : null),
    [data],
  );
  const compared = balanceCompareLabel(normalized);

  const header = (
    <AccountingPageHeader
      back={{ label: "All reports", onClick: onBack }}
      title="Balance sheet"
      subtitle="What the business has, what it owes, and what is left."
      actions={
        <ExportMenu
          label="Export balance sheet"
          disabled={!data || loading}
          exporting={exporter.exporting}
          demo={demo}
          onExport={(format) =>
            data &&
            void exporter.run(
              data,
              {
                report_id: "balance-sheet",
                show_zero: false,
                details: detail,
                layout: 2,
              },
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
        <div
          role="group"
          aria-label="As of"
          // Each segment sizes to its label; below 340px the track scrolls
          // inside itself rather than widening the page.
          className="seg-track seg-sm w-full max-w-full overflow-x-auto [scrollbar-width:none] sm:w-auto [&::-webkit-scrollbar]:hidden"
        >
          {[
            ...AS_OF_PRESETS,
            { value: "custom" as const, label: "Custom date", short: "Custom" },
          ].map((p) => {
            const active =
              p.value === "custom" ? customOpen : !customOpen && preset === p.value;
            return (
              <button
                key={p.value}
                type="button"
                aria-pressed={active}
                onClick={() => choosePreset(p.value)}
                className={cn(
                  // .seg-item sets padding and size outside the utility layer.
                  "seg-item shrink-0 grow max-sm:px-2! max-sm:text-[12.5px]! sm:grow-0",
                  active && "is-active",
                )}
              >
                <span className="sm:hidden">{p.short}</span>
                <span className="hidden sm:inline">{p.label}</span>
              </button>
            );
          })}
        </div>
        {customOpen && (
          <div className="w-full sm:w-44">
            <DateInput
              ariaLabel="As of date"
              size="sm"
              minDate="1900-01-01"
              maxDate="2100-12-31"
              value={custom}
              onChange={setCustom}
            />
          </div>
        )}
        <FilterChip
          label="Compare"
          value={compareMode}
          onChange={(v) => chooseCompare(v as BalanceCompare)}
          options={[
            ...BALANCE_COMPARES,
            ...(compareMode === "custom"
              ? [{ value: "custom", label: "Custom date" }]
              : []),
          ]}
        />
        <FilterChip
          label="Includes"
          value={normalized.mode}
          onChange={(v) =>
            apply(
              balanceFilter(asOf, v as ReportFilter["mode"], normalized.compare_to),
            )
          }
          options={[
            { value: "working", label: "All activity" },
            { value: "posted", label: "Reviewed only" },
          ]}
        />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>As of {dateText(asOf)}</span>
        <span aria-hidden="true">·</span>
        <span>Cash basis</span>
        <span aria-hidden="true">·</span>
        <span>USD</span>
        {compared && (
          <>
            <span aria-hidden="true">·</span>
            <span>Compared with {compared.long}</span>
          </>
        )}
        <span role="status" className="inline-flex items-center gap-1.5">
          {updating && (
            <>
              <RefreshCw
                size={12}
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
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
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-4 text-sm text-error"
        >
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing balance sheet" />
      ) : data && model ? (
        <div
          aria-busy={updating || undefined}
          className={cn(
            "space-y-5 transition-opacity lg:space-y-6",
            updating && "opacity-70",
          )}
        >
          <ScopeNotice data={data} onReview={onReview} field="ending_cents" />
          {isEmptyBalance(data) ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <Landmark
                size={26}
                aria-hidden="true"
                className="mb-3 text-muted-foreground"
              />
              <p className="text-sm font-medium">Nothing on the books yet on this date</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a later date, or add the opening balances for your bank accounts.
              </p>
              {preset !== "today" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => choosePreset("today")}
                >
                  Show today
                </Button>
              )}
            </Card>
          ) : (
            <BalanceReport
              data={data}
              model={model}
              months={months}
              seriesLoading={seriesLoading}
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

function tileChange(
  now: bigint,
  before: bigint | undefined,
  invert: boolean,
  since: string | null,
): TileChange | null {
  if (before === undefined || !since) return null;
  const c = changeOf(now, before);
  if (c.kind === "none") return { text: `No change since ${since}`, tone: "flat" };
  if (c.kind === "near-zero")
    return {
      text: `${c.diff > ZERO ? "+" : ""}${formatCents(c.diff)} vs almost nothing`,
      tone: changeTone(c.diff, invert),
    };
  return {
    text: `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% since ${since}`,
    tone: changeTone(c.diff, invert),
  };
}

function withLogos(rows: BalanceRow[]): RankedRow[] {
  return rows.map((r) => ({
    ...r,
    icon:
      r.accountId && r.cashKind && r.cashKind !== "none" ? (
        <AccountingAccountLogo
          accountId={r.accountId}
          name={r.label}
          size={22}
          className="shrink-0"
        />
      ) : undefined,
  }));
}

function BalanceReport({
  data,
  model,
  months,
  seriesLoading,
  metric,
  setMetric,
  detail,
  setDetail,
  privacy,
  onDrill,
  onReload,
}: {
  data: ReportData;
  model: ReturnType<typeof buildReportModel>;
  months: BalanceMonth[];
  seriesLoading: boolean;
  metric: BalanceMetric;
  setMetric: (m: BalanceMetric) => void;
  detail: boolean;
  setDetail: (v: boolean) => void;
  privacy: boolean;
  onDrill: Drill;
  onReload: () => void;
}) {
  const { current, previous, difference } = balanceTotals(data);
  const { isRevealed, hoverProps } = useMaskedHover();
  // Tiles are narrow on a phone: "since Dec 2025", or "a year ago".
  const compareTo = data.filter.compare_to;
  const since = compareTo
    ? compareTo.slice(5) === data.filter.to.slice(5) && compareTo !== data.filter.to
      ? "a year ago"
      : new Intl.DateTimeFormat("en-US", {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${compareTo}T00:00:00Z`))
    : null;
  const series = (m: BalanceMetric) =>
    months.map((x) => Number(x[m === "cash" ? "cash" : m]) / 100);
  const tiles: {
    id: BalanceMetric;
    value: bigint;
    previous?: bigint;
    invert: boolean;
  }[] = [
    { id: "assets", value: current.assets, previous: previous?.assets, invert: false },
    { id: "liabilities", value: current.liabilities, previous: previous?.liabilities, invert: true },
    { id: "equity", value: current.equity, previous: previous?.equity, invert: false },
    { id: "cash", value: current.cash, previous: previous?.cash, invert: false },
  ];
  const own = withLogos(whatYouOwn(data));
  const owe = withLogos(whatYouOwe(data));
  const equity = equityLines(data);
  const rows = balanceStatementRows(model);
  const uncategorized =
    data.filter.mode === "working"
      ? uncategorizedCents(
          data.accounts,
          (a) => a.purpose,
          (a) => a.ending_cents,
        )
      : ZERO;
  const copy = metricCopy[metric];
  const underwater = assetsUnderwater(months);
  return (
    <>
      <section
        aria-label="Summary"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4"
      >
        {tiles.map((t) => (
          <MetricTile
            key={t.id}
            label={metricCopy[t.id].tile}
            value={formatCents(t.value)}
            negative={t.value < ZERO}
            change={tileChange(t.value, t.previous, t.invert, since)}
            context={metricCopy[t.id].context}
            spark={series(t.id)}
            selected={metric === t.id}
            onSelect={() => setMetric(t.id)}
          />
        ))}
      </section>

      <SectionCard
        labelledBy="bs-chart"
        title={copy.title}
        description={
          metric === "assets" && underwater
            ? "Assets beside liabilities at each month end. Where liabilities are taller, the business owes more than it has."
            : copy.description
        }
      >
        <div className="px-3 pb-5 sm:px-5 lg:px-6 lg:pb-6" {...hoverProps}>
          <BalanceLegend metric={metric} underwater={underwater} />
          {seriesLoading && !months.some((m) => m.assets !== ZERO) ? (
            <div role="status" aria-label="Loading month-end balances">
              <div className="skeleton h-[230px] w-full rounded-lg sm:h-[300px]" />
            </div>
          ) : (
            <BalanceSheetChart
              data={months}
              metric={metric}
              title={`${copy.title}, twelve months to ${dateText(data.filter.to)}`}
              revealed={isRevealed}
              masked={privacy}
            />
          )}
        </div>
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
        <SectionCard
          labelledBy="bs-own"
          title="What you own"
          description={
            <>
              <MaskedValue value={formatCents(current.assets)} /> in total
            </>
          }
        >
          <RankedList
            rows={own}
            tone="teal"
            onDrill={onDrill}
            empty="No assets on this date."
          />
        </SectionCard>
        <SectionCard
          labelledBy="bs-owe"
          title="What you owe"
          description={
            <>
              <MaskedValue value={formatCents(current.liabilities)} /> in total
            </>
          }
        >
          <RankedList
            rows={owe}
            tone="copper"
            onDrill={onDrill}
            empty="Nothing owed on this date."
          />
        </SectionCard>
      </div>

      <EquityCard
        lines={equity.lines}
        total={equity.total}
        totals={current}
        onDrill={onDrill}
      />

      <SectionCard
        labelledBy="bs-statement"
        title="Statement"
        description="The formal balance sheet. Select a line to see its transactions."
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
            model={model}
            rows={rows}
            base={current.assets}
            shareHeader="% of assets"
            amountHeader="Balance"
            currentHeader="As of"
            detail={detail}
            onDrill={onDrill}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-5 py-3.5 lg:px-6">
          <HealthLine
            data={data}
            uncategorized={uncategorized}
            lead={[
              difference === ZERO
                ? { tone: "good", text: "Balanced: assets equal liabilities plus equity" }
                : {
                    tone: "warn",
                    text: (
                      <>
                        Out of balance by <MaskedValue value={formatCents(difference)} />
                      </>
                    ),
                  },
            ]}
          />
          <span className="text-xs text-muted-foreground">
            Revision {data.revision}
          </span>
        </div>
      </SectionCard>

      <CoverageDisclosure data={data} notes={model.footnotes} onReload={onReload} />
    </>
  );
}

function BalanceLegend({
  metric,
  underwater,
}: {
  metric: BalanceMetric;
  underwater: boolean;
}) {
  const items: [string, string][] =
    metric === "assets"
      ? underwater
        ? [
            ["Assets", "bg-teal"],
            ["Liabilities", "bg-copper-strong"],
          ]
        : [
            ["Owed to others", "bg-copper-strong"],
            ["Yours (equity)", "bg-teal"],
          ]
      : metric === "liabilities"
        ? [["Liabilities", "bg-copper-strong"]]
        : [
            [metric === "equity" ? "Equity" : "Cash position", "bg-teal"],
            ["Below zero", "bg-error"],
          ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-2 text-xs text-muted-foreground sm:px-0">
      {items.map(([label, swatch]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-sm", swatch)} />
          {label}
        </span>
      ))}
    </div>
  );
}

