"use client";

import * as React from "react";
import { accountingReadJson } from "@/lib/accounting/read-json";
import type { BooksFigure, BooksFigures } from "@/lib/accounting/tax-books-figures";
import type { BooksState } from "./tax-estimator-model";

export const booksFiguresUrl = (year: number, through?: string) =>
  `/api/accounting/tax?year=${encodeURIComponent(String(year))}${through ? `&through=${encodeURIComponent(through)}` : ""}`;

/**
 * Keeps rows that came from the books current: one read when the year is
 * shown and one on demand, never a poll. The page applies the figures; the
 * hook only owns the request and what to say about it. A response that lands
 * after the year changed is dropped so it can never write into another year.
 */
export function useBooksRefresh(options: {
  year: number;
  enabled: boolean;
  hasBooksRows: boolean;
  apply: (figures: BooksFigure[]) => Pick<BooksState, "moved" | "problems">;
}): { books: BooksState; refresh: () => void } {
  const { year, enabled, hasBooksRows, apply } = options;
  const [state, setState] = React.useState<Omit<BooksState, "available">>({
    status: "idle",
    through: null,
    error: "",
    moved: [],
    problems: [],
    unreviewed: 0,
  });
  const applyRef = React.useRef(apply);
  applyRef.current = apply;
  const yearRef = React.useRef(year);
  yearRef.current = year;
  const fetchedYear = React.useRef<number | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const run = React.useCallback(
    (targetYear: number) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setState((prev) => ({ ...prev, status: "loading", error: "" }));
      accountingReadJson<BooksFigures>(booksFiguresUrl(targetYear), abort.signal)
        .then((result) => {
          if (abort.signal.aborted || yearRef.current !== targetYear) return;
          const applied = applyRef.current(result.figures);
          fetchedYear.current = targetYear;
          setState({
            status: "idle",
            through: result.through,
            error: "",
            moved: applied.moved,
            problems: [...result.notes, ...applied.problems],
            unreviewed: result.unreviewed,
          });
        })
        .catch((error: unknown) => {
          if (abort.signal.aborted || yearRef.current !== targetYear) return;
          setState((prev) => ({
            ...prev,
            status: "error",
            error:
              error instanceof Error && error.message
                ? error.message
                : "Couldn't refresh from the books.",
          }));
        });
    },
    [],
  );

  React.useEffect(() => {
    if (!enabled || !hasBooksRows) return;
    if (fetchedYear.current === year) return;
    run(year);
  }, [enabled, hasBooksRows, year, run]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = React.useCallback(() => {
    if (!enabled) return;
    run(yearRef.current);
  }, [enabled, run]);

  return { books: { available: enabled, ...state }, refresh };
}
