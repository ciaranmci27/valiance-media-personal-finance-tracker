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
import type { OwnerMonth } from "@/lib/accounting/owner-activity";
import {
  CHART_MARGIN,
  COMPARE_FILL,
  GRID_STROKE,
  MonthChartFrame,
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
 * The owner activity chart, two bars a month. "flows": money put in beside
 * money taken out. "salary": salary through payroll beside money taken out.
 * "share": taken out so far beside profit so far, the running totals that
 * show whether draws are keeping pace with what the business earns.
 */

export type OwnerChartMode = "flows" | "salary" | "share";

const TEAL = "var(--color-teal)";
const COPPER = "var(--color-copper-strong)";
const dollars = (v: bigint | null) => (v === null ? 0 : Number(v) / 100);

export const OWNER_SERIES: Record<
  OwnerChartMode,
  { first: { label: string; swatch: string }; second: { label: string; swatch: string } }
> = {
  flows: {
    first: { label: "Put in", swatch: "bg-teal" },
    second: { label: "Taken out", swatch: "bg-copper-strong" },
  },
  salary: {
    first: { label: "Salary", swatch: "bg-teal" },
    second: { label: "Taken out", swatch: "bg-copper-strong" },
  },
  share: {
    first: { label: "Profit so far", swatch: "bg-[rgba(var(--ink),0.2)]" },
    second: { label: "Taken out so far", swatch: "bg-copper-strong" },
  },
};

export function OwnerActivityChart({
  data,
  mode,
  title,
  revealed,
  masked,
}: {
  data: OwnerMonth[];
  mode: OwnerChartMode;
  title: string;
  revealed: boolean;
  masked: boolean;
}) {
  const show = !masked || revealed;
  const series = OWNER_SERIES[mode];
  const pick = (d: OwnerMonth): [bigint | null, bigint] =>
    mode === "flows"
      ? [d.putIn, d.takenOut]
      : mode === "salary"
        ? [d.salary, d.takenOut]
        : [d.profitSoFar, d.takenSoFar];
  const rows = React.useMemo(
    () =>
      data.map((d) => {
        const [a, b] = pick(d);
        return { ...d, first: dollars(a), second: dollars(b) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, mode],
  );
  const monthTitle = (d: OwnerMonth) =>
    d.partial
      ? `${monthLong.format(atDate(d.month))}, ${dayShort.format(atDate(d.partial.from))} to ${dayShort.format(atDate(d.partial.to))}`
      : monthLong.format(atDate(d.month));
  const makeTick = (step: number) =>
    function MonthTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
      const index = data.findIndex((d) => d.month === payload?.value);
      const point = data[index];
      if (!payload || !point || !labelShown(index, data.length, step)) return <g />;
      const sub = point.partial
        ? point.partial.from.slice(8) !== "01"
          ? `from ${dayShort.format(atDate(point.partial.from))}`
          : `to ${dayShort.format(atDate(point.partial.to))}`
        : null;
      return (
        <g transform={`translate(${x},${y})`}>
          <text textAnchor="middle" dy={12} {...TICK}>
            {monthShort.format(atDate(payload.value))}
            {payload.value.slice(5, 7) === "01" && data.length > 12 ? ` ${payload.value.slice(2, 4)}` : ""}
          </text>
          {sub && (
            <text textAnchor="middle" dy={26} {...TICK} fontSize={10}>
              {sub}
            </text>
          )}
        </g>
      );
    };
  const value = (v: bigint | null) => (v === null ? "-" : formatCents(v));
  const describe = (d: OwnerMonth): MonthDetail => {
    const [a, b] = pick(d);
    return {
      title: monthTitle(d),
      rows: [
        { label: series.first.label, value: value(a), active: true },
        { label: series.second.label, value: value(b), active: true },
      ],
      footer: [{ label: "Profit this month", value: formatCents(d.profit) }],
    };
  };
  return (
    <MonthChartFrame
      data={data}
      title={title}
      show={show}
      grouped
      describe={describe}
      table={{
        headers: ["Month", series.first.label, series.second.label],
        cells: (d) => {
          const [a, b] = pick(d);
          return [monthTitle(d), value(a), value(b)];
        },
      }}
    >
      {({ focus, narrow, yAxis, barSize, tooltip }) => {
        const opacity = (i: number) =>
          (focus === null || focus === i ? 1 : 0.35) * (data[i].partial ? 0.75 : 1);
        return (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              margin={CHART_MARGIN}
              barGap={narrow ? 2 : 3}
              barSize={barSize}
              barCategoryGap={data.length > 18 ? "18%" : "26%"}
              maxBarSize={26}
            >
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis
                dataKey="month"
                axisLine={false}
                tickLine={false}
                tick={makeTick(labelStep(data.length, narrow))}
                height={data.some((d) => d.partial) ? 36 : 24}
                interval={0}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={TICK}
                width={yAxis}
                tickCount={5}
                allowDecimals={false}
                tickFormatter={(v: number) => (show ? formatCurrency(v, { compact: true }) : "•••")}
              />
              <ReferenceLine y={0} stroke={ZERO_STROKE} />
              {tooltip}
              <Bar
                dataKey="first"
                name={series.first.label}
                fill={mode === "share" ? COMPARE_FILL : TEAL}
                shape={<RoundedBar />}
                isAnimationActive={false}
              >
                {rows.map((d, i) => (
                  <Cell key={d.month} fillOpacity={opacity(i)} />
                ))}
              </Bar>
              <Bar
                dataKey="second"
                name={series.second.label}
                fill={COPPER}
                shape={<RoundedBar />}
                isAnimationActive={false}
              >
                {rows.map((d, i) => (
                  <Cell key={d.month} fillOpacity={opacity(i)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        );
      }}
    </MonthChartFrame>
  );
}
