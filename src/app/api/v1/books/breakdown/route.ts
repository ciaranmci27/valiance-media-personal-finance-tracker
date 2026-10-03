import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import { booksClient, booksRange, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

interface Breakdown {
  from: string;
  to: string;
  book_mode: "working" | "posted";
  measure: "activity" | "balance";
  group_by: string;
  top: number;
  compare: { from: string; to: string } | null;
  rows: Row[];
  other: Row | null;
  total: Row;
  quality: Row;
  revision: string;
}

/** The fields of a row in reading order (SQL objects come back sorted by key length). */
function ordered(row: Row | null): Row | null {
  if (!row) return null;
  const fields = ["key", "label", "type", "groups", "income_cents", "expense_cents", "net_cents", "count", "balance_cents", "compare", "change"];
  return Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]]));
}

const refuse = (message: string, hint: string, reason = "invalid_parameters") =>
  new ApiError(422, "VALIDATION_ERROR", message, { reason, hint });

/** Totals by month, quarter, category, contact, bank account or role, added up in SQL (accounting.breakdown). */
export const GET = withApi(
  apiOperation("books.breakdown"),
  async ({ query, keyHash, service }) => {
    const { from, to } = await booksRange(service, query.from, query.to);
    if (query.compare && (query.compare_from || query.compare_to))
      throw refuse("Send compare, or compare_from and compare_to, not both.", "compare=previous_period or previous_year covers most questions.");
    if (Boolean(query.compare_from) !== Boolean(query.compare_to) || (query.compare_from && query.compare_from > query.compare_to!))
      throw refuse("Send both compare_from and compare_to, in order.", "compare_from must be on or before compare_to.", "invalid_range");
    if (query.measure === "balance") {
      if (query.group_by === "contact" || query.group_by === "role")
        throw refuse("A balance is per account or per period, not per contact or role.", "Use group_by month, quarter, category or bank_account with measure=balance.");
      if (query.contact || query.role || query.kind || query.bank_account)
        throw refuse("contact, role, kind and bank_account filter activity, not balances.", "For one account's balance, pass its id in category.");
    }
    const result = await booksRead<Breakdown>(booksClient(service, keyHash), "breakdown", {
      params: {
        from,
        to,
        mode: query.mode,
        group_by: query.group_by,
        measure: query.measure,
        top: query.top,
        ...(query.compare ? { compare: query.compare } : {}),
        ...(query.compare_from ? { compare_from: query.compare_from, compare_to: query.compare_to } : {}),
        ...(query.category ? { account_ids: query.category } : {}),
        ...(query.account_types ? { account_types: query.account_types } : {}),
        // No contact is 'unassigned' to the books.
        ...(query.contact ? { payee: query.contact === "none" ? "unassigned" : query.contact } : {}),
        ...(query.role ? { role: query.role } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.bank_account ? { bank_account: query.bank_account } : {}),
      },
    });
    return {
      data: {
        from: result.from,
        to: result.to,
        book_mode: result.book_mode,
        measure: result.measure,
        group_by: result.group_by,
        top: result.top,
        compare: result.compare,
        rows: result.rows.map(ordered),
        other: ordered(result.other),
        total: ordered(result.total),
        quality: result.quality,
        revision: result.revision,
      },
    };
  },
);
