import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import {
  FormW2IndexContent,
  type W2EmployeeRow,
} from "@/components/features/payroll/form-w2-index-content";
import type { PayrollEmployee, PayrollForm } from "@/types/payroll";

interface Params {
  year: string;
}

export const metadata = {
  title: "W-2 Forms | Payroll",
};

export default async function FormW2IndexPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) notFound();

  let employees: W2EmployeeRow[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const yStart = `${year}-01-01`;
    const yEnd = `${year}-12-31`;

    const [empRes, runRes, formRes] = await Promise.all([
      supabase
        .from("payroll_employees")
        .select("id, first_name, last_name, status")
        .is("deleted_at", null)
        .order("last_name", { ascending: true }),
      supabase
        .from("payroll_runs")
        .select("employee_id")
        .is("deleted_at", null)
        .in("status", ["finalized", "paid"])
        .gte("pay_date", yStart)
        .lte("pay_date", yEnd),
      supabase
        .from("payroll_forms")
        .select("*")
        .eq("form_type", "w2")
        .eq("tax_year", year)
        .is("deleted_at", null),
    ]);

    const empRows = (empRes.data as Pick<PayrollEmployee, "id" | "first_name" | "last_name" | "status">[] | null) ?? [];
    const runEmpIds = new Set(
      ((runRes.data as { employee_id: string }[] | null) ?? []).map((r) => r.employee_id),
    );
    const formsByEmp = new Map<string, PayrollForm>();
    for (const f of (formRes.data as PayrollForm[] | null) ?? []) {
      if (f.employee_id) formsByEmp.set(f.employee_id, f);
    }

    employees = empRows.map((e) => ({
      id: e.id,
      first_name: e.first_name,
      last_name: e.last_name,
      status: e.status,
      had_runs: runEmpIds.has(e.id),
      form: formsByEmp.get(e.id) ?? null,
    }));
  }

  return <FormW2IndexContent year={year} employees={employees} />;
}
