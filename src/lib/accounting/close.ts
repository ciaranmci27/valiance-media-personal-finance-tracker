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
const nonzero = cents.pipe(
  z.string().refine((v) => BigInt(v) !== BigInt(0), "Enter a nonzero amount."),
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
      type: z.literal("reconciliation.create"),
      id,
      account_id: id,
      from: dateSchema,
      to: dateSchema,
      opening_cents: cents,
      ending_cents: cents,
      document_id: id.nullable().optional(),
      notes: z.string().max(3000).optional(),
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
      reason: reason.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.item.remove"),
      ...base,
      item_id: id,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("reconciliation.save"),
      id,
      expected_version: z.number().int().nonnegative(),
      // bank_accounts ids are hash-derived, not RFC 4122 shaped.
      bank_account_id: z.guid(),
      statement_start: dateSchema,
      statement_end: dateSchema,
      opening_balance_cents: cents,
      ending_balance_cents: cents,
      document_id: id.nullable().optional(),
      notes: z.string().max(3000).optional(),
      items: z
        .array(
          z
            .object({
              id: id.optional(),
              journal_line_id: id,
              amount_cents: nonzero,
            })
            .strict(),
        )
        .max(50000)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("reconciliation.complete"), ...base }).strict(),

  z
    .object({ type: z.literal("reconciliation.reopen"), ...base, reason })
    .strict(),

  z
    .object({ type: z.enum(["period.close", "period.lock"]), ...period, month })
    .strict(),
  z
    .object({ type: z.literal("period.reopen"), ...period, month, reason })
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
  document_id: string | null;
  status: "in_progress" | "completed";
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
export interface CloseChecklist {
  month: string;
  month_start: string;
  through: string;
  month_ended: boolean;
  revision: string;
  ready: boolean;
  drafts: number;
  history_mismatches: number;
  banks: BankCloseBalance[];
  accounts: BankCloseBalance[];
  reports: AccountingWorkspace;
  period: {
    month: string;
    status: "open" | "locked";
    version: number;
    close_snapshot: unknown;
  } | null;
}
export interface BankCloseBalance {
  id: string;
  account_id: string;
  name: string;
  book_cents: string;
  observed_balance_cents: string | null;
  observed_at: string | null;
  difference_cents: string | null;
}
export interface PeriodImpact {
  revision: string;
  periods: { month_start: string; is_locked: boolean; reason: string }[];
  snapshots: { id: string; kind: string; created_at: string }[];
}
export interface CloseHistory {
  periods: PeriodImpact["periods"];
  reconciliations: Statement[];
}
