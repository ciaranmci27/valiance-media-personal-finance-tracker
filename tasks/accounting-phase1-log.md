# Accounting Phase 1 execution log

## Scope and current state

2026-09-07. Branch: `astra/accounting-schema`. Authoritative instructions: `accounting-astra-brief.md` and `accounting-target-schema.md`; `accounting-review-2026-09-07.md` supplies context. The earlier accounting spec and build plan are historical.

Current step: **Steps 0a through 6 complete; step 7 gate in progress. Phase 1 has not passed its gate, so Phase 2 has not started**. No hosted database or real-data mutation is permitted. The explicitly requested Wave inspection is read-only file analysis, not an import into any database. Real exports remain in ignored `admin/.local/wave/`; no transaction contents, source IDs, payees or account numbers may enter tracked files or tool output. The four account names in the findings were explicitly authorized by the owner on 2026-09-07.

The brief was already modified in the working tree at the start. Preserve that owner edit and do not stage it. Claude owns the UI. Respect the brief's exact deletion/minimal-edit exceptions; do not edit the target schema or review. No new dependency has been added.

The owner subsequently committed that brief edit as `f59721e`; it was clean at the start of the continuation. Astra did not edit or stage it.

## Resolved intermediate-gate question

### Q3. Intermediate test gate during the schema replacement

**Answered: approved with the standing decisions below.** Original question: may the full runner report explicitly documented failures from unported suites during steps 1-6, while each step's new/ported tests must pass, with all surviving suites required green at step 7?

The brief requires `test:accounting:all` green at the end of every step. Step 1 also requires archiving all 36 old migrations and changing the harness to apply none of the archive. The replacement ledger is not built until step 2, banking until step 3, history until step 4, and reports/payroll/tax until step 5. Existing suites cannot pass in those intermediate states:

- `admin/scripts/accounting-test-db.ts` inserts `public.acct_settings` immediately after applying migrations.
- `admin/scripts/verify-accounting-db.ts` directly reads the foundation migration path and calls `public.acct_command`.
- `admin/scripts/verify-accounting-transactions.ts` calls `acct_operate` and `acct_register`; `verify-accounting-history.ts` calls old history functions and tables whose replacements belong to step 4.
- `admin/scripts/verify-accounting-all.ts` discovers and runs all existing suites, not only the domains ported so far.

**Recommended answer:** Yes, as an explicit exception to the intermediate green requirement only. Preserve the prescribed implementation order. Run the full runner after each step and log exact passed/failed counts with each unported dependency identified. Keep original assertions and expected values; do not disable tests, manufacture passing results, apply the archived chain in the active harness, or build later domains out of order to disguise the transition. Require new/ported tests to pass at their step and every surviving suite to pass before Phase 1 acceptance. Retire only the explicitly removed-feature suites at the prescribed step. The final gate is unchanged.

No archive, harness rewrite, migration or schema change has been implemented pending this answer. The runner still passes 46/46 against the existing schema.

## Owner decisions

### Q1. Receivable/payable activity: preserve or convert?

**Answered 2026-09-07: preserve exactly, no conversion.** Original question: brief section 6 explicitly says: "if one does, stop and ask." The ledger contains 83 nonzero rows across four accounts with Receivable or Payable types, despite blank invoice/bill references and no exported bill items. Are these opening carryovers/clearing movements that should remain as recorded, or do they represent actual unpaid invoice/bill accruals requiring conversion?

Affected year/type aggregates, not individual transactions:

| Year | Type | Rows | Total debits | Total credits | Debit-minus-credit net |
| --- | --- | --- | --- | --- | --- |
| 2022 | Receivable | 3 | $9,748.36 | $0.00 | $9,748.36 |
| 2023 | Receivable | 3 | $0.00 | $9,757.83 | -$9,757.83 |
| 2023 | Payable | 47 | $15,033.57 | $15,033.57 | $0.00 |
| 2024 | Payable | 12 | $313.50 | $313.50 | $0.00 |
| 2025 | Payable | 8 | $194.30 | $194.30 | $0.00 |
| 2026 | Payable | 10 | $3,537.05 | $3,537.05 | $0.00 |

**Recommended answer:** Preserve the original dated, balanced journals and their account classifications if the owner confirms these are carryover/clearing entries consistent with the intended books. The unmodified ledger reproduces every supplied report's headline totals. Do not convert solely because an account has an AR/AP type. If actual unpaid accruals exist, define the conversion explicitly before implementing it. No conversion or import has been performed.

### Q2. Entirely zero opening journal

**Answered 2026-09-07: approved.** Original question: one 2022-12-31 opening transaction group has two zero-valued lines. The target requires nonzero journal lines. Should the adapter retain this group in raw import history with an explicit exclusion reason and create no journal for it?

**Recommended answer:** Yes. Preserve its raw provenance, mark it intentionally excluded with a reason, and create no financial entry. Its total is $0.00. Preserve all nine other opening groups, including the two nonzero expense lines whose net is $0.00. Do not manufacture a financial amount or remove offsetting nonzero entries. This recommendation is not implemented.

### Resolved by the existing brief, no additional question

All account IDs are blank. Section 6 already prescribes mapping account names through `external_names.wave` while retaining the source ID in raw data. Follow that instruction, preserve blank IDs as blank, and reject ambiguous mappings. Each of the 49 source account names currently has exactly one group/type combination. No provider ID will be invented. Stability of transaction IDs across separate exports remains unverified because only one ledger export exists; the findings document states that limit.

The owner authorized proceeding to step 0 onward in order. Receivables are Bench opening carryovers, collected in 2023; their revenue predates these books. The 2023 collection must credit the receivable, never income. The remaining receivable balance is -$9.47, a credit residual. Payables are payroll-adjustment clearing, not unpaid bills. Preserve original dates and financial types, mapping to `receivable` and `payroll_liability` subtypes as applicable. The owner explicitly authorized `receivable` as a target subtype and requested the four source account names in the findings.

Keep the all-zero opening group in raw import history with an explicit exclusion reason and no journal. Preserve all nine other opening groups, including both offsetting nonzero expense lines. Implementation of these adapter decisions remains pending step 4.

Transaction ID stability across separate exports is a known limit, not a blocker. Verify against the next export during the parallel run. No additional export is requested now.

## Evidence: initial inventory

- `git branch --show-current`: `astra/accounting-schema`.
- `git status --short`: only the pre-existing change to `admin/tasks/accounting-astra-brief.md` before this step.
- `git check-ignore -v admin/.local/wave/`: `admin/.gitignore:51:.local/ admin/.local/wave/`.
- `git ls-files admin/.local`: no output, no local exports tracked.
- Read-only CSV header/count inspection with bundled Python: 13 CSV files; one ledger with 4,637 data rows and 23 columns; four P&Ls for 2023-2026; five balance sheets for 2022-2026 year end; customers 1 data row; vendors and bill items 0 data rows.

## 2026-09-07: step 0 completed

Commit: `17e5987`, `Park invoice lifecycle changes out of the accounting branch`.

Restored `app/` using the prescribed `git checkout main -- app/`. Git checkout's overlay retained four tracked files absent from main. Removed those four exact paths with `git rm --` to achieve the requested tree equality: the accounting delivery verifier, webhook delivery worker, webhook transport, and invoice lifecycle migration. All work remains recoverable from the parked branch. No unrelated path or uncommitted user work was removed.

Created `astra/invoice-lifecycle-parked` from `codex/accounting-completion`, without switching, merging or pushing. Both refs resolved to `f8c27de66bc122ac9881e75a4c16c5ee76ee8850` at creation. No further changes to `app/` are permitted after this step.

Evidence:

1. `git diff main --quiet -- app/`, checked exit code 0 before printing:

   > Step 0 tree check: app/ exactly matches main.

2. Compared `git rev-parse astra/invoice-lifecycle-parked` with `git rev-parse codex/accounting-completion` and failed on any mismatch:

   > Step 0 parked branch check: both refs resolve to f8c27de66bc122ac9881e75a4c16c5ee76ee8850.

3. `npm run test:accounting:all --workspace=admin`, exit code 0. Ignored artifacts: `admin/.local/phase1/step0-tests.txt` and `step0-verification.json`.

   > 46/46 suites passed.

   > Fixture PostgreSQL, HTTP and encrypted restore checks require --integration.

Step 1 inspection counted the top-level accounting migration filenames and inspected the harness dependencies described in Q3:

> Step 1 inventory: 36 accounting migration files remain active; none archived yet.

## 2026-09-07: step 0a evidence

Files added:

- `admin/scripts/inspect-accounting-wave.py`: reproducible read-only inspection using Python's standard library. No new dependency, database call, network call or source-data write.
- `admin/tasks/accounting-wave-findings.md`: exact headers, source structure, opening and closing analysis, identifier limitations and aggregate parity.
- This execution log, including Q1 and Q2.

Commands and observed output:

1. `& 'C:/Users/Ciaran Mcintyre/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' admin/scripts/inspect-accounting-wave.py`

   > Wave structure inspection: 13 files read; 4637 ledger rows; 2269 balanced groups; 83 receivable/payable-type rows; 9/9 report aggregate totals match.

   Additional checks: zero unbalanced groups; zero multi-date groups; zero names with multiple classifications. All 35 report aggregate comparisons have a zero-cent difference. These checks do not establish account-level parity or successful application import.

2. `npm run test:accounting:all --workspace=admin`, with `ACCOUNTING_VERIFICATION_REPORT` set to the ignored `admin/.local/phase1/step0a-verification.json` and console output captured in ignored `admin/.local/phase1/step0a-tests.txt`.

   > 46/46 suites passed.

   > Fixture PostgreSQL, HTTP and encrypted restore checks require --integration.

   Exit code 0. This is the existing local suite baseline, not proof that the new target schema exists. Integration mode was not run.

No change has been made to `app/`, UI, API routes, schema or migrations. No real records have been imported or altered. The initial inspection paused at the required stop-and-ask point. The owner resolved Q1 and Q2 on 2026-09-07. Step 0a is now complete with those decisions and the evidence above; the disproven absence-of-activity assumption is documented, not reported as a passed check.


## Standing decisions received for the port

- Q3 approved: record expected failures for each intermediate step. Every ported suite must pass when its step ends; all surviving suites must pass the Phase 1 gate. Remove or archive removed-feature suites.
- Seven domain migrations plus drop and business profile are approved; one new migration per commit. The harness never applies archive files.
- Business profile follows the existing tax_estimates authenticated RLS/grant pattern. Seed LLC/S-corp identity, legal name from existing settings if available, otherwise Valiance Media LLC. Leave election year and sensitive/contact fields null.
- Seed system accounts with stable system_purpose. Review section 6 contains workflow prose, not a chart; use the target's explicit system-purpose list as the chart source, retaining generic bank/card/income/expense accounts. No real Wave accounts or values enter the seed.
- Descriptor normalization follows the owner's exact rules with ten synthetic examples. Keep surviving command names/response keys, remove removed-feature keys, add specified fields, and log equivalent mappings.
- Choose unspecified storage types/defaults/checks/indexes and record decisions. Only financial-meaning questions need owner input; continue unrelated work while they wait. The user's unanswered-recommendation rule does not waive higher-priority requirements for any action that independently requires explicit approval.
- Wave inspector remains standalone; never required by tests. Fixtures are synthetic/sanitized. Do not touch services on 5447 or 3108, hosted databases, or real records.
- Continue straight into Phase 2 backend after the Phase 1 gate. No merging or main push.

