import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksClient, booksCommand, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Payees, through the books' reader check (accounting.payees_list). */
export const GET = withApi(
  apiOperation("books.payees"),
  async ({ keyHash, service }) => {
    const result = await booksRead<{ payees: unknown[] }>(
      booksClient(service, keyHash),
      "payees",
      {},
    );
    return { data: { payees: result.payees } };
  },
);

/** Adds a payee. Create-only: the books command refuses to change an existing one. */
export const POST = withApi(
  apiOperation("books.payee_create"),
  async ({ body, idempotencyKey, keyHash, service }) => {
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
      },
    };
  },
);
