import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { EmployeeFormContent } from "@/components/features/payroll/employee-form-content";
import type { PayrollEmployee, StateTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "Edit Employee | Payroll",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditEmployeePage({ params }: PageProps) {
  const { id } = await params;
  if (!id) notFound();

  let employee: PayrollEmployee | null = null;
  let stateConfigs: StateTaxConfig[] = [];

  if (isDemoMode()) {
    notFound();
  }

  const supabase = await createClient();
  const [empRes, statesRes] = await Promise.all([
    supabase
      .from("payroll_employees")
      .select("*")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("state_tax_configs")
      .select("*")
      .is("deleted_at", null),
  ]);

  employee = (empRes.data as PayrollEmployee | null) ?? null;
  stateConfigs = (statesRes.data as StateTaxConfig[] | null) ?? [];

  if (!employee) notFound();

  return (
    <EmployeeFormContent initial={employee} stateConfigs={stateConfigs} />
  );
}
