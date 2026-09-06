import { z } from "zod";
import { readCents } from "./money";

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      year >= 1900 &&
      year <= 2100 &&
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Choose a valid date from 1900 through 2100.");
const cents = z.string().refine((value) => {
  try {
    return readCents(value) !== BigInt(0);
  } catch {
    return false;
  }
}, "Each line needs a nonzero amount in exact cents.");
const line = z
  .object({
    account_id: z.uuid(),
    amount_cents: cents,
    memo: z.string().max(500).default(""),
  })
  .strict();
const version = z.number().int().positive();
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("account.create"),
      id: z.uuid(),
      code: z.string().trim().max(20),
      name: z.string().trim().min(1).max(120),
      account_type: z.enum([
        "asset",
        "liability",
        "equity",
        "income",
        "expense",
      ]),
      normal_side: z.enum(["debit", "credit"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("draft.save"),
      id: z.uuid(),
      expected_version: z.number().int().nonnegative(),
      entry_date: dateSchema,
      memo: z.string().trim().min(1).max(1000),
      lines: z.array(line).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("entry.post"),
      id: z.uuid(),
      expected_version: version,
    })
    .strict(),
  z
    .object({
      type: z.literal("draft.discard"),
      id: z.uuid(),
      expected_version: version,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("entry.reverse"),
      id: z.uuid(),
      expected_version: version,
      entry_date: dateSchema,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export const requestSchema = z
  .object({ key: z.uuid(), command: commandSchema })
  .strict();
export type AccountingCommand = z.infer<typeof commandSchema>;
export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense";
export interface AccountingAccount {
  id: string;
  code: string;
  name: string;
  account_type: AccountType;
  normal_side: "debit" | "credit";
  is_archived: boolean;
}
export interface JournalLine {
  id: string;
  account_id: string;
  amount_cents: string;
  memo: string;
}
export interface JournalEntry {
  context?: EntryContext | null;
  id: string;
  entry_date: string;
  memo: string;
  status: "draft" | "posted" | "discarded";
  version: number;
  primary_origin: string;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  created_at: string;
  lines: JournalLine[];
}
export interface EntryContext {
  kind:
    | "manual"
    | "income"
    | "expense"
    | "transfer"
    | "payroll"
    | "opening"
    | "owner"
    | "loan"
    | "asset"
    | "invoice_receipt"
    | "refund";
  payee_id?: string | null;
  customer_id?: string | null;
  project_id?: string | null;
  business_line_id?: string | null;
  payment_rail:
    | "unknown"
    | "ach"
    | "check"
    | "cash"
    | "card"
    | "third_party"
    | "wire"
    | "other";
  contractor_treatment: "unreviewed" | "reportable" | "excluded";
  contractor_reason: string;
}
export interface BalanceRow extends AccountingAccount {
  opening_cents: string;
  debit_cents: string;
  credit_cents: string;
  ending_cents: string;
  period_cents: string;
}
export interface AccountingWorkspace {
  legal_name: string;
  revision: string;
  from: string;
  to: string;
  accounts: AccountingAccount[];
  entries: JournalEntry[];
  entry_count: number;
  draft_count: number;
  balances: BalanceRow[];
  reports: {
    income_cents: string;
    expense_cents: string;
    net_income_cents: string;
    assets_cents: string;
    liabilities_cents: string;
    equity_cents: string;
    retained_cents: string;
    year_income_cents: string;
    balance_difference_cents: string;
    trial_balance_cents: string;
  };
}
