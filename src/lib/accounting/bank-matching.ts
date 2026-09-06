import { z } from "zod";
import { readCents } from "./money";
import type { JournalEntry } from "./contracts";
const base = {
  id: z.uuid(),
  expected_revision: z.string().regex(/^\d{1,19}$/),
  reason: z.string().trim().min(1).max(1000),
};
const positive = z.string().refine((v) => {
  try {
    return readCents(v) > BigInt(0);
  } catch {
    return false;
  }
}, "Enter a positive exact-cent allocation.");
export const bankCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("bank.match"),
      group_id: z.uuid(),
      allocations: z
        .array(z.object({ line_id: z.uuid(), amount_cents: positive }).strict())
        .max(50),
      discard_drafts: z
        .array(
          z
            .object({
              id: z.uuid(),
              expected_version: z.number().int().positive(),
            })
            .strict(),
        )
        .max(50)
        .default([]),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("bank.release"), match_id: z.uuid() })
    .strict(),
]);
export interface BankReview {
  source_conflict: boolean;
  revision: string;
  remaining_cents: string;
  total: number;
  group: {
    id: string;
    entry_date: string;
    memo: string;
    bank_amount_cents: string;
    account_name: string;
    source_system: string;
    source_scope: string;
    status: string;
  };
  drafts: (Omit<JournalEntry, "lines"> & {
    lines: (JournalEntry["lines"][number] & { account_name: string })[];
  })[];
  candidates: {
    line_id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    amount_cents: string;
    available_cents: string;
    days_apart: number;
  }[];
  matches: {
    id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    amount_cents: string;
    release: { reason: string; created_at: string } | null;
  }[];
}
