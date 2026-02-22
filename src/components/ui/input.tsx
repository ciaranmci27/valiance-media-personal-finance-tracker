"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  onRightIconClick?: () => void;
  label?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, icon, rightIcon, onRightIconClick, label, id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-foreground">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              {icon}
            </div>
          )}
          <input
            id={inputId}
            type={type}
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
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
              tabIndex={-1}
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
