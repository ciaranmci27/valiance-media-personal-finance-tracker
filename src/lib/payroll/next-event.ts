// Compute the "next firing" of a payroll-event automation trigger. Pure,
// data-in/data-out, so both the client (form preview) and the Edge Function
// scheduler can call it.
//
// Design notes
// ------------
// A "fire time" is an absolute UTC instant: the event's date (e.g. pay date
// May 20) interpreted at a user-chosen wall-clock time in a user-chosen
// timezone, then offset by N minutes. The scheduler stores this UTC instant
// in `automations.next_run_at` and fires when `now() >= next_run_at`.
//
// For each upcoming payroll event we compute a candidate fire time; we return
// the earliest candidate that is strictly > `afterTime`. "Strictly greater"
// is important: right after an automation fires, it calls this with
// afterTime = last fire time, and we must advance to the NEXT event, not
// re-fire on the same one.

import {
  getPayPeriodsInRange,
  type PayScheduleInput,
  dateUtils,
} from "./schedule";
import { isBankingDay } from "./deposits";
import type {
  PayrollEventContext,
  PayrollEventTriggerConfig,
  PayrollEventType,
  PayrollDepositType,
  PayrollFormType,
} from "@/types/database";
import type {
  PayrollEmployee,
  PayrollTaxDeposit,
  PayrollForm,
} from "@/types/payroll";

// ─── Inputs ───────────────────────────────────────────────────────────────────

export interface NextEventInputs {
  /** Active, non-deleted employees. Callers filter. */
  employees: PayrollEmployee[];
  /** Scheduled/late deposits (not paid, not deleted). */
  deposits: PayrollTaxDeposit[];
  /** Draft/generated forms (not filed, not deleted). */
  forms: PayrollForm[];
}

