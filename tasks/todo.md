# SimpleFIN sync cadence (2026-09-17)

Owner: bank feeds only pull when the books are opened (sync on open in the
shell, 6h staleness rule). Nothing calls `/api/accounting/jobs/feeds`: not the
repo, not the VPS crontab, not this PC, not the finance Supabase project (no
pg_cron or pg_net installed there). The Feeds card still prints "Next
background sync" because ACCOUNTING_FEED_WORKER_ENABLED=true. SimpleFIN Bridge
(MX upstream) refreshes each bank once a day at a drifting hour (observed
09-16: Chase 09:49, Amex 12:46 Phoenix), so the books trail Wave by about a
day. Goal: pull within two hours of every Bridge refresh while staying under
SimpleFIN's 24-requests-per-day guidance.

## Plan
- [x] Sync: one all-accounts request per run instead of one request per mapped
      account (8 per run today). Group identities whose windows fit inside 90
      days; keep per-identity checkpoints and the out-of-window checks.
      12 runs a day = 12 requests, under the daily guidance.
- [x] Scheduler SQL: after a complete run next_sync_at = now + 110 min (was 6h);
      `fail` honours retry_seconds from a 429 instead of a flat hour; sync_due
      keeps the 6h rule for sync on open. Migration + schema.sql edited in place.
- [x] Worker route: drain every due connection inside the 150s budget instead
      of only the first; stamp a worker heartbeat the UI can read.
- [x] Feeds UI: show "Next background sync" only when the heartbeat is within
      2x cadence; otherwise "Background worker has not run" plus the setup note.
- [x] Host the worker on Supabase (owner asked 2026-09-17): pg_cron + pg_net
      call a new edge function `sync-feeds` hourly at :17; a complete run is
      due again after 110 minutes, so the effective cadence is two hours. The
      call runs synchronously with a 120s pg_net timeout so the HTTP result
      lands in net._http_response. It checks x-worker-secret against
      ACCOUNTING_WORKER_SECRET (edge secret), decrypts the access URL with
      SIMPLEFIN_ENCRYPTION_KEY (edge secret, same v1:iv:tag:cipher AES-GCM
      format) and writes through the same accounting.sync_server RPC and lease
      the app uses, so "Sync now" and the cron never overlap.
- [x] Shared core: move the pure modules (parser + window, sync orchestrator,
      money.parseUsd, SimpleFinError + URL validation + message redaction)
      into supabase/functions/_shared/feeds/ with explicit .ts imports; the
      Next.js code imports them through a tsconfig alias (allowImportingTsExtensions).
      Replace Buffer.byteLength with TextEncoder and node randomUUID with
      crypto.randomUUID. The Node transport (DNS pinning) stays in src; the
      edge transport is fetch with the same host allowlist, redirect: manual,
      25s timeout and 20MB cap.
- [x] Migration: create extension pg_cron, pg_net; vault secrets project_url,
      sync_feeds_key (publishable key for the gateway) and worker_secret;
      cron.schedule('accounting-sync-feeds','17 */2 * * *', net.http_post(...)).
      Also re-schedule process-automations every 15 min while there (it lost
      its cron in the project move).
- [x] Deploy notes for the owner: supabase/config.toml (project_id, verify_jwt),
      `npx supabase functions deploy sync-feeds`, `supabase secrets set` for
      SIMPLEFIN_ENCRYPTION_KEY + ACCOUNTING_WORKER_SECRET, apply migration.
- [x] .env.example: document SIMPLEFIN_ENCRYPTION_KEY, ACCOUNTING_WORKER_SECRET,
      ACCOUNTING_FEED_WORKER_ENABLED and the cron line.
- [x] Tests: verify-accounting-feed-sync (request grouping), feed-db (cadence),
      production route (drain), schema parity; lint; tsc.

Side finding, out of scope: the new finance project has no pg_cron/pg_net, so
the process-automations edge function is not scheduled there either.

## Review

