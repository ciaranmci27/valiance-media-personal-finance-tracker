'use client';

import { forwardRef, useId } from 'react';
import { fieldChrome, labelSizeClass, type InputSize } from './_shared';

/** Native color selection for portal branding and appearance settings. */
export interface ColorInputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  ariaLabel?: string;
  description?: string;
  error?: string;
  disabled?: boolean;
  size?: InputSize;
  className?: string;
}

export const ColorInput = forwardRef<HTMLInputElement, ColorInputProps>(function ColorInput(
  {
    value,
    onChange,
    label,
    ariaLabel,
    description,
    error,
    disabled,
    size = 'default',
    className = '',
  },
  ref,
) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && (
        <label
          htmlFor={id}
          className={`block ${labelSizeClass(size)} font-medium text-input-text-label`}
        >
          {label}
        </label>
      )}
      {description && (
        <p id={`${id}-description`} className="text-xs text-input-text-subtle">
          {description}
        </p>
      )}
      <div
        className={`${fieldChrome(error, disabled)} ${size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'} p-1`}
      >
        <input
          ref={ref}
          id={id}
          type="color"
          value={value}
          disabled={disabled}
          aria-label={ariaLabel || (!label ? 'Custom color' : undefined)}
          aria-invalid={!!error || undefined}
          aria-describedby={
            [description && `${id}-description`, error && `${id}-error`]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={(event) => onChange(event.target.value)}
          className="block h-full w-full cursor-pointer border-0 bg-transparent p-0 outline-none disabled:cursor-not-allowed"
        />
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}
    </div>
  );
});
