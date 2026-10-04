import { z } from "zod";
import { centsToDecimal, formatCents, parseUsd, readCents } from "./money";
const cents = z.string().refine((v) => {
  try {
    return readCents(v) >= BigInt(0);
  } catch {
    return false;
  }
}, "Enter nonnegative integer cents.");
const base = { id: z.guid(), expected_version: z.number().int().min(0) },
  reason = z.string().trim().min(1).max(1000);
export const ruleDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    priority: z.number().int().min(1).max(10000),
    description_mode: z.enum(["exact", "prefix", "contains"]),
    description: z.string().trim().min(1).max(250),
    // Null leaves the condition out: any account, either direction, no bound.
    bank_account_id: z.guid().nullable(),
    direction: z.enum(["increase", "decrease"]).nullable(),
    min_cents: cents.nullable(),
    max_cents: cents
      .pipe(z.string().refine((v) => BigInt(v) > BigInt(0)))
      .nullable(),
    match_payee_id: z.guid().nullable(),
    category_account_id: z.guid(),
    assign_payee_id: z.guid().nullable(),
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
  z.object({ ...base, type: z.literal("rule.dismiss"), reason }).strict(),
  z
    .object({
      type: z.enum(["rule.apply", "rule.apply_preview"]),
      id: z.guid(),
      expected_revision: z.string().regex(/^\d{1,19}$/),
      entries: z
        .array(
          z
            .object({
              id: z.guid(),
              expected_version: z.number().int().positive(),
              rule_id: z.guid(),
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
      party_id: z.guid(),
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
        bank_account_id: z.guid().optional(),
        direction: z.enum(["increase", "decrease", "in", "out"]).optional(),
        amount_min: cents.optional(),
        amount_max: cents.optional(),
        payee_id: z.guid().optional(),
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
          account_id: z.guid(),
          payee_id: z.guid().optional(),
          memo: z.string().max(2000).optional(),
        })
        .strict(),
      z
        .object({
          splits: z
            .array(
              z
                .object({
                  account_id: z.guid(),
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
          payee_id: z.guid().optional(),
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
      party_id: z.guid(),
      match_kind: z.enum(["key", "exact", "prefix"]),
      pattern: z.string().trim().min(1).max(250),
      enabled: z.boolean(),
    })
    .strict(),
]);
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
/** Why a rule is off: an edit switched it off, the owner paused it, or it was never switched on. */
export interface RulePause {
  cause: "edited" | "paused" | "never_on" | "other";
  at: string;
}
/** What a suggested rule would do in the books today (accounting.rule_evidence). */
export interface RuleSuggestion {
  /** Live transactions it matches. */
  matches: number;
  /** Of those, reviewed (posted). */
  posted: number;
  /** Of those, already in the rule's category. */
  in_category: number;
  /** Uncategorized drafts it would fill now. */
  ready: number;
  /** The agent's own reason, when it gave one. */
  note: string | null;
}
export interface AccountingRule extends RuleDefinition {
  id: string;
  version: number;
  enabled: boolean;
  reason: string;
  /** 'suggested' while an agent's rule waits for the owner; absent on rules read before the review state. */
  review_status?: "suggested" | "confirmed";
  suggested_by?: string | null;
  suggested_by_name?: string | null;
  paused?: RulePause | null;
  suggestion?: RuleSuggestion | null;
  /** The stored condition and action objects, as the books hold them. */
  conditions?: Record<string, unknown>;
  actions?: Record<string, unknown>;
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

/** The books read a rule with no upper bound as the largest bigint. */
export const RULE_NO_MAXIMUM = "9223372036854775807";

/** A rule's amount bounds, with null for no bound: a zero minimum and the bigint ceiling are not limits. */
export function ruleAmountBounds(
  min: string | null | undefined,
  max: string | null | undefined,
): { min: string | null; max: string | null } {
  return {
    min: min && BigInt(min) > BigInt(0) ? min : null,
    max: max && max !== RULE_NO_MAXIMUM ? max : null,
  };
}

/** Money for a rule bound: whole dollars drop the cents ("$500", "$12.50"). */
export function ruleMoney(cents: string): string {
  const text = formatCents(cents);
  return text.endsWith(".00") ? text.slice(0, -3) : text;
}

/** "any amount", "$500 or more", "up to $2,000" or "$500 to $2,000". */
export function ruleAmountLabel(
  min: string | null | undefined,
  max: string | null | undefined,
): string {
  const b = ruleAmountBounds(min, max);
  if (b.min && b.max) return `${ruleMoney(b.min)} to ${ruleMoney(b.max)}`;
  if (b.min) return `${ruleMoney(b.min)} or more`;
  if (b.max) return `up to ${ruleMoney(b.max)}`;
  return "any amount";
}

/** The plural and singular words for what a rule moves: deposits, payments or transactions. */
export function ruleNoun(direction: string | null | undefined) {
  return direction === "increase" || direction === "in"
    ? { one: "deposit", many: "deposits" }
    : direction === "decrease" || direction === "out"
      ? { one: "payment", many: "payments" }
      : { one: "transaction", many: "transactions" };
}

/**
 * What a rule does from now on, in one plain sentence: "New deposits from
 * Premier Estate Planning into Checking will be filed as Agency Income."
 * `contact` is the contact the rule assigns, when it names one; otherwise
 * the bank description it matches stands in. `category` is null for a rule
 * that splits across categories.
 */
export function ruleOutcomeSentence(
  rule: Pick<
    AccountingRule,
    "direction" | "description_mode" | "description" | "min_cents" | "max_cents"
  >,
  names: {
    category: string | null;
    bank: string | null;
    contact: string | null;
  },
): string {
  const direction = rule.direction as string | null;
  const inward = direction === "increase" || direction === "in";
  const outward = direction === "decrease" || direction === "out";
  const mode = rule.description_mode as string;
  const text = `"${rule.description}"`;
  const who = names.contact
    ? `${outward ? "to" : "from"} ${names.contact}`
    : mode === "prefix"
      ? `starting with ${text}`
      : mode === "exact" || mode === "equals"
        ? `described as ${text}`
        : `matching ${text}`;
  const where = names.bank
    ? ` ${inward ? "into" : outward ? "from" : "on"} ${names.bank}`
    : "";
  const amount = ruleAmountLabel(rule.min_cents, rule.max_cents);
  const size = amount === "any amount" ? "" : ` of ${amount}`;
  const what = `New ${ruleNoun(direction).many} ${who}${where}${size}`;
  return names.category === null
    ? `${what} will be split across categories.`
    : `${what} will be filed as ${names.category}.`;
}

/** How a suggestion's past matches line up with it: "It matches 3 past deposits, all already filed as Agency Income." */
export function ruleEvidenceLine(
  rule: Pick<AccountingRule, "direction"> & {
    suggestion?: RuleSuggestion | null;
  },
  category: string | null,
): string {
  const noun = ruleNoun(rule.direction as string | null);
  const n = rule.suggestion?.matches ?? 0,
    k = rule.suggestion?.in_category ?? 0;
  if (!n) return `No past ${noun.many} match it yet.`;
  const matches = `It matches ${n} past ${n === 1 ? noun.one : noun.many}`;
  if (category === null) return `${matches}.`;
  if (k >= n)
    return n === 1
      ? `${matches}, already filed as ${category}.`
      : `${matches}, all already filed as ${category}.`;
  if (k > 0) return `${matches}; ${k} already filed as ${category}.`;
  return `${matches}; none filed as ${category} yet.`;
}

/** What the rule editor shows and edits. Blank strings mean "any" or "no bound". */
export interface RuleForm {
  name: string;
  priority: number;
  description_mode: "exact" | "prefix" | "contains";
  description: string;
  bank_account_id: string;
  direction: "" | "increase" | "decrease";
  min: string;
  max: string;
  match_payee_id: string;
  category_account_id: string;
  assign_payee_id: string;
}

/**
 * A rule that matches on the cleaned bank description (descriptor_key), as
 * agents write them. The editor's own form matches on the raw description,
 * so such a rule is kept in its stored form unless the owner changes it.
 */
export function ruleMatchesCleaned(rule: Pick<AccountingRule, "conditions">) {
  const c = rule.conditions;
  return !!c && "descriptor_key" in c && !("description" in c);
}

/** The editor's starting values for a rule. */
export function ruleForm(rule: AccountingRule): RuleForm {
  const bounds = ruleAmountBounds(rule.min_cents, rule.max_cents);
  const mode = rule.description_mode as string;
  const direction = rule.direction as string | null;
  return {
    name: rule.name,
    priority: rule.priority,
    description_mode:
      mode === "equals" ? "exact" : (mode as RuleForm["description_mode"]),
    description: rule.description,
    bank_account_id: rule.bank_account_id ?? "",
    direction:
      direction === "in" || direction === "increase"
        ? "increase"
        : direction === "out" || direction === "decrease"
          ? "decrease"
          : "",
    min: bounds.min ? centsToDecimal(bounds.min) : "",
    max: bounds.max ? centsToDecimal(bounds.max) : "",
    match_payee_id: rule.match_payee_id ?? "",
    category_account_id: rule.category_account_id ?? "",
    assign_payee_id: rule.assign_payee_id ?? "",
  };
}

/**
 * The rule.save command for an edit. A field the owner left as it was keeps
 * its stored value exactly, so saving never changes what a rule matches by
 * itself: a rule on the cleaned description is saved in its stored form with
 * only the changed keys replaced, and untouched amount bounds keep their
 * stored cents.
 */
export function ruleSaveCommand(
  rule: AccountingRule,
  initial: RuleForm,
  form: RuleForm,
  reason: string,
) {
  const same = (key: keyof RuleForm) => form[key] === initial[key];
  const cents = (value: string) =>
    value.trim() ? parseUsd(value).toString() : null;
  const minimum = cents(form.min),
    maximum = cents(form.max);
  if (
    (minimum !== null && BigInt(minimum) < BigInt(0)) ||
    (maximum !== null && BigInt(maximum) <= BigInt(0)) ||
    (minimum !== null && maximum !== null && BigInt(minimum) > BigInt(maximum))
  )
    throw new Error(
      "Enter amounts above zero, with the minimum no higher than the maximum.",
    );
  const stored = rule.conditions;
  if (rule.version > 0 && ruleMatchesCleaned(rule)) {
    const conditions: Record<string, unknown> = { ...stored };
    const put = (key: string, value: string | null) => {
      if (value === null || value === "") delete conditions[key];
      else conditions[key] = value;
    };
    if (!same("description_mode") || !same("description"))
      conditions.descriptor_key = {
        [form.description_mode === "exact" ? "equals" : form.description_mode]:
          form.description.trim(),
      };
    if (!same("bank_account_id")) put("bank_account_id", form.bank_account_id);
    if (!same("direction")) put("direction", form.direction);
    if (!same("min")) put("amount_min", minimum);
    if (!same("max")) put("amount_max", maximum);
    if (!same("match_payee_id")) put("payee_id", form.match_payee_id);
    const actions: Record<string, unknown> = { ...(rule.actions ?? {}) };
    if (!same("category_account_id")) {
      delete actions.splits;
      actions.account_id = form.category_account_id;
    }
    if (!same("assign_payee_id")) {
      if (form.assign_payee_id) actions.payee_id = form.assign_payee_id;
      else delete actions.payee_id;
    }
    return {
      type: "rule.save" as const,
      id: rule.id,
      expected_version: rule.version,
      reason,
      name: form.name,
      priority: form.priority,
      conditions,
      actions,
    };
  }
  // The editor's own form. Untouched bounds keep the cents they were stored with.
  const storedCents = (
    key: "amount_min" | "amount_max",
    fallback: string | null,
  ) => (stored ? ((stored[key] as string | undefined) ?? null) : fallback);
  return {
    type: "rule.save" as const,
    id: rule.id,
    expected_version: rule.version,
    name: form.name,
    priority: form.priority,
    description_mode: form.description_mode,
    description: form.description,
    bank_account_id: form.bank_account_id || null,
    direction: form.direction || null,
    min_cents: same("min")
      ? storedCents("amount_min", rule.min_cents)
      : minimum,
    max_cents: same("max")
      ? storedCents("amount_max", rule.max_cents)
      : maximum,
    match_payee_id: form.match_payee_id || null,
    category_account_id: form.category_account_id,
    assign_payee_id: form.assign_payee_id || null,
    reason,
  };
}

/** A past transaction a rule matches, as the rules preview reads it. */
export type RuleEvidenceRow = Pick<
  RuleCandidate,
  | "id"
  | "entry_date"
  | "status"
  | "bank_account_id"
  | "bank_amount_cents"
  | "lines"
>;
