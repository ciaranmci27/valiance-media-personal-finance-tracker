# Accounting build plan

Status: implementation in progress, 2026-09-05. Ledger, daily register, explicit CSV import, private evidence, reconciliation, calendar close, and filed-year controls are implemented. Complete invoice/payroll source workflows, extended reports, tax linkage, and restore acceptance still need work. Bank feeds, draft rules, and historical source verification now have synthetic acceptance coverage. Evidence is recorded in [accounting-implementation.md](accounting-implementation.md). The authoritative requirements are [accounting-spec.md](accounting-spec.md). `admin/tasks/todo.md` remains the older payroll plan and is not the accounting build authority.

Deliver a dependable Wave replacement with all available historical economic transactions in the normal ledger. Preserve personal Income, Expenses, Net Worth, and manual tax inputs. Wave remains available through year end or longer. AI/MCP/public REST and general personal-page linking are deferred. Tax linking is included.

## Execution rules

1. Implement one packet at a time through its acceptance gate. Keep a useful vertical workflow working after each UI packet. Record changed files, checks run, evidence, and unresolved items below the packet when finishing it.
2. Use synthetic fixtures and a separate staging database first. Live-data requests occur only at the relevant gate; missing real exports do not stop independent foundation work.
3. Inspect working-tree migrations before editing. One migration file per commit, reuse the active file, immutable committed migrations, canonical schema updated in place. Output delta SQL whenever editing an existing working-tree migration. Split changes for separate Supabase projects into separate commits as needed.
4. Preserve unrelated work. Do not repurpose payroll tasks, remove personal pages, enable live bank jobs, or publish demo data containing real records as a side effect.
5. Update packet status only after its checks pass. A date, amount of code, or passing trial balance alone is not an acceptance gate. Implementation completion and owner selection of admin as primary are different milestones.

## Packet dependency map

| Packet | Depends on | Deliverable |
| --- | --- | --- |
| A | None | Fixtures, contracts, test/runtime setup, source discovery |
| B | A | Restricted ledger, chart, journal/register vertical slice |
| C | B; real Wave samples for final adapter acceptance | Full historical import in normal books |
| D | B | Bank/CSV ingestion, canonical identity, overlap matching |
| E | C, D | Daily review, transfers, rules, evidence workflow |
| F | E | Statement reconciliation and calendar close |
| G | B, E | Complete invoice lifecycle and settlements |
| H | B, E | Patriot register and liability clearing |
| I | C, F, G, H | Complete reports, dimensions, manual registers, portable exports |
| J | I | Tax mappings, actuals/projections and safe linking |
| K | C through J | Restore, security, integration acceptance and production readiness |
| L | K; actual monthly close evidence | Parallel operation and owner-selected primary-system transition |

The order supports early historical import and usable books. Foundation report functions and backup primitives begin in B, not after the full UI. Real-data discovery in A runs alongside useful local implementation when inputs are available; it is not a requirement to delegate work to other agents.

## A. Establish fixtures, contracts, and checks

Status: in progress. Exact money/contracts, synthetic financial fixtures, runnable checks, and baseline verification are implemented. Provider sample discovery and staging integration remain open.

- [ ] Inventory actual schema/auth/automation behavior and record project/runtime versions. Confirm owner-only authorization and separate staging configuration.
- [ ] Define exact-cent/date types, state transitions, command error/idempotency contracts, report metadata, source scopes, and posting/closing lock order.
- [ ] Create a compact synthetic multi-year company fixture: opening equity, split purchase, card charge/payment, cross-month transfer, payroll, invoice partial payment/refund, personal-paid business expense, and repeated source observations.
- [ ] Inspect provided Wave/statement/Patriot examples and record adapter findings, missing fields, actual report basis, and normalization requirements. Keep sensitive samples out of committed fixtures; derive sanitized test cases.
- [x] Add documented runnable accounting checks and establish baseline type/build/tax results. Accounting uses the supported `lint:accounting` ESLint command.

Gate: synthetic fixtures have independently calculated expected balances/reports and operations can be expressed unambiguously. Source discovery records what remains blocked by missing samples. No invented provider fields or historical IDs.

Implemented tooling: `npm run test:accounting -w admin`, `npm run test:accounting:db -w admin`, and `npm run lint:accounting -w admin`. Prerequisites and evidence are in the implementation record. Retain `npm run test:tax -w admin`, workspace type checking, and `npm run build -w admin`.

## B. Build the ledger and first usable register

