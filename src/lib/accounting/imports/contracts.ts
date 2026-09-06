import { z } from "zod";
import { dateSchema } from "../contracts";
import { readCents } from "../money";
const id = z.uuid(),
  version = z.number().int().min(1),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const cents = z.string().refine((s) => {
  try {
    return readCents(s) !== BigInt(0);
  } catch {
    return false;
  }
});
export const csvOptionsSchema = z
  .object({
    delimiter: z.enum([",", ";", "\t"]),
    headerRow: z.number().int().min(0).max(50),
    dateFormat: z.enum(["yyyy-mm-dd", "mm/dd/yyyy", "dd/mm/yyyy"]),
    decimal: z.enum([".", ","]),
    thousands: z.enum(["", ",", ".", " "]),
  })
  .strict();
export const journalMappingSchema = z
  .object({
    group: z.string().min(1),
    date: z.string().min(1),
    memo: z.string().min(1),
    account: z.string().min(1),
    debit: z.string().optional(),
    credit: z.string().optional(),
    amount: z.string().optional(),
    lineMemo: z.string().optional(),
    stableGroupIds: z.boolean(),
    accounts: z.record(z.string(), id),
  })
  .strict();
export const bankMappingSchema = z
  .object({
    date: z.string().min(1),
    description: z.string().min(1),
    amount: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    externalId: z.string().optional(),
    sign: z.enum(["deposits_positive", "withdrawals_positive"]),
    accountId: id,
  })
  .strict();
const group = z
  .object({
    id,
    ordinal: z.number().int().min(0),
    external_id: z.string().min(1).max(500),
    identity_kind: z.enum(["provider_id", "fingerprint_multiplicity"]),
    fingerprint: hash,
    source_hash: hash,
    entry_date: dateSchema,
    memo: z.string().min(1).max(1000),
    lines: z
      .array(
        z
          .object({
            account_id: id,
            amount_cents: cents,
            memo: z.string().max(500),
          })
          .strict(),
      )
      .max(100),
    bank_account_id: id.optional(),
    bank_amount_cents: cents.optional(),
    raw: z.array(z.record(z.string(), z.string())).min(1).max(150),
    errors: z.array(z.string()).length(0).optional(),
  })
  .strict();
export const importCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("import.create"),
      id,
      source_system: z.enum(["wave", "csv", "simplefin"]),
      source_scope: z.string().min(1).max(250),
      file_hash: hash,
      mapping_hash: hash,
      file_name: z.string().min(1).max(250),
      source_document_id: id.optional(),
      mode: z.enum(["journal", "bank"]),
      basis: z.enum(["cash", "unconfirmed"]),
      expected_groups: z.number().int().min(1).max(50000),
      from: dateSchema,
      to: dateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("import.stage"),
      id,
      expected_version: version,
      groups: z.array(group).min(1).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal("import.apply"),
      id,
      expected_version: version,
      group_ids: z.array(id).min(1).max(50),
    })
    .strict(),
  z
    .object({ type: z.literal("import.finish"), id, expected_version: version })
    .strict(),
  z
    .object({
      type: z.literal("import.cancel"),
      id,
      expected_version: version,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("import.resolve"),
      id,
      expected_version: version,
      resolution: z.enum(["new", "match", "exclude"]),
      entry_id: id.optional(),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export interface ImportBatch {
  id: string;
  version: number;
  source_system: string;
  source_scope: string;
  file_hash: string;
  mapping_hash: string;
  file_name: string;
  mode: "journal" | "bank";
  basis: string;
  status: string;
  expected_groups: number;
  from_date: string;
  to_date: string;
  coverage_verified: boolean;
  error: string;
  created_at: string;
}
export interface ImportGroup {
  id: string;
  version: number;
  ordinal: number;
  entry_date: string;
  memo: string;
  status: string;
  reason: string;
  entry_id: string | null;
  candidate_entry_id: string | null;
  bank_amount_cents: string | null;
  lines: { account_id: string; amount_cents: string; memo: string }[];
}
export interface ImportState {
  batches: ImportBatch[];
  groups: ImportGroup[];
  counts: Record<string, number>;
  total: number;
}
