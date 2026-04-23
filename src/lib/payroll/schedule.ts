// Pay-date math.
//
// A pay cadence is modeled as a sorted sequence of pay dates. Given any
// pay date, its pay period ends `pay_lag_days` earlier and starts the day
// after the previous pay date's period_end. (With lag=0 and weekly cadence,
// period_end == pay_date and period_start = pay_date - 6 days.)
//
// All dates are handled in UTC to keep them immune to DST. Payroll DATE
// columns store plain YYYY-MM-DD strings, so we parse/format with UTC
// helpers rather than Date.parse (which assumes local time).
//
// Banking-day convention:
//   The `pay_date` field on a returned PayPeriod is the banking-day-shifted
//   date (the day the ACH actually settles and the employee sees funds).
//   period_start / period_end stay anchored to the unshifted calendar
//   cadence - employees work the calendar period regardless of when the
//   bank happens to settle. When a pay date falls on a weekend or federal
//   holiday it shifts BACKWARD to the prior banking day (industry default:
//   pay early, not late). See `shiftToBankingDay`.
//
// Supported frequencies: weekly, biweekly, semimonthly, monthly, annual.
//
// Semimonthly convention:
//   semimonthly_days = [a, b] with a < b, e.g. [15, 30] or [1, 15].
//   Pay dates are the a-th and b-th day of each month, rolled back to
//   the last day of the month if the requested day does not exist
//   (e.g. [15, 31] in February pays on Feb 28/29).
//
// Monthly convention:
//   monthly_day = 1..31. Rolls back to last day of month when the month
//   is shorter (Feb 31 -> Feb 28/29, Apr 31 -> Apr 30).
//
// Annual convention:
//   One pay date per calendar year, at the same month-day as the anchor.

import type { PayFrequency } from "@/types/payroll";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PayPeriod {
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  pay_date: string;     // YYYY-MM-DD
}

export interface PayScheduleInput {
  pay_frequency: PayFrequency;
  pay_anchor_date: string;            // YYYY-MM-DD
  pay_lag_days: number;               // >= 0
  semimonthly_days?: number[] | null; // required when pay_frequency = semimonthly
  monthly_day?: number | null;        // required when pay_frequency = monthly
}

// ─── Date utilities (UTC only) ────────────────────────────────────────────────

const ONE_DAY_MS = 86_400_000;

function parseDate(s: string): Date {
  // Accepts YYYY-MM-DD. Treats the value as a UTC date at 00:00:00.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * ONE_DAY_MS);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / ONE_DAY_MS);
}

function daysInMonth(year: number, month1to12: number): number {
  // month is 1..12. Use day 0 of next month to get last day of this month.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function utcDate(year: number, month1to12: number, day: number): Date {
  // Clamp day to last-of-month if requested day is too large (monthly/semimonthly rollback).
  const dim = daysInMonth(year, month1to12);
  const clampedDay = Math.min(day, dim);
  return new Date(Date.UTC(year, month1to12 - 1, clampedDay));
}

// ─── Federal holidays (ACH / FedWire observed) ────────────────────────────────
//
// Rules the Fed applies:
//   - Holidays on Saturday: Fed operates normally the preceding Friday; only
//     federal employees observe the Friday off. ACH / FedWire settle normally.
//   - Holidays on Sunday: Fed observes the following Monday (no settlement).
// So for banking-day purposes, only the Sunday-shift rule applies.

/** Returns the nth (1-indexed) occurrence of `weekday` in the given month.
 *  weekday: 0=Sun, 1=Mon, ..., 6=Sat. */
function nthWeekdayOfMonth(
  year: number,
  month1to12: number,
  weekday: number,
  n: number,
): Date {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstDow = first.getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  return new Date(Date.UTC(year, month1to12 - 1, 1 + offset + (n - 1) * 7));
}

