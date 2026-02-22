"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Loader2,
  Save,
  X,
  Calendar,
  DollarSign,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { IncomeSource } from "@/types/database";

interface AddIncomeContentProps {
  sources: IncomeSource[];
  existingEntries: Record<string, string>; // "YYYY-MM" -> entry ID
  latestMonth: string | null; // "YYYY-MM-DD" of the most recent entry
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

export function AddIncomeContent({
  sources,
  existingEntries,
  latestMonth,
}: AddIncomeContentProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = React.useState(false);
  const [showNotes, setShowNotes] = React.useState(false);

  // Default to the month after the most recent entry, or current month
  const defaultDate = React.useMemo(() => {
    if (latestMonth) {
      return getNextMonth(latestMonth);
    }
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, [latestMonth]);

  const [selectedYear, setSelectedYear] = React.useState(defaultDate.year);
  const [selectedMonth, setSelectedMonth] = React.useState(defaultDate.month);

  // Check if selected month already has an entry
  const monthValue = `${selectedYear}-${String(selectedMonth + 1).padStart(2, "0")}`;
  const conflictEntryId = existingEntries[monthValue] ?? null;
  const hasConflict = conflictEntryId !== null;

  // Form state
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState("");

  // Calculate total
  const total = Object.values(amounts).reduce(
    (sum, amt) => sum + (parseFloat(amt) || 0),
    0
  );

  // Count sources with values (positive or negative)
  const filledSourceCount = Object.values(amounts).filter(a => parseFloat(a) !== 0).length;

  // Sort sources by amount: positive (highest to lowest), then losses, then zero/empty
  const sortedSources = React.useMemo(() => {
    return [...sources].sort((a, b) => {
      const amountA = parseFloat(amounts[a.id] || "0") || 0;
      const amountB = parseFloat(amounts[b.id] || "0") || 0;

      // Zero entries go last
      if (amountA === 0 && amountB !== 0) return 1;
      if (amountB === 0 && amountA !== 0) return -1;

      // Both non-zero: sort by absolute value descending (positive first, then negative)
      if (amountA > 0 && amountB <= 0) return -1;
      if (amountB > 0 && amountA <= 0) return 1;

      // Both positive or both negative: sort by value descending
      return amountB - amountA;
    });
  }, [sources, amounts]);

  // Month navigation
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  // Use refs to track current values for the interval callbacks
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
    action(); // Fire immediately on click
    // Start repeating after 400ms delay, then every 100ms
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

  // Cleanup on unmount
  React.useEffect(() => {
    return () => stopHold();
  }, []);

  const handleSave = async () => {
    if (total === 0 || hasConflict) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      router.push("/income");
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      // Create the entry
      const { data: entry, error: entryError } = await supabase
        .from("income_entries")
        .insert({
          month: monthValue + "-01",
          notes: notes || null,
        })
        .select()
        .single();

      if (entryError) throw entryError;

      // Create amounts for each source
      const amountInserts = Object.entries(amounts)
        .filter(([_, amt]) => parseFloat(amt) !== 0)
        .map(([sourceId, amt]) => ({
          entry_id: entry.id,
          source_id: sourceId,
          amount: parseFloat(amt),
        }));

      if (amountInserts.length > 0) {
        const { error: amountsError } = await supabase
          .from("income_amounts")
          .insert(amountInserts);

        if (amountsError) throw amountsError;
      }

      router.push(`/income/${entry.id}`);
      router.refresh();
    } catch (error) {
      console.error("Error creating income entry:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const canSave = total !== 0 && !hasConflict;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold">Income Entry</h1>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <Link href="/income">
            <Button variant="ghost" disabled={isSaving}>
              <X className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Cancel</span>
            </Button>
          </Link>
          <Button
            onClick={handleSave}
            disabled={isSaving || !canSave}
            className="bg-teal text-white hover:bg-teal/90"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 sm:mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 sm:mr-1" />
            )}
            <span className="hidden sm:inline">{isSaving ? "Creating..." : "Create"}</span>
          </Button>
        </div>
      </div>

      {/* Month & Total Summary */}
      <div className="grid grid-cols-2 gap-px rounded-xl overflow-hidden glass-card">
        {/* Month Selector */}
        <div className={cn(
          "bg-card/50 p-3 sm:p-5 transition-colors",
          hasConflict && "bg-error/5"
        )}>
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-medium">Month</span>
          </div>
          <div className="flex items-center justify-center">
            <div className="flex items-center justify-between w-full max-w-[180px]">
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
              <div className="text-center flex-1 min-w-0 px-1">
                <p className={cn(
                  "text-base sm:text-xl font-semibold truncate transition-colors",
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
            <div className="flex items-center justify-center gap-1.5 mt-2 text-error">
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">
                Entry exists{" "}
                <Link
                  href={`/income/${conflictEntryId}`}
                  className="underline hover:text-error/80 transition-colors"
                >
                  here
                </Link>
              </span>
            </div>
          )}
        </div>

        {/* Total */}
        <div className="bg-card/50 p-3 sm:p-5 text-center border-l border-border/50">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Total</span>
          </div>
          <p className={cn(
            "text-xl sm:text-2xl font-bold font-mono",
            total > 0 ? "text-primary" : "text-muted-foreground"
          )}>
            {formatCurrency(total)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {filledSourceCount} source{filledSourceCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Sources */}
      <div className="rounded-xl glass-card overflow-hidden">
        {sortedSources.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-muted-foreground mb-2">No income sources configured.</p>
            <Link href="/income/sources" className="text-primary hover:underline text-sm font-medium">
              Add income sources
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Source
                </th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedSources.map((source, index) => {
                const amount = amounts[source.id] || "";

                return (
                  <tr
                    key={source.id}
                    className={cn(
                      "animate-fade-up h-[60px]",
                      `stagger-${Math.min(index + 1, 6)}`
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-3 w-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: source.color || "#5B8A8A" }}
                        />
                        <span className="text-sm font-medium">{source.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        value={amount}
                        onChange={(e) =>
                          setAmounts((prev) => ({
                            ...prev,
                            [source.id]: e.target.value,
                          }))
                        }
                        className="w-28 h-8 px-1 text-right text-sm font-mono ml-auto"
                        placeholder="0.00"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Notes - Collapsible */}
      <div className="space-y-3">
        {!showNotes ? (
          <button
            onClick={() => setShowNotes(true)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add notes
          </button>
        ) : (
          <div className="animate-fade-up">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Notes
              </span>
              <button
                onClick={() => {
                  setShowNotes(false);
                  setNotes("");
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Remove
              </button>
            </div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this month's income..."
              className="min-h-[100px] glass-card"
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  );
}
