import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  INCOME_ITEM_COLUMNS,
  centsToDollars,
  incomeMonth,
  monthOf,
  presentIncomeItem,
  trackerWriteError,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ItemRow = Parameters<typeof presentIncomeItem>[0];

const notFound = () =>
  new ApiError(404, "NOT_FOUND", "No income item with that id.", {
    reason: "not_found",
  });

/** Changes an income item; a new date in another month moves it to that month. */
export const PATCH = withApi(
  apiOperation("tracker.income_item_update"),
  async ({ params, body, service }) => {
    const { data: current, error: readError } = await service
      .from("income_line_items")
      .select("id, received_date")
      .eq("id", params.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (readError) throw trackerWriteError(readError, "income item");
    if (!current) throw notFound();

    const changes: Record<string, unknown> = {};
    if (body.received_date !== undefined) {
      changes.received_date = body.received_date;
      if (
        monthOf(body.received_date) !== monthOf(current.received_date as string)
      )
        changes.entry_id = await incomeMonth(service, body.received_date);
    }
    if (body.source_id !== undefined) changes.source_id = body.source_id;
    if (body.amount_cents !== undefined)
      changes.amount = centsToDollars(body.amount_cents);
    if (body.notes !== undefined) changes.notes = body.notes?.trim() || null;

    const { data, error } = await service
      .from("income_line_items")
      .update(changes)
      .eq("id", params.id)
      .is("deleted_at", null)
      .select(INCOME_ITEM_COLUMNS)
      .maybeSingle();
    if (error) throw trackerWriteError(error, "income item");
    if (!data) throw notFound();
    return { data: presentIncomeItem(data as ItemRow) };
  },
);

/** Moves an income item to Trash; the month's totals follow by trigger. */
export const DELETE = withApi(
  apiOperation("tracker.income_item_delete"),
  async ({ params, service }) => {
    const { data, error } = await service
      .from("income_line_items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw trackerWriteError(error, "income item");
    if (!data) throw notFound();
    return { data: { id: params.id, deleted: true as const } };
  },
);
