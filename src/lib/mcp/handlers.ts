import "server-only";
import type { NextRequest } from "next/server";
import type { API_OPERATIONS } from "@/lib/api/operations";
import * as summary from "@/app/api/v1/books/summary/route";
import * as accounts from "@/app/api/v1/books/accounts/route";
import * as ledger from "@/app/api/v1/books/accounts/[id]/ledger/route";
import * as transactions from "@/app/api/v1/books/transactions/route";
import * as transaction from "@/app/api/v1/books/transactions/[id]/route";
import * as categorize from "@/app/api/v1/books/transactions/[id]/categorize/route";
import * as split from "@/app/api/v1/books/transactions/[id]/split/route";
import * as categorizeBulk from "@/app/api/v1/books/transactions/categorize/route";
import * as reports from "@/app/api/v1/books/reports/route";
import * as report from "@/app/api/v1/books/reports/[id]/route";
import * as revision from "@/app/api/v1/books/revision/route";
import * as reconciliation from "@/app/api/v1/books/reconciliation/route";
import * as attention from "@/app/api/v1/books/attention/route";
import * as missed from "@/app/api/v1/books/missed-transactions/route";
import * as contacts from "@/app/api/v1/books/contacts/route";
import * as contact from "@/app/api/v1/books/contacts/[id]/route";
import * as contactAssign from "@/app/api/v1/books/contacts/[id]/assign/route";
import * as rules from "@/app/api/v1/books/rules/route";
import * as drafts from "@/app/api/v1/books/drafts/route";
import * as draft from "@/app/api/v1/books/drafts/[id]/route";
import * as income from "@/app/api/v1/tracker/income/route";
import * as incomeItems from "@/app/api/v1/tracker/income/items/route";
import * as incomeItem from "@/app/api/v1/tracker/income/items/[id]/route";
import * as expenses from "@/app/api/v1/tracker/expenses/route";
import * as expense from "@/app/api/v1/tracker/expenses/[id]/route";
import * as netWorth from "@/app/api/v1/tracker/net-worth/route";
import * as netWorthEntry from "@/app/api/v1/tracker/net-worth/[id]/route";
import * as tax from "@/app/api/v1/tax/estimate/route";

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type RouteModule = Partial<
  Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", RouteHandler>
>;

/**
 * The v1 route module behind each registry path. The type requires every
 * path in API_OPERATIONS, and scripts/verify-mcp.ts checks each operation's
 * method is exported, so a tool always runs the same handler REST does.
 */
export const ROUTE_MODULES: Record<
  (typeof API_OPERATIONS)[number]["path"],
  RouteModule
> = {
  "/api/v1/books/summary": summary,
  "/api/v1/books/accounts": accounts,
  "/api/v1/books/accounts/{id}/ledger": ledger,
  "/api/v1/books/transactions": transactions,
  "/api/v1/books/transactions/{id}": transaction,
  "/api/v1/books/transactions/{id}/categorize": categorize,
  "/api/v1/books/transactions/{id}/split": split,
  "/api/v1/books/transactions/categorize": categorizeBulk,
  "/api/v1/books/reports": reports,
  "/api/v1/books/reports/{id}": report,
  "/api/v1/books/revision": revision,
  "/api/v1/books/reconciliation": reconciliation,
  "/api/v1/books/attention": attention,
  "/api/v1/books/missed-transactions": missed,
  "/api/v1/books/contacts": contacts,
  "/api/v1/books/contacts/{id}": contact,
  "/api/v1/books/contacts/{id}/assign": contactAssign,
  "/api/v1/books/rules": rules,
  "/api/v1/books/drafts": drafts,
  "/api/v1/books/drafts/{id}": draft,
  "/api/v1/tracker/income": income,
  "/api/v1/tracker/income/items": incomeItems,
  "/api/v1/tracker/income/items/{id}": incomeItem,
  "/api/v1/tracker/expenses": expenses,
  "/api/v1/tracker/expenses/{id}": expense,
  "/api/v1/tracker/net-worth": netWorth,
  "/api/v1/tracker/net-worth/{id}": netWorthEntry,
  "/api/v1/tax/estimate": tax,
};

export function routeHandler(
  path: string,
  method: keyof RouteModule,
): RouteHandler | null {
  return (ROUTE_MODULES as Record<string, RouteModule>)[path]?.[method] ?? null;
}
