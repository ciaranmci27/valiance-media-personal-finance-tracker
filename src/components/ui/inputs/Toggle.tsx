'use client';

import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { labelSizeClass, type InputSize } from './_shared';

/** Glass switch with an optional visible label, supporting both labelled forms and icon rows. */
export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  error?: string;
  size?: InputSize;
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  {
    checked,
    onChange,
    disabled,
    label,
    description,
    error,
    size = 'default',
    className = '',
    ...props
  },
  ref,
) {
  const id = useId();
  const track = size === 'sm' ? 'h-5 w-9' : size === 'lg' ? 'h-7 w-[52px]' : 'h-6 w-11';
  const knob = size === 'lg' ? 'h-5 w-5' : 'h-4 w-4';
  const position = checked
    ? size === 'sm'
      ? 'translate-x-[18px]'
      : size === 'lg'
        ? 'translate-x-7'
        : 'translate-x-6'
    : size === 'sm'
      ? 'translate-x-0.5'
      : 'translate-x-1';
  return (
    <div className={`space-y-1.5 ${className}`}>
      <button
        {...props}
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        aria-describedby={
          [props['aria-describedby'], description && `${id}-description`, error && `${id}-error`]
            .filter(Boolean)
            .join(' ') || undefined
        }
        onClick={() => onChange(!checked)}
        className={`group inline-flex items-center gap-2.5 rounded-input ${labelSizeClass(size)} font-medium text-input-text focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none group-focus-visible:ring-2 group-focus-visible:ring-input-ring group-focus-visible:ring-offset-1 ${track} ${checked ? 'bg-input-accent' : 'bg-input-bg-active border border-input-border-hover'}`}
        >
          <span
            className={`${knob} ${position} rounded-full bg-input-accent-fg shadow-sm transition-transform motion-reduce:transition-none`}
          />
        </span>
        {label && <span>{label}</span>}
      </button>
      {description && (
        <p id={`${id}-description`} className="text-xs text-input-text-subtle">
          {description}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}
    </div>
  );
});
