import { z } from "zod";
import { dateSchema } from "./contracts";
const cents = z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
  id = z.uuid(),
  nullableId = id.nullable(),
  reason = z.string().trim().min(1).max(1000);
export const payrollKinds = {
  officer_wages: "Officer cash wages",
  other_wages: "Other employee cash wages",
  reimbursement: "Employee reimbursements",
  net_pay: "Net pay",
  employee_tax: "Employee tax withholding",
  retirement_deferral: "Employee retirement deferrals",
  other_deduction: "Other employee deductions",
  employer_tax: "Employer payroll taxes",
  employer_retirement: "Employer retirement contribution",
  employer_benefit: "Employer benefit cost",
  provider_fee: "Payroll service fee",
  noncash_reclass: "Previously recorded noncash benefit",
} as const;
export type PayrollKind = keyof typeof payrollKinds;
export const payrollPaired = new Set<string>([
  "employer_tax",
  "employer_retirement",
  "employer_benefit",
  "provider_fee",
  "noncash_reclass",
]);
export const payrollCredit = new Set<string>([
  "net_pay",
  "employee_tax",
  "retirement_deferral",
  "other_deduction",
]);
export const payrollFactLabels = {
  federal_taxable_cents: "Federal taxable wages",
  federal_withheld_cents: "Federal income tax withheld",
  state_taxable_cents: "State taxable wages",
  state_withheld_cents: "State income tax withheld",
  social_security_wages_cents: "Social Security wages",
  medicare_wages_cents: "Medicare wages",
} as const;
export const payrollEmployeeSchema = z
  .object({
    key: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(160),
    is_officer: z.boolean(),
    gross_cash_cents: cents,
    federal_taxable_cents: cents.nullable().optional(),
    federal_withheld_cents: cents.nullable().optional(),
    state_taxable_cents: cents.nullable().optional(),
    state_withheld_cents: cents.nullable().optional(),
    social_security_wages_cents: cents.nullable().optional(),
    medicare_wages_cents: cents.nullable().optional(),
  })
  .strict();
export const payrollComponentSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    kind: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(160),
    amount_cents: cents.refine(
      (s) => BigInt(s) > BigInt(0),
      "Enter a positive component amount.",
    ),
    account_id: nullableId,
    offset_account_id: nullableId,
    expected_on: dateSchema.nullable(),
    source_line_id: nullableId.optional(),
  })
  .strict();
export const payrollBodySchema = z
  .object({
    pay_date: dateSchema,
    period_from: dateSchema,
    period_to: dateSchema,
    declared_gross_cents: cents,
    declared_net_cents: cents,
    components: z.array(payrollComponentSchema).min(1).max(40),
    employees: z.array(payrollEmployeeSchema).min(1).max(50),
  })
  .strict();
export type PayrollBody = z.infer<typeof payrollBodySchema>;
export type PayrollComponent = z.infer<typeof payrollComponentSchema>;
export type PayrollEmployee = z.infer<typeof payrollEmployeeSchema>;
const payrollYtdSchema = z
  .object({
    verified: z.boolean(),
    through: dateSchema.optional(),
    employees: z.array(payrollEmployeeSchema).max(50).optional(),
    federal_taxable_cents: cents.optional(),
    federal_withheld_cents: cents.optional(),
    state_taxable_cents: cents.optional(),
    state_withheld_cents: cents.optional(),
    social_security_wages_cents: cents.optional(),
    medicare_wages_cents: cents.optional(),
  })
  .strict();
const cashComponentSchema = z
  .object({
    kind: z.string().trim().min(1).max(80),
    amount_cents: cents,
    key: z.string().max(80).optional(),
    label: z.string().max(160).optional(),
    account_id: nullableId.optional(),
    offset_account_id: nullableId.optional(),
    expected_on: dateSchema.nullable().optional(),
    source_line_id: nullableId.optional(),
  })
  .strict();