export interface NextEventResult {
  /** UTC ISO string. The moment the scheduler should fire. */
  fire_at: string;
  /** Context describing the underlying event, for template substitution. */
  context: PayrollEventContext;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the next fire time strictly after `afterTime`. Returns null when no
 * upcoming event matches the config (e.g. no employees, no unpaid deposits,
 * or the configured employee/deposit/form doesn't exist).
 */
export function computeNextPayrollEvent(
  config: PayrollEventTriggerConfig,
  afterTime: Date,
  inputs: NextEventInputs,
): NextEventResult | null {
  const candidates = gatherCandidates(config, afterTime, inputs);
  let best: NextEventResult | null = null;
  for (const c of candidates) {
    const fireAt = toFireAt(c.event_date, config);
    if (fireAt.getTime() <= afterTime.getTime()) continue;
    if (best === null || fireAt.getTime() < new Date(best.fire_at).getTime()) {
      best = { fire_at: fireAt.toISOString(), context: c };
    }
  }
  return best;
}

// ─── Candidate gathering ──────────────────────────────────────────────────────

function gatherCandidates(
  config: PayrollEventTriggerConfig,
  afterTime: Date,
  inputs: NextEventInputs,
): PayrollEventContext[] {
  switch (config.event) {
    case "pay_date":
    case "ach_send_date":
    case "period_end":
      return gatherEmployeeEventCandidates(config, afterTime, inputs.employees);
    case "deposit_due":
      return gatherDepositCandidates(config, inputs.deposits);
    case "form_due":
      return gatherFormCandidates(config, inputs.forms);
  }
}

function gatherEmployeeEventCandidates(
  config: PayrollEventTriggerConfig,
  afterTime: Date,
  employees: PayrollEmployee[],
): PayrollEventContext[] {
  // Filter by scoped employee if provided. Otherwise all active employees.
  const scoped = config.employee_id
    ? employees.filter((e) => e.id === config.employee_id)
    : employees;

  const results: PayrollEventContext[] = [];
  // Walk forward from afterTime for up to ~400 days - enough to cover annual
  // cadences without runaway loops.
  const from = dateUtils.addDays(afterTime, -1);
  const to = dateUtils.addDays(afterTime, 400);

  for (const emp of scoped) {
    if (emp.status !== "active") continue;
    let periods;
    try {
      const scheduleInput: PayScheduleInput = {
        pay_frequency: emp.pay_frequency,
        pay_anchor_date: emp.pay_anchor_date,
        pay_lag_days: emp.pay_lag_days ?? 0,
        semimonthly_days: emp.semimonthly_days ?? null,
        monthly_day: emp.monthly_day ?? null,
      };
      periods = getPayPeriodsInRange(scheduleInput, from, to);
    } catch {
      continue;
    }
    for (const p of periods) {
      const event_date =
        config.event === "pay_date"
          ? p.pay_date
          : config.event === "ach_send_date"
            ? subtractBankingDaysYmd(p.pay_date, 2)
            : p.period_end;
      results.push({
        event_date,
        event_type: config.event,
        employee_id: emp.id,
        employee_name: `${emp.first_name} ${emp.last_name}`.trim(),
        amount: Number(emp.pay_amount) || null,
        link: `/payroll/cycles/${p.pay_date}`,
      });
    }
  }
  return results;
}

function gatherDepositCandidates(
  config: PayrollEventTriggerConfig,
  deposits: PayrollTaxDeposit[],
): PayrollEventContext[] {
  const filter = config.deposit_type ?? "any";
  return deposits
    .filter((d) => d.status !== "paid" && !d.deleted_at)
    .filter((d) => filter === "any" || d.deposit_type === filter)
    .map((d) => ({
      event_date: d.due_date,
      event_type: "deposit_due" as PayrollEventType,
      deposit_id: d.id,
      deposit_type: d.deposit_type as PayrollDepositType,
      amount: Number(d.amount) || null,
      link: "/payroll/deposits",
    }));
}

function gatherFormCandidates(
  config: PayrollEventTriggerConfig,
  forms: PayrollForm[],
): PayrollEventContext[] {
  const filter = config.form_type ?? "any";
  return forms
    .filter((f) => f.status !== "filed" && !f.deleted_at)
    .filter((f) => filter === "any" || f.form_type === filter)
    .map((f) => ({
      event_date: formDueDate(f),
      event_type: "form_due" as PayrollEventType,
      form_id: f.id,
      form_type: f.form_type as PayrollFormType,
      link: formLink(f),
    }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert (event_date, offset_minutes, fire_time, timezone) into a UTC Date. */
function toFireAt(
  eventDateYmd: string,
  config: PayrollEventTriggerConfig,
): Date {
  const [y, m, d] = eventDateYmd.split("-").map(Number);
  const [hh, mm] = (config.fire_time || "09:00").split(":").map(Number);
  // Build the local wall-clock instant in the target timezone, then convert
  // to UTC via offset math (matches the existing schedule trigger logic).
  const localAsUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetMs = timezoneOffsetMs(config.timezone, new Date(localAsUTC));
  const fireUtc = new Date(localAsUTC + offsetMs + config.offset_minutes * 60_000);
  return fireUtc;
}

/**
 * For a given UTC instant, return the ms offset that, when added to a UTC
 * time representing the local wall-clock, produces the true UTC instant of
 * that wall-clock reading in the target timezone.
 */
function timezoneOffsetMs(timezone: string, probe: Date): number {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(probe);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  const tzAsUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    0,
  );
  return probe.getTime() - tzAsUTC;
}

/** Banking-day backward walk. Skips weekends AND the 11 US federal holidays
 *  observed by the Fed (via isBankingDay from deposits.ts). Kept in lockstep
 *  with the Deno edge function's port in payroll-events.ts so web preview
 *  and scheduled fire times agree around holidays. */
function subtractBankingDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  let remaining = n;
  while (remaining > 0) {
    date = new Date(date.getTime() - 86_400_000);
    if (isBankingDay(date)) remaining -= 1;
  }
  return formatYmd(date);
}

function formatYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function formDueDate(form: PayrollForm): string {
  // 941: last day of month following quarter. 940: Jan 31 following year.
  // W-2/W-3: Jan 31 following year. A1-QRT: last day of month following
  // quarter. A1-APR: Feb 28 following year. Close-enough defaults when the
  // form row doesn't carry a due_date column.
  const year = form.tax_year;
  const q = form.quarter ?? null;
  switch (form.form_type) {
    case "941":
    case "a1_qrt": {
      const quarter = q ?? 1;
      const endMonth = quarter * 3;
      const dueY = endMonth === 12 ? year + 1 : year;
      const dueMonth = (endMonth % 12) + 1;
      const lastDay = new Date(Date.UTC(dueY, dueMonth, 0)).getUTCDate();
      return `${dueY}-${String(dueMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    }
    case "940":
    case "w2":
    case "w3":
      return `${year + 1}-01-31`;
    case "a1_apr":
      return `${year + 1}-02-28`;
    default:
      return `${year + 1}-01-31`;
  }
}

function formLink(form: PayrollForm): string {
  switch (form.form_type) {
    case "941":
      return `/payroll/forms/941/${form.tax_year}/${form.quarter ?? 1}`;
    case "940":
      return `/payroll/forms/940/${form.tax_year}`;
    case "w2":
      return form.employee_id
        ? `/payroll/forms/w2/${form.tax_year}/${form.employee_id}`
        : `/payroll/forms/w2/${form.tax_year}`;
    case "w3":
      return `/payroll/forms/w3/${form.tax_year}`;
    case "a1_qrt":
      return `/payroll/forms/a1-qrt/${form.tax_year}/${form.quarter ?? 1}`;
    case "a1_apr":
      return `/payroll/forms/a1-apr/${form.tax_year}`;
    default:
      return "/payroll/forms";
  }
}

// ─── Template substitution ────────────────────────────────────────────────────

/**
 * Replace {{variable}} tokens in a template string using the event context.
 * Unknown tokens are left as-is so they're visible to the admin for debugging.
 */
export function substituteEventVariables(
  template: string,
  context: PayrollEventContext | null | undefined,
  baseUrl?: string,
): string {
  if (!context) return template;
  const values: Record<string, string> = {
    event_type: friendlyEventType(context.event_type),
    event_date: formatLongDate(context.event_date),
    event_date_short: context.event_date,
    employee_name: context.employee_name ?? "",
    amount: context.amount != null ? formatCurrency(context.amount) : "",
    link: context.link
      ? baseUrl
        ? `${baseUrl.replace(/\/$/, "")}${context.link}`
        : context.link
      : "",
    deposit_type: context.deposit_type
      ? friendlyDepositType(context.deposit_type)
      : "",
    form_type: context.form_type ? context.form_type.toUpperCase() : "",
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => {
    const v = values[key.toLowerCase()];
    return v !== undefined && v !== "" ? v : match;
  });
}

function friendlyEventType(event: PayrollEventType): string {
  switch (event) {
    case "pay_date":
      return "Pay date";
    case "ach_send_date":
      return "ACH send date";
    case "period_end":
      return "Period end";
    case "deposit_due":
      return "Tax deposit due";
    case "form_due":
      return "Form due";
  }
}

function friendlyDepositType(type: PayrollDepositType): string {
  switch (type) {
    case "federal_941":
      return "Federal 941 (withholding + FICA)";
    case "federal_940":
      return "FUTA";
    case "state_withholding":
      return "State withholding";
    case "state_suta":
      return "SUTA";
    case "state_sdi":
      return "SDI";
    case "any":
      return "Any";
  }
}

function formatLongDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${weekdays[date.getUTCDay()]}, ${months[m - 1]} ${d}, ${y}`;
}

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}
