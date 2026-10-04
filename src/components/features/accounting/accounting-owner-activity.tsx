"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Info, UserRound } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import {
  OWNER_SERIES,
  OwnerActivityChart,
  type OwnerChartMode,
} from "@/components/charts/owner-activity-chart";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import {
  reportFilterSchema,
  type BreakdownData,
  type BreakdownFilter,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import { balanceSeriesQuery, defaultReportFilter, reportQuery } from "@/lib/accounting/preload";
import { changeOf, compareLabel, rangeLabel } from "@/lib/accounting/profit-loss";
import {
  OWNER_NOTES,
  equityRollForward,
  isEmptyOwnerReport,
  ownerLines,
  ownerLinesFilter,
  ownerMonths,
  ownerNotes,
  ownerSentence,
  ownerStatement,
  ownerTotals,
  salaryAccounts,
  type OwnerLine,
  type OwnerTotals,
} from "@/lib/accounting/owner-activity";
import {
  demoAccountActivity,
  demoReportData,
  demoReportDetail,
} from "@/lib/accounting/demo-reports";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { useReportLines } from "./use-report-lines";
import { useReportExport } from "./use-report-export";
import { dateLabel, todayInBooks } from "./format";
import { PeriodControls } from "./report-period-controls";
import { useFiscalStartMonth } from "./use-fiscal-year";
import {
  CardRow,
  CardTotal,
  CoverageDisclosure,
  ExportMenu,
  HealthLine,
  LegendRow,
  MetricTile,
  ReportSkeleton,
  ScopeNotice,
  ScrollList,
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

type OwnerMetric = "in" | "out" | "salary" | "share";

const metricCopy: Record<
  OwnerMetric,
  { tile: string; mode: OwnerChartMode; title: string; description: string }
> = {
  in: {
    tile: "Money put in",
    mode: "flows",
    title: "Put in and taken out, by month",
    description: "Money you put into the business beside money you took out, each month.",
  },
  out: {
    tile: "Money taken out",
    mode: "flows",
    title: "Put in and taken out, by month",
    description: "Money you put into the business beside money you took out, each month.",
  },
  salary: {
    tile: "Paid as salary",
    mode: "salary",
    title: "Salary and draws, by month",
    description: "Your pay through payroll beside the money you took out as owner.",
  },
  share: {
    tile: "Taken out vs profit",
    mode: "share",
    title: "Taken out against profit, so far",
    description: "Running totals from the start of the period: what you took out beside what the business earned.",
  },
};

export function AccountingOwnerActivity({
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
  const fallback = demo
    ? defaultReportFilter(`${today.slice(0, 4)}-01-01`, today)
    : defaultReportFilter(from, to);
  const filter: ReportFilter = {
    ...readReportFilter(params.get("report_filter"), fallback),
    payee: undefined,
  };
  const signature = JSON.stringify(filter);
  const [metric, setMetric] = useState<OwnerMetric>("out");
  const [detail, setDetail] = useState(false);
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);
  const exporter = useReportExport();
  const fiscalStart = useFiscalStartMonth(demo);
  const { isHidden } = usePrivacy();

  const live = !demo;
  const options = { enabled: live, keepPrevious: true };
  const comparison: ReportFilter | null =
    filter.compare_from && filter.compare_to
      ? { from: filter.compare_from, to: filter.compare_to, mode: filter.mode, offset: 0 }
      : null;
  const reportRead = useAccountingRead<ReportData>(reportQuery("owner-activity", filter), options);
  const compareRead = useAccountingRead<ReportData>(
    comparison ? reportQuery("owner-activity", comparison) : null,
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
  const data = demo ? demoData : (reportRead.data ?? null);
  const previous = demo ? demoCompare : (compareRead.data ?? null);
  const salaryIds = data ? salaryAccounts(data).map((a) => a.id) : [];
  const salaryFilter: BreakdownFilter | null = salaryIds.length
    ? {
        from: filter.from,
        to: filter.to,
        mode: filter.mode,
        group_by: "month",
        measure: "activity",
        account_ids: salaryIds,
      }
    : null;
  const salaryRead = useAccountingRead<BreakdownData>(
    salaryFilter ? balanceSeriesQuery(salaryFilter) : null,
    options,
  );
  const demoSalary = useMemo(
    () => (demo && salaryFilter ? demoAccountActivity(salaryFilter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature, salaryIds.join(",")],
  );
  const salary = demo ? demoSalary : (salaryRead.data ?? null);
  const lineRead = useReportLines(data ? ownerLinesFilter(data) : null, demo);
  const lines = useMemo(() => (lineRead.rows ? ownerLines(lineRead.rows) : null), [lineRead.rows]);
  const loading = live && reportRead.loading;
  const updating = live && (reportRead.isPlaceholder || reportRead.revalidating);

  function apply(patch: Partial<ReportFilter>, replace = false) {
    setDrill(null);
    writeReportFilter({ ...filter, ...patch, offset: 0 }, replace);
  }
  const openDetail: Drill = (title, scope) => {
    const parsed = reportFilterSchema.safeParse(scope);
    if (parsed.success) setDrill({ title, filter: parsed.data });
  };

  const errorMessage = exporter.error || (live && !data && reportRead.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Owner activity"
        subtitle="What you put in and took out, beside what the business earned."
        actions={
          <ExportMenu
            label="Export owner activity"
            disabled={!data || loading}
            exporting={exporter.exporting}
            demo={demo}
            onExport={(format) =>
              data &&
              void exporter.run(
                data,
                { report_id: "owner-activity", show_zero: false, details: detail, layout: 2 },
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
        scope="Owner equity, salary and profit"
        updating={updating}
        onApply={apply}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing owner activity" />
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", updating && "opacity-70")}
        >
          <ScopeNotice data={data} onReview={onReview} />
          {isEmptyOwnerReport(data) ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <UserRound size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">No owner activity in this period</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a longer period, or record the money you put in and took out.
              </p>
            </Card>
          ) : (
            <OwnerReport
              data={data}
              previous={previous}
              lines={lines}
              linesComplete={lineRead.complete}
              linesTotal={lineRead.total}
              linesError={lineRead.error}
              salary={salary?.rows ?? null}
              metric={metric}
              setMetric={setMetric}
              detail={detail}
              setDetail={setDetail}
              privacy={isHidden}
              onDrill={openDetail}
              onEntry={onEntry}
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

/** A change in a figure where up is neither good nor bad. */
function neutralChange(now: bigint, before: bigint | null, short: string | null): TileChange | null {
  if (before === null || !short) return null;
  const c = changeOf(now, before);
  if (c.kind === "none") return { text: `No change vs ${short}`, tone: "flat" };
  if (c.kind === "near-zero")
    return { text: `${c.diff > ZERO ? "+" : ""}${formatCents(c.diff)} vs almost nothing`, tone: "flat" };
  return { text: `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${short}`, tone: "flat" };
}

function OwnerReport({
  data,
  previous,
  lines,
  linesComplete,
  linesTotal,
  linesError,
  salary,
  metric,
  setMetric,
  detail,
  setDetail,
  privacy,
  onDrill,
  onEntry,
  onReload,
}: {
  data: ReportData;
  previous: ReportData | null;
  lines: OwnerLine[] | null;
  linesComplete: boolean;
  linesTotal: number;
  linesError: string;
  salary: BreakdownData["rows"] | null;
  metric: OwnerMetric;
  setMetric: (m: OwnerMetric) => void;
  detail: boolean;
  setDetail: (v: boolean) => void;
  privacy: boolean;
  onDrill: Drill;
  onEntry: (id: string) => void;
  onReload: () => void;
}) {
  const compared = compareLabel(data.filter);
  const short = compared?.short ?? null;
  const t = ownerTotals(data);
  const then = previous ? ownerTotals(previous) : null;
  const months = ownerMonths(data, lines, t.salaryTracked ? salary : null);
  const { isRevealed, hoverProps } = useMaskedHover();
  const copy = metricCopy[metric];
  const series = OWNER_SERIES[copy.mode];
  const periodText = rangeLabel(data.filter.from, data.filter.to);
  const shareChange = (): TileChange | null => {
    if (!short || !then || t.takenShare === null || then.takenShare === null) return null;
    const diff = Math.round((t.takenShare - then.takenShare) * 10) / 10;
    if (diff === 0) return { text: `No change vs ${short}`, tone: "flat" };
    return { text: `${diff > 0 ? "+" : ""}${diff.toFixed(1)} pts vs ${short}`, tone: "flat" };
  };
  const tiles: { id: OwnerMetric; value: string; change: TileChange | null; context: string; spark: number[] }[] = [
    {
      id: "in",
      value: formatCents(t.putIn),
      change: neutralChange(t.putIn, then?.putIn ?? null, short),
      context: "Credits to your owner accounts",
      spark: months.map((m) => Number(m.putIn) / 100),
    },
    {
      id: "out",
      value: formatCents(t.takenOut),
      change: neutralChange(t.takenOut, then?.takenOut ?? null, short),
      context: "Draws and distributions",
      spark: months.map((m) => Number(m.takenOut) / 100),
    },
    {
      id: "salary",
      value: t.salaryTracked ? formatCents(t.salary) : "Not tracked",
      change: t.salaryTracked ? neutralChange(t.salary, then?.salary ?? null, short) : null,
      context: t.salaryTracked ? "Officer pay through payroll, before tax" : "No officer pay account in the books",
      spark: months.map((m) => (m.salary === null ? 0 : Number(m.salary) / 100)),
    },
    {
      id: "share",
      value: t.takenShare === null ? "No profit" : `${t.takenShare.toFixed(1)}%`,
      change: shareChange(),
      context: t.takenShare === null ? "The business made no profit" : "Of this period's profit",
      spark: months.map((m) => (m.profitSoFar > ZERO ? Number((m.takenSoFar * BigInt(1000)) / m.profitSoFar) / 10 : 0)),
    },
  ];
  const roll = equityRollForward(data);
  const statement = ownerStatement(data, detail);
  const tied = statement.find((r) => r.key === "end")?.values[0] === t.endingEquity.toString();
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
        labelledBy="oa-chart"
        title={copy.title}
        description={
          copy.mode === "salary" && !t.salaryTracked
            ? "The books have no officer pay account, so only money taken out is shown."
            : lines === null
              ? `${copy.description} Reading your transactions.`
              : copy.description
        }
      >
        <div className="px-3 pb-5 sm:px-5 lg:px-6 lg:pb-6" {...hoverProps}>
          <LegendRow
            items={[
              {
                ...series.first,
                shown: months.some((m) =>
                  copy.mode === "flows"
                    ? m.putIn !== ZERO
                    : copy.mode === "salary"
                      ? (m.salary ?? ZERO) !== ZERO
                      : m.profitSoFar !== ZERO,
                ),
              },
              {
                ...series.second,
                shown: months.some((m) => (copy.mode === "share" ? m.takenSoFar : m.takenOut) !== ZERO),
              },
            ]}
          />
          <OwnerActivityChart
            data={months}
            mode={copy.mode}
            title={`${copy.title}, ${periodText}`}
            revealed={isRevealed}
            masked={privacy}
          />
        </div>
      </SectionCard>

      <CardRow wide>
        <EquityCard roll={roll} t={t} privacy={privacy} onDrill={onDrill} />
        <SalaryCard t={t} privacy={privacy} />
      </CardRow>

      <SectionCard
        labelledBy="oa-lines"
        title="Every time money moved"
        description={
          linesError
            ? linesError
            : lines === null
              ? "Reading your transactions."
              : lines.length
                ? `${lines.length} ${lines.length === 1 ? "transaction" : "transactions"} on your owner accounts, newest first. Select one to open it.`
                : "No money moved between you and the business in this period."
        }
      >
        {lines && lines.length > 0 && (
          <ScrollList label="Owner transactions" className="mx-2.5 mb-3 lg:mx-3.5">
            <ul className="space-y-0.5">
              {lines.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => onEntry(l.entryId)}
                    className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,12rem)_auto]"
                  >
                    <span className="hidden text-xs text-muted-foreground tabular-nums sm:block">
                      {dateLabel(l.date)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm" title={l.memo}>
                        {l.memo}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground sm:hidden">
                        {dateLabel(l.date)}, {l.account}
                      </span>
                    </span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:block" title={l.account}>
                      {l.account}
                    </span>
                    <span
                      className={cn(
                        "text-right text-sm tabular-nums",
                        !privacy && l.amount < ZERO && "text-copper-strong",
                      )}
                    >
                      <MaskedValue value={`${l.amount > ZERO ? "+" : ""}${formatCents(l.amount)}`} />
                      <span className="block text-xs text-muted-foreground">
                        {l.amount > ZERO ? "Put in" : "Taken out"}
                      </span>
                    </span>
                    <span className="sr-only">, open the transaction</span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollList>
        )}
        {lines && !linesComplete && (
          <p className="px-5 pb-3 text-xs text-muted-foreground lg:px-6">
            Showing the first {lines.length} of {linesTotal}. The totals above count every one.
          </p>
        )}
        {t.putIn >= t.takenOut ? (
          <CardTotal label="Put in, less taken out" amount={t.putIn - t.takenOut} />
        ) : (
          <CardTotal label="Taken out, less put in" amount={t.takenOut - t.putIn} />
        )}
      </SectionCard>

      <SectionCard
        labelledBy="oa-statement"
        title="Statement"
        description="Your equity from the start of the period to the end. Select a line to see its transactions."
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
              id: "owner-activity",
              title: "Owner activity",
              description: "",
              columns: [],
              rows: statement,
              footnotes: [],
              comparison: !!data.filter.compare_from,
            }}
            rows={statement}
            base={ZERO}
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
                ? { tone: "good", text: "Ties out: ending equity matches the balance sheet" }
                : { tone: "warn", text: "Ending equity does not match the balance sheet" },
            ]}
          />
          <span className="text-xs text-muted-foreground">Revision {data.revision}</span>
        </div>
      </SectionCard>

      <CoverageDisclosure data={data} notes={OWNER_NOTES} onReload={onReload} />
    </>
  );
}

function EquityCard({
  roll,
  t,
  privacy,
  onDrill,
}: {
  roll: ReturnType<typeof equityRollForward>;
  t: OwnerTotals;
  privacy: boolean;
  onDrill: Drill;
}) {
  const hover = useMaskedHover();
  const hide = privacy && !hover.showValue;
  const change = t.endingEquity - t.startingEquity;
  return (
    <SectionCard
      labelledBy="oa-equity"
      title="Where your equity went"
      description={
        hide
          ? "Hover to reveal the amounts."
          : `Your equity went ${change >= ZERO ? "up" : "down"} by ${formatCents(change >= ZERO ? change : -change)}, from ${formatCents(t.startingEquity)} to ${formatCents(t.endingEquity)}.`
      }
    >
      <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6" {...hover.hoverProps}>
        <WaterfallList
          label="Equity, start to end"
          start={{ label: "Starting equity", amount: roll.start }}
          lines={roll.lines}
          total={{ label: "Ending equity", amount: roll.end }}
          onDrill={onDrill}
          hide={hide}
        />
      </div>
    </SectionCard>
  );
}

/**
 * Salary through payroll beside money taken out as owner: one share bar,
 * the sentence, and plain notes on anything worth a look.
 */
function SalaryCard({ t, privacy }: { t: OwnerTotals; privacy: boolean }) {
  const { showValue, hoverProps } = useMaskedHover();
  const hide = privacy && !showValue;
  const whole = t.salary + t.takenOut;
  const salaryShare = whole > ZERO ? Number((t.salary * BigInt(1000)) / whole) / 10 : 0;
  const notes = ownerNotes(t);
  return (
    <SectionCard
      labelledBy="oa-salary"
      title="Salary and draws"
      description={hide ? "Hover to reveal the amounts." : ownerSentence(t)}
    >
      <div className="flex flex-1 flex-col gap-4 px-5 pb-5 lg:px-6 lg:pb-6" {...hoverProps}>
        {whole > ZERO && (
          <div>
            <div
              aria-hidden="true"
              className="flex h-3 w-full overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]"
            >
              <span className="h-full bg-teal" style={{ width: `${salaryShare}%` }} />
              <span className="h-full bg-copper-strong" style={{ width: `${100 - salaryShare}%` }} />
            </div>
            <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-teal" />
                  Salary through payroll
                </dt>
                <dd className="text-right tabular-nums">
                  {t.salaryTracked ? <MaskedValue value={formatCents(t.salary)} inheritHover /> : "Not tracked"}
                  <span className="ml-2 text-xs text-muted-foreground">
                    <MaskedValue value={`${salaryShare.toFixed(1)}%`} inheritHover />
                  </span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-copper-strong" />
                  Taken out as owner
                </dt>
                <dd className="text-right tabular-nums">
                  <MaskedValue value={formatCents(t.takenOut)} inheritHover />
                  <span className="ml-2 text-xs text-muted-foreground">
                    <MaskedValue value={`${(100 - salaryShare).toFixed(1)}%`} inheritHover />
                  </span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-muted-foreground">Profit this period</dt>
                <dd className="text-right tabular-nums">
                  <MaskedValue value={formatCents(t.profit)} inheritHover />
                </dd>
              </div>
            </dl>
          </div>
        )}
        {notes.length > 0 && (
          <ul className="mt-auto space-y-2">
            {notes.map((n) => (
              <li
                key={n.text}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm leading-relaxed",
                  n.tone === "look"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-[rgba(var(--ink),0.03)]",
                )}
              >
                {n.tone === "look" ? (
                  <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
                ) : (
                  <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
                )}
                <span>{hide ? "Hover to reveal." : n.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <CardTotal label="Salary and draws together" amount={whole} />
    </SectionCard>
  );
}
