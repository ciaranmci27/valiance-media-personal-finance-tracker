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
import { formatCurrency, toMonthlyAmount } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";
import type { ExpenseHistory } from "@/types/database";

interface ExpenseTrendChartProps {
  history: ExpenseHistory[];
}

const TEAL_COLOR = "hsl(167, 21%, 56%)";

export function ExpenseTrendChart({ history }: ExpenseTrendChartProps) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed;

  // Reconstruct total expenses over time using event sourcing
  const chartData = React.useMemo(() => {
    if (history.length === 0) return [];

    // Sort all events by date (oldest first)
    const sortedEvents = [...history].sort(
      (a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime()
    );

    // Track the current state of each expense: expense_id -> { amount, frequency, is_active }
    const expenseStates = new Map<string, { amount: number; frequency: string; isActive: boolean }>();

    // Track monthly snapshots
    const monthlySnapshots = new Map<string, number>();

    // Helper to calculate total from current states
    const calculateTotal = () => {
      let total = 0;
      expenseStates.forEach((state) => {
        if (state.isActive) {
          total += toMonthlyAmount(state.amount, state.frequency as "weekly" | "monthly" | "quarterly" | "annual");
        }
      });
      return Math.round(total * 100) / 100;
    };

    // Process each event and update state
    sortedEvents.forEach((event) => {
      const expenseId = event.expense_id;

      // Update expense state based on event type
      switch (event.event_type) {
        case "created":
        case "updated":
          expenseStates.set(expenseId, {
            amount: Number(event.amount),
            frequency: event.frequency,
            isActive: event.is_active,
          });
          break;
        case "paused":
          if (expenseStates.has(expenseId)) {
            const current = expenseStates.get(expenseId)!;
            current.isActive = false;
          } else {
            expenseStates.set(expenseId, {
              amount: Number(event.amount),
              frequency: event.frequency,
              isActive: false,
            });
          }
          break;
        case "activated":
          if (expenseStates.has(expenseId)) {
            const current = expenseStates.get(expenseId)!;
            current.isActive = true;
          } else {
            expenseStates.set(expenseId, {
              amount: Number(event.amount),
              frequency: event.frequency,
              isActive: true,
            });
          }
          break;
        case "deleted":
          if (expenseStates.has(expenseId)) {
            const current = expenseStates.get(expenseId)!;
            current.isActive = false;
          }
          break;
      }

      // Record snapshot for this month
      const date = new Date(event.changed_at);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      monthlySnapshots.set(monthKey, calculateTotal());
    });

    // Convert to array and format for chart
    const data = Array.from(monthlySnapshots.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([monthKey, total]) => {
        const [year, month] = monthKey.split("-");
        const date = new Date(Number(year), Number(month) - 1, 1);
        return {
          month: monthKey,
          label: date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
          total,
        };
      })
      .slice(-12); // Last 12 months

    return data;
  }, [history]);

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <p className="text-sm font-medium text-foreground mb-1">{label}</p>
          <p className="text-sm">
            <span className="font-mono font-medium text-primary">
              {showValues ? formatCurrency(payload[0].value) : "•••••"}
            </span>
            <span className="text-muted-foreground ml-2">/month</span>
          </p>
        </div>
      );
    }
    return null;
  };

  if (chartData.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No historical data available
      </div>
    );
  }

  return (
    <div className="h-[200px] w-full" {...hoverProps}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 15, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id="tealGradient" x1="0" y1="0" x2="0" y2="1">
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
            dataKey="total"
            stroke={TEAL_COLOR}
            strokeWidth={2}
            fill="url(#tealGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
