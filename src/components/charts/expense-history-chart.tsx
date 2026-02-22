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
import { formatCurrency } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";
import type { ExpenseHistory } from "@/types/database";

interface ExpenseHistoryChartProps {
  history: ExpenseHistory[];
}

const TEAL_COLOR = "hsl(167, 21%, 56%)";

export function ExpenseHistoryChart({ history }: ExpenseHistoryChartProps) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed;

  // Transform history into chart data - show amount over time
  const chartData = React.useMemo(() => {
    if (history.length === 0) return [];

    // Filter to only created/updated events (the ones with meaningful amount changes)
    const relevantEvents = history.filter(
      (h) => h.event_type === "created" || h.event_type === "updated"
    );

    if (relevantEvents.length === 0) return [];

    // Sort by date (oldest first for chart)
    const sorted = [...relevantEvents].sort(
      (a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime()
    );

    return sorted.map((entry) => {
      const date = new Date(entry.changed_at);
      return {
        date: entry.changed_at,
        label: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        amount: Number(entry.amount),
        frequency: entry.frequency,
      };
    });
  }, [history]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { label: string; amount: number; frequency: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <p className="text-xs text-muted-foreground mb-1">{data.label}</p>
          <p className="text-sm">
            <span className="font-mono font-medium text-primary">
              {showValues ? formatCurrency(data.amount) : "•••••"}
            </span>
            <span className="text-muted-foreground ml-1.5 text-xs">/{data.frequency}</span>
          </p>
        </div>
      );
    }
    return null;
  };

  if (chartData.length < 3) {
    return null;
  }

  return (
    <div className="h-[180px] w-full" {...hoverProps}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 15, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id="expenseHistoryGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={TEAL_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={TEAL_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            dy={5}
            interval="preserveStartEnd"
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
            tickFormatter={(value) => {
              if (!showValues) return "•••";
              if (value >= 1000) {
                const k = value / 1000;
                return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
              }
              return `$${value}`;
            }}
            width={38}
            tickCount={3}
            domain={['auto', 'auto']}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="amount"
            stroke={TEAL_COLOR}
            strokeWidth={2}
            fill="url(#expenseHistoryGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
