import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import { booksClient, booksRange, booksRead, quality } from "@/lib/api/books";
import { buildReportModel } from "@/lib/accounting/report-model";
import type { ReportData } from "@/lib/accounting/reports";
import { topRows } from "@/lib/api/report-top";

/** The reports top-N applies to, and what their rows are. */
const TOP_NOUNS: Record<string, { one: string; many: string }> = {
  "profit-loss": { one: "category", many: "categories" },
  "customer-income": { one: "contact", many: "contacts" },
  "vendor-expenses": { one: "contact", many: "contacts" },
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Reports screen's own pipeline: the same SQL read (summary, or the
 * general ledger for that report) and the same buildReportModel, so every row
 * matches the screen. The customer and vendor reports read contact roles, as
 * the screen does: clients on one, everyone the business pays on the other.
 * The filters are the ones accounting.report already takes (account_ids,
 * account_types, payee); top sorts and rolls up the rows afterwards.
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
    if (query.top !== undefined && !TOP_NOUNS[params.id])
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "top works on profit-loss, customer-income and vendor-expenses.",
        {
          reason: "invalid_parameters",
          hint: "Leave top out for this report, or read one of those three.",
        },
      );
    const client = booksClient(service, keyHash);
    const byContact =
      params.id === "customer-income" || params.id === "vendor-expenses";
    const contacts = byContact
      ? ((
          await booksRead<{ payees: { id: string; roles: string[] }[] | null }>(
            client,
            "payees",
            {},
          )
        ).payees ?? [])
      : undefined;
    const report = await booksRead<ReportData>(
      client,
      "report",
      {
        kind: params.id === "general-ledger" ? "general_ledger" : "summary",
        params: {
          from,
          to,
          mode: query.mode,
          ...(query.category ? { account_ids: query.category } : {}),
          ...(query.account_types ? { account_types: query.account_types } : {}),
          ...(query.contact
            ? { payee: query.contact === "none" ? "unassigned" : query.contact }
            : {}),
          ...(query.compare_from
            ? { compare_from: query.compare_from, compare_to: query.compare_to }
            : {}),
        },
      },
    );
    const model = buildReportModel(params.id, report, false, contacts);
    const rows =
      query.top !== undefined
        ? topRows(model.rows, query.top, TOP_NOUNS[params.id])
        : model.rows;
    return {
      data: {
        id: model.id,
        title: model.title,
        from,
        to,
        book_mode: query.mode,
        columns: model.columns,
        rows: rows.map(({ key, label, kind, code, values }) => ({
          key,
          label,
          kind,
          ...(code ? { code } : {}),
          values,
        })),
        footnotes:
          query.top !== undefined
            ? [
                ...model.footnotes,
                "Rows are sorted biggest first; Other is each section total less the rows shown.",
              ]
            : model.footnotes,
        quality: quality(report),
        revision: report.revision,
      },
    };
  },
);
