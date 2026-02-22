import { createClient } from "@/lib/supabase/server";
import { IncomeListContent } from "@/components/features/income/income-list-content";
import { isDemoMode } from "@/lib/demo";
import {
  demoIncomeEntries,
  demoIncomeSources,
  demoIncomeAmountsPlain,
} from "@/lib/demo/data";

export const metadata = {
  title: "Income",
};

export default async function IncomePage() {
  // Return demo data if in demo mode
  if (isDemoMode()) {
    return (
      <IncomeListContent
        entries={demoIncomeEntries}
        sources={demoIncomeSources}
        amounts={demoIncomeAmountsPlain}
      />
    );
  }

  const supabase = await createClient();

  const [
    { data: entries },
    { data: sources },
    { data: amounts },
  ] = await Promise.all([
    supabase
      .from("income_entries")
      .select("*")
      .is("deleted_at", null)
      .order("month", { ascending: false }),
    supabase
      .from("income_sources")
      .select("*")
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("income_amounts")
      .select("*"),
  ]);

  return (
    <IncomeListContent
      entries={entries || []}
      sources={sources || []}
      amounts={amounts || []}
    />
  );
}
