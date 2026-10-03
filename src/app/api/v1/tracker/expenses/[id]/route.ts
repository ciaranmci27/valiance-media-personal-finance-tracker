import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  EXPENSE_COLUMNS,
  centsToDollars,
  presentExpense,
  trackerWriteError,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExpenseRow = Parameters<typeof presentExpense>[0];

const notFound = () =>
  new ApiError(404, "NOT_FOUND", "No expense with that id.", {
    reason: "not_found",
  });

/** Changes, pauses or resumes an expense; the history trigger records it. */
export const PATCH = withApi(
  apiOperation("tracker.expense_update"),
  async ({ params, body, service }) => {
    const changes: Record<string, unknown> = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.amount_cents !== undefined)
      changes.amount = centsToDollars(body.amount_cents);
    if (body.frequency !== undefined) changes.frequency = body.frequency;
    if (body.expense_type !== undefined)
      changes.expense_type = body.expense_type;
    if (body.category !== undefined) changes.category = body.category;
    if (body.is_active !== undefined) changes.is_active = body.is_active;
    if (body.effective_date !== undefined)
      changes.effective_date = body.effective_date;
    if (body.notes !== undefined) changes.notes = body.notes?.trim() || null;
    const { data, error } = await service
      .from("expenses")
      .update(changes)
      .eq("id", params.id)
      .is("deleted_at", null)
      .select(EXPENSE_COLUMNS)
      .maybeSingle();
    if (error) throw trackerWriteError(error, "expense");
    if (!data) throw notFound();
    return { data: presentExpense(data as ExpenseRow) };
  },
);

/** Moves an expense to Trash, as the Expenses screen does. */
export const DELETE = withApi(
  apiOperation("tracker.expense_delete"),
  async ({ params, service }) => {
    const { data, error } = await service
      .from("expenses")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw trackerWriteError(error, "expense");
    if (!data) throw notFound();
    return { data: { id: params.id, deleted: true as const } };
  },
);
