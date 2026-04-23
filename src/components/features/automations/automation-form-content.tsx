"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus,
  Loader2,
  Mail,
  Bell,
  Trash2,
  Zap,
  Calendar,
  Clock,
  Repeat,
  CalendarClock,
  MousePointerClick,
  ChevronRight,
  Check,
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
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmailTagsInput } from "@/components/ui/email-tags-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { cn } from "@/lib/utils";
import type {
  EmailActionConfig,
  NotificationActionConfig,
  PayrollDepositType,
  PayrollEventTriggerConfig,
  PayrollEventType,
  PayrollFormType,
  ScheduleTriggerConfig,
  TriggerConfig,
} from "@/types/database";
import type {
  PayrollEmployee,
  PayrollTaxDeposit,
  PayrollForm,
} from "@/types/payroll";
import { computeNextPayrollEvent } from "@/lib/payroll/next-event";

interface ActionItem {
  id: string;
  type: "email" | "notification";
  config: EmailActionConfig | NotificationActionConfig;
}

type TriggerType = "schedule" | "manual" | "payroll_event";

const PAYROLL_EVENT_OPTIONS: {
  value: PayrollEventType;
  label: string;
  description: string;
}[] = [
  {
    value: "pay_date",
    label: "Pay date",
    description: "The day employees are deposited",
  },
  {
    value: "ach_send_date",
    label: "ACH send date",
    description: "2 banking days before the pay date",
  },
  {
    value: "period_end",
    label: "Period end",
    description: "Last day of the work period",
  },
  {
    value: "deposit_due",
    label: "Tax deposit due",
    description: "941, FUTA, state withholding, SUTA, SDI",
  },
  {
    value: "form_due",
    label: "Form filing due",
    description: "941, 940, W-2, W-3, A1-QRT, A1-APR",
  },
];

const DEPOSIT_TYPE_OPTIONS: { value: PayrollDepositType; label: string }[] = [
  { value: "any", label: "Any deposit type" },
  { value: "federal_941", label: "Federal 941 (withholding + FICA)" },
  { value: "federal_940", label: "FUTA" },
  { value: "state_withholding", label: "State withholding" },
  { value: "state_suta", label: "SUTA" },
  { value: "state_sdi", label: "SDI" },
];

const FORM_TYPE_OPTIONS: { value: PayrollFormType; label: string }[] = [
  { value: "any", label: "Any form" },
  { value: "941", label: "Form 941" },
  { value: "940", label: "Form 940" },
  { value: "w2", label: "Form W-2" },
  { value: "w3", label: "Form W-3" },
  { value: "a1_qrt", label: "Form A1-QRT" },
  { value: "a1_apr", label: "Form A1-APR" },
];

const OFFSET_OPTIONS: { value: number; label: string }[] = [
  { value: -10080, label: "1 week before" },
  { value: -4320, label: "3 days before" },
  { value: -2880, label: "2 days before" },
  { value: -1440, label: "1 day before (24 hours)" },
  { value: -720, label: "12 hours before" },
  { value: -180, label: "3 hours before" },
  { value: 0, label: "At the event time" },
  { value: 1440, label: "1 day after" },
];

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

// Get current date/time components in a specific timezone
function getDatePartsInTimezone(
  date: Date,
  timezone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  // Fallback to UTC if timezone is invalid
  let tz = timezone;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    console.warn(`Invalid timezone "${timezone}", falling back to UTC`);
    tz = "UTC";
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) return 0;
    if (type === "weekday") {
      const dayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      return dayMap[part.value] ?? 0;
    }
    return parseInt(part.value, 10);
  };

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    dayOfWeek: getPart("weekday"),
  };
}

