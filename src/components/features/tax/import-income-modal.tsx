"use client";

import * as React from "react";
import { Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import {
  demoIncomeSources,
  demoIncomeEntries,
  demoIncomeAmountsPlain,
} from "@/lib/demo/data";
import { formatCurrency, cn } from "@/lib/utils";
import type { TaxIncomeSource, TaxClassification, IncomeType } from "@/types/database";
import { IncomeTypePicker } from "./income-type-picker";

interface ImportIncomeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taxYear: number;
  onImport: (sources: TaxIncomeSource[]) => void;
  taxClassification?: TaxClassification | null;
}

interface AggregatedSource {
  sourceId: string; // income_sources.id for link tracking
  name: string;
  total: number;
  selected: boolean;
  incomeType: IncomeType | null;
  subjectToSe: boolean;
}

export function ImportIncomeModal({
  open,
  onOpenChange,
  taxYear,
  onImport,
  taxClassification,
}: ImportIncomeModalProps) {
  const [loading, setLoading] = React.useState(false);
  const [sources, setSources] = React.useState<AggregatedSource[]>([]);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Fetch and aggregate income data when modal opens
  React.useEffect(() => {
    if (!open) return;

    async function fetchIncome() {
      setLoading(true);
      try {
        if (isDemoMode()) {
          // Use demo data
          const yearStart = `${taxYear}-01-01`;
          const yearEnd = `${taxYear}-12-31`;

          const entriesInYear = demoIncomeEntries.filter(
            (e) => e.month >= yearStart && e.month <= yearEnd && !e.deleted_at
          );
          const entryIds = new Set(entriesInYear.map((e) => e.id));

          const sourceMap = new Map<string, { sourceId: string; name: string; total: number }>();
          for (const amount of demoIncomeAmountsPlain) {
            if (!entryIds.has(amount.entry_id)) continue;
            const source = demoIncomeSources.find((s) => s.id === amount.source_id);
            if (!source) continue;

            const existing = sourceMap.get(source.id) || { sourceId: source.id, name: source.name, total: 0 };
            existing.total += Number(amount.amount);
            sourceMap.set(source.id, existing);
          }

          setSources(
            Array.from(sourceMap.values())
              .filter((s) => s.total > 0)
              .map((s) => ({
                sourceId: s.sourceId,
                name: s.name,
                total: s.total,
                selected: true,
                incomeType: null,
                subjectToSe: false,
              }))
          );
        } else {
          const supabase = createClient();

          // Fetch entries for the tax year
          const { data: entries } = await supabase
            .from("income_entries")
            .select("id, month")
            .is("deleted_at", null)
            .gte("month", `${taxYear}-01-01`)
            .lte("month", `${taxYear}-12-31`);

          if (!entries || entries.length === 0) {
            setSources([]);
            return;
          }

          const entryIds = entries.map((e) => e.id);

          // Fetch amounts for those entries
          const { data: amounts } = await supabase
            .from("income_amounts")
            .select("amount, source_id, income_sources(name)")
            .in("entry_id", entryIds);

          if (!amounts) {
            setSources([]);
            return;
          }

          // Aggregate by source
          const sourceMap = new Map<string, { sourceId: string; name: string; total: number }>();
          for (const a of amounts) {
            const name =
              (a.income_sources as unknown as { name: string })?.name || "Unknown";
            const existing = sourceMap.get(a.source_id) || { sourceId: a.source_id, name, total: 0 };
            existing.total += Number(a.amount);
            sourceMap.set(a.source_id, existing);
          }

          setSources(
            Array.from(sourceMap.values())
              .filter((s) => s.total > 0)
              .map((s) => ({
                sourceId: s.sourceId,
                name: s.name,
                total: s.total,
                selected: true,
                incomeType: null,
                subjectToSe: false,
              }))
          );
        }
      } finally {
        setLoading(false);
      }
    }

    fetchIncome();
  }, [open, taxYear]);

  const toggleSelected = (index: number) => {
    setSources((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, selected: !s.selected } : s
      )
    );
  };

  const updateIncomeType = (index: number, newType: IncomeType) => {
    setSources((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, incomeType: newType, subjectToSe: newType === "1099" } : s
      )
    );
  };

  const toggleSe = (index: number) => {
    setSources((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, subjectToSe: !s.subjectToSe } : s
      )
    );
  };

  const handleConfirm = () => {
    const selected = sources
      .filter((s) => s.selected && s.incomeType)
      .map((s) => ({
        id: crypto.randomUUID(),
        name: s.name,
        amount: Math.round(s.total * 100) / 100,
        subject_to_se: s.subjectToSe,
        income_type: s.incomeType!,
        linked_source_id: s.sourceId,
        linked_amount: Math.round(s.total * 100) / 100,
        is_unlinked: false,
      }));

    onImport(selected);
    onOpenChange(false);
  };

  const selectedSources = sources.filter((s) => s.selected);
  const selectedCount = selectedSources.length;
  const selectedTotal = selectedSources.reduce((sum, s) => sum + s.total, 0);
  const hasUnclassified = selectedSources.some((s) => !s.incomeType);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div ref={contentRef} className="relative">
        <DialogHeader>
          <DialogTitle>Income Reference</DialogTitle>
          <DialogDescription>
            Your tracked revenue for {taxYear} is shown below for reference.
            These totals may reflect top, middle, or bottom-line revenue and may differ from your actual tax figures.
          </DialogDescription>
        </DialogHeader>

        {/* YTD total summary banner */}
        {!loading && sources.length > 0 && (
          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-4 py-3 mt-4">
            <span className="text-sm text-muted-foreground">
              Total Tracked Revenue:{" "}
              <span className="font-mono font-medium text-foreground">
                {formatCurrency(sources.reduce((sum, s) => sum + s.total, 0))}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {sources.length} source{sources.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        <div className="py-4 space-y-2 max-h-80 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && sources.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No income data found for {taxYear}.
            </p>
          )}

          {/* Helper text above source list */}
          {!loading && sources.length > 0 && (
            <p className="text-xs text-muted-foreground px-1 pb-1">
              Select sources to pre-fill your tax income. You can adjust amounts after importing to reflect actual tax figures.
            </p>
          )}

          {!loading &&
            sources.map((source, i) => (
              <div
                key={source.sourceId}
                role="button"
                tabIndex={0}
                onClick={() => toggleSelected(i)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSelected(i); } }}
                className={cn(
                  "w-full flex items-center gap-3 rounded-lg border border-border p-3 transition-all duration-200 text-left cursor-pointer",
                  "opacity-0 animate-fade-up",
                  `stagger-${Math.min(i + 1, 6)}`,
                  source.selected
                    ? "bg-primary/5 border-primary/20"
                    : "opacity-50"
                )}
                style={{ animationFillMode: "forwards" }}
              >
                {/* Checkbox */}
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                    source.selected
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-border"
                  )}
                >
                  {source.selected && <Check className="h-3 w-3" />}
                </span>

                {/* Source info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{source.name}</p>
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-muted text-muted-foreground border border-border">
                      YTD
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">
                    {formatCurrency(source.total)}
                  </p>
                </div>

                {/* Income type picker + SE toggle */}
                <div onClick={(e) => e.stopPropagation()} className="shrink-0 flex items-center gap-1">
                  <IncomeTypePicker
                    incomeType={source.incomeType}
                    taxClassification={taxClassification ?? null}
                    onChange={(type) => updateIncomeType(i, type)}
                    portalContainer={contentRef}
                  />
                  {source.incomeType === "1099" && (
                    <button
                      type="button"
                      onClick={() => toggleSe(i)}
                      className={cn(
                        "px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border cursor-pointer transition-colors",
                        source.subjectToSe
                          ? "bg-primary/15 text-primary border-primary/25"
                          : "bg-muted text-muted-foreground/40 border-border line-through"
                      )}
                    >
                      SE
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-3">
          {/* Footer total */}
          {selectedCount > 0 && (
            <div className="hidden sm:block flex-1 text-sm text-muted-foreground">
              <span className="font-mono font-medium text-foreground">
                {formatCurrency(selectedTotal)}
              </span>{" "}
              from {selectedCount} source{selectedCount !== 1 ? "s" : ""}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} className="flex-1 sm:flex-initial">
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={selectedCount === 0 || hasUnclassified}
              className="gap-2 flex-1 sm:flex-initial"
            >
              Use {selectedCount} Source{selectedCount !== 1 ? "s" : ""}
            </Button>
          </div>
        </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
