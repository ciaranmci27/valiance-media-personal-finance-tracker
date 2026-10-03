import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  accountIndex,
  booksClient,
  booksRange,
  booksRead,
} from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LedgerLines {
  rows: {
    id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    line_memo: string;
    status: string;
    amount_cents: string;
    running_cents: string;
  }[];
  total: number;
  total_cents: string;
  opening_cents: string;
  revision: string;
}

export const GET = withApi(
  apiOperation("books.account_ledger"),
  async ({ query, params, keyHash, service }) => {
    const { from, to } = await booksRange(service, query.from, query.to);
    const client = booksClient(service, keyHash);
    const ledger = await booksRead<LedgerLines>(client, "report_lines", {
      kind: "general_ledger",
      params: {
        from,
        to,
        offset: query.offset,
        limit: query.limit,
        mode: query.mode,
      },
      account: params.id,
    });
    // The ledger read answers an unknown account with an empty page; only then is
    // it worth the chart read that tells "no activity" from "no such account".
    if (
      ledger.total === 0 &&
      !(await accountIndex(client, to)).names.has(params.id)
    )
      throw new ApiError(404, "NOT_FOUND", "No account with that id.", {
        reason: "not_found",
      });
    const reached = query.offset + ledger.rows.length;
    return {
      data: {
        account_id: params.id,
        from,
        to,
        opening_cents: ledger.opening_cents,
        total_cents: ledger.total_cents,
        total: ledger.total,
        next_offset:
          ledger.rows.length > 0 && reached < ledger.total ? reached : null,
        lines: ledger.rows.map((row) => ({
          id: row.id,
          entry_id: row.entry_id,
          date: row.entry_date,
          memo: row.memo,
          line_memo: row.line_memo,
          status: row.status,
          amount_cents: row.amount_cents,
          running_cents: row.running_cents,
        })),
        revision: ledger.revision,
      },
    };
  },
);
