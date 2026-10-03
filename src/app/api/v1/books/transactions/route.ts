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

interface Register {
  entries: EntryRow[];
  total: number;
  needs_review_count: number;
}

export const GET = withApi(
  apiOperation("books.transactions"),
  async ({ query, keyHash, service }) => {
    if (query.from && query.to && query.from > query.to)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "from must be on or before to.",
        { reason: "invalid_range" },
      );
    const client = booksClient(service, keyHash);
    const filter = {
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.account ? { account: query.account } : {}),
      ...(query.payee ? { payee: query.payee } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.review
        ? { review: query.review === "needed" ? "needs_review" : "reviewed" }
        : {}),
      ...(query.q ? { query: query.q } : {}),
      ...(query.descriptor_key ? { descriptor_key: query.descriptor_key } : {}),
    };
    const [register, index] = await Promise.all([
      booksRead<Register>(client, "transactions", {
        filter,
        page: { offset: query.offset, limit: query.limit },
      }),
      booksToday(service).then((today) => accountIndex(client, today)),
    ]);
    const reached = query.offset + register.entries.length;
    return {
      data: {
        total: register.total,
        needs_review_count: register.needs_review_count,
        offset: query.offset,
        limit: query.limit,
        next_offset:
          register.entries.length > 0 && reached < register.total
            ? reached
            : null,
        transactions: register.entries.map((entry) =>
          presentEntry(entry, index.names, index.profiles),
        ),
      },
    };
  },
);
