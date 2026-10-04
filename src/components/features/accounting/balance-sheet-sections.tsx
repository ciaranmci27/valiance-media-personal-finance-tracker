"use client";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import {
  ownershipSentence,
  type BalanceTotals,
  type EquityLine,
} from "@/lib/accounting/balance-sheet";
import { SectionCard, type Drill } from "./report-kit";

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
  // The waterfall's scale covers every running total and zero.
  let running = ZERO;
  const steps = lines.map((l) => {
    const start = running;
    running += l.amount;
    return { line: l, start, end: running };
  });
  const points = [ZERO, total, ...steps.flatMap((s) => [s.start, s.end])];
  const low = points.reduce((m, v) => (v < m ? v : m), ZERO),
    high = points.reduce((m, v) => (v > m ? v : m), ZERO);
  const span = high - low || BigInt(1);
  const pos = (v: bigint) => Number(((v - low) * BigInt(10000)) / span) / 100;
  const zero = pos(ZERO);
  const segment = (from: bigint, to: bigint) => ({
    left: `${Math.min(pos(from), pos(to))}%`,
    width: `${Math.max(0.6, Math.abs(pos(to) - pos(from)))}%`,
  });
  const row = (
    key: string,
    label: string,
    amount: bigint,
    bar: { left: string; width: string },
    fill: string,
    strong: boolean,
    drill?: () => void,
  ) => {
    const content = (
      <>
        <span
          className={cn(
            "col-start-1 row-start-1 min-w-0 text-sm sm:truncate",
            strong && "font-semibold",
          )}
        >
          {label}
        </span>
        <span
          aria-hidden="true"
          className="relative col-span-2 col-start-1 row-start-2 h-2.5 rounded-full bg-[rgba(var(--ink),0.05)] sm:col-span-1 sm:col-start-2 sm:row-start-1"
        >
          <span
            className="absolute inset-y-0 w-px bg-[rgba(var(--ink),0.25)]"
            style={{ left: `${zero}%` }}
          />
          <span
            className={cn("absolute inset-y-0 rounded-full", fill)}
            style={bar}
          />
        </span>
        <span
          className={cn(
            // Phones: name and amount share a line, the bar runs under them.
            "col-start-2 row-start-1 text-right text-sm tabular-nums sm:col-start-3",
            strong && "font-semibold",
            !hide && amount < ZERO && "text-error",
          )}
        >
          <MaskedValue value={money(amount)} inheritHover />
        </span>
      </>
    );
    const layout =
      "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-lg px-2.5 py-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_8.5rem]";
    return (
      <li key={key}>
        {drill ? (
          <button
            type="button"
            onClick={drill}
            className={cn(
              layout,
              "text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
            )}
          >
            {content}
            <span className="sr-only">, show transactions</span>
          </button>
        ) : (
          <div className={layout}>{content}</div>
        )}
      </li>
    );
  };
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
        <ul className="-mx-2.5 space-y-0.5">
          {steps.map(({ line, start, end }) =>
            row(
              line.key,
              line.label,
              line.amount,
              segment(start, end),
              line.amount < ZERO ? "bg-copper-strong" : "bg-teal",
              false,
              line.filter ? () => onDrill(line.label, line.filter!) : undefined,
            ),
          )}
        </ul>
        <ul className="-mx-2.5 border-t border-border pt-1">
          {row(
            "total",
            "Total equity",
            total,
            segment(ZERO, total),
            total < ZERO ? "bg-error" : "bg-teal-dark",
            true,
          )}
        </ul>
      </div>
    </SectionCard>
  );
}
