"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BookOpen, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/inputs/Select";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import type { ReportData, ReportDetail, ReportFilter } from "@/lib/accounting/reports";
import { defaultReportFilter, reportQuery } from "@/lib/accounting/preload";
import {
  LEDGER_NOTES,
  LEDGER_TYPES,
  LEDGER_TYPE_LABELS,
  ledgerAccounts,
  ledgerLines,
  ledgerScope,
  ledgerTotals,
  matchLines,
  basisSentence,
  type LedgerAccount,
  type LedgerLine,
} from "@/lib/accounting/general-ledger";
import { demoReportData, demoReportDetail } from "@/lib/accounting/demo-reports";
import { AccountingPageHeader } from "./accounting-page-header";
import { useAccountingRead } from "./use-accounting-read";
import { useReportLines } from "./use-report-lines";
import { useReportExport } from "./use-report-export";
import { useFiscalStartMonth } from "./use-fiscal-year";
import { dateLabel, todayInBooks } from "./format";
import { PeriodControls } from "./report-period-controls";
import {
  CoverageDisclosure,
  ExportMenu,
  ReportSkeleton,
  ScopeNotice,
  ScrollList,
  SectionCard,
  StatTile,
  readReportFilter,
  writeReportFilter,
} from "./report-kit";

const ZERO = BigInt(0);
/** "All accounts" in the rail and the picker. */
const ALL = "all";
/** How tall the rail and the ledger list may grow before they scroll (rem). */
const LIST_CAP = 34;