// Convert a local date/time in a specific timezone to UTC ISO string
function localToUTC(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timezone: string
): string {
  // Create a rough UTC date to calculate the timezone offset
  const roughUTC = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Get what this UTC time looks like in the target timezone
  const tzParts = getDatePartsInTimezone(roughUTC, timezone);

  // Calculate offset: how many ms difference between UTC and local
  const tzAsUTC = new Date(
    Date.UTC(
      tzParts.year,
      tzParts.month - 1,
      tzParts.day,
      tzParts.hour,
      tzParts.minute,
      0
    )
  );
  const offsetMs = roughUTC.getTime() - tzAsUTC.getTime();

  // The local time we want expressed as if it were UTC
  const targetLocalAsUTC = new Date(
    Date.UTC(year, month - 1, day, hours, minutes, 0)
  );

  // Apply offset to get actual UTC time
  const actualUTC = new Date(targetLocalAsUTC.getTime() + offsetMs);

  return actualUTC.toISOString();
}

// Get number of days in a month
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// Calculate next run time based on trigger config (timezone-aware)
function calculateNextRun(config: ScheduleTriggerConfig): string {
  const {
    frequency,
    time,
    timezone,
    day_of_week: targetDayOfWeek = 0,
    day_of_month: targetDayOfMonth = 1,
    months: quarterlyMonths = [1, 4, 7, 10],
    month: targetMonth = 1,
  } = config;

  const [targetHours, targetMinutes] = time.split(":").map(Number);

  // Get current time in the target timezone
  const now = new Date();
  const current = getDatePartsInTimezone(now, timezone);

  // Check if the target time has already passed today
  const isTimePassed =
    current.hour > targetHours ||
    (current.hour === targetHours && current.minute >= targetMinutes);

  let nextYear = current.year;
  let nextMonth = current.month;
  let nextDay = current.day;

  switch (frequency) {
    case "daily": {
      // If time passed today, move to tomorrow
      if (isTimePassed) {
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const tomorrowParts = getDatePartsInTimezone(tomorrow, timezone);
        nextYear = tomorrowParts.year;
        nextMonth = tomorrowParts.month;
        nextDay = tomorrowParts.day;
      }
      break;
    }

    case "weekly": {
      // Calculate days until target day of week
      let daysUntil = targetDayOfWeek - current.dayOfWeek;
      if (daysUntil < 0 || (daysUntil === 0 && isTimePassed)) {
        daysUntil += 7;
      }
      const targetDate = new Date(
        now.getTime() + daysUntil * 24 * 60 * 60 * 1000
      );
      const targetParts = getDatePartsInTimezone(targetDate, timezone);
      nextYear = targetParts.year;
      nextMonth = targetParts.month;
      nextDay = targetParts.day;
      break;
    }

    case "monthly": {
      nextDay = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, nextMonth));
      // If we've passed this day/time this month, move to next month
      if (
        current.day > targetDayOfMonth ||
        (current.day === targetDayOfMonth && isTimePassed)
      ) {
        nextMonth++;
        if (nextMonth > 12) {
          nextMonth = 1;
          nextYear++;
        }
        nextDay = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, nextMonth));
      }
      break;
    }

    case "quarterly": {
      // Find the next quarterly month (default to standard quarters if empty)
      const monthsToUse =
        quarterlyMonths.length > 0 ? quarterlyMonths : [1, 4, 7, 10];
      const sortedMonths = [...monthsToUse].sort((a, b) => a - b);
      let foundNext = false;

      for (const qMonth of sortedMonths) {
        if (qMonth > current.month) {
          nextMonth = qMonth;
          foundNext = true;
          break;
        } else if (qMonth === current.month) {
          const dayToCheck = Math.min(
            targetDayOfMonth,
            getDaysInMonth(nextYear, qMonth)
          );
          if (
            current.day < dayToCheck ||
            (current.day === dayToCheck && !isTimePassed)
          ) {
            nextMonth = qMonth;
            foundNext = true;
            break;
          }
        }
      }

      if (!foundNext) {
        // Move to first quarterly month of next year
        nextYear++;
        nextMonth = sortedMonths[0];
      }

      nextDay = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, nextMonth));
      break;
    }

    case "yearly": {
      nextMonth = targetMonth;
      nextDay = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, nextMonth));

      // Check if this year's date has passed
      if (
        current.month > targetMonth ||
        (current.month === targetMonth && current.day > targetDayOfMonth) ||
        (current.month === targetMonth &&
          current.day === targetDayOfMonth &&
          isTimePassed)
      ) {
        nextYear++;
        nextDay = Math.min(
          targetDayOfMonth,
          getDaysInMonth(nextYear, nextMonth)
        );
      }
      break;
    }
  }

  // Convert the calculated local time to UTC
  return localToUTC(
    nextYear,
    nextMonth,
    nextDay,
    targetHours,
    targetMinutes,
    timezone
  );
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

