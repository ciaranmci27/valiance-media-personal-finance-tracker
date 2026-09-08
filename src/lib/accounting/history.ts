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
const oneYear = (v: { from: string; to: string }) =>
  v.from <= v.to && v.from.slice(0, 4) === v.to.slice(0, 4);
const kind = z.enum(["opening_balances", "annual_totals"]);
/** Totals a source profit and loss or balance sheet states for one year. */
const expectedTotals = z
  .object({
    income_cents: cents.optional(),
    expense_cents: cents.optional(),
    net_income_cents: cents.optional(),
    cost_of_goods_sold_cents: cents.optional(),
    gross_profit_cents: cents.optional(),
    operating_expense_cents: cents.optional(),
    assets_cents: cents.optional(),
    liabilities_cents: cents.optional(),
    equity_total_cents: cents.optional(),
  })
  .strict();
export const historyPreviewSchema = z
  .object(controls)
  .strict()
  .refine(oneYear, "Compare one calendar-year scope at a time.");
/** Report-level comparison: the books against a source report's stated totals. */
export const historyTotalsSchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    kind,
    expected: expectedTotals.refine(
      (v) => Object.keys(v).length > 0,
      "Load at least one source report.",
    ),
  })
  .strict()
  .refine(oneYear, "Compare one calendar-year scope at a time.");
export const historyCompareSchema = z.union([
  historyPreviewSchema,
  historyTotalsSchema,
]);
export const historyCommandSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("history.lock"),id,expected_revision:revision,history_id:id,reason:reason.optional()}).strict(),
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
  
  
  z.object({
    type:z.literal('history.check'),id,expected_revision:revision.optional(),fiscal_year:z.number().int().min(1900).max(2100),kind:z.enum(['opening_balances','annual_totals']),
    from:dateSchema,to:dateSchema,document_id:id,reason,explanation:z.string().trim().max(3000).optional(),
    report_kind:z.enum(['profit_loss','balance_sheet']).optional(),basis:z.literal('cash').optional(),source_report_type:z.string().max(100).optional(),
    expected:expectedTotals.extend({monthly:monthly.optional(),accounts:accounts.optional(),totals:totals.optional()}).strict().refine(v=>Object.keys(v).length>0),
  }).strict(),
]);
export type HistoryControls = z.infer<typeof historyPreviewSchema>;
export type HistoryTotals = z.infer<typeof historyTotalsSchema>;
export type HistoryTotalKey = keyof HistoryTotals["expected"];
/** Result of a report-level comparison. Amounts are cents as strings. */
export interface HistoryTotalsPreview {
  from: string;
  to: string;
  revision: string;
  ready: boolean;
  partial_year: boolean;
  scope_ended: boolean;
  differences: number;
  source_errors: number;
  drafts: number;
  /** The books' figures for every key the source report stated. */
  actual: Record<string, string>;
  /** Books minus source, per stated key. */
  difference: Record<string, string>;
}
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
    id: string;
    fiscal_year: number;
    kind: "opening_balances" | "annual_totals";
    status: "matches" | "explained" | "mismatch";
    /** Source controls as recorded, plus the compared from and to dates. */
    expected: Record<string, unknown>;
    /** The books' figures at the time of the check. */
    actual: Record<string, unknown>;
    /** Books minus source per stated key, or a legacy difference count. */
    difference: Record<string, unknown>;
    explanation: string;
    checked_at: string;
    from_date: string;
    to_date: string;
    source_document_id: string;
    created_at: string;
    /** True once a later posting or a mismatch made this check stale. */
    invalidated: boolean;
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
