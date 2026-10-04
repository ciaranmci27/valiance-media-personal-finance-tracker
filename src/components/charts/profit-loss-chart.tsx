"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { cn } from "@/lib/utils";

/**
 * The profit and loss chart: one metric month by month (or as a running
 * total), with the comparison period as faint bars beside it. Full width,
 * keyboard readable (arrow keys walk the months and the figures are
 * announced), with a screen-reader table and every figure masked under
 * privacy mode.
 */

export type ChartMetric = "income" | "expense" | "net" | "margin";

export interface ProfitLossChartPoint {
  /** First of the month, YYYY-MM-DD. */
  month: string;
  /** Dollars, or percent for margin; null when a margin has no income. */
  value: number | null;
  compare: number | null;
  /** Exact cents for the tooltip. */
  income: bigint;
  expense: bigint;
  net: bigint;
  compareIncome: bigint | null;
  compareExpense: bigint | null;
  compareNet: bigint | null;
  partial: { from: string; to: string } | null;
}

const MASK = "•••••";
const Y_AXIS = 56;
const Y_AXIS_NARROW = 44;
const MARGIN = { top: 12, right: 8, left: 0, bottom: 0 };
const COLORS: Record<ChartMetric, string> = {
  income: "var(--color-teal)",
  expense: "var(--copper-strong)",
  net: "var(--color-teal)",
  margin: "var(--color-teal)",
};
const NEGATIVE = "var(--error)";
const COMPARE = "rgba(var(--ink), 0.2)";
const TICK = { fill: "var(--muted-foreground)", fontSize: 11 };

const monthName = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});
const monthYear = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dayName = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const at = (date: string) => new Date(`${date}T00:00:00Z`);

function percent(value: number) {
  return `${value.toFixed(1)}%`;
}

/** Rounds the end of the bar away from zero, for gains and losses alike. */
function RoundedBar(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  fillOpacity?: number;
}) {
  const { x = 0, y = 0, width = 0, height = 0, fill, fillOpacity } = props;
  if (!width || !height) return null;
  const down = height < 0;
  const top = down ? y + height : y,
    h = Math.abs(height),
    r = Math.min(4, width / 2, h);
  const path = down
    ? `M${x},${top} h${width} v${h - r} a${r},${r} 0 0 1 ${-r},${r} h${-(width - 2 * r)} a${r},${r} 0 0 1 ${-r},${-r} Z`
    : `M${x},${top + h} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${width - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} Z`;
  return <path d={path} fill={fill} fillOpacity={fillOpacity} />;
}

