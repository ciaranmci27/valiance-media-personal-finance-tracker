# Accounting UI log (Claude, branch `claude/accounting-ui`)

Working copy: git worktree at `D:\Valiance Media LLC\Projects\Valiance Media-claude-ui`, branched from `f8c27de` (same base as `astra/accounting-schema`). Scope and ownership: review section 14. Not touched until Phase 1 merges: `accounting-books.tsx`, `accounting-manage.tsx`, anything under `src/lib/accounting/**`, `src/app/api/accounting/**`, `supabase/**`, `scripts/**`.

## Plan

### A. Component library (admin `src/components/ui/`)
- [ ] `data-table.tsx`: desktop table to mobile cards, sortable columns, empty state, admin tokens
- [ ] `row-actions-menu.tsx`: portal kebab menu for per-row actions
- [ ] `badge.tsx`: neutral and semantic pills
- [ ] `section-header.tsx`: uppercase label with count pill
- [ ] `multi-select.tsx`: searchable multi-select with chips
- [ ] `searchable-select.tsx`: grouped, searchable single select (promoted from `accounting-picker.tsx`); picker becomes a thin wrapper
- [ ] `pagination.tsx`: shared offset pager replacing 15 hand-rolled footers
- [ ] `features/accounting/format.ts`: one place for money, date and label formatting in the UI

### B. Business settings
- [ ] `/settings/business` page with sections Identity, Tax profile, Books, People
- [ ] `/api/admin/settings/business` route (reads and writes `public.business_profile`; graceful empty state until the table exists)
- [ ] Settings hub: "Business" first; `/settings/tax` keeps only per-year personal facts or redirects
- [ ] Estimator setup card shows profile values with an edit link instead of its own four fields

### C. Conformance pass on owned accounting components
- [ ] Raw `<select>` to `CustomSelect` or `SearchableSelect`; raw checkboxes to `Checkbox`; raw textarea to `Textarea`
- [ ] `window.confirm` to `ConfirmationDialog`; native `title` to `Tooltip`
- [ ] Remove the 12 `selectStyle` copies and the five money wrappers in favor of `format.ts`
- [ ] Light theme: `text-primary` links to `text-teal-light`; amber and emerald without light pairing
- [ ] Mobile: tables through `DataTable` with card renderers; no unwrapped tables
- [ ] Decorative icons `aria-hidden`; 10px text raised to 11px minimum

### D. Transactions
- [ ] Needs review as the default view with a count badge (uses `needs_review_count` when present, computed from rows until then)
- [ ] Bulk categorize (select rows, one category, review all)
- [ ] Prior-treatment hint row and "remember this payee" (uses `prior_treatment` and `descriptor_key` when present)
- [ ] Collapse the context section to payee and project

### E. Month end and payroll
- [ ] Close screen reduced to three checks plus Lock; reconciliation reachable as an optional tool
- [ ] Cash-basis payroll screen: two Patriot debits, no liabilities

### F. After the Phase 1 gate (needs the shell files)
- [ ] Navigation: Transactions, Reports, Accounts, Month end, More
- [ ] Remove "Prepare review batch"; sync-on-open freshness line
- [ ] Rewire to the new function names and workspace fields

## Log

