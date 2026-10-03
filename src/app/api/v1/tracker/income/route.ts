import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import { booksToday } from "@/lib/api/books";
import {
  dollarsToCents,
  monthOf,
  monthsBefore,
  readAll,
  sumCents,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Entry {
  id: string;
  month: string;
  notes: string | null;
}
interface Amount {
  entry_id: string;
  source_id: string;
  amount: string | number;
}

/**
 * The income tracker, read with the service role after api_authorize checked
 * income.read on both the key and its member. Month totals add up the per
 * source amounts, which the line items roll into by trigger, as the Income
 * page does. Every read pages past PostgREST's response cap.
 */
export const GET = withApi(
  apiOperation("tracker.income"),
  async ({ query, service }) => {
    const to = monthOf(query.to ?? (await booksToday(service)));
    const from = query.from ? monthOf(query.from) : monthsBefore(to, 11);
    if (from > to)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "from must be on or before to.",
        {
          reason: "invalid_range",
        },
      );
    if (from < monthsBefore(to, 119))
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Ask for at most 120 months at a time.",
        {
          reason: "invalid_range",
        },
      );

    const [entries, sources] = await Promise.all([
      readAll<Entry>(
        (start, end) =>
          service
            .from("income_entries")
            .select("id, month, notes")
            .is("deleted_at", null)
            .gte("month", from)
            .lte("month", to)
            .order("month", { ascending: true })
            .order("id", { ascending: true })
            .range(start, end),
        "the income tracker",
      ),
      readAll<{ id: string; name: string; slug: string; is_active: boolean }>(
        (start, end) =>
          service
            .from("income_sources")
            .select("id, name, slug, is_active")
            .is("deleted_at", null)
            .order("sort_order", { ascending: true })
            .order("id", { ascending: true })
            .range(start, end),
        "the income tracker",
      ),
    ]);

    const ids = entries.map((entry) => entry.id);
    const amounts = ids.length
      ? await readAll<Amount>(
          (start, end) =>
            service
              .from("income_amounts")
              .select("entry_id, source_id, amount")
              .in("entry_id", ids)
              .order("id", { ascending: true })
              .range(start, end),
          "the income tracker",
        )
      : [];

    const months = entries.map((entry) => {
      const bySource = amounts
        .filter((row) => row.entry_id === entry.id)
        .map((row) => ({
          source_id: row.source_id,
          amount_cents: dollarsToCents(row.amount),
        }))
        .filter((row) => row.amount_cents !== "0");
      return {
        month: entry.month,
        total_cents: sumCents(bySource.map((row) => row.amount_cents)),
        notes: entry.notes ?? null,
        by_source: bySource,
      };
    });
    return {
      data: {
        from,
        to,
        sources,
        months,
        total_cents: sumCents(months.map((month) => month.total_cents)),
      },
    };
  },
);
