import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, contactUrl } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Changes a contact while it is still a suggestion; the books refuse a confirmed one. */
export const PATCH = withApi(
  apiOperation("books.contact_update"),
  async ({ params, body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "contact.update",
      idempotencyKey,
      { ...body, id: params.id },
    );
    return {
      data: {
        id: params.id,
        version: typeof result.version === "number" ? result.version : null,
        review_status: "suggested" as const,
        review_url: contactUrl(origin, params.id),
      },
    };
  },
);
