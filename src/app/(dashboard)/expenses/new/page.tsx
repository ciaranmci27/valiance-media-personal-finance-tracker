import { AddExpenseContent } from "@/components/features/expenses/add-expense-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Add Expense",
};

export default async function AddExpensePage() {
  if (!(await canAccess("expenses.manage"))) return <AccessDenied area="Expenses" />;
  return <AddExpenseContent />;
}
