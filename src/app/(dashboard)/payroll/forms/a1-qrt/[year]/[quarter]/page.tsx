import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { FormA1QrtContent } from "@/components/features/payroll/form-a1-qrt-content";
import type {
  FormA1QrtData,
  OrganizationConfig,
  PayrollForm,
} from "@/types/payroll";

interface Params {
  year: string;
  quarter: string;
}

export const metadata = {
  title: "AZ Form A1-QRT | Payroll",
};

export default async function FormA1QrtPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { year: yearParam, quarter: quarterParam } = await params;
  const year = Number(yearParam);
  const quarter = Number(quarterParam);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) notFound();
  if (![1, 2, 3, 4].includes(quarter)) notFound();

  let form: PayrollForm | null = null;
  let organization: OrganizationConfig | null = null;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const [formRes, orgRes] = await Promise.all([
      supabase
        .from("payroll_forms")
        .select("*")
        .eq("form_type", "a1_qrt")
        .eq("tax_year", year)
        .eq("quarter", quarter)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("organization_config")
        .select("*")
        .is("deleted_at", null)
        .maybeSingle(),
    ]);
    form = (formRes.data as PayrollForm | null) ?? null;
    organization = (orgRes.data as OrganizationConfig | null) ?? null;
  }

  return (
    <FormA1QrtContent
      year={year}
      quarter={quarter as 1 | 2 | 3 | 4}
      form={form}
      formData={(form?.form_data as FormA1QrtData | null) ?? null}
      organization={organization}
    />
  );
}
