"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Landmark, Plus, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { FederalTaxConfig } from "@/types/payroll";

interface Props {
  configs: FederalTaxConfig[];
}

export function FederalListContent({ configs }: Props) {
  const router = useRouter();

  const [showAddYear, setShowAddYear] = React.useState(false);
  const [newYear, setNewYear] = React.useState<string>("");
  const [navigating, setNavigating] = React.useState(false);

  const existingYears = React.useMemo(
    () => new Set(configs.map((c) => c.tax_year)),
    [configs]
  );

  const handleCreateYear = () => {
    const year = Number(newYear);
    if (!year || year < 2000 || year > 2100) {
      toast("error", "Enter a valid 4-digit year between 2000 and 2100");
      return;
    }
    if (existingYears.has(year)) {
      toast("info", `Config for ${year} already exists`);
      router.push(`/payroll/config/federal/${year}`);
      return;
    }
    setNavigating(true);
    router.push(`/payroll/config/federal/${year}`);
  };

  // Reset navigating state if the component stays mounted (e.g. navigation was cancelled).
  React.useEffect(() => {
    if (!navigating) return;
    const t = window.setTimeout(() => setNavigating(false), 3000);
    return () => window.clearTimeout(t);
  }, [navigating]);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#C5A68F]/10">
              <Landmark className="h-5 w-5 text-[#C5A68F]" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Federal Tax Tables</h1>
              <p className="text-sm text-muted-foreground">
                Per-year IRS brackets, FICA, FUTA, and standard deductions
              </p>
            </div>
          </div>
        </div>
        {!showAddYear && (
          <Button size="sm" onClick={() => setShowAddYear(true)}>
            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Add Year
          </Button>
        )}
      </div>

      {showAddYear && (
        <div className="glass-card rounded-xl p-4 flex items-center gap-3">
          <Input
            type="number"
            placeholder="e.g. 2027"
            value={newYear}
            onChange={(e) => setNewYear(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateYear();
              if (e.key === "Escape") {
                setShowAddYear(false);
                setNewYear("");
              }
            }}
            className="h-9 max-w-[140px]"
            autoFocus
          />
          <Button size="sm" onClick={handleCreateYear} disabled={navigating}>
            {navigating && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />}
            Open Editor
          </Button>
          <button
            type="button"
            onClick={() => {
              setShowAddYear(false);
              setNewYear("");
            }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md px-1 py-0.5"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="space-y-2">
        {configs.length === 0 ? (
          <div className="glass-card rounded-xl p-8 text-center text-sm text-muted-foreground">
            No federal tax configurations yet. Add one to get started.
          </div>
        ) : (
          configs.map((cfg) => (
            <Link
              key={cfg.id}
              href={`/payroll/config/federal/${cfg.tax_year}`}
              className="block group"
            >
              <div
                className={cn(
                  "glass-card rounded-xl p-4 transition-all duration-200",
                  "hover:border-primary/30 hover:scale-[1.01]"
                )}
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#C5A68F]/10 group-hover:scale-105 transition-transform">
                    <Landmark className="h-5 w-5 text-[#C5A68F]" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                      {cfg.tax_year} Tax Year
                    </h3>
                    <p className="text-sm text-muted-foreground truncate">
                      SS wage base ${cfg.fica.ss_wage_base.toLocaleString()} · FUTA{" "}
                      {(cfg.futa.rate * 100).toFixed(1)}% on ${cfg.futa.wage_base.toLocaleString()}
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
