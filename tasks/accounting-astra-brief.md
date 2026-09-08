# Astra 6 brief: accounting schema port and backend

Date: 2026-09-07. Repository: `D:\Valiance Media LLC\Projects\Valiance Media`. Workspace: `admin/`. Branch for this work: `astra/accounting-schema`, created from `codex/accounting-completion`. Claude works in parallel on `claude/accounting-ui` from the same base and owns all UI; you own the database and backend. The file ownership rules in section 3 exist so the two branches merge without conflict. Do not deviate from them.

## 0. Read first, in this order

1. `admin/tasks/accounting-target-schema.md`: the build specification. Every table, column, function family, trigger, scenario and delivery rule for the new data layer. This document is authoritative over the older `accounting-spec.md` and `accounting-build-plan.md`, which are now historical.
2. `admin/tasks/accounting-review-2026-09-07.md`: the review that produced the spec. Sections 4 (defects), 5 (verdicts), 11 (descriptors), 12 (schema), 13 (sequencing), 14 (division of labor) and 15 (business profile) are the ones you need.
3. `admin/scripts/accounting-test-db.ts` and `admin/scripts/verify-accounting-all.ts`: the PGlite harness you built. It stays. It applies migration files verbatim per suite, which is how the port gets validated.

## 1. Mission, in priority order

A. **Phase 1: port the accounting data layer to the target schema.** This is the cleanup. 27 tables in a dedicated `accounting` schema, one command dispatcher, about 30 functions, about 10 triggers, seven domain migrations applied fresh. The 36-file `acct_` chain is archived, not migrated. Everything in the spec's section 5 removal map is removed by construction.
B. **The business profile.** One `public.business_profile` singleton (review section 15) that the tax estimator and accounting both read. Ships inside Phase 1 because `accounting.settings` depends on it.
C. **The Wave adapter.** The owner's export files are already in `admin/.local/wave/` (section 6). Independent of A and B. Produce the findings document first, before Phase 1 step 2, because what the ledger file contains can affect how `import_rows` and `history_checks` are built.
D. **Phase 2 backend fixes** (section 7 below), after A and B pass their gate.

Do not start Phase 3 backend items or any UI work. Do not touch `app/` except for the one parking task in section 5, step 0.

## 2. Hard constraints

These are enforced by tests where possible and reviewed by Claude at the gate. A violation fails the gate.

1. **Table budget.** The `accounting` schema contains exactly the 27 tables named in the spec, with those names. `verify-accounting-schema.ts` asserts the exact table list, that no table exists in `public` with an `acct_` prefix after the drop migration, and that `public.business_profile` exists. Adding a table requires a written question in the log and an answer from the owner first.
2. **No function patching.** No `pg_get_functiondef`, no string `replace()` of function bodies, anywhere in any migration. A function is defined once, in full, in its domain file. The parity script greps the migrations directory for `pg_get_functiondef` and fails if it finds one.
3. **One dispatcher.** `accounting.operate(command jsonb)` is the only owner write entry point. `acct_command`, `acct_execute` and `acct_operate` do not survive.
4. **One report engine.** `accounting.report(kind, params)` and `report_lines` serve every financial report and the close snapshot. `acct_workspace` as a second engine does not survive; `workspace()` calls `report()`.
5. **Money, dates, ids, immutability, grants:** exactly as the spec's section 0. Every function `SECURITY DEFINER` with `SET search_path = ''` and fully qualified names. No grants to `anon`. `service_role` executes only `sync_server` and `tax_refresh_server`.
6. **Contract freeze** (section 4). API route paths and their JSON request and response shapes do not change, except to remove fields that belong to removed features and to add new fields the spec introduces. Claude builds UI against the frozen shapes while you work.
7. **No changes to `app/`** other than section 5, step 0. No changes to `admin/src/components/**` other than the deletions and the two minimal edits listed in section 3.
8. **Nothing runs against a hosted Supabase project or any real data.** PGlite and the marked local fixture cluster only. No `supabase db push`. Do not apply migrations anywhere the owner has not explicitly named.
9. **No new dependencies** without a line in the log saying what and why.
10. **Real Wave exports never enter Git.** `admin/.local/` is gitignored. Fixtures are derived and sanitized: fake payee names, shifted amounts, no account numbers, no real memo text.
11. **Deviations are questions, not decisions.** Anything the spec does not cover, or anything you believe the spec gets wrong, goes into `admin/tasks/accounting-phase1-log.md` as a question with your recommended answer. Do not implement your recommendation until the owner answers. Do not edit the spec or the review.
12. **Completion claims carry evidence.** Every "done" in the log names the command that proves it and quotes the summary line of its output.
13. **No em-dashes** in code, comments, SQL, docs or UI strings. Hyphens, commas or separate sentences.
14. **Git:** one migration file per commit. Commit messages describe the domain. Never rewrite history on the shared base branch. Never merge to `main` (it mirrors `admin/` to a public repository).

