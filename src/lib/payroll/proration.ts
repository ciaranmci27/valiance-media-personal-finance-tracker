// Partial-period proration.
//
// Used when hire_date or termination_date falls within the pay period, so
// the employee was only on payroll for a portion of the period. Calendar-day
// proration is the simplest defensible method (business-day proration is
// also legal but varies by company policy).
//
// Formula:
//   daysInPeriod = period_end - period_start + 1  (inclusive on both ends)
//   daysWorked   = min(period_end, termination_or_end)
//                  - max(period_start, hire_or_start) + 1
//   proratedAmount = basePeriodAmount * (daysWorked / daysInPeriod)
//
// If daysWorked <= 0, the result is 0 (employee was not on payroll during
// any portion of the period).
//
// For annual pay_frequency, the "period" is a full year. Mid-year hire
// prorates by fraction of the year worked. This is consistent with how
// year-end true-ups are typically computed.

import { round2 } from "./rounding";

const ONE_DAY_MS = 86_400_000;

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetweenInclusive(startStr: string, endStr: string): number {
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  return Math.round((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1;
}

export interface ProrationInput {
  basePeriodAmount: number;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  hireDate?: string | null;       // YYYY-MM-DD
  terminationDate?: string | null; // YYYY-MM-DD
}

export interface ProrationResult {
  proratedAmount: number;
  daysInPeriod: number;
  daysWorked: number;
  /** True if any proration was applied (hire or term fell in period). */
  wasProrated: boolean;
}

export function prorate(input: ProrationInput): ProrationResult {
  const daysInPeriod = daysBetweenInclusive(input.periodStart, input.periodEnd);
  if (daysInPeriod <= 0) {
    return {
      proratedAmount: 0,
      daysInPeriod: 0,
      daysWorked: 0,
      wasProrated: false,
    };
  }

  // Effective window = intersection of [periodStart, periodEnd] and
  // [hireDate, terminationDate]. If hire/term are null, they don't restrict.
  const hireAffects =
    input.hireDate != null && input.hireDate > input.periodStart;
  const termAffects =
    input.terminationDate != null && input.terminationDate < input.periodEnd;

  const effStart = hireAffects ? (input.hireDate as string) : input.periodStart;
  const effEnd = termAffects
    ? (input.terminationDate as string)
    : input.periodEnd;

  let daysWorked = 0;
  if (effStart <= effEnd) {
    daysWorked = daysBetweenInclusive(effStart, effEnd);
  }

  const wasProrated = hireAffects || termAffects;
  const fraction = daysInPeriod > 0 ? daysWorked / daysInPeriod : 0;
  const prorated = Math.max(0, input.basePeriodAmount || 0) * fraction;

  return {
    proratedAmount: round2(prorated),
    daysInPeriod,
    daysWorked,
    wasProrated,
  };
}
