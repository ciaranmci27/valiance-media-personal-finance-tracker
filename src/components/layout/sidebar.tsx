"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  CircleDollarSign,
  ReceiptText,
  PiggyBank,
  Landmark,
  BookOpen,
  Users2,
  Zap,
  Layers,
  LogOut,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { PAYROLL_ENABLED, ACCOUNTING_ENABLED } from "@/lib/env";

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
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
    title: "Tax Estimator",
    href: "/tax-payments",
    icon: Landmark,
  },
  ...(PAYROLL_ENABLED
    ? [
        {
          title: "Payroll",
          href: "/payroll",
          icon: Users2,
        },
      ]
    : []),
  ...(ACCOUNTING_ENABLED ? [{ title: "Accounting", href: "/accounting", icon: BookOpen }] : []),
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

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  // Mobile drawer state is owned here; page headers open it by dispatching
  // an "open-sidebar" window event (see MobileMenuButton in page-header.tsx).
  const [mobileOpen, setMobileOpen] = React.useState(false);
  React.useEffect(() => {
    const open = () => setMobileOpen(true);
    window.addEventListener("open-sidebar", open);
    return () => window.removeEventListener("open-sidebar", open);
  }, []);

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
    const hasMoreSpecificMatch = navItems.some((item) => {
      if (item.href === href || item.href === "/") return false;
      const itemMatches =
        pathname === item.href || pathname.startsWith(item.href + "/");
      return itemMatches && item.href.length > href.length;
    });

    return !hasMoreSpecificMatch;
  };

  const handleMobileClose = () => {
    setMobileOpen(false);
  };

  const handleNavClick = () => {
    // Close mobile sidebar when navigating
    setMobileOpen(false);
  };

  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const initials = siteConfig.realName
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <>
      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={handleMobileClose}
          aria-hidden="true"
        />
      )}

      {/* data-theme="dark" pins the rail to the dark palette in both themes;
          the dark token block's [data-theme="dark"] selector re-scopes every
          var for this subtree. */}
      <aside
        data-theme="dark"
        className={cn(
          "fixed top-0 left-0 h-full w-60 glass-sidebar flex flex-col z-50",
          "transform transition-transform duration-200 ease-out",
          "lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo header, h-16 so its border aligns with the page header */}
        <div className="flex items-center justify-between h-16 px-5 border-b border-white/[0.06]">
          <Link href="/" className="flex items-center" onClick={handleNavClick}>
            <Image
              src={siteConfig.logos.horizontalInverted}
              alt={siteConfig.companyName}
              width={3443}
              height={820}
              sizes="152px"
              className="h-9 w-auto"
              style={{ width: "auto", height: 36 }}
              priority
            />
          </Link>
          <button
            onClick={handleMobileClose}
            className="lg:hidden p-1 text-zinc-400 hover:text-white"
            aria-label="Close menu"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto sidebar-scroll">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={handleNavClick}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150",
                  active
                    ? "bg-primary/15 text-teal-light glow-brand-soft"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                )}
              >
                <span className="relative flex-shrink-0 leading-none">
                  <Icon size={18} aria-hidden />
                </span>
                <span className="text-sm font-medium flex-1">{item.title}</span>
              </Link>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-white/5">
          <Link
            href="/settings"
            onClick={handleNavClick}
            className={cn(
              "flex items-center gap-3 px-2 py-2 rounded-lg transition-colors",
              settingsActive ? "bg-primary/15 glow-brand-soft" : "hover:bg-white/5"
            )}
          >
            <span
              className="w-6 h-6 rounded-full bg-primary text-white text-xs font-medium flex items-center justify-center flex-shrink-0"
              aria-hidden="true"
            >
              {initials}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-zinc-200 truncate">
                {siteConfig.realName}
              </span>
              <span
                className={cn(
                  "block text-xs truncate",
                  settingsActive ? "text-teal-light" : "text-zinc-500"
                )}
              >
                Owner
              </span>
            </span>
          </Link>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-2 py-2 mt-1 rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
          >
            <LogOut size={16} aria-hidden />
            <span className="text-sm">Sign out</span>
          </button>
        </div>
      </aside>
    </>
  );
}
