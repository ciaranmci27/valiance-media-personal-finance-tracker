"use client";

import * as React from "react";
import * as ReactDOM from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Zap,
  Mail,
  Bell,
  Calendar,
  Clock,
  Play,
  Pause,
  MoreHorizontal,
  Eye,
  Trash2,
  Repeat,
  MousePointerClick,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { AutomationWithActions, ScheduleTriggerConfig } from "@/types/database";

interface AutomationsListContentProps {
  automations: AutomationWithActions[];
}

// Summary card component
function SummaryCard({
  icon,
  label,
  value,
  className,
  primary,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  className?: string;
  primary?: boolean;
}) {
  return (
    <Card className={cn("animate-fade-up", className)}>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-lg",
              primary ? "bg-primary/10" : "bg-muted"
            )}
          >
            {icon}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p
              className={cn(
                "text-xl font-bold",
                primary && "text-primary"
              )}
            >
              {value}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Helper functions for schedule display
const getOrdinalSuffix = (day: number) => {
  if (day > 3 && day < 21) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
};

const getFrequencyLabel = (triggerConfig: ScheduleTriggerConfig) => {
  const freq = triggerConfig.frequency || "monthly";
  const labels: Record<string, string> = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
  };
  return labels[freq] || "Monthly";
};

const getScheduleDetail = (triggerConfig: ScheduleTriggerConfig) => {
  const freq = triggerConfig.frequency || "monthly";
  const daysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  switch (freq) {
    case "daily":
      return null;
    case "weekly":
      return daysOfWeek[triggerConfig.day_of_week ?? 1];
    case "monthly":
    case "quarterly":
      const day = triggerConfig.day_of_month ?? 1;
      return `${day}${getOrdinalSuffix(day)}`;
    case "yearly":
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const dayY = triggerConfig.day_of_month ?? 1;
      const month = months[(triggerConfig.month ?? 1) - 1];
      return `${month} ${dayY}${getOrdinalSuffix(dayY)}`;
    default:
      return null;
  }
};

