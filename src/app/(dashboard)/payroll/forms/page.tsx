import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { FormsListContent } from "@/components/features/payroll/forms-list-content";
import type { PayrollForm } from "@/types/payroll";

export const metadata = {
  title: "Tax Forms | Payroll",
};

export default async function PayrollFormsPage() {
  let forms: PayrollForm[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("payroll_forms")
      .select("*")
      .is("deleted_at", null)
      .order("tax_year", { ascending: false })
      .order("quarter", { ascending: true })
      .order("form_type", { ascending: true })
      .limit(200);
    forms = (data as PayrollForm[] | null) ?? [];
  }

  return <FormsListContent forms={forms} currentYear={new Date().getUTCFullYear()} />;
}
