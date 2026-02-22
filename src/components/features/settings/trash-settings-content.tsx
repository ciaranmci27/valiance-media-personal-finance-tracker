"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  RotateCcw,
  Trash2,
  DollarSign,
  Calendar,
  Receipt,
  TrendingUp,
  Loader2,
  Package,
  Zap,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatMonth, formatDate, cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";

interface DeletedItem {
  id: string;
  name?: string;
  date?: string;
  month?: string;
  amount?: string;
  frequency?: string;
  event_type?: string;
  changed_at?: string;
  deleted_at: string;
}

interface TrashSettingsContentProps {
  deletedSources: DeletedItem[];
  deletedEntries: DeletedItem[];
  deletedExpenses: DeletedItem[];
  deletedNetWorth: DeletedItem[];
  deletedAutomations: DeletedItem[];
  deletedExpenseHistory: DeletedItem[];
}

type ItemType = "income_sources" | "income_entries" | "expenses" | "net_worth" | "automations" | "expense_history";

const itemConfig: Record<ItemType, { icon: React.ElementType; label: string; color: string }> = {
  income_sources: { icon: DollarSign, label: "Income Sources", color: "text-primary bg-primary/10" },
  income_entries: { icon: Calendar, label: "Income Entries", color: "text-[#C5A68F] bg-[#C5A68F]/10" },
  expenses: { icon: Receipt, label: "Expenses", color: "text-error bg-error/10" },
  net_worth: { icon: TrendingUp, label: "Net Worth", color: "text-success bg-success/10" },
  automations: { icon: Zap, label: "Automations", color: "text-amber-500 bg-amber-500/10" },
  expense_history: { icon: History, label: "Expense History", color: "text-muted-foreground bg-muted" },
};

export function TrashSettingsContent({
  deletedSources,
  deletedEntries,
  deletedExpenses,
  deletedNetWorth,
  deletedAutomations,
  deletedExpenseHistory,
}: TrashSettingsContentProps) {
  const router = useRouter();
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  const allItems = [
    ...deletedSources.map((item) => ({ ...item, type: "income_sources" as ItemType })),
    ...deletedEntries.map((item) => ({ ...item, type: "income_entries" as ItemType })),
    ...deletedExpenses.map((item) => ({ ...item, type: "expenses" as ItemType })),
    ...deletedNetWorth.map((item) => ({ ...item, type: "net_worth" as ItemType })),
    ...deletedAutomations.map((item) => ({ ...item, type: "automations" as ItemType })),
    ...deletedExpenseHistory.map((item) => ({ ...item, type: "expense_history" as ItemType })),
  ].sort((a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime());

  const totalDeleted = allItems.length;

  const handleRestore = async (type: ItemType, id: string) => {
    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      return;
    }

    setRestoring(id);
    const supabase = createClient();

    try {
      // Restore the item by clearing deleted_at
      // Note: For expenses, database trigger automatically creates "activated" history event
      await supabase.from(type).update({ deleted_at: null }).eq("id", id);
      router.refresh();
    } catch (error) {
      console.error("Error restoring:", error);
    } finally {
      setRestoring(null);
    }
  };

  const handlePermanentDelete = async (type: ItemType, id: string) => {
    // Show a more detailed warning for expenses and expense history since it affects historical data
    let warningMessage = "Permanently delete this item? This cannot be undone.";

    if (type === "expenses") {
      warningMessage = "⚠️ Warning: Permanently deleting this expense will make your historical financial data inaccurate.\n\nPast monthly totals and reports will no longer reflect this expense.\n\nWe recommend:\n• Pausing the expense instead (keeps history accurate)\n• Keeping it in trash (can restore later)\n\nAre you sure you want to permanently delete?";
    } else if (type === "expense_history") {
      warningMessage = "⚠️ Warning: Permanently deleting this history entry will remove the audit trail for this expense change.\n\nThis may affect your ability to track expense changes over time.\n\nAre you sure you want to permanently delete?";
    }

    if (!confirm(warningMessage)) return;

    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      return;
    }

    setDeleting(id);
    const supabase = createClient();

    try {
      await supabase.from(type).delete().eq("id", id);
      router.refresh();
    } catch (error) {
      console.error("Error deleting:", error);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-error/10">
            <Trash2 className="h-5 w-5 text-error" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Trash</h1>
            <p className="text-sm text-muted-foreground">
              {totalDeleted === 0
                ? "No deleted items"
                : `${totalDeleted} deleted item${totalDeleted !== 1 ? "s" : ""}`}
            </p>
          </div>
        </div>
        <Link href="/settings">
          <Button size="sm" className="rounded-xl gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
      </div>

      {totalDeleted === 0 ? (
        /* Empty State */
        <div className="glass-card rounded-xl p-12 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted mx-auto mb-4">
            <Package className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="font-medium mb-1">Trash is empty</h3>
          <p className="text-sm text-muted-foreground">
            Deleted items will appear here for recovery
          </p>
        </div>
      ) : (
        /* Deleted Items List */
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recently Deleted
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>

          <div className="glass-card rounded-xl overflow-hidden">
            <div className="divide-y divide-border/50">
              {allItems.map((item) => {
                const config = itemConfig[item.type];
                const Icon = config.icon;
                const isLoading = restoring === item.id || deleting === item.id;

                return (
                  <div
                    key={`${item.type}-${item.id}`}
                    className={cn(
                      "flex items-center gap-4 p-4 transition-colors hover:bg-secondary/30",
                      isLoading && "opacity-50"
                    )}
                  >
                    {/* Icon */}
                    <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl shrink-0", config.color.split(" ")[1])}>
                      <Icon className={cn("h-5 w-5", config.color.split(" ")[0])} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">
                        {item.name ||
                          (item.month ? formatMonth(item.month) :
                          (item.date ? formatMonth(item.date) :
                          (item.amount ? `${item.event_type ? `${item.event_type.charAt(0).toUpperCase() + item.event_type.slice(1)}: ` : ''}$${Number(item.amount).toFixed(2).replace(/\.00$/, '')} (${item.frequency})` :
                          `Item ${item.id.slice(0, 8)}`)))}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{config.label}</span>
                        <span>•</span>
                        <span>Deleted {formatDate(item.deleted_at)}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-3 rounded-lg hover:bg-success/10 hover:text-success"
                        onClick={() => handleRestore(item.type, item.id)}
                        disabled={isLoading}
                      >
                        {restoring === item.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <RotateCcw className="h-4 w-4 mr-1.5" />
                            Restore
                          </>
                        )}
                      </Button>
                      <Tooltip content="Delete permanently">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 rounded-lg hover:bg-error/10 hover:text-error"
                        onClick={() => handlePermanentDelete(item.type, item.id)}
                        disabled={isLoading}
                      >
                        {deleting === item.id ? (
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
          </div>

          {/* Info Text */}
          <p className="text-xs text-muted-foreground text-center px-4">
            Items in trash are kept for 30 days before permanent deletion
          </p>
        </div>
      )}
    </div>
  );
}
