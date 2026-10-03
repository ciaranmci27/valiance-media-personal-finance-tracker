import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import { booksClient, booksRange, booksRead, quality } from "@/lib/api/books";
import { buildReportModel } from "@/lib/accounting/report-model";
import type { ReportData } from "@/lib/accounting/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Reports screen's own pipeline: the same SQL read (summary, or the
 * general ledger for that report) and the same buildReportModel, so every row
 * matches the screen.
 */
export const GET = withApi(
  apiOperation("books.report"),
  async ({ query, params, keyHash, service }) => {
    const { from, to } = await booksRange(service, query.from, query.to);
    if (
      Boolean(query.compare_from) !== Boolean(query.compare_to) ||
      (query.compare_from && query.compare_from > query.compare_to!)
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Send both compare_from and compare_to, in order.",
        { reason: "invalid_range" },
      );
    const report = await booksRead<ReportData>(
      booksClient(service, keyHash),
      "report",
      {
        kind: params.id === "general-ledger" ? "general_ledger" : "summary",
        params: {
          from,
          to,
          mode: query.mode,
          ...(query.compare_from
            ? { compare_from: query.compare_from, compare_to: query.compare_to }
            : {}),
        },
      },
    );
    const model = buildReportModel(params.id, report);
    return {
      data: {
        id: model.id,
        title: model.title,
        from,
        to,
        book_mode: query.mode,
        columns: model.columns,
        rows: model.rows.map(({ key, label, kind, code, values }) => ({
          key,
          label,
          kind,
          ...(code ? { code } : {}),
          values,
        })),
        footnotes:
          params.id === "customer-income" || params.id === "vendor-expenses"
            ? [
                ...model.footnotes,
                "The API does not read contact settings, so a contact is not filtered by its customer or vendor role: one with both income and expenses can appear on both reports.",
              ]
            : model.footnotes,
        quality: quality(report),
        revision: report.revision,
      },
    };
  },
);
