import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksClient, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Reconciliation {
  as_of: string;
  checked_at: string;
  revision: string;
  accounts: unknown[];
}

/** Each money account's book balance against what its bank reported (accounting.reconciliation_status). */
export const GET = withApi(
  apiOperation("books.reconciliation"),
  async ({ query, keyHash, service }) => {
    const result = await booksRead<Reconciliation>(
      booksClient(service, keyHash),
      "reconciliation",
      { params: query.account ? { account: query.account } : {} },
    );
    return {
      data: {
        as_of: result.as_of,
        checked_at: result.checked_at,
        accounts: result.accounts,
        revision: result.revision,
      },
    };
  },
);
