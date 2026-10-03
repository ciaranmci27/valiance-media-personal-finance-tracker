import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  centsToDollars,
  presentNetWorth,
  trackerWriteError,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NetWorthRow = Parameters<typeof presentNetWorth>[0];

const notFound = () =>
  new ApiError(404, "NOT_FOUND", "No net worth entry with that id.", {
    reason: "not_found",
  });

/** Changes a net worth entry. Checked for net_worth.manage. */
export const PATCH = withApi(
  apiOperation("tracker.net_worth_update"),
  async ({ params, body, service }) => {
    const changes: Record<string, unknown> = {};
    if (body.date !== undefined) changes.date = body.date;
    if (body.amount_cents !== undefined)
      changes.amount = centsToDollars(body.amount_cents);
    if (body.notes !== undefined) changes.notes = body.notes?.trim() || null;
    const { data, error } = await service
      .from("net_worth")
      .update(changes)
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id, date, amount, notes")
      .maybeSingle();
    if (error) throw trackerWriteError(error, "net worth entry for that date");
    if (!data) throw notFound();
    return { data: presentNetWorth(data as NetWorthRow) };
  },
);

/** Moves a net worth entry to Trash, as the Net Worth screen does. */
export const DELETE = withApi(
  apiOperation("tracker.net_worth_delete"),
  async ({ params, service }) => {
    const { data, error } = await service
      .from("net_worth")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw trackerWriteError(error, "net worth entry");
    if (!data) throw notFound();
    return { data: { id: params.id, deleted: true as const } };
  },
);