/** Returns the last occurrence of `weekday` in the given month. */
function lastWeekdayOfMonth(
  year: number,
  month1to12: number,
  weekday: number,
): Date {
  const dim = daysInMonth(year, month1to12);
  const last = new Date(Date.UTC(year, month1to12 - 1, dim));
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  return new Date(Date.UTC(year, month1to12 - 1, dim - offset));
}

/** Apply Fed's Sunday-shifts-to-Monday rule. Saturday holidays stay on
 *  Saturday for banking purposes (the Fed is already closed that day). */
function sundayToMonday(date: Date): Date {
  return date.getUTCDay() === 0 ? addDays(date, 1) : date;
}

/** All federal holidays observed by ACH / FedWire in a given year, as
 *  YYYY-MM-DD strings. */
function federalHolidaysInYear(year: number): string[] {
  return [
    sundayToMonday(utcDate(year, 1, 1)),       // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3),           // MLK (3rd Mon Jan)
    nthWeekdayOfMonth(year, 2, 1, 3),           // Presidents' (3rd Mon Feb)
    lastWeekdayOfMonth(year, 5, 1),             // Memorial (last Mon May)
    sundayToMonday(utcDate(year, 6, 19)),      // Juneteenth
    sundayToMonday(utcDate(year, 7, 4)),       // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1),           // Labor (1st Mon Sep)
    nthWeekdayOfMonth(year, 10, 1, 2),          // Columbus (2nd Mon Oct)
    sundayToMonday(utcDate(year, 11, 11)),     // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4),          // Thanksgiving (4th Thu Nov)
    sundayToMonday(utcDate(year, 12, 25)),     // Christmas
  ].map(formatDate);
}

/** Cached holiday set per year so repeated calls don't recompute. */
const HOLIDAY_CACHE = new Map<number, Set<string>>();
function holidaysFor(year: number): Set<string> {
  let cached = HOLIDAY_CACHE.get(year);
  if (!cached) {
    cached = new Set(federalHolidaysInYear(year));
    HOLIDAY_CACHE.set(year, cached);
  }
  return cached;
}

function isBankingDay(date: Date): boolean {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false; // Sun / Sat
  return !holidaysFor(date.getUTCFullYear()).has(formatDate(date));
}

/**
 * Shift a calendar date to the nearest banking day (Mon-Fri, non-holiday).
 * Direction "back" is the payroll-industry default: if the scheduled pay
 * date falls on a weekend/holiday, pay the employee the prior business day
 * rather than making them wait.
 */
function shiftToBankingDay(date: Date, direction: "back" | "forward" = "back"): Date {
  let cursor = new Date(date.getTime());
  const step = direction === "back" ? -1 : 1;
  while (!isBankingDay(cursor)) {
    cursor = addDays(cursor, step);
  }
  return cursor;
}

// ─── Per-frequency pay date generators ────────────────────────────────────────

/** Given weekly anchor, return pay_date at index (0 = anchor, 1 = next, -1 = prev). */
function weeklyPayDate(anchor: Date, index: number): Date {
  return addDays(anchor, index * 7);
}

function biweeklyPayDate(anchor: Date, index: number): Date {
  return addDays(anchor, index * 14);
}

/**
 * All semimonthly pay dates falling in [from, to], inclusive, sorted ascending.
 * Each month contributes two pay dates: the two values in `days` (rolled back
 * to last-of-month when the day doesn't exist).
 */
