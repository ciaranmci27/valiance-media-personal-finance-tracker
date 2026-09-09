"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/inputs/Checkbox";

export interface DataTableColumn<T> {
  /** Stable key, also the sort key. */
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Classes applied to both the header cell and body cells, e.g. responsive hiding. */
  className?: string;
  /** Makes the column sortable; returns the comparable value. */
  sortValue?: (row: T) => string | number;
  /** Fixed width class, e.g. "w-32". */
  width?: string;
  /** Digits line up when true. */
  numeric?: boolean;
}

export interface DataTableSelection {
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onToggleAll: (keys: string[]) => void;
  /** Rows whose keys are not selectable stay unchecked and disabled. */
  isSelectable?: (key: string) => boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  /** Mouse convenience; keyboard users use the primary cell's control. */
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
  /**
   * Card renderer for small screens. Below `lg` the table hides and this stack
   * shows instead. Pass it for any table a phone will open.
   */
  mobileCard?: (row: T) => ReactNode;
  /** Row selection with a leading checkbox column. */
  selection?: DataTableSelection;
  /** Footer row, e.g. totals. Rendered inside the table on desktop only. */
  footer?: ReactNode;
  /** Element rendered below the table on every breakpoint, e.g. a Pagination. */
  after?: ReactNode;
  /** Dims the table and marks it busy while data reloads. */
  busy?: boolean;
  fixedLayout?: boolean;
  /** Wraps the table in a glass card. Turn off when the parent already is one. */
  framed?: boolean;
  className?: string;
  /** Row class hook, e.g. to tint drafts. */
  rowClassName?: (row: T) => string | undefined;
}

/** Cents and counts arrive as strings; sort them as numbers when they are one. */
const numeric = (v: unknown): number | null =>
  typeof v === "number"
    ? v
    : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())
      ? Number(v)
      : null;

/** A row click that started on a control belongs to that control, not the row. */
const fromControl = (e: React.MouseEvent<HTMLElement>) =>
  !!(e.target as HTMLElement).closest(
    "button, a, input, select, textarea, label, [role='menu'], [role='dialog']",
  );

const alignClass = (align?: "left" | "right" | "center") =>
  align === "right"
    ? "text-right"
    : align === "center"
      ? "text-center"
      : "text-left";

/**
 * The one table. Desktop rows above `lg`, cards below it, sortable headers,
 * optional selection and footer. Cells take admin tokens so the table reads
 * the same on both themes.
 */
