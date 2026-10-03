import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./http";

/**
 * The tracker modules store dollars as NUMERIC with two decimals; the API
 * answers in integer cents everywhere. Postgres returns NUMERIC as a string or
 * a number; both convert exactly here.
 */
export function dollarsToCents(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "0";
  const text = typeof value === "number" ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?\d*$/.exec(text);
  if (!match)
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "A stored amount could not be read.",
      { reason: "bad_amount" },
    );
  const [, sign, whole, fraction = ""] = match;
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return (sign && cents !== BigInt(0) ? -cents : cents).toString();
}

const PAGE = 1000;

/**
 * Every row of a select. PostgREST caps one response (db-max-rows, 1000 by
 * default), so rows are read a page at a time. `page` must build the query
 * fresh with an order that ends on a unique column. Reading stops on an empty
 * page rather than a short one, so a server cap below PAGE cannot end it early.
 */
export async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  what: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + PAGE - 1);
    if (error)
      throw new ApiError(500, "INTERNAL_ERROR", `Could not read ${what}.`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

export function sumCents(values: string[]): string {
  return values
    .reduce((total, value) => total + BigInt(value), BigInt(0))
    .toString();
}

/** The first day of the month holding `date`. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** `months` months before the month holding `date`, as its first day. */
export function monthsBefore(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 - months;
  const shifted = new Date(Date.UTC(year, month, 1));
  return shifted.toISOString().slice(0, 10);
}

/** Twelfths of a month per occurrence: an amount times this, over 12, is its monthly figure. */
const TWELFTHS: Record<string, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

/**
 * The monthly total of many recurring amounts, rounded once at the end like
 * the Expenses screen (which sums unrounded monthly figures).
 */
export function monthlyTotalCents(
  rows: { amountCents: string; frequency: string }[],
): string {
  const twelfths = rows.reduce(
    (sum, row) =>
      sum + BigInt(row.amountCents) * BigInt(TWELFTHS[row.frequency] ?? 12),
    BigInt(0),
  );
  const half = twelfths >= BigInt(0) ? BigInt(6) : -BigInt(6);
  return ((twelfths + half) / BigInt(12)).toString();
}

/** A recurring amount expressed per month, rounded to the cent (half away from zero). */
export function monthlyCents(amountCents: string, frequency: string): string {
  const cents = BigInt(amountCents);
  const [numerator, denominator] =
    frequency === "weekly"
      ? [52, 12]
      : frequency === "quarterly"
        ? [1, 3]
        : frequency === "annual"
          ? [1, 12]
          : [1, 1];
  const scaled = cents * BigInt(numerator) * BigInt(2);
  const divisor = BigInt(denominator) * BigInt(2);
  const half = scaled >= BigInt(0) ? BigInt(denominator) : -BigInt(denominator);
  return ((scaled + half) / divisor).toString();
}

/** Integer cents to the trackers' NUMERIC(…,2) dollars, exactly: "-12345" becomes "-123.45". */
export function centsToDollars(cents: string): string {
  const value = BigInt(cents);
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = absolute / BigInt(100);
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** A database refusal on a tracker write, as an API error. */
export function trackerWriteError(
  error: { code?: string; message?: string },
  what: string,
): ApiError {
  if (error.code === "23505")
    return new ApiError(409, "CONFLICT", `That ${what} already exists.`, {
      reason: "duplicate",
    });
  if (error.code === "23503")
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      `The ${what} refers to something that does not exist.`,
      {
        reason: "invalid_reference",
      },
    );
  if (
    error.code === "23514" ||
    error.code === "P0001" ||
    error.code === "22P02"
  )
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      `The ${what} was refused: ${error.message ?? "invalid value"}.`,
      {
        reason: "invalid_parameters",
      },
    );
  return new ApiError(500, "INTERNAL_ERROR", `Could not save the ${what}.`);
}

/**
 * The income month holding `date`, created or restored as needed: the same
 * steps as the Income screen (lib/income-ledger.ts ensureIncomeEntryForDate).
 */
export async function incomeMonth(
  service: SupabaseClient,
  date: string,
): Promise<string> {
  const month = monthOf(date);
  const read = () =>
    service
      .from("income_entries")
      .select("id, deleted_at")
      .eq("month", month)
      .maybeSingle();
  const first = await read();
  if (first.error) throw trackerWriteError(first.error, "income month");
  let entry = first.data;
  if (!entry) {
    const created = await service
      .from("income_entries")
      .insert({ month })
      .select("id, deleted_at")
      .maybeSingle();
    // Another request may have made the month first; read it back.
    if (created.error && created.error.code !== "23505")
      throw trackerWriteError(created.error, "income month");
    entry = created.data ?? (await read()).data;
    if (!entry)
      throw new ApiError(
        500,
        "INTERNAL_ERROR",
        "Could not open the income month.",
      );
  }
  if (entry.deleted_at) {
    const restored = await service
      .from("income_entries")
      .update({ deleted_at: null })
      .eq("id", entry.id);
    if (restored.error) throw trackerWriteError(restored.error, "income month");
  }
  return entry.id as string;
}

export const INCOME_ITEM_COLUMNS =
  "id, entry_id, source_id, received_date, amount, notes, external_source";

export function presentIncomeItem(row: {
  id: string;
  source_id: string;
  received_date: string;
  amount: string | number;
  notes: string | null;
  external_source: string | null;
}) {
  return {
    id: row.id,
    received_date: row.received_date,
    month: monthOf(row.received_date),
    source_id: row.source_id,
    amount_cents: dollarsToCents(row.amount),
    notes: row.notes ?? null,
    external_source: row.external_source ?? null,
  };
}

export const EXPENSE_COLUMNS =
  "id, name, amount, frequency, expense_type, category, is_active, effective_date, notes";

export function presentExpense(row: {
  id: string;
  name: string;
  amount: string | number;
  frequency: string;
  expense_type: string;
  category: string | null;
  is_active: boolean;
  effective_date: string;
  notes: string | null;
}) {
  const amount = dollarsToCents(row.amount);
  return {
    id: row.id,
    name: row.name,
    amount_cents: amount,
    frequency: row.frequency,
    monthly_cents: monthlyCents(amount, row.frequency),
    expense_type: row.expense_type,
    category: row.category ?? null,
    is_active: row.is_active,
    effective_date: row.effective_date,
    notes: row.notes ?? null,
  };
}

export function presentNetWorth(row: {
  id: string;
  date: string;
  amount: string | number;
  notes: string | null;
}) {
  return {
    id: row.id,
    date: row.date,
    amount_cents: dollarsToCents(row.amount),
    notes: row.notes ?? null,
  };
}
