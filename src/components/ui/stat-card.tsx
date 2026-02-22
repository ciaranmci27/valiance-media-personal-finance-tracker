"use client";

import * as React from "react";
import { cn, formatCurrency, formatPercentage } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useMaskedHover, getMaskedValue } from "@/components/ui/masked-value";

interface StatCardProps {
  title: string;
  value: number;
  previousValue?: number;
  format?: "currency" | "number" | "percentage";
  icon?: React.ReactNode;
  className?: string;
  trend?: "up" | "down" | "neutral";
  /** When true, inverts trend colors: decrease = success (green), increase = error (red) */
  invertTrend?: boolean;
}

export function StatCard({
  title,
  value,
  previousValue,
  format = "currency",
  icon,
  className,
  trend: forcedTrend,
  invertTrend = false,
}: StatCardProps) {
  const { isHidden, isRevealed, showValue, hoverProps } = useMaskedHover();

  const formattedValue = React.useMemo(() => {
    switch (format) {
      case "currency":
        return formatCurrency(value);
      case "percentage":
        return `${value.toFixed(1)}%`;
      default:
        return value.toLocaleString();
    }
  }, [value, format]);

  const percentageChange = React.useMemo(() => {
    if (previousValue === undefined || previousValue === 0) return null;
    return ((value - previousValue) / Math.abs(previousValue)) * 100;
  }, [value, previousValue]);

  const trend = forcedTrend ?? (percentageChange !== null
    ? percentageChange > 0
      ? "up"
      : percentageChange < 0
      ? "down"
      : "neutral"
    : "neutral");

  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  // When invertTrend is true, flip the colors (for expenses: decrease = good, increase = bad)
  const trendColor = invertTrend
    ? trend === "up"
      ? "text-error"
      : trend === "down"
      ? "text-success"
      : "text-muted-foreground"
    : trend === "up"
    ? "text-success"
    : trend === "down"
    ? "text-error"
    : "text-muted-foreground";

  // Get masked display values
  const displayValue = getMaskedValue(formattedValue, isHidden, isRevealed);
  const displayPercentage = percentageChange !== null
    ? getMaskedValue(formatPercentage(Math.abs(percentageChange)), isHidden, isRevealed)
    : null;

  return (
    <div
      className={cn(
        "glass-card rounded-xl p-4 sm:p-6 animate-fade-up transition-opacity",
        isHidden && "cursor-default",
        className
      )}
      {...hoverProps}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p
            className={cn(
              "text-lg sm:text-2xl font-bold tracking-tight currency",
              // Neutralize color when hidden to not reveal positive/negative
              isHidden && !isRevealed
                ? "text-foreground"
                : value < 0
                ? "text-error"
                : "text-foreground"
            )}
          >
            {displayValue}
          </p>
        </div>
        {icon && (
          <div className="hidden min-[440px]:block rounded-lg bg-primary/10 p-2.5 text-primary">
            {icon}
          </div>
        )}
      </div>

      {percentageChange !== null && (
        <div className="mt-4 flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              // When hidden (and not revealed by hover), always show neutral styling
              isHidden && !isRevealed
                ? "bg-muted text-muted-foreground"
                : invertTrend
                ? // Inverted: up = bad (red), down = good (green)
                  trend === "up"
                  ? "bg-error/10 text-error"
                  : trend === "down"
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground"
                : // Normal: up = good (green), down = bad (red)
                  trend === "up"
                ? "bg-success/10 text-success"
                : trend === "down"
                ? "bg-error/10 text-error"
                : "bg-muted text-muted-foreground"
            )}
          >
            {/* When hidden, always show neutral Minus icon */}
            {isHidden && !isRevealed ? (
              <Minus className="h-3 w-3" />
            ) : (
              <TrendIcon className="h-3 w-3" />
            )}
            <span>{displayPercentage}</span>
          </div>
          <span className="text-xs text-muted-foreground">vs last month</span>
        </div>
      )}
    </div>
  );
}
