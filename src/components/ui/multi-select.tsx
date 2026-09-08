"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface MultiSelectProps {
  label?: string;
  helperText?: string;
  error?: string;
  options: MultiSelectOption[];
  placeholder?: string;
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
  size?: "default" | "sm";
  searchable?: boolean;
  selectAll?: boolean;
  maxSelections?: number;
  required?: boolean;
  id?: string;
  className?: string;
}

const MAX_HEIGHT = 280;

/**
 * Multi-value select with chips, search and keyboard navigation. Renders its
 * list through a portal at a fixed position so it escapes dialog and table
 * clipping, matching `CustomSelect`.
 */
export function MultiSelect({
  label,
  helperText,
  error,
  options,
  placeholder = "Select...",
  value = [],
  onChange,
  disabled = false,
  size = "default",
  searchable = true,
  selectAll = false,
  maxSelections,
  required,
  id,
  className,
}: MultiSelectProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlighted, setHighlighted] = React.useState(-1);
  const [pos, setPos] = React.useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: MAX_HEIGHT,
    above: false,
  });
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle))
    : options;
  const enabledFiltered = filtered.filter((o) => !o.disabled);
  const allSelected =
    enabledFiltered.length > 0 &&
    enabledFiltered.every((o) => value.includes(o.value));
  const atMax = maxSelections !== undefined && value.length >= maxSelections;
  const selectedLabels = value
    .map((v) => options.find((o) => o.value === v)?.label)
    .filter((l): l is string => Boolean(l));

  const place = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const aboveSpace = rect.top;
    const above = below < MAX_HEIGHT + 8 && aboveSpace > below;
    setPos({
      top: above ? rect.top - 4 : rect.bottom + 4,
      left: Math.max(
        8,
        Math.min(rect.left, window.innerWidth - rect.width - 8),
      ),
      width: rect.width,
      maxHeight: Math.max(
        120,
        Math.min(MAX_HEIGHT, (above ? aboveSpace : below) - 8),
      ),
      above,
    });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    setSearch("");
    setHighlighted(-1);
    if (searchable) setTimeout(() => searchRef.current?.focus(), 0);
  }, [open, searchable]);

  React.useEffect(() => {
    if (!open || highlighted < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  const toggle = (v: string) => {
    if (value.includes(v)) onChange?.(value.filter((x) => x !== v));
    else if (!atMax) onChange?.([...value, v]);
  };

  const toggleAll = () => {
    if (allSelected) {
      const drop = new Set(enabledFiltered.map((o) => o.value));
      onChange?.(value.filter((v) => !drop.has(v)));
      return;
    }
    const next = new Set(value);
    for (const o of enabledFiltered) {
      if (maxSelections !== undefined && next.size >= maxSelections) break;
      next.add(o.value);
    }
    onChange?.([...next]);
  };

  const nextEnabled = (from: number, dir: 1 | -1) => {
    for (let i = 0; i < filtered.length; i++) {
      const idx = (from + dir * (i + 1) + filtered.length) % filtered.length;
      if (!filtered[idx].disabled) return idx;
    }
    return -1;
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => nextEnabled(h < 0 ? -1 : h, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => nextEnabled(h < 0 ? filtered.length : h, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0 && !filtered[highlighted].disabled)
        toggle(filtered[highlighted].value);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlighted(nextEnabled(-1, 1));
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlighted(nextEnabled(filtered.length, -1));
    }
  };

  const small = size === "sm";
  const highlightedId =
    highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined;
  const box = (checked: boolean, dim = false) => (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked ? "border-primary bg-primary" : "border-border bg-transparent",
        dim && "opacity-50",
      )}
    >
      {checked && (
        <Check size={10} strokeWidth={3} className="text-primary-foreground" />
      )}
    </span>
  );

  return (
    <div className={cn("w-full", className)}>
      {label && (
        <label
          id={`${inputId}-label`}
          htmlFor={inputId}
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          {label}
          {required && (
            <span className="ml-1 text-error" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <button
        ref={triggerRef}
        id={inputId}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? highlightedId : undefined}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-labelledby={label ? `${inputId}-label` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border bg-input text-left transition-colors",
          small ? "min-h-9 px-3 py-1.5 text-sm" : "min-h-10 px-3 py-2 text-sm",
          "hover:border-[rgba(var(--ink),0.18)]",
          "focus:outline-none focus:ring-2 focus:ring-ring focus:border-teal",
          "disabled:cursor-not-allowed disabled:opacity-50",
          error ? "border-error" : "border-border",
          open && "border-teal ring-2 ring-ring",
        )}
      >
        {value.length === 0 ? (
          <span className="text-muted-foreground">{placeholder}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {selectedLabels.slice(0, 3).map((lbl, i) => (
              <span
                key={value[i]}
                className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-0.5 text-xs font-medium text-teal-light"
              >
                <span className="max-w-[120px] truncate">{lbl}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Remove ${lbl}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(value[i]);
                  }}
                  className="-mr-0.5 rounded p-0.5 transition-colors hover:bg-primary/20"
                >
                  <X size={10} aria-hidden="true" />
                </span>
              </span>
            ))}
            {selectedLabels.length > 3 && (
              <span className="self-center text-xs text-muted-foreground">
                +{selectedLabels.length - 3} more
              </span>
            )}
          </span>
        )}
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {error && (
        <p role="alert" className="mt-1.5 text-sm text-error">
          {error}
        </p>
      )}
      {helperText && !error && (
        <p className="mt-1.5 text-sm text-muted-foreground">{helperText}</p>
      )}

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            aria-labelledby={label ? `${inputId}-label` : undefined}
            onKeyDown={onListKey}
            className="fixed z-[99999] overflow-hidden rounded-lg border border-border bg-popover shadow-[var(--shadow-overlay)]"
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: pos.width,
              maxHeight: pos.maxHeight,
              transform: pos.above ? "translateY(-100%)" : undefined,
              pointerEvents: "auto",
            }}
          >
            {searchable && (
              <div className="border-b border-border p-2">
                <div className="relative">
                  <Search
                    size={14}
                    aria-hidden="true"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    aria-label="Search options"
                    aria-controls={listboxId}
                    aria-activedescendant={highlightedId}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setHighlighted(-1);
                    }}
                    onKeyDown={onListKey}
                    placeholder="Search..."
                    className="h-8 w-full rounded-md bg-secondary pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/40"
                  />
                </div>
              </div>
            )}
            {selectAll && !needle && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  toggleAll();
                }}
                className="flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-secondary"
              >
                {box(allSelected)}
                Select all
              </button>
            )}
            <div
              className="overflow-y-auto p-1"
              style={{
                maxHeight: Math.max(
                  80,
                  pos.maxHeight -
                    (searchable ? 48 : 0) -
                    (selectAll && !needle ? 40 : 0),
                ),
              }}
            >
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No options found
                </div>
              ) : (
                filtered.map((option, index) => {
                  const isSelected = value.includes(option.value);
                  const isDisabled = option.disabled || (!isSelected && atMax);
                  return (
                    <div
                      key={option.value}
                      id={`${listboxId}-option-${index}`}
                      role="option"
                      data-index={index}
                      aria-selected={isSelected}
                      aria-disabled={isDisabled || undefined}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (!isDisabled) toggle(option.value);
                      }}
                      onMouseEnter={() => !isDisabled && setHighlighted(index)}
                      className={cn(
                        "flex select-none items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                        isDisabled
                          ? "cursor-not-allowed text-muted-foreground opacity-50"
                          : "cursor-pointer text-foreground",
                        index === highlighted && !isDisabled && "bg-secondary",
                      )}
                    >
                      {box(isSelected, isDisabled)}
                      <span className="flex-1">{option.label}</span>
                    </div>
                  );
                })
              )}
            </div>
            {maxSelections !== undefined && (
              <div className="border-t border-border px-3 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                {value.length}/{maxSelections} selected
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