Step 1 expected failures: every existing database-backed suite still depends on the removed public.acct_* chain or its old migration paths. The full runner will enumerate exact affected names after execution. Pure TypeScript suites may continue to pass. The new drop suite must pass; no old suite is silently skipped.


## Step 1 completed: archive and guarded drop

Moved 36 legacy migration files without editing their content. The active loader is top-level only and includes the new accounting and business-profile filenames. Removed the old accounting blocks from the canonical schema. Existing personal-finance definitions remain. Added a setup-error close in the PGlite harness so expected unported-suite failures do not leave WASM workers alive.

The new drop migration checks and locks every legacy table, including the mandatory settings and journals checks, and refuses any records. It uses RESTRICT, not CASCADE, and rolls back on unexpected external dependencies. It removes legacy private-bucket policies only when they refer to old accounting functions; other storage policies remain. No bucket or files are deleted. This is a new file, not a delta to a previously applied migration. It has run only against invented in-memory fixtures.

Evidence:

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-drop.ts`: `Legacy drop: 14 assertions passed; populated tables and external dependencies preserved.`
- `npm run test:accounting:all --workspace=admin`: **8/47 suites passed.** Exit 1 is expected during the approved transition. Exact result artifact: ignored `admin/.local/phase1/step1-verification.json`.

Expected unported failures observed:

- `verify-accounting-bank-matching.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-authority.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-account-setup.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-clearing.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-books-package.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-close.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-customer-funds.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-contractors.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-db.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-documents.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-feed-db.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-history-imports.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-history.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-import-comparison.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-import-db.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-invoice-settlements.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-invoice-history.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-invoice-sync.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-invoices.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-large-invoices.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-manual-invoices.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-operational-reports.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-payroll-reporting.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-payroll.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-periods.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-registers.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-recovery-db.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-reports.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-retained-review.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-rules.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-schema.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-statement-cutoffs.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-statement-files.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-tax-payment-plan.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-tax-workpapers.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-tax-refresh.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-transactions.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-transfers.ts`: legacy schema/migration dependency not ported yet.
- `verify-accounting-workflows.ts`: legacy schema/migration dependency not ported yet.

Passing suites: `verify-accounting-feed-sync.ts`, `verify-accounting-drop.ts`, `verify-accounting-imports.ts`, `verify-accounting-simplefin.ts`, `verify-accounting-tax-links.ts`, `verify-accounting-tax-projection.ts`, `verify-accounting.ts`, `verify-tax.ts`.

No tests were disabled. Removed-feature suites are still present until their prescribed retirement step. The drop suite is the only newly ported database suite for this step and passes. No hosted access, changes to fixture services, or further app/ changes occurred.


## Step 2 in progress: business profile domain

New migration `20260907193410_business_profile.sql` creates and seeds the shared singleton. Its RLS policies and authenticated CRUD grants follow tax_estimates as explicitly directed. A guard prevents deleting the singleton, validates timezone names, increments version, and refuses timezone changes after observations exist. The default email account UUID is unconstrained, matching the existing organization configuration until email ownership is separately established. No payroll/organization or tax_estimates rows are modified.

The seed can read an existing settings legal name when this profile migration is applied independently. In the prescribed full chain, the preceding drop correctly refuses any populated settings row; after a successful empty reset the fallback legal name is used. The drop guard is not weakened to salvage a name. Election year, EIN, address and contacts remain null. Profile migration contains seed DML; canonical schema carries only its final definitions.

Evidence: `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-business-profile.ts` reported `Business profile: 15 assertions passed; seed, authenticated access and timezone guard verified.` This is domain evidence, not a completed step 2 claim. Ledger port and step-ending full run remain pending.

### Ledger decisions and contract mapping

- Seven core tables are implemented. IDs, original descriptors, posted lines/dates, reversal pairing, stale versions, command receipts and locked-period guards are enforced in SQL. Totals aggregate as numeric internally to avoid overflowing bigint when summing individually valid cents; transport remains decimal integer strings. Audit monetary fields also use strings.
- One `operate({key, command})` owner entry point retains the HTTP envelope. Internal domain handlers are not granted to authenticated/service roles. Unbuilt handlers are referenced by fixed function names, never client-controlled SQL; they become available in their prescribed domain migration. Settings bootstrap is serialized and uses the authenticated admin user on first `settings.save`; subsequent reads/writes require that stored owner. No migration chooses an arbitrary auth.users row.
- `draft.discard`, `transaction.save`, `transaction.review`, `account.create`, `account.update`, `chart.seed`, `entry.context`, `entry.correct`, `entry.annotate`, `preferences.save` remain command names. `primary_origin` remains a response key backed by `origin`; account profile fields will be projections from accounts. `entry.annotate.note` becomes the entry's audited reason, not a separate annotations table. `preferences.save.authority_mode` maps wave_primary/parallel_pilot to wave and admin_primary to admin. Shared identity is read from business_profile, not copied into settings.
- New `entry.categorize` and `entry.split` retain the bank line ID so matches survive recategorization. Splits accept signed exact cents or positive basis-point weights totaling 10000, with largest-remainder allocation and stable source order. Zero allocations are refused. Bank/card categories require the transfer flow. `settings.save` and `entry.discard` are added as specified.
- Counter-account subtypes remain text rather than a closed enum; this accommodates the owner's explicit receivable subtype. Account type/subtype/contra changes are refused after posted activity to protect reports; rename and external-name mapping remain audited. Account grouping permits one level of the same financial type and prevents cycles.
- Lock guards also protect earlier financial dates when a later month is locked, preserving the original negative-path invariant and closed balance-sheet snapshots. Metadata edits to posted entries remain allowed while locked. Full period-close snapshots and owner close commands depend on the single report engine in step 5; those existing suites remain explicitly unported until that dependency exists rather than introducing a second report engine.
- `audit_log.row_id` deterministically encodes singleton/month keys as UUIDs; ordinary row UUIDs remain unchanged. Audit identity stays owner/worker/system. Receipts can only be pruned by privileged maintenance after 90 days; ordinary callers have no direct DML grants. No pruning job was introduced.
- Ten invented descriptor examples cover numeric and named dates, digit runs, card tokens, suffixes and whitespace. No real descriptions are used. Exact key stability across future normalization changes will require an explicit future migration, not silent recomputation of stored keys.

Step 2 expected remaining failures: old read/backup/close/report-dependent database suites still reference removed functions. The new ledger and business-profile suites and the ported transaction suite must pass. Existing DB, periods and schema suites retain their assertions for their report/domain dependencies; the core guard scenarios are additionally exercised now in verify-accounting-ledger.ts. No failing suite is represented as fully ported.


### Step 2 end evidence

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-ledger.ts`: `Ledger core: 50 checks passed, including descriptor normalization, exact balances, posting guards and permissions.` Includes original fixture aggregate expected cents: assets 1278000, liabilities 3000, equity 1000000, current income 75000, prior earnings 200000; all synthetic.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-transactions.ts`: `Transaction review, sorting, exact split and presentation: 27 assertions passed.` Original expected values and negative assertions retained. Fixture setup now uses the seeded uncategorized account instead of creating a second system-purpose account.
- Business profile and drop suites continue passing in the full run.
- `npm run test:accounting:all --workspace=admin`: `12/49 suites passed.` Full result: ignored `admin/.local/phase1/step2-verification.json`. Exit 1 is expected under Q3.

Remaining expected unported/dependency failures:

- `verify-accounting-bank-matching.ts`
- `verify-accounting-authority.ts`
- `verify-accounting-account-setup.ts`
- `verify-accounting-books-package.ts`
- `verify-accounting-clearing.ts`
- `verify-accounting-close.ts`
- `verify-accounting-customer-funds.ts`
- `verify-accounting-contractors.ts`
- `verify-accounting-db.ts`
- `verify-accounting-documents.ts`
- `verify-accounting-feed-db.ts`
- `verify-accounting-history-imports.ts`
- `verify-accounting-history.ts`
- `verify-accounting-import-comparison.ts`
- `verify-accounting-import-db.ts`
- `verify-accounting-invoice-history.ts`
- `verify-accounting-invoice-settlements.ts`
- `verify-accounting-invoice-sync.ts`
- `verify-accounting-invoices.ts`
- `verify-accounting-large-invoices.ts`
- `verify-accounting-manual-invoices.ts`
- `verify-accounting-operational-reports.ts`
- `verify-accounting-payroll-reporting.ts`
- `verify-accounting-payroll.ts`
- `verify-accounting-periods.ts`
- `verify-accounting-recovery-db.ts`
- `verify-accounting-registers.ts`
- `verify-accounting-reports.ts`
- `verify-accounting-retained-review.ts`
- `verify-accounting-rules.ts`
- `verify-accounting-statement-cutoffs.ts`
- `verify-accounting-statement-files.ts`
- `verify-accounting-tax-refresh.ts`
- `verify-accounting-tax-workpapers.ts`
- `verify-accounting-transfers.ts`
- `verify-accounting-workflows.ts`
- `verify-accounting-tax-payment-plan.ts`

The ledger and transaction tests pass. The older DB/periods/schema suites still require read engines, close snapshots or removed-state replacements assigned to later steps; they are not claimed ported or passed. Core posting/locking assertions are already covered by the new ledger suite. Finish these cross-domain ports before the gate, preserving surviving expectations. Concurrency integration has not been run against the protected 5447 fixture; it must use an isolated fixture if needed. No later-domain implementation was inserted into the ledger merely to mask missing dependencies.


### Step 3 integration decision: shared private ledger handler

Before the banking migration, the unapplied ledger baseline's private handler now permits calls from the service_role worker context without pretending to be the owner. It remains ungranted to either browser or worker roles; only the two worker entry points can reach it as definer. operate still requires the stored owner. This shares draft/split/post invariants rather than duplicating them in sync.

Full-line draft edits preserve matched bank-line UUIDs and amounts; omission or changed financial values are refused. Discard releases matching evidence with the supplied reason before discarding, so observations return to review. These are corrections to the new, unapplied baseline definition, kept in its domain file to satisfy the authoritative single-definition/no-function-patching requirement. No historical archived migration was edited; no migration has been applied to a hosted project. Each correction commit touches one migration file. The baseline is still under construction, not ready to apply.


Step 3 compatibility decisions: retained `entry.bulkpost` uses the same private ledger posting handler in one atomic command. Retained `transfer.link` validates already posted two-line bank/transit legs and permits a one-time assignment of their previously null transfer_group_id. This grouping metadata changes no financial date, line, amount, origin or account; an existing group can never be changed. All such changes are audited. This preserves the existing command without reversing valid history merely to associate its legs.


## Step 3: banking, documents, rules and protocol adapter

Delivered the nine banking-domain tables, private command/worker helpers, source evidence guards, document storage policies, rule preview, payee aliases and transfer matching. No new dependency. Active migrations apply only the new files; canonical construction blocks include the same domain definitions. The final catalog-generated snapshot remains a step 7 deliverable.

Decisions under the owner's standing instructions:

- Additional independent-source evidence uses a zero `bank_matches.amount_cents` allocation, validated against a fully allocated identical movement from a different source. Positive allocations remain bounded by both observation and journal line. This preserves two-source evidence without double booking or over-allocation. Corroboration must be released before its positive anchor. Draft discard releases both with an audit reason.
- Rule previews retain posted-history and already-categorized explanations. Equal-priority winners and conflicting aliases remain ineligible. Rules never silently replace reviewed categories. Split rules validate positive basis points summing to 10000. Prior single-category treatment is suggested; prior split proportions are not assumed to fit a new purchase.
- The old rule-import subsection depends on `import.stage/apply`, so its original source-invariant assertions move to step 4. Original code is retrievable from Git and the ignored development extraction. The banking suite already tests matched bank-line preservation; this does not replace the pending import-specific assertions. The removed per-rule backup/version table assertions become applied_rule_id and append-only audit checks. Original rule cents/count expectations remain.
- `ACCT_STALE_REVISION` identifies stale whole-workspace input; `ACCT_STALE_VERSION` remains the per-row error. The old rule negative test now expects the precise revision error. Command names and payload keys are unchanged.
- `feed.map` retains the existing balance sign in private checkpoint metadata because the target bank_accounts table specifies movement_sign only. Both signs freeze once evidence exists. Mutable aliases/documents use integer versions. Financial revision also changes for banking/rule/payee/document writes that affect review or report eligibility.
- `feed.prepare` returns its frozen id/prepared shape with prepared zero. Draft-capable sync remains opt-in at this phase; Phase 2 turns it on in the HTTP worker. Pending movements create no financial evidence/date, but counts are retained in sync audit. Previously posted movements changing to pending are conflicts.
- Matching before transfer creation can replace one unambiguous bank-origin draft with the owner-created transfer, retaining its observation match and audit reason. Ambiguous source candidates are left for review. Cross-date legs preserve both actual dates. Single-leg reversal of a two-leg transfer is refused.
- Document upload permission refuses a second object at a reserved path and only exposes owner-reserved files. Complete/link requires an uploaded object; storage deletion remains unavailable. No public storage permission is granted.
- D3: default transport v1, accept both v1.0.7 and the v2 draft. D4: official protocol defines posted as Unix seconds, so the correct local date is obtained by one timezone conversion, not by preserving UTC calendar digits. Midnight tests explicitly retain the correct previous Phoenix date where applicable, alongside daytime/DST tests. This corrects the review's characterization without changing a timestamp's meaning. Sources are documented in accounting-simplefin.md.

Surviving new/ported suites required green at this boundary: ledger, business-profile, drop, transactions, banking, documents, rules and SimpleFIN. Bank matching still depends on step 4 import setup; old transfers depends on the step 5 report reads; old feed DB depends on the step 6 worker/read projections. These are explicitly unported, not represented as passed. Their negative paths and expected balances must survive their final ports.

### Step 3 end evidence

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-banking.ts`: `Banking, matching, rules and worker isolation: 42 checks passed`.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-documents.ts`: `Accounting document permissions: 11 assertions passed.`.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-simplefin.ts`: `SimpleFIN protocol, scope, transport and security: 98 assertions passed.`.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-rules.ts`: `Rule previews, alias conflicts, atomic draft application, replay and history: 23 assertions passed.`.
- `npm run test:accounting:all --workspace=admin`: **14/50 suites passed**, exit 1. The required new/ported suites all passed. Ignored evidence: `admin/.local/phase1/step3-verification.json` and `step3-tests.txt`.

Expected unported/removed-feature failures at this step:

- `verify-accounting-authority.ts`
- `verify-accounting-bank-matching.ts`
- `verify-accounting-account-setup.ts`
- `verify-accounting-books-package.ts`
- `verify-accounting-clearing.ts`
- `verify-accounting-close.ts`
- `verify-accounting-contractors.ts`
- `verify-accounting-db.ts`
- `verify-accounting-customer-funds.ts`
- `verify-accounting-feed-sync.ts`
- `verify-accounting-feed-db.ts`
- `verify-accounting-history-imports.ts`
- `verify-accounting-history.ts`
- `verify-accounting-import-comparison.ts`
- `verify-accounting-import-db.ts`
- `verify-accounting-invoice-history.ts`
- `verify-accounting-invoice-settlements.ts`
- `verify-accounting-invoice-sync.ts`
- `verify-accounting-invoices.ts`
- `verify-accounting-large-invoices.ts`
- `verify-accounting-manual-invoices.ts`
- `verify-accounting-operational-reports.ts`
- `verify-accounting-payroll-reporting.ts`
- `verify-accounting-payroll.ts`
- `verify-accounting-periods.ts`
- `verify-accounting-registers.ts`
- `verify-accounting-reports.ts`
- `verify-accounting-recovery-db.ts`
- `verify-accounting-retained-review.ts`
- `verify-accounting-statement-cutoffs.ts`
- `verify-accounting-statement-files.ts`
- `verify-accounting-tax-refresh.ts`
- `verify-accounting-tax-workpapers.ts`
- `verify-accounting-transfers.ts`
- `verify-accounting-workflows.ts`
- `verify-accounting-tax-payment-plan.ts`


## Step 4: source history and resumable imports

The history domain adds import_batches, import_rows and history_checks. The Wave adapter uses explicit debit/credit columns, exact dates and external_names.wave mapping, preserving blank Account ID values in immutable raw history. No original source files are copied into fixtures. The Wave fixtures are entirely invented, using the observed column structure. Synthetic receivable collections credit the receivable, not revenue; two nonzero offsetting expense lines survive; the all-zero opening group has a recorded exclusion reason and no entry.

Decisions and dependency boundaries:

- import_rows carries version/created_at/updated_at to preserve frozen per-row resolution versions. Source raw, parsed proposal, fingerprint, external ID and ordinal are immutable; corrections are new entries with a reversal and replacement. Bank observations are retained at staging, so cancel never removes their review queue. Cancel resets all unapplied rows to ready; resume re-evaluates source errors, duplicate identity and the raw-only zero exclusion before applying.
- Added import.resolve resolution `correct` for changed journal exports. Existing `new`, `match`, `exclude` survive. Changed recorded financial entries cannot use `new` to double book. Match validates actual lines/dates for journals or attaches a bounded bank match. No matching action silently changes an existing entry's origin.
- The ordinary import comparison remains a read function. Source-only changes remain separate from financial changes, with exact large integer cents and deterministic pagination. Removed capture/history persistence assertions are retired; duplicate IDs now fail earlier under the target unique constraint. Remaining original comparison count/balance expectations are retained.
- Wave report controls identify dates from metadata and preserve the declared accrual label. The owner-designated parity basis is cash. The opening balance sheet produces the opening check; later balance sheets supply annual balance controls to combine with the matching P&L. The standalone inspector is not called by npm or tests.
- `history_preview` and `history.check/verify` call the single future report engine, and `history.lock` calls the future close handler. Their end-to-end suites therefore remain unported until step 5. This avoids introducing a second report engine in the history migration. New imported financial postings invalidate the latest checks for the affected year and later balance-dependent years. Prior proof remains in audit.
- Flat annual controls require income, expense and net income; opening controls require assets, liabilities and total equity. Legacy monthly/account controls remain supported by the preview. Verified status requires a completed journal batch wholly covered by the check; bank batches always have parity_status n/a. Final report-export gate tests belong to step 5.
- The original rule-import negative values -8899 and -9900 are now covered in the Wave/import suite. The source-bank amount/date changes fail on save, earlier than the old post-time refusal. Original financial evidence remains unchanged. No zero or balancing journal line is invented.

Required newly ported tests at this boundary: verify-accounting-wave.ts and verify-accounting-import-comparison.ts. Existing import-db/history/history-imports/bank-matching suites still require report/close reads and will be ported in steps 5-6; these are not marked passed.

### Step 4 end evidence

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-import-comparison.ts`: `Import comparison: 36 checks passed.`.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-wave.ts`: `Wave adapter, import provenance, cancellation and correction: 35 checks passed.`.
- `npm run test:accounting:all --workspace=admin`: **16/51 suites passed**, exit 1. The new/ported suites and prior core suites passed. Ignored evidence: `admin/.local/phase1/step4-verification.json` and `step4-tests.txt`.

Expected unported/removed-feature failures at this step:

- `verify-accounting-authority.ts`
- `verify-accounting-bank-matching.ts`
- `verify-accounting-account-setup.ts`
- `verify-accounting-books-package.ts`
- `verify-accounting-clearing.ts`
- `verify-accounting-close.ts`
- `verify-accounting-contractors.ts`
- `verify-accounting-db.ts`
- `verify-accounting-customer-funds.ts`
- `verify-accounting-feed-sync.ts`
- `verify-accounting-feed-db.ts`
- `verify-accounting-history-imports.ts`
- `verify-accounting-history.ts`
- `verify-accounting-import-db.ts`
- `verify-accounting-invoice-settlements.ts`
- `verify-accounting-invoice-history.ts`
- `verify-accounting-invoice-sync.ts`
- `verify-accounting-invoices.ts`
- `verify-accounting-large-invoices.ts`
- `verify-accounting-manual-invoices.ts`
- `verify-accounting-operational-reports.ts`
- `verify-accounting-payroll-reporting.ts`
- `verify-accounting-payroll.ts`
- `verify-accounting-periods.ts`
- `verify-accounting-recovery-db.ts`
- `verify-accounting-reports.ts`
- `verify-accounting-registers.ts`
- `verify-accounting-retained-review.ts`
- `verify-accounting-statement-cutoffs.ts`
- `verify-accounting-statement-files.ts`
- `verify-accounting-tax-refresh.ts`
- `verify-accounting-tax-workpapers.ts`
- `verify-accounting-transfers.ts`
- `verify-accounting-workflows.ts`
- `verify-accounting-tax-payment-plan.ts`


### Step 5 in progress: close domain

The close migration adds reconciliations and reconciliation_items. close_checklist is a function, not an additional table, preserving the authoritative 27-table list. Statement evidence is optional. Completion requires exactly zero difference; partial signed allocations are bounded by their posted bank line and a line cannot be reused on another statement. A later posting reopens affected completed reconciliations. Snapshots use only accounting.report.

Reopening an earlier month reopens dependent later locked months atomically, with all prior snapshots preserved by the audit trigger. This preserves the existing invariant that a backdated financial change cannot silently invalidate a later locked balance sheet. This changes no financial entries.

Intermediate development evidence: `npx tsx --tsconfig admin/tsconfig.json admin/.local/phase1/check-report-close.ts` reports `Report and close draft: 20 checks passed`. It applies the close draft plus the in-progress report engine to an isolated PGlite fixture. Checks include the original 1278000 assets / 3000 liabilities / 1000000 capital / 200000 prior earnings / 75000 current profit, zero balance difference, snapshots, locked posting refusal, exact statement completion, and history/reconciliation invalidation after a one-cent late posting. This is development evidence, not the step 5 or Phase 1 gate. The report engine has not been committed yet; full ported suites will follow when all step 5 domains exist.


### Q4. Correcting a defect in a new, unapplied baseline function

The generic migration skill freezes committed files, while this task requires one full function definition in its domain file, no function patch chain, and a freshly generated unapplied baseline. Integration testing found a concrete SQL name-resolution defect in banking_command's discovery branch: `d.key=key::text` is ambiguous because jsonb_each also exposes key. Qualified `d.key=banking_command.key::text` is the recommended correction, without changing financial behavior.

Recommended resolution: correct the new unapplied baseline definition in its domain, mirror the canonical definition, keep one migration per correction commit and leave the archived chain untouched. This is the same fresh-baseline treatment already used for ledger integration corrections above. No hosted database or owner data is involved. Per the owner's latest operating rule, continue independent step 5 work now; if unanswered at the dependent step 6/gate, implement this recommendation and record its regression evidence. The discovery branch is not claimed verified until corrected. The payroll fixture uses an explicitly created synthetic bank mapping, independently of discovery.


### Step 5 in progress: payroll and registers domain

The payroll/register domain adds payroll_runs and registers. Default payroll.post uses cash accounting: declared gross wages plus employer taxes balance the net-pay and tax-deposit bank credits. It matches unambiguous observations and can replace their bank drafts. Supplied components must agree with declared totals. Additional deductions/reimbursements require the explicit alternative accrual template rather than silently treating an unpaid deduction as paid. Officer and other wages retain separately mapped expense accounts when supplied.

The alternative `template: accrual` uses declared mapped components and verifies expense/liability types, gross/net totals, exact balance, and retained source support. Historical linking validates exact lines and pay date; one posting cannot back two payroll runs. Voiding requires the payroll command, which posts a dated reversal. Noncash reclassification validates the original line/capacity and protects the original posting while referenced. No payroll is executed or paid by this app.

Registers keep actual movements as journal entries. A configuration item inside the schedule JSON preserves the frozen expense/fee/lender fields without extra columns or tables. Proposed/posted schedule items retain their stable row key and entry reference. Financial terms freeze once posted. Depreciation and loan payments are checked against recorded basis/principal; a dated running-balance guard also prevents a backdated change from making later basis negative. Historical attachment validates exact lines/date; metadata naming remains editable.

The contractor report uses the owner-set is_contractor flag, separately reports card amounts, and applies the existing 60000-cent threshold for 2022-2025 and 200000 cents for 2026. Years after 2026 require a versioned year rule rather than assuming inflation is zero. Refreshed primary references: IRS [2025 instructions](https://www.irs.gov/pub/irs-prior/i1099mec--2025.pdf) and [1099-NEC FAQ](https://www.irs.gov/faqs/small-business-self-employed-other-business/form-1099-nec-independent-contractors/form-1099-nec-independent-contractors). The old FS-2025-08 PDF URL now returns 404. This is a review worksheet, not a filing/eligibility decision; classification remains visible.

Intermediate development evidence: `npx tsx --tsconfig admin/tsconfig.json admin/.local/phase1/check-payroll-registers.ts` reports `Payroll and registers draft: 18 checks passed`. Synthetic gross 500000 plus employer tax 38250 balances net debit 380000 and tax debit 158250, both matched. Other assertions cover an explicit accrual template, void-only reversal, stale/immutable posted runs, 240000 asset cost and 4000 depreciation, 100000 loan proceeds and 10000 principal payment, excess depreciation/principal refusal and direct-read permissions. It currently uses the in-progress report draft. Older payroll/register suites are not yet ported and this is not a completion claim for step 5.


### Step 5 in progress: tax domain

The tax domain adds tax_mappings, immutable tax_adjustments and tax_links. It does not alter the personal tax_estimates table. The source uses the single report engine for book profit and applies per-line exact numeric tax rounding, retaining the original 10001-cent meals / 5001-cent deduction behavior. Mappings and adjustments are year-specific, audited and revision-bearing. Corrections to adjustments require new signed offset rows.

Recorded choices under standing decision 7:

- tax_adjustments retains an effective_date column so surviving dated adjustments preserve their original cutoff and monthly allocation. It must be in tax_year. New calls without a date use December 31, avoiding recognition before the annual adjustment is supplied. This is not a ledger posting.
- Existing separately stated concepts (qualified_dividend, short_gain, long_gain, charity, tax_exempt and ordinary_adjustment) survive alongside the target vocabulary. Legacy mapping names translate to the canonical names. Interest income defaults separately stated, while interest expense remains an ordinary deduction; an explicit separately_stated flag is preserved. Basis opening adjustments are evidence, never an inferred allowable-loss calculation.
- Legacy link body and enabled/reason fields live inside forecast_inputs. Safe-harbor inputs will use that same JSON, with pure TypeScript math. Profile classification is read directly, with a supplied effective year respected. A null effective year means no earlier year restriction is recorded, not that an election date has been verified.
- A five-minute refresh lease lives transiently inside tax_links.inputs, not in another table. Completion checks the exact financial revision, personal-estimate hash, business-profile hash, selected cutoff and token. A changed input returns stale. Successful finish retries with the same token/payload replay successfully. Workers have no owner impersonation and only the service role may call tax_refresh_server.
- The latest posted payroll run at/before cutoff supplies verified YTD. A void after cutoff does not rewrite that earlier view. Missing YTD on the latest run is not replaced with an older attestation. Original personal inputs are used only in a calculation copy; no worker writes personal estimator data.
- Frozen snapshot response keys project the last cached result from tax_links. Tax snapshot history/jobs tables are removed. Snapshot ID is the link ID; this is a cache, not immutable historical output. report_snapshots remains the immutable export mechanism. This equivalent projection is logged under standing decision 6.

Intermediate evidence: `npx tsx --tsconfig admin/tsconfig.json admin/.local/phase1/check-tax.ts`: `Tax draft: 20 checks passed`. The isolated synthetic fixture covers 89999 book profit, 94999 taxable ordinary income after meal deductibility, signed adjustment/offset, immutable adjustments, read/worker grants, repeat completion, personal-input preservation, and stale results after ledger or personal changes. It applies the in-progress report draft; this is not the step 5 or Phase 1 gate. Existing tax suites still require porting.


### Q4 resolution at the dependent report integration

The owner has not supplied a separate answer, so the latest standing operating rule applies: implement the logged recommendation at the dependent step. Integration has now reached report packages, which depend on the payroll read contract. New unapplied baseline corrections stay in their owning domain, with one migration per correction commit and matching canonical updates. No archived file is changed. This resolves Q4; baseline function definitions are not patched or duplicated in later files.

Payroll integration also found two validation defects to correct: supplied net-pay components must agree with declared net pay in the cash template, and multiple noncash components in the same run must share the original expense line's capacity. Neither correction changes a valid recorded amount. The payroll read adds the frozen year summary keys and respects the cutoff, using actual run employee totals separately from cumulative YTD. Package generation must not invent missing employee wage facts.

Correction evidence: npx tsx --tsconfig admin/tsconfig.json admin/.local/phase1/check-payroll-registers.ts reports 'Payroll and registers draft: 22 checks passed'. New checks preserve the September 1 run before its September 2 void, remove it after the void, reject a 9999 net component against 10000 declared net, and reject two 4000 noncash components against one 5000 source line. The final tracked port will retain these assertions.

Q4 banking correction evidence: npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-banking.ts reports 'Banking, matching, rules and worker isolation: 43 checks passed'. An explicit PL/pgSQL block label qualifies the local key in discovery lookup. The new tracked assertion maps a discovered account without supplying connection_id and verifies the retained connection/provider identity.

Tax evidence correction: document availability uses the target document status (inbox/linked/archived) plus the retained private storage object. The development code had incorrectly checked an unsupported uploaded status. npx tsx --tsconfig admin/tsconfig.json admin/.local/phase1/check-tax.ts now reports 'Tax draft: 22 checks passed', including refusal before upload and acceptance of a supported adjustment/offset after upload.

The payroll YTD read uses the same target document-state/private-object test. npx tsx --tsconfig admin/tsconfig.json admin/.local/phase1/check-payroll-registers.ts reports 'Payroll and registers draft: 23 checks passed', now explicitly asserting that the retained supported September 1 YTD is current before the later void.


### Step 5 in progress: unified reports and retained exports

The reports migration adds the 27th accounting table, report_snapshots. It defines the single financial report engine, shared cash allocations, line drill-down, ledger, workspace, support reports and retained report/package commands. Cash allocations use exact largest-remainder cents and counter-account classification, including operating card/payroll liabilities, transit transfers, financing equity/loans and investing fixed assets. Posted snapshots remain immutable. Stored account codes project null to the existing empty-string response convention so existing report rendering remains compatible.

P&L, balance sheet, trial balance, monthly totals, comparison columns and drill-down share posted-book scope. Working mode includes only balanced drafts. Balance-sheet retained earnings use the business profile fiscal year. Journal import parity gates exports; bank batches never gate them. Balance-dependent reports also include earlier journal batches in their completeness check. Tax workpapers remain year-to-date through their cutoff. Payroll support preserves earlier cutoffs when a later void exists. Register controls compare actual attached movements against ledger balances without blocking month close.

The existing report.capture, report.snapshot, report.support.capture and report.books.capture names survive. Support captures use kind year_end_package with their exact subtype in data.type/params, since the target snapshot kind vocabulary has no separate support kind. Frozen snapshot response keys (id/revision/created_at/payload) map directly to the new row. Packages retain complete ledger/support rows, refuse truncation and share a single financial revision. Operational receivables/customer-credit reports belong to removed invoice/customer-funds features and will be retired with those suites.

New tracked integration suites promote the synthetic development checks, with no ignored draft SQL dependency: verify-accounting-report-core.ts, verify-accounting-payroll-core.ts, verify-accounting-tax-core.ts. The older comprehensive suites remain unported until the remaining step 5 contract work is complete. This is not the Phase 1 gate.

Tracked integration evidence: npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-report-core.ts: 'Report, close and retained package integration: 39 checks passed'; verify-accounting-payroll-core.ts: 'Payroll and register integration: 23 checks passed'; verify-accounting-tax-core.ts: 'Tax inputs and refresh integration: 22 checks passed'. These now apply only active migrations through the normal harness. Report tests include 18 ledger lines, complete 14-document package generation, immutable captured 75000 profit, deterministic pagination, 1200000 opening checking balance, balanced-preview exclusion and an exact one-cent fractional cash allocation.


### Removed-feature suite retirement during step 5

The following suites are deleted with the features explicitly removed by target section 5. Git retains their prior versions. Operational reports here tested only invoice aging/customer credits. Retained-review tested the removed retained-earnings review state machine; actual opening-balance and history parity scenarios survive in core/history suites. Recovery runner verification is retired and will not contact any fixture/host.

- verify-accounting-authority.ts
- verify-accounting-clearing.ts
- verify-accounting-customer-funds.ts
- verify-accounting-invoice-settlements.ts
- verify-accounting-invoice-history.ts
- verify-accounting-invoice-sync.ts
- verify-accounting-invoices.ts
- verify-accounting-large-invoices.ts
- verify-accounting-manual-invoices.ts
- verify-accounting-operational-reports.ts
- verify-accounting-retained-review.ts
- verify-accounting-statement-cutoffs.ts
- verify-accounting-recovery-db.ts
- verify-accounting-recovery.ts

The pure safe-harbor assertions in the mixed tax-payment-plan suite will be retained while its removed persistence section is retired. No ledger/import/close financial assertions are discarded by this removal.


Step 5 intermediate full run: `npm run test:accounting:all --workspace=admin`: **19/41 suites passed**, exit 1. Evidence is `admin/.local/phase1/step5-progress-verification.json`. These remaining suites are expected to fail until their port completes:

- verify-accounting-bank-matching.ts
- verify-accounting-account-setup.ts
- verify-accounting-books-package.ts
- verify-accounting-close.ts
- verify-accounting-db.ts
- verify-accounting-contractors.ts
- verify-accounting-feed-sync.ts
- verify-accounting-feed-db.ts
- verify-accounting-history-imports.ts
- verify-accounting-history.ts
- verify-accounting-import-db.ts
- verify-accounting-payroll-reporting.ts
- verify-accounting-payroll.ts
- verify-accounting-periods.ts
- verify-accounting-registers.ts
- verify-accounting-reports.ts
- verify-accounting-statement-files.ts
- verify-accounting-tax-refresh.ts
- verify-accounting-tax-workpapers.ts
- verify-accounting-transfers.ts
- verify-accounting-workflows.ts
- verify-accounting-tax-payment-plan.ts

The schema suite has now been ported rather than comparing empty legacy catalogs: `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-schema.ts` reports `Target schema: 27 accounting tables, 52 functions; exact table list, private grants and no active migration patching verified.` and `Canonical schema parity: 14 catalog comparisons passed (tables, columns, constraints, indexes, functions, triggers, policies).` The final declarative snapshot regeneration and trigger count still belong to step 7.


### Step 5 legacy ledger and detailed-report port evidence

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-db.ts`: `Accounting PostgreSQL: 72 assertions passed. PGlite executes real SQL; multi-connection races require staging verification.` Original exact financial totals, -125000 corrected profit, 18446744073709551614 summed debits, rollback/receipt/audit atomicity, stale/idempotency failures, direct-write refusals, posted immutability and role restrictions remain. The removed broad export RPC is replaced in this suite by test-only privileged state inspection, with separate owner/worker read permission assertions.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-reports.ts`: `Detailed reports, exact comparisons, cash classifications and payee reversals: 96 assertions passed.` Original 75000/200000 comparisons, 1278000 balance sheet, 18-line ledger, CSV formula escaping, PDF header, scoped ledger and retained snapshot assertions survive. Removed project/customer dimensions use the surviving payee attribution for the 275-cent reversal fixture. Card -12000 and payroll -100000 now derive operating classification, so unclassified count is zero, and operating cash after the card reversal is 90000. The former 190000 amount is explicitly reconciled by separating the -100000 payroll payment. Removed per-line allocation persistence tests are replaced by derived-classification and direct-write refusal assertions.
- Report validation now refuses invalid account filters and non-ledger scoped captures. Chronological detail order preserves the original running-balance expectation. `verify-accounting-report-core.ts`: `Report, close and retained package integration: 39 checks passed`; `verify-accounting-schema.ts`: `Target schema: 27 accounting tables, 53 functions; exact table list, private grants and no active migration patching verified.` and `Canonical schema parity: 14 catalog comparisons passed (tables, columns, constraints, indexes, functions, triggers, policies).`

Deferred contract item for step 6: the old cash.allocate command operated a removed allocation table. Keep its name for draft line cash_class overrides with exact-sum validation; posted line changes require the existing correction flow under the target immutability rule. A single cash_class cannot represent arbitrary multiple manual classifications. Retain the derived split breakdown from counter-lines; reject a mixed override without modifying money. Request for Claude: adapt the surviving cash review controls to that draft/correction model. This follows the target frozen-lines rule and does not add a table.


### Q5. Correcting an incorrectly dated transaction

The original close suite has a 900-cent receipt initially dated May 5, corrected to its actual April 5 date by a May 5 reversal plus an April 5 replacement. The new ledger currently forbids a replacement before the original date. The target specification freezes original entries but does not prohibit correcting a mistaken date, so that extra restriction would lose an existing accounting workflow.

Recommendation: permit the replacement on its actual open financial date, subject to earliest_history_date and period locks, while the full reversal remains on or after the original date. Preserve provenance, original lines, reason and replacement linkage. The result must remain April income 900 and May income 0. Continue the independent period-suite port; under the latest operating rule, apply this recommendation at the dependent close test if the owner has not answered. No source import is shifted or reclassified automatically.


Q5 resolution at the dependent close test: no separate answer has arrived. Apply the logged recommendation under the owner's latest operating rule. The original-date error is corrected by an earlier replacement inside the open history boundary; the reversal still cannot predate the original. The core immutable posting and lock guards remain in force.


### Step 5 period and statement reconciliation port evidence

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-periods.ts`: `Period locks, dependent reopen and retained filing packages: 15 assertions passed.` Preserves two dependent locks, zero locks after reopening, twelve annual locks and 26 retained lock events across the original cycles. Filed-year/restatement state and broad recovery exports are removed; immutable year-end packages and the audit's original close snapshots replace them. A backdated draft is refused at creation, earlier than the old posting check.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-close.ts`: `Statement reconciliation, dated corrections and optional close evidence: 21 assertions passed.` Retains 10000 opening, 10000 deposit, -2500 withdrawal and 17500 ending, including -1000 partial selection and -1500 remaining difference. The target stores one allocation per journal line; the two former source items are represented by their combined -2500 line selection. Tests refuse -2501 over-allocation, reuse on another statement, completed selection edits, and direct reads. A 500 savings statement reopens after the later one-cent posting. The 900-cent actual-date correction passes with April 900 and May zero; a replacement before the history boundary is refused.
- Optional reconciliation metadata may be reopened after period lock without changing any snapshot or money. This replaces the removed statement supersession/restatement gate. Account-lifecycle state-machine assertions are retired here; account archive guards remain in the ledger suite and bank closure data is retained on bank_accounts.
- Q5 regression checks: verify-accounting-ledger.ts reports 50 checks; verify-accounting-db.ts reports 72 assertions; verify-accounting-transactions.ts reports 27 assertions; verify-accounting-schema.ts reports 27 tables / 53 functions and 14 catalog comparisons. All pass.

