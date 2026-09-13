"use client";

import * as React from "react";
import { TrendingUp, Wallet, PiggyBank, DollarSign, Plus } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IncomeChart } from "@/components/charts/income-chart";
import { NetWorthChart } from "@/components/charts/net-worth-chart";
import { IncomeBreakdownChart } from "@/components/charts/income-breakdown-chart";
import { formatCurrency, toMonthlyAmount, cn, formatMonth } from "@/lib/utils";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { PageHeader } from "@/components/layout/page-header";
import { SetupGuide } from "@/components/features/accounting/setup-guide";
import { siteConfig } from "@/config/site";
import type { IncomeEntry, IncomeSource, IncomeAmount, Expense, ExpenseHistory, NetWorth } from "@/types/database";

// Chart range options
type ChartRange = "6mo" | "12mo" | "all";

// Chart range toggle component
function ChartRangeToggle({
  value,
  onChange,
}: {
  value: ChartRange;
  onChange: (range: ChartRange) => void;
}) {
  const options: { value: ChartRange; label: string }[] = [
    { value: "6mo", label: "6mo" },
    { value: "12mo", label: "12mo" },
    { value: "all", label: "All" },
  ];

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-[rgba(var(--ink),0.05)] p-0.5 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "px-2 py-1 text-xs font-medium rounded-md transition-colors",
            value === option.value
              ? "bg-[rgba(var(--ink),0.09)] text-foreground shadow-[inset_0_1px_0_rgba(var(--ink),0.16)]"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Chart card wrapper with hover-to-reveal
function ChartCard({
  title,
  children,
  rightContent,
  className,
}: {
  title: string;
  children: (isRevealed: boolean) => React.ReactNode;
  rightContent?: React.ReactNode;
  className?: string;
}) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();

  return (
    <Card className={className} {...hoverProps}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {rightContent}
        </div>
      </CardHeader>
      <CardContent>
        {children(isRevealed)}
      </CardContent>
    </Card>
  );
}

interface DashboardContentProps {
  incomeEntries: IncomeEntry[];
  incomeSources: IncomeSource[];
  incomeAmounts: (IncomeAmount & { income_entries: { month: string; deleted_at: string | null } })[];
  expenses: Expense[];
  expenseHistory: ExpenseHistory[];
  netWorthEntries: NetWorth[];
}

