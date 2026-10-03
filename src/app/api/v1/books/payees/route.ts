import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import {
  appUrl,
  booksClient,
  booksCommand,
  booksRead,
  nameMatches,
  pageOf,
} from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Payee {
  name: string;
  kind: string;
  is_archived: boolean;
}

/** Payees, through the books' reader check (accounting.payees_list), searched and paged by name. */
export const GET = withApi(
  apiOperation("books.payees"),
  async ({ query, keyHash, service }) => {
    const result = await booksRead<{ payees: Payee[] | null }>(
      booksClient(service, keyHash),
      "payees",
      {},
    );
    const matching = (result.payees ?? [])
      .filter(
        (payee) => query.include_archived === "true" || !payee.is_archived,
      )
      .filter((payee) => !query.kind || payee.kind === query.kind)
      .filter((payee) => nameMatches(payee.name, query.q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const { rows, ...page } = pageOf(matching, query);
    return { data: { ...page, payees: rows } };
  },
);

/** Adds a payee. Create-only: the books command refuses to change an existing one. */
export const POST = withApi(
  apiOperation("books.payee_create"),
  async ({ body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "payee.create",
      idempotencyKey,
      body,
    );
    return {
      data: {
        id: String(result.id ?? ""),
        version: typeof result.version === "number" ? result.version : null,
        review_url: appUrl(origin, "/accounting?view=manage&section=payees"),
      },
    };
  },
);