Status: core implementation verified. Restricted ledger, chart, draft/post/reverse/atomic correction, SQL reports, register, setup, private evidence, JSON export, and real concurrency checks are implemented. Later packets extend these primitives.

- [ ] Implement settings, owner authorization, accounts, entries/lines, corrections, periods, audit, command receipts, and minimal document/source identities. Seed system purposes with stable IDs and Wave-compatible mapping support.
- [ ] Implement atomic draft/post/reverse/replace operations and all INSERT/UPDATE/DELETE/reparent, balancing, archive, stale-write, and locked-period protections.
- [ ] Add chart, manual journal, Copy as draft, account register and entry detail UI; preserve existing navigation/pages behind the accounting feature flag.
- [ ] Implement posted TB/P&L/balance sheet and working-preview distinction with exact money transport and drill-down. Include explicit opening retained earnings and continuous-year behavior.
- [ ] Establish backup/export primitives and database invariant/property checks before importing real accounting data.

Gate: a synthetic opening balance plus manual activity produces correct reports; correction works without deleting history; concurrent post/close and direct write bypass attempts fail as intended. No public/demo principal reads real books. Review can use the journal without editing database rows manually.

## C. Import Wave history into ordinary transactions

Status: partial implementation. Explicit journal/CSV mapping, immutable source files, preview, resumable staging, duplicate review and ordinary ledger posting are implemented. Independent report comparison, documented annual-closing normalization, partial-year coverage, baseline locks, and cancelled-import resumption are now implemented and tested. Actual Wave adapter acceptance remains pending real source samples.

- [ ] Build source file storage, mappings, immutable observations, staged journal groups, import checkpoints, and replay identities.
- [ ] Implement the inspected Wave adapter, explicit cash-basis/AR/AP/closing normalization where required, and exact row-to-result traceability. Unsupported economic records block their scope.
- [ ] Build import preview, account mapping, batch approval, error repair, report comparison, and receipt association. Historical entries are posted through the same ledger rules as new entries.
- [ ] Implement repeated/reordered export detection, legitimate identical-group multiplicity, new/changed/missing source comparison, and correction previews without posted overwrites.
- [ ] Verify earliest opening balances, each supported year's reports, outstanding items, incomplete coverage labels, and historical baseline locks.

Gate: all provided supported history appears in normal register/search/reports. Reimport and chunk retry do not duplicate it. Source totals and annual/bank controls tie or have reviewed documented transformations. An incomplete conversion cannot be exported as complete official books. Historical receipt gaps and unsupported as-of aging are explicit.

Live dependency: actual Wave exports and same-basis reports. If unavailable, complete the importer framework/fixtures and record that real-adapter acceptance remains pending. Do not replace this packet with an archive browser.

## D. Bank/CSV ingestion and cross-source identity

Status: implemented and tested with synthetic data. Connection encryption, one-time claims, source identities, ownership/sign/date review, bounded version 2 syncs, leases, reconnect continuity, observations, coverage gaps, review batches, and restricted scheduling are implemented. Real institution/account acceptance remains a live dependency. See accounting-simplefin.md.

- [x] Implement stable bank accounts plus separate source account identities, encrypted SimpleFIN claims, URL checks, connection lease, scheduling, coverage checkpoints, retry/error recording, and disconnect/reconnect.
- [x] Implement the tested versioned adapter, exact amounts/signs/dates, posted-only ledger ingestion, balance observations, pending preview if useful, and late/changed-record exceptions.
- [x] Build CSV column/date/locale/sign preview, validation and source/batch identities; distinguish journal imports from bank movement imports.
- [x] Match incoming observations to existing Wave/manual activity before drafting. Implement bounded bank-line allocations, duplicate candidates, and atomic redundant-draft resolution.
- [x] Expose connection/account freshness, source coverage, gaps, balances, exceptions, and manual sync in UI.

Gate: Wave, CSV, and SimpleFIN overlap produces one posting with multiple evidence links. Reconnection creates no second account/opening history. Outages and locked-period arrivals do not silently lose data. Card charge/payment/refund and bank sign fixtures pass. Credentials never reach browser/log/export.

Live dependency: actual account ownership, institution support, statement samples, and a SimpleFIN connection. Provider history gaps use CSV rather than fabricated coverage.

## E. Complete the daily review workflow

Status: partial implementation. Register/filter/saved-view, exact journal/splits, bulk approval, templates, party/dimension context and private evidence UI are implemented. Atomic dated transfer groups and complete-group reversal are implemented and verified. Rules, suggestions and remaining daily-work refinements remain open.

