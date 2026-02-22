"use client";

import * as React from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Eye, EyeOff, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { NotificationDropdown } from "./notification-dropdown";

// Map paths to page titles
const pageTitles: Record<string, string> = {
  "/": "Dashboard",
  "/income": "Income",
  "/income/new": "Income Entry",
  "/income/sources": "Income Sources",
  "/expenses": "Fixed Expenses",
  "/expenses/new": "New Expense",
  "/net-worth": "Net Worth",
  "/net-worth/new": "Net Worth Entry",
  "/automations": "Automations",
  "/automations/new": "New Automation",
  "/settings": "Settings",
  "/settings/account": "Account Settings",
  "/settings/appearance": "Appearance",
  "/settings/data": "Data Management",
  "/settings/trash": "Trash",
};

interface HeaderProps {
  onMobileMenuClick?: () => void;
}

export function Header({ onMobileMenuClick }: HeaderProps) {
  const pathname = usePathname();
  const { isHidden, toggleHidden } = usePrivacy();

  // Initialize with null to indicate "not yet determined"
  const [theme, setTheme] = React.useState<"light" | "dark" | null>(null);
  // Track if privacy state is loaded to prevent flash
  const [privacyLoaded, setPrivacyLoaded] = React.useState(false);

  // Set privacy loaded after mount
  React.useEffect(() => {
    setPrivacyLoaded(true);
  }, []);

  // Get page title from pathname
  const pageTitle = React.useMemo(() => {
    // Check exact match first
    if (pageTitles[pathname]) return pageTitles[pathname];

    // Check if it's a dynamic route (e.g., /income/[id])
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const basePath = `/${segments[0]}`;
      if (pageTitles[basePath]) {
        // Check if it's a sources detail page
        if (segments[1] === "sources" && segments[2]) {
          return "Edit Income Source";
        }
        // Check if it's an expense detail page
        if (segments[0] === "expenses" && segments[1]) {
          return "Expense Details";
        }
        // Check if it's an income detail page
        if (segments[0] === "income" && segments[1]) {
          return "Income Entry";
        }
        // Check if it's a net-worth detail page
        if (segments[0] === "net-worth" && segments[1]) {
          return "Net Worth Entry";
        }
        return `${pageTitles[basePath]} Details`;
      }
    }

    return "Valiance Admin";
  }, [pathname]);

  // Read actual theme from DOM on mount and listen for changes
  React.useEffect(() => {
    const currentTheme = document.documentElement.getAttribute("data-theme") as "light" | "dark" | null;
    setTheme(currentTheme === "light" ? "light" : "dark");

    // Listen for theme changes (from appearance settings)
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "data-theme") {
          const newTheme = document.documentElement.getAttribute("data-theme") as "light" | "dark" | null;
          setTheme(newTheme === "light" ? "light" : "dark");
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  const toggleTheme = () => {
    if (!theme) return;
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    localStorage.setItem("theme", newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
  };

  // Determine display theme (default to dark during SSR/initial render)
  const displayTheme = theme ?? "dark";

  // Pages with custom headers - show mobile header bar, hide on desktop
  const isSettingsPage = pathname.startsWith("/settings");
  const isIncomeSourcesPage = pathname === "/income/sources";
  const isIncomePage = pathname.startsWith("/income/") && pathname !== "/income/sources";
  const isExpensePage = pathname.startsWith("/expenses/");
  const isAutomationPage = pathname.startsWith("/automations/") || pathname === "/automations/new";
  const isNetWorthPage = pathname.startsWith("/net-worth/");
  const hasCustomHeader = isSettingsPage || isIncomeSourcesPage || isIncomePage || isExpensePage || isAutomationPage || isNetWorthPage;

  // For custom header pages, show mobile header bar (hidden on desktop where page has its own header)
  if (hasCustomHeader) {
    return (
      <header className="md:hidden sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border/50 px-4 bg-background">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMobileMenuClick}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold text-foreground">{pageTitle}</h1>
        </div>

        <div className="flex items-center gap-1">
          <NotificationDropdown />

          {/* Privacy Toggle */}
          <Tooltip content={isHidden ? "Show data" : "Hide data"}>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleHidden}
              className={cn(!privacyLoaded && "opacity-0")}
            >
              {isHidden ? (
                <EyeOff className="h-5 w-5" />
              ) : (
                <Eye className="h-5 w-5" />
              )}
            </Button>
          </Tooltip>
        </div>
      </header>
    );
  }

  return (
    <header
      className="sticky top-0 z-50 md:static flex h-16 items-center justify-between border-b border-border/50 px-4 md:px-6 bg-background md:bg-gradient-to-b md:from-primary/5 md:to-transparent"
    >
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onMobileMenuClick}
          className="md:hidden"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h1 className="text-lg md:text-xl font-semibold text-foreground">{pageTitle}</h1>
      </div>

      <div className="flex items-center gap-1 md:gap-2">
        {/* Notifications */}
        <NotificationDropdown />

        {/* Privacy Toggle - hide/show sensitive data */}
        <Tooltip content={isHidden ? "Show data" : "Hide data"}>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleHidden}
            className={cn(!privacyLoaded && "opacity-0")}
          >
            {isHidden ? (
              <EyeOff className="h-5 w-5" />
            ) : (
              <Eye className="h-5 w-5" />
            )}
          </Button>
        </Tooltip>

        {/* Theme Toggle - hidden on mobile, hidden until theme is determined to prevent flash */}
        <Tooltip content={`Switch to ${displayTheme === "dark" ? "light" : "dark"} mode`}>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className={cn("hidden md:inline-flex", !theme && "opacity-0")}
          >
            <Image
              src={displayTheme === "dark" ? "/dark.png" : "/light.png"}
              alt={displayTheme === "dark" ? "Dark mode" : "Light mode"}
              width={24}
              height={24}
              className="h-6 w-6"
            />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
