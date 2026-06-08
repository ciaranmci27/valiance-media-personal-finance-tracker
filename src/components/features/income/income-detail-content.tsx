"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Calendar,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  FileText,
  Loader2,
  Pencil,
  PieChart,
  Plus,
  ReceiptText,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { CustomSelect } from "@/components/ui/select";
import { DateInput } from "@/components/ui/date-input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { IncomeBreakdownChart } from "@/components/charts/income-breakdown-chart";
import { useMaskedHover, getMaskedValue } from "@/components/ui/masked-value";
import { formatCurrency, formatDate, formatMonth, cn } from "@/lib/utils";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import {
  defaultDateForMonth,
  ensureIncomeEntryForDate,
} from "@/lib/income-ledger";
import type {
  IncomeLineItemWithSource,
  IncomeSource,
} from "@/types/database";

interface IncomeAmount {
  id: string;
  source_id: string;
  amount: string | number;
  income_sources: {
    id: string;
    name: string;
    color: string | null;
  } | null;
}

interface IncomeEntry {
  id: string;
  month: string;
  notes: string | null;
  income_amounts: IncomeAmount[];
  income_line_items: IncomeLineItemWithSource[];
}

interface IncomeDetailContentProps {
  entry: IncomeEntry;
  sources: IncomeSource[];
  prevEntryId: string | null;
  nextEntryId: string | null;
}

interface SourceRow {
  source: {
    id: string;
    name: string;
    color: string | null;
    is_active: boolean;
  };
  total: number;
  items: IncomeLineItemWithSource[];
}

function sortedItems(items: IncomeLineItemWithSource[]) {
  return [...items].sort((a, b) => {
    const dateDiff = b.received_date.localeCompare(a.received_date);
    if (dateDiff !== 0) return dateDiff;
    return b.created_at.localeCompare(a.created_at);
  });
}

function buildSourceRows(
  entry: IncomeEntry,
  sources: IncomeSource[],
): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  const activeItems = sortedItems(
    (entry.income_line_items || []).filter((item) => !item.deleted_at),
  );

  for (const item of activeItems) {
    const fallbackSource = sources.find((source) => source.id === item.source_id);
    const source = item.income_sources || fallbackSource;
    if (!source) continue;

    const existing = rows.get(source.id) || {
      source: {
        id: source.id,
        name: source.name,
        color: source.color,
        is_active: fallbackSource?.is_active ?? true,
      },
      total: 0,
      items: [],
    };

    existing.items.push(item);
    existing.total += Number(item.amount);
    rows.set(source.id, existing);
  }

  if (activeItems.length === 0) {
    for (const amount of entry.income_amounts || []) {
      const total = Number(amount.amount) || 0;
      if (total === 0) continue;
      const fallbackSource = sources.find((source) => source.id === amount.source_id);
      const source = amount.income_sources || fallbackSource;
      if (!source) continue;

      rows.set(source.id, {
        source: {
          id: source.id,
          name: source.name,
          color: source.color,
          is_active: fallbackSource?.is_active ?? true,
        },
        total,
        items: [],
      });
    }
  }

  return Array.from(rows.values()).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.source.name.localeCompare(b.source.name);
  });
}

