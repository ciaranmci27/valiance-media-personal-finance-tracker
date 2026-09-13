import { z } from "zod";
import { dateSchema } from "./contracts";

const year = z.number().int().min(1900).max(2100);
const cents = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);
const nonnegativeCents = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const taxConcepts = {
  ordinary_income: "Ordinary business income",
  ordinary_expense: "Business expense",
  officer_wages: "Officer wages",
  meals: "Meals",
  travel: "Travel",
  nondeductible: "Nondeductible expense",
  interest: "Separately stated interest",
  qualified_dividend: "Qualified dividends",
  short_gain: "Short-term capital gain or loss",
  long_gain: "Long-term capital gain or loss",
  charity: "Charitable contributions",
  tax_exempt: "Tax-exempt income",
  excluded_book: "Other book amount excluded from ordinary income",
} as const;
export type TaxConcept = keyof typeof taxConcepts;
const concept = z.enum(
  Object.keys(taxConcepts) as [TaxConcept, ...TaxConcept[]],
);
export const taxBasisBodySchema = z
  .object({
    opening_stock_cents: nonnegativeCents.nullable(),
    opening_debt_cents: nonnegativeCents.nullable(),
    ending_stock_cents: nonnegativeCents.nullable(),
    ending_debt_cents: nonnegativeCents.nullable(),
    allowed_loss_cents: nonnegativeCents.nullable(),
    distribution_reviewed: z.boolean(),
    limitations: z.string().max(2000),
  })
  .strict();
const common = {
  id: z.uuid(),
  year,
  expected_version: z.number().int().min(0),
  document_id: z.uuid(),
  reason: z.string().trim().min(1).max(1000),
  verified: z.literal(true),
};
export const taxWorkpaperCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("tax.mapping"),
      document_id: z.uuid().nullable(),
      account_id: z.uuid(),
      concept,
      deductible_bps: z.number().int().min(0).max(10000),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("tax.adjustment"),
      adjustment_key: z.uuid(),
      effective_date: dateSchema,
      concept: z.enum([
        "ordinary_adjustment",
        "interest",
        "qualified_dividend",
        "short_gain",
        "long_gain",
        "charity",
        "tax_exempt",
      ]),
      amount_cents: cents,
      active: z.boolean(),
    })
    .strict(),
]);
export const taxScopeSchema = z
  .object({ year, through: dateSchema })
  .strict()
  .refine((v) => v.through.startsWith(`${v.year}-`));
export interface TaxWorkpaperRevision {
  id: string;
  tax_year: number;
  version: number;
  document_id: string | null;
  reason: string;
  created_at: string;
  created_by: string;
}
export interface TaxMapping extends TaxWorkpaperRevision {
  account_id: string;
  concept: TaxConcept;
  deductible_bps: number;
}
export interface TaxAdjustment extends TaxWorkpaperRevision {
  adjustment_key: string;
  effective_date: string;
  concept:
    | "ordinary_adjustment"
    | "interest"
    | "qualified_dividend"
    | "short_gain"
    | "long_gain"
    | "charity"
    | "tax_exempt";
  amount_cents: string;
  active: boolean;
  current: boolean;
}
export interface TaxSource {
  year: number;
  through: string;
  revision: string;
  fingerprint: string;
  /** How the business is taxed in this year, derived from the business profile. */
  year_settings: { classification: string } | null;
  accounts: {
    account_id: string;
    name: string;
    code: string;
    account_type: "income" | "expense";
    mapping: TaxMapping | null;
    book_cents: string;
    ordinary_cents: string;
    line_count: number;
    current: boolean;
  }[];
  adjustments: TaxAdjustment[];
  basis:
    | (TaxWorkpaperRevision & {
        through_date: string;
        source_fingerprint: string;
        body: z.infer<typeof taxBasisBodySchema>;
        current: boolean;
      })
    | null;
  monthly: {
    month: string;
    book_cents: string;
    ordinary_cents: string;
    complete: boolean;
  }[];
  separately_stated: Partial<Record<TaxAdjustment["concept"], string>>;
  book_profit_cents: string;
  mapped_ordinary_cents: string;
  adjusted_ordinary_cents: string;
  book_to_tax_cents: string;
  unmapped_accounts: number;
  drafts: number;
  incomplete_imports: number;
  unavailable_adjustments: number;
}
