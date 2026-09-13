"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Disclosure } from "@/components/ui/disclosure";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { Party } from "@/lib/accounting/workflows";

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
    <Disclosure
      summary="Receipts and history"
      className={className}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      {opened && <AccountingEvidence key={props.entryId} {...props} />}
    </Disclosure>
  );
}
