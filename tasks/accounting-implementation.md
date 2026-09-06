# Accounting implementation record

Updated 2026-09-05. Ledger, daily imports/evidence, reconciliation, close/filing history, and independent historical verification are implemented and tested in synthetic books. Transfers, bank connection management, invoice/payroll subledgers, extended reports, tax linkage, and restore acceptance remain in progress. Requirements remain in [accounting-spec.md](accounting-spec.md), with gates in [accounting-build-plan.md](accounting-build-plan.md).

## What works in this slice

- A separate `/accounting` screen with Overview, Journal, Chart of accounts, and Reports. Existing personal finance and tax flows keep their current behavior.
- Create accounts; create and edit journal drafts with line memos; review and post; discard drafts with a reason; copy an entry as a new draft; reverse a posted entry into an open date. Original and reversal entries link to each other.
- Exact USD cents throughout input, database commands, SQL aggregation, JSON transport, display, and audit exports. Debits are positive and credits negative internally. No floating-point money calculations enter the live report path.
- PostgreSQL functions for posted profit and loss, balance sheet, and trial balance, including opening balances and continuous prior-year earnings. Drafts are excluded. Account rows open their matching journal entries in the selected range.
- An authenticated JSON export containing all foundation rows, independent of the register's 200-entry display limit. It explicitly marks coverage unverified and does not include attachment files.
- Read-only synthetic demo data, with all real accounting reads and writes denied in demo mode.

The screen labels this as a ledger foundation. It does not imply historical coverage, bank reconciliation, cash-basis import normalization, or tax readiness merely because the trial balance is zero.

## Database and command boundary

The new migration is [20260905203346_accounting_foundation.sql](../supabase/migrations/20260905203346_accounting_foundation.sql). The same definitions are included in the canonical [schema.sql](../supabase/schema/schema.sql), with a test that verifies parity. No existing committed migration was changed. The owner reported applying this migration and enabling the environment flag. Browser inspection confirms that the live app reaches the accounting owner-setup gate; setup is not yet complete.

`acct_settings` has one explicitly configured owner. An unset owner means no accounting access. The existing general admin email allowlist or development auth bypass does not grant accounting access. Cookie-authenticated server requests use the owner's Supabase session, never the service client.

All accounting table grants are revoked from `anon`, `authenticated`, and `service_role`, and RLS is enabled. Authenticated users can execute only the small owner-checked command/read/export surface. Internal helper functions cannot be called through those roles. This is an internal UI endpoint, not the deferred public REST integration.

Each command runs in one database transaction. Commands acquire the singleton company lock before entry/account/period locks. Statement and row triggers protect direct DML as well. Owner checks run before and after waiting for the command lock. Immutable receipts bind a request UUID to its original actor, payload, and result. Draft versions reject stale saves; posted and discarded rows cannot be edited or deleted. Deferred checks enforce balanced posted entries even if a caller bypasses the posting function. Closing guards refuse a month that still contains drafts.

Source observations, entry-source links, document metadata, and audit rows have initial identities and immutability constraints. Uploads, workers, and provider adapters do not yet use them. PostgreSQL administrators capable of changing grants or disabling triggers remain outside the application's trust boundary.

The browser reuses a request key when retrying the same command after an ambiguous response. A changed payload gets a new key. Request state is not yet durable across a browser restart; replay across tabs/reloads and a full operation-history UI remain follow-up work.

## Local demo

No Supabase migration or company data is needed for the synthetic accounting screen. From the repository root in a separate PowerShell terminal:

```powershell
$env:NEXT_PUBLIC_DEMO_MODE = 'true'
$env:NEXT_PUBLIC_ACCOUNTING_ENABLED = 'true'
$env:APP_ENV = 'test'
npm run dev -w admin
```

Open `/accounting` on that server. The demo uses a fixed January-February 2026 range and disables edits and date changes. It includes prior-year activity in opening balances. Do not treat its named invoice or salary entries as evidence that those subledgers have been built.

The normal environment example keeps `NEXT_PUBLIC_ACCOUNTING_ENABLED=false`. This is a build-time public feature flag, so restart development or rebuild a deployed bundle after changing it. The flag controls availability; database owner authorization controls access.

## Staging setup, when continuing integration

