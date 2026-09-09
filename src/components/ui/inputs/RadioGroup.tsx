'use client';

import { forwardRef, useEffect, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { injectAnimations, labelSizeClass, type InputSize } from './_shared';

/** A native radio for a feature-owned option row. Wrap it in a label or pass aria-label. */
export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  size?: InputSize;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { size = 'default', className = '', ...props },
  ref,
) {
  useEffect(injectAnimations, []);
  const controlSize = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-5 w-5' : 'h-[18px] w-[18px]';
  return (
    <span className={`relative mt-0.5 inline-flex shrink-0 ${controlSize} ${className}`}>
      <input
        {...props}
        ref={ref}
        type="radio"
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none flex h-full w-full items-center justify-center rounded-full border border-input-border bg-input-bg peer-hover:border-input-border-hover peer-checked:border-input-accent peer-checked:bg-input-accent peer-focus-visible:ring-2 peer-focus-visible:ring-input-ring peer-focus-visible:ring-offset-1 peer-disabled:opacity-50 after:h-2 after:w-2 after:rounded-full after:bg-input-accent-fg after:opacity-0 peer-checked:after:opacity-100 motion-safe:peer-checked:after:animate-[ui-radio-pop_150ms_ease-out]"
      />
    </span>
  );
});

/** A labelled group with native arrow-key navigation and inline or stacked options. */
export interface RadioGroupProps<T extends string = string> {
  label?: string;
  description?: string;
  error?: string;
  ariaLabel?: string;
  name?: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; description?: ReactNode; disabled?: boolean }[];
  disabled?: boolean;
  required?: boolean;
  size?: InputSize;
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}

export function RadioGroup<T extends string>({
  label,
  description,
  error,
  ariaLabel,
  name,
  value,
  onChange,
  options,
  disabled,
  required,
  size = 'default',
  className = '',
  orientation = 'vertical',
}: RadioGroupProps<T>) {
  const id = useId();
  const describedBy =
    [description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(' ') ||
    undefined;
  return (
    <fieldset
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={`min-w-0 space-y-1.5 ${className}`}
    >
      {label && (
        <legend className={`${labelSizeClass(size)} font-medium text-input-text-label`}>
          {label}
        </legend>
      )}
      {description && (
        <p id={`${id}-description`} className="text-xs text-input-text-subtle">
          {description}
        </p>
      )}
      <div
        className={`flex gap-3 ${orientation === 'vertical' ? 'flex-col' : 'flex-wrap items-center'}`}
      >
        {options.map((option) => (
          <label
            key={option.value}
            className={`inline-flex cursor-pointer items-start gap-2.5 ${labelSizeClass(size)} text-input-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50`}
          >
            <Radio
              size={size}
              name={name || id}
              value={option.value}
              checked={value === option.value}
              disabled={disabled || option.disabled}
              required={required}
              onChange={() => onChange(option.value)}
            />
            <span>
              <span className="block font-medium">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block text-xs text-input-text-subtle">
                  {option.description}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