export function DashboardContent({
  incomeEntries,
  incomeSources,
  incomeAmounts,
  expenses,
  expenseHistory,
  netWorthEntries,
}: DashboardContentProps) {
  // Available months from income entries
  const availableMonths = React.useMemo(
    () => incomeEntries.map((e) => e.month),
    [incomeEntries]
  );

  // Stats always show the latest month (the period selector was removed)
  const selectedMonth = availableMonths[0] || "";
  const [incomeChartRange, setIncomeChartRange] = React.useState<ChartRange>("12mo");
  const [netWorthChartRange, setNetWorthChartRange] = React.useState<ChartRange>("12mo");

  // Get previous month for comparison
  const selectedMonthIndex = availableMonths.indexOf(selectedMonth);
  const previousMonth = availableMonths[selectedMonthIndex + 1];

  // Calculate month total helper
  const calculateMonthTotal = (month: string) => {
    return incomeAmounts
      .filter((a) => a.income_entries?.month === month)
      .reduce((sum, a) => sum + Number(a.amount), 0);
  };

  // Selected month totals
  const selectedMonthTotal = selectedMonth ? calculateMonthTotal(selectedMonth) : 0;
  const previousMonthTotal = previousMonth ? calculateMonthTotal(previousMonth) : 0;

  // Calculate monthly expenses at a specific point in time
  // If asOfDate is provided, use historical values; otherwise use current values
  const calculateExpensesAtDate = React.useCallback(
    (asOfDate?: Date) => {
      return expenses.reduce((sum, expense) => {
        let amount = Number(expense.amount);
        let frequency = expense.frequency;

        if (asOfDate) {
          // Find the earliest history entry AFTER asOfDate for this expense
          // That history entry contains what the values were BEFORE the change
          const historyAfterDate = expenseHistory
            .filter(
              (h) =>
                h.expense_id === expense.id &&
                new Date(h.changed_at) > asOfDate
            )
            .sort(
              (a, b) =>
                new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime()
            )[0];

          if (historyAfterDate) {
            // Use the historical values (what it was before the change)
            amount = Number(historyAfterDate.amount);
            frequency = historyAfterDate.frequency as typeof expense.frequency;
          }
          // If no history after asOfDate, the expense hasn't changed since then
          // so current values are correct
        }

        return sum + toMonthlyAmount(amount, frequency);
      }, 0);
    },
    [expenses, expenseHistory]
  );

  // Current monthly expenses
  const totalMonthlyExpenses = calculateExpensesAtDate();

  // Previous month's expenses (first day of previous month)
  const previousMonthExpenses = React.useMemo(() => {
    if (!previousMonth) return totalMonthlyExpenses;
    // Parse the previous month and get the first day
    const [year, month] = previousMonth.split("-").map(Number);
    const previousMonthStart = new Date(year, month - 1, 1);
    return calculateExpensesAtDate(previousMonthStart);
  }, [previousMonth, calculateExpensesAtDate, totalMonthlyExpenses]);

  const personalExpenses = expenses
    .filter((e) => e.expense_type === "personal")
    .reduce((sum, e) => sum + toMonthlyAmount(Number(e.amount), e.frequency), 0);

  const businessExpenses = expenses
    .filter((e) => e.expense_type === "business")
    .reduce((sum, e) => sum + toMonthlyAmount(Number(e.amount), e.frequency), 0);

  // Net position (income - expenses)
  const netPosition = selectedMonthTotal - totalMonthlyExpenses;
  const previousNetPosition = previousMonthTotal - previousMonthExpenses;

  // Current net worth (always latest)
  const currentNetWorth = netWorthEntries[0]?.amount ?? 0;
  const previousNetWorth = netWorthEntries[1]?.amount ?? 0;

  // Get range limit based on chart range setting
  const getRangeLimit = (range: ChartRange, totalEntries: number) => {
    switch (range) {
      case "6mo":
        return 6;
      case "12mo":
        return 12;
      case "all":
        return totalEntries;
    }
  };

  // Prepare income chart data based on range
  const incomeChartData = React.useMemo(() => {
    const limit = getRangeLimit(incomeChartRange, incomeEntries.length);
    const entriesToShow = incomeEntries.slice(0, limit).reverse();

    return entriesToShow.map((entry) => {
      const monthAmounts = incomeAmounts.filter(
        (a) => a.income_entries?.month === entry.month
      );
      const total = monthAmounts.reduce((sum, a) => sum + Number(a.amount), 0);
      const bySource: Record<string, number> = {};

      incomeSources.forEach((source) => {
        const amount = monthAmounts.find((a) => a.source_id === source.id);
        bySource[source.slug] = Number(amount?.amount ?? 0);
      });

      return {
        month: entry.month,
        total,
        ...bySource,
      };
    });
  }, [incomeEntries, incomeAmounts, incomeSources, incomeChartRange]);

  // Selected month breakdown for donut chart
  const selectedMonthBreakdown = React.useMemo(() => {
    if (!selectedMonth) return [];
    const monthAmounts = incomeAmounts.filter(
      (a) => a.income_entries?.month === selectedMonth
    );
    return incomeSources
      .map((source) => {
        const amount = monthAmounts.find((a) => a.source_id === source.id);
        return {
          name: source.name,
          value: Number(amount?.amount ?? 0),
          color: source.color,
        };
      })
      .filter((item) => item.value !== 0);
  }, [selectedMonth, incomeAmounts, incomeSources]);

  // Net worth chart data based on range
  const netWorthChartData = React.useMemo(() => {
    const limit = getRangeLimit(netWorthChartRange, netWorthEntries.length);
    return netWorthEntries.slice(0, limit).reverse().map((entry) => ({
      date: entry.date,
      amount: Number(entry.amount),
    }));
  }, [netWorthEntries, netWorthChartRange]);

  // Format selected month for display
  const formatMonthDisplay = (month: string) => {
    if (!month) return "";
    return formatMonth(month);
  };

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = siteConfig.realName.split(" ")[0];

  return (
    <div className="space-y-5 lg:space-y-6">
      <PageHeader
        title={`${greeting}, ${firstName}`}
        subtitle="Here's where things stand today."
      />

      <SetupGuide year={new Date().getFullYear()} />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3 lg:gap-4 lg:grid-cols-4">
        <StatCard
          title="Monthly Income"
          value={selectedMonthTotal}
          previousValue={previousMonthTotal}
          icon={<TrendingUp className="h-5 w-5" />}
          className="stagger-1"
        />
        <StatCard
          title="Monthly Expenses"
          value={totalMonthlyExpenses}
          previousValue={previousMonthExpenses}
          invertTrend
          icon={<Wallet className="h-5 w-5" />}
          className="stagger-2"
        />
        <StatCard
          title="Net Position"
          value={netPosition}
          previousValue={previousNetPosition}
          icon={<DollarSign className="h-5 w-5" />}
          className="stagger-3"
        />
        <StatCard
          title="Net Worth"
          value={Number(currentNetWorth)}
          previousValue={Number(previousNetWorth)}
          icon={<PiggyBank className="h-5 w-5" />}
          className="stagger-4"
        />
      </div>

      {/* Charts Row */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        {/* Income Trend - Takes 2 columns */}
        <ChartCard
          title="Income Trend"
          className="lg:col-span-2 stagger-5"
          rightContent={
            <ChartRangeToggle
              value={incomeChartRange}
              onChange={setIncomeChartRange}
            />
          }
        >
          {(isRevealed) => (
            <IncomeChart
              data={incomeChartData}
              sources={incomeSources}
              isRevealed={isRevealed}
            />
          )}
        </ChartCard>

        {/* Income Breakdown */}
        <ChartCard
          title={formatMonthDisplay(selectedMonth)}
          className="stagger-6"
        >
          {(isRevealed) => (
            <IncomeBreakdownChart
              data={selectedMonthBreakdown}
              isRevealed={isRevealed}
            />
          )}
        </ChartCard>
      </div>

      {/* Bottom Row */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        {/* Net Worth Chart */}
        <ChartCard
          title="Net Worth Over Time"
          rightContent={
            <ChartRangeToggle
              value={netWorthChartRange}
              onChange={setNetWorthChartRange}
            />
          }
        >
          {(isRevealed) => (
            <NetWorthChart data={netWorthChartData} isRevealed={isRevealed} />
          )}
        </ChartCard>

        {/* Expense Summary */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-baseline justify-between">
              <CardTitle className="text-base font-semibold">Expense Summary</CardTitle>
              <span className="text-xs text-muted-foreground">per month</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between py-3 border-b border-border">
                <div>
                  <p className="font-medium">Personal</p>
                  <p className="text-sm text-muted-foreground">
                    {expenses.filter((e) => e.expense_type === "personal").length} expenses
                  </p>
                </div>
                <p className="text-lg font-semibold currency">
                  <MaskedValue value={formatCurrency(personalExpenses)} />
                </p>
              </div>
              <div className="flex items-center justify-between py-3 border-b border-border">
                <div>
                  <p className="font-medium">Business</p>
                  <p className="text-sm text-muted-foreground">
                    {expenses.filter((e) => e.expense_type === "business").length} expenses
                  </p>
                </div>
                <p className="text-lg font-semibold currency">
                  <MaskedValue value={formatCurrency(businessExpenses)} />
                </p>
              </div>
              <div className="flex items-center justify-between pt-2">
                <p className="font-medium text-muted-foreground">Total Monthly</p>
                <p className="text-xl font-bold currency text-teal-light">
                  <MaskedValue value={formatCurrency(totalMonthlyExpenses)} />
                </p>
              </div>
              <div className="flex items-center justify-between text-sm">
                <p className="text-muted-foreground">Annual Projection</p>
                <p className="font-medium currency">
                  <MaskedValue value={formatCurrency(totalMonthlyExpenses * 12)} />
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