1. Use a separate Supabase staging project with a known owner sign-in. Apply the new migration once using the project's migration workflow. It creates new objects in a transaction and fails if those objects already exist; do not run it repeatedly as a repair script.
2. In staging, inspect the intended owner's existing `auth.users` record and copy that exact UUID. Provision the single settings row as a database operator, replacing both placeholders below. There is no automatic first-user assignment, synthetic owner seed, or production user UUID in the migration.
3. Configure the admin staging app with that project's existing URL and anon key, real authentication, `NEXT_PUBLIC_DEMO_MODE=false`, and `NEXT_PUBLIC_ACCOUNTING_ENABLED=true`. Rebuild/restart, sign in as the chosen owner, and open Accounting. Verify another signed-in account is refused as well.
4. Create a staging chart and synthetic journals through the UI. Perform the outstanding concurrency and browser checks below before proceeding to real-data imports.

```sql
INSERT INTO public.acct_settings (owner_user_id, legal_name)
VALUES ('REPLACE_WITH_OWNER_AUTH_USER_UUID'::uuid, 'REPLACE_WITH_LEGAL_COMPANY_NAME');
```

A duplicate settings insert fails instead of silently transferring ownership. Account templates/system purposes and Wave account mapping still need implementation, so this slice intentionally does not seed a real chart. Do not use the synthetic fixture accounts as a historical Wave mapping.

## Checks and evidence

Run from the repository root after installing the workspace dependencies:

```powershell
npm run test:accounting -w admin
npm run test:accounting:db -w admin
npm run lint:accounting -w admin
npx tsc --noEmit -p admin/tsconfig.json
npm run test:tax -w admin
npm run build -w admin
```

`npm run format:accounting -w admin` formats only this slice. `lint:accounting` uses ESLint directly with the installed Next rules. The older general `lint` script still names `next lint`, which Next 16 no longer provides; it is not the accounting verification command.

Evidence recorded for this slice:

| Check | Result |
| --- | --- |
| Exact money, real calendar dates, command validation, generated split allocations | 591 checks passed |
| Migration/canonical parity and PostgreSQL behavior | 73 assertions passed in an isolated PGlite database |
| Existing tax engine | 88 checks passed before and after this work |
| Accounting ESLint | Passed |
| Admin TypeScript | Passed |
| Admin optimized production build | Passed with synthetic demo and Accounting enabled |
| HTTP route smoke | Accounting renders synthetic data; demo API reads/writes and foreign-origin writes return 403; Income, Expenses, and Net Worth return 200 |
| Browser interaction and desktop/mobile screenshots | In progress in the logged-in Codex browser, explicitly authorized by the owner instead of Playwright |

The compact synthetic company has independently calculated controls: January-February revenue $1,900, expenses $1,150, net income $750, assets $12,780, liabilities $30, shareholder capital $10,000, prior-year earnings $2,000, and current-year earnings $750. The $500 transfer sits in transit at January end and clears in February. These are financial-line fixtures; invoice allocation, payroll detail, split-purchase and repeated-source-observation fixtures still need their full workflows.

The database checks exercise real PostgreSQL SQL, PL/pgSQL, role grants, row guards, and deferred constraints. Only Supabase's auth table/UID contract is stubbed. They test original/reversal links, replay/conflict handling, stale writes, failed-post rollback including audit/receipts, locked dates, direct line insert/update/delete/reparent attempts, direct unbalanced status transitions, account guards, append-only audit, anonymous/non-owner/service-role denial, and amounts larger than JavaScript's safe integer range. Aggregate and nested audit amounts remain exact strings.

Runtime: Node 22.17.1, npm 10.9.2, Next.js 16.1.6. PGlite uses a single connection. This does not prove independent-session races, Supabase/PostgREST behavior, production grants, backup restoration, or browser interactions. Docker testing and signed-in browser validation are continuing under the full-build request.

## Next work and boundaries

Finish A/B before marking their gates complete:

