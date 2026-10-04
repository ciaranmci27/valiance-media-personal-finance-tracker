"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, CheckCircle2, Landmark } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MaskedValue } from "@/components/ui/masked-value";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { reportFilterSchema, type ReportFilter } from "@/lib/accounting/reports";
import { supportReportFilterSchema, type SupportReportData } from "@/lib/accounting/support-reports";
import type { RegisterDetail, RegisterView } from "@/lib/accounting/registers";
import { BOOKS_START } from "@/lib/accounting/balance-sheet";
import { demoLoanDetail, demoLoanRegisters, demoParties, demoReportDetail } from "@/lib/accounting/demo-reports";
import { accountingHref } from "@/lib/accounting/views";
import {
  LOAN_NOTES,
  loanHistory,
  loanLines,
  loanScope,
  loanSentence,
  loanTies,
  loanTotals,
  loanYears,
  type LoanLine,
  type LoanYear,
} from "@/lib/accounting/loan-balances";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingCache } from "./accounting-cache";
import { useAccountingRead } from "./use-accounting-read";
import { dateLabel, todayInBooks } from "./format";
import type { BooksMetadata } from "./types";
import { CardRow, CardTotal, ExportMenu, ReportSkeleton, ScrollList, SectionCard, StatTile } from "./report-kit";
import { CheckList, SupportNotes, YearControls, useSupportExport, useSupportReport } from "./support-report-kit";

const ZERO = BigInt(0);
const registerHref = (id: string) => accountingHref("manage", "registers", { kind: "loan", register: id });

