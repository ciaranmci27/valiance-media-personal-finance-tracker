"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Download, FileArchive, FileSpreadsheet, FileText, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Pagination } from "@/components/ui/pagination";
import { cn } from "@/lib/utils";
import { usePrivacy } from "@/contexts/privacy-context";
import { formatCents } from "@/lib/accounting/money";
import type { ReportData, ReportFilter } from "@/lib/accounting/reports";
import type { BooksPackageHistory, BooksPackagePreview } from "@/lib/accounting/books-package";
import { reportQuery } from "@/lib/accounting/preload";
import { demoReportData, demoReportDetail } from "@/lib/accounting/demo-reports";
import { accountingHref } from "@/lib/accounting/views";
import {
  PACKAGE_CONTENTS,
  PACKAGE_GROUPS,
  PACKAGE_NOTES,
  itemReady,
  packageChecks,
  packageScope,
  packageSummary,
  packageYears,
  type PackageCheck,
} from "@/lib/accounting/year-end-package";
import { AccountingPageHeader } from "./accounting-page-header";
import { useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";
import { countLabel, dateLabel, timestampLabel, todayInBooks } from "./format";
import { CardRow, ScrollList, SectionCard, StatTile } from "./report-kit";
import { YearControls, useSupportReport } from "./support-report-kit";

const PAGE_SIZE = 25;
const reportHref = (id: string) => accountingHref("reports", undefined, { report: id });

/**
 * The year-end package: is the year ready to hand to a tax preparer, and
 * everything in one download. The calendar (tax) year from January 1,
 * reviewed transactions only, as the books capture it; every report in it
 * at the same book revision. Readiness is the checks the reports make.
 */
export function AccountingBooksPackage({
  onBack,
  onReview,
  demo = false,
}: {
  onBack: () => void;
  onReview: () => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  const years = packageYears(today);
  const savedYear = Number(params.get("package_year"));
  const year = years.includes(savedYear) ? savedYear : years[0];
  const savedThrough = params.get("package_through");
  const scope =
    savedThrough && savedThrough.startsWith(`${year}-`) && savedThrough <= today
      ? { year, through: savedThrough }
      : packageScope(year, today);
  const from = `${year}-01-01`;
  const live = !demo;

  // What the package will hold, and what the books say about it.
  const preview = useAccountingRead<BooksPackagePreview>(
    { view: "books-package", year: String(year), through: scope.through },
    { enabled: live, keepPrevious: true },
  );
  const [offset, setOffset] = useState(0);
  const history = useAccountingRead<BooksPackageHistory>(
    { view: "books-package-history", year: String(year), offset: String(offset) },
    { enabled: live, keepPrevious: true },
  );
  // The checks, from the reports' own reads (the package's scope).
  const coreScope: ReportFilter = { from, to: scope.through, mode: "posted", offset: 0 };
  const coreRead = useAccountingRead<ReportData>(reportQuery("trial-balance", coreScope), { enabled: live, keepPrevious: true });
  const demoCore = useMemo(
    () => (demo ? demoReportData(coreScope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, from, scope.through],
  );
  const core = demo ? demoCore : (coreRead.data ?? null);
  // The demo's journal line count, as the package preview would give it.
  const [demoLines, setDemoLines] = useState<number | null>(null);
  useEffect(() => {
    if (!demo) return;
    void demoReportDetail({ from, to: scope.through, mode: "posted", offset: 0 }).then((d) => setDemoLines(d.total));
  }, [demo, from, scope.through]);
  const lineCount = demo ? demoLines : (preview.data?.ledger_count ?? null);
  const yearScope = (report_id: "tax-workpapers" | "contractor-worksheet" | "payroll-register" | "asset-register" | "loan-register") => ({
    report_id,
    from,
    to: scope.through,
    offset: 0,
  });
  const tax = useSupportReport(yearScope("tax-workpapers"), demo);
  const contractor = useSupportReport(yearScope("contractor-worksheet"), demo);
  const payroll = useSupportReport(yearScope("payroll-register"), demo);
  const asset = useSupportReport(yearScope("asset-register"), demo);
  const loan = useSupportReport(yearScope("loan-register"), demo);
  const checks = packageChecks({
    core,
    tax: tax.data,
    contractor: contractor.data,
    payroll: payroll.data,
    asset: asset.data,
    loan: loan.data,
    reviewItems: preview.data?.review_items,
  });
  const summary = packageSummary(checks);

  const pkg = usePackageDownloads(preview.data ?? null, () => void history.reload());
  function chooseYear(next: number) {
    const url = new URL(window.location.href);
    url.searchParams.set("package_year", String(next));
    url.searchParams.set("package_through", packageScope(next, today).through);
    window.history.pushState(null, "", url);
    setOffset(0);
  }
  const tooBig = (preview.data?.ledger_count ?? 0) > 100000;
  const unavailable = demo ? "Available with your own books" : tooBig ? "Over the 100,000-line package limit" : "";
  const errorMessage = pkg.error || (live && !preview.data && preview.error) || "";
  const reports = PACKAGE_CONTENTS.length;
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Year-end package"
        subtitle="Is the year ready for your tax preparer? Everything they need, in one download."
        actions={
          <Button
            size="sm"
            disabled={demo || tooBig || !preview.data || !!pkg.busy}
            title={unavailable || undefined}
            onClick={() => void pkg.download({ format: "zip" })}
          >
            <FileArchive aria-hidden="true" />
            {pkg.busy === "zip" ? "Preparing the package..." : "Download the package"}
          </Button>
        }
      />
      <YearControls
        years={years}
        year={year}
        from={from}
        to={scope.through}
        scope="Calendar year, reviewed transactions only"
        updating={live && (preview.revalidating || preview.isPlaceholder)}
        onYear={chooseYear}
      />
      {demo && (
        <p className="text-xs text-muted-foreground">
          Downloads are available with your own books; the checks and contents below read the demo books.
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="Readiness"
          value={summary.text === "Checking the year." ? "-" : summary.ready ? "Ready" : `${summary.look} open`}
          context={summary.ready ? "Nothing needs a look" : summary.look ? "Things to look at" : "Checking the year"}
          tone={summary.ready ? "good" : summary.look ? "bad" : "neutral"}
        />
        <StatTile label="Profit" value={core ? formatCents(BigInt(core.totals.net_cents)) : "-"} context="Book profit for the year" />
        <StatTile
          label="Journal lines"
          value={lineCount === null ? "-" : lineCount.toLocaleString("en-US")}
          context={tooBig ? "Over the package limit" : "In the general ledger"}
          tone={tooBig ? "bad" : "neutral"}
        />
        <StatTile label="Reports" value={String(reports)} context="In the package" />
      </section>

      <CardRow wide>
        <ReadinessCard checks={checks} text={summary.text} onReview={onReview} />
        <ContentsCard checks={checks} demo={demo || tooBig} busy={pkg.busy} onDownload={(report, format) => void pkg.download({ report, format })} />
      </CardRow>

      {live && (
        <SectionCard
          labelledBy="yp-history"
          title="Packages you kept"
          description="Each download keeps a copy at its book revision. Later edits do not change a kept copy."
        >
          {!history.data?.rows.length ? (
            <p className="border-t border-border px-5 py-5 text-sm text-muted-foreground lg:px-6">
              {history.loading ? "Reading the packages." : `No package kept for ${year} yet. Downloading one keeps it here.`}
            </p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {history.data.rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 lg:px-6">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">January 1 through {dateLabel(row.to_date)}</span>
                    <span className="block text-xs text-muted-foreground">
                      Kept {timestampLabel(row.created_at)} · revision {row.revision} ·{" "}
                      {row.review_items.length ? countLabel(row.review_items.length, "open item") : "nothing open"}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={!!pkg.busy} onClick={() => void pkg.fetchKept(row.id, "zip")}>
                      <Download aria-hidden="true" />
                      ZIP
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!!pkg.busy} onClick={() => void pkg.fetchKept(row.id, "csv-zip")}>
                      CSV only
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!!pkg.busy} onClick={() => void pkg.fetchKept(row.id, "json")}>
                      JSON
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            total={history.data?.count ?? 0}
            onChange={setOffset}
            noun="packages"
            busy={history.revalidating}
            className="mt-auto border-t border-border"
          />
        </SectionCard>
      )}

      <Disclosure summary="What the package is" contentClassName="space-y-3 text-xs text-muted-foreground">
        {PACKAGE_NOTES.map((n) => (
          <p key={n}>{n}</p>
        ))}
        <p>
          The package follows the calendar (tax) year the books keep for it, even when your fiscal year starts in another month.
        </p>
        {preview.data && <p>Book revision {preview.data.revision}</p>}
      </Disclosure>
    </div>
  );
}

/**
 * Downloads from the package: the books keep a copy at the current revision
 * (report.books.capture, once per year, cutoff and revision), then the
 * server draws the whole package or one report from it, in the branded
 * layout.
 */
function usePackageDownloads(preview: BooksPackagePreview | null, onKept: () => void) {
  const command = useAccountingCommand();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const kept = useRef<{ key: string; id: string; saved: boolean } | null>(null);
  async function save(url: string, fallback: string) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? "Unable to download the package.");
    }
    const href = URL.createObjectURL(await response.blob()),
      anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallback;
    anchor.click();
    URL.revokeObjectURL(href);
  }
  async function download({ format, report }: { format: "zip" | "pdf" | "csv"; report?: string }) {
    if (!preview || busy) return;
    setBusy(report ? `${report}:${format}` : "zip");
    setError("");
    try {
      const key = JSON.stringify({ year: preview.year, through: preview.through, revision: preview.revision });
      if (kept.current?.key !== key) kept.current = { key, id: crypto.randomUUID(), saved: false };
      if (!kept.current.saved) {
        const ok = await command.execute({
          type: "report.books.capture",
          id: kept.current.id,
          expected_revision: preview.revision,
          year: preview.year,
          through: preview.through,
        });
        if (!ok) return;
        kept.current.saved = true;
        onKept();
      }
      const id = kept.current.id;
      await save(
        report
          ? `/api/accounting/packages/${id}?report=${report}&format=${format}&layout=2`
          : `/api/accounting/packages/${id}?format=zip&layout=2`,
        report ? `${report}-${preview.year}.${format}` : `books-package-${preview.year}.zip`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to download the package.");
    } finally {
      setBusy(null);
    }
  }
  async function fetchKept(id: string, format: "zip" | "csv-zip" | "json") {
    if (busy) return;
    setBusy(`kept:${id}`);
    setError("");
    try {
      await save(`/api/accounting/packages/${id}?format=${format}&layout=2`, `books-package-${id.slice(0, 8)}.${format === "json" ? "json" : "zip"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to download the package.");
    } finally {
      setBusy(null);
    }
  }
  return { download, fetchKept, busy, error: error || command.error || "" };
}

/** Each check with a plain status and the page that fixes it. */
function ReadinessCard({ checks, text, onReview }: { checks: PackageCheck[]; text: string; onReview: () => void }) {
  // Privacy mode hides the amounts the checks quote.
  const { isHidden } = usePrivacy();
  const mask = (s: string) => (isHidden ? s.replace(/-?\$[\d,]+\.\d\d/g, "•••••") : s);
  const linkClass =
    "inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
  return (
    <SectionCard labelledBy="yp-ready" title="Is the year ready?" description={text}>
      <ScrollList label="Readiness checks" className="mx-2.5 mb-3 lg:mx-3.5">
        <ul className="space-y-1">
          {checks.map((c) => (
            <li
              key={c.key}
              className={cn(
                "flex items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-sm",
                c.status === "look" && "border border-warning/40 bg-warning/5",
              )}
            >
              {c.status === "ready" ? (
                <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
              ) : c.status === "look" ? (
                <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
              ) : c.status === "info" ? (
                <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
              ) : (
                <Loader2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground motion-safe:animate-spin" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {mask(c.title)}
                  <span className="sr-only">
                    {c.status === "ready" ? ", ready" : c.status === "look" ? ", needs a look" : c.status === "info" ? ", for information" : ", checking"}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{mask(c.detail)}</span>
                {c.status !== "ready" && c.status !== "waiting" && (c.report || c.review) && (
                  <span className="mt-1.5 block">
                    {c.review ? (
                      <button type="button" onClick={onReview} className={linkClass}>
                        Review them
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </button>
                    ) : (
                      <a href={reportHref(c.report!)} className={linkClass}>
                        Open the report
                        <ArrowUpRight size={12} aria-hidden="true" />
                        <span className="sr-only">, {mask(c.title)}</span>
                      </a>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </ScrollList>
    </SectionCard>
  );
}

/** Every report in the package, what it answers, whether it is ready, and a download of each. */
function ContentsCard({
  checks,
  demo,
  busy,
  onDownload,
}: {
  checks: PackageCheck[];
  demo: boolean;
  busy: string | null;
  onDownload: (report: string, format: "pdf" | "csv") => void;
}) {
  const iconButton =
    "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-[rgba(var(--ink),0.05)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-40";
  return (
    <SectionCard
      labelledBy="yp-contents"
      title="What's in the package"
      description={`${PACKAGE_CONTENTS.length} reports at one book revision, each as a branded PDF and a CSV.`}
    >
      <ScrollList label="Package contents" className="mx-2.5 mb-3 lg:mx-3.5">
        {PACKAGE_GROUPS.map((group) => (
          <div key={group}>
            <p className="px-2.5 pt-2 pb-1 font-mono text-[11px] uppercase tracking-[0.12em] text-teal-light">{group}</p>
            <ul className="space-y-0.5">
              {PACKAGE_CONTENTS.filter((i) => i.group === group).map((item) => {
                const ready = itemReady(item, checks);
                return (
                  <li key={item.id} className="flex items-center gap-3 rounded-lg px-2.5 py-2">
                    <span
                      aria-hidden="true"
                      className={cn("h-2 w-2 shrink-0 rounded-full", ready ? "bg-success" : "bg-warning")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {item.page ? (
                          <a
                            href={reportHref(item.page)}
                            className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                        <span className="sr-only">{ready ? ", ready" : ", needs a look"}</span>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{item.answers}</span>
                    </span>
                    <span className="flex shrink-0 items-center">
                      {item.pdf && (
                        <button
                          type="button"
                          className={iconButton}
                          disabled={demo || !!busy}
                          onClick={() => onDownload(item.id, "pdf")}
                          aria-label={`Download ${item.title} as PDF`}
                        >
                          <FileText size={14} aria-hidden="true" />
                          {busy === `${item.id}:pdf` ? "..." : "PDF"}
                        </button>
                      )}
                      <button
                        type="button"
                        className={iconButton}
                        disabled={demo || !!busy}
                        onClick={() => onDownload(item.id, "csv")}
                        aria-label={`Download ${item.title} as CSV`}
                      >
                        <FileSpreadsheet size={14} aria-hidden="true" />
                        {busy === `${item.id}:csv` ? "..." : "CSV"}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </ScrollList>
    </SectionCard>
  );
}
