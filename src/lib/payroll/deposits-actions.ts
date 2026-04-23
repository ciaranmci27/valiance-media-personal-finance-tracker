"use server";

// Tax deposit server actions.
//
// Contract:
//   - upsertDepositsForRun(runId): called from finalizeRun. Adds the run to
//     every deposit bucket it contributes to (federal 941, state withholding,
//     FUTA, SUTA). Idempotent: re-running keeps amounts in sync. Paid deposits
//     are locked; new liability against a paid bucket creates a new scheduled
//     row for the delta so the audit trail stays clean.
//
//   - removeRunFromDeposits(runId): called from voidRun. Strips the run from
//     any scheduled deposits and recomputes amounts. If a bucket drops to
//     zero with no other runs, the scheduled row is soft-deleted. Paid rows
//     are left alone (the money was actually sent).
//
//   - markDepositPaid(depositId, payment_reference, paid_at): flips a
//     scheduled deposit to paid. Does not recompute.
//
//   - listDeposits({ year, status, type }): query helper for the UI.
//
// Arizona has no SDI program, so state_sdi deposits are never created.
//
// Each deposit row carries included_run_ids[] so we can always rebuild the
// amount by re-summing contributions from the referenced runs.

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { round2 } from "./rounding";
import {
  federal941DueDate,
  futaQuarterlyDueDate,
  quarterForPayDate,
  stateQuarterlyDueDate,
  stateWithholdingDueDate,
  triggersNextDayRule,
} from "./deposits";
import type {
  DepositStatus,
  DepositType,
  FederalDepositSchedule,
  OrganizationConfig,
  PayrollDepositHistory,
  PayrollRun,
  PayrollTaxDeposit,
  StateDepositSchedule,
} from "@/types/payroll";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

