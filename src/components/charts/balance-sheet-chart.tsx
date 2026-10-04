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
  monthShort,
  type MonthDetail,
} from "./month-chart-kit";

/**
 * Month-end balances for the balance sheet. Assets show as one bar per
 * month split into what is owed to others (copper, below) and what is the
 * owner's (teal, on top), so the bar's height is everything the business has
 * and the split is the equation itself. If equity ever falls below zero that
 * stack would lie, so the chart shows assets and liabilities side by side
 * instead. Liabilities, equity and cash position each show alone.
 */

export type BalanceMetric = "assets" | "liabilities" | "equity" | "cash";

export interface BalanceChartPoint {
  /** First of the month, YYYY-MM-DD. */
  month: string;
  /** The day the balance is taken: the month end, or the as-of date. */
  at: string;
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  cash: bigint;
}

const TEAL = "var(--color-teal)";
const COPPER = "var(--copper-strong)";
const dollars = (v: bigint) => Number(v) / 100;
const dateLong = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function BalanceSheetChart({
  data,
  metric,
  title,
  revealed,
  masked,
}: {
  data: BalanceChartPoint[];
  metric: BalanceMetric;
  title: string;
  revealed: boolean;
  masked: boolean;
}) {
  const show = !masked || revealed;
  const underwater = data.some((d) => d.equity < BigInt(0));
  const split = metric === "assets" && !underwater;
  const grouped = metric === "assets" && underwater;
  const rows = React.useMemo(
    () =>
      data.map((d) => ({
        ...d,
        owed: dollars(d.liabilities),
        yours: dollars(d.equity),
        has: dollars(d.assets),
        value: dollars(
          metric === "liabilities"
            ? d.liabilities
            : metric === "equity"
              ? d.equity
              : metric === "cash"
                ? d.cash
                : d.assets,
        ),
      })),
    [data, metric],
  );
  const monthEnd = (d: BalanceChartPoint) =>
    new Date(
      Date.UTC(Number(d.month.slice(0, 4)), Number(d.month.slice(5, 7)), 0),
    )
      .toISOString()
      .slice(0, 10);

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
    const january = payload.value.slice(5, 7) === "01";
    const short = point.at !== monthEnd(point);
    return (
      <g transform={`translate(${x},${y})`}>
        <text textAnchor="middle" dy={12} {...TICK}>
          {monthShort.format(atDate(payload.value))}
          {january ? ` ${payload.value.slice(2, 4)}` : ""}
        </text>
        {short && (
          <text textAnchor="middle" dy={26} {...TICK} fontSize={10}>
            {dayShort.format(atDate(point.at))}
          </text>
        )}
      </g>
    );
  };

  const describe = (d: BalanceChartPoint): MonthDetail => ({
    title: `Balance on ${dateLong.format(atDate(d.at))}`,
    rows: [
      { label: "Assets", value: formatCents(d.assets), active: metric === "assets" },
      { label: "Liabilities", value: formatCents(d.liabilities), active: metric === "liabilities" },
      { label: "Equity", value: formatCents(d.equity), active: metric === "equity" },
    ],
    footer: [
      { label: "Cash position", value: formatCents(d.cash), active: metric === "cash" },
    ],
  });

  const headers =
    metric === "assets"
      ? ["Month end", "Assets", "Liabilities", "Equity"]
      : ["Month end", title.split(",")[0]];
  return (
    <MonthChartFrame
      data={data}
      title={title}
      show={show}
      grouped={grouped}
      describe={describe}
      table={{
        headers,
        cells: (d) =>
          metric === "assets"
            ? [
                dateLong.format(atDate(d.at)),
                formatCents(d.assets),
                formatCents(d.liabilities),
                formatCents(d.equity),
              ]
            : [
                dateLong.format(atDate(d.at)),
                formatCents(
                  metric === "liabilities" ? d.liabilities : metric === "equity" ? d.equity : d.cash,
                ),
              ],
      }}
    >
      {({ focus, narrow, yAxis, barSize, tooltip }) => {
        const dim = (i: number) => (focus === null || focus === i ? 1 : 0.35);
        const partial = (i: number) =>
          data[i].at !== monthEnd(data[i]) ? 0.75 : 1;
        return (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              margin={CHART_MARGIN}
              barGap={narrow ? 2 : 3}
              barSize={barSize}
              barCategoryGap="26%"
              maxBarSize={grouped ? 26 : 44}
            >
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis
                dataKey="month"
                axisLine={false}
                tickLine={false}
                tick={makeTick(labelStep(data.length, narrow))}
                height={data.some((d) => d.at !== monthEnd(d)) ? 36 : 24}
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
              {split && (
                <Bar
                  dataKey="owed"
                  name="Owed to others"
                  stackId="assets"
                  fill={COPPER}
                  shape={<RoundedBar flat />}
                  isAnimationActive={false}
                >
                  {rows.map((d, i) => (
                    <Cell key={d.month} fillOpacity={dim(i) * partial(i)} />
                  ))}
                </Bar>
              )}
              {split && (
                <Bar
                  dataKey="yours"
                  name="Yours"
                  stackId="assets"
                  fill={TEAL}
                  shape={<RoundedBar />}
                  isAnimationActive={false}
                >
                  {rows.map((d, i) => (
                    <Cell key={d.month} fillOpacity={dim(i) * partial(i)} />
                  ))}
                </Bar>
              )}
              {grouped && (
                <Bar
                  dataKey="has"
                  name="Assets"
                  fill={TEAL}
                  shape={<RoundedBar />}
                  isAnimationActive={false}
                >
                  {rows.map((d, i) => (
                    <Cell key={d.month} fillOpacity={dim(i) * partial(i)} />
                  ))}
                </Bar>
              )}
              {grouped && (
                <Bar
                  dataKey="owed"
                  name="Liabilities"
                  fill={COPPER}
                  shape={<RoundedBar />}
                  isAnimationActive={false}
                >
                  {rows.map((d, i) => (
                    <Cell key={d.month} fillOpacity={dim(i) * partial(i)} />
                  ))}
                </Bar>
              )}
              {metric !== "assets" && (
                <Bar
                  dataKey="value"
                  name={title}
                  fill={metric === "liabilities" ? COPPER : TEAL}
                  shape={<RoundedBar />}
                  isAnimationActive={false}
                >
                  {rows.map((d, i) => (
                    <Cell
                      key={d.month}
                      fill={
                        d.value < 0
                          ? NEGATIVE_FILL
                          : metric === "liabilities"
                            ? COPPER
                            : TEAL
                      }
                      fillOpacity={dim(i) * partial(i)}
                    />
                  ))}
                </Bar>
              )}
            </BarChart>
          </ResponsiveContainer>
        );
      }}
    </MonthChartFrame>
  );
}

/** Whether the assets view falls back to side-by-side bars. */
export function assetsUnderwater(data: BalanceChartPoint[]) {
  return data.some((d) => d.equity < BigInt(0));
}