1. Verify staging auth/RPC and concurrent post/post, post/close, archive/post, stale-save, and same-key replay behavior using separate connections. Test rollback and lock contention in the deployed PostgreSQL version.
2. Add stable system account purposes/templates, account editing/archive UI, atomic reverse-and-replace, period-status visibility, complete report metadata, working previews, and audit/history views. A reversal and Copy as draft currently require separate commands. Accounting corrections in locked dates require an open correction date.
3. Complete server-side register pagination/search and true account running balances. The current register filters only the latest 200 loaded entries, explicitly says so, and can fetch an individual entry by its stable link. Reports and JSON exports use all eligible rows. Chart/trial-balance drill-down currently follows the selected period, not every opening-balance contributor.
4. Validate keyboard flow, form error recovery, changed-date navigation, privacy mode, and desktop/mobile layouts using the required Playwright MCP. Check changes made in another tab and a lost command response.
5. Establish a versioned restore procedure, attachment bundle, and off-platform backup verification. The JSON export is a starting primitive, not a tested disaster-recovery package.
6. Inspect actual Wave exports and same-basis reports, statement samples, and Patriot registers. No sanitized source samples were available for this slice; no provider field names or conversion semantics were invented. Build Wave normalization/import only after those adapter findings are recorded, while independent ledger work continues.

Wave/SimpleFIN/CSV ingestion, transaction review and evidence, statement reconciliation, invoice settlement, Patriot integration, tax links, and parallel-operation acceptance remain in the later packets. AI, MCP, public REST integration, and broad linking to personal finance pages remain deferred. Wave stays the operational books system during the pilot, with any transition selected by the owner after the agreed verification gates.

## Continuation checkpoint: daily books and imports, 2026-09-05

The next layer is implemented in `20260905215106_accounting_workflows_imports_evidence.sql`. The original foundation migration is unchanged. This is an implementation checkpoint, not the end of the full build.

Implemented and exercised:

- Server-side transaction search and pagination, source evidence filters, payee/project filters, saved views, account running balances, chart editing, and a reviewed optional default chart.
- Atomic reversal/replacement, transactional draft/context saves, explicit visible-row bulk posting, immutable annotations, payees/customers, dimensions, reusable journal templates, and parallel-mode settings.
- Exact CSV parsing with explicit dates/signs/locales/account mapping; balanced journal grouping; stable provider identities or fingerprint multiplicity; resumable staging/application; duplicate matching and source-change exceptions. Journal imports post historical entries, while bank files create review drafts or link evidence.
- Private original document storage with upload intents, content hashes, resumable uploads, immutable objects, owner-only storage policies, download integrity checks, a document inbox, and links that can be added after a financial lock. Original import files are retained. No external document execution or public URL is required.
- Version 2 JSON export includes all of this layer's accounting metadata. It still declares unverified coverage and excludes file bytes; the full portable bundle and restore verification remain in progress.
- The owner setup screen provides exact setup SQL for the authenticated account. The localhost app is signed in but the real ledger has no configured owner. No live company data was inserted or migrated by this work.

Verification at this checkpoint:

| Check | Result |
| --- | --- |
| Money/contracts | 591 checks |
| Foundation database | 73 assertions |
| Workflows, atomic rollback, export metadata | 36 assertions |
| CSV parsing | 21 assertions |
| Import persistence and overlap | 15 assertions |
| Document authorization/storage policies | 11 assertions |
| Real PostgreSQL concurrent sessions | 8 assertions across 3 connections |
| HTTP upload/download/origin/CSV boundary | 18 assertions |
| Existing tax engine | 88 checks |
| Accounting lint and admin type check | Passed |
| Optimized production build | Passed with Accounting enabled and demo disabled |
| Codex browser | Account editing, payee creation, import form, and document inbox verified with synthetic books |

The real PostgreSQL fixture runtime is bound to loopback on port 5447, database `accounting_test`, with an explicit marker. The separate editable fixture app uses port 3108 and `.next-accounting-test`. Production build verification uses `.next-accounting-build`, leaving the owner's dev build alone. The fixture driver requires explicit local/test configuration, a loopback database name, and the marker; it fails closed elsewhere.

New commands: `test:accounting:workflows`, `test:accounting:imports`, `test:accounting:documents`, `test:accounting:concurrency`, `test:accounting:http`, and `build:accounting` in the admin workspace. The concurrency and HTTP checks require the prepared local PostgreSQL fixture and fixture app. `prepare-accounting-postgres.ts` initializes an empty fixture database; `sync-accounting-postgres.ts` installs new modules or refreshes functions in an already marked fixture.

