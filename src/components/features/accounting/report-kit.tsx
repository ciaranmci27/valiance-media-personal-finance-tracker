"use client";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  CircleAlert,
  Download,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  Minus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { cn } from "@/lib/utils";
import { usePrivacy } from "@/contexts/privacy-context";
import { formatCents } from "@/lib/accounting/money";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import {
  reportFilterSchema,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import {
  percentLabel,
  type BreakdownRow,
  type StatementRow,
} from "@/lib/accounting/profit-loss";
import type { ReportModel } from "@/lib/accounting/report-model";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { AccountingPicker } from "./accounting-picker";
import { countLabel, dateLabel, timestampLabel } from "./format";

/**
 * The pieces the redesigned reports share (profit and loss, balance sheet):
 * the address-bar filter, the controls-row chip, the scope notice, the
 * selectable metric tile, the section card and segmented control, the ranked
 * list that opens transactions, the export menu and the loading skeleton.
 */

const ZERO = BigInt(0);
const money = (value: bigint) => formatCents(value);
export type Drill = (title: string, filter: Partial<ReportFilter>) => void;

/** The filter in the address bar, or the default when it is absent or broken. */
export function readReportFilter(
  raw: string | null,
  fallback: ReportFilter,
): ReportFilter {
  try {
    const value = reportFilterSchema.parse(JSON.parse(raw ?? "null"));
    return {
      ...value,
      account_ids: undefined,
      account_types: undefined,
      cash_class: undefined,
      offset: 0,
    };
  } catch {
    /* A broken link must not change the report scope. */
  }
  return fallback;
}

/** Writes the filter to the address bar; the screen reads it back from there. */
export function writeReportFilter(filter: ReportFilter, replace = false) {
  const parsed = reportFilterSchema.safeParse(filter);
  if (!parsed.success) return;
  const url = new URL(window.location.href);
  url.searchParams.set("report_filter", JSON.stringify(parsed.data));
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

/** A picker sized as a chip for the controls row: muted name, then the choice. */
export function FilterChip({
  label,
  value,
  options,
  onChange,
  searchable = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  searchable?: boolean;
}) {
  const chosen =
    options.find((o) => o.value === value)?.label ?? options[0]?.label;
  return (
    <AccountingPicker
      ariaLabel={label}
      value={value}
      options={options}
      onChange={onChange}
      searchable={searchable}
      className="w-auto"
      triggerClassName="h-8 min-h-0 gap-1.5 rounded-lg border-0 bg-[rgba(var(--ink),0.045)] px-3 text-[13px] shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)] hover:bg-[rgba(var(--ink),0.08)]"
    >
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <span className="text-muted-foreground">{label}</span>
        <span className="max-w-[11rem] truncate font-medium">{chosen}</span>
      </span>
    </AccountingPicker>
  );
}

/**
 * What the report includes and leaves out: transactions awaiting review,
 * money still uncategorized, incomplete drafts. A period report counts the
 * uncategorized movement; a balance sheet counts the balance left in them.
 */
export function ScopeNotice({
  data,
  onReview,
  field = "period_cents",
}: {
  data: ReportData;
  onReview: () => void;
  field?: "period_cents" | "ending_cents";
}) {
  const working = data.filter.mode === "working";
  const awaiting = working
    ? data.quality.draft_count - data.quality.unbalanced_drafts
    : data.quality.draft_count;
  const uncategorized = working
    ? uncategorizedCents(
        data.accounts,
        (a) => a.purpose,
        (a) => a[field],
      )
    : ZERO;
  const parts: ReactNode[] = [];
  if (working && awaiting > 0)
    parts.push(
      `Includes ${countLabel(awaiting, "transaction")} awaiting review.`,
    );
  if (!working && awaiting > 0)
    parts.push(
      `${countLabel(awaiting, "transaction")} awaiting review ${awaiting === 1 ? "is" : "are"} not included.`,
    );
  if (uncategorized > ZERO)
    parts.push(
      <>
        <MaskedValue value={money(uncategorized)} /> is still uncategorized.
      </>,
    );
  if (working && data.quality.unbalanced_drafts > 0)
    parts.push(
      `${countLabel(data.quality.unbalanced_drafts, "incomplete transaction")} ${data.quality.unbalanced_drafts === 1 ? "is" : "are"} left out.`,
    );
  if (data.quality.uncategorized_lines > 0)
    parts.push(
      `${countLabel(data.quality.uncategorized_lines, "reviewed line")} still ${data.quality.uncategorized_lines === 1 ? "needs" : "need"} a category.`,
    );
  if (!parts.length) return null;
  return (
    <div
      role="status"
      className="glass-card flex items-center justify-between gap-3 rounded-xl px-4 py-3"
    >
      <p className="flex min-w-0 items-start gap-2.5 text-sm">
        <CircleAlert
          size={16}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warning"
        />
        <span>
          {parts.map((p, i) => (
            <span key={i}>
              {i > 0 && " "}
              {p}
            </span>
          ))}
        </span>
      </p>
      {(awaiting > 0 || uncategorized > ZERO) && (
        <Button variant="outline" size="sm" onClick={onReview}>
          Review
        </Button>
      )}
    </div>
  );
}

export type TileChange = { text: string; tone: "good" | "bad" | "flat" };

/** A selectable headline figure with its trend, driving the report's chart. */
export function MetricTile({
  label,
  value,
  negative,
  change,
  context,
  spark,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  negative: boolean;
  change: TileChange | null;
  context: string;
  spark: number[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { isHidden, isRevealed, showValue, hoverProps } = useMaskedHover();
  const hide = isHidden && !isRevealed;
  const [whole, cents] = value.includes(".") ? value.split(".") : [value, ""];
  const Icon =
    change?.tone === "flat" || hide
      ? Minus
      : change?.text.startsWith("-")
        ? TrendingDown
        : TrendingUp;
  const toneClass = hide
    ? "text-muted-foreground"
    : change?.tone === "good"
      ? "text-success"
      : change?.tone === "bad"
        ? "text-error"
        : "text-muted-foreground";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      {...hoverProps}
      className={cn(
        "glass-card glass-card-interactive relative flex min-w-0 flex-col rounded-xl p-4 text-left lg:p-5",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
      )}
    >
      {/* The glass rule owns box-shadow and border, so the selected ring is its own layer. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -inset-px rounded-xl transition-opacity",
          "bg-teal/[0.05] ring-[1.5px] ring-inset ring-teal/70",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground lg:text-sm">
          {label}
        </span>
        <Sparkline
          data={spark}
          width={64}
          height={20}
          className={cn(
            "hidden min-[400px]:block",
            selected ? "text-teal-light" : "text-muted-foreground/70",
          )}
        />
      </span>
      <span
        className={cn(
          "mt-1.5 text-xl font-semibold leading-none tracking-tight tabular-nums lg:text-[28px]",
          !hide && negative && "text-error",
        )}
      >
        {showValue ? (
          <>
            {whole}
            {cents && (
              <span className="text-[0.6em] font-medium text-muted-foreground">
                .{cents}
              </span>
            )}
          </>
        ) : (
          "•••••"
        )}
      </span>
      <span className="mt-3 flex min-h-4 items-start gap-1 text-xs">
        {change ? (
          <>
            <Icon
              size={12}
              aria-hidden="true"
              className={cn("mt-[2px] shrink-0", toneClass)}
            />
            <span className={cn("min-w-0 font-medium leading-snug", toneClass)}>
              {showValue ? change.text : "Change hidden"}
            </span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">{context}</span>
        )}
      </span>
    </button>
  );
}

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
          <h2 id={labelledBy} className="text-base font-semibold leading-tight">
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

export type RankedRow = BreakdownRow & {
  /** A logo or icon before the name. */
  icon?: ReactNode;
  /** A short note under the name, e.g. why a balance is negative. */
  hint?: string;
};

/**
 * Rows ranked by amount, each with a share and a bar, each opening its
 * transactions. A negative amount stays in the list in the error color with
 * its hint, rather than being dropped.
 */
export function RankedList({
  rows,
  tone,
  onDrill,
  empty,
}: {
  rows: RankedRow[];
  tone: "teal" | "copper";
  onDrill: Drill;
  empty: string;
}) {
  const abs = (v: bigint) => (v < ZERO ? -v : v);
  const max = rows.reduce((m, r) => (abs(r.amount) > m ? abs(r.amount) : m), ZERO);
  if (!rows.length)
    return (
      <p className="px-5 pb-6 text-sm text-muted-foreground lg:px-6">{empty}</p>
    );
  return (
    <ul className="space-y-0.5 px-2.5 pb-3 lg:px-3.5">
      {rows.map((r) => {
        const negative = r.amount < ZERO;
        const share =
          r.share !== 0 && Math.abs(r.share) < 0.1
            ? "<0.1%"
            : `${r.share.toFixed(1)}%`;
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-2">
              {r.icon}
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{r.label}</span>
                  {r.tag && (
                    <Badge size="sm" className="shrink-0">
                      {r.tag}
                    </Badge>
                  )}
                </span>
                {r.hint && (
                  <span className="block text-xs text-muted-foreground">
                    {r.hint}
                  </span>
                )}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 text-right text-sm tabular-nums",
                negative && "text-error",
              )}
            >
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
                  negative
                    ? "bg-error/60"
                    : tone === "teal"
                      ? "bg-teal"
                      : "bg-copper-strong",
                  r.key === "rest" && "opacity-50",
                )}
                style={{
                  width: `${max > ZERO ? Math.max(0.8, Number((abs(r.amount) * BigInt(1000)) / max) / 10) : 0}%`,
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

/**
 * A formal statement from the shared report model: section headings, lines
 * that open their transactions, a share column, and Comparison and Change
 * when comparing (green or red by whether the move is good for that side).
 */
export function StatementTable({
  model,
  rows,
  base,
  shareHeader,
  amountHeader = "Amount",
  currentHeader = "Current",
  detail,
  onDrill,
}: {
  model: ReportModel;
  rows: StatementRow[];
  /** What each line is a share of: income, or total assets. */
  base: bigint;
  shareHeader: string;
  amountHeader?: string;
  /** The amount column's name when a comparison sits beside it. */
  currentHeader?: string;
  detail: boolean;
  onDrill: Drill;
}) {
  const { isHidden } = usePrivacy();
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
    // Under privacy mode the color alone would say which way it moved.
    if (isHidden) return "text-muted-foreground";
    const diff = BigInt(r.values[2]);
    if (diff === ZERO) return "text-muted-foreground";
    const good = r.side === "expense" ? diff < ZERO : diff > ZERO;
    return good ? "text-success" : "text-error";
  };
  const share = (r: StatementRow) =>
    r.kind === "heading" ? null : (
      <span className="text-xs text-muted-foreground">
        <MaskedValue value={percentLabel(BigInt(r.values[0]), base) ?? "-"} />
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
      header: comparing ? currentHeader : amountHeader,
      align: "right",
      numeric: true,
      className: "py-2.5 whitespace-nowrap",
      render: (r) => amount(r, 0),
    },
    {
      key: "share",
      header: shareHeader,
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
  lead = [],
}: {
  data: ReportData;
  uncategorized: bigint;
  /** Checks that come first, e.g. whether the balance sheet balances. */
  lead?: { tone: "good" | "warn" | "none"; text: ReactNode }[];
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
    ...lead,
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

/** The footnotes, each bank account's reconciliation date and the feeds' last sync. */
export function CoverageDisclosure({
  data,
  notes,
  onReload,
}: {
  data: ReportData;
  notes: string[];
  onReload: () => void;
}) {
  return (
    <Disclosure
      summary="Data coverage & reconciliation"
      contentClassName="space-y-3 text-xs text-muted-foreground"
    >
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      <p>
        Reconciliation dates below are account-specific. A balanced ledger
        alone does not establish that all historical transactions have been
        imported.
      </p>
      {data.accounts
        .filter((a) => ["bank", "cash", "card"].includes(a.cash_kind))
        .map((a) => (
          <div
            key={a.id}
            className="flex justify-between gap-4 border-t border-border pt-2"
          >
            <span>{a.name}</span>
            <span>
              {dateLabel(
                data.quality.reconciliations.find((r) => r.account_id === a.id)
                  ?.through,
              ) || "Not yet reconciled"}
            </span>
          </div>
        ))}
      {data.quality.feeds.map((f, i) => (
        <div key={i} className="flex justify-between gap-4">
          <span>{f.name}</span>
          <span>
            {f.last_success_at
              ? `Last sync ${timestampLabel(f.last_success_at)}`
              : "No successful sync"}{" "}
            · {f.status}
          </span>
        </div>
      ))}
      <p>
        Report definition {data.definition_version} ·{" "}
        {data.filter.mode === "posted" ? "Reviewed only" : "All activity"}
      </p>
      <Button size="sm" variant="ghost" onClick={onReload}>
        <RefreshCw aria-hidden="true" />
        Refresh coverage
      </Button>
    </Disclosure>
  );
}

/** The header's Export menu: a branded PDF and a spreadsheet CSV. */
export function ExportMenu({
  label,
  disabled,
  exporting,
  demo,
  onExport,
}: {
  label: string;
  disabled: boolean;
  exporting: "csv" | "pdf" | null;
  demo: boolean;
  onExport: (format: "csv" | "pdf") => void;
}) {
  const unavailable = "Available with your own books";
  return (
    <RowActionsMenu
      label={label}
      align="end"
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !!exporting}
          aria-label="Export"
        >
          <Download aria-hidden="true" />
          {exporting ? `Preparing ${exporting.toUpperCase()}...` : "Export"}
          <ChevronDown aria-hidden="true" className="opacity-60" />
        </Button>
      }
      actions={[
        {
          label: "PDF",
          description: demo ? unavailable : "Branded statement for your accountant",
          icon: <FileText />,
          disabled: demo,
          onSelect: () => onExport("pdf"),
        },
        {
          label: "CSV",
          description: demo ? unavailable : "Every account, ready for a spreadsheet",
          icon: <FileSpreadsheet />,
          disabled: demo,
          onSelect: () => onExport("csv"),
        },
      ]}
    />
  );
}

/** Placeholders in the redesigned reports' shape: tiles, chart, a card, two cards. */
export function ReportSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-5 lg:space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass-card space-y-3 rounded-xl p-4 lg:p-5">
            <div className="flex justify-between">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="glass-card space-y-4 rounded-xl p-5 lg:p-6">
        <div className="flex justify-between">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-44 rounded-lg" />
        </div>
        <Skeleton className="h-[230px] w-full rounded-lg sm:h-[300px]" />
      </div>
      <div className="glass-card space-y-3 rounded-xl p-5 lg:p-6">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-3 w-full rounded-full" />
        <div className="flex gap-8">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
        {[0, 1].map((i) => (
          <div key={i} className="glass-card space-y-4 rounded-xl p-5 lg:p-6">
            <Skeleton className="h-5 w-48" />
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="space-y-1.5">
                <div className="flex justify-between">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3.5 w-20" />
                </div>
                <Skeleton className="h-1.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
