"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import {
  CHART_MARGIN,
  COMPARE_FILL,
  GRID_STROKE,
  MonthChartFrame,
  NEGATIVE_FILL,
  RoundedBar,
  TICK,
  ZERO_STROKE,
  atDate,
  dayShort,
  labelShown,
  labelStep,
  monthLong,
  monthShort,
  type MonthDetail,
} from "./month-chart-kit";

/**
 * The profit and loss chart: one metric month by month (or as a running
 * total), with the comparison period as faint bars beside it. The frame
 * (keyboard, tooltip, screen-reader table, phone bar sizes) is shared with
 * the balance sheet in month-chart-kit.
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

const COLORS: Record<ChartMetric, string> = {
  income: "var(--color-teal)",
  expense: "var(--copper-strong)",
  net: "var(--color-teal)",
  margin: "var(--color-teal)",
};

function percent(value: number) {
  return `${value.toFixed(1)}%`;
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

  const makeTick = (step: number) => function MonthTick({
    x,
    y,
    payload,
  }: {
    x?: number;
    y?: number;
    payload?: { value: string };
  }) {
    const index = data.findIndex((d) => d.month === payload?.value);
    const point = data[index];
    if (!payload || !point || !labelShown(index, data.length, step)) return <g />;
    const label = `${monthShort.format(atDate(payload.value))}${many && payload.value.slice(5, 7) === "01" ? ` ${payload.value.slice(2, 4)}` : ""}`;
    const sub = point.partial
      ? point.partial.from.slice(8) !== "01"
        ? `from ${dayShort.format(atDate(point.partial.from))}`
        : `to ${dayShort.format(atDate(point.partial.to))}`
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
  const monthTitle = (point: ProfitLossChartPoint) => {
    if (running) {
      const first = data[0];
      const start = dayShort.format(atDate(first.partial?.from ?? first.month));
      return `${start} to ${dayShort.format(atDate(lastDay(point)))}, ${point.month.slice(0, 4)}`;
    }
    return point.partial
      ? `${monthLong.format(atDate(point.month))}, ${dayShort.format(atDate(point.partial.from))} to ${dayShort.format(atDate(point.partial.to))}`
      : monthLong.format(atDate(point.month));
  };

  const describe = (point: ProfitLossChartPoint): MonthDetail => {
    const money = (v: bigint) => formatCents(v);
    const margin =
      point.income > BigInt(0)
        ? percent(Number((point.net * BigInt(1000)) / point.income) / 10)
        : "No income";
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
    const footer =
      !comparing
        ? []
        : compareMargin !== null
          ? [{ label: compareLabel, value: compareMargin }]
          : compareValue !== null
            ? [{ label: compareLabel, value: formatCents(compareValue) }]
            : [];
    return {
      title: monthTitle(point),
      rows: [
        { label: "Income", value: money(point.income), active: metric === "income" },
        { label: "Expenses", value: money(point.expense), active: metric === "expense" },
        { label: "Net profit", value: money(point.net), active: metric === "net" },
        { label: "Margin", value: margin, active: metric === "margin" },
      ],
      footer,
    };
  };

  return (
    <MonthChartFrame
      data={data}
      title={title}
      show={show}
      grouped={comparing}
      describe={describe}
      table={{
        headers: ["Month", currentLabel, ...(comparing ? [compareLabel] : [])],
        cells: (d) => [
          monthTitle(d),
          format(d.value),
          ...(comparing ? [format(d.compare)] : []),
        ],
      }}
    >
      {({ focus, narrow, yAxis, barSize, tooltip }) => (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={CHART_MARGIN}
            barGap={narrow ? 2 : 3}
            barSize={barSize}
            barCategoryGap={data.length > 18 ? "18%" : "26%"}
            maxBarSize={comparing ? 26 : 44}
          >
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={makeTick(labelStep(data.length, narrow))}
              height={hasPartial ? 36 : 24}
              interval={0}
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
            <ReferenceLine y={0} stroke={ZERO_STROKE} />
            {tooltip}
            {comparing && (
              <Bar
                dataKey="compare"
                name={compareLabel}
                fill={COMPARE_FILL}
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
                      ? NEGATIVE_FILL
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
      )}
    </MonthChartFrame>
  );
}
