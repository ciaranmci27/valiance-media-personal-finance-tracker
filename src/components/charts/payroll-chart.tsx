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
import type { PayrollMonth } from "@/lib/accounting/payroll-register";
import {
  CHART_MARGIN,
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
 * Payroll by month, one stacked bar each: net pay at the bottom, what was
 * withheld from pay above it (together, gross wages), and the employer's
 * cost on top (together, the total payroll cost).
 */

const NET = "var(--color-teal)";
const WITHHELD = "var(--color-teal-light)";
const EMPLOYER = "var(--color-copper-strong)";
const dollars = (v: bigint) => Number(v) / 100;

export const PAYROLL_SERIES = {
  net: { label: "Net pay", swatch: "bg-teal" },
  withholding: { label: "Withheld from pay", swatch: "bg-teal-light" },
  employer: { label: "Employer cost", swatch: "bg-copper-strong" },
};

export function PayrollChart({
  data,
  title,
  revealed,
  masked,
}: {
  data: PayrollMonth[];
  title: string;
  revealed: boolean;
  masked: boolean;
}) {
  const show = !masked || revealed;
  const rows = React.useMemo(
    () =>
      data.map((d) => ({
        ...d,
        netValue: dollars(d.net),
        withheldValue: dollars(d.withholding),
        employerValue: dollars(d.employer),
      })),
    [data],
  );
  const monthTitle = (d: PayrollMonth) =>
    d.partial
      ? `${monthLong.format(atDate(d.month))}, ${dayShort.format(atDate(d.partial.from))} to ${dayShort.format(atDate(d.partial.to))}`
      : monthLong.format(atDate(d.month));
  const makeTick = (step: number) =>
    function MonthTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
      const index = data.findIndex((d) => d.month === payload?.value);
      if (!payload || index < 0 || !labelShown(index, data.length, step)) return <g />;
      return (
        <g transform={`translate(${x},${y})`}>
          <text textAnchor="middle" dy={12} {...TICK}>
            {monthShort.format(atDate(payload.value))}
          </text>
        </g>
      );
    };
  const describe = (d: PayrollMonth): MonthDetail => ({
    title: monthTitle(d),
    rows: [
      { label: PAYROLL_SERIES.net.label, value: formatCents(d.net), active: true },
      { label: PAYROLL_SERIES.withholding.label, value: formatCents(d.withholding), active: true },
      { label: PAYROLL_SERIES.employer.label, value: formatCents(d.employer), active: true },
    ],
    footer: [
      { label: "Gross wages", value: formatCents(d.gross) },
      { label: "Total cost", value: formatCents(d.gross + d.employer) },
      { label: "Runs", value: String(d.runs) },
    ],
  });
  return (
    <MonthChartFrame
      data={data}
      title={title}
      show={show}
      grouped={false}
      describe={describe}
      table={{
        headers: ["Month", "Net pay", "Withheld from pay", "Employer cost", "Total cost"],
        cells: (d) => [
          monthTitle(d),
          formatCents(d.net),
          formatCents(d.withholding),
          formatCents(d.employer),
          formatCents(d.gross + d.employer),
        ],
      }}
    >
      {({ focus, narrow, yAxis, barSize, tooltip }) => {
        const opacity = (i: number) => (focus === null || focus === i ? 1 : 0.35) * (data[i].partial ? 0.75 : 1);
        const cells = rows.map((d, i) => <Cell key={d.month} fillOpacity={opacity(i)} />);
        return (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={CHART_MARGIN} barSize={barSize} barCategoryGap="26%" maxBarSize={44}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis
                dataKey="month"
                axisLine={false}
                tickLine={false}
                tick={makeTick(labelStep(data.length, narrow))}
                height={24}
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
              <Bar dataKey="netValue" name="Net pay" stackId="pay" fill={NET} shape={<RoundedBar flat />} isAnimationActive={false}>
                {cells}
              </Bar>
              <Bar
                dataKey="withheldValue"
                name="Withheld from pay"
                stackId="pay"
                fill={WITHHELD}
                shape={<RoundedBar flat />}
                isAnimationActive={false}
              >
                {cells}
              </Bar>
              <Bar
                dataKey="employerValue"
                name="Employer cost"
                stackId="pay"
                fill={EMPLOYER}
                shape={<RoundedBar />}
                isAnimationActive={false}
              >
                {cells}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        );
      }}
    </MonthChartFrame>
  );
}
