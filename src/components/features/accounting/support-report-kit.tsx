"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { cn } from "@/lib/utils";
import { demoSupportReport } from "@/lib/accounting/demo-reports";
import type { SupportReportData, SupportReportFilter } from "@/lib/accounting/support-reports";
import { rangeLabel } from "@/lib/accounting/profit-loss";
import { useAccountingCache } from "./accounting-cache";
import { useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";
import { PresetSegments } from "./report-kit";

/**
 * The pieces the support reports share (contractor worksheet, tax
 * workpapers, payroll register, fixed assets, loan
 * balances): the read that pages through every row, the export that keeps a
 * snapshot and downloads it in layout 2, the calendar-year control, the
 * "needs a decision" list and the notes. They sit beside report-kit, which
 * holds the tiles, cards and lists every report uses.
 */

/** The cached read of a support report page. */
export const supportQuery = (filter: SupportReportFilter) => ({
  view: "support-report",
  filter: JSON.stringify(filter),
});

/** How many pages of 100 rows a screen reads before it stops. */
const PAGE_LIMIT = 10;

export type SupportRead = {
  data: SupportReportData | null;
  loading: boolean;
  /** The data on screen belongs to the previous scope, or a newer one is loading. */
  updating: boolean;
  /** Every row is read (false past ten pages; the export still has them all). */
  complete: boolean;
  error: string;
  reload: () => void;
};

/**
 * A support report with all its rows: the first page through the shared
 * cache (kept on screen while the next scope loads), then the rest of the
 * pages, up to ten. The demo reads its synthetic books.
 */
export function useSupportReport(filter: SupportReportFilter, demo: boolean, enabled = true): SupportRead {
  const cache = useAccountingCache();
  const first = useAccountingRead<SupportReportData>(supportQuery({ ...filter, offset: 0 }), {
    enabled: !demo && enabled,
    keepPrevious: true,
  });
  const key = JSON.stringify(filter);
  const demoData = useMemo(() => {
    if (!demo || !enabled) return null;
    const head = demoSupportReport({ ...filter, offset: 0 });
    const rows = [...head.rows];
    while (rows.length < head.count) rows.push(...demoSupportReport({ ...filter, offset: rows.length }).rows);
    return { ...head, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, enabled, key]);
  const [rest, setRest] = useState<{ key: string; rows: SupportReportData["rows"] } | null>(null);
  const head = first.data;
  const more = !demo && enabled && !!head && !first.isPlaceholder && head.rows.length < head.count;
  useEffect(() => {
    if (!more || !head) return;
    const controller = new AbortController();
    void (async () => {
      const rows: SupportReportData["rows"] = [];
      try {
        for (let n = 1; n < PAGE_LIMIT && head.rows.length + rows.length < head.count; n++) {
          const page = await cache.read<SupportReportData>(
            supportQuery({ ...filter, offset: n * 100 }),
            controller.signal,
          );
          rows.push(...page.rows);
        }
        if (!controller.signal.aborted) setRest({ key: `${key}:${head.revision}`, rows });
      } catch {
        /* The first page's read reports failures; the list says it is partial. */
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, more, key, head?.revision]);
  if (demo)
    return { data: demoData, loading: false, updating: false, complete: true, error: "", reload: () => undefined };
  const extra = head && rest?.key === `${key}:${head.revision}` ? rest.rows : [];
  const data = head ? { ...head, rows: [...head.rows, ...extra] } : null;
  return {
    data,
    loading: first.loading && !head,
    updating: first.isPlaceholder || first.revalidating || (more && !extra.length),
    complete: !data || data.rows.length >= data.count,
    error: first.error,
    reload: () => void first.reload(),
  };
}

/**
 * Downloads a support report: the books keep a snapshot of the report as
 * shown (report.support.capture, once per revision and scope), then the
 * server draws it as the branded PDF or the CSV (layout 2). A second format
 * reuses the snapshot.
 */
export function useSupportExport() {
  const command = useAccountingCommand();
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [error, setError] = useState("");
  const capture = useRef<{ signature: string; id: string; saved: boolean } | null>(null);
  async function run(data: SupportReportData, format: "csv" | "pdf") {
    if (exporting) return;
    setExporting(format);
    setError("");
    const filter = { ...data.filter, offset: 0 };
    const signature = JSON.stringify({ filter, revision: data.revision });
    if (capture.current?.signature !== signature)
      capture.current = { signature, id: crypto.randomUUID(), saved: false };
    try {
      if (!capture.current.saved) {
        const ok = await command.execute({
          type: "report.support.capture",
          id: capture.current.id,
          expected_revision: data.revision,
          filter,
        });
        if (!ok) return;
        capture.current.saved = true;
      }
      const response = await fetch(`/api/accounting/reports/${capture.current.id}?format=${format}&layout=2`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? "Unable to download the retained report.");
      }
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${data.report_id}-${data.filter.from}-${data.filter.to}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to export this report.");
    } finally {
      setExporting(null);
    }
  }
  return { run, exporting, error: error || command.error || "" };
}

/**
 * A calendar-year report's controls: the years as segments, and a line
 * saying what is shown. Used where the rules run by calendar year (1099s),
 * not the fiscal year.
 */
export function YearControls({
  years,
  year,
  from,
  to,
  scope,
  updating,
  onYear,
  children,
}: {
  /** More controls beside the years, such as the quarters. */
  children?: ReactNode;
  years: number[];
  year: number;
  from: string;
  to: string;
  /** What the figures cover: "Reviewed contractor payments". */
  scope: ReactNode;
  updating: boolean;
  onYear: (year: number) => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <PresetSegments
          label="Calendar year"
          options={years.map((y) => ({ value: String(y), label: String(y), short: String(y) }))}
          value={String(year)}
          onChoose={(v) => v !== "custom" && onYear(Number(v))}
        />
        {children}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{rangeLabel(from, to)}</span>
        <span aria-hidden="true">·</span>
        <span>{scope}</span>
        <span aria-hidden="true">·</span>
        <span>USD</span>
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
}

export type CheckItem = {
  key: string;
  /** "look" needs the owner; "info" is worth knowing. */
  tone: "look" | "info";
  title: string;
  detail: string;
  action?: ReactNode;
};

/**
 * A list of things to decide or check, each a title and a plain sentence,
 * or an all-clear line when there is nothing. Rows keep their own height.
 */
export function CheckList({ items, empty }: { items: CheckItem[]; empty: string }) {
  if (!items.length)
    return (
      <p className="flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 px-3 py-2.5 text-sm">
        <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
        <span>{empty}</span>
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.map((n) => (
        <li
          key={n.key}
          className={cn(
            "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
            n.tone === "look" ? "border-warning/40 bg-warning/5" : "border-border bg-[rgba(var(--ink),0.03)]",
          )}
        >
          {n.tone === "look" ? (
            <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
          ) : (
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{n.title}</span>
            <span className="mt-0.5 block leading-relaxed text-muted-foreground">{n.detail}</span>
            {n.action && <span className="mt-1.5 block">{n.action}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How the report is built, its revision, and a refresh. */
export function SupportNotes({
  data,
  notes,
  onReload,
}: {
  data: SupportReportData;
  notes: string[];
  onReload: () => void;
}) {
  return (
    <Disclosure summary="How this report is built" contentClassName="space-y-3 text-xs text-muted-foreground">
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      <p>
        Report definition {data.definition_version} · Revision {data.revision}
      </p>
      <Button size="sm" variant="ghost" onClick={onReload}>
        <RefreshCw aria-hidden="true" />
        Refresh
      </Button>
    </Disclosure>
  );
}