## 3. File ownership

You own and may change freely:

- `admin/supabase/**` (migrations, `schema/schema.sql`, tests)
- `admin/src/lib/accounting/**` (including `contracts.ts`, `workflows.ts`, `server/**`, `imports/**`)
- `admin/src/app/api/accounting/**`
- `admin/scripts/**`
- `admin/tasks/accounting-phase1-log.md` (yours to create), `admin/tasks/accounting-simplefin.md`, `admin/tasks/accounting-payroll-notes.md`, `admin/tasks/accounting-tax-notes.md` if you need to correct them
- `admin/.gitignore`, `admin/package.json` (dependencies only with a log line)

You may make exactly these changes under `admin/src/components/**` and `admin/src/app/(dashboard)/**`, and nothing else there:

- Delete the removed-feature components listed in section 5, step 6.
- In `accounting-books.tsx` and `accounting-manage.tsx`: remove the imports, nav entries, view cases and section cases that referenced the deleted components. Minimal, mechanical edits. No restructuring, no styling, no copy changes.
- In `src/app/(dashboard)/accounting/page.tsx`: replace the `client.rpc("acct_workspace", ...)` call with the new server helper `loadAccountingWorkspace(params)` you export from `src/lib/accounting/server/workspace.ts`. One call site, nothing else.

Claude owns everything else under `admin/src/components/**`, `admin/src/app/(dashboard)/**`, `admin/src/app/globals.css`, and will not touch your directories. If you believe a change is needed in Claude's area, write it in the log as a request.

## 4. Contract freeze

The UI reaches the backend only through these routes. Keep their paths, methods and JSON shapes. Where a route belongs to a removed feature, delete the route.

| Route | Status | Notes |
| --- | --- | --- |
| `POST /api/accounting` (commands via `use-accounting-command.ts`: `{key, command}` in, `{id, version?}` or `{error}` out) | Keep | The `WorkflowCommand` union in `src/lib/accounting/workflows.ts` is the contract. Remove commands of removed features. Keep the names and payloads of surviving commands. Add new commands from the spec's section 3 (`entry.categorize`, `entry.split`, `alias.save`, `bank.sync_request`, `payroll.post` cash-basis, `register.save`, `settings.save`). Record every added or removed command name in the log. |
| `GET /api/accounting` and the server helper behind `page.tsx` (`AccountingWorkspace`) | Keep | Same `AccountingWorkspace` shape minus removed-feature fields. Add `needs_review_count` and, on each transaction row, `source_description`, `descriptor_key` and `prior_treatment` (summary: last category, payee, count) so Claude can build the review row. |
| `/api/accounting/feeds` | Keep | Same shapes. Sync now creates drafts (Phase 2); the prepare step becomes a no-op that returns the same shape until Claude removes the button. |
| `/api/accounting/imports` | Keep | Same shapes; `parity_status` replaces `coverage_verified`. |
| `/api/accounting/history` | Keep | Backed by `history_checks`. |
| `/api/accounting/documents` | Keep | Same. |
| `/api/accounting/reports/[id]` and `/api/accounting/packages/[id]` | Keep | Backed by `report_snapshots`. |
| `/api/accounting/tax` | Keep | Backed by `tax_mappings`, `tax_adjustments`, `tax_links`. Absorb what the UI needs from the removed payment-plan route: the safe-harbor result is a field on the tax link view, computed by a pure function. |
| `/api/accounting/jobs/feeds`, `/api/accounting/jobs/tax` | Keep | Worker routes, bearer-gated, unchanged auth. |
| `/api/accounting/tax/payment-plan` | Remove | Folded into `/api/accounting/tax`. |
| `/api/accounting/recovery` | Remove | |
| `/api/accounting/invoices/source` and `/api/webhooks/accounting/invoices` | Remove | Parked with the invoice feature. The legacy `/api/webhooks/invoices` receiver is untouched. |