Remaining build: partial bank allocations and redundant-draft resolution, transfers/rules, statement reconciliation and closing, complete invoice lifecycle and settlements, payroll registers/clearing, full reports/manual registers, opt-in tax linking, complete backup/restore package, and readiness/parallel-operation controls. Actual Wave/statement/Patriot samples and real monthly closes remain live acceptance dependencies. Browser verification follows the user's explicit Codex-browser instruction, without Playwright.
# Reconciliation and close checkpoint, 2026-09-05

Migration `20260905225711_accounting_reconciliation_close.sql` follows the two earlier accounting migrations. It is packaged separately; the user has only confirmed applying the original foundation migration. No live database changes were applied by the agent. The canonical schema includes all final definitions.

Implemented:

- Statement periods, declared item/debit/credit controls, uploaded statement evidence, first-statement opening review, partial signed line allocations, predecessor continuity, immutable completion proof, cancellation and successor supersession.
- Accounts now open a reconciliation workspace. The owner can enter statement items, search/match posted lines, save partial matches, review uncleared items, complete and revisit a statement. Account opening/closure dates require a final zero-balance reconciliation and block later posting.
- Close books UI includes the calendar cutoff, all prior drafts/import coverage, uncategorized/suspense amounts, bank/card coverage and clearing obligations. Close saves a snapshot without posting entries. Earlier reopen preserves original records and reopens affected later closes.
- Entity classification by year, recorded filing with private support, original filed snapshot retention and an explicit restatement case. Restatement must reclose the affected months before storing revised reports. Ordinary reopen cannot bypass filed-year controls.
- Clearing allocations have bounded capacities across dated releases. A later payment reversal preserves the earlier balance, releases its settlement and offsets the reversal pair. The UI supports allocations, documented timing items and dated release history.
- Atomic correction has separate reversal and replacement dates. A misdated May receipt corrected to April changes both months correctly. All main UI commands use the owner-checked `acct_operate` dispatcher.
- Export version 3 includes close/reconciliation, clearing, fiscal-year, restatement and lifecycle records in addition to existing ledger/evidence metadata. Full document bundles and restore remain a later packet.

Verification at this checkpoint: money/contracts 591, foundation SQL 73, workflows 36, import parser 21, import persistence 15, document permissions 11, reconciliation/lifecycle 20, clearing timelines 13, period/filing/backup 18, real PostgreSQL concurrency 9, actual Next.js HTTP/private evidence 18, existing tax 88. TypeScript, accounting ESLint and the production accounting build passed.

Browser evidence: completed a synthetic February savings statement from creation through one exact match and retained proof using the Codex in-app browser. Inspected the responsive account, matching and close-checklist screens at the available narrow panel width. No Playwright was used. Test data stays in the marked loopback PostgreSQL fixture on port 5447 and the separate Next.js test server on port 3108.

Remaining work is explicitly tracked in the build plan. This checkpoint is not a claim that the complete Wave replacement is finished. Historical coverage checks are not yet operational, SimpleFIN and complete invoice/payroll integrations are pending, and actual source data/three real parallel closes have not been supplied or performed.


## Historical verification checkpoint

Migration `20260905233800_accounting_historical_verification.sql` adds independent monthly/category/balance-sheet controls, versioned documented annual-closing normalization, partial-year coverage, baseline locks, and cancelled-import resumption. It is a new migration, applied after the earlier three; the owner has confirmed applying only the foundation migration. No live database migration or owner assignment was performed.

Source amounts remain blank until supplied. Any mismatch, unfinished economic group, unsupported exclusion, unavailable evidence, draft, suspense balance, unclassified entity year, or future range blocks verification. Historical locks preserve the independent report proof and are explicitly distinguished from locally reconciled statement closes. Reopening retains the snapshot. Posted financial changes and normalization review changes invalidate prior acceptance. Backup v4 retains all disposition versions and invalidations.

Validation: 12 historical parity assertions; 13 end-to-end historical import/normalization/replay/export assertions; 20 reconciliation, 13 clearing, and 18 period/filing assertions passed. Canonical versus sequential migration schema passed seven PostgreSQL catalog comparisons, including functions, policies, triggers, constraints, and grants. TypeScript and accounting ESLint passed. CUA browser acceptance used independent synthetic January report controls, verified partial-year coverage, locked the historical baseline, inspected its retained snapshot, and reopened it for subsequent integration tests. Actual Wave sample normalization and source-report acceptance remain external dependencies.


## Dated transfer checkpoint

