"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Pencil,
  Save,
  Trash2,
  X,
  FileText,
  Calendar,
  DollarSign,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMaskedHover, getMaskedValue } from "@/components/ui/masked-value";
import {
  formatCurrency,
  formatMonth,
  calculatePercentageChange,
  formatPercentage,
  cn,
} from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { NetWorth } from "@/types/database";

interface NetWorthDetailContentProps {
  entry: NetWorth;
  previousEntry: NetWorth | null;
  prevEntryId: string | null;
  nextEntryId: string | null;
}

export function NetWorthDetailContent({
  entry,
  previousEntry,
  prevEntryId,
  nextEntryId,
}: NetWorthDetailContentProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Form state
  const [amount, setAmount] = React.useState(entry.amount);
  const [notes, setNotes] = React.useState(entry.notes || "");

  // Privacy mode
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();

  const numericAmount = Number(entry.amount);
  const change = previousEntry
    ? numericAmount - Number(previousEntry.amount)
    : 0;
  const percentageChange = previousEntry
    ? calculatePercentageChange(numericAmount, Number(previousEntry.amount))
    : 0;
  const trend = change > 0 ? "up" : change < 0 ? "down" : "neutral";

  const displayAmount = getMaskedValue(
    formatCurrency(numericAmount),
    isHidden,
    isRevealed
  );
  const displayChange = getMaskedValue(
    `${change >= 0 ? "+" : ""}${formatCurrency(change)}`,
    isHidden,
    isRevealed
  );
  const displayPercent = getMaskedValue(
    formatPercentage(Math.abs(percentageChange)),
    isHidden,
    isRevealed
  );
  // Navigation
  const goToPrevious = () => {
    if (prevEntryId) router.push(`/net-worth/${prevEntryId}`);
  };

  const goToNext = () => {
    if (nextEntryId) router.push(`/net-worth/${nextEntryId}`);
  };

  const handleSave = async () => {
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      await supabase
        .from("net_worth")
        .update({
          amount: Number(amount),
          notes: notes || null,
        })
        .eq("id", entry.id);

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

    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      router.push("/net-worth");
      return;
    }

    setIsDeleting(true);
    const supabase = createClient();

    try {
      await supabase
        .from("net_worth")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", entry.id);

      router.push("/net-worth");
      router.refresh();
    } catch (error) {
      console.error("Error deleting:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancel = () => {
    setAmount(entry.amount);
    setNotes(entry.notes || "");
    setIsEditing(false);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold">Net Worth Entry</h1>
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
              onClick={() => setIsEditing(true)}
              className="bg-teal text-white hover:bg-teal/90"
            >
              <Pencil className="h-4 w-4 sm:mr-1" />
              <span className="sm:inline">Edit</span>
            </Button>
          )}
        </div>
      </div>

      {/* Month & Amount Summary */}
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
                {formatMonth(entry.date)}
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

        {/* Net Worth Amount */}
        <div
          className="bg-card/50 p-3 sm:p-5 text-center border-t min-[360px]:border-t-0 min-[360px]:border-l border-border/50 flex flex-col items-center justify-center"
          {...(isEditing ? {} : hoverProps)}
        >
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Net Worth</span>
          </div>
          {isEditing ? (
            <Input
              type="text"
              inputMode="decimal"
              value={amount ? Number(amount).toLocaleString("en-US") : ""}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.\-]/g, "");
                setAmount(Number(raw) || 0);
              }}
              placeholder="0"
              className="text-center text-xl sm:text-2xl font-bold font-mono max-w-[200px]"
            />
          ) : (
            <p className="text-xl sm:text-2xl font-bold font-mono text-primary">
              {displayAmount}
            </p>
          )}
          {previousEntry && !isEditing && (
            <p className={cn(
              "text-xs font-mono mt-1",
              trend === "up" && "text-success",
              trend === "down" && "text-error",
              trend === "neutral" && "text-muted-foreground"
            )}>
              {displayChange} ({displayPercent})
            </p>
          )}
        </div>
      </div>

      {/* Notes */}
      <div className="flex flex-col">
        <div className="flex items-center gap-2 text-muted-foreground mb-3">
          <FileText className="h-4 w-4" />
          <span className="text-sm font-medium uppercase tracking-wider">Notes</span>
        </div>
        {isEditing ? (
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add notes about your net worth this month..."
            className="flex-1 min-h-[150px] resize-none glass-card px-4 py-4"
          />
        ) : (
          <div
            className="rounded-xl glass-card min-h-[150px] px-4 py-4 cursor-pointer hover:bg-secondary/30 transition-colors"
            onClick={() => setIsEditing(true)}
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
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
