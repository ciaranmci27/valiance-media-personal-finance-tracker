import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, payeeFields, writtenDraft } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Splits one draft across categories; it stays a draft for review. */
export const POST = withApi(
  apiOperation("books.split"),
  async ({ params, body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "split",
      idempotencyKey,
      { ...payeeFields(body), id: params.id },
    );
    return { data: writtenDraft(result, params.id, origin) };
  },
);
