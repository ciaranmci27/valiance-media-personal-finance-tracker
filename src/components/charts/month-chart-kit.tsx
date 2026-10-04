"use client";

import * as React from "react";
import { Tooltip } from "recharts";
import { cn } from "@/lib/utils";

/**
 * What every month-by-month report chart shares (profit and loss, balance
 * sheet): the frame that makes it keyboard readable (arrow keys walk the
 * months, the figures are announced, a screen-reader table carries them all),
 * the tooltip card in the app's style, bar sizing that keeps bars readable on
 * a phone, rounded bar ends and the axis conventions. Each chart supplies
 * only its Recharts series and the words for a month.
 */

export const MASK = "•••••";
export const CHART_MARGIN = { top: 12, right: 8, left: 0, bottom: 0 };
export const TICK = { fill: "var(--muted-foreground)", fontSize: 11 };
export const GRID_STROKE = "rgba(var(--ink), 0.08)";
export const ZERO_STROKE = "rgba(var(--ink), 0.22)";
export const COMPARE_FILL = "rgba(var(--ink), 0.2)";
export const NEGATIVE_FILL = "var(--error)";
const Y_AXIS = 56;
const Y_AXIS_NARROW = 44;

export const monthShort = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});
export const monthLong = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
export const dayShort = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
export const atDate = (date: string) => new Date(`${date}T00:00:00Z`);

/**
 * How many months each axis label covers: every month while they fit,
 * every second one on a phone past eight months, wider on long ranges.
 */
export function labelStep(count: number, narrow: boolean) {
  if (count > 18) return narrow ? 4 : 3;
  if (count > 12) return 2;
  return narrow && count > 8 ? 2 : 1;
}
/** Labels count back from the last month, so the newest is always named. */
export const labelShown = (index: number, count: number, step: number) =>
  (count - 1 - index) % step === 0;

/** Rounds the end of the bar away from zero, for gains and losses alike. */
export function RoundedBar(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  fillOpacity?: number;
  /** Round only the top end, for the lower segment of a stack. */
  flat?: boolean;
}) {
  const { x = 0, y = 0, width = 0, height = 0, fill, fillOpacity, flat } = props;
  if (!width || !height) return null;
  const down = height < 0;
  const top = down ? y + height : y,
    h = Math.abs(height),
    r = flat ? 0 : Math.min(4, width / 2, h);
  const path = down
    ? `M${x},${top} h${width} v${h - r} a${r},${r} 0 0 1 ${-r},${r} h${-(width - 2 * r)} a${r},${r} 0 0 1 ${-r},${-r} Z`
    : `M${x},${top + h} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${width - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} Z`;
  return <path d={path} fill={fill} fillOpacity={fillOpacity} />;
}

export interface TooltipRow {
  label: string;
  value: string;
  /** The series the chart is showing. */
  active?: boolean;
}
export interface MonthDetail {
  title: string;
  rows: TooltipRow[];
  /** Rows under a rule, e.g. the comparison. */
  footer?: TooltipRow[];
}

