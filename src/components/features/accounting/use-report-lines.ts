"use client";

import { useEffect, useState } from "react";
import { demoReportDetail } from "@/lib/accounting/demo-reports";
import type { ReportDetail, ReportFilter } from "@/lib/accounting/reports";
import { useAccountingCache } from "./accounting-cache";

/** How many pages of 100 journal lines a screen reads before it stops. */
const PAGE_LIMIT = 10;

/**
 * Every journal line for a scope, read a page of 100 at a time through the
 * shared cache (a write elsewhere marks the pages stale and they are read
 * again). Stops after ten pages and says so, rather than reading without
 * end. The demo reads its synthetic journal.
 */
export function useReportLines(
  filter: ReportFilter | null,
  demo: boolean,
): { rows: ReportDetail["rows"] | null; total: number; complete: boolean; error: string } {
  const cache = useAccountingCache();
  const key = filter ? JSON.stringify(filter) : "";
  const [state, setState] = useState<{
    key: string;
    rows: ReportDetail["rows"];
    total: number;
    error: string;
  } | null>(null);

  useEffect(() => {
    if (!filter) return;
    const controller = new AbortController();
    const unsubscribe: (() => void)[] = [];
    const page = (offset: number): Promise<ReportDetail> => {
      const scope = { ...filter, offset };
      if (demo) return demoReportDetail(scope);
      const query = { view: "report-detail", filter: JSON.stringify(scope) };
      return cache.read<ReportDetail>(query, controller.signal);
    };
    const run = async () => {
      try {
        const first = await page(0);
        const rows = [...first.rows];
        for (let n = 1; n < PAGE_LIMIT && rows.length < first.total; n++)
          rows.push(...(await page(n * 100)).rows);
        if (!controller.signal.aborted) setState({ key, rows, total: first.total, error: "" });
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ key, rows: [], total: 0, error: e instanceof Error ? e.message : "Unable to load the transactions." });
      }
    };
    void run();
    if (!demo) {
      const query = { view: "report-detail", filter: JSON.stringify({ ...filter, offset: 0 }) };
      unsubscribe.push(
        cache.subscribe(query, () => {
          const entry = cache.entry(query);
          if (!cache.inflight(query) && (!entry || entry.stale)) void run();
        }),
      );
    }
    return () => {
      controller.abort();
      unsubscribe.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, demo]);

  if (!filter) return { rows: [], total: 0, complete: true, error: "" };
  if (!state || state.key !== key) return { rows: null, total: 0, complete: false, error: "" };
  return {
    rows: state.rows,
    total: state.total,
    complete: state.rows.length >= state.total,
    error: state.error,
  };
}
