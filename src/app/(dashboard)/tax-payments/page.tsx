import { createClient } from "@/lib/supabase/server";
import { TaxEstimatorContent } from "@/components/features/tax/tax-estimator-content";
import { isDemoMode } from "@/lib/demo";
import { demoTaxEstimates } from "@/lib/demo/data";
import { accountingClient } from "@/lib/accounting/server/access";

export const metadata = {
  title: "Tax Estimator",
};

export default async function TaxPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const requestedYear = Number((await searchParams).year);
  if (isDemoMode()) {
    return (
      <TaxEstimatorContent
        estimates={demoTaxEstimates}
        initialYear={requestedYear}
      />
    );
  }

  const supabase = await createClient();

  const { data: estimates } = await supabase
    .from("tax_estimates")
    .select("*")
    .is("deleted_at", null)
    .order("tax_year", { ascending: false });

  let accountingAvailable = false;
  try {
    await accountingClient();
    accountingAvailable = true;
  } catch {
    /* Personal estimates remain available without accounting. */
  }
  return (
    <TaxEstimatorContent
      estimates={estimates || []}
      accountingAvailable={accountingAvailable}
      initialYear={requestedYear}
    />
  );
}
