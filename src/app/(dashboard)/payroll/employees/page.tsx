import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { EmployeesListContent } from "@/components/features/payroll/employees-list-content";
import type { PayrollEmployee } from "@/types/payroll";

export const metadata = {
  title: "Employees | Payroll",
};

export default async function EmployeesListPage() {
  let employees: PayrollEmployee[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("payroll_employees")
      .select("*")
      .is("deleted_at", null)
      .order("last_name", { ascending: true });
    employees = (data as PayrollEmployee[] | null) ?? [];
  }

  return <EmployeesListContent employees={employees} />;
}
