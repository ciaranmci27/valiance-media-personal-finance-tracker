import { z } from "zod";
import { commandSchema, dateSchema } from "./contracts";
import { readCents } from "./money";
import { importCommandSchema } from "./imports/contracts";
import { closeCommandSchema } from "./close";
import { historyCommandSchema } from "./history";
import { transferCommandSchema } from "./transfers";
import { bankCommandSchema } from "./bank-matching";
import { retainedCommandSchema, retainedReviewSchema } from "./retained-review";
import { statementCommandSchema } from "./statement-files";
import { rulesCommandSchema } from "./rules";
import { feedCommandSchema } from "./feeds";
import type { RuleCandidate } from "./rules";

const id = z.uuid();
const version = z.number().int().min(0).max(2147483646);
const optionalId = id.nullable().optional();
const name = z.string().trim().min(1).max(120);
const memo = z.string().trim().min(1).max(1000);
const amount = z.string().refine((s) => {
  try {
    return readCents(s) !== BigInt(0);
  } catch {
    return false;
  }
}, "Enter a nonzero exact-cent amount.");
const lines = z
  .array(
    z
      .object({
        account_id: id,
        amount_cents: amount,
        memo: z.string().max(500).default(""),
      })
      .strict(),
  )
  .max(100);
const cashKind = z.enum(["none", "bank", "cash", "card"]);
const partyKind = z.enum(["vendor", "customer", "both"]);
const taxClassification = z.enum([
  "unreviewed",
  "individual",
  "corporation",
  "partnership",
  "foreign",
  "other",
]);
const documentation = z.enum([
  "missing",
  "requested",
  "received",
  "not_required",
]);
const contextFields = {
  kind: z
    .enum([
      "manual",
      "income",
      "expense",
      "transfer",
      "payroll",
      "opening",
      "owner",
      "loan",
      "asset",
      "invoice_receipt",
      "refund",
    ])
    .default("manual"),
  payee_id: optionalId,
  customer_id: optionalId,
  project_id: optionalId,
  business_line_id: optionalId,
  payment_rail: z
    .enum([
      "unknown",
      "ach",
      "check",
      "cash",
      "card",
      "third_party",
      "wire",
      "other",
    ])
    .default("unknown"),
  contractor_treatment: z
    .enum(["unreviewed", "reportable", "excluded"])
    .default("unreviewed"),
  contractor_reason: z.string().max(1000).default(""),
};
const registerFilterObject = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    account: id.optional(),
    entry_id: id.optional(),
    status: z.enum(["all", "draft", "posted", "discarded"]).default("all"),
    source: z
      .enum(["wave", "simplefin", "csv", "manual", "internal"])
      .optional(),
    query: z.string().trim().max(200).optional(),
    payee: id.optional(),
    project: id.optional(),
    business_line: id.optional(),
    missing_receipt: z.boolean().optional(),
    min_cents: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    max_cents: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const registerFilterSchema = registerFilterObject.refine(
  (v) => !v.from || !v.to || v.from <= v.to,
  "Choose a valid date range.",
);
export type RegisterFilter = z.infer<typeof registerFilterSchema>;
export const extendedCommandSchema = z.union([
  commandSchema,
  importCommandSchema,
  closeCommandSchema,
  historyCommandSchema,
  transferCommandSchema,
  bankCommandSchema,
  retainedCommandSchema,
  statementCommandSchema,
  rulesCommandSchema,
  feedCommandSchema,
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("document.link"),
        id,
        expected_version: version,
        entry_id: id,
      })
      .strict(),
    z
      .object({
        type: z.literal("document.archive"),
        id,
        expected_version: version,
        reason: memo,
      })
      .strict(),
    z
      .object({
        type: z.literal("entry.bulkpost"),
        id,
        entries: z
          .array(z.object({ id, expected_version: version }).strict())
          .min(1)
          .max(50),
      })
      .strict(),
    z
      .object({
        type: z.literal("transaction.save"),
        id,
        expected_version: version,
        entry_date: dateSchema,
        memo,
        lines,
        context: z.object(contextFields).strict().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("dimension.save"),
        id,
        expected_version: version,
        name,
        kind: z.enum(["project", "business_line"]),
        customer_id: optionalId,
        is_archived: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        type: z.literal("preferences.save"),
        id,
        expected_version: version,
        legal_name: z.string().trim().min(1).max(200),
        authority_mode: z.enum(["wave_primary", "parallel_pilot"]),
        history_start: dateSchema.nullable(),
        transfer_window_days: z.number().int().min(0).max(30),
        transit_alert_days: z.number().int().min(1).max(365),
      })
      .strict(),
    z
      .object({
        type: z.literal("account.update"),
        id,
        expected_version: version,
        name,
        code: z.string().trim().max(20),
        purpose: z.string().max(80).nullable().optional(),
        cash_kind: cashKind,
        parent_account_id: optionalId,
        subtype: z.string().max(100).default(""),
        is_archived: z.boolean(),
      })
      .strict(),
    z
      .object({
        type: z.literal("chart.seed"),
        id,
        accounts: z
          .array(
            z
              .object({
                id,
                name,
                code: z.string().max(20),
                account_type: z.enum([
                  "asset",
                  "liability",
                  "equity",
                  "income",
                  "expense",
                ]),
                normal_side: z.enum(["debit", "credit"]),
                purpose: z.string().max(80).optional(),
                cash_kind: cashKind.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    z
      .object({
        type: z.literal("entry.context"),
        id,
        expected_version: version,
        ...contextFields,
      })
      .strict(),
    z
      .object({
        type: z.literal("entry.correct"),
        retained_review: retainedReviewSchema.optional(),
        reversal_date: dateSchema,
        id,
        expected_version: version,
        replacement_id: id,
        entry_date: dateSchema,
        reason: memo,
        memo,
        lines: lines.min(2),
      })
      .strict(),
    z
      .object({
        type: z.literal("entry.annotate"),
        id,
        entry_id: id,
        note: z.string().trim().min(1).max(3000),
      })
      .strict(),
    z
      .object({
        type: z.literal("party.save"),
        id,
        expected_version: version,
        name,
        kind: partyKind,
        default_account_id: optionalId,
        tax_classification: taxClassification.default("unreviewed"),
        documentation: documentation.default("missing"),
        notes: z.string().max(3000).default(""),
        is_archived: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        type: z.literal("template.save"),
        id,
        expected_version: version,
        name,
        memo,
        lines: lines.min(2),
        is_archived: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        type: z.literal("view.save"),
        id,
        expected_version: version,
        name,
        filters: registerFilterObject
          .omit({ offset: true, limit: true, entry_id: true })
          .refine(
            (v) => !v.from || !v.to || v.from <= v.to,
            "Choose a valid date range.",
          ),
      })
      .strict(),
    z
      .object({
        type: z.literal("report.snapshot"),
        id,
        from: dateSchema,
        to: dateSchema,
      })
      .strict(),
  ]),
]);
export const extendedRequestSchema = z
  .object({ key: id, command: extendedCommandSchema })
  .strict();
export type WorkflowCommand = z.infer<typeof extendedCommandSchema>;
export interface AccountProfile {
  account_id: string;
  version: number;
  purpose: string | null;
  cash_kind: z.infer<typeof cashKind>;
  parent_account_id: string | null;
  subtype: string;
}
export interface Party {
  id: string;
  version: number;
  name: string;
  kind: z.infer<typeof partyKind>;
  default_account_id: string | null;
  tax_classification: z.infer<typeof taxClassification>;
  documentation: z.infer<typeof documentation>;
  notes: string;
  is_archived: boolean;
}
export interface JournalTemplate {
  id: string;
  version: number;
  name: string;
  memo: string;
  lines: z.infer<typeof lines>;
  is_archived: boolean;
}
export interface ManageData {
  profiles: AccountProfile[];
  parties: Party[];
  dimensions: {
    id: string;
    version: number;
    name: string;
    kind: "project" | "business_line";
    customer_id: string | null;
    is_archived: boolean;
  }[];
  templates: JournalTemplate[];
  views: {
    id: string;
    version: number;
    name: string;
    filters: Partial<RegisterFilter>;
  }[];
  periods: { month_start: string; is_locked: boolean; reason: string }[];
  preferences: {
    version: number;
    authority_mode: "wave_primary" | "parallel_pilot" | "admin_primary";
    primary_from: string | null;
    history_start: string | null;
    transfer_window_days: number;
    transit_alert_days: number;
  } | null;
}
export interface EntryEvidence {
  rules?: {
    id: string;
    rule_id: string;
    rule_version: number;
    rule_name: string;
    created_at: string;
    before_value: RuleCandidate;
    after_value: {
      version: number;
      lines: RuleCandidate["lines"];
      payee_id: string | null;
    };
  }[];
  sources: {
    id: string;
    source_system: string;
    external_id: string;
    observed_at: string;
    raw_payload: unknown;
  }[];
  notes: { id: string; note: string; created_at: string }[];
  documents: {
    id: string;
    original_name: string;
    size_bytes: string;
    mime_type: string;
  }[];
  audit: {
    id: string;
    table_name: string;
    action: string;
    recorded_at: string;
    before_value: unknown;
    after_value: unknown;
  }[];
}
