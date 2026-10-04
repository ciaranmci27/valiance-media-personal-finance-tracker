"use client";
import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CircleCheck, Info, Scale } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import {
  reportFilterSchema,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import { reportQuery } from "@/lib/accounting/preload";
import {
  balanceCompareLabel,
  balanceFilter,
  dateText,
  isEmptyBalance,
} from "@/lib/accounting/balance-sheet";
import {
  TRIAL_NOTES,
  TYPE_LABELS,
  TRIAL_TYPES,
  byType,
  sideLabel,
  trialChecks,
  trialLines,
  trialScope,
  trialTotals,
  typeWord,
  type TrialCheck,
  type TrialLine,
  type TypeTotal,
} from "@/lib/accounting/trial-balance";
import { demoReportData, demoReportDetail } from "@/lib/accounting/demo-reports";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingRead } from "./use-accounting-read";
import { useReportExport } from "./use-report-export";
import { todayInBooks } from "./format";
import { AsOfControls } from "./report-period-controls";
import { useFiscalStartMonth } from "./use-fiscal-year";
import { fiscalYearStart } from "@/lib/accounting/fiscal-year";
import {
  CardRow,
  CoverageDisclosure,
  ExportMenu,
  HealthLine,
  ReportSkeleton,
  ScopeNotice,
  ScrollList,
  SectionCard,
  Segmented,
  StatTile,
  readReportFilter,
  writeReportFilter,
  type Drill,
} from "./report-kit";

const ZERO = BigInt(0);

