"use client";

import * as React from "react";
import { Input, type InputProps } from "./input";

/**
 * Formats a number string with thousands separators (commas).
 * Preserves decimal input in progress (e.g. "1,234." or "1,234.5").
 */
function formatWithCommas(raw: string): string {
  if (!raw) return "";

  // Split on decimal point
  const parts = raw.split(".");
  const intPart = parts[0].replace(/,/g, "");

  // Handle negative sign
  const isNegative = intPart.startsWith("-");
  const digits = isNegative ? intPart.slice(1) : intPart;

  // Add commas to integer part
  const formatted = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const withSign = isNegative ? `-${formatted}` : formatted;

  // Re-attach decimal part (preserve trailing dot and partial decimals)
  if (parts.length > 1) {
    return `${withSign}.${parts[1]}`;
  }

  // Preserve trailing dot if user just typed it
  if (raw.endsWith(".")) {
    return `${withSign}.`;
  }

  return withSign;
}

/**
 * Strips commas from a formatted string and returns the raw number string.
 */
function stripCommas(formatted: string): string {
  return formatted.replace(/,/g, "");
}

interface NumberInputProps extends Omit<InputProps, "type" | "value" | "onChange" | "min" | "max"> {
  value: number | string;
  onChange: (e: { target: { value: string } }) => void;
  /** Set to true for integer-only fields (dependents, counts) */
  integer?: boolean;
  /** Minimum allowed value */
  min?: number;
  /** Maximum allowed value */
  max?: number;
  /** Skip thousands-separator commas. Use for years, phone numbers, ZIP codes,
   *  and any other identifier-style numeric that shouldn't be grouped. */
  noCommas?: boolean;
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onChange, integer, min, max, noCommas, onKeyDown, ...props }, ref) => {
    const format = React.useCallback(
      (s: string) => (noCommas ? s : formatWithCommas(s)),
      [noCommas],
    );
    // Track the display string separately so we can preserve user input like trailing dots
    const [display, setDisplay] = React.useState(() => {
      const num = typeof value === "string" ? value : value ? String(value) : "";
      return format(num);
    });

    // Sync display when value changes externally (e.g. loading data). Skip
    // the sync when the incoming prop is numerically equivalent to what the
    // user has already typed; otherwise mid-edit states like ".", "0.", "0.0"
    // get wiped because the parent's round-tripped value (e.g. 0.03 or "")
    // stringifies differently than the raw input. This is what breaks typing
    // ".03" or leaving a trailing dot while entering a decimal.
    const prevValueRef = React.useRef(value);
    React.useEffect(() => {
      if (value === prevValueRef.current) return;
      prevValueRef.current = value;

      const incomingStr =
        typeof value === "string" ? value : value ? String(value) : "";
      const incomingNum = parseFloat(incomingStr);
      const currentNum = parseFloat(stripCommas(display));
      const sameNumeric =
        (Number.isNaN(incomingNum) && Number.isNaN(currentNum)) ||
        incomingNum === currentNum;
      if (sameNumeric) return;

      setDisplay(format(incomingStr));
    }, [value, display]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = stripCommas(e.target.value);

      // Allow empty, negative sign, or valid number patterns
      if (raw === "" || raw === "-") {
        setDisplay(raw);
        onChange({ target: { value: raw } });
        return;
      }

      // Validate the raw input is a valid number pattern
      const pattern = integer ? /^-?\d*$/ : /^-?\d*\.?\d*$/;
      if (!pattern.test(raw)) return;

      // Clamp to min/max if specified
      if (raw !== "" && raw !== "-") {
        const num = parseFloat(raw);
        if (!isNaN(num)) {
          if (max != null && num > max) {
            const clamped = String(max);
            setDisplay(format(clamped));
            onChange({ target: { value: clamped } });
            return;
          }
          if (min != null && num < min) {
            const clamped = String(min);
            setDisplay(format(clamped));
            onChange({ target: { value: clamped } });
            return;
          }
        }
      }

      setDisplay(format(raw));
      onChange({ target: { value: raw } });
    };

    // Allow arrow keys to increment/decrement like a native number input
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const raw = stripCommas(display);
        const current = parseFloat(raw) || 0;
        const step = integer ? 1 : (e.shiftKey ? 10 : 1);
        let next = e.key === "ArrowUp" ? current + step : current - step;
        if (max != null && next > max) next = max;
        if (min != null && next < min) next = min;
        const nextStr = integer ? String(next) : String(Math.round(next * 100) / 100);
        setDisplay(format(nextStr));
        onChange({ target: { value: nextStr } });
      }
      onKeyDown?.(e);
    };

    return (
      <Input
        ref={ref}
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        value={display}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  }
);
NumberInput.displayName = "NumberInput";

export { NumberInput };
