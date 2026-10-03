import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksCommand, contactUrl } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Assigned {
  entries?: { id: string; version: number }[];
  remembered?: string[];
  already_remembered?: string[];
  not_remembered?: {
    descriptor_key: string;
    contact: { id: string; name: string };
  }[];
}

/** Fills a blank contact on transactions, all or nothing; nothing else on them changes. */
export const POST = withApi(
  apiOperation("books.contact_assign"),
  async ({ params, body, idempotencyKey, keyHash, origin, service }) => {
    const result = (await booksCommand(
      service,
      keyHash,
      "contact.assign",
      idempotencyKey,
      { contact_id: params.id, entries: body.entries, remember: body.remember },
    )) as Assigned;
    return {
      data: {
        contact_id: params.id,
        entries: result.entries ?? [],
        remembered: result.remembered ?? [],
        already_remembered: result.already_remembered ?? [],
        not_remembered: result.not_remembered ?? [],
        review_url: contactUrl(origin, params.id),
      },
    };
  },
);
