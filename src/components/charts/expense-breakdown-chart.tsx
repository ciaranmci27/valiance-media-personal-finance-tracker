"use client";

import * as React from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { formatCurrency } from "@/lib/utils";
import { useMaskedHover } from "@/components/ui/masked-value";

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

interface ExpenseBreakdownChartProps {
  personal: number;
  business: number;
  isRevealed?: boolean;
}

const TEAL_COLOR = "hsl(167, 21%, 56%)"; // teal-light
const COPPER_COLOR = "hsl(26, 29%, 67%)"; // copper

export function ExpenseBreakdownChart({
  personal,
  business,
  isRevealed: externalRevealed,
}: ExpenseBreakdownChartProps) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const showValues = !isHidden || isRevealed || externalRevealed;

  const total = personal + business;

  const chartData = [
    { name: "Personal", value: personal, color: TEAL_COLOR },
    { name: "Business", value: business, color: COPPER_COLOR },
  ].filter((item) => item.value > 0);

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
        No expense data
      </div>
    );
  }

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
            paddingAngle={chartData.length > 1 ? 3 : 0}
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
          <p className="text-xs text-muted-foreground">Total Monthly</p>
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-center gap-6">
        {chartData.map((item, index) => {
          const percentage = total > 0 ? ((item.value / total) * 100).toFixed(0) : 0;
          return (
            <div key={index} className="flex items-center gap-2 text-sm">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <div>
                <span className="text-foreground font-medium">{item.name}</span>
                <span className="text-muted-foreground ml-2">
                  {showValues ? `${percentage}%` : "••%"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
