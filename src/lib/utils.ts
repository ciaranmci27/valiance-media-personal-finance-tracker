import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind CSS classes with proper conflict resolution
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a number as USD currency
 */
export function formatCurrency(
  amount: number,
  options?: { showSign?: boolean; compact?: boolean }
): string {
  const { showSign = false, compact = false } = options || {};

  // For compact notation, use custom formatting to avoid ugly decimals like "$24.00K"
  if (compact) {
    const absAmount = Math.abs(amount);
    let formatted: string;

    if (absAmount >= 1_000_000) {
      const value = absAmount / 1_000_000;
      // Only show decimal if not a round number
      formatted = value % 1 === 0 ? `$${value}M` : `$${value.toFixed(1)}M`;
    } else if (absAmount >= 1_000) {
      const value = absAmount / 1_000;
      // Only show decimal if not a round number
      formatted = value % 1 === 0 ? `$${value}K` : `$${value.toFixed(1)}K`;
    } else {
      formatted = `$${absAmount.toFixed(0)}`;
    }

    if (showSign && amount !== 0) {
      return amount > 0 ? `+${formatted}` : `-${formatted}`;
    }
    return amount < 0 ? `-${formatted}` : formatted;
  }

  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  // Strip trailing .00 but keep non-zero decimals like .50
  const formatted = formatter.format(Math.abs(amount)).replace(/\.00$/, "");

  if (showSign && amount !== 0) {
    return amount > 0 ? `+${formatted}` : `-${formatted}`;
  }

  return amount < 0 ? `-${formatted}` : formatted;
}

/**
 * Parse a date string safely (avoids timezone issues with YYYY-MM-DD format)
 * JavaScript's new Date("2026-01-01") interprets as UTC midnight,
 * which can show as Dec 31 in US timezones. This parses as local time.
 */
export function parseLocalDate(date: Date | string): Date {
  if (date instanceof Date) return date;
  // Parse YYYY-MM-DD as local date by splitting
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day || 1);
}

/**
 * Format a date as a readable month/year string
 */
export function formatMonth(date: Date | string): string {
  const d = parseLocalDate(date);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Format a date as short month/year
 */
export function formatMonthShort(date: Date | string): string {
  const d = parseLocalDate(date);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/**
 * Format a date as full date
 */
export function formatDate(date: Date | string): string {
  const d = parseLocalDate(date);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Calculate percentage change between two values
 */
export function calculatePercentageChange(
  current: number,
  previous: number
): number {
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Format percentage with sign
 */
export function formatPercentage(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1).replace(/\.0$/, "")}%`;
}

/**
 * Convert expense amount to monthly equivalent based on frequency
 */
export function toMonthlyAmount(
  amount: number,
  frequency: "weekly" | "monthly" | "quarterly" | "annual"
): number {
  switch (frequency) {
    case "weekly":
      return (amount * 52) / 12;
    case "monthly":
      return amount;
    case "quarterly":
      return amount / 3;
    case "annual":
      return amount / 12;
    default:
      return amount;
  }
}

/**
 * Convert expense amount to annual equivalent based on frequency
 */
export function toAnnualAmount(
  amount: number,
  frequency: "weekly" | "monthly" | "quarterly" | "annual"
): number {
  switch (frequency) {
    case "weekly":
      return amount * 52;
    case "monthly":
      return amount * 12;
    case "quarterly":
      return amount * 4;
    case "annual":
      return amount;
    default:
      return amount;
  }
}

/**
 * Truncate text with ellipsis
 */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "...";
}

/**
 * Delay utility for async operations
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick items from an array at a constant step interval starting from index 0.
 * Guarantees equal gaps between every pair of adjacent picks.
 */
function evenlySpacePick<T>(arr: T[], maxCount: number): T[] {
  if (arr.length <= maxCount) return arr;
  const step = Math.ceil(arr.length / maxCount);
  const result: T[] = [];
  for (let i = 0; i < arr.length; i += step) {
    result.push(arr[i]);
  }
  return result;
}

/**
 * Compute adaptive X axis ticks and formatter for Recharts based on date range.
 * - 1–2 years of data → month abbreviations ("Jan", "Mar", "May")
 * - 3+ years of data → year labels ("2023", "2024", "2025")
 * - Always picks from the full data array at constant step intervals so ticks
 *   are visually evenly spaced on the categorical axis.
 * - Thins ticks to ~`maxTicks` to prevent label overlap in narrow charts.
 */
export function computeChartTicks(
  dates: string[],
  maxTicks: number = 5
): { ticks: string[]; formatter: (value: string) => string } {
  if (dates.length === 0) {
    return { ticks: [], formatter: (v) => v };
  }

  // Determine unique years in the dataset
  const uniqueYears = new Set<number>();
  for (const date of dates) {
    uniqueYears.add(parseLocalDate(date).getFullYear());
  }

  // Always pick from the full dates array for even visual spacing
  const pickedDates = evenlySpacePick(dates, maxTicks);

  if (uniqueYears.size >= 3) {
    // 3+ years: year labels
    return {
      ticks: pickedDates,
      formatter: (value) => String(parseLocalDate(value).getFullYear()),
    };
  }

  // 1–2 years: month abbreviations
  return {
    ticks: pickedDates,
    formatter: (value) =>
      parseLocalDate(value).toLocaleDateString("en-US", { month: "short" }),
  };
}
