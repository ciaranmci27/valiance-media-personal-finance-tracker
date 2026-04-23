import { createClient } from "@/lib/supabase/server";
import { StatesListContent } from "@/components/features/payroll/states-list-content";
import { isDemoMode } from "@/lib/demo";
import type { StateTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "State Tax Tables | Payroll Settings",
};

export default async function StatesListPage() {
  let configs: StateTaxConfig[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("state_tax_configs")
      .select("*")
      .is("deleted_at", null)
      .order("state_code", { ascending: true })
      .order("tax_year", { ascending: false });
    configs = (data as StateTaxConfig[] | null) ?? [];
  }

  return <StatesListContent configs={configs} />;
}
