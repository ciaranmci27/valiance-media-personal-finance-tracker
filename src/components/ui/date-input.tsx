"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================================
// Ref merging (local; admin has no _shared util)
// ============================================================================

function mergeRefs<T>(
  ...refs: Array<React.Ref<T> | undefined | null>
): React.RefCallback<T> {
  return (node) => {
    refs.forEach((ref) => {
      if (!ref) return;
      if (typeof ref === "function") ref(node);
      else (ref as { current: T | null }).current = node;
    });
  };
}

// ============================================================================
// Types + constants
// ============================================================================

export interface DateInputProps {
  label?: string;
  description?: string;
  error?: string;
  helperText?: string;
  placeholder?: string;
  /** ISO date string: YYYY-MM-DD */
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  size?: "default" | "sm";
  /** ISO date string */
  minDate?: string;
  /** ISO date string */
  maxDate?: string;
  clearable?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  inputClassName?: string;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ============================================================================
// Date helpers
// ============================================================================

function parseDate(str: string | undefined): Date | null {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toDisplay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toFullLabel(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ============================================================================
// Component
// ============================================================================

export const DateInput = React.forwardRef<HTMLButtonElement, DateInputProps>(
  function DateInput(
    {
      label,
      description,
      error,
      helperText,
      placeholder,
      value,
      onChange,
      onBlur,
      onFocus,
      disabled = false,
      size = "default",
      minDate,
      maxDate,
      clearable = false,
      required,
      name,
      id,
      className,
      inputClassName,
    },
    forwardedRef,
  ) {
    const parsedValue = parseDate(value);
    const parsedMin = parseDate(minDate);
    const parsedMax = parseDate(maxDate);

    const today = React.useMemo(() => {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      return t;
    }, []);

    const initialYear = parsedValue?.getFullYear() ?? today.getFullYear();
    const initialMonth = parsedValue?.getMonth() ?? today.getMonth();

    const autoId = React.useId();
    const inputId = id || autoId;
    const errorId = error ? `${inputId}-error` : undefined;
    const descId = description ? `${inputId}-desc` : undefined;
    const helperId = helperText && !error ? `${inputId}-helper` : undefined;
    const describedBy =
      [descId, errorId, helperId].filter(Boolean).join(" ") || undefined;

    const [isOpen, setIsOpen] = React.useState(false);
    const [viewMode, setViewMode] = React.useState<"days" | "years">("days");
    const [viewYear, setViewYear] = React.useState(initialYear);
    const [viewMonth, setViewMonth] = React.useState(initialMonth);
    const [focusedDate, setFocusedDate] = React.useState<Date | null>(null);
    const [dropdownPos, setDropdownPos] = React.useState({
      top: 0,
      left: 0,
      width: 0,
      openAbove: false,
    });

    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const dropdownRef = React.useRef<HTMLDivElement>(null);
    const gridRef = React.useRef<HTMLDivElement>(null);

    const calendarHeight = size === "sm" ? 300 : 340;

    const updatePosition = React.useCallback(() => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const openAbove =
        spaceBelow < calendarHeight + 8 && spaceAbove > spaceBelow;
      const calendarWidth = Math.max(rect.width, 280);
      const left = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - calendarWidth - 8),
      );
      setDropdownPos({
        top: openAbove ? rect.top - 4 : rect.bottom + 4,
        left,
        width: calendarWidth,
        openAbove,
      });
    }, [calendarHeight]);

    React.useEffect(() => {
      if (!isOpen) return;
      updatePosition();
      window.addEventListener("scroll", updatePosition, true);
      window.addEventListener("resize", updatePosition);
      return () => {
        window.removeEventListener("scroll", updatePosition, true);
        window.removeEventListener("resize", updatePosition);
      };
    }, [isOpen, updatePosition]);

    React.useEffect(() => {
      if (!isOpen) return;

      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (
          triggerRef.current &&
          !triggerRef.current.contains(target) &&
          dropdownRef.current &&
          !dropdownRef.current.contains(target)
        ) {
          setIsOpen(false);
          onBlur?.();
        }
      };

      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setIsOpen(false);
          triggerRef.current?.focus();
        }
      };

      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleEscape);
      };
    }, [isOpen, onBlur]);

    React.useEffect(() => {
      if (!isOpen) return;
      const target = parsedValue || today;
      setViewYear(target.getFullYear());
      setViewMonth(target.getMonth());
      setFocusedDate(target);
      setViewMode("days");
      // parsedValue intentionally left out: we only reseed when opening.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    React.useEffect(() => {
      if (!isOpen || !focusedDate || !gridRef.current) return;
      const dateStr = toIso(focusedDate);
      const btn = gridRef.current.querySelector(
        `[data-date="${dateStr}"]`,
      ) as HTMLButtonElement | null;
      btn?.focus();
    }, [isOpen, focusedDate, viewMonth, viewYear]);

    const isDateDisabled = React.useCallback(
      (date: Date): boolean => {
        if (parsedMin && date < parsedMin) return true;
        if (parsedMax && date > parsedMax) return true;
        return false;
      },
      [parsedMin, parsedMax],
    );

    const handleSelect = (day: number) => {
      const date = new Date(viewYear, viewMonth, day);
      if (isDateDisabled(date)) return;
      onChange?.(toIso(date));
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    const handleClear = (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange?.("");
    };

    const handleClearKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onChange?.("");
      }
    };

    const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
    };

    const navigateMonth = (direction: -1 | 1) => {
      const next = viewMonth + direction;
      if (next < 0) {
        setViewMonth(11);
        setViewYear(viewYear - 1);
      } else if (next > 11) {
        setViewMonth(0);
        setViewYear(viewYear + 1);
      } else {
        setViewMonth(next);
      }
    };

    // Years view shows 12 years per page centered on viewYear. Shifting by 12
    // makes the page-by-page navigation match the grid exactly.
    const navigateYearPage = (direction: -1 | 1) => {
      setViewYear(viewYear + direction * 12);
    };

    // Start of the 12-year block containing viewYear. We align to a floor so
    // each page shows a consistent set of years (e.g. 2016-2027 rather than
    // sliding with viewYear).
    const yearPageStart = Math.floor(viewYear / 12) * 12;
    const yearCells: number[] = [];
    for (let y = yearPageStart; y < yearPageStart + 12; y += 1) {
      yearCells.push(y);
    }
    const yearPageEnd = yearPageStart + 11;

    const handleYearSelect = (year: number) => {
      setViewYear(year);
      setViewMode("days");
    };

    const handleGridKeyDown = (e: React.KeyboardEvent, cellDate: Date) => {
      let nextDate: Date | null = null;

      switch (e.key) {
        case "ArrowLeft":
          nextDate = addDays(cellDate, -1);
          break;
        case "ArrowRight":
          nextDate = addDays(cellDate, 1);
          break;
        case "ArrowUp":
          nextDate = addDays(cellDate, -7);
          break;
        case "ArrowDown":
          nextDate = addDays(cellDate, 7);
          break;
        case "PageUp":
          nextDate = new Date(
            cellDate.getFullYear(),
            cellDate.getMonth() - 1,
            cellDate.getDate(),
          );
          break;
        case "PageDown":
          nextDate = new Date(
            cellDate.getFullYear(),
            cellDate.getMonth() + 1,
            cellDate.getDate(),
          );
          break;
        case "Home":
          nextDate = new Date(
            cellDate.getFullYear(),
            cellDate.getMonth(),
            1,
          );
          break;
        case "End":
          nextDate = new Date(
            cellDate.getFullYear(),
            cellDate.getMonth(),
            getDaysInMonth(cellDate.getFullYear(), cellDate.getMonth()),
          );
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (!isDateDisabled(cellDate)) {
            onChange?.(toIso(cellDate));
            setIsOpen(false);
            triggerRef.current?.focus();
          }
          return;
        default:
          return;
      }

      if (nextDate) {
        e.preventDefault();
        if (parsedMin && nextDate < parsedMin) nextDate = parsedMin;
        if (parsedMax && nextDate > parsedMax) nextDate = parsedMax;

        if (
          nextDate.getMonth() !== viewMonth ||
          nextDate.getFullYear() !== viewYear
        ) {
          setViewMonth(nextDate.getMonth());
          setViewYear(nextDate.getFullYear());
        }
        setFocusedDate(nextDate);
      }
    };

    const displayLabel = parsedValue
      ? toDisplay(parsedValue)
      : placeholder || "Select date...";

    // Admin parity: default size matches <Input> (h-10, px-3, py-2, text-sm)
    const triggerSizing =
      size === "sm" ? "h-8 px-2.5 text-xs" : "h-10 px-3 text-sm";
    const calIconSize = size === "sm" ? 14 : 16;
    const clearIconSize = size === "sm" ? 14 : 16;
    const navIconSize = size === "sm" ? 14 : 16;
    const monthText = size === "sm" ? "text-xs" : "text-sm";
    const cellHeight = size === "sm" ? "h-8" : "h-10";
    const cellText = size === "sm" ? "text-xs" : "text-sm";
    const calPad = size === "sm" ? "p-2" : "p-3";

    const showClear = clearable && value && !disabled;

    // Build calendar grid (6 rows × 7 days = 42 cells)
    const daysInMonth = getDaysInMonth(viewYear, viewMonth);
    const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
    const prevMonthDays = getDaysInMonth(
      viewMonth === 0 ? viewYear - 1 : viewYear,
      viewMonth === 0 ? 11 : viewMonth - 1,
    );

    const cells: Array<{ day: number; inMonth: boolean; date: Date }> = [];

    for (let i = firstDay - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      cells.push({ day: d, inMonth: false, date: new Date(y, m, d) });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, inMonth: true, date: new Date(viewYear, viewMonth, d) });
    }

    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ day: d, inMonth: false, date: new Date(y, m, d) });
    }

    return (
      <div className={cn("space-y-1.5", className)}>
        {label && (
          <label
            id={`${inputId}-label`}
            htmlFor={inputId}
            className="block text-sm font-medium text-foreground"
          >
            {label}
            {required && (
              <span className="text-error ml-1" aria-hidden="true">
                *
              </span>
            )}
          </label>
        )}
        {description && (
          <p id={descId} className="text-xs text-muted-foreground">
            {description}
          </p>
        )}

        {name && <input type="hidden" name={name} value={value || ""} />}

        <div className="relative">
          <button
            ref={mergeRefs(triggerRef, forwardedRef)}
            id={inputId}
            type="button"
            disabled={disabled}
            aria-expanded={isOpen}
            aria-haspopup="dialog"
            aria-required={required || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            aria-labelledby={label ? `${inputId}-label` : undefined}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            onKeyDown={handleTriggerKeyDown}
            onFocus={onFocus}
            onBlur={() => {
              if (!isOpen) onBlur?.();
            }}
            className={cn(
              "w-full rounded-lg border border-border bg-input text-foreground transition-colors",
              "flex items-center justify-between gap-2 text-left",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background focus:border-transparent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              triggerSizing,
              error && "border-error focus:ring-error",
              isOpen &&
                "ring-2 ring-ring ring-offset-2 ring-offset-background border-transparent",
              !disabled && "cursor-pointer",
              inputClassName,
            )}
          >
            <span
              className={cn(
                "truncate",
                parsedValue ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {displayLabel}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {showClear && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={handleClear}
                  onKeyDown={handleClearKeyDown}
                  aria-label="Clear date"
                  className="p-1 -m-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X size={clearIconSize} />
                </span>
              )}
              <Calendar
                size={calIconSize}
                className="text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          </button>
        </div>

        {error && (
          <p id={errorId} role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {helperText && !error && (
          <p id={helperId} className="text-sm text-muted-foreground">
            {helperText}
          </p>
        )}

        {isOpen &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              ref={dropdownRef}
              role="dialog"
              aria-label="Date picker"
              className={cn(
                "fixed z-[9999] bg-card border border-border rounded-lg shadow-lg",
                calPad,
              )}
              style={{
                top: dropdownPos.top,
                left: dropdownPos.left,
                width: dropdownPos.width,
                transform: dropdownPos.openAbove ? "translateY(-100%)" : undefined,
              }}
            >
              {/* Month/Year navigation */}
              <div className="flex items-center justify-between mb-3">
                <button
                  type="button"
                  onClick={() =>
                    viewMode === "days"
                      ? navigateMonth(-1)
                      : navigateYearPage(-1)
                  }
                  aria-label={
                    viewMode === "days"
                      ? "Previous month"
                      : "Previous 12 years"
                  }
                  className="p-2 -m-1 rounded hover:bg-secondary text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeft size={navIconSize} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setViewMode(viewMode === "days" ? "years" : "days")
                  }
                  aria-label={
                    viewMode === "days"
                      ? `${MONTHS[viewMonth]} ${viewYear}. Click to pick a year.`
                      : `${yearPageStart}-${yearPageEnd}. Click to return to day view.`
                  }
                  className={cn(
                    monthText,
                    "font-semibold text-foreground px-2 py-1 rounded hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {viewMode === "days"
                    ? `${MONTHS[viewMonth]} ${viewYear}`
                    : `${yearPageStart} – ${yearPageEnd}`}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    viewMode === "days"
                      ? navigateMonth(1)
                      : navigateYearPage(1)
                  }
                  aria-label={
                    viewMode === "days" ? "Next month" : "Next 12 years"
                  }
                  className="p-2 -m-1 rounded hover:bg-secondary text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight size={navIconSize} aria-hidden="true" />
                </button>
              </div>

              {viewMode === "years" ? (
                <div
                  className="grid grid-cols-3 gap-1"
                  role="grid"
                  aria-label="Year picker"
                >
                  {yearCells.map((year) => {
                    const isCurrentYear = year === today.getFullYear();
                    const isSelectedYear =
                      parsedValue && year === parsedValue.getFullYear();
                    // Out-of-bounds check: disable the year if it lies fully
                    // outside [minDate, maxDate].
                    const yearStart = new Date(year, 0, 1);
                    const yearEnd = new Date(year, 11, 31);
                    const outOfRange = Boolean(
                      (parsedMax && yearStart > parsedMax) ||
                        (parsedMin && yearEnd < parsedMin),
                    );
                    return (
                      <button
                        key={year}
                        type="button"
                        disabled={outOfRange}
                        onClick={() => handleYearSelect(year)}
                        aria-current={isCurrentYear ? "date" : undefined}
                        aria-selected={isSelectedYear || undefined}
                        className={cn(
                          "h-10 flex items-center justify-center rounded text-sm transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                          isSelectedYear
                            ? "bg-primary text-primary-foreground font-medium"
                            : outOfRange
                              ? "text-muted-foreground/40 cursor-not-allowed"
                              : isCurrentYear
                                ? "text-primary font-semibold hover:bg-primary/10"
                                : "text-foreground hover:bg-secondary",
                        )}
                      >
                        {year}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <>
              {/* Day headers */}
              <div className="grid grid-cols-7 mb-1" role="row">
                {DAYS.map((d) => (
                  <div
                    key={d}
                    role="columnheader"
                    aria-label={d}
                    className="text-center text-xs font-medium text-muted-foreground py-1"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Day cells */}
              <div ref={gridRef} className="grid grid-cols-7" role="grid">
                {cells.map((cell) => {
                  const isSelected =
                    parsedValue && isSameDay(cell.date, parsedValue);
                  const isToday = isSameDay(cell.date, today);
                  const cellDisabled =
                    !cell.inMonth || isDateDisabled(cell.date);
                  const isFocused =
                    focusedDate && isSameDay(cell.date, focusedDate) && cell.inMonth;
                  const dateStr = toIso(cell.date);

                  return (
                    <button
                      key={dateStr}
                      type="button"
                      data-date={dateStr}
                      disabled={cellDisabled}
                      tabIndex={isFocused ? 0 : -1}
                      onClick={() => cell.inMonth && handleSelect(cell.day)}
                      onKeyDown={(e) => handleGridKeyDown(e, cell.date)}
                      aria-label={toFullLabel(cell.date)}
                      aria-selected={isSelected || undefined}
                      aria-current={isToday ? "date" : undefined}
                      className={cn(
                        "relative w-full flex items-center justify-center rounded transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        cellHeight,
                        cellText,
                        isSelected
                          ? "bg-primary text-primary-foreground font-medium"
                          : cellDisabled
                            ? "text-muted-foreground/40 cursor-not-allowed"
                            : isToday
                              ? "text-primary font-semibold hover:bg-primary/10"
                              : "text-foreground hover:bg-secondary",
                      )}
                    >
                      {cell.day}
                      {isToday && !isSelected && (
                        <span
                          aria-hidden="true"
                          className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-primary"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Today button */}
              <div className="mt-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => {
                    if (!isDateDisabled(today)) {
                      onChange?.(toIso(today));
                      setIsOpen(false);
                      triggerRef.current?.focus();
                    }
                  }}
                  disabled={isDateDisabled(today)}
                  className="w-full text-center text-xs text-primary hover:text-primary font-medium py-1 rounded hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Today
                </button>
              </div>
                </>
              )}
            </div>,
            document.body,
          )}
      </div>
    );
  },
);

DateInput.displayName = "DateInput";
