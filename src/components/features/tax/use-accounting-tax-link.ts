"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaxLinkView } from "@/lib/accounting/tax-links";

/** Never settles: a superseded request is dropped, not rejected. */
const forever = new Promise<never>(() => {});

/**
 * Read the accounting link for a year. An aborted `signal` means a newer
 * request took over, so the result is dropped and nothing rejects.
 */
export async function readTaxLink(
  year: number,
  signal?: AbortSignal,
): Promise<TaxLinkView> {
  if (signal?.aborted) return forever;
  const response = await fetch(`/api/accounting/tax?year=${year}`, {
    cache: "no-store",
  });
  if (signal?.aborted) return forever;
  const result = await response.json();
  if (signal?.aborted) return forever;
  if (!response.ok)
    throw new Error(result.error ?? "The accounting link could not be loaded.");
  return result;
}
export function useAccountingTaxLink(
  year: number,
  enabled: boolean,
  savedKey = "",
) {
  const [view, setView] = useState<TaxLinkView | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (force = false) => {
      if (!enabled) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      try {
        let current = await readTaxLink(year, controller.signal);
        if (current.link?.enabled && (!current.current || force)) {
          const response = await fetch("/api/accounting/tax", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ year, force }),
          });
          if (controller.signal.aborted) return;
          const result = await response.json();
          if (controller.signal.aborted) return;
          if (!response.ok)
            setError(result.error ?? "The linked estimate needs review.");
          current = await readTaxLink(year, controller.signal);
        }
        if (!controller.signal.aborted) setView(current);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Accounting refresh unavailable.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [year, enabled],
  );
  useEffect(() => {
    void refresh();
    const foreground = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", foreground);
    const timer = setInterval(foreground, 30000);
    return () => {
      request.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh, savedKey]);
  return {
    view: view?.estimate?.tax_year === year ? view : null,
    error,
    loading,
    refresh,
  };
}
