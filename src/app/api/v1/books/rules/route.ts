import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { booksClient, booksCommand, booksRead } from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Categorization rules, through the books' reader check (accounting.rules_list). */
export const GET = withApi(
  apiOperation("books.rules"),
  async ({ keyHash, service }) => {
    const result = await booksRead<{ rules: unknown[] }>(
      booksClient(service, keyHash),
      "rules",
      {},
    );
    return { data: { rules: result.rules } };
  },
);

/** Adds a rule that never posts on its own (auto_post is forced off in SQL). Create-only. */
export const POST = withApi(
  apiOperation("books.rule_create"),
  async ({ body, idempotencyKey, keyHash, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "rule.create",
      idempotencyKey,
      body,
    );
    return {
      data: {
        id: String(result.id ?? ""),
        version: typeof result.version === "number" ? result.version : null,
      },
    };
  },
);
