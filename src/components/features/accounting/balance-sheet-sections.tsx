"use client";
import { useMaskedHover } from "@/components/ui/masked-value";
import { formatCents } from "@/lib/accounting/money";
import {
  ownershipSentence,
  type BalanceTotals,
  type EquityLine,
} from "@/lib/accounting/balance-sheet";
import { SectionCard, WaterfallList, type Drill } from "./report-kit";

const ZERO = BigInt(0);
const money = (value: bigint) => formatCents(value);
const share = (part: bigint, whole: bigint) =>
  whole > ZERO ? Number((part * BigInt(10000)) / whole) / 100 : 0;

/**
 * Equity in the owner's words. A meter splits everything the business has
 * into what is owed to others and what is the owner's; below it, a
 * waterfall walks from zero to total equity, one plain-language line at a
 * time (money put in, money taken out, profits kept, this year's profit,
 * and any other equity account under its own name), so the lines visibly
 * add up. Each line with accounts behind it opens their transactions.
 */
export function EquityCard({
  lines,
  total,
  totals,
  onDrill,
}: {
  lines: EquityLine[];
  total: bigint;
  totals: BalanceTotals;
  onDrill: Drill;
}) {
  const { isHidden, showValue, hoverProps } = useMaskedHover();
  const hide = isHidden && !showValue;
  const { assets, liabilities } = totals;
  const owed = Math.min(100, Math.max(0, share(liabilities, assets)));
  return (
    <SectionCard
      labelledBy="bs-equity"
      title="Equity, explained"
      description={
        hide ? "Hover to reveal the split." : ownershipSentence(totals)
      }
    >
      <div className="space-y-4 px-5 pb-5 lg:px-6 lg:pb-6" {...hoverProps}>
        {assets > ZERO && (
          <div className="space-y-2">
            <div
              role="img"
              aria-label={
                hide
                  ? "What the business has, split hidden"
                  : `Of ${money(assets)} the business has, ${money(liabilities)} is owed to others and ${money(assets - liabilities)} is yours`
              }
              className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]"
            >
              {owed > 0 && (
                <div
                  className="h-full animate-bar-fill bg-copper-strong"
                  style={{ width: `${owed}%` }}
                />
              )}
              {owed < 100 && (
                <div
                  className="h-full animate-bar-fill bg-teal"
                  style={{ width: `${100 - owed}%` }}
                />
              )}
            </div>
            <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-copper-strong" />
                Owed to others
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-teal" />
                Yours (equity)
              </span>
            </p>
          </div>
        )}
        <WaterfallList
          label="Equity, line by line"
          lines={lines}
          total={{ label: "Total equity", amount: total }}
          onDrill={onDrill}
          hide={hide}
        />
      </div>
    </SectionCard>
  );
}