### 2026-09-07
- Worktree created beside the repository; `node_modules` junctioned from the main checkout; `admin/.env` copied. Turbopack refuses the junction, so the preview runs with `next dev --webpack -p 3210` and the Browser pane attaches by URL. `.env.local` puts the worktree in demo mode so screens render without a database.
- A: all seven library components written and type-checked (`data-table`, `row-actions-menu`, `badge`, `section-header`, `multi-select`, `searchable-select`, `pagination`); `accounting-picker.tsx` now wraps `SearchableSelect`; `format.ts` added. `use-accounting-command.ts` gained `executeMany` for bulk actions with one refresh.
- C: rulebook written (`accounting-ui-conformance.md`); six file-scoped agents run the pass. Feeds, bank match and statement import are done (agent report: 0 src type errors, eslint clean).
- D: `accounting-transactions.tsx` rewritten on `DataTable`: Needs review is the default tab when drafts exist, with a count badge; row selection; "Set category" bulk action next to "Review selected"; row actions through `RowActionsMenu`; `Pagination`; prior-treatment hint and "Remember payee" wired to the optional `prior_treatment`, `descriptor_key` and `source_description` fields. Verified rendering in the preview.
- D: `accounting-transaction-editor.tsx` uses `Checkbox`, `useConfirmationDialog` (two former `window.confirm`), picker labels, the app's pill track for direction, `money`/`dateLabel`. `accounting-context-editor.tsx` reduced to Payee and Project (shown only when projects exist); other context fields pass through untouched. Both files type-check.
- C: all six agents finished; every owned file passes `tsc` (src) and the accounting ESLint config. Reconciliation (optional tool) runs last.
- Shared dialog chrome moved out of `accounting-invoice-shared.tsx` into `accounting-dialog.tsx` (`WorkflowDialog`, `WorkflowActions`, `EvidencePicker`, `DialogMoney`, `usdCents`, `linkedEntry`, with the old `Invoice*` names as aliases). Nine kept screens repointed. `accounting-payroll-form.tsx` still imports the old file and is superseded by the new payroll screen.
- B: `/settings/business` page, `lib/business-profile.ts` (load, save, estimator mapping, demo profile, "table not installed" state), settings hub reordered ("Business" first, "Tax years" second). Tax years page and the estimator setup card show the profile's structure read-only with an edit link once the profile exists. Astra's `20260907193410_business_profile.sql` matches the column contract.
- E: `accounting-close.tsx` rebuilt as Month end: three step cards (Everything reviewed, Balances match, Lock the month), "More checks" collapsed, year-end card, saved closes, restatement sections guarded. Clearing and statement-cutoff panels dropped (their files are being removed).
- E: `accounting-payroll-run.tsx` written: list with totals tiles, register form with the six totals and optional lines, live balance check, auto-resolved posting accounts (editable), W-2 details, detail dialog with journal lines and open bank debits, record and void. Uses today's `payroll.save`, `payroll.approve` and `payroll.void`. Replaces `accounting-payroll.tsx`, `-form`, `-action` at the gate when `accounting-manage.tsx` opens up.
- Light theme spot check on Transactions: readable, tokens hold.

### Requests for Astra (relay through the owner; this file is not on Astra's branch)
0. Post-gate defect found while rewiring Bank feeds: `feed.map` with `ownership: "company"` inserts the `bank_accounts` row but never writes `discovery.<id>.ownership = "company"` (schema.sql around lines 2615 to 2621; only the non-company branch stamps ownership), so the `feeds` view returns a mapped identity as `unreviewed`. The UI treats an identity with a `feed_account_id` as decided, so nothing is blocked, but the read should say `company`.
1. Do not delete `accounting-invoice-shared.tsx` before the UI branch merges. After the merge it is unreferenced by kept screens and safe to delete along with `accounting-payroll-form.tsx`, `accounting-payroll-action.tsx` and `accounting-payroll.tsx`, which the new `accounting-payroll-run.tsx` replaces.
2. Cash-basis payroll (Phase 2): keep `payroll.save` body fields as they are. When the component for `net_pay`, `employee_tax` or `employer_tax` carries a bank or card account as `account_id`, post the credit straight to that bank line with no obligation, so the Patriot debits match to it. Liability accounts keep today's behavior.
3. `AccountingWorkspace` additions the UI already reads when present: `needs_review_count`, and per entry `source_description`, `descriptor_key`, `prior_treatment: { account_id, payee_id, count, last_date }`.
4. `alias.save` payload the UI sends: `{ party_id, match_kind: "key", pattern }`.

