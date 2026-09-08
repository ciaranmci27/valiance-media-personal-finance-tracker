import { z } from "zod";
import { dateSchema } from "./contracts";

const dimension = z.union([z.uuid(), z.literal("unassigned")]).optional();
export const reportFilterSchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    mode: z.enum(["posted", "working"]).default("posted"),
    compare_from: dateSchema.optional(),
    compare_to: dateSchema.optional(),
    payee: dimension,
    account_ids: z.array(z.uuid()).min(1).max(500).optional(),
    account_types: z
      .array(z.enum(["asset", "liability", "equity", "income", "expense"]))
      .min(1)
      .max(5)
      .optional(),
    cash_class: z
      .enum([
        "operating",
        "investing",
        "financing",
        "internal_transfer",
        "unclassified",
      ])
      .optional(),
    offset: z.number().int().min(0).max(10000000).default(0),
  })
  .strict()
  .refine(
    (v) =>
      v.from <= v.to &&
      Boolean(v.compare_from) === Boolean(v.compare_to) &&
      (!v.compare_from || v.compare_from <= v.compare_to!),
    "Choose valid current and comparison dates.",
  );
export type ReportFilter = z.infer<typeof reportFilterSchema>;
export type CashClass =
  | "operating"
  | "investing"
  | "financing"
  | "internal_transfer"
  | "unclassified";
export interface ReportAccount {
  id: string;
  name: string;
  code: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  normal_side: "debit" | "credit";
  is_archived: boolean;
  parent_account_id: string | null;
  parent_name: string | null;
  subtype: string;
  purpose: string | null;
  cash_kind: string;
  opening_cents: string;
  debit_cents: string;
  credit_cents: string;
  period_cents: string;
  ending_cents: string;
  prior_cents: string;
  year_cents: string;
  compare_period_cents: string;
  compare_ending_cents: string;
  compare_prior_cents: string;
  compare_year_cents: string;
}
export interface ReportTotals {
  income_cents: string;
  cogs_cents: string;
  expense_cents: string;
  net_cents: string;
  assets_cents: string;
  liabilities_cents: string;
  equity_cents: string;
  prior_cents: string;
  year_cents: string;
  difference_cents: string;
  cash_opening_cents: string;
  cash_ending_cents: string;
}
export interface ReportData {
  legal_name: string;
  revision: string;
  definition_version: number;
  currency: "USD";
  basis: string;
  generated_at: string;
  filter: ReportFilter;
  accounts: ReportAccount[];
  totals: ReportTotals;
  comparison: ReportTotals;
  monthly: {
    month: string;
    income_cents: string;
    expense_cents: string;
    net_cents: string;
  }[];
  dimensions: {
    kind: "payee";
    id: string;
    name: string;
    income_cents: string;
    expense_cents: string;
    compare_income_cents: string;
    compare_expense_cents: string;
  }[];
  cash: {
    classification: CashClass;
    amount_cents: string;
    line_count: number;
  }[];
  quality: {
    draft_count: number;
    unbalanced_drafts: number;
    incomplete_imports: number;
    unclassified_cash_lines: number;
    uncategorized_lines: number;
    reconciliations: { account_id: string; through: string }[];
    feeds: { name: string; last_success_at: string | null; status: string }[];
  };
}
export interface ReportDetail {
  revision: string;
  total: number;
  total_cents: string;
  opening_cents: string;
  rows: {
    id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    line_memo: string;
    account_id: string;
    account_name: string;
    account_type: string;
    amount_cents: string;
    running_cents: string;
    status: string;
    primary_origin: string;
    classification?: string;
    allocation_source?: string;
    allocation_index?: number;
  }[];
}
export const cashAllocationCommand = z
  .object({
    type: z.literal("cash.allocate"),
    id: z.uuid(),
    expected_version: z.number().int().min(0),
    reason: z.string().trim().min(1).max(1000),
    allocations: z
      .array(
        z
          .object({
            classification: z.enum([
              "operating",
              "investing",
              "financing",
              "internal_transfer",
            ]),
            amount_cents: z.string().regex(/^-?[1-9]\d{0,18}$/),
            note: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const reportOptionsSchema = z
  .object({
    report_id: z.enum([
      "profit-loss",
      "balance-sheet",
      "cash-flow",
      "customer-income",
      "vendor-expenses",
      "trial-balance",
      "general-ledger",
      "owner-activity",
    ]),
    show_zero: z.boolean(),
    details: z.boolean(),
  })
  .strict();
export const reportCaptureCommand = z
  .object({
    type: z.literal("report.capture"),
    id: z.uuid(),
    expected_revision: z.string().regex(/^\d{1,18}$/),
    filter: reportFilterSchema.refine(
      (f) => !f.account_ids && !f.account_types && !f.cash_class,
    ),
    options: reportOptionsSchema,
  })
  .strict();
export interface DetailedReportSnapshot {
  id: string;
  revision: string;
  created_at: string;
  payload: {
    type: "detailed_report";
    data: ReportData;
    options: z.infer<typeof reportOptionsSchema>;
    export_definition: 1;
    ledger?: ReportDetail["rows"];
  };
}
