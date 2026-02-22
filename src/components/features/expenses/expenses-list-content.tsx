"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Briefcase,
  User,
  Play,
  Pause,
  Wallet,
  Calendar,
  ArrowUp,
  ArrowDown,
  ArrowDownAZ,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { CategoryBreakdownChart } from "@/components/charts/category-breakdown-chart";
import { TypeBreakdownChart } from "@/components/charts/type-breakdown-chart";
import { ExpenseTrendChart } from "@/components/charts/expense-trend-chart";
import {
  MaskedValue,
  useMaskedHover,
  getMaskedValue,
} from "@/components/ui/masked-value";
import {
  formatCurrency,
  toMonthlyAmount,
  toAnnualAmount,
  cn,
} from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { Expense, ExpenseHistory, ExpenseCategory } from "@/types/database";
import { EXPENSE_CATEGORIES } from "@/types/database";
import { siteConfig } from "@/config/site";

interface ExpensesListContentProps {
  expenses: Expense[];
  history: ExpenseHistory[];
}

type TabValue = "all" | "personal" | "business";
type SortColumn = "amount" | "monthly";
type SortDirection = "asc" | "desc";

// Mobile card component for expenses
function ExpenseCard({
  expense,
  monthly,
  index,
  onToggleStatus,
  isToggling,
  isFirstPaused,
}: {
  expense: Expense;
  monthly: number;
  index: number;
  onToggleStatus: (id: string, newStatus: boolean) => void;
  isToggling: boolean;
  isFirstPaused?: boolean;
}) {
  const router = useRouter();
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const currencyMask = "$•••••••";
  const displayAmount = getMaskedValue(
    formatCurrency(Number(expense.amount)),
    isHidden,
    isRevealed,
    currencyMask
  );
  const displayMonthly = getMaskedValue(
    formatCurrency(monthly),
    isHidden,
    isRevealed,
    currencyMask
  );

  const frequencyLabels: Record<string, string> = {
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    annual: "Annual",
  };

  const isPaused = !expense.is_active;

  const handleCardClick = () => {
    router.push(`/expenses/${expense.id}`);
  };

  const handleToggle = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleStatus(expense.id, !expense.is_active);
  };

  return (
    <div className="relative">
      {isFirstPaused && (
        <div className="flex items-center gap-3 mb-3 mt-2">
          <div className="flex-1 border-t border-dashed border-border/50" />
          <span className="text-[10px] font-medium text-muted-foreground bg-muted/80 border border-border px-2 py-0.5 rounded-full uppercase tracking-wider">
            Inactive
          </span>
          <div className="flex-1 border-t border-dashed border-border/50" />
        </div>
      )}
      <div
        onClick={handleCardClick}
        onTouchStart={hoverProps.onMouseEnter}
        onTouchEnd={hoverProps.onMouseLeave}
        className={cn(
          "glass-card rounded-xl p-4 cursor-pointer transition-all duration-300",
          "hover:border-primary/30 active:scale-[0.98]",
          "animate-fade-up",
          `stagger-${Math.min(index + 1, 6)}`,
          isPaused && "opacity-60"
        )}
        {...hoverProps}
      >
        {/* Header: Name and Status Toggle */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <span
              className={cn(
                "font-semibold block truncate",
                isPaused ? "text-muted-foreground" : "text-foreground"
              )}
            >
              {expense.name}
            </span>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                  expense.expense_type === "personal"
                    ? "bg-teal/20 text-teal-light"
                    : "bg-copper/20 text-copper"
                )}
              >
                {expense.expense_type === "personal" ? (
                  <User className="h-3 w-3" />
                ) : (
                  <Briefcase className="h-3 w-3" />
                )}
                {expense.expense_type === "personal" ? "Personal" : siteConfig.companyName}
              </span>
              {expense.category && (
                <span className="text-xs text-muted-foreground">
                  {EXPENSE_CATEGORIES[expense.category]}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={handleToggle}
            disabled={isToggling}
            className={cn(
              "p-2 rounded-lg transition-colors shrink-0",
              expense.is_active
                ? "bg-success/10 text-success hover:bg-success/20"
                : "bg-copper/10 text-copper hover:bg-copper/20",
              isToggling && "opacity-50 cursor-not-allowed"
            )}
          >
            {isToggling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : expense.is_active ? (
              <Play className="h-4 w-4" />
            ) : (
              <Pause className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Amount Details */}
        <div className="border-t border-border/50 pt-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <span className="text-xs text-muted-foreground block mb-0.5">Amount</span>
              <span className={cn("font-mono text-sm", isPaused && "text-muted-foreground")}>
                {displayAmount}
              </span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block mb-0.5">Frequency</span>
              <span className="text-sm text-muted-foreground">
                {frequencyLabels[expense.frequency]}
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs text-muted-foreground block mb-0.5">Monthly</span>
              <span
                className={cn(
                  "font-mono font-semibold",
                  isPaused ? "text-muted-foreground font-normal" : "text-foreground"
                )}
              >
                {displayMonthly}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Table row with hover-to-reveal
function ExpenseRow({
  expense,
  monthly,
  index,
  onToggleStatus,
  isToggling,
  isFirstPaused,
}: {
  expense: Expense;
  monthly: number;
  index: number;
  onToggleStatus: (id: string, newStatus: boolean) => void;
  isToggling: boolean;
  isFirstPaused?: boolean;
}) {
  const router = useRouter();
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const currencyMask = "$•••••••";
  const displayAmount = getMaskedValue(
    formatCurrency(Number(expense.amount)),
    isHidden,
    isRevealed,
    currencyMask
  );
  const displayMonthly = getMaskedValue(
    formatCurrency(monthly),
    isHidden,
    isRevealed,
    currencyMask
  );

  const frequencyLabels: Record<string, string> = {
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    annual: "Annual",
  };

  const isPaused = !expense.is_active;

  const handleRowClick = () => {
    router.push(`/expenses/${expense.id}`);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleStatus(expense.id, !expense.is_active);
  };

  return (
    <tr
      onClick={handleRowClick}
      className={cn(
        "transition-all duration-300 hover:bg-secondary/50 cursor-pointer animate-fade-up",
        `stagger-${Math.min(index + 1, 6)}`,
        isPaused && "bg-foreground/[0.03] text-muted-foreground",
        isFirstPaused && "relative border-t-border/50"
      )}
      style={isFirstPaused ? { borderTopStyle: 'dashed' } : undefined}
      {...hoverProps}
    >
      <td className="px-4 py-3 align-middle">
        {isFirstPaused && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
            <span className="text-[10px] font-medium text-muted-foreground bg-muted/80 border border-border px-2 py-0.5 rounded-full uppercase tracking-wider">
              Inactive
            </span>
          </div>
        )}
        <span
          className={cn(
            "font-medium transition-colors",
            isPaused
              ? "text-muted-foreground"
              : "text-foreground"
          )}
        >
          {expense.name}
        </span>
      </td>
      <td className="px-4 py-3 align-middle">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
            expense.expense_type === "personal"
              ? "bg-teal/20 text-teal-light"
              : "bg-copper/20 text-copper"
          )}
        >
          {expense.expense_type === "personal" ? (
            <User className="h-3 w-3" />
          ) : (
            <Briefcase className="h-3 w-3" />
          )}
          {expense.expense_type === "personal" ? "Personal" : siteConfig.companyName}
        </span>
      </td>
      <td className="px-4 py-3 align-middle text-sm text-muted-foreground">
        {expense.category ? EXPENSE_CATEGORIES[expense.category] : "—"}
      </td>
      <td className={cn("px-4 py-3 align-middle text-right font-mono text-sm min-w-[140px]", isPaused && "text-muted-foreground")}>{displayAmount}</td>
      <td className="px-4 py-3 align-middle text-sm text-muted-foreground">
        {frequencyLabels[expense.frequency]}
      </td>
      <td className={cn("px-4 py-3 align-middle text-right font-mono text-sm font-medium min-w-[140px]", isPaused && "text-muted-foreground font-normal")}>
        {displayMonthly}
      </td>
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center justify-center">
          <Tooltip content={expense.is_active ? "Click to pause" : "Click to activate"} position="top">
            <button
              onClick={handleToggle}
              disabled={isToggling}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                "hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/50",
                isToggling && "opacity-50 cursor-not-allowed"
              )}
            >
              {isToggling ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : expense.is_active ? (
                <Play className="h-4 w-4 text-success" />
              ) : (
                <Pause className="h-4 w-4 text-copper" />
              )}
            </button>
          </Tooltip>
        </div>
      </td>
    </tr>
  );
}

