"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  size?: "default" | "sm";
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      checked,
      onChange,
      disabled = false,
      label,
      size = "default",
      className,
      ...props
    },
    ref,
  ) => {
    const isSmall = size === "sm";

    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
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
            "relative inline-flex shrink-0 items-center justify-center rounded border transition-colors duration-150 ease-out",
            "group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
            isSmall ? "h-4 w-4" : "h-5 w-5",
            checked
              ? "bg-primary border-primary"
              : "bg-transparent border-border group-hover:border-primary/50",
          )}
        >
          {checked && (
            <Check
              className={cn(
                "text-primary-foreground",
                isSmall ? "h-3 w-3" : "h-3.5 w-3.5",
              )}
              strokeWidth={3}
              aria-hidden="true"
            />
          )}
        </span>
        {label && <span className="select-none">{label}</span>}
      </button>
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
