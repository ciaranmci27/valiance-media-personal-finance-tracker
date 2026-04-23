"use server";

// Payroll form server actions (Form 941 for now; 940/W-2 add later phases).
//
// Contract
// --------
//   - generateForm941({ tax_year, quarter }): loads the quarter's runs and
//     federal 941 deposits, aggregates via form-941.ts, and upserts a
//     payroll_forms row keyed by (form_type='941', tax_year, quarter).
//     Idempotent: if a draft exists, the form_data is refreshed. Filed rows
//     are locked; caller must unlock via the UI (not implemented; filed means
//     filed with the IRS and shouldn't mutate).
//
//   - saveForm941Draft({ form_id, form_data }): persists admin edits to
//     line items (e.g., Line 7 override, research credit, sick pay adjustments).
//
//   - markFormFiled({ form_id, confirmation_number, filed_at }): transitions
//     a draft/generated form to filed. Filed rows are not regenerated.
//
//   - listForms({ tax_year }): returns all forms for the year.
//
//   - getForm(id): single form fetch.

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { aggregateForm940 } from "./form-940";
import { aggregateForm941 } from "./form-941";
import { aggregateFormA1Apr } from "./form-a1-apr";
import { aggregateFormA1Qrt } from "./form-a1-qrt";
import { aggregateFormW2 } from "./form-w2";
import { aggregateFormW3 } from "./form-w3";
import type {
  Form940Data,
  Form941Data,
  FormA1AprData,
  FormA1QrtData,
  FormW2Data,
  FormW3Data,
  OrganizationConfig,
  PayrollEmployee,
  PayrollForm,
  PayrollFormStatus,
  PayrollFormType,
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function requireActionAuth(): Promise<string | null> {
  if (isDemoMode()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return "Not authenticated";
  return null;
}

// ─── Result shape ─────────────────────────────────────────────────────────────

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

// ─── generateForm941 ──────────────────────────────────────────────────────────

export interface GenerateForm941Input {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
}

export interface GenerateForm941Result {
  form_id: string;
  data: Form941Data;
  warnings: string[];
}

export async function generateForm941(
  input: GenerateForm941Input,
): Promise<ActionResult<GenerateForm941Result>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: false, error: "Demo mode: forms not available" };

  if (!Number.isInteger(input.tax_year) || input.tax_year < 2020 || input.tax_year > 2100) {
    return { ok: false, error: "Invalid tax year" };
  }
  if (![1, 2, 3, 4].includes(input.quarter)) {
    return { ok: false, error: "Invalid quarter" };
  }

  const supabase = await createClient();

  // Load org config to determine deposit schedule.
  const { data: orgRow } = await supabase
    .from("organization_config")
    .select("*")
    .is("deleted_at", null)
    .maybeSingle();
  const org = (orgRow as OrganizationConfig | null) ?? null;
  if (!org) {
    return {
      ok: false,
      error: "Organization config missing - finish payroll setup before generating 941.",
    };
  }

  const [qStart, qEnd] = quarterRange(input.tax_year, input.quarter);

  // Runs within the quarter, finalized or paid.
  const { data: runRows, error: runErr } = await supabase
    .from("payroll_runs")
    .select("*")
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .gte("pay_date", qStart)
    .lte("pay_date", qEnd);
  if (runErr) return { ok: false, error: runErr.message };
  const runs = (runRows as PayrollRun[] | null) ?? [];

  // Federal 941 deposits with period_end in the quarter. Both paid and
  // scheduled pass through; the aggregator only counts paid toward Line 13a.
  const { data: depRows, error: depErr } = await supabase
    .from("payroll_tax_deposits")
    .select("*")
    .eq("deposit_type", "federal_941")
    .is("deleted_at", null)
    .gte("period_end", qStart)
    .lte("period_end", qEnd);
  if (depErr) return { ok: false, error: depErr.message };
  const deposits = (depRows as PayrollTaxDeposit[] | null) ?? [];

  // Employee hire/termination dates for Line 1. Limited to employees that
  // appear on the quarter's runs so we don't drag in everyone; the aggregator
  // uses this list to catch employees active on the reference date who only
  // have a one-day off-cycle run that doesn't span the 12th.
  const employeeIds = Array.from(new Set(runs.map((r) => r.employee_id)));
  let employees: Array<{
    id: string;
    hire_date: string | null;
    termination_date: string | null;
  }> = [];
  if (employeeIds.length > 0) {
    const { data: empRows, error: empErr } = await supabase
      .from("payroll_employees")
      .select("id, hire_date, termination_date")
      .in("id", employeeIds);
    if (empErr) return { ok: false, error: empErr.message };
    employees =
      (empRows as Array<{
        id: string;
        hire_date: string | null;
        termination_date: string | null;
      }> | null) ?? [];
  }

  const result = aggregateForm941({
    tax_year: input.tax_year,
    quarter: input.quarter,
    runs,
    deposits,
    federal_deposit_schedule: org.federal_deposit_schedule,
    employees,
  });

  // Upsert by (form_type, tax_year, quarter). A partial unique index
  // (payroll_forms_unique_active) enforces at most one non-deleted row per
  // (form_type, tax_year, quarter, employee_id). If maybeSingle() ever reports
  // more than one match (shouldn't happen post-index), surface a hard error
  // instead of silently inserting a duplicate.
  const { data: existingRow, error: existingErr } = await supabase
    .from("payroll_forms")
    .select("*")
    .eq("form_type", "941")
    .eq("tax_year", input.tax_year)
    .eq("quarter", input.quarter)
    .is("deleted_at", null)
    .maybeSingle();
  if (existingErr) {
    return {
      ok: false,
      error: `Form lookup failed: ${existingErr.message}. Contact an administrator - there may be duplicate Form 941 rows for this quarter.`,
    };
  }
  const existing = (existingRow as PayrollForm | null) ?? null;

  if (existing && existing.status === "filed") {
    return {
      ok: false,
      error: "Form 941 for this quarter is already filed and locked.",
    };
  }

  if (existing) {
    const { error } = await supabase
      .from("payroll_forms")
      .update({
        form_data: result.data,
        status: "generated" as PayrollFormStatus,
        generated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/payroll");
    revalidatePath("/payroll/forms");
    revalidatePath(`/payroll/forms/941/${input.tax_year}/${input.quarter}`);
    return {
      ok: true,
      data: {
        form_id: existing.id,
        data: result.data,
        warnings: result.warnings,
      },
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("payroll_forms")
    .insert({
      form_type: "941",
      tax_year: input.tax_year,
      quarter: input.quarter,
      status: "generated" as PayrollFormStatus,
      form_data: result.data,
      generated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insErr) {
    // 23505 = unique_violation. Concurrent generate raced past the SELECT above
    // and hit the unique index. Surface a clear, retryable message.
    if ((insErr as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: "Form 941 for this quarter was created by another request. Refresh and try again.",
      };
    }
    return { ok: false, error: insErr.message };
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/forms");
  revalidatePath(`/payroll/forms/941/${input.tax_year}/${input.quarter}`);
  return {
    ok: true,
    data: {
      form_id: (inserted as { id: string }).id,
      data: result.data,
      warnings: result.warnings,
    },
  };
}

// ─── generateFormA1Qrt ────────────────────────────────────────────────────────

export interface GenerateFormA1QrtInput {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
}

export interface GenerateFormA1QrtResult {
  form_id: string;
  data: FormA1QrtData;
  warnings: string[];
}

export async function generateFormA1Qrt(
  input: GenerateFormA1QrtInput,
): Promise<ActionResult<GenerateFormA1QrtResult>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: false, error: "Demo mode: forms not available" };

  if (!Number.isInteger(input.tax_year) || input.tax_year < 2020 || input.tax_year > 2100) {
    return { ok: false, error: "Invalid tax year" };
  }
  if (![1, 2, 3, 4].includes(input.quarter)) {
    return { ok: false, error: "Invalid quarter" };
  }

  const supabase = await createClient();

  const { data: orgRow } = await supabase
    .from("organization_config")
    .select("*")
    .is("deleted_at", null)
    .maybeSingle();
  const org = (orgRow as OrganizationConfig | null) ?? null;
  if (!org) {
    return {
      ok: false,
      error: "Organization config missing - finish payroll setup before generating A1-QRT.",
    };
  }

  const [qStart, qEnd] = quarterRange(input.tax_year, input.quarter);

  // A1-QRT only covers AZ-sourced wages. Join in the employee state_code so
  // multi-state orgs only include Arizona runs. An employee who moved out of
  // AZ mid-year keeps their old runs tagged via the employee_snapshot, but
  // today we filter off the live state_code - sufficient for the AZ-only
  // scope we target.
  const { data: runRows, error: runErr } = await supabase
    .from("payroll_runs")
    .select("*, payroll_employees!inner(state_code)")
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .eq("payroll_employees.state_code", "AZ")
    .gte("pay_date", qStart)
    .lte("pay_date", qEnd);
  if (runErr) return { ok: false, error: runErr.message };
  const runs = ((runRows as (PayrollRun & { payroll_employees: unknown })[] | null) ?? []).map(
    (r) => {
      const { payroll_employees: _ignored, ...rest } = r;
      void _ignored;
      return rest as PayrollRun;
    },
  );

  const { data: depRows, error: depErr } = await supabase
    .from("payroll_tax_deposits")
    .select("*")
    .eq("deposit_type", "state_withholding")
    .is("deleted_at", null)
    .gte("period_end", qStart)
    .lte("period_end", qEnd);
  if (depErr) return { ok: false, error: depErr.message };
  const deposits = (depRows as PayrollTaxDeposit[] | null) ?? [];

  const result = aggregateFormA1Qrt({
    tax_year: input.tax_year,
    quarter: input.quarter,
    runs,
    deposits,
    state_deposit_schedule: org.state_deposit_schedule,
  });

  return await upsertForm({
    form_type: "a1_qrt",
    tax_year: input.tax_year,
    quarter: input.quarter,
    employee_id: null,
    form_data: result.data,
    warnings: result.warnings,
    revalidatePaths: [
      "/payroll",
      "/payroll/forms",
      `/payroll/forms/a1-qrt/${input.tax_year}/${input.quarter}`,
    ],
    duplicateErrorMessage:
      "A1-QRT for this quarter was created by another request. Refresh and try again.",
    filedErrorMessage: "AZ A1-QRT for this quarter is already filed and locked.",
  });
}

// ─── generateForm940 ──────────────────────────────────────────────────────────

export interface GenerateForm940Input {
  tax_year: number;
}

export interface GenerateForm940Result {
  form_id: string;
  data: Form940Data;
  warnings: string[];
}

export async function generateForm940(
  input: GenerateForm940Input,
): Promise<ActionResult<GenerateForm940Result>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: false, error: "Demo mode: forms not available" };

  if (!Number.isInteger(input.tax_year) || input.tax_year < 2020 || input.tax_year > 2100) {
    return { ok: false, error: "Invalid tax year" };
  }

  const supabase = await createClient();
  const [yStart, yEnd] = yearRange(input.tax_year);

  const { data: runRows, error: runErr } = await supabase
    .from("payroll_runs")
    .select("*")
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .gte("pay_date", yStart)
    .lte("pay_date", yEnd);
  if (runErr) return { ok: false, error: runErr.message };
  const runs = (runRows as PayrollRun[] | null) ?? [];

  const { data: depRows, error: depErr } = await supabase
    .from("payroll_tax_deposits")
    .select("*")
    .eq("deposit_type", "federal_940")
    .is("deleted_at", null)
    .gte("period_end", yStart)
    .lte("period_end", yEnd);
  if (depErr) return { ok: false, error: depErr.message };
  const deposits = (depRows as PayrollTaxDeposit[] | null) ?? [];

  const result = aggregateForm940({
    tax_year: input.tax_year,
    runs,
    deposits,
  });

  return await upsertForm({
    form_type: "940",
    tax_year: input.tax_year,
    quarter: null,
    employee_id: null,
    form_data: result.data,
    warnings: result.warnings,
    revalidatePaths: [
      "/payroll",
      "/payroll/forms",
      `/payroll/forms/940/${input.tax_year}`,
    ],
    duplicateErrorMessage:
      "Form 940 for this year was created by another request. Refresh and try again.",
    filedErrorMessage: "Form 940 for this year is already filed and locked.",
  });
}

// ─── generateFormW2 ───────────────────────────────────────────────────────────

export interface GenerateFormW2Input {
  tax_year: number;
  employee_id: string;
}

export interface GenerateFormW2Result {
  form_id: string;
  data: FormW2Data;
  warnings: string[];
}

export async function generateFormW2(
  input: GenerateFormW2Input,
): Promise<ActionResult<GenerateFormW2Result>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: false, error: "Demo mode: forms not available" };

  if (!Number.isInteger(input.tax_year) || input.tax_year < 2020 || input.tax_year > 2100) {
    return { ok: false, error: "Invalid tax year" };
  }
  if (!input.employee_id) return { ok: false, error: "Missing employee id" };

  const supabase = await createClient();
  const [yStart, yEnd] = yearRange(input.tax_year);

  const { data: empRow } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("id", input.employee_id)
    .is("deleted_at", null)
    .maybeSingle();
  const employee = (empRow as PayrollEmployee | null) ?? null;
  if (!employee) {
    return { ok: false, error: "Employee not found" };
  }

  const { data: runRows, error: runErr } = await supabase
    .from("payroll_runs")
    .select("*")
    .is("deleted_at", null)
    .eq("employee_id", input.employee_id)
    .in("status", ["finalized", "paid"])
    .gte("pay_date", yStart)
    .lte("pay_date", yEnd);
  if (runErr) return { ok: false, error: runErr.message };
  const runs = (runRows as PayrollRun[] | null) ?? [];

  const result = aggregateFormW2({
    tax_year: input.tax_year,
    runs,
    employee,
  });

  return await upsertForm({
    form_type: "w2",
    tax_year: input.tax_year,
    quarter: null,
    employee_id: input.employee_id,
    form_data: result.data,
    warnings: result.warnings,
    revalidatePaths: [
      "/payroll",
      "/payroll/forms",
      `/payroll/forms/w2/${input.tax_year}/${input.employee_id}`,
    ],
    duplicateErrorMessage:
      "W-2 for this employee/year was created by another request. Refresh and try again.",
    filedErrorMessage: "W-2 for this employee/year is already filed and locked.",
  });
}