### Step 5 historical controls and pure tax payment planning

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-history.ts`: `Historical parity controls: 15 assertions passed.` Retains monthly 20000/5000/15000 and 30000/15000/15000 income/expense/net, 40000 bank balance including prior 10000, two locked periods and late one-cent invalidation. New negative checks reject duplicate months, wrong monthly boundaries and unknown control accounts. Missing months remain unverified. Aggregate control comparisons use numeric so totals exceeding an individual bigint remain exact.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-tax-payment-plan.ts`: 50 pure safe-harbor assertions passed. Removed payment-plan persistence tests are retired with their removed tables; the pure calculator remains for the tax-link view in step 6.
- History baseline correction regression: Wave adapter 35 checks, import comparison 36 checks, report core 39 checks all passed in isolated PGlite. No source exports or hosted databases were used.

### Step 5 retained books package port

`npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-books-package.ts`: `Books package: 63 assertions passed (coherent revisions, exact cents, retained worksheets, ZIP manifests, replay and access).` Preserves 9007199254740993 ledger cents, 9007199254640993 net after payroll, -101 tax adjustment, immutable captures, hash/length validation for every ZIP member, CSV formula escaping, null payroll facts and private access. Five support reports replace six because payroll-liabilities belonged to removed clearing obligations; this yields fourteen documents and seventeen ZIP files instead of fifteen/eighteen. The ordinary_income input alias now displays the canonical gross_receipts concept with unchanged financial treatment.

