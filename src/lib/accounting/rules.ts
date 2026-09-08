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
const legacyRulesCommandSchema = z.discriminatedUnion("type", [
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
      type: z.enum(["rule.apply", "rule.apply_preview"]),
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
const canonicalRuleSchema = z
  .object({
    ...base,
    type: z.literal("rule.save"),
    reason,
    name: z.string().trim().min(1).max(120),
    priority: z.number().int().min(1).max(10000),
    enabled: z.boolean().default(false),
    auto_post: z.boolean().default(false),
    conditions: z
      .object({
        descriptor_key: z.union([
          z.object({ equals: z.string().trim().min(1).max(250) }).strict(),
          z.object({ prefix: z.string().trim().min(1).max(250) }).strict(),
          z.object({ contains: z.string().trim().min(1).max(250) }).strict(),
        ]),
        bank_account_id: z.uuid().optional(),
        direction: z.enum(["increase", "decrease", "in", "out"]).optional(),
        amount_min: cents.optional(),
        amount_max: cents.optional(),
        payee_id: z.uuid().optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.amount_min === undefined ||
          v.amount_max === undefined ||
          BigInt(v.amount_min) <= BigInt(v.amount_max),
        "Minimum must not exceed maximum.",
      ),
    actions: z.union([
      z
        .object({
          account_id: z.uuid(),
          payee_id: z.uuid().optional(),
          memo: z.string().max(2000).optional(),
        })
        .strict(),
      z
        .object({
          splits: z
            .array(
              z
                .object({
                  account_id: z.uuid(),
                  share_bps: z.number().int().min(1).max(9999),
                })
                .strict(),
            )
            .min(2)
            .max(100)
            .refine(
              (v) => v.reduce((n, s) => n + s.share_bps, 0) === 10000,
              "Split percentages must total 100%.",
            ),
          payee_id: z.uuid().optional(),
          memo: z.string().max(2000).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export const rulesCommandSchema = z.union([
  legacyRulesCommandSchema,
  canonicalRuleSchema,
  z
    .object({
      ...base,
      type: z.literal("alias.save"),
      party_id: z.uuid(),
      match_kind: z.enum(["key", "exact", "prefix"]),
      pattern: z.string().trim().min(1).max(250),
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
