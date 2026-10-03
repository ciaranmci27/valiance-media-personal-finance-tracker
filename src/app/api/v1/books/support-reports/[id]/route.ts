import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError, databaseError } from "@/lib/api/http";
import { booksClient, booksRange, booksToday } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TITLES = {
  "payroll-register": "Payroll register",
  "contractor-worksheet": "Contractor (1099) worksheet",
  "tax-workpapers": "Tax workpapers",
  "asset-register": "Fixed asset register",
  "loan-register": "Loan register",
} as const;

interface SupportReport {
  report_id: string;
  revision: string;
  columns: { label: string; numeric: boolean }[];
  rows: { id?: string | null; cells: (string | null)[] }[];
  count: number;
  total_cells: (string | null)[];
  notes: string[];
  controls?: unknown;
  threshold_cents?: string;
  tax_workpaper?: {
    book_profit_cents: string;
    mapped_ordinary_cents: string;
    adjusted_ordinary_cents: string;
    book_to_tax_cents: string;
    separately_stated: Record<string, string>;
    unmapped_accounts: number;
    drafts: number | null;
    year_settings?: { classification?: string | null } | null;
  };
}

/**
 * The owner's support reports (accounting.support_report), read only. The
 * key needs accounting.payroll: public.api_accounting checks it, makes the
 * transaction read only, and only then lets the owner-only report run.
 */
export const GET = withApi(
  apiOperation("books.support_report"),
  async ({ query, params, keyHash, service }) => {
    if (query.year !== undefined && (query.from || query.to))
      throw new ApiError(422, "VALIDATION_ERROR", "Send year, or from and to, not both.", {
        reason: "invalid_parameters",
        hint: "year covers January 1 to December 31 (or to today for this year).",
      });
    let range: { from: string; to: string };
    if (query.year !== undefined) {
      const today = await booksToday(service);
      const end = `${query.year}-12-31`;
      range = { from: `${query.year}-01-01`, to: end < today ? end : today };
      if (range.from > range.to)
        throw new ApiError(422, "VALIDATION_ERROR", "That year has not started.", { reason: "invalid_range", hint: "Use this year or an earlier one." });
    } else range = await booksRange(service, query.from, query.to);

    const { data, error } = await booksClient(service, keyHash).rpc("support_report", {
      params: { report_id: params.id, from: range.from, to: range.to, offset: query.offset, limit: query.limit },
    });
    if (error) throw databaseError(error.message, "accounting.payroll");
    const report = data as SupportReport;
    const threshold = report.threshold_cents;
    const rows = report.rows.map((row) => ({
      id: String(row.id ?? ""),
      cells: row.cells,
      // Cash paid (bank and cash, net of refunds) is the fourth column.
      ...(params.id === "contractor-worksheet" && threshold !== undefined ? { meets_threshold: BigInt(row.cells[3] ?? "0") >= BigInt(threshold) } : {}),
    }));
    const reached = query.offset + rows.length;
    const tax = report.tax_workpaper;
    return {
      data: {
        id: params.id,
        title: TITLES[params.id],
        from: range.from,
        to: range.to,
        columns: report.columns.map(({ label, numeric }) => ({ label, numeric })),
        rows,
        count: report.count,
        offset: query.offset,
        limit: query.limit,
        next_offset: rows.length > 0 && reached < report.count ? reached : null,
        total_cells: report.total_cells,
        notes: report.notes,
        ...(threshold !== undefined ? { threshold_cents: threshold } : {}),
        ...(tax
          ? {
              summary: {
                book_profit_cents: tax.book_profit_cents,
                mapped_ordinary_cents: tax.mapped_ordinary_cents,
                adjusted_ordinary_cents: tax.adjusted_ordinary_cents,
                book_to_tax_cents: tax.book_to_tax_cents,
                separately_stated: tax.separately_stated,
                unmapped_accounts: tax.unmapped_accounts,
                drafts: tax.drafts ?? null,
                classification: tax.year_settings?.classification ?? null,
              },
            }
          : {}),
        ...(report.controls !== undefined ? { controls: report.controls } : {}),
        revision: report.revision,
      },
    };
  },
);
