import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { RunsListContent } from "@/components/features/payroll/runs-list-content";
import type { PayrollRunListItem } from "@/types/payroll";

export const metadata = {
  title: "Pay Runs | Payroll",
};

export default async function PayrollRunsListPage() {
  let rows: PayrollRunListItem[] = [];

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("payroll_runs")
      .select(
        "*, payroll_employees:employee_id(id, first_name, last_name)",
      )
      .is("deleted_at", null)
      .order("pay_date", { ascending: false })
      .limit(500);
    rows = (data as PayrollRunListItem[] | null) ?? [];
  }

  return <RunsListContent runs={rows} />;
}
