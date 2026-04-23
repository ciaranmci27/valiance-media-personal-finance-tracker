"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  onRightIconClick?: () => void;
  /** Accessible label for the right-icon button (e.g. "Show password"). Required
   *  whenever `onRightIconClick` is set so screen readers can identify the
   *  interactive control. The button is also keyboard-reachable when this is
   *  present. */
  rightIconLabel?: string;
  label?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, icon, rightIcon, onRightIconClick, rightIconLabel, label, id, required, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
    const isInteractiveRight = Boolean(onRightIconClick);

    return (
      <div className={cn("space-y-1.5", !label && !icon && !rightIcon && "contents")}>
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
            {label}
            {required && <span className="text-error ml-1" aria-hidden="true">*</span>}
          </label>
        )}
        <div className={cn("relative", !label && !icon && !rightIcon && "contents")}>
          {icon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              {icon}
            </div>
          )}
          <input
            id={inputId}
            type={type}
            required={required}
            aria-required={required || undefined}
            className={cn(
              "flex h-10 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground transition-colors",
              "placeholder:text-muted-foreground",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background focus:border-transparent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "file:border-0 file:bg-transparent file:text-sm file:font-medium",
              icon && "pl-10",
              rightIcon && "pr-10",
              error && "border-error focus:ring-error",
              className
            )}
            ref={ref}
            {...props}
          />
          {rightIcon && (
            <button
              type="button"
              onClick={onRightIconClick}
              aria-label={rightIconLabel}
              className={cn(
                "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors rounded-sm",
                isInteractiveRight
                  ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  : "focus:outline-none",
              )}
              tabIndex={isInteractiveRight ? 0 : -1}
            >
              {rightIcon}
            </button>
          )}
        </div>
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
