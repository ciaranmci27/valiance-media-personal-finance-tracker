import { createClient } from "@/lib/supabase/server";
import { TrashSettingsContent } from "@/components/features/settings/trash-settings-content";
import { isDemoMode } from "@/lib/demo";
import {
  demoDeletedSources,
  demoDeletedEntries,
  demoDeletedExpenses,
  demoDeletedNetWorth,
  demoDeletedAutomations,
  demoDeletedExpenseHistory,
} from "@/lib/demo/data";

export const metadata = {
  title: "Trash",
};

export default async function TrashSettingsPage() {
  // Return demo data if in demo mode
  if (isDemoMode()) {
    return (
      <TrashSettingsContent
        deletedSources={demoDeletedSources}
        deletedEntries={demoDeletedEntries}
        deletedExpenses={demoDeletedExpenses}
        deletedNetWorth={demoDeletedNetWorth}
        deletedAutomations={demoDeletedAutomations}
        deletedExpenseHistory={demoDeletedExpenseHistory}
      />
    );
  }

  const supabase = await createClient();

  // Fetch all deleted items
  const [
    { data: deletedSources },
    { data: deletedEntries },
    { data: deletedExpenses },
    { data: deletedNetWorth },
    { data: deletedAutomations },
    { data: deletedExpenseHistory },
  ] = await Promise.all([
    supabase
      .from("income_sources")
      .select("id, name, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("income_entries")
      .select("id, month, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("expenses")
      .select("id, name, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("net_worth")
      .select("id, date, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("automations")
      .select("id, name, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("expense_history")
      .select("id, event_type, amount, frequency, changed_at, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
  ]);

  return (
    <TrashSettingsContent
      deletedSources={deletedSources || []}
      deletedEntries={deletedEntries || []}
      deletedExpenses={deletedExpenses || []}
      deletedNetWorth={deletedNetWorth || []}
      deletedAutomations={deletedAutomations || []}
      deletedExpenseHistory={deletedExpenseHistory || []}
    />
  );
}
