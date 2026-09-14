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
export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  group?: string;
  detail?: ReactNode;
  keywords?: string;
  disabled?: boolean;
  isGroupHeader?: boolean;
  /** On a group header, with `collapsibleGroups`: the group starts closed. */
  collapsed?: boolean;
  /** Rich content for the row. `label` stays the text for search, typeahead and the closed field. */
  render?: ReactNode;
}
/** Accessible, token-based Select configuration. */
export interface SelectProps {
  label?: string;
  visibleLabel?: string;
  ariaLabel?: string;
  value?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
  /** The field itself takes the search while open: typing narrows the list. */
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
  /** Group headers become toggles; a search expands every group while it lasts. */
  collapsibleGroups?: boolean;
}
/** A navigable line in the popup: a group toggle or a selectable option. */
type SelectRow = { header: string } | { option: SelectOption };
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
    collapsibleGroups,
  },
  forwardedRef,
) {
  const autoId = useId(),
    inputId = id || triggerId || autoId,
    listId = `${inputId}-list`;
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0),
    [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 300,
    openAbove: false,
  });
  // The field: the closed button, or the search box that stands in for it while open.
  const trigger = useRef<HTMLElement | null>(null),
    popup = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    refocus = useRef(false);

  const { host: popupHost, prepare: preparePopup } = useInputPopup(open, trigger, popup);
  const selected = options.find((option) => !option.isGroupHeader && option.value === value);
  const fieldLabel = visibleLabel ?? (searchable ? undefined : label),
    accessibleLabel = ariaLabel || label || visibleLabel;
  const normalized: SelectOption[] = [];
  const startCollapsed = new Set<string>();
  let group: string | undefined;
  for (const option of options) {
    if (option.isGroupHeader) {
      group = option.label;
      if (option.collapsed) startCollapsed.add(option.label);
    } else normalized.push({ ...option, group: option.group ?? group });
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
  // Collapsing only applies to named groups and never while a search narrows the list.
  const collapsing = !!collapsibleGroups && !needle;
  const rowsFor = (open: Set<string>): SelectRow[] =>
    groups.flatMap((group) => [
      ...(collapsing && group ? [{ header: group }] : []),
      ...(!collapsing || !group || open.has(group)
        ? filtered
            .filter((option) => option.group === group && !option.disabled)
            .map((option) => ({ option }))
        : []),
    ]);
  const rows = rowsFor(expanded),
    activeRow = rows[active],
    activeOption = activeRow && 'option' in activeRow ? activeRow.option : undefined;
  // The same value may appear in two groups (a suggestion and its home), so rows key on both.
  const rowKey = (row: SelectRow) =>
    'option' in row ? `option:${row.option.group ?? ''}:${row.option.value}` : `header:${row.header}`;
  const rowIndex = new Map<string, number>();
  rows.forEach((row, index) => rowIndex.set(rowKey(row), index));
  const isExpanded = (group: string) => !collapsing || expanded.has(group);
  const help = description || helperText;
  const describedBy =
    [help && `${inputId}-help`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined;
  const updatePosition = useCallback(() => {
    if (trigger.current) setPosition(popupPosition(trigger.current, 320, 220));
  }, []);
  // The button is back on the next render; focus returns to it then.
  const close = () => {
    setOpen(false);
    refocus.current = true;
  };
  const choose = (option: SelectOption) => {
    if (!option.disabled) {
      onChange?.(option.value);
      close();
    }
  };
  const toggleGroup = (group: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const show = () => {
    preparePopup();
    if (disabled) return;
    setQuery('');
    // Every group opens except those marked closed; the chosen value's group always opens.
    const initial = new Set(
      [...new Set(ordered.map((option) => option.group))].filter(
        (group): group is string =>
          !!group && (!startCollapsed.has(group) || group === selected?.group),
      ),
    );
    if (selected?.group) initial.add(selected.group);
    setExpanded(initial);
    const initialRows = collapsibleGroups
      ? [...new Set(ordered.map((option) => option.group))].flatMap((group) => [
          ...(group ? [{ header: group } as SelectRow] : []),
          ...(!group || initial.has(group)
            ? ordered
                .filter((option) => option.group === group && !option.disabled)
                .map((option) => ({ option }) as SelectRow)
            : []),
        ])
      : ordered.filter((option) => !option.disabled).map((option) => ({ option }) as SelectRow);
    // Nothing is highlighted until the pointer or keyboard moves when the value is not listed.
    setActive(
      initialRows.findIndex((row) => 'option' in row && row.option.value === value),
    );
    updatePosition();
    setOpen(true);
  };
  useEffect(() => {
    if (open) return;
    if (!refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open]);
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
    if (open && active >= 0)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      // From the field itself focus moves on naturally; from the list it returns to the field.
      setOpen(false);
      if (event.target !== search.current) refocus.current = true;
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (searchable && (event.key === 'Home' || event.key === 'End')) return;
      event.preventDefault();
      setActive((index) =>
        event.key === 'Home'
          ? 0
          : event.key === 'End' || (event.key === 'ArrowUp' && index < 0)
            ? Math.max(0, rows.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) %
              Math.max(1, rows.length),
      );
    } else if (
      activeRow &&
      'header' in activeRow &&
      !needle &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      if ((event.key === 'ArrowRight') !== expanded.has(activeRow.header))
        toggleGroup(activeRow.header);
    } else if (event.key === 'Enter' || (!searchable && event.key === ' ')) {
      event.preventDefault();
      if (activeRow && 'header' in activeRow) toggleGroup(activeRow.header);
      else if (activeOption) choose(activeOption);
    } else if (!searchable && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const index = rows.findIndex((row) =>
        ('option' in row ? row.option.label : row.header)
          .toLocaleLowerCase()
          .startsWith(event.key.toLocaleLowerCase()),
      );
      if (index >= 0) setActive(index);
    }
  };
  const chevronSize = size === 'sm' ? 14 : 16;
  // One chrome for the closed button and the open search box, so nothing shifts between them.
  const fieldClass = `w-full flex items-center justify-between gap-2 text-left rounded-input transition-colors motion-reduce:transition-none ${triggerClassName || (compact ? 'px-2 py-1 text-sm hover:bg-input-bg-hover' : `${fieldSize(size)} ${size === 'sm' ? 'px-2.5' : size === 'lg' ? 'px-3.5' : 'px-3'} ${fieldChrome(error, disabled)}`)}`;
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
      {searchable && open ? (
        <div
          ref={(node) => {
            trigger.current = node;
          }}
          onClick={() => search.current?.focus()}
          className={`${fieldClass} cursor-text ring-2 ring-input-ring`}
        >
          {selected?.icon}
          <input
            ref={search}
            id={inputId}
            type="text"
            role="combobox"
            aria-label={accessibleLabel}
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeRow ? `${listId}-${active}` : undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            placeholder={selected?.label || placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={navigate}
            className="min-w-0 flex-1 bg-transparent text-input-text outline-none placeholder:text-input-text-placeholder"
          />
          {showChevron && (
            <ChevronDown
              size={chevronSize}
              aria-hidden="true"
              onClick={(event) => {
                event.stopPropagation();
                close();
              }}
              className="shrink-0 rotate-180 cursor-pointer text-input-text-placeholder"
            />
          )}
        </div>
      ) : (
        <button
          ref={mergeRefs<HTMLButtonElement>((node) => {
            trigger.current = node;
          }, forwardedRef)}
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
          className={`${fieldClass} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-ring disabled:opacity-50 disabled:cursor-not-allowed ${open ? 'ring-2 ring-input-ring' : ''}`}
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
              size={chevronSize}
              className={`shrink-0 text-input-text-placeholder transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            />
          )}
        </button>
      )}
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
            // The popup is portaled, but React still bubbles its clicks to the
            // trigger's ancestors (a table row, a card); a choice is not a row click.
            onClick={(event) => event.stopPropagation()}
            className={`${popupChrome} p-1`}
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
              transform: position.openAbove ? 'translateY(-100%)' : undefined,
              pointerEvents: 'auto',
            }}
          >
            {/* Only the list scrolls, inside the rounded frame, on a thin bar. */}
            <div
              id={listId}
              role="listbox"
              aria-label={accessibleLabel}
              tabIndex={searchable ? undefined : 0}
              aria-activedescendant={!searchable && activeRow ? `${listId}-${active}` : undefined}
              className="overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--color-input-border-hover)_transparent]"
              style={{ maxHeight: position.maxHeight - 8 }}
            >
              {groups.map((group, groupIndex) => {
                const headerIndex = group ? rowIndex.get(`header:${group}`) : undefined;
                const groupOpen = !group || isExpanded(group);
                const count = filtered.filter((option) => option.group === group).length;
                return (
                  <div
                    key={group || 'ungrouped'}
                    role="group"
                    aria-labelledby={
                      group && headerIndex !== undefined ? `${listId}-${headerIndex}` : undefined
                    }
                    aria-label={group && headerIndex === undefined ? group : undefined}
                    className={
                      groupIndex > 0 ? 'mt-1 border-t border-input-border-divider pt-1' : ''
                    }
                  >
                    {group && headerIndex !== undefined ? (
                      <button
                        type="button"
                        id={`${listId}-${headerIndex}`}
                        tabIndex={-1}
                        aria-expanded={groupOpen}
                        aria-controls={`${listId}-group-${groupIndex}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerMove={() => setActive(headerIndex)}
                        onClick={() => toggleGroup(group)}
                        className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-input-sm px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-input-text-subtle transition-colors motion-reduce:transition-none hover:text-input-text ${headerIndex === active ? 'bg-input-bg-active text-input-text' : ''}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{group}</span>
                        <span className="flex shrink-0 items-center gap-1.5 font-normal normal-case tracking-normal tabular-nums">
                          {count}
                          <ChevronDown
                            size={12}
                            aria-hidden="true"
                            className={`transition-transform motion-reduce:transition-none ${groupOpen ? 'rotate-180' : ''}`}
                          />
                        </span>
                      </button>
                    ) : (
                      group && (
                        <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-input-text-subtle">
                          {group}
                        </div>
                      )
                    )}
                    <div id={`${listId}-group-${groupIndex}`}>
                      {groupOpen &&
                        filtered
                          .filter((option) => option.group === group)
                          .map((option) => {
                            const index = rowIndex.get(rowKey({ option })) ?? -1;
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
                                className={`flex items-center gap-2 rounded-input-sm px-3 py-1.5 text-sm ${option.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${index === active ? 'bg-input-bg-active' : ''} ${option.value === value ? 'text-input-accent-subtle-fg bg-input-accent-subtle' : 'text-input-text'}`}
                              >
                                {option.icon}
                                <span className="min-w-0 flex-1">
                                  {option.render ? (
                                    <span className="block min-w-0">{option.render}</span>
                                  ) : (
                                    <span className="block break-words">{option.label}</span>
                                  )}
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
                  </div>
                );
              })}
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
