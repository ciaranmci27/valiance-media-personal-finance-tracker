import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { appUrl, booksClient, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Attention {
  as_of: string;
  checked_at: string;
  revision: string;
  alert: boolean;
  counts: { alert: number; info: number };
  items: { link?: string; [field: string]: unknown }[];
}

/** What needs the owner (accounting.attention), with links made whole for wherever the agent sends them. */
export const GET = withApi(
  apiOperation("books.attention"),
  async ({ query, keyHash, origin, service }) => {
    const result = await booksRead<Attention>(
      booksClient(service, keyHash),
      "attention",
      { params: { include_info: query.include_info === "true" } },
    );
    return {
      data: {
        as_of: result.as_of,
        checked_at: result.checked_at,
        alert: result.alert,
        counts: result.counts,
        items: result.items.map((item) =>
          item.link ? { ...item, link: appUrl(origin, item.link) } : item,
        ),
        revision: result.revision,
      },
    };
  },
);
