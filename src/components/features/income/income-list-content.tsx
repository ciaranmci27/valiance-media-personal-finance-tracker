"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Wallet,
  TrendingUp,
  Calendar,
  Layers,
  ArrowUp,
  ArrowDown,
  ArrowDownAZ,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { IncomeBreakdownChart } from "@/components/charts/income-breakdown-chart";
import { IncomeTrendChart } from "@/components/charts/income-trend-chart";
import {
  MaskedValue,
  useMaskedHover,
  getMaskedValue,
} from "@/components/ui/masked-value";
import {
  formatCurrency,
  formatMonth,
  formatMonthShort,
  parseLocalDate,
  cn,
} from "@/lib/utils";
import type { IncomeEntry, IncomeSource, IncomeAmount } from "@/types/database";

interface IncomeListContentProps {
  entries: IncomeEntry[];
  sources: IncomeSource[];
  amounts: IncomeAmount[];
}

type SortColumn = "month" | "total";
type SortDirection = "asc" | "desc";

// Mobile card component for income entries
function IncomeCard({
  entry,
  sources,
  getSourceAmount,
  total,
  index,
  onHoverStart,
  onHoverEnd,
}: {
  entry: IncomeEntry;
  sources: IncomeSource[];
  getSourceAmount: (entryId: string, sourceId: string) => number;
  total: number;
  index: number;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}) {
  const router = useRouter();
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const currencyMask = "$•••••••";

  const handleCardClick = () => {
    router.push(`/income/${entry.id}`);
  };

  // Get sources with non-zero amounts
  const sourcesWithAmounts = sources
    .map((source) => ({
      source,
      amount: getSourceAmount(entry.id, source.id),
    }))
    .filter(({ amount }) => amount !== 0);

  return (
    <div
      onClick={handleCardClick}
      onMouseEnter={() => {
        onHoverStart();
        hoverProps.onMouseEnter?.();
      }}
      onMouseLeave={() => {
        onHoverEnd();
        hoverProps.onMouseLeave?.();
      }}
      onTouchStart={hoverProps.onMouseEnter}
      onTouchEnd={hoverProps.onMouseLeave}
      className={cn(
        "glass-card rounded-xl p-4 cursor-pointer transition-all duration-300",
        "hover:border-primary/30 active:scale-[0.98]",
        "animate-fade-up",
        `stagger-${Math.min(index + 1, 6)}`
      )}
    >
      {/* Header: Month and Total */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0">
            <Calendar className="h-4 w-4 text-primary" />
          </div>
          <div>
            <span className="font-semibold text-foreground block">
              {formatMonth(entry.month)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatMonthShort(entry.month)}
            </span>
          </div>
        </div>
        <div className="text-right">
          <span className="text-xs text-muted-foreground block mb-0.5">Total</span>
          <span
            className={cn(
              "font-mono font-semibold text-lg",
              total < 0 ? "text-error" : "text-primary"
            )}
          >
            {getMaskedValue(formatCurrency(total), isHidden, isRevealed, currencyMask)}
          </span>
        </div>
      </div>

      {/* Source Breakdown */}
      {sourcesWithAmounts.length > 0 && (
        <div className="border-t border-border/50 pt-3 space-y-2">
          {sourcesWithAmounts.map(({ source, amount }) => (
            <div key={source.id} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: source.color }}
                />
                <span className="text-sm text-muted-foreground truncate">
                  {source.name}
                </span>
              </div>
              <span
                className={cn(
                  "font-mono text-sm",
                  amount < 0 ? "text-error" : "text-foreground"
                )}
              >
                {getMaskedValue(formatCurrency(amount), isHidden, isRevealed, currencyMask)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Table row with hover-to-reveal
function IncomeRow({
  entry,
  sources,
  getSourceAmount,
  total,
  index,
  onHoverStart,
  onHoverEnd,
}: {
  entry: IncomeEntry;
  sources: IncomeSource[];
  getSourceAmount: (entryId: string, sourceId: string) => number;
  total: number;
  index: number;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}) {
  const router = useRouter();
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const currencyMask = "$•••••••";

  const handleRowClick = () => {
    router.push(`/income/${entry.id}`);
  };

  return (
    <tr
      onClick={handleRowClick}
      onMouseEnter={() => {
        onHoverStart();
        hoverProps.onMouseEnter?.();
      }}
      onMouseLeave={() => {
        onHoverEnd();
        hoverProps.onMouseLeave?.();
      }}
      className={cn(
        "transition-all duration-300 hover:bg-secondary/50 cursor-pointer animate-fade-up",
        `stagger-${Math.min(index + 1, 6)}`
      )}
    >
      <td className="px-4 py-3 align-middle">
        <span className="font-medium text-foreground">
          {formatMonth(entry.month)}
        </span>
      </td>
      {sources.map((source) => {
        const amount = getSourceAmount(entry.id, source.id);
        const displayValue =
          amount === 0
            ? "—"
            : getMaskedValue(formatCurrency(amount), isHidden, isRevealed, currencyMask);
        return (
          <td
            key={source.id}
            className={cn(
              "px-4 py-3 align-middle text-right font-mono text-sm min-w-[140px]",
              amount === 0
                ? "text-muted-foreground"
                : amount < 0
                ? "text-error"
                : "text-foreground"
            )}
          >
            {displayValue}
          </td>
        );
      })}
      <td
        className={cn(
          "px-4 py-3 align-middle text-right font-mono font-medium min-w-[140px]",
          total < 0 ? "text-error" : "text-primary"
        )}
      >
        {getMaskedValue(formatCurrency(total), isHidden, isRevealed, currencyMask)}
      </td>
    </tr>
  );
}

export function IncomeListContent({
  entries,
  sources,
  amounts,
}: IncomeListContentProps) {
  // Get unique years from entries (only years with data)
  const years = React.useMemo(() => {
    const uniqueYears = new Set(
      entries.map((e) => parseLocalDate(e.month).getFullYear())
    );
    return Array.from(uniqueYears).sort((a, b) => b - a);
  }, [entries]);

  // Default to most recent year with data, or "all" if no data
  const defaultYear = years.length > 0 ? years[0].toString() : "all";
  const [selectedYear, setSelectedYear] = React.useState<string>(defaultYear);
  const [sortColumn, setSortColumn] = React.useState<SortColumn>("month");
  const [sortDirection, setSortDirection] = React.useState<SortDirection>("desc");
  const [hoveredEntryId, setHoveredEntryId] = React.useState<string | null>(null);

  // Hover-to-reveal for the breakdown chart
  const { isRevealed: chartRevealed, hoverProps: chartHoverProps } = useMaskedHover();

  // Calculate total for an entry
  const getEntryTotal = React.useCallback(
    (entryId: string) => {
      return amounts
        .filter((a) => a.entry_id === entryId)
        .reduce((sum, a) => sum + Number(a.amount), 0);
    },
    [amounts]
  );

  // Get amount for a specific source in an entry
  const getSourceAmount = React.useCallback(
    (entryId: string, sourceId: string) => {
      const amount = amounts.find(
        (a) => a.entry_id === entryId && a.source_id === sourceId
      );
      return Number(amount?.amount ?? 0);
    },
    [amounts]
  );

  // Toggle sort when clicking a column header
  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "desc" ? "asc" : "desc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  // Filter and sort entries
  const filteredEntries = React.useMemo(() => {
    let filtered = entries;

    // Filter by year
    if (selectedYear !== "all") {
      filtered = entries.filter((entry) => {
        const year = parseLocalDate(entry.month).getFullYear();
        return year === parseInt(selectedYear);
      });
    }

    // Sort
    return [...filtered].sort((a, b) => {
      if (sortColumn === "month") {
        const aDate = parseLocalDate(a.month).getTime();
        const bDate = parseLocalDate(b.month).getTime();
        return sortDirection === "desc" ? bDate - aDate : aDate - bDate;
      } else {
        const aTotal = getEntryTotal(a.id);
        const bTotal = getEntryTotal(b.id);
        return sortDirection === "desc" ? bTotal - aTotal : aTotal - bTotal;
      }
    });
  }, [entries, selectedYear, sortColumn, sortDirection, getEntryTotal]);

  // Active sources for table columns - only show sources that have data in filtered entries
  const activeSources = React.useMemo(() => {
    return sources.filter((source) => {
      if (!source.is_active) return false;
      return filteredEntries.some((entry) => {
        const amount = amounts.find(
          (a) => a.entry_id === entry.id && a.source_id === source.id
        );
        return Number(amount?.amount ?? 0) !== 0;
      });
    });
  }, [sources, filteredEntries, amounts]);

  // Calculate totals for stat cards
  const totals = React.useMemo(() => {
    const yearEntries = selectedYear === "all" ? entries : filteredEntries;
    const yearTotal = yearEntries.reduce((sum, entry) => sum + getEntryTotal(entry.id), 0);
    const monthlyAvg = yearEntries.length > 0 ? yearTotal / yearEntries.length : 0;

    // Best month
    let bestMonth = { month: "", total: 0 };
    yearEntries.forEach((entry) => {
      const total = getEntryTotal(entry.id);
      if (total > bestMonth.total) {
        bestMonth = { month: entry.month, total };
      }
    });

    return { yearTotal, monthlyAvg, bestMonth };
  }, [entries, filteredEntries, selectedYear, getEntryTotal]);

  // Get the hovered entry if any
  const hoveredEntry = React.useMemo(() => {
    if (!hoveredEntryId) return null;
    return filteredEntries.find((e) => e.id === hoveredEntryId) || null;
  }, [hoveredEntryId, filteredEntries]);

  // Calculate source totals for the chart (format for IncomeBreakdownChart)
  // If hovering on a row, show that month's breakdown; otherwise show aggregate
  const sourceBreakdownData = React.useMemo(() => {
    const entriesToUse = hoveredEntry ? [hoveredEntry] : filteredEntries;
    return sources
      .filter((s) => s.is_active)
      .map((source) => {
        const total = entriesToUse.reduce((sum, entry) => {
          return sum + getSourceAmount(entry.id, source.id);
        }, 0);
        return {
          name: source.name,
          value: total,
          color: source.color || "#5B8A8A",
        };
      })
      .filter(({ value }) => value !== 0);
  }, [sources, filteredEntries, hoveredEntry, getSourceAmount]);

  // Chart title based on selection and hover state
  const chartTitle = React.useMemo(() => {
    if (hoveredEntry) {
      return `${formatMonth(hoveredEntry.month)} Sources`;
    }
    if (selectedYear === "all") {
      return "All Time Sources";
    }
    return `${selectedYear} Sources`;
  }, [hoveredEntry, selectedYear]);

  // Current filtered total
  const currentTotal = filteredEntries.reduce(
    (sum, entry) => sum + getEntryTotal(entry.id),
    0
  );

  // Chart visibility based on data
  const showTrendChart = filteredEntries.length >= 3;
  const showSourceChart = sourceBreakdownData.length > 0;

  // Year tabs
  const yearTabs = [
    { value: "all", label: "All" },
    ...years.map((year) => ({
      value: year.toString(),
      label: year.toString(),
    })),
  ];

  return (
    <div className="space-y-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          title={selectedYear === "all" ? "Total Income" : `${selectedYear} Income`}
          value={totals.yearTotal}
          icon={<Wallet className="h-5 w-5" />}
          className="stagger-1"
        />
        <StatCard
          title="Monthly Average"
          value={totals.monthlyAvg}
          icon={<TrendingUp className="h-5 w-5" />}
          className="stagger-2"
        />
        <StatCard
          title="Best Month"
          value={totals.bestMonth.total}
          icon={<Calendar className="h-5 w-5" />}
          className="stagger-3"
        />
        <StatCard
          title="Income Sources"
          value={activeSources.length}
          format="number"
          icon={<Layers className="h-5 w-5" />}
          className="stagger-4"
        />
      </div>

      {/* Tabs and Add Button */}
      <div className="flex items-center justify-between gap-2 min-[560px]:gap-4">
        {/* Mobile: Dropdown select for tabs */}
        <div className="min-[700px]:hidden w-40">
          <CustomSelect
            value={selectedYear}
            onChange={(value) => setSelectedYear(value)}
            options={yearTabs.map((tab) => ({
              value: tab.value,
              label: tab.label,
            }))}
            size="sm"
          />
        </div>

        {/* Desktop: Button tabs */}
        <div className="hidden min-[700px]:flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          {yearTabs.slice(0, 5).map((tab) => (
            <button
              key={tab.value}
              onClick={() => setSelectedYear(tab.value)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                selectedYear === tab.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              {tab.label}
            </button>
          ))}
          {yearTabs.length > 5 && (
            <CustomSelect
              value={yearTabs.slice(5).some((t) => t.value === selectedYear) ? selectedYear : ""}
              onChange={(value) => setSelectedYear(value)}
              options={yearTabs.slice(5).map((tab) => ({
                value: tab.value,
                label: tab.label,
              }))}
              size="sm"
              placeholder="More..."
            />
          )}
        </div>

        <Link href="/income/new">
          <Button>
            <Plus className="h-4 w-4" />
            Add Entry
          </Button>
        </Link>
      </div>

      {/* Table and Chart Layout */}
      <div className="flex flex-col xl:flex-row xl:items-start gap-6">
        {/* Mobile: Card Layout */}
        <div className="lg:hidden flex-1 space-y-3">
          {/* Mobile Sort Controls */}
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs text-muted-foreground">Sort by:</span>
            <button
              onClick={() => handleSort("month")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                sortColumn === "month"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Month
              {sortColumn === "month" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
            <button
              onClick={() => handleSort("total")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                sortColumn === "total"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Total
              {sortColumn === "total" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
          </div>

          {/* Cards */}
          {filteredEntries.map((entry, index) => (
            <IncomeCard
              key={entry.id}
              entry={entry}
              sources={activeSources}
              getSourceAmount={getSourceAmount}
              total={getEntryTotal(entry.id)}
              index={index}
              onHoverStart={() => setHoveredEntryId(entry.id)}
              onHoverEnd={() => setHoveredEntryId(null)}
            />
          ))}

          {/* Mobile Total Footer */}
          {filteredEntries.length > 0 && (
            <div className="glass-card rounded-xl p-4 mt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  {selectedYear === "all" ? "Total Income" : `${selectedYear} Total`}
                </span>
                <span className="font-mono font-bold text-lg text-primary">
                  <MaskedValue value={formatCurrency(currentTotal)} />
                </span>
              </div>
            </div>
          )}

          {filteredEntries.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              No income entries found
            </div>
          )}
        </div>

        {/* Desktop: Table Layout */}
        <Card className="hidden lg:block flex-1 min-w-0">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("month")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          sortColumn === "month" && "text-foreground"
                        )}
                      >
                        Month
                        {sortColumn === "month" &&
                          (sortDirection === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUp className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                    {activeSources.map((source) => (
                      <th
                        key={source.id}
                        className="px-4 py-3 text-right text-sm font-medium text-muted-foreground min-w-[140px]"
                      >
                        <div className="flex items-center justify-end gap-2">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: source.color }}
                          />
                          {source.name}
                        </div>
                      </th>
                    ))}
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("total")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          sortColumn === "total" && "text-foreground"
                        )}
                      >
                        Total
                        {sortColumn === "total" &&
                          (sortDirection === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUp className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredEntries.map((entry, index) => (
                    <IncomeRow
                      key={entry.id}
                      entry={entry}
                      sources={activeSources}
                      getSourceAmount={getSourceAmount}
                      total={getEntryTotal(entry.id)}
                      index={index}
                      onHoverStart={() => setHoveredEntryId(entry.id)}
                      onHoverEnd={() => setHoveredEntryId(null)}
                    />
                  ))}
                </tbody>
                {filteredEntries.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/30">
                      <td
                        colSpan={activeSources.length + 1}
                        className="px-4 py-3 text-sm font-medium text-muted-foreground"
                      >
                        {selectedYear === "all"
                          ? "Total Income"
                          : `${selectedYear} Total`}
                      </td>
                      <td className="px-4 py-3 text-right font-bold tracking-tight currency text-foreground">
                        <MaskedValue value={formatCurrency(currentTotal)} />
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>

              {filteredEntries.length === 0 && (
                <div className="py-12 text-center text-muted-foreground">
                  No income entries found
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right Column - Charts */}
        {(showSourceChart || showTrendChart) && (
          <div className="xl:w-[340px] xl:flex-shrink-0 space-y-6">
            {/* Source Breakdown Chart */}
            {showSourceChart && (
              <Card className="h-fit" {...chartHoverProps}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-medium transition-all duration-200">
                    {chartTitle}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <IncomeBreakdownChart data={sourceBreakdownData} size="compact" isRevealed={chartRevealed || hoveredEntryId !== null} />
                </CardContent>
              </Card>
            )}

            {/* Income Trend Chart */}
            {showTrendChart && (
              <Card className="h-fit">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-medium">
                    Income Trend
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <IncomeTrendChart entries={filteredEntries} amounts={amounts} />
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
