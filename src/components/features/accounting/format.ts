import { formatCents } from "@/lib/accounting/money";

/**
 * The one place the accounting UI formats money, dates and enum labels.
 * Components import from here instead of carrying their own copies.
 */

export const BOOKS_TIMEZONE = "America/Phoenix";

/** The current date in the books, independent of the selected reporting period. */
export function booksToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Whole-dollar or cent-exact display of integer cents, with a leading minus. */
export function money(cents: string | bigint | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "$0.00";
  return formatCents(cents);
}

/** Signed money with an explicit plus for inflows, for review rows. */
export function signedMoney(cents: string | bigint): string {
  const text = formatCents(cents);
  return text.startsWith("-") ? text : `+${text}`;
}

/** Money with the sign dropped, for columns that already say in or out. */
export function absMoney(cents: string | bigint): string {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  return formatCents(value < BigInt(0) ? -value : value);
}

const dateLong = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const dateShort = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const monthLong = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: BOOKS_TIMEZONE,
});

/** Financial dates arrive as `YYYY-MM-DD`; format them without a timezone shift. */
export function dateLabel(date: string | null | undefined): string {
  if (!date) return "";
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : dateLong.format(parsed);
}

/** Same as `dateLabel` without the year, for dense rows. */
export function dateShortLabel(date: string | null | undefined): string {
  if (!date) return "";
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : dateShort.format(parsed);
}

/** `YYYY-MM` or `YYYY-MM-DD` to "September 2026". */
export function monthLabel(month: string | null | undefined): string {
  if (!month) return "";
  const parsed = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? month : monthLong.format(parsed);
}

const monthShort = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});
const monthShortYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/** "Sep", or "Sep 26" when `withYear` is set, for chart axes. */
export function monthShortLabel(
  month: string | null | undefined,
  withYear = false,
): string {
  if (!month) return "";
  const parsed = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return (withYear ? monthShortYear : monthShort).format(parsed);
}

/** Timestamps (audit rows, sync runs) in the books timezone. */
export function timestampLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateTime.format(parsed);
}

/** Today's financial date in the books timezone. */
export function todayInBooks(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** `invoice_receipt` to "Invoice receipt". */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return "";
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "3 transactions", "1 receipt". */
export function countLabel(count: number, singular: string, plural?: string) {
  return `${count.toLocaleString()} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/**
 * A bank-fed or imported entry that has not been reviewed is real activity
 * waiting for a category, not a draft; "draft" is reserved for entries the
 * owner is still writing by hand. Posted entries carry no state word.
 */
export function entryStateLabel(entry: {
  status: string;
  primary_origin: string;
}): "Draft" | "Unreviewed" | null {
  if (entry.status !== "draft") return null;
  return entry.primary_origin === "manual" || entry.primary_origin === "internal"
    ? "Draft"
    : "Unreviewed";
}
