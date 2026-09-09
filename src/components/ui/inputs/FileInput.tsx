'use client';

import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { fieldChrome, fieldSize, labelSizeClass, type InputSize } from './_shared';

/** Native file selection, including multiple uploads and camera capture, in the shared field anatomy. */
export interface FileInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  description?: string;
  error?: string;
  size?: InputSize;
}

export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(function FileInput(
  { label, description, error, size = 'default', id, className = '', ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id || autoId;
  const hidden = className.split(/\s+/).some((token) => token === 'hidden' || token === 'sr-only');
  const input = (
    <input
      {...props}
      ref={ref}
      id={inputId}
      type="file"
      aria-invalid={!!error || undefined}
      aria-describedby={
        [
          props['aria-describedby'],
          description && `${inputId}-description`,
          error && `${inputId}-error`,
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
      className={
        hidden
          ? className
          : `block min-w-0 w-full px-3 outline-none ${fieldChrome(error, props.disabled)} ${fieldSize(size)} file:mr-3 file:border-0 file:bg-transparent file:p-0 file:text-input-accent-subtle-fg file:font-medium disabled:cursor-not-allowed`
      }
    />
  );
  if (hidden) return input;
  return (
    <div className={`space-y-1.5 ${className}`}>
      {(label || description) && (
        <div className="flex items-center justify-between gap-2">
          {label ? (
            <label
              htmlFor={inputId}
              className={`block ${labelSizeClass(size)} font-medium text-input-text-label`}
            >
              {label}
            </label>
          ) : (
            <span />
          )}
          {description && (
            <p id={`${inputId}-description`} className="text-xs text-input-text-subtle">
              {description}
            </p>
          )}
        </div>
      )}
      {input}
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}
    </div>
  );
});
