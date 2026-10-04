"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BarChart3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useMaskedHover } from "@/components/ui/masked-value";
import {
  ProfitLossChart,
  type ChartMetric,
  type ProfitLossChartPoint,
} from "@/components/charts/profit-loss-chart";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { buildReportModel } from "@/lib/accounting/report-model";
import {
  reportFilterSchema,
  type BreakdownData,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import {
  breakdownQuery,
  defaultReportFilter,
  reportQuery,
} from "@/lib/accounting/preload";
import {
  PERIOD_PRESETS,
  changeOf,
  changeTone,
  compareLabel,
  compareModeOf,
  dollarSplit,
  expenseByCategory,
  expenseByVendor,
  incomeByCategory,
  incomeByContact,
  isEmptyProfitLoss,
  marginOf,
  presetOf,
  presetRange,
  previousPeriod,
  profitLossMonths,
  profitLossTotals,
  rangeLabel,
  samePeriodLastYear,
  statementRows,
  topMovers,
  type CompareMode,
  type PeriodPreset,
  type ProfitLossMonth,
} from "@/lib/accounting/profit-loss";
import {
  demoBreakdown,
  demoParties,
  demoReportData,
  demoReportDetail,
} from "@/lib/accounting/demo-reports";
import type { BooksMetadata } from "./types";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { useReportExport } from "./use-report-export";
import { useFiscalStartMonth } from "./use-fiscal-year";
import { todayInBooks } from "./format";
import {
  ChangesList,
  ConcentrationNote,
  DollarCard,
} from "./profit-loss-sections";
import {
  CardRow,
  CardTotal,
  CoverageDisclosure,
  ExportMenu,
  FilterChip,
  HealthLine,
  MetricTile,
  RankedList,
  ReportSkeleton,
  ScopeNotice,
  SectionCard,
  PresetSegments,
  Segmented,
  StatementTable,
  readReportFilter,
  writeReportFilter,
} from "./report-kit";

const ZERO = BigInt(0);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
type Metric = ChartMetric;
type View = "monthly" | "running";



const metricCopy: Record<
  Metric,
  { tile: string; title: string; running: string; description: string }
> = {
  income: {
    tile: "Income",
    title: "Income by month",
    running: "Income so far",
    description: "Money in, by the month it landed.",
  },
  expense: {
    tile: "Expenses",
    title: "Expenses by month",
    running: "Expenses so far",
    description: "Money out, by the month it was paid.",
  },
  net: {
    tile: "Net profit",
    title: "Net profit by month",
    running: "Net profit so far",
    description: "Income minus expenses. Loss months show in red.",
  },
  margin: {
    tile: "Profit margin",
    title: "Profit margin by month",
    running: "Profit margin so far",
    description: "The share of income left after expenses.",
  },
};

export function AccountingProfitLoss({
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
  // The fiscal year (business settings) shapes the year presets and drills.
  const fiscalStart = useFiscalStartMonth(demo);
  // Demo books have no workspace dates worth defaulting to: open on this year.
  const fallback = demo
    ? defaultReportFilter(`${today.slice(0, 4)}-01-01`, today)
    : defaultReportFilter(from, to);
  const filter = readReportFilter(params.get("report_filter"), fallback);
  const signature = JSON.stringify(filter);
  const preset = presetOf(filter.from, filter.to, today, fiscalStart);
  const compareMode = compareModeOf(filter);
  const comparing = compareMode !== "none";

  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const [range, setRange] = useState({ from: filter.from, to: filter.to });
  const [rangeError, setRangeError] = useState("");
  const [metric, setMetric] = useState<Metric>("net");
  const [view, setView] = useState<View>("monthly");
  const [detail, setDetail] = useState(true);
  const [incomeBy, setIncomeBy] = useState<"clients" | "categories">("clients");
  const [expenseBy, setExpenseBy] = useState<"categories" | "vendors">(
    "categories",
  );
  const [drill, setDrill] = useState<{
    title: string;
    filter: ReportFilter;
  } | null>(null);
  const exporter = useReportExport();
  const { isHidden } = usePrivacy();

  // The address bar is the source of truth; the date inputs follow it.
  useEffect(() => {
    setRange({ from: filter.from, to: filter.to });
    if (presetOf(filter.from, filter.to, today, fiscalStart) === "custom") setCustomOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.from, filter.to]);

  // Typed dates apply once the owner pauses, never per keystroke.
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
  const reportRead = useAccountingRead<ReportData>(
    reportQuery("profit-loss", filter),
    { enabled: live, keepPrevious: true },
  );
  const monthsRead = useAccountingRead<BreakdownData>(
    comparing ? breakdownQuery(filter) : null,
    { enabled: live, keepPrevious: true },
  );
  const demoData = useMemo(
    () => (demo ? demoReportData(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const demoMonths = useMemo(
    () => (demo && comparing ? demoBreakdown(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, comparing, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
  const breakdown = demo ? demoMonths : (monthsRead.data ?? null);
  const loading = live && reportRead.loading;
  const updating =
    live &&
    (reportRead.isPlaceholder ||
      reportRead.revalidating ||
      (comparing && monthsRead.loading));
  const parties = demo ? demoParties : manage.parties;

  function apply(patch: Partial<ReportFilter>, replace = false) {
    const next: ReportFilter = { ...filter, ...patch, offset: 0 };
    // A comparison follows the period it compares with.
    if (patch.from || patch.to) {
      const mode = compareModeOf(filter);
      if (mode === "previous") Object.assign(next, previousPeriod(next.from, next.to));
      if (mode === "year") Object.assign(next, samePeriodLastYear(next.from, next.to));
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
    if (mode === "none")
      apply({ compare_from: undefined, compare_to: undefined });
    else if (mode === "previous") apply(previousPeriod(filter.from, filter.to));
    else if (mode === "year") apply(samePeriodLastYear(filter.from, filter.to));
  }
  function openDetail(title: string, scope: Partial<ReportFilter>) {
    const parsed = reportFilterSchema.safeParse(scope);
    if (parsed.success) setDrill({ title, filter: parsed.data });
  }

  const model = useMemo(
    () => (data ? buildReportModel("profit-loss", data, false, parties) : null),
    [data, parties],
  );
  const months = useMemo(
    () => (data ? profitLossMonths(data, breakdown) : []),
    [data, breakdown],
  );
  const compared = compareLabel(filter);
  const periodText = rangeLabel(filter.from, filter.to);

  const header = (
    <AccountingPageHeader
      back={{ label: "All reports", onClick: onBack }}
      title="Profit & loss"
      subtitle="What the business earned, what it cost, and what was left."
      actions={
        <ExportMenu
          label="Export profit and loss"
          disabled={!data || loading}
          exporting={exporter.exporting}
          demo={demo}
          onExport={(format) =>
            data &&
            void exporter.run(
              data,
              {
                report_id: "profit-loss",
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
            ...(compareMode === "custom"
              ? [{ value: "custom", label: "Custom dates" }]
              : []),
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
        <FilterChip
          label="Contact"
          searchable
          value={filter.payee ?? ""}
          onChange={(v) => apply({ payee: v || undefined })}
          options={[
            { value: "", label: "All contacts" },
            { value: "unassigned", label: "No contact" },
            ...parties.map((p) => ({ value: p.id, label: p.name })),
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
        <span>Cash basis</span>
        <span aria-hidden="true">·</span>
        <span>USD</span>
        {compared && (
          <>
            <span aria-hidden="true">·</span>
            <span>Compared with {lowerFirst(compared.long)}</span>
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

  const errorMessage =
    exporter.error || (live && !data && reportRead.error) || "";

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
        <ReportSkeleton label="Preparing profit and loss" />
      ) : data && model ? (
        <div
          aria-busy={updating || undefined}
          className={cn(
            "space-y-5 transition-opacity lg:space-y-6",
            updating && "opacity-70",
          )}
        >
          <ScopeNotice data={data} onReview={onReview} />
          {isEmptyProfitLoss(data) ? (
            <EmptyPeriod
              onYearToDate={() => choosePreset("year")}
              showReset={preset !== "year"}
              reviewedOnly={filter.mode === "posted"}
            />
          ) : (
            <Report
              data={data}
              model={model}
              months={months}
              metric={metric}
              setMetric={setMetric}
              view={view}
              setView={setView}
              detail={detail}
              setDetail={setDetail}
              incomeBy={incomeBy}
              setIncomeBy={setIncomeBy}
              expenseBy={expenseBy}
              setExpenseBy={setExpenseBy}
              parties={parties}
              comparedShort={compared?.short ?? null}
              comparedLong={compared?.long ?? null}
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



function EmptyPeriod({
  onYearToDate,
  showReset,
  reviewedOnly,
}: {
  onYearToDate: () => void;
  showReset: boolean;
  reviewedOnly: boolean;
}) {
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <BarChart3
        size={26}
        aria-hidden="true"
        className="mb-3 text-muted-foreground"
      />
      <p className="text-sm font-medium">No income or expenses in this period</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {reviewedOnly
          ? "Pick a longer period, or include transactions still awaiting review."
          : "Pick a longer period, or check that the period's bank activity is in the books."}
      </p>
      {showReset && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onYearToDate}>
          Show year to date
        </Button>
      )}
    </Card>
  );
}


function Report({
  data,
  model,
  months,
  metric,
  setMetric,
  view,
  setView,
  detail,
  setDetail,
  incomeBy,
  setIncomeBy,
  expenseBy,
  setExpenseBy,
  parties,
  comparedShort,
  comparedLong,
  periodText,
  privacy,
  onDrill,
  onReload,
}: {
  data: ReportData;
  model: ReturnType<typeof buildReportModel>;
  months: ProfitLossMonth[];
  metric: Metric;
  setMetric: (m: Metric) => void;
  view: View;
  setView: (v: View) => void;
  detail: boolean;
  setDetail: (v: boolean) => void;
  incomeBy: "clients" | "categories";
  setIncomeBy: (v: "clients" | "categories") => void;
  expenseBy: "categories" | "vendors";
  setExpenseBy: (v: "categories" | "vendors") => void;
  parties: { id: string; name: string; roles?: string[] }[];
  comparedShort: string | null;
  comparedLong: string | null;
  periodText: string;
  privacy: boolean;
  onDrill: (title: string, filter: Partial<ReportFilter>) => void;
  onReload: () => void;
}) {
  const { current, previous } = profitLossTotals(data);
  const comparing = !!previous;
  const series = (m: Metric) =>
    months.map((x) =>
      m === "income"
        ? Number(x.income) / 100
        : m === "expense"
          ? Number(x.expense) / 100
          : m === "net"
            ? Number(x.net) / 100
            : (marginOf(x.net, x.income) ?? 0),
    );
  const chartData = useMemo<ProfitLossChartPoint[]>(() => {
    let income = ZERO,
      expense = ZERO,
      cIncome = ZERO,
      cExpense = ZERO;
    return months.map((m) => {
      income += m.income;
      expense += m.expense;
      cIncome += m.compare?.income ?? ZERO;
      cExpense += m.compare?.expense ?? ZERO;
      const running = view === "running";
      const i = running ? income : m.income,
        e = running ? expense : m.expense,
        ci = running ? cIncome : (m.compare?.income ?? ZERO),
        ce = running ? cExpense : (m.compare?.expense ?? ZERO);
      const pick = (inc: bigint, exp: bigint) =>
        metric === "income"
          ? Number(inc) / 100
          : metric === "expense"
            ? Number(exp) / 100
            : metric === "net"
              ? Number(inc - exp) / 100
              : marginOf(inc - exp, inc);
      return {
        month: m.month,
        value: pick(i, e),
        compare: m.compare ? pick(ci, ce) : null,
        income: i,
        expense: e,
        net: i - e,
        compareIncome: m.compare ? ci : null,
        compareExpense: m.compare ? ce : null,
        compareNet: m.compare ? ci - ce : null,
        partial: m.partial,
      };
    });
  }, [months, metric, view]);

  const split = dollarSplit(data);
  const statement = statementRows(model, data);
  const incomeRows =
    incomeBy === "clients"
      ? incomeByContact(data, parties)
      : incomeByCategory(data);
  const expenseRows =
    expenseBy === "categories"
      ? expenseByCategory(data)
      : expenseByVendor(data, parties);
  const movers = topMovers(data);
  const uncategorized =
    data.filter.mode === "working"
      ? uncategorizedCents(
          data.accounts,
          (a) => a.purpose,
          (a) => a.period_cents,
        )
      : ZERO;
  const copy = metricCopy[metric];
  const chartTitle = view === "running" ? copy.running : copy.title;
  const { isRevealed: chartRevealed, hoverProps: chartHover } = useMaskedHover();

  const tiles: {
    id: Metric;
    value: string;
    numeric: bigint | null;
    change: { text: string; tone: "good" | "bad" | "flat" } | null;
    context: string;
  }[] = [
    {
      id: "income",
      value: formatCents(current.income),
      numeric: current.income,
      change: changeText(current.income, previous?.income, false, comparedShort),
      context: periodText,
    },
    {
      id: "expense",
      value: formatCents(current.expense),
      numeric: current.expense,
      change: changeText(current.expense, previous?.expense, true, comparedShort),
      context: periodText,
    },
    {
      id: "net",
      value: formatCents(current.net),
      numeric: current.net,
      change: changeText(current.net, previous?.net, false, comparedShort),
      context: current.net < ZERO ? "A loss for the period" : "Income minus expenses",
    },
    {
      id: "margin",
      value: current.margin === null ? "No income" : `${current.margin.toFixed(1)}%`,
      numeric: null,
      change:
        previous && comparedShort
          ? current.margin !== null && previous.margin !== null
            ? (() => {
                const points = current.margin - previous.margin;
                return {
                  text: `${points > 0 ? "+" : ""}${points.toFixed(1)} pts vs ${comparedShort}`,
                  tone: points > 0 ? "good" : points < 0 ? "bad" : "flat",
                } as const;
              })()
            : previous.margin === null
              ? { text: `No income in ${comparedShort}`, tone: "flat" as const }
              : null
          : null,
      context: "Of income left as profit",
    },
  ];

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {tiles.map((t) => (
          <MetricTile
            key={t.id}
            label={t.id === "net" && current.net < ZERO ? "Net loss" : metricCopy[t.id].tile}
            value={t.value}
            negative={t.numeric !== null ? t.numeric < ZERO : (current.margin ?? 0) < 0}
            change={t.change}
            context={t.context}
            spark={series(t.id)}
            selected={metric === t.id}
            onSelect={() => setMetric(t.id)}
          />
        ))}
      </section>

      <SectionCard
        labelledBy="pl-chart"
        title={chartTitle}
        description={copy.description}
        action={
          <Segmented
            label="Chart view"
            value={view}
            onChange={setView}
            options={[
              { value: "monthly", label: "Monthly" },
              { value: "running", label: "Running total" },
            ]}
          />
        }
      >
        <div className="px-3 pb-5 sm:px-5 lg:px-6 lg:pb-6" {...chartHover}>
          <ChartLegend
            metric={metric}
            comparing={comparing}
            periodText={periodText}
            comparedLong={comparedLong}
            hasLoss={chartData.some((d) => (d.value ?? 0) < 0)}
          />
          <ProfitLossChart
            data={chartData}
            metric={metric}
            title={`${chartTitle}, ${periodText}`}
            comparing={comparing}
            currentLabel="This period"
            compareLabel={
              comparedShort
                ? `${view === "running" ? "Same point" : "Same month"}, ${comparedShort}`
                : "Comparison"
            }
            revealed={chartRevealed}
            masked={privacy}
            running={view === "running"}
          />
        </div>
      </SectionCard>

      <DollarCard split={split} />

      <CardRow>
        <SectionCard
          labelledBy="pl-income"
          title="Where income came from"
          description={`By ${incomeBy === "clients" ? "client" : "category"}, largest first.`}
          action={
            <Segmented
              label="Group income by"
              value={incomeBy}
              onChange={setIncomeBy}
              options={[
                { value: "clients", label: "Clients" },
                { value: "categories", label: "Categories" },
              ]}
            />
          }
        >
          <RankedList
            rows={incomeRows}
            label="Where income came from"
            tone="teal"
            onDrill={onDrill}
            empty="No income in this period."
          />
          {incomeBy === "clients" && <ConcentrationNote rows={incomeRows} />}
          <CardTotal label="Total income" amount={current.income} />
        </SectionCard>
        <SectionCard
          labelledBy="pl-expense"
          title="Where it went"
          description={`By ${expenseBy === "categories" ? "category" : "vendor"}, largest first.`}
          action={
            <Segmented
              label="Group expenses by"
              value={expenseBy}
              onChange={setExpenseBy}
              options={[
                { value: "categories", label: "Categories" },
                { value: "vendors", label: "Vendors" },
              ]}
            />
          }
        >
          <RankedList
            rows={expenseRows}
            label="Where expenses went"
            tone="copper"
            onDrill={onDrill}
            empty="No expenses in this period."
          />
          <CardTotal label="Total expenses" amount={current.expense} />
        </SectionCard>
      </CardRow>

      {comparing && movers.length > 0 && (
        <SectionCard
          labelledBy="pl-changes"
          title="What changed"
          description={`Against ${lowerFirst(comparedLong ?? "")}. Biggest moves first.`}
        >
          <ChangesList movers={movers} onDrill={onDrill} />
        </SectionCard>
      )}

      <SectionCard
        labelledBy="pl-statement"
        title="Statement"
        description="The formal profit and loss. Select a line to see its transactions."
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
            rows={statement.rows}
            base={current.income}
            shareHeader="% of income"
            detail={detail}
            onDrill={onDrill}
          />
        </div>
        {statement.costOfSalesHidden && (
          <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground lg:px-6">
            No cost of sales in this period, so gross profit equals income and
            that section is hidden.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-5 py-3.5 lg:px-6">
          <HealthLine data={data} uncategorized={uncategorized} />
          <span className="text-xs text-muted-foreground">
            Revision {data.revision}
          </span>
        </div>
      </SectionCard>

      <CoverageDisclosure
        data={data}
        notes={model.footnotes.filter(
          (note) =>
            !statement.costOfSalesHidden ||
            !note.startsWith("Cost of sales uses"),
        )}
        onReload={onReload}
      />
    </>
  );
}

/** "+12.4% vs last year", or dollars when the comparison was almost nothing. */
function changeText(
  now: bigint,
  before: bigint | undefined,
  invert: boolean,
  short: string | null,
): { text: string; tone: "good" | "bad" | "flat" } | null {
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


function ChartLegend({
  metric,
  comparing,
  periodText,
  comparedLong,
  hasLoss,
}: {
  metric: Metric;
  comparing: boolean;
  periodText: string;
  comparedLong: string | null;
  hasLoss: boolean;
}) {
  const swatch =
    metric === "expense" ? "bg-copper-strong" : "bg-teal";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-2 text-xs text-muted-foreground sm:px-0">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-sm", swatch)} />
        {periodText}
      </span>
      {comparing && comparedLong && (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-sm bg-[rgba(var(--ink),0.2)]"
          />
          {comparedLong}
        </span>
      )}
      {(metric === "net" || metric === "margin") && hasLoss && (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-error" />
          Loss month
        </span>
      )}
    </div>
  );
}