async function requireActionAuth(): Promise<string | null> {
  if (isDemoMode()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return "Not authenticated";
  return null;
}

interface DepositBucket {
  deposit_type: DepositType;
  period_start: string;
  period_end: string;
  due_date: string;
  /** Per-run contribution to this bucket. Summing across runs gives the
   *  total deposit amount. */
  amount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function federalLiabilityForRun(run: PayrollRun): number {
  // 941 deposit = federal income tax withheld + both halves of FICA + the
  // additional Medicare withheld. Per IRS, all of these aggregate to the
  // semiweekly/monthly deposit amount.
  return round2(
    Number(run.federal_income_tax || 0) +
      Number(run.social_security_employee || 0) +
      Number(run.social_security_employer || 0) +
      Number(run.medicare_employee || 0) +
      Number(run.medicare_employer || 0) +
      Number(run.additional_medicare || 0),
  );
}

/** Computes the period window for a federal 941 bucket based on schedule.
 *  Monthly: calendar month. Semiweekly: the Wed-Fri or Sat-Tue bucket that
 *  contains the pay date. */
function federalBucketPeriod(
  payDateYmd: string,
  schedule: FederalDepositSchedule,
): { period_start: string; period_end: string } {
  if (schedule === "monthly") {
    const [y, m] = payDateYmd.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const last = new Date(Date.UTC(y, m, 0));
    return {
      period_start: ymd(first),
      period_end: ymd(last),
    };
  }
  // Semiweekly: anchor on the pay date's semiweekly period window.
  const d = parseYmd(payDateYmd);
  const dow = d.getUTCDay();
  if (dow === 3 || dow === 4 || dow === 5) {
    // Wed-Fri bucket: period [Wed, Fri] surrounding this payday.
    const start = addDays(d, 3 - dow); // Wed
    const end = addDays(d, 5 - dow); // Fri
    return { period_start: ymd(start), period_end: ymd(end) };
  }
  // Sat-Tue bucket: period [Sat, Tue] surrounding this payday.
  const daysFromSat = dow === 6 ? 0 : dow + 1;
  const start = addDays(d, -daysFromSat); // Sat
  const end = addDays(start, 3); // Tue
  return { period_start: ymd(start), period_end: ymd(end) };
}

function stateBucketPeriod(
  payDateYmd: string,
  schedule: StateDepositSchedule,
): { period_start: string; period_end: string } {
  if (schedule === "quarterly") {
    const q = quarterForPayDate(payDateYmd);
    return { period_start: q.quarterStart, period_end: q.quarterEnd };
  }
  if (schedule === "monthly") {
    return federalBucketPeriod(payDateYmd, "monthly");
  }
  return federalBucketPeriod(payDateYmd, "semiweekly");
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Returns every deposit bucket a finalized run contributes to. Amounts are
 *  this run's share only; aggregation happens in upsertDepositsForRun. */
function bucketsForRun(
  run: PayrollRun,
  org: OrganizationConfig,
): DepositBucket[] {
  const buckets: DepositBucket[] = [];

  // Federal 941 (income tax + FICA)
  const f941 = federalLiabilityForRun(run);
  if (f941 > 0) {
    const period = federalBucketPeriod(run.pay_date, org.federal_deposit_schedule);
    buckets.push({
      deposit_type: "federal_941",
      period_start: period.period_start,
      period_end: period.period_end,
      due_date: federal941DueDate(run.pay_date, org.federal_deposit_schedule),
      amount: f941,
    });
  }

  // State withholding (AZ income tax)
  const sw = round2(Number(run.state_income_tax || 0));
  if (sw > 0) {
    const period = stateBucketPeriod(run.pay_date, org.state_deposit_schedule);
    buckets.push({
      deposit_type: "state_withholding",
      period_start: period.period_start,
      period_end: period.period_end,
      due_date: stateWithholdingDueDate(run.pay_date, org.state_deposit_schedule),
      amount: sw,
    });
  }

  // FUTA (employer only, quarterly, >$500 cumulative threshold enforced at
  // aggregation time - we still record the bucket so Q4 residuals appear)
  const futa = round2(Number(run.futa || 0));
  if (futa > 0) {
    const q = futaQuarterlyDueDate(run.pay_date);
    buckets.push({
      deposit_type: "federal_940",
      period_start: q.quarterStart,
      period_end: q.quarterEnd,
      due_date: q.dueDate,
      amount: futa,
    });
  }

  // SUTA (quarterly)
  const suta = round2(Number(run.suta || 0));
  if (suta > 0) {
    const q = stateQuarterlyDueDate(run.pay_date);
    buckets.push({
      deposit_type: "state_suta",
      period_start: q.quarterStart,
      period_end: q.quarterEnd,
      due_date: q.dueDate,
      amount: suta,
    });
  }

  return buckets;
}

/** Pulls the organization_config row (singleton) for the active tenant. */
async function loadOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<OrganizationConfig | null> {
  const { data } = await supabase
    .from("organization_config")
    .select("*")
    .is("deleted_at", null)
    .maybeSingle();
  return (data as OrganizationConfig | null) ?? null;
}

function contributionForBucket(
  run: PayrollRun,
  bucket: Pick<DepositBucket, "deposit_type">,
): number {
  switch (bucket.deposit_type) {
    case "federal_941":
      return federalLiabilityForRun(run);
    case "state_withholding":
      return round2(Number(run.state_income_tax || 0));
    case "federal_940":
      return round2(Number(run.futa || 0));
    case "state_suta":
      return round2(Number(run.suta || 0));
    case "state_sdi":
      return round2(Number(run.state_disability_employer || 0));
  }
}

// ─── upsertDepositsForRun ─────────────────────────────────────────────────────

export async function upsertDepositsForRun(runId: string): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!runId) return { ok: false, error: "Missing run id" };

  const supabase = await createClient();

  // Only finalized (and later, paid) runs contribute to deposits.
  const { data: runRow } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("id", runId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!runRow) return { ok: false, error: "Run not found" };
  const run = runRow as PayrollRun;
  if (run.status !== "finalized" && run.status !== "paid") {
    return { ok: false, error: "Only approved or paid runs produce deposits" };
  }

  const org = await loadOrganization(supabase);
  if (!org) {
    return {
      ok: false,
      error: "Organization config missing - set up payroll org before approving pay runs",
    };
  }

  const buckets = bucketsForRun(run, org);

  for (const bucket of buckets) {
    // Atomic upsert via RPC. A partial unique index on
    // (deposit_type, period_end) WHERE status <> 'paid' AND deleted_at IS NULL
    // guarantees a single active row per bucket, so concurrent finalizes for
    // the same period can't produce duplicate deposits.
    const notes = buildNotes(bucket.deposit_type, bucket.amount, null);
    const { data: depositId, error: rpcError } = await supabase.rpc(
      "upsert_payroll_tax_deposit_run",
      {
        p_deposit_type: bucket.deposit_type,
        p_period_start: bucket.period_start,
        p_period_end: bucket.period_end,
        p_due_date: bucket.due_date,
        p_run_id: runId,
        p_notes: notes,
      },
    );
    if (rpcError) return { ok: false, error: rpcError.message };

    // The RPC recomputed the amount; re-read to apply the $100k next-day flag
    // to notes. Keeping the flag logic in TS avoids duplicating it in SQL.
    if (bucket.deposit_type === "federal_941" && depositId) {
      const { data: refreshed } = await supabase
        .from("payroll_tax_deposits")
        .select("amount, notes")
        .eq("id", depositId)
        .maybeSingle();
      if (refreshed) {
        const updatedNotes = buildNotes(
          "federal_941",
          Number(refreshed.amount ?? 0),
          refreshed.notes ?? null,
        );
        if (updatedNotes !== refreshed.notes) {
          const { error: noteErr } = await supabase
            .from("payroll_tax_deposits")
            .update({ notes: updatedNotes })
            .eq("id", depositId);
          if (noteErr) return { ok: false, error: noteErr.message };
        }
      }
    }
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/deposits");
  return { ok: true };
}

/** Re-reads every included run and sums its contribution to the given bucket
 *  type. Used to keep deposit amounts in sync with the underlying runs. */
async function aggregateBucketAmount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  type: DepositType,
  runIds: string[],
): Promise<number> {
  if (runIds.length === 0) return 0;
  const { data } = await supabase
    .from("payroll_runs")
    .select(
      "id, status, federal_income_tax, state_income_tax, social_security_employee, social_security_employer, medicare_employee, medicare_employer, additional_medicare, futa, suta, state_disability_employer",
    )
    .in("id", runIds)
    .is("deleted_at", null);
  const runs = (data as PayrollRun[] | null) ?? [];
  let total = 0;
  for (const run of runs) {
    if (run.status !== "finalized" && run.status !== "paid") continue;
    total += contributionForBucket(run, { deposit_type: type });
  }
  return round2(total);
}

function buildNotes(
  type: DepositType,
  amount: number,
  prior: string | null,
): string | null {
  if (type === "federal_941" && triggersNextDayRule(amount)) {
    // IRS Pub 15: $100k next-day rule. This requires the admin to deposit
    // within one banking day of accumulating the liability, and moves them
    // to the semiweekly schedule for the rest of the year. We flag it in
    // the notes so the deposits UI can surface it; we do not silently
    // change the due date because that would mask the regulatory move.
    const flag = "ALERT: $100k next-day deposit rule triggered. Deposit within 1 banking day and switch to semiweekly schedule for the remainder of the year.";
    return prior && prior.includes(flag) ? prior : [prior, flag].filter(Boolean).join(" | ");
  }
  return prior;
}

// ─── removeRunFromDeposits (called from voidRun) ──────────────────────────────

export async function removeRunFromDeposits(runId: string): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!runId) return { ok: false, error: "Missing run id" };

  const supabase = await createClient();

  // Only touch scheduled (non-paid) rows. Paid deposits were really sent
  // and stay as audit evidence; the void creates reconciliation work that
  // the admin does manually.
  const { data: rows } = await supabase
    .from("payroll_tax_deposits")
    .select("*")
    .contains("included_run_ids", [runId])
    .neq("status", "paid")
    .is("deleted_at", null);
  const deposits = (rows as PayrollTaxDeposit[] | null) ?? [];

  for (const row of deposits) {
    const nextIds = (row.included_run_ids ?? []).filter((id) => id !== runId);
    if (nextIds.length === 0) {
      const { error } = await supabase
        .from("payroll_tax_deposits")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) return { ok: false, error: error.message };
      continue;
    }
    const recomputed = await aggregateBucketAmount(
      supabase,
      row.deposit_type,
      nextIds,
    );
    const { error } = await supabase
      .from("payroll_tax_deposits")
      .update({
        amount: recomputed,
        included_run_ids: nextIds,
      })
      .eq("id", row.id);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/deposits");
  return { ok: true };
}

