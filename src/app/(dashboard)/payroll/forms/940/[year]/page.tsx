import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { Form940Content } from "@/components/features/payroll/form-940-content";
import type {
  Form940Data,
  OrganizationConfig,
  PayrollForm,
} from "@/types/payroll";

interface Params {
  year: string;
}

export const metadata = {
  title: "Form 940 | Payroll",
};

export default async function Form940Page({
  params,
}: {
  params: Promise<Params>;
}) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) notFound();

  let form: PayrollForm | null = null;
  let organization: OrganizationConfig | null = null;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const [formRes, orgRes] = await Promise.all([
      supabase
        .from("payroll_forms")
        .select("*")
        .eq("form_type", "940")
        .eq("tax_year", year)
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
    <Form940Content
      year={year}
      form={form}
      formData={(form?.form_data as Form940Data | null) ?? null}
      organization={organization}
    />
  );
}
