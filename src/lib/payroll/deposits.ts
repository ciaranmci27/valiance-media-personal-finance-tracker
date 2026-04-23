// Deposit due-date math. Pure functions. No IO.
//
// Sources
// -------
// Federal: IRS Publication 15 (Circular E), 2025 edition, "When To Deposit
//          Taxes" section. https://www.irs.gov/pub/irs-pdf/p15.pdf
//          - Monthly schedule: all 941 taxes for a calendar month are due by
//            the 15th of the following month.
//          - Semiweekly schedule:
//            - Paydays Wed/Thu/Fri: deposit by the following Wednesday.
//            - Paydays Sat/Sun/Mon/Tue: deposit by the following Friday.
//            - Three-banking-day rule: if any of the 3 weekdays after the end
//              of the semiweekly period is a legal holiday, the due date is
//              extended by one banking day per such holiday.
//          - $100k next-day rule: if $100,000+ of 941 liability accumulates
//            on any single day, deposit is due the next banking day. (Not
//            applied here at the due-date level; surfaced as a flag.)
//          - FUTA (Form 940): quarterly deposit is due by the last day of
//            the month following the end of the quarter, but only if the
//            accumulated undeposited FUTA exceeds $500. Otherwise carried to
//            the next quarter. At year-end, any remaining balance is due
//            with Form 940 by Jan 31.
//
// Arizona: Form A1-WP (Payment of Arizona Income Tax Withheld), instructions.
//          - Quarterly (<$500/quarter withholding): paid with the A1-QRT by
//            the last day of the month following the quarter.
//          - Monthly ($500-$1,500): due 15th of the following month.
//          - Semiweekly (>$1,500): mirrors the federal semiweekly schedule.
//          Arizona has no state disability insurance (SDI) program, so no
//          SDI deposits are scheduled.
//          State unemployment (UC-018): quarterly, due the last day of the
//          month following the end of the quarter.
//
// Banking days
// ------------
// A "banking day" under IRS Pub 15 is any day that is not a Saturday, Sunday,
// or legal holiday in the District of Columbia. Legal holidays are the 11
// federal holidays; when a fixed-date holiday falls on a Saturday it is
// observed the preceding Friday, and when it falls on a Sunday it is
// observed the following Monday.

import type {
  FederalDepositSchedule,
  StateDepositSchedule,
} from "@/types/payroll";

// ─── Date utilities (UTC only, matching schedule.ts conventions) ──────────────

const ONE_DAY_MS = 86_400_000;

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * ONE_DAY_MS);
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function lastDayOfMonth(year: number, month1to12: number): Date {
  return new Date(Date.UTC(year, month1to12 - 1, daysInMonth(year, month1to12)));
}

function nthWeekdayOfMonth(
  year: number,
  month1to12: number,
  weekday: number, // 0=Sun..6=Sat
  nth: number, // 1..5
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
  weekday: number, // 0=Sun..6=Sat
): Date {
  const last = lastDayOfMonth(year, month1to12);
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  return addDays(last, -offset);
}

// ─── Federal holidays ─────────────────────────────────────────────────────────

/** Observance rule for fixed-date federal holidays: Sat -> preceding Fri,
 *  Sun -> following Mon, weekdays unchanged. */
