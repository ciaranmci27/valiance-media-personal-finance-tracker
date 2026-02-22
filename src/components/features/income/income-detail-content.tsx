"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Pencil,
  Plus,
  Minus,
  Save,
  Trash2,
  X,
  Calendar,
  DollarSign,
  Loader2,
  ChevronLeft,
  ChevronRight,
  FileText,
  PieChart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IncomeBreakdownChart } from "@/components/charts/income-breakdown-chart";
import { useMaskedHover, getMaskedValue } from "@/components/ui/masked-value";
import { formatCurrency, formatMonth, cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { IncomeSource } from "@/types/database";

interface IncomeAmount {
  id: string;
  source_id: string;
  amount: string;
  income_sources: {
    id: string;
    name: string;
    color: string | null;
  };
}

interface IncomeEntry {
  id: string;
  month: string;
  notes: string | null;
  income_amounts: IncomeAmount[];
}

interface IncomeDetailContentProps {
  entry: IncomeEntry;
  sources: IncomeSource[];
  prevEntryId: string | null;
  nextEntryId: string | null;
}

export function IncomeDetailContent({
  entry,
  sources,
  prevEntryId,
  nextEntryId,
}: IncomeDetailContentProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Form state
  const [amounts, setAmounts] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    entry.income_amounts.forEach((ia) => {
      initial[ia.source_id] = ia.amount;
    });
    return initial;
  });
  const [notes, setNotes] = React.useState(entry.notes || "");

  // Add-to-amount state
  const [addingToSourceId, setAddingToSourceId] = React.useState<string | null>(null);
  const [pendingAdditions, setPendingAdditions] = React.useState<string[]>([]);
  const [addInputValue, setAddInputValue] = React.useState("");
  const [isAddSaving, setIsAddSaving] = React.useState(false);
  const addInputRef = React.useRef<HTMLInputElement>(null);

  // Focus input when panel opens
  React.useEffect(() => {
    if (addingToSourceId && addInputRef.current) {
      addInputRef.current.focus();
    }
  }, [addingToSourceId]);

  // Privacy mode
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();

  // Calculate total
  const total = Object.values(amounts).reduce(
    (sum, amt) => sum + (parseFloat(amt) || 0),
    0
  );

  // Count active sources (with non-zero amounts, including losses)
  const activeSourceCount = Object.values(amounts).filter(
    (amt) => parseFloat(amt) !== 0
  ).length;

  // Build sources for display:
  // - View mode: only sources with recorded amounts
  // - Edit mode: all active sources (so user can add to any)
  const displaySources = React.useMemo(() => {
    const sourceMap = new Map<string, { id: string; name: string; color: string | null }>();

    // Sources with recorded amounts (skip zero-amount in view mode)
    entry.income_amounts.forEach((ia) => {
      if (ia.income_sources) {
        const amt = parseFloat(ia.amount) || 0;
        if (isEditing || amt !== 0) {
          sourceMap.set(ia.source_id, {
            id: ia.income_sources.id,
            name: ia.income_sources.name,
            color: ia.income_sources.color,
          });
        }
      }
    });

    // In edit mode, also include active sources without amounts
    if (isEditing) {
      sources.filter(s => s.is_active).forEach((source) => {
        if (!sourceMap.has(source.id)) {
          sourceMap.set(source.id, {
            id: source.id,
            name: source.name,
            color: source.color,
          });
        }
      });
    }

    // Sort by amount: positive (highest to lowest), then losses, then zero/empty
    return Array.from(sourceMap.values()).sort((a, b) => {
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
  }, [entry.income_amounts, sources, amounts, isEditing]);

  // Chart data - use displaySources
  const chartData = displaySources
    .map((source) => ({
      name: source.name,
      value: parseFloat(amounts[source.id] || "0") || 0,
      color: source.color || "#5B8A8A",
    }))
    .filter((d) => d.value !== 0);

  // Navigation
  const goToPrevious = () => {
    if (prevEntryId) router.push(`/income/${prevEntryId}`);
  };

  const goToNext = () => {
    if (nextEntryId) router.push(`/income/${nextEntryId}`);
  };

  const handleSave = async () => {
    // In demo mode, show message and exit edit mode
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      // Update notes
      await supabase
        .from("income_entries")
        .update({ notes: notes || null })
        .eq("id", entry.id);

      // Update amounts
      for (const sourceId of Object.keys(amounts)) {
        const amount = parseFloat(amounts[sourceId]) || 0;
        const existingAmount = entry.income_amounts.find(
          (ia) => ia.source_id === sourceId
        );

        if (existingAmount && amount === 0) {
          // Remove zero-amount records so the source doesn't show as active
          await supabase
            .from("income_amounts")
            .delete()
            .eq("id", existingAmount.id);
        } else if (existingAmount) {
          await supabase
            .from("income_amounts")
            .update({ amount })
            .eq("id", existingAmount.id);
        } else if (amount !== 0) {
          await supabase.from("income_amounts").insert({
            entry_id: entry.id,
            source_id: sourceId,
            amount,
          });
        }
      }

      setIsEditing(false);
      router.refresh();
    } catch (error) {
      console.error("Error saving:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this entry?")) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      router.push("/income");
      return;
    }

    setIsDeleting(true);
    const supabase = createClient();

    try {
      await supabase
        .from("income_entries")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", entry.id);

      router.push("/income");
      router.refresh();
    } catch (error) {
      console.error("Error deleting:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancel = () => {
    // Reset form state
    const initial: Record<string, string> = {};
    entry.income_amounts.forEach((ia) => {
      initial[ia.source_id] = ia.amount;
    });
    setAmounts(initial);
    setNotes(entry.notes || "");
    setIsEditing(false);
  };

  // Add-to-amount handlers
  const openAddPanel = (sourceId: string) => {
    setAddingToSourceId(sourceId);
    setPendingAdditions([]);
    setAddInputValue("");
  };

  const closeAddPanel = () => {
    setAddingToSourceId(null);
    setPendingAdditions([]);
    setAddInputValue("");
  };

  const addPendingAmount = () => {
    const val = parseFloat(addInputValue);
    if (isNaN(val) || val === 0) return;
    setPendingAdditions((prev) => [...prev, addInputValue]);
    setAddInputValue("");
    addInputRef.current?.focus();
  };

  const removePendingAmount = (index: number) => {
    setPendingAdditions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddSave = async () => {
    if (!addingToSourceId || pendingAdditions.length === 0) return;

    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      closeAddPanel();
      return;
    }

    setIsAddSaving(true);
    const supabase = createClient();

    try {
      const currentAmount = parseFloat(amounts[addingToSourceId] || "0") || 0;
      const additionsSum = pendingAdditions.reduce(
        (sum, val) => sum + (parseFloat(val) || 0),
        0
      );
      const newTotal = currentAmount + additionsSum;

      const existingRecord = entry.income_amounts.find(
        (ia) => ia.source_id === addingToSourceId
      );

      if (existingRecord && newTotal === 0) {
        // Remove zero-amount records so the source doesn't show as active
        await supabase
          .from("income_amounts")
          .delete()
          .eq("id", existingRecord.id);
      } else if (existingRecord) {
        await supabase
          .from("income_amounts")
          .update({ amount: newTotal })
          .eq("id", existingRecord.id);
      } else if (newTotal !== 0) {
        await supabase.from("income_amounts").insert({
          entry_id: entry.id,
          source_id: addingToSourceId,
          amount: newTotal,
        });
      }

      // Update local state immediately so the UI reflects the new total
      setAmounts((prev) => ({
        ...prev,
        [addingToSourceId]: String(newTotal),
      }));
      closeAddPanel();
      router.refresh();
    } catch (error) {
      console.error("Error saving addition:", error);
    } finally {
      setIsAddSaving(false);
    }
  };

  const formatClean = (value: number) => formatCurrency(value);

  const displayTotal = getMaskedValue(
    formatClean(total),
    isHidden,
    isRevealed
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold">Income Entry</h1>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {isEditing ? (
            <>
              <Button variant="ghost" onClick={handleCancel} disabled={isSaving}>
                <X className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">Cancel</span>
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="h-4 w-4 sm:mr-1 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 sm:mr-1" />
                )}
                <span className="hidden sm:inline">
                  {isSaving ? "Saving..." : "Save"}
                </span>
              </Button>
            </>
          ) : (
            <Button
              onClick={() => { closeAddPanel(); setIsEditing(true); }}
              className="bg-teal text-white hover:bg-teal/90"
            >
              <Pencil className="h-4 w-4 sm:mr-1" />
              <span className="sm:inline">Edit</span>
            </Button>
          )}
        </div>
      </div>

      {/* Month & Total Summary */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-px rounded-xl overflow-hidden glass-card">
        {/* Month Navigator */}
        <div className="bg-card/50 p-3 sm:p-5 flex flex-col items-center justify-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-medium">Month</span>
          </div>
          <div className="flex items-center justify-center w-full">
            <div className="flex items-center justify-center gap-1">
              <button
                onClick={goToPrevious}
                disabled={!prevEntryId}
                className={cn(
                  "p-1.5 rounded-lg transition-colors shrink-0 select-none",
                  prevEntryId
                    ? "hover:bg-secondary text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/30 cursor-not-allowed"
                )}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <p className="text-sm sm:text-base md:text-lg font-semibold whitespace-nowrap px-1">
                {formatMonth(entry.month)}
              </p>
              <button
                onClick={goToNext}
                disabled={!nextEntryId}
                className={cn(
                  "p-1.5 rounded-lg transition-colors shrink-0 select-none",
                  nextEntryId
                    ? "hover:bg-secondary text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/30 cursor-not-allowed"
                )}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Total */}
        <div
          className="bg-card/50 p-3 sm:p-5 text-center border-t min-[360px]:border-t-0 min-[360px]:border-l border-border/50 flex flex-col items-center justify-center"
          {...hoverProps}
        >
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Total</span>
          </div>
          <p className={cn(
            "text-xl sm:text-2xl font-bold font-mono",
            total > 0 ? "text-primary" : "text-muted-foreground"
          )}>
            {displayTotal}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {activeSourceCount} source{activeSourceCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Sources */}
      <div className="rounded-xl glass-card overflow-hidden">
        {displaySources.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-muted-foreground">No income sources.</p>
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
              {displaySources.map((source, index) => {
                const amount = amounts[source.id] || "";
                const numericAmount = parseFloat(amount || "0") || 0;
                const displayValue = getMaskedValue(
                  formatClean(numericAmount),
                  isHidden,
                  isRevealed
                );
                const isPanelOpen = addingToSourceId === source.id;

                // Compute add-panel math
                const additionsSum = isPanelOpen
                  ? pendingAdditions.reduce(
                      (sum, val) => sum + (parseFloat(val) || 0),
                      0
                    )
                  : 0;
                const newTotal = numericAmount + additionsSum;

                return (
                  <React.Fragment key={source.id}>
                    <tr
                      className={cn(
                        "animate-fade-up h-[60px]",
                        `stagger-${Math.min(index + 1, 6)}`
                      )}
                      {...(isEditing ? {} : hoverProps)}
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
                        {isEditing ? (
                          <Input
                            type="number"
                            step="0.01"
                            value={amount || ""}
                            onChange={(e) =>
                              setAmounts((prev) => ({
                                ...prev,
                                [source.id]: e.target.value,
                              }))
                            }
                            className="w-28 h-8 px-1 text-right text-sm font-mono ml-auto"
                            placeholder="0.00"
                          />
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <Tooltip content="Add to amount">
                            <button
                              onClick={() =>
                                isPanelOpen
                                  ? closeAddPanel()
                                  : openAddPanel(source.id)
                              }
                              className={cn(
                                "p-1 rounded-md transition-colors",
                                isPanelOpen
                                  ? "bg-primary/10 text-primary"
                                  : "text-muted-foreground/50 hover:text-primary hover:bg-primary/10"
                              )}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                            </Tooltip>
                            <span
                              className={cn(
                                "font-mono",
                                numericAmount === 0
                                  ? "text-muted-foreground font-normal"
                                  : numericAmount < 0
                                    ? "text-error font-semibold"
                                    : "text-foreground font-semibold"
                              )}
                            >
                              {numericAmount === 0 ? "—" : displayValue}
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>

                    {/* Add-to-amount expansion */}
                    {isPanelOpen && (() => {
                      const inputVal = parseFloat(addInputValue) || 0;
                      const liveTotal = newTotal + inputVal;

                      return (
                        <tr className="animate-fade-in">
                          <td colSpan={2} className="p-0">
                            <div className="mx-3 my-2 rounded-lg bg-secondary/40 border border-border/50 overflow-hidden">
                              <div className="px-5 py-4 space-y-3">
                                {/* Math column — everything right-aligned */}
                                <div className="font-mono text-sm tabular-nums space-y-2.5">
                                  {/* Current balance */}
                                  <div className="flex items-baseline justify-between text-muted-foreground">
                                    <span className="text-xs font-sans uppercase tracking-wider font-medium">Current</span>
                                    <span>{formatClean(numericAmount)}</span>
                                  </div>
                                  <div className="border-t border-border/30" />

                                  {/* Committed additions */}
                                  {pendingAdditions.map((val, i) => {
                                    const parsed = parseFloat(val) || 0;
                                    return (
                                      <div
                                        key={i}
                                        className="flex items-center justify-end"
                                      >
                                        <Tooltip content="Click to remove">
                                        <button
                                          onClick={() => removePendingAmount(i)}
                                          className={cn(
                                            "hover:line-through transition-colors cursor-pointer",
                                            parsed < 0
                                              ? "text-error hover:text-error/60"
                                              : "text-primary hover:text-error"
                                          )}
                                        >
                                          {parsed >= 0 ? "+" : "−"}{formatClean(Math.abs(parsed))}
                                        </button>
                                        </Tooltip>
                                      </div>
                                    );
                                  })}

                                  {/* Input as the next line in the math column */}
                                  <div className="flex items-center justify-end">
                                    <div className="relative">
                                      <input
                                        ref={addInputRef}
                                        type="number"
                                        step="0.01"
                                        value={addInputValue}
                                        onChange={(e) => setAddInputValue(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") addPendingAmount();
                                          if (e.key === "Escape") closeAddPanel();
                                        }}
                                        className={cn(
                                          "w-36 h-9 rounded-lg border border-border bg-background/50 text-right text-sm font-mono text-foreground",
                                          "pl-3 pr-10",
                                          "placeholder:text-muted-foreground",
                                          "!outline-none !ring-0 !shadow-none",
                                        )}
                                        placeholder="0.00"
                                      />
                                      <button
                                        type="button"
                                        onClick={addPendingAmount}
                                        tabIndex={-1}
                                        className="absolute right-1.5 top-1/2 -translate-y-1/2 focus:outline-none"
                                      >
                                        {(() => {
                                          const inputNum = parseFloat(addInputValue);
                                          const hasValue = addInputValue && !isNaN(inputNum) && inputNum !== 0;
                                          const isNeg = hasValue && inputNum < 0;
                                          return (
                                            <div className={cn(
                                              "h-6 w-6 rounded-full flex items-center justify-center transition-colors",
                                              hasValue
                                                ? isNeg
                                                  ? "bg-error text-white"
                                                  : "bg-primary text-primary-foreground"
                                                : "bg-muted text-muted-foreground/40"
                                            )}>
                                              {isNeg ? (
                                                <Minus className="h-3.5 w-3.5" />
                                              ) : (
                                                <Plus className="h-3.5 w-3.5" />
                                              )}
                                            </div>
                                          );
                                        })()}
                                      </button>
                                    </div>
                                  </div>

                                  {/* Running total — updates live as you type */}
                                  {pendingAdditions.length > 0 && (
                                    <>
                                      <div className="border-t border-border/40 !mt-2" />
                                      <div className="flex items-baseline justify-between">
                                        <span className="text-xs font-sans uppercase tracking-wider font-medium text-muted-foreground">
                                          New total
                                        </span>
                                        <span className="font-semibold text-foreground">
                                          {formatClean(liveTotal)}
                                        </span>
                                      </div>
                                    </>
                                  )}
                                </div>

                                {/* Actions — stable row at bottom */}
                                <div className="flex items-center justify-end gap-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-sm text-muted-foreground"
                                    onClick={closeAddPanel}
                                    disabled={isAddSaving}
                                  >
                                    Cancel
                                  </Button>
                                  {pendingAdditions.length > 0 && (
                                    <Button
                                      size="sm"
                                      className="h-9 px-4 text-sm"
                                      onClick={handleAddSave}
                                      disabled={isAddSaving}
                                    >
                                      {isAddSaving ? (
                                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                                      ) : (
                                        <Save className="h-4 w-4 mr-1.5" />
                                      )}
                                      {isAddSaving ? "Saving..." : "Save"}
                                    </Button>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })()}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Notes & Breakdown Chart Row */}
      <div className={cn(
        "grid gap-6 items-stretch",
        chartData.length > 0 ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"
      )}>
        {/* Notes - Left */}
        <div className="flex flex-col">
          <div className="flex items-center gap-2 text-muted-foreground mb-3">
            <FileText className="h-4 w-4" />
            <span className="text-sm font-medium uppercase tracking-wider">Notes</span>
          </div>
          {isEditing ? (
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this month's income..."
              className="flex-1 min-h-[200px] resize-none glass-card px-4 py-4"
            />
          ) : (
            <div
              className="rounded-xl glass-card flex-1 min-h-[200px] px-4 py-4 cursor-pointer hover:bg-secondary/30 transition-colors"
              onClick={() => { closeAddPanel(); setIsEditing(true); }}
            >
              <p className={cn(
                "text-sm whitespace-pre-wrap",
                !entry.notes && "text-muted-foreground italic"
              )}>
                {entry.notes || "Click to add notes..."}
              </p>
            </div>
          )}
        </div>

        {/* Breakdown Chart - Right */}
        {chartData.length > 0 && (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <PieChart className="h-4 w-4" />
              <span className="text-sm font-medium uppercase tracking-wider">Breakdown</span>
            </div>
            <div className="rounded-xl glass-card p-4 flex-1">
              <IncomeBreakdownChart data={chartData} isRevealed={isRevealed} size="compact" />
            </div>
          </div>
        )}
      </div>

      {/* Bottom Actions */}
      {isEditing ? (
        <div className="flex md:hidden items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSaving}>
            <X className="h-4 w-4 mr-1" />
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            className="text-error hover:text-error hover:bg-error/10"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-1" />
            )}
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
          <Button
            className="md:hidden bg-teal text-white hover:bg-teal/90"
            size="sm"
            onClick={() => { closeAddPanel(); setIsEditing(true); }}
          >
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
