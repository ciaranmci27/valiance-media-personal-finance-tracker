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
import type { ContactMonth } from "@/lib/accounting/contact-report";
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
 * The contact reports' chart. "amount" stacks each month's total by the
 * biggest contacts with everyone else on top; "count", "share" and
 * "average" show how many contacts paid, the top contact's share of the
 * month, and the money per paying contact; "extra" is a money series the
 * page brings (spending with payees that charge on a schedule).
 */

export type ContactMetric = "amount" | "count" | "share" | "average" | "extra";

/** The stacked contacts' fills, biggest first, and the matching legend swatches. */
export const STACK_FILLS = [
  "var(--color-teal)",
  "var(--color-copper-strong)",
  "color-mix(in srgb, var(--color-teal) 50%, transparent)",
  "color-mix(in srgb, var(--color-copper-strong) 55%, transparent)",
];
export const STACK_SWATCHES = [
  "bg-teal",
  "bg-copper-strong",
  "bg-teal/50",
  "bg-copper-strong/55",
];
export const REST_SWATCH = "bg-[rgba(var(--ink),0.2)]";

const TEAL = "var(--color-teal)";
const dollars = (v: bigint) => Number(v) / 100;

export function ContactReportChart({
  data,
  stack,
  metric,
  title,
  labels,
  extra,
  revealed,
  masked,
}: {
  data: ContactMonth[];
  stack: { id: string; name: string }[];
  metric: ContactMetric;
  title: string;
  /** How the count and average series are named: "Paying clients", "Per paying client". */
  labels: { count: string; average: string };
  /** The "extra" series: one value per month, null where unknown. */
  extra?: { label: string; values: (bigint | null)[] };
  revealed: boolean;
  masked: boolean;
}) {
  const show = !masked || revealed;
  const rows = React.useMemo(
    () =>
      data.map((d, i) => ({
        ...d,
        ...Object.fromEntries(d.stacked.map((v, i) => [`s${i}`, dollars(v)])),
        restValue: dollars(d.rest),
        count: d.paying ?? 0,
        share: d.topShare ?? 0,
        averageValue: d.average === null ? 0 : dollars(d.average),
        extraValue: extra?.values[i] == null ? 0 : dollars(extra.values[i]!),
      })),
    [data, extra],
  );
  const monthTitle = (d: ContactMonth) =>
    d.partial
      ? `${monthLong.format(atDate(d.month))}, ${dayShort.format(atDate(d.partial.from))} to ${dayShort.format(atDate(d.partial.to))}`
      : monthLong.format(atDate(d.month));
  const percent = (v: number | null) => (v === null ? "-" : `${v.toFixed(1)}%`);
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
  const extraAt = (d: ContactMonth) => {
    const v = extra?.values[data.indexOf(d)];
    return v === null || v === undefined ? "-" : formatCents(v);
  };
  // The one series every metric but "amount" shows: its name and a month's value.
  const singleLabel =
    metric === "extra"
      ? (extra?.label ?? "")
      : metric === "count"
        ? labels.count
        : metric === "share"
          ? `${stack[0]?.name ?? "Top"}'s share`
          : labels.average;
  const singleValue = (d: ContactMonth) =>
    metric === "extra"
      ? extraAt(d)
      : metric === "count"
        ? d.paying === null
          ? "-"
          : String(d.paying)
        : metric === "share"
          ? percent(d.topShare)
          : d.average === null
            ? "-"
            : formatCents(d.average);
  const describe = (d: ContactMonth): MonthDetail => ({
    title: monthTitle(d),
    rows:
      metric === "amount"
        ? [
            ...stack.map((s, i) => ({ label: s.name, value: formatCents(d.stacked[i]) })),
            { label: "Everyone else", value: formatCents(d.rest) },
          ]
        : [{ label: singleLabel, value: singleValue(d), active: true }],
    footer: [{ label: "Total", value: formatCents(d.total), active: metric === "amount" }],
  });
  const table =
    metric === "amount"
      ? {
          headers: ["Month", ...stack.map((s) => s.name), "Everyone else", "Total"],
          cells: (d: ContactMonth) => [
            monthTitle(d),
            ...d.stacked.map((v) => formatCents(v)),
            formatCents(d.rest),
            formatCents(d.total),
          ],
        }
      : {
          headers: ["Month", singleLabel],
          cells: (d: ContactMonth) => [monthTitle(d), singleValue(d)],
        };
  const tickFormat = (value: number) =>
    !show
      ? "•••"
      : metric === "count"
        ? String(value)
        : metric === "share"
          ? `${value}%`
          : formatCurrency(value, { compact: true });
  return (
    <MonthChartFrame
      data={data}
      title={title}
      show={show}
      grouped={false}
      describe={describe}
      table={table}
    >
      {({ focus, narrow, yAxis, barSize, tooltip }) => {
        const opacity = (i: number) =>
          (focus === null || focus === i ? 1 : 0.35) * (data[i].partial ? 0.75 : 1);
        return (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              margin={CHART_MARGIN}
              barSize={barSize}
              barCategoryGap={data.length > 18 ? "18%" : "26%"}
              maxBarSize={44}
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
                domain={metric === "share" ? [0, 100] : undefined}
                tickFormatter={tickFormat}
              />
              <ReferenceLine y={0} stroke={ZERO_STROKE} />
              {tooltip}
              {metric === "amount" ? (
                [
                  ...stack.map((s, i) => (
                    <Bar
                      key={s.id}
                      dataKey={`s${i}`}
                      name={s.name}
                      stackId="contacts"
                      fill={STACK_FILLS[i]}
                      shape={<RoundedBar flat />}
                      isAnimationActive={false}
                    >
                      {rows.map((d, j) => (
                        <Cell key={d.month} fillOpacity={opacity(j)} />
                      ))}
                    </Bar>
                  )),
                  <Bar
                    key="rest"
                    dataKey="restValue"
                    name="Everyone else"
                    stackId="contacts"
                    fill={COMPARE_FILL}
                    shape={<RoundedBar />}
                    isAnimationActive={false}
                  >
                    {rows.map((d, j) => (
                      <Cell key={d.month} fillOpacity={opacity(j)} />
                    ))}
                  </Bar>,
                ]
              ) : (
                <Bar
                  dataKey={
                    metric === "count"
                      ? "count"
                      : metric === "share"
                        ? "share"
                        : metric === "extra"
                          ? "extraValue"
                          : "averageValue"
                  }
                  name={title}
                  fill={TEAL}
                  shape={<RoundedBar />}
                  isAnimationActive={false}
                >
                  {rows.map((d, j) => (
                    <Cell key={d.month} fillOpacity={opacity(j)} />
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
