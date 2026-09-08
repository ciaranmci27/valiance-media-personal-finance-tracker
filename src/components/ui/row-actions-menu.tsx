"use client";

import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RowAction {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
  /** Draws a divider above this item. */
  separator?: boolean;
}

export interface RowActionsMenuProps {
  actions: RowAction[];
  /** Accessible name for the trigger, e.g. "Actions for Amazon Web Services". */
  label: string;
  align?: "start" | "end";
  className?: string;
}

/**
 * A "more" trigger that opens a portal menu, so it is never clipped by a
 * table's scroll container. Radix handles focus, keyboard navigation and
 * dismissal; this file only supplies the admin styling.
 */
export function RowActionsMenu({
  actions,
  label,
  align = "end",
  className,
}: RowActionsMenuProps) {
  if (!actions.length) return null;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors",
            "hover:bg-secondary hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "data-[state=open]:bg-secondary data-[state=open]:text-foreground",
            className,
          )}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onClick={(e) => e.stopPropagation()}
          className="z-[70] min-w-[176px] overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-[var(--shadow-overlay)] animate-in fade-in-0 zoom-in-95"
        >
          {actions.map((action) => (
            <React.Fragment key={action.label}>
              {action.separator && (
                <Menu.Separator className="my-1 h-px bg-border" />
              )}
              <Menu.Item
                disabled={action.disabled}
                onSelect={action.onSelect}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none transition-colors",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
                  action.variant === "danger"
                    ? "text-error data-[highlighted]:bg-error/10"
                    : "text-foreground data-[highlighted]:bg-secondary",
                )}
              >
                {action.icon && (
                  <span
                    aria-hidden="true"
                    className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4"
                  >
                    {action.icon}
                  </span>
                )}
                {action.label}
              </Menu.Item>
            </React.Fragment>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
