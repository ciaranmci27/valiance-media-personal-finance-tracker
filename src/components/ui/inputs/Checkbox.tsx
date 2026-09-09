'use client';

import { forwardRef, useId, useRef, useEffect, type ReactNode } from 'react';
import { mergeRefs } from './_shared';
import { Check, Minus } from 'lucide-react';

/** Accessible, token-based Checkbox configuration. */
export interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  onClick?: React.MouseEventHandler<HTMLInputElement>;
  onChange?: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'default' | 'lg';
  name?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    checked = false,
    indeterminate = false,
    onClick,
    onChange,
    label,
    description,
    disabled = false,
    size = 'default',
    name,
    id,
    ariaLabel,
    className,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const autoId = useId();
  const inputId = id || autoId;
  const controlSize = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-5 w-5' : 'h-[18px] w-[18px]';
  const iconSize = size === 'sm' ? 11 : size === 'lg' ? 15 : 13;

  return (
    <label
      htmlFor={inputId}
      className={`inline-flex items-start gap-2.5 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className || ''}`}
    >
      <input
        ref={mergeRefs(ref, inputRef)}
        onClick={onClick}
        aria-checked={indeterminate ? 'mixed' : checked}
        id={inputId}
        name={name}
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`${controlSize} mt-0.5 flex flex-shrink-0 items-center justify-center rounded-[5px] border transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-input-ring peer-focus-visible:ring-offset-1 ${
          checked || indeterminate
            ? 'border-input-accent bg-input-accent text-input-accent-fg'
            : 'border-input-border bg-input-bg peer-hover:border-input-border-hover'
        }`}
      >
        {indeterminate ? (
          <Minus size={iconSize} strokeWidth={3} />
        ) : checked ? (
          <Check size={iconSize} strokeWidth={3} />
        ) : null}
      </span>
      {label || description ? (
        <span className="min-w-0 flex-1">
          {label ? (
            <span className="block text-sm font-medium text-input-text">{label}</span>
          ) : null}
          {description ? (
            <span className="mt-0.5 block text-xs text-input-text-subtle">{description}</span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});

Checkbox.displayName = 'Checkbox';
