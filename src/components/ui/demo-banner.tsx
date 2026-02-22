"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface DemoBannerProps {
  sidebarCollapsed?: boolean;
}

export function DemoBanner({ sidebarCollapsed = false }: DemoBannerProps) {
  return (
    <div
      className={cn(
        "fixed bottom-0 right-0 left-0 z-40 bg-primary/10 backdrop-blur-sm border-t border-primary/20 px-4 py-2 transition-all duration-300",
        // Match sidebar margin on desktop
        sidebarCollapsed ? "md:left-16" : "md:left-64"
      )}
    >
      <div className="flex items-center justify-center gap-2 text-sm">
        <Info className="h-4 w-4 text-primary shrink-0" />
        <span className="text-primary font-medium">
          Demo Mode
        </span>
        <span className="text-muted-foreground hidden sm:inline">
          — You&apos;re viewing sample data. Changes won&apos;t be saved.
        </span>
      </div>
    </div>
  );
}