Done 2026-09-17, except the two deploy steps only the owner can run (Vault +
edge secrets, `functions deploy sync-feeds`). Suites: simplefin (98), feed
sync (57), feed db (41), schema parity (16 comparisons, 28 tables), lint,
prettier, tsc all green; verify-accounting-all run as a regression pass. The
HTTP and production suites need `--integration` with isolated endpoints and
were not run. The edge function is not type-checked locally (no Deno on this
PC); its shared core is exercised by the Node suites, only index.ts is
Deno-only. Not verified in a browser: the Feeds card label needs a signed-in
session against the finance project.

Left out on purpose: re-scheduling process-automations (it is unknown whether
that function is deployed on the new project; a failing 15-minute job would be
noise), a separate migration file for this feature rather than appending to
the staged team-access migration from the other session (different feature,
different commit).

Gotchas: large heredocs with quoted delimiters failed to parse in this shell
three times; write TS and SQL through the Write tool or a Python file. The
Web Crypto `BufferSource` parameters need a cast under TS 5.7 Uint8Array
generics. `syncWindow` rejects a checkpoint before history_start, so grouping
fixtures need a matching history start.

# Transaction search (2026-09-15)

Owner: the ledger search only matched memo and the raw bank descriptor with one
contiguous ILIKE. Card numbers, amounts, contacts, categories and dates were not
searchable. Make it robust without over-building: no new extensions, no
ranking, no saved searches.

## Plan
- [x] SQL: `accounting.search_terms(text)` tokenizer (quoted phrases, whitespace
      words, amount / whole-dollar / compare terms, LIKE escaping, 12-term cap)
- [x] SQL: `accounting.transactions` builds one lowercased document per entry
      (memo, descriptor, kind, dates in four spellings, contact name, line
      account code + name + memo + formatted amounts, bank institution + mask,
      matched bank descriptions) and requires every term to match (AND);
      amounts match any line or the entry magnitude; `>`/`<` compare magnitude
- [x] Migration `20260915135116_accounting_search.sql` + grants; canonical
      `schema.sql` edited in place (function body byte-identical)
- [x] TS mirror `src/lib/accounting/search.ts` for demo mode and tests
- [x] Ledger UI: demo filter uses the mirror; search-specific empty state;
      placeholder names what is searchable
- [x] `scripts/verify-accounting-search.ts`: SQL and TS parity over a seeded
      ledger (phrase, AND, amount, dollars, card mask, contact, category,
      date, compare, wildcard safety)
- [x] Run: search, transactions, schema, preload suites; lint; tsc

## Review
(filled in when done)

Done 2026-09-15. Suites: search (154), transactions (27), schema parity (16),
preload, lint, prettier, tsc all green. Left out on purpose: pg_trgm or a
search index (the ledger is small and the document is built per row at query
time), relevance ranking, match highlighting, saved searches, and a change to
the bank-review search, which still matches memo only.

Gotcha met on the way: the canonical schema.sql is hand-mirrored, and a JS
String.replace with a string replacement expands "$'" inside SQL regexes and
corrupted the file once; splice with a function replacer. Every accounting
function must be SECURITY DEFINER with search_path '' (verify-accounting-schema
enforces it), including pure helpers.

Full runner: 51/53. The two that fail, verify-accounting-db.ts and
verify-accounting-drop.ts, fail identically with the search migration removed,
so they predate this work and are not touched here.

# Team access and account theme (2026-09-15)

Owner: add a Team page with team_members and team_member_permissions like the
app workspace, and make the Appearance theme save to the account. Decisions:
books open to members with accounting.manage; permissions enforced in RLS;
owner sets the initial password when adding a member.

## Plan
- [x] Migration `20260915145008_team_access.sql`: team_members, role_permissions,
      team_member_permissions, helpers (current_team_member_id, role,
      has_permission, my_access, bootstrap_team_owner), guard trigger, seeds,
      RLS rewrite on live public tables, require_owner / document_access /
      operate bootstrap, business_profile_get membership check
- [x] Snapshot: `-- ACCOUNTING TEAM` region in schema.sql, policy blocks edited
      in place, catalog functions mirrored byte for byte, automations.sql policies
- [x] Harness: accounting-schema.ts filename regex, verify-accounting-schema.ts
      parity filters, fixture owner team row, `scripts/verify-team.ts`
