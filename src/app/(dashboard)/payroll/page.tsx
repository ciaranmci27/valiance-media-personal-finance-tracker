import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { PayrollSetupCard } from "@/components/features/payroll/payroll-setup-card";
import { PayrollOverviewContent } from "@/components/features/payroll/payroll-overview-content";
import type {
  OrganizationConfig,
  PayrollEmployee,
  PayrollForm,
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";

export const metadata = {
  title: "Payroll",
};

export default async function PayrollOverviewPage() {
  let organization: OrganizationConfig | null = null;
  let employees: PayrollEmployee[] = [];
  let yearRuns: PayrollRun[] = [];
  let yearDeposits: PayrollTaxDeposit[] = [];
  let recentForms: PayrollForm[] = [];

  const taxYear = new Date().getUTCFullYear();

  if (!isDemoMode()) {
    const supabase = await createClient();

    const orgRes = await supabase
      .from("organization_config")
      .select("*")
      .is("deleted_at", null)
      .maybeSingle();

    organization = (orgRes.data as OrganizationConfig | null) ?? null;

    // Empty-state guard: run the onboarding wizard until an organization exists.
    // Skip the rest of the dashboard queries in that case.
    if (!organization) {
      return <PayrollSetupCard />;
    }

    const [empRes, runsRes, depRes, formsRes] = await Promise.all([
      supabase
        .from("payroll_employees")
        .select("*")
        .is("deleted_at", null)
        .order("last_name", { ascending: true }),
      supabase
        .from("payroll_runs")
        .select("*")
        .is("deleted_at", null)
        .gte("pay_date", `${taxYear}-01-01`)
        .lte("pay_date", `${taxYear}-12-31`),
      // Fetch every deposit for the current tax year (paid + scheduled). The
      // Current cycle panel needs paid deposits to say "all settled", while
      // the "Due soon" widget derives its unpaid subset from the same list.
      supabase
        .from("payroll_tax_deposits")
        .select("*")
        .is("deleted_at", null)
        .gte("due_date", `${taxYear}-01-01`)
        .lte("due_date", `${taxYear + 1}-03-31`)
        .order("due_date", { ascending: true }),
      supabase
        .from("payroll_forms")
        .select("*")
        .is("deleted_at", null)
        .eq("tax_year", taxYear)
        .order("quarter", { ascending: true })
        .order("form_type", { ascending: true }),
    ]);

    employees = (empRes.data as PayrollEmployee[] | null) ?? [];
    yearRuns = (runsRes.data as PayrollRun[] | null) ?? [];
    yearDeposits = (depRes.data as PayrollTaxDeposit[] | null) ?? [];
    recentForms = (formsRes.data as PayrollForm[] | null) ?? [];
  }

  return (
    <PayrollOverviewContent
      organization={organization}
      employees={employees}
      yearRuns={yearRuns}
      taxYear={taxYear}
      yearDeposits={yearDeposits}
      recentForms={recentForms}
    />
  );
}
