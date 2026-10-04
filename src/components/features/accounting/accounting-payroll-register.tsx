"use client";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, CheckCircle2, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import type { ReportData, ReportFilter } from "@/lib/accounting/reports";
import { supportReportFilterSchema, type SupportReportData } from "@/lib/accounting/support-reports";
import { reportQuery } from "@/lib/accounting/preload";
import { demoPayrollYear, demoReportData } from "@/lib/accounting/demo-reports";
import { rangeLabel } from "@/lib/accounting/profit-loss";
import { accountingHref } from "@/lib/accounting/views";
import {
  PAYROLL_NOTES,
  payrollBreakdown,
  payrollMonths,
  payrollQuarters,
  payrollScope,
  payrollTies,
  payrollTotals,
  payrollYears,
  quarterOf,
  quarterSummaries,
  registerRuns,
  runEmployees,
  runIndex,
  type PayrollQuarter,
  type PayrollYearRead,
  type RegisterRun,
} from "@/lib/accounting/payroll-register";
import { PayrollChart, PAYROLL_SERIES } from "@/components/charts/payroll-chart";
import { AccountingPageHeader } from "./accounting-page-header";
import { useAccountingRead } from "./use-accounting-read";
import { dateLabel, todayInBooks } from "./format";
import { CardRow, ExportMenu, LegendRow, ReportSkeleton, SectionCard, Segmented, StatTile } from "./report-kit";
import { CheckList, SupportNotes, YearControls, useSupportExport, useSupportReport } from "./support-report-kit";

const ZERO = BigInt(0);

/**
 * The payroll register: what payroll cost for a calendar year (or one
 * quarter of it), what was taken home, and whether every run ties to the
 * books. Payroll is calendar-year, as W-2s and quarterly returns are.
 */
