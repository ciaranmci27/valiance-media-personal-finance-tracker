import { createClient } from "@/lib/supabase/server";
import { FederalListContent } from "@/components/features/payroll/federal-list-content";
import { isDemoMode } from "@/lib/demo";
import type { FederalTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "Federal Tax Tables | Payroll Settings",
};

export default async function FederalListPage() {
  let configs: FederalTaxConfig[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("federal_tax_configs")
      .select("*")
      .is("deleted_at", null)
      .order("tax_year", { ascending: false });
    configs = (data as FederalTaxConfig[] | null) ?? [];
  }

  return <FederalListContent configs={configs} />;
}
