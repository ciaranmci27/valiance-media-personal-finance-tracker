"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Pencil,
  Save,
  Trash2,
  X,
  FileText,
  History,
  User,
  Briefcase,
  Play,
  Pause,
  DollarSign,
  Calendar,
  TrendingUp,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { siteConfig } from "@/config/site";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMaskedHover, getMaskedValue } from "@/components/ui/masked-value";
import {
  formatCurrency,
  formatDate,
  toMonthlyAmount,
  toAnnualAmount,
  cn,
} from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { Expense, ExpenseHistory, ExpenseCategory } from "@/types/database";
import { EXPENSE_CATEGORIES } from "@/types/database";
import { ExpenseHistoryChart } from "@/components/charts/expense-history-chart";

interface ExpenseDetailContentProps {
  expense: Expense;
  history: ExpenseHistory[];
}

export function ExpenseDetailContent({
  expense,
  history,
}: ExpenseDetailContentProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isTogglingStatus, setIsTogglingStatus] = React.useState(false);

  // Form state
  const [name, setName] = React.useState(expense.name);
  const [amount, setAmount] = React.useState(expense.amount);
  const [frequency, setFrequency] = React.useState(expense.frequency);
  const [expenseType, setExpenseType] = React.useState(expense.expense_type);
  const [category, setCategory] = React.useState<ExpenseCategory | null>(expense.category);
  const [isActive, setIsActive] = React.useState(expense.is_active);
  const [notes, setNotes] = React.useState(expense.notes || "");

  // History state (for optimistic updates on delete)
  const [historyList, setHistoryList] = React.useState(history);

  // Privacy mode
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();

  const monthly = toMonthlyAmount(Number(amount), frequency);
  const annual = toAnnualAmount(Number(amount), frequency);

  const frequencyLabels: Record<string, string> = {
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    annual: "Annual",
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

    // Determine what changed to predict the history event
    const amountChanged = Number(amount) !== expense.amount;
    const frequencyChanged = frequency !== expense.frequency;

    try {
      await supabase
        .from("expenses")
        .update({
          name,
          amount: Number(amount),
          frequency,
          expense_type: expenseType,
          category,
          is_active: isActive,
          notes: notes || null,
        })
        .eq("id", expense.id);

      // Add optimistic history entry if amount/frequency changed
      // (status changes are handled by handleToggleStatus, not save)
      if (amountChanged || frequencyChanged) {
        const newHistoryEntry: ExpenseHistory = {
          id: crypto.randomUUID(),
          expense_id: expense.id,
          event_type: "updated",
          amount: String(amount),
          frequency,
          is_active: isActive,
          changed_at: new Date().toISOString(),
          notes: "Amount or frequency updated",
          deleted_at: null,
          created_at: new Date().toISOString(),
        };
        setHistoryList((prev) => [newHistoryEntry, ...prev]);
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
    if (!confirm("Are you sure you want to delete this expense?")) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      router.push("/expenses");
      return;
    }

    setIsDeleting(true);
    const supabase = createClient();

    try {
      // Soft-delete the expense
      // Note: Database trigger automatically creates "deleted" history event
      await supabase
        .from("expenses")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", expense.id);

      router.push("/expenses");
      router.refresh();
    } catch (error) {
      console.error("Error deleting:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleStatus = async () => {
    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      return;
    }

    setIsTogglingStatus(true);
    const newStatus = !isActive;
    setIsActive(newStatus);

    const supabase = createClient();

    try {
      const { error } = await supabase
        .from("expenses")
        .update({ is_active: newStatus })
        .eq("id", expense.id);

      if (error) {
        setIsActive(!newStatus);
        console.error("Error toggling status:", error);
      } else {
        // Add optimistic history entry for status change
        const newHistoryEntry: ExpenseHistory = {
          id: crypto.randomUUID(),
          expense_id: expense.id,
          event_type: newStatus ? "activated" : "paused",
          amount: String(amount),
          frequency,
          is_active: newStatus,
          changed_at: new Date().toISOString(),
          notes: newStatus ? "Expense activated" : "Expense paused",
          deleted_at: null,
          created_at: new Date().toISOString(),
        };
        setHistoryList((prev) => [newHistoryEntry, ...prev]);
        router.refresh();
      }
    } catch (error) {
      setIsActive(!newStatus);
      console.error("Error toggling status:", error);
    } finally {
      setIsTogglingStatus(false);
    }
  };

  const handleCancel = () => {
    setName(expense.name);
    setAmount(expense.amount);
    setFrequency(expense.frequency);
    setExpenseType(expense.expense_type);
    setCategory(expense.category);
    setIsActive(expense.is_active);
    setNotes(expense.notes || "");
    setIsEditing(false);
  };

  const handleDeleteHistory = async (historyId: string) => {
    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      return;
    }

    // Optimistic update
    setHistoryList((prev) => prev.filter((h) => h.id !== historyId));

    const supabase = createClient();

    try {
      const { error } = await supabase
        .from("expense_history")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", historyId);

      if (error) {
        // Revert on error
        setHistoryList(history);
        console.error("Error deleting history:", error);
      }
    } catch (error) {
      setHistoryList(history);
      console.error("Error deleting history:", error);
    }
  };

  const formatClean = (value: number) => formatCurrency(value);

  const displayAmount = getMaskedValue(formatClean(Number(amount)), isHidden, isRevealed);
  const displayMonthly = getMaskedValue(formatClean(monthly), isHidden, isRevealed);
  const displayAnnual = getMaskedValue(formatClean(annual), isHidden, isRevealed);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isEditing ? (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Expense name..."
              className="text-lg sm:text-xl font-semibold h-auto py-1.5 px-2 -ml-2 placeholder:font-normal placeholder:text-muted-foreground/60"
            />
          ) : (
            <h1 className="text-xl font-semibold truncate">{expense.name}</h1>
          )}
          {!isEditing && (
            <>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0",
                  expenseType === "personal"
                    ? "bg-teal/20 text-teal-light"
                    : "bg-copper/20 text-copper"
                )}
              >
                {expenseType === "personal" ? (
                  <User className="h-3 w-3" />
                ) : (
                  <Briefcase className="h-3 w-3" />
                )}
                <span className="hidden sm:inline">
                  {expenseType === "personal" ? "Personal" : siteConfig.companyName}
                </span>
              </span>
              {category && (
                <>
                  <span className="text-muted-foreground hidden sm:inline">•</span>
                  <span className="text-sm text-muted-foreground hidden sm:inline">
                    {EXPENSE_CATEGORIES[category]}
                  </span>
                </>
              )}
              <span className="text-muted-foreground hidden sm:inline">•</span>
              <span className="text-sm text-muted-foreground hidden sm:inline">
                {frequencyLabels[frequency]}
              </span>
            </>
          )}
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
                <span className="hidden sm:inline">{isSaving ? "Saving..." : "Save"}</span>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={handleToggleStatus}
                disabled={isTogglingStatus}
                className={isActive ? "text-copper hover:text-copper hover:bg-transparent" : "text-success hover:text-success hover:bg-transparent"}
              >
                {isTogglingStatus ? (
                  <Loader2 className="h-4 w-4 sm:mr-1 animate-spin" />
                ) : isActive ? (
                  <Pause className="h-4 w-4 sm:mr-1" />
                ) : (
                  <Play className="h-4 w-4 sm:mr-1" />
                )}
                <span className="sm:inline">{isActive ? "Pause" : "Activate"}</span>
              </Button>
              <Button
                onClick={() => setIsEditing(true)}
                className="bg-teal text-white hover:bg-teal/90"
              >
                <Pencil className="h-4 w-4 sm:mr-1" />
                <span className="sm:inline">Edit</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Financial Summary */}
      <div
        className="grid grid-cols-2 sm:grid-cols-3 gap-px rounded-xl overflow-hidden glass-card"
        {...hoverProps}
      >
        <div className="bg-card/50 p-4 sm:p-5 text-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Amount</span>
          </div>
          {isEditing ? (
            <Input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="text-xl sm:text-2xl font-bold font-mono text-center h-auto py-1"
            />
          ) : (
            <p className="text-xl sm:text-2xl font-bold font-mono">{displayAmount}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">{frequencyLabels[frequency]}</p>
        </div>
        <div className="bg-card/50 p-4 sm:p-5 text-center border-l sm:border-x border-border/50">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-medium">Monthly</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold font-mono text-primary">{displayMonthly}</p>
          <p className="text-xs text-muted-foreground mt-1">Per month</p>
        </div>
        <div className="hidden sm:block bg-card/50 p-5 text-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <TrendingUp className="h-4 w-4" />
            <span className="text-sm font-medium">Annual</span>
          </div>
          <p className="text-2xl font-bold font-mono">{displayAnnual}</p>
          <p className="text-xs text-muted-foreground mt-1">Per year</p>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-4 p-6 rounded-xl glass-card">
        <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wider">
          Details
        </h3>
        {isEditing ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <CustomSelect
                label="Frequency"
                value={frequency}
                onChange={(value) => setFrequency(value as typeof frequency)}
                options={[
                  { value: "weekly", label: "Weekly" },
                  { value: "monthly", label: "Monthly" },
                  { value: "quarterly", label: "Quarterly" },
                  { value: "annual", label: "Annual" },
                ]}
              />

              <CustomSelect
                label="Type"
                value={expenseType}
                onChange={(value) => setExpenseType(value as "personal" | "business")}
                options={[
                  { value: "personal", label: "Personal" },
                  { value: "business", label: siteConfig.companyName },
                ]}
              />
            </div>

            <CustomSelect
              label="Category"
              value={category || ""}
              onChange={(value) => setCategory(value as ExpenseCategory || null)}
              placeholder="Select a category..."
              options={Object.entries(EXPENSE_CATEGORIES).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="w-full">
                <label className="block text-sm font-medium text-foreground mb-1.5">Frequency</label>
                <div className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm">
                  {frequencyLabels[frequency]}
                </div>
              </div>
              <div className="w-full">
                <label className="block text-sm font-medium text-foreground mb-1.5">Type</label>
                <div className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm">
                  {expenseType === "personal" ? "Personal" : siteConfig.companyName}
                </div>
              </div>
            </div>
            <div className="w-full">
              <label className="block text-sm font-medium text-foreground mb-1.5">Category</label>
              <div className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm">
                {category ? EXPENSE_CATEGORIES[category] : "—"}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileText className="h-4 w-4" />
          <h3 className="font-medium text-sm uppercase tracking-wider">Notes</h3>
        </div>
        {isEditing ? (
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add notes about this expense..."
            className="min-h-[100px] glass-card px-4 py-4"
          />
        ) : (
          <div
            className="px-4 py-4 rounded-xl glass-card min-h-[100px] cursor-pointer hover:bg-secondary/30 transition-colors"
            onClick={() => setIsEditing(true)}
          >
            <p className={cn("text-sm whitespace-pre-wrap", !expense.notes && "text-muted-foreground italic")}>
              {expense.notes || "Click to add notes..."}
            </p>
          </div>
        )}
      </div>

      {/* Change History & Trend Chart */}
      {historyList.length > 0 && (() => {
        // Check if we have enough data points for the chart (3+ created/updated events)
        const chartableEvents = historyList.filter(
          (h) => h.event_type === "created" || h.event_type === "updated"
        );
        const showChart = chartableEvents.length >= 3;

        return (
          <div className={cn(
            "grid gap-6",
            showChart ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"
          )}>
            {/* Change History List */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-muted-foreground">
                <History className="h-4 w-4" />
                <h3 className="font-medium text-sm uppercase tracking-wider">Change History</h3>
              </div>
              <div className="rounded-xl glass-card overflow-hidden divide-y divide-border">
                {historyList.map((entry, index) => (
                  <HistoryRow key={entry.id} entry={entry} onDelete={handleDeleteHistory} isLatest={index === 0} />
                ))}
              </div>
            </div>

            {/* Trend Chart - only shows with 3+ data points */}
            {showChart && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <TrendingUp className="h-4 w-4" />
                  <h3 className="font-medium text-sm uppercase tracking-wider">History Trend</h3>
                </div>
                <div className="rounded-xl glass-card p-4">
                  <ExpenseHistoryChart history={historyList} />
                </div>
              </div>
            )}
          </div>
        );
      })()}

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
            <Trash2 className="h-4 w-4 mr-1" />
            Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("md:hidden", isActive ? "text-copper hover:text-copper" : "text-success hover:text-success")}
            onClick={handleToggleStatus}
            disabled={isTogglingStatus}
          >
            {isTogglingStatus ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : isActive ? (
              <Pause className="h-4 w-4 mr-1" />
            ) : (
              <Play className="h-4 w-4 mr-1" />
            )}
            {isActive ? "Pause" : "Activate"}
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

// Event type labels and colors
const eventTypeConfig: Record<string, { label: string; color: string }> = {
  created: { label: "Created", color: "text-copper" },
  updated: { label: "Updated to", color: "text-copper" },
  paused: { label: "Paused", color: "text-muted-foreground" },
  activated: { label: "Activated", color: "text-success" },
  deleted: { label: "Deleted", color: "text-error" },
};

// History row with hover-to-reveal and delete
function HistoryRow({
  entry,
  onDelete,
  isLatest = false,
}: {
  entry: ExpenseHistory;
  onDelete: (id: string) => void;
  isLatest?: boolean;
}) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const [isDeleting, setIsDeleting] = React.useState(false);
  const displayAmount = getMaskedValue(formatCurrency(Number(entry.amount)), isHidden, isRevealed);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this history entry?")) return;

    setIsDeleting(true);
    onDelete(entry.id);
  };

  const config = eventTypeConfig[entry.event_type] || eventTypeConfig.updated;
  const showAmount = entry.event_type !== 'paused' && entry.event_type !== 'deleted';

  return (
    <div className="px-4 py-3 flex items-center justify-between group" {...hoverProps}>
      <span className="text-sm flex items-center gap-1">
        <span className={config.color}>{config.label}</span>
        {showAmount && (
          <>
            {" "}
            <span className="font-mono font-medium">{displayAmount}</span>{" "}
            <span className="text-muted-foreground">({entry.frequency})</span>
          </>
        )}
        {!isLatest && (
          <Tooltip content="Delete history entry">
          <button
            onClick={handleDelete}
            disabled={isDeleting}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-error/10 text-muted-foreground hover:text-error disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          </button>
          </Tooltip>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{formatDate(entry.changed_at)}</span>
    </div>
  );
}
