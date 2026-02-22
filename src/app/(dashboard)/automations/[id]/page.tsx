import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AutomationDetailContent } from "@/components/features/automations/automation-detail-content";
import { isDemoMode } from "@/lib/demo";
import { getDemoAutomation } from "@/lib/demo/data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const automation = getDemoAutomation(id);
    if (!automation) {
      return { title: "Automation Not Found" };
    }
    return { title: automation.name };
  }

  const supabase = await createClient();

  const { data: automation } = await supabase
    .from("automations")
    .select("name")
    .eq("id", id)
    .single();

  if (!automation) {
    return { title: "Automation Not Found" };
  }

  return { title: (automation as { name: string }).name };
}

export default async function AutomationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const automation = getDemoAutomation(id);
    if (!automation) {
      notFound();
    }
    // getDemoAutomation already includes automation_runs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return <AutomationDetailContent automation={automation as any} />;
  }

  const supabase = await createClient();

  // Fetch the automation with its actions and recent runs
  const { data: automation } = await supabase
    .from("automations")
    .select(`
      *,
      automation_actions (*),
      automation_runs (*)
    `)
    .eq("id", id)
    .order("sort_order", { referencedTable: "automation_actions", ascending: true })
    .order("started_at", { referencedTable: "automation_runs", ascending: false })
    .limit(10, { referencedTable: "automation_runs" })
    .single();

  if (!automation) {
    notFound();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <AutomationDetailContent automation={automation as any} />;
}
