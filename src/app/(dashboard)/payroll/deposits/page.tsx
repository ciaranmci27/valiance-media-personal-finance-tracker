import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { DepositsListContent } from "@/components/features/payroll/deposits-list-content";
import type { PayrollTaxDeposit, StateTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "Tax Deposits | Payroll",
};

export default async function PayrollDepositsPage() {
  let deposits: PayrollTaxDeposit[] = [];
  let stateConfigs: StateTaxConfig[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const [depositsRes, stateConfigsRes] = await Promise.all([
      supabase
        .from("payroll_tax_deposits")
        .select("*")
        .is("deleted_at", null)
        .order("due_date", { ascending: true })
        .limit(500),
      // State configs carry payment_portals metadata used to deep-link state
      // deposits to the correct agency portal with inline instructions.
      supabase
        .from("state_tax_configs")
        .select("*")
        .is("deleted_at", null)
        .order("tax_year", { ascending: false }),
    ]);
    deposits = (depositsRes.data as PayrollTaxDeposit[] | null) ?? [];
    stateConfigs = (stateConfigsRes.data as StateTaxConfig[] | null) ?? [];
  }

  return (
    <DepositsListContent deposits={deposits} stateConfigs={stateConfigs} />
  );
}
