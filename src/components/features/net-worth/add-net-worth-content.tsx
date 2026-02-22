"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Save,
  X,
  FileText,
  Calendar,
  DollarSign,
  Loader2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  formatCurrency,
  calculatePercentageChange,
  formatPercentage,
  cn,
} from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { NetWorth } from "@/types/database";

interface AddNetWorthContentProps {
  previousEntry: NetWorth | null;
  existingEntries: Record<string, string>; // "YYYY-MM" -> entry ID
}

// Compute the next month after a "YYYY-MM-DD" date string
function getNextMonth(dateStr: string): { year: number; month: number } {
  const [year, monthStr] = dateStr.split("-");
  const m = parseInt(monthStr, 10) - 1; // 0-indexed
  if (m === 11) {
    return { year: parseInt(year, 10) + 1, month: 0 };
  }
  return { year: parseInt(year, 10), month: m + 1 };
}

export function AddNetWorthContent({
  previousEntry,
  existingEntries,
}: AddNetWorthContentProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = React.useState(false);

  // Default to the month after the most recent entry, or current month
  const defaultDate = React.useMemo(() => {
    if (previousEntry?.date) {
      return getNextMonth(previousEntry.date);
    }
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, [previousEntry]);

  const [selectedYear, setSelectedYear] = React.useState(defaultDate.year);
  const [selectedMonth, setSelectedMonth] = React.useState(defaultDate.month);

  // Check if selected month already has an entry
  const monthValue = `${selectedYear}-${String(selectedMonth + 1).padStart(2, "0")}`;
  const conflictEntryId = existingEntries[monthValue] ?? null;
  const hasConflict = conflictEntryId !== null;

  // Form state
  const [amount, setAmount] = React.useState<number>(0);
  const [notes, setNotes] = React.useState("");

  // Calculate change from previous
  const change = previousEntry ? amount - Number(previousEntry.amount) : 0;
  const changePercent = previousEntry
    ? calculatePercentageChange(amount, Number(previousEntry.amount))
    : 0;
  const trend = change > 0 ? "up" : change < 0 ? "down" : "neutral";

  // Month navigation
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const monthRef = React.useRef(selectedMonth);
  const yearRef = React.useRef(selectedYear);

  React.useEffect(() => {
    monthRef.current = selectedMonth;
    yearRef.current = selectedYear;
  }, [selectedMonth, selectedYear]);

  const goToPreviousMonth = React.useCallback(() => {
    if (monthRef.current === 0) {
      setSelectedMonth(11);
      setSelectedYear(yearRef.current - 1);
    } else {
      setSelectedMonth(monthRef.current - 1);
    }
  }, []);

  const goToNextMonth = React.useCallback(() => {
    if (monthRef.current === 11) {
      setSelectedMonth(0);
      setSelectedYear(yearRef.current + 1);
    } else {
      setSelectedMonth(monthRef.current + 1);
    }
  }, []);

  // Hold-to-repeat for month navigation
  const holdIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const holdTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const startHold = (action: () => void) => {
    action();
    holdTimeoutRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(action, 100);
    }, 400);
  };

  const stopHold = () => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  };

  React.useEffect(() => {
    return () => stopHold();
  }, []);

  const handleSave = async () => {
    if (hasConflict) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      router.push("/net-worth");
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      // Create the entry
      const { data: entry, error } = await supabase
        .from("net_worth")
        .insert({
          date: monthValue + "-01",
          amount: amount,
          notes: notes || null,
        })
        .select()
        .single();

      if (error) throw error;

      // Navigate to the new entry
      router.push(`/net-worth/${entry.id}`);
      router.refresh();
    } catch (error) {
      console.error("Error creating net worth entry:", error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold">Net Worth Entry</h1>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <Link href="/net-worth">
            <Button variant="ghost" disabled={isSaving}>
              <X className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Cancel</span>
            </Button>
          </Link>
          <Button
            onClick={handleSave}
            disabled={isSaving || hasConflict}
            className="bg-teal text-white hover:bg-teal/90"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 sm:mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 sm:mr-1" />
            )}
            <span className="hidden sm:inline">
              {isSaving ? "Creating..." : "Create"}
            </span>
          </Button>
        </div>
      </div>

      {/* Month & Amount Summary */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-px rounded-xl overflow-hidden glass-card">
        {/* Month Selector */}
        <div className={cn(
          "bg-card/50 p-3 sm:p-5 flex flex-col items-center justify-center transition-colors",
          hasConflict && "bg-error/5"
        )}>
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-medium">Month</span>
          </div>
          <div className="flex items-center justify-center w-full">
            <div className="flex items-center justify-center gap-1">
              <button
                onMouseDown={() => startHold(goToPreviousMonth)}
                onMouseUp={stopHold}
                onMouseLeave={stopHold}
                onTouchStart={() => startHold(goToPreviousMonth)}
                onTouchEnd={stopHold}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground shrink-0 select-none"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="text-center px-1">
                <p className={cn(
                  "text-sm sm:text-base md:text-lg font-semibold whitespace-nowrap transition-colors",
                  hasConflict && "text-error"
                )}>
                  {monthNames[selectedMonth]}
                </p>
                <p className={cn(
                  "text-xs transition-colors",
                  hasConflict ? "text-error/70" : "text-muted-foreground"
                )}>
                  {selectedYear}
                </p>
              </div>
              <button
                onMouseDown={() => startHold(goToNextMonth)}
                onMouseUp={stopHold}
                onMouseLeave={stopHold}
                onTouchStart={() => startHold(goToNextMonth)}
                onTouchEnd={stopHold}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground shrink-0 select-none"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          {hasConflict && (
            <div className="flex items-center gap-1.5 mt-2 text-error">
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">
                Entry exists{" "}
                <Link
                  href={`/net-worth/${conflictEntryId}`}
                  className="underline hover:text-error/80 transition-colors"
                >
                  here
                </Link>
              </span>
            </div>
          )}
        </div>

        {/* Net Worth Amount */}
        <div className="bg-card/50 p-3 sm:p-5 text-center border-t min-[360px]:border-t-0 min-[360px]:border-l border-border/50 flex flex-col items-center justify-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Net Worth</span>
          </div>
          <Input
            type="text"
            inputMode="decimal"
            value={amount ? amount.toLocaleString("en-US") : ""}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9.\-]/g, "");
              setAmount(Number(raw) || 0);
            }}
            placeholder="0"
            className="text-center text-xl sm:text-2xl font-bold font-mono max-w-[200px]"
          />
          {previousEntry && !hasConflict && (
            amount > 0 ? (
              <p className={cn(
                "text-xs font-mono mt-1",
                trend === "up" && "text-success",
                trend === "down" && "text-error",
                trend === "neutral" && "text-muted-foreground"
              )}>
                {change >= 0 ? "+" : ""}{formatCurrency(change)} ({formatPercentage(Math.abs(changePercent))})
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setAmount(Number(previousEntry.amount))}
                className="text-xs text-muted-foreground mt-1 hover:text-foreground transition-colors cursor-pointer"
              >
                Last month: {formatCurrency(Number(previousEntry.amount))}
              </button>
            )
          )}
        </div>
      </div>

      {/* Notes */}
      <div className="flex flex-col">
        <div className="flex items-center gap-2 text-muted-foreground mb-3">
          <FileText className="h-4 w-4" />
          <span className="text-sm font-medium uppercase tracking-wider">Notes</span>
        </div>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add notes about your net worth this month..."
          className="flex-1 min-h-[150px] resize-none glass-card px-4 py-4"
        />
      </div>
    </div>
  );
}
