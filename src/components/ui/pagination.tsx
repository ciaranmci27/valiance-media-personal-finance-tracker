"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PaginationProps {
  /** Zero-based offset of the first visible row. */
  offset: number;
  /** Rows per page. */
  limit: number;
  /** Total rows across all pages. */
  total: number;
  onChange: (offset: number) => void;
  /** Noun for the range label, e.g. "transactions". */
  noun?: string;
  busy?: boolean;
  className?: string;
}

/**
 * The one pager. Range label on the left, previous and next on the right.
 * Renders nothing when everything fits on one page.
 */
export function Pagination({
  offset,
  limit,
  total,
  onChange,
  noun,
  busy = false,
  className,
}: PaginationProps) {
  if (total <= limit && offset === 0) return null;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;
  const buttonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40";
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <span className="tabular-nums" aria-live="polite">
        {first.toLocaleString()} to {last.toLocaleString()} of{" "}
        {total.toLocaleString()}
        {noun ? ` ${noun}` : ""}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous page"
          disabled={!canPrev || busy}
          onClick={() => onChange(Math.max(0, offset - limit))}
          className={buttonClass}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!canNext || busy}
          onClick={() => onChange(offset + limit)}
          className={buttonClass}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
