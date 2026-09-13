"use client";
import type { ReactEventHandler, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one accordion. A hairline frame, no shadow, a chevron that turns, and
 * the same padding everywhere, so a disclosure inside a dialog looks like a
 * disclosure on a page. Native `details`, so it works without JavaScript and
 * the summary is a real focus stop.
 */
export function Disclosure({
  summary,
  meta,
  children,
  className,
  contentClassName,
  defaultOpen,
  onToggle,
}: {
  summary: ReactNode;
  /** Small text at the right of the summary, e.g. a count. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  defaultOpen?: boolean;
  onToggle?: ReactEventHandler<HTMLDetailsElement>;
}) {
  return (
    <details
      className={cn("group rounded-xl border border-border", className)}
      open={defaultOpen}
      onToggle={onToggle}
    >
      <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-open:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90"
          />
          <span className="min-w-0 truncate">{summary}</span>
        </span>
        {meta && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {meta}
          </span>
        )}
      </summary>
      <div className={cn("border-t border-border p-4", contentClassName)}>
        {children}
      </div>
    </details>
  );
}
