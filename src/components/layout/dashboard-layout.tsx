"use client";

import * as React from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { DemoBanner } from "@/components/ui/demo-banner";
import { PrivacyProvider } from "@/contexts/privacy-context";
import { isDemoMode } from "@/lib/demo";
import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  children: React.ReactNode;
  /** Initial privacy state from server (read from cookie during SSR) */
  initialPrivacyHidden: boolean;
  /** Initial sidebar state from server (read from cookie during SSR) */
  initialSidebarCollapsed: boolean;
}

/**
 * Helper to set a cookie
 */
function setCookie(name: string, value: string, days: number = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

export function DashboardLayout({
  children,
  initialPrivacyHidden,
  initialSidebarCollapsed,
}: DashboardLayoutProps) {
  // Initialize with server-provided value to prevent flash
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(initialSidebarCollapsed);
  // Mobile sidebar state
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // On mount, sync with DOM attribute (set by blocking script from localStorage)
  // Only override server value if localStorage explicitly set a value
  React.useEffect(() => {
    const domAttr = document.documentElement.getAttribute("data-sidebar-collapsed");
    // If DOM attribute exists (localStorage had a value), use it
    // Otherwise, trust the server-provided value from cookie
    if (domAttr !== null) {
      setSidebarCollapsed(domAttr === "true");
    }
  }, []);

  // Handle sidebar collapse change - persist to localStorage and cookie
  const handleSidebarCollapsedChange = React.useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    // Store in localStorage for blocking script on next page load
    localStorage.setItem("sidebar-collapsed", String(collapsed));
    // Store in cookie for SSR on next page load
    setCookie("sidebar-collapsed", String(collapsed));
    // Update DOM attribute for CSS
    document.documentElement.setAttribute("data-sidebar-collapsed", String(collapsed));
  }, []);

  const isDemo = isDemoMode();

  return (
    <PrivacyProvider initialHidden={initialPrivacyHidden}>
      <div className="min-h-screen">
        <Sidebar
          collapsed={sidebarCollapsed}
          onCollapsedChange={handleSidebarCollapsedChange}
          mobileOpen={mobileOpen}
          onMobileOpenChange={setMobileOpen}
        />
        <div
          className={cn(
            "relative z-10 transition-all duration-300",
            // Desktop: margin based on sidebar state
            sidebarCollapsed ? "md:ml-16" : "md:ml-64",
            // Mobile: no margin (sidebar is overlay)
            "ml-0"
          )}
        >
          <Header onMobileMenuClick={() => setMobileOpen(true)} />
          <main className={cn("px-4 md:px-6 pb-6 pt-6", isDemo && "pb-14")}>
            {children}
          </main>
          {isDemo && <DemoBanner sidebarCollapsed={sidebarCollapsed} />}
        </div>
      </div>
    </PrivacyProvider>
  );
}
