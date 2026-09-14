"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Placeholders for loads inside a screen that is already open. Each keeps
 * the height of what replaces it, so the swap moves nothing.
 */

/** Receipts and history while the evidence read is still on its way. */
export function EvidenceSkeleton({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading receipts and history"
      className={cn("space-y-6", className)}
    >
      {[0, 1, 2].map((section) => (
        <div key={section} className="space-y-2.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A financial statement: a highlights row and a two-column table. */
export function StatementSkeleton() {
  return (
    <div role="status" aria-label="Preparing report" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="glass-card space-y-3 rounded-xl p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-32" />
          </div>
        ))}
      </div>
      <div className="glass-card rounded-xl p-4">
        <div className="flex justify-between border-b border-border py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex justify-between py-3">
            <Skeleton className={cn("h-4", i % 3 === 0 ? "w-48" : "w-36")} />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A Manage section: a heading and a short list. */
export function ManagePanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3 w-64" />
      </div>
      <div className="glass-card divide-y divide-border rounded-xl px-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between py-3.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
