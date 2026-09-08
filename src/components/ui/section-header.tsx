import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionHeaderProps {
  label: ReactNode;
  /** Subtle count pill next to the label. */
  count?: number;
  /** Optional semantic status dot color (a CSS color value). */
  dotColor?: string;
  /** Right-aligned slot for a small action or filter. */
  action?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
  className?: string;
}

/**
 * The one heading used above grouped lists and tables. Neutral uppercase label
 * plus a quiet count pill, so every grouped section reads as part of one system
 * instead of an ad hoc heading per screen.
 */
export function SectionHeader({
  label,
  count,
  dotColor,
  action,
  description,
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn("mb-3 flex items-start justify-between gap-3", className)}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {dotColor && (
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: dotColor }}
            />
          )}
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </h2>
          {typeof count === "number" && (
            <span className="rounded-full bg-[rgba(var(--ink),0.06)] px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
