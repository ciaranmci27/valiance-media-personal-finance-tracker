"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "next/navigation";
import { Bell, Zap } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { getDemoNotifications, getDemoUnreadCount } from "@/lib/demo/data";
import type { Notification } from "@/types/database";

const PANEL_WIDTH = 320;

interface NotificationDropdownProps {
  initialNotifications?: Notification[];
  initialUnreadCount?: number;
}

export function NotificationDropdown({
  initialNotifications = [],
  initialUnreadCount = 0,
}: NotificationDropdownProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Notification[]>(initialNotifications);
  const [unreadCount, setUnreadCount] = React.useState(initialUnreadCount);
  const [isLoading, setIsLoading] = React.useState(false);
  // Panel position, computed from the trigger when opening. The panel renders
  // through a portal on document.body so ancestor transforms/overflow can
  // never clip or re-anchor it; it opens below the trigger, right-aligned.
  const [panelPos, setPanelPos] = React.useState<{ left: number; top: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Fetch unread count on mount and when pathname changes (navigation)
  React.useEffect(() => {
    const fetchUnreadCount = async () => {
      // Use demo data in demo mode
      if (isDemoMode()) {
        setUnreadCount(getDemoUnreadCount());
        return;
      }

      const supabase = createClient();
      try {
        const { count } = await supabase
          .from("notifications")
          .select("*", { count: "exact", head: true })
          .eq("is_read", false);

        if (count !== null) {
          setUnreadCount(count);
        }
      } catch (error) {
        console.error("Error fetching unread count:", error);
      }
    };

    fetchUnreadCount();
  }, [pathname]);

  // Close when clicking outside the trigger and the portaled panel
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close on navigation
  React.useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  // Fetch notifications when dropdown opens
  const fetchNotifications = async () => {
    setIsLoading(true);

    // Use demo data in demo mode
    if (isDemoMode()) {
      setNotifications(getDemoNotifications({ limit: 10 }));
      setUnreadCount(getDemoUnreadCount());
      setIsLoading(false);
      return;
    }

    const supabase = createClient();

    try {
      // Fetch notifications and unread count in parallel
      const [notificationsResult, countResult] = await Promise.all([
        supabase
          .from("notifications")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("notifications")
          .select("*", { count: "exact", head: true })
          .eq("is_read", false),
      ]);

      if (notificationsResult.data) {
        setNotifications(notificationsResult.data as Notification[]);
      }
      if (countResult.count !== null) {
        setUnreadCount(countResult.count);
      }
    } catch (error) {
      console.error("Error fetching notifications:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpen = () => {
    if (!isOpen) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        // Below the bell, right-aligned to it; clamped so it stays on-screen
        // at narrow widths.
        const left = Math.max(
          16,
          Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 16)
        );
        const top = rect.bottom + 8;
        setPanelPos({ left, top });
      }
      fetchNotifications();
    }
    setIsOpen(!isOpen);
  };

  const handleMarkAsRead = async (id: string) => {
    // In demo mode, just update local state
    if (isDemoMode()) {
      setNotifications(
        notifications.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      return;
    }

    const supabase = createClient();

    try {
      await supabase.from("notifications").update({ is_read: true }).eq("id", id);

      setNotifications(
        notifications.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

  const handleMarkAllAsRead = async () => {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);

    if (unreadIds.length === 0) return;

    // In demo mode, just update local state
    if (isDemoMode()) {
      setNotifications(notifications.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
      return;
    }

    const supabase = createClient();

    try {
      await supabase.from("notifications").update({ is_read: true }).in("id", unreadIds);

      setNotifications(notifications.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.is_read) {
      await handleMarkAsRead(notification.id);
    }

    if (notification.link) {
      router.push(notification.link);
    }

    setIsOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleOpen}
        className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        aria-label={
          unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"
        }
      >
        <Bell size={18} aria-hidden />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen &&
        panelPos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ left: panelPos.left, top: panelPos.top, width: PANEL_WIDTH }}
            className="fixed z-[60] max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-card shadow-[var(--shadow-overlay)] overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="font-medium">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllAsRead}
                  className="text-xs text-teal-light hover:underline"
                >
                  Mark all as read
                </button>
              )}
            </div>

            {/* Notifications List */}
            <div className="max-h-96 overflow-y-auto">
              {isLoading ? (
                <div className="py-8 text-center text-zinc-500">
                  <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full mx-auto mb-2" />
                  Loading...
                </div>
              ) : notifications.length === 0 ? (
                <div className="py-8 text-center text-zinc-500">
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06]">
                    <Bell className="h-5 w-5" aria-hidden />
                  </div>
                  <p className="text-sm">No notifications yet</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {notifications.map((notification) => (
                    <button
                      key={notification.id}
                      onClick={() => handleNotificationClick(notification)}
                      className={cn(
                        "w-full text-left px-4 py-3 hover:bg-secondary/50 transition-colors",
                        !notification.is_read && "bg-primary/10"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <div
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
                            !notification.is_read ? "bg-primary/15" : "bg-white/[0.06]"
                          )}
                        >
                          <Zap
                            className={cn(
                              "h-4 w-4",
                              !notification.is_read
                                ? "text-teal-light"
                                : "text-muted-foreground"
                            )}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className={cn(
                              "text-sm font-medium truncate",
                              !notification.is_read && "text-foreground"
                            )}
                          >
                            {notification.title}
                          </p>
                          {notification.message && (
                            <p className="text-xs text-zinc-500 line-clamp-2 mt-0.5">
                              {notification.message}
                            </p>
                          )}
                          <p className="text-xs text-zinc-500 mt-1">
                            {formatDate(notification.created_at)}
                          </p>
                        </div>
                        {!notification.is_read && (
                          <div className="h-2 w-2 rounded-full bg-primary shrink-0 mt-2" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
