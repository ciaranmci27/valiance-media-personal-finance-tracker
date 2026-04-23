/**
 * Payroll audit helpers.
 *
 * Two independent audit streams live here:
 *
 * 1. Config change log (`config_change_history`) - one row per edit to
 *    organization_config, federal_tax_configs, or state_tax_configs. Called
 *    explicitly from server actions (not a DB trigger) so the change_summary
 *    can carry UI context (e.g. "Updated AZ A-4 rate to 2.0%").
 *
 * 2. Sensitive-action audit log (`payroll_audit_events`) - append-only
 *    record of things like SSN reveals. Generic event_type + target_type
 *    shape so we can add new sensitive actions without another migration.
 *    Also hosts the in-memory rate limiter used by those actions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConfigChangeType } from "@/types/payroll";
import { isDemoMode } from "@/lib/demo";

export interface RecordConfigChangeArgs {
  configType: ConfigChangeType;
  configId: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  summary?: string;
}

/**
 * Generate a short human-readable summary from a shallow diff of two
 * objects. Keys whose values are deeply equal are skipped. Used when the
 * caller does not pass an explicit summary.
 */
export function summarizeDiff(
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null,
  maxFields: number = 5
): string {
  if (!oldValues && newValues) return "Created";
  if (oldValues && !newValues) return "Deleted";
  if (!oldValues || !newValues) return "No change";

  const changed: string[] = [];
  const keys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);

  for (const key of keys) {
    const before = oldValues[key];
    const after = newValues[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push(key);
    }
  }

  if (changed.length === 0) return "No change";
  if (changed.length <= maxFields) {
    return `Updated: ${changed.join(", ")}`;
  }
  const shown = changed.slice(0, maxFields).join(", ");
  return `Updated: ${shown} (+${changed.length - maxFields} more)`;
}

/**
 * Insert an audit row. Silently no-ops in demo mode.
 * Failures are logged but do not throw; the primary mutation should
 * not be rolled back because an audit write failed.
 */
export async function recordConfigChange(
  supabase: SupabaseClient,
  args: RecordConfigChangeArgs
): Promise<void> {
  if (isDemoMode()) return;

  const summary =
    args.summary ?? summarizeDiff(args.oldValues, args.newValues);

  const { error } = await supabase.from("config_change_history").insert({
    config_type: args.configType,
    config_id: args.configId,
    old_values: args.oldValues,
    new_values: args.newValues,
    change_summary: summary,
  });

  if (error) {
    console.error("[payroll/audit] failed to record config change:", error);
  }
}

// ─── Sensitive-action audit log ───────────────────────────────────────────────

export interface PayrollAuditEventInput {
  actor_user_id?: string | null;
  actor_email?: string | null;
  event_type: string;
  target_type: string;
  target_id?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append a row to payroll_audit_events. Silent no-op in demo mode. Failures
 * are logged but never thrown: the caller's primary action (e.g. revealing
 * an SSN) must not be blocked by a missed audit row, but the console error
 * has to be loud enough that admins notice gaps during review.
 */
export async function recordPayrollAuditEvent(
  supabase: SupabaseClient,
  event: PayrollAuditEventInput,
): Promise<void> {
  if (isDemoMode()) return;

  const { error } = await supabase.from("payroll_audit_events").insert({
    actor_user_id: event.actor_user_id ?? null,
    actor_email: event.actor_email ?? null,
    event_type: event.event_type,
    target_type: event.target_type,
    target_id: event.target_id ?? null,
    metadata: event.metadata ?? {},
  });
  if (error) {
    console.error("[payroll/audit] failed to record audit event:", {
      event_type: event.event_type,
      target_type: event.target_type,
      target_id: event.target_id,
      error,
    });
  }
}

// ─── In-memory rate limiter ───────────────────────────────────────────────────
//
// Per Node process, so in serverless each instance keeps its own counters.
// That is fine as a throttle against scripted scraping from a single tab:
// the audit log provides forensic coverage even if the limiter is bypassed
// via multi-instance fan-out. A shared store (Redis) would be required for
// strict cross-instance enforcement.

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window after this call is accounted for. */
  remaining: number;
  /** Epoch ms at which the oldest tracked request ages out (a slot frees). */
  resetAt: number;
}

export interface RateLimitOptions {
  /** Stable identifier for the actor (user id > email > 'anon'). */
  actorKey: string;
  /** Logical bucket name so different actions do not share a counter. */
  bucket: string;
  /** Max requests allowed within `windowMs`. */
  max: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
}

// bucketName -> (actorKey -> ascending timestamps of recent requests)
const rateLimitBuckets = new Map<string, Map<string, number[]>>();

export function checkRateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const cutoff = now - opts.windowMs;

  let perActor = rateLimitBuckets.get(opts.bucket);
  if (!perActor) {
    perActor = new Map();
    rateLimitBuckets.set(opts.bucket, perActor);
  }
  const history = (perActor.get(opts.actorKey) ?? []).filter((t) => t > cutoff);

  if (history.length >= opts.max) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: history[0] + opts.windowMs,
    };
  }

  history.push(now);
  perActor.set(opts.actorKey, history);
  return {
    allowed: true,
    remaining: opts.max - history.length,
    resetAt: history[0] + opts.windowMs,
  };
}

export const SSN_REVEAL_RATE_LIMIT = {
  bucket: "ssn_reveal",
  max: 10,
  windowMs: 60 * 60 * 1000, // 1 hour
} as const;