function semimonthlyPayDatesInRange(from: Date, to: Date, days: number[]): Date[] {
  if (days.length !== 2) {
    throw new Error(
      `schedule: semimonthly_days must have exactly 2 entries, got ${days.length}`,
    );
  }
  const [d1, d2] = [...days].sort((a, b) => a - b);
  const result: Date[] = [];

  // Walk month by month from one month before `from` to one month after `to`
  // to make sure edge-of-range pay dates are captured.
  const startYear = from.getUTCFullYear();
  const startMonth = from.getUTCMonth() + 1;
  const endYear = to.getUTCFullYear();
  const endMonth = to.getUTCMonth() + 1;

  let y = startYear;
  let m = startMonth - 1; // one month before to be safe
  if (m === 0) {
    m = 12;
    y -= 1;
  }

  const loopEndY = endYear;
  const loopEndM = endMonth + 1 > 12 ? 1 : endMonth + 1;
  const loopEndYFinal = endMonth + 1 > 12 ? endYear + 1 : endYear;

  while (y < loopEndYFinal || (y === loopEndYFinal && m <= loopEndM)) {
    const p1 = utcDate(y, m, d1);
    const p2 = utcDate(y, m, d2);
    if (p1 >= from && p1 <= to) result.push(p1);
    if (p2 >= from && p2 <= to) result.push(p2);

    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  result.sort((a, b) => a.getTime() - b.getTime());
  return result;
}

/** Monthly pay date for a given (year, month), respecting day rollback. */
function monthlyPayDate(year: number, month1to12: number, day: number): Date {
  return utcDate(year, month1to12, day);
}

/** Annual pay date: same month/day as the anchor, for the given year. */
function annualPayDate(year: number, anchor: Date): Date {
  return utcDate(year, anchor.getUTCMonth() + 1, anchor.getUTCDate());
}

// ─── Core: previous and next pay dates ────────────────────────────────────────

/**
 * Returns the pay date on or immediately BEFORE `on`, given the employee's
 * frequency and anchor. Returns null if no prior pay date exists (i.e. the
 * anchor is after `on` and there is no earlier pay date to compute).
 *
 * For weekly/biweekly: subtract k*7 or k*14 from anchor until <= on.
 * For semimonthly/monthly/annual: walk back month by month / year by year.
 */
function previousPayDate(input: PayScheduleInput, on: Date): Date | null {
  const anchor = parseDate(input.pay_anchor_date);

  switch (input.pay_frequency) {
    case "weekly": {
      // Round diff down to nearest multiple of 7.
      const diffDays = daysBetween(anchor, on);
      const k = Math.floor(diffDays / 7);
      return weeklyPayDate(anchor, k);
    }
    case "biweekly": {
      const diffDays = daysBetween(anchor, on);
      const k = Math.floor(diffDays / 14);
      return biweeklyPayDate(anchor, k);
    }
    case "semimonthly": {
      if (!input.semimonthly_days || input.semimonthly_days.length !== 2) {
        throw new Error("schedule: semimonthly requires semimonthly_days of length 2");
      }
      // Look back up to 3 months to be safe; return the latest <= on.
      const from = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth() - 3, 1));
      const dates = semimonthlyPayDatesInRange(from, on, input.semimonthly_days);
      return dates.length > 0 ? dates[dates.length - 1] : null;
    }
    case "monthly": {
      if (input.monthly_day == null) {
        throw new Error("schedule: monthly requires monthly_day");
      }
      // Try the target day in on's month; if > on, fall back a month; else use it.
      const y = on.getUTCFullYear();
      const m = on.getUTCMonth() + 1;
      const thisMonthPay = monthlyPayDate(y, m, input.monthly_day);
      if (thisMonthPay <= on) return thisMonthPay;
      // Previous month
      const prevM = m === 1 ? 12 : m - 1;
      const prevY = m === 1 ? y - 1 : y;
      return monthlyPayDate(prevY, prevM, input.monthly_day);
    }
    case "annual": {
      const y = on.getUTCFullYear();
      const thisYearPay = annualPayDate(y, anchor);
      if (thisYearPay <= on) return thisYearPay;
      return annualPayDate(y - 1, anchor);
    }
  }
}