// Workflow node wrapper
function WorkflowNode({
  number,
  title,
  icon: Icon,
  isComplete,
  children,
  className,
}: {
  number: number;
  title: string;
  icon: React.ElementType;
  isComplete?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("relative", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium",
              isComplete
                ? "bg-success/10 text-success"
                : "bg-primary/10 text-primary"
            )}
          >
            {isComplete ? <Check className="h-4 w-4" /> : number}
          </div>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base font-medium">{title}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function AutomationFormContent() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Form state
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  // Trigger state
  const [triggerType, setTriggerType] = React.useState<TriggerType | null>(null);

  // Schedule state (for schedule trigger)
  const [frequency, setFrequency] =
    React.useState<ScheduleTriggerConfig["frequency"]>("monthly");
  const [time, setTime] = React.useState("09:00");
  const [timezone, setTimezone] = React.useState("America/New_York");
  const [dayOfWeek, setDayOfWeek] = React.useState(1);
  const [dayOfMonth, setDayOfMonth] = React.useState(1);
  const [month, setMonth] = React.useState(1);

  // Duration state
  const [durationType, setDurationType] =
    React.useState<ScheduleTriggerConfig["duration_type"]>("forever");
  const [runCount, setRunCount] = React.useState(10);
  const [runUntil, setRunUntil] = React.useState("");

  // Payroll event trigger state
  const [payrollEvent, setPayrollEvent] =
    React.useState<PayrollEventType>("pay_date");
  const [payrollOffsetMinutes, setPayrollOffsetMinutes] =
    React.useState<number>(-1440);
  const [payrollEmployeeId, setPayrollEmployeeId] = React.useState<string>("");
  const [payrollDepositType, setPayrollDepositType] =
    React.useState<PayrollDepositType>("any");
  const [payrollFormType, setPayrollFormType] =
    React.useState<PayrollFormType>("any");
  const [payrollEmployees, setPayrollEmployees] = React.useState<
    PayrollEmployee[]
  >([]);
  const [payrollDeposits, setPayrollDeposits] = React.useState<
    PayrollTaxDeposit[]
  >([]);
  const [payrollForms, setPayrollForms] = React.useState<PayrollForm[]>([]);

  // Load payroll data eagerly on mount so we can decide whether to SHOW the
  // Payroll Event trigger option (hidden entirely when no active employees
  // exist), and to drive the scope dropdown / live preview when the trigger
  // is selected. Employees, deposits, and forms are all pulled so every event
  // type works immediately without another fetch.
  React.useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    void (async () => {
      const [emps, deps, forms] = await Promise.all([
        supabase
          .from("payroll_employees")
          .select("*")
          .eq("status", "active")
          .is("deleted_at", null),
        supabase
          .from("payroll_tax_deposits")
          .select("*")
          .is("deleted_at", null),
        supabase.from("payroll_forms").select("*").is("deleted_at", null),
      ]);
      if (cancelled) return;
      setPayrollEmployees((emps.data ?? []) as PayrollEmployee[]);
      setPayrollDeposits((deps.data ?? []) as PayrollTaxDeposit[]);
      setPayrollForms((forms.data ?? []) as PayrollForm[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Gate the Payroll Event trigger option. If the only active employees get
  // removed after the user has already selected "payroll_event", fall back
  // to "manual" so the form doesn't end up in a dead-end state.
  const hasActiveEmployees = payrollEmployees.length > 0;
  React.useEffect(() => {
    if (triggerType === "payroll_event" && !hasActiveEmployees) {
      setTriggerType(null);
    }
  }, [triggerType, hasActiveEmployees]);

  // Actions state
  const [actions, setActions] = React.useState<ActionItem[]>([]);

  const addAction = (type: "email" | "notification") => {
    const newAction: ActionItem = {
      id: crypto.randomUUID(),
      type,
      config:
        type === "email"
          ? { to: "", subject: "", body: "" }
          : { title: "", message: "", link: "" },
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

  const buildTriggerConfig = (): TriggerConfig => {
    if (triggerType === "manual") {
      return {};
    }

    if (triggerType === "payroll_event") {
      const config: PayrollEventTriggerConfig = {
        event: payrollEvent,
        offset_minutes: payrollOffsetMinutes,
        fire_time: time,
        timezone,
        duration_type: durationType,
        runs_completed: 0,
      };
      if (
        payrollEvent === "pay_date" ||
        payrollEvent === "ach_send_date" ||
        payrollEvent === "period_end"
      ) {
        if (payrollEmployeeId) config.employee_id = payrollEmployeeId;
      }
      if (payrollEvent === "deposit_due") {
        config.deposit_type = payrollDepositType;
      }
      if (payrollEvent === "form_due") {
        config.form_type = payrollFormType;
      }
      if (durationType === "count") config.run_count = runCount;
      if (durationType === "until") config.run_until = runUntil;
      return config;
    }

    const config: ScheduleTriggerConfig = {
      frequency,
      time,
      timezone,
      duration_type: durationType,
      runs_completed: 0,
    };

    if (frequency === "weekly") {
      config.day_of_week = dayOfWeek;
    }
    if (["monthly", "quarterly", "yearly"].includes(frequency)) {
      config.day_of_month = dayOfMonth;
    }
    if (frequency === "quarterly") {
      config.months = [1, 4, 7, 10];
    }
    if (frequency === "yearly") {
      config.month = month;
    }
    if (durationType === "count") {
      config.run_count = runCount;
    }
    if (durationType === "until") {
      config.run_until = runUntil;
    }

    return config;
  };

  // Compute the next fire time for the payroll_event trigger, used in the
  // live preview. Recomputes whenever any relevant field changes.
  const payrollPreview = React.useMemo(() => {
    if (triggerType !== "payroll_event") return null;
    try {
      const cfg: PayrollEventTriggerConfig = {
        event: payrollEvent,
        offset_minutes: payrollOffsetMinutes,
        fire_time: time,
        timezone,
        duration_type: "forever",
        employee_id:
          payrollEvent === "pay_date" ||
          payrollEvent === "ach_send_date" ||
          payrollEvent === "period_end"
            ? payrollEmployeeId || null
            : null,
        deposit_type:
          payrollEvent === "deposit_due" ? payrollDepositType : null,
        form_type: payrollEvent === "form_due" ? payrollFormType : null,
      };
      return computeNextPayrollEvent(cfg, new Date(), {
        employees: payrollEmployees,
        deposits: payrollDeposits,
        forms: payrollForms,
      });
    } catch {
      return null;
    }
  }, [
    triggerType,
    payrollEvent,
    payrollOffsetMinutes,
    time,
    timezone,
    payrollEmployeeId,
    payrollDepositType,
    payrollFormType,
    payrollEmployees,
    payrollDeposits,
    payrollForms,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !triggerType || actions.length === 0) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      router.push("/automations");
      return;
    }

    setIsSubmitting(true);
    const supabase = createClient();

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const triggerConfig = buildTriggerConfig();
      let nextRunAt: string | null = null;
      let finalTriggerConfig: TriggerConfig = triggerConfig;
      if (triggerType === "schedule") {
        nextRunAt = calculateNextRun(triggerConfig as ScheduleTriggerConfig);
      } else if (triggerType === "payroll_event") {
        // Compute the initial next_run_at plus event context so the first
        // firing already has the right template variables available.
        const preview = computeNextPayrollEvent(
          triggerConfig as PayrollEventTriggerConfig,
          new Date(),
          {
            employees: payrollEmployees,
            deposits: payrollDeposits,
            forms: payrollForms,
          },
        );
        if (preview) {
          nextRunAt = preview.fire_at;
          finalTriggerConfig = {
            ...(triggerConfig as PayrollEventTriggerConfig),
            next_event_context: preview.context,
          };
        }
      }

      const { data: automation, error: automationError } = await supabase
        .from("automations")
        .insert({
          user_id: user.id,
          name: name.trim(),
          description: description.trim() || null,
          trigger_type: triggerType,
          trigger_config: finalTriggerConfig,
          next_run_at: nextRunAt,
        })
        .select()
        .single();

      if (automationError) throw automationError;

      if (automation && actions.length > 0) {
        const actionInserts = actions.map((action, index) => ({
          automation_id: automation.id,
          action_type: action.type,
          action_config: action.config,
          sort_order: index,
        }));

        const { error: actionsError } = await supabase
          .from("automation_actions")
          .insert(actionInserts);

        if (actionsError) throw actionsError;
      }

      router.push("/automations");
      router.refresh();
    } catch (error) {
      console.error("Error creating automation:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = name.trim() && triggerType && actions.length > 0;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Zap className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">New Automation</h1>
          <p className="text-sm text-muted-foreground">
            Build a workflow with a trigger and actions
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        {/* Step 1: Basic Info */}
        <WorkflowNode
          number={1}
          title="Basic Information"
          icon={Zap}
          isComplete={!!name.trim()}
          className="animate-fade-up stagger-1"
        >
          <div className="space-y-4">
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Monthly Report Reminder"
              required
            />
            <Textarea
              label="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this automation do?"
            />
          </div>
        </WorkflowNode>

        <ConnectorLine />

        {/* Step 2: Select Trigger */}
        <WorkflowNode
          number={2}
          title="Select Trigger"
          icon={MousePointerClick}
          isComplete={!!triggerType}
          className="animate-fade-up stagger-2"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose what starts this automation
            </p>

            {/* Trigger Type Selection. Payroll Event is hidden when there
                are no active employees, so the grid collapses to 2 columns. */}
            <div
              className={cn(
                "grid grid-cols-1 gap-3",
                hasActiveEmployees ? "sm:grid-cols-3" : "sm:grid-cols-2",
              )}
            >
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

              {hasActiveEmployees && (
                <button
                  type="button"
                  onClick={() => setTriggerType("payroll_event")}
                  className={cn(
                    "flex items-start gap-3 p-4 rounded-lg border-2 transition-all text-left",
                    triggerType === "payroll_event"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-secondary/50"
                  )}
                >
                  <div
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
                      triggerType === "payroll_event"
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    <CalendarClock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-medium">Payroll Event</p>
                    <p className="text-sm text-muted-foreground">
                      Fire relative to pay dates, deposits, forms
                    </p>
                  </div>
                </button>
              )}
            </div>

            {/* Payroll Event Configuration */}
            {triggerType === "payroll_event" && (
              <div className="space-y-6 pt-4 border-t border-border mt-4">
                {/* Event type */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <CalendarClock className="h-4 w-4" />
                    Event
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {PAYROLL_EVENT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setPayrollEvent(opt.value)}
                        className={cn(
                          "text-left px-3 py-2 rounded-lg border transition-colors",
                          payrollEvent === opt.value
                            ? "border-primary bg-primary/10"
                            : "border-border hover:border-primary/50 hover:bg-secondary"
                        )}
                      >
                        <div className="text-sm font-medium">{opt.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {opt.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Scope (depends on event) */}
                {(payrollEvent === "pay_date" ||
                  payrollEvent === "ach_send_date" ||
                  payrollEvent === "period_end") && (
                  <CustomSelect
                    label="Which employee(s)?"
                    value={payrollEmployeeId || "__all__"}
                    onChange={(v) =>
                      setPayrollEmployeeId(v === "__all__" ? "" : v)
                    }
                    options={[
                      { value: "__all__", label: "Any employee" },
                      ...payrollEmployees.map((e) => ({
                        value: e.id,
                        label: `${e.first_name} ${e.last_name}`.trim(),
                      })),
                    ]}
                  />
                )}

                {payrollEvent === "deposit_due" && (
                  <CustomSelect
                    label="Which deposit type?"
                    value={payrollDepositType}
                    onChange={(v) =>
                      setPayrollDepositType(v as PayrollDepositType)
                    }
                    options={DEPOSIT_TYPE_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                    }))}
                  />
                )}

                {payrollEvent === "form_due" && (
                  <CustomSelect
                    label="Which form?"
                    value={payrollFormType}
                    onChange={(v) => setPayrollFormType(v as PayrollFormType)}
                    options={FORM_TYPE_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                    }))}
                  />
                )}

                {/* Offset */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <CustomSelect
                    label="When to fire"
                    value={String(payrollOffsetMinutes)}
                    onChange={(v) => setPayrollOffsetMinutes(parseInt(v, 10))}
                    options={OFFSET_OPTIONS.map((o) => ({
                      value: String(o.value),
                      label: o.label,
                    }))}
                  />
                  <CustomSelect
                    label="Fire at this time"
                    value={time}
                    onChange={setTime}
                    options={timeOptions}
                  />
                </div>

                <CustomSelect
                  label="Timezone"
                  value={timezone}
                  onChange={setTimezone}
                  options={timezones}
                />

                {/* Preview */}
                <div
                  className={cn(
                    "rounded-lg border p-4 space-y-1.5",
                    payrollPreview
                      ? "border-primary/20 bg-primary/5"
                      : "border-border bg-muted/20"
                  )}
                >
                  <div className="text-xs font-semibold uppercase tracking-wider text-primary">
                    Next fire
                  </div>
                  {payrollPreview ? (
                    <>
                      <p className="text-sm text-foreground">
                        {new Date(payrollPreview.fire_at).toLocaleString(
                          "en-US",
                          {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: timezone,
                            timeZoneName: "short",
                          },
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Based on{" "}
                        <span className="text-foreground font-medium">
                          {payrollPreview.context.event_type.replace(
                            /_/g,
                            " ",
                          )}
                        </span>
                        {payrollPreview.context.employee_name &&
                          ` for ${payrollPreview.context.employee_name}`}{" "}
                        on{" "}
                        <span className="text-foreground font-medium">
                          {payrollPreview.context.event_date}
                        </span>
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No upcoming events match this configuration yet. Verify
                      you have active employees / unpaid deposits / unfiled
                      forms for the selected scope.
                    </p>
                  )}
                </div>

                {/* Template variables hint */}
                <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
                  <div className="font-semibold text-foreground">
                    Template variables you can use in email / notification
                    bodies:
                  </div>
                  <code className="block font-mono text-[11px] leading-5">
                    {"{{event_type}}"} {"{{event_date}}"}{" "}
                    {"{{employee_name}}"} {"{{amount}}"} {"{{link}}"}{" "}
                    {"{{deposit_type}}"} {"{{form_type}}"}
                  </code>
                </div>

                {/* Duration (shared shape with schedule triggers) */}
                <div className="space-y-3 pt-4 border-t border-border">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Repeat className="h-4 w-4" />
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
                    <NumberInput
                      integer
                      min={1}
                      max={999}
                      label="Number of times to run"
                      value={runCount.toString()}
                      onChange={(e) =>
                        setRunCount(parseInt(e.target.value) || 1)
                      }
                    />
                  )}

                  {durationType === "until" && (
                    <DateInput
                      label="Run until"
                      value={runUntil}
                      onChange={(v) => setRunUntil(v)}
                      minDate={new Date().toISOString().split("T")[0]}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Schedule Configuration (only shown when schedule is selected) */}
            {triggerType === "schedule" && (
              <div className="space-y-6 pt-4 border-t border-border mt-4">
                {/* Frequency */}
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

                {/* Frequency-specific options */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {frequency === "weekly" && (
                    <CustomSelect
                      label="Day of Week"
                      value={dayOfWeek.toString()}
                      onChange={(v) => setDayOfWeek(parseInt(v))}
                      options={daysOfWeek.map((day) => ({
                        value: String(day.value),
                        label: day.label,
                      }))}
                    />
                  )}

                  {["monthly", "quarterly", "yearly"].includes(frequency) && (
                    <CustomSelect
                      label="Day of Month"
                      value={dayOfMonth.toString()}
                      onChange={(v) => setDayOfMonth(parseInt(v))}
                      options={dayOptions.map((day) => ({
                        value: String(day),
                        label: `${day}${getOrdinalSuffix(day)}`,
                      }))}
                    />
                  )}

                  {frequency === "yearly" && (
                    <CustomSelect
                      label="Month"
                      value={month.toString()}
                      onChange={(v) => setMonth(parseInt(v))}
                      options={months.map((m) => ({
                        value: String(m.value),
                        label: m.label,
                      }))}
                    />
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

                {/* Duration */}
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
                    <NumberInput
                      integer
                      min={1}
                      max={999}
                      label="Number of times to run"
                      value={runCount.toString()}
                      onChange={(e) => setRunCount(parseInt(e.target.value) || 1)}
                    />
                  )}

                  {durationType === "until" && (
                    <DateInput
                      label="Run until"
                      value={runUntil}
                      onChange={(v) => setRunUntil(v)}
                      minDate={new Date().toISOString().split("T")[0]}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </WorkflowNode>

        <ConnectorLine />

        {/* Step 3: Select Actions */}
        <WorkflowNode
          number={3}
          title="Select Actions"
          icon={Zap}
          isComplete={actions.length > 0}
          className="animate-fade-up stagger-3"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose what happens when the automation runs
            </p>

            {/* Action Type Selection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => addAction("email")}
                className="flex items-start gap-3 p-4 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-secondary/50 transition-all text-left"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500 shrink-0">
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-medium">Send Email</p>
                  <p className="text-sm text-muted-foreground">
                    Send an email to a recipient
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => addAction("notification")}
                className="flex items-start gap-3 p-4 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-secondary/50 transition-all text-left"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500 shrink-0">
                  <Bell className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-medium">In-App Notification</p>
                  <p className="text-sm text-muted-foreground">
                    Show a notification in the app
                  </p>
                </div>
              </button>
            </div>

            {/* Added Actions */}
            {actions.length > 0 && (
              <div className="space-y-3 pt-4 border-t border-border">
                <p className="text-sm font-medium text-muted-foreground">
                  Configured Actions ({actions.length})
                </p>
                {actions.map((action, index) => (
                  <Card key={action.id} className="border-border/50">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex flex-col items-center gap-1 pt-1">
                          <div
                            className={cn(
                              "flex h-8 w-8 items-center justify-center rounded-lg",
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
                                <p className="text-xs text-muted-foreground">
                                  Keep under 60 characters for best display in email clients
                                </p>
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
                                  placeholder={
                                    (action.config as EmailActionConfig).format === "html"
                                      ? `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <h2 style="color: #2563eb;">Monthly Report Ready</h2>
  <p>Hi there,</p>
  <p>Your <strong>monthly report</strong> is now available for review.</p>
  <p>
    <a href="#" style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
      View Report
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">Best regards,<br>Your Team</p>
</body>
</html>`
                                      : `Hi there,

Your monthly report is now available and ready for your review.

Key Highlights:
• Revenue increased by 12% this month
• 3 new clients onboarded
• All targets met successfully

Please let us know if you have any questions.

Best regards,
Your Team`
                                  }
                                  className={cn(
                                    "min-h-[160px] text-sm",
                                    (action.config as EmailActionConfig).format === "html" ? "font-mono" : ""
                                  )}
                                  required
                                />
                                <p className="text-xs text-muted-foreground">
                                  {(action.config as EmailActionConfig).format === "html"
                                    ? "Write HTML markup for rich formatting. Inline styles recommended for email compatibility."
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
                                    <p className="text-xs text-muted-foreground">
                                      Replies will be sent to this address instead of the sender
                                    </p>
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
                                <p className="text-xs text-muted-foreground">
                                  Short, attention-grabbing title
                                </p>
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
                                <p className="text-xs text-muted-foreground">
                                  The notification message shown to the user
                                </p>
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
                                <p className="text-xs text-muted-foreground">
                                  Page to open when the notification is clicked
                                </p>
                              </div>
                            </>
                          )}
                        </div>

                        <Tooltip content="Remove action">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-error shrink-0"
                          onClick={() => removeAction(action.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        </Tooltip>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </WorkflowNode>

        {/* Submit */}
        <div className="flex items-center justify-end gap-3 pt-6">
          <Link href="/automations">
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={isSubmitting || !isValid}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                Create Automation
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
