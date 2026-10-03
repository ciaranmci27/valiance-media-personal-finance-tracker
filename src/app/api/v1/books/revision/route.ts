import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksClient, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the books' revision read answers: the counter and the work signal (accounting.work_signal), from one snapshot. */
interface Revision {
  revision: string;
  actionable_drafts: {
    count: number;
    fingerprint: string;
    newest_at: string | null;
  };
  contacts_needed: { count: number; since: string };
}

/** The books' change counter (accounting.revision) and what an agent can act on, cheap enough to poll. */
export const GET = withApi(
  apiOperation("books.revision"),
  async ({ keyHash, service }) => {
    const result = await booksRead<Revision>(
      booksClient(service, keyHash),
      "revision",
      {},
    );
    return {
      data: {
        revision: result.revision,
        actionable_drafts: result.actionable_drafts,
        contacts_needed: result.contacts_needed,
      },
    };
  },
);
