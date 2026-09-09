'use client';
import { popupPosition, popupChrome, useInputPopup } from './_shared';
import { fieldChrome, fieldSize } from './_shared';

import { useState, useRef, useEffect, useCallback, useId, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { mergeRefs, labelSizeClass } from './_shared';

/** Accessible, token-based DateInput configuration. */
export interface DateInputProps {
  label?: string;
  description?: string;
  error?: string;
  placeholder?: string;
  defaultValue?: string;
  readOnly?: boolean;
  ariaLabel?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  title?: string;
  value?: string; // ISO date string: YYYY-MM-DD
  onChange?: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  size?: 'default' | 'sm' | 'lg';
  minDate?: string; // ISO date string
  maxDate?: string; // ISO date string
  clearable?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  inputClassName?: string;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parseDate(str: string | undefined): Date | null {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDisplay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function toFullLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
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

export const DateInput = forwardRef<HTMLButtonElement, DateInputProps>(function DateInput(
  {
    label,
    description,
    error,
    placeholder,
    value: controlledValue,
    defaultValue = '',
    readOnly = false,
    ariaLabel,
    'aria-label': nativeLabel,
    'aria-labelledby': labelledBy,
    title,
    onChange: onValueChange,
    onBlur,
    onFocus,
    disabled = false,
    size = 'default',
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
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const value = controlledValue ?? uncontrolledValue;
  const onChange = (next: string) => {
    setUncontrolledValue(next);
    onValueChange?.(next);
  };
  const parsedValue = parseDate(value);
  const parsedMin = parseDate(minDate);
  const parsedMax = parseDate(maxDate);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const initialYear = parsedValue?.getFullYear() ?? today.getFullYear();
  const initialMonth = parsedValue?.getMonth() ?? today.getMonth();

  const autoId = useId();
  const inputId = id || autoId;
  const errorId = error ? `${inputId}-error` : undefined;
  const descId = description ? `${inputId}-desc` : undefined;
  const describedBy = [descId, errorId].filter(Boolean).join(' ') || undefined;

  const [isOpen, setIsOpen] = useState(false);
  const [viewYear, setViewYear] = useState(initialYear);
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const [focusedDate, setFocusedDate] = useState<Date | null>(null);
  const [dropdownPos, setDropdownPos] = useState({
    top: 0,
    left: 0,
    width: 0,
    openAbove: false,
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { host: popupHost, prepare: preparePopup } = useInputPopup(isOpen, triggerRef, dropdownRef);
  const gridRef = useRef<HTMLDivElement>(null);

  const calendarHeight = size === 'sm' ? 300 : size === 'lg' ? 420 : 340;
  const calPad = size === 'sm' ? 'p-2' : size === 'lg' ? 'p-4' : 'p-3';
  const navIconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const monthText = size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm';
  const cellHeight = size === 'sm' ? 'h-8' : size === 'lg' ? 'h-12' : 'h-10';
  const cellText = size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm';

  const updatePosition = useCallback(() => {
    if (triggerRef.current) setDropdownPos(popupPosition(triggerRef.current, calendarHeight, 280));
  }, [calendarHeight]);

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
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
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isOpen, onBlur]);

  const openPicker = () => {
    if (disabled || readOnly) return;
    const target = parsedValue || today;
    preparePopup();
    setViewYear(target.getFullYear());
    setViewMonth(target.getMonth());
    setFocusedDate(target);
    updatePosition();
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen || !focusedDate || !gridRef.current) return;
    const dateStr = toIso(focusedDate);
    const btn = gridRef.current.querySelector(
      `[data-date="${dateStr}"]`,
    ) as HTMLButtonElement | null;
    btn?.focus();
  }, [isOpen, focusedDate, viewMonth, viewYear]);

  const isDateDisabled = (date: Date): boolean => {
    if (parsedMin && date < parsedMin) return true;
    if (parsedMax && date > parsedMax) return true;
    return false;
  };

  const handleSelect = (day: number) => {
    const date = new Date(viewYear, viewMonth, day);
    if (isDateDisabled(date)) return;
    onChange?.(toIso(date));
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange?.('');
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openPicker();
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

  const handleGridKeyDown = (e: React.KeyboardEvent, cellDate: Date) => {
    let nextDate: Date | null = null;

    switch (e.key) {
      case 'ArrowLeft':
        nextDate = addDays(cellDate, -1);
        break;
      case 'ArrowRight':
        nextDate = addDays(cellDate, 1);
        break;
      case 'ArrowUp':
        nextDate = addDays(cellDate, -7);
        break;
      case 'ArrowDown':
        nextDate = addDays(cellDate, 7);
        break;
      case 'PageUp':
        nextDate = new Date(cellDate.getFullYear(), cellDate.getMonth() - 1, cellDate.getDate());
        break;
      case 'PageDown':
        nextDate = new Date(cellDate.getFullYear(), cellDate.getMonth() + 1, cellDate.getDate());
        break;
      case 'Home':
        nextDate = new Date(cellDate.getFullYear(), cellDate.getMonth(), 1);
        break;
      case 'End':
        nextDate = new Date(
          cellDate.getFullYear(),
          cellDate.getMonth(),
          getDaysInMonth(cellDate.getFullYear(), cellDate.getMonth()),
        );
        break;
      case 'Enter':
      case ' ':
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

      if (nextDate.getMonth() !== viewMonth || nextDate.getFullYear() !== viewYear) {
        setViewMonth(nextDate.getMonth());
        setViewYear(nextDate.getFullYear());
      }
      setFocusedDate(nextDate);
    }
  };

  const displayLabel = parsedValue ? toDisplay(parsedValue) : placeholder || 'Select date...';

  const sizeClasses = `${fieldSize(size)} ${size === 'sm' ? 'px-2.5' : size === 'lg' ? 'px-3.5' : 'px-3'}`;
  const calIconSize = size === 'sm' ? 14 : size === 'lg' ? 20 : 16;
  const clearIconSize = size === 'sm' ? 14 : size === 'lg' ? 20 : 16;

  const showClear = clearable && value && !disabled && !readOnly;

  // Build calendar grid
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
    <div className={`space-y-1.5 ${className || ''}`}>
      {label && (
        <label
          id={`${inputId}-label`}
          htmlFor={inputId}
          className={`block ${labelSizeClass(size)} font-medium text-input-text-label`}
        >
          {label}
        </label>
      )}
      {description && (
        <p id={descId} className="text-xs text-input-text-subtle">
          {description}
        </p>
      )}

      {(name || required) && (
        <input
          className="sr-only"
          tabIndex={-1}
          aria-label={label || ariaLabel || nativeLabel || 'Date'}
          name={name}
          value={value || ''}
          required={required}
          readOnly={readOnly}
          disabled={disabled}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          onInvalid={() => triggerRef.current?.focus()}
        />
      )}

      <button
        ref={mergeRefs(triggerRef, forwardedRef)}
        id={inputId}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={isOpen ? `${inputId}-popup` : undefined}
        aria-required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-label={ariaLabel || nativeLabel}
        title={title}
        aria-labelledby={labelledBy || (label ? `${inputId}-label` : undefined)}
        onClick={() => {
          if (isOpen) setIsOpen(false);
          else openPicker();
        }}
        onKeyDown={readOnly ? undefined : handleTriggerKeyDown}
        onFocus={onFocus}
        onBlur={() => {
          if (!isOpen) onBlur?.();
        }}
        className={`w-full ${sizeClasses} outline-none flex items-center justify-between gap-2 text-left ${fieldChrome(error, disabled)} ${inputClassName || ''}`}
      >
        <span
          className={`truncate ${parsedValue ? 'text-input-text' : 'text-input-text-placeholder'}`}
        >
          {displayLabel}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {showClear && (
            <span
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange('');
                }
              }}
              onClick={handleClear}
              aria-label="Clear date"
              className="p-1 -m-0.5 rounded-input-sm hover:bg-input-bg-hover text-input-text-placeholder hover:text-input-text transition-colors duration-150"
            >
              <X size={clearIconSize} />
            </span>
          )}
          <Calendar size={calIconSize} className="text-input-text-placeholder" />
        </div>
      </button>

      {error && (
        <p id={errorId} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}

      {isOpen &&
        popupHost &&
        createPortal(
          <div
            id={`${inputId}-popup`}
            ref={dropdownRef}
            popover="manual"
            role="dialog"
            aria-label="Date picker"
            className={`${popupChrome} ${calPad}`}
            style={{
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              transform: dropdownPos.openAbove ? 'translateY(-100%)' : undefined,
            }}
          >
            {/* Month/Year navigation */}
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => navigateMonth(-1)}
                aria-label="Previous month"
                className="p-2 -m-1 rounded-input-sm hover:bg-input-bg-hover text-input-text-subtle transition-colors duration-150"
              >
                <ChevronLeft size={navIconSize} />
              </button>
              <span className={`${monthText} font-semibold text-input-text`}>
                {MONTHS[viewMonth]} {viewYear}
              </span>
              <button
                type="button"
                onClick={() => navigateMonth(1)}
                aria-label="Next month"
                className="p-2 -m-1 rounded-input-sm hover:bg-input-bg-hover text-input-text-subtle transition-colors duration-150"
              >
                <ChevronRight size={navIconSize} />
              </button>
            </div>

            {/* Day headers */}
            <div className="grid grid-cols-7 mb-1" role="row">
              {DAYS.map((d) => (
                <div
                  key={d}
                  role="columnheader"
                  aria-label={d}
                  className="text-center text-xs font-medium text-input-text-placeholder py-1"
                >
                  {d}
                </div>
              ))}
            </div>

            {/* Day cells */}
            <div ref={gridRef} className="grid grid-cols-7" role="grid">
              {cells.map((cell) => {
                const isSelected = parsedValue && isSameDay(cell.date, parsedValue);
                const isToday = isSameDay(cell.date, today);
                const cellDisabled = !cell.inMonth || isDateDisabled(cell.date);
                const isFocused = focusedDate && isSameDay(cell.date, focusedDate) && cell.inMonth;
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
                    aria-pressed={!!isSelected}
                    aria-current={isToday ? 'date' : undefined}
                    className={`relative ${cellHeight} w-full flex items-center justify-center ${cellText} rounded-input-sm outline-none transition-colors duration-150 ${
                      isSelected
                        ? 'bg-input-accent text-input-accent-fg font-medium'
                        : cellDisabled
                          ? 'text-input-text-disabled cursor-not-allowed'
                          : isToday
                            ? 'text-input-accent font-semibold hover:bg-input-accent-subtle'
                            : 'text-input-text hover:bg-input-bg-hover'
                    } focus-visible:ring-2 focus-visible:ring-input-ring focus-visible:ring-inset`}
                  >
                    {cell.day}
                    {isToday && !isSelected && (
                      <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-input-accent" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Today button */}
            <div className="mt-2 pt-2 border-t border-input-border-divider">
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
                className="w-full text-center text-xs text-input-accent hover:text-input-accent font-medium py-1 rounded-input-sm hover:bg-input-accent-subtle transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Today
              </button>
            </div>
          </div>,
          popupHost,
        )}
    </div>
  );
});

DateInput.displayName = 'DateInput';
