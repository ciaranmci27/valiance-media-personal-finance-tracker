"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================================
// Option Types
// ============================================================================

export interface SelectOption {
  value: string;
  label: string;
  /** If true, renders as a non-clickable group header */
  isGroupHeader?: boolean;
}

// ============================================================================
// Custom Select with Portal Dropdown
// ============================================================================

export interface CustomSelectProps {
  label?: string;
  error?: string;
  helperText?: string;
  options: SelectOption[];
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
  size?: "default" | "sm";
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

function CustomSelect({
  className = "",
  label,
  error,
  helperText,
  options,
  placeholder = "Select an option",
  value,
  onChange,
  required,
  disabled,
  id,
  size = "default",
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [dropdownPosition, setDropdownPosition] = React.useState<DropdownPosition | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const selectId = id || label?.toLowerCase().replace(/\s+/g, "-");

  const selectedOption = options.find((opt) => opt.value === value);

  // Size-based padding
  const buttonPadding = size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2.5";
  const optionPadding = size === "sm" ? "px-3 py-2" : "px-4 py-2.5";

  // Calculate dropdown position based on trigger button
  const updateDropdownPosition = React.useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + window.scrollY + 4,
        left: rect.left + window.scrollX,
        width: rect.width,
      });
    }
  }, []);

  // Update position when dropdown opens
  React.useLayoutEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
    }
  }, [isOpen, updateDropdownPosition]);

  // Update position on scroll/resize
  React.useEffect(() => {
    if (!isOpen) return;

    const handlePositionUpdate = () => {
      updateDropdownPosition();
    };

    window.addEventListener("scroll", handlePositionUpdate, true);
    window.addEventListener("resize", handlePositionUpdate);

    return () => {
      window.removeEventListener("scroll", handlePositionUpdate, true);
      window.removeEventListener("resize", handlePositionUpdate);
    };
  }, [isOpen, updateDropdownPosition]);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideButton = buttonRef.current?.contains(target);
      const isInsideDropdown = dropdownRef.current?.contains(target);

      if (!isInsideButton && !isInsideDropdown) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  React.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen]);

  const handleSelect = React.useCallback(
    (optionValue: string) => {
      if (onChange) {
        onChange(optionValue);
      }
      setIsOpen(false);
    },
    [onChange]
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsOpen(!isOpen);
      } else if (event.key === "ArrowDown" && !isOpen) {
        event.preventDefault();
        setIsOpen(true);
      }
    },
    [isOpen]
  );

  // Render dropdown via Portal to escape stacking context issues
  const renderDropdown = () => {
    if (!isOpen || !dropdownPosition) return null;

    const dropdown = (
      <div
        ref={dropdownRef}
        role="listbox"
        style={{
          position: "absolute",
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
          zIndex: 99999,
        }}
        className="py-1 border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto bg-card"
      >
        {options.map((option, index) => {
          // Render group headers as non-clickable dividers
          if (option.isGroupHeader) {
            return (
              <div
                key={`header-${option.value}`}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground",
                  index > 0 && "mt-1 border-t border-border pt-2"
                )}
              >
                {option.label}
              </div>
            );
          }

          const isSelected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => handleSelect(option.value)}
              className={cn(
                "w-full flex items-center justify-between text-left text-sm transition-colors cursor-pointer",
                optionPadding,
                isSelected
                  ? "bg-primary/10 text-primary"
                  : "text-foreground hover:bg-secondary"
              )}
            >
              <span>{option.label}</span>
              {isSelected && <Check className="h-4 w-4 text-primary" />}
            </button>
          );
        })}
      </div>
    );

    // Portal to body to escape stacking contexts
    if (typeof document !== "undefined") {
      return createPortal(dropdown, document.body);
    }
    return null;
  };

  return (
    <div className={cn("w-full", className)} ref={containerRef}>
      {label && (
        <label
          htmlFor={selectId}
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          {label}
          {required && <span className="text-error ml-1">*</span>}
        </label>
      )}

      <div className="relative">
        {/* Trigger Button */}
        <button
          ref={buttonRef}
          type="button"
          id={selectId}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          className={cn(
            "w-full rounded-lg border border-input bg-card transition-colors duration-200",
            "text-left cursor-pointer inline-flex items-center justify-between",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-50",
            buttonPadding,
            error && "border-error focus:ring-error",
            isOpen && "ring-2 ring-ring ring-offset-2 ring-offset-background border-primary"
          )}
        >
          <span className={selectedOption ? "text-foreground" : "text-muted-foreground"}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              isOpen && "rotate-180"
            )}
          />
        </button>

        {/* Dropdown rendered via Portal */}
        {renderDropdown()}
      </div>

      {error && <p className="mt-1.5 text-sm text-error">{error}</p>}
      {helperText && !error && (
        <p className="mt-1.5 text-sm text-muted-foreground">{helperText}</p>
      )}
    </div>
  );
}

CustomSelect.displayName = "CustomSelect";

// ============================================================================
// Native Select (Original - for forms that need native behavior)
// ============================================================================

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, children, ...props }, ref) => {
    return (
      <div className="space-y-2">
        {label && (
          <label className="text-sm font-medium text-foreground">{label}</label>
        )}
        <div className="relative">
          <select
            className={cn(
              "flex h-10 w-full appearance-none rounded-lg border border-input bg-card px-3 py-2 pr-10 text-sm ring-offset-background transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              error && "border-error focus:ring-error",
              className
            )}
            ref={ref}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    );
  }
);
Select.displayName = "Select";

export { Select, CustomSelect };
