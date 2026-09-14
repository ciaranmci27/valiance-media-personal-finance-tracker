"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Disclosure } from "@/components/ui/disclosure";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { Party } from "@/lib/accounting/workflows";
import { EvidenceSkeleton } from "./accounting-skeletons";

/** The panel's chunk; a dialog warms it on open so the first expand is instant. */
export const loadEvidenceChunk = () => import("./accounting-evidence");

const AccountingEvidence = dynamic(
  () => loadEvidenceChunk().then((module) => module.AccountingEvidence),
  { loading: () => <EvidenceSkeleton /> },
);

/** Mount the panel on first expansion; keep unsaved notes when collapsing it. */
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
