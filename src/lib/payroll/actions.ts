"use server";

// Payroll server actions.
//
// All SSN handling happens here because encryptSsn / decryptSsn read
// AES_ENCRYPTION_KEY, which must stay server-side. The form component
// collects plaintext SSN in local state, then hands it to one of these
// actions; nothing about encryption crosses the network in plaintext
// beyond the single request/response.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { encryptSsn, decryptSsn, isSsnEncryptionConfigured } from "@/lib/crypto/ssn";
import {
  checkRateLimit,
  recordPayrollAuditEvent,
  SSN_REVEAL_RATE_LIMIT,
} from "@/lib/payroll/audit";
import type {
  EmployeeStateElection,
  EmploymentType,
  EmployeeStatus,
  FilingStatus,
  PayFrequency,
  PayrollAddress,
} from "@/types/payroll";

// ─── Input shape ──────────────────────────────────────────────────────────────

export interface EmployeeFormInput {
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  address?: PayrollAddress | null;

  /** Plaintext SSN. Pass only when the user typed a new value; leave undefined
   *  to preserve whatever ssn_encrypted already exists on the row. */
  ssn?: string | null;

  employment_type: EmploymentType;
  hire_date: string; // YYYY-MM-DD
  termination_date?: string | null;
  status: EmployeeStatus;

  pay_amount: number;
  pay_frequency: PayFrequency;
  pay_anchor_date: string;
  semimonthly_days?: number[] | null;
  monthly_day?: number | null;
  pay_lag_days: number;
  target_annual_comp?: number | null;

  w4_filing_status: FilingStatus;
  w4_multiple_jobs: boolean;
  w4_exempt: boolean;
  w4_dependents_amount: number;
  w4_other_income: number;
  w4_deductions: number;
  w4_extra_withholding: number;

  state_code: string;
  state_config: EmployeeStateElection;

  notes?: string | null;
}

// ─── Shared result type ───────────────────────────────────────────────────────

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateRequired(input: EmployeeFormInput): string | null {
  if (!input.first_name.trim() || !input.last_name.trim()) {
    return "First and last name are required";
  }
  if (!input.hire_date) return "Hire date is required";
  if (!input.pay_anchor_date) return "Pay anchor date is required";
  if (!input.state_code) return "State is required";
  if (!(Number(input.pay_amount) >= 0)) {
    return "Pay amount must be a non-negative number";
  }
  return null;
}

function normalizeAddress(
  addr: PayrollAddress | null | undefined,
): PayrollAddress | Record<string, never> {
  if (!addr) return {};
  const hasAny =
    addr.line1?.trim() ||
    addr.city?.trim() ||
    addr.state?.trim() ||
    addr.zip?.trim();
  if (!hasAny) return {};
  return {
    line1: addr.line1?.trim() ?? "",
    line2: addr.line2?.trim() || undefined,
    city: addr.city?.trim() ?? "",
    state: addr.state ?? "",
    zip: addr.zip?.trim() ?? "",
  };
}

