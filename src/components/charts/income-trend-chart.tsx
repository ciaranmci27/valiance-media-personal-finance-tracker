"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency, formatMonthShort, parseLocalDate, computeChartTicks } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";
import type { IncomeEntry, IncomeAmount } from "@/types/database";

// Colors
const POSITIVE_COLOR = "hsl(167, 21%, 51%)"; // Teal
const NEGATIVE_COLOR = "#C4686E"; // Muted coral-red for losses

interface IncomeTrendChartProps {
  entries: IncomeEntry[];
  amounts: IncomeAmount[];
  isRevealed?: boolean;
}

export function IncomeTrendChart({
  entries,
  amounts,
  isRevealed: externalRevealed,
}: IncomeTrendChartProps) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed || externalRevealed;

  // Transform entries into chart data
  const chartData = React.useMemo(() => {
    return entries
      .map((entry) => {
        const total = amounts
          .filter((a) => a.entry_id === entry.id)
          .reduce((sum, a) => sum + Number(a.amount), 0);
        return {
          month: entry.month,
          total,
          label: formatMonthShort(entry.month),
        };
      })
      .sort((a, b) => parseLocalDate(a.month).getTime() - parseLocalDate(b.month).getTime());
  }, [entries, amounts]);

  // Calculate the gradient offset for where y=0 falls in the chart
  const gradientOffset = React.useMemo(() => {
    if (chartData.length === 0) return 1;
    const values = chartData.map((d) => d.total);
    const max = Math.max(...values);
    const min = Math.min(...values);

    // If all values are positive or all negative, no split needed
    if (min >= 0) return 1; // All positive
    if (max <= 0) return 0; // All negative

    // Calculate where 0 falls between min and max (as a percentage from top)
    return max / (max - min);
  }, [chartData]);

  // Adaptive X axis ticks
  const { ticks: axisTicks, formatter: xTickFormatter } = React.useMemo(
    () => computeChartTicks(chartData.map((d) => d.month), 5),
    [chartData]
  );

  // Check if we have any negative values
  const hasNegative = React.useMemo(() => {
    return chartData.some((d) => d.total < 0);
  }, [chartData]);


  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      const value = item.total;
      const color = value >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;

      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <p className="text-sm font-medium text-foreground mb-1">
            {formatMonthShort(item.month)}
          </p>
          <p className="text-sm">
            <span className="font-mono font-medium" style={{ color }}>
              {showValues ? formatCurrency(value) : "•••••"}
            </span>
          </p>
        </div>
      );
    }
    return null;
  };

  if (chartData.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground">
        No trend data
      </div>
    );
  }

  return (
    <div className="h-[200px] w-full" {...hoverProps}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <defs>
            {/* Gradient for fill - splits at y=0 if there are negative values */}
            <linearGradient id="incomeTrendGradientFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={POSITIVE_COLOR} stopOpacity={0.3} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={POSITIVE_COLOR} stopOpacity={0.1} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={NEGATIVE_COLOR} stopOpacity={0.1} />
              <stop offset="100%" stopColor={NEGATIVE_COLOR} stopOpacity={0.3} />
            </linearGradient>
            {/* Gradient for stroke - splits at y=0 if there are negative values */}
            <linearGradient id="incomeTrendGradientStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={POSITIVE_COLOR} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={POSITIVE_COLOR} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={NEGATIVE_COLOR} />
              <stop offset="100%" stopColor={NEGATIVE_COLOR} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="month"
            ticks={axisTicks}
            tickFormatter={xTickFormatter}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickMargin={8}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickFormatter={(value) =>
              showValues ? formatCurrency(value, { compact: true }) : "•••"
            }
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="total"
            stroke={hasNegative ? "url(#incomeTrendGradientStroke)" : POSITIVE_COLOR}
            strokeWidth={2}
            fill="url(#incomeTrendGradientFill)"
            dot={false}
            activeDot={({ cx, cy, payload }: any) => (
              <circle
                cx={cx}
                cy={cy}
                r={4}
                fill={payload.total >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR}
                stroke="hsl(var(--background))"
                strokeWidth={2}
              />
            )}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
