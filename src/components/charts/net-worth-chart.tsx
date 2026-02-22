"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency, formatMonthShort, computeChartTicks } from "@/lib/utils";
import { usePrivacy } from "@/contexts/privacy-context";

// Colors
const POSITIVE_COLOR = "#C5A68F"; // Copper
const NEGATIVE_COLOR = "#C4686E"; // Muted coral-red for losses

interface NetWorthChartProps {
  data: Array<{
    date: string;
    amount: number;
  }>;
  /** External hover state for reveal - when true, shows values even if hidden */
  isRevealed?: boolean;
}

export function NetWorthChart({ data, isRevealed: externalRevealed }: NetWorthChartProps) {
  const { isHidden } = usePrivacy();
  // Show values if not hidden OR if externally revealed by hover
  const showValues = !isHidden || externalRevealed;

  // Adaptive ticks: month labels for single-year data, year labels for multi-year
  const { ticks: axisTicks, formatter: tickFormatter } = React.useMemo(
    () => computeChartTicks(data.map((d) => d.date), 5),
    [data]
  );


  // Calculate the gradient offset for where y=0 falls in the chart
  // This allows the gradient to change color at the zero line
  const gradientOffset = React.useMemo(() => {
    if (data.length === 0) return 1;
    const values = data.map((d) => d.amount);
    const max = Math.max(...values);
    const min = Math.min(...values);

    // If all values are positive or all negative, no split needed
    if (min >= 0) return 1; // All positive
    if (max <= 0) return 0; // All negative

    // Calculate where 0 falls between min and max (as a percentage from top)
    return max / (max - min);
  }, [data]);

  // Check if we have any negative values
  const hasNegative = React.useMemo(() => {
    return data.some((d) => d.amount < 0);
  }, [data]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const value = payload[0]?.value ?? 0;
      const color = value >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;

      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <p className="font-medium text-foreground mb-1">
            {formatMonthShort(label)}
          </p>
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            <p className="text-lg font-mono font-bold" style={{ color }}>
              {showValues ? formatCurrency(value) : "•••••"}
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  if (data.length === 0) {
    return (
      <div className="h-[250px] flex items-center justify-center text-muted-foreground">
        No net worth data available
      </div>
    );
  }

  return (
    <div className="h-[250px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <defs>
            {/* Gradient for fill - splits at y=0 if there are negative values */}
            <linearGradient id="netWorthGradientFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={POSITIVE_COLOR} stopOpacity={0.3} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={POSITIVE_COLOR} stopOpacity={0.1} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={NEGATIVE_COLOR} stopOpacity={0.1} />
              <stop offset="100%" stopColor={NEGATIVE_COLOR} stopOpacity={0.3} />
            </linearGradient>
            {/* Gradient for stroke - splits at y=0 if there are negative values */}
            <linearGradient id="netWorthGradientStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={POSITIVE_COLOR} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={POSITIVE_COLOR} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={NEGATIVE_COLOR} />
              <stop offset="100%" stopColor={NEGATIVE_COLOR} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="hsl(var(--border))"
            opacity={0.5}
          />
          <XAxis
            dataKey="date"
            ticks={axisTicks}
            tickFormatter={tickFormatter}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            dy={10}
            tickMargin={5}
          />
          <YAxis
            tickFormatter={(value) => showValues ? formatCurrency(value, { compact: true }) : "•••"}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="amount"
            stroke={hasNegative ? "url(#netWorthGradientStroke)" : POSITIVE_COLOR}
            strokeWidth={2}
            fill="url(#netWorthGradientFill)"
            dot={false}
            activeDot={({ cx, cy, payload }: any) => (
              <circle
                cx={cx}
                cy={cy}
                r={4}
                fill={payload.amount >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR}
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
