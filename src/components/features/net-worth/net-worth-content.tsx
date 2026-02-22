"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Wallet,
  Calendar,
  ArrowUp,
  ArrowDown,
  Trophy,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { NetWorthChart } from "@/components/charts/net-worth-chart";
import { NetWorthChangeChart } from "@/components/charts/net-worth-change-chart";
import {
  MaskedValue,
  useMaskedHover,
  getMaskedValue,
} from "@/components/ui/masked-value";
import {
  formatCurrency,
  formatMonth,
  formatDate,
  parseLocalDate,
  calculatePercentageChange,
  formatPercentage,
  cn,
} from "@/lib/utils";
import type { NetWorth } from "@/types/database";

interface NetWorthContentProps {
  entries: NetWorth[];
}

type SortColumn = "date" | "amount" | "change";
type SortDirection = "asc" | "desc";

// Mobile card component
function NetWorthCard({
  entry,
  prevEntry,
  index,
}: {
  entry: NetWorth;
  prevEntry: NetWorth | undefined;
  index: number;
}) {
  const router = useRouter();
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const currencyMask = "$•••••••";

  const change = prevEntry
    ? Number(entry.amount) - Number(prevEntry.amount)
    : 0;
  const changePercent = prevEntry
    ? calculatePercentageChange(Number(entry.amount), Number(prevEntry.amount))
    : 0;

  const displayAmount = getMaskedValue(
    formatCurrency(Number(entry.amount)),
    isHidden,
    isRevealed,
    currencyMask
  );
  const displayChange = getMaskedValue(
    formatCurrency(Math.abs(change)),
    isHidden,
    isRevealed,
    currencyMask
  );
  const displayPercent = getMaskedValue(
    formatPercentage(changePercent),
    isHidden,
    isRevealed
  );

  return (
    <div
      onClick={() => router.push(`/net-worth/${entry.id}`)}
      onTouchStart={hoverProps.onMouseEnter}
      onTouchEnd={hoverProps.onMouseLeave}
      {...hoverProps}
      className={cn(
        "glass-card rounded-xl p-4 cursor-pointer transition-all duration-300",
        "hover:border-primary/30 active:scale-[0.98]",
        "animate-fade-up",
        `stagger-${Math.min(index + 1, 6)}`
      )}
    >
      {/* Header: Month and Amount */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0">
            <Calendar className="h-4 w-4 text-primary" />
          </div>
          <span className="font-semibold text-foreground">
            {formatMonth(entry.date)}
          </span>
        </div>
        <div className="text-right">
          <span
            className={cn(
              "font-mono font-semibold text-lg",
              Number(entry.amount) < 0 ? "text-error" : "text-primary"
            )}
          >
            {displayAmount}
          </span>
        </div>
      </div>

      {/* Change + Notes */}
      {(prevEntry || entry.notes) && (
        <div className="border-t border-border/50 pt-3 mt-3 space-y-2">
          {prevEntry && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Change</span>
              <span
                className={cn(
                  "font-mono text-sm",
                  isHidden && !isRevealed
                    ? "text-muted-foreground"
                    : change > 0
                    ? "text-success"
                    : change < 0
                    ? "text-error"
                    : "text-muted-foreground"
                )}
              >
                {displayChange}
                <span className="text-xs opacity-75 ml-1">({displayPercent})</span>
              </span>
            </div>
          )}
          {entry.notes && (
            <p className="text-sm text-muted-foreground truncate">
              {entry.notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Table row with hover-to-reveal
function NetWorthRow({
  entry,
  prevEntry,
  index,
}: {
  entry: NetWorth;
  prevEntry: NetWorth | undefined;
  index: number;
}) {
  const router = useRouter();
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const currencyMask = "$•••••••";

  const change = prevEntry
    ? Number(entry.amount) - Number(prevEntry.amount)
    : 0;
  const changePercent = prevEntry
    ? calculatePercentageChange(Number(entry.amount), Number(prevEntry.amount))
    : 0;

  const displayAmount = getMaskedValue(
    formatCurrency(Number(entry.amount)),
    isHidden,
    isRevealed,
    currencyMask
  );
  const displayChange = getMaskedValue(
    formatCurrency(Math.abs(change)),
    isHidden,
    isRevealed,
    currencyMask
  );
  const displayPercent = getMaskedValue(
    formatPercentage(changePercent),
    isHidden,
    isRevealed
  );

  const handleRowClick = () => {
    router.push(`/net-worth/${entry.id}`);
  };

  return (
    <tr
      onClick={handleRowClick}
      className={cn(
        "transition-all duration-300 hover:bg-secondary/50 cursor-pointer animate-fade-up",
        `stagger-${Math.min(index + 1, 6)}`
      )}
      {...hoverProps}
    >
      <td className="px-4 py-3 align-middle">
        <span className="font-medium text-foreground">
          {formatMonth(entry.date)}
        </span>
      </td>
      <td
        className={cn(
          "px-4 py-3 align-middle text-right font-mono font-medium min-w-[140px]",
          Number(entry.amount) < 0 ? "text-error" : "text-primary"
        )}
      >
        {displayAmount}
      </td>
      <td className="px-4 py-3 align-middle text-right min-w-[160px]">
        {prevEntry && (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-mono text-sm",
              // Neutralize colors when hidden
              isHidden && !isRevealed
                ? "text-muted-foreground"
                : change > 0
                ? "text-success"
                : change < 0
                ? "text-error"
                : "text-muted-foreground"
            )}
          >
            {displayChange}
            <span className="text-xs opacity-75">({displayPercent})</span>
          </span>
        )}
        {!prevEntry && <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-4 py-3 align-middle text-sm text-muted-foreground truncate max-w-[200px]">
        {entry.notes || "—"}
      </td>
    </tr>
  );
}

export function NetWorthContent({ entries }: NetWorthContentProps) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = React.useState<string>("all");
  const [sortColumn, setSortColumn] = React.useState<SortColumn>("date");
  const [sortDirection, setSortDirection] = React.useState<SortDirection>("desc");

  // Hover-to-reveal for the trend chart
  const { isRevealed: trendChartRevealed, hoverProps: trendChartHoverProps } = useMaskedHover();

  // Get unique years from entries
  const years = React.useMemo(() => {
    const uniqueYears = new Set(
      entries.map((e) => parseLocalDate(e.date).getFullYear())
    );
    return Array.from(uniqueYears).sort((a, b) => b - a);
  }, [entries]);

  // Toggle sort when clicking a column header
  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "desc" ? "asc" : "desc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  // Create a map of entry to previous entry for change calculation
  const entryToPrevMap = React.useMemo(() => {
    const map = new Map<string, NetWorth | undefined>();
    const sorted = [...entries].sort(
      (a, b) => parseLocalDate(b.date).getTime() - parseLocalDate(a.date).getTime()
    );
    sorted.forEach((entry, index) => {
      map.set(entry.id, sorted[index + 1]);
    });
    return map;
  }, [entries]);

  // Calculate change for an entry
  const getEntryChange = React.useCallback(
    (entry: NetWorth) => {
      const prev = entryToPrevMap.get(entry.id);
      return prev ? Number(entry.amount) - Number(prev.amount) : 0;
    },
    [entryToPrevMap]
  );

  // Filter and sort entries
  const filteredEntries = React.useMemo(() => {
    let filtered = entries;

    // Filter by year
    if (selectedYear !== "all") {
      filtered = entries.filter((entry) => {
        const year = parseLocalDate(entry.date).getFullYear();
        return year === parseInt(selectedYear);
      });
    }

    // Sort
    return [...filtered].sort((a, b) => {
      let comparison = 0;

      if (sortColumn === "date") {
        comparison = parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime();
      } else if (sortColumn === "amount") {
        comparison = Number(a.amount) - Number(b.amount);
      } else if (sortColumn === "change") {
        comparison = getEntryChange(a) - getEntryChange(b);
      }

      return sortDirection === "desc" ? -comparison : comparison;
    });
  }, [entries, selectedYear, sortColumn, sortDirection, getEntryChange]);

  // Current and previous values (from all entries, not filtered)
  const current = entries[0];
  const previous = entries[1];

  // Stats calculations
  const stats = React.useMemo(() => {
    const targetEntries = selectedYear === "all" ? entries : filteredEntries;
    if (targetEntries.length === 0) {
      return { high: 0, low: 0, average: 0, totalChange: 0 };
    }

    const amounts = targetEntries.map((e) => Number(e.amount));
    const high = Math.max(...amounts);
    const low = Math.min(...amounts);
    const average = amounts.reduce((sum, a) => sum + a, 0) / amounts.length;

    // Calculate total change for the period
    const sortedByDate = [...targetEntries].sort(
      (a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime()
    );
    const first = sortedByDate[0];
    const last = sortedByDate[sortedByDate.length - 1];
    const totalChange = first && last ? Number(last.amount) - Number(first.amount) : 0;

    return { high, low, average, totalChange };
  }, [entries, filteredEntries, selectedYear]);

  // Chart data (filtered entries, chronological order)
  const chartData = React.useMemo(() => {
    return [...filteredEntries]
      .sort((a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime())
      .map((entry) => ({
        date: entry.date,
        amount: Number(entry.amount),
      }));
  }, [filteredEntries]);

  // Monthly change data for bar chart
  // Uses full entries list to find prior month (e.g., Dec of prior year for Jan)
  const changeData = React.useMemo(() => {
    const sorted = [...filteredEntries].sort(
      (a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime()
    );

    // Build a lookup from the full (unfiltered) entries sorted chronologically
    const allSorted = [...entries].sort(
      (a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime()
    );

    return sorted
      .map((entry) => {
        // Find this entry's index in the full list, then grab the one before it
        const idxInAll = allSorted.findIndex((e) => e.id === entry.id);
        if (idxInAll <= 0) return null; // No prior entry exists at all — skip
        const prev = allSorted[idxInAll - 1];
        return {
          date: entry.date,
          change: Number(entry.amount) - Number(prev.amount),
        };
      })
      .filter((d): d is { date: string; change: number } => d !== null);
  }, [filteredEntries, entries]);

  // Chart visibility
  const showTrendChart = chartData.length >= 2;
  const showChangeChart = changeData.length >= 6;

  // Year tabs
  const yearTabs = [
    { value: "all", label: "All", count: entries.length },
    ...years.map((year) => ({
      value: year.toString(),
      label: year.toString(),
      count: entries.filter((e) => parseLocalDate(e.date).getFullYear() === year).length,
    })),
  ];

  return (
    <div className="space-y-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          title="Current Net Worth"
          value={current ? Number(current.amount) : 0}
          icon={<Wallet className="h-5 w-5" />}
          className="stagger-1"
        />
        <StatCard
          title={selectedYear === "all" ? "All-Time High" : `${selectedYear} High`}
          value={stats.high}
          icon={<Trophy className="h-5 w-5" />}
          trend="up"
          className="stagger-2"
        />
        <StatCard
          title={selectedYear === "all" ? "All-Time Low" : `${selectedYear} Low`}
          value={stats.low}
          icon={<Target className="h-5 w-5" />}
          trend="down"
          className="stagger-3"
        />
        <StatCard
          title="Average"
          value={stats.average}
          icon={<Calendar className="h-5 w-5" />}
          className="stagger-4"
        />
      </div>

      {/* Tabs and Add Button */}
      <div className="flex items-center justify-between gap-2 min-[560px]:gap-4">
        {/* Mobile: Dropdown select for tabs */}
        <div className="min-[700px]:hidden w-32">
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
          {yearTabs.slice(0, 6).map((tab) => (
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
          {yearTabs.length > 6 && (
            <CustomSelect
              value={yearTabs.slice(6).some((t) => t.value === selectedYear) ? selectedYear : ""}
              onChange={(value) => setSelectedYear(value)}
              options={yearTabs.slice(6).map((tab) => ({
                value: tab.value,
                label: tab.label,
              }))}
              size="sm"
              placeholder="More..."
            />
          )}
        </div>

        <Link href="/net-worth/new">
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
              onClick={() => handleSort("date")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                sortColumn === "date"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Date
              {sortColumn === "date" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
            <button
              onClick={() => handleSort("amount")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                sortColumn === "amount"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Amount
              {sortColumn === "amount" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
            <button
              onClick={() => handleSort("change")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                sortColumn === "change"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Change
              {sortColumn === "change" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
          </div>

          {/* Cards */}
          {filteredEntries.map((entry, index) => (
            <NetWorthCard
              key={entry.id}
              entry={entry}
              prevEntry={entryToPrevMap.get(entry.id)}
              index={index}
            />
          ))}

          {/* Mobile Total Footer */}
          {filteredEntries.length > 0 && (
            <div className="glass-card rounded-xl p-4 mt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  {selectedYear === "all" ? "Period Change" : `${selectedYear} Change`}
                </span>
                <span
                  className={cn(
                    "font-mono font-bold text-lg",
                    stats.totalChange > 0
                      ? "text-success"
                      : stats.totalChange < 0
                      ? "text-error"
                      : "text-foreground"
                  )}
                >
                  <MaskedValue
                    value={`${stats.totalChange >= 0 ? "+" : ""}${formatCurrency(stats.totalChange)}`}
                  />
                </span>
              </div>
            </div>
          )}

          {filteredEntries.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              No net worth entries found
            </div>
          )}
        </div>

        {/* Desktop: Table */}
        <Card className="hidden lg:block flex-1 min-w-0 h-fit">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("date")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          sortColumn === "date" && "text-foreground"
                        )}
                      >
                        Date
                        {sortColumn === "date" &&
                          (sortDirection === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUp className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("amount")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          sortColumn === "amount" && "text-foreground"
                        )}
                      >
                        Amount
                        {sortColumn === "amount" &&
                          (sortDirection === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUp className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("change")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          sortColumn === "change" && "text-foreground"
                        )}
                      >
                        Change
                        {sortColumn === "change" &&
                          (sortDirection === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUp className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredEntries.map((entry, index) => (
                    <NetWorthRow
                      key={entry.id}
                      entry={entry}
                      prevEntry={entryToPrevMap.get(entry.id)}
                      index={index}
                    />
                  ))}
                </tbody>
                {filteredEntries.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/30">
                      <td className="px-4 py-3 text-sm font-medium text-muted-foreground">
                        {selectedYear === "all" ? "Period Change" : `${selectedYear} Change`}
                      </td>
                      <td></td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={cn(
                            "font-bold tracking-tight font-mono",
                            stats.totalChange > 0
                              ? "text-success"
                              : stats.totalChange < 0
                              ? "text-error"
                              : "text-foreground"
                          )}
                        >
                          <MaskedValue
                            value={`${stats.totalChange >= 0 ? "+" : ""}${formatCurrency(stats.totalChange)}`}
                          />
                        </span>
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>

              {filteredEntries.length === 0 && (
                <div className="py-12 text-center text-muted-foreground">
                  No net worth entries found
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right Column - Charts */}
        {(showTrendChart || showChangeChart) && (
          <div className="xl:w-[340px] xl:flex-shrink-0 space-y-6">
            {/* Net Worth Trend Chart */}
            {showTrendChart && (
              <Card className="h-fit" {...trendChartHoverProps}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-medium">
                    Net Worth Trend
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <NetWorthChart data={chartData} isRevealed={trendChartRevealed} />
                </CardContent>
              </Card>
            )}

            {/* Monthly Change Chart */}
            {showChangeChart && (
              <Card className="h-fit">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-medium">
                    Monthly Change
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <NetWorthChangeChart data={changeData} />
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
