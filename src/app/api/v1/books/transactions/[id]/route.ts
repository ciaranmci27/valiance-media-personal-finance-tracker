import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import {
  accountIndex,
  booksClient,
  booksRead,
  booksToday,
  presentEntry,
  type EntryRow,
} from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(
  apiOperation("books.transaction"),
  async ({ params, keyHash, service }) => {
    const client = booksClient(service, keyHash);
    const [entry, index] = await Promise.all([
      booksRead<EntryRow | null>(client, "entry_detail", { entry: params.id }),
      booksToday(service).then((today) => accountIndex(client, today)),
    ]);
    if (!entry)
      throw new ApiError(404, "NOT_FOUND", "No transaction with that id.", {
        reason: "not_found",
      });
    return { data: presentEntry(entry, index.names, index.profiles) };
  },
);
