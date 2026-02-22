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
import { formatCurrency, formatMonthShort } from "@/lib/utils";
import { usePrivacy } from "@/contexts/privacy-context";
import type { IncomeSource } from "@/types/database";

// Colors
const POSITIVE_COLOR = "#5B8A8A"; // Teal
const NEGATIVE_COLOR = "#C4686E"; // Muted coral-red for losses

interface IncomeChartProps {
  data: Array<{
    month: string;
    total: number;
    [key: string]: string | number;
  }>;
  sources: IncomeSource[];
  /** External hover state for reveal - when true, shows values even if hidden */
  isRevealed?: boolean;
}

export function IncomeChart({ data, sources, isRevealed: externalRevealed }: IncomeChartProps) {
  const { isHidden } = usePrivacy();
  // Show values if not hidden OR if externally revealed by hover
  const showValues = !isHidden || externalRevealed;

  // Calculate optimal tick interval based on data length
  const tickInterval = React.useMemo(() => {
    const len = data.length;
    if (len <= 6) return 0; // Show all
    if (len <= 12) return 1; // Every other
    if (len <= 24) return 2; // Every 3rd
    return Math.floor(len / 8); // ~8 labels max
  }, [data.length]);

  // Calculate the gradient offset for where y=0 falls in the chart
  // This allows the gradient to change color at the zero line
  const gradientOffset = React.useMemo(() => {
    const values = data.map((d) => d.total);
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
    return data.some((d) => d.total < 0);
  }, [data]);

  // Calculate dynamic y-axis width based on the largest value (always in K format)
  const yAxisWidth = React.useMemo(() => {
    if (data.length === 0) return 45;
    const values = data.map((d) => d.total);
    const maxAbs = Math.max(Math.abs(Math.max(...values)), Math.abs(Math.min(...values)));
    const hasNegatives = values.some((v) => v < 0);

    // Calculate the actual formatted label to measure
    const formatLabel = (val: number) => {
      if (val === 0) return "$0";
      const k = val / 1000;
      const sign = hasNegatives ? "-" : "";
      if (k >= 1000) {
        const m = k / 1000;
        return `${sign}$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
      }
      if (k < 1) {
        // For values under $100, show raw value
        if (val < 100) {
          return `${sign}$${val}`;
        }
        return `${sign}$.${Math.round(k * 10)}K`;
      }
      return `${sign}$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
    };

    const maxLabel = formatLabel(maxAbs);
    // ~7px per character at fontSize 11, plus 4px padding
    return Math.max(36, maxLabel.length * 7 + 4);
  }, [data]);

  // Format y-axis tick values in K format
  const formatYAxisTick = (value: number) => {
    if (value === 0) return "$0";
    const absValue = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    const k = absValue / 1000;
    if (k >= 1000) {
      const m = k / 1000;
      return `${sign}$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
    }
    if (k < 1) {
      // For values under $1K, show raw value if under $100, otherwise $.xK
      if (absValue < 100) {
        return `${sign}$${absValue}`;
      }
      return `${sign}$.${Math.round(k * 10)}K`;
    }
    return `${sign}$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const value = payload[0]?.value ?? 0;
      const color = value >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;

      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <p className="font-medium text-foreground mb-2">
            {formatMonthShort(label)}
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, index: number) => {
              const entryColor = entry.value >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;
              return (
                <div key={index} className="flex items-center justify-between gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: entryColor }}
                    />
                    <span className="text-muted-foreground capitalize">
                      {entry.dataKey === "total" ? "Total" : entry.dataKey}
                    </span>
                  </div>
                  <span className="font-mono font-medium">
                    {showValues ? formatCurrency(entry.value) : "•••••"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
        >
          <defs>
            {/* Gradient for fill - splits at y=0 if there are negative values */}
            <linearGradient id="incomeGradientFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={POSITIVE_COLOR} stopOpacity={0.3} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={POSITIVE_COLOR} stopOpacity={0.1} />
              <stop offset={`${gradientOffset * 100}%`} stopColor={NEGATIVE_COLOR} stopOpacity={0.1} />
              <stop offset="100%" stopColor={NEGATIVE_COLOR} stopOpacity={0.3} />
            </linearGradient>
            {/* Gradient for stroke - splits at y=0 if there are negative values */}
            <linearGradient id="incomeGradientStroke" x1="0" y1="0" x2="0" y2="1">
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
            dataKey="month"
            tickFormatter={(value) => formatMonthShort(value)}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            dy={10}
            interval={tickInterval}
            tickMargin={5}
          />
          <YAxis
            tickFormatter={(value) => showValues ? formatYAxisTick(value) : "•••"}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            dx={-5}
            width={yAxisWidth}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="total"
            stroke={hasNegative ? "url(#incomeGradientStroke)" : POSITIVE_COLOR}
            strokeWidth={2}
            fill="url(#incomeGradientFill)"
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
