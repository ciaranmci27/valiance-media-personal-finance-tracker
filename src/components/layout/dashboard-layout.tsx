"use client";

import * as React from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { DemoBanner } from "@/components/ui/demo-banner";
import { ToastContainer } from "@/components/ui/toast";
import { PrivacyProvider } from "@/contexts/privacy-context";
import { isDemoMode } from "@/lib/demo";
import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  children: React.ReactNode;
  /** Initial privacy state from server (read from cookie during SSR) */
  initialPrivacyHidden: boolean;
  accountingTestMode?: boolean;
}

export function DashboardLayout({
  children,
  initialPrivacyHidden,
  accountingTestMode=false,
}: DashboardLayoutProps) {
  const isDemo = isDemoMode();

  return (
    <PrivacyProvider initialHidden={initialPrivacyHidden}>
      <div className="min-h-screen">
        <Sidebar />
        <div className="relative z-10 lg:ml-60">
          {isDemo && !accountingTestMode && <DemoBanner />}
          <main
            className={cn(
              "px-4 lg:px-6 pb-6 pt-5 lg:pt-7",
              // Clear the fixed h-9 announcement bar
              isDemo && !accountingTestMode && "pt-14 lg:pt-16"
            )}
          >
            {children}
          </main>
        </div>
        <ToastContainer />
      </div>
    </PrivacyProvider>
  );
}