// ─── generateFormW3 ───────────────────────────────────────────────────────────

export interface GenerateFormW3Input {
  tax_year: number;
}

export interface GenerateFormW3Result {
  form_id: string;
  data: FormW3Data;
  warnings: string[];
}

export async function generateFormW3(
  input: GenerateFormW3Input,
): Promise<ActionResult<GenerateFormW3Result>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: false, error: "Demo mode: forms not available" };

  if (!Number.isInteger(input.tax_year) || input.tax_year < 2020 || input.tax_year > 2100) {
    return { ok: false, error: "Invalid tax year" };
  }

  const supabase = await createClient();

  // W-3 rolls up the generated W-2s for the year. If any employees lack a W-2
  // row, we surface a warning; the admin should generate individual W-2s
  // first. Reading stored W-2s (vs recomputing) ensures the W-3 reflects any
  // manual box overrides the admin applied on each W-2 viewer.
  const { data: w2Rows, error: w2Err } = await supabase
    .from("payroll_forms")
    .select("form_data, employee_id")
    .eq("form_type", "w2")
    .eq("tax_year", input.tax_year)
    .is("deleted_at", null);
  if (w2Err) return { ok: false, error: w2Err.message };
  const w2s = ((w2Rows as { form_data: FormW2Data; employee_id: string | null }[] | null) ?? [])
    .map((r) => r.form_data);

  // The aggregator already emits a "no W-2s" warning when the input is empty;
  // pass warnings through as-is to avoid duplicating guidance.
  const result = aggregateFormW3({ tax_year: input.tax_year, w2s });

  return await upsertForm({
    form_type: "w3",
    tax_year: input.tax_year,
    quarter: null,
    employee_id: null,
    form_data: result.data,
    warnings: result.warnings,
    revalidatePaths: [
      "/payroll",
      "/payroll/forms",
      `/payroll/forms/w3/${input.tax_year}`,
    ],
    duplicateErrorMessage:
      "W-3 for this year was created by another request. Refresh and try again.",
    filedErrorMessage: "W-3 for this year is already filed and locked.",
  });
}

