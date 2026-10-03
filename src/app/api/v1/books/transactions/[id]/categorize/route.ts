import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, writtenDraft } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Categorizes one draft; it stays a draft for review. */
export const POST = withApi(
  apiOperation("books.categorize"),
  async ({ params, body, idempotencyKey, keyHash, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "categorize",
      idempotencyKey,
      { ...body, id: params.id },
    );
    return { data: writtenDraft(result, params.id) };
  },
);
