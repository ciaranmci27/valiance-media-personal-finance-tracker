"use client";

import * as React from "react";
import { Menu, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrivacy } from "@/contexts/privacy-context";
import { Tooltip } from "@/components/ui/tooltip";
import { NotificationDropdown } from "./notification-dropdown";

/**
 * Integrated page header. Lives in the content flow; there is no sticky
 * chrome bar. Title and subtitle on the left, page actions on the right.
 * Global chrome (notifications, privacy, theme, user) lives in the sidebar.
 *
 * The dashboard layout's <main> supplies horizontal padding and top spacing,
 * so this component only owns its internal rhythm.
 */

/**
 * Mobile-only hamburger that opens the sidebar drawer via a window event
 * (the sidebar listens for "open-sidebar"). Exported separately so pages
 * with hand-rolled heading rows can embed it inline before their title.
 */
export function MobileMenuButton({ className }: { className?: string }) {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event("open-sidebar"))}
      className={cn(
        "lg:hidden p-2 -ml-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0",
        className
      )}
      aria-label="Open menu"
    >
      <Menu size={20} aria-hidden />
    </button>
  );
}

/**
 * Global header controls: notification bell + privacy eye. PageHeader renders
 * this automatically; pages with hand-rolled heading rows embed it inline at
 * the end of their row (use className="ml-auto" when the row has no
 * justify-between).
 */
export function HeaderControls({ className }: { className?: string }) {
  const { isHidden, toggleHidden } = usePrivacy();
  // Deferred until mount to avoid a flash of the wrong privacy icon
  const [privacyLoaded, setPrivacyLoaded] = React.useState(false);
  React.useEffect(() => {
    setPrivacyLoaded(true);
  }, []);

  return (
    <div className={cn("flex items-center gap-1 flex-shrink-0", className)}>
      <NotificationDropdown />
      <Tooltip content={isHidden ? "Show data" : "Hide data"} position="bottom">
        <button
          onClick={toggleHidden}
          className={cn(
            "p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors",
            !privacyLoaded && "opacity-0"
          )}
          aria-label={isHidden ? "Show data" : "Hide data"}
        >
          {isHidden ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </Tooltip>
    </div>
  );
}

interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="pb-1">
      <div className="flex items-center justify-between gap-3 lg:gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <MobileMenuButton />
          <div className="min-w-0">
            <h1 className="text-2xl lg:text-[26px] font-bold text-white tracking-tight leading-tight truncate">
              {title}
            </h1>
            {subtitle && (
              <div className="text-sm text-muted-foreground mt-1">{subtitle}</div>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 lg:gap-3 flex-shrink-0">
          {actions}
          <HeaderControls />
        </div>
      </div>
    </div>
  );
}