export function ChartTooltipCard({
  detail,
  show,
}: {
  detail: MonthDetail;
  show: boolean;
}) {
  const row = (r: TooltipRow) => (
    <div
      key={r.label}
      className="flex items-center justify-between gap-6 text-xs"
    >
      <dt
        className={cn(
          "text-muted-foreground",
          r.active && "font-medium text-foreground",
        )}
      >
        {r.label}
      </dt>
      <dd
        className={cn(
          "tabular-nums",
          r.active && "font-semibold",
          show && r.value.startsWith("-") && "text-error",
        )}
      >
        {show ? r.value : MASK}
      </dd>
    </div>
  );
  return (
    <div className="min-w-[200px] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-overlay)]">
      <p className="mb-2 text-sm font-medium">{detail.title}</p>
      <dl className="space-y-1">
        {detail.rows.map(row)}
        {detail.footer?.length ? (
          <div className="mt-1.5 space-y-1 border-t border-border pt-1.5">
            {detail.footer.map(row)}
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/** Bars take a fixed share of each month's band, so they stay bars on a phone. */
function barSizeFor(band: number, narrow: boolean, grouped: boolean) {
  if (!band) return undefined;
  const share = grouped ? (narrow ? 0.38 : 0.3) : narrow ? 0.62 : 0.48;
  return Math.round(
    Math.min(grouped ? 26 : 44, Math.max(narrow ? 7 : 6, band * share)),
  );
}

export interface ChartLayout {
  /** Keyboard-chosen month, or null while the pointer drives the tooltip. */
  focus: number | null;
  narrow: boolean;
  yAxis: number;
  barSize: number | undefined;
  /** The Recharts tooltip to place in the chart (absent while the keyboard drives). */
  tooltip: React.ReactNode;
}

/**
 * The focusable frame around a month chart. Arrow keys, Home and End walk
 * the months and show the same card the pointer does; the figures are
 * announced and listed in a screen-reader table.
 */
export function MonthChartFrame<T extends { month: string }>({
  data,
  title,
  show,
  grouped,
  describe,
  table,
  children,
}: {
  data: T[];
  /** What the chart shows, for its accessible name and table caption. */
  title: string;
  show: boolean;
  /** Two bars per month (a comparison beside the current figure). */
  grouped: boolean;
  describe: (point: T) => MonthDetail;
  table: { headers: string[]; cells: (point: T) => string[] };
  children: (layout: ChartLayout) => React.ReactNode;
}) {
  const [focus, setFocus] = React.useState<number | null>(null);
  const [width, setWidth] = React.useState(0);
  const observer = React.useRef<ResizeObserver | null>(null);
  const measure = React.useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    setWidth(node.clientWidth);
    observer.current = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.current.observe(node);
  }, []);
  React.useEffect(() => () => observer.current?.disconnect(), []);
  const narrow = width > 0 && width < 520;
  const yAxis = narrow ? Y_AXIS_NARROW : Y_AXIS;
  const band =
    width > 0
      ? (width - yAxis - CHART_MARGIN.right) / Math.max(1, data.length)
      : 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!data.length) return;
    const last = data.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? Math.min(last, (focus ?? -1) + 1)
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? Math.max(0, (focus ?? data.length) - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : e.key === "Escape"
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setFocus(next);
  };

  if (!data.length)
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        No months in this period
      </div>
    );

  const RechartsTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: { payload: T }[];
  }) =>
    active && payload?.length ? (
      <ChartTooltipCard detail={describe(payload[0].payload)} show={show} />
    ) : null;
  const focused = focus !== null ? data[focus] : null;
  const detail = focused ? describe(focused) : null;
  const announce = detail
    ? `${detail.title}. ${[...detail.rows, ...(detail.footer ?? [])]
        .map((r) => `${r.label} ${show ? r.value : "hidden"}`)
        .join(", ")}.`
    : "";

  return (
    <div className="w-full">
      <div
        ref={measure}
        role="group"
        tabIndex={0}
        aria-label={`${title}. Use the left and right arrow keys to read each month.`}
        onKeyDown={onKeyDown}
        onBlur={() => setFocus(null)}
        onMouseMove={() => focus !== null && setFocus(null)}
        className="relative h-[230px] w-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus-ring sm:h-[300px]"
      >
        {children({
          focus,
          narrow,
          yAxis,
          barSize: barSizeFor(band, narrow, grouped),
          tooltip:
            focus === null ? (
              <Tooltip
                content={<RechartsTooltip />}
                cursor={{ fill: "rgba(var(--ink), 0.05)" }}
                isAnimationActive={false}
                wrapperStyle={{ outline: "none", zIndex: 5 }}
              />
            ) : null,
        })}
        {detail && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-2 z-10"
            style={{
              left: `calc(${yAxis}px + (100% - ${yAxis + CHART_MARGIN.right}px) * ${(focus! + 0.5) / data.length})`,
              transform: `translateX(${focus === 0 ? "-12%" : focus === data.length - 1 ? "-88%" : "-50%"})`,
            }}
          >
            <ChartTooltipCard detail={detail} show={show} />
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {/* The wrapper is the sr-only box: a table ignores a 1px width and would widen the page. */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              {table.headers.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => {
              const [first, ...rest] = table.cells(d);
              return (
                <tr key={d.month}>
                  <th scope="row">{first}</th>
                  {rest.map((c, i) => (
                    <td key={i}>{show ? c : "Hidden"}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
