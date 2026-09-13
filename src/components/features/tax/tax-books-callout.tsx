"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Bank and imported activity that is still waiting for a category is not in
 * any figure on this page. That deserves a callout, not a footnote: the
 * count, why it matters, the way in, and a refresh for when the owner is
 * back. Same box as the setup guide so it reads as the same kind of message.
 */
export function TaxBooksCallout({
  count,
  refreshing,
  onRefresh,
}: {
  count: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (count <= 0) return null;
  const noun = count === 1 ? "transaction" : "transactions";
  return (
    <section
      role="status"
      aria-label="Transactions to review"
      className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3"
    >
      <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {count} {noun} still to review
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Business profit and wages from the books leave {count === 1 ? "it" : "them"} out
          until {count === 1 ? "it has" : "they have"} a category. Review{" "}
          {count === 1 ? "it" : "them"} in Transactions, then refresh here.
        </p>
      </div>
      <div className="flex basis-full items-center justify-end gap-2 self-center sm:ml-auto sm:basis-auto">
        <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
          <RefreshCw size={14} aria-hidden="true" className={cn(refreshing && "animate-spin")} />
          Refresh
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href="/accounting?view=journal">
            Review
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
