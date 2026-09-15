"use client";

import * as React from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { BootProvider } from "@/components/layout/boot";
import { DemoBanner } from "@/components/ui/demo-banner";
import { ToastContainer } from "@/components/ui/toast";
import { PrivacyProvider } from "@/contexts/privacy-context";
import { AccessProvider, useAccess } from "@/contexts/access-context";
import { isDemoMode } from "@/lib/demo";
import { cn } from "@/lib/utils";
import type { AccessContext } from "@/lib/access-control";

interface DashboardLayoutProps {
  children: React.ReactNode;
  accountingTestMode?: boolean;
  /** The signed-in member and permissions, resolved by the server layout. */
  initialAccess: AccessContext;
  /** Demo mode or the local auth bypass: profile writes stay in memory. */
  syntheticAccess?: boolean;
}

/** The privacy eye reads and writes the signed-in member's row. */
function AccountPrivacyProvider({ children }: { children: React.ReactNode }) {
  const { member, updateMe, synthetic } = useAccess();
  const persist = React.useCallback(
    (hidden: boolean) => updateMe({ privacy_hidden: hidden }),
    [updateMe],
  );
  return (
    <PrivacyProvider
      initialHidden={member.privacy_hidden}
      persist={synthetic ? undefined : persist}
    >
      {children}
    </PrivacyProvider>
  );
}

export function DashboardLayout({
  children,
  accountingTestMode = false,
  initialAccess,
  syntheticAccess = false,
}: DashboardLayoutProps) {
  const isDemo = isDemoMode();

  return (
    <AccessProvider initialAccess={initialAccess} synthetic={syntheticAccess}>
      <AccountPrivacyProvider>
        <BootProvider>
          <div className="min-h-screen">
            <Sidebar />
            <div className="relative z-10 lg:ml-60">
              {isDemo && !accountingTestMode && <DemoBanner />}
              <main
                className={cn(
                  "px-4 lg:px-6 pb-6 pt-5 lg:pt-7",
                  // Clear the fixed h-9 announcement bar
                  isDemo && !accountingTestMode && "pt-14 lg:pt-16",
                )}
              >
                {children}
              </main>
            </div>
            <ToastContainer />
          </div>
        </BootProvider>
      </AccountPrivacyProvider>
    </AccessProvider>
  );
}
