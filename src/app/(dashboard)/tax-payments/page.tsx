import { createClient } from "@/lib/supabase/server";
import { TaxEstimatorContent } from "@/components/features/tax/tax-estimator-content";
import { isDemoMode } from "@/lib/demo";
import { demoTaxEstimates } from "@/lib/demo/data";

export const metadata = {
  title: "Tax Estimator",
};

export default async function TaxPaymentsPage() {
  if (isDemoMode()) {
    return <TaxEstimatorContent estimates={demoTaxEstimates} />;
  }

  const supabase = await createClient();

  const { data: estimates } = await supabase
    .from("tax_estimates")
    .select("*")
    .is("deleted_at", null)
    .order("tax_year", { ascending: false });

  return <TaxEstimatorContent estimates={estimates || []} />;
}
