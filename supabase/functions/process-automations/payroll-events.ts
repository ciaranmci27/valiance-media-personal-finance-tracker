// Payroll-event trigger support for the automation scheduler.
//
// This file is a Deno-only port of admin/src/lib/payroll/next-event.ts and a
// minimal subset of admin/src/lib/payroll/schedule.ts. Kept standalone because
// Deno edge functions cannot import from the Next.js app. If schedule math
// changes in the Next.js app, update here too.

// ─── Shared types ─────────────────────────────────────────────────────────────

export type PayFrequency =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "annual";

export type PayrollEventType =
  | "pay_date"
  | "ach_send_date"
  | "period_end"
  | "deposit_due"
  | "form_due";

export type PayrollDepositType =
  | "federal_941"
  | "federal_940"
  | "state_withholding"
  | "state_suta"
  | "state_sdi"
  | "any";

export type PayrollFormType =
  | "941"
  | "940"
  | "w2"
  | "w3"
  | "a1_qrt"
  | "a1_apr"
  | "any";

export interface PayrollEventContext {
  event_date: string;
  event_type: PayrollEventType;
  employee_id?: string | null;
  employee_name?: string | null;
  amount?: number | null;
  deposit_id?: string | null;
  deposit_type?: PayrollDepositType | null;
  form_id?: string | null;
  form_type?: PayrollFormType | null;
  link?: string | null;
}

export interface PayrollEventTriggerConfig {
  event: PayrollEventType;
  offset_minutes: number;
  fire_time: string;
  timezone: string;
  employee_id?: string | null;
  deposit_type?: PayrollDepositType | null;
  form_type?: PayrollFormType | null;
  duration_type: "forever" | "count" | "until";
  run_count?: number;
  run_until?: string;
  runs_completed?: number;
  next_event_context?: PayrollEventContext | null;
}

export interface EmployeeRow {
  id: string;
  first_name: string;
  last_name: string;
  status: "active" | "terminated";
  pay_amount: number | string;
  pay_frequency: PayFrequency;
  pay_anchor_date: string;
  pay_lag_days: number | null;
  semimonthly_days: number[] | null;
  monthly_day: number | null;
}

export interface DepositRow {
  id: string;
  deposit_type: PayrollDepositType;
  due_date: string;
  amount: number | string;
  status: "scheduled" | "paid" | "late";
  deleted_at: string | null;
}

export interface FormRow {
  id: string;
  form_type: PayrollFormType;
  tax_year: number;
  quarter: number | null;
  status: "draft" | "generated" | "filed";
  deleted_at: string | null;
  employee_id: string | null;
}

export interface NextEventResult {
  fire_at: string;
  context: PayrollEventContext;
}

// ─── Date helpers (UTC only) ──────────────────────────────────────────────────

const ONE_DAY_MS = 86_400_000;

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * ONE_DAY_MS);
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// ─── Banking-day helpers ──────────────────────────────────────────────────────
// Ported from admin/src/lib/payroll/deposits.ts. Keep in sync with that file
// so web-preview fire times match what the Edge Function schedules.

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function lastDayOfUtcMonth(year: number, month1to12: number): Date {
  return new Date(Date.UTC(year, month1to12, 0));
}

function nthWeekdayOfMonth(
  year: number,
  month1to12: number,
  weekday: number, // 0=Sun..6=Sat
  nth: number,
): Date {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstDow = first.getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return new Date(Date.UTC(year, month1to12 - 1, day));
}

function lastWeekdayOfMonth(
  year: number,
  month1to12: number,
  weekday: number,
): Date {
  const last = lastDayOfUtcMonth(year, month1to12);
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  return addDays(last, -offset);
}

/** Observance rule for fixed-date federal holidays: Sat -> preceding Fri,
 *  Sun -> following Mon, weekdays unchanged. */