// ─── generateFormA1Apr ────────────────────────────────────────────────────────

export interface GenerateFormA1AprInput {
  tax_year: number;
}

export interface GenerateFormA1AprResult {
  form_id: string;
  data: FormA1AprData;
  warnings: string[];
}

export async function generateFormA1Apr(
  input: GenerateFormA1AprInput,
): Promise<ActionResult<GenerateFormA1AprResult>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: false, error: "Demo mode: forms not available" };

  if (!Number.isInteger(input.tax_year) || input.tax_year < 2020 || input.tax_year > 2100) {
    return { ok: false, error: "Invalid tax year" };
  }

  const supabase = await createClient();

  // Pull the four stored A1-QRTs for the year and the rolled-up W-3.
  const [qrtRes, w3Res, empRes] = await Promise.all([
    supabase
      .from("payroll_forms")
      .select("quarter, form_data")
      .eq("form_type", "a1_qrt")
      .eq("tax_year", input.tax_year)
      .is("deleted_at", null),
    supabase
      .from("payroll_forms")
      .select("form_data")
      .eq("form_type", "w3")
      .eq("tax_year", input.tax_year)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("payroll_forms")
      .select("employee_id")
      .eq("form_type", "w2")
      .eq("tax_year", input.tax_year)
      .is("deleted_at", null),
  ]);

  if (qrtRes.error) return { ok: false, error: qrtRes.error.message };
  if (w3Res.error) return { ok: false, error: w3Res.error.message };
  if (empRes.error) return { ok: false, error: empRes.error.message };

  const quarters: {
    q1?: FormA1QrtData;
    q2?: FormA1QrtData;
    q3?: FormA1QrtData;
    q4?: FormA1QrtData;
  } = {};
  for (const row of (qrtRes.data as { quarter: number; form_data: FormA1QrtData }[] | null) ?? []) {
    const key = `q${row.quarter}` as "q1" | "q2" | "q3" | "q4";
    if (row.quarter === 1 || row.quarter === 2 || row.quarter === 3 || row.quarter === 4) {
      quarters[key] = row.form_data;
    }
  }

  const w3 = (w3Res.data?.form_data as FormW3Data | undefined) ?? undefined;
  const w2_count = ((empRes.data as { employee_id: string | null }[] | null) ?? []).length;

  // Distinct-employees count for the year: derive from the runs to catch any
  // employees paid but not yet on a W-2 (e.g., pre-W-2-generation).
  const [yStart, yEnd] = yearRange(input.tax_year);
  const { data: empRuns } = await supabase
    .from("payroll_runs")
    .select("employee_id")
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .gte("pay_date", yStart)
    .lte("pay_date", yEnd);
  const distinctEmployees = new Set(
    ((empRuns as { employee_id: string }[] | null) ?? []).map((r) => r.employee_id),
  ).size;

  const result = aggregateFormA1Apr({
    tax_year: input.tax_year,
    quarters,
    w3,
    w2_count,
    total_employees: distinctEmployees,
  });

  return await upsertForm({
    form_type: "a1_apr",
    tax_year: input.tax_year,
    quarter: null,
    employee_id: null,
    form_data: result.data,
    warnings: result.warnings,
    revalidatePaths: [
      "/payroll",
      "/payroll/forms",
      `/payroll/forms/a1-apr/${input.tax_year}`,
    ],
    duplicateErrorMessage:
      "A1-APR for this year was created by another request. Refresh and try again.",
    filedErrorMessage: "AZ A1-APR for this year is already filed and locked.",
  });
}

