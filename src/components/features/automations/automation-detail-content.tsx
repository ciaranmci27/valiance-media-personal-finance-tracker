"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Pencil,
  Save,
  Trash2,
  X,
  Zap,
  Mail,
  Bell,
  Calendar,
  Clock,
  Globe,
  History,
  Play,
  Pause,
  Rocket,
  Loader2,
  CheckCircle,
  XCircle,
  Repeat,
  CalendarClock,
  MousePointerClick,
  ChevronRight,
  AtSign,
  FileText,
  Send,
  Link as LinkIcon,
  Users,
  Reply,
  Code,
  Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Select, CustomSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmailTagsInput } from "@/components/ui/email-tags-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type {
  AutomationFull,
  AutomationRun,
  EmailActionConfig,
  NotificationActionConfig,
  ScheduleTriggerConfig,
} from "@/types/database";

interface AutomationDetailContentProps {
  automation: AutomationFull;
}

type TriggerType = "schedule" | "manual";

// Common timezones
const timezones = [
  { value: "America/New_York", label: "Eastern Time (ET)" },
  { value: "America/Chicago", label: "Central Time (CT)" },
  { value: "America/Denver", label: "Mountain Time (MT)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
  { value: "America/Phoenix", label: "Arizona (MST)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HST)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST)" },
  { value: "UTC", label: "UTC" },
];

const frequencyOptions = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

const daysOfWeek = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const months = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
];

const dayOptions = Array.from({ length: 28 }, (_, i) => i + 1);

// Generate time options grouped by hour with 15-minute intervals
const generateTimeOptions = () => {
  const options = [];

  for (let h = 0; h < 24; h++) {
    const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const ampm = h < 12 ? "AM" : "PM";

    // Add hour header
    options.push({
      value: `header-${h}`,
      label: `${displayHour} ${ampm}`,
      isGroupHeader: true,
    });

    // Add 15-minute intervals for this hour
    for (const m of [0, 15, 30, 45]) {
      const time = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
      const display = `${displayHour}:${m.toString().padStart(2, "0")} ${ampm}`;
      options.push({ value: time, label: display });
    }
  }

  return options;
};

const timeOptions = generateTimeOptions();

interface ActionItem {
  id: string;
  type: "email" | "notification";
  config: EmailActionConfig | NotificationActionConfig;
  isNew?: boolean;
}

function calculateNextRun(config: ScheduleTriggerConfig): string {
  const now = new Date();
  const [hours, minutes] = config.time.split(":").map(Number);
  let nextRun = new Date(now);
  nextRun.setHours(hours, minutes, 0, 0);

  switch (config.frequency) {
    case "daily":
      if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
      break;
    case "weekly":
      const targetDay = config.day_of_week ?? 1;
      const currentDay = nextRun.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0 || (daysUntil === 0 && nextRun <= now)) daysUntil += 7;
      nextRun.setDate(nextRun.getDate() + daysUntil);
      break;
    case "monthly":
      nextRun.setDate(config.day_of_month ?? 1);
      if (nextRun <= now) nextRun.setMonth(nextRun.getMonth() + 1);
      break;
    case "quarterly":
      const quarterMonths = config.months ?? [1, 4, 7, 10];
      nextRun.setDate(config.day_of_month ?? 1);
      let found = false;
      for (let i = 0; i < 12 && !found; i++) {
        const checkMonth = ((now.getMonth() + i) % 12) + 1;
        if (quarterMonths.includes(checkMonth)) {
          nextRun.setMonth(checkMonth - 1);
          if (i > 0 || nextRun > now) found = true;
        }
      }
      if (nextRun <= now) nextRun.setFullYear(nextRun.getFullYear() + 1);
      break;
    case "yearly":
      nextRun.setMonth((config.month ?? 1) - 1);
      nextRun.setDate(config.day_of_month ?? 1);
      if (nextRun <= now) nextRun.setFullYear(nextRun.getFullYear() + 1);
      break;
  }

  return nextRun.toISOString();
}

function getOrdinalSuffix(day: number) {
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
}

