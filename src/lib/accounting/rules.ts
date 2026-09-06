import { z } from "zod";
import { readCents } from "./money";
const cents = z.string().refine((v) => {
  try {
    return readCents(v) >= BigInt(0);
  } catch {
    return false;
  }
}, "Enter nonnegative integer cents.");
const base = { id: z.uuid(), expected_version: z.number().int().min(0) },
  reason = z.string().trim().min(1).max(1000);
export const ruleDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    priority: z.number().int().min(1).max(10000),
    description_mode: z.enum(["exact", "prefix", "contains"]),
    description: z.string().trim().min(1).max(250),
    bank_account_id: z.uuid(),
    direction: z.enum(["increase", "decrease"]),
    min_cents: cents,
    max_cents: cents.pipe(z.string().refine((v) => BigInt(v) > BigInt(0))),
    match_payee_id: z.uuid().nullable(),
    category_account_id: z.uuid(),
    assign_payee_id: z.uuid().nullable(),
  })
  .strict();
export const rulesCommandSchema = z.discriminatedUnion("type", [
  ruleDefinitionSchema
    .extend({ ...base, type: z.literal("rule.save"), reason })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("rule.activate"),
      expected_revision: z.string().regex(/^\d{1,19}$/),
      reviewed: z.literal(true),
      enabled: z.boolean(),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("rule.apply"),
      id: z.uuid(),
      expected_revision: z.string().regex(/^\d{1,19}$/),
      entries: z
        .array(
          z
            .object({
              id: z.uuid(),
              expected_version: z.number().int().positive(),
              rule_id: z.uuid(),
              rule_version: z.number().int().positive(),
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
      type: z.literal("alias.save"),
      party_id: z.uuid(),
      match_mode: z.enum(["exact", "prefix"]),
      description: z.string().trim().min(1).max(250),
      enabled: z.boolean(),
    })
    .strict(),
]);
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export interface AccountingRule extends RuleDefinition {
  id: string;
  version: number;
  enabled: boolean;
  reason: string;
  history?: (RuleDefinition & {
    version: number;
    enabled: boolean;
    reason: string;
    created_at: string;
  })[];
}
export interface PayeeAlias {
  id: string;
  version: number;
  party_id: string;
  party_name: string;
  match_mode: "exact" | "prefix";
  description: string;
  enabled: boolean;
}
export interface RulesView {
  revision: string;
  rules: AccountingRule[];
  aliases: PayeeAlias[];
}
export interface RuleCandidate {
  id: string;
  version: number;
  entry_date: string;
  memo: string;
  status: string;
  bank_account_id: string;
  bank_amount_cents: string;
  category_account_id: string;
  payee_id: string | null;
  aliases: {
    conflict: boolean;
    aliases: { id: string; name: string; description: string }[];
  };
  matches: (AccountingRule & { rule_id: string; category_name: string })[];
  winner: (AccountingRule & { rule_id: string; category_name: string }) | null;
  eligible: boolean;
  reason: string;
  lines: { account_id: string; amount_cents: string; memo: string }[];
}
export interface RulesPreview {
  revision: string;
  rows: RuleCandidate[];
  total: number;
  from: string;
  to: string;
}
