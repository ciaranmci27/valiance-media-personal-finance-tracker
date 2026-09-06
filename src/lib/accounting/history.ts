import { z } from "zod";
import { dateSchema } from "./contracts";
import { readCents } from "./money";
const id = z.uuid(),
  revision = z.string().regex(/^\d{1,19}$/),
  reason = z.string().trim().min(1).max(3000);
const cents = z.string().refine((v) => {
  try {
    readCents(v);
    return true;
  } catch {
    return false;
  }
}, "Enter an exact amount in cents.");
const monthly = z
  .array(
    z
      .object({
        from: dateSchema,
        to: dateSchema,
        income_cents: cents,
        expense_cents: cents,
        net_income_cents: cents,
      })
      .strict(),
  )
  .max(12);
const accounts = z
  .array(z.object({ account_id: id, amount_cents: cents }).strict())
  .max(1000);
const totals = z
  .object({
    assets_cents: cents,
    liabilities_cents: cents,
    equity_total_cents: cents,
  })
  .strict();
const controls = {
  from: dateSchema,
  to: dateSchema,
  monthly,
  accounts,
  totals,
};
export const historyPreviewSchema = z
  .object(controls)
  .strict()
  .refine(
    (v) => v.from <= v.to && v.from.slice(0, 4) === v.to.slice(0, 4),
    "Compare one calendar-year scope at a time.",
  );
export const historyCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("history.verify"),
      id,
      expected_revision: revision,
      ...controls,
      document_id: id,
      cash_basis_confirmed: z.literal(true),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("history.disposition"),
      id,
      expected_revision: revision,
      group_id: id,
      kind: z.enum(["annual_closing", "unsupported"]),
      document_id: id,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("history.lock"),
      id,
      expected_revision: revision,
      history_id: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("import.resume"),
      id,
      expected_version: z.number().int().min(1).max(2147483646),
    })
    .strict(),
]);
export type HistoryControls = z.infer<typeof historyPreviewSchema>;
export interface HistoryPreview {
  scope_ended: boolean;
  entity_verified: boolean;
  from: string;
  to: string;
  partial_year: boolean;
  revision: string;
  ready: boolean;
  differences: number;
  source_errors: number;
  drafts: number;
  unclassified_accounts: number;
  required_accounts: number;
  monthly: {
    from: string;
    to: string;
    actual: {
      income_cents: string;
      expense_cents: string;
      net_income_cents: string;
    };
    source: HistoryControls["monthly"][number] | null;
  }[];
  accounts: {
    account_id: string;
    code: string;
    name: string;
    account_type: string;
    actual_cents: string;
    source_cents: string | null;
    required: boolean;
  }[];
  reports: {
    assets_cents: string;
    liabilities_cents: string;
    equity_cents: string;
    retained_cents: string;
    year_income_cents: string;
  };
}
export interface HistoryView {
  revision: string;
  years: { year: number; classification: string }[];
  checks: {
    eligible_months: number;
    locked_months: string[];
    id: string;
    from_date: string;
    to_date: string;
    source_document_id: string;
    revision: string;
    explanation: string;
    created_at: string;
    invalidated: boolean;
    controls: {
      monthly: HistoryControls["monthly"];
      totals: HistoryControls["totals"];
      proof: HistoryPreview;
    };
    account_controls: HistoryControls["accounts"];
  }[];
  excluded: {
    id: string;
    entry_date: string;
    memo: string;
    reason: string;
    batch_id: string;
    disposition: { id: string; kind: string; reason: string } | null;
  }[];
}