New migration `20260905234949_accounting_dated_transfers.sql` adds atomic same-date and cross-date transfers, existing-posting grouping, bounded transit allocation, immutable group history, and complete-group reversal. An independently reversed leg cannot commit. Card payments debit card liability without creating expense. The transfer UI includes both posting dates, searchable existing entries, posting review, links to both legs, and reversal review.

Validation: 19 database assertions cover transit at each month end, incoming-before-outgoing card payment, no income/expense impact, replay/stale writes, duplicate grouping, direct history mutation, and deferred whole-group reversal. TypeScript and accounting lint passed. CUA browser acceptance posted a synthetic $125.50 March31/April2 transfer and reversed both original dates, retaining the group. The persistent local fixture uses additional account11, Payment transit, because its older purpose-less transit account already has posted activity. No real database changed.


## Partial bank matching checkpoint

New migration `20260906000213_accounting_partial_bank_matching.sql` permits bounded split evidence allocations with per-source-identity and per-provider-scope line capacities. Changed financial fields on the same provider identity block matching. Matching can span multiple posted lines; multiple providers may support the same economic posting. Source descriptions can be reviewed without posting again. Releases and reversals retain the original matches and return affected source groups to review. Backup v5 includes release history.

Completing an overlapping import match requires explicit approval of every redundant draft at its current version, validates its original bank movement, preserves links to retained documents, and discards the drafts atomically. A partially matched draft cannot post or return to ordinary apply/exclude.

Validation: 23 database assertions cover exact allocation bounds, provider overlap, unchanged and conflicting source revisions, rollback without draft approval, explicit release, reversal/rematching, evidence-only confirmation, immutability and anonymous denial. The CUA browser matched a synthetic May $500 movement to existing $200 and $300 receipts, inspected and approved the redundant draft, and verified zero remaining and both retained links. TypeScript and accounting lint passed. Synthetic May test receipts increase only May activity; January-February baseline remains unchanged.

Checkpoint 6 regression gate passed: money/contracts591, workflows36, historical12+13, import21+15, reconciliation20, clearing13, period/filing18, transfers19, bankmatching23, schema catalog7, real PostgreSQL concurrency9, HTTP/privateevidence18, accounting lint, TypeScript and production build.


## Retained earnings review checkpoint

New migration `20260906001354_accounting_retained_earnings_review.sql` blocks ordinary retained-earnings posting without a retained review bound to the exact draft version and financial payload. Manual opening controls must independently agree per account and precede existing posted history. Income/expense closing entries are refused. Supported cash-basis historical openings retain their immutable source file and account controls; complete source/report coverage remains a separate gate. Atomic corrections require explicit evidence and replacement controls. Reversals preserve the original review. Backup v6 includes the review records.

The posting and correction UI collect source balances and evidence, expose input differences, and retain source documents on the resulting entry. Fourteen initial database assertions passed for blocked posting, exact controls, correction rollback, nominal closing rejection, evidence retention, stale reviews, permissions and export; an additional duplicate-opening guard assertion was added for the final gate. Historical12+13 and schema catalog7 passed with the new importer guard. Browser acceptance posted a synthetic $500 opening dated2024-12-31 with independent controls and linked document, inspected the retained evidence, then reversed it on its original date to retain the base fixture balances.

Retained review final gate: 15 assertions, historical12+13, import21+15, bank23, reconciliation20, clearing13, period18, schema catalog7, TypeScript, accounting lint and production build all passed.


## Statement source files and amendments checkpoint

Migration `20260906003706_accounting_statement_files.sql` adds retained CSV files, stable statement-item identities, explicit restoration of removed source items, and immutable before/after statement amendments. Imports are bounded, resumable chunks and do not create journal entries. Full-file UI control checks compare independent statement counts and increases/decreases. Original CSV bytes, including UTF-8 BOM, hash consistently across parsing and private storage. Header changes validate item scope and predecessor continuity; changing the opening clears prior opening allocations for review. Backup v7 includes these records.

The UI supports choosing a CSV or reusing an attached CSV, explicit mapping and number/date conventions, comparison before import, retry, source-file history, and editable in-progress controls with reasons and visible changes. Browser acceptance loaded the retained synthetic May CSV, mapped its columns, compared one $500 movement, retried without duplication, and saved a note amendment with retained before/after history. The file chooser itself was not automated. Original multipart upload and hashing were exercised through the real HTTP endpoints. No real company data changed.

