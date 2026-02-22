// Supabase Edge Function: process-automations
// This function is triggered by pg_cron every 15 minutes to process due automations

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// SMTP configuration from environment
const SMTP_HOST = Deno.env.get("SMTP_HOST") || "";
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") || "587");
const SMTP_SECURE = Deno.env.get("SMTP_SECURE") === "true";
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const SMTP_FROM = Deno.env.get("SMTP_FROM") || "";

interface EmailActionConfig {
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  body: string;
  format?: "text" | "html";
}

interface NotificationActionConfig {
  title: string;
  message: string;
  link?: string;
}

interface TriggerConfig {
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  time: string;
  timezone: string;
  day_of_week?: number; // 0-6 (Sunday-Saturday) for weekly
  day_of_month?: number; // 1-28 for monthly/quarterly/yearly
  months?: number[]; // e.g., [1, 4, 7, 10] for quarterly
  month?: number; // 1-12 for yearly
  duration_type: "forever" | "count" | "until";
  run_count?: number;
  run_until?: string;
  runs_completed?: number;
}

interface Automation {
  id: string;
  user_id: string;
  name: string;
  trigger_type: "schedule" | "manual";
  trigger_config: TriggerConfig;
  next_run_at: string;
}

interface AutomationAction {
  id: string;
  automation_id: string;
  action_type: "email" | "notification";
  action_config: EmailActionConfig | NotificationActionConfig;
  sort_order: number;
}

// Get current date/time components in a specific timezone
function getDatePartsInTimezone(date: Date, timezone: string): {
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
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
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
    Date.UTC(tzParts.year, tzParts.month - 1, tzParts.day, tzParts.hour, tzParts.minute, 0)
  );
  const offsetMs = roughUTC.getTime() - tzAsUTC.getTime();

  // The local time we want expressed as if it were UTC
  const targetLocalAsUTC = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Apply offset to get actual UTC time
  const actualUTC = new Date(targetLocalAsUTC.getTime() + offsetMs);

  return actualUTC.toISOString();
}

// Get number of days in a month
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// Calculate next run time based on trigger config (timezone-aware)
function calculateNextRun(triggerConfig: TriggerConfig): string {
  const {
    frequency,
    time,
    timezone,
    day_of_week: targetDayOfWeek = 0,
    day_of_month: targetDayOfMonth = 1,
    months: quarterlyMonths = [1, 4, 7, 10],
    month: targetMonth = 1,
  } = triggerConfig;

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
      const targetDate = new Date(now.getTime() + daysUntil * 24 * 60 * 60 * 1000);
      const targetParts = getDatePartsInTimezone(targetDate, timezone);
      nextYear = targetParts.year;
      nextMonth = targetParts.month;
      nextDay = targetParts.day;
      break;
    }

    case "monthly": {
      nextDay = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, nextMonth));
      // If we've passed this day/time this month, move to next month
      if (current.day > targetDayOfMonth || (current.day === targetDayOfMonth && isTimePassed)) {
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
      const monthsToUse = quarterlyMonths.length > 0 ? quarterlyMonths : [1, 4, 7, 10];
      const sortedMonths = [...monthsToUse].sort((a, b) => a - b);
      let foundNext = false;

      for (const qMonth of sortedMonths) {
        if (qMonth > current.month) {
          nextMonth = qMonth;
          foundNext = true;
          break;
        } else if (qMonth === current.month) {
          const dayToCheck = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, qMonth));
          if (current.day < dayToCheck || (current.day === dayToCheck && !isTimePassed)) {
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
        (current.month === targetMonth && current.day === targetDayOfMonth && isTimePassed)
      ) {
        nextYear++;
        nextDay = Math.min(targetDayOfMonth, getDaysInMonth(nextYear, nextMonth));
      }
      break;
    }
  }

  // Convert the calculated local time to UTC
  return localToUTC(nextYear, nextMonth, nextDay, targetHours, targetMinutes, timezone);
}

// Helper to parse comma-separated emails into array
function parseEmails(emails: string): string[] {
  return emails.split(",").map((e) => e.trim()).filter(Boolean);
}