- [ ] Build grouped Review and All transactions views, saved filters/source search, keyboard progression, explicit bulk selection and impact previews.
- [ ] Implement categorization, exact splits, owner reimbursement/contribution/distribution choices, refunds, match existing, exclusion reasons, and explicit posting/correction.
- [ ] Implement same-date and cross-date transfer groups, payment transit, matching suggestions, allocation bounds, and stale-obligation exceptions.
- [ ] Add versioned rules/aliases, prior-treatment suggestions, saved templates, history preview and conflicts. Auto-post remains off during pilot; its later per-rule activation requires tests and owner action.
- [ ] Build document inbox, private upload/download, evidence links, missing-receipt filter, payee detail/history, responsive layout and accessible controls.

Gate: one synthetic month is categorized without direct SQL. Every row is traceable to evidence; repeating a bulk operation is idempotent. A personal purchase on a company card remains accounted for. Cross-month transfers preserve both dates. Source evidence is visible on imported historical entries using the same detail screen.

## F. Reconcile statements and close months

Status: core workflow implemented and verified in synthetic books. Statement items and bounded partial matches, explicit opening review, independent balance proof, immutable snapshots, successor supersession, close checklist, year classification/filing, controlled restatement, clearing timelines and account closure are implemented. Statement CSV import, safe retry, retained source identities and in-progress header amendments are implemented. Deeper card cutoff and real-data acceptance remain open.

- [x] Implement statement ranges, predecessor balances, cleared-item allocations, outstanding carryforward, statement documents, and completion proof.
- [x] Build statement matching UI, zero-difference validation, unfinished-save/resume, and explicit mismatch investigation with no balancing plug.
- [ ] Separate statement cycles from calendar locks; implement cutoff bridges for cards and account closure handling.
- [x] Implement close checklist, snapshots, period lock/reopen, reconciliation supersession and the dedicated filed-year restatement path.
- [x] Add tests for equal missing deposits/withdrawals, partial clearing, post/close races, posted corrections, and evidence-only attachment after lock.

Gate: complete synthetic checking/card statements and lock a month without auto-posting drafts. An unexplained difference cannot be marked complete by adding a note. Reopening preserves the old proof; filed-year correction retains the originally filed package.

## G. Complete invoice source lifecycle and settlement

Status: [ ] Not started

- [ ] Extend `app` source coverage to issued/unpaid lifecycle, amendments, cancellations/deletions, drafts and settlement claims. Preserve current legacy personal-income delivery behavior.
- [ ] Add stable revisions, snapshot/bootstrap with tombstones, durable accounting inbox, signature/schema validation, bounded delivery retries, and full nightly snapshot reconciliation.
- [ ] Implement local invoice/customer/project identities and dated revisions; distinguish CRM state, expected payment, and accounting settlement.
- [ ] Build receipt matching, line allocation, partial/multiple payments, explicit fees, discounts, refunds/returns, unresolved customer funds, and invoice detail with dated history.
- [ ] Match already-posted Wave historical receipts to invoice history without recognizing revenue again; handle conflicting source edits as exceptions.

Gate: unpaid invoices actually appear; missed/out-of-order events converge; historical aging is correct where data exists; a $2,000 payment leaves $3,000 due on a $5,000 invoice; refunds reverse allocations and amounts once. Existing personal Income keeps its intended current behavior.

Migrations for `app` and `admin` are committed separately when needed. A changes-since query over the old paid-only event log is not an adequate implementation of this packet. Automatic CRM paid write-back is deferred.

## H. Patriot registers and liability clearing

Status: [ ] Not started

- [ ] Implement verified run identity, register input/version/document storage, officer detail and supported payroll components.
- [ ] Build the recurring salary journal template with explicit withholding, retirement, other deductions, reimbursements/noncash benefits, net pay and employer costs.
- [ ] Match multiple bank debits to each run's obligations, keeping fees separate and evidence visible.
- [ ] Build residual/aging views using expected settlement dates; import registers onto existing Wave payroll entries without duplicate expenses.
- [ ] Expose supported taxable-wage/withholding data to the tax adapter, with actual coverage and explicit unavailable fields.

Gate: a real current Patriot run and a synthetic deduction/benefit run balance and clear correctly; gross minus net is not blindly treated as tax. Officer wage versus personal taxable wage differences are documented. No payroll execution or government filing is added.

## I. Complete reports, manual registers, and exports

Status: [ ] Not started

