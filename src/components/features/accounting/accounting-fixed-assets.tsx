"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, CheckCircle2, Monitor } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MaskedValue } from "@/components/ui/masked-value";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { reportFilterSchema, type ReportFilter } from "@/lib/accounting/reports";
import { supportReportFilterSchema, type SupportReportData } from "@/lib/accounting/support-reports";
import type { RegisterView } from "@/lib/accounting/registers";
import { BOOKS_START } from "@/lib/accounting/balance-sheet";
import { demoRegisters, demoReportDetail, demoSupportReport } from "@/lib/accounting/demo-reports";
import { accountingHref } from "@/lib/accounting/views";
import {
  ASSET_NOTES,
  assetHistory,
  assetLines,
  assetScope,
  assetTies,
  assetTotals,
  assetYears,
  priorScope,
  type AssetLine,
  type AssetYear,
} from "@/lib/accounting/fixed-assets";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { useAccountingCache } from "./accounting-cache";
import { useAccountingRead } from "./use-accounting-read";
import { dateLabel, todayInBooks } from "./format";
import { CardRow, CardTotal, ExportMenu, ReportSkeleton, ScrollList, SectionCard, StatTile } from "./report-kit";
import {
  CheckList,
  SupportNotes,
  YearControls,
  supportQuery,
  useSupportExport,
  useSupportReport,
} from "./support-report-kit";

const ZERO = BigInt(0);
/** Years of history the depreciation card reads at most. */
const HISTORY_YEARS = 6;

const registerHref = (id: string) => accountingHref("manage", "registers", { kind: "asset", register: id });

/**
 * The register at each year end from the first asset's year to the year
 * before the one shown, read through the shared cache (the demo reads its
 * synthetic books). Null until every year is read.
 */