The suite exposed an incomplete package preview inventory and missing payroll review notice. The report baseline now uses all five support reports for preview counts, preserves payroll/register/tax review notices in the retained package, and refuses future package cutoffs using the books timezone. Package generation still shares the single report engine. Regression: report core 39 checks, detailed reports 96 assertions, schema 27 tables / 53 functions with 14 catalog comparisons, all passed.

### Step 5 payroll and contractor port evidence

- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-payroll.ts`: `Payroll accrual alternative, source linkage and reversal guards: 35 assertions passed.` The explicit accrual alternative retains gross 500000, net 420000, employer tax 35000, payroll tax liability 105000, exact balance and two actual net disbursements 200000 + 220000. It retains duplicate, stale, unsupported-component, mismatched-total, source reuse, 20000 noncash capacity, dependency and permission failures. No clearing allocations or obligations survive. Posted/void runs cannot be rewritten. Historical linkage creates no journal; historical void is now an explicit journal reversal rather than unlinking recorded money, as the target specifies. The original linked/voided statuses project to target posted/void.
- The test caught three validation omissions: explicitly false verification was accepted, employee gross/officer totals could disagree with the run, and a payroll draft could be saved into a locked period. These are now rejected without posting or changing financial data. Cash remains the default; the accrual suite explicitly selects its template.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-payroll-reporting.ts`: `Payroll reports, actual run facts and moving-cutoff YTD: 30 assertions passed.` Retains 100000 run gross, 95000 verified provider taxable wages, null missing per-run tax facts, immutable 1000.00 rendered totals and dated voids. The latest run's YTD replaces removed attestation/coverage commands: advancing the cutoff does not invalidate the same register; a newer run missing YTD does not borrow older evidence. Missing storage objects invalidate evidence. Removed liability worksheet assertions are retired; cash payroll does not create obligations.
- `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-contractors.ts`: `Contractor cash, card exclusions, refunds and retained worksheets: 28 assertions passed.` Original cash 100000, refund -1000, card 100000 and prior-year 50000 remain exact. Owner-funded noncash 20000 is not silently counted as bank cash. Threshold equality at 200000 is tested. Owner classification and documentation metadata survive; removed per-payment contractor allocations, reviews, history and restatement machinery are retired. Reports are payment worksheets, not automated filing decisions.
- Regression: payroll core 23 checks, payroll reporting 30 assertions, tax core 22 checks, books package 63 assertions and schema 27 tables / 53 functions with 14 catalog comparisons all pass.

