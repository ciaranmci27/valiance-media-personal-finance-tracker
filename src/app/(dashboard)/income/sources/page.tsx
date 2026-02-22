import { createClient } from "@/lib/supabase/server";
import { IncomeSourcesContent } from "@/components/features/income/income-sources-content";
import { isDemoMode } from "@/lib/demo";
import { demoIncomeSources } from "@/lib/demo/data";

export const metadata = {
  title: "Income Sources",
};

export default async function IncomeSourcesPage() {
  // Return demo data if in demo mode
  if (isDemoMode()) {
    return <IncomeSourcesContent sources={demoIncomeSources} />;
  }

  const supabase = await createClient();

  const { data: sources } = await supabase
    .from("income_sources")
    .select("*")
    .is("deleted_at", null)
    .order("name");

  return <IncomeSourcesContent sources={sources || []} />;
}