function observedFixedHoliday(
  year: number,
  month1to12: number,
  day: number,
): Date {
  const d = new Date(Date.UTC(year, month1to12 - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) return addDays(d, -1);
  if (dow === 0) return addDays(d, 1);
  return d;
}

/** 11 federal holidays observed by the Federal Reserve. */
function federalHolidaysForYear(year: number): Set<string> {
  const dates: Date[] = [
    observedFixedHoliday(year, 1, 1), // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3), // MLK Day (3rd Mon Jan)
    nthWeekdayOfMonth(year, 2, 1, 3), // Presidents' Day (3rd Mon Feb)
    lastWeekdayOfMonth(year, 5, 1), // Memorial Day (last Mon May)
    observedFixedHoliday(year, 6, 19), // Juneteenth
    observedFixedHoliday(year, 7, 4), // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day (1st Mon Sep)
    nthWeekdayOfMonth(year, 10, 1, 2), // Columbus Day (2nd Mon Oct)
    observedFixedHoliday(year, 11, 11), // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving (4th Thu Nov)
    observedFixedHoliday(year, 12, 25), // Christmas
  ];
  return new Set(dates.map(formatYmd));
}

const holidayCache = new Map<number, Set<string>>();

function isFederalHoliday(d: Date): boolean {
  const year = d.getUTCFullYear();
  let set = holidayCache.get(year);
  if (!set) {
    set = federalHolidaysForYear(year);
    holidayCache.set(year, set);
  }
  return set.has(formatYmd(d));
}

function isBankingDay(d: Date): boolean {
  if (isWeekend(d)) return false;
  return !isFederalHoliday(d);
}

/** Backward walk, skipping weekends AND federal holidays. Matches the web
 *  app's subtractBusinessDays behavior for ACH-send offset calculations. */
function subtractBankingDays(ymd: string, n: number): string {
  let d = parseYmd(ymd);
  let remaining = n;
  while (remaining > 0) {
    d = addDays(d, -1);
    if (isBankingDay(d)) remaining -= 1;
  }
  return formatYmd(d);
}

/** Pay-date banking-day shift: pay early on the preceding banking day when
 *  the nominal pay date is a weekend or federal holiday. Matches schedule.ts
 *  `shiftToBankingDay` (backward direction). */
function shiftPayDateBackward(d: Date): Date {
  let cur = d;
  while (!isBankingDay(cur)) cur = addDays(cur, -1);
  return cur;
}

// ─── Pay-date generation ──────────────────────────────────────────────────────
// Simplified port of schedule.ts. Produces the full list of pay dates in
// [from, to] for a given cadence, already banking-day-shifted for pay dates
// (period_end stays on the raw calendar day).

interface PayPeriod {
  pay_date: string;
  period_end: string;
}

function generatePayPeriods(
  emp: EmployeeRow,
  from: Date,
  to: Date,
): PayPeriod[] {
  if (to < from) return [];
  switch (emp.pay_frequency) {
    case "weekly":
      return genWeekly(emp, from, to);
    case "biweekly":
      return genBiweekly(emp, from, to);
    case "semimonthly":
      return genSemimonthly(emp, from, to);
    case "monthly":
      return genMonthly(emp, from, to);
    case "annual":
      return genAnnual(emp, from, to);
  }
}

function genWeekly(emp: EmployeeRow, from: Date, to: Date): PayPeriod[] {
  const anchor = parseYmd(emp.pay_anchor_date);
  const lag = emp.pay_lag_days ?? 0;
  const out: PayPeriod[] = [];
  // Align to the nearest anchor-weekday at or before `from`.
  const diff = Math.floor((from.getTime() - anchor.getTime()) / ONE_DAY_MS);
  const k0 = Math.floor(diff / 7);
  let k = k0 - 1;
  let safety = 2000;
  while (safety-- > 0) {
    const calendarPayDate = addDays(anchor, k * 7);
    const shifted = shiftPayDateBackward(calendarPayDate);
    const periodEnd = addDays(calendarPayDate, -lag);
    if (shifted > to) break;
    if (shifted >= from) {
      out.push({
        pay_date: formatYmd(shifted),
        period_end: formatYmd(periodEnd),
      });
    }
    k += 1;
  }
  return out;
}

function genBiweekly(emp: EmployeeRow, from: Date, to: Date): PayPeriod[] {
  const anchor = parseYmd(emp.pay_anchor_date);
  const lag = emp.pay_lag_days ?? 0;
  const out: PayPeriod[] = [];
  const diff = Math.floor((from.getTime() - anchor.getTime()) / ONE_DAY_MS);
  const k0 = Math.floor(diff / 14);
  let k = k0 - 1;
  let safety = 2000;
  while (safety-- > 0) {
    const calendarPayDate = addDays(anchor, k * 14);
    const shifted = shiftPayDateBackward(calendarPayDate);
    const periodEnd = addDays(calendarPayDate, -lag);
    if (shifted > to) break;
    if (shifted >= from) {
      out.push({
        pay_date: formatYmd(shifted),
        period_end: formatYmd(periodEnd),
      });
    }
    k += 1;
  }
  return out;
}

function genSemimonthly(
  emp: EmployeeRow,
  from: Date,
  to: Date,
): PayPeriod[] {
  const days = (emp.semimonthly_days ?? [15, 31])
    .slice()
    .sort((a, b) => a - b);
  const [d1, d2] = [days[0], days[1]];
  const lag = emp.pay_lag_days ?? 0;
  const out: PayPeriod[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth() + 1 - 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth() + 2;
  const endYFinal = endM > 12 ? endY + 1 : endY;
  const endMFinal = endM > 12 ? 1 : endM;
  while (y < endYFinal || (y === endYFinal && m <= endMFinal)) {
    for (const day of [d1, d2]) {
      const capped = Math.min(day, daysInMonth(y, m));
      const calendarPayDate = new Date(Date.UTC(y, m - 1, capped));
      const shifted = shiftPayDateBackward(calendarPayDate);
      const periodEnd = addDays(calendarPayDate, -lag);
      if (shifted >= from && shifted <= to) {
        out.push({
          pay_date: formatYmd(shifted),
          period_end: formatYmd(periodEnd),
        });
      }
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  out.sort((a, b) => a.pay_date.localeCompare(b.pay_date));
  return out;
}

function genMonthly(emp: EmployeeRow, from: Date, to: Date): PayPeriod[] {
  const day = emp.monthly_day ?? 15;
  const lag = emp.pay_lag_days ?? 0;
  const out: PayPeriod[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth() + 1 - 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth() + 2;
  const endYFinal = endM > 12 ? endY + 1 : endY;
  const endMFinal = endM > 12 ? 1 : endM;
  while (y < endYFinal || (y === endYFinal && m <= endMFinal)) {
    const capped = Math.min(day, daysInMonth(y, m));
    const calendarPayDate = new Date(Date.UTC(y, m - 1, capped));
    const shifted = shiftPayDateBackward(calendarPayDate);
    const periodEnd = addDays(calendarPayDate, -lag);
    if (shifted >= from && shifted <= to) {
      out.push({
        pay_date: formatYmd(shifted),
        period_end: formatYmd(periodEnd),
      });
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function genAnnual(emp: EmployeeRow, from: Date, to: Date): PayPeriod[] {
  const anchor = parseYmd(emp.pay_anchor_date);
  const anchorMonth = anchor.getUTCMonth() + 1;
  const anchorDay = anchor.getUTCDate();
  const lag = emp.pay_lag_days ?? 0;
  const out: PayPeriod[] = [];
  for (
    let y = from.getUTCFullYear() - 1;
    y <= to.getUTCFullYear() + 1;
    y += 1
  ) {
    const capped = Math.min(anchorDay, daysInMonth(y, anchorMonth));
    const calendarPayDate = new Date(Date.UTC(y, anchorMonth - 1, capped));
    const shifted = shiftPayDateBackward(calendarPayDate);
    const periodEnd = addDays(calendarPayDate, -lag);
    if (shifted >= from && shifted <= to) {
      out.push({
        pay_date: formatYmd(shifted),
        period_end: formatYmd(periodEnd),
      });
    }
  }
  return out;
}

// ─── Fire-time computation ────────────────────────────────────────────────────

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

function toFireAt(
  eventDateYmd: string,
  config: PayrollEventTriggerConfig,
): Date {
  const [y, m, d] = eventDateYmd.split("-").map(Number);
  const [hh, mm] = (config.fire_time || "09:00").split(":").map(Number);
  const localAsUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetMs = timezoneOffsetMs(config.timezone, new Date(localAsUTC));
  return new Date(localAsUTC + offsetMs + config.offset_minutes * 60_000);
}

// ─── Candidate gathering ──────────────────────────────────────────────────────

function gatherEmployeeEventCandidates(
  config: PayrollEventTriggerConfig,
  afterTime: Date,
  employees: EmployeeRow[],
): PayrollEventContext[] {
  const scoped = config.employee_id
    ? employees.filter((e) => e.id === config.employee_id)
    : employees;
  const results: PayrollEventContext[] = [];
  const from = addDays(afterTime, -1);
  const to = addDays(afterTime, 400);
  for (const emp of scoped) {
    if (emp.status !== "active") continue;
    let periods: PayPeriod[] = [];
    try {
      periods = generatePayPeriods(emp, from, to);
    } catch {
      continue;
    }
    for (const p of periods) {
      const event_date =
        config.event === "pay_date"
          ? p.pay_date
          : config.event === "ach_send_date"
            ? subtractBankingDays(p.pay_date, 2)
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
  deposits: DepositRow[],
): PayrollEventContext[] {
  const filter = config.deposit_type ?? "any";
  return deposits
    .filter((d) => d.status !== "paid" && !d.deleted_at)
    .filter((d) => filter === "any" || d.deposit_type === filter)
    .map((d) => ({
      event_date: d.due_date,
      event_type: "deposit_due" as PayrollEventType,
      deposit_id: d.id,
      deposit_type: d.deposit_type,
      amount: Number(d.amount) || null,
      link: "/payroll/deposits",
    }));
}

function formDueDate(form: FormRow): string {
  const year = form.tax_year;
  const q = form.quarter ?? null;
  switch (form.form_type) {
    case "941":
    case "a1_qrt": {
      const quarter = q ?? 1;
      const endMonth = quarter * 3;
      const dueY = endMonth === 12 ? year + 1 : year;
      const dueMonth = (endMonth % 12) + 1;
      const lastDay = daysInMonth(dueY, dueMonth);
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

function formLink(form: FormRow): string {
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

function gatherFormCandidates(
  config: PayrollEventTriggerConfig,
  forms: FormRow[],
): PayrollEventContext[] {
  const filter = config.form_type ?? "any";
  return forms
    .filter((f) => f.status !== "filed" && !f.deleted_at)
    .filter((f) => filter === "any" || f.form_type === filter)
    .map((f) => ({
      event_date: formDueDate(f),
      event_type: "form_due" as PayrollEventType,
      form_id: f.id,
      form_type: f.form_type,
      link: formLink(f),
    }));
}

// ─── Public: computeNextPayrollEvent ──────────────────────────────────────────

export function computeNextPayrollEvent(
  config: PayrollEventTriggerConfig,
  afterTime: Date,
  inputs: { employees: EmployeeRow[]; deposits: DepositRow[]; forms: FormRow[] },
): NextEventResult | null {
  let candidates: PayrollEventContext[] = [];
  switch (config.event) {
    case "pay_date":
    case "ach_send_date":
    case "period_end":
      candidates = gatherEmployeeEventCandidates(
        config,
        afterTime,
        inputs.employees,
      );
      break;
    case "deposit_due":
      candidates = gatherDepositCandidates(config, inputs.deposits);
      break;
    case "form_due":
      candidates = gatherFormCandidates(config, inputs.forms);
      break;
  }
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

// ─── Template substitution ────────────────────────────────────────────────────

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

// ─── Supabase-backed fetch wrappers ───────────────────────────────────────────

export async function loadPayrollInputs(
  // Accepts the service-role supabase-js v2 client. Typed as `any` because
  // the Deno edge function doesn't import the full client type surface.
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{
  employees: EmployeeRow[];
  deposits: DepositRow[];
  forms: FormRow[];
}> {
  const [employeesRes, depositsRes, formsRes] = await Promise.all([
    supabase
      .from("payroll_employees")
      .select(
        "id,first_name,last_name,status,pay_amount,pay_frequency,pay_anchor_date,pay_lag_days,semimonthly_days,monthly_day",
      )
      .eq("status", "active")
      .is("deleted_at", null),
    supabase
      .from("payroll_tax_deposits")
      .select("id,deposit_type,due_date,amount,status,deleted_at")
      .is("deleted_at", null),
    supabase
      .from("payroll_forms")
      .select("id,form_type,tax_year,quarter,status,deleted_at,employee_id")
      .is("deleted_at", null),
  ]);
  return {
    employees: (employeesRes.data ?? []) as EmployeeRow[],
    deposits: (depositsRes.data ?? []) as DepositRow[],
    forms: (formsRes.data ?? []) as FormRow[],
  };
}
