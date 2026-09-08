"use client";
import {
  SearchableSelect,
  type SearchableOption,
  type SearchableSelectProps,
} from "@/components/ui/searchable-select";

/**
 * The account and payee picker used throughout accounting. It is the shared
 * `SearchableSelect` from the component library; this file keeps the accounting
 * names so call sites read naturally.
 */
export type AccountingOption = SearchableOption;
export type AccountingPickerProps = SearchableSelectProps;

export function AccountingPicker(props: AccountingPickerProps) {
  return <SearchableSelect {...props} />;
}
