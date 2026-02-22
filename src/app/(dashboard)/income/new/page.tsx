import { createClient } from "@/lib/supabase/server";
import { AddIncomeContent } from "@/components/features/income/add-income-content";
import { isDemoMode } from "@/lib/demo";
import { demoIncomeSources, demoIncomeEntries } from "@/lib/demo/data";

export const metadata = {
  title: "Add Income Entry",
};

export default async function AddIncomePage() {
  // Handle demo mode
  if (isDemoMode()) {
    const sorted = [...demoIncomeEntries].sort((a, b) => b.month.localeCompare(a.month));
    const latestMonth = sorted[0]?.month ?? null;
    const existingEntries: Record<string, string> = {};
    for (const e of sorted) {
      existingEntries[e.month.slice(0, 7)] = e.id;
    }

    return (
      <AddIncomeContent
        sources={demoIncomeSources.filter((s) => s.is_active)}
        existingEntries={existingEntries}
        latestMonth={latestMonth}
      />
    );
  }

  const supabase = await createClient();

  const { data: sources } = await supabase
    .from("income_sources")
    .select("*")
    .is("deleted_at", null)
    .eq("is_active", true)
    .order("sort_order");

  // Get all existing entries (month -> id) to prevent duplicates and link to them
  const { data: entries } = await supabase
    .from("income_entries")
    .select("id, month")
    .is("deleted_at", null)
    .order("month", { ascending: false });

  const existingEntries: Record<string, string> = {};
  let latestMonth: string | null = null;
  for (const e of entries ?? []) {
    const month = (e as { month: string }).month;
    const id = (e as { id: string }).id;
    existingEntries[month.slice(0, 7)] = id;
    if (!latestMonth) latestMonth = month;
  }

  return (
    <AddIncomeContent
      sources={sources || []}
      existingEntries={existingEntries}
      latestMonth={latestMonth}
    />
  );
}
