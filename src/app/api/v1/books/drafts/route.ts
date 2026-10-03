import { createHash } from "node:crypto";
import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, writtenDraft } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The id public.api_books_command gives a new draft: md5('draft:' || key)::uuid. */
function draftId(key: string): string {
  const hex = createHash("md5").update(`draft:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Prepares a draft journal entry for the owner to review. */
export const POST = withApi(
  apiOperation("books.draft_create"),
  async ({ body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "draft.create",
      idempotencyKey,
      body,
    );
    return { data: writtenDraft(result, draftId(idempotencyKey), origin) };
  },
);
