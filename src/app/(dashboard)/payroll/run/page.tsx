import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { listPayWindows, previewBatch } from "@/lib/payroll/runs-actions";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { PayWindowsContent } from "@/components/features/payroll/pay-windows-content";
import { RunBatchContent } from "@/components/features/payroll/run-batch-content";
import type { OrganizationConfig } from "@/types/payroll";

export const metadata = {
  title: "Calculate Payroll",
};

interface PageProps {
  searchParams: Promise<{ pay_date?: string; employees?: string }>;
}

export default async function RunPayrollPage({ searchParams }: PageProps) {
  const { pay_date, employees } = await searchParams;

  let organization: OrganizationConfig | null = null;
  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("organization_config")
      .select("*")
      .is("deleted_at", null)
      .maybeSingle();
    organization = (data as OrganizationConfig | null) ?? null;
  }

  if (!organization && !isDemoMode()) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <Link
          href="/payroll"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Back to payroll"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div className="glass-card rounded-xl p-8 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning/10">
            <AlertTriangle className="h-6 w-6 text-warning" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-semibold">Setup required</h2>
          <p className="text-sm text-muted-foreground">
            Configure your organization profile before running payroll.
          </p>
          <Link
            href="/payroll"
            className="inline-block text-sm font-medium text-primary hover:underline"
          >
            Go to payroll setup
          </Link>
        </div>
      </div>
    );
  }

  // No pay_date - show the landing (upcoming pay windows).
  if (!pay_date) {
    const result = await listPayWindows();
    if (!result.ok || !result.data) {
      return (
        <div className="space-y-6 max-w-3xl mx-auto">
          <div className="glass-card rounded-xl p-6 text-sm text-error">
            Failed to load pay cycles: {result.error ?? "Unknown error"}
          </div>
        </div>
      );
    }
    return (
      <PayWindowsContent
        windows={result.data.windows}
        errors={result.data.errors}
      />
    );
  }

  // pay_date present - detail view for a specific window (optionally scoped
  // to a specific employee roster via the ?employees=id1,id2 param).
  const employeeIds = employees
    ? employees
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const preview = await previewBatch({
    pay_date,
    employee_ids: employeeIds,
  });
  if (!preview.ok || !preview.data) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <div className="glass-card rounded-xl p-6 text-sm text-error">
          Failed to load payroll preview: {preview.error ?? "Unknown error"}
        </div>
      </div>
    );
  }

  return (
    <RunBatchContent
      initialPreview={preview.data}
      initialPayDate={pay_date}
      initialEmployeeIds={employeeIds}
    />
  );
}