/** Build the column payload for Supabase insert/update from form input. */
function toColumnPayload(
  input: EmployeeFormInput,
  ssnEncrypted: string | null | undefined,
  ssnKeyVersion: number | null | undefined,
) {
  return {
    first_name: input.first_name.trim(),
    last_name: input.last_name.trim(),
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    address: normalizeAddress(input.address),
    ssn_encrypted: ssnEncrypted ?? null,
    ssn_key_version: ssnKeyVersion ?? null,
    employment_type: input.employment_type,
    hire_date: input.hire_date,
    termination_date: input.termination_date || null,
    status: input.status,
    pay_amount: Number(input.pay_amount),
    pay_frequency: input.pay_frequency,
    pay_anchor_date: input.pay_anchor_date,
    semimonthly_days: input.semimonthly_days ?? null,
    monthly_day: input.monthly_day ?? null,
    pay_lag_days: Number(input.pay_lag_days) || 0,
    target_annual_comp:
      input.target_annual_comp == null ? null : Number(input.target_annual_comp),
    w4_filing_status: input.w4_filing_status,
    w4_multiple_jobs: !!input.w4_multiple_jobs,
    w4_exempt: !!input.w4_exempt,
    w4_dependents_amount: Number(input.w4_dependents_amount) || 0,
    w4_other_income: Number(input.w4_other_income) || 0,
    w4_deductions: Number(input.w4_deductions) || 0,
    w4_extra_withholding: Number(input.w4_extra_withholding) || 0,
    state_code: input.state_code,
    state_config: input.state_config ?? {},
    notes: input.notes?.trim() || null,
  };
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createEmployee(
  input: EmployeeFormInput,
): Promise<ActionResult<{ id: string }>> {
  const validationError = validateRequired(input);
  if (validationError) return { ok: false, error: validationError };

  if (isDemoMode()) {
    return { ok: true, data: { id: "demo-employee-id" } };
  }

  let ssnEncrypted: string | null = null;
  let ssnKeyVersion: number | null = null;
  if (input.ssn && input.ssn.trim()) {
    if (!isSsnEncryptionConfigured()) {
      return {
        ok: false,
        error: "AES_ENCRYPTION_KEY is not configured on the server.",
      };
    }
    try {
      const encrypted = encryptSsn(input.ssn);
      ssnEncrypted = encrypted.ciphertext;
      ssnKeyVersion = encrypted.keyVersion;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to encrypt SSN";
      return { ok: false, error: msg };
    }
  }

  const payload = toColumnPayload(input, ssnEncrypted, ssnKeyVersion);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payroll_employees")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    console.error("[payroll/actions] createEmployee failed:", error);
    return { ok: false, error: error.message };
  }

  revalidatePath("/payroll/employees");
  revalidatePath("/payroll");
  return { ok: true, data: { id: data.id } };
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateEmployee(
  id: string,
  input: EmployeeFormInput,
): Promise<ActionResult> {
  if (!id) return { ok: false, error: "Missing employee id" };

  const validationError = validateRequired(input);
  if (validationError) return { ok: false, error: validationError };

  if (isDemoMode()) {
    return { ok: true };
  }

  const supabase = await createClient();

  // If input.ssn is explicitly passed, re-encrypt. Undefined means
  // "don't touch it"; empty string means "clear it".
  let ssnEncryptedField: string | null | undefined = undefined;
  let ssnKeyVersionField: number | null | undefined = undefined;
  if (input.ssn !== undefined) {
    if (input.ssn === null || input.ssn.trim() === "") {
      ssnEncryptedField = null;
      ssnKeyVersionField = null;
    } else {
      if (!isSsnEncryptionConfigured()) {
        return {
          ok: false,
          error: "AES_ENCRYPTION_KEY is not configured on the server.",
        };
      }
      try {
        const encrypted = encryptSsn(input.ssn);
        ssnEncryptedField = encrypted.ciphertext;
        ssnKeyVersionField = encrypted.keyVersion;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to encrypt SSN";
        return { ok: false, error: msg };
      }
    }
  }

  const payload = toColumnPayload(input, null, null); // ssn fields filled below
  // Remove the null ssn fields when caller didn't touch them.
  const {
    ssn_encrypted: _ignoredCipher,
    ssn_key_version: _ignoredVersion,
    ...rest
  } = payload;
  const updatePayload =
    ssnEncryptedField === undefined
      ? rest
      : {
          ...rest,
          ssn_encrypted: ssnEncryptedField,
          ssn_key_version: ssnKeyVersionField ?? null,
        };

  const { error } = await supabase
    .from("payroll_employees")
    .update(updatePayload)
    .eq("id", id);

  if (error) {
    console.error("[payroll/actions] updateEmployee failed:", error);
    return { ok: false, error: error.message };
  }

  revalidatePath("/payroll/employees");
  revalidatePath(`/payroll/employees/${id}`);
  revalidatePath("/payroll");
  return { ok: true };
}

// ─── Soft delete ──────────────────────────────────────────────────────────────

export async function softDeleteEmployee(id: string): Promise<ActionResult> {
  if (!id) return { ok: false, error: "Missing employee id" };
  if (isDemoMode()) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase
    .from("payroll_employees")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[payroll/actions] softDeleteEmployee failed:", error);
    return { ok: false, error: error.message };
  }

  revalidatePath("/payroll/employees");
  revalidatePath("/payroll");
  return { ok: true };
}

