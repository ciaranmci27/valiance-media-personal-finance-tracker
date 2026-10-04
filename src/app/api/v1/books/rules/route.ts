import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import {
  appUrl,
  booksClient,
  booksCommand,
  booksRead,
  contactRuleFields,
  payeeFields,
  nameMatches,
  pageOf,
} from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Rule {
  name: string;
  enabled: boolean;
  review_status: "suggested" | "confirmed";
  conditions?: Record<string, unknown>;
  actions?: Record<string, unknown>;
}

/** Categorization rules, through the books' reader check (accounting.rules_list), in their order, searched and paged. */
export const GET = withApi(
  apiOperation("books.rules"),
  async ({ query, keyHash, service }) => {
    const result = await booksRead<{ rules: Rule[] | null }>(
      booksClient(service, keyHash),
      "rules",
      {},
    );
    const matching = (result.rules ?? [])
      .filter(
        (rule) => !query.enabled || String(rule.enabled) === query.enabled,
      )
      .filter(
        (rule) =>
          !query.review_status || rule.review_status === query.review_status,
      )
      .filter((rule) => nameMatches(rule.name, query.q));
    const { rows, ...page } = pageOf(matching, query);
    return {
      data: {
        ...page,
        rules: rows.map((rule) => ({
          ...rule,
          conditions: contactRuleFields(rule.conditions),
          actions: contactRuleFields(rule.actions),
        })),
      },
    };
  },
);

/** Adds a rule that never posts on its own (auto_post is forced off in SQL). Create-only. */
export const POST = withApi(
  apiOperation("books.rule_create"),
  async ({ body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "rule.create",
      idempotencyKey,
      {
        ...body,
        conditions: payeeFields(body.conditions),
        actions: payeeFields(body.actions),
      },
    );
    return {
      data: {
        id: String(result.id ?? ""),
        version: typeof result.version === "number" ? result.version : null,
        review_url: appUrl(origin, "/accounting?view=manage&section=rules"),
      },
    };
  },
);
