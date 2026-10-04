/**
 * The books' fiscal year, from the business settings' start month (1 to 12,
 * January when unset). The books compute "this year" the same way: the year
 * starts on the first of that month on or before the date.
 */

const pad = (n: number) => String(n).padStart(2, "0");

export const normalizeMonth = (month: number | null | undefined) =>
  Number.isInteger(month) && month! >= 1 && month! <= 12 ? month! : 1;

/** The first day of the fiscal year the date falls in. */
export function fiscalYearStart(date: string, month?: number | null): string {
  const m = normalizeMonth(month);
  const year = Number(date.slice(0, 4)),
    current = Number(date.slice(5, 7));
  return `${m <= current ? year : year - 1}-${pad(m)}-01`;
}

/** The last day of the fiscal year before the one the date falls in. */
export function fiscalPriorEnd(date: string, month?: number | null): string {
  const start = fiscalYearStart(date, month);
  return new Date(Date.parse(`${start}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
