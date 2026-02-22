"use client";

import * as React from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { formatCurrency } from "@/lib/utils";
import { usePrivacy } from "@/contexts/privacy-context";

interface IncomeBreakdownChartProps {
  data: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  /** External hover state for reveal - when true, shows values even if hidden */
  isRevealed?: boolean;
  /** Size variant - compact for sidebars, default for wider containers */
  size?: "compact" | "default";
}

// Threshold for grouping small sources into "Other" (5% of total absolute value)
const OTHER_THRESHOLD = 0.05;
const OTHER_COLOR = "#6b7280"; // Gray
const NEGATIVE_COLOR = "#C4686E"; // Muted coral-red for losses (balanced with teal/copper palette)

interface ChartDataItem {
  name: string;
  value: number; // Absolute value for pie sizing
  actualValue: number; // Real value (can be negative)
  color: string;
  isNegative: boolean;
}

export function IncomeBreakdownChart({ data, isRevealed: externalRevealed, size = "default" }: IncomeBreakdownChartProps) {
  const isCompact = size === "compact";
  const { isHidden } = usePrivacy();
  // Show values if not hidden OR if externally revealed by hover
  const showValues = !isHidden || externalRevealed;

  // Calculate net total (sum of all values including negatives)
  const netTotal = data.reduce((sum, item) => sum + item.value, 0);

  // Calculate absolute total for percentage calculations
  const absoluteTotal = data.reduce((sum, item) => sum + Math.abs(item.value), 0);

  // Group small income sources into "Other" category, handle negatives
  const chartData = React.useMemo((): ChartDataItem[] => {
    if (absoluteTotal === 0) return [];

    const significant: ChartDataItem[] = [];
    let otherPositiveTotal = 0;
    let otherNegativeTotal = 0;

    data.forEach((item) => {
      const absValue = Math.abs(item.value);
      const percentage = absValue / absoluteTotal;

      if (percentage >= OTHER_THRESHOLD) {
        significant.push({
          name: item.name,
          value: absValue, // Use absolute value for pie slice size
          actualValue: item.value, // Keep original for display
          color: item.value < 0 ? NEGATIVE_COLOR : item.color,
          isNegative: item.value < 0,
        });
      } else {
        if (item.value < 0) {
          otherNegativeTotal += item.value;
        } else {
          otherPositiveTotal += item.value;
        }
      }
    });

    // Add "Other" for grouped positive items
    if (otherPositiveTotal > 0) {
      significant.push({
        name: "Other",
        value: otherPositiveTotal,
        actualValue: otherPositiveTotal,
        color: OTHER_COLOR,
        isNegative: false,
      });
    }

    // Add "Other Losses" for grouped negative items
    if (otherNegativeTotal < 0) {
      significant.push({
        name: "Other Losses",
        value: Math.abs(otherNegativeTotal),
        actualValue: otherNegativeTotal,
        color: NEGATIVE_COLOR,
        isNegative: true,
      });
    }

    // Sort: positive income first, then losses
    return significant.sort((a, b) => {
      if (a.isNegative === b.isNegative) {
        return b.value - a.value; // Within same type, sort by size descending
      }
      return a.isNegative ? 1 : -1; // Positive first, negative last
    });
  }, [data, absoluteTotal]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload as ChartDataItem;
      const percentage = ((item.value / absoluteTotal) * 100).toFixed(1);
      return (
        <div className="glass-card rounded-lg p-3 shadow-lg border border-border">
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="font-medium text-foreground">
              {item.name}
              {item.isNegative && <span className="ml-1" style={{ color: NEGATIVE_COLOR }}>(Loss)</span>}
            </span>
          </div>
          <p className="text-sm">
            <span className="font-mono font-medium" style={item.isNegative ? { color: NEGATIVE_COLOR } : undefined}>
              {showValues ? formatCurrency(item.actualValue, { compact: true }) : "•••••"}
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

  if (data.length === 0 || absoluteTotal === 0) {
    return (
      <div className={isCompact ? "h-[200px]" : "h-[250px]"} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span className="text-muted-foreground">No income data for this month</span>
      </div>
    );
  }

  // Limit legend items for compact view
  const maxLegendItems = isCompact ? 4 : 6;
  const visibleLegendItems = chartData.slice(0, maxLegendItems);
  const hiddenCount = chartData.length - maxLegendItems;

  // Size configurations
  const chartHeight = isCompact ? 200 : 250;
  const innerRadius = isCompact ? 55 : 70;
  const outerRadius = isCompact ? 80 : 100;

  return (
    <div className="w-full flex flex-col">
      {/* Chart container */}
      <div className="w-full relative" style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              paddingAngle={chartData.length > 1 ? 2 : 0}
              dataKey="value"
              strokeWidth={0}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color}
                />
              ))}
            </Pie>
            <Tooltip
              content={<CustomTooltip />}
              wrapperStyle={{
                visibility: 'visible',
                position: 'absolute',
                top: 8,
                right: 8,
                left: 'auto',
                transform: 'none',
                pointerEvents: 'none'
              }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* Center text */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className={`${isCompact ? "text-xl" : "text-2xl"} font-bold currency`} style={netTotal < 0 ? { color: NEGATIVE_COLOR } : undefined}>
              {showValues ? formatCurrency(netTotal, { compact: true }) : "•••••"}
            </p>
            <p className="text-xs text-muted-foreground">
              {netTotal < 0 ? "Net Loss" : "Net Income"}
            </p>
          </div>
        </div>
      </div>

      {/* Legend - grid for compact, flex-wrap centered for default */}
      {isCompact ? (
        <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 mt-2">
          {visibleLegendItems.map((item, index) => (
            <div key={index} className="flex items-center gap-1.5 text-xs min-w-0">
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span
                className="text-muted-foreground truncate"
                style={item.isNegative ? { color: NEGATIVE_COLOR } : undefined}
              >
                {item.name}
              </span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className="flex items-center text-xs text-muted-foreground">
              +{hiddenCount} more
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-3">
          {visibleLegendItems.map((item, index) => (
            <div key={index} className="flex items-center gap-1.5 text-xs">
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span
                className="text-muted-foreground"
                style={item.isNegative ? { color: NEGATIVE_COLOR } : undefined}
              >
                {item.name}
              </span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <span className="text-xs text-muted-foreground">+{hiddenCount} more</span>
          )}
        </div>
      )}
    </div>
  );
}