function useYearEnds(years: number[], demo: boolean): { year: number; data: SupportReportData }[] | null {
  const cache = useAccountingCache();
  const key = years.join(",");
  const [state, setState] = useState<{ key: string; ends: { year: number; data: SupportReportData }[] } | null>(null);
  useEffect(() => {
    const scopes = years.map((y) => ({ report_id: "asset-register" as const, from: `${y}-12-31`, to: `${y}-12-31`, offset: 0 }));
    if (demo) {
      setState({ key, ends: scopes.map((s, i) => ({ year: years[i], data: demoSupportReport(s) })) });
      return;
    }
    const controller = new AbortController();
    void Promise.all(scopes.map((s) => cache.read<SupportReportData>(supportQuery(s), controller.signal)))
      .then((list) => {
        if (!controller.signal.aborted) setState({ key, ends: list.map((data, i) => ({ year: years[i], data })) });
      })
      .catch(() => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, demo]);
  return state?.key === key ? state.ends : null;
}

/**
 * Fixed assets: what the business owns, what it is worth on the books, how
 * much depreciation is this year's, and whether the register agrees with
 * the balance sheet. As of a date: today in the current year, else the
 * year's end.
 */
export function AccountingFixedAssets({
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
  const years = assetYears(today);
  const saved = (() => {
    try {
      const parsed = supportReportFilterSchema.safeParse(JSON.parse(params.get("support_filter") ?? "{}"));
      return parsed.success ? Number(parsed.data.to.slice(0, 4)) : null;
    } catch {
      return null;
    }
  })();
  const year = saved && years.includes(saved) ? saved : years[0];
  const scope = assetScope(year, today);
  const read = useSupportReport(scope, demo);
  const priorRead = useSupportReport(priorScope(scope), demo);
  const registersRead = useAccountingRead<RegisterView>(
    { view: "registers", kind: "asset", date: scope.to },
    { enabled: !demo, keepPrevious: true },
  );
  const demoRegisterView = useMemo(() => (demo ? demoRegisters(scope.to) : null), [demo, scope.to]);
  const registers = demo ? demoRegisterView : (registersRead.data ?? null);
  const data = read.data;
  // Depreciation by year: the register at each earlier year end.
  const first = data?.rows.length ? Math.min(...data.rows.map((r) => Number(r.cells[1].slice(0, 4)))) : null;
  const historyYears = first === null ? [] : Array.from({ length: Math.max(0, year - first) }, (_, i) => first + i).slice(-HISTORY_YEARS);
  const ends = useYearEnds(historyYears, demo);
  const exporter = useSupportExport();
  const { isHidden } = usePrivacy();
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);

  function chooseYear(next: number) {
    setDrill(null);
    const url = new URL(window.location.href);
    url.searchParams.set("support_filter", JSON.stringify(assetScope(next, today)));
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
        title="Fixed assets"
        subtitle="What the business owns, what it is worth on the books, and whether the register agrees."
        actions={
          <ExportMenu
            label="Export the fixed asset register"
            disabled={!data || read.loading}
            exporting={exporter.exporting}
            demo={demo}
            pdfDescription="Branded register with the ties"
            csvDescription="One row per asset, with the ties"
            onExport={(format) => data && void exporter.run(data, format)}
          />
        }
      />
      <YearControls
        years={years}
        year={year}
        from={scope.to}
        to={scope.to}
        scope="Fixed assets as of this date"
        updating={read.updating}
        onYear={chooseYear}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {read.loading && !data ? (
        <ReportSkeleton label="Preparing the fixed asset register" />
      ) : data ? (
        <div
          aria-busy={read.updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", read.updating && "opacity-70")}
        >
          <Register
            data={data}
            prior={priorRead.data}
            registers={registers}
            history={ends ? assetHistory([...ends, { year, data }]) : null}
            privacy={isHidden}
            onAccount={openAccount}
            onReload={() => {
              read.reload();
              priorRead.reload();
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

function Register({
  data,
  prior,
  registers,
  history,
  privacy,
  onAccount,
  onReload,
}: {
  data: SupportReportData;
  prior: SupportReportData | null;
  registers: RegisterView | null;
  history: AssetYear[] | null;
  privacy: boolean;
  onAccount: (id: string, name: string) => void;
  onReload: () => void;
}) {
  const lines = assetLines(data, prior, registers);
  const t = assetTotals(lines, data);
  const year = Number(data.filter.to.slice(0, 4));
  if (!lines.length)
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <Monitor size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No assets in the register</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Record equipment you buy in Manage, Registers, and it appears here with its depreciation.
        </p>
      </Card>
    );
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile label="Cost" value={formatCents(t.cost)} context={`${t.count} ${t.count === 1 ? "asset" : "assets"}`} />
        <StatTile label="Depreciated to date" value={formatCents(t.accumulated)} context="Posted to the books" />
        <StatTile label="Book value" value={formatCents(t.book)} context="Cost less depreciation" />
        <StatTile
          label={`${year} depreciation`}
          value={t.thisYear === null ? "-" : formatCents(t.thisYear)}
          context={t.thisYear === null ? "Reading last year" : data.filter.to.endsWith("-12-31") ? "For the year" : "So far this year"}
        />
      </section>

      <CardRow>
        <OwnCard lines={lines} t={t} privacy={privacy} />
        <TiesCard data={data} onAccount={onAccount} />
      </CardRow>

      {history && history.length > 1 && <HistoryCard history={history} />}

      <Statement data={data} lines={lines} t={t} />

      <SupportNotes data={data} notes={ASSET_NOTES} onReload={onReload} />
    </>
  );
}

/** Each asset: cost, book value and how much is used up. */
function OwnCard({ lines, t, privacy }: { lines: AssetLine[]; t: ReturnType<typeof assetTotals>; privacy: boolean }) {
  return (
    <SectionCard
      labelledBy="fa-own"
      title="What you own"
      description={
        privacy
          ? "Each asset, its book value and how much is used up."
          : `${t.count} ${t.count === 1 ? "asset" : "assets"}, ${Math.round(t.cost > ZERO ? Number((t.accumulated * BigInt(100)) / t.cost) : 0)}% depreciated overall.`
      }
    >
      <ScrollList label="Assets" className="mx-2.5 mb-3 lg:mx-3.5">
        <ul className="space-y-1">
          {lines.map((l) => (
            <li key={l.id}>
              <a
                href={registerHref(l.id)}
                className="block rounded-lg px-2.5 py-2.5 transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium" title={l.name}>
                    {l.name}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">
                    <MaskedValue value={formatCents(l.book)} />
                  </span>
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {l.disposed ? "Sold or written off" : `In service ${dateLabel(l.inService ?? l.acquired)}`}
                    {l.method ? `, ${l.method}` : ""}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    of <MaskedValue value={formatCents(l.cost)} />
                  </span>
                </span>
                {!l.disposed && (
                  <span className="mt-2 flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(var(--ink),0.08)]"
                    >
                      <span className="block h-full rounded-full bg-copper-strong" style={{ width: `${Math.min(100, l.used)}%` }} />
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {privacy ? "Used up" : `${l.used.toFixed(0)}% used up`}
                    </span>
                  </span>
                )}
                <span className="sr-only">, open in Registers</span>
              </a>
            </li>
          ))}
        </ul>
      </ScrollList>
      <CardTotal label="Book value" amount={t.book} />
    </SectionCard>
  );
}

/** The register against the fixed asset and accumulated depreciation accounts. */
function TiesCard({ data, onAccount }: { data: SupportReportData; onAccount: (id: string, name: string) => void }) {
  const { isHidden } = usePrivacy();
  const mask = (s: string) => (isHidden ? s.replace(/-?\$[\d,]+\.\d\d/g, "•••••") : s);
  const ties = assetTies(data);
  const good = ties.filter((x) => x.tone === "good");
  const off = ties.filter((x) => x.tone === "look");
  const linkClass =
    "inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
  return (
    <SectionCard
      labelledBy="fa-ties"
      title="Ties to the books"
      description={
        !ties.length
          ? "No fixed asset accounts to compare yet."
          : off.length
            ? "The register and the balance sheet differ. Each difference is below."
            : "The register agrees with the balance sheet."
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
                  <span className="block text-xs text-muted-foreground">{mask(x.detail)}</span>
                </span>
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
        <a href={accountingHref("manage", "registers", { kind: "asset" })} className={cn(linkClass, "mt-auto self-start pt-2")}>
          Open the registers in Manage
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      </div>
    </SectionCard>
  );
}

/** Depreciation posted each year and the book value at each year end. Posted figures only. */
function HistoryCard({ history }: { history: AssetYear[] }) {
  const most = history.reduce((m, h) => (h.depreciation > m ? h.depreciation : m), ZERO) || BigInt(1);
  return (
    <SectionCard
      labelledBy="fa-history"
      title="Depreciation by year"
      description="What was posted each year, and the book value left at the year's end. Past figures only; the books keep no future schedule."
    >
      <ul className="@container space-y-1 border-t border-border px-5 py-3 lg:px-6">
        {history.map((h) => (
          <li
            key={h.year}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-1.5 text-sm @xl:grid-cols-[3.5rem_minmax(0,1fr)_8rem_9rem]"
          >
            <span className="font-medium tabular-nums">{h.year}</span>
            <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]">
              <span
                className="block h-full rounded-full bg-copper-strong"
                style={{ width: `${Math.max(1, Number((h.depreciation * BigInt(1000)) / most) / 10)}%` }}
              />
            </span>
            <span className="text-right tabular-nums">
              <MaskedValue value={formatCents(h.depreciation)} />
            </span>
            <span className="col-span-3 text-right text-xs text-muted-foreground tabular-nums @xl:col-span-1">
              Book value <MaskedValue value={formatCents(h.book)} />
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** Every asset by account: cost, depreciation, book value and this year's depreciation. */
function Statement({ data, lines, t }: { data: SupportReportData; lines: AssetLine[]; t: ReturnType<typeof assetTotals> }) {
  const names = new Map((data.controls?.rows ?? []).map((r) => [r.account_id, r.name]));
  const groups = new Map<string, AssetLine[]>();
  for (const l of lines) {
    const key = (l.accountId && names.get(l.accountId)) || "Fixed assets";
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const grid =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 @2xl:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_7.5rem_7.5rem]";
  return (
    <SectionCard
      labelledBy="fa-statement"
      title="Register"
      description="Each asset under its account. Select one to open it in Registers, with its entries."
    >
      <div className="@container border-t border-border">
        <div
          aria-hidden="true"
          className={cn(grid, "hidden px-5 pt-3 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid lg:px-6")}
        >
          <span>Asset</span>
          <span className="text-right">Cost</span>
          <span className="text-right">Depreciated</span>
          <span className="text-right">Book value</span>
          <span className="text-right">This year</span>
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
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate" title={l.name}>
                          {l.name}
                        </span>
                        {l.disposed && (
                          <Badge size="sm" className="shrink-0">
                            Gone
                          </Badge>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Acquired {dateLabel(l.acquired)}
                        <span className="@2xl:hidden">
                          , cost <MaskedValue value={formatCents(l.cost)} />
                        </span>
                      </span>
                    </span>
                    <span className="hidden text-right tabular-nums @2xl:block">
                      <MaskedValue value={formatCents(l.cost)} />
                    </span>
                    <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                      <MaskedValue value={formatCents(l.accumulated)} />
                    </span>
                    <span className="text-right tabular-nums">
                      <MaskedValue value={formatCents(l.book)} />
                    </span>
                    <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                      {l.thisYear === null ? "" : <MaskedValue value={formatCents(l.thisYear)} />}
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
        <span className="text-muted-foreground">Cost, less depreciation</span>
        <span className="text-right tabular-nums">
          <MaskedValue value={`${formatCents(t.cost)} - ${formatCents(t.accumulated)}`} />
        </span>
        <span className="font-semibold">Book value</span>
        <span className="text-right font-semibold tabular-nums">
          <MaskedValue value={formatCents(t.book)} />
        </span>
      </div>
    </SectionCard>
  );
}
