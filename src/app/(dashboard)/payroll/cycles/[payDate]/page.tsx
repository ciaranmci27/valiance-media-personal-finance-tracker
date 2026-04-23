import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { CycleDetailContent } from "@/components/features/payroll/cycle-detail-content";
import type {
  PayrollEmployee,
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";

export const metadata = {
  title: "Pay Cycle | Payroll",
};

interface PageProps {
  params: Promise<{ payDate: string }>;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export default async function PayrollCycleDetailPage({ params }: PageProps) {
  const { payDate } = await params;
  if (!payDate || !YMD.test(payDate)) notFound();

  // Demo mode has no real cycle data; land the visitor on the runs list
  // instead of a 404. The overview and runs list both render empty-state
  // fixtures in demo, so this keeps navigation coherent.
  if (isDemoMode()) redirect("/payroll/runs");

  const supabase = await createClient();

  const { data: runRows } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("pay_date", payDate)
    .is("deleted_at", null)
    .order("employee_id", { ascending: true });

  const runs = (runRows as PayrollRun[] | null) ?? [];
  if (runs.length === 0) notFound();

  const employeeIds = Array.from(new Set(runs.map((r) => r.employee_id)));
  const runIds = runs.map((r) => r.id);

  const [empRes, depositsRes] = await Promise.all([
    supabase
      .from("payroll_employees")
      .select("id, first_name, last_name, pay_frequency, state_code")
      .in("id", employeeIds),
    // Any deposit that covers at least one of this cycle's runs. A deposit
    // may span runs across multiple cycles (monthly/semiweekly batches),
    // so we surface it here even if it also includes other pay dates.
    supabase
      .from("payroll_tax_deposits")
      .select("*")
      .overlaps("included_run_ids", runIds)
      .is("deleted_at", null)
      .order("due_date", { ascending: true }),
  ]);

  const employees =
    (empRes.data as Pick<
      PayrollEmployee,
      "id" | "first_name" | "last_name" | "pay_frequency" | "state_code"
    >[] | null) ?? [];
  const deposits = (depositsRes.data as PayrollTaxDeposit[] | null) ?? [];

  return (
    <CycleDetailContent
      payDate={payDate}
      runs={runs}
      employees={employees}
      deposits={deposits}
    />
  );
}
