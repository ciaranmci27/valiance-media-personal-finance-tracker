"use client";
import { useMemo } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { SelectOption, SelectProps } from "@/components/ui/inputs/Select";
import {
  TRANSFER_CATEGORY,
  type CategoryGroup,
} from "@/lib/accounting/categories";
import { AccountingPicker } from "./accounting-picker";
import { dateLabel } from "./format";

/**
 * One line, whatever the width. Bank account names end in the number that
 * tells them apart, so the name gives way before the number does.
 */
function TransferLabel({ verb, account }: { verb: string; account: string }) {
  const cut = account.trim().lastIndexOf(" ");
  const head = cut > 0 ? account.slice(0, cut) : account;
  const tail = cut > 0 ? account.slice(cut + 1) : "";
  return (
    <span className="flex min-w-0 whitespace-nowrap">
      <span className="shrink-0">{verb}&nbsp;</span>
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0">&nbsp;{tail}</span>}
    </span>
  );
}

/** A matching opposite movement on another of the owner's accounts. */
export interface TransferMatch {
  /** The other account's name. */
  account: string;
  /** When the opposite movement happened. */
  date: string;
  onSelect: () => void;
}

/**
 * The category field on a bank movement: collapsible groups from
 * `categoryGroups`, and a plain account id out. When the books hold an
 * opposite movement on another account, a transfer row leads the list as a
 * suggestion, named for the account it matches; choosing it opens the
 * transfer dialog and leaves the value alone. Without a match the row is
 * absent: a movement with no counterpart is not a transfer.
 */
export function AccountingCategoryPicker({
  groups,
  direction,
  transfer,
  onChange,
  ...rest
}: Omit<SelectProps, "options" | "onChange" | "collapsibleGroups"> & {
  groups: CategoryGroup[];
  direction?: "in" | "out";
  transfer?: TransferMatch;
  onChange: (accountId: string) => void;
}) {
  const options = useMemo<SelectOption[]>(
    () => [
      ...(transfer
        ? [
            {
              value: TRANSFER_CATEGORY,
              label:
                direction === "out"
                  ? `Transfer to ${transfer.account}`
                  : `Transfer from ${transfer.account}`,
              render: (
                <TransferLabel
                  verb={direction === "out" ? "Transfer to" : "Transfer from"}
                  account={transfer.account}
                />
              ),
              detail: `Matches a movement on ${dateLabel(transfer.date)}`,
              keywords: "transfer card payment move savings bank",
              icon: (
                <ArrowLeftRight
                  size={14}
                  aria-hidden="true"
                  className="text-muted-foreground"
                />
              ),
            },
          ]
        : []),
      ...groups.flatMap((group) => [
        {
          value: `group:${group.id}`,
          label: group.label,
          isGroupHeader: true,
          collapsed: group.collapsed,
        },
        ...group.options.map((option) => ({
          value: option.value,
          label: option.label,
          keywords: option.keywords,
          detail: option.detail,
        })),
      ]),
    ],
    [groups, direction, transfer],
  );
  return (
    <AccountingPicker
      {...rest}
      collapsibleGroups
      options={options}
      onChange={(value) => {
        if (value === TRANSFER_CATEGORY) transfer?.onSelect();
        else onChange(value);
      }}
    />
  );
}