// Mobile card component for automations
function AutomationCard({
  automation,
  index,
  onToggle,
  onDelete,
}: {
  automation: AutomationWithActions;
  index: number;
  onToggle: (id: string, isActive: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const router = useRouter();
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showMenu]);

  const isScheduleTrigger = automation.trigger_type === "schedule";
  const triggerConfig = automation.trigger_config as ScheduleTriggerConfig;
  const emailActions = automation.automation_actions.filter(
    (a) => a.action_type === "email"
  ).length;
  const notificationActions = automation.automation_actions.filter(
    (a) => a.action_type === "notification"
  ).length;

  const handleCardClick = () => {
    router.push(`/automations/${automation.id}`);
  };

  const handleMenuToggle = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowMenu(!showMenu);
  };

  const handleToggleStatus = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle(automation.id, !automation.is_active);
    setShowMenu(false);
  };

  const handleDelete = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete(automation.id);
    setShowMenu(false);
  };

  return (
    <div
      onClick={handleCardClick}
      className={cn(
        "glass-card rounded-xl p-4 cursor-pointer transition-all duration-300",
        "hover:border-primary/30 active:scale-[0.98]",
        "animate-fade-up relative",
        `stagger-${Math.min(index + 1, 6)}`
      )}
    >
      {/* Header: Name and Menu */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg shrink-0",
              automation.is_active ? "bg-primary/10" : "bg-muted"
            )}
          >
            <Zap
              className={cn(
                "h-4 w-4",
                automation.is_active ? "text-primary" : "text-muted-foreground"
              )}
            />
          </div>
          <div className="min-w-0">
            <span className="font-semibold text-foreground block truncate">
              {automation.name}
            </span>
            {automation.description && (
              <span className="text-xs text-muted-foreground truncate block">
                {automation.description}
              </span>
            )}
          </div>
        </div>

        {/* Menu Button */}
        <div className="relative" ref={menuRef}>
          <Tooltip content="Actions">
          <button
            onClick={handleMenuToggle}
            className="p-2 rounded-lg hover:bg-secondary transition-colors"
          >
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </button>
          </Tooltip>

          {showMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
              <Link
                href={`/automations/${automation.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-secondary transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <Eye className="h-4 w-4" />
                View
              </Link>
              <button
                onClick={handleToggleStatus}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
                  automation.is_active
                    ? "text-copper hover:bg-copper/10"
                    : "text-success hover:bg-success/10"
                )}
              >
                {automation.is_active ? (
                  <>
                    <Pause className="h-4 w-4" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Activate
                  </>
                )}
              </button>
              <button
                onClick={handleDelete}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-error hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Info Grid */}
      <div className="border-t border-border/50 pt-3 space-y-2">
        {/* Trigger and Schedule Row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {automation.trigger_type === "manual" ? (
              <>
                <MousePointerClick className="h-3.5 w-3.5" />
                Manual
              </>
            ) : (
              <>
                <Calendar className="h-3.5 w-3.5" />
                Schedule
              </>
            )}
          </div>
          {isScheduleTrigger && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Repeat className="h-3 w-3" />
                {getFrequencyLabel(triggerConfig)}
              </span>
              {getScheduleDetail(triggerConfig) && (
                <span>{getScheduleDetail(triggerConfig)}</span>
              )}
              {triggerConfig.time && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {triggerConfig.time}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions and Status Row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm">
            {emailActions > 0 && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Mail className="h-3.5 w-3.5" />
                {emailActions}
              </span>
            )}
            {notificationActions > 0 && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Bell className="h-3.5 w-3.5" />
                {notificationActions}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              {automation.automation_runs?.length ?? 0} {(automation.automation_runs?.length ?? 0) === 1 ? "run" : "runs"}
            </span>
          </div>

          <button
            onClick={handleToggleStatus}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors",
              automation.is_active
                ? "bg-success/10 text-success"
                : "bg-copper/10 text-copper"
            )}
          >
            {automation.is_active ? (
              <>
                <Play className="h-3 w-3" />
                Active
              </>
            ) : (
              <>
                <Pause className="h-3 w-3" />
                Paused
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function AutomationRow({
  automation,
  index,
  onToggle,
  onDelete,
}: {
  automation: AutomationWithActions;
  index: number;
  onToggle: (id: string, isActive: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [showMenu, setShowMenu] = React.useState(false);
  const [menuPosition, setMenuPosition] = React.useState({ top: 0, left: 0 });
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Update menu position when showing
  const handleToggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!showMenu && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPosition({
        top: rect.bottom + window.scrollY + 4,
        left: rect.right + window.scrollX - 160, // 160 = menu width (w-40)
      });
    }
    setShowMenu(!showMenu);
  };

  const isScheduleTrigger = automation.trigger_type === "schedule";
  const triggerConfig = automation.trigger_config as ScheduleTriggerConfig;
  const emailActions = automation.automation_actions.filter(
    (a) => a.action_type === "email"
  ).length;
  const notificationActions = automation.automation_actions.filter(
    (a) => a.action_type === "notification"
  ).length;

  return (
    <tr
      className={cn(
        "transition-colors hover:bg-secondary/50 cursor-pointer animate-fade-up",
        `stagger-${Math.min(index + 1, 6)}`
      )}
    >
      <td className="px-4 py-3">
        <Link
          href={`/automations/${automation.id}`}
          className="flex items-center gap-3 group"
        >
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
              automation.is_active ? "bg-primary/10" : "bg-muted"
            )}
          >
            <Zap
              className={cn(
                "h-4 w-4",
                automation.is_active ? "text-primary" : "text-muted-foreground"
              )}
            />
          </div>
          <div className="min-w-0">
            <span className="font-medium text-foreground group-hover:text-primary transition-colors block truncate">
              {automation.name}
            </span>
            {automation.description && (
              <span className="text-sm text-muted-foreground truncate block">
                {automation.description}
              </span>
            )}
          </div>
        </Link>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {automation.trigger_type === "manual" ? (
            <>
              <MousePointerClick className="h-3.5 w-3.5" />
              Manual
            </>
          ) : (
            <>
              <Calendar className="h-3.5 w-3.5" />
              Schedule
            </>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        {isScheduleTrigger ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Repeat className="h-3.5 w-3.5" />
              {getFrequencyLabel(triggerConfig)}
            </span>
            {getScheduleDetail(triggerConfig) && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {getScheduleDetail(triggerConfig)}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {triggerConfig.time}
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 text-sm">
          {emailActions > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              {emailActions}
            </span>
          )}
          {notificationActions > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Bell className="h-3.5 w-3.5" />
              {notificationActions}
            </span>
          )}
          {emailActions === 0 && notificationActions === 0 && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          {automation.automation_runs?.length ?? 0}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(automation.id, !automation.is_active);
          }}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors",
            automation.is_active
              ? "bg-success/10 text-success hover:bg-success/20"
              : "bg-copper/10 text-copper hover:bg-copper/20"
          )}
        >
          {automation.is_active ? (
            <>
              <Play className="h-3 w-3" />
              Active
            </>
          ) : (
            <>
              <Pause className="h-3 w-3" />
              Paused
            </>
          )}
        </button>
      </td>
      <td className="px-4 py-3 text-right">
        <Tooltip content="Actions">
        <Button
          ref={buttonRef}
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleToggleMenu}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        </Tooltip>

        {showMenu &&
          typeof document !== "undefined" &&
          ReactDOM.createPortal(
            <div
              ref={menuRef}
              className="fixed z-50 w-40 rounded-lg border border-border bg-card shadow-lg"
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
              }}
            >
              <Link
                href={`/automations/${automation.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-secondary transition-colors rounded-t-lg"
                onClick={() => setShowMenu(false)}
              >
                <Eye className="h-4 w-4" />
                View
              </Link>
              <button
                onClick={() => {
                  onToggle(automation.id, !automation.is_active);
                  setShowMenu(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
                  automation.is_active
                    ? "text-copper hover:bg-copper/10"
                    : "text-success hover:bg-success/10"
                )}
              >
                {automation.is_active ? (
                  <>
                    <Pause className="h-4 w-4" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Activate
                  </>
                )}
              </button>
              <button
                onClick={() => {
                  onDelete(automation.id);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-error hover:bg-destructive/10 transition-colors rounded-b-lg"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            </div>,
            document.body
          )}
      </td>
    </tr>
  );
}

export function AutomationsListContent({
  automations,
}: AutomationsListContentProps) {
  const router = useRouter();

  const handleToggle = async (id: string, isActive: boolean) => {
    const supabase = createClient();

    try {
      await supabase
        .from("automations")
        .update({ is_active: isActive })
        .eq("id", id);
      router.refresh();
    } catch (error) {
      console.error("Error toggling automation:", error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this automation?")) return;

    const supabase = createClient();

    try {
      await supabase
        .from("automations")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      router.refresh();
    } catch (error) {
      console.error("Error deleting automation:", error);
    }
  };

  const activeCount = automations.filter((a) => a.is_active).length;
  const inactiveCount = automations.length - activeCount;
  const totalRuns = automations.reduce(
    (sum, a) => sum + (a.automation_runs?.length ?? 0),
    0
  );

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <SummaryCard
          icon={<Play className="h-5 w-5 text-success" />}
          label="Active"
          value={activeCount}
          className="stagger-1"
        />
        <SummaryCard
          icon={<Pause className="h-5 w-5 text-copper" />}
          label="Paused"
          value={inactiveCount}
          className="stagger-2"
        />
        <SummaryCard
          icon={<Zap className="h-5 w-5 text-primary" />}
          label="Automations"
          value={automations.length}
          className="stagger-3"
        />
        <SummaryCard
          icon={<History className="h-5 w-5 text-primary" />}
          label="Total Runs"
          value={totalRuns}
          className="stagger-4 border-primary/30"
          primary
        />
      </div>

      {/* Table / Cards */}
      {automations.length > 0 ? (
        <>
          {/* Mobile: Card Layout */}
          <div className="lg:hidden space-y-3">
            {automations.map((automation, index) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                index={index}
                onToggle={handleToggle}
                onDelete={handleDelete}
              />
            ))}
          </div>

          {/* Desktop: Table Layout */}
          <Card className="hidden lg:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                        Automation
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                        Trigger
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                        Schedule
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                        Actions
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                        Runs
                      </th>
                      <th className="px-4 py-3 text-center text-sm font-medium text-muted-foreground">
                        Status
                      </th>
                      <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground w-12"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {automations.map((automation, index) => (
                      <AutomationRow
                        key={automation.id}
                        automation={automation}
                        index={index}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="animate-fade-up">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Zap className="h-6 w-6 text-primary" />
              </div>
            </div>
            <h3 className="text-lg font-medium mb-2">No automations yet</h3>
            <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
              Create your first automation to schedule recurring emails and
              notifications.
            </p>
            <Link href="/automations/new">
              <Button>
                <Plus className="h-4 w-4" />
                Create Automation
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Add Automation Button */}
      {automations.length > 0 && (
        <div className="flex justify-center">
          <Link href="/automations/new">
            <Button>
              <Plus className="h-4 w-4" />
              Create New
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
