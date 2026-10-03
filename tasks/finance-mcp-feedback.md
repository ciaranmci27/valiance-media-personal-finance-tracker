# Finance MCP: feedback from the agent side (2026-10-03)

From the session building the finance agent in `valiance-media-agents`, after reading
`finance-agent-brief.md`, the admin source, and probing production. Ranked by what
blocks the agent first.

## P0: blockers

1. **Production does not serve `/api/v1` yet.** Unauthenticated `GET /api/v1/openapi.json`
   and `GET /api/v1/books/revision` return the session middleware's
   `{"error":"Sign in to access this resource."}` (401), never the API envelope. The
   `/api/v1/` exemption in `src/lib/supabase/middleware.ts` is a working-tree change, not
   deployed. The documented-public OpenAPI route is blocked too. The agent cannot be tested
   against REST until this ships.
2. **No `version` on transaction reads, so no draft write can succeed.** `presentEntry`
   (`src/lib/api/books.ts:120-161`) drops it, and the `transaction` schema
   (`src/lib/api/operations.ts:211-251`) lacks it, yet categorize, split, bulk and replace
   all require `expected_version` (`operations.ts:987, 1004, 1028, 1077`). The verify
   harness reads it from Postgres directly (`scripts/verify-api-http.ts:222-224`), which
   hides the gap. Add `version` to `presentEntry` and the schema.
3. **`books_search_transactions` is refused at its default size.** ~1.06 KB per two-line
   transaction x default limit 50 (`operations.ts:451`) = ~53 KB, over the MCP cap
   `MAX_RESULT_CHARS = 40_000` (`src/lib/mcp/server.ts:29`). The cron's first call
   (`review=needed`, no limit) fails as `result_too_large`. Default 20, cap 50, and ideally
   a compact list projection (drop `lines`, `created_at`, `cash_class` from list rows; keep
   them in `books_get_transaction`).

## P1: needed for the categorize workflow

4. **Expose `descriptor_key` and `prior_treatment` on transactions.** `entry_detail`
   computes both (`supabase/schema/schema.sql:3844-3854`); `presentEntry` drops them. Rules
   match only on `conditions.descriptor_key` (`operations.ts:153`), so without it
   `books_propose_rule` is guesswork. `prior_treatment` (last category, payee, count) is the
   confidence signal for categorizing.
5. **Add `payee_name` to transaction rows** (only `payee_id` today, `books.ts:148`), so
   naming a payee does not require pulling the whole payee list.
6. **Add `categorized=false` (or `review=uncategorized`).** `review=needed` also returns
   drafts that rules already categorized, which only need the owner.
7. **Let unpaginated lists narrow.** `books_list_payees` and `books_list_rules` take no
   parameters (`operations.ts:920, 944`); accounts has no limit (`operations.ts:362-367`).
   ~270 chars per row hits the 40K wall at 150-200 rows, and the refusal hint suggests a
   date range these endpoints do not have. Add `q`, `limit`/`offset`, `type`/`kind`
   (e.g. `type=expense`), and an endpoint-appropriate hint.
8. **Absolute `review_url`, on every write.** Relative today (`books.ts:222`), so it is not
   clickable in Telegram. Rule and payee creates return none (`operations.ts:1111, 1133`).
9. **Hints on refusals.** `stale_version`, `not_a_draft`, `rate_limited`, `not_found`,
   `invalid_parameters`, and most `books_refused` codes lack one (`src/lib/api/http.ts:117-224`).
   Also expose `pair_entry_id`, so a draft that is half of a proposed transfer is visible
   before a write is refused.

## P2: retrieval and descriptions

Hermes matches on name plus first sentence (`src/lib/mcp/tools.ts:16-19`).

10. Leads in the owner's words:
    - `books_search_transactions`: "drafts needing review or categorizing, uncategorized, imported bank transactions".
    - `books_list_accounts`: "categories, chart of accounts".
    - `books_get_report`: "spending by category or vendor, balance sheet, cash flow".
    - `books_summary`: "revenue", "spending".
    - `books_create_draft`: "adjustment (accrual, depreciation), not bank transactions".
11. Separate tracker from books: start tracker leads with "Owner's manual tracker:" and put
    "official" in books leads, so "what did I spend" and "income" do not collide.
12. Use tool names, not REST paths, in descriptions (`/books`, `GET /tracker/income` at
    `operations.ts:564, 608, 739`).
13. `books_categorize_drafts_bulk` is annotated `destructiveHint:false` (`tools.ts:224`)
    but changes drafts.
14. Expose `limit` on `books_account_ledger` (fixed at 100 lines, ~22 KB, `schema.sql:5366`).
15. Report `values` mix cents strings with `"12.50%"` (`operations.ts:279`): add a per-column
    unit, or state the convention in `finance_guide`.

## Already right

All 32 tools match the brief by name, scope-filtered per key. `mode` defaults to
`working`. `quality` is on summary and reports. `books_revision` is a cheap counter.
Creates are idempotent with `replayed:true`. Draft writes return `{id, version, status,
review_url}`. Refusals are `{ok:false, status, error:{code, message, reason, hint?}}`. All
money is integer-cents strings. Drafts-only and rules-off are enforced in SQL.

## Hermes client facts (pinned v2026.7.20) the server can rely on

- Tool names arrive as `mcp__finance__<tool>`. Tool Search is `auto` (on only past 10% of
  context), so with ~32 tools the full list is likely sent every turn.
- Handshake is always the legacy `initialize` (no `protocol` option in this version).
- No `trust` tiers in this version: every MCP call runs without an approval prompt. The
  read-only pilot relies on the key's scopes, which the server enforces.
- `${FINANCE_MCP_KEY}` resolves from the container environment.