export function AccountingPayrollRegister({
  onBack,
  onEntry,
  demo = false,
}: {
  onBack: () => void;
  onEntry: (id: string) => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  const years = payrollYears(today);
  const saved = (() => {
    try {
      const parsed = supportReportFilterSchema.safeParse(JSON.parse(params.get("support_filter") ?? "{}"));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  })();
  const savedYear = saved ? Number(saved.to.slice(0, 4)) : null;
  const year = savedYear && years.includes(savedYear) ? savedYear : years[0];
  const quarter = saved && savedYear === year ? quarterOf(saved) : null;
  const quarters = payrollQuarters(year, today);
  const scope = payrollScope(year, today, quarter && quarters.includes(quarter) ? quarter : null);
  const read = useSupportReport(scope, demo);
  const data = read.data;
  const exporter = useSupportExport();
  const { isHidden } = usePrivacy();

  // The runs' details (components, provider facts, journal entries) for the
  // year to the scope's end, and the books' payroll accounts for the scope.
  const yearRead = useAccountingRead<PayrollYearRead>(
    { view: "payroll-year", year: String(year), through: scope.to },
    { enabled: !demo, keepPrevious: true },
  );
  const booksScope: ReportFilter = { from: scope.from, to: scope.to, mode: "posted", offset: 0 };
  const booksRead = useAccountingRead<ReportData>(reportQuery("profit-loss", booksScope), {
    enabled: !demo,
    keepPrevious: true,
  });
  const demoYear = useMemo(() => (demo ? demoPayrollYear(year, scope.to) : null), [demo, year, scope.to]);
  const demoBooks = useMemo(
    () => (demo ? demoReportData(booksScope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, scope.from, scope.to],
  );
  const payrollYear = demo ? demoYear : (yearRead.data ?? null);
  const books = demo ? demoBooks : (booksRead.data ?? null);

  function choose(nextYear: number, nextQuarter: PayrollQuarter | null) {
    const url = new URL(window.location.href);
    url.searchParams.set("support_filter", JSON.stringify(payrollScope(nextYear, today, nextQuarter)));
    window.history.pushState(null, "", url);
  }

  const errorMessage = exporter.error || (!data && read.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Payroll register"
        subtitle="What payroll cost, what was taken home, and whether every run ties to the books."
        actions={
          <ExportMenu
            label="Export the payroll register"
            disabled={!data || read.loading}
            exporting={exporter.exporting}
            demo={demo}
            pdfDescription="Branded register, runs by quarter"
            csvDescription="One row per run, with quarter totals"
            onExport={(format) => data && void exporter.run(data, format)}
          />
        }
      />
      <YearControls
        years={years}
        year={year}
        from={scope.from}
        to={scope.to}
        scope="Posted payroll runs"
        updating={read.updating}
        onYear={(y) => choose(y, null)}
      >
        <Segmented
          label="Quarter"
          value={quarter ? String(quarter) : "year"}
          onChange={(v) => choose(year, v === "year" ? null : (Number(v) as PayrollQuarter))}
          options={[
            { value: "year", label: "Year" },
            ...quarters.map((q) => ({ value: String(q), label: `Q${q}` })),
          ]}
        />
      </YearControls>
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {read.loading && !data ? (
        <ReportSkeleton label="Preparing the payroll register" />
      ) : data ? (
        <div
          aria-busy={read.updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", read.updating && "opacity-70")}
        >
          <Register
            data={data}
            payrollYear={payrollYear}
            books={books}
            detailsError={!demo && !payrollYear ? yearRead.error : ""}
            privacy={isHidden}
            onEntry={onEntry}
            onReload={() => {
              read.reload();
              void yearRead.reload();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Register({
  data,
  payrollYear,
  books,
  detailsError,
  privacy,
  onEntry,
  onReload,
}: {
  data: SupportReportData;
  payrollYear: PayrollYearRead | null;
  books: ReportData | null;
  detailsError: string;
  privacy: boolean;
  onEntry: (id: string) => void;
  onReload: () => void;
}) {
  const runs = registerRuns(data);
  const t = payrollTotals(runs, payrollYear);
  const months = payrollMonths(runs, data.filter, payrollYear);
  const hover = useMaskedHover();
  const year = Number(data.filter.to.slice(0, 4));
  if (!runs.length)
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <Wallet size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No payroll runs in this period</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Post your payroll runs in Payroll, and they appear here by pay date.
        </p>
      </Card>
    );
  const legend = [
    { ...PAYROLL_SERIES.net, shown: t.net !== ZERO },
    { ...PAYROLL_SERIES.withholding, shown: t.withholding !== ZERO },
    { ...PAYROLL_SERIES.employer, shown: t.employerTax + t.employerOther !== ZERO },
  ];
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile label="Gross wages" value={formatCents(t.gross)} context={`${t.runs} ${t.runs === 1 ? "run" : "runs"}`} />
        <StatTile
          label="Employer costs"
          value={formatCents(t.employerTax + t.employerOther)}
          context={t.detailed ? "On top of wages" : "Employer taxes"}
        />
        <StatTile label="Net pay" value={formatCents(t.net)} context="After withholding" />
        <StatTile label="Total payroll cost" value={formatCents(t.cost)} context="Wages plus employer" />
      </section>

      <SectionCard
        labelledBy="pr-chart"
        title="Payroll by month"
        description="Net pay and what was withheld make up gross wages; the employer's cost sits on top."
      >
        <div className="px-3 pb-5 sm:px-5 lg:px-6 lg:pb-6" {...hover.hoverProps}>
          <LegendRow items={legend} />
          <PayrollChart
            data={months}
            title={`Payroll by month, ${rangeLabel(data.filter.from, data.filter.to)}`}
            revealed={hover.isRevealed}
            masked={privacy}
          />
        </div>
      </SectionCard>

      <CardRow>
        <DollarCard runs={runs} payrollYear={payrollYear} privacy={privacy} />
        <TiesCard
          runs={runs}
          payrollYear={payrollYear}
          books={books}
          error={detailsError}
          privacy={privacy}
          onEntry={onEntry}
        />
      </CardRow>

      <QuarterCard runs={runs} payrollYear={payrollYear} year={year} />

      <Statement runs={runs} payrollYear={payrollYear} t={t} onEntry={onEntry} />

      <SupportNotes data={data} notes={PAYROLL_NOTES} onReload={onReload} />
    </>
  );
}

/** Gross wages, what came out of them, net pay, and the employer's cost on top. */
function DollarCard({
  runs,
  payrollYear,
  privacy,
}: {
  runs: RegisterRun[];
  payrollYear: PayrollYearRead | null;
  privacy: boolean;
}) {
  const { showValue, hoverProps } = useMaskedHover();
  const hide = privacy && !showValue;
  const t = payrollTotals(runs, payrollYear);
  const b = payrollBreakdown(runs, payrollYear);
  const share = (v: bigint) => (t.cost > ZERO ? Number((v * BigInt(1000)) / t.cost) / 10 : 0);
  const employer = t.employerTax + t.employerOther;
  const line = (label: string, amount: bigint, sign: "" | "-" | "+", strong = false, sub = false) => (
    <div key={label} className={cn("flex items-baseline justify-between gap-4 py-2", sub && "pl-4")}>
      <dt className={cn(strong ? "font-medium" : "text-muted-foreground")}>{label}</dt>
      <dd className={cn("tabular-nums", strong && "font-medium")}>
        <MaskedValue value={`${sign === "-" ? "-" : sign === "+" ? "+" : ""}${formatCents(amount)}`} inheritHover />
      </dd>
    </div>
  );
  return (
    <SectionCard
      labelledBy="pr-dollar"
      title="Where each payroll dollar went"
      description={
        hide
          ? "Gross wages to net pay, and the employer's cost on top."
          : `Of every dollar payroll cost, ${share(t.net).toFixed(0)} cents went out as net pay.`
      }
    >
      <div className="flex flex-1 flex-col gap-3 px-5 pb-4 lg:px-6" {...hoverProps}>
        <div aria-hidden="true" className="flex h-3 w-full overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]">
          <span className="h-full bg-teal" style={{ width: `${share(t.net)}%` }} />
          <span className="h-full bg-teal-light" style={{ width: `${share(t.withholding)}%` }} />
          <span className="h-full bg-copper-strong" style={{ width: `${share(employer)}%` }} />
        </div>
        <dl className="divide-y divide-border border-y border-border text-sm">
          {line("Gross wages", t.gross, "", true)}
          {b.withholding.map((w) => line(w.label, w.amount, "-", false, true))}
          {line("Net pay", t.net, "", true)}
          {b.employer.map((e) => line(e.label, e.amount, "+", false, true))}
        </dl>
        {!t.detailed && (
          <p className="text-xs text-muted-foreground">
            Withholding by type and other employer costs come from each run&apos;s details, which are not loaded.
          </p>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-4 border-t border-border px-5 py-3.5 text-sm font-semibold lg:px-6">
        <span>Total payroll cost</span>
        <span className="tabular-nums">
          <MaskedValue value={formatCents(t.cost)} />
        </span>
      </div>
    </SectionCard>
  );
}

/** Each run has its journal, adds up, and the payroll accounts hold what the runs posted. */
function TiesCard({
  runs,
  payrollYear,
  books,
  error,
  privacy,
  onEntry,
}: {
  runs: RegisterRun[];
  payrollYear: PayrollYearRead | null;
  books: ReportData | null;
  error: string;
  privacy: boolean;
  onEntry: (id: string) => void;
}) {
  // Privacy mode hides the amounts the checks quote.
  const mask = (s: string) => (privacy ? s.replace(/-?\$[\d,]+\.\d\d/g, "•••••") : s);
  const ties = payrollTies(runs, payrollYear, books).map((x) => ({ ...x, title: mask(x.title), detail: mask(x.detail) }));
  const good = ties.filter((x) => x.tone === "good");
  const rest = ties.filter((x) => x.tone !== "good");
  return (
    <SectionCard
      labelledBy="pr-ties"
      title="Ties to the books"
      description={
        error
          ? `The runs' details did not load: ${error}`
          : rest.some((x) => x.tone === "look")
            ? "Most of payroll ties out; a few things need a look."
            : "Every run ties to the books."
      }
    >
      <div className="flex flex-1 flex-col gap-3 px-5 pb-5 lg:px-6 lg:pb-6">
        {good.length > 0 && (
          <ul className="space-y-1.5">
            {good.map((x) => (
              <li key={x.key} className="flex items-start gap-2 text-sm">
                <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
                <span className="min-w-0">
                  <span className="block font-medium">{x.title}</span>
                  <span className="block text-xs text-muted-foreground">{x.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {rest.length > 0 && (
          <CheckList
            empty=""
            items={rest.map((x) => ({
              key: x.key,
              tone: x.tone === "look" ? "look" : "info",
              title: x.title,
              detail: x.detail,
              action: x.entryId ? (
                <button
                  type="button"
                  onClick={() => onEntry(x.entryId!)}
                  className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  Open the entry
                  <ArrowUpRight size={12} aria-hidden="true" />
                </button>
              ) : x.key === "drafts" ? (
                <a
                  href={accountingHref("payroll")}
                  className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  Open Payroll
                  <ArrowUpRight size={12} aria-hidden="true" />
                </a>
              ) : undefined,
            }))}
          />
        )}
      </div>
    </SectionCard>
  );
}

/** Each quarter's totals, with the provider's wage facts where every run has them. */
function QuarterCard({
  runs,
  payrollYear,
  year,
}: {
  runs: RegisterRun[];
  payrollYear: PayrollYearRead | null;
  year: number;
}) {
  const quarters = quarterSummaries(runs, payrollYear);
  const facts = quarters.length > 0 && quarters.every((q) => q.facts);
  // Whole class names, so the styles are generated.
  const cols = facts
    ? "@2xl:grid-cols-[4rem_repeat(5,minmax(0,1fr))]"
    : "@2xl:grid-cols-[4rem_repeat(4,minmax(0,1fr))]";
  const head = facts
    ? ["Wages", "Federal tax withheld", "Social Security wages", "Medicare wages", "Employer taxes"]
    : ["Wages", "Withheld", "Employer taxes", "Net pay"];
  return (
    <SectionCard
      labelledBy="pr-quarters"
      title="By quarter"
      description={
        facts
          ? "Information for checking your quarterly returns: the wages and withholding your payroll provider reported, as the books hold them. Compare with what was filed."
          : "Each quarter's register totals. The provider's wage facts are shown only when every run in a quarter reports them."
      }
    >
      <div className="@container border-t border-border px-5 pb-4 lg:px-6">
        <div
          role="table"
          aria-label={`Payroll by quarter, ${year}`}
          className="w-full text-sm"
        >
          <div role="row" className={cn("hidden gap-x-3 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid", cols)}>
            <span role="columnheader">Quarter</span>
            {head.map((h) => (
              <span key={h} role="columnheader" className="text-right">
                {h}
              </span>
            ))}
          </div>
          {quarters.map((q) => {
            const cells = facts
              ? [q.gross, q.facts!.federalWithheld, q.facts!.socialSecurityWages, q.facts!.medicareWages, q.employer]
              : [q.gross, q.withholding, q.employer, q.net];
            return (
              <div
                key={q.quarter}
                role="row"
                className={cn("grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border py-2.5 @md:grid-cols-2 @2xl:items-baseline", cols)}
              >
                <span role="rowheader" className="font-medium @md:col-span-2 @2xl:col-span-1">
                  Q{q.quarter}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {q.runs} {q.runs === 1 ? "run" : "runs"}
                  </span>
                </span>
                {cells.map((v, i) => (
                  <span key={head[i]} role="cell" className="flex justify-between gap-2 tabular-nums @2xl:block @2xl:text-right">
                    <span className="text-xs text-muted-foreground @2xl:hidden">{head[i]}</span>
                    <MaskedValue value={formatCents(v)} />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </SectionCard>
  );
}

/** One row per run: pay date, who it paid, gross, withholding, employer cost, net, and its journal entry. */
function Statement({
  runs,
  payrollYear,
  t,
  onEntry,
}: {
  runs: RegisterRun[];
  payrollYear: PayrollYearRead | null;
  t: ReturnType<typeof payrollTotals>;
  onEntry: (id: string) => void;
}) {
  const index = runIndex(payrollYear);
  const grid =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 @3xl:grid-cols-[6.5rem_minmax(0,1fr)_7rem_7rem_7rem_7rem]";
  return (
    <SectionCard
      labelledBy="pr-statement"
      title="Runs"
      description="Each posted run by pay date. Select one to open its journal entry."
    >
      <div className="@container border-t border-border">
        <div
          aria-hidden="true"
          className={cn(grid, "hidden px-5 pt-3 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @3xl:grid lg:px-6")}
        >
          <span>Pay date</span>
          <span>Run</span>
          <span className="text-right">Gross</span>
          <span className="text-right">Withheld</span>
          <span className="text-right">Employer</span>
          <span className="text-right">Net pay</span>
        </div>
        <ul className="space-y-0.5 px-2.5 pt-1 pb-2 lg:px-3.5">
          {runs.map((r) => {
            const entry = index.get(r.id)?.entry_id ?? null;
            const names = runEmployees(r, payrollYear);
            const body = (
              <>
                <span className="hidden text-xs text-muted-foreground tabular-nums @3xl:block">{dateLabel(r.date)}</span>
                <span className="min-w-0">
                  <span className="block truncate">{r.run}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <span className="@3xl:hidden">{dateLabel(r.date)}</span>
                    {names.length > 0 && (
                      <>
                        <span className="@3xl:hidden">, </span>
                        {names.join(", ")}
                      </>
                    )}
                  </span>
                </span>
                <span className="hidden text-right tabular-nums @3xl:block">
                  <MaskedValue value={formatCents(r.gross)} />
                </span>
                <span className="hidden text-right tabular-nums text-muted-foreground @3xl:block">
                  <MaskedValue value={formatCents(r.withholding)} />
                </span>
                <span className="hidden text-right tabular-nums text-muted-foreground @3xl:block">
                  <MaskedValue value={formatCents(r.employer)} />
                </span>
                <span className="text-right tabular-nums">
                  <MaskedValue value={formatCents(r.net)} />
                  <span className="block text-xs text-muted-foreground @3xl:hidden">
                    <MaskedValue value={`${formatCents(r.gross)} gross`} />
                  </span>
                </span>
              </>
            );
            const row = cn(
              grid,
              "w-full items-baseline rounded-lg px-2.5 py-2 text-left text-sm",
              entry &&
                "transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
            );
            return (
              <li key={r.id}>
                {entry ? (
                  <button type="button" className={row} onClick={() => onEntry(entry)}>
                    {body}
                    <span className="sr-only">, open the journal entry</span>
                  </button>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-border px-5 py-3.5 text-sm lg:px-6">
        <span className="text-muted-foreground">Gross wages</span>
        <span className="text-right tabular-nums">
          <MaskedValue value={formatCents(t.gross)} />
        </span>
        <span className="text-muted-foreground">Withheld, and employer taxes</span>
        <span className="text-right tabular-nums">
          <MaskedValue value={`${formatCents(t.withholding)} / ${formatCents(t.employerTax)}`} />
        </span>
        <span className="font-semibold">Net pay</span>
        <span className="text-right font-semibold tabular-nums">
          <MaskedValue value={formatCents(t.net)} />
        </span>
      </div>
    </SectionCard>
  );
}
