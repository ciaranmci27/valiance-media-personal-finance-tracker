'use client';
import { fieldChrome, fieldSize } from './_shared';

import { useRef, useId, forwardRef } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { mergeRefs, labelSizeClass } from './_shared';

/** Accessible, token-based TextInput configuration. */
export interface TextInputProps
  extends Pick<
    React.InputHTMLAttributes<HTMLInputElement>,
    | 'aria-label'
    | 'aria-labelledby'
    | 'aria-describedby'
    | 'defaultValue'
    | 'inputMode'
    | 'onPaste'
    | 'title'
    | 'onClick'
    | 'form'
    | 'style'
    | 'role'
    | 'aria-expanded'
    | 'aria-controls'
    | 'aria-autocomplete'
    | 'aria-activedescendant'
    | 'spellCheck'
    | 'min'
    | 'max'
  > {
  label?: string;
  description?: string;
  error?: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  size?: 'default' | 'sm' | 'lg';
  type?: 'text' | 'email' | 'password' | 'url' | 'tel' | 'search' | 'month';
  leftIcon?: LucideIcon;
  rightIcon?: LucideIcon;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  clearable?: boolean;
  name?: string;
  id?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  className?: string;
  inputClassName?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    label,
    description,
    error,
    placeholder,
    value,
    onChange,
    onBlur,
    onFocus,
    onKeyDown,
    disabled = false,
    size = 'default',
    type = 'text',
    leftIcon: LeftIcon,
    rightIcon: RightIcon,
    prefix,
    suffix,
    clearable = false,
    name,
    id,
    autoComplete,
    autoFocus,
    readOnly,
    required,
    maxLength,
    minLength,
    pattern,
    className,
    inputClassName,
    ...nativeProps
  },
  forwardedRef,
) {
  const internalRef = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const inputId = id || autoId;
  const errorId = error ? `${inputId}-error` : undefined;
  const descId = description ? `${inputId}-desc` : undefined;
  const describedBy = [descId, errorId].filter(Boolean).join(' ') || undefined;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange?.(e.target.value);
  };

  const handleClear = () => {
    onChange?.('');
    internalRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && clearable && value) {
      e.preventDefault();
      handleClear();
    }
    onKeyDown?.(e);
  };

  // Padding is 1px lighter than the button equivalent so that, once the input's
  // 1px border is added, the total height matches the borderless Button
  // (sm 28px / default 36px / lg 44px). Keeps inputs and adjacent buttons aligned.
  const sizeClasses = fieldSize(size);

  const iconSizeClasses = size === 'sm' ? 'h-3.5 w-3.5' : size === 'lg' ? 'h-5 w-5' : 'h-4 w-4';

  const showClear = clearable && value && !disabled && !readOnly;

  // Flex-based wrapper: border, ring, bg all live on the wrapper
  const wrapperPx = size === 'sm' ? 'px-2.5' : size === 'lg' ? 'px-3.5' : 'px-3';

  return (
    <div className={`space-y-1.5 ${className || ''}`}>
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
            <p id={descId} className="text-xs text-input-text-subtle flex-shrink-0 mb-0">
              {description}
            </p>
          )}
        </div>
      )}
      <div
        className={`flex items-center gap-1.5 ${wrapperPx} outline-none ${fieldChrome(error, disabled)} ${
          readOnly ? 'bg-input-bg-disabled cursor-default' : ''
        } ${inputClassName || ''}`}
      >
        {LeftIcon && (
          <LeftIcon className={`${iconSizeClasses} text-input-text-placeholder flex-shrink-0`} />
        )}
        {prefix != null && (
          <span
            className={`${size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm'} text-input-text-subtle flex-shrink-0 select-none`}
          >
            {prefix}
          </span>
        )}
        <input
          {...nativeProps}
          ref={mergeRefs(internalRef, forwardedRef)}
          id={inputId}
          name={name}
          type={type}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
          onFocus={onFocus}
          disabled={disabled}
          readOnly={readOnly}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          maxLength={maxLength}
          minLength={minLength}
          pattern={pattern}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [nativeProps['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined
          }
          className={`flex-1 min-w-0 ${sizeClasses} bg-transparent outline-none text-input-text placeholder:text-input-text-placeholder`}
        />
        {suffix != null && (
          <span
            className={`${size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm'} text-input-text-subtle flex-shrink-0 select-none`}
          >
            {suffix}
          </span>
        )}
        {showClear && (
          <button
            type="button"
            onClick={handleClear}
            tabIndex={-1}
            aria-label="Clear input"
            className="p-1 -m-0.5 rounded-input-sm hover:bg-input-bg-hover text-input-text-placeholder hover:text-input-text transition-colors duration-150 flex-shrink-0"
          >
            <X className={iconSizeClasses} />
          </button>
        )}
        {RightIcon && !showClear && (
          <RightIcon className={`${iconSizeClasses} text-input-text-placeholder flex-shrink-0`} />
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}
    </div>
  );
});

TextInput.displayName = 'TextInput';
