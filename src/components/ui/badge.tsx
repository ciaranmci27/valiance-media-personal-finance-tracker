"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "copper";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: "default" | "sm";
  /** Leading status dot in the variant color. */
  dot?: boolean;
}

// Quiet tinted pills. Color is a signal, not decoration: most badges should be
// `default`; reserve semantic variants for states that matter at a glance.
// Every tint is a theme token so the pill reads on both grounds.
const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-[rgba(var(--ink),0.06)] text-foreground/80",
  success: "bg-success/12 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-error/12 text-error",
  info: "bg-primary/14 text-teal-light",
  copper: "bg-copper/16 text-copper",
};

const dotClasses: Record<BadgeVariant, string> = {
  default: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-error",
  info: "bg-teal-light",
  copper: "bg-copper",
};

export function Badge({
  variant = "default",
  size = "default",
  dot = false,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-1.5 py-px text-[11px]" : "px-2 py-0.5 text-xs",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            dotClasses[variant],
          )}
        />
      )}
      {children}
    </span>
  );
}
