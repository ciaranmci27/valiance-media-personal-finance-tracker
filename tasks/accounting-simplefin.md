# SimpleFIN adapter and operations

Status: the Phase 1 schema and adapter are tested with synthetic fixtures. The server route port is step 6, and automatic draft creation in those routes is Phase 2. No live token was claimed and no real transactions were imported.

## Provider contract

The transport defaults to version 1. The parser accepts the v1.0.7 `errors`/`accounts` envelope and the v2 draft `errlist`/`connections` envelope. A v1 institution identity is derived deterministically from its organization metadata; account IDs are scoped to that institution. Malformed mixed envelopes fail conservatively. Amounts remain decimal strings until exact conversion to integer cents.

Both specifications define `posted` as Unix seconds representing an instant. Convert that instant once through `public.business_profile.books_timezone`. A timestamp near UTC midnight can legitimately have the previous local calendar date; retaining its UTC date would change its meaning. Tests cover midday, midnight, DST and invalid IANA zones. Pending timestamp zero never creates a financial date or journal entry. Source references: [v1 protocol](https://www.simplefin.org/protocol-v1.html), [v2 draft protocol](https://www.simplefin.org/protocol.html).

## Target database behavior

- `bank_connections` stores encrypted credentials and a fenced five-minute lease. `sync_server` is service-role-only and never impersonates the owner. Browser reads exclude the ciphertext and private checkpoint details.
- Discovery retains account metadata, not personal transaction lists. Only explicitly mapped company USD accounts retain observations. Ledger account and movement sign freeze once observations exist. The legacy balance sign is stored in the private checkpoint and freezes at the same boundary.
- Immutable posted observations carry original payload, source ID, description, hash and date. A changed existing provider record is retained as a conflict without overwriting evidence or advancing that account checkpoint. Missing/incomplete mapped accounts cannot mark a run wholly successful.
- Pending and zero-valued nonfinancial movements create no journal. Counts remain in the run audit. A previously posted record becoming pending/nonfinancial is a conflict, not an automatic reversal.
- Matching runs before draft creation. One unambiguous existing financial line is reused. Independent sources can corroborate an already fully allocated line with a zero allocation; the financial amount is never allocated twice. Ambiguous matches stay for review.
- The worker supports creating a draft from a posted observation, preserving the source description. Enabled rules and remembered treatment can fill its category, payee and memo. Tied rules, alias conflicts and previously categorized drafts are not silently changed. Auto-post requires an explicit rule setting and admin as the primary books system.
- `feed.prepare` remains a compatibility no-op. The HTTP worker enables the draft path in Phase 2. Closed-period observations remain unmatched on their actual date rather than being shifted.
- `feed.skip` requires a reason and records the checkpoint change in audit. It does not manufacture reconciliation or historical coverage. Disconnect stops scheduling and fences workers while retaining the encrypted credential and evidence; revoke a token separately in Bridge when appropriate.

## Security and deployment

Transport retains HTTPS host allowlisting, public-address DNS checks, pinned addresses, no redirects, time/size limits and redacted errors. AES-GCM uses the existing versioned encryption helper with `SIMPLEFIN_ENCRYPTION_KEY`, independently from other app secrets. Worker bearer authentication remains on the existing route.

## Shared core and scheduler (2026-09-17)

The parser, sync windows, request grouping and the run loop live in `supabase/functions/_shared/feeds/` and are imported by both the Next.js routes (alias `@feeds/*`) and the `sync-feeds` edge function. One run makes one all-accounts request per connection (accounts whose windows fit in 90 days share it), so a connection costs one SimpleFIN request per run against the 24-per-day guidance. The Node transport (DNS pinning) stays in `src/lib/accounting/server/simplefin-transport.ts`; the edge function uses `fetch` with the same host allowlist, no redirects, a 25s limit and a 20MB cap.

Schedule: pg_cron job `accounting-sync-feeds` runs hourly at :17 and posts to the edge function through pg_net (installed by `20260917075356_accounting_feed_cadence.sql`, skipped where pg_cron is unavailable). A complete run is due again after 110 minutes, so the effective cadence is two hours; a failed run waits an hour or the provider's Retry-After. SimpleFIN Bridge itself refreshes each bank about once a day at a drifting hour, which is the floor. Every tick stamps `accounting.feed_worker`; the Feeds card shows "worker checked in" from it and says so when no scheduler is calling. Sync on open (six-hour rule) is unchanged and remains the fallback.

Deploy, once, with the Supabase CLI signed in to the finance project:

1. Vault secrets in the SQL editor: `select vault.create_secret('https://kedxsjrbnrffrzdoyveh.supabase.co','accounting_project_url'); select vault.create_secret('<ACCOUNTING_WORKER_SECRET>','accounting_worker_secret');` (optionally `accounting_publishable_key`).
2. Edge secrets: `npx supabase@latest secrets set --project-ref kedxsjrbnrffrzdoyveh SIMPLEFIN_ENCRYPTION_KEY=<value> ACCOUNTING_WORKER_SECRET=<value>` (same values as `admin/.env`).
3. Deploy: `npx supabase@latest functions deploy sync-feeds --project-ref kedxsjrbnrffrzdoyveh` (`verify_jwt = false` comes from `supabase/config.toml`).
4. Apply the migration, then check `select * from cron.job;` and, after :17, `select id,status_code,content from net._http_response order by id desc limit 3;` and the Feeds card.

## Validation

`verify-accounting-simplefin.ts` exercises parsing, exact amounts, v1/v2 identity, timestamps, transport and encryption. `verify-accounting-banking.ts` exercises synthetic leases, repeat/conflicting observations, draft review, matching, transfer reversal and permissions against PGlite. The old feed database suite still requires its step 6 server-contract port; it is not evidence for the new schema until ported.