export function AccountingGeneralLedger({
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
  // A ledger is one period: no comparison and no contact scope.
  const raw = readReportFilter(params.get("report_filter"), fallback);
  const filter: ReportFilter = { from: raw.from, to: raw.to, mode: raw.mode, offset: 0 };
  const signature = JSON.stringify(filter);
  const exporter = useReportExport();
  const fiscalStart = useFiscalStartMonth(demo);
  const [picked, setPicked] = useState<string | null>(null);

  const live = !demo;
  const reportRead = useAccountingRead<ReportData>(reportQuery("general-ledger", filter), {
    enabled: live,
    keepPrevious: true,
  });
  const demoData = useMemo(
    () => (demo ? demoReportData(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
  const accounts = useMemo(
    () => (data ? ledgerAccounts(data, fiscalStart) : []),
    [data, fiscalStart],
  );
  // Open on the first account with activity, which is usually checking.
  const selected =
    picked === ALL
      ? null
      : (accounts.find((a) => a.id === picked) ??
        accounts.find((a) => a.debit !== ZERO || a.credit !== ZERO) ??
        null);
  const lineRead = useReportLines(data ? ledgerScope(data, selected?.id ?? null) : null, demo);
  // Every line in the period, for the Lines tile: the first page says how many.
  const allQuery = data
    ? { view: "report-detail", filter: JSON.stringify(ledgerScope(data, null)) }
    : null;
  const countRead = useAccountingRead<ReportDetail>(allQuery, { enabled: live, keepPrevious: true });
  const [demoCount, setDemoCount] = useState<{ key: string; total: number } | null>(null);
  useEffect(() => {
    if (!demo || !data) return;
    let alive = true;
    void demoReportDetail(ledgerScope(data, null)).then(
      (d) => alive && setDemoCount({ key: signature, total: d.total }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, signature]);
  const lineCount = demo ? (demoCount?.key === signature ? demoCount.total : null) : (countRead.data?.total ?? null);
  const loading = live && reportRead.loading;
  const updating = live && (reportRead.isPlaceholder || reportRead.revalidating);

  function apply(patch: Partial<ReportFilter>, replace = false) {
    writeReportFilter({ ...filter, ...patch, offset: 0 }, replace);
  }

  const errorMessage = exporter.error || (live && !data && reportRead.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="General ledger"
        subtitle="Every line in every account: what happened, and where a transaction went."
        actions={
          <ExportMenu
            label="Export the general ledger, all accounts"
            disabled={!data || loading}
            exporting={exporter.exporting}
            demo={demo}
            onExport={(format) =>
              data &&
              void exporter.run(
                data,
                {
                  report_id: "general-ledger",
                  show_zero: false,
                  details: true,
                  layout: 2,
                  fiscal_start_month: fiscalStart,
                },
                format,
              )
            }
          />
        }
      />
      <PeriodControls
        filter={filter}
        today={today}
        fiscalMonth={fiscalStart}
        compare={false}
        scope="Every account, every line"
        updating={updating}
        onApply={apply}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing the general ledger" />
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", updating && "opacity-70")}
        >
          <ScopeNotice data={data} onReview={onReview} />
          {accounts.length === 0 ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <BookOpen size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">No lines in this period</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a longer period, or record the business&apos;s transactions.
              </p>
            </Card>
          ) : (
            <LedgerReport
              data={data}
              accounts={accounts}
              selected={selected}
              lineCount={lineCount}
              fiscalStart={fiscalStart}
              lines={lineRead.rows}
              linesTotal={lineRead.total}
              linesComplete={lineRead.complete}
              linesError={lineRead.error}
              onPick={setPicked}
              onEntry={onEntry}
              onReload={() => void reportRead.reload()}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function LedgerReport({
  data,
  accounts,
  selected,
  lineCount,
  fiscalStart,
  lines: rows,
  linesTotal,
  linesComplete,
  linesError,
  onPick,
  onEntry,
  onReload,
}: {
  data: ReportData;
  accounts: LedgerAccount[];
  selected: LedgerAccount | null;
  lineCount: number | null;
  fiscalStart: number;
  lines: ReportDetail["rows"] | null;
  linesTotal: number;
  linesComplete: boolean;
  linesError: string;
  onPick: (id: string) => void;
  onEntry: (id: string) => void;
  onReload: () => void;
}) {
  const [search, setSearch] = useState("");
  const [find, setFind] = useState("");
  const t = ledgerTotals(accounts);
  const balanced = t.debits === t.credits;
  const lines = rows ? ledgerLines(rows, data, fiscalStart) : null;
  const shown = lines ? matchLines(lines, find) : null;
  const q = search.trim().toLowerCase();
  const railAccounts = q
    ? accounts.filter((a) => `${a.code ?? ""} ${a.name}`.toLowerCase().includes(q))
    : accounts;
  const isResult = selected && (selected.type === "income" || selected.type === "expense");
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="Lines"
          value={lineCount === null ? "-" : lineCount.toLocaleString("en-US")}
          context="Journal lines"
        />
        <StatTile label="Debits" value={formatCents(t.debits)} context="In the period" />
        <StatTile
          label="Credits"
          value={formatCents(t.credits)}
          context={balanced ? "Equal to the debits" : "Not equal to the debits"}
          tone={balanced ? "neutral" : "bad"}
        />
        <StatTile
          label="Accounts with activity"
          value={String(t.active)}
          context={`Of ${accounts.length} in the ledger`}
        />
      </section>

      <div className="space-y-2.5 lg:hidden">
        <Select
          label="Account"
          searchable
          value={selected?.id ?? ALL}
          onChange={onPick}
          options={[
            { value: ALL, label: "All accounts", detail: "Every line, by date" },
            ...accounts.map((a) => ({
              value: a.id,
              label: a.code ? `${a.code} ${a.name}` : a.name,
              group: LEDGER_TYPE_LABELS[a.type],
              keywords: `${a.code ?? ""} ${a.name}`,
            })),
          ]}
        />
      </div>

      <div className="grid items-stretch gap-5 lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-6">
        <SectionCard
          labelledBy="gl-accounts"
          title="Accounts"
          description="Net change in the period. Select one to read its lines."
          className="hidden lg:flex"
        >
          <div className="px-5 pb-3 lg:px-6">
            <TextInput
              aria-label="Find an account"
              placeholder="Find an account"
              size="sm"
              clearable
              value={search}
              onChange={setSearch}
              prefix={<Search size={14} aria-hidden="true" />}
            />
          </div>
          <ScrollList label="Accounts" cap={LIST_CAP} className="mx-2.5 mb-3 lg:mx-3.5">
            <ul className="space-y-0.5">
              {!q && (
                <li>
                  <RailButton
                    active={!selected}
                    onClick={() => onPick(ALL)}
                    label="All accounts"
                    meta="Every line, by date"
                    amount={null}
                  />
                </li>
              )}
              {LEDGER_TYPES.map((type) => {
                const list = railAccounts.filter((a) => a.type === type);
                if (!list.length) return null;
                return (
                  <li key={type}>
                    <p className="px-2.5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-teal-light">
                      {LEDGER_TYPE_LABELS[type]}
                    </p>
                    <ul className="space-y-0.5">
                      {list.map((a) => (
                        <li key={a.id}>
                          <RailButton
                            active={selected?.id === a.id}
                            onClick={() => onPick(a.id)}
                            label={a.name}
                            meta={a.code ?? ""}
                            amount={a.change}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
              {q && railAccounts.length === 0 && (
                <li className="px-2.5 py-3 text-sm text-muted-foreground">No account matches.</li>
              )}
            </ul>
          </ScrollList>
        </SectionCard>

        <SectionCard
          labelledBy="gl-lines"
          title={selected ? (selected.code ? `${selected.code} ${selected.name}` : selected.name) : "All accounts"}
          description={
            linesError
              ? linesError
              : selected
                ? `${selected.type.charAt(0).toUpperCase()}${selected.type.slice(1)} account. ${
                    isResult
                      ? basisSentence(data.filter, fiscalStart)
                      : "The balance runs from the start of the books."
                  }`
                : "Every line in the period, by date, with its account."
          }
        >
          <div className="px-5 pb-3 lg:px-6">
            <TextInput
              aria-label="Find a line"
              placeholder="Find a line by description or amount"
              size="sm"
              clearable
              value={find}
              onChange={setFind}
              prefix={<Search size={14} aria-hidden="true" />}
            />
          </div>
          {selected && (
            <div className="mx-5 flex items-center justify-between gap-4 border-y border-border py-2.5 text-sm lg:mx-6">
              <span className="text-muted-foreground">Opening balance, {dateLabel(data.filter.from)}</span>
              <span className="tabular-nums">
                <MaskedValue value={formatCents(selected.opening)} />
              </span>
            </div>
          )}
          {shown === null ? (
            <p className="px-5 py-6 text-sm text-muted-foreground lg:px-6">Reading the lines.</p>
          ) : shown.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground lg:px-6">
              {find ? "No line matches." : "No lines in this period."}
            </p>
          ) : (
            // The lines lay out by the card's own width: five columns when
            // there is room, the date and account under the description when not.
            <div className="@container flex min-w-0 flex-1 basis-0 flex-col">
              <div
                aria-hidden="true"
                className="mx-2.5 hidden grid-cols-[5.5rem_minmax(0,1fr)_6.75rem_6.75rem_7.75rem] gap-x-3 px-2.5 pt-2 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid lg:mx-3.5"
              >
                <span>Date</span>
                <span>Description</span>
                <span className="text-right">Debit</span>
                <span className="text-right">Credit</span>
                <span className="text-right">{selected ? "Balance" : ""}</span>
              </div>
              <ScrollList label="Ledger lines" cap={LIST_CAP} className="mx-2.5 mb-3 lg:mx-3.5">
                <ul className="space-y-0.5">
                  {shown.map((l) => (
                    <li key={l.id}>
                      <LineButton line={l} withAccount={!selected} onClick={() => onEntry(l.entryId)} />
                    </li>
                  ))}
                </ul>
              </ScrollList>
            </div>
          )}
          {lines && !linesComplete && (
            <p className="px-5 pb-2 text-xs text-muted-foreground lg:px-6">
              Showing the first {lines.length.toLocaleString("en-US")} of {linesTotal.toLocaleString("en-US")} lines. Pick a shorter period to see the rest here; the export has every line.
            </p>
          )}
          {find && shown && lines && (
            <p className="px-5 pb-2 text-xs text-muted-foreground lg:px-6">
              {shown.length} of {lines.length} lines match.
            </p>
          )}
          <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-border px-5 py-3.5 text-sm lg:px-6">
            <span className="text-muted-foreground">Debits and credits</span>
            <span className="text-right tabular-nums">
              <MaskedValue value={`${formatCents(selected ? selected.debit : t.debits)} / ${formatCents(selected ? selected.credit : t.credits)}`} />
            </span>
            {selected && (
              <>
                <span className="font-semibold">Closing balance, {dateLabel(data.filter.to)}</span>
                <span className="text-right font-semibold tabular-nums">
                  <MaskedValue value={formatCents(selected.closing)} />
                </span>
              </>
            )}
          </div>
        </SectionCard>
      </div>

      <CoverageDisclosure data={data} notes={LEDGER_NOTES} onReload={onReload} />
    </>
  );
}

function RailButton({
  active,
  onClick,
  label,
  meta,
  amount,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  meta: string;
  amount: bigint | null;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
        active && "bg-teal/[0.12] font-medium",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate" title={label}>
          {label}
        </span>
        {meta && <span className="block text-xs font-normal text-muted-foreground">{meta}</span>}
      </span>
      {amount !== null && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          <MaskedValue value={amount === ZERO ? "No change" : `${amount > ZERO ? "+" : ""}${formatCents(amount)}`} />
        </span>
      )}
    </button>
  );
}

function LineButton({
  line: l,
  withAccount,
  onClick,
}: {
  line: LedgerLine;
  withAccount: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring @2xl:grid-cols-[5.5rem_minmax(0,1fr)_6.75rem_6.75rem_7.75rem]"
    >
      <span className="hidden pt-px text-xs text-muted-foreground tabular-nums @2xl:block">{dateLabel(l.date)}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm" title={l.description}>
            {l.description}
          </span>
          {l.draft && (
            <Badge size="sm" className="shrink-0">
              Not reviewed
            </Badge>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground @2xl:hidden">
          {[dateLabel(l.date), withAccount ? l.account : null, l.note || null].filter(Boolean).join(", ")}
        </span>
        {(withAccount || l.note) && (
          <span className="hidden truncate text-xs text-muted-foreground @2xl:block">
            {[withAccount ? l.account : null, l.note || null].filter(Boolean).join(", ")}
          </span>
        )}
      </span>
      <span className="hidden text-right text-sm tabular-nums @2xl:block">
        {l.debit > ZERO && <MaskedValue value={formatCents(l.debit)} />}
      </span>
      <span className="hidden text-right text-sm tabular-nums @2xl:block">
        {l.credit > ZERO && <MaskedValue value={formatCents(l.credit)} />}
      </span>
      <span className="text-right text-sm tabular-nums">
        <span className="@2xl:hidden">
          <MaskedValue value={`${l.change > ZERO ? "+" : ""}${formatCents(l.change)}`} />
        </span>
        {!withAccount && (
          <span className="block text-xs text-muted-foreground @2xl:text-sm @2xl:text-foreground">
            <MaskedValue value={formatCents(l.balance)} />
          </span>
        )}
      </span>
      <span className="sr-only">, open the transaction</span>
    </button>
  );
}