/** First pay date ON OR AFTER `on`. */
function nextPayDate(input: PayScheduleInput, on: Date): Date {
  const anchor = parseDate(input.pay_anchor_date);

  switch (input.pay_frequency) {
    case "weekly": {
      const diffDays = daysBetween(anchor, on);
      const k = Math.ceil(diffDays / 7);
      return weeklyPayDate(anchor, k);
    }
    case "biweekly": {
      const diffDays = daysBetween(anchor, on);
      const k = Math.ceil(diffDays / 14);
      return biweeklyPayDate(anchor, k);
    }
    case "semimonthly": {
      if (!input.semimonthly_days || input.semimonthly_days.length !== 2) {
        throw new Error("schedule: semimonthly requires semimonthly_days of length 2");
      }
      const to = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth() + 3, 1));
      const dates = semimonthlyPayDatesInRange(on, to, input.semimonthly_days);
      if (dates.length === 0) {
        throw new Error("schedule: could not find next semimonthly pay date");
      }
      return dates[0];
    }
    case "monthly": {
      if (input.monthly_day == null) {
        throw new Error("schedule: monthly requires monthly_day");
      }
      const y = on.getUTCFullYear();
      const m = on.getUTCMonth() + 1;
      const thisMonthPay = monthlyPayDate(y, m, input.monthly_day);
      if (thisMonthPay >= on) return thisMonthPay;
      const nextM = m === 12 ? 1 : m + 1;
      const nextY = m === 12 ? y + 1 : y;
      return monthlyPayDate(nextY, nextM, input.monthly_day);
    }
    case "annual": {
      const y = on.getUTCFullYear();
      const thisYearPay = annualPayDate(y, anchor);
      if (thisYearPay >= on) return thisYearPay;
      return annualPayDate(y + 1, anchor);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given a date that could be either a calendar-aligned pay date or its
 * banking-day shift, return the calendar-aligned form. Returns null if
 * neither interpretation matches the schedule. This lets callers feed in
 * whatever date the admin typed / pasted (calendar or shifted) without
 * care-and-feeding - internally we always reason about the calendar date
 * so period boundaries stay stable.
 */
function resolveCalendarPayDate(
  input: PayScheduleInput,
  payDate: Date,
): Date | null {
  const prev = previousPayDate(input, payDate);
  if (prev && prev.getTime() === payDate.getTime()) return prev;
  // payDate could be the back-shift of the NEXT anchor-aligned date
  // (e.g. admin posted Friday because Monday Jan 2 is a holiday and the
  // real anchor-aligned date is Jan 2 which shifts back to the Friday).
  try {
    const next = nextPayDate(input, addDays(payDate, 1));
    if (formatDate(shiftToBankingDay(next)) === formatDate(payDate)) {
      return next;
    }
  } catch {
    // nextPayDate can throw for semimonthly/monthly at extreme boundaries.
  }
  return null;
}

/**
 * Given a pay date, compute the pay period that ends `pay_lag_days` before it.
 * period_start = (previous pay date - lag) + 1 day.
 *
 * The `pay_date` field on the returned PayPeriod is the banking-day-shifted
 * date. period_start/period_end are anchored to the unshifted calendar
 * cadence so work boundaries don't move when the Fed happens to be closed.
 *
 * Accepts either the calendar-aligned pay date or the already-shifted date
 * (admin-posted). Internal math always runs against the calendar form.
 *
 * For the very first pay (when there is no previous pay date), period_start
 * defaults to period_end - (cadence interval) + 1. This only applies when
 * anchor itself is the pay date being queried and we have no history.
 */
export function getPeriodForPayDate(input: PayScheduleInput, payDate: Date): PayPeriod {
  const calendarPayDate = resolveCalendarPayDate(input, payDate) ?? payDate;
  const periodEnd = addDays(calendarPayDate, -input.pay_lag_days);

  // Find the prior pay date (strictly before calendarPayDate).
  const oneBefore = addDays(calendarPayDate, -1);
  const prev = previousPayDate(input, oneBefore);

  let periodStart: Date;
  if (prev) {
    const prevEnd = addDays(prev, -input.pay_lag_days);
    periodStart = addDays(prevEnd, 1);
  } else {
    // First pay in sequence - back out by a default cadence length.
    periodStart = defaultPeriodStart(input, periodEnd);
  }

  return {
    period_start: formatDate(periodStart),
    period_end: formatDate(periodEnd),
    pay_date: formatDate(shiftToBankingDay(calendarPayDate)),
  };
}

/**
 * Given a target date (typically "today"), return the next upcoming pay period
 * (the pay period whose pay_date is on or after the target).
 */
export function getNextPayPeriod(input: PayScheduleInput, asOf: Date): PayPeriod {
  const payDate = nextPayDate(input, asOf);
  return getPeriodForPayDate(input, payDate);
}

/**
 * True iff `payDate` matches a pay date the schedule would generate, in
 * either its calendar-aligned form OR its banking-day-shifted form (the
 * UI typically displays the shifted form, so admin-posted values may be
 * either).
 *
 * getPeriodForPayDate happily derives a period from ANY date, so without
 * this guard an admin could accept (or paste into the URL) a date that is
 * not aligned with the cadence - producing a run whose period doesn't line
 * up with surrounding runs, leaving YTD gaps or overlaps. For off-cycle
 * runs the admin legitimately picks any date, so callers should skip this
 * check when runType is off_cycle.
 */
export function isLegalPayDate(
  input: PayScheduleInput,
  payDate: Date,
): boolean {
  try {
    return resolveCalendarPayDate(input, payDate) !== null;
  } catch {
    return false;
  }
}

/**
 * All pay periods whose pay_date falls in [from, to], inclusive.
 * Useful for batch views like "pay dates in the next 30 days".
 */
export function getPayPeriodsInRange(
  input: PayScheduleInput,
  from: Date,
  to: Date,
): PayPeriod[] {
  if (to < from) return [];

  const result: PayPeriod[] = [];
  let cursor = nextPayDate(input, from);
  // Guard against infinite loops.
  let safety = 2000;
  while (cursor <= to && safety > 0) {
    result.push(getPeriodForPayDate(input, cursor));
    cursor = nextPayDate(input, addDays(cursor, 1));
    safety -= 1;
  }
  return result;
}

/**
 * All pay dates within a calendar year, as YYYY-MM-DD strings. Used by
 * year-level widgets (pay history, projections).
 */
export function getPayDatesForYear(input: PayScheduleInput, year: number): string[] {
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year, 11, 31));
  return getPayPeriodsInRange(input, from, to).map((p) => p.pay_date);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultPeriodStart(input: PayScheduleInput, periodEnd: Date): Date {
  switch (input.pay_frequency) {
    case "weekly":
      return addDays(periodEnd, -6);
    case "biweekly":
      return addDays(periodEnd, -13);
    case "semimonthly": {
      // Half a month back, then +1 day.
      const y = periodEnd.getUTCFullYear();
      const m = periodEnd.getUTCMonth() + 1;
      const d = periodEnd.getUTCDate();
      if (!input.semimonthly_days || input.semimonthly_days.length !== 2) {
        return addDays(periodEnd, -14);
      }
      const [d1, d2] = [...input.semimonthly_days].sort((a, b) => a - b);
      if (d === d2 || (d === daysInMonth(y, m) && d2 >= daysInMonth(y, m))) {
        // Ending at 2nd of the two days - period starts at d1 + 1.
        return utcDate(y, m, d1 + 1);
      }
      // Ending at 1st of the two days - period starts on the 1st.
      return utcDate(y, m, 1);
    }
    case "monthly":
      // Prior month, day after.
      return addDays(
        new Date(
          Date.UTC(
            periodEnd.getUTCFullYear(),
            periodEnd.getUTCMonth() - 1,
            periodEnd.getUTCDate(),
          ),
        ),
        1,
      );
    case "annual":
      return addDays(
        new Date(
          Date.UTC(
            periodEnd.getUTCFullYear() - 1,
            periodEnd.getUTCMonth(),
            periodEnd.getUTCDate(),
          ),
        ),
        1,
      );
  }
}

// ─── Re-exports for convenience ───────────────────────────────────────────────

export const dateUtils = { parseDate, formatDate, addDays };
