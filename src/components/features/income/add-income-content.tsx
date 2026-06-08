"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  DollarSign,
  Loader2,
  Plus,
  ReceiptText,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/select";
import { DateInput } from "@/components/ui/date-input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import {
  defaultDateForMonth,
  ensureIncomeEntryForDate,
  monthStartFromDate,
  todayIso,
} from "@/lib/income-ledger";
import {
  cn,
  formatCurrency,
  formatDate,
  formatMonth,
  parseLocalDate,
} from "@/lib/utils";
import type {
  IncomeLineItemWithEntryAndSource,
  IncomeSource,
} from "@/types/database";

interface AddIncomeContentProps {
  sources: IncomeSource[];
  lineItems: IncomeLineItemWithEntryAndSource[];
}

interface SourceGroup {
  source: {
    id: string;
    name: string;
    color: string | null;
  };
  items: IncomeLineItemWithEntryAndSource[];
  total: number;
}

function groupItemsBySource(
  items: IncomeLineItemWithEntryAndSource[],
  sources: IncomeSource[],
): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();

  for (const item of items) {
    const fallbackSource = sources.find((source) => source.id === item.source_id);
    const source = item.income_sources || fallbackSource;
    if (!source) continue;

    const existing = groups.get(source.id) || {
      source: {
        id: source.id,
        name: source.name,
        color: source.color,
      },
      items: [] as IncomeLineItemWithEntryAndSource[],
      total: 0,
    };

    existing.items.push(item);
    existing.total += Number(item.amount);
    groups.set(source.id, existing);
  }

  return Array.from(groups.values()).sort((a, b) => b.total - a.total);
}

export function AddIncomeContent({
  sources,
  lineItems,
}: AddIncomeContentProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = React.useState(false);
  const [receivedDate, setReceivedDate] = React.useState(() => todayIso());
  const [sourceId, setSourceId] = React.useState(() => sources[0]?.id ?? "");
  const [amount, setAmount] = React.useState("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!sourceId && sources[0]) {
      setSourceId(sources[0].id);
    }
  }, [sourceId, sources]);

  const selectedMonth = monthStartFromDate(receivedDate);
  const selectedMonthItems = React.useMemo(() => {
    return lineItems
      .filter((item) => item.income_entries?.month === selectedMonth)
      .sort((a, b) => {
        const dateDiff =
          parseLocalDate(b.received_date).getTime() -
          parseLocalDate(a.received_date).getTime();
        if (dateDiff !== 0) return dateDiff;
        return b.created_at.localeCompare(a.created_at);
      });
  }, [lineItems, selectedMonth]);

  const groups = React.useMemo(
    () => groupItemsBySource(selectedMonthItems, sources),
    [selectedMonthItems, sources],
  );

  const monthTotal = selectedMonthItems.reduce(
    (sum, item) => sum + Number(item.amount),
    0,
  );
  const numericAmount = parseFloat(amount) || 0;
  const canSave = Boolean(receivedDate && sourceId && numericAmount !== 0);
  const sourceOptions = sources.map((source) => ({
    value: source.id,
    label: source.name,
  }));

  const handleSave = async () => {
    if (!canSave) return;

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      setAmount("");
      setNotes("");
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      const entryId = await ensureIncomeEntryForDate(supabase, receivedDate);

      const { error } = await supabase.from("income_line_items").insert({
        entry_id: entryId,
        source_id: sourceId,
        received_date: receivedDate,
        amount: numericAmount,
        notes: notes.trim() || null,
      });

      if (error) throw error;

      setAmount("");
      setNotes("");
      toast("success", "Income item added");
      router.refresh();
    } catch (error) {
      console.error("Error adding income item:", error);
      toast("error", "Could not add income item");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="hidden md:flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <ReceiptText className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Add Income Item</h1>
            <p className="text-sm text-muted-foreground">
              Record a dated payment and keep monthly totals automatic.
            </p>
          </div>
        </div>
        <Link href="/income">
          <Button variant="ghost">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
      </div>

      <div className="grid gap-px overflow-hidden rounded-xl glass-card md:grid-cols-3">
        <div className="bg-card/50 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <CalendarDays className="h-4 w-4" />
            <span className="text-sm font-medium">Selected Month</span>
          </div>
          <p className="text-lg font-semibold">{formatMonth(selectedMonth)}</p>
          <button
            type="button"
            onClick={() => setReceivedDate(defaultDateForMonth(selectedMonth))}
            className="mt-1 text-xs text-primary hover:underline"
          >
            Jump to today in this month
          </button>
        </div>
        <div className="bg-card/50 p-4 sm:p-5 border-t md:border-t-0 md:border-l border-border/50">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Month Total</span>
          </div>
          <p className={cn(
            "text-2xl font-bold font-mono",
            monthTotal < 0 ? "text-error" : "text-primary",
          )}>
            {formatCurrency(monthTotal)}
          </p>
        </div>
        <div className="bg-card/50 p-4 sm:p-5 border-t md:border-t-0 md:border-l border-border/50">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <ReceiptText className="h-4 w-4" />
            <span className="text-sm font-medium">Items Added</span>
          </div>
          <p className="text-2xl font-bold font-mono">
            {selectedMonthItems.length}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        <div className="rounded-xl glass-card p-4 sm:p-5 space-y-4 h-fit">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-primary" />
            <h2 className="font-semibold">New Item</h2>
          </div>

          <DateInput
            label="Received Date"
            value={receivedDate}
            onChange={(value) => value && setReceivedDate(value)}
            required
          />

          <CustomSelect
            label="Source"
            value={sourceId}
            onChange={setSourceId}
            options={sourceOptions}
            placeholder="Select source"
            disabled={sourceOptions.length === 0}
            required
          />

          <NumberInput
            label="Amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            className="h-10 min-h-10 font-mono"
            required
          />

          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Notes for this item..."
            className="min-h-[96px]"
          />

          <Button
            onClick={handleSave}
            disabled={!canSave || isSaving || sourceOptions.length === 0}
            className="w-full"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {isSaving ? "Saving..." : "Add Item"}
          </Button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {formatMonth(selectedMonth)} Ledger
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>

          {groups.length === 0 ? (
            <div className="glass-card rounded-xl p-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted mx-auto mb-3">
                <ReceiptText className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="font-medium">No items added for this month</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add the first item on the left.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((group, groupIndex) => (
                <div
                  key={group.source.id}
                  className={cn(
                    "rounded-xl glass-card overflow-hidden animate-fade-up",
                    `stagger-${Math.min(groupIndex + 1, 6)}`,
                  )}
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="h-3 w-3 rounded-full shrink-0"
                        style={{ backgroundColor: group.source.color || "#5B8A8A" }}
                      />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{group.source.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {group.items.length} item{group.items.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                    <p className={cn(
                      "font-mono font-semibold",
                      group.total < 0 ? "text-error" : "text-primary",
                    )}>
                      {formatCurrency(group.total)}
                    </p>
                  </div>

                  <div className="divide-y divide-border/50">
                    {group.items.map((item) => (
                      <div
                        key={item.id}
                        className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3"
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
                          {formatCurrency(Number(item.amount))}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
