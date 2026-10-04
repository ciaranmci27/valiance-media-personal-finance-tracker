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
 * The cash flow report's chart. Starting and ending cash show the balance at
 * each month's start or end. Cash in and out show each month's profit beside
 * its change in cash, which is the gap the report explains: a month can be
 * profitable while cash falls.
 */

export type CashMetric = "starting" | "in" | "out" | "ending";

export interface CashChartPoint {
  /** First of the month, YYYY-MM-DD. */
  month: string;
  /** The month's last day in the period. */
  at: string;
  starting: bigint;
  ending: bigint;
  change: bigint;
  profit: bigint;
  partial: { from: string; to: string } | null;
}

const TEAL = "var(--color-teal)";
const dollars = (v: bigint) => Number(v) / 100;

export function CashReportChart({
  data,
  metric,
  title,
  revealed,
  masked,
}: {
  data: CashChartPoint[];
  metric: CashMetric;
  title: string;
  revealed: boolean;
  masked: boolean;
}) {
  const show = !masked || revealed;
  const flows = metric === "in" || metric === "out";
  const rows = React.useMemo(
    () =>
      data.map((d) => ({
        ...d,
        balance: dollars(metric === "starting" ? d.starting : d.ending),
        cash: dollars(d.change),
        made: dollars(d.profit),
      })),
    [data, metric],
  );
  const monthTitle = (d: CashChartPoint) =>
    d.partial
      ? `${monthLong.format(atDate(d.month))}, ${dayShort.format(atDate(d.partial.from))} to ${dayShort.format(atDate(d.partial.to))}`
      : monthLong.format(atDate(d.month));
  const makeTick = (step: number) =>
    function MonthTick({
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
      const sub = point.partial
        ? point.partial.from.slice(8) !== "01"
          ? `from ${dayShort.format(atDate(point.partial.from))}`
          : `to ${dayShort.format(atDate(point.partial.to))}`
        : null;
      return (
        <g transform={`translate(${x},${y})`}>
          <text textAnchor="middle" dy={12} {...TICK}>
            {monthShort.format(atDate(payload.value))}
            {payload.value.slice(5, 7) === "01" && data.length > 12
              ? ` ${payload.value.slice(2, 4)}`
              : ""}
          </text>
          {sub && (
            <text textAnchor="middle" dy={26} {...TICK} fontSize={10}>
              {sub}
            </text>
          )}
        </g>
      );
    };
  const describe = (d: CashChartPoint): MonthDetail => ({
    title: monthTitle(d),
    rows: [
      { label: "Profit", value: formatCents(d.profit), active: flows },
      { label: "Change in cash", value: formatCents(d.change), active: flows },
    ],
    footer: [
      { label: "Cash at the start", value: formatCents(d.starting), active: metric === "starting" },
      { label: "Cash at the end", value: formatCents(d.ending), active: metric === "ending" },
    ],
  });
  return (
    <MonthChartFrame
      data={data}
      title={title}
      show={show}
      grouped={flows}
      describe={describe}
      table={{
        headers: flows
          ? ["Month", "Profit", "Change in cash"]
          : ["Month", metric === "starting" ? "Cash at the start" : "Cash at the end"],
        cells: (d) =>
          flows
            ? [monthTitle(d), formatCents(d.profit), formatCents(d.change)]
            : [monthTitle(d), formatCents(metric === "starting" ? d.starting : d.ending)],
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
              maxBarSize={flows ? 26 : 44}
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
                tickFormatter={(value: number) =>
                  show ? formatCurrency(value, { compact: true }) : "•••"
                }
              />
              <ReferenceLine y={0} stroke={ZERO_STROKE} />
              {tooltip}
              {flows && (
                <Bar
                  dataKey="made"
                  name="Profit"
                  fill={COMPARE_FILL}
                  shape={<RoundedBar />}
                  isAnimationActive={false}
                >
                  {rows.map((d, i) => (
                    <Cell key={d.month} fillOpacity={opacity(i)} />
                  ))}
                </Bar>
              )}
              <Bar
                dataKey={flows ? "cash" : "balance"}
                name={flows ? "Change in cash" : title}
                fill={TEAL}
                shape={<RoundedBar />}
                isAnimationActive={false}
              >
                {rows.map((d, i) => (
                  <Cell
                    key={d.month}
                    fill={(flows ? d.cash : d.balance) < 0 ? NEGATIVE_FILL : TEAL}
                    fillOpacity={opacity(i)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        );
      }}
    </MonthChartFrame>
  );
}
