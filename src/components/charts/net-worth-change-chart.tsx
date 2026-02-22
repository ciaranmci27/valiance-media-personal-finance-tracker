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
  ReferenceLine,
} from "recharts";
import { formatCurrency, formatMonthShort, computeChartTicks } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";

interface NetWorthChangeChartProps {
  data: Array<{
    date: string;
    change: number;
  }>;
  isRevealed?: boolean;
}

export function NetWorthChangeChart({
  data,
  isRevealed: externalRevealed,
}: NetWorthChangeChartProps) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed || externalRevealed;

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      const isPositive = item.change >= 0;
      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <p className="text-sm font-medium text-foreground mb-1">
            {formatMonthShort(item.date)}
          </p>
          <p
            className={`text-sm font-mono font-medium ${
              isPositive ? "text-success" : "text-error"
            }`}
          >
            {showValues
              ? `${isPositive ? "+" : ""}${formatCurrency(item.change)}`
              : "•••••"}
          </p>
        </div>
      );
    }
    return null;
  };

  // Adaptive ticks: month labels for single-year data, year labels for multi-year
  const { ticks: axisTicks, formatter: tickFormatter } = React.useMemo(
    () => computeChartTicks(data.map((d) => d.date), 5),
    [data]
  );


  if (data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground">
        No change data
      </div>
    );
  }

  return (
    <div className="h-[200px] w-full" {...hoverProps}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <XAxis
            dataKey="date"
            ticks={axisTicks}
            tickFormatter={tickFormatter}
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
              showValues ? `$${(value / 1000).toFixed(0)}K` : "•••"
            }
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="hsl(var(--border))" />
          <Bar dataKey="change" radius={[4, 4, 0, 0]}>
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.change >= 0 ? "hsl(142, 40%, 45%)" : "hsl(0, 45%, 55%)"}
                opacity={0.8}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