### Verification at the end of the pre-gate work
- `npx tsc --noEmit -p tsconfig.json`: 0 errors under `src/` (the 10 pre-existing errors under `scripts/` are Astra's, in its brief as Phase 2 item 6).
- `npx eslint --config eslint.accounting.config.mjs` over `src/components/features/accounting`, the seven new `ui/` files, the Business settings page and `lib/business-profile.ts`: clean.
- `ACCOUNTING_BUILD_CHECK=true npx next build --webpack`: passed, `/settings/business` present in the route list. Turbopack cannot build in this worktree because of the node_modules junction; the main checkout will use the normal build.
- Demo-mode render check in the Browser pane (webpack dev server on 3210): Transactions (desktop and 375px), Reports catalog and P&L, Chart of accounts, Rules, Bank feeds, Imports, Tax workpapers, Documents, Settings hub, Business, Tax years. Light theme checked on Transactions. Month end and payroll cannot render in demo mode (the shell hides them); they are type-checked and reviewed by hand.

### Navigation shell (built ahead of the gate as new files)
- `accounting-shell.tsx` exports `AccountingBooks` and replaces the old shell: Transactions (with a review-count badge), Reports, Accounts, Month end, More. The `view` query values are unchanged so links keep working; `overview` and `invoices` are gone. The Add menu offers Money out, Money in, Transfer or card payment, Payroll run and Journal entry. Sync-on-open fires a `bank.sync_request` once when the workspace reports `sync_due`.
- `accounting-journal-dialogs.tsx` holds the entry detail, journal editor (account lines use `SearchableSelect`), approval, correction review and naming dialogs. No retained-earnings review dependency.
- `accounting-more.tsx` replaces `accounting-manage.tsx`: Everyday (feeds, imports, transfers, receipts, rules, payees), Records (payroll on the new screen, assets, loans, contractors, tax), Setup (projects, templates, Wave migration, settings). Settings links to Business settings and keeps only book preferences and the export. Recovery, authority and the invoice screens are not mounted.
- `page.tsx` now imports the shell. `accounting-books.tsx` and `accounting-manage.tsx` are unreferenced and are deleted at the gate along with Astra's removed files.
- Committed on `claude/accounting-ui` as one commit so the branch can be merged and reviewed.

### Waiting on the Phase 1 gate
- Navigation: Transactions, Reports, Accounts, Month end, More; Invoices behind a flag.
- Wire `accounting-payroll-run.tsx` in place of the three old payroll files; drop the "Prepare review batch" step from Bank feeds once sync creates drafts.
- Sync-on-open freshness line (`sync_due`), the prior-treatment fields and `alias.save` lighting up, `needs_review_count`.
- One rewiring pass for any renamed read functions, then rebase onto the merged Phase 1 base.

### Accounts: bank and cards panel
- `accounting-bank-panel.tsx` replaces the collapsed "Bank & card balances" block at the top of Accounts. One card per bank, cash or card account: book balance beside the balance the bank last reported (from the feeds view: identity balance times the canonical account's `balance_sign`), an "Off by" line when they differ, connection badge (Connected, Reconnect, Disconnected, No feed), last sync time, Reconcile and Sync now (posts `{ action: "sync", id }` to `/api/accounting/feeds`). The account name opens its ledger; "Bank feeds" jumps to More. Reads the current `FeedData` shape; the gate rewiring pass covers any rename.
- Demo mode had no account profiles, so nothing was ever a bank account there. The shell now derives demo profiles from the default chart by code, which also lights up the cash summary on Transactions in demo.

### Demo walkthrough fixes
- Every More section, the Accounts panel (dark, light, 375px) and the entry detail were walked in the demo preview. Fixes: `SearchableSelect` clusters options under one heading per group (the cash picker showed "Cash & bank" twice); the Transactions table uses `fixedLayout` so the description keeps its width, with the Account column hidden below `xl`; a row click opens the entry detail (`DataTable` ignores clicks that start on a button, link, input or menu); demo books resolve an entry from the loaded workspace instead of calling the API.
- Payroll and Month end cannot render in demo, so a review agent checked both against the zod schemas and SQL functions and a second agent is applying its findings: silent approval errors, page size 25 vs the server's 50, editable Patriot run number the server rejects, void allowed for linked runs, reimbursement picker offering income accounts, the Month end coverage count treating every account as done, document-less year filing sending an empty uuid, stale `expected_revision` never refetching, and the data flash on every reload.

- Review fixes applied across the shared surface: `commandContext()` strips the register's `entry_id` before any `transaction.save` (every edit of an existing entry was rejected by the strict schema); saved views drop `sort`; `executeMany` returns saved ids so a bulk retry skips them; a failed reload after a save reports as a reload problem, not a save failure; `alias.save` sends the real rule shape; the review badge and default tab use `needs_review_count` when present; the search box caps at 200 characters; the bank panel prefers the identity on a live connection and tolerates a non-JSON sync response; `NavButton` moved to module scope so keyboard focus survives re-renders; the error banner yields to an open dialog; `DataTable` sorts numeric strings as numbers and no longer sets `aria-selected` outside a grid; `Tooltip` no longer calls hooks after an early return.

### Removed features stripped from the UI (Astra's step 6 handoff request, 15:20)
- Astra asked for every UI reference to six removed features to go before its lib and route port lands: saved views, journal templates, dimensions (projects and business lines), filed-year and restatement state (including the per-year classification `year.configure`, now read from the business profile), statement-file ingestion (`statement.import`, `statement.amend`) and persisted tax payment plans. Two agents are applying it: one across shell, Transactions, More, journal dialogs, context editor and reports (with a `BooksMetadata` pick type so `manage` stops naming the dropped keys), one across Month end, Wave migration, tax workpapers and reconciliation, deleting `accounting-register.tsx`, `accounting-statement-import.tsx`, `accounting-tax-payment-plan.tsx` and `accounting-tax-payment-editor.tsx`. Month end's year-end card now points at the immutable year-end package instead of filing state.
- Done (both agents reported, tsc 0 under src, eslint clean): `types.ts` exports `BooksMetadata`, used by all 22 files that took `manage`; Transactions "Reset filters" is local; the More view's Setup group is Wave migration and Settings; the context editor is payee only; reports keep "Business performance" for customer and vendor views only; Month end is close, reopen and lock with a link to the year-end package (`?view=reports&report=books-package`); Wave migration and tax workpapers lost their per-year classification controls (`year.configure`, `tax.year`); reconciliation lost CSV statement import, amendment and source history. Deleted: `accounting-register.tsx`, `accounting-statement-import.tsx`, `accounting-tax-payment-plan.tsx`, `accounting-tax-payment-editor.tsx`, and sixteen components the shell never reaches (authority, clearing, customer funds, the nine invoice screens, payroll coverage, recovery, retained review, statement cutoff, `use-accounting-list-state.ts`). A reachability script from the accounting page confirms zero unreachable components; `accounting-invoice-shared.tsx` stays only because the contractor review screen still uses its select class, and both go at the gate when contractor reviews become a worksheet.
- Astra's payroll request (15:33): recording a run now asks for the posting template (cash by default, accrual when the register carries deductions, reimbursements or fees) and, for cash, the bank account the run was paid from (a single bank account is preselected). `payroll.approve` sends `template` and `bank_account_id` through a cast until the shared command type merges; the "Waiting on bank debits" obligation list is gone.
- Read from Astra's schema (15:40): the entry detail projection carries `prior_treatment` as `{ count, last_category, payee_id }` (the Transactions hint type now uses `last_category`); `context` is `{ kind, payee_id }`; `entry.categorize` takes `{ id, expected_version, account_id, memo, payee_id }` and is the better target for the inline picker, the prior-treatment "Use" and bulk "Set category" once its TypeScript schema lands; `entry.split` exists; `bank.sync_request` exists, so sync-on-open will fire; `public.business_profile` stays directly writable by the owner, so Business settings keeps its upsert.
- Still to adapt once Astra's route port shows the shapes: the cash review dialog on report detail (one `cash_class` per draft line, corrections for posted lines) and the account form's report group, which should offer the canonical subtype names.

### Gate rewiring checklist (from Astra's Phase 1 log through step 6, read 2026-09-07 15:15)
- Accounts carry their metadata inline (subtype, cash kind); the separate `AccountProfile` list goes away. Astra asks for canonical subtype names: the old free label "Cash and bank" plus `cash_kind` maps to subtype `bank`. Rewire `manage.profiles` readers (accounts, transactions, bank panel, payroll form, demo profiles) to the inline fields.
- `cash.allocate` now sets a draft line's `cash_class` with exact-sum validation; posted lines change through the correction flow. Astra asks the cash review controls (cash flow report) to follow that draft-or-correct model.
- Filed-year and restatement state are removed; immutable year-end packages and audit close snapshots replace them. Month end drops the year-end card's `year.file` and `year.restatement.*` actions and shows the package instead. `close_checklist` is a function, statement evidence optional, completion needs a zero difference, a later posting reopens a completed reconciliation.
- `statement.import` and `statement.amend` are removed with their tables; `accounting-statement-import.tsx` retires. Reconciliation stays (one allocation per journal line).
- Payroll: cash template is the default, `template: accrual` is the explicit alternative; old `linked` and `voided` statuses project to `posted` and `void`; YTD comes from the latest posted run at or before the cutoff; no obligations or clearing.
- Feeds: sync runs on `accounting.sync_server` leases; explicit "prepare review batch" staging is retired; bank staging reports ready rows until match or apply. Legacy import `group_id` translates to `bank_transaction_id` in the step 6 route port.
- History: `history.disposition` removed; `import.resolve` gains `correct`; completed batches refuse cancel or resume.
- Tax: mappings are versioned rows, adjustments immutable with offsets, links hold forecast inputs and a refresh cache; snapshot id is the link id. Contractors use the party `is_contractor` flag and a worksheet, no per-payment reviews.
- From Astra's step 6 log (16:00): `ImportBatch.parity_status` replaces `coverage_verified`; `import.comparison.capture` is removed (read-only comparison stays, one reference in `accounting-import-comparison.tsx`); the contractor contract keeps annual party totals only, so `accounting-contractor-review.tsx` retires and `accounting-contractors.tsx` (two references) becomes the worksheet, which also frees `accounting-invoice-shared.tsx` for deletion; the tax link view returns `safe_harbor` computed from `forecast_inputs.safe_harbor`; payroll detail accepts the selected bank and template for the preview, and lists honor `as_of`, `query`, `status`, `offset` with full-set totals; the close view keeps `month_start`, `through`, `month_ended`, `accounts`, `reports`; manage profiles expose `type` and `external_names` for the Wave adapter.
- Reports: single engine; support captures use kind `year_end_package`; five support reports (fourteen package documents); operational receivable and customer-credit reports are gone.

### Phase 1 gate integration (16:30 onward)
- Astra recorded the gate at `b07e94c`: 41 of 41 suites pass, backend lint and types clean, schema regenerated (27 accounting tables plus `business_profile`, 56 functions, 16 catalog comparisons), but the gate is NOT PASSED because kept UI files fail the compiler, lint and Turbopack build on its branch. Its inventory names 374 errors in 25 files, most of which no longer exist here.
- Merged `astra/accounting-schema` into `claude/accounting-ui` as `97606f9`. Twenty-one conflicts: my versions kept for the twelve content conflicts (Astra's edits there were import removals my files had already made), every file either side deleted stays deleted (old shell, manage, three payroll files, contractor review, import comparison, invoice shared). Post-merge: 153 compiler errors in 16 files, all mine, zero unreachable components.
- Rewiring in progress: `commandContext()` now returns the command's `{ kind, payee_id }` (invoice receipts become income), the journal editor and context editor carry that type, book settings use `primary_system` and `primary_system_since` with no transit-alert field, the payroll list drops the overdue badge and the "still owed" tile. Agents are rewiring Month end, reconciliation and Wave migration (close history is audit-derived, `reconciliation.save`, `history.check`), contractors as a worksheet, reports without the operational module, imports and registers without the deleted comparison and loan-schedule components, and Bank feeds on the lease-based connection contract with ownership review.

- Rewiring done (17:00): Month end counts drafts, derives each bank account's state from `difference_cents`, keeps `history_mismatches` as its one extra check, lists locked and reopened months from `CloseHistory.periods`, takes `expected_revision` from the checklist or period impact, and locks with `period.lock`. Reconciliation has two statuses, optional statement evidence, a reasoned item removal, and adds lines through `reconciliation.allocate` (the `save` command replaces the whole item set and needs a bank account id the view does not expose). Wave migration records comparisons with `history.check` and a control kind select. Contractors is a per-party worksheet (classification, W-9, cash, card, total, threshold flag, payments link). Reports lose the operational catalog and the customer filter. Imports gained an in-file comparison panel on the surviving `import-comparison` read. Registers drop the loan schedule review. Bank feeds run on the lease contract with ownership review, no coverage gaps, no prepare step. Deleted `accounting-operational-report.tsx`. Gate on this branch: 41 of 41 suites, `lint:accounting` clean, compiler zero errors.

### Requests for Astra after the gate (contract and read divergences the rewiring exposed)
- `ReconciliationView` still types `items[].allocations`, `proof.outstanding` and `next_ordinal`, which the SQL no longer returns; `reconciliation.save` needs a `bank_account_id` that neither `Statement` nor `AccountingAccount` exposes, so the UI adds lines with `reconciliation.allocate` instead.
- `HistoryView.checks[].controls.proof` and `eligible_months` are absent at runtime; `periods` rows carry `reopen_reason` while the type says `reason`.
- `feed.map` with `ownership: "company"` never stamps the ownership (see request 0 above).
- The regenerated `schema.sql` names every not-null constraint (`CONSTRAINT "x_not_null" NOT NULL col`), Postgres 18 syntax. Supabase runs Postgres 17.6 and rejects it. The columns already carry inline `NOT NULL`, so the regenerator should emit that form only. See `admin/tasks/supabase-split-2026-09-07.md`.

### Commits on `claude/accounting-ui`
- `c68e545` Rebuild accounting UI on the shared component library
- `712d23b` Retire the old shell and payroll screens; trim the reports catalog
- `73f156a` Add the bank and cards panel to Accounts
- `e8fc0b6` Open entries from a row click and fit the Transactions table
- `45311a1` Fix contract mismatches found in the accounting UI review
- `d4af351` Strip removed features from the accounting UI
- `34bb0ac` Record payroll with an explicit bank account and posting template
- `74225b2` Read the prior treatment hint from last_category
- `673fc80` Extend the gate checklist from Astra's step 6 notes
- `97606f9` Merge branch 'astra/accounting-schema' into claude/accounting-ui
- `9242590` Rewire the accounting UI to the ported Phase 1 contracts

### Handing the gate back to Astra
- On this branch the four gate checks Astra could not pass on its own now pass: `npm run test:accounting:all` 41 of 41, `npm run lint:accounting` exit 0, `tsc --noEmit` zero errors, and the production build (webpack in this worktree; Turbopack cannot follow the node_modules junction here, so Astra should run `build:accounting` on the main checkout). Still to run by Astra after integrating this branch: the Turbopack build, the HTTP page check and the production runtime suite, then the schema regeneration and verification it already has.
- Integration: merge `claude/accounting-ui` into `astra/accounting-schema` (it already contains Astra's branch, so the merge is fast-forward on the UI side) and re-run the step 7 gate. Nothing has been pushed or merged to main.
