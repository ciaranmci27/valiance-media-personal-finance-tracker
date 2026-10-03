import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  centsToDollars,
  presentNetWorth,
  readAll,
  trackerWriteError,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NetWorthRow = Parameters<typeof presentNetWorth>[0];

/** Net worth entries, oldest first, read after api_authorize checked net_worth.read. */
export const GET = withApi(
  apiOperation("tracker.net_worth"),
  async ({ query, service }) => {
    if (query.from && query.to && query.from > query.to)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "from must be on or before to.",
        { reason: "invalid_range" },
      );
    const rows = await readAll<NetWorthRow>((start, end) => {
      let request = service
        .from("net_worth")
        .select("id, date, amount, notes")
        .is("deleted_at", null);
      if (query.from) request = request.gte("date", query.from);
      if (query.to) request = request.lte("date", query.to);
      return request
        .order("date", { ascending: true })
        .order("id", { ascending: true })
        .range(start, end);
    }, "net worth");
    const entries = rows.map(presentNetWorth);
    return {
      data: { entries, latest_cents: entries.at(-1)?.amount_cents ?? null },
    };
  },
);

/** Adds a net worth entry; one per date (a taken date answers 409). Checked for net_worth.manage. */
export const POST = withApi(
  apiOperation("tracker.net_worth_create"),
  async ({ body, service }) => {
    const { data, error } = await service
      .from("net_worth")
      .insert({
        date: body.date,
        amount: centsToDollars(body.amount_cents),
        notes: body.notes?.trim() || null,
      })
      .select("id, date, amount, notes")
      .single();
    if (error || !data)
      throw trackerWriteError(error ?? {}, "net worth entry for that date");
    return { data: presentNetWorth(data as NetWorthRow) };
  },
);
