"use client";
import {
  Select,
  type SelectOption,
  type SelectProps,
} from "@/components/ui/inputs/Select";

/**
 * The account and payee picker used throughout accounting. It is the shared
 * `Select` from the component library; this file keeps the accounting
 * names so call sites read naturally.
 */
export type AccountingOption = SelectOption;
export type AccountingPickerProps = SelectProps;

export function AccountingPicker({
  children,
  ...props
}: AccountingPickerProps) {
  // A searchable Select becomes the search box while it is open. That reads
  // well for a plain field, but a picker with its own trigger is a card
  // carrying a logo, a name and a balance, and swapping all of it for an
  // empty text box on click is jarring. Those pickers stay a button and just
  // open the menu, where typing still jumps to a match.
  return (
    <Select searchable={!children} {...props}>
      {children}
    </Select>
  );
}