function observedFixedHoliday(year: number, month1to12: number, day: number): Date {
  const d = new Date(Date.UTC(year, month1to12 - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) return addDays(d, -1); // Sat -> Fri
  if (dow === 0) return addDays(d, 1); // Sun -> Mon
  return d;
}

/** Returns the set of federal-holiday YYYY-MM-DD strings for the given year.
 *  Covers all 11 federal holidays observed by the Federal Reserve. */
function federalHolidaysForYear(year: number): Set<string> {
  const dates: Date[] = [
    observedFixedHoliday(year, 1, 1),                 // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3),                  // MLK Day (3rd Mon Jan)
    nthWeekdayOfMonth(year, 2, 1, 3),                  // Presidents' Day (3rd Mon Feb)
    lastWeekdayOfMonth(year, 5, 1),                    // Memorial Day (last Mon May)
    observedFixedHoliday(year, 6, 19),                 // Juneteenth
    observedFixedHoliday(year, 7, 4),                  // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1),                  // Labor Day (1st Mon Sep)
    nthWeekdayOfMonth(year, 10, 1, 2),                 // Columbus Day (2nd Mon Oct)
    observedFixedHoliday(year, 11, 11),                // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4),                 // Thanksgiving (4th Thu Nov)
    observedFixedHoliday(year, 12, 25),                // Christmas
  ];
  return new Set(dates.map(formatYmd));
}

// Memoize per-year lookup so we don't rebuild the set every call.
const holidayCache = new Map<number, Set<string>>();

export function isFederalHoliday(date: Date): boolean {
  const year = date.getUTCFullYear();
  let set = holidayCache.get(year);
  if (!set) {
    set = federalHolidaysForYear(year);
    holidayCache.set(year, set);
  }
  return set.has(formatYmd(date));
}

export function isBankingDay(date: Date): boolean {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isFederalHoliday(date);
}

export function nextBankingDay(date: Date): Date {
  let d = date;
  while (!isBankingDay(d)) d = addDays(d, 1);
  return d;
}

// ─── Quarters ─────────────────────────────────────────────────────────────────

export interface QuarterInfo {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** First day of the quarter. YYYY-MM-DD. */
  quarterStart: string;
  /** Last day of the quarter. YYYY-MM-DD. */
  quarterEnd: string;
}

/** Resolves the calendar quarter that contains the given pay date. */
export function quarterForPayDate(payDateYmd: string): QuarterInfo {
  const d = parseYmd(payDateYmd);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0..11
  const qIdx = Math.floor(m / 3); // 0..3
  const startMonth = qIdx * 3; // 0,3,6,9
  const endMonth = startMonth + 2; // 2,5,8,11
  return {
    year: y,
    quarter: (qIdx + 1) as 1 | 2 | 3 | 4,
    quarterStart: formatYmd(new Date(Date.UTC(y, startMonth, 1))),
    quarterEnd: formatYmd(lastDayOfMonth(y, endMonth + 1)),
  };
}

// ─── Federal 941 deposits ─────────────────────────────────────────────────────

function monthlyDueDate(payDate: Date): Date {
  const y = payDate.getUTCFullYear();
  const m = payDate.getUTCMonth(); // 0..11
  const dueY = m === 11 ? y + 1 : y;
  const dueM = m === 11 ? 0 : m + 1;
  return nextBankingDay(new Date(Date.UTC(dueY, dueM, 15)));
}

/** IRS Pub 15 semiweekly schedule. Returns the base due date, with the
 *  three-banking-day holiday extension applied. */
function semiweeklyDueDate(payDate: Date): Date {
  const dow = payDate.getUTCDay(); // 0=Sun..6=Sat
  let periodEnd: Date;
  let baseDue: Date;
  if (dow === 3 || dow === 4 || dow === 5) {
    // Wed/Thu/Fri payday -> semiweekly period ends Friday -> due following Wed
    periodEnd = addDays(payDate, 5 - dow);
    baseDue = addDays(periodEnd, 5); // Fri + 5 days = next Wed
  } else {
    // Sat/Sun/Mon/Tue payday -> semiweekly period ends Tuesday -> due Friday
    const daysToTue =
      dow === 6 ? 3 : dow === 0 ? 2 : dow === 1 ? 1 : /* dow 2 */ 0;
    periodEnd = addDays(payDate, daysToTue);
    baseDue = addDays(periodEnd, 3); // Tue + 3 days = Fri
  }

  // Three-banking-day extension: one extra banking day per holiday within the
  // three weekdays immediately following the end of the semiweekly period.
  // "Weekdays" means Mon-Fri only, so for a Fri period end the window is
  // Mon/Tue/Wed (skipping Sat/Sun), not the three calendar days after Fri.
  let extension = 0;
  let probe = periodEnd;
  let weekdaysSeen = 0;
  while (weekdaysSeen < 3) {
    probe = addDays(probe, 1);
    const dow = probe.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    weekdaysSeen++;
    if (isFederalHoliday(probe)) extension++;
  }
  let due = baseDue;
  // Apply the extension as banking days, not calendar days.
  for (let i = 0; i < extension; i++) due = nextBankingDay(addDays(due, 1));
  // Finally, roll due forward if it landed on a non-banking day.
  return nextBankingDay(due);
}

/** Federal 941 (income tax + FICA) deposit due date for a given pay date. */
export function federal941DueDate(
  payDateYmd: string,
  schedule: FederalDepositSchedule,
): string {
  const d = parseYmd(payDateYmd);
  const due = schedule === "monthly" ? monthlyDueDate(d) : semiweeklyDueDate(d);
  return formatYmd(due);
}

/** IRS $100,000 next-day rule threshold. If the accumulated undeposited 941
 *  liability reaches this on a single day, the deposit is due the next
 *  banking day and the employer is moved to the semiweekly schedule for the
 *  remainder of the year. The UI surfaces this as a warning so the admin can
 *  hand-adjust; this helper is the threshold check only. */
export const ONE_HUNDRED_K_RULE_THRESHOLD = 100_000;

export function triggersNextDayRule(accumulatedLiability: number): boolean {
  return accumulatedLiability >= ONE_HUNDRED_K_RULE_THRESHOLD;
}

// ─── State withholding deposits (Arizona A1-WP) ───────────────────────────────

/** Arizona mirrors the federal monthly/semiweekly schedules. The quarterly
 *  option has its withholding paid with the A1-QRT filing, due on the last
 *  day of the month following the quarter end. */
export function stateWithholdingDueDate(
  payDateYmd: string,
  schedule: StateDepositSchedule,
): string {
  const d = parseYmd(payDateYmd);
  if (schedule === "quarterly") {
    return formatYmd(quarterlyFilingDueDateFor(d));
  }
  if (schedule === "monthly") {
    return formatYmd(monthlyDueDate(d));
  }
  return formatYmd(semiweeklyDueDate(d));
}

// ─── Quarterly filings & deposits (FUTA, SUTA, A1-QRT, A1-WP quarterly) ───────

/** Last day of the month following the quarter that contains `d`, rolled
 *  forward to the next banking day. */
function quarterlyFilingDueDateFor(d: Date): Date {
  const { quarterEnd } = quarterForPayDate(formatYmd(d));
  const qEnd = parseYmd(quarterEnd);
  const y = qEnd.getUTCFullYear();
  const m = qEnd.getUTCMonth(); // 2,5,8,11
  const dueY = m === 11 ? y + 1 : y;
  const dueM = (m + 1) % 12; // 3,6,9,0
  const due = lastDayOfMonth(dueY, dueM + 1);
  return nextBankingDay(due);
}

/** FUTA $500 cumulative-YTD threshold. Deposits only become required once
 *  accumulated undeposited FUTA exceeds this amount at a quarter end. */
export const FUTA_DEPOSIT_THRESHOLD = 500;

/** Returns { dueDate, quarterEnd, quarterStart, quarter } for FUTA quarterly
 *  deposits covering the quarter that contains `payDateYmd`. The caller must
 *  still apply the $500 threshold rule against accumulated FUTA. Q4 residual
 *  FUTA is payable with Form 940 by Jan 31 regardless of threshold. */
export function futaQuarterlyDueDate(payDateYmd: string): QuarterInfo & {
  dueDate: string;
} {
  const quarter = quarterForPayDate(payDateYmd);
  const due = quarterlyFilingDueDateFor(parseYmd(payDateYmd));
  return { ...quarter, dueDate: formatYmd(due) };
}

/** AZ SUTA (UC-018/UC-019) and A1-QRT: same due-date math as FUTA. */
export function stateQuarterlyDueDate(payDateYmd: string): QuarterInfo & {
  dueDate: string;
} {
  return futaQuarterlyDueDate(payDateYmd);
}

// ─── Form due dates (informational) ───────────────────────────────────────────

/** Form 941 (quarterly employer return) due dates per IRS: last day of month
 *  following the quarter. If all deposits were made on time, the filing gets
 *  a 10-day extension (not represented here; admin should adjust if applicable). */
export function form941DueDate(year: number, quarter: 1 | 2 | 3 | 4): string {
  const endMonth = quarter * 3; // 3,6,9,12
  const dueY = endMonth === 12 ? year + 1 : year;
  const dueM = (endMonth % 12) + 1; // 4,7,10,1
  return formatYmd(nextBankingDay(lastDayOfMonth(dueY, dueM)));
}

/** Form 940 (annual FUTA): due Jan 31 of the following year. If all deposits
 *  on time, extended to Feb 10 (not automatic here). */
export function form940DueDate(year: number): string {
  return formatYmd(nextBankingDay(new Date(Date.UTC(year + 1, 0, 31))));
}

/** W-2 / W-3 / EFW2: due Jan 31 of the following year (both employee copies
 *  and SSA filing). */
export function w2DueDate(year: number): string {
  return formatYmd(nextBankingDay(new Date(Date.UTC(year + 1, 0, 31))));
}

/** AZ Form A1-QRT (quarterly state withholding return): due last day of
 *  month following the quarter, same cadence as the 941. */
export function formA1QrtDueDate(year: number, quarter: 1 | 2 | 3 | 4): string {
  return form941DueDate(year, quarter);
}

/** AZ Form A1-APR (annual payment/return reconciliation): due by
 *  February 28 (statute; AZDOR publishes the precise day). Use Feb 28 and
 *  roll forward to the next banking day. */
export function formA1AprDueDate(year: number): string {
  return formatYmd(nextBankingDay(new Date(Date.UTC(year + 1, 1, 28))));
}