export function AccountingTrialBalance({
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
  const raw = readReportFilter(params.get("report_filter"), balanceFilter(today, "working"));
  // A trial balance is balances through a date: read from the start of the books.
  const filter = balanceFilter(raw.to, raw.mode, raw.compare_to);
  const signature = JSON.stringify(filter);
  const [detail, setDetail] = useState(true);
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);
  const exporter = useReportExport();
  const { isHidden } = usePrivacy();
  const fiscalStart = useFiscalStartMonth(demo);

  const live = !demo;
  const reportRead = useAccountingRead<ReportData>(reportQuery("trial-balance", filter), {
    enabled: live,
    keepPrevious: true,
  });
  const demoData = useMemo(
    () => (demo ? demoReportData(filter) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, signature],
  );
  const data = demo ? demoData : (reportRead.data ?? null);
  const loading = live && reportRead.loading;
  const updating = live && (reportRead.isPlaceholder || reportRead.revalidating);

  function apply(next: ReportFilter, replace = false) {
    setDrill(null);
    writeReportFilter(next, replace);
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
        title="Trial balance"
        subtitle="Every account's balance on one page: do the books balance, and what will your accountant ask about?"
        actions={
          <ExportMenu
            label="Export trial balance"
            disabled={!data || loading}
            exporting={exporter.exporting}
            demo={demo}
            onExport={(format) =>
              data &&
              void exporter.run(
                data,
                { report_id: "trial-balance", show_zero: false, details: detail, layout: 2 },
                format,
              )
            }
          />
        }
      />
      <AsOfControls
        filter={filter}
        fiscalMonth={fiscalStart}
        today={today}
        scope={`Income and expenses since ${dateText(fiscalYearStart(filter.to, fiscalStart))}`}
        updating={updating}
        onApply={apply}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {loading && !data ? (
        <ReportSkeleton label="Preparing trial balance" />
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", updating && "opacity-70")}
        >
          <ScopeNotice data={data} onReview={onReview} field="ending_cents" />
          {isEmptyBalance(data) ? (
            <Card className="flex flex-col items-center px-6 py-14 text-center">
              <Scale size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">Nothing on the books yet on this date</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a later date, or add the opening balances for your accounts.
              </p>
            </Card>
          ) : (
            <TrialReport
              data={data}
              fiscalStart={fiscalStart}
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

function TrialReport({
  data,
  fiscalStart,
  detail,
  setDetail,
  privacy,
  onDrill,
  onReload,
}: {
  data: ReportData;
  fiscalStart: number;
  detail: boolean;
  setDetail: (v: boolean) => void;
  privacy: boolean;
  onDrill: Drill;
  onReload: () => void;
}) {
  const lines = trialLines(data);
  const t = trialTotals(lines);
  const types = byType(lines);
  const checks = trialChecks(data, lines);
  const compared = balanceCompareLabel(data.filter, fiscalStart);
  const balanced = t.difference === ZERO;
  const uncategorized =
    data.filter.mode === "working"
      ? uncategorizedCents(data.accounts, (a) => a.purpose, (a) => a.ending_cents)
      : ZERO;
  const since = compared ? `since ${compared.short}` : null;
  const moneyChange = (now: bigint, then: bigint) =>
    since
      ? {
          text: now === then ? `No change ${since}` : `${now > then ? "+" : ""}${formatCents(now - then)} ${since}`,
          tone: "flat" as const,
        }
      : null;
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="Total debits"
          value={formatCents(t.debits)}
          context="Debit balances added up"
          change={moneyChange(t.debits, t.compareDebits)}
        />
        <StatTile
          label="Total credits"
          value={formatCents(t.credits)}
          context="Credit balances added up"
          change={moneyChange(t.credits, t.compareCredits)}
        />
        <StatTile
          label="Difference"
          value={balanced ? "Balanced" : formatCents(t.difference < ZERO ? -t.difference : t.difference)}
          tone={balanced ? "good" : "bad"}
          context={balanced ? "Debits equal credits" : "Debits and credits differ"}
        />
        <StatTile
          label="Accounts with a balance"
          value={String(t.accounts)}
          context={`On ${dateText(data.filter.to)}`}
          change={
            since
              ? {
                  text:
                    t.accounts === t.compareAccounts
                      ? `No change ${since}`
                      : `${t.accounts > t.compareAccounts ? "+" : ""}${t.accounts - t.compareAccounts} ${since}`,
                  tone: "flat",
                }
              : null
          }
        />
      </section>

      <CardRow>
        <ChecksCard checks={checks} privacy={privacy} onDrill={(line) => {
          const scope = trialScope(data, line, fiscalStart);
          if (scope) onDrill(line.name, scope);
        }} />
        <TypeCard types={types} debits={t.debits} credits={t.credits} />
      </CardRow>

      <SectionCard
        labelledBy="tb-statement"
        title="Trial balance"
        description={`Every account's balance on ${dateText(data.filter.to)}, by type. Select an account to see its transactions.`}
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
        <TrialTable
          data={data}
          fiscalStart={fiscalStart}
          lines={lines}
          types={types}
          detail={detail}
          comparing={!!compared}
          comparedLong={compared?.long ?? null}
          totals={t}
          onDrill={onDrill}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-5 py-3.5 lg:px-6">
          <HealthLine
            data={data}
            uncategorized={uncategorized}
            lead={[
              balanced
                ? { tone: "good", text: "Balanced: total debits equal total credits" }
                : {
                    tone: "warn",
                    text: (
                      <>
                        Out of balance by <MaskedValue value={formatCents(t.difference < ZERO ? -t.difference : t.difference)} />
                      </>
                    ),
                  },
            ]}
          />
          <span className="text-xs text-muted-foreground">Revision {data.revision}</span>
        </div>
      </SectionCard>

      <CoverageDisclosure data={data} notes={TRIAL_NOTES} onReload={onReload} />
    </>
  );
}

/** What an accountant would ask about, or a plain all-clear. */
function ChecksCard({
  checks,
  privacy,
  onDrill,
}: {
  checks: TrialCheck[];
  privacy: boolean;
  onDrill: (line: TrialLine) => void;
}) {
  const { showValue, hoverProps } = useMaskedHover();
  const hide = privacy && !showValue;
  const looks = checks.filter((c) => c.tone === "look").length;
  return (
    <SectionCard
      labelledBy="tb-checks"
      title="Worth a look"
      description={
        checks.length === 0
          ? "Nothing stands out. Every account sits on its usual side and nothing is waiting for a category."
          : looks
            ? `${looks} ${looks === 1 ? "thing" : "things"} your accountant may ask about${checks.length > looks ? `, and ${checks.length - looks} to know` : ""}.`
            : `Nothing looks wrong; ${checks.length === 1 ? "one thing" : `${checks.length} things`} to know.`
      }
    >
      <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6" {...hoverProps}>
        {checks.length === 0 ? (
          <p className="flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 px-3 py-2.5 text-sm">
            <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
            Ready to hand over: the books balance and nothing is unusual.
          </p>
        ) : (
          <ScrollList label="Things worth a look" className="-mx-2.5">
            <ul className="space-y-0.5">
              {checks.map((c) => {
                const body = (
                  <>
                    {c.tone === "look" ? (
                      <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
                    ) : (
                      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{hide ? "Hover to reveal" : c.title}</span>
                      <span className="block text-xs leading-relaxed text-muted-foreground">{c.detail}</span>
                    </span>
                  </>
                );
                const layout = "flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left";
                return (
                  <li key={c.key}>
                    {c.line?.account ? (
                      <button
                        type="button"
                        onClick={() => onDrill(c.line!)}
                        className={cn(
                          layout,
                          "transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
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
        )}
      </div>
    </SectionCard>
  );
}

/** Debits and credits per account type, with the totals at the foot. */
function TypeCard({
  types,
  debits,
  credits,
}: {
  types: TypeTotal[];
  debits: bigint;
  credits: bigint;
}) {
  const { hoverProps } = useMaskedHover();
  return (
    <SectionCard labelledBy="tb-types" title="By type" description="Debits and credits for each kind of account.">
      <div className="flex flex-1 flex-col px-5 pb-3 lg:px-6" {...hoverProps}>
        <table className="w-full text-sm">
          <caption className="sr-only">Debits and credits by account type</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="py-2 text-left font-medium">Type</th>
              <th scope="col" className="py-2 text-right font-medium">Debit</th>
              <th scope="col" className="py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-y border-border">
            {types.map((r) => (
              <tr key={r.type}>
                <th scope="row" className="py-2.5 text-left font-normal">
                  {r.label}
                  <span className="ml-1.5 text-xs text-muted-foreground">{r.count}</span>
                </th>
                <td className="py-2.5 text-right tabular-nums">
                  {r.debit > ZERO ? <MaskedValue value={formatCents(r.debit)} inheritHover /> : <span className="text-muted-foreground">-</span>}
                </td>
                <td className="py-2.5 text-right tabular-nums">
                  {r.credit > ZERO ? <MaskedValue value={formatCents(r.credit)} inheritHover /> : <span className="text-muted-foreground">-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-6 border-t border-border px-5 py-3.5 text-sm font-semibold lg:px-6">
        <span>Total</span>
        <span className="text-right tabular-nums"><MaskedValue value={formatCents(debits)} /></span>
        <span className="text-right tabular-nums"><MaskedValue value={formatCents(credits)} /></span>
      </div>
    </SectionCard>
  );
}

/**
 * The full list, grouped by type with subtotals: account number, account,
 * debit, credit, and the comparison balance and change when comparing.
 * Phones get one row per account with its balance and side.
 */
function TrialTable({
  data,
  fiscalStart,
  lines,
  types,
  detail,
  comparing,
  comparedLong,
  totals,
  onDrill,
}: {
  data: ReportData;
  fiscalStart: number;
  lines: TrialLine[];
  types: TypeTotal[];
  detail: boolean;
  comparing: boolean;
  comparedLong: string | null;
  totals: ReturnType<typeof trialTotals>;
  onDrill: Drill;
}) {
  const hasCodes = lines.some((l) => l.code);
  const amount = (v: bigint) =>
    v > ZERO ? <MaskedValue value={formatCents(v)} className="whitespace-nowrap tabular-nums" /> : null;
  const name = (l: TrialLine) => {
    const scope = trialScope(data, l, fiscalStart);
    return scope ? (
      <button
        type="button"
        onClick={() => onDrill(l.name, scope)}
        className="rounded-sm text-left hover:text-teal-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {l.name}
        <span className="sr-only">, show transactions</span>
      </button>
    ) : (
      <span>
        {l.name}
        <span className="block text-xs text-muted-foreground">Computed from earlier years&apos; income and expenses</span>
      </span>
    );
  };
  const groups = TRIAL_TYPES.map((type) => ({
    type,
    rows: lines.filter((l) => l.type === type),
    total: types.find((t) => t.type === type),
  })).filter((g) => g.rows.length);
  const compareTotal = (rows: TrialLine[]) => rows.reduce((s, l) => s + l.compare, ZERO);
  const cols = (hasCodes ? 1 : 0) + 3 + (comparing ? 2 : 0);
  return (
    <>
      <div className="hidden overflow-x-auto border-t border-border md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Trial balance on {dateText(data.filter.to)}</caption>
          <thead>
            <tr className="bg-[rgba(var(--ink),0.03)] text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {hasCodes && <th scope="col" className="w-20 px-4 py-2.5 text-left font-medium lg:pl-6">No.</th>}
              <th scope="col" className={cn("px-4 py-2.5 text-left font-medium", !hasCodes && "lg:pl-6")}>Account</th>
              <th scope="col" className="w-32 px-4 py-2.5 text-right font-medium">Debit</th>
              <th scope="col" className={cn("w-32 px-4 py-2.5 text-right font-medium", !comparing && "lg:pr-6")}>Credit</th>
              {comparing && (
                <>
                  <th scope="col" className="w-36 px-4 py-2.5 text-right font-medium" title={comparedLong ?? undefined}>Comparison</th>
                  <th scope="col" className="w-36 px-4 py-2.5 text-right font-medium lg:pr-6">Change</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.type}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={cols}
                    className="px-4 pt-4 pb-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-teal-light lg:px-6"
                  >
                    {TYPE_LABELS[g.type]}
                  </th>
                </tr>
                {detail &&
                  g.rows.map((l) => (
                    <tr key={l.id} className="border-b border-border/60">
                      {hasCodes && <td className="px-4 py-2 text-xs text-muted-foreground tabular-nums lg:pl-6">{l.code}</td>}
                      <td className={cn("px-4 py-2", !hasCodes && "lg:pl-6")}>{name(l)}</td>
                      <td className="px-4 py-2 text-right">{amount(l.debit)}</td>
                      <td className={cn("px-4 py-2 text-right", !comparing && "lg:pr-6")}>{amount(l.credit)}</td>
                      {comparing && (
                        <>
                          <td className="px-4 py-2 text-right text-muted-foreground">
                            <MaskedValue value={sideLabel(l.compare)} className="whitespace-nowrap tabular-nums" />
                          </td>
                          <td className="px-4 py-2 text-right text-muted-foreground lg:pr-6">
                            <MaskedValue value={l.balance === l.compare ? "No change" : sideLabel(l.balance - l.compare)} className="whitespace-nowrap tabular-nums" />
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                <tr className="border-b border-border font-semibold">
                  {hasCodes && <td className="lg:pl-6" />}
                  <td className={cn("px-4 py-2.5", !hasCodes && "lg:pl-6")}>Total {TYPE_LABELS[g.type].toLowerCase()}</td>
                  <td className="px-4 py-2.5 text-right">{amount(g.total?.debit ?? ZERO)}</td>
                  <td className={cn("px-4 py-2.5 text-right", !comparing && "lg:pr-6")}>{amount(g.total?.credit ?? ZERO)}</td>
                  {comparing && (
                    <>
                      <td className="px-4 py-2.5 text-right">
                        <MaskedValue value={sideLabel(compareTotal(g.rows))} className="whitespace-nowrap tabular-nums" />
                      </td>
                      <td className="px-4 py-2.5 text-right lg:pr-6">
                        <MaskedValue
                          value={sideLabel(g.rows.reduce((s, l) => s + l.balance, ZERO) - compareTotal(g.rows))}
                          className="whitespace-nowrap tabular-nums"
                        />
                      </td>
                    </>
                  )}
                </tr>
              </Fragment>
            ))}
            <tr className="bg-teal/[0.11] text-base font-semibold">
              {hasCodes && <td className="lg:pl-6" />}
              <td className={cn("px-4 py-3", !hasCodes && "lg:pl-6")}>Total</td>
              <td className="px-4 py-3 text-right">{amount(totals.debits)}</td>
              <td className={cn("px-4 py-3 text-right", !comparing && "lg:pr-6")}>{amount(totals.credits)}</td>
              {comparing && (
                <>
                  <td className="px-4 py-3 text-right text-sm">
                    {totals.compareDebits === totals.compareCredits ? (
                      "Balanced"
                    ) : (
                      <MaskedValue
                        value={`Off by ${formatCents(totals.compareDebits - totals.compareCredits)}`}
                        className="whitespace-nowrap tabular-nums"
                      />
                    )}
                  </td>
                  <td className="lg:pr-6" />
                </>
              )}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="border-t border-border md:hidden">
        {groups.map((g) => (
          <div key={g.type} className="border-b border-border">
            <p className="px-5 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-teal-light">
              {TYPE_LABELS[g.type]}
            </p>
            {detail && (
              <ul>
                {g.rows.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-4 px-5 py-2.5 text-sm">
                    <span className="min-w-0">
                      {name(l)}
                      <span className="block text-xs text-muted-foreground">
                        {[l.code, typeWord(l.type)].filter(Boolean).join(", ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-right tabular-nums">
                      <MaskedValue value={sideLabel(l.balance)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="flex justify-between gap-4 px-5 py-2.5 text-sm font-semibold">
              <span>Total {TYPE_LABELS[g.type].toLowerCase()}</span>
              <span className="text-right tabular-nums">
                <MaskedValue value={sideLabel((g.total?.debit ?? ZERO) - (g.total?.credit ?? ZERO))} />
              </span>
            </p>
          </div>
        ))}
        <dl className="grid grid-cols-2 gap-2 bg-teal/[0.11] px-5 py-3 text-sm font-semibold">
          <dt>Total debits</dt>
          <dd className="text-right tabular-nums"><MaskedValue value={formatCents(totals.debits)} /></dd>
          <dt>Total credits</dt>
          <dd className="text-right tabular-nums"><MaskedValue value={formatCents(totals.credits)} /></dd>
        </dl>
      </div>
    </>
  );
}
