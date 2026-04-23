"use client";

import Link from "next/link";
import { Map as MapIcon, Plus, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CALCULATION_METHOD_LABELS, type StateTaxConfig } from "@/types/payroll";

interface Props {
  configs: StateTaxConfig[];
}

export function StatesListContent({ configs }: Props) {
  // Group by state_code, keeping years sorted DESC within each group.
  const groups = new Map<string, StateTaxConfig[]>();
  for (const cfg of configs) {
    const list = groups.get(cfg.state_code) ?? [];
    list.push(cfg);
    groups.set(cfg.state_code, list);
  }
  const groupedStates = Array.from(groups.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
              <MapIcon className="h-5 w-5 text-violet-500" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">State Tax Tables</h1>
              <p className="text-sm text-muted-foreground">
                Per-state income tax, SDI, and SUTA configuration
              </p>
            </div>
          </div>
        </div>
        <Link href="/payroll/config/states/new">
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Add State
          </Button>
        </Link>
      </div>

      {groupedStates.length === 0 ? (
        <div className="glass-card rounded-xl p-8 text-center text-sm text-muted-foreground">
          No state configurations yet. Add one to get started.
        </div>
      ) : (
        <div className="space-y-4">
          {groupedStates.map(([code, years]) => (
            <div key={code} className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {code}
                </h2>
                <div className="flex-1 h-px bg-border/50" />
              </div>
              {years.map((cfg) => (
                <Link
                  key={cfg.id}
                  href={`/payroll/config/states/${cfg.state_code}/${cfg.tax_year}`}
                  className="block group"
                >
                  <div
                    className={cn(
                      "glass-card rounded-xl p-4 transition-all duration-200",
                      "hover:border-primary/30 hover:scale-[1.01]"
                    )}
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/10 group-hover:scale-105 transition-transform">
                        <MapIcon className="h-5 w-5 text-violet-500" aria-hidden="true" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                          {cfg.state_code} · {cfg.tax_year}
                        </h3>
                        <p className="text-sm text-muted-foreground truncate">
                          {CALCULATION_METHOD_LABELS[cfg.calculation_method]}
                        </p>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
