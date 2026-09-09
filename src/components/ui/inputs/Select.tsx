'use client';
import { popupPosition, popupChrome, useInputPopup } from './_shared';
import { fieldChrome, fieldSize } from './_shared';

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  forwardRef,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { mergeRefs, labelSizeClass } from './_shared';
import { TextInput } from './TextInput';
export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  group?: string;
  detail?: ReactNode;
  keywords?: string;
  disabled?: boolean;
  isGroupHeader?: boolean;
}
/** Accessible, token-based Select configuration. */
export interface SelectProps {
  label?: string;
  visibleLabel?: string;
  ariaLabel?: string;
  value?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
  searchable?: boolean;
  placeholder?: string;
  emptyText?: string;
  helperText?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  triggerId?: string;
  size?: 'default' | 'sm' | 'lg';
  description?: string;
  className?: string;
  triggerClassName?: string;
  compact?: boolean;
  children?: ReactNode;
  showChevron?: boolean;
}
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    label,
    visibleLabel,
    ariaLabel,
    value,
    onChange,
    options,
    searchable,
    placeholder = 'Select...',
    emptyText = 'No matching options.',
    helperText,
    description,
    error,
    disabled,
    required,
    name,
    id,
    triggerId,
    size = 'default',
    className = '',
    triggerClassName,
    compact,
    children,
    showChevron = true,
  },
  forwardedRef,
) {
  const autoId = useId(),
    inputId = id || triggerId || autoId,
    listId = `${inputId}-list`;
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 300,
    openAbove: false,
  });
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);

  const { host: popupHost, prepare: preparePopup } = useInputPopup(open, trigger, popup);
  const selected = options.find((option) => !option.isGroupHeader && option.value === value);
  const fieldLabel = visibleLabel ?? (searchable ? undefined : label),
    accessibleLabel = ariaLabel || label || visibleLabel;
  const normalized: SelectOption[] = [];
  let group: string | undefined;
  for (const option of options) {
    if (option.isGroupHeader) group = option.label;
    else normalized.push({ ...option, group: option.group ?? group });
  }
  const ordered = [...new Set(normalized.map((option) => option.group))].flatMap((group) =>
    normalized.filter((option) => option.group === group),
  );
  const needle = query.trim().toLocaleLowerCase();
  const matches = ordered.filter(
    (option) =>
      !needle ||
      `${option.label} ${option.group || ''} ${option.keywords || ''} ${typeof option.detail === 'string' ? option.detail : ''}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  const groups = [...new Set(matches.map((option) => option.group))];
  const filtered = groups.flatMap((group) => matches.filter((option) => option.group === group));
  const available = filtered.filter((option) => !option.disabled),
    activeOption = available[active];
  const help = description || helperText;
  const describedBy =
    [help && `${inputId}-help`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined;
  const updatePosition = useCallback(() => {
    if (trigger.current) setPosition(popupPosition(trigger.current, 320, 220));
  }, []);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (option: SelectOption) => {
    if (!option.disabled) {
      onChange?.(option.value);
      close();
    }
  };
  const show = () => {
    preparePopup();
    if (disabled) return;
    setQuery('');
    setActive(
      Math.max(
        0,
        ordered.filter((option) => !option.disabled).findIndex((option) => option.value === value),
      ),
    );
    updatePosition();
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    (search.current || popup.current?.querySelector<HTMLElement>('[role="listbox"]'))?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, popupHost, updatePosition]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      setOpen(false);
      trigger.current?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (searchable && (event.key === 'Home' || event.key === 'End')) return;
      event.preventDefault();
      setActive((index) =>
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? Math.max(0, available.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) %
              Math.max(1, available.length),
      );
    } else if (event.key === 'Enter' || (!searchable && event.key === ' ')) {
      event.preventDefault();
      if (activeOption) choose(activeOption);
    } else if (!searchable && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const index = available.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
      );
      if (index >= 0) setActive(index);
    }
  };
  return (
    <div className={`space-y-1.5 ${className}`}>
      {fieldLabel && (
        <label
          htmlFor={inputId}
          className={`${labelSizeClass(size)} block font-medium text-input-text-label`}
        >
          {fieldLabel}
          {required && <span aria-hidden="true"> *</span>}
        </label>
      )}
      {(name || required) && (
        <input
          className="sr-only"
          tabIndex={-1}
          aria-label={accessibleLabel}
          name={name}
          value={value || ''}
          required={required}
          disabled={disabled}
          onChange={() => {}}
          onFocus={() => trigger.current?.focus()}
          onInvalid={() => trigger.current?.focus()}
        />
      )}
      <button
        ref={mergeRefs(trigger, forwardedRef)}
        id={inputId}
        type="button"
        role="combobox"
        aria-label={accessibleLabel}
        aria-haspopup="listbox"
        aria-required={required}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        aria-invalid={!!error || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
        className={`w-full flex items-center justify-between gap-2 text-left rounded-input transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-ring disabled:opacity-50 disabled:cursor-not-allowed ${triggerClassName || (compact ? 'px-2 py-1 text-sm hover:bg-input-bg-hover' : `${fieldSize(size)} ${size === 'sm' ? 'px-2.5' : size === 'lg' ? 'px-3.5' : 'px-3'} ${fieldChrome(error, disabled)}`)} ${open ? 'ring-2 ring-input-ring' : ''}`}
      >
        {children || (
          <span
            className={`flex min-w-0 items-center gap-2 ${selected ? 'text-input-text' : 'text-input-text-placeholder'}`}
          >
            {selected?.icon}
            <span className="truncate">{selected?.label || placeholder}</span>
          </span>
        )}
        {showChevron && (
          <ChevronDown
            size={size === 'sm' ? 14 : 16}
            className={`shrink-0 text-input-text-placeholder transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {help && (
        <p id={`${inputId}-help`} className="text-xs text-input-text-subtle">
          {help}
        </p>
      )}
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-input-error">
          {error}
        </p>
      )}
      {open &&
        popupHost &&
        createPortal(
          <div
            ref={popup}
            popover="manual"
            tabIndex={-1}
            onKeyDown={navigate}
            className={`${popupChrome} p-1`}
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
              transform: position.openAbove ? 'translateY(-100%)' : undefined,
              pointerEvents: 'auto',
            }}
          >
            {searchable && (
              <div className="sticky top-0 z-10 bg-surface-overlay p-1">
                <TextInput
                  ref={search}
                  aria-label={`Search ${accessibleLabel || 'options'}`}
                  role="combobox"
                  aria-expanded={true}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
                  placeholder="Search..."
                  value={query}
                  onChange={(value) => {
                    setQuery(value);
                    setActive(0);
                  }}
                  size="sm"
                />
              </div>
            )}
            <div
              id={listId}
              role="listbox"
              aria-label={accessibleLabel}
              tabIndex={searchable ? undefined : 0}
              aria-activedescendant={
                !searchable && activeOption ? `${listId}-${active}` : undefined
              }
            >
              {groups.map((group) => (
                <div key={group || 'ungrouped'} role="group" aria-label={group}>
                  {group && (
                    <div className="px-3 pb-1 pt-2 text-xs font-semibold text-input-text-subtle">
                      {group}
                    </div>
                  )}
                  {filtered
                    .filter((option) => option.group === group)
                    .map((option) => {
                      const index = available.indexOf(option);
                      return (
                        <div
                          key={option.value}
                          id={index >= 0 ? `${listId}-${index}` : undefined}
                          role="option"
                          aria-selected={option.value === value}
                          aria-disabled={option.disabled || undefined}
                          onPointerMove={() => {
                            if (!option.disabled) setActive(index);
                          }}
                          onClick={() => choose(option)}
                          className={`flex items-center gap-2 rounded-input-sm px-3 py-2 text-sm ${option.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${index === active ? 'bg-input-bg-active' : ''} ${option.value === value ? 'text-input-accent-subtle-fg bg-input-accent-subtle' : 'text-input-text'}`}
                        >
                          {option.icon}
                          <span className="min-w-0 flex-1">
                            <span className="block break-words">{option.label}</span>
                            {option.detail && (
                              <span className="block text-xs text-input-text-subtle">
                                {option.detail}
                              </span>
                            )}
                          </span>
                          {option.value === value && <Check size={14} className="shrink-0" />}
                        </div>
                      );
                    })}
                </div>
              ))}
              {!filtered.length && (
                <p className="px-3 py-4 text-sm text-input-text-subtle">{emptyText}</p>
              )}
            </div>
          </div>,
          popupHost,
        )}
    </div>
  );
});