### Step 5 register port evidence

`npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-registers.ts`: `Asset and loan movements, dated balances and retained controls: 44 assertions passed.` Preserves acquisition 100000, depreciation 20000, carrying value 80000, disposal proceeds 75000 and loss 5000. A 500000 loan draw followed by 100000 principal, 2500 interest and 500 fee produces the original -103000 bank movement and 400000 principal. The suite retains dated reversals, 200000 register totals, mismatch 1000, immutable 2000.00 exports, schedule duplicate protection and locked-period failures.

The regression exposed two errors: a disposal loss could use an income account, and reversing depreciation after disposal could make accumulated depreciation positive. Both are rejected now; expense and fee account types are also checked. The target's single journal_entries.register_id replaces former partial historical allocations across multiple registers. Historical linkage must match the full existing journal exactly and cannot reassign another register's journal. It never changes the original amounts. Removed loan-schedule import and register movement/revision tables are not recreated. Optional register differences do not gate month lock.

Regression: payroll core 23 checks, payroll accrual 35 assertions and schema 27 tables / 53 functions with 14 catalog comparisons passed.

Intermediate full run before this register port: `npm run test:accounting:all --workspace=admin` reported **29/41 suites passed**, exit 1. Evidence: `admin/.local/phase1/step5-current-verification.json`. Expected unported failures: bank-matching, account-setup, feed-sync, feed-db, history-imports, import-db, registers (now ported), statement-files, tax-refresh, tax-workpapers, transfers and workflows. The Phase 1 gate has not been reached.

