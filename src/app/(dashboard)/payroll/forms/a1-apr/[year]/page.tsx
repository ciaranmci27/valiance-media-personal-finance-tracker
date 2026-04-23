import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { FormA1AprContent } from "@/components/features/payroll/form-a1-apr-content";
import type {
  FormA1AprData,
  PayrollForm,
} from "@/types/payroll";

interface Params {
  year: string;
}

export const metadata = {
  title: "AZ Form A1-APR | Payroll",
};

export default async function FormA1AprPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) notFound();

  let form: PayrollForm | null = null;
  let quarterCount = 0;
  let w3Exists = false;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const [formRes, qrtRes, w3Res] = await Promise.all([
      supabase
        .from("payroll_forms")
        .select("*")
        .eq("form_type", "a1_apr")
        .eq("tax_year", year)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("payroll_forms")
        .select("id", { count: "exact", head: true })
        .eq("form_type", "a1_qrt")
        .eq("tax_year", year)
        .is("deleted_at", null),
      supabase
        .from("payroll_forms")
        .select("id")
        .eq("form_type", "w3")
        .eq("tax_year", year)
        .is("deleted_at", null)
        .maybeSingle(),
    ]);
    form = (formRes.data as PayrollForm | null) ?? null;
    quarterCount = qrtRes.count ?? 0;
    w3Exists = !!w3Res.data;
  }

  return (
    <FormA1AprContent
      year={year}
      form={form}
      formData={(form?.form_data as FormA1AprData | null) ?? null}
      quarterCount={quarterCount}
      w3Exists={w3Exists}
    />
  );
}