Validation: statement DB24, statement HTTP8, general HTTP21 including BOM integrity, reconciliation20/clearing13/period18, retained15, historical12+13, schema catalog7, TypeScript, accounting lint and production build passed. Current owner-data deployment still requires the unapplied committed migrations and owner setup.


## Draft rules and payee aliases checkpoint

Migration `20260906005815_accounting_draft_rules.sql` adds immutable rule versions and application records, normalized exact/prefix payee aliases, explicit description/account/direction/amount conditions, stable priority ordering, and visible rule/alias conflicts. Rules save paused; enablement follows a separate preview approval. Applying selected drafts is atomic and revision checked, preserves bank date/amount, refuses posted or already categorized entries, and records the exact winning version. No automatic posting is enabled. Backup v8 retains definitions, aliases and applications.

The management UI supports creating/editing/pausing rules, source-range previews, per-page draft selection with totals, exact journal review, aliases, and retained version history. Entry evidence gives a readable category/payee change summary plus the stored record. Source/effect JSON obeys the amount-masking preference. The bank posting guard also refuses imported drafts whose bank date or amount has drifted from the original observation.

Validation: rules28, money/contracts612 including malformed-cent safeParse regressions, HTTP22 including an invalid-money 400 response, schema catalog7, bank23, imports21+15, historical12+13, retained15, statement24, workflows36, reconciliation20/clearing13/period18, TypeScript, lint and production build passed. Final lint and production build also passed after the validation and UI refinements. Browser acceptance created a bounded $10-$25 hosting rule, saved a payee alias, previewed two June drafts, enabled the rule separately, selected both with a $39.99 review total, filled their categories/payees, and inspected the retained version2 evidence. Both remain drafts and posted reports remain unchanged.

Remaining daily-work refinement: suggestions learned from prior posted treatment and contextual rule discovery within a new bank review. SimpleFIN, invoice lifecycle, payroll, extended reports, tax linkage and portable restore remain subsequent build packets.


## SimpleFIN connection and observation checkpoint

Migration `20260906015114_accounting_simplefin.sql` adds encrypted server credentials, durable one-time claim attempts, stable canonical bank accounts with separate provider identities, reviewed ownership/date/sign mappings, account observations, bounded sync runs, leases/generation fencing, persisted request budgets, backoff, disconnect/reconnect, and retained history gaps. Worker table/ledger privileges remain revoked; one service-role facade can retain feed evidence but cannot create or post journals. Actual bank access remains off in synthetic/demo environments and no live token was claimed.

The adapter pins the March 2026 version 2 draft contract. Unknown error scopes, missing mapped accounts, malformed monetary values, and incomplete responses preserve the affected checkpoint. Successful account progress survives unrelated failures. Exact repeats reuse reviewed source links; changed amounts/dates enter exceptions. Posted-to-pending regressions retain evidence and a visible warning. Source balances and unavailable balances remain distinct. Original source data reaches normal journal evidence after owner-approved bank draft creation.

The Bank feeds UI supports connection setup, discovery, mapping, explicit exclusion of personal accounts, manual sync, opt-in daily worker status, queue preparation, gap handling, and retained run diagnostics. Canonical settings can be corrected before their first transaction window. Used settings cannot silently reinterpret imported financial dates or signs. Reconnection reuses original book accounts and checkpoints and never creates opening balances. Backup v9 retains all non-secret feed records and explicitly requires separate credential recovery/reconnection.

Close checks now include unprepared posted feed movements and mapped bank accounts requiring statement coverage. Routine bank batches require posted/matched movements and independent statement reconciliation; annual historical-report verification is reserved for journal history imports. This prevents a daily sync from imposing an unnecessary historical verification workflow.

Validation: protocol/transport86, feed DB69, worker/encryption35, canonical catalog7, reconciliation20/clearing13/period18, history12+13, bank23, imports21+15, retained15, statement24, rules28, real PostgreSQL concurrency9, HTTP/private evidence30, TypeScript, accounting lint, and production build passed. Browser acceptance mapped a synthetic card with a positive debt balance, excluded a personal account, prepared a $42.75 checking movement, approved its draft, and inspected its normal journal/source evidence. The pending $5 authorization was excluded. The synthetic draft remains unposted. Operational details and live dependencies are in accounting-simplefin.md.
