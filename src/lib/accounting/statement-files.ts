import { z } from "zod";
import { dateSchema } from "./contracts";
import { readCents } from "./money";
import { csvOptionsSchema, bankMappingSchema } from "./imports/contracts";
const cents = z.string().refine((v) => {
  try {
    readCents(v);
    return true;
  } catch {
    return false;
  }
}, "Use exact integer cents.");
const base = {
  id: z.uuid(),
  expected_version: z.number().int().positive(),
  document_id: z.uuid(),
};
export const statementCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("statement.import"),
      file_hash: z.string().regex(/^[a-f0-9]{64}$/),
      mapping_hash: z.string().regex(/^[a-f0-9]{64}$/),
      mapping: z
        .object({ options: csvOptionsSchema, columns: bankMappingSchema })
        .strict(),
      restore_removed: z.boolean().default(false),
      items: z
        .array(
          z
            .object({
              external_id: z.string().min(1).max(500),
              fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
              source_row: z.number().int().positive(),
              entry_date: dateSchema,
              description: z.string().min(1).max(1000),
              amount_cents: cents.pipe(
                z.string().refine((v) => BigInt(v) !== BigInt(0)),
              ),
              raw: z.record(z.string(), z.string()),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("statement.amend"),
      from: dateSchema,
      to: dateSchema,
      opening_cents: cents,
      ending_cents: cents,
      declared_count: z.number().int().min(0).max(50000),
      declared_debits_cents: cents.pipe(
        z.string().refine((v) => BigInt(v) >= BigInt(0)),
      ),
      declared_credits_cents: cents.pipe(
        z.string().refine((v) => BigInt(v) >= BigInt(0)),
      ),
      predecessor_id: z.uuid().nullable(),
      notes: z.string().max(3000),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export interface StatementSources {
  files: {
    id: string;
    document_id: string;
    original_name: string;
    rows: number;
    created_at: string;
  }[];
  amendments: {
    id: string;
    reason: string;
    created_at: string;
    previous_document_id: string;
    next_document_id: string;
    before_value: Record<string, string | number | null>;
    after_value: Record<string, string | number | null>;
  }[];
}
