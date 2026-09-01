"use client";

import { Info } from "lucide-react";

/**
 * Announcement bar pinned to the top of the content area (right of the
 * sidebar on desktop). h-9 is load-bearing: the dashboard layout offsets
 * <main> by the same height in demo mode so content clears the bar.
 */
export function DemoBanner() {
  return (
    <div className="fixed top-0 right-0 left-0 lg:left-60 z-40 h-9 bg-primary/15 backdrop-blur-sm border-b border-primary/30 px-4">
      <div className="flex h-full items-center justify-center gap-2 text-sm">
        <Info className="h-4 w-4 text-teal-light shrink-0" />
        <span className="text-teal-light font-medium">
          Demo Mode
        </span>
        <span className="text-muted-foreground hidden sm:inline">
          You&apos;re viewing sample data. Changes won&apos;t be saved.
        </span>
      </div>
    </div>
  );
}
