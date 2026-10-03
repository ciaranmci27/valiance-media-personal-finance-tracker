import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import { booksClient, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Recurring {
  as_of: string;
  from: string;
  book_mode: "working" | "posted";
  total: number;
  offset: number;
  limit: number;
  totals: Record<string, unknown>;
  series: Record<string, unknown>[];
  revision: string;
}

/** Recurring charges and subscriptions found in the books' transactions (accounting.recurring). */
export const GET = withApi(
  apiOperation("books.recurring"),
  async ({ query, keyHash, service }) => {
    if (query.from && query.as_of && query.from > query.as_of)
      throw new ApiError(422, "VALIDATION_ERROR", "from must be on or before as_of.", { reason: "invalid_range" });
    const result = await booksRead<Recurring>(booksClient(service, keyHash), "recurring", {
      params: {
        status: query.status,
        min_count: query.min_count,
        mode: query.mode,
        offset: query.offset,
        limit: query.limit,
        ...(query.from ? { from: query.from } : {}),
        ...(query.as_of ? { as_of: query.as_of } : {}),
        ...(query.contact ? { contact: query.contact } : {}),
      },
    });
    const reached = result.offset + result.series.length;
    const fields = ["contact", "descriptor_key", "category", "bank_account", "cadence", "count", "first_date", "last_date", "next_expected", "status", "last_cents", "previous_cents", "average_cents", "price_change", "annual_cents"];
    return {
      data: {
        as_of: result.as_of,
        from: result.from,
        book_mode: result.book_mode,
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        next_offset: result.series.length > 0 && reached < result.total ? reached : null,
        totals: {
          active: result.totals.active,
          stopped: result.totals.stopped,
          active_annual_cents: result.totals.active_annual_cents,
          active_monthly_cents: result.totals.active_monthly_cents,
        },
        // Fields in reading order (SQL objects come back sorted by key length).
        series: result.series.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))),
        revision: result.revision,
      },
    };
  },
);
