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

export function AccountingPicker(props: AccountingPickerProps) {
  return <Select searchable {...props} />;
}
