import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ExpenseDetailContent } from "@/components/features/expenses/expense-detail-content";
import { isDemoMode } from "@/lib/demo";
import { getDemoExpense, getDemoExpenseHistory } from "@/lib/demo/data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const expense = getDemoExpense(id);
    if (!expense) {
      return { title: "Expense Not Found" };
    }
    return { title: expense.name };
  }

  const supabase = await createClient();

  const { data: expense } = await supabase
    .from("expenses")
    .select("name")
    .eq("id", id)
    .single();

  if (!expense) {
    return { title: "Expense Not Found" };
  }

  return { title: (expense as { name: string }).name };
}

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const expense = getDemoExpense(id);
    if (!expense) {
      notFound();
    }
    const history = getDemoExpenseHistory(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return <ExpenseDetailContent expense={expense as any} history={history as any} />;
  }

  const supabase = await createClient();

  // Fetch the expense with its history
  const { data: expense } = await supabase
    .from("expenses")
    .select("*")
    .eq("id", id)
    .single();

  if (!expense) {
    notFound();
  }

  // Fetch history (excluding soft-deleted entries)
  const { data: history } = await supabase
    .from("expense_history")
    .select("*")
    .eq("expense_id", id)
    .is("deleted_at", null)
    .order("changed_at", { ascending: false })
    .limit(20);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <ExpenseDetailContent expense={expense as any} history={(history || []) as any} />;
}
