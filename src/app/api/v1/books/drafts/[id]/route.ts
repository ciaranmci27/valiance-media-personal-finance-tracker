import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, writtenDraft } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replaces a draft, lines included. Posted transactions are refused. */
export const PUT = withApi(
  apiOperation("books.draft_update"),
  async ({ params, body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "draft.update",
      idempotencyKey,
      { ...body, id: params.id },
    );
    return { data: writtenDraft(result, params.id, origin) };
  },
);
