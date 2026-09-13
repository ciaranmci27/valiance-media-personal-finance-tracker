"use client";
import { Check } from "lucide-react";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import { money } from "./format";

/** Show both sides of the journal and the difference, including zero. */
export function JournalTotals({
  debit,
  credit,
}: {
  debit: bigint;
  credit: bigint;
}) {
  const difference = debit - credit;
  const balanced = difference === BigInt(0);
  return (
    <div
      aria-label="Journal totals"
      className="rounded-xl border border-border bg-secondary/30 px-4 py-3 text-sm"
    >
      <dl className="grid grid-cols-2 gap-4">
        {(
          [
            ["Total debits", debit],
            ["Total credits", credit],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words font-semibold tabular-nums">
              <MaskedValue value={money(value)} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-muted-foreground">Difference</span>
        <span
          className={cn(
            "flex flex-wrap items-center gap-2 font-medium tabular-nums",
            balanced ? "text-success" : "text-warning",
          )}
        >
          {balanced && debit > BigInt(0) && (
            <>
              <Check size={14} aria-hidden="true" />
              <span className="text-xs">Balanced</span>
            </>
          )}
          <MaskedValue value={money(difference)} />
        </span>
      </div>
    </div>
  );
}