export const cashPayrollBodySchema = z
  .object({
    pay_date: dateSchema,
    period_start: dateSchema,
    period_end: dateSchema,
    gross_cents: cents,
    net_cents: cents,
    employee_withholding_cents: cents,
    employer_tax_cents: cents,
    components: z.array(cashComponentSchema).max(40).default([]),
    employees: z.array(payrollEmployeeSchema).max(50).default([]),
    ytd: payrollYtdSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.period_start <= v.period_end && v.period_end <= v.pay_date,
    "Review the payroll period and pay date.",
  );
export interface PayrollYear {
  year: number;
  through: string;
  revision: string;
  fingerprint: string;
  run_count: number;
  drafts: number;
  employees: PayrollEmployee[];
  coverage: {
    id: string;
    tax_year: number;
    version: number;
    through_date: string;
    /** Last verified pay date; `through_date` is only the requested cutoff. */
    source_through_date?: string;
    current: boolean;
    employees: PayrollEmployee[];
    document_id: string;
    reason: string;
    created_at: string;
  } | null;
}
export const payrollCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("payroll.import.undo"),
      id,
      expected_version: z.number().int().positive(),
      effective_date: dateSchema,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("payroll.discard"),
      id,
      expected_version: z.number().int().positive(),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("payroll.save"),
      id,
      expected_version: z.number().int().min(0).max(2147483646),
      provider_run_id: z.string().trim().min(1).max(160),
      body: z.union([payrollBodySchema, cashPayrollBodySchema]),
      ytd: payrollYtdSchema.optional(),
      document_id: nullableId,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.enum(["payroll.approve", "payroll.post"]),
      template: z.enum(["cash", "accrual"]).optional(),
      bank_account_id: id.optional(),
      id,
      expected_version: z.number().int().positive(),
      mode: z.enum(["new", "historical"]).default("new"),
      entry_id: id.optional(),
      entry_version: z.number().int().positive().optional(),
      verified: z.literal(true),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("payroll.void"),
      id,
      expected_version: z.number().int().positive(),
      effective_date: dateSchema,
      reason,
    })
    .strict(),
]);
export interface PayrollPreview {
  ready: boolean;
  issues: string[];
  lines: {
    account_id: string;
    amount_cents: string;
    expected_on: string | null;
    memo: string;
  }[];
  totals: Record<
    | "gross_cents"
    | "officer_cents"
    | "other_wages_cents"
    | "reimbursements_cents"
    | "deductions_cents"
    | "net_cents"
    | "employer_cents",
    string
  >;
}
export interface PayrollRun {
  import_mode?: "created" | "linked" | null;
  import_undone?: boolean;
  id: string;
  version: number;
  provider_run_id: string;
  head_revision: number;
  status: "draft" | "posted" | "linked" | "voided";
  pay_date: string;
  document_id: string | null;
  gross_cents: string;
  net_cents: string;
  entry_id: string | null;
}
export interface PayrollList {
  revision: string;
  as_of: string;
  count: number;
  offset: number;
  runs: PayrollRun[];
  totals: {
    gross_cents: string;
    net_cents: string;
    drafts: number;
  };
}
export interface PayrollPosting {
  id: string;
  entry_id: string;
  mode: "new" | "historical";
  void?: {
    effective_date: string;
    reason: string;
    reversal_entry_id: string | null;
  } | null;
}
export interface PayrollRevision {
  run_id: string;
  revision: number;
  body: PayrollBody;
  body_text: string;
  body_hash: string;
  document_id: string | null;
  reason: string;
  created_at: string;
  posting?: PayrollPosting | null;
}
export interface PayrollDetail {
  import_mode?: "created" | "linked" | null;
  import_undone?: boolean;
  id: string;
  version: number;
  provider_run_id: string;
  head_revision: number;
  status: PayrollRun["status"];
  register: PayrollRevision;
  preview: PayrollPreview;
  posting: PayrollPosting | null;
  history_count: number;
  history_offset: number;
  history: PayrollRevision[];
}
export const payrollFilterSchema = z
  .object({
    as_of: dateSchema,
    year: z.number().int().min(1900).max(2100),
    query: z.string().max(200).default(""),
    offset: z.number().int().min(0).max(10000000).default(0),
  })
  .strict();
