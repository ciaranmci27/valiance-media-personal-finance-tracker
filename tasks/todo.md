# Transfer auto pairing and fill indicators (2026-09-19)

Owner: a card payment lands as two rows in Review (-$31.64 "Debit to AMEX
EPAYMENT" on Checking, +$31.64 "AUTOPAY PAYMENT - THANK YOU" on the card) and
nothing pairs them. Today the only help is a transfer option hidden inside the
category dropdown, found by a client-side search of the current page
(`transferCounterpart`, accounting-transactions.tsx:879), so a counterpart on
another page is never seen. Sync (`sync_server`) drafts each leg on its own
and `apply_treatment` only knows aliases, rules, prior treatment and payee
default. Separately, a row the books filled at sync time looks identical to
one the owner chose: `applied_rule_id` is stored and already returned by
`entry_detail` but the ledger never reads it, and prior treatment and payee
default fills leave no trace at all. Drafts count in the owner's numbers
(all activity), so a wrong silent fill or a wrong silent pair is the risk to
design against. No LLM anywhere: deterministic signals only.

## Design

Proposed pair = the two existing bank drafts, kept, each recategorized from
Uncategorized to Transfers in transit with kind `transfer`, pointing at each
other. `entry.categorize` already accepts the transit account and keeps the
bank line id, so both bank matches stay attached and nothing is discarded or
recreated. Confirming posts both legs under one `transfer_group_id`, which is
exactly the shape `transfer.create` writes for a cross-date transfer and the
shape `transfer.link` validates, so reverse, restore and the reports work
unchanged. Same-day pairs also go through transit and net to zero that day.
While proposed, the legs sit on the balance sheet, so income and expenses are
no longer inflated by the pair.

`transfer_group_id` is NOT used for the proposal: the guard makes it immutable
once set (ACCT_TRANSFER_GROUP_IMMUTABLE) and the UI treats it as a real
transfer (reverse flow, not editable). The proposal lives in two new columns.

Two rows stay two rows. The ledger is paginated, sorted and filterable by
account, so one merged row would break under an account filter or across a
page edge. Each leg reads "Transfer to Amex -2005" / "Transfer from Checking
-6491"; confirming either leg confirms both and both leave Review.

The gate (all required), mutual: entry is a draft from simplefin or csv with
one bank line and a suspense category, not already paired, never unpaired by
the owner before; exactly one other such draft on a different own account with
the opposite amount inside `transfer_window_days`, both dates in open periods;
and that counterpart in turn has exactly one candidate (this entry). Two $500
outflows and one $500 inflow is ambiguous and pairs nothing.

Signals, strongest first; the gate plus any one pairs, the gate alone only
suggests:
1. `learned`: a posted, unreversed transfer group exists between the same two
   accounts in the same direction whose matched bank observations carry these
   two descriptor keys (read through bank_matches to bank_transactions, since
   entries from `transfer.create` have no descriptor key of their own).
2. `names_account`: one leg's source description contains the other account's
   institution name or mask from `bank_accounts` (mask match needs 4 digits).
3. `keyword`: source description (not descriptor_key, which strips PAYMENT)
   matches a short list: TRANSFER, AUTOPAY, EPAYMENT, E-PAYMENT, PAYMENT THANK
   YOU, ONLINE PMT, MOBILE PMT. Cold start only.
Deferred, not in this build: the "money into a card with no merchant" shape
(needs real refund rows first) and per-pair auto post after N confirmations.

## Plan
- [x] Migration `<ts>_accounting_transfer_pairing.sql` (one file for the whole
      feature) + schema.sql edited in place, never regenerated:
      `journal_entries.fill_source text null check in ('rule','prior',
      'payee_default','transfer_pair')` and `pair_entry_id uuid null references
      journal_entries(id)`, index on pair_entry_id. Guard: both columns may
      only be non-null on drafts; add both to the posted-immutable allowlist
      handling so posting can clear them.
- [x] `accounting.transfer_candidate(entry uuid) returns jsonb`, STABLE, same
      grants as `rule_candidate` (postgres only). Returns counterpart id,
      eligible, signal, and the counterpart account name and date. One
      function serves both the sync-time pairing and the read-time suggestion.
- [x] `apply_treatment`: stamp `fill_source` after each successful fill
      (`rule` beside the existing applied_rule_id write, `prior`,
      `payee_default`). Then, only if the entry is still uncategorized, call
      `transfer_candidate`; when eligible with a signal, categorize both legs
      to transit with kind `transfer`, set pair_entry_id both ways and
      fill_source `transfer_pair`, and write a `transfer.paired` audit row on
      each leg carrying the signal. Runs for feed sync and file import alike
      since both already call apply_treatment. Transfer check runs last so an
      owner rule always wins.
- [x] `banking_command`: `transfer.confirm` (either leg id + both expected
      versions; re-verify both are drafts, still bank line + transit line,
      opposite amounts; set one transfer_group_id on both, clear pair and
      fill_source, post both, atomic) and `transfer.unpair` (both legs back to
      their suspense account and income/expense kind, clear pair and
      fill_source, audit `transfer.unpaired` so the gate never re-pairs them).
      Zod schemas in lib/accounting/transfers.ts, permission mapping in
      server/access.ts beside the existing transfer commands.
- [x] `ledger_command` safety: `entry.post`, `entry.review`, `entry.bulkpost`
      and `transaction.review` refuse a leg with pair_entry_id
      (ACCT_TRANSFER_PAIR_CONFIRM) so one leg can never post alone.
      `entry.categorize`, `entry.split`, `draft.save` and the discards on a
      paired leg unpair first, then proceed. Every owner categorize or split
      clears fill_source; apply_treatment re-stamps after its own call.
- [x] `entry_detail`: add `fill` for drafts (source, rule name when source is
      rule, counterpart account name and date when transfer_pair) and
      `transfer_suggestion` for gate-only matches from `transfer_candidate`.
      This replaces the page-local `transferCounterpart` search, which is
      deleted. Check the read cost on a 100 row page; if it shows, compute the
      suggestion only for uncategorized drafts (it already is gated that way).
- [x] Contracts: `fill_source`, `pair_entry_id`, `applied_rule_id`, `fill` and
      `transfer_suggestion` on JournalEntry; presentTransaction reports a
      paired leg as a transfer that is not editable.
- [x] Ledger UI, one indicator pattern: the existing copper sparkle line under
      the row (where "Previously X [Use]" sits today, desktop row and mobile
      card both). Filled rows: "Filled by rule: Adobe", "Same as last 3
      times", "Payee default". Paired rows: "Transfer to Amex -2005" with
      [Confirm] and [Not a transfer]. Gate-only rows: "Looks like a transfer
      to Amex -2005 [Pair]" opening the existing AccountingTransferFromDraft
      dialog. Text carries the meaning, the sparkle is aria-hidden, buttons
      get focus-visible rings and busy states like the existing Use button.
      The row check on a paired leg dispatches transfer.confirm; bulk review
      sends one confirm per pair and skips the second leg. Picker keeps its
      transfer option, now fed by `transfer_suggestion`.
- [x] History panel labels in accounting-evidence.tsx: `transfer.paired`
      "Paired as a transfer", `transfer.confirm` "Transfer confirmed",
      `transfer.unpaired` "Marked not a transfer".
- [x] Backfill, run once inside the migration: apply the same pairing to
      existing uncategorized bank drafts in open periods (covers the two
      $31.64 rows). No backfill of fill_source for already filled drafts
      except `rule` where applied_rule_id is set and the category still
      matches the rule's action.
- [x] Tests: new `scripts/verify-accounting-transfer-pairing.ts` (PGlite
      harness, added to test:accounting:all): each signal pairs; gate only
      suggests; two candidates pair nothing; non-mutual pairs nothing; rule
      match beats pairing; lone post refused; confirm posts both with transit
      at zero after the later date and zero income/expense; unpair restores
      both and is never re-paired; owner recategorize of one leg frees the
      other; learned signal fires on the second month; locked period skipped;
      fill_source stamped and cleared. Re-run banking, rules, transfers,
      transactions and schema parity suites.
- [ ] (partial: rendering checked in demo; live clicks wait on the migration) Verify in the browser with real pointer clicks (lessons rule): sparkle
      lines on both themes, Confirm, Not a transfer, Pair, keyboard path,
      account-filtered view showing one leg, mobile cards.

## Owner decisions (2026-09-19)
Keyword list approved as written. Backfill yes, open periods only. Migration
goes in before the app deploy.

## Review
Built 2026-09-19. Migration 20260919175400_accounting_transfer_pairing.sql is
generated from the hand-edited schema.sql (function bodies byte-identical);
schema parity passes (16 catalog comparisons).

Changed from the plan:
- One leg can never post alone is enforced in the entry guard trigger
  (ACCT_TRANSFER_PAIR_CONFIRM when a paired draft leaves draft), not per
  command, so entry.post, entry.review, entry.bulkpost, transaction.review and
  rule auto post are all covered by one check. draft.save on a paired leg is
  refused; categorize, split and discard unpair first.
- prior_summary now ignores entries with a transfer_group_id. Without this a
  confirmed pair would become "what you chose last time" for its descriptor
  and the next month's leg would be filled to transit alone instead of paired.
- The paired line reads "Transfer to X, date" plus [Not a transfer]; the row's
  own check confirms (tooltip and aria-label say "Confirm transfer"). A
  separate Confirm button duplicated the check and truncated on phones.
- transfer_suggestion also returns for ambiguous matches (nearest date,
  ambiguous true) so the picker keeps today's transfer option; ambiguous never
  pairs.
- The backfill runs through a temporary definer function called as
  service_role, because ledger_command only skips the owner check for the
  worker role. The function is dropped in the same migration.

Verified:
- New suite verify-accounting-transfer-pairing.ts: 51 assertions (each signal,
  gate only, ambiguity, window, known treatment wins, lone post refused three
  ways, confirm, learned on month two, unpair never re-proposed, categorize
  and discard free the other leg, fill markers set and cleared).
- test:accounting:all: 52 of 54 pass. verify-accounting-db.ts and
  verify-accounting-drop.ts fail the same way with this migration moved
  aside, so they were already failing; not touched here.
- tsc clean, prettier clean on touched files.
- Browser (admin-demo, temporary sample drafts, since removed): all four
  indicator lines render on desktop rows and mobile cards, paired legs read
  "Transfer", check aria-label reads "Confirm ... as a transfer".

Not verified: Confirm, Not a transfer and Pair clicked against a live
database. Demo mode disables row actions and the finance project does not have
the migration yet. Click through these three after applying it.

Follow-up 2026-09-19 (owner: the hint line made those rows two lines tall):
the sparkle line under the description is gone, including the older
"Previously X [Use]". Every row is one line again. A proposed leg names the
other account in its Category cell ("Transfer to ... -2005", date in the
tooltip); "Not a transfer" moved to the row's actions menu; the check still
confirms. Filled rows carry a sparkle beside the picker with the reason in its
tooltip; "Looks like a transfer" and "Previously X" are the same sparkle as a
button that pairs or applies in one click. The sparkle hangs in the column
gutter so category names stay aligned. Checked in admin-demo on desktop and
phone widths with temporary sample drafts, since removed.

Follow-up 2026-09-19, same migration file:
- entry_detail returns transfer_account_id for any entry in a transfer group,
  so posted legs read "Transfer to X" / "Transfer from X" like proposed ones.
- The pager only trusts a total that belongs to the current filter, so it no
  longer flashes the previous tab's count while Review or Deleted loads.
- One-off link backfill for imported (Wave) transfers: posted two-line entries
  against the in-transit account, unlinked and unreversed, paired when there is
  exactly one candidate each way inside transfer_window_days, then in date
  order when every candidate sits between the same two accounts. It only sets
  transfer_group_id (irreversible by the guard), so transfer_link_backfill(false)
  previews through a rolled-back subtransaction. Temporary functions, dropped in
  the migration; the suite verify-accounting-transfer-link-backfill.ts runs the
  SQL between the markers in the migration file (17 assertions). A linked leg
  is no longer editable on its own and deletes with its other side.

Link backfill on the real books (2026-09-19): first run linked 305 transfers
on one candidate each way and left 18 legs in four groups: chains through one
account (A to B, B to the card, same amount) and same-day twins. Two passes
added between strict and date order: named (bank text carries the other
account's number, best match unique each way; the number comes from the feed
mapping or the end of the account name) and twins (two or more candidates, all
one account on one day, so interchangeable). Any progress restarts from
strict. Suite now 26 assertions with those shapes.

Deferred: "money into a card with no merchant" signal; per-pair auto post.

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