Step 5 tax port in progress: the original negative fixtures exposed missing account-type validation in tax mappings. Expense concepts now require expense accounts, gross receipts require income and 10000 bps, investment income concepts require income, and distributions/contributions require equity. Tax source cutoffs reject null, wrong-year and future dates using the books timezone. `verify-accounting-tax-core.ts`: `Tax inputs and refresh integration: 22 checks passed`. The older workpaper suite now reaches its partial-year report check; that remaining report-layer correction is next. No claim that this suite is complete yet.

### Step 5 tax workpapers port evidence

`npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-tax-workpapers.ts`: `Accounting tax workpapers: 60 assertions passed.` Original book profit 80499, mapped ordinary 84999, separately stated interest 500 and 4500 book-to-tax difference remain exact. The -2000 adjustment yields 82999; an explicit +2000 offset restores 84999 while retaining both rows. Opening stock basis 1000000 stays evidence only, with no inferred loss allowance. A 3-cent meal rounds to 2 cents of deduction; reversal restores the prior amount. The 9007199254740993 adjustment survives exactly and is offset without editing history. Independent years, stale mappings, immutable exports, missing document evidence and owner permissions remain covered.

Removed annual tax-classification records read the shared business profile. Tax mappings are versioned current rows with audit history; adjustments are immutable rows corrected with offsets, so the former active/versioned-adjustment and basis-attestation machinery is retired. A missing adjustment document is reported without changing recorded money. Mapping rows no longer require documents because the target has no mapping document field. The workpaper report now refuses partial-year starts instead of labeling full-year totals as a shorter period. Regression: report core 39 checks, books package 63 assertions, tax core 22 checks and schema 27 tables / 53 functions with 14 catalog comparisons passed.

Retired `verify-accounting-statement-files.ts`: its subject is removed statement.import, statement.amend, item-source history and recovery export tables. CSV parsing, document uploads and actual reconciliation money remain covered by their surviving suites. No failing statement-file suite is retained for the gate.

### Step 5 tax worker port evidence

`npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-tax-refresh.ts`: `49 tax refresh checks passed.` The original manual estimate 12345 stays unchanged in storage through refresh, retries, failure and disable. This fixture uses an election effective in 2027 to exercise the original unavailable-treatment fallback for 2026. Tests retain finite-calculation checks, uncertain-finish handling, invalid-input failure, lease contention/expiry/replacement, personal-input and financial-revision invalidation, retry delay, permission checks and no owner impersonation. Current cache replaces removed snapshot/job history tables; an already-read cache remains unchanged in the caller while the next cache is computed.

Worker fixes exposed by the port: due returns the existing array of id objects and excludes current, leased and delayed rows; a competing start returns busy rather than running without a token; superseded tokens return superseded without altering the active lease; failures wait five minutes; worker cache updates preserve the owner's configuration version. Status remains the target fresh/stale/error, so successful worker responses use fresh. Manual test-only clock changes are privileged edits and may increase version; the real worker does not. Regression: tax core 22 checks, workpapers 60 assertions and schema 27 tables / 53 functions with 14 catalog comparisons pass.

Step 5 remaining account regression port: `npx tsx --tsconfig admin/tsconfig.json admin/scripts/verify-accounting-account-setup.ts` reports `Account setup: 30 assertions passed (atomic profiles, rollback, replay, identity and exact statement signs).` Inline account metadata replaces the separate profile. The original invalid bank/card/expense setups exposed missing natural-type guards; recognized subtypes now enforce their asset/liability/equity/income/expense type, and cash/bank/card accounts cannot have a contra normal side. Custom subtype text remains possible for imported classifications. Parent failures roll back atomically, system-purpose edits fail, and exact sign conversion retains 9007199254740993. Regression: ledger 50, PostgreSQL 72, banking 43, register 44 and schema 14 catalog comparisons all pass. Request for Claude/step 6: use canonical subtype names; the former free-label "Cash and bank" plus cash_kind must map to bank at the server boundary.

Step 5 import/transfer regression ports:

- `verify-accounting-import-db.ts`: `Accounting import persistence: 15 assertions passed.` Two journals post once, 20000 income remains unchanged by overlapping bank evidence, changed identities become exceptions and the -1250 unmatched expense becomes one draft. Bank staging now reports ready rows until match/apply; overlapping evidence is not a second transaction row.
- `verify-accounting-history-imports.ts`: `Historical import parity, explicit exclusions and immutable sources: 10 assertions passed.` Cancel/resume preserves partial staging, the explicit synthetic closing exclusion keeps its raw record and reason, and 10000 income / 2000 expense / 8000 profit with 108000 ending assets verifies. A control expecting 116000 fails. Removed history.disposition normalization and backup tables are not recreated. This is an explicitly chosen synthetic exclusion, not automatic conversion of Wave data. Completed batches now refuse cancellation or resume.
- `verify-accounting-transfers.ts`: `Dated transfers, card payments, and atomic reversal: 17 assertions passed.` Retains same-day one-entry transfers, 50000 positive transit at January end, zero after February arrival, -50000 for early card arrival, zero income/expense, replay and atomic reversal. Transit comes from the seeded system-purpose account. Removed clearing and transfer-group tables are replaced by actual ledger balances and entry transfer_group_id.
- Regression: Wave 35 checks, `Historical parity controls: 15 assertions passed.`, import persistence 15 assertions and schema 27 tables / 53 functions with 14 catalog comparisons all pass.


Step 5 bank matching regression: `verify-accounting-bank-matching.ts` reports `Partial bank matching, draft replacement and corroborated reversals: 23 assertions passed.` Preserves a 50000 bank receipt matched to 20000 and 30000 journals, exact remaining amounts, changed-source exceptions, capacity refusals, explicit release, and zero-allocation independent corroboration. The target reserves capacity for a matched draft, so replacing it requires explicit discard before the first partial posted allocation rather than only at the final allocation. No financial capacity is counted twice. Source matching is tested with canonical bank_transaction_id; legacy import group_id translation remains part of the step 6 route contract port.

The test caught reversed journals retaining active matches. Reversal now releases zero-allocation corroboration first and then primary allocations, with an audit reason, returning all affected source observations to review. The original journal and raw observation remain unchanged. Regression: banking 43, ledger 50, payroll core 23, transfers 17 and schema 14 catalog comparisons pass.

## Phase 1 step 5 domain completion and step 6 handoff

`npm run test:accounting:all --workspace=admin`: **37/40 suites passed**, exit 1. Exact summary: `37/40 suites passed.` Evidence is `admin/.local/phase1/step5-end-verification.json` and `step5-end-tests.txt`. Every ported suite is green. Expected failures entering step 6 are only verify-accounting-feed-sync.ts (legacy worker orchestration), verify-accounting-feed-db.ts (legacy worker RPC/claim/window objects), and verify-accounting-workflows.ts (legacy dispatcher/read contracts). These depend on the step 6 library/service port and will not remain failing at the gate. All removed-feature suites retired so far are deleted rather than ignored.

Step 5 domain migrations, retained reports, close, payroll, registers, tax, history/import, banking/matching and account regression ports are complete with the evidence above. Phase 1 itself is not complete. Next: port surviving library and route contracts, remove the listed UI components with only the allowed mechanical shell edits, then run the full gate. No hosted database or protected fixture service has been used.

### Step 6 in progress: worker transport port
- Ported `syncSimpleFin` from removed request/window tables to `accounting.sync_server` lease/complete/fail. The current run's seen accounts and conflicted account keys live in the existing connection checkpoint JSON. Bounded chunks (100 observations) remain durable, only the final complete chunk advances its account, and a conflict in an earlier chunk prevents later chunks from advancing that account. Discovery never changes transaction coverage. A replaced lease cannot write. Worker due discovery stays inside the only granted worker function.
- Chosen implementation details under standing decision 7: run-local checkpoint bookkeeping is reset when a new lease starts; worker completion includes the surviving `complete` response; a partial run never updates `last_success_at`. No new table or dependency.
- Ported the feed DB suite from removed claim/window/backup tables. Legacy explicit-prepare import staging and statement/coverage gate expectations are retired with those features; bank evidence, changed-provider protection, authorization, checkpoints, leases, and failure durability remain tested in the replacement suite and banking suite.
- Evidence: `node node_modules/tsx/dist/cli.mjs admin/scripts/verify-accounting-feed-sync.ts`: `SimpleFIN worker failure boundaries and encryption: 35 assertions passed.`; `... verify-accounting-feed-db.ts`: `SimpleFIN durable chunks, checkpoints and worker isolation: 30 assertions passed.`; `... verify-accounting-banking.ts`: `Banking, matching, rules and worker isolation: 43 checks passed`.
- Step 6 is not complete. The route/client port and workflow suite are still pending. Phase 2 default draft creation has not been enabled by this transport port.

