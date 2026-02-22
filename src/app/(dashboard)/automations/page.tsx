import { createClient } from "@/lib/supabase/server";
import { AutomationsListContent } from "@/components/features/automations/automations-list-content";
import { isDemoMode } from "@/lib/demo";
import { demoAutomations, demoAutomationRuns } from "@/lib/demo/data";

export const metadata = {
  title: "Automations",
};

export default async function AutomationsPage() {
  // Return demo data if in demo mode
  if (isDemoMode()) {
    // Add automation_runs for each automation (list page only needs id for counting)
    const automationsWithRuns = demoAutomations.map((a) => ({
      ...a,
      automation_runs: demoAutomationRuns
        .filter((r) => r.automation_id === a.id)
        .map((r) => ({ id: r.id })),
    }));
    return <AutomationsListContent automations={automationsWithRuns} />;
  }

  const supabase = await createClient();

  const { data: automations } = await supabase
    .from("automations")
    .select(`
      *,
      automation_actions (*),
      automation_runs (id)
    `)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  return <AutomationsListContent automations={automations || []} />;
}