// Send email via SMTP
async function sendEmail(config: EmailActionConfig): Promise<void> {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("SMTP not configured, skipping email:", config.subject);
    throw new Error("SMTP not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS secrets.");
  }

  try {
    // Create SMTP client
    const client = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: SMTP_PORT,
        tls: SMTP_SECURE,
        auth: {
          username: SMTP_USER,
          password: SMTP_PASS,
        },
      },
    });

    // Parse recipients
    const toAddresses = parseEmails(config.to);
    const ccAddresses = config.cc ? parseEmails(config.cc) : undefined;
    const bccAddresses = config.bcc ? parseEmails(config.bcc) : undefined;

    // Build email content
    const emailContent: {
      from: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
      subject: string;
      content?: string;
      html?: string;
    } = {
      from: SMTP_FROM,
      to: toAddresses,
      subject: config.subject,
    };

    // Add CC, BCC, Reply-To if provided
    if (ccAddresses && ccAddresses.length > 0) emailContent.cc = ccAddresses;
    if (bccAddresses && bccAddresses.length > 0) emailContent.bcc = bccAddresses;
    if (config.replyTo) emailContent.replyTo = config.replyTo;

    // Set content based on format
    if (config.format === "html") {
      emailContent.html = config.body;
    } else {
      emailContent.content = config.body;
    }

    // Send the email
    await client.send(emailContent);
    await client.close();

    console.log(`Email sent to ${toAddresses.join(", ")}: ${config.subject}`);
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

// Create in-app notification
async function createNotification(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  runId: string,
  config: NotificationActionConfig
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    user_id: userId,
    title: config.title,
    message: config.message,
    link: config.link || null,
    automation_run_id: runId,
  });

  if (error) {
    console.error("Error creating notification:", error);
    throw error;
  }

  console.log(`Notification created for user ${userId}: ${config.title}`);
}

// Check if automation has exceeded its duration limits
function hasExceededDuration(config: TriggerConfig): boolean {
  if (config.duration_type === "count" && config.run_count) {
    if ((config.runs_completed ?? 0) >= config.run_count) {
      return true;
    }
  }
  if (config.duration_type === "until" && config.run_until) {
    if (new Date() >= new Date(config.run_until)) {
      return true;
    }
  }
  return false;
}

