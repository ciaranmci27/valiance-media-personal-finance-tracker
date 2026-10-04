"use client";
import { Users } from "lucide-react";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import {
  concentration,
  type BreakdownRow,
  type DollarSplit,
  type Mover,
} from "@/lib/accounting/profit-loss";
import { formatCents } from "@/lib/accounting/money";
import { SectionCard, type Drill } from "./report-kit";

const ZERO = BigInt(0);



const money = (value: bigint) => formatCents(value);

/* ------------------------------------------------------------------------ */
/* Every dollar earned                                                      */
/* ------------------------------------------------------------------------ */

/** Whole cents of each income dollar, rounded so the parts add to 100. */
function centsSplit(parts: bigint[], income: bigint): number[] {
  if (income <= ZERO) return parts.map(() => 0);
  const raw = parts.map((p) => Number((p * BigInt(10000)) / income) / 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, i) => [v - Math.floor(v), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

export function DollarCard({ split }: { split: DollarSplit }) {
  const { isHidden, showValue, hoverProps } = useMaskedHover();
  const { income, expense, payroll, other, result, loss } = split;
  const hide = isHidden && !showValue;
  const pct = (v: bigint, base: bigint) =>
    base > ZERO ? Number((v * BigInt(10000)) / base) / 100 : 0;
  // A loss is drawn against what went out: income covers part of the bar
  // and the hatched remainder is what it did not cover.
  const base = loss ? expense : income;
  const segments = [
    { key: "payroll", label: "Payroll", value: payroll, className: "bg-copper-strong" },
    { key: "other", label: "Other costs", value: other, className: "bg-copper/60" },
    ...(loss
      ? []
      : [{ key: "profit", label: "Profit", value: result, className: "bg-teal" }]),
  ].filter((s) => s.value > ZERO);
  const cents = centsSplit(
    [payroll, other, loss ? ZERO : result],
    income,
  );
  const ratio =
    income > ZERO
      ? (Number((expense * BigInt(100)) / income) / 100).toFixed(2)
      : null;
  const sentence =
    income <= ZERO
      ? "Nothing came in this period, so every expense is a loss."
      : loss
        ? `Expenses ran past income: for each $1.00 that came in, $${ratio} went out.`
        : `Of each $1.00 that came in, ${cents[2]} ${cents[2] === 1 ? "cent was" : "cents were"} left as profit.`;
  const label = hide
    ? "How income was spent, amounts hidden"
    : [
        ...segments.map(
          (s) => `${s.label} ${money(s.value)}, ${pct(s.value, base).toFixed(0)} percent`,
        ),
        ...(loss ? [`Loss ${money(result)}`] : []),
      ].join(", ");
  const hatch = {
    backgroundImage:
      "repeating-linear-gradient(135deg, var(--error) 0 2px, transparent 2px 6px)",
  };
  return (
    <SectionCard
      labelledBy="pl-dollar"
      title="Every dollar earned"
      description={hide ? "Hover to reveal the split." : sentence}
    >
      <div className="space-y-4 px-5 pb-5 lg:px-6 lg:pb-6" {...hoverProps}>
        <div
          role="img"
          aria-label={label}
          className="relative flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]"
        >
          {segments.map((s) => (
            <div
              key={s.key}
              className={cn("h-full animate-bar-fill", s.className)}
              style={{ width: `${pct(s.value, base)}%` }}
            />
          ))}
          {loss && (
            <div
              className="absolute inset-y-0 right-0 border-l-2 border-card"
              style={{ width: `${pct(result, base)}%`, ...hatch }}
            />
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
          {[
            ...segments.map((s) => ({
              ...s,
              // In a loss the bar is the costs, so each part reads as dollars
              // and a share of costs; otherwise as cents of each income dollar.
              big: loss
                ? money(s.value)
                : `${cents[s.key === "payroll" ? 0 : s.key === "other" ? 1 : 2]}¢`,
              small: loss
                ? `${pct(s.value, base).toFixed(0)}% of costs`
                : money(s.value),
            })),
            ...(loss
              ? [
                  {
                    key: "loss",
                    label: "Loss",
                    value: result,
                    className: "",
                    big: money(result),
                    small: `${pct(result, base).toFixed(0)}% not covered`,
                  },
                ]
              : []),
          ].map((s) => (
            <div key={s.key} className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", s.className)}
                  style={s.key === "loss" ? hatch : undefined}
                />
                {s.label}
              </dt>
              <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 tabular-nums">
                <span className="text-lg font-semibold">
                  <MaskedValue value={s.big} inheritHover />
                </span>
                <span className="text-xs text-muted-foreground">
                  <MaskedValue value={s.small} inheritHover />
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------------ */
/* Where income came from, where it went                                    */
/* ------------------------------------------------------------------------ */


export function ConcentrationNote({ rows }: { rows: BreakdownRow[] }) {
  const focus = concentration(rows);
  if (!focus) return null;
  return (
    <div className="mx-5 mb-5 flex gap-3 rounded-xl border border-border bg-[rgba(var(--ink),0.03)] p-3 text-sm lg:mx-6 lg:mb-6">
      <Users
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <p className="leading-relaxed">
        <span className="font-medium">
          {focus.count === 1 ? "One client" : "Two clients"} brought in{" "}
          <MaskedValue value={`${focus.share.toFixed(1)}%`} /> of income.
        </span>{" "}
        <span className="text-muted-foreground">
          {focus.count === 1
            ? "Losing them would take most of the revenue with them."
            : <>Losing the smaller of the two would cut income by <MaskedValue value={`${focus.smallest.toFixed(0)}%`} />.</>}
        </span>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* What changed                                                             */
/* ------------------------------------------------------------------------ */

export function ChangesList({
  movers,
  onDrill,
}: {
  movers: Mover[];
  onDrill: Drill;
}) {
  const { isHidden, showValue, hoverProps } = useMaskedHover();
  const hide = isHidden && !showValue;
  return (
    <ul
      className="grid gap-x-8 px-2.5 pb-3 sm:grid-cols-2 lg:px-3.5"
      {...hoverProps}
    >
      {movers.map((m) => (
        <li key={m.id} className="min-w-0">
          <button
            type="button"
            onClick={() => onDrill(m.label, m.filter)}
            className="flex w-full items-start justify-between gap-4 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm">{m.label}</span>
              <span className="block text-xs text-muted-foreground">
                {m.type === "income" ? "Income" : "Expense"}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span
                className={cn(
                  "block text-sm font-semibold",
                  !hide && m.tone === "good" && "text-success",
                  !hide && m.tone === "bad" && "text-error",
                )}
              >
                <MaskedValue
                  value={`${m.diff > ZERO ? "+" : ""}${money(m.diff)}`}
                  inheritHover
                />
              </span>
              <span className="block text-xs text-muted-foreground">
                <MaskedValue
                  value={`${money(m.previous)} to ${money(m.current)}`}
                  inheritHover
                />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */
/* The statement                                                            */
/* ------------------------------------------------------------------------ */


