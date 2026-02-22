import { createClient } from "@/lib/supabase/server";
import { AddNetWorthContent } from "@/components/features/net-worth/add-net-worth-content";
import { isDemoMode } from "@/lib/demo";
import { demoNetWorth } from "@/lib/demo/data";

export const metadata = {
  title: "Add Net Worth Entry",
};

export default async function AddNetWorthPage() {
  // Handle demo mode
  if (isDemoMode()) {
    const sorted = [...demoNetWorth].sort((a, b) => b.date.localeCompare(a.date));
    const previousEntry = sorted[0] ?? null;
    const existingEntries: Record<string, string> = {};
    for (const e of sorted) {
      existingEntries[e.date.slice(0, 7)] = e.id;
    }

    return (
      <AddNetWorthContent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        previousEntry={previousEntry as any}
        existingEntries={existingEntries}
      />
    );
  }

  const supabase = await createClient();

  // Get the most recent entry for comparison
  const { data: previousEntry } = await supabase
    .from("net_worth")
    .select("*")
    .is("deleted_at", null)
    .order("date", { ascending: false })
    .limit(1)
    .single();

  // Get all existing entries (date -> id) to prevent duplicates and link to them
  const { data: entries } = await supabase
    .from("net_worth")
    .select("id, date")
    .is("deleted_at", null)
    .order("date", { ascending: false });

  const existingEntries: Record<string, string> = {};
  for (const e of entries ?? []) {
    existingEntries[(e as { date: string }).date.slice(0, 7)] = (e as { id: string }).id;
  }

  return (
    <AddNetWorthContent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      previousEntry={previousEntry as any}
      existingEntries={existingEntries}
    />
  );
}
