import { createClient } from "@/lib/supabase/server";
import { AddIncomeContent } from "@/components/features/income/add-income-content";
import { isDemoMode } from "@/lib/demo";
import {
  demoIncomeSources,
  demoIncomeLineItems,
} from "@/lib/demo/data";

export const metadata = {
  title: "Add Income Entry",
};

export default async function AddIncomePage() {
  // Handle demo mode
  if (isDemoMode()) {
    return (
      <AddIncomeContent
        sources={demoIncomeSources.filter((s) => s.is_active)}
        lineItems={demoIncomeLineItems}
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

  const { data: lineItems } = await supabase
    .from("income_line_items")
    .select(`
      *,
      income_sources (
        id,
        name,
        color
      ),
      income_entries!inner (
        id,
        month,
        deleted_at
      )
    `)
    .is("deleted_at", null)
    .is("income_entries.deleted_at", null)
    .order("received_date", { ascending: false })
    .order("created_at", { ascending: false });

  return (
    <AddIncomeContent
      sources={sources || []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lineItems={(lineItems || []) as any}
    />
  );
}
