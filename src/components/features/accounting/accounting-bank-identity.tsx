"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import { bankIdentitiesByAccount } from "@/lib/accounting/bank-identity";
import type { FeedData, FeedIdentity } from "@/lib/accounting/feeds";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { cn } from "@/lib/utils";

const BankIdentityContext = createContext({
  feeds: null as FeedData | null,
  identities: new Map<string, FeedIdentity>(),
  accountIds: new Set<string>(),
});

/** Share the shell's existing feed read across lists, pickers, and portaled dialogs. */
export function AccountingBankIdentityProvider({
  feeds,
  profiles,
  children,
  className,
}: {
  feeds: FeedData | null;
  profiles: AccountProfile[];
  children: ReactNode;
  className?: string;
}) {
  const value = useMemo(() => {
    const identities = bankIdentitiesByAccount(feeds);
    const accountIds = new Set([
      ...identities.keys(),
      ...profiles
        .filter((p) => p.cash_kind !== "none")
        .map((p) => p.account_id),
    ]);
    return { identities, accountIds, feeds };
  }, [feeds, profiles]);
  return (
    <BankIdentityContext.Provider value={value}>
      <div className={className}>{children}</div>
    </BankIdentityContext.Provider>
  );
}

export function useAccountingBankIdentity() {
  return useContext(BankIdentityContext);
}

export function AccountingAccountLogo({
  accountId,
  name,
  size,
  className,
}: {
  accountId: string;
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const { identities } = useAccountingBankIdentity();
  const identity = identities.get(accountId);
  return (
    <InstitutionLogo
      institution={identity?.institution || identity?.name}
      name={name}
      size={size}
      className={className}
    />
  );
}

export function AccountingAccountLabel({
  accountId,
  name,
  size = 22,
  showInstitution = false,
  className,
}: {
  accountId: string;
  name: string;
  size?: number;
  showInstitution?: boolean;
  className?: string;
}) {
  const { identities } = useAccountingBankIdentity();
  const institution = identities.get(accountId)?.institution;
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <AccountingAccountLogo accountId={accountId} name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate" title={name}>
          {name}
        </span>
        {showInstitution && institution && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {institution}
          </span>
        )}
      </span>
    </span>
  );
}
