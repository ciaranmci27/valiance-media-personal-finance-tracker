"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  CircleDollarSign,
  ReceiptText,
  PiggyBank,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogOut,
  X,
  Layers,
  Zap,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Tooltip } from "@/components/ui/tooltip";
import { isDemoMode } from "@/lib/demo";

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  {
    title: "Dashboard",
    href: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Income",
    href: "/income",
    icon: CircleDollarSign,
  },
  {
    title: "Expenses",
    href: "/expenses",
    icon: ReceiptText,
  },
  {
    title: "Net Worth",
    href: "/net-worth",
    icon: PiggyBank,
  },
  {
    title: "Automations",
    href: "/automations",
    icon: Zap,
  },
  {
    title: "Sources",
    href: "/income/sources",
    icon: Layers,
  },
];

const bottomNavItems: NavItem[] = [
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
  },
];

interface SidebarProps {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}

export function Sidebar({
  collapsed = false,
  onCollapsedChange,
  mobileOpen = false,
  onMobileOpenChange,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = React.useState<"light" | "dark" | null>(null);

  // Read theme from DOM on mount
  React.useEffect(() => {
    const currentTheme = document.documentElement.getAttribute("data-theme") as "light" | "dark" | null;
    setTheme(currentTheme === "light" ? "light" : "dark");

    // Listen for theme changes (from header toggle)
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

  const displayTheme = theme ?? "dark";

  const handleCollapse = () => {
    onCollapsedChange?.(!collapsed);
  };

  const handleSignOut = async () => {
    // In demo mode, just redirect without calling Supabase
    if (isDemoMode()) {
      router.push("/login");
      return;
    }

    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  // Check if nav item is active (including sub-pages)
  const isActive = (href: string) => {
    // Dashboard: exact match only
    if (href === "/") return pathname === "/";

    // Check if pathname matches this href or is a sub-page
    const isMatch = pathname === href || pathname.startsWith(href + "/");
    if (!isMatch) return false;

    // Check if there's a more specific nav item that also matches
    // (e.g., /income/sources should win over /income when on /income/sources)
    const allItems = [...navItems, ...bottomNavItems];
    const hasMoreSpecificMatch = allItems.some((item) => {
      if (item.href === href || item.href === "/") return false;
      const itemMatches =
        pathname === item.href || pathname.startsWith(item.href + "/");
      return itemMatches && item.href.length > href.length;
    });

    return !hasMoreSpecificMatch;
  };

  const handleMobileClose = () => {
    onMobileOpenChange?.(false);
  };

  const handleNavClick = () => {
    // Close mobile sidebar when navigating
    if (mobileOpen) {
      onMobileOpenChange?.(false);
    }
  };

  return (
    <>
      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={handleMobileClose}
        />
      )}

      <div className="group">
        {/* Toggle - slides out from sidebar edge on hover (desktop only) */}
        <button
          onClick={handleCollapse}
          className={cn(
            "fixed top-1/2 z-50 hidden md:flex",
            "h-8 w-3 items-center justify-center",
            "rounded-r-md bg-card border border-l-0 border-border",
            "text-muted-foreground hover:text-primary hover:bg-secondary",
            "transition-all duration-300 ease-out",
            "opacity-0 -translate-y-1/2 -translate-x-full",
            "group-hover:opacity-100 group-hover:translate-x-0",
            collapsed ? "left-16" : "left-64"
          )}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>

        <aside
          className={cn(
            "fixed left-0 top-0 z-50 h-screen transition-all duration-300",
            "glass-strong flex flex-col border-r border-border overflow-hidden",
            // Desktop: show based on collapsed state
            "md:translate-x-0",
            collapsed ? "md:w-16" : "md:w-64",
            // Mobile: show/hide based on mobileOpen, always full width
            "w-64",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
      {/* Logo - switches based on theme */}
      <div className="flex h-16 items-center justify-between border-b border-border px-4">
        {/* Desktop: Logo based on collapsed state */}
        <div className="hidden md:block">
          {!collapsed && (
            <Link href="/" className="flex items-center gap-2" onClick={handleNavClick}>
              <Image
                src={displayTheme === "dark" ? siteConfig.logos.horizontalInverted : siteConfig.logos.horizontal}
                alt={siteConfig.companyName}
                width={140}
                height={32}
                className="h-8 w-auto"
                priority
              />
            </Link>
          )}
          {collapsed && (
            <Link href="/" className="mx-auto" onClick={handleNavClick}>
              <Image
                src={siteConfig.logos.icon}
                alt={siteConfig.companyName}
                width={32}
                height={32}
                className="h-8 w-8 rounded-lg"
                priority
              />
            </Link>
          )}
        </div>

        {/* Mobile: Logo on left */}
        <Link href="/" className="md:hidden flex items-center gap-2" onClick={handleNavClick}>
          <Image
            src={displayTheme === "dark" ? siteConfig.logos.horizontalInverted : siteConfig.logos.horizontal}
            alt={siteConfig.companyName}
            width={140}
            height={32}
            className="h-8 w-auto"
            priority
          />
        </Link>

        {/* Mobile close button on right */}
        <button
          onClick={handleMobileClose}
          className="md:hidden flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden p-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);

          return (
            <Tooltip
              key={item.href}
              content={item.title}
              position="right"
              disabled={!collapsed}
            >
              <Link
                href={item.href}
                onClick={handleNavClick}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  collapsed && "md:justify-center md:px-2"
                )}
              >
                <Icon className={cn("h-5 w-5 shrink-0", active && "text-primary")} />
                <span className={cn("whitespace-nowrap", collapsed && "md:hidden")}>{item.title}</span>
              </Link>
            </Tooltip>
          );
        })}

        {/* Mobile: Settings and Sign Out in main nav area */}
        <div className="md:hidden space-y-1">
          {bottomNavItems.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={handleNavClick}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="whitespace-nowrap">{item.title}</span>
              </Link>
            );
          })}

          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className="whitespace-nowrap">Sign Out</span>
          </button>
        </div>
      </nav>

      {/* Bottom Navigation - Desktop only */}
      <div className="hidden md:flex md:flex-col border-t border-border p-3 space-y-1">
        {bottomNavItems.map((item) => {
          const Icon = item.icon;
          const active = pathname.startsWith(item.href);

          return (
            <Tooltip
              key={item.href}
              content={item.title}
              position="right"
              disabled={!collapsed}
            >
              <Link
                href={item.href}
                onClick={handleNavClick}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  collapsed && "justify-center px-2"
                )}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className={cn("whitespace-nowrap", collapsed && "hidden")}>{item.title}</span>
              </Link>
            </Tooltip>
          );
        })}

        <Tooltip content="Sign Out" position="right" disabled={!collapsed}>
          <button
            onClick={handleSignOut}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
              "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
              collapsed && "justify-center px-2"
            )}
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className={cn("whitespace-nowrap", collapsed && "hidden")}>Sign Out</span>
          </button>
        </Tooltip>
      </div>

      </aside>
      </div>
    </>
  );
}
