"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  size?: "default" | "sm";
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    { checked, onChange, disabled = false, label, size = "default", className, ...props },
    ref,
  ) => {
    const isSmall = size === "sm";

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          "group inline-flex items-center gap-2.5 text-sm font-medium text-foreground",
          "focus-visible:outline-none",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            "relative inline-block shrink-0 rounded-full transition-colors duration-200 ease-out",
            "group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
            isSmall ? "h-[18px] w-8" : "h-5 w-9",
            checked ? "bg-primary" : "bg-muted-foreground/40",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-[2px] left-[2px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out",
              isSmall ? "h-3.5 w-3.5" : "h-4 w-4",
              checked
                ? isSmall
                  ? "translate-x-[14px]"
                  : "translate-x-4"
                : "translate-x-0",
            )}
          />
        </span>
        {label && <span className="select-none">{label}</span>}
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
