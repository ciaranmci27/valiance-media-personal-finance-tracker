import { z } from "zod";
import { dateSchema } from "../contracts";
import type { ImportBatch, ImportGroup } from "./contracts";

export const importComparisonFilterSchema = z
  .object({
    earlier: z.uuid(),
    later: z.uuid(),
    from: dateSchema,
    to: dateSchema,
    change: z
      .enum([
        "differences",
        "all",
        "changed",
        "new",
        "missing",
        "source_only",
        "unchanged",
      ])
      .default("differences"),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .refine((v) => v.earlier !== v.later && v.from <= v.to);
export type ImportComparisonFilter = z.infer<
  typeof importComparisonFilterSchema
>;
export const comparisonLabels = {
  changed: "Changed",
  new: "New in later file",
  missing: "Absent from later file",
  source_only: "Source details only",
  unchanged: "Unchanged",
};
export type ComparisonGroup = ImportGroup & {
  bank_account_id: string | null;
  source_hash: string;
  external_id: string;
  identity_kind: string;
  raw_payload: Record<string, unknown>[] | Record<string, unknown>;
};
export interface ComparisonRow {
  key: string;
  external_id: string;
  identity_kind: string;
  change: keyof typeof comparisonLabels;
  earlier: ComparisonGroup | null;
  later: ComparisonGroup | null;
}
export interface ImportComparison {
  earlier: ImportBatch;
  later: ImportBatch;
  from: string;
  to: string;
  revision: string;
  mapping_changed: boolean;
  basis_changed: boolean;
  uncertain_identity_count: number;
  counts: Partial<Record<ComparisonRow["change"], number>>;
  total: number;
  filtered_total: number;
  offset: number;
  rows: ComparisonRow[];
}
