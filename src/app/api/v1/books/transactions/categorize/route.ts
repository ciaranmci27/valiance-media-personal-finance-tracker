import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, payeeFields, writtenDraft } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Categorizes up to 50 drafts in one transaction: all of them or none. */
export const POST = withApi(
  apiOperation("books.categorize_bulk"),
  async ({ body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "categorize.bulk",
      idempotencyKey,
      { items: body.items.map(payeeFields) },
    );
    const results = Array.isArray(result.results)
      ? (result.results as Record<string, unknown>[])
      : [];
    return {
      data: {
        results: results.map((entry, index) =>
          writtenDraft(entry ?? {}, body.items[index]?.id ?? "", origin),
        ),
      },
    };
  },
);
