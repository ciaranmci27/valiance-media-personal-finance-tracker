"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { Party } from "@/lib/accounting/workflows";
import { cn } from "@/lib/utils";

const AccountingEvidence = dynamic(
  () =>
    import("./accounting-evidence").then((module) => module.AccountingEvidence),
  {
    loading: () => (
      <p role="status" className="text-sm text-muted-foreground">
        Loading receipts and history...
      </p>
    ),
  },
);

/** Fetch evidence only on first expansion; keep unsaved notes when collapsing it. */
export function EntryEvidenceDisclosure({
  className,
  ...props
}: {
  entryId: string;
  accounts: AccountingAccount[];
  parties: Party[];
  className?: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className={cn("group rounded-xl border border-border", className)}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
        Receipts and history
      </summary>
      {opened && (
        <div className="border-t border-border p-4">
          <AccountingEvidence key={props.entryId} {...props} />
        </div>
      )}
    </details>
  );
}
