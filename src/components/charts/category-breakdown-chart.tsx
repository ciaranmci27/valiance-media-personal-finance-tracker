"use client";

import * as React from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { formatCurrency } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/types/database";

// Compact currency format for large numbers
function formatCompactCurrency(value: number): string {
  if (value >= 10000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(2)}K`;
  }
  return formatCurrency(value);
}

// Color palette for categories
const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  housing: "hsl(167, 21%, 46%)",      // teal darker
  transport: "hsl(26, 29%, 57%)",     // copper darker
  utilities: "hsl(200, 40%, 50%)",    // blue
  health: "hsl(142, 40%, 45%)",       // green
  entertainment: "hsl(280, 40%, 55%)", // purple
  subscriptions: "hsl(340, 45%, 55%)", // pink
  software: "hsl(210, 50%, 50%)",     // bright blue
  hosting: "hsl(180, 35%, 45%)",      // cyan
  marketing: "hsl(35, 60%, 50%)",     // orange
  fees: "hsl(0, 45%, 55%)",           // red
  services: "hsl(260, 35%, 55%)",     // violet
  contractors: "hsl(100, 35%, 45%)",  // lime
  payroll: "hsl(220, 45%, 55%)",      // indigo
  insurance: "hsl(45, 50%, 50%)",     // yellow
  other: "hsl(0, 0%, 50%)",           // gray
};

interface CategoryBreakdownChartProps {
  categoryTotals: Partial<Record<ExpenseCategory, number>>;
  isRevealed?: boolean;
}

export function CategoryBreakdownChart({
  categoryTotals,
  isRevealed: externalRevealed,
}: CategoryBreakdownChartProps) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed || externalRevealed;

  const chartData = Object.entries(categoryTotals)
    .filter(([, value]) => value && value > 0)
    .map(([category, value]) => ({
      name: EXPENSE_CATEGORIES[category as ExpenseCategory],
      value: value as number,
      color: CATEGORY_COLORS[category as ExpenseCategory],
    }))
    .sort((a, b) => b.value - a.value);

  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      const percentage = total > 0 ? ((item.value / total) * 100).toFixed(1) : 0;
      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="font-medium text-foreground">{item.name}</span>
          </div>
          <p className="text-sm">
            <span className="font-mono font-medium">
              {showValues ? formatCurrency(item.value) : "•••••"}
            </span>
            <span className="text-muted-foreground ml-2">
              {showValues ? `(${percentage}%)` : "(••%)"}
            </span>
          </p>
        </div>
      );
    }
    return null;
  };

  if (total === 0) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground">
        No category data
      </div>
    );
  }

  // Show top categories in legend (max 4)
  const topCategories = chartData.slice(0, 4);

  return (
    <div className="h-[280px] w-full relative" {...hoverProps}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="45%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={chartData.length > 1 ? 2 : 0}
            dataKey="value"
            strokeWidth={0}
          >
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            content={<CustomTooltip />}
            wrapperStyle={{
              visibility: "visible",
              position: "absolute",
              top: 8,
              right: 8,
              left: "auto",
              transform: "none",
              pointerEvents: "none",
            }}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* Center text */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ marginTop: "-20px" }}>
        <div className="text-center">
          <p className="text-lg font-bold tracking-tight currency text-foreground">
            {showValues ? formatCompactCurrency(total) : "•••••"}
          </p>
          <p className="text-xs text-muted-foreground">{chartData.length} Categories</p>
        </div>
      </div>

      {/* Legend - show top categories */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-wrap justify-center gap-x-4 gap-y-1">
        {topCategories.map((item, index) => {
          const percentage = total > 0 ? ((item.value / total) * 100).toFixed(0) : 0;
          return (
            <div key={index} className="flex items-center gap-1.5 text-xs">
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-foreground">{item.name}</span>
              <span className="text-muted-foreground">
                {showValues ? `${percentage}%` : "••%"}
              </span>
            </div>
          );
        })}
        {chartData.length > 4 && (
          <span className="text-xs text-muted-foreground">+{chartData.length - 4} more</span>
        )}
      </div>
    </div>
  );
}
