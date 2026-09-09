'use client';
import { popupPosition, popupChrome, useInputPopup } from './_shared';
import { fieldChrome, fieldSize } from './_shared';

import { useState, useRef, useEffect, useCallback, useId, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { Clock, ChevronUp, ChevronDown } from 'lucide-react';
import { mergeRefs, labelSizeClass } from './_shared';

/** Accessible, token-based TimeInput configuration. */
export interface TimeInputProps {
  label?: string;
  description?: string;
  error?: string;
  placeholder?: string;
  value?: string; // 24h format: "HH:MM"
  onChange?: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  size?: 'default' | 'sm' | 'lg';
  use24Hour?: boolean;
  minuteStep?: number;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  inputClassName?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parseTime(str: string | undefined): { hours: number; minutes: number } | null {
  if (!str) return null;
  const [h, m] = str.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return { hours: h, minutes: m };
}

function formatDisplay(hours: number, minutes: number, use24Hour: boolean): string {
  if (use24Hour) return `${pad(hours)}:${pad(minutes)}`;
  const period = hours >= 12 ? 'PM' : 'AM';
  const display12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${display12}:${pad(minutes)} ${period}`;
}

export const TimeInput = forwardRef<HTMLButtonElement, TimeInputProps>(function TimeInput(
  {
    label,
    description,
    error,
    placeholder,
    value,
    onChange,
    onBlur,
    onFocus,
    disabled = false,
    size = 'default',
    use24Hour = false,
    minuteStep = 1,
    required,
    name,
    id,
    className,
    inputClassName,
  },
  forwardedRef,
) {
  const parsed = parseTime(value);
  const autoId = useId();
  const inputId = id || autoId;
  const errorId = error ? `${inputId}-error` : undefined;
  const descId = description ? `${inputId}-desc` : undefined;
  const describedBy = [descId, errorId].filter(Boolean).join(' ') || undefined;

  const [isOpen, setIsOpen] = useState(false);
  const [editHours, setEditHours] = useState(parsed?.hours ?? 12);
  const [editMinutes, setEditMinutes] = useState(parsed?.minutes ?? 0);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0, openAbove: false });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { host: popupHost, prepare: preparePopup } = useInputPopup(isOpen, triggerRef, dropdownRef);

  const updatePosition = useCallback(() => {
    if (triggerRef.current) setDropdownPos(popupPosition(triggerRef.current, 200, 220));
  }, []);

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
    preparePopup();
    setEditHours(parsed?.hours ?? 12);
    setEditMinutes(parsed?.minutes ?? 0);
    updatePosition();
    setIsOpen(true);
  };

  // Mirror editHours/editMinutes in a ref so repeated calls from the
  // hold-to-repeat loop (see SpinnerColumn) always see the freshest values
  // without waiting for React re-renders to propagate new closures.
  const stateRef = useRef({ h: editHours, m: editMinutes });
  useEffect(() => {
    stateRef.current = { h: editHours, m: editMinutes };
  }, [editHours, editMinutes]);

  const emitChange = (h: number, m: number) => {
    onChange?.(`${pad(h)}:${pad(m)}`);
  };

  const adjustHours = (delta: number) => {
    const curr = stateRef.current;
    const next = (curr.h + delta + 24) % 24;
    stateRef.current = { h: next, m: curr.m };
    setEditHours(next);
    emitChange(next, curr.m);
  };

  // Minutes wrap independently of hours: going past 59 loops back to 0
  // (and past 0 loops to 59) without touching the hour field. Users who
  // want to change the hour use the hour column directly.
  const adjustMinutes = (delta: number) => {
    const curr = stateRef.current;
    const next = (((curr.m + delta) % 60) + 60) % 60;
    stateRef.current = { h: curr.h, m: next };
    setEditMinutes(next);
    emitChange(curr.h, next);
  };

  const togglePeriod = () => {
    const next = editHours >= 12 ? editHours - 12 : editHours + 12;
    setEditHours(next);
    emitChange(next, editMinutes);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openPicker();
    }
  };

  const displayLabel = parsed
    ? formatDisplay(parsed.hours, parsed.minutes, use24Hour)
    : placeholder || 'Select time...';

  const sizeClasses = `${fieldSize(size)} ${size === 'sm' ? 'px-2.5' : size === 'lg' ? 'px-3.5' : 'px-3'}`;
  const clockSize = size === 'sm' ? 14 : size === 'lg' ? 20 : 16;
  const colonText = size === 'sm' ? 'text-lg' : size === 'lg' ? 'text-2xl' : 'text-xl';
  const periodClass =
    size === 'sm'
      ? 'px-2 py-1.5 text-xs'
      : size === 'lg'
        ? 'px-4 py-2.5 text-base'
        : 'px-3 py-2 text-sm';
  const presetClass =
    size === 'sm'
      ? 'px-1.5 py-0.5 text-xs'
      : size === 'lg'
        ? 'px-2.5 py-1.5 text-sm'
        : 'px-2 py-1 text-xs';
  const pickerPad = size === 'sm' ? 'p-3' : size === 'lg' ? 'p-5' : 'p-4';

  const display12Hour = editHours === 0 ? 12 : editHours > 12 ? editHours - 12 : editHours;
  const displayHour = use24Hour ? pad(editHours) : String(display12Hour);
  const period = editHours >= 12 ? 'PM' : 'AM';

  return (
    <div className={`space-y-1.5 ${className || ''}`}>
      {label && (
        <label
          id={`${inputId}-label`}
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

      {name && <input type="hidden" name={name} value={value || ''} />}

      <button
        ref={mergeRefs(triggerRef, forwardedRef)}
        id={inputId}
        type="button"
        disabled={disabled}
        aria-expanded={isOpen}
        role="combobox"
        aria-haspopup="dialog"
        aria-controls={isOpen ? `${inputId}-popup` : undefined}
        aria-required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-labelledby={label ? `${inputId}-label` : undefined}
        onClick={() => (isOpen ? setIsOpen(false) : openPicker())}
        onKeyDown={handleTriggerKeyDown}
        onFocus={onFocus}
        onBlur={() => {
          if (!isOpen) onBlur?.();
        }}
        className={`w-full ${sizeClasses} outline-none flex items-center justify-between gap-2 text-left ${fieldChrome(error, disabled)} ${inputClassName || ''}`}
      >
        <span className={`truncate ${parsed ? 'text-input-text' : 'text-input-text-placeholder'}`}>
          {displayLabel}
        </span>
        <Clock size={clockSize} className="flex-shrink-0 text-input-text-placeholder" />
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
            aria-label="Time picker"
            className={`${popupChrome} ${pickerPad}`}
            style={{
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              transform: dropdownPos.openAbove ? 'translateY(-100%)' : undefined,
            }}
          >
            <div className="flex items-center justify-center gap-1">
              <SpinnerColumn
                value={displayHour}
                onIncrement={() => adjustHours(1)}
                onDecrement={() => adjustHours(-1)}
                ariaLabel="Hours"
                size={size}
              />

              <span
                className={`${colonText} font-semibold text-input-text-placeholder px-0.5 select-none`}
              >
                :
              </span>

              <SpinnerColumn
                value={pad(editMinutes)}
                onIncrement={() => adjustMinutes(minuteStep)}
                onDecrement={() => adjustMinutes(-minuteStep)}
                ariaLabel="Minutes"
                size={size}
              />

              {!use24Hour && (
                <button
                  type="button"
                  onClick={togglePeriod}
                  className={`ml-2 ${periodClass} font-semibold rounded-input-sm bg-input-bg-hover hover:bg-input-bg-active text-input-text transition-colors duration-150 select-none`}
                  aria-label={`Toggle AM/PM, currently ${period}`}
                >
                  {period}
                </button>
              )}
            </div>

            <div className="flex gap-1.5 mt-3 pt-3 border-t border-input-border-divider justify-center flex-wrap">
              {(use24Hour
                ? ['09:00', '12:00', '15:00', '18:00']
                : ['9:00 AM', '12:00 PM', '3:00 PM', '6:00 PM']
              ).map((preset) => {
                const [hStr, rest] = preset.split(':');
                const isPM = preset.includes('PM');
                let h = parseInt(hStr);
                if (!use24Hour) {
                  if (isPM && h !== 12) h += 12;
                  if (!isPM && h === 12) h = 0;
                }
                const m = parseInt(rest);
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setEditHours(h);
                      setEditMinutes(m);
                      emitChange(h, m);
                    }}
                    className={`${presetClass} rounded-input-sm bg-input-bg-hover hover:bg-input-accent-subtle text-input-text-subtle hover:text-input-accent-subtle-fg transition-colors duration-150`}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </div>,
          popupHost,
        )}
    </div>
  );
});

TimeInput.displayName = 'TimeInput';

// Internal spinner column

function SpinnerColumn({
  value,
  onIncrement,
  onDecrement,
  ariaLabel,
  size = 'default',
}: {
  value: string;
  onIncrement: () => void;
  onDecrement: () => void;
  ariaLabel: string;
  size?: 'default' | 'sm' | 'lg';
}) {
  // Latest-handler refs so the recursive hold loop always invokes the
  // freshest closure after each parent re-render between ticks.
  const incRef = useRef(onIncrement);
  const decRef = useRef(onDecrement);
  useEffect(() => {
    incRef.current = onIncrement;
  });
  useEffect(() => {
    decRef.current = onDecrement;
  });

  // Hold-to-repeat timer. Single chained setTimeout so we can shrink the
  // delay between ticks for acceleration.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  // Any pointerup/cancel anywhere stops the hold , covers the case where
  // the user drags off the button before releasing.
  useEffect(() => {
    const stop = () => clearHold();
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [clearHold]);

  // Cleanup on unmount.
  useEffect(() => () => clearHold(), [clearHold]);

  const startHold = (dir: 'inc' | 'dec') => {
    clearHold();
    const fire = () => (dir === 'inc' ? incRef.current() : decRef.current());
    fire(); // immediate tick on press
    // Wait ~350ms before starting rapid-fire so a quick click doesn't double-fire.
    holdTimerRef.current = setTimeout(() => {
      let delay = 110;
      const tick = () => {
        fire();
        delay = Math.max(25, delay - 6); // accelerate, floor at 25ms
        holdTimerRef.current = setTimeout(tick, delay);
      };
      tick();
    }, 350);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onIncrement();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onDecrement();
    }
  };

  const btnPad = size === 'sm' ? 'p-1.5' : size === 'lg' ? 'p-2.5' : 'p-2';
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const valueClass =
    size === 'sm' ? 'w-10 text-lg' : size === 'lg' ? 'w-14 text-2xl' : 'w-12 text-xl';

  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          startHold('inc');
        }}
        aria-label={`Increase ${ariaLabel}`}
        className={`${btnPad} rounded-input-sm hover:bg-input-bg-hover text-input-text-placeholder hover:text-input-text transition-colors duration-150`}
      >
        <ChevronUp size={iconSize} />
      </button>
      <div
        role="spinbutton"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuenow={parseInt(value)}
        onKeyDown={handleKeyDown}
        className={`${valueClass} text-center font-semibold text-input-text py-1 rounded-input-sm bg-input-bg-hover select-none outline-none focus-visible:ring-2 focus-visible:ring-input-ring`}
      >
        {value}
      </div>
      <button
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          startHold('dec');
        }}
        aria-label={`Decrease ${ariaLabel}`}
        className={`${btnPad} rounded-input-sm hover:bg-input-bg-hover text-input-text-placeholder hover:text-input-text transition-colors duration-150`}
      >
        <ChevronDown size={iconSize} />
      </button>
    </div>
  );
}
