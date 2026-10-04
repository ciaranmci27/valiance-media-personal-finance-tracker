"use client";

import { useEffect, useMemo, useState } from "react";
import { breakdownQuery } from "@/lib/accounting/preload";
import { accountingQueryKey } from "@/lib/accounting/read-cache";
import { seriesFilter } from "@/lib/accounting/contact-report";
import { demoBreakdown } from "@/lib/accounting/demo-reports";
import type { BreakdownData, ReportFilter } from "@/lib/accounting/reports";
import { useAccountingCache } from "./accounting-cache";

/**
 * One month series per contact, read through the shared cache: how many
 * there are depends on the period, so this reads them together rather than
 * one hook each. A cached series answers at once; a write elsewhere marks it
 * stale and it is read again, keeping the last answer on screen meanwhile.
 * The demo builds them from its synthetic journal.
 */
export function useContactSeries(
  filter: ReportFilter,
  ids: string[],
  demo: boolean,
): { series: Map<string, BreakdownData>; loading: boolean } {
  const cache = useAccountingCache();
  const queries = useMemo(
    () => ids.map((id) => ({ id, query: breakdownQuery(seriesFilter(filter, id)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(filter), ids.join(",")],
  );
  const key = queries.map((q) => accountingQueryKey(q.query)).join("|");
  const [state, setState] = useState<{ key: string; series: Map<string, BreakdownData> }>({
    key: "",
    series: new Map(),
  });
  const demoSeries = useMemo(
    () =>
      demo
        ? new Map(ids.map((id) => [id, demoBreakdown(seriesFilter(filter, id))]))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, key],
  );

  useEffect(() => {
    if (demo || !queries.length) return;
    const controller = new AbortController();
    let failed = false;
    const run = () =>
      Promise.all(
        queries.map((q) =>
          cache
            .read<BreakdownData>(q.query, controller.signal)
            .then((data) => [q.id, data] as const),
        ),
      ).then(
        (pairs) => {
          if (!controller.signal.aborted) setState({ key, series: new Map(pairs) });
        },
        () => {
          failed = true;
        },
      );
    void run();
    const unsubscribe = queries.map((q) =>
      cache.subscribe(q.query, () => {
        if (failed || cache.inflight(q.query)) return;
        const entry = cache.entry(q.query);
        if (!entry || entry.stale) void run();
      }),
    );
    return () => {
      controller.abort();
      unsubscribe.forEach((u) => u());
    };
  }, [cache, demo, key, queries]);

  if (demoSeries) return { series: demoSeries, loading: false };
  return { series: state.series, loading: queries.length > 0 && state.key !== key };
}
