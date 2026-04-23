import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { Form941Content } from "@/components/features/payroll/form-941-content";
import type {
  Form941Data,
  OrganizationConfig,
  PayrollForm,
} from "@/types/payroll";

interface Params {
  year: string;
  quarter: string;
}

export const metadata = {
  title: "Form 941 | Payroll",
};

export default async function Form941Page({
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
        .eq("form_type", "941")
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
    <Form941Content
      year={year}
      quarter={quarter as 1 | 2 | 3 | 4}
      form={form}
      formData={(form?.form_data as Form941Data | null) ?? null}
      organization={organization}
    />
  );
}