// ─── Reveal SSN ──────────────────────────────────────────────────────────────
//
// Every reveal is audited (payroll_audit_events) and rate-limited per
// authenticated user (10/hour sliding window, in-memory). The audit row is
// written for successful reveals, rate-limited attempts, and decryption
// failures so the log reconstructs intent as well as outcome.

export async function revealEmployeeSsn(
  id: string,
): Promise<ActionResult<{ ssn: string }>> {
  if (!id) return { ok: false, error: "Missing employee id" };
  if (isDemoMode()) return { ok: true, data: { ssn: "123-45-6789" } };

  if (!isSsnEncryptionConfigured()) {
    return {
      ok: false,
      error: "AES_ENCRYPTION_KEY is not configured on the server.",
    };
  }

  const supabase = await createClient();

  // Identify the actor. When ADMIN_ALLOWED_EMAILS is configured, requireAuth
  // has already gated the API surface; here we additionally pull the user so
  // audit rows and the rate-limit bucket are tied to an identity rather than
  // the shared Node process.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorKey = user?.id ?? user?.email ?? "anon";
  const actorMeta = {
    actor_user_id: user?.id ?? null,
    actor_email: user?.email ?? null,
  };

  const limit = checkRateLimit({
    actorKey,
    bucket: SSN_REVEAL_RATE_LIMIT.bucket,
    max: SSN_REVEAL_RATE_LIMIT.max,
    windowMs: SSN_REVEAL_RATE_LIMIT.windowMs,
  });
  if (!limit.allowed) {
    await recordPayrollAuditEvent(supabase, {
      ...actorMeta,
      event_type: "ssn_reveal_rate_limited",
      target_type: "payroll_employee",
      target_id: id,
      metadata: {
        max: SSN_REVEAL_RATE_LIMIT.max,
        window_ms: SSN_REVEAL_RATE_LIMIT.windowMs,
        reset_at: new Date(limit.resetAt).toISOString(),
      },
    });
    return {
      ok: false,
      error: `Too many SSN reveals. Try again after ${new Date(limit.resetAt).toLocaleTimeString()}.`,
    };
  }

  const { data, error } = await supabase
    .from("payroll_employees")
    .select("ssn_encrypted")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error("[payroll/actions] revealEmployeeSsn fetch failed:", error);
    await recordPayrollAuditEvent(supabase, {
      ...actorMeta,
      event_type: "ssn_reveal_failed",
      target_type: "payroll_employee",
      target_id: id,
      metadata: { reason: "fetch_failed", error: error.message },
    });
    return { ok: false, error: error.message };
  }
  if (!data?.ssn_encrypted) {
    await recordPayrollAuditEvent(supabase, {
      ...actorMeta,
      event_type: "ssn_reveal_failed",
      target_type: "payroll_employee",
      target_id: id,
      metadata: { reason: "no_ssn_on_file" },
    });
    return { ok: false, error: "No SSN on file for this employee" };
  }

  try {
    const ssn = decryptSsn(data.ssn_encrypted);
    await recordPayrollAuditEvent(supabase, {
      ...actorMeta,
      event_type: "ssn_reveal",
      target_type: "payroll_employee",
      target_id: id,
      metadata: { remaining_in_window: limit.remaining },
    });
    return { ok: true, data: { ssn } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to decrypt SSN";
    await recordPayrollAuditEvent(supabase, {
      ...actorMeta,
      event_type: "ssn_reveal_failed",
      target_type: "payroll_employee",
      target_id: id,
      metadata: { reason: "decrypt_failed", error: msg },
    });
    return { ok: false, error: msg };
  }
}