export function IncomeDetailContent({
  entry,
  sources,
  prevEntryId,
  nextEntryId,
}: IncomeDetailContentProps) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirmationDialog();
  const [isDeletingMonth, setIsDeletingMonth] = React.useState(false);
  const [isAdding, setIsAdding] = React.useState(false);
  const [isSavingNotes, setIsSavingNotes] = React.useState(false);
  const [isEditingNotes, setIsEditingNotes] = React.useState(false);
  const [expandedSourceIds, setExpandedSourceIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const sourceRows = React.useMemo(
    () => buildSourceRows(entry, sources),
    [entry, sources],
  );

  React.useEffect(() => {
    setExpandedSourceIds((previous) => {
      const next = new Set(previous);
      for (const row of sourceRows) {
        if (row.items.length > 0) next.add(row.source.id);
      }
      return next;
    });
  }, [sourceRows]);

  const activeSourceOptions = React.useMemo(() => {
    return sources
      .filter((source) => source.is_active)
      .map((source) => ({
        value: source.id,
        label: source.name,
      }));
  }, [sources]);

  const editableSourceOptions = React.useMemo(() => {
    const sourceMap = new Map<string, { value: string; label: string }>();
    for (const source of sources) {
      if (source.is_active) {
        sourceMap.set(source.id, {
          value: source.id,
          label: source.name,
        });
      }
    }
    for (const row of sourceRows) {
      const source = sources.find((s) => s.id === row.source.id);
      sourceMap.set(row.source.id, {
        value: row.source.id,
        label: source?.name || row.source.name,
      });
    }
    return Array.from(sourceMap.values());
  }, [sources, sourceRows]);

  const defaultSourceId = activeSourceOptions[0]?.value ?? "";
  const [addDate, setAddDate] = React.useState(() => defaultDateForMonth(entry.month));
  const [addSourceId, setAddSourceId] = React.useState(defaultSourceId);
  const [addAmount, setAddAmount] = React.useState("");
  const [addNotes, setAddNotes] = React.useState("");
  const [monthNotes, setMonthNotes] = React.useState(entry.notes || "");

  const [editingItemId, setEditingItemId] = React.useState<string | null>(null);
  const [editDate, setEditDate] = React.useState("");
  const [editSourceId, setEditSourceId] = React.useState("");
  const [editAmount, setEditAmount] = React.useState("");
  const [editNotes, setEditNotes] = React.useState("");
  const [savingItemId, setSavingItemId] = React.useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setAddDate(defaultDateForMonth(entry.month));
    setMonthNotes(entry.notes || "");
  }, [entry.month, entry.notes]);

  React.useEffect(() => {
    if (!addSourceId && defaultSourceId) setAddSourceId(defaultSourceId);
  }, [addSourceId, defaultSourceId]);

  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const activeLineItemCount = sourceRows.reduce(
    (sum, row) => sum + row.items.length,
    0,
  );
  const monthTotal = sourceRows.reduce((sum, row) => sum + row.total, 0);
  const activeSourceCount = sourceRows.filter((row) => row.total !== 0).length;
  const displayTotal = getMaskedValue(
    formatCurrency(monthTotal),
    isHidden,
    isRevealed,
  );

  const chartData = sourceRows
    .map((row) => ({
      name: row.source.name,
      value: row.total,
      color: row.source.color || "#5B8A8A",
    }))
    .filter((row) => row.value !== 0);

  const goToPrevious = () => {
    if (prevEntryId) router.push(`/income/${prevEntryId}`);
  };

  const goToNext = () => {
    if (nextEntryId) router.push(`/income/${nextEntryId}`);
  };

  const toggleSource = (sourceId: string) => {
    setExpandedSourceIds((previous) => {
      const next = new Set(previous);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };

  const resetAddForm = () => {
    setAddAmount("");
    setAddNotes("");
  };

  const handleAddItem = async () => {
    const numericAmount = parseFloat(addAmount) || 0;
    if (!addDate || !addSourceId || numericAmount === 0) return;

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      resetAddForm();
      return;
    }

    setIsAdding(true);
    const supabase = createClient();

    try {
      const targetEntryId = await ensureIncomeEntryForDate(supabase, addDate);
      const { error } = await supabase.from("income_line_items").insert({
        entry_id: targetEntryId,
        source_id: addSourceId,
        received_date: addDate,
        amount: numericAmount,
        notes: addNotes.trim() || null,
      });

      if (error) throw error;

      resetAddForm();
      toast("success", "Income item added");
      if (targetEntryId !== entry.id) {
        router.push(`/income/${targetEntryId}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      console.error("Error adding income item:", error);
      toast("error", "Could not add income item");
    } finally {
      setIsAdding(false);
    }
  };

  const startEditItem = (item: IncomeLineItemWithSource) => {
    setEditingItemId(item.id);
    setEditDate(item.received_date);
    setEditSourceId(item.source_id);
    setEditAmount(String(item.amount));
    setEditNotes(item.notes || "");
  };

  const cancelEditItem = () => {
    setEditingItemId(null);
    setEditDate("");
    setEditSourceId("");
    setEditAmount("");
    setEditNotes("");
  };

  const handleSaveItem = async (itemId: string) => {
    const numericAmount = parseFloat(editAmount) || 0;
    if (!editDate || !editSourceId || numericAmount === 0) return;

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      cancelEditItem();
      return;
    }

    setSavingItemId(itemId);
    const supabase = createClient();

    try {
      const targetEntryId = await ensureIncomeEntryForDate(supabase, editDate);
      const { error } = await supabase
        .from("income_line_items")
        .update({
          entry_id: targetEntryId,
          source_id: editSourceId,
          received_date: editDate,
          amount: numericAmount,
          notes: editNotes.trim() || null,
          deleted_at: null,
        })
        .eq("id", itemId);

      if (error) throw error;

      cancelEditItem();
      toast("success", "Income item updated");
      if (targetEntryId !== entry.id) {
        router.push(`/income/${targetEntryId}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      console.error("Error updating income item:", error);
      toast("error", "Could not update income item");
    } finally {
      setSavingItemId(null);
    }
  };

  const handleDeleteItem = async (item: IncomeLineItemWithSource) => {
    const confirmed = await confirm({
      title: "Delete this income item?",
      description: "This item will be removed from the monthly total.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!confirmed) return;

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      return;
    }

    setDeletingItemId(item.id);
    const supabase = createClient();

    try {
      const { error } = await supabase
        .from("income_line_items")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", item.id);

      if (error) throw error;

      toast("success", "Income item deleted");
      if (activeLineItemCount <= 1) {
        router.push("/income");
      } else {
        router.refresh();
      }
    } catch (error) {
      console.error("Error deleting income item:", error);
      toast("error", "Could not delete income item");
    } finally {
      setDeletingItemId(null);
    }
  };

  const handleSaveMonthNotes = async () => {
    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      setIsEditingNotes(false);
      return;
    }

    setIsSavingNotes(true);
    const supabase = createClient();

    try {
      const { error } = await supabase
        .from("income_entries")
        .update({ notes: monthNotes.trim() || null })
        .eq("id", entry.id);

      if (error) throw error;

      setIsEditingNotes(false);
      toast("success", "Month notes saved");
      router.refresh();
    } catch (error) {
      console.error("Error saving month notes:", error);
      toast("error", "Could not save notes");
    } finally {
      setIsSavingNotes(false);
    }
  };

  const handleDeleteMonth = async () => {
    const confirmed = await confirm({
      title: "Delete this month?",
      description: "This income month will be moved to trash. You can restore it later.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!confirmed) return;

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      router.push("/income");
      return;
    }

    setIsDeletingMonth(true);
    const supabase = createClient();

    try {
      const { error } = await supabase
        .from("income_entries")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", entry.id);

      if (error) throw error;

      router.push("/income");
      router.refresh();
    } catch (error) {
      console.error("Error deleting month:", error);
      toast("error", "Could not delete month");
    } finally {
      setIsDeletingMonth(false);
    }
  };

  const canAdd = Boolean(addDate && addSourceId && (parseFloat(addAmount) || 0) !== 0);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {confirmDialog}

      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <ReceiptText className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Income Ledger</h1>
            <p className="text-sm text-muted-foreground">
              {formatMonth(entry.month)}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 min-[420px]:grid-cols-3 gap-px rounded-xl overflow-hidden glass-card">
        <div className="bg-card/50 p-3 sm:p-5 flex flex-col items-center justify-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-medium">Month</span>
          </div>
          <div className="flex items-center justify-center w-full">
            <button
              onClick={goToPrevious}
              disabled={!prevEntryId}
              aria-label="Previous month"
              className={cn(
                "p-1.5 rounded-lg transition-colors shrink-0 select-none",
                prevEntryId
                  ? "hover:bg-secondary text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/30 cursor-not-allowed",
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm sm:text-base md:text-lg font-semibold whitespace-nowrap px-2">
              {formatMonth(entry.month)}
            </p>
            <button
              onClick={goToNext}
              disabled={!nextEntryId}
              aria-label="Next month"
              className={cn(
                "p-1.5 rounded-lg transition-colors shrink-0 select-none",
                nextEntryId
                  ? "hover:bg-secondary text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/30 cursor-not-allowed",
              )}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          className="bg-card/50 p-3 sm:p-5 text-center border-t min-[420px]:border-t-0 min-[420px]:border-l border-border/50 flex flex-col items-center justify-center"
          {...hoverProps}
        >
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Total</span>
          </div>
          <p className={cn(
            "text-xl sm:text-2xl font-bold font-mono",
            monthTotal > 0 ? "text-primary" : monthTotal < 0 ? "text-error" : "text-muted-foreground",
          )}>
            {displayTotal}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {activeSourceCount} source{activeSourceCount === 1 ? "" : "s"}
          </p>
        </div>

        <div className="bg-card/50 p-3 sm:p-5 text-center border-t min-[420px]:border-t-0 min-[420px]:border-l border-border/50 flex flex-col items-center justify-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <CalendarDays className="h-4 w-4" />
            <span className="text-sm font-medium">Items</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold font-mono">
            {activeLineItemCount}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            dated entries
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1 text-muted-foreground">
          <Plus className="h-4 w-4" />
          <h2 className="text-sm font-medium uppercase tracking-wider">
            Add Income Item
          </h2>
        </div>

        <div className="rounded-xl glass-card p-4 sm:p-5 space-y-4">
          <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)_140px]">
            <DateInput
              label="Date"
              value={addDate}
              onChange={(value) => value && setAddDate(value)}
              size="sm"
            />
            <CustomSelect
              label="Source"
              value={addSourceId}
              onChange={setAddSourceId}
              options={activeSourceOptions}
              placeholder="Select source"
              size="sm"
            />
            <NumberInput
              label="Amount"
              value={addAmount}
              onChange={(event) => setAddAmount(event.target.value)}
              placeholder="0.00"
              className="h-[34px] min-h-[34px] px-2.5 py-1.5 font-mono"
            />
          </div>
          <div className="space-y-3">
            <Textarea
              value={addNotes}
              onChange={(event) => setAddNotes(event.target.value)}
              placeholder="Notes for this item..."
              className="min-h-[72px]"
            />
            <div className="flex justify-end">
              <Button
                onClick={handleAddItem}
                disabled={!canAdd || isAdding}
                className="w-full sm:w-32"
              >
                {isAdding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {isAdding ? "Saving..." : "Add"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-1 text-muted-foreground">
            <ReceiptText className="h-4 w-4" />
            <h2 className="text-sm font-medium uppercase tracking-wider">
              Source Entries
            </h2>
          </div>

          {sourceRows.length === 0 ? (
            <div className="glass-card rounded-xl p-8 text-center">
              <ReceiptText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium">No income items for this month</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add one above to start the ledger.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {sourceRows.map((row, index) => {
                const isExpanded = expandedSourceIds.has(row.source.id);
                const displaySourceTotal = getMaskedValue(
                  formatCurrency(row.total),
                  isHidden,
                  isRevealed,
                );

                return (
                  <div
                    key={row.source.id}
                    className={cn(
                      "rounded-xl glass-card overflow-hidden animate-fade-up",
                      `stagger-${Math.min(index + 1, 6)}`,
                    )}
                    {...hoverProps}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSource(row.source.id)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 text-muted-foreground transition-transform",
                            !isExpanded && "-rotate-90",
                          )}
                        />
                        <span
                          className="h-3 w-3 rounded-full shrink-0"
                          style={{ backgroundColor: row.source.color || "#5B8A8A" }}
                        />
                        <div className="min-w-0">
                          <p className="font-medium truncate">{row.source.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {row.items.length} item{row.items.length === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      <p className={cn(
                        "font-mono font-semibold",
                        row.total < 0 ? "text-error" : "text-primary",
                      )}>
                        {displaySourceTotal}
                      </p>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border/50">
                        {row.items.length === 0 ? (
                          <div className="px-4 py-4 text-sm text-muted-foreground">
                            No item history exists for this source yet.
                          </div>
                        ) : (
                          <div className="divide-y divide-border/50">
                            {row.items.map((item) => {
                              const isEditing = editingItemId === item.id;
                              const isSaving = savingItemId === item.id;
                              const isDeleting = deletingItemId === item.id;
                              const displayItemAmount = getMaskedValue(
                                formatCurrency(Number(item.amount)),
                                isHidden,
                                isRevealed,
                              );

                              if (isEditing) {
                                return (
                                  <div key={item.id} className="p-4 bg-secondary/20 space-y-3">
                                    <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)_130px]">
                                      <DateInput
                                        label="Date"
                                        value={editDate}
                                        onChange={(value) => value && setEditDate(value)}
                                        size="sm"
                                      />
                                      <CustomSelect
                                        label="Source"
                                        value={editSourceId}
                                        onChange={setEditSourceId}
                                        options={editableSourceOptions}
                                        size="sm"
                                      />
                                      <NumberInput
                                        label="Amount"
                                        value={editAmount}
                                        onChange={(event) => setEditAmount(event.target.value)}
                                        className="h-[34px] min-h-[34px] px-2.5 py-1.5 font-mono"
                                      />
                                    </div>
                                    <Textarea
                                      value={editNotes}
                                      onChange={(event) => setEditNotes(event.target.value)}
                                      placeholder="Notes for this item..."
                                      className="min-h-[72px]"
                                    />
                                    <div className="flex items-center justify-end gap-2">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={cancelEditItem}
                                        disabled={isSaving}
                                      >
                                        <X className="h-4 w-4" />
                                        Cancel
                                      </Button>
                                      <Button
                                        size="sm"
                                        onClick={() => handleSaveItem(item.id)}
                                        disabled={isSaving || (parseFloat(editAmount) || 0) === 0}
                                      >
                                        {isSaving ? (
                                          <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                          <Save className="h-4 w-4" />
                                        )}
                                        {isSaving ? "Saving..." : "Save"}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              }

                              return (
                                <div
                                  key={item.id}
                                  className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-3 items-center"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium">
                                      {formatDate(item.received_date)}
                                    </p>
                                    {item.notes && (
                                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                                        {item.notes}
                                      </p>
                                    )}
                                  </div>
                                  <p className={cn(
                                    "font-mono text-sm font-medium",
                                    Number(item.amount) < 0 ? "text-error" : "text-foreground",
                                  )}>
                                    {displayItemAmount}
                                  </p>
                                  <div className="flex items-center gap-1">
                                    <Tooltip content="Edit item">
                                      <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label="Edit income item"
                                        onClick={() => startEditItem(item)}
                                        disabled={Boolean(editingItemId) || isDeleting}
                                      >
                                        <Pencil className="h-4 w-4" />
                                      </Button>
                                    </Tooltip>
                                    <Tooltip content="Delete item">
                                      <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label="Delete income item"
                                        className="text-error hover:text-error"
                                        onClick={() => handleDeleteItem(item)}
                                        disabled={isDeleting}
                                      >
                                        {isDeleting ? (
                                          <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                          <Trash2 className="h-4 w-4" />
                                        )}
                                      </Button>
                                    </Tooltip>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-6">
          {chartData.length > 0 && (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 text-muted-foreground mb-3">
                <PieChart className="h-4 w-4" />
                <span className="text-sm font-medium uppercase tracking-wider">Breakdown</span>
              </div>
              <div className="rounded-xl glass-card p-4 flex-1" {...hoverProps}>
                <IncomeBreakdownChart
                  data={chartData}
                  isRevealed={isRevealed}
                  size="compact"
                />
              </div>
            </div>
          )}

          <div className="flex flex-col">
            <div className="flex items-center justify-between gap-2 text-muted-foreground mb-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                <span className="text-sm font-medium uppercase tracking-wider">Month Notes</span>
              </div>
              {!isEditingNotes && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setIsEditingNotes(true)}
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Button>
              )}
            </div>
            {isEditingNotes ? (
              <div className="space-y-3">
                <Textarea
                  value={monthNotes}
                  onChange={(event) => setMonthNotes(event.target.value)}
                  placeholder="Any notes about this month..."
                  className="min-h-[160px] resize-none glass-card px-4 py-4"
                />
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMonthNotes(entry.notes || "");
                      setIsEditingNotes(false);
                    }}
                    disabled={isSavingNotes}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveMonthNotes}
                    disabled={isSavingNotes}
                  >
                    {isSavingNotes ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {isSavingNotes ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="rounded-xl glass-card flex min-h-[160px] w-full items-start justify-start px-4 py-4 text-left cursor-pointer hover:bg-secondary/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={() => setIsEditingNotes(true)}
              >
                <p className={cn(
                  "text-sm whitespace-pre-wrap",
                  !entry.notes && "text-muted-foreground italic",
                )}>
                  {entry.notes || "Click to add notes..."}
                </p>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          className="text-error hover:text-error hover:bg-error/10"
          onClick={handleDeleteMonth}
          disabled={isDeletingMonth}
        >
          {isDeletingMonth ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          {isDeletingMonth ? "Deleting..." : "Delete Month"}
        </Button>
      </div>
    </div>
  );
}
