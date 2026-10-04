import { z } from "zod";
import { dateSchema } from "./contracts";
import type { AccountingQuery } from "./read-cache";

/**
 * Recurring charges the books find in their own transactions
 * (accounting.recurring): money out to the same contact, or under the same
 * bank description, on a steady weekly, monthly, quarterly or yearly beat.
 * Transfers, card payments and reversed pairs never count. A series that
 * has missed one and a half beats is stopped.
 */

export const recurringFilterSchema = z
  .object({
    as_of: dateSchema,
    mode: z.enum(["posted", "working"]),
    status: z.enum(["all", "active", "stopped"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
export type RecurringFilter = z.infer<typeof recurringFilterSchema>;

export type Cadence = "weekly" | "monthly" | "quarterly" | "annual";

export interface RecurringSeries {
  contact: { id: string; name: string } | null;
  descriptor_key: string | null;
  category: string | null;
  bank_account: string | null;
  cadence: Cadence;
  count: number;
  first_date: string;
  last_date: string;
  next_expected: string;
  status: "active" | "stopped";
  last_cents: string;
  previous_cents: string | null;
  average_cents: string;
  price_change: { on: string; from_cents: string; to_cents: string } | null;
  annual_cents: string;
}

export interface RecurringData {
  as_of: string;
  from: string;
  book_mode: "posted" | "working";
  total: number;
  offset: number;
  limit: number;
  totals: {
    active: number;
    stopped: number;
    active_annual_cents: string;
    active_monthly_cents: string;
  };
  series: RecurringSeries[];
}

export function recurringQuery(filter: RecurringFilter): AccountingQuery {
  return { view: "recurring", filter: JSON.stringify(filter) };
}

/** The recurring read for a report period: everything known as of its last day. */
export function recurringFilterFor(period: { to: string; mode: "posted" | "working" }): RecurringFilter {
  return { as_of: period.to, mode: period.mode, status: "all", limit: 100 };
}

const PER_YEAR: Record<Cadence, number> = { weekly: 52, monthly: 12, quarterly: 4, annual: 1 };
const big = (v: string | null | undefined) => BigInt(v || "0");

export const CADENCE_WORDS: Record<Cadence, string> = {
  weekly: "Every week",
  monthly: "Every month",
  quarterly: "Every quarter",
  annual: "Every year",
};

export interface RecurringRow {
  key: string;
  name: string;
  /** The contact, when the series has one: its transactions can be opened. */
  contactId: string | null;
  category: string | null;
  cadence: Cadence;
  /** The latest charge, and what it comes to per month. */
  last: bigint;
  monthly: bigint;
  status: "active" | "stopped";
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  priceChange: { on: string; from: bigint; to: bigint } | null;
}

export interface RecurringSummary {
  /** Active charges, biggest per month first. */
  active: RecurringRow[];
  monthly: bigint;
  annual: bigint;
  /** Active series whose first charge fell in the period. */
  started: RecurringRow[];
  /** Price rises (or cuts) that took effect in the period, on active series. */
  increases: RecurringRow[];
  decreases: RecurringRow[];
  /** Series that stopped: the next charge was due in the period and never came. */
  stopped: RecurringRow[];
  /** The books found more series than one read returns. */
  partial: boolean;
}

export function recurringRow(s: RecurringSeries): RecurringRow {
  const last = big(s.last_cents);
  return {
    key: s.contact ? `c:${s.contact.id}` : `d:${s.descriptor_key ?? ""}`,
    name: s.contact?.name ?? s.descriptor_key ?? "Unnamed charge",
    contactId: s.contact?.id ?? null,
    category: s.category,
    cadence: s.cadence,
    last,
    monthly: (last * BigInt(PER_YEAR[s.cadence])) / BigInt(12),
    status: s.status,
    firstDate: s.first_date,
    lastDate: s.last_date,
    nextExpected: s.next_expected,
    priceChange: s.price_change
      ? { on: s.price_change.on, from: big(s.price_change.from_cents), to: big(s.price_change.to_cents) }
      : null,
  };
}

export function recurringSummary(
  data: RecurringData,
  period: { from: string; to: string },
): RecurringSummary {
  const rows = data.series.map(recurringRow);
  const within = (d: string | undefined) => !!d && d >= period.from && d <= period.to;
  const active = rows
    .filter((r) => r.status === "active")
    .sort((a, b) => (b.monthly > a.monthly ? 1 : b.monthly < a.monthly ? -1 : 0));
  return {
    active,
    monthly: big(data.totals.active_monthly_cents),
    annual: big(data.totals.active_annual_cents),
    started: active.filter((r) => within(r.firstDate)),
    increases: active.filter((r) => r.priceChange && within(r.priceChange.on) && r.priceChange.to > r.priceChange.from),
    decreases: active.filter((r) => r.priceChange && within(r.priceChange.on) && r.priceChange.to < r.priceChange.from),
    stopped: rows.filter((r) => r.status === "stopped" && within(r.nextExpected)),
    partial: data.total > data.series.length,
  };
}

