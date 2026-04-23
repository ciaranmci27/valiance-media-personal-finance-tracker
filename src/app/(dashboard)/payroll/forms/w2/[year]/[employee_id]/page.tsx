import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { FormW2Content } from "@/components/features/payroll/form-w2-content";
import type {
  FormW2Data,
  PayrollEmployee,
  PayrollForm,
} from "@/types/payroll";

interface Params {
  year: string;
  employee_id: string;
}

export const metadata = {
  title: "W-2 | Payroll",
};

export default async function FormW2Page({
  params,
}: {
  params: Promise<Params>;
}) {
  const { year: yearParam, employee_id: employeeId } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) notFound();
  if (!employeeId) notFound();

  let form: PayrollForm | null = null;
  let employee: Pick<
    PayrollEmployee,
    "id" | "first_name" | "last_name" | "state_code"
  > | null = null;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const [formRes, empRes] = await Promise.all([
      supabase
        .from("payroll_forms")
        .select("*")
        .eq("form_type", "w2")
        .eq("tax_year", year)
        .eq("employee_id", employeeId)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("payroll_employees")
        .select("id, first_name, last_name, state_code")
        .eq("id", employeeId)
        .is("deleted_at", null)
        .maybeSingle(),
    ]);
    form = (formRes.data as PayrollForm | null) ?? null;
    employee = (empRes.data as Pick<
      PayrollEmployee,
      "id" | "first_name" | "last_name" | "state_code"
    > | null) ?? null;
  }

  if (!employee) notFound();

  return (
    <FormW2Content
      year={year}
      employeeId={employeeId}
      employee={employee}
      form={form}
      formData={(form?.form_data as FormW2Data | null) ?? null}
    />
  );
}
