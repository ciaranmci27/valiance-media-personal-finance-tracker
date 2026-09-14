"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Filter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { popupChrome, useInputPopup } from "@/components/ui/inputs/_shared";
import { cn } from "@/lib/utils";

/**
 * The Filters button and its floating panel, shared by the lists. The panel
 * sits in the native top layer, in the same chrome the inputs use, so their
 * own popups (calendars, selects) open above it and a click inside any of
 * them stays. The position is computed before the panel opens so its first
 * paint is already under the button.
 */
export function FilterPopover({
  open,
  onOpenChange,
  count = 0,
  width = 560,
  label = "Filters",
  onReset,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active filters, shown as a count on the button. */
  count?: number;
  /** Panel width in pixels; narrower screens get what fits. */
  width?: number;
  label?: string;
  onReset: () => void;
  children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const popup = useInputPopup(open, button, panel);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  // The latest callback, so the document listeners never go stale.
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const place = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const fitted = Math.min(width, window.innerWidth - 16);
    setPosition({
      top: rect.bottom + 4,
      left: Math.max(
        8,
        Math.min(rect.right - fitted, window.innerWidth - fitted - 8),
      ),
      width: fitted,
    });
  }, [width]);
  useEffect(() => {
    if (!open || !popup.host) return;
    place();
    // A click inside any open popup (the panel, a select, a calendar) stays.
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        !target ||
        button.current?.contains(target) ||
        target.closest("[popover]")
      )
        return;
      change.current(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        document.querySelectorAll("[popover]:popover-open").length <= 1
      )
        change.current(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, popup.host, place]);
  return (
    <>
      <Button
        ref={button}
        size="sm"
        variant={open ? "secondary" : "ghost"}
        onClick={() => {
          place();
          popup.prepare();
          onOpenChange(!open);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Filter size={14} aria-hidden="true" />
        {label}
        {count > 0 && (
          <Badge variant="info" size="sm">
            {count}
          </Badge>
        )}
      </Button>
      {open &&
        popup.host &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            role="dialog"
            aria-label={label}
            style={position}
            className={cn(popupChrome, "p-4")}
          >
            {children}
            <div className="mt-3 flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={onReset}>
                <X size={14} aria-hidden="true" />
                Reset filters
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>,
          popup.host,
        )}
    </>
  );
}