export function ExpensesListContent({ expenses: initialExpenses, history }: ExpensesListContentProps) {
  const [expenses, setExpenses] = React.useState<Expense[]>(initialExpenses);
  const [activeTab, setActiveTab] = React.useState<TabValue>("all");
  const [sortColumn, setSortColumn] = React.useState<SortColumn>("monthly");
  const [sortDirection, setSortDirection] = React.useState<SortDirection>("desc");
  const [sortByName, setSortByName] = React.useState(false);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  // Toggle expense active status
  const handleToggleStatus = async (id: string, newStatus: boolean) => {
    setTogglingId(id);

    // Optimistic update
    setExpenses((prev) =>
      prev.map((e) => (e.id === id ? { ...e, is_active: newStatus } : e))
    );

    const supabase = createClient();

    try {
      const { error } = await supabase
        .from("expenses")
        .update({ is_active: newStatus })
        .eq("id", id);

      if (error) {
        // Revert on error
        setExpenses((prev) =>
          prev.map((e) => (e.id === id ? { ...e, is_active: !newStatus } : e))
        );
        console.error("Error toggling expense status:", error);
      }
    } catch (error) {
      // Revert on error
      setExpenses((prev) =>
        prev.map((e) => (e.id === id ? { ...e, is_active: !newStatus } : e))
      );
      console.error("Error toggling expense status:", error);
    } finally {
      setTogglingId(null);
    }
  };

  // Toggle sort when clicking a column header
  const handleSort = (column: SortColumn) => {
    // Disable name sort when using numeric sort
    setSortByName(false);

    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(sortDirection === "desc" ? "asc" : "desc");
    } else {
      // New column, default to descending
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  // Toggle alphabetical sort
  const toggleNameSort = () => {
    setSortByName(!sortByName);
  };

  // Filter and sort expenses by tab and selected column
  // Paused expenses always appear at the bottom
  const filteredExpenses = React.useMemo(() => {
    const filtered = activeTab === "all"
      ? expenses
      : expenses.filter((e) => e.expense_type === activeTab);

    return [...filtered].sort((a, b) => {
      // Paused expenses always go to the bottom
      if (a.is_active && !b.is_active) return -1;
      if (!a.is_active && b.is_active) return 1;

      // If sorting by name, use alphabetical sort
      if (sortByName) {
        return a.name.localeCompare(b.name);
      }

      // Otherwise use numeric sort
      let aValue: number;
      let bValue: number;

      if (sortColumn === "amount") {
        aValue = Number(a.amount);
        bValue = Number(b.amount);
      } else {
        aValue = toMonthlyAmount(Number(a.amount), a.frequency);
        bValue = toMonthlyAmount(Number(b.amount), b.frequency);
      }

      return sortDirection === "desc" ? bValue - aValue : aValue - bValue;
    });
  }, [expenses, activeTab, sortColumn, sortDirection, sortByName]);

  // Calculate totals (only active expenses)
  const calculateTotals = (exps: Expense[]) => {
    const activeExps = exps.filter((e) => e.is_active);
    const monthly = activeExps.reduce(
      (sum, e) => sum + toMonthlyAmount(Number(e.amount), e.frequency),
      0
    );
    const annual = activeExps.reduce(
      (sum, e) => sum + toAnnualAmount(Number(e.amount), e.frequency),
      0
    );
    return { monthly, annual };
  };

  const allTotals = calculateTotals(expenses);
  const personalTotals = calculateTotals(
    expenses.filter((e) => e.expense_type === "personal")
  );
  const businessTotals = calculateTotals(
    expenses.filter((e) => e.expense_type === "business")
  );
  const currentTotals = calculateTotals(filteredExpenses);

  // Calculate category distribution (monthly equivalent for each category)
  // Uses filtered expenses so it reflects the current view, only active expenses
  const categoryTotals = React.useMemo(() => {
    const totals: Partial<Record<ExpenseCategory, number>> = {};
    filteredExpenses
      .filter((e) => e.is_active)
      .forEach((e) => {
        if (e.category) {
          const monthlyAmount = toMonthlyAmount(Number(e.amount), e.frequency);
          totals[e.category] = (totals[e.category] || 0) + monthlyAmount;
        }
      });
    return totals;
  }, [filteredExpenses]);

  // Chart visibility: 1 pie chart per 9 expenses (based on current filter)
  // Priority: 1. Category Breakdown (always), 2. History Trend (if data), 3. Type Breakdown
  const totalChartsAllowed = Math.max(1, Math.floor(filteredExpenses.length / 9));
  // Category Breakdown always takes 1 slot, so additional slots are totalChartsAllowed - 1
  const additionalChartsAllowed = totalChartsAllowed - 1;
  const hasTrendData = history.length > 0;
  // Trend chart gets priority #2 if data exists
  const showTrendChart = additionalChartsAllowed >= 1 && hasTrendData;
  // Type chart shows if we have slots remaining after trend
  const chartsUsedByTrend = showTrendChart ? 1 : 0;
  const showTypeChart = additionalChartsAllowed > chartsUsedByTrend;

  const tabs: {
    value: TabValue;
    label: string;
    icon: React.ReactNode;
    count: number;
  }[] = [
    {
      value: "all",
      label: "All",
      icon: null,
      count: expenses.length,
    },
    {
      value: "personal",
      label: "Personal",
      icon: <User className="h-4 w-4" />,
      count: expenses.filter((e) => e.expense_type === "personal").length,
    },
    {
      value: "business",
      label: siteConfig.companyName,
      icon: <Briefcase className="h-4 w-4" />,
      count: expenses.filter((e) => e.expense_type === "business").length,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          title="Total Monthly"
          value={allTotals.monthly}
          icon={<Wallet className="h-5 w-5" />}
          className="stagger-1"
        />
        <StatCard
          title="Personal"
          value={personalTotals.monthly}
          icon={<User className="h-5 w-5" />}
          className="stagger-2"
        />
        <StatCard
          title={siteConfig.companyName}
          value={businessTotals.monthly}
          icon={<Briefcase className="h-5 w-5" />}
          className="stagger-3"
        />
        <StatCard
          title="Annual Projection"
          value={allTotals.annual}
          icon={<Calendar className="h-5 w-5" />}
          className="stagger-4"
        />
      </div>

      {/* Tabs and Add Button */}
      <div className="flex items-center justify-between gap-2 min-[560px]:gap-4">
        {/* Mobile: Dropdown select for tabs */}
        <div className="min-[600px]:hidden w-40">
          <CustomSelect
            value={activeTab}
            onChange={(value) => setActiveTab(value as TabValue)}
            options={tabs.map((tab) => ({
              value: tab.value,
              label: `${tab.value === "all" ? "All Expenses" : tab.label} (${tab.count})`,
            }))}
            size="sm"
          />
        </div>

        {/* Desktop: Button tabs */}
        <div className="hidden min-[600px]:flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                activeTab === tab.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              {tab.icon}
              {tab.label}
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-xs",
                  activeTab === tab.value
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <Link href="/expenses/new">
          <Button>
            <Plus className="h-4 w-4" />
            Add Expense
          </Button>
        </Link>
      </div>

      {/* Table and Chart Layout */}
      <div className="flex flex-col xl:flex-row gap-6">
        {/* Mobile: Card Layout */}
        <div className="lg:hidden flex-1 space-y-3">
          {/* Mobile Sort Controls */}
          <div className="flex items-center gap-2 px-1 flex-wrap">
            <span className="text-xs text-muted-foreground">Sort by:</span>
            <button
              onClick={toggleNameSort}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                sortByName
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Name
              {sortByName && <ArrowDownAZ className="h-3 w-3" />}
            </button>
            <button
              onClick={() => handleSort("amount")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                !sortByName && sortColumn === "amount"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Amount
              {!sortByName && sortColumn === "amount" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
            <button
              onClick={() => handleSort("monthly")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                !sortByName && sortColumn === "monthly"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Monthly
              {!sortByName && sortColumn === "monthly" &&
                (sortDirection === "desc" ? (
                  <ArrowDown className="h-3 w-3" />
                ) : (
                  <ArrowUp className="h-3 w-3" />
                ))}
            </button>
          </div>

          {/* Cards */}
          {(() => {
            const activeExpenses = filteredExpenses.filter((e) => e.is_active);
            const pausedExpenses = filteredExpenses.filter((e) => !e.is_active);

            return (
              <>
                {activeExpenses.map((expense, index) => (
                  <ExpenseCard
                    key={expense.id}
                    expense={expense}
                    monthly={toMonthlyAmount(
                      Number(expense.amount),
                      expense.frequency
                    )}
                    index={index}
                    onToggleStatus={handleToggleStatus}
                    isToggling={togglingId === expense.id}
                  />
                ))}
                {pausedExpenses.map((expense, index) => (
                  <ExpenseCard
                    key={expense.id}
                    expense={expense}
                    monthly={toMonthlyAmount(
                      Number(expense.amount),
                      expense.frequency
                    )}
                    index={activeExpenses.length + index}
                    onToggleStatus={handleToggleStatus}
                    isToggling={togglingId === expense.id}
                    isFirstPaused={index === 0}
                  />
                ))}
              </>
            );
          })()}

          {/* Mobile Total Footer */}
          {filteredExpenses.length > 0 && (
            <div className="glass-card rounded-xl p-4 mt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  {activeTab === "all"
                    ? "Total Fixed Expenses"
                    : activeTab === "personal"
                      ? "Personal Total"
                      : `${siteConfig.companyName} Total`}
                </span>
                <span className="font-mono font-bold text-lg text-foreground">
                  <MaskedValue value={formatCurrency(currentTotals.monthly)} />
                </span>
              </div>
            </div>
          )}

          {filteredExpenses.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              No expenses found
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
                        onClick={toggleNameSort}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          sortByName && "text-foreground"
                        )}
                      >
                        Expense
                        {sortByName && <ArrowDownAZ className="h-3 w-3" />}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Category
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("amount")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          !sortByName && sortColumn === "amount" && "text-foreground"
                        )}
                      >
                        Amount
                        {!sortByName && sortColumn === "amount" && (
                          sortDirection === "desc"
                            ? <ArrowDown className="h-3 w-3" />
                            : <ArrowUp className="h-3 w-3" />
                        )}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Frequency
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      <button
                        onClick={() => handleSort("monthly")}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                          !sortByName && sortColumn === "monthly" && "text-foreground"
                        )}
                      >
                        Monthly
                        {!sortByName && sortColumn === "monthly" && (
                          sortDirection === "desc"
                            ? <ArrowDown className="h-3 w-3" />
                            : <ArrowUp className="h-3 w-3" />
                        )}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-muted-foreground">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(() => {
                    const activeExpenses = filteredExpenses.filter((e) => e.is_active);
                    const pausedExpenses = filteredExpenses.filter((e) => !e.is_active);

                    return (
                      <>
                        {activeExpenses.map((expense, index) => (
                          <ExpenseRow
                            key={expense.id}
                            expense={expense}
                            monthly={toMonthlyAmount(
                              Number(expense.amount),
                              expense.frequency
                            )}
                            index={index}
                            onToggleStatus={handleToggleStatus}
                            isToggling={togglingId === expense.id}
                          />
                        ))}
                        {pausedExpenses.map((expense, index) => (
                          <ExpenseRow
                            key={expense.id}
                            expense={expense}
                            monthly={toMonthlyAmount(
                              Number(expense.amount),
                              expense.frequency
                            )}
                            index={activeExpenses.length + index}
                            onToggleStatus={handleToggleStatus}
                            isToggling={togglingId === expense.id}
                            isFirstPaused={index === 0}
                          />
                        ))}
                      </>
                    );
                  })()}
                </tbody>
                {filteredExpenses.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/30">
                      <td
                        colSpan={5}
                        className="px-4 py-3 text-sm font-medium text-muted-foreground"
                      >
                        {activeTab === "all"
                          ? "Total Fixed Expenses"
                          : activeTab === "personal"
                            ? "Personal Total"
                            : `${siteConfig.companyName} Total`}
                      </td>
                      <td className="px-4 py-3 text-right font-bold tracking-tight currency text-foreground">
                        <MaskedValue value={formatCurrency(currentTotals.monthly)} />
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>

              {filteredExpenses.length === 0 && (
                <div className="py-12 text-center text-muted-foreground">
                  No expenses found
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right Column - Charts */}
        <div className="xl:w-[340px] xl:flex-shrink-0 space-y-6">
          {/* Category Breakdown Chart */}
          <Card className="h-fit">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-medium">Category Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryBreakdownChart categoryTotals={categoryTotals} />
            </CardContent>
          </Card>

          {/* Type Breakdown Chart (Personal vs Business) */}
          {showTypeChart && (
            <Card className="h-fit">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-medium">
                  Type Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TypeBreakdownChart
                  personal={personalTotals.monthly}
                  business={businessTotals.monthly}
                />
              </CardContent>
            </Card>
          )}

          {/* Expense Trend Chart */}
          {showTrendChart && (
            <Card className="h-fit">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-medium">
                  Expense Trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ExpenseTrendChart history={history} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
