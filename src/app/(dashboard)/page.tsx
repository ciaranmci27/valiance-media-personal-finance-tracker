import { createClient } from "@/lib/supabase/server";
import { DashboardContent } from "@/components/features/dashboard/dashboard-content";
import { isDemoMode } from "@/lib/demo";
import { accountingClient } from "@/lib/accounting/server/access";
import {
  demoIncomeEntries,
  demoIncomeSources,
  demoIncomeAmounts,
  demoExpenses,
  demoExpenseHistory,
  demoNetWorth,
} from "@/lib/demo/data";

// Disable caching to always fetch fresh data
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Return demo data if in demo mode
  if (isDemoMode()) {
    return (
      <DashboardContent
        incomeEntries={demoIncomeEntries}
        incomeSources={demoIncomeSources}
        incomeAmounts={demoIncomeAmounts}
        expenses={demoExpenses.filter((e) => e.is_active)}
        expenseHistory={demoExpenseHistory}
        netWorthEntries={demoNetWorth}
        booksAvailable
      />
    );
  }

  const supabase = await createClient();

  // Are the books there for this session? One light probe; the dashboard
  // works without them. It runs alongside the reads below instead of ahead
  // of them, so the page answers in the time of its slowest read, not the sum.
  const booksProbe = accountingClient().then(
    () => true,
    // Personal finance pages carry the dashboard on their own.
    () => false,
  );

  // Fetch all data in parallel
  const [
    booksAvailable,
    { data: incomeEntries },
    { data: incomeSources },
    { data: incomeAmounts },
    { data: expenses },
    { data: expenseHistory },
    { data: netWorthEntries },
  ] = await Promise.all([
    booksProbe,
    supabase
      .from("income_entries")
      .select("*")
      .is("deleted_at", null)
      .order("month", { ascending: false }), // Get all entries for full history
    supabase
      .from("income_sources")
      .select("*")
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("income_amounts")
      .select("*, income_entries!inner(month, deleted_at)")
      .is("income_entries.deleted_at", null)
      .order("income_entries(month)", { ascending: false }),
    supabase
      .from("expenses")
      .select("*")
      .is("deleted_at", null)
      .eq("is_active", true),
    supabase
      .from("expense_history")
      .select("*")
      .order("changed_at", { ascending: false }),
    supabase
      .from("net_worth")
      .select("*")
      .is("deleted_at", null)
      .order("date", { ascending: false }), // Get all entries for full history
  ]);

  return (
    <DashboardContent
      incomeEntries={incomeEntries || []}
      incomeSources={incomeSources || []}
      incomeAmounts={incomeAmounts || []}
      expenses={expenses || []}
      expenseHistory={expenseHistory || []}
      netWorthEntries={netWorthEntries || []}
      booksAvailable={booksAvailable}
    />
  );
}
