"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchableOption {
  value: string;
  label: string;
  /** Options with the same group render under one uppercase heading. */
  group?: string;
  /** Secondary line under the label, e.g. an account type or balance. */
  detail?: ReactNode;
  /** Extra text the search matches against but never shows. */
  keywords?: string;
  disabled?: boolean;
}

export interface SearchableSelectProps {
  /** Accessible name for the trigger. Always required. */
  label: string;
  /** Visible form label above the trigger. */
  visibleLabel?: string;
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Text shown when the search matches nothing. */
  emptyText?: string;
  className?: string;
  /**
   * Replaces the trigger's default chrome (height, border, background) with
   * the caller's own, for triggers that are themselves a card or a row.
   * Focus, open and disabled states still apply.
   */
  triggerClassName?: string;
  triggerId?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  helperText?: string;
  /** Borderless trigger for inline use inside table rows. */
  compact?: boolean;
  /** Custom trigger content. Replaces the selected label. */
  children?: ReactNode;
  showChevron?: boolean;
}

/**
 * Grouped, searchable single select for long lists (a chart of accounts, a
 * payee list). Use `CustomSelect` for short enum-style lists. Renders through
 * a Radix dropdown so it escapes table and dialog clipping and keeps keyboard
 * navigation.
 */
export function SearchableSelect({
  label,
  visibleLabel,
  value,
  options,
  onChange,
  placeholder = "Choose...",
  emptyText = "No matching options.",
  className,
  triggerClassName,
  triggerId,
  disabled,
  required,
  error,
  helperText,
  compact,
  children,
  showChevron = true,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const id = triggerId ?? autoId;
  const selected = options.find((o) => o.value === value);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? options.filter((o) =>
        `${o.label} ${o.group ?? ""} ${o.keywords ?? ""}`
          .toLowerCase()
          .includes(needle),
      )
    : options;
  // Cluster options under their group in first-seen order so a heading never repeats.
  const groupOrder = new Map<string, number>();
  for (const o of matches) {
    const g = o.group ?? "";
    if (!groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
  }
  const filtered = [...matches].sort(
    (a, b) =>
      (groupOrder.get(a.group ?? "") ?? 0) -
      (groupOrder.get(b.group ?? "") ?? 0),
  );

  return (
    <div className={cn(!compact && "w-full", className)}>
      {visibleLabel && (
        <label
          htmlFor={id}
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          {visibleLabel}
          {required && (
            <span className="ml-1 text-error" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <Menu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        modal={false}
      >
        <Menu.Trigger asChild>
          <button
            type="button"
            id={id}
            disabled={disabled}
            aria-label={visibleLabel ? undefined : label}
            aria-describedby={error ? `${id}-error` : undefined}
            data-invalid={error ? "true" : undefined}
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-2 rounded-lg text-left text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "disabled:cursor-not-allowed disabled:opacity-50",
              triggerClassName ??
                (compact
                  ? "px-2 py-1.5 hover:bg-secondary"
                  : "h-10 border bg-input px-3 py-2 hover:border-[rgba(var(--ink),0.18)]"),
              !compact &&
                !triggerClassName &&
                (error ? "border-error" : "border-border"),
              open && !compact && "ring-2 ring-ring",
              open && !compact && !triggerClassName && "border-teal",
            )}
          >
            {children ?? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  !selected && "text-muted-foreground",
                )}
              >
                {selected?.label ?? placeholder}
              </span>
            )}
            {showChevron && (
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform duration-200",
                  open && "rotate-180",
                )}
              />
            )}
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-[70] w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-popover shadow-[var(--shadow-overlay)] animate-in fade-in-0 zoom-in-95"
            onCloseAutoFocus={() => setQuery("")}
          >
            <div className="relative border-b border-border p-3">
              <Search
                size={15}
                aria-hidden="true"
                className="absolute left-6 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                ref={input}
                autoFocus
                aria-label={`Search ${label.toLowerCase()}`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(e.key)
                  )
                    e.stopPropagation();
                }}
                placeholder="Search..."
                className="h-9 w-full rounded-lg bg-secondary pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <div className="max-h-80 overflow-y-auto p-1.5">
              {!filtered.length && (
                <p className="p-5 text-sm text-muted-foreground">{emptyText}</p>
              )}
              {filtered.map((option, i) => (
                <div key={option.value}>
                  {option.group && option.group !== filtered[i - 1]?.group && (
                    <Menu.Label className="px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {option.group}
                    </Menu.Label>
                  )}
                  <Menu.Item
                    disabled={option.disabled}
                    onSelect={() => {
                      if (option.value !== value) onChange(option.value);
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-secondary data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.detail && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {option.detail}
                        </div>
                      )}
                    </div>
                    {value === option.value && (
                      <Check
                        size={15}
                        aria-hidden="true"
                        className="shrink-0 text-teal-light"
                      />
                    )}
                  </Menu.Item>
                </div>
              ))}
            </div>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1.5 text-sm text-error"
        >
          {error}
        </p>
      )}
      {helperText && !error && (
        <p className="mt-1.5 text-sm text-muted-foreground">{helperText}</p>
      )}
    </div>
  );
}