// ─── Shared upsert plumbing ───────────────────────────────────────────────────

interface UpsertFormInput {
  form_type: PayrollFormType;
  tax_year: number;
  quarter: number | null;
  employee_id: string | null;
  form_data:
    | Form940Data
    | Form941Data
    | FormA1AprData
    | FormA1QrtData
    | FormW2Data
    | FormW3Data;
  warnings: string[];
  revalidatePaths: string[];
  duplicateErrorMessage: string;
  filedErrorMessage: string;
}

async function upsertForm<T extends UpsertFormInput>(
  input: T,
): Promise<ActionResult<{ form_id: string; data: T["form_data"]; warnings: string[] }>> {
  const supabase = await createClient();

  let existingQuery = supabase
    .from("payroll_forms")
    .select("*")
    .eq("form_type", input.form_type)
    .eq("tax_year", input.tax_year)
    .is("deleted_at", null);

  if (input.quarter != null) {
    existingQuery = existingQuery.eq("quarter", input.quarter);
  } else {
    existingQuery = existingQuery.is("quarter", null);
  }
  if (input.employee_id != null) {
    existingQuery = existingQuery.eq("employee_id", input.employee_id);
  } else {
    existingQuery = existingQuery.is("employee_id", null);
  }

  const { data: existingRow, error: existingErr } = await existingQuery.maybeSingle();
  if (existingErr) {
    return {
      ok: false,
      error: `Form lookup failed: ${existingErr.message}. Contact an administrator - there may be duplicate form rows for this key.`,
    };
  }
  const existing = (existingRow as PayrollForm | null) ?? null;

  if (existing && existing.status === "filed") {
    return { ok: false, error: input.filedErrorMessage };
  }

  if (existing) {
    const { error } = await supabase
      .from("payroll_forms")
      .update({
        form_data: input.form_data,
        status: "generated" as PayrollFormStatus,
        generated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    for (const p of input.revalidatePaths) revalidatePath(p);
    return {
      ok: true,
      data: {
        form_id: existing.id,
        data: input.form_data as T["form_data"],
        warnings: input.warnings,
      },
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("payroll_forms")
    .insert({
      form_type: input.form_type,
      tax_year: input.tax_year,
      quarter: input.quarter,
      employee_id: input.employee_id,
      status: "generated" as PayrollFormStatus,
      form_data: input.form_data,
      generated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      return { ok: false, error: input.duplicateErrorMessage };
    }
    return { ok: false, error: insErr.message };
  }

  for (const p of input.revalidatePaths) revalidatePath(p);
  return {
    ok: true,
    data: {
      form_id: (inserted as { id: string }).id,
      data: input.form_data as T["form_data"],
      warnings: input.warnings,
    },
  };
}

// ─── saveForm941Draft ─────────────────────────────────────────────────────────

export interface SaveForm941DraftInput {
  form_id: string;
  form_data: Form941Data;
}

export async function saveForm941Draft(
  input: SaveForm941DraftInput,
): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!input.form_id) return { ok: false, error: "Missing form id" };

  const supabase = await createClient();

  const { data: row } = await supabase
    .from("payroll_forms")
    .select("id, form_type, tax_year, quarter, status")
    .eq("id", input.form_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return { ok: false, error: "Form not found" };
  if (row.status === "filed") {
    return { ok: false, error: "Filed forms cannot be edited" };
  }
  if (row.form_type !== "941") {
    return { ok: false, error: "Wrong form type - this endpoint only saves 941" };
  }

  // Light sanity check on the payload: tax_year and quarter must match.
  if (
    input.form_data.tax_year !== row.tax_year ||
    input.form_data.quarter !== row.quarter
  ) {
    return {
      ok: false,
      error: "Form data year/quarter do not match the stored form",
    };
  }

  const { error } = await supabase
    .from("payroll_forms")
    .update({
      form_data: input.form_data,
      status: "draft" as PayrollFormStatus,
    })
    .eq("id", input.form_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/payroll/forms");
  revalidatePath(`/payroll/forms/941/${row.tax_year}/${row.quarter}`);
  return { ok: true };
}

// ─── markFormFiled ────────────────────────────────────────────────────────────

export interface MarkFormFiledInput {
  form_id: string;
  confirmation_number?: string | null;
  filed_at?: string | null;
}

export async function markFormFiled(
  input: MarkFormFiledInput,
): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!input.form_id) return { ok: false, error: "Missing form id" };

  const supabase = await createClient();

  const { data: row } = await supabase
    .from("payroll_forms")
    .select("id, status, form_type, tax_year, quarter, employee_id")
    .eq("id", input.form_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return { ok: false, error: "Form not found" };
  if (row.status === "filed") {
    return { ok: false, error: "Form is already filed" };
  }

  const filedAt = input.filed_at ?? new Date().toISOString();
  const { error } = await supabase
    .from("payroll_forms")
    .update({
      status: "filed" as PayrollFormStatus,
      filed_at: filedAt,
      confirmation_number: input.confirmation_number?.trim() || null,
    })
    .eq("id", input.form_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/payroll");
  revalidatePath("/payroll/forms");
  revalidatePath(
    formDetailPath(
      row.form_type as PayrollFormType,
      row.tax_year,
      row.quarter,
      row.employee_id ?? null,
    ),
  );
  return { ok: true };
}

// ─── Form-specific detail path helper ─────────────────────────────────────────

function formDetailPath(
  type: PayrollFormType,
  year: number,
  quarter: number | null,
  employeeId: string | null,
): string {
  switch (type) {
    case "941":
      return `/payroll/forms/941/${year}/${quarter ?? 1}`;
    case "940":
      return `/payroll/forms/940/${year}`;
    case "a1_qrt":
      return `/payroll/forms/a1-qrt/${year}/${quarter ?? 1}`;
    case "a1_apr":
      return `/payroll/forms/a1-apr/${year}`;
    case "w2":
      return `/payroll/forms/w2/${year}/${employeeId ?? ""}`;
    case "w3":
      return `/payroll/forms/w3/${year}`;
    case "efw2":
      return `/payroll/forms/efw2/${year}`;
    default:
      return "/payroll/forms";
  }
}

// ─── listForms ────────────────────────────────────────────────────────────────

export interface ListFormsFilter {
  tax_year?: number;
}

export async function listForms(
  filter: ListFormsFilter = {},
): Promise<ActionResult<PayrollForm[]>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true, data: [] };

  const supabase = await createClient();
  let query = supabase
    .from("payroll_forms")
    .select("*")
    .is("deleted_at", null);
  if (filter.tax_year) query = query.eq("tax_year", filter.tax_year);

  const { data, error } = await query
    .order("tax_year", { ascending: false })
    .order("quarter", { ascending: true })
    .order("form_type", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data as PayrollForm[] | null) ?? [] };
}

// ─── getForm ──────────────────────────────────────────────────────────────────

export async function getForm(
  id: string,
): Promise<ActionResult<PayrollForm | null>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true, data: null };
  if (!id) return { ok: false, error: "Missing form id" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payroll_forms")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data as PayrollForm | null) ?? null };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function yearRange(year: number): [string, string] {
  return [`${year}-01-01`, `${year}-12-31`];
}

function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): [string, string] {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const pad = (n: number) => String(n).padStart(2, "0");
  // Quarter ends are always Mar/Jun/Sep/Dec. Jun and Sep have 30 days; Mar and
  // Dec have 31. No leap-year concern since Feb is never a quarter end.
  const endDay = endMonth === 6 || endMonth === 9 ? 30 : 31;
  return [
    `${year}-${pad(startMonth)}-01`,
    `${year}-${pad(endMonth)}-${pad(endDay)}`,
  ];
}
