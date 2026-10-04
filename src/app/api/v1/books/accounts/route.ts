import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import {
  booksClient,
  booksRead,
  booksToday,
  nameMatches,
  yearStart,
} from "@/lib/api/books";
import type { ReportData } from "@/lib/accounting/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(
  apiOperation("books.accounts"),
  async ({ query, keyHash, service }) => {
    const asOf = query.as_of ?? (await booksToday(service));
    const report = await booksRead<ReportData>(
      booksClient(service, keyHash),
      "report",
      {
        kind: "summary",
        params: { from: yearStart(asOf), to: asOf, mode: query.mode },
      },
    );
    const accounts = report.accounts
      .filter((a) => query.include_archived === "true" || !a.is_archived)
      .filter((a) => !query.type || a.account_type === query.type)
      .filter((a) => nameMatches(a.name, query.q))
      .map((a) => {
        // As the Accounts screen shows them: positive is the account's normal
        // balance (what an asset holds, what a liability owes, income earned).
        const normal = (cents: string) =>
          a.normal_side === "credit" ? (-BigInt(cents)).toString() : cents;
        return {
          id: a.id,
          code: a.code || null,
          name: a.name,
          type: a.account_type,
          subtype: a.subtype,
          purpose: a.purpose ?? null,
          parent_id: a.parent_account_id,
          is_archived: a.is_archived,
          closed_on: a.closed_on ?? null,
          cash_kind: a.cash_kind,
          normal_side: a.normal_side,
          balance_cents: normal(a.ending_cents),
          period_cents: normal(a.period_cents),
        };
      });
    return {
      data: {
        as_of: asOf,
        book_mode: query.mode,
        accounts,
        revision: report.revision,
      },
    };
  },
);
