import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import {
  EXPENSE_COLUMNS,
  centsToDollars,
  monthlyTotalCents,
  presentExpense,
  readAll,
  trackerWriteError,
} from "@/lib/api/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExpenseRow = Parameters<typeof presentExpense>[0];

/** The expenses tracker: known recurring costs and subscriptions, read after api_authorize checked expenses.read. */
export const GET = withApi(
  apiOperation("tracker.expenses"),
  async ({ query, service }) => {
    const rows = await readAll<ExpenseRow>((start, end) => {
      let request = service
        .from("expenses")
        .select(EXPENSE_COLUMNS)
        .is("deleted_at", null);
      if (query.category) request = request.eq("category", query.category);
      if (query.type) request = request.eq("expense_type", query.type);
      if (query.active !== "all")
        request = request.eq("is_active", query.active === "true");
      return request
        .order("name", { ascending: true })
        .order("id", { ascending: true })
        .range(start, end);
    }, "the expenses tracker");
    const expenses = rows.map(presentExpense);
    return {
      data: {
        expenses,
        monthly_total_cents: monthlyTotalCents(
          expenses
            .filter((row) => row.is_active)
            .map((row) => ({
              amountCents: row.amount_cents,
              frequency: row.frequency,
            })),
        ),
      },
    };
  },
);

/** Adds an expense, as the Expenses screen does; its history starts by trigger. Checked for expenses.manage. */
export const POST = withApi(
  apiOperation("tracker.expense_create"),
  async ({ body, service }) => {
    const { data, error } = await service
      .from("expenses")
      .insert({
        name: body.name,
        amount: centsToDollars(body.amount_cents),
        frequency: body.frequency,
        expense_type: body.expense_type,
        category: body.category ?? null,
        is_active: true,
        ...(body.effective_date ? { effective_date: body.effective_date } : {}),
        notes: body.notes?.trim() || null,
      })
      .select(EXPENSE_COLUMNS)
      .single();
    if (error || !data) throw trackerWriteError(error ?? {}, "expense");
    return { data: presentExpense(data as ExpenseRow) };
  },
);
