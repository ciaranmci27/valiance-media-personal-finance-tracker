import { z } from "zod";
import { dateSchema } from "./contracts";
const id = z.uuid(),
  cents = z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
  reason = z.string().trim().min(1).max(1000),
  version = z.number().int().min(0).max(2147483646);
const common = {
  name: z.string().trim().min(1).max(160),
  started_on: dateSchema,
  initial_cents: cents,
  account_id: id,
  expense_account_id: id,
  terms: z.string().max(4000),
};
export const assetBodySchema = z
  .object({
    ...common,
    in_service_on: dateSchema,
    accumulated_account_id: id,
    method: z.string().trim().min(1).max(1000),
  })
  .strict();
export const loanBodySchema = z
  .object({
    ...common,
    lender: z.string().trim().min(1).max(160),
    fee_account_id: id,
  })
  .strict();
export const registerBodySchema = z.union([assetBodySchema, loanBodySchema]);
export type RegisterBody = z.infer<typeof registerBodySchema>;
export const registerActionSchema = z
  .object({
    kind: z.enum([
      "acquisition",
      "depreciation",
      "disposal",
      "draw",
      "payment",
    ]),
    date: dateSchema,
    amount_cents: cents,
    interest_cents: cents.optional(),
    fee_cents: cents.optional(),
    counter_account_id: id.optional(),
    gain_loss_account_id: id.optional(),
    schedule_row_key: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type RegisterAction = z.infer<typeof registerActionSchema>;
export const registerCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("register.save"),
      id,
      expected_version: version,
      kind: z.enum(["asset", "loan"]),
      body: registerBodySchema,
      document_id: id.nullable(),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("register.post"),
      id,
      register_id: id,
      expected_version: version,
      body: registerActionSchema,
      mode: z.enum(["new", "historical"]),
      entry_id: id.optional(),
      entry_version: version.optional(),
      document_id: id,
      verified: z.literal(true),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("register.void"),
      id,
      register_id: id,
      expected_version: version,
      movement_id: id,
      date: dateSchema,
      reason,
    })
    .strict(),
]);
export type RegisterKind = "asset" | "loan";
export interface RegisterState {
  cost_cents: string;
  depreciation_cents: string;
  carrying_cents: string;
  principal_cents: string;
  initialized: boolean;
  disposed: boolean;
}
export interface RegisterRow {
  id: string;
  version: number;
  kind: RegisterKind;
  body: RegisterBody;
  document_id: string | null;
  state: RegisterState;
}
export interface RegisterView {
  revision: string;
  as_of: string;
  count: number;
  offset: number;
  rows: RegisterRow[];
}
export interface RegisterRevision {
  revision: number;
  body: RegisterBody;
  document_id: string | null;
  reason: string;
  created_at: string;
}
export interface RegisterMovement {
  id: string;
  kind: RegisterAction["kind"];
  effective_date: string;
  entry_id: string;
  mode: "new" | "historical";
  body: RegisterAction;
  lines: { account_id: string; amount_cents: string }[];
  document_id: string;
  reason: string;
  void: null | {
    effective_date: string;
    reason: string;
    reversal_entry_id: string | null;
  };
}
export interface RegisterDetail {
  id: string;
  version: number;
  kind: RegisterKind;
  record: RegisterRevision;
  as_of: string;
  state: RegisterState;
  movement_count: number;
  movements: RegisterMovement[];
  revision_count: number;
  revisions: RegisterRevision[];
  offset: number;
}
export interface RegisterPreview {
  lines: { account_id: string; amount_cents: string }[];
  cost_delta: string;
  depreciation_delta: string;
  principal_delta: string;
  gain_cents: string;
  state: RegisterState;
}
export const registerActionLabels = {
  acquisition: "Record acquisition",
  depreciation: "Record depreciation",
  disposal: "Record disposal",
  draw: "Record loan proceeds",
  payment: "Record loan payment",
} as const;