- [x] Server: resolveAccess (demo, dev bypass, allow-list, bootstrap),
      requireAuth carries member + permissions, invite and email routes
- [x] Client: access context, dashboard layout gate, sidebar filter + footer,
      /team page with add, edit and permissions dialogs, page access cards,
      settings index Team card, accounting page copy
- [x] Theme: theme_preference on team_members, inline first-paint script,
      provider re-apply, appearance selector saves to the account
- [x] Types, .env.example, run schema parity, verify-team, tsc, lint, browser

## Review
Done 2026-09-15. Migration 20260915145008_team_access.sql is a fresh file; the
staged 20260915135116_accounting_search.sql belongs to the search feature and
was left alone so the two commits stay separate. Suites: verify-team (58),
schema parity (16, team objects now diffed), setup (62). tsc clean; eslint on
the changed files shows only three pre-existing dashboard warnings. Browser:
demo server on 3003 (another session, same tree) rendered /team, Add member,
Roles and permissions; screenshots under .playwright/.

Left for the owner: apply the migration to the finance project, sign in once
(the first sign-in claims the owner row), then add people under Team. The
theme selector saves to team_members.theme_preference; the dashboard layout
seeds the first paint from it, so a new device follows the account.

Gotchas met: a SECURITY DEFINER function still sees current_setting("role") as
authenticated, so the guard bypass is a transaction flag set by the bootstrap
RPC plus a no-session direct-database check; RLS WITH CHECK violations raise
rather than filter, so the test wraps them; the pglite harness only applies
migrations matching its filename regex and only loads the ACCOUNTING regions
of schema.sql, so the team objects live in an ACCOUNTING TEAM region that
loads before the catalog.

Follow-up 2026-09-15: read-only members no longer see write controls inside
pages their read key opens. Income list/detail/sources, expenses list/detail,
net worth list/detail and the tax estimator each take canManage =
hasPermission("<module>.manage") and render-gate every add, edit, delete,
toggle and inline field (TaxInputsCard, TaxHero, TaxBooksCallout and
QuarterTile gained readOnly / optional handler props; the setup wizard shows
an empty state instead). Owner view verified on the demo server; the
read-only branch is covered by tsc and code review until a real member exists.

Follow-up 2026-09-15: the privacy eye moved from browser data to the account.
team_members.privacy_hidden (in the same migration) is the source of truth;
PrivacyProvider takes the account value and a persist callback, the dashboard
layout seeds data-hidden before paint, cookie and localStorage stay as the
mirror for the root blocking script. Managers cannot flip another person's eye
(guard). Team suite 59 checks, parity 16.

Follow-up 2026-09-17: Appearance gained a Display section with a Show Net
Worth switch. team_members.show_net_worth (new migration
20260917073109_team_access_preferences.sql, default true) hides the Net Worth
rail entry and the dashboard tile and chart for that person only; the pages
stay reachable. Snapshot lists the column last to match the live attnum, and
the harness regex now accepts team_access.* migrations.

Follow-up 2026-09-17: the dashboard shows the company books when the session
can open them (server probe via accountingClient, plus accounting.manage).
books-panel.tsx reads the month workspace, the twelve-month P&L report, manage
profiles and the recent posted register, all keyed as the accounting shell
warms them. BooksSummary = month tiles + cash flow; BooksRecent sits in the
bottom row beside Expense Summary, which also fills the slot Net Worth leaves
when hidden. Reads fail silently so the dashboard never blocks on the books;
demo mode uses getAccountingDemo() and says the sample has no monthly history.

Follow-up 2026-09-17: one dashboard instead of two stacks. Top row is a
sideways stat strip (no scrollbar, arrows from lg, swipe on phones) built from
the permission keys: Income this month (books, else income tracking), Business
expenses and Net profit (books), Personal expenses (fixed expenses), Net
position (net profit less personal expenses), Cash in bank (books + feeds),
Net worth (key + show_net_worth). Middle row: Cash flow (6mo default) and
Income trend (6mo default). Bottom row: Recent transactions and Expense
summary. The Company books heading, the income donut, the net worth chart and
the tracker's Monthly Expenses and Net Position tiles are gone.
