import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { FormW3Content } from "@/components/features/payroll/form-w3-content";
import type {
  FormW3Data,
  PayrollForm,
} from "@/types/payroll";

interface Params {
  year: string;
}

export const metadata = {
  title: "Form W-3 | Payroll",
};

export default async function FormW3Page({
  params,
}: {
  params: Promise<Params>;
}) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) notFound();

  let form: PayrollForm | null = null;
  let w2Count = 0;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const [formRes, w2CountRes] = await Promise.all([
      supabase
        .from("payroll_forms")
        .select("*")
        .eq("form_type", "w3")
        .eq("tax_year", year)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("payroll_forms")
        .select("id", { count: "exact", head: true })
        .eq("form_type", "w2")
        .eq("tax_year", year)
        .is("deleted_at", null),
    ]);
    form = (formRes.data as PayrollForm | null) ?? null;
    w2Count = w2CountRes.count ?? 0;
  }

  return (
    <FormW3Content
      year={year}
      form={form}
      formData={(form?.form_data as FormW3Data | null) ?? null}
      w2Count={w2Count}
    />
  );
}
