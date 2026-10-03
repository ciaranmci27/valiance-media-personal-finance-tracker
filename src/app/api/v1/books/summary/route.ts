import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksClient, booksRange, booksRead, quality } from "@/lib/api/books";
import type { ReportData } from "@/lib/accounting/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Summary = ReportData & {
  cost_of_goods_sold_cents: string;
  gross_profit_cents: string;
  operating_expense_cents: string;
  net_income_cents: string;
};

export const GET = withApi(
  apiOperation("books.summary"),
  async ({ query, keyHash, service }) => {
    const { from, to } = await booksRange(service, query.from, query.to);
    const report = await booksRead<Summary>(
      booksClient(service, keyHash),
      "report",
      {
        kind: "summary",
        params: { from, to, mode: query.mode },
      },
    );
    return {
      data: {
        from,
        to,
        book_mode: query.mode,
        basis: report.basis,
        currency: report.currency,
        income_cents: report.totals.income_cents,
        cost_of_goods_sold_cents: report.cost_of_goods_sold_cents,
        gross_profit_cents: report.gross_profit_cents,
        operating_expense_cents: report.operating_expense_cents,
        expense_cents: report.totals.expense_cents,
        net_income_cents: report.net_income_cents,
        assets_cents: report.totals.assets_cents,
        liabilities_cents: report.totals.liabilities_cents,
        equity_cents: report.totals.equity_cents,
        cash_opening_cents: report.totals.cash_opening_cents,
        cash_ending_cents: report.totals.cash_ending_cents,
        monthly: report.monthly,
        quality: quality(report),
        revision: report.revision,
      },
    };
  },
);