- [ ] Complete SQL reports from spec section 14, exact opening/running balances, monthly/prior comparisons, typed dimensions, saved views, and exact drill-down.
- [ ] Implement cash-movement classification/allocation, explicit transit and unresolved classes; never include card liability as cash.
- [ ] Implement manual assets/loan records, reviewed templates, owner/payroll support and contractor worksheet with payment-rail/documentation exceptions.
- [ ] Implement report CSV/PDF, books support package, full versioned JSON plus document bundle/manifests, and retained close/filing snapshots.
- [ ] Validate reports against independently calculated fixtures and historical Wave control reports, including mapping changes and partial coverage.

Gate: every displayed/exported total ties to its authoritative rows; snapshot values survive subsequent renames/mapping updates; unsupported formal tax reports are not implied. Export can reconstruct supported books and retrieve evidence, rather than merely provide a screenshot of balances.

## J. Link business data to the existing tax estimator

Status: [ ] Not started

- [ ] Build reviewed year-versioned account/tax mappings and explicit adjustments; distinguish net profit, deductible treatment, separately stated items, wages and distributions.
- [ ] Add opt-in links to existing estimator input IDs, source freshness/revisions, bounded exact-money conversion, error/stale state, and durable refresh/reconciliation.
- [ ] Add recorded-actual versus remaining-year forecast controls, projected payroll/withholding where supported, and input/output snapshots with change explanation.
- [ ] Keep annual liability, already paid, projected shortfall, and installment targets distinct. Implement only supported/tested year/jurisdiction targets; manual fallback where required inputs/rules are missing.
- [ ] Extend existing tax verification with linkage/negative-profit/duplicate-source/manual-input preservation tests. Keep general Income/Expenses/Net Worth linking deferred.

Gate: approved accounting changes update the linked business estimate exactly once, with provenance, without replacing unrelated manual inputs. Corporate payroll tax deposits cannot become personal estimated-tax payments. An unsupported schedule or missing basis does not generate a confident payment recommendation.

## K. Operational and production acceptance

Status: [ ] Not started

- [ ] Complete off-platform database/document backups, manifest verification, key recovery, failure alerts and documented restore procedure.
- [ ] Restore to a clean environment and verify reports, sign-in, documents, encryption/relink recovery and exactly-once import resumption.
- [ ] Verify owner/demo/worker grants, privileged functions, storage access, source input validation, secret redaction and real-data isolation.
- [ ] Run all relevant database/scenario/tax/type/build checks and Codex in-app browser UI checks; the user's latest instruction explicitly excludes Playwright. Log known unrelated baseline failures separately.
- [ ] Confirm feature flag, invoker authentication, worker leases, data coverage monitors, snapshot retention and deployment configuration before activating real schedules.

Gate: all initial-delivery acceptance scenarios pass. Restore evidence includes exact totals and accessible documents. No remaining critical issue in financial invariants, source completeness, permissions, or recoverability. Deployment/activation follows the user's actual authorization at that time; this planning request does not deploy software.

## L. Parallel operation and owner-selected transition

Status: [ ] Not started

- [ ] Record Wave-primary pilot mode, mapped accounts, imported history scope and known differences.
- [ ] Run both systems for at least three consecutive actual monthly closes; compare reports, statements, payroll, collections, and outstanding balances with source evidence.
- [ ] Exercise repeated exports, overlap, corrections, missed events and recovery with the actual account set; resolve material discrepancies and extend the pilot when needed.
- [ ] When gates pass, have the owner select the admin-primary effective date. Carry the ledger forward without a second opening balance.
- [ ] Keep Wave accessible through year end or longer as desired. Cancelling Wave is a separate optional decision, never an automatic task.

Gate: owner can run routine books independently in admin, trusts the verified history and recent closes, has working tax inputs/exports/recovery, and explicitly selects admin as primary. Unpaid invoices can remain unpaid; all payments and outstanding balances must be explained.

## Later work, not initial acceptance criteria

| Work | Prerequisite |
| --- | --- |
| Selected Income/Expenses/Net Worth links | Stable books, target meaning/provenance, explicit opt-in and deduplication |
| Read-only AI explanations | Tested report/evidence functions, scoped access, privacy review |
| AI proposals and MCP | Separate proposal/approval design and permissions; no service-role access |
| REST integration | Concrete consumer needs; versioned transport/scopes rather than a speculative API |
| Processor/OCR/advanced accounting | Separate scoped design and fixtures for actual business needs |

## Completion record template

For each packet record: completion date, relevant commits/files, commands and outcomes, fixture/live-data evidence, operational configuration where applicable, and unresolved follow-up IDs. Mark complete only after its gate is satisfied. Keep sensitive financial data and secrets out of the checklist.