export function ProfitLossChart({
  data,
  metric,
  title,
  comparing,
  currentLabel,
  compareLabel,
  revealed,
  masked,
  running = false,
}: {
  data: ProfitLossChartPoint[];
  metric: ChartMetric;
  /** What the chart shows, for its accessible name. */
  title: string;
  comparing: boolean;
  currentLabel: string;
  compareLabel: string;
  /** The card is hovered while privacy mode is on. */
  revealed: boolean;
  masked: boolean;
  /** Values are totals from the first month through each month. */
  running?: boolean;
}) {
  const show = !masked || revealed;
  const [focus, setFocus] = React.useState<number | null>(null);
  // The plot's width decides the bar size: on a phone, percentage gaps alone
  // leave hairline bars, so bars take a fixed share of each month's band.
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
  const band = width > 0 ? (width - yAxis - MARGIN.right) / Math.max(1, data.length) : 0;
  const barSize = band
    ? Math.round(
        Math.min(
          comparing ? 26 : 44,
          Math.max(narrow ? 7 : 6, band * (comparing ? (narrow ? 0.38 : 0.3) : narrow ? 0.62 : 0.48)),
        ),
      )
    : undefined;
  const isPercent = metric === "margin";
  const color = COLORS[metric];
  const format = (v: number | null) =>
    v === null ? "No income" : isPercent ? percent(v) : formatCurrency(v);
  const hasPartial = data.some((d) => d.partial);
  const marginAxis = React.useMemo(() => {
    if (!isPercent) return null;
    const values = data.flatMap((d) => [d.value ?? 0, d.compare ?? 0]);
    const low = Math.max(-100, Math.min(0, ...values));
    const high = Math.min(100, Math.max(25, ...values));
    const step = high - low > 100 ? 50 : 25;
    const ticks: number[] = [];
    for (let v = Math.floor(low / step) * step; v < high + step; v += step) {
      ticks.push(v);
      if (v >= high) break;
    }
    return ticks;
  }, [data, isPercent]);
  const many = data.length > 12;

  const tick = ({
    x,
    y,
    payload,
  }: {
    x?: number;
    y?: number;
    payload?: { value: string };
  }) => {
    // Ticks skip months on long ranges, so match by month, not position.
    const point = data.find((d) => d.month === payload?.value);
    if (!payload || !point) return <g />;
    const label = `${monthName.format(at(payload.value))}${many && payload.value.slice(5, 7) === "01" ? ` ${payload.value.slice(2, 4)}` : ""}`;
    const sub = point.partial
      ? point.partial.from.slice(8) !== "01"
        ? `from ${dayName.format(at(point.partial.from))}`
        : `to ${dayName.format(at(point.partial.to))}`
      : null;
    return (
      <g transform={`translate(${x},${y})`}>
        <text textAnchor="middle" dy={12} {...TICK}>
          {label}
        </text>
        {sub && (
          <text textAnchor="middle" dy={26} {...TICK} fontSize={10}>
            {sub}
          </text>
        )}
      </g>
    );
  };

  const details = (point: ProfitLossChartPoint) => {
    const money = (v: bigint | null) => (v === null ? "-" : formatCents(v));
    const rows: [string, string, boolean][] = [
      ["Income", money(point.income), metric === "income"],
      ["Expenses", money(point.expense), metric === "expense"],
      ["Net profit", money(point.net), metric === "net"],
    ];
    const margin =
      point.income > BigInt(0)
        ? percent(Number((point.net * BigInt(1000)) / point.income) / 10)
        : "No income";
    rows.push(["Margin", margin, metric === "margin"]);
    const compareValue =
      metric === "income"
        ? point.compareIncome
        : metric === "expense"
          ? point.compareExpense
          : metric === "net"
            ? point.compareNet
            : null;
    const compareMargin =
      metric === "margin" && point.compareIncome !== null
        ? point.compareIncome > BigInt(0)
          ? percent(
              Number((point.compareNet! * BigInt(1000)) / point.compareIncome) /
                10,
            )
          : "No income"
        : null;
    return { rows, compareValue, compareMargin };
  };

  /** Where a month ends inside the period: its last day, or the period end. */
  const lastDay = (point: ProfitLossChartPoint) =>
    point.partial?.to ??
    new Date(
      Date.UTC(
        Number(point.month.slice(0, 4)),
        Number(point.month.slice(5, 7)),
        0,
      ),
    )
      .toISOString()
      .slice(0, 10);
  const title_ = (point: ProfitLossChartPoint) => {
    if (running) {
      const first = data[0];
      const start = dayName.format(at(first.partial?.from ?? first.month));
      return `${start} to ${dayName.format(at(lastDay(point)))}, ${point.month.slice(0, 4)}`;
    }
    return point.partial
      ? `${monthYear.format(at(point.month))}, ${dayName.format(at(point.partial.from))} to ${dayName.format(at(point.partial.to))}`
      : monthYear.format(at(point.month));
  };

  const TooltipCard = ({ point }: { point: ProfitLossChartPoint }) => {
    const { rows, compareValue, compareMargin } = details(point);
    return (
      <div className="min-w-[200px] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-overlay)]">
        <p className="mb-2 text-sm font-medium">{title_(point)}</p>
        <dl className="space-y-1">
          {rows.map(([label, value, active]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-6 text-xs"
            >
              <dt
                className={cn(
                  "text-muted-foreground",
                  active && "font-medium text-foreground",
                )}
              >
                {label}
              </dt>
              <dd
                className={cn(
                  "tabular-nums",
                  active && "font-semibold",
                  show && value.startsWith("-") && "text-error",
                )}
              >
                {show ? value : MASK}
              </dd>
            </div>
          ))}
          {comparing && compareMargin !== null && (
            <div className="mt-1.5 flex items-center justify-between gap-6 border-t border-border pt-1.5 text-xs">
              <dt className="text-muted-foreground">{compareLabel}</dt>
              <dd className="tabular-nums">{show ? compareMargin : MASK}</dd>
            </div>
          )}
          {comparing && compareValue !== null && (
            <div className="mt-1.5 flex items-center justify-between gap-6 border-t border-border pt-1.5 text-xs">
              <dt className="text-muted-foreground">{compareLabel}</dt>
              <dd className="tabular-nums">
                {show ? formatCents(compareValue) : MASK}
              </dd>
            </div>
          )}
        </dl>
      </div>
    );
  };

  const RechartsTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: { payload: ProfitLossChartPoint }[];
  }) =>
    active && payload?.length ? <TooltipCard point={payload[0].payload} /> : null;

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

  const focused = focus !== null ? data[focus] : null;
  const announce = focused
    ? `${title_(focused)}. ${details(focused)
        .rows.map(([label, value]) => `${label} ${show ? value : "hidden"}`)
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
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={MARGIN}
            barGap={narrow ? 2 : 3}
            barSize={barSize}
            barCategoryGap={data.length > 18 ? "18%" : "26%"}
            maxBarSize={comparing ? 26 : 44}
          >
            <CartesianGrid
              vertical={false}
              stroke="rgba(var(--ink), 0.08)"
              strokeDasharray="0"
            />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={tick}
              height={hasPartial ? 36 : 24}
              interval={data.length > 18 ? 2 : data.length > 12 ? 1 : 0}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={TICK}
              width={yAxis}
              tickCount={5}
              allowDecimals={false}
              // A margin can fall far below zero in a thin month; past -100%
              // the bar runs off the axis and the tooltip carries the figure.
              {...(marginAxis
                ? {
                    domain: [marginAxis[0], marginAxis[marginAxis.length - 1]],
                    ticks: marginAxis,
                    allowDataOverflow: true,
                  }
                : {})}
              tickFormatter={(value: number) =>
                show
                  ? isPercent
                    ? `${Math.round(value)}%`
                    : formatCurrency(value, { compact: true })
                  : "•••"
              }
            />
            <ReferenceLine y={0} stroke="rgba(var(--ink), 0.22)" />
            {focus === null && (
              <Tooltip
                content={<RechartsTooltip />}
                cursor={{ fill: "rgba(var(--ink), 0.05)" }}
                isAnimationActive={false}
                wrapperStyle={{ outline: "none", zIndex: 5 }}
              />
            )}
            {comparing && (
              <Bar
                dataKey="compare"
                name={compareLabel}
                fill={COMPARE}
                shape={<RoundedBar />}
                isAnimationActive={false}
              >
                {data.map((d, i) => (
                  <Cell
                    key={d.month}
                    fillOpacity={focus === null || focus === i ? 1 : 0.5}
                  />
                ))}
              </Bar>
            )}
            <Bar
              dataKey="value"
              name={currentLabel}
              fill={color}
              shape={<RoundedBar />}
              isAnimationActive={false}
            >
              {data.map((d, i) => (
                <Cell
                  key={d.month}
                  fill={
                    (metric === "net" || metric === "margin") &&
                    (d.value ?? 0) < 0
                      ? NEGATIVE
                      : color
                  }
                  fillOpacity={
                    focus === null || focus === i ? (d.partial ? 0.7 : 1) : 0.35
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {focused && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-2 z-10"
            style={{
              left: `calc(${yAxis}px + (100% - ${yAxis + MARGIN.right}px) * ${(focus! + 0.5) / data.length})`,
              transform: `translateX(${focus === 0 ? "-12%" : focus === data.length - 1 ? "-88%" : "-50%"})`,
            }}
          >
            <TooltipCard point={focused} />
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
            <th scope="col">Month</th>
            <th scope="col">{currentLabel}</th>
            {comparing && <th scope="col">{compareLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <th scope="row">{title_(d)}</th>
              <td>{show ? format(d.value) : "Hidden"}</td>
              {comparing && <td>{show ? format(d.compare) : "Hidden"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
