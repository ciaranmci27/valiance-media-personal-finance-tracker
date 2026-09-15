import { createClient } from "@/lib/supabase/server";
import { ExpensesListContent } from "@/components/features/expenses/expenses-list-content";
import { isDemoMode } from "@/lib/demo";
import { demoExpenses, demoExpenseHistory } from "@/lib/demo/data";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Fixed Expenses",
};

export default async function ExpensesPage() {
  if (!(await canAccess("expenses.read"))) return <AccessDenied area="Expenses" />;
  // Return demo data if in demo mode
  if (isDemoMode()) {
    return (
      <ExpensesListContent
        expenses={demoExpenses}
        history={demoExpenseHistory}
      />
    );
  }

  const supabase = await createClient();

  const [{ data: expenses }, { data: history }] = await Promise.all([
    supabase
      .from("expenses")
      .select("*")
      .is("deleted_at", null)
      .order("expense_type")
      .order("amount", { ascending: false }),
    supabase
      .from("expense_history")
      .select("*")
      .is("deleted_at", null)
      .order("changed_at", { ascending: true }),
  ]);

  return (
    <ExpensesListContent
      expenses={expenses || []}
      history={history || []}
    />
  );
}
