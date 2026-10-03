import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksClient, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The books' change counter (accounting.revision), cheap enough to poll. */
export const GET = withApi(
  apiOperation("books.revision"),
  async ({ keyHash, service }) => {
    const result = await booksRead<{ revision: string }>(
      booksClient(service, keyHash),
      "revision",
      {},
    );
    return { data: { revision: result.revision } };
  },
);