### Step 6 decisions and UI handoff request
- Q6 (resolved under standing operating rule): surviving metadata views (`manage`, `feeds`, rules, history and the tax-link selector) need an owner read after removing their old RPCs. Recommendation implemented at the dependent step: one `accounting.context(view, params)` read projection, owner-gated with no write capability, rather than recreating the old RPC family. Financial views continue to use the report engine. This adds one function, not a table. Its basic empty-book projections were exercised against PGlite with `node node_modules/tsx/dist/cli.mjs admin/.local/phase1/context-check.ts`: eight views returned `OK` (session, manage, feeds, rules, history, close-history, tax, tax-history). Populated/frozen-shape tests remain part of the pending workflow port.
- **Request for Claude:** kept UI still references removed dimensions, journal templates, saved views, retained-year reviews, statement-file matching and persisted tax payment plans. Remove those controls and their typed fields/call sites on the UI branch. I will delete only the exact components and shell imports/nav/cases authorized by the brief. The repo-wide type gate may expose remaining UI references until Claude's corresponding edits arrive; those will be listed with compiler evidence rather than hidden by compatibility fields for removed features.
- Command/response removal decisions follow the removal map: invoice families, broad backup/restore, authority gates, clearing allocations, statement-file ingestion, dimensions/templates/saved views, persisted payment plans, per-payment contractor reviews, tax-year/basis tables, and retained-year review histories are removed. The current tax cache remains readable and year-end rendered report packages remain downloadable.
- Step 6 feed/document route integration: owner clients now select the `accounting` schema and authorize using the lightweight session projection; the service clients call only `sync_server`/`tax_refresh_server`. The one-use SimpleFIN claim is reserved in connection checkpoint JSON before contacting the provider. `claim.send` can succeed once; mismatched nonce, repeated send and late failure after success are refused. Ciphertext never enters the owner projection or audit payload. Document response `state` remains `uploading`/`available`/`archived`, derived from actual private storage existence and status, while canonical status is retained separately.
- Evidence: feed DB suite now prints `SimpleFIN durable chunks, checkpoints and worker isolation: 35 assertions passed.`; documents suite prints `Accounting document permissions: 11 assertions passed.`. Route and workflow contract validation is still in progress, not a completion claim.
- Step 6 ledger contracts: transaction rows now include immutable `source_description`, `descriptor_key` and `prior_treatment` (last category/payee/count). Missing-receipt filtering requires an actual available object linked to the entry. Existing `cash.allocate` is a version-checked draft cash-class override; split classes require split entries and posted changes require correction. Existing annotation IDs survive as audit metadata, with notes stored on the entry and prior notes readable from audit. Human-readable account subtype labels defer to an explicit surviving `cash_kind` for bank/cash/card accounts.
- `settings.save` accepts the shared profile with its own expected profile version. A failed profile version check rolls back the settings update too. `preferences.save` retains the surviving legal-name/history fields. New command contracts added: `entry.categorize`, `entry.split`, `bank.sync_request`, `settings.save`; `payroll.post` accepts the surviving approval payload. Alias and register-save names already existed and stay.
- Workflow suite port preserves the original 11-row fixture, checking opening `1200000`, closing `1228000`, correction net income `74000`, atomic reversal rollback, bulk-post rollback, idempotency, account identity protection and unauthorized reads. Removed dimension and backup-export checks were retired; snapshot immutability remains. A transaction with its context now uses one row version rather than a second context-table write, so initial version expectations are 1. An annotation increments the same entry version.
- Evidence: `node node_modules/tsx/dist/cli.mjs admin/scripts/verify-accounting-workflows.ts`: `Accounting workflows: 43 assertions passed.`; `... verify-accounting-transactions.ts`: `Transaction review, sorting, exact split and presentation: 27 assertions passed.`; `... verify-accounting-db.ts`: `Accounting PostgreSQL: 72 assertions passed.`. Remaining Step 6 work includes full populated read projections and surviving API/type checks.
- Intermediate full run: `npm run test:accounting:all --workspace=admin` produced `39/40 suites passed` (`admin/.local/phase1/step6-progress.json`). The account setup regression caught a conflicting explicit natural subtype being hidden by `cash_kind`. Fixed precedence: a canonical subtype is validated as supplied; only noncanonical UI labels defer to cash kind. Targeted rerun: `Account setup: 30 assertions passed (atomic profiles, rollback, replay, identity and exact statement signs).` This is not the Step 6 gate run.
- Step 6 payroll/register reads: extracted the existing posting calculations into private `payroll_plan` and `register_plan` functions so preview and posting cannot diverge. The owner-facing `payroll(view)` and `registers(view)` families retain list/detail/preview keys and project history from audit instead of the removed revision/movement tables. Added two private functions, no tables. Register lists remain bounded to 100 rows and carry total count; snapshot/report inventory still uses the report engine.
- **Request for Claude:** cash payroll approval/preview needs the explicitly selected `bank_account_id` and optional `template` (`cash` default, `accrual` explicit). Do not infer a bank from the old payroll liability mapping. New fields are accepted alongside the surviving `payroll.approve` name and new `payroll.post` name. Removed obligation/clearing arrays should no longer drive the payroll UI.
- Evidence: `... verify-accounting-payroll.ts`: `Payroll accrual alternative, source linkage and reversal guards: 35 assertions passed.`; `... verify-accounting-payroll-core.ts`: `Payroll and register integration: 29 checks passed`; `... verify-accounting-registers.ts`: `Asset and loan movements, dated balances and retained controls: 50 assertions passed.`
- Step 6 populated read coverage: the new read bridge exercises the actual domain RPCs in PGlite, including workspace totals, source/note evidence, cash classification, statement selection, transfer groups, reports, rules, tax source and metadata. New permanent suite: `node node_modules/tsx/dist/cli.mjs admin/scripts/verify-accounting-read-contracts.ts`: `Accounting HTTP view bridge and frozen read contracts: 71 assertions passed.` This also checks owner-only access and rejects removed command names. The register/payroll preview suites cover those detail branches separately. The bridge performs no financial calculations.
- Step 6 bank review drawer preserves the selected import group ID and translates it to the immutable bank observation for reads and matching. Candidate lines are bounded, same-account and same-sign with available capacity; matched drafts and remaining cents use the same allocation records. Evidence: `node node_modules/tsx/dist/cli.mjs admin/scripts/verify-accounting-bank-matching.ts`: `Partial bank matching, draft replacement and corroborated reversals: 29 assertions passed.` The added assertions exercise legacy group_id matching and drawer amounts before and after draft replacement.
- Step 6 Wave HTTP path now detects ledger headers before the generic CSV parser, preserving the literal separator header. Inspect keeps its existing keys and adds adapter/account proposals. Parse uses saved external_names.wave mappings and the shared history boundary, refuses conflicting selected mappings, and includes the effective mappings in its hash. account.create/update accept external_names.wave. import.stage accepts opening kind, explicit exclusion reasons and raw parsing exceptions; import.resume and import.resolve(correct) reach their existing domain handlers. ImportBatch uses parity_status instead of coverage_verified. Synthetic route-boundary schemas are covered; no owner export was read or copied for this change.
- Populated rule reads retain the flat description/category/payee/amount keys alongside canonical conditions/actions. Manage profiles expose type and external_names for the Wave adapter. Evidence: Wave adapter suite 41 checks passed; HTTP view bridge 80 assertions passed; schema suite 27 tables, 56 functions and 14 catalog comparisons passed. Initial populated rule read exposed an ambiguous key reference, corrected and rerun. Step 6 remains in progress.
- Step 6 close aliases retain period.close and reconciliation.unmatch, delegating to the existing lock and selection-removal logic. The close view keeps month_start, through, month_ended, accounts and reports, with financial data still from workspace/report. Evidence: close regression 21 assertions passed using the legacy names; schema parity 14 comparisons passed. A mistaken invocation of the nonexistent close-core suite was not counted as evidence. Canonical parity also caught an incidental rule_candidate text replacement in the prior edit; canonical was restored to its unchanged banking definition.
- Step 6 safe-harbor integration: existing exact-cent installment math is now returned as safe_harbor on the tax link view. Its optional reviewed inputs live in tax_links.forecast_inputs.safe_harbor, not a plan table; document availability is checked from private storage on each read. Removed tax.plan.save and persisted plan-view/snapshot types. The original federal/manual methods, evidence requirements and supported-year limits are unchanged. Shared validation was split into tax-payment-inputs.ts to avoid an import cycle, with no new dependency. Evidence: pure safe-harbor suite 52 assertions passed; HTTP read bridge 80 assertions passed.
- Step 6 payroll boundary accepts the target cash-basis save body alongside the surviving detailed body, with explicitly typed source YTD facts. Payroll detail accepts selected bank/template for the shared preview. Lists honor as_of, query, status and offset; totals and count cover the full filtered set rather than only one page. Evidence: payroll/register core 34 checks passed (cash body through Zod, exact preview, cutoff, empty page with unchanged totals); payroll accrual regression 35 assertions passed; schema parity 14 comparisons passed.
- Step 6 contractor contract removes the per-payment review/body/history types and keeps annual party totals, classification, documentation, cash paid and separate card amounts. The optional cutoff argument added to contractor_report preserves the surviving through filter; the one-argument annual call is unchanged. Search/party/pagination only select the computed rows in the read bridge. Removed import.comparison.capture and its persisted history type; read-only comparison remains. Evidence: contractor regression 31 assertions passed, including 100000 before a refund versus 99000 afterward and a wrong-year rejection; schema parity 14 comparisons passed.
- Step 6 history surface adds history.check with typed exact-cent report controls and preserves history.lock as the existing operation over passed history checks. Removed the stale history.disposition SQL branch as well as its HTTP type; explicit import exclusions remain import.resolve(exclude). The first history regression caught an overbroad removal of history.lock, restored before commit. Evidence: historical parity suite 15 assertions passed; schema parity 14 comparisons passed. Feed types no longer contain generation, request-budget or coverage-gap records from removed tables.

- Step 6 rule application now records its immutable candidate and resulting lines in audit_log, retaining the applied rule version/name even after rule edits. Candidate previews retain flat frozen fields alongside canonical conditions/actions. No table added. Evidence: verify-accounting-rules.ts reports 23 assertions passed; schema reports 27 tables / 56 functions and 14 catalog comparisons passed. Baseline-file edits follow resolved Q4; these files remain unapplied outside disposable fixtures.
- Step 6 evidence view retains rules[] using the immutable application audit payload. Rule regression now reports 27 assertions passed, including exact -1999 bank amount, balanced resulting lines, and unchanged original evidence after a rule rename. Schema parity remains 14 comparisons passed.

## Phase 1 step 6 completion