Types in `src/lib/accounting/contracts.ts` are the shared vocabulary. Changes are removals of removed-feature types and additions from the spec. Every change is a line in the log.

## 5. Phase 1, in order

Each step ends with `npm run test:accounting:all --workspace=admin` green for the suites that exist at that point, and a log entry with evidence.

**Step 0a: Wave findings.** Read the files in `admin/.local/wave/` and write `admin/tasks/accounting-wave-findings.md` as described in section 6. Quote column headers and row counts, not transaction contents. This is a half-day task at most and it comes first.

**Step 0: park the CRM integration.** On `astra/accounting-schema`, restore `app/` to its state on `main` (`git checkout main -- app/` then commit as "Park invoice lifecycle changes out of the accounting branch"). Then create `astra/invoice-lifecycle-parked` from `codex/accounting-completion` so the app-side work stays retrievable. After this step the accounting branch touches nothing under `app/`.

**Step 1: archive and drop.** Move the 36 `accounting_*` migration files to `admin/supabase/migrations/archive/accounting/` with a README stating they were applied nowhere except the foundation file. Write the drop migration: it asserts `public.acct_journal_entries` and `public.acct_settings` are empty (raise if not), then drops every `public.acct_*` table, function, trigger and policy, and the `accounting-private` bucket policies that reference them. Update the harness so it applies the archive nothing and the new files everything. Add `admin/.local/` to `admin/.gitignore` if not present.

