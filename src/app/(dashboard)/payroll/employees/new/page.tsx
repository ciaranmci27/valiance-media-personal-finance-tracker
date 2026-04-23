import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { EmployeeFormContent } from "@/components/features/payroll/employee-form-content";
import type { StateTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "New Employee | Payroll",
};

export default async function NewEmployeePage() {
  let stateConfigs: StateTaxConfig[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("state_tax_configs")
      .select("*")
      .is("deleted_at", null);
    stateConfigs = (data as StateTaxConfig[] | null) ?? [];
  }

  return <EmployeeFormContent initial={null} stateConfigs={stateConfigs} />;
}
