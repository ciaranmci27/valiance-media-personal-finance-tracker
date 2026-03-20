"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IncomeType, TaxClassification } from "@/types/database";

interface IncomeTypePickerProps {
  incomeType: IncomeType | null;
  taxClassification: TaxClassification | null;
  onChange: (type: IncomeType) => void;
  /** Portal target for rendering inside dialogs (body has pointer-events: none in modals) */
  portalContainer?: React.RefObject<HTMLElement | null>;
}

interface IncomeTypeOption {
  value: IncomeType;
  label: string;
  description: string;
  taxNote: string;
}

function getOptions(): IncomeTypeOption[] {
  return [
    {
      value: "w2",
      label: "W-2",
      description: "Wages & salary",
      taxNote: "Subject to employee FICA",
    },
    {
      value: "k1",
      label: "K-1",
      description: "Pass-through distributions",
      taxNote: "Toggle SE for active income",
    },
    {
      value: "1099",
      label: "1099",
      description: "Non-employment income",
      taxNote: "May be subject to SE tax",
    },
  ];
}

const BADGE_STYLES: Record<IncomeType, string> = {
  "1099": "bg-primary/15 text-primary border-primary/25",
  w2: "bg-muted text-muted-foreground border-border",
  k1: "bg-copper/15 text-copper border-copper/25",
};

const BADGE_LABELS: Record<IncomeType, string> = {
  "1099": "1099",
  w2: "W-2",
  k1: "K-1",
};

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

export function IncomeTypePicker({
  incomeType,
  taxClassification,
  onChange,
  portalContainer,
}: IncomeTypePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [position, setPosition] = React.useState<DropdownPosition | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const options = getOptions();

  // Position calculation
  const updatePosition = React.useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownWidth = 280;

    const container = portalContainer?.current;
    if (container) {
      // Portal is inside a dialog (which has transforms), so position relative to the container
      const containerRect = container.getBoundingClientRect();
      let left = rect.right - containerRect.left - dropdownWidth;
      if (left < 0) left = 0;
      setPosition({
        top: rect.bottom - containerRect.top + 4,
        left,
        width: dropdownWidth,
      });
    } else {
      // Default: portal to document.body with scroll offsets
      let left = rect.right + window.scrollX - dropdownWidth;
      if (left < 8) left = 8;
      setPosition({
        top: rect.bottom + window.scrollY + 4,
        left,
        width: dropdownWidth,
      });
    }
  }, [portalContainer]);

  React.useLayoutEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, updatePosition]);

  // Reposition on scroll/resize
  React.useEffect(() => {
    if (!isOpen) return;
    const handler = () => updatePosition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [isOpen, updatePosition]);

  // Click outside to close
  React.useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  // Escape to close
  React.useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen]);

  const handleSelect = (value: IncomeType) => {
    onChange(value);
    setIsOpen(false);
  };

  const renderDropdown = () => {
    if (!isOpen || !position) return null;

    const dropdown = (
      <div
        ref={dropdownRef}
        style={{
          position: "absolute",
          top: position.top,
          left: position.left,
          width: position.width,
          zIndex: 99999,
        }}
        className="py-1 border border-border rounded-lg shadow-lg bg-card"
      >
        {options.map((opt) => {
          const isSelected = opt.value === incomeType;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              className={cn(
                "w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer",
                isSelected
                  ? "bg-primary/10"
                  : "hover:bg-secondary"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border"
                )}
              >
                {isSelected && <Check className="h-2.5 w-2.5" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border",
                      BADGE_STYLES[opt.value]
                    )}
                  >
                    {opt.label}
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {opt.description}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {opt.taxNote}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    );

    if (typeof document !== "undefined") {
      const target = portalContainer?.current ?? document.body;
      return createPortal(dropdown, target);
    }
    return null;
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "shrink-0 h-8 inline-flex items-center gap-0.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider rounded cursor-pointer transition-colors border",
          incomeType
            ? BADGE_STYLES[incomeType]
            : "bg-amber-500/15 text-amber-400 border-amber-400/50 animate-pulse"
        )}
      >
        {incomeType ? BADGE_LABELS[incomeType] : "Select"}
        <ChevronDown
          className={cn(
            "h-2.5 w-2.5 transition-transform",
            isOpen && "rotate-180"
          )}
        />
      </button>
      {renderDropdown()}
    </>
  );
}
