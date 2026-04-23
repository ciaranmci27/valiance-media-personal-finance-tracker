"use server";

// Pay stub email server actions.
//
// Two entry points:
//   sendPayStub(runId)        - manual trigger from the run detail UI
//                                ("Resend stub" button)
//   sendPayStubFireAndForget  - called from markRunPaid; never throws,
//                                logs errors so the paid transition is
//                                not blocked by SMTP hiccups.
//
// Both paths build the email through the same template, update
// payroll_runs.stub_sent_at on success, and write a payroll_run_history
// row of event_type 'paid' with a note indicating the stub result (so
// there's an audit trail when stubs fail or are re-sent manually).

import { revalidatePath } from "next/cache";

import { isDemoMode } from "@/lib/demo";
import { sendTransactional } from "@/lib/email/send-mail";
import { buildPayStubEmail, type PayStubYtdTotals } from "@/lib/email/templates/payroll/paystub";
import { createClient } from "@/lib/supabase/server";
import { splitWithholdings } from "@/lib/payroll/withholdings";
import type {
  OrganizationConfig,
  PayrollEmployee,
  PayrollRun,
} from "@/types/payroll";

import { computeYtdThrough } from "./ytd";

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

async function requireActionAuth(): Promise<string | null> {
  if (isDemoMode()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return "Not authenticated";
  return null;
}

/** Public server action: send or resend the pay stub for a single run. */
export async function sendPayStub(runId: string): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!runId) return { ok: false, error: "Missing run id" };

  const result = await sendPayStubInternal(runId, "manual");
  if (result.ok) {
    revalidatePath(`/payroll/runs/${runId}`);
    revalidatePath("/payroll/runs");
  }
  return result;
}

/**
 * Fire-and-forget variant for markRunPaid: logs failures but does not
 * surface an error, so SMTP issues never block the paid transition. The
 * UI will show "stub not sent" and offer a manual resend.
 */
export async function sendPayStubFireAndForget(runId: string): Promise<void> {
  try {
    const result = await sendPayStubInternal(runId, "auto");
    if (!result.ok) {
      console.error(
        `[payroll/paystub] auto-send failed for run ${runId}:`,
        result.error,
      );
    }
  } catch (err) {
    console.error(`[payroll/paystub] auto-send threw for run ${runId}:`, err);
  }
}

// ─── Core send routine ────────────────────────────────────────────────────────

async function sendPayStubInternal(
  runId: string,
  trigger: "auto" | "manual",
): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: run, error: runErr } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("id", runId)
    .is("deleted_at", null)
    .maybeSingle();
  if (runErr) return { ok: false, error: runErr.message };
  if (!run) return { ok: false, error: "Run not found" };
  if (run.status === "voided") {
    return { ok: false, error: "Cannot send a pay stub for a voided run" };
  }

  // Employee: prefer the snapshot (immutable proof of what was in effect
  // on the pay date). Fall back to the live row if the snapshot is absent
  // for legacy runs.
  const employee = await loadEmployee(
    supabase,
    run.employee_id,
    run.employee_snapshot,
  );
  if (!employee) return { ok: false, error: "Employee not found" };
  if (!employee.email) {
    return { ok: false, error: "Employee has no email on file" };
  }

  const organization = await loadOrganization(supabase, run.organization_snapshot);
  if (!organization) return { ok: false, error: "Organization config not found" };

  const ytd = await loadYtdThroughRun(supabase, run as PayrollRun);

  const built = buildPayStubEmail({
    run: run as PayrollRun,
    employee,
    organization,
    ytd,
  });

  const send = await sendTransactional({
    to: employee.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    accountId: organization.default_email_account_id ?? undefined,
  });

  if (!send.success) {
    return { ok: false, error: send.error ?? "Email send failed" };
  }

  const { error: updateErr } = await supabase
    .from("payroll_runs")
    .update({ stub_sent_at: new Date().toISOString() })
    .eq("id", runId);
  if (updateErr) {
    console.error(
      `[payroll/paystub] email sent but stub_sent_at update failed for run ${runId}:`,
      updateErr,
    );
  }

  await recordStubEvent(
    supabase,
    run as PayrollRun,
    trigger === "auto"
      ? "Pay stub emailed automatically after marking paid"
      : "Pay stub re-sent manually",
  );

  return { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SupabaseLike = Awaited<ReturnType<typeof createClient>>;

async function loadEmployee(
  supabase: SupabaseLike,
  employeeId: string,
  snapshot: unknown,
): Promise<PayrollEmployee | null> {
  if (snapshot && typeof snapshot === "object" && "id" in snapshot) {
    return snapshot as PayrollEmployee;
  }
  const { data } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("id", employeeId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as PayrollEmployee | null) ?? null;
}

async function loadOrganization(
  supabase: SupabaseLike,
  snapshot: unknown,
): Promise<OrganizationConfig | null> {
  if (snapshot && typeof snapshot === "object" && "legal_name" in snapshot) {
    return snapshot as OrganizationConfig;
  }
  const { data } = await supabase
    .from("organization_config")
    .select("*")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OrganizationConfig | null) ?? null;
}

async function loadYtdThroughRun(
  supabase: SupabaseLike,
  run: PayrollRun,
): Promise<PayStubYtdTotals> {
  const year = Number(run.pay_date.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const { data: rows } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("employee_id", run.employee_id)
    .gte("pay_date", yearStart)
    .lte("pay_date", yearEnd)
    .is("deleted_at", null);

  const all = (rows as PayrollRun[] | null) ?? [];
  // Include runs up to and including this one. computeYtdThrough's cutoff
  // is exclusive, so pass null and rely on status filtering inside.
  const totals = computeYtdThrough(all, year, null);
  const preTax = all
    .filter((r) => r.status === "finalized" || r.status === "paid")
    .reduce(
      (acc, r) => {
        const s = splitWithholdings(r.other_withholdings);
        acc.preTax += s.preTax401k + s.preTax125;
        acc.postTax += s.postTax;
        return acc;
      },
      { preTax: 0, postTax: 0 },
    );

  return {
    gross_pay: totals.grossYtd,
    federal_income_tax: totals.federalIncomeTaxYtd,
    state_income_tax: totals.stateIncomeTaxYtd,
    social_security_employee: totals.socialSecurityEmployeeYtd,
    medicare_employee: totals.medicareEmployeeYtd,
    additional_medicare: totals.additionalMedicareYtd,
    state_disability_employee: totals.stateDisabilityEmployeeYtd,
    pre_tax_deductions: preTax.preTax,
    post_tax_deductions: preTax.postTax,
    net_pay: totals.netPayYtd,
  };
}

async function recordStubEvent(
  supabase: SupabaseLike,
  run: PayrollRun,
  note: string,
): Promise<void> {
  const { error } = await supabase.from("payroll_run_history").insert({
    run_id: run.id,
    event_type: "paid",
    status: run.status,
    gross_pay: Number(run.gross_pay),
    net_pay: Number(run.net_pay),
    notes: note,
  });
  if (error) {
    console.error("[payroll/paystub] recordStubEvent failed:", error);
  }
}