function getScheduleDescription(config: ScheduleTriggerConfig) {
  const timeLabel =
    timeOptions.find((t) => t.value === config.time)?.label ?? config.time;
  let schedule = "";

  switch (config.frequency) {
    case "daily":
      schedule = `Every day at ${timeLabel}`;
      break;
    case "weekly":
      const dayName =
        daysOfWeek.find((d) => d.value === config.day_of_week)?.label ??
        "Monday";
      schedule = `Every ${dayName} at ${timeLabel}`;
      break;
    case "monthly":
      schedule = `On the ${config.day_of_month}${getOrdinalSuffix(config.day_of_month ?? 1)} of every month at ${timeLabel}`;
      break;
    case "quarterly":
      schedule = `On the ${config.day_of_month}${getOrdinalSuffix(config.day_of_month ?? 1)} every quarter at ${timeLabel}`;
      break;
    case "yearly":
      const monthName =
        months.find((m) => m.value === config.month)?.label ?? "January";
      schedule = `On ${monthName} ${config.day_of_month}${getOrdinalSuffix(config.day_of_month ?? 1)} every year at ${timeLabel}`;
      break;
    default:
      schedule = `On the ${config.day_of_month ?? 1}${getOrdinalSuffix(config.day_of_month ?? 1)} of every month at ${timeLabel}`;
  }

  if (config.duration_type === "count" && config.run_count) {
    const remaining = config.run_count - (config.runs_completed ?? 0);
    schedule += ` (${remaining} runs remaining)`;
  } else if (config.duration_type === "until" && config.run_until) {
    schedule += ` (until ${new Date(config.run_until).toLocaleDateString()})`;
  }

  return schedule;
}

function RunStatusBadge({ status }: { status: AutomationRun["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        status === "success" && "bg-success/10 text-success",
        status === "failed" && "bg-error/10 text-error",
        status === "running" && "bg-blue-500/10 text-blue-500"
      )}
    >
      {status === "success" && <CheckCircle className="h-3 w-3" />}
      {status === "failed" && <XCircle className="h-3 w-3" />}
      {status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
    </span>
  );
}

