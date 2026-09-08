import { z } from "zod";
import { dateSchema } from "./contracts";
import { centsToDecimal } from "./money";
import type { ReportDocument } from "./report-document";
export const supportReportCatalog = [
  {
    id: "tax-workpapers",
    title: "Tax workpapers",
    description:
      "Reviewed account treatment, book-to-tax adjustments and supported shareholder basis.",
    group: "Payroll & year end",
  },
  {
    id: "contractor-worksheet",
    title: "Contractor worksheet",
    description:
      "Payments, refunds, exclusions and unresolved reporting decisions by payee.",
    group: "Payroll & year end",
  },
  {
    id: "asset-register",
    title: "Fixed assets",
    description:
      "Cost, book depreciation and carrying value, with source schedules and account controls.",
    group: "Payroll & year end",
  },
  {
    id: "loan-register",
    title: "Loan balances",
    description:
      "Documented principal, repayments and agreement with each loan account.",
    group: "Payroll & year end",
  },
  {
    id: "payroll-register",
    title: "Payroll register",
    description:
      "Cash wages, deductions, employer costs and net pay, with each approved run and journal.",
    group: "Payroll & year end",
  },
  {
    id: "payroll-liabilities",
    title: "Payroll amounts payable",
    description:
      "Open payroll obligations, expected dates and exact bank-payment settlements.",
    group: "Payroll & year end",
  },
] as const;
export type SupportReportId = (typeof supportReportCatalog)[number]["id"];
export const supportReportFilterSchema = z
  .object({
    report_id: z.enum([
      "payroll-register",
      "payroll-liabilities",
      "contractor-worksheet",
      "asset-register",
      "loan-register",
      "tax-workpapers",
    ]),
    from: dateSchema,
    to: dateSchema,
    offset: z.number().int().min(0).max(10000000).default(0),
  })
  .strict()
  .refine((f) => f.from <= f.to);
export type SupportReportFilter = z.infer<typeof supportReportFilterSchema>;
export const supportReportCommandSchema = z
  .object({
    type: z.literal("report.support.capture"),
    id: z.uuid(),
    expected_revision: z.string().regex(/^\d{1,19}$/),
    filter: supportReportFilterSchema,
  })
  .strict();
export interface SupportReportData {
  definition_version: number;
  report_id: SupportReportId;
  legal_name: string;
  revision: string;
  filter: SupportReportFilter;
  columns: { label: string; numeric: boolean }[];
  rows: {
    id: string;
    run_id?: string;
    contractor_party_id?: string | null;
    register_id?: string;
    register_kind?: "asset" | "loan";
    tax_kind?: "account" | "adjustment";
    tax_account_id?: string | null;
    cells: string[];
  }[];
  controls?: {
    rows: {
      account_id: string;
      name: string;
      register_cents: string;
      book_cents: string;
      difference_cents: string;
    }[];
    missing_documents: number;
    ready: boolean;
  };
  total_cells: string[];
  count: number;
  notes: string[];
}
export interface SupportReportSnapshot {
  id: string;
  created_at: string;
  payload: {
    type: "support_report";
    export_definition: 1;
    data: SupportReportData;
  };
}
export function supportReportDocument(
  snapshot: SupportReportSnapshot,
): ReportDocument {
  const d = snapshot.payload.data,
    report = supportReportCatalog.find((r) => r.id === d.report_id);
  if (!report || d.rows.length !== d.count)
    throw new Error("The retained report is incomplete.");
  const cells = (values: string[]) =>
    values.map((value, i) =>
      d.columns[i].numeric ? centsToDecimal(BigInt(value)) : value,
    );
  return {
    title: report.title,
    company: d.legal_name,
    snapshotId: snapshot.id,
    metadata: [
      [
        "Period",
        d.report_id === "payroll-register" ||
        d.report_id === "contractor-worksheet" ||
        d.report_id === "tax-workpapers"
          ? `${d.filter.from} through ${d.filter.to}`
          : `As of ${d.filter.to}`,
      ],
      ["Currency", "USD"],
      ["Data revision", d.revision],
      ["Report definition", String(d.definition_version)],
      ["Retained at", snapshot.created_at],
    ],
    columns: d.columns.map((c) => c.label),
    numeric: d.columns.map((c) => c.numeric),
    rows: [
      ...d.rows.map((r) => ({
        key: r.id,
        kind: "account" as const,
        cells: cells(r.cells),
      })),
      { key: "total", kind: "total", cells: cells(d.total_cells) },
    ],
    notes: [
      ...d.notes,
      ...(d.controls?.rows.map(
        (r) =>
          `${r.name}: register USD ${centsToDecimal(r.register_cents)}, books USD ${centsToDecimal(r.book_cents)}, difference USD ${centsToDecimal(r.difference_cents)}.`,
      ) ?? []),
    ],
  };
}