/** Each loan's detail (its posted movements) as of the date, through the shared cache. Null until all are read. */
function useLoanDetails(ids: string[], date: string, demo: boolean): Map<string, RegisterDetail> | null {
  const cache = useAccountingCache();
  const key = `${ids.join(",")}@${date}`;
  const [state, setState] = useState<{ key: string; map: Map<string, RegisterDetail> } | null>(null);
  useEffect(() => {
    if (demo) {
      setState({ key, map: new Map(ids.map((id) => [id, demoLoanDetail(id, date)])) });
      return;
    }
    const controller = new AbortController();
    void Promise.all(
      ids.map((id) => cache.read<RegisterDetail>({ view: "register-detail", id, date }, controller.signal)),
    )
      .then((list) => {
        if (!controller.signal.aborted) setState({ key, map: new Map(list.map((d, i) => [ids[i], d])) });
      })
      .catch(() => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, demo]);
  return state?.key === key ? state.map : null;
}

/**
 * Loan balances: what is owed on each loan, how much has been paid down,
 * how much of the payments was interest, and whether the register agrees
 * with the books. As of today in the current year, else the year's end.
 */
export function AccountingLoanBalances({
  manage,
  onBack,
  onEntry,
  demo = false,
}: {
  manage: BooksMetadata;
  onBack: () => void;
  onEntry: (id: string) => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  const years = loanYears(today);
  const saved = (() => {
    try {
      const parsed = supportReportFilterSchema.safeParse(JSON.parse(params.get("support_filter") ?? "{}"));
      return parsed.success ? Number(parsed.data.to.slice(0, 4)) : null;
    } catch {
      return null;
    }
  })();
  const year = saved && years.includes(saved) ? saved : years[0];
  const scope = loanScope(year, today);
  const read = useSupportReport(scope, demo);
  const registersRead = useAccountingRead<RegisterView>(
    { view: "registers", kind: "loan", date: scope.to },
    { enabled: !demo, keepPrevious: true },
  );
  const demoView = useMemo(() => (demo ? demoLoanRegisters(scope.to) : null), [demo, scope.to]);
  const registers = demo ? demoView : (registersRead.data ?? null);
  const data = read.data;
  const ids = (data?.rows ?? []).map((r) => r.register_id ?? r.id);
  const details = useLoanDetails(ids, scope.to, demo);
  const owners = (demo ? demoParties : manage.parties)
    .filter((p) => (p.roles ?? []).includes("owner"))
    .map((p) => p.name);
  const exporter = useSupportExport();
  const { isHidden } = usePrivacy();
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);

  function chooseYear(next: number) {
    setDrill(null);
    const url = new URL(window.location.href);
    url.searchParams.set("support_filter", JSON.stringify(loanScope(next, today)));
    window.history.pushState(null, "", url);
  }
  function openAccount(id: string, name: string) {
    const parsed = reportFilterSchema.safeParse({ from: BOOKS_START, to: scope.to, mode: "posted", account_ids: [id], offset: 0 });
    if (parsed.success) setDrill({ title: name, filter: parsed.data });
  }

  const errorMessage = exporter.error || (!data && read.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Loan balances"
        subtitle="What you owe on each loan, what you have paid down, and whether the register agrees."
        actions={
          <ExportMenu
            label="Export the loan register"
            disabled={!data || read.loading}
            exporting={exporter.exporting}
            demo={demo}
            pdfDescription="Branded register with the ties"
            csvDescription="One row per loan, with the ties"
            onExport={(format) => data && void exporter.run(data, format)}
          />
        }
      />
      <YearControls
        years={years}
        year={year}
        from={scope.to}
        to={scope.to}
        scope="Loans as of this date"
        updating={read.updating}
        onYear={chooseYear}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {read.loading && !data ? (
        <ReportSkeleton label="Preparing the loan register" />
      ) : data ? (
        <div
          aria-busy={read.updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", read.updating && "opacity-70")}
        >
          <Loans
            data={data}
            lines={loanLines(data, registers, details, owners)}
            history={details ? loanHistory([...details.values()], scope.to) : null}
            privacy={isHidden}
            onAccount={openAccount}
            onReload={() => {
              read.reload();
              void registersRead.reload();
            }}
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

function Loans({
  data,
  lines,
  history,
  privacy,
  onAccount,
  onReload,
}: {
  data: SupportReportData;
  lines: LoanLine[];
  history: LoanYear[] | null;
  privacy: boolean;
  onAccount: (id: string, name: string) => void;
  onReload: () => void;
}) {
  const t = loanTotals(lines, data);
  const year = Number(data.filter.to.slice(0, 4));
  if (!lines.length)
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <Landmark size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No loans in the register</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Record a loan in Manage, Registers, and its balance and payments appear here.
        </p>
      </Card>
    );
  const soFar = data.filter.to.endsWith("-12-31") ? `In ${year}` : `${year} so far`;
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile label="Owed now" value={formatCents(t.owed)} context="Principal still owed" />
        <StatTile
          label="Paid down"
          value={t.repaidThisYear === null ? "-" : formatCents(t.repaidThisYear)}
          context={t.repaidThisYear === null ? "Reading the payments" : soFar}
        />
        <StatTile
          label="Interest paid"
          value={t.interestThisYear === null ? "-" : formatCents(t.interestThisYear)}
          context={t.interestThisYear === null ? "Reading the payments" : soFar}
        />
        <StatTile label="Loans" value={String(t.count)} context={t.open === t.count ? "All with a balance" : `${t.open} with a balance`} />
      </section>

      <CardRow>
        <EachLoanCard lines={lines} t={t} privacy={privacy} asOf={dateLabel(data.filter.to)} />
        <TiesCard data={data} onAccount={onAccount} />
      </CardRow>

      {history && history.length > 0 && <HistoryCard history={history} />}

      <Statement data={data} lines={lines} t={t} year={year} />

      <SupportNotes data={data} notes={LOAN_NOTES} onReload={onReload} />
    </>
  );
}

/** Each loan: what is owed against what was borrowed, and how much is paid down. */
function EachLoanCard({
  lines,
  t,
  privacy,
  asOf,
}: {
  lines: LoanLine[];
  t: ReturnType<typeof loanTotals>;
  privacy: boolean;
  asOf: string;
}) {
  return (
    <SectionCard
      labelledBy="lb-each"
      title="Each loan"
      description={privacy ? "Each loan, what is owed and how much is paid down." : loanSentence(t, asOf)}
    >
      <ScrollList label="Loans" className="mx-2.5 mb-3 lg:mx-3.5">
        <ul className="space-y-1">
          {lines.map((l) => (
            <li key={l.id}>
              <a
                href={registerHref(l.id)}
                className="block rounded-lg px-2.5 py-2.5 transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium" title={l.name}>
                      {l.name}
                    </span>
                    {l.shareholder && (
                      <Badge size="sm" variant="info" className="shrink-0">
                        From the owner
                      </Badge>
                    )}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">
                    <MaskedValue value={formatCents(l.balance)} />
                  </span>
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {[l.lender || null, `since ${dateLabel(l.started)}`].filter(Boolean).join(", ")}
                  </span>
                  {l.original > ZERO && (
                    <span className="shrink-0 tabular-nums">
                      of <MaskedValue value={formatCents(l.original)} />
                    </span>
                  )}
                </span>
                {l.repaid !== null && (
                  <span className="mt-2 flex items-center gap-2">
                    <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(var(--ink),0.08)]">
                      <span className="block h-full rounded-full bg-teal" style={{ width: `${Math.min(100, l.paidShare)}%` }} />
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {l.balance === ZERO ? "Paid off" : privacy ? "Paid down" : `${l.paidShare.toFixed(0)}% paid down`}
                    </span>
                  </span>
                )}
                <span className="sr-only">, open in Registers</span>
              </a>
            </li>
          ))}
        </ul>
      </ScrollList>
      <CardTotal label="Owed now" amount={t.owed} />
    </SectionCard>
  );
}

/** The register against the loan accounts. */
function TiesCard({ data, onAccount }: { data: SupportReportData; onAccount: (id: string, name: string) => void }) {
  const { isHidden } = usePrivacy();
  const mask = (s: string) => (isHidden ? s.replace(/-?\$[\d,]+\.\d\d/g, "•••••") : s);
  const ties = loanTies(data);
  const good = ties.filter((x) => x.tone === "good");
  const off = ties.filter((x) => x.tone === "look");
  const linkClass =
    "inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
  return (
    <SectionCard
      labelledBy="lb-ties"
      title="Ties to the books"
      description={
        !ties.length
          ? "No loan accounts to compare yet."
          : off.length
            ? "The register and the balance sheet differ. Each difference is below."
            : "The register agrees with the balance sheet."
      }
    >
      <div className="flex flex-1 flex-col gap-3 px-5 pb-5 lg:px-6 lg:pb-6">
        {good.length > 0 && (
          <ul className="space-y-1.5">
            {good.map((x) => (
              <li key={x.key}>
                <button
                  type="button"
                  onClick={() => onAccount(x.accountId, x.account)}
                  className="flex w-full items-start gap-2 rounded-md text-left text-sm hover:bg-[rgba(var(--ink),0.04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
                  <span className="min-w-0">
                    <span className="block font-medium">{x.title}</span>
                    <span className="block text-xs text-muted-foreground">{mask(x.detail)}</span>
                  </span>
                  <span className="sr-only">, show the account&apos;s entries</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {off.length > 0 && (
          <CheckList
            empty=""
            items={off.map((x) => ({
              key: x.key,
              tone: "look",
              title: mask(x.title),
              detail: mask(x.detail),
              action: (
                <button type="button" className={linkClass} onClick={() => onAccount(x.accountId, x.account)}>
                  See {x.account}&apos;s entries
                  <ArrowUpRight size={12} aria-hidden="true" />
                </button>
              ),
            }))}
          />
        )}
        <a href={accountingHref("manage", "registers", { kind: "loan" })} className={cn(linkClass, "mt-auto self-start pt-2")}>
          Open the registers in Manage
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      </div>
    </SectionCard>
  );
}

/** Principal borrowed and repaid each year, interest recorded, and what was owed at each year end. */
function HistoryCard({ history }: { history: LoanYear[] }) {
  const most = history.reduce((m, h) => (h.owed > m ? h.owed : m), ZERO) || BigInt(1);
  return (
    <SectionCard
      labelledBy="lb-history"
      title="Principal by year"
      description="What was borrowed and repaid each year, the interest recorded on the payments, and what was owed at the year's end. Posted figures only."
    >
      <div className="@container border-t border-border px-5 pb-4 lg:px-6">
        <div
          aria-hidden="true"
          className="hidden grid-cols-[3.5rem_minmax(0,1fr)_7rem_7rem_7rem_8rem] gap-x-3 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid"
        >
          <span>Year</span>
          <span>Owed at year end</span>
          <span className="text-right">Borrowed</span>
          <span className="text-right">Repaid</span>
          <span className="text-right">Interest</span>
          <span className="text-right">Owed</span>
        </div>
        <ul>
          {history.map((h) => (
            <li
              key={h.year}
              className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-border py-2 text-sm first:border-t-0 @2xl:grid-cols-[3.5rem_minmax(0,1fr)_7rem_7rem_7rem_8rem]"
            >
              <span className="font-medium tabular-nums">{h.year}</span>
              <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]">
                <span
                  className="block h-full rounded-full bg-teal"
                  style={{ width: `${Math.max(h.owed > ZERO ? 1 : 0, Number((h.owed * BigInt(1000)) / most) / 10)}%` }}
                />
              </span>
              {(
                [
                  ["Borrowed", h.borrowed],
                  ["Repaid", h.repaid],
                  ["Interest", h.interest],
                ] as const
              ).map(([label, v]) => (
                <span
                  key={label}
                  className="col-span-3 flex justify-between text-xs text-muted-foreground tabular-nums @2xl:col-span-1 @2xl:block @2xl:text-right @2xl:text-sm"
                >
                  <span className="@2xl:hidden">{label}</span>
                  <MaskedValue value={formatCents(v)} />
                </span>
              ))}
              <span className="col-start-3 row-start-1 text-right tabular-nums @2xl:col-start-auto @2xl:row-start-auto">
                <MaskedValue value={formatCents(h.owed)} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}

/** Every loan by account: what was first borrowed, repaid to date, owed, and this year's interest. */
function Statement({
  data,
  lines,
  t,
  year,
}: {
  data: SupportReportData;
  lines: LoanLine[];
  t: ReturnType<typeof loanTotals>;
  year: number;
}) {
  const names = new Map((data.controls?.rows ?? []).map((r) => [r.account_id, r.name]));
  const groups = new Map<string, LoanLine[]>();
  for (const l of lines) {
    const key = (l.accountId && names.get(l.accountId)) || "Loans";
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const grid =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 @2xl:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_7.5rem_7.5rem]";
  return (
    <SectionCard
      labelledBy="lb-statement"
      title="Register"
      description="Each loan under its account. Select one to open it in Registers, with its payments."
    >
      <div className="@container border-t border-border">
        <div
          aria-hidden="true"
          className={cn(grid, "hidden px-5 pt-3 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid lg:px-6")}
        >
          <span>Loan</span>
          <span className="text-right">Borrowed</span>
          <span className="text-right">Repaid</span>
          <span className="text-right">Owed</span>
          <span className="text-right">{year} interest</span>
        </div>
        {[...groups.entries()].map(([group, list]) => (
          <div key={group} className="px-2.5 pb-2 lg:px-3.5">
            <p className="px-2.5 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.12em] text-teal-light">{group}</p>
            <ul className="space-y-0.5">
              {list.map((l) => (
                <li key={l.id}>
                  <a
                    href={registerHref(l.id)}
                    className={cn(
                      grid,
                      "w-full items-baseline rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate" title={l.name}>
                        {l.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[l.lender || null, `since ${dateLabel(l.started)}`, l.shareholder ? "from the owner" : null]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </span>
                    <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                      {l.original > ZERO ? <MaskedValue value={formatCents(l.original)} /> : ""}
                    </span>
                    <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                      {l.repaid === null ? "" : <MaskedValue value={formatCents(l.repaid)} />}
                    </span>
                    <span className="text-right tabular-nums">
                      <MaskedValue value={formatCents(l.balance)} />
                    </span>
                    <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                      {l.interestThisYear === null ? "" : <MaskedValue value={formatCents(l.interestThisYear)} />}
                    </span>
                    <span className="sr-only">, open in Registers</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-border px-5 py-3.5 text-sm lg:px-6">
        <span className="text-muted-foreground">Paid down in {year}</span>
        <span className="text-right tabular-nums">
          {t.repaidThisYear === null ? "-" : <MaskedValue value={formatCents(t.repaidThisYear)} />}
        </span>
        <span className="font-semibold">Owed now</span>
        <span className="text-right font-semibold tabular-nums">
          <MaskedValue value={formatCents(t.owed)} />
        </span>
      </div>
    </SectionCard>
  );
}