export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyState,
  initialSort,
  mobileCard,
  selection,
  footer,
  after,
  busy = false,
  fixedLayout = false,
  framed = true,
  className,
  rowClassName,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    initialSort ?? null,
  );

  const sorted = useMemo(() => {
    if (!sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return data;
    const getVal = col.sortValue;
    return [...data].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      const na = numeric(va);
      const nb = numeric(vb);
      const cmp =
        na !== null && nb !== null
          ? na - nb
          : String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [data, sort, columns]);

  const toggleSort = (key: string) =>
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });

  const keys = sorted.map(keyExtractor);
  const selectableKeys = selection
    ? keys.filter((k) => selection.isSelectable?.(k) ?? true)
    : [];
  const allSelected =
    selectableKeys.length > 0 &&
    selectableKeys.every((k) => selection!.selected.has(k));
  const someSelected =
    !allSelected && selectableKeys.some((k) => selection!.selected.has(k));
  const colSpan = columns.length + (selection ? 1 : 0);
  const empty = emptyState ?? "Nothing here yet.";

  return (
    <div
      aria-busy={busy || undefined}
      className={cn("transition-opacity", busy && "opacity-60", className)}
    >
      {mobileCard && (
        <div className="space-y-3 lg:hidden">
          {sorted.length === 0 ? (
            <div className="glass-card rounded-xl px-4 py-10 text-center text-sm text-muted-foreground">
              {empty}
            </div>
          ) : (
            sorted.map((row) => {
              const key = keyExtractor(row);
              return (
                <div
                  key={key}
                  onClick={
                    onRowClick
                      ? (e) => {
                          if (!fromControl(e)) onRowClick(row);
                        }
                      : undefined
                  }
                  className={cn(
                    onRowClick && "cursor-pointer",
                    rowClassName?.(row),
                  )}
                >
                  {mobileCard(row)}
                </div>
              );
            })
          )}
          {after}
        </div>
      )}

      <div
        className={cn(
          mobileCard && "hidden lg:block",
          framed && "glass-card overflow-hidden rounded-xl",
        )}
      >
        <div className="overflow-x-auto">
          <table
            className={cn(
              "w-full border-collapse text-left",
              fixedLayout && "table-fixed",
            )}
          >
            <thead>
              <tr className="border-b border-border bg-[rgba(var(--ink),0.03)]">
                {selection && (
                  <th scope="col" className="w-10 px-3 py-3">
                    <Checkbox
                      size="sm"
                      checked={allSelected}
                      ariaLabel={
                        allSelected ? "Clear selection" : "Select all rows"
                      }
                      indeterminate={someSelected}
                      disabled={selectableKeys.length === 0}
                      onChange={() => selection.onToggleAll(selectableKeys)}
                    />
                  </th>
                )}
                {columns.map((col) => {
                  const isSorted = sort?.key === col.key;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={
                        isSorted
                          ? sort!.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      className={cn(
                        "whitespace-nowrap px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
                        alignClass(col.align),
                        col.width,
                        col.className,
                      )}
                    >
                      {col.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            col.align === "right" && "flex-row-reverse",
                          )}
                        >
                          {col.header}
                          {isSorted ? (
                            sort!.dir === "asc" ? (
                              <ArrowUp size={12} aria-hidden="true" />
                            ) : (
                              <ArrowDown size={12} aria-hidden="true" />
                            )
                          ) : (
                            <ChevronsUpDown
                              size={12}
                              aria-hidden="true"
                              className="opacity-50"
                            />
                          )}
                        </button>
                      ) : (
                        col.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={colSpan}
                    className="px-4 py-12 text-center text-sm text-muted-foreground"
                  >
                    {empty}
                  </td>
                </tr>
              ) : (
                sorted.map((row) => {
                  const key = keyExtractor(row);
                  const selectable = selection?.isSelectable?.(key) ?? true;
                  const isSelected = selection?.selected.has(key) ?? false;
                  return (
                    <tr
                      key={key}
                      onClick={
                        onRowClick
                          ? (e) => {
                              if (!fromControl(e)) onRowClick(row);
                            }
                          : undefined
                      }
                      data-selected={isSelected || undefined}
                      className={cn(
                        "border-b border-border transition-colors last:border-0",
                        onRowClick &&
                          "cursor-pointer hover:bg-[rgba(var(--ink),0.03)]",
                        isSelected && "bg-primary/[0.06]",
                        rowClassName?.(row),
                      )}
                    >
                      {selection && (
                        <td
                          className="w-10 px-3 py-3 align-middle"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            size="sm"
                            checked={isSelected}
                            disabled={!selectable}
                            ariaLabel={
                              isSelected ? "Deselect row" : "Select row"
                            }
                            onChange={() => selection.onToggle(key)}
                          />
                        </td>
                      )}
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={cn(
                            "px-4 py-3 align-middle text-sm text-foreground",
                            alignClass(col.align),
                            col.numeric && "tabular-nums",
                            col.className,
                          )}
                        >
                          {col.render(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
            {footer && sorted.length > 0 && (
              <tfoot>
                <tr className="border-t border-border bg-[rgba(var(--ink),0.03)] text-sm font-medium">
                  {footer}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {after && <div className="border-t border-border">{after}</div>}
      </div>
    </div>
  );
}