// Workflow connector line
function ConnectorLine() {
  return (
    <div className="flex justify-center py-2">
      <div className="w-0.5 h-8 bg-border relative">
        <ChevronRight className="absolute -bottom-1 left-1/2 -translate-x-1/2 rotate-90 h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}

export function AutomationDetailContent({
  automation,
}: AutomationDetailContentProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isRunning, setIsRunning] = React.useState(false);

  const isScheduleTrigger = automation.trigger_type === "schedule";
  const triggerConfig = automation.trigger_config as ScheduleTriggerConfig;

  // Form state
  const [name, setName] = React.useState(automation.name);
  const [description, setDescription] = React.useState(
    automation.description || ""
  );

  // Trigger type state
  const [triggerType, setTriggerType] = React.useState<TriggerType>(
    automation.trigger_type as TriggerType
  );

  // Schedule state (only used for schedule trigger)
  const [frequency, setFrequency] = React.useState<ScheduleTriggerConfig["frequency"]>(
    isScheduleTrigger ? triggerConfig.frequency || "monthly" : "monthly"
  );
  const [time, setTime] = React.useState(
    isScheduleTrigger ? triggerConfig.time : "09:00"
  );
  const [timezone, setTimezone] = React.useState(
    isScheduleTrigger ? triggerConfig.timezone : "America/New_York"
  );
  const [dayOfWeek, setDayOfWeek] = React.useState(
    isScheduleTrigger ? triggerConfig.day_of_week ?? 1 : 1
  );
  const [dayOfMonth, setDayOfMonth] = React.useState(
    isScheduleTrigger ? triggerConfig.day_of_month ?? 1 : 1
  );
  const [month, setMonth] = React.useState(
    isScheduleTrigger ? triggerConfig.month ?? 1 : 1
  );

  // Duration state
  const [durationType, setDurationType] = React.useState<ScheduleTriggerConfig["duration_type"]>(
    isScheduleTrigger ? triggerConfig.duration_type || "forever" : "forever"
  );
  const [runCount, setRunCount] = React.useState(
    isScheduleTrigger ? triggerConfig.run_count ?? 10 : 10
  );
  const [runUntil, setRunUntil] = React.useState(
    isScheduleTrigger ? triggerConfig.run_until ?? "" : ""
  );

  // Actions state
  const [actions, setActions] = React.useState<ActionItem[]>(
    automation.automation_actions.map((a) => ({
      id: a.id,
      type: a.action_type,
      config: a.action_config as EmailActionConfig | NotificationActionConfig,
    }))
  );

  const addAction = (type: "email" | "notification") => {
    const newAction: ActionItem = {
      id: crypto.randomUUID(),
      type,
      config:
        type === "email"
          ? { to: "", subject: "", body: "" }
          : { title: "", message: "", link: "" },
      isNew: true,
    };
    setActions([...actions, newAction]);
  };

  const updateAction = (
    id: string,
    config: EmailActionConfig | NotificationActionConfig
  ) => {
    setActions(actions.map((a) => (a.id === id ? { ...a, config } : a)));
  };

  const removeAction = (id: string) => {
    setActions(actions.filter((a) => a.id !== id));
  };

  const buildTriggerConfig = (): ScheduleTriggerConfig | Record<string, never> => {
    if (triggerType === "manual") {
      return {};
    }

    const config: ScheduleTriggerConfig = {
      frequency,
      time,
      timezone,
      duration_type: durationType,
      runs_completed: isScheduleTrigger ? triggerConfig.runs_completed ?? 0 : 0,
    };

    if (frequency === "weekly") config.day_of_week = dayOfWeek;
    if (["monthly", "quarterly", "yearly"].includes(frequency))
      config.day_of_month = dayOfMonth;
    if (frequency === "quarterly") config.months = [1, 4, 7, 10];
    if (frequency === "yearly") config.month = month;
    if (durationType === "count") config.run_count = runCount;
    if (durationType === "until") config.run_until = runUntil;

    return config;
  };

  const handleSave = async () => {
    // In demo mode, show message and exit edit mode
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      const newTriggerConfig = buildTriggerConfig();
      const nextRunAt =
        triggerType === "schedule"
          ? calculateNextRun(newTriggerConfig as ScheduleTriggerConfig)
          : null;

      await supabase
        .from("automations")
        .update({
          name,
          description: description || null,
          trigger_type: triggerType,
          trigger_config: newTriggerConfig,
          next_run_at: nextRunAt,
        })
        .eq("id", automation.id);

      await supabase
        .from("automation_actions")
        .delete()
        .eq("automation_id", automation.id);

      if (actions.length > 0) {
        const actionInserts = actions.map((action, index) => ({
          automation_id: automation.id,
          action_type: action.type,
          action_config: action.config,
          sort_order: index,
        }));
        await supabase.from("automation_actions").insert(actionInserts);
      }

      setIsEditing(false);
      router.refresh();
    } catch (error) {
      console.error("Error saving:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this automation?")) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      router.push("/automations");
      return;
    }

    setIsDeleting(true);
    const supabase = createClient();

    try {
      await supabase
        .from("automations")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", automation.id);
      router.push("/automations");
      router.refresh();
    } catch (error) {
      console.error("Error deleting:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancel = () => {
    setName(automation.name);
    setDescription(automation.description || "");
    setTriggerType(automation.trigger_type as TriggerType);
    if (isScheduleTrigger) {
      setFrequency(triggerConfig.frequency || "monthly");
      setTime(triggerConfig.time);
      setTimezone(triggerConfig.timezone);
      setDayOfWeek(triggerConfig.day_of_week ?? 1);
      setDayOfMonth(triggerConfig.day_of_month ?? 1);
      setMonth(triggerConfig.month ?? 1);
      setDurationType(triggerConfig.duration_type || "forever");
      setRunCount(triggerConfig.run_count ?? 10);
      setRunUntil(triggerConfig.run_until ?? "");
    }
    setActions(
      automation.automation_actions.map((a) => ({
        id: a.id,
        type: a.action_type,
        config: a.action_config as EmailActionConfig | NotificationActionConfig,
      }))
    );
    setIsEditing(false);
  };

  const handleToggleActive = async () => {
    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      return;
    }

    const supabase = createClient();
    const newIsActive = !automation.is_active;

    try {
      await supabase
        .from("automations")
        .update({ is_active: newIsActive })
        .eq("id", automation.id);
      router.refresh();
    } catch (error) {
      console.error("Error toggling automation:", error);
    }
  };

  const handleRunNow = async () => {
    if (!confirm("Run a test of this automation?")) return;

    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Automations can't be run in demo mode. This is just a preview of the functionality.");
      return;
    }

    setIsRunning(true);

    try {
      const supabase = createClient();

      // Use Supabase's built-in function invocation
      const { data, error } = await supabase.functions.invoke("process-automations", {
        body: { automation_id: automation.id },
      });

      if (error) {
        throw error;
      }

      if (data?.processed > 0) {
        router.refresh();
      } else {
        alert(data?.message || "Automation could not be run");
      }
    } catch (error) {
      console.error("Error running automation:", error);
      alert(error instanceof Error ? error.message : "Failed to run automation");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{automation.name}</h1>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
                automation.is_active
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground"
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
                  Inactive
                </>
              )}
            </span>
          </div>
          {automation.description && (
            <p className="text-muted-foreground mt-1">
              {automation.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button variant="ghost" onClick={handleCancel} disabled={isSaving}>
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={handleToggleActive}
                className={automation.is_active ? "text-copper hover:text-copper" : "text-success hover:text-success"}
              >
                {automation.is_active ? (
                  <>
                    <Pause className="h-4 w-4 mr-1" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-1" />
                    Activate
                  </>
                )}
              </Button>
              <Button onClick={() => setIsEditing(true)}>
                <Pencil className="h-4 w-4 mr-1" />
                Edit
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="animate-fade-up stagger-1">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                {isScheduleTrigger ? (
                  <Calendar className="h-5 w-5 text-primary" />
                ) : (
                  <MousePointerClick className="h-5 w-5 text-primary" />
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Trigger</p>
                <p className="text-lg font-semibold">
                  {isScheduleTrigger ? "Schedule" : "Manual"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="animate-fade-up stagger-2">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                {isScheduleTrigger ? (
                  <Repeat className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <Clock className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {isScheduleTrigger ? "Frequency" : "Last Run"}
                </p>
                <p className="text-lg font-semibold">
                  {isScheduleTrigger
                    ? frequencyOptions.find((f) => f.value === triggerConfig.frequency)?.label || "Monthly"
                    : automation.last_run_at
                      ? formatDate(automation.last_run_at)
                      : "Never"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="animate-fade-up stagger-3">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <History className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Runs</p>
                <p className="text-lg font-semibold">
                  {automation.automation_runs.length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Workflow View */}
      <div className="space-y-2">
        {/* Basic Info Card (when editing) */}
        {isEditing && (
          <>
            <Card className="animate-fade-up">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-medium">
                    1
                  </div>
                  <CardTitle className="text-base font-medium flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    Basic Information
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
                <Textarea
                  label="Description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this automation do?"
                />
              </CardContent>
            </Card>
            <ConnectorLine />
          </>
        )}

        {/* Trigger Card */}
        <Card className="animate-fade-up">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              {isEditing && (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-medium">
                  2
                </div>
              )}
              <CardTitle className="text-base font-medium flex items-center gap-2">
                <MousePointerClick className="h-4 w-4 text-muted-foreground" />
                Trigger
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Choose what starts this automation
                </p>

                {/* Trigger Type Selection */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setTriggerType("manual")}
                    className={cn(
                      "flex items-start gap-3 p-4 rounded-lg border-2 transition-all text-left",
                      triggerType === "manual"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-secondary/50"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
                        triggerType === "manual"
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <MousePointerClick className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium">Manual Trigger</p>
                      <p className="text-sm text-muted-foreground">
                        Run manually with a button click
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTriggerType("schedule")}
                    className={cn(
                      "flex items-start gap-3 p-4 rounded-lg border-2 transition-all text-left",
                      triggerType === "schedule"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-secondary/50"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
                        triggerType === "schedule"
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <Calendar className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium">Schedule Trigger</p>
                      <p className="text-sm text-muted-foreground">
                        Run on a recurring schedule
                      </p>
                    </div>
                  </button>
                </div>

                {/* Schedule Configuration */}
                {triggerType === "schedule" && (
                  <div className="space-y-6 pt-4 border-t border-border mt-4">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                        <Repeat className="h-4 w-4" />
                        Frequency
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {frequencyOptions.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() =>
                              setFrequency(opt.value as ScheduleTriggerConfig["frequency"])
                            }
                            className={cn(
                              "px-3 py-2 text-sm font-medium rounded-lg border transition-colors",
                              frequency === opt.value
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border hover:border-primary/50 hover:bg-secondary"
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {frequency === "weekly" && (
                        <Select
                          label="Day of Week"
                          value={dayOfWeek.toString()}
                          onChange={(e) => setDayOfWeek(parseInt(e.target.value))}
                        >
                          {daysOfWeek.map((day) => (
                            <option key={day.value} value={day.value}>
                              {day.label}
                            </option>
                          ))}
                        </Select>
                      )}
                      {["monthly", "quarterly", "yearly"].includes(frequency) && (
                        <Select
                          label="Day of Month"
                          value={dayOfMonth.toString()}
                          onChange={(e) => setDayOfMonth(parseInt(e.target.value))}
                        >
                          {dayOptions.map((day) => (
                            <option key={day} value={day}>
                              {day}
                              {getOrdinalSuffix(day)}
                            </option>
                          ))}
                        </Select>
                      )}
                      {frequency === "yearly" && (
                        <Select
                          label="Month"
                          value={month.toString()}
                          onChange={(e) => setMonth(parseInt(e.target.value))}
                        >
                          {months.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </Select>
                      )}
                      <CustomSelect
                        label="Time"
                        value={time}
                        onChange={setTime}
                        options={timeOptions}
                      />
                      <CustomSelect
                        label="Timezone"
                        value={timezone}
                        onChange={setTimezone}
                        options={timezones}
                      />
                    </div>

                    <div className="space-y-3 pt-4 border-t border-border">
                      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                        <CalendarClock className="h-4 w-4" />
                        Duration
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {(["forever", "count", "until"] as const).map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setDurationType(type)}
                            className={cn(
                              "px-3 py-2 text-sm font-medium rounded-lg border transition-colors",
                              durationType === type
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border hover:border-primary/50 hover:bg-secondary"
                            )}
                          >
                            {type === "forever"
                              ? "Forever"
                              : type === "count"
                                ? "# of Times"
                                : "Until Date"}
                          </button>
                        ))}
                      </div>
                      {durationType === "count" && (
                        <Input
                          type="number"
                          label="Number of times to run"
                          value={runCount.toString()}
                          onChange={(e) => setRunCount(parseInt(e.target.value) || 1)}
                          min={1}
                          max={999}
                        />
                      )}
                      {durationType === "until" && (
                        <Input
                          type="date"
                          label="Run until"
                          value={runUntil}
                          onChange={(e) => setRunUntil(e.target.value)}
                          min={new Date().toISOString().split("T")[0]}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                {isScheduleTrigger ? (
                  <>
                    <p className="text-sm text-muted-foreground mb-3">
                      {getScheduleDescription(triggerConfig)}
                    </p>
                    <div className="flex flex-wrap items-center gap-4 text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        {timezones.find((tz) => tz.value === triggerConfig.timezone)
                          ?.label || triggerConfig.timezone}
                      </span>
                      {automation.next_run_at && (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          Next run: {formatDate(automation.next_run_at)}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This automation runs when manually triggered using the &quot;Run Now&quot; button.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <ConnectorLine />

        {/* Actions Card */}
        <Card className="animate-fade-up">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isEditing && (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-medium">
                    3
                  </div>
                )}
                <CardTitle className="text-base font-medium flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  Actions ({isEditing ? actions.length : automation.automation_actions.length})
                </CardTitle>
              </div>
              {isEditing && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addAction("email")}
                  >
                    <Mail className="h-4 w-4 mr-1" />
                    Email
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addAction("notification")}
                  >
                    <Bell className="h-4 w-4 mr-1" />
                    Notification
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="space-y-3">
                {actions.length === 0 ? (
                  <div className="border-2 border-dashed border-border rounded-lg py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      No actions. Add email or notification actions above.
                    </p>
                  </div>
                ) : (
                  actions.map((action, index) => (
                    <Card key={action.id} className="border-dashed">
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex flex-col items-center gap-1 pt-1">
                            <div
                              className={cn(
                                "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
                                action.type === "email"
                                  ? "bg-blue-500/10 text-blue-500"
                                  : "bg-amber-500/10 text-amber-500"
                              )}
                            >
                              {action.type === "email" ? (
                                <Mail className="h-4 w-4" />
                              ) : (
                                <Bell className="h-4 w-4" />
                              )}
                            </div>
                            <span className="text-xs font-medium text-muted-foreground">
                              #{index + 1}
                            </span>
                          </div>
                          <div className="flex-1 space-y-4">
                            {action.type === "email" ? (
                              <>
                                {/* Recipient */}
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <AtSign className="h-3.5 w-3.5 text-muted-foreground" />
                                    <label className="text-sm font-medium">Recipient Email</label>
                                  </div>
                                  <EmailTagsInput
                                    value={(action.config as EmailActionConfig).to}
                                    onChange={(value) =>
                                      updateAction(action.id, {
                                        ...(action.config as EmailActionConfig),
                                        to: value,
                                      })
                                    }
                                    placeholder="Enter recipient email"
                                    required
                                  />
                                </div>

                                {/* Subject */}
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                                      <label className="text-sm font-medium">Subject Line</label>
                                    </div>
                                    <span className={cn(
                                      "text-xs",
                                      ((action.config as EmailActionConfig).subject?.length || 0) > 60
                                        ? "text-amber-500"
                                        : "text-muted-foreground"
                                    )}>
                                      {(action.config as EmailActionConfig).subject?.length || 0}/60
                                    </span>
                                  </div>
                                  <Input
                                    value={(action.config as EmailActionConfig).subject}
                                    onChange={(e) =>
                                      updateAction(action.id, {
                                        ...(action.config as EmailActionConfig),
                                        subject: e.target.value,
                                      })
                                    }
                                    placeholder="Monthly Report Ready for Review"
                                    required
                                  />
                                </div>

                                {/* Body Format Toggle */}
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                      <label className="text-sm font-medium">Email Body</label>
                                    </div>
                                    <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          updateAction(action.id, {
                                            ...(action.config as EmailActionConfig),
                                            format: "text",
                                          })
                                        }
                                        className={cn(
                                          "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                                          ((action.config as EmailActionConfig).format || "text") === "text"
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground"
                                        )}
                                      >
                                        <Type className="h-3 w-3" />
                                        Plain Text
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          updateAction(action.id, {
                                            ...(action.config as EmailActionConfig),
                                            format: "html",
                                          })
                                        }
                                        className={cn(
                                          "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                                          (action.config as EmailActionConfig).format === "html"
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground"
                                        )}
                                      >
                                        <Code className="h-3 w-3" />
                                        HTML
                                      </button>
                                    </div>
                                  </div>
                                  <Textarea
                                    value={(action.config as EmailActionConfig).body}
                                    onChange={(e) =>
                                      updateAction(action.id, {
                                        ...(action.config as EmailActionConfig),
                                        body: e.target.value,
                                      })
                                    }
                                    placeholder="Email body content..."
                                    className={cn(
                                      "min-h-[120px] text-sm",
                                      (action.config as EmailActionConfig).format === "html" ? "font-mono" : ""
                                    )}
                                    required
                                  />
                                  <p className="text-xs text-muted-foreground">
                                    {(action.config as EmailActionConfig).format === "html"
                                      ? "Write HTML markup for rich formatting. Inline styles recommended."
                                      : "Plain text email. Line breaks will be preserved."}
                                  </p>
                                </div>

                                {/* Additional Options - CC, BCC, Reply-To */}
                                <details className="group">
                                  <summary className="flex items-center gap-2 cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors list-none">
                                    <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                                    <span>Additional Options</span>
                                    {((action.config as EmailActionConfig).cc || (action.config as EmailActionConfig).bcc || (action.config as EmailActionConfig).replyTo) && (
                                      <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                                        configured
                                      </span>
                                    )}
                                  </summary>
                                  <div className="mt-4 space-y-4">
                                    {/* CC */}
                                    <EmailTagsInput
                                      value={(action.config as EmailActionConfig).cc || ""}
                                      onChange={(value) =>
                                        updateAction(action.id, {
                                          ...(action.config as EmailActionConfig),
                                          cc: value || undefined,
                                        })
                                      }
                                      label="CC (optional)"
                                      placeholder="Add CC recipient"
                                      helperText="Carbon copy - visible to all recipients"
                                    />

                                    {/* BCC */}
                                    <EmailTagsInput
                                      value={(action.config as EmailActionConfig).bcc || ""}
                                      onChange={(value) =>
                                        updateAction(action.id, {
                                          ...(action.config as EmailActionConfig),
                                          bcc: value || undefined,
                                        })
                                      }
                                      label="BCC (optional)"
                                      placeholder="Add BCC recipient"
                                      helperText="Blind carbon copy - hidden from other recipients"
                                    />

                                    {/* Reply-To */}
                                    <div className="space-y-1.5">
                                      <div className="flex items-center gap-2">
                                        <Reply className="h-3.5 w-3.5 text-muted-foreground" />
                                        <label className="text-sm font-medium">Reply-To (optional)</label>
                                      </div>
                                      <Input
                                        type="email"
                                        value={(action.config as EmailActionConfig).replyTo || ""}
                                        onChange={(e) =>
                                          updateAction(action.id, {
                                            ...(action.config as EmailActionConfig),
                                            replyTo: e.target.value || undefined,
                                          })
                                        }
                                        placeholder="replies@company.com"
                                      />
                                    </div>
                                  </div>
                                </details>
                              </>
                            ) : (
                              <>
                                {/* Title */}
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                                    <label className="text-sm font-medium">Notification Title</label>
                                  </div>
                                  <Input
                                    value={(action.config as NotificationActionConfig).title}
                                    onChange={(e) =>
                                      updateAction(action.id, {
                                        ...(action.config as NotificationActionConfig),
                                        title: e.target.value,
                                      })
                                    }
                                    placeholder="Report Ready"
                                    required
                                  />
                                </div>

                                {/* Message */}
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                    <label className="text-sm font-medium">Message</label>
                                  </div>
                                  <Textarea
                                    value={(action.config as NotificationActionConfig).message}
                                    onChange={(e) =>
                                      updateAction(action.id, {
                                        ...(action.config as NotificationActionConfig),
                                        message: e.target.value,
                                      })
                                    }
                                    placeholder="Your monthly report is ready for review."
                                    className="min-h-[80px]"
                                    required
                                  />
                                </div>

                                {/* Link */}
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <LinkIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                    <label className="text-sm font-medium">Link (optional)</label>
                                  </div>
                                  <Input
                                    value={(action.config as NotificationActionConfig).link || ""}
                                    onChange={(e) =>
                                      updateAction(action.id, {
                                        ...(action.config as NotificationActionConfig),
                                        link: e.target.value,
                                      })
                                    }
                                    placeholder="/income or /settings"
                                  />
                                </div>
                              </>
                            )}
                          </div>
                          <Tooltip content="Remove action">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-error"
                            onClick={() => removeAction(action.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          </Tooltip>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {automation.automation_actions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No actions configured.
                  </p>
                ) : (
                  automation.automation_actions.map((action) => {
                    const config = action.action_config as
                      | EmailActionConfig
                      | NotificationActionConfig;
                    return (
                      <div
                        key={action.id}
                        className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
                      >
                        <div
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
                            action.action_type === "email"
                              ? "bg-blue-500/10 text-blue-500"
                              : "bg-amber-500/10 text-amber-500"
                          )}
                        >
                          {action.action_type === "email" ? (
                            <Mail className="h-4 w-4" />
                          ) : (
                            <Bell className="h-4 w-4" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          {action.action_type === "email" ? (
                            <>
                              <p className="font-medium text-sm">
                                {(config as EmailActionConfig).subject}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                To: {(config as EmailActionConfig).to}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="font-medium text-sm">
                                {(config as NotificationActionConfig).title}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {(config as NotificationActionConfig).message}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Run History */}
      <Card className="animate-fade-up">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium flex items-center gap-2">
              <History className="h-4 w-4" />
              Recent Runs
            </CardTitle>
            {!isEditing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRunNow}
                disabled={isRunning}
              >
                {isRunning ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Rocket className="h-4 w-4 mr-1" />
                )}
                Test Run
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {automation.automation_runs.length > 0 ? (
            <div className="divide-y divide-border">
              {automation.automation_runs.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <RunStatusBadge status={run.status} />
                    <span className="text-sm text-muted-foreground">
                      {formatDate(run.started_at)}
                    </span>
                  </div>
                  {run.error && (
                    <span className="text-xs text-error max-w-xs truncate">
                      {run.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No runs yet. Click &quot;Test Run&quot; to trigger this automation.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bottom Actions */}
      {isEditing ? (
        <div className="flex md:hidden items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSaving}>
            <X className="h-4 w-4 mr-1" />
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            className="text-error hover:text-error"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Delete
          </Button>
          <Button
            className="md:hidden bg-teal text-white hover:bg-teal/90"
            size="sm"
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
