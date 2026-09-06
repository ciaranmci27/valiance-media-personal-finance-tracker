import { z } from "zod";
import { dateSchema } from "./contracts";
import { readCents } from "./money";
import type { AccountingWorkspace } from "./contracts";

const id = z.uuid(),
  version = z.number().int().min(1).max(2147483646);
const cents = z.string().refine((v) => {
  try {
    readCents(v);
    return true;
  } catch {
    return false;
  }
}, "Enter an exact amount in cents.");
const positive = cents.pipe(
  z.string().refine((v) => BigInt(v) > BigInt(0), "Enter a positive amount."),
);
const nonzero = cents.pipe(
  z.string().refine((v) => BigInt(v) !== BigInt(0), "Enter a nonzero amount."),
);
const nonnegative = cents.pipe(
  z
    .string()
    .refine((v) => BigInt(v) >= BigInt(0), "Enter zero or a positive amount."),
);
const reason = z.string().trim().min(1).max(1000),
  revision = z.string().regex(/^\d{1,19}$/);
const month = dateSchema.refine(
  (v) => v.endsWith("-01"),
  "Choose the first day of the month.",
);
const base = { id, expected_version: version },
  period = { id, expected_revision: revision };
export const closeCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("account.lifecycle"),
      ...period,
      expected_version: z.number().int().min(0).max(2147483646),
      opened_on: dateSchema,
      closed_on: dateSchema.nullable(),
      document_id: id.nullable(),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.create"),
      id,
      account_id: id,
      from: dateSchema,
      to: dateSchema,
      opening_cents: cents,
      ending_cents: cents,
      declared_count: z.number().int().min(0).max(50000),
      declared_debits_cents: nonnegative,
      declared_credits_cents: nonnegative,
      document_id: id,
      predecessor_id: id.nullable().optional(),
      notes: z.string().max(3000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.items"),
      ...base,
      items: z
        .array(
          z
            .object({
              id,
              ordinal: z.number().int().min(0).max(49999),
              entry_date: dateSchema,
              description: reason,
              amount_cents: nonzero,
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.item.remove"),
      ...base,
      item_id: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.opening"),
      ...base,
      expected_revision: revision,
      reviewed: z.literal(true),
      outstanding: z
        .array(z.object({ line_id: id, amount_cents: nonzero }).strict())
        .max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.allocate"),
      ...base,
      allocations: z
        .array(
          z
            .object({
              id,
              statement_item_id: id,
              entry_line_id: id,
              amount_cents: nonzero,
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.unmatch"),
      ...base,
      allocation_id: id,
    })
    .strict(),
  z.object({ type: z.literal("reconciliation.complete"), ...base }).strict(),
  z
    .object({ type: z.literal("reconciliation.cancel"), ...base, reason })
    .strict(),
  z
    .object({ type: z.literal("reconciliation.reopen"), ...base, reason })
    .strict(),
  z
    .object({
      type: z.literal("clearing.allocate"),
      ...period,
      obligation_line_id: id,
      settlement_line_id: id,
      amount_cents: positive,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("clearing.release"),
      ...period,
      allocation_id: id,
      effective_date: dateSchema,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("clearing.review"),
      ...period,
      line_id: id,
      as_of: dateSchema,
      residual_cents: nonzero,
      expected_resolution: dateSchema,
      document_id: id,
      reason,
    })
    .strict(),
  z.object({ type: z.literal("period.close"), ...period, month }).strict(),
  z
    .object({ type: z.literal("period.reopen"), ...period, month, reason })
    .strict(),
  z
    .object({
      type: z.literal("year.configure"),
      ...period,
      year: z.number().int().min(1900).max(2100),
      classification: z.enum(["s_corp", "other", "unverified"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("year.file"),
      ...period,
      year: z.number().int().min(1900).max(2100),
      filed_on: dateSchema,
      document_id: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("year.restatement.begin"),
      ...period,
      month,
      reason,
      document_id: id,
      external_return_review: z.enum([
        "required",
        "not_required_with_explanation",
      ]),
      return_review_explanation: z.string().trim().min(1).max(3000),
    })
    .strict(),
  z
    .object({ type: z.literal("year.restatement.complete"), ...period })
    .strict(),
]);
export interface Statement {
  id: string;
  version: number;
  account_id: string;
  from_date: string;
  to_date: string;
  opening_cents: string;
  ending_cents: string;
  declared_count: number;
  declared_debits_cents: string;
  declared_credits_cents: string;
  predecessor_id: string | null;
  document_id: string;
  status: "in_progress" | "completed" | "superseded" | "cancelled";
  notes: string;
}
export interface ReconciliationProof {
  ready: boolean;
  revision: string;
  item_count: number;
  declared_count: number;
  debits_cents: string;
  credits_cents: string;
  unmatched_items: number;
  opening_difference_cents: string | null;
  statement_difference_cents: string;
  book_balance_cents: string;
  outstanding_cents: string;
  bridge_difference_cents: string;
  outstanding: {
    line_id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    amount_cents: string;
    outstanding_cents: string;
  }[];
}
export interface ReconciliationView {
  revision: string;
  statements: Statement[];
  statement: Statement | null;
  proof: ReconciliationProof | null;
  opening_book_cents: string;
  item_count: number;
  line_count: number;
  next_ordinal: number | null;
  items: {
    id: string;
    ordinal: number;
    entry_date: string;
    description: string;
    amount_cents: string;
    remaining_cents: string;
    allocations: {
      id: string;
      entry_line_id: string;
      entry_id: string;
      amount_cents: string;
      memo: string;
    }[];
  }[];
  lines: {
    id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    amount_cents: string;
    remaining_cents: string;
    available_cents: string;
  }[];
}
export interface ClearingView {
  allocations: {
    id: string;
    effective_date: string;
    amount_cents: string;
    reason: string;
    obligation_entry_id: string;
    settlement_entry_id: string;
    obligation_memo: string;
    settlement_memo: string;
    account_name: string;
    released: { effective_date: string; reason: string } | null;
  }[];
  as_of: string;
  revision: string;
  rows: {
    line_id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    account_id: string;
    account_name: string;
    purpose: string;
    normal_side: string;
    amount_cents: string;
    residual_cents: string;
    review: {
      id: string;
      reason: string;
      expected_resolution: string;
      document_id: string;
    } | null;
    allocations: {
      id: string;
      obligation_line_id: string;
      settlement_line_id: string;
      amount_cents: string;
      effective_date: string;
      reason: string;
      released: { effective_date: string; reason: string } | null;
    }[];
  }[];
}
export interface CloseChecklist {
  month_ended: boolean;
  month_start: string;
  through: string;
  revision: string;
  ready: boolean;
  drafts: number;
  unreviewed_feed_movements: number;
  unverified_imports: number;
  unreconciled_accounts: number;
  uncategorized_lines: number;
  opening_suspense_accounts: number;
  unexplained_clearing_lines: number;
  accounts: { id: string; name: string; reconciliation_id: string | null }[];
  obligations: ClearingView["rows"];
  reports: AccountingWorkspace;
}
export interface PeriodImpact {
  revision: string;
  periods: { month_start: string; is_locked: boolean; reason: string }[];
  filed_years: {
    year: number;
    classification: string;
    filed_on: string;
    filed_snapshot_id: string;
  }[];
}
export interface CloseHistory {
  lifecycle: {
    account_id: string;
    version: number;
    opened_on: string;
    closed_on: string | null;
    closure_document_id: string | null;
  }[];
  revision: string;
  periods: PeriodImpact["periods"];
  years: {
    year: number;
    classification: string;
    filed_on: string | null;
    filed_snapshot_id: string | null;
  }[];
  closes: {
    proof?: { kind?: string; history_check_id?: string };
    id: string;
    month_start: string;
    snapshot_id: string;
    created_at: string;
    reopen: { reason: string; created_at: string } | null;
  }[];
  restatements: {
    id: string;
    fiscal_year: number;
    from_date: string;
    to_date: string;
    reason: string;
    status: "open" | "completed";
    original_snapshot_id: string;
    replacement_snapshot_id: string | null;
    affected_periods: string[];
    return_review_explanation: string;
  }[];
}