// Process a single automation
async function processAutomation(
  supabase: ReturnType<typeof createClient>,
  automation: Automation,
  actions: AutomationAction[]
): Promise<void> {
  console.log(`Processing automation: ${automation.name} (${automation.id})`);

  // Check if automation has exceeded duration limits before processing
  if (automation.trigger_type === "schedule" && hasExceededDuration(automation.trigger_config)) {
    console.log(`Skipping automation ${automation.name} - duration limit exceeded, deactivating`);
    await supabase
      .from("automations")
      .update({ is_active: false, next_run_at: null })
      .eq("id", automation.id);
    return;
  }

  // Create run record
  const { data: run, error: runError } = await supabase
    .from("automation_runs")
    .insert({
      automation_id: automation.id,
      status: "running",
    })
    .select()
    .single();

  if (runError || !run) {
    console.error("Error creating run record:", runError);
    throw runError;
  }

  const runId = run.id;
  let hasError = false;
  let errorMessage = "";

  // Use try-finally to ensure run status is ALWAYS updated
  try {
    // Execute actions in order
    const sortedActions = actions.sort((a, b) => a.sort_order - b.sort_order);

    for (const action of sortedActions) {
      try {
        if (action.action_type === "email") {
          await sendEmail(action.action_config as EmailActionConfig);
        } else if (action.action_type === "notification") {
          await createNotification(
            supabase,
            automation.user_id,
            runId,
            action.action_config as NotificationActionConfig
          );
        }
      } catch (error) {
        hasError = true;
        errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error executing action ${action.id}:`, error);
        // Continue with other actions even if one fails
      }
    }

    // Update automation - calculate next_run_at and check duration limits
    try {
      const updateData: {
        last_run_at: string;
        next_run_at?: string;
        is_active?: boolean;
        trigger_config?: TriggerConfig;
      } = {
        last_run_at: new Date().toISOString(),
      };

      if (automation.trigger_type === "schedule") {
        const config = automation.trigger_config;
        const newRunsCompleted = (config.runs_completed ?? 0) + 1;

        // Check if automation should be deactivated based on duration settings
        let shouldDeactivate = false;

        if (config.duration_type === "count" && config.run_count) {
          if (newRunsCompleted >= config.run_count) {
            shouldDeactivate = true;
            console.log(`Automation ${automation.name} reached run count limit (${config.run_count})`);
          }
        } else if (config.duration_type === "until" && config.run_until) {
          const untilDate = new Date(config.run_until);
          if (new Date() >= untilDate) {
            shouldDeactivate = true;
            console.log(`Automation ${automation.name} reached end date (${config.run_until})`);
          }
        }

        if (shouldDeactivate) {
          updateData.is_active = false;
          updateData.next_run_at = null as unknown as string; // Clear next run
        } else {
          updateData.next_run_at = calculateNextRun(config);
        }

        // Update runs_completed in trigger_config
        updateData.trigger_config = {
          ...config,
          runs_completed: newRunsCompleted,
        };
      }

      await supabase
        .from("automations")
        .update(updateData)
        .eq("id", automation.id);
    } catch (error) {
      // Log but don't fail the run - the actions completed
      console.error(`Error updating automation ${automation.id}:`, error);
      if (!hasError) {
        hasError = true;
        errorMessage = `Automation update failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } finally {
    // ALWAYS update run status, even if errors occurred
    try {
      await supabase
        .from("automation_runs")
        .update({
          status: hasError ? "failed" : "success",
          completed_at: new Date().toISOString(),
          error: errorMessage || null,
        })
        .eq("id", runId);

      console.log(`Automation ${automation.name} completed with status: ${hasError ? "failed" : "success"}`);
    } catch (finalError) {
      // Last resort - log the error but don't throw
      console.error(`CRITICAL: Failed to update run status for ${runId}:`, finalError);
    }
  }
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    console.log(`[${new Date().toISOString()}] process-automations invoked`);

    // Verify authorization
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.log("Request rejected: No authorization header");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Create Supabase client with service role
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check for manual trigger (specific automation_id in body)
    let manualAutomationId: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        manualAutomationId = body.automation_id || null;
      } catch {
        // No body or invalid JSON, continue with scheduled processing
      }
    }

    let automations;
    let queryError;

    if (manualAutomationId) {
      // Manual trigger: run specific automation regardless of next_run_at or is_active
      // This allows users to test paused automations
      const result = await supabase
        .from("automations")
        .select("*")
        .eq("id", manualAutomationId)
        .is("deleted_at", null)
        .single();

      automations = result.data ? [result.data] : [];
      queryError = result.error;
    } else {
      // Scheduled trigger: query due automations
      const now = new Date().toISOString();
      const result = await supabase
        .from("automations")
        .select("*")
        .eq("is_active", true)
        .is("deleted_at", null)
        .lte("next_run_at", now);

      automations = result.data;
      queryError = result.error;
    }

    if (queryError) {
      console.error("Error querying automations:", queryError);
      return new Response(JSON.stringify({ error: queryError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (!automations || automations.length === 0) {
      console.log(manualAutomationId ? "Automation not found or inactive" : "No automations due for processing");
      return new Response(JSON.stringify({ processed: 0, message: manualAutomationId ? "Automation not found or inactive" : "No automations due" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    console.log(`Found ${automations.length} automations to process`);

    // Process each automation
    let processed = 0;
    let failed = 0;

    for (const automation of automations) {
      try {
        // Fetch actions for this automation
        const { data: actions, error: actionsError } = await supabase
          .from("automation_actions")
          .select("*")
          .eq("automation_id", automation.id)
          .order("sort_order");

        if (actionsError) {
          console.error(`Error fetching actions for ${automation.id}:`, actionsError);
          failed++;
          continue;
        }

        await processAutomation(supabase, automation as Automation, actions as AutomationAction[]);
        processed++;
      } catch (error) {
        console.error(`Error processing automation ${automation.id}:`, error);
        failed++;
      }
    }

    return new Response(
      JSON.stringify({
        processed,
        failed,
        total: automations.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  } catch (error) {
    console.error("Unhandled error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  }
});
