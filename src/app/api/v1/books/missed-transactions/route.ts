import { createHash } from "node:crypto";
import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, payeeFields, writtenDraft } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The id public.api_books_command gives the draft: md5('missed:' || key)::uuid. */
function missedId(key: string): string {
  const hex = createHash("md5").update(`missed:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Drafts a bank movement the feed missed. Every guard is in SQL
 * (public.api_books_command, missed.create): a gap on that account right
 * now, the direction and size that shrink it, no same amount within 10 days,
 * an open month, and a draft only.
 */
export const POST = withApi(
  apiOperation("books.missed_create"),
  async ({ body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "missed.create",
      idempotencyKey,
      payeeFields(body),
    );
    return { data: writtenDraft(result, missedId(idempotencyKey), origin) };
  },
);
