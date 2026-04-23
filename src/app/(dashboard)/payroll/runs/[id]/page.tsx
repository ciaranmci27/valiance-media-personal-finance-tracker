import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { computeYtdThrough, ZERO_YTD } from "@/lib/payroll/engine";
import { RunDetailContent } from "@/components/features/payroll/run-detail-content";
import type {
  PayrollEmployee,
  PayrollRun,
  PayrollRunHistory,
  PayrollTaxDeposit,
} from "@/types/payroll";

export const metadata = {
  title: "Pay Run | Payroll",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PayRunDetailPage({ params }: PageProps) {
  const { id } = await params;
  if (!id) notFound();

  if (isDemoMode()) {
    notFound();
  }

  const supabase = await createClient();

  const { data: runRow } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  const run = (runRow as PayrollRun | null) ?? null;
  if (!run) notFound();

  const [empRes, historyRes, yearRunsRes, depositsRes, cycleRunsRes] =
    await Promise.all([
      supabase
        .from("payroll_employees")
        .select("*")
        .eq("id", run.employee_id)
        .maybeSingle(),
      supabase
        .from("payroll_run_history")
        .select("*")
        .eq("run_id", id)
        .is("deleted_at", null)
        .order("changed_at", { ascending: true }),
      supabase
        .from("payroll_runs")
        .select("*")
        .eq("employee_id", run.employee_id)
        .is("deleted_at", null)
        .in("status", ["finalized", "paid"])
        .gte("pay_date", `${taxYearOf(run.pay_date)}-01-01`)
        .lte("pay_date", `${taxYearOf(run.pay_date)}-12-31`),
      // Deposits that include this run contribute to the "What's next"
      // checklist so the admin can see exactly what they still owe the IRS
      // or state for wages paid in this run. Status-agnostic query - a run
      // in draft has no deposits, and finalized/paid statuses both can.
      supabase
        .from("payroll_tax_deposits")
        .select("*")
        .contains("included_run_ids", [id])
        .is("deleted_at", null)
        .order("due_date", { ascending: true }),
      // Sibling runs in this cycle (same pay_date). Powers the cycle-aware
      // What's-next checklist so Step 1/2 reflect progress across every
      // employee in the pay cycle, not just this run.
      supabase
        .from("payroll_runs")
        .select("*")
        .eq("pay_date", run.pay_date)
        .is("deleted_at", null),
    ]);

  const employee = (empRes.data as PayrollEmployee | null) ?? null;
  const history = (historyRes.data as PayrollRunHistory[] | null) ?? [];
  const yearRuns = (yearRunsRes.data as PayrollRun[] | null) ?? [];
  const deposits = (depositsRes.data as PayrollTaxDeposit[] | null) ?? [];
  const cycleRuns = (cycleRunsRes.data as PayrollRun[] | null) ?? [];

  const taxYear = taxYearOf(run.pay_date);
  const ytdBefore = computeYtdThrough(yearRuns, taxYear, run.pay_date);
  const ytdIncluding =
    run.status === "finalized" || run.status === "paid"
      ? computeYtdThrough(
          [...yearRuns, run].filter(
            (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i,
          ),
          taxYear,
        )
      : { ...ZERO_YTD };

  return (
    <RunDetailContent
      run={run}
      employee={employee}
      history={history}
      ytdBefore={ytdBefore}
      ytdIncluding={ytdIncluding}
      deposits={deposits}
      cycleRuns={cycleRuns}
    />
  );
}

function taxYearOf(ymd: string): number {
  return Number(ymd.split("-")[0]);
}
