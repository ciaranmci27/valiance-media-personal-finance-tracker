"use client";
import type { ReactNode } from "react";
import { ArrowUpRight, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import type { ReportData, ReportFilter } from "@/lib/accounting/reports";
import type { ReportModel } from "@/lib/accounting/report-model";
import {
  concentration,
  percentLabel,
  type BreakdownRow,
  type DollarSplit,
  type Mover,
  type StatementRow,
} from "@/lib/accounting/profit-loss";
import { formatCents } from "@/lib/accounting/money";
import { countLabel, dateLabel, timestampLabel } from "./format";

const ZERO = BigInt(0);
type Drill = (title: string, filter: Partial<ReportFilter>) => void;

/** The card frame every section shares: a title row, then content. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  labelledBy,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  labelledBy: string;
}) {
  return (
    <Card
      className={cn("flex min-w-0 flex-col", className)}
      role="region"
      aria-labelledby={labelledBy}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5 pb-3 lg:p-6 lg:pb-4">
        <div className="min-w-0">
          <h2
            id={labelledBy}
            className="text-base font-semibold leading-tight"
          >
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** Two or three options in the app's segmented control. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("seg-track seg-sm", className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("seg-item", value === o.value && "is-active")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

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

export function BreakdownList({
  rows,
  tone,
  onDrill,
  empty,
}: {
  rows: BreakdownRow[];
  tone: "income" | "expense";
  onDrill: Drill;
  empty: string;
}) {
  const max = rows.reduce((m, r) => (r.amount > m ? r.amount : m), ZERO);
  if (!rows.length)
    return (
      <p className="px-5 pb-6 text-sm text-muted-foreground lg:px-6">{empty}</p>
    );
  return (
    <ul className="space-y-0.5 px-2.5 pb-3 lg:px-3.5">
      {rows.map((r) => {
        const share = r.share < 0.1 && r.share > 0 ? "<0.1%" : `${r.share.toFixed(1)}%`;
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm">{r.label}</span>
              {r.tag && (
                <Badge size="sm" className="shrink-0">
                  {r.tag}
                </Badge>
              )}
            </span>
            <span className="shrink-0 text-right text-sm tabular-nums">
              <MaskedValue value={money(r.amount)} />
              <span className="ml-2 inline-block w-12 text-xs text-muted-foreground">
                <MaskedValue value={share} />
              </span>
            </span>
            <span
              aria-hidden="true"
              className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[rgba(var(--ink),0.06)]"
            >
              <span
                className={cn(
                  "block h-full rounded-full animate-bar-fill",
                  tone === "income" ? "bg-teal" : "bg-copper-strong",
                  r.key === "rest" && "opacity-50",
                )}
                style={{
                  width: `${max > ZERO ? Math.max(0.8, Number((r.amount * BigInt(1000)) / max) / 10) : 0}%`,
                }}
              />
            </span>
          </>
        );
        const layout =
          "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-lg px-2.5 py-2";
        return (
          <li key={r.key}>
            {r.filter ? (
              <button
                type="button"
                onClick={() => onDrill(r.label, r.filter!)}
                className={cn(
                  layout,
                  "text-left transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
                )}
              >
                {body}
                <span className="sr-only">, show transactions</span>
              </button>
            ) : (
              <div className={layout}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

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

export function StatementTable({
  model,
  rows,
  income,
  detail,
  onDrill,
}: {
  model: ReportModel;
  rows: StatementRow[];
  income: bigint;
  detail: boolean;
  onDrill: Drill;
}) {
  const comparing = model.comparison;
  const shown = rows.filter((r) => detail || r.kind !== "account");
  const amount = (r: StatementRow, i: number) =>
    r.kind === "heading" ? null : (
      <MaskedValue
        value={
          i === 2 && BigInt(r.values[2]) > ZERO
            ? `+${money(BigInt(r.values[2]))}`
            : money(BigInt(r.values[i]))
        }
        className="whitespace-nowrap tabular-nums"
      />
    );
  const changeClass = (r: StatementRow) => {
    if (r.kind === "heading" || !comparing) return undefined;
    const diff = BigInt(r.values[2]);
    if (diff === ZERO) return "text-muted-foreground";
    const good = r.side === "expense" ? diff < ZERO : diff > ZERO;
    return good ? "text-success" : "text-error";
  };
  const share = (r: StatementRow) =>
    r.kind === "heading" ? null : (
      <span className="text-xs text-muted-foreground">
        <MaskedValue value={percentLabel(BigInt(r.values[0]), income) ?? "-"} />
      </span>
    );
  const drill = (r: StatementRow) => r.detail?.[0] ?? r.entryFilter;
  const label = (r: StatementRow, mobile = false) => {
    if (r.kind === "heading")
      return (
        <span
          className={cn(
            r.label === r.section
              ? "text-[11px] font-semibold uppercase tracking-[0.12em] text-teal-light"
              : "text-sm font-medium text-muted-foreground",
          )}
        >
          {r.label}
        </span>
      );
    const filter = drill(r);
    const text = (
      <span
        className={cn(
          !mobile && r.kind === "account" && "pl-3",
          !mobile && r.indent && "pl-6",
          r.kind !== "account" && "font-semibold",
        )}
      >
        {r.label}
      </span>
    );
    return filter ? (
      <button
        type="button"
        onClick={() => onDrill(r.label, filter)}
        className="group inline-flex items-center gap-1.5 rounded-sm text-left hover:text-teal-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {text}
        <ArrowUpRight
          size={12}
          aria-hidden="true"
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
        <span className="sr-only">, show transactions</span>
      </button>
    ) : (
      text
    );
  };
  const columns: DataTableColumn<StatementRow>[] = [
    {
      key: "label",
      header: "Account",
      className: "py-2.5",
      render: label,
    },
    {
      key: "amount",
      header: comparing ? "Current" : "Amount",
      align: "right",
      numeric: true,
      className: "py-2.5 whitespace-nowrap",
      render: (r) => amount(r, 0),
    },
    {
      key: "share",
      header: "% of income",
      align: "right",
      className: "w-28 py-2.5 whitespace-nowrap",
      render: share,
    },
    ...(comparing
      ? [
          {
            key: "compare",
            header: "Comparison",
            align: "right" as const,
            numeric: true,
            className: "py-2.5 whitespace-nowrap",
            render: (r: StatementRow) => amount(r, 1),
          },
          {
            key: "change",
            header: "Change",
            align: "right" as const,
            numeric: true,
            className: "py-2.5 whitespace-nowrap",
            render: (r: StatementRow) => (
              <span className={changeClass(r)}>{amount(r, 2)}</span>
            ),
          },
        ]
      : []),
  ];
  const rowClass = (r: StatementRow) =>
    r.kind === "heading"
      ? "border-b-0 [&>td]:pt-5 [&>td]:pb-1.5 hover:bg-transparent"
      : r.kind === "total"
        ? "bg-teal/[0.11] font-semibold"
        : r.kind === "subtotal"
          ? "border-t border-[rgba(var(--ink),0.16)]"
          : undefined;
  return (
    <DataTable
      className="lg:[&_td:first-child]:pl-6 lg:[&_td:last-child]:pr-6 lg:[&_th:first-child]:pl-6 lg:[&_th:last-child]:pr-6"
      columns={columns}
      data={shown}
      keyExtractor={(r) => r.key}
      framed={false}
      rowClassName={rowClass}
      onRowClick={(r) => {
        const filter = drill(r);
        if (filter && r.kind !== "heading") onDrill(r.label, filter);
      }}
      emptyState="No income or expense activity in this period."
      mobileCard={(r) =>
        r.kind === "heading" ? (
          <div className="pt-2">{label(r)}</div>
        ) : (
          <div
            className={cn(
              r.kind === "total" && "-mx-4 -my-3 bg-teal/[0.11] px-4 py-3",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm">{label(r, true)}</div>
              <div
                className={cn(
                  "flex shrink-0 items-baseline gap-2 text-right text-sm",
                  r.kind !== "account" && "font-semibold",
                )}
              >
                {share(r)}
                {amount(r, 0)}
              </div>
            </div>
            {comparing && (
              <dl className="mt-2 flex justify-between gap-3 text-xs text-muted-foreground">
                <div className="flex gap-1.5">
                  <dt>Comparison</dt>
                  <dd>{amount(r, 1)}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>Change</dt>
                  <dd className={changeClass(r)}>{amount(r, 2)}</dd>
                </div>
              </dl>
            )}
          </div>
        )
      }
    />
  );
}

/** One line about how complete the numbers are: review, categories, banks, feeds. */
export function HealthLine({
  data,
  uncategorized,
}: {
  data: ReportData;
  uncategorized: bigint;
}) {
  const working = data.filter.mode === "working";
  const awaiting = working
    ? data.quality.draft_count - data.quality.unbalanced_drafts
    : data.quality.draft_count;
  const banks = data.accounts.filter((a) =>
    ["bank", "cash", "card"].includes(a.cash_kind),
  );
  const through = banks.map(
    (a) =>
      data.quality.reconciliations.find((r) => r.account_id === a.id)?.through ??
      null,
  );
  const reconciled = through.filter((d): d is string => !!d);
  const covered = reconciled.filter((d) => d >= data.filter.to).length;
  const lastSync = data.quality.feeds
    .map((f) => f.last_success_at)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  const items: { tone: "good" | "warn" | "none"; text: ReactNode }[] = [
    awaiting > 0
      ? {
          tone: "warn",
          text: `${countLabel(awaiting, "transaction")} awaiting review${working ? " (included)" : " (not included)"}`,
        }
      : { tone: "good", text: "Every transaction reviewed" },
    ...(data.quality.uncategorized_lines > 0 || uncategorized > ZERO
      ? [
          {
            tone: "warn" as const,
            text:
              uncategorized > ZERO ? (
                <>
                  <MaskedValue value={money(uncategorized)} /> uncategorized
                </>
              ) : (
                `${countLabel(data.quality.uncategorized_lines, "line")} need a category`
              ),
          },
        ]
      : []),
    ...(banks.length
      ? [
          reconciled.length === 0
            ? { tone: "none" as const, text: "No bank account reconciled yet" }
            : covered === banks.length
              ? {
                  tone: "good" as const,
                  text: "Every bank account reconciled through the period",
                }
              : {
                  tone: "none" as const,
                  text: `${reconciled.length} of ${banks.length} bank accounts reconciled, latest through ${dateLabel(reconciled.sort().at(-1))}`,
                },
        ]
      : []),
    ...(lastSync
      ? [{ tone: "none" as const, text: `Bank feeds synced ${timestampLabel(lastSync)}` }]
      : []),
  ];
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              item.tone === "good"
                ? "bg-success"
                : item.tone === "warn"
                  ? "bg-warning"
                  : "bg-[rgba(var(--ink),0.3)]",
            )}
          />
          {item.text}
        </li>
      ))}
    </ul>
  );
}