// ─── markDepositPaid ──────────────────────────────────────────────────────────

export interface MarkDepositPaidInput {
  deposit_id: string;
  payment_reference?: string | null;
  paid_at?: string | null;
}

export async function markDepositPaid(
  input: MarkDepositPaidInput,
): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!input.deposit_id) return { ok: false, error: "Missing deposit id" };

  const supabase = await createClient();
  const paidAt = input.paid_at ?? new Date().toISOString();

  const { data: row } = await supabase
    .from("payroll_tax_deposits")
    .select("status, due_date")
    .eq("id", input.deposit_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return { ok: false, error: "Deposit not found" };
  if (row.status === "paid") return { ok: false, error: "Deposit already paid" };

  const { error } = await supabase
    .from("payroll_tax_deposits")
    .update({
      status: "paid" as DepositStatus,
      paid_at: paidAt,
      payment_reference: input.payment_reference?.trim() || null,
    })
    .eq("id", input.deposit_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/payroll");
  revalidatePath("/payroll/deposits");
  return { ok: true };
}

// ─── listDeposits ─────────────────────────────────────────────────────────────

export interface ListDepositsFilter {
  year?: number;
  status?: DepositStatus | "all";
  type?: DepositType | "all";
}

export async function listDeposits(
  filter: ListDepositsFilter = {},
): Promise<ActionResult<PayrollTaxDeposit[]>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true, data: [] };

  const supabase = await createClient();
  let query = supabase
    .from("payroll_tax_deposits")
    .select("*")
    .is("deleted_at", null);

  if (filter.year) {
    query = query
      .gte("period_end", `${filter.year}-01-01`)
      .lte("period_end", `${filter.year}-12-31`);
  }
  if (filter.status && filter.status !== "all") {
    query = query.eq("status", filter.status);
  }
  if (filter.type && filter.type !== "all") {
    query = query.eq("deposit_type", filter.type);
  }

  const { data, error } = await query.order("due_date", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data as PayrollTaxDeposit[] | null) ?? [] };
}

// ─── listDepositHistory ───────────────────────────────────────────────────────

// Lazy-loaded audit trail for a single deposit. The deposits list view fires
// this when the user expands a row's "History" disclosure. Ordered oldest ->
// newest so the timeline reads top-down.
export async function listDepositHistory(
  depositId: string,
): Promise<ActionResult<PayrollDepositHistory[]>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true, data: [] };
  if (!depositId) return { ok: false, error: "Missing deposit id" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payroll_deposit_history")
    .select("*")
    .eq("deposit_id", depositId)
    .is("deleted_at", null)
    .order("changed_at", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data as PayrollDepositHistory[] | null) ?? [] };
}
