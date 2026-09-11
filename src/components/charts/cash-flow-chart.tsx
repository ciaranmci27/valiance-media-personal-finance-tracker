"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { formatCurrency, formatMonthShort } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";

/**
 * Monthly income beside monthly expenses, one axis, two thin bars per month.
 * Income wears the brand teal; expenses stay neutral so the one accent reads
 * as "money in". Net profit rides in the tooltip and the table view.
 */

export interface CashFlowPoint {
  /** First day of the month, YYYY-MM-DD. */
  month: string;
  income: number;
  expenses: number;
  net: number;
}

const INCOME_COLOR = "var(--color-teal)";
const EXPENSE_COLOR = "rgba(var(--ink), 0.28)";
const AXIS_TICK = { fill: "#71717A", fontSize: 11 };

export function CashFlowChart({
  data,
  isRevealed: externalRevealed,
}: {
  data: CashFlowPoint[];
  isRevealed?: boolean;
}) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed || externalRevealed;
  const mask = "•••••";

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: { payload: CashFlowPoint }[];
  }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload;
    const rows: [string, number, string][] = [
      ["Income", point.income, INCOME_COLOR],
      ["Expenses", point.expenses, EXPENSE_COLOR],
    ];
    return (
      <div className="rounded-lg border border-white/[0.08] bg-card p-3 shadow-[var(--shadow-overlay)]">
        <p className="mb-1.5 text-sm font-medium text-foreground">
          {formatMonthShort(point.month)}
        </p>
        {rows.map(([label, value, color]) => (
          <p
            key={label}
            className="flex items-center justify-between gap-6 text-xs"
          >
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {label}
            </span>
            <span className="tabular-nums text-foreground">
              {showValues ? formatCurrency(value) : mask}
            </span>
          </p>
        ))}
        <p className="mt-1.5 flex items-center justify-between gap-6 border-t border-border pt-1.5 text-xs">
          <span className="text-muted-foreground">Net</span>
          <span
            className={
              point.net < 0
                ? "tabular-nums text-error"
                : "tabular-nums text-foreground"
            }
          >
            {showValues ? formatCurrency(point.net, { showSign: true }) : mask}
          </span>
        </p>
      </div>
    );
  };

  if (data.length === 0)
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-zinc-500">
        No monthly activity yet
      </div>
    );

  return (
    <div className="w-full" {...hoverProps}>
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
            barCategoryGap="28%"
            barGap={2}
            barSize={16}
          >
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={AXIS_TICK}
              tickMargin={8}
              tickFormatter={(value: string) =>
                formatMonthShort(value).replace(/\s\d{4}$/, "")
              }
              interval={data.length > 8 ? 1 : 0}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={AXIS_TICK}
              width={48}
              tickFormatter={(value: number) =>
                showValues ? formatCurrency(value, { compact: true }) : "•••"
              }
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ fill: "rgba(var(--ink), 0.04)" }}
            />
            <Bar
              dataKey="income"
              name="Income"
              radius={[4, 4, 0, 0]}
              fill={INCOME_COLOR}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.month} fill={INCOME_COLOR} />
              ))}
            </Bar>
            <Bar
              dataKey="expenses"
              name="Expenses"
              radius={[4, 4, 0, 0]}
              fill={EXPENSE_COLOR}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.month} fill={EXPENSE_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Monthly income, expenses and net profit</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Income</th>
            <th scope="col">Expenses</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <th scope="row">{formatMonthShort(d.month)}</th>
              <td>{showValues ? formatCurrency(d.income) : mask}</td>
              <td>{showValues ? formatCurrency(d.expenses) : mask}</td>
              <td>{showValues ? formatCurrency(d.net) : mask}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CashFlowLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: INCOME_COLOR }}
        />
        Income
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: EXPENSE_COLOR }}
        />
        Expenses
      </span>
    </div>
  );
}