**Step 2: business profile and ledger.** Migration `..._business_profile.sql` in `public` (review section 15 columns, RLS, owner-only policies matching the rest of admin's personal tables, a helper `public.business_profile_get()`). Migration `..._accounting_ledger.sql`: `CREATE SCHEMA accounting`, grants, `settings`, `accounts`, `journal_entries`, `journal_lines`, `periods`, `audit_log`, `command_receipts`, the helpers, the guards, the balance trigger, the audit trigger, `descriptor_key()`, and `operate` with the draft, post, discard, reverse, correct, categorize, split, period and settings families. Port `verify-accounting-transactions.ts`, `-periods.ts`, `-close.ts` (lock parts), `-db.ts`, `-schema.ts`, `-concurrency.ts` onto it, keeping their hard-coded expected values.

**Step 3: banking, documents, rules.** `..._accounting_banking.sql`: `parties`, `payee_aliases`, `bank_connections`, `bank_accounts`, `bank_transactions`, `bank_matches`, `documents`, `document_links`, `rules`, `sync_server`, the transfer and match families, `bank_review`, `prior_treatment`. Port the feed, bank-matching, transfers, documents, rules and SimpleFIN suites. Fix D3 and D4 from the review here while the adapter is open: accept both the v1 envelope (`errors`, no `conn_id`) and the v2 draft, and convert `posted` with `business_profile.books_timezone` in a way the unit test asserts as the correct local date, not the shifted one.

**Step 4: history and imports.** `..._accounting_history.sql`: `import_batches`, `import_rows`, `history_checks`, the import families, `import_compare`, `history.check`. Port the imports, history, history-imports and import-comparison suites (comparison becomes a function test). Report gates read `parity_status` on `journal` batches only; bank batches never block exports (D1). Cancel resets unapplied rows and never orphans observations (D2).

**Step 5: close, payroll, registers, tax, reports.** `..._accounting_close.sql` (`reconciliations`, `reconciliation_items`, `close_checklist`, `period.lock` snapshot), `..._accounting_payroll_registers.sql` (`payroll_runs` with the cash-basis template as the default `payroll.post`, `registers`, `contractor_report`), `..._accounting_tax.sql` (`tax_mappings`, `tax_adjustments`, `tax_links`, `tax_source`, `tax_refresh_server`, safe-harbor as a pure TypeScript function over `forecast_inputs`), `..._accounting_reports.sql` (`report`, `report_lines`, `ledger`, `report_snapshots`, `report.capture`, `workspace`). Port the reports, operational-reports, close, statement-files, payroll, registers, tax-workpapers, tax-links, tax-refresh, tax-projection and books-package suites. Retire the payment-plan, customer-funds, invoice, recovery, authority, clearing and statement-cutoff suites with their features.

**Step 6: library, routes and removed UI.** Port `src/lib/accounting/**` and `src/app/api/accounting/**` to the new function names and the `accounting` schema (`client.schema("accounting")` in `server/access.ts`). Export `loadAccountingWorkspace` and switch the single call in `page.tsx`. Delete these components and remove their references from `accounting-books.tsx` and `accounting-manage.tsx` with minimal edits: `accounting-invoices.tsx`, `accounting-invoice-decision.tsx`, `accounting-invoice-detail.tsx`, `accounting-invoice-inbox.tsx`, `accounting-invoice-payment.tsx`, `accounting-invoice-shared.tsx`, `accounting-invoice-sources.tsx`, `accounting-invoice-timeline.tsx`, `accounting-manual-invoice.tsx`, `accounting-customer-fund-form.tsx`, `accounting-recovery.tsx`, `accounting-authority.tsx`, `accounting-import-comparison.tsx`, `accounting-retained-review.tsx`, `accounting-register.tsx`, `accounting-tax-payment-plan.tsx`, `accounting-tax-payment-editor.tsx`, `accounting-clearing.tsx`, `accounting-statement-cutoff.tsx`, `accounting-account-lifecycle.tsx`, `accounting-loan-schedule.tsx`, `accounting-contractor-review.tsx`, `accounting-payroll-coverage.tsx`. If a kept component imports a removed one, log it as a request for Claude rather than editing the kept component beyond the import line. Remove the `overview` view from `accounting-books.tsx`.

**Step 7: gate evidence.** Run and paste summaries in the log: `npm run test:accounting:all --workspace=admin`, `npm run lint:accounting --workspace=admin`, `npx tsc --noEmit -p admin/tsconfig.json` (zero errors, including scripts), `npm run build:accounting --workspace=admin`. Regenerate `schema/schema.sql` from the applied result and confirm `verify-accounting-schema.ts` passes with the table-list, no-patching and no-`acct_` assertions. State the final table, function and trigger counts.

## 6. Wave adapter (parallel, when files exist)

The files are already in `admin/.local/wave/` (gitignored; never copy them anywhere tracked):

- `Wave Export All Transactions Data/accounting.csv`: the Wave Data Export ledger, about 836 KB. This is the source of truth: every journal line with Transaction ID, date, account name, account ID, account type and group, description, debit and credit columns, customer, vendor and memo. Alongside it: `customers.csv`, `vendors.csv`, and `bill_items.csv` (header only; no bills were ever created in Wave). There is no invoices file because no invoices were created in Wave.
- `Wave PnL Data/`: four Profit and Loss CSVs, one per year (2023, 2024, 2025, 2026 through December 31). Identify each by lines 1 to 4 of the file (`Date Range: ...`), not by the file name.
- `Wave Balance Sheet Data/`: five Balance Sheet CSVs, as of 2022-12-31, 2023-12-31, 2024-12-31, 2025-12-31 and 2026-12-31. Identify each by its `As of ...` line. Treat 2026-12-31 as "today".

All nine reports say `Report Type: Accrual (Paid & Unpaid)`. The owner confirmed that switching Wave between accrual and cash basis changes no number for this business, because Wave never held an unpaid invoice or bill. Treat the reports as cash-basis parity targets. Your findings document must still confirm from `accounting.csv` that no receivable or payable account carries activity; if one does, stop and ask.

No General Ledger, Trial Balance, chart export or receipts export will be provided; the chart is rebuilt from the account name, ID and type on every transaction line. Do not ask for more files unless a specific parity check cannot be completed without one, and say which check.

**History boundary.** The books start on 2022-12-31. Before that the owner used Bench, which stays outside these books. `business_profile.earliest_history_date = 2022-12-31`. Expect the 2022-12-31 entries to be opening balances carried over from Bench; the 2022-12-31 Balance Sheet is the `expected` side of a `history_checks` row of kind `opening_balances`, and the four P&Ls are the `annual_totals` rows for 2023 through 2026. There is no 2022 P&L; a 2022 fiscal year has one day of opening activity and no annual check.

First produce `admin/tasks/accounting-wave-findings.md`: exact columns, whether the Transaction ID is stable across exports, how journal groups are expressed, whether rows are cash-basis, whether accounts-receivable or accounts-payable rows exist (the owner invoices from `app`, but check for any Wave-issued invoices or bills), whether annual closing entries exist, and how the 2022-12-31 opening entries are shaped. Then implement `src/lib/accounting/imports/wave.ts` producing `import_rows` for `kind = 'journal'`, with a mapping from Wave account names to `accounts` via `external_names.wave` and the Wave account ID kept in `import_rows.raw`, sanitized fixtures derived from the real files (fake payees, shifted amounts, no real memo text), and the `history.check` rows above. Any conversion the files require (closing entries, accrual rows) is a question in the log, with the affected years and amounts, before it is implemented.

## 7. Phase 2 backend, after the Phase 1 gate

1. Sync creates drafts: `sync_server` ends by drafting posted observations, matching before drafting, running enabled rules, setting `applied_rule_id` and pre-filling from `prior_treatment` when no rule matches. The feeds route's prepare step returns success without work.
2. `bank.sync_request` command plus a sync-on-open path: `loadAccountingWorkspace` returns `sync_due: true` when the newest `last_success_at` is older than six hours; the route triggers a non-blocking sync under the lease.
3. One scheduler design in the log: a VPS cron calling `/api/accounting/jobs/feeds` and `/api/accounting/jobs/tax` with the worker secret, or `pg_cron` plus `pg_net`. Recommend one; the owner chooses.
4. Cash movements: `cash_class` derived from counter-account subtype by default (card and payroll liabilities to operating, transit to transfer, equity and loans to financing, fixed assets to investing).
5. Document the environment variables the surviving routes need in `admin/.env.example`.
6. Fix the ten TypeScript errors in `admin/scripts/` and make the accounting build tsconfig include `scripts/**`.

## 8. Reporting

Keep `admin/tasks/accounting-phase1-log.md` current as you go: a dated entry per step with files changed, commands run with summary lines, deviations as numbered questions with your recommendation, and requests for Claude's area. This log is the only status document. Do not update the spec, the review, `accounting-build-plan.md` or `accounting-release.md`.

## 9. Definition of done for Phase 1 (what Claude checks at the gate)

- `accounting` schema has exactly the 27 spec tables; `public.business_profile` exists; no `public.acct_*` objects remain; migrations contain no `pg_get_functiondef`.
- Every spec scenario (section 4) has a verify script with hard-coded expected cents, counts and error codes, exercised through `operate` and the reads against PGlite; negative paths kept.
- `test:accounting:all`, `lint:accounting`, repo-wide `tsc`, and `build:accounting` pass, with output in the log.
- Contract freeze honored: kept routes and `WorkflowCommand` names unchanged except logged removals and additions; `AccountingWorkspace` carries `needs_review_count`, `source_description`, `descriptor_key`, `prior_treatment`.
- `app/` matches `main` on the accounting branch; the parked branch exists.
- The removed-feature components are deleted and the two shell files still compile.
- The log has no unanswered questions.
