import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  INCOME_ITEM_COLUMNS,
  centsToDollars,
  incomeMonth,
  presentIncomeItem,
  readAll,
  trackerWriteError,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ItemRow = Parameters<typeof presentIncomeItem>[0];

/** The income items behind the monthly totals, read after api_authorize checked income.read. */
export const GET = withApi(
  apiOperation("tracker.income_items"),
  async ({ query, service }) => {
    if (query.from && query.to && query.from > query.to)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "from must be on or before to.",
        { reason: "invalid_range" },
      );
    const rows = await readAll<ItemRow>((start, end) => {
      let request = service
        .from("income_line_items")
        .select(INCOME_ITEM_COLUMNS)
        .is("deleted_at", null);
      if (query.from) request = request.gte("received_date", query.from);
      if (query.to) request = request.lte("received_date", query.to);
      return request
        .order("received_date", { ascending: true })
        .order("id", { ascending: true })
        .range(start, end);
    }, "the income tracker");
    return { data: { items: rows.map(presentIncomeItem) } };
  },
);

/**
 * Adds an income item the way the Income screen does: open (or restore) the
 * month, then insert the item; the month's totals follow by trigger. Checked
 * by api_authorize for income.manage on the key and its member.
 */
export const POST = withApi(
  apiOperation("tracker.income_item_create"),
  async ({ body, service }) => {
    const entryId = await incomeMonth(service, body.received_date);
    const { data, error } = await service
      .from("income_line_items")
      .insert({
        entry_id: entryId,
        source_id: body.source_id,
        received_date: body.received_date,
        amount: centsToDollars(body.amount_cents),
        notes: body.notes?.trim() || null,
      })
      .select(INCOME_ITEM_COLUMNS)
      .single();
    if (error || !data) throw trackerWriteError(error ?? {}, "income item");
    return { data: presentIncomeItem(data as ItemRow) };
  },
);
