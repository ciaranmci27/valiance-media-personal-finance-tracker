import { z } from "zod";
import { dateSchema } from "./contracts";
import type { ReportData, ReportDetail } from "./reports";
import type { SupportReportData } from "./support-reports";
import type { PayrollYear } from "./payroll";
import type { AccountProfile } from "./workflows";

export const booksPackageScopeSchema = z
  .object({ year: z.number().int().min(1900).max(2100), through: dateSchema })
  .strict()
  .refine(
    (value) => Number(value.through.slice(0, 4)) === value.year,
    "Choose a cutoff within the selected year.",
  );
export const booksPackageCommandSchema = z
  .object({
    type: z.literal("report.books.capture"),
    id: z.uuid(),
    expected_revision: z.string().regex(/^\d{1,19}$/),
    year: z.number().int().min(1900).max(2100),
    through: dateSchema,
  })
  .strict()
  .refine(
    (value) => Number(value.through.slice(0, 4)) === value.year,
    "Choose a cutoff within the selected year.",
  );
export const booksPackageCatalog = {
  id: "books-package" as const,
  title: "Year-end books package",
  description:
    "A complete review set: statements, ledger, mappings, payroll, contractor and tax support.",
  group: "Payroll & year end",
};
export interface BooksPackagePreview {
  year: number;
  through: string;
  revision: string;
  legal_name: string;
  ledger_count: number;
  incomplete_imports: number;
  review_items: { kind: string; message: string }[];
  notes: string[];
  reports: { id: string; rows: number }[];
}
export interface BooksPackageSnapshot {
  id: string;
  revision: string;
  created_at: string;
  payload: {
    type: "books_package";
    export_definition: 1;
    year: number;
    through: string;
    core: ReportData;
    ledger: ReportDetail["rows"];
    ledger_count: number;
    support: SupportReportData[];
    payroll: PayrollYear;
    review_items: { kind: string; message: string }[];
    notes: string[];
    account_mappings: {
      id: string;
      code: string;
      name: string;
      account_type: string;
      normal_side: string;
      is_archived: boolean;
      profile: AccountProfile | null;
    }[];
    document_index: {
      id: string;
      original_name: string;
      content_hash: string;
      mime_type: string;
      size_bytes: string;
      state: string | null;
    }[];
  };
}
export interface BooksPackageHistory {
  count: number;
  rows: {
    id: string;
    from_date: string;
    to_date: string;
    revision: string;
    created_at: string;
    review_items: { kind: string; message: string }[];
  }[];
}