- Full surviving runner: `npm run test:accounting:all --workspace=admin` prints `41/41 suites passed.` Evidence: `admin/.local/phase1/step6-final-tests.txt` and `step6-final.json`. No suite is expected to fail now. An earlier run caught a malformed payroll type removal; corrected before the passing run. Another run passed all individual suites but failed writing an incorrectly relative report path; the final run uses an absolute report path and exits successfully.
- Rules HTTP schemas now accept canonical descriptor conditions, percentage splits and key aliases while retaining legacy payloads. `verify-accounting-read-contracts.ts`: `Accounting HTTP view bridge and frozen read contracts: 85 assertions passed.` Split percentages other than 10000 bps are rejected. Removed payroll obligation, overdue and remaining-balance types with the removed clearing feature.
- Deleted obsolete fixture upgrade/seed utilities (`sync-accounting-postgres.ts`, `seed-accounting-feed-fixture.ts`, `seed-accounting-tax-fixture.ts`, `seed-accounting-cutoff-fixture.ts`) that referenced the archived schema. The fresh fixture preparer replaces them. Deleted the nested accounting invoice sync webhook along with the explicitly parked invoice receiver; the unrelated legacy invoice webhook remains untouched.
- Isolated PostgreSQL concurrency: `ACCOUNTING_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15447/accounting_test node node_modules/tsx/dist/cli.mjs admin/scripts/verify-accounting-concurrency.ts` reports 9 assertions passed across 3 connections. A stale-revision error expectation was ported before the successful rerun. The database is a new disposable cluster in `admin/.local/phase1/pg-disposable`, not the protected 5447 cluster.
- Actual local API: `verify-accounting-http.ts --api-only`, with explicit disposable endpoints on 15447/13108, prints `Accounting HTTP and private evidence: 40 assertions passed (API only; page gate remains separate).` This includes synthetic Wave inspection, exact 12345 receivable opening, retained zero-group exclusion, staging/apply, commands and private receipt evidence. Repeated runs use unique synthetic names/identities. The SQL baseline used by this HTTP fixture predates the final rule-evidence additions; those additions are covered against fresh PGlite. The default HTTP suite still requires the accounting page.
- `node ../node_modules/eslint/bin/eslint.js --config eslint.accounting.config.mjs src/lib/accounting src/app/api/accounting scripts/verify-accounting.ts scripts/verify-accounting-db.ts` from admin exits 0: `Owned backend lint: zero errors or warnings.` Repo type checking has no remaining errors in scripts, libraries or API routes; kept UI errors remain for the Phase 1 gate.
- Frozen-key equivalents: payroll/register revision history comes from the append-only audit; tax snapshot reads the current tax-link cache, not the removed historical snapshot/job tables. year_settings projects the shared business profile. basis retains the closest opening-metadata/null equivalent and never infers a deductible loss. Rule evidence projects immutable application audit rows. Reconciliation proof is selected posted ledger lines versus statement totals, with removed source-statement/coverage/clearing keys retired.
- Additional removed commands: `year.restatement.begin`, `year.restatement.complete`, `reconciliation.cancel` (old statement cancellation lifecycle). Added `reconciliation.save`, `period.lock`, `history.check`; retained `reconciliation.item.remove`; surviving `period.close`, `reconciliation.unmatch`, `history.lock`, `payroll.approve` remain. Tax plan persistence, comparison capture and per-payment contractor review commands are removed as documented above.
- Kept UI edits are restricted to removed-component imports, authorized shell nav/view/section removals and the single workspace loader call. One remaining invoice shell view case was found by lint and removed mechanically. No visual redesign or general kept-component port was attempted.

## Step 7 gate preparation

Q7, resolved technical snapshot decision under the standing operating rule: regenerate the accounting canonical blocks from the applied in-memory PostgreSQL catalog. Define all columns and constraints in CREATE TABLE, ordered by foreign-key dependencies. PostgreSQL requires ALTER TABLE for enabling RLS; use that final-state security declaration, not migration/backfill/patch SQL. Emit full function definitions, grants, indexes, triggers and policies directly from the applied catalog. Seed only the approved generic account defaults and business profile, never fixture owner rows, audit activity or financial data. This satisfies applied-result parity without copying the migration construction loops or function patches.

### Final command inventory versus codex/accounting-completion

Computed from the literal/enum command definitions in the old and current accounting libraries. This inventory supersedes any earlier shorthand lists.

Added: `bank.sync_request`, `entry.categorize`, `entry.discard`, `entry.split`, `history.check`, `payroll.post`, `period.lock`, `reconciliation.save`, `rule.apply_preview`, `settings.save`. `draft.discard` survives alongside the new target alias. Canonical rule/alias payload variants add fields without renaming their existing commands.

Removed: `account.lifecycle`, `authority.change`, `clearing.allocate`, `clearing.release`, `clearing.review`, `contractor.review`, `dimension.save`, `history.disposition`, `import.comparison.capture`, `invoice.accept`, `invoice.adjust`, `invoice.fund.apply`, `invoice.fund.record`, `invoice.fund.reverse`, `invoice.fund.review`, `invoice.fund.use`, `invoice.inbox.resolve`, `invoice.manual.save`, `invoice.settle`, `invoice.settlement.reverse`, `invoice.source.save`, `payroll.coverage`, `reconciliation.cancel`, `reconciliation.items`, `reconciliation.opening`, `report.operational.capture`, `retained.post`, `statement.amend`, `statement.import`, `tax.basis`, `tax.plan.save`, `tax.year`, `template.save`, `view.save`, `year.configure`, `year.file`, `year.restatement.begin`, `year.restatement.complete`.

## Step 7 gate results: NOT PASSED

1. `npm run test:accounting:all --workspace=admin`: exit 0, **41/41 suites passed.** Evidence: `admin/.local/phase1/gate-tests.txt` and `gate-tests.json`. Every surviving ordinary suite is green.
2. `npm run lint:accounting --workspace=admin`: exit 1, **89 problems (87 errors, 2 warnings)**, all in kept accounting UI. Evidence: `gate-lint.txt`. The owned backend/API subset exits 0 with no errors or warnings.
3. `node node_modules/typescript/bin/tsc --noEmit -p admin/tsconfig.json` (same compiler as npx): exit 2, **374 errors across 25 kept accounting component files**. Zero errors in scripts, libraries or API routes. Evidence: `gate-types.txt`.
4. `npm run build:accounting --workspace=admin`: exit 1, **Turbopack build failed with 2 errors**. Both are kept UI imports of the retired `@/lib/accounting/operational-reports` module, in `accounting-operational-report.tsx:14` and `accounting-reports.tsx:35`. Evidence: `gate-build.txt`. It does not reach a production artifact, so the production-runtime suite cannot run yet. The normal HTTP page check also remains unpassed; the explicitly separate API-only result is not a substitute.
5. `node node_modules/tsx/dist/cli.mjs admin/scripts/regenerate-accounting-schema.ts`: **Canonical catalog regenerated: 28 tables including business_profile, 58 functions, 85 triggers, 17 generic chart accounts.** The snapshot is generated only from fresh in-memory migrations. No transaction rows, owner IDs, audit rows or private files are emitted. Two initial generator errors (constraint-trigger pseudo-constraints and missing function terminators) were fixed before verification.
6. `node node_modules/tsx/dist/cli.mjs admin/scripts/verify-accounting-schema.ts`: **27 accounting tables, 56 accounting functions; 83 table trigger attachments using 10 shared trigger functions; business_profile adds 2 functions and 2 trigger attachments. Canonical schema parity: 16 catalog comparisons passed.** The extra comparisons verify generic chart and profile seeds, in addition to tables/columns/constraints/indexes/functions/triggers/policies and security assertions. Nine active migration files; archive remains excluded.
7. `git diff main --quiet -- app/`: exit 0, app exactly matches main. `git show-ref --verify refs/heads/astra/invoice-lifecycle-parked` confirms the parked branch at f8c27de66bc122ac9881e75a4c16c5ee76ee8850. `git ls-files admin/.local`: no tracked files. No merge or push performed.

### Requests for Claude, blocking the gate

- Replace the retained uses of InvoiceDialog, InvoiceActions and InvoiceMoney with shared UI primitives in Claude-owned files. Their old source component was explicitly removed by the brief. Import removals alone intentionally leave these call sites for the UI owner.
- Remove the remaining deleted-feature controls and props: clearing/statement coverage and amendment workflows; contractor per-payment review; payroll obligation/coverage controls; tax year/basis/payment-plan editors; dimensions/templates/saved views; old operational report catalog. Use the surviving read contracts and new fields documented above. Do not recreate those tables or send those removed commands.
- Wire payroll preview/post to an explicitly selected bank account and cash/accrual template. Use canonical register/payroll statuses and current body fields; audit-derived history preserves the surviving response keys.
- Wire reports to the surviving financial/report and party aggregation surfaces. The old project/business-line operational report module is deliberately removed.
- Port the two shell components' remaining feature references on the UI branch. Astra's authorized removals are complete; broad edits to those kept components remain outside this branch's scope.

No unanswered financial question remains. The blocker is the explicit UI ownership boundary, not an unmade implementation decision. Phase 1 is **not complete** and Phase 2 has **not started**, because the brief requires the gate to pass first. Do not weaken the compiler/lint/build checks or restore removed features to get an artificial green result. Re-run the gate and full HTTP/production checks once the UI changes are available through an owner-authorized integration; no merge is performed here.

The disposable API server on 13108 and PostgreSQL cluster on 15447 have been stopped after testing. The protected fixture services on 3108 and 5447 were left alone. No hosted database or real financial data was modified.

Compiler inventory for Claude (filenames under admin/src/components/features/accounting/):

- accounting-close.tsx: 58 errors.
- accounting-contractors.tsx: 29 errors.
- accounting-payroll.tsx: 26 errors.
- accounting-reconciliation.tsx: 22 errors.
- accounting-manage.tsx: 21 errors.
- accounting-tax-workpapers.tsx: 20 errors.
- accounting-payroll-action.tsx: 20 errors.
- accounting-feeds.tsx: 19 errors.
- accounting-operational-report.tsx: 18 errors.
- accounting-books.tsx: 17 errors.
- accounting-context-editor.tsx: 17 errors.
- accounting-payroll-form.tsx: 16 errors.
- accounting-tax-link-editor.tsx: 14 errors.
- accounting-transactions.tsx: 13 errors.
- accounting-reports.tsx: 12 errors.
- accounting-register-action.tsx: 10 errors.
- accounting-manual-registers.tsx: 8 errors.
- accounting-statement-import.tsx: 8 errors.
- accounting-tax-link.tsx: 6 errors.
- accounting-register-form.tsx: 5 errors.
- accounting-support-report.tsx: 5 errors.
- accounting-imports.tsx: 3 errors.
- accounting-history.tsx: 3 errors.
- accounting-account-create.tsx: 3 errors.
- accounting-transaction-editor.tsx: 1 errors.
