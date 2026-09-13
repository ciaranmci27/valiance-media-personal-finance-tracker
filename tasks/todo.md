# Next payment: tax so far beside the annualized requirement (2026-09-12)

Owner: pays the tax on what was actually earned each quarter; wants no forecasting; agreed to show the IRS annualized instalment next to it; manual rows spread evenly. Plan: `~/.claude/plans/twinkly-whistling-creek.md`. No SQL.

- [x] `payment-schedule.ts`: period table, `annualizeRows`, `withheldThrough`, `estimatedThrough`, `annualizedRequirement`, `shortfallCost`; suggestion becomes the full remaining balance; even split removed
- [x] `verify-tax-schedule.ts` updated and extended; `verify-tax.ts` scaled-rows case
- [x] `booksFiguresUrl(year, through?)`; estimator reads the period's books actuals once and computes the annualized requirement
- [x] Hero card shows both rows and the shortfall cost; tiles show both lines, no "About"
- [x] Verify: suites, tsc, eslint, no em-dashes, read-only browser check

Review 2026-09-12: schedule 46 checks (period table, books-only scaling, prorated withholding, quarter-bounded payments, share and floor, shortfall cost), engine 101 (scaled income leaves the standard deduction whole); tsc and eslint clean. On the live 2026 estimate the card reads "Tax on the year so far 4,200.68 / 948.68" and "Required, annualized 4,762.99 / 835.24, income through Aug 31", with a 562.31 federal shortfall costing about 13.16 to Jan 15; the Q3 tile carries both lines and Q4 carries none; the period read happens once after the books read lands. Nothing written. Owner found the hero oddly spaced (left column bottom-aligned against the taller card) and the two stacked rows confusing; the card is now a three-column table (Still owed, Annualized against Federal and Arizona) with one sentence naming the period, and the hero aligns to the top. Then, after the owner walked through the 90% rule: the labels became Actual, Minimum (the 90%-rule instalment) and Total (the same instalment without the cushion, 25% of the year per deadline), with the definitions moved into tooltips on the labels and the sentence under the table dropped; 47 schedule checks. Tooltips then shortened to one shape (what it is, what it means), the interest note moved from Minimum to Actual, and the Total row hidden whenever it equals Actual (Q4, factor 1). Books notes: the payroll sentence dropped; drafts became a count with a Review link ("3 transactions still to review are not in these figures yet") and stay out of the figures by the owner's decision; bank-fed and imported drafts now read "Unreviewed" in report detail and the Transactions menu, "Draft" reserved for manual entries. The owner found the review sentence too quiet; it is now a warning callout between the hero and the numbers (`tax-books-callout.tsx`) with the count, why it matters, Review and Refresh. Card header collapsed to one row (deadline left, due badge right; "Next payment" stays as the section label) and Record payment right-aligned. Input bank: the searchable Select's sticky search header now owns the popup's top padding and carries a hairline, so the list no longer shows through above the box; fixed in app, mirrored to admin, byte check green.

---

# Derived tax classification per year (2026-09-12)

Owner: 2022 shows as S-Corp but the LLC filed as an LLC through 2022 and elected S-Corp from 2023; "In effect since: Not recorded" let the profile save stamp every year. Rule: the profile decides every year, the election from its start year on, the entity's default before it. Plan: `~/.claude/plans/twinkly-whistling-creek.md`.

- [x] `lib/business-classification.ts` (pure: defaultClassification, isElection, classificationForYear, businessTypeForYear) + `scripts/verify-accounting-business-classification.ts`
- [x] `saveBusinessProfile` stamps years before and from the start year separately; `describeTaxProfileForYear`
- [x] Business settings: start year required for an election, options from formation to next year, honest helper copy, cleared when nothing is elected
- [x] Tax years page, estimator and setup wizard derive each year's structure from the profile
- [x] Books: `tax_source.year_settings` derived with the same rule, `current` dropped, picker gate points at Business settings; delta SQL in chat
- [x] Guide: profile step names a missing election year
- [x] Verify: classification, workpapers, figures, setup, schema, tax engine and schedule suites; tsc; eslint; no em-dashes; browser check of the field and the guide sentence (the repairing save is the owner's)

---

# Setup guide: close every loop (2026-09-12)

Owner: "I reviewed the payroll and it's good... there's literally no way for me to dismiss the payroll callout or acknowledge that the work has been done properly"; "there can't be any UX gaps". Rule: every step is provable from data or acknowledgeable by the owner, and says what to do and where. Plan: `~/.claude/plans/twinkly-whistling-creek.md`.

- [x] Review every step's trigger against the live books and the SQL: payroll "verified YTD" unreachable from any owner path; classification pointed at a screen with no control; adjustments described an action the app cannot do; from-zero path (owner row, chart, system purposes, profile, bank) uncovered
- [x] SQL: `settings.setup` jsonb, `setup.acknowledge` in `operate`, `setup_status` returns chart/purposes/profile/acknowledgements/runs-without-register; parity green; delta in chat
- [x] Builder: chart, system-accounts, profile (ack "Looks right"), connect (ack), reconnect, mapping, mapping-partial (ack), sync (ack), primary (ack), treatments (ack per year), payroll-registers (ack per year); `claimGuide` before the owner row exists
- [x] Route: `view=setup` answers the claim step when accounting is not configured
- [x] Component: acknowledge and reopen through the command hook, both buttons on every row, done list under the expander, localStorage snooze removed
- [x] Figures copy: no more "year-to-date report"
- [x] Tests: setup suite (builder per step, provable-or-acknowledgeable rule, SQL command round trip, register count), figures, read-contracts, schema parity
- [ ] Verify in the browser after the delta is applied: profile step leads, "Looks right" moves it under done, Reopen restores it, every row carries both buttons, payroll step absent, 2025 on the estimator; phone width
- [x] Follow-ups spawned: Tax workpapers "Revise adjustment" always fails; `officer_wages` purpose unassignable from the Accounts picker
- [x] Re-ask: acknowledgements answer a state. Business details, discovered accounts and sync errors carry a fingerprint of what was confirmed and reopen with a reason when it changes; Wave-primary is per year; the key vocabulary now allows uuid prefixes (the sync dismissal would have been refused); 63 setup checks
- [x] Blank dialog on a real checkbox click: the input bank's sr-only input resolved its absolute position against the fixed dialog frame, so focusing it scrolled the frame 1,281px. `WorkflowDialog`'s scroll container is now `relative`; source fix in the input bank spawned as a task

---

# Setup guide banner (2026-09-12)

Owner: "we need to use [the callout banner system] as a setup guide... go in proper UX order based on priority, like bank connection first." One step at a time on the dashboard, every accounting screen and the Tax Estimator. Plan: `~/.claude/plans/twinkly-whistling-creek.md`.

- [x] SQL `accounting.setup_status(year, cutoff)` appended to the working-tree migration, mirrored in `schema.sql`; delta SQL in chat; `verify-accounting-schema` parity
- [x] `read.ts` case `setup-status` + read-contracts line
- [x] `lib/accounting/setup-guide.ts` pure builder (ports `booksNotices`, adds imports, classification, treatments, adjustments, payroll steps) + `scripts/verify-accounting-setup.ts`
- [x] `route.ts` `view=setup` branch (feeds + status in parallel, steps built server-side)
- [x] `components/features/accounting/setup-guide.tsx` (hook, one box, "N more after this", Later snooze for info steps, Suggest treatments dialog, in-place pushState links); `accountingHref(view, section?, params?)`
- [x] Placements: shell (replaces the notice stack), dashboard, Tax Estimator; delete `accounting-notices.tsx`
- [x] Verify: tsc, eslint, setup + read-contracts + schema suites, verify-accounting-all, input bank, no em-dashes, read-only browser check of all three placements; lesson
- [x] Owner feedback: the imports step was unclearable (multi-year Wave batch, parity re-flagged by any posted entry) and unexplained. Dropped it from the guide and from `setup_status` (delta SQL in chat), made the picker treat parity as a note instead of a gate, added "Later" on warning steps, and rewrote the treatments and payroll details to say what to do; lesson

Review 2026-09-12: tsc clean apart from the stale generated `.next/types/validator.ts`; eslint clean on the new files (the contracts script's five `no-explicit-any` and the dashboard's three unused-import warnings predate this change); setup suite 38 checks, read-contracts, schema parity (61 functions) and verify-accounting-all 48/50 pass (same two migration-shape failures as before). Browser check on the signed-in server, after the owner applied the delta SQL: the banner renders on the dashboard, every accounting screen and the Tax Estimator with the first open step ("Finish checking 1 import against the source"), the expander lists the treatments and payroll steps in order, "Suggest treatments" opens the rules review from the banner (cancelled, nothing applied), and the "Imports" link swaps the accounting view in place without a reload. At 375px the actions drop onto their own line (fixed during the pass) and nothing scrolls sideways. Before the SQL was applied the read returned a 400 (PostgREST PGRST202) and the banner stayed hidden, as designed.

---

# Suggest tax treatments by rule (2026-09-12)

Owner: no AI; rules first, flag the rest for manual review; loosen the payroll gate. Plan: `~/.claude/plans/twinkly-whistling-creek.md`. No new SQL, routes or dependencies.

- [x] `lib/accounting/tax-treatment-rules.ts` (prior year, purpose, name, subtype; manual review otherwise) + `scripts/verify-accounting-tax-treatments.ts`
- [x] Payroll fallbacks in `tax-books-figures.ts` (posted runs when no verified register; gross pay when taxable wages missing) + tests
- [x] `components/features/accounting/tax-treatment-review.tsx` (suggest list, overrides, needs-your-pick group, apply via tax.mapping commands)
- [x] Hosts: Tax workpapers accounts tab button + dialog; books picker second step with refetch
- [x] `accountingError` messages for ACCT_TAX_CONCEPT and ACCT_ACCOUNT_NOT_FOUND
- [x] Verify: tsc, eslint, treatments + figures suites, verify-accounting-all, no em-dashes, no anthropic references, read-only browser check of both hosts

Review 2026-09-12: tsc clean (source tree), eslint clean on touched files, treatments 58 and figures 77 checks pass, verify-accounting-all 47/49 (same two migration-shape failures as before). On the live 2026 books the rules placed 17 of 18 unmapped accounts (report group, purpose and name rules all fired) and flagged "Meals and Entertainment" for the owner's pick because its name fits two treatments. Nothing was applied; that is the owner's click.

---

# Books figures as rows (2026-09-12)

Owner: the accounting tax link "doesn't make sense"; the books should be a source in Add income, like income tracking. Safe harbor dropped. Plan: `~/.claude/plans/twinkly-whistling-creek.md`. SQL objects stay for a later cleanup migration (that migration must also update `verify-accounting-schema.ts:68,112`).

- [x] Types and pure code: `BooksLink` on the three row types, `payroll.ts` `source_through_date`, `ACCT_TAX_RANGE` message, `lib/accounting/tax-books-figures.ts`, `lib/tax/books-rows.ts`, template dedupe by books role, `scripts/verify-accounting-tax-figures.ts`
- [x] Schedule and meter without safe harbor; `federalDeadlines` moves into `payment-schedule.ts`
- [x] Estimator: `use-books-refresh.ts`, `books-figures-modal.tsx`, model and parent rewrite, card and sheet, popover entry; delete `use-accounting-tax-link.ts` and `tax-accounting-status.tsx`
- [x] `GET /api/accounting/tax?year=&through=` figures endpoint
- [x] Accounting-side removal: link files, workpapers estimator tab, route pre-flight, workflows, read.ts, worker route and middleware exemption, tax-service, local-test-client, lib files, `tax-projection.ts` trim
- [x] Scripts, package.json, `.env.example`, docs; `timing` and `paid_on` removed last
- [x] Verify: tsc, eslint, test:tax, test:tax:schedule, tax-figures, verify-accounting-all, grep for stragglers, read-only browser check

Review 2026-09-12: source tree typechecks (the generated `.next/types/validator.ts` still lists the deleted worker route until the dev server restarts or the next build); eslint clean on the touched files apart from pre-existing `no-explicit-any` in `verify-tax.ts` and `verify-accounting-tax-core.ts`; test:tax 99, test:tax:schedule 35, tax-figures 74; verify-accounting-all 46/48 with the same two migration-shape failures as before (`verify-accounting-db`, `verify-accounting-drop`, unrelated). Picker verified on the signed-in server against the live books: business profit held back ("18 accounts still need a tax treatment"), payroll held back ("Needs a verified year-to-date register"), Cancel adds nothing. Five empty "Q3/Q4 federal estimate" rows appeared on the live 2026 estimate during this session's browser checks; owner to decide whether to remove them.

---

# Tax Estimator redesign (2026-09-11)

Owner approved the mockup (artifact "Tax Estimator Redesign"): one hero number with a paid-vs-owed meter, rows that open an edit sheet, quarter tiles, a receipt column. Same data layer, calculation and persistence. Plan: `~/.claude/plans/twinkly-whistling-creek.md`.

- [x] `src/lib/tax/payment-schedule.ts` (deadlines, quarter buckets, suggested amounts, meter segments) + `scripts/verify-tax-schedule.ts` + `test:tax:schedule`
- [x] `.meter-hatch` utility in `globals.css`
- [x] `tax-estimator-model.ts` (model and actions types)
- [x] `tax-receipt.tsx` (replaces CalculationResults; every conditional line preserved)
- [x] `tax-hero.tsx` (still owed / refund / paid in full, meter, legend, next payment)
- [x] `tax-edit-sheet.tsx` (income, gain, withholding, payment, household, notes; Advanced disclosure)
- [x] `tax-inputs-card.tsx` (list rows, quarter tiles, household line, notes line)
- [x] `tax-accounting-status.tsx` rewritten as a pill + popover; dead "Payment planning" link removed
- [x] `tax-estimator-content.tsx` swap: model/actions builders, new composition, dead components deleted
- [ ] Verify: tsc, eslint (accounting config), test:tax, test:tax:schedule, verify-accounting-all, no em-dashes, demo walkthrough at desktop and mobile, privacy mask, keyboard pass

Out of scope at the time: the linked-row zeroing bug (since resolved by the books-figures change), safe-harbor plan authoring (since dropped), state deadline tables.

Guided entry (owner 2026-09-11: "confusing in terms of filling in your information"):
- [x] `tax-guide.tsx`: setup card while income is empty (Profile, Income, Tax already paid, Household), compact strip until paid and household are reviewed, hide/ack stored per year in localStorage
- [x] Sheet modes: profile (filing status, state; business structure read-only with settings link), add-income (template chips, import, custom), add-paid (withholding, quarterly estimate, nothing yet)
- [x] Inputs card: plain-language section descriptions, quick-add template chips, amounts editable in place on manual rows and tile rows
- [x] Parent: profile row becomes a button, setProfile action, guide prefs and step computation

Review 2026-09-11: typecheck, eslint (accounting config), test:tax (99), test:tax:schedule (38), input-bank byte check and 49/51 accounting suites pass; the two failing suites (`verify-accounting-drop`, `verify-accounting-db`) read the in-flight accounting migrations and fail independently of the tax files. Verified on the signed-in dev server (3002, read-only): desktop and 375px layouts, strip guide, quick-add chips, inline amounts, sheet open and Escape close. Console shows a 422 from `POST /api/accounting/tax`, the books-link refresh failing on the pre-existing "linked income target was removed" state. Open: the stored 2026 row lost Officer Salary, Business Profit and both W-2 withholding rows between the owner's two screenshots; not restored, waiting on the owner.


---

# Accounting: mobile pass (2026-09-11)

Owner report: the Overview scrolls sideways on a phone and the Transactions list shows cards inside a card. Make every accounting screen read cleanly at 375px.

- [ ] Overview: implicit `auto` grid columns let nowrap memos widen the panel grids past the viewport (`accounting-overview.tsx`); pin `grid-cols-1` and `min-w-0` on the panels and chart.
- [ ] DataTable: when `framed={false}` the parent is already a card, so the mobile stack renders as a divided list instead of cards on a card (`ui/data-table.tsx`).
- [ ] Transactions: mobile rows as list rows inside the section card, toolbar stacks cleanly (`accounting-transactions.tsx`).
- [ ] Other `framed={false}` + `mobileCard` callers (accounts, bank match, history, imports, payroll run, reconciliation, report detail, rules, support report) use the same row treatment.
- [ ] Audit the remaining accounting screens (agent report) and fix fixed widths, ungated multi-column grids and dialogs.
- [ ] Verify at 375px in the browser (demo server on 3003) and record results.

---
# Accounting: crash fixes and redesign (2026-09-10)

## Crash fixes (done, verified)
- [x] Month end: route `view=close` and `view=period-impact` in `src/app/api/accounting/route.ts` (Month end renders; 200 on both reads, 400 on a bad date).
- [x] Receipts: `accounting.documents()` returns `entries` (id, memo, entry_date). Migration `20260910222855_accounting_documents_entries.sql` + `schema.sql`; regression check in `verify-accounting-banking.ts`. OWNER: apply the migration to the finance project.
- [x] Sync on open: shell runs due connections through `/api/accounting/feeds` (same path as Sync now) and surfaces the blocking reason as a toast. `feedSyncDue()` in `lib/accounting/feeds.ts`.
- [ ] Owner: review the 11 discovered account mappings in Bank feeds so syncs can run.
- [x] Accounts view: bank cards overflow at 375px (fixed in the bank panel rewrite).

## Redesign (plan in `accounting-redesign-plan.md`, waiting for sign-off)
- [x] Phase A: sidebar accordion under Accounting (Overview, Transactions, Accounts, Reports, Records, Settings, Export books) mirroring the app sidebar; no in-page tab bar or gear; light-mode fix for brand text tokens inside the dark rail (`--color-teal-light` re-derived in the dark block). Settings and Records as views, Overview page (`accounting-overview.tsx` + `charts/cash-flow-chart.tsx`), `ui/institution-logo.tsx` with inlined brand glyphs (`lib/institution-icons.ts`), DM Sans money everywhere, skeleton loaders, DataTable tints raised for dark mode, dialogs calmed (transaction editor, entry detail). Old `?view=manage` links redirect.
- [x] Data export moved to Settings > Data management: dataset picker (personal finance + books), JSON or CSV zip, optional books date range, `GET /api/export`. The old `/api/accounting?export=true` link (never routed) is gone from the sidebar and accounting settings.
- [x] Flow audit 2026-09-11 (two agent reports, see chat): syncs now send `create_drafts` so unmatched movements land in Needs review; sync on open only tries connections with a mapped account; mapping dialog defaults History begins to `primary_system_since`; Accounts and Overview say "Not mapped" with a Map accounts action instead of "Not connected".
- [x] Flow fixes 2026-09-11: books notices under every accounting header (`accounting-notices.tsx`: map accounts, partial mapping, reconnect, sync error, Wave still primary); contractor flag sent by party.save (partnership/requested options dropped, they never saved); payee default category applied in `apply_treatment` (migration appended, owner applies); New payee from the transaction editor; Remember payee checkbox in the editor; Income by customer hides vendors and vice versa; Review as I categorize toggle plus bulk Mark reviewed too, selection kept; Record as transfer from a draft row with counterpart detection (`accounting-transfer-from-draft.tsx`); month end step 2 only counts accounts with a bank balance; mapping dialog trimmed (no timezone, signs under Advanced, note optional, no checkbox) and duplicate identity hint.
- [x] Modal simplification 2026-09-11 (owner: "every single modal I open has just way too much information"): `WorkflowDialog` takes an optional description (sr-only when omitted) and sizes sm/md/lg. Simplified: journal editor, approval, replacement review, bulk review, bulk set category, record transfer, new payee, connect/reconnect SimpleFIN, map account, disconnect, skip history, CSV import wizard, cancel import, post imported, review source group, lock covered months, attach document, match bank movement, edit account, standard chart, account ledger, add account, reconciliation confirm, new statement, add statement item, line detail, classify cash movement, rule editor, alias, add/edit payee, lock/reopen month. Pattern: short title, one sentence only when it changes the decision, extras under Advanced still submitting their defaults, one verb button plus ghost Cancel.
- [x] Crash fix: the estimator link's history dialog read `count`/`snapshots`/`versions`, but `tax-history` returns only `rows`. `LinkHistory` in `accounting-tax-link.tsx` now renders the audit rows as "Change history" with plain-English actions (Recalculated, Link settings saved). The workpapers history empty state read the same missing `count` and now checks `rows.length`.
- [ ] Modals not yet done (agent stopped on a model limit): payroll run, manual registers, register action, tax workpapers, transfers, books package. (Tax link and its editor were retired 2026-09-12.)
- [x] Sidebar: Tax Estimator moved to sit directly below the Accounting group, still a main-level item (not nested in the accordion).
- [x] Tax estimator zeroed a linked business income row when the books link read failed. Resolved 2026-09-12 by retiring the link: books figures now live on the row and a failed refresh keeps the last values.
- [ ] Still open: feed.map never stamps company ownership in the discovery map (SQL, hidden by the UI); a changed provider record stalls an account with only feed.skip as escape; scope `busy` to the row on Transactions; collapse the three review surfaces.
- [ ] Phase B: Transactions simplification and vocabulary pass.
- [ ] Phase C: Accounts and Reports polish, Month end card.
- [ ] Phase D: one-click ownership review, feed worker scheduler.

---
# Payroll Feature - Implementation Plan

Status: **Sections A & B complete (2026-04-17). Sections C-J pending.**

Scope: S Corp owner-operator payroll for the admin finance app. Open source, single-org deployment. Flexible schema supporting multi-frequency employees but optimized for single-owner use.

---

## Design principles

1. **Everything configurable via UI** - tax tables, state rules, organization info, schedules. No hardcoded rates.
2. **Historical immutability** - finalized pay runs snapshot their config versions. Editing a config never retroactively changes past runs.
3. **View-and-copy primary, PDF secondary** - the core UX is "read the numbers, copy them, pay from your bank." Email is additive (paystub delivery, enrollment confirmations) and fully opt-in.
4. **Zero data loss** - soft delete only, event-sourced history, void-as-reversal not overwrite, `ON DELETE RESTRICT` on FKs.
5. **Modular for future employees** - built for N employees even though N=1 today.
6. **Match existing admin patterns exactly** - `.glass-card`, plain useState forms, custom toast, MaskedValue, server-component-pages-pass-data-to-Content-components, Recharts for charts, dark+light theme, WCAG 2.1 AA.

---

## Out of scope (deliberate)

- Hourly tracking, PTO, overtime, benefits, retirement plans, garnishments
- Multi-state employees
- Local taxes (NYC, PA locals, OH RITA, etc.)
- Direct ACH / bank integration (user pays from their bank manually)
- E-filing 941/940 (pre-filled PDFs only)
- Multi-tenant / SaaS
- Runtime SMTP account management in production (email accounts are edited locally and committed; prod reads static config)

---

## Data model

### New tables

- [ ] `organization_config` - singleton: legal_name, fein, state_tax_id, state_ui_id, address JSONB, signer_name, signer_title, phone, email
- [ ] `federal_tax_configs` - per-year: tax_year PK, brackets JSONB, fica JSONB, futa JSONB, std_deductions JSONB, version_hash, notes
- [ ] `state_tax_configs` - per (state_code, tax_year): calculation_method ENUM, config JSONB (shape varies), sdi_config JSONB, suta_config JSONB, version_hash, notes
- [ ] `payroll_employees` - roster with W-4 + state election fields, encrypted SSN, pay_frequency, pay_anchor_date, semimonthly_days, monthly_day, pay_lag_days, target_annual_comp (optional S Corp benchmark)
- [ ] `payroll_runs` - the ledger. Snapshots employee + tax configs at finalize. run_type enum: regular | off_cycle | correction. Status: draft | finalized | paid | voided.
- [ ] `payroll_run_history` - event-sourced audit trail (trigger `record_payroll_run_history()` mirrors `record_expense_history()`)
- [ ] `payroll_tax_deposits` - federal 941, 940, state withholding, SUTA deposits. Status: scheduled | paid | late.
- [ ] `payroll_forms` - generated 941/940/W-2/W-3/EFW2/state forms. Status: draft | filed.
- [ ] `config_change_history` - audits edits to federal/state/organization configs

**Total: 10 tables**. `payroll_employees.tax_id_encrypted` stores AES-256-GCM ciphertext of SSN/ITIN.

### Migration strategy

- [ ] Ship migration that seeds `federal_tax_configs` for current year
- [ ] Ship migration that seeds `state_tax_configs` for AZ current year (2.5% flat, employee-elected withholding rates `[0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]`%, SUTA new employer 2.0% on first $8,000, no SDI)
- [ ] All tables follow existing admin patterns: UUID PK, `deleted_at`, `created_at`, `updated_at`, `update_updated_at()` trigger
- [ ] RLS: open-access-authenticated pattern (consistent with rest of admin)

### Soft-delete & integrity

- [ ] FK `payroll_runs.employee_id → payroll_employees.id ON DELETE RESTRICT`
- [ ] FK `payroll_runs.reverses_run_id → payroll_runs.id ON DELETE RESTRICT` (for corrections)
- [ ] FK `payroll_forms.employee_id → payroll_employees.id ON DELETE RESTRICT`
- [ ] Soft-delete pattern on all tables except history tables

---

## Calculation engine (pure, testable)

Location: `admin/src/lib/payroll/`

- [ ] `engine.ts` - orchestrator: `calculateRun(employee, period, fedConfig, stateConfig, ytdSnapshot) → RunResult`
- [ ] `federal.ts` - IRS Pub 15-T percentage method, FICA with wage base cap, additional Medicare 0.9% over 200k YTD, FUTA
- [ ] `state/index.ts` - dispatcher by `calculation_method`
- [ ] `state/none.ts` - returns zeros
- [ ] `state/flat.ts` - rate × (gross - std deduction - allowances)
- [ ] `state/flat-employee-elected.ts` - Arizona-style: employee-chosen rate from allowed list
- [ ] `state/progressive.ts` - bracket lookup by filing status
- [ ] `state/custom.ts` - JSON formula evaluator (minimal expression language)
- [ ] `schedule.ts` - `getNextPayDate()`, `getAllUpcomingPayDates()`, `groupEmployeesByPayDate()`
- [ ] `ytd.ts` - aggregate prior runs for YTD lookups (SS wage base cap, additional Medicare threshold)
- [ ] `supplemental.ts` - off-cycle bonus tax (22% federal flat rule for supplemental < $1M)
- [ ] `proration.ts` - mid-period hire/termination proration helper

Every function pure, no Supabase access. Persistence handled separately.

### Encryption helper (shared, not inside payroll/)

Location: `admin/src/lib/crypto/aes.ts`. Mirrors `Valiance Media Starter/src/lib/email/crypto.ts` line-for-line but generalized:
- AES-256-GCM, 12-byte IV, auth tag appended
- Output format: `iv_hex:authTag_hex:ciphertext_hex`
- Accepts an env-var name as parameter so SSN and SMTP can use different keys:
  - `encryptWith(keyEnvVar, plaintext) → string`
  - `decryptWith(keyEnvVar, ciphertext) → string`
- Thin wrappers: `src/lib/crypto/ssn.ts` uses `AES_ENCRYPTION_KEY`; `src/lib/email/crypto.ts` uses `SMTP_ENCRYPTION_KEY`
- Throws a clear error if the named env var is missing
- Server-side only (API routes + server components); never shipped to client bundle

---

## Routes

- [ ] `/payroll` - overview (stats, grouped pay-date batches, recent runs, optional S Corp comp tracker)
- [ ] `/payroll/employees` - list with sort/filter/tabs
- [ ] `/payroll/employees/new` - sectioned form with live pay-stub preview
- [ ] `/payroll/employees/[id]` - detail, edit-in-place, YTD, trend chart, pay history
- [ ] `/payroll/run?date=YYYY-MM-DD` - batch review for a pay date
- [ ] `/payroll/run/off-cycle` - off-cycle payment workflow
- [ ] `/payroll/runs` - all runs history
- [ ] `/payroll/runs/[id]` - run detail with copy-first values layout
- [ ] `/payroll/taxes` - tabbed (Deposits / 941 / 940 / W-2 / State)
- [ ] `/payroll/taxes/deposits/[id]`
- [ ] `/payroll/taxes/941/[year]/[quarter]`
- [ ] `/payroll/taxes/940/[year]`
- [ ] `/payroll/taxes/w2/[year]`
- [ ] `/payroll/taxes/w2/[year]/[employeeId]`
- [ ] `/payroll/config` - settings index
- [ ] `/payroll/config/organization` - FEIN, state IDs, legal info
- [ ] `/payroll/config/federal/[year]` - federal tax table editor
- [ ] `/payroll/config/states` - list of configured states + add-new
- [ ] `/payroll/config/states/[code]/[year]` - polymorphic state config editor
- [ ] `/payroll/config/onboarding` - first-run wizard
- [ ] `/payroll/reports` - CSV + bundled exports

### Sidebar

- [ ] Add `{ title: "Payroll", href: "/payroll", icon: Users2 }` to `src/components/layout/sidebar.tsx` navItems (between Expenses and Net Worth)

---

## API routes (first in admin)

- [ ] `POST /api/payroll/runs/calculate` - calc preview, doesn't persist
- [ ] `POST /api/payroll/runs/finalize` - writes finalized runs with snapshots
- [ ] `GET  /api/payroll/pay-stub/[runId]` - streams PDF
- [ ] `POST /api/payroll/forms/[formId]/generate` - computes form data
- [ ] `GET  /api/payroll/forms/[formId]/pdf` - streams PDF
- [ ] `GET  /api/payroll/forms/efw2/[year]` - streams EFW2 text file

Note: `export const dynamic = "force-dynamic"` on every handler.

---

## New infrastructure

- [ ] `@react-pdf/renderer` package for PDF generation (pay stubs, 941, 940, W-2)
- [ ] `nodemailer ^8.0.1` package for SMTP sending
- [ ] AES-256-GCM helper at `src/lib/crypto/aes.ts` (copy from `Valiance Media Starter/src/lib/email/crypto.ts`, rename exports to generic `encrypt`/`decrypt`/`isEncryptionConfigured`). One shared helper serves SSN encryption + SMTP password encryption.
- [ ] `src/lib/email/send-mail.ts` (port from Starter): `sendTransactional(options)` for app-to-user emails. Relay mode not needed; skip.
- [ ] `settings.json` at admin project root: `{ email: { accounts: [...] } }`. Committed to git (passwords encrypted). Decryption key stays in env.
- [ ] Loader helper `src/lib/email/load-accounts.ts`: reads settings.json, returns typed `EmailAccount[]`
- [ ] `.env.example` additions: `AES_ENCRYPTION_KEY=` (SSN encryption) + `SMTP_ENCRYPTION_KEY=` (SMTP password encryption). Same algorithm, separate keys by concern.
- [ ] Startup guard: if `AES_ENCRYPTION_KEY` missing, payroll routes render a clear error screen directing user to set the env var
- [ ] Email-send guard: if no accounts configured or `SMTP_ENCRYPTION_KEY` missing, `sendTransactional` returns `{ success: false, error }` without throwing; callers treat email as best-effort

---

## Integration with existing admin features

- [ ] Dashboard (`/`): add payroll costs to business-expense aggregations (query `payroll_runs` where `status IN ('finalized','paid')`)
- [ ] Add "Payroll YTD" StatCard to main dashboard
- [ ] Do NOT duplicate runs into `expenses` table (different domain: transactions vs recurring costs)
- [ ] Tax Estimator (`/tax-payments`): when a federal tax deposit is marked paid, optionally auto-append to `tax_estimates.payments` JSONB for the year (avoid double-entry)
- [ ] `/settings/trash` reuse: soft-deleted payroll records show up there with restore option

---

## UX specifics

### `/payroll` overview

- StatCards: Monthly Payroll Cost · YTD Gross Wages · YTD Employer Taxes · Next Run Due
- Optional S Corp reasonable-comp progress widget (if `target_annual_comp` set on any employee)
- "Upcoming Pay Runs" grouped by pay date, each with employees list + total + Review button
- Recent Pay Runs table (last 10), card layout on mobile
- Right sidebar: Tax Deposits Due · Payroll by Employee pie
- Year-boundary warning banner if no tax config for upcoming year (shown Nov-Dec)

### `/payroll/run?date=...`

- Sticky header: Pay Date (editable), "Finalize All" button
- One row per employee due on that date
- Row: name, period dates, Gross, collapsible breakdown, Net, "Adjust" button (proration/bonus dialog), Reviewed checkbox
- Finalize flow: confirmation dialog → write snapshots + calculate → post-finalize action page
- Post-finalize action page: **copy-first** list of what to do in your bank, with amounts one-click copyable

### `/payroll/runs/[id]`

- Header: employee name + period + status badge
- **Payment Instructions card** (primary): net amount with copy button, payment method dropdown, mark-paid action
- Breakdown card: gross → each withholding line with copy buttons → net
- Employer liabilities card: FICA match + FUTA + SUTA with copy buttons
- Actions: Mark Paid (dialog: method, reference, date) · Void (dialog: reason, creates reverser) · Download Pay Stub PDF
- History timeline at bottom (from `payroll_run_history`)

### `/payroll/employees/new`

Sectioned form (single page, clear section headers):
1. Basics: Name, Email, SSN (MaskedValue), Address, Hire Date
2. Employment: W-2/1099 radio, Pay Amount, Pay Frequency, anchor fields (based on frequency)
3. Federal W-4: Filing Status, Multiple Jobs, Dependents, 4a/4b/4c
4. State Tax: State dropdown → renders polymorphic form (for AZ: A-4 rate picker + dependents)
5. Optional: target_annual_comp for S Corp reasonable-comp tracking
6. Live summary cards: computes and displays a preview pay stub using current form values

### `/payroll/config/states/[code]/[year]`

Polymorphic editor based on `calculation_method`:
- `none`: just notes + SDI + SUTA
- `flat`: rate input + optional std deduction + optional allowance × count
- `flat_employee_elected`: default rate + allowed rates array (chips UI)
- `progressive`: bracket table editor (add/remove rows per filing status) + std deductions
- `custom`: advanced editor (probably JSON textarea with syntax highlight - v2+)

Every save writes a `config_change_history` row. Never mutates prior snapshots.

---

## Pre-seed values (verified online Apr 2026)

### Federal 2026 (`federal_tax_configs` seed)

```
FICA:
  Social Security: rate 6.2% (each side), wage base $184,500  (up from $176,100 in 2025)
  Medicare: rate 1.45% (each side)
  Additional Medicare: 0.9% on individual YTD over $200,000 (employee side only, no employer match)

FUTA: 0.6% on first $7,000 wages per employee

Standard deductions (2026):
  Single: $16,100
  MFJ:    $32,200
  HOH:    $24,150

Income tax brackets: pulled from IRS Publication 15-T 2026 (percentage method)
  Note: Pub 15-T 2026 updated for OBBBA (One Big Beautiful Bill Act, enacted Jul 2025).
  OBBBA's tip/overtime deductions do not apply to our salaried-only scope.
  7 brackets, max rate 37%.
```

### Arizona 2026 (`state_tax_configs` seed, unchanged from 2025)

```
calculation_method: 'flat_employee_elected'
config: {
  rates: [0.005, 0.010, 0.015, 0.020, 0.025, 0.030, 0.035],
  defaultRate: 0.020   // Form A-4 default if employee doesn't file
}
sdi_config: {}  // Arizona has no state disability
suta_config: {
  newEmployerRate: 0.020,     // 2.0% new employer, minimum 2 calendar years
  wageBase: 8000,             // First $8,000 of wages per employee
  rangeMin: 0.0003,           // Rate range 0.03% - 8.36% for established employers
  rangeMax: 0.0836,
  formsDue: ['A-1-QRT quarterly', 'A-1-APR annual']
}
actualTaxRate: 0.025  // AZ actual flat income tax = 2.5% (withholding rate is employee-elected per A-4)
```

Sources verified: Bloomberg Tax (AZ rates unchanged for 2026), AZ DES UIT-0603A FY26, IRS SSA.gov wage base release, IRS Pub 15-T 2026.

---

## Onboarding wizard (mirrors tax-setup-card pattern exactly)

Reference: `src/components/features/tax/tax-setup-card.tsx` + its integration at `tax-estimator-content.tsx` line 508 (`const isSetupMode = estimates.length === 0`).

**Pattern verified from existing admin code:**
- Sidebar nav always visible
- Navigate to `/payroll` → check `organization_config` row exists → if not, render `<PayrollSetupCard>` inline (empty-state guard)
- Local component state machine (no URL routing, no progress bar)
- Glass card centered layout, icon badge, sectioned form, uppercase section headers
- "Continue" / "Back" buttons, no step indicator (matches tax wizard's minimal approach)
- Batch insert on finish, then `router.refresh()`
- **Enrollment state = presence of `organization_config` row**. No separate enable flag, no feature toggle table.

**Steps (local state `step: 1 | 2 | 3 | 4`):**

- [ ] Step 1 - Organization: legal name, FEIN (9-digit), state withholding ID, state UI ID, address, signer name, signer title, phone, email
- [ ] Step 2 - Federal confirm: read-only view of pre-seeded 2026 federal config, "Looks right" continue button, "Edit later at Settings > Federal"
- [ ] Step 3 - State: dropdown defaulting to AZ (pre-seeded), renders polymorphic editor inline for review, can change state here
- [ ] Step 4 - First employee: full employee form with live pay-stub preview (same form as `/payroll/employees/new`)
- [ ] "Complete Setup" button: batch insert → organization_config + confirm federal + confirm state + first employee, all in one transaction
- [ ] On finish: `router.refresh()` → the overview renders since `organization_config` now exists

---

## Unified v1 build (dependency-ordered, single release)

Per direction: no separate phases. One v1 build, sections implemented in dependency order.

### Section A - Foundation ✅

- [x] Single migration file `supabase/migrations/20260417_create_payroll.sql` containing all 9 tables + triggers + RLS + seed. One-file-per-feature matches existing `20260319_create_tax_estimates.sql` convention.
- [x] Triggers: `record_payroll_run_history()` mirrors `record_expense_history()` (insert + update variants). `update_updated_at()` applied to every new table. `record_config_change_history()` dropped in favor of explicit client-side writes so `change_summary` can carry UI context (documented in migration comment).
- [x] Seed: Federal 2026 (FICA SS 6.2%/$184,500, Medicare 1.45%, Add Medicare 0.9%/$200k, FUTA 0.6%/$7,000, std deductions $16,100/$32,200/$16,100/$24,150 CONFIRMED; percentage-method brackets seeded as 2025 Pub 15-T placeholders flagged for onboarding-wizard confirmation). AZ 2026 confirmed unchanged (0.5-3.5% A-4 rates, default 2.0%, actual 2.5%, SUTA 2.0% new/$8,000).
- [x] Shared AES-256-GCM helper at `src/lib/crypto/aes.ts` with `encryptWith(envVar, plaintext)` / `decryptWith(envVar, ciphertext)`. Thin wrappers: `src/lib/crypto/ssn.ts` (AES_ENCRYPTION_KEY, with 9-digit normalization), `src/lib/email/crypto.ts` (SMTP_ENCRYPTION_KEY).
- [x] `.env.example` additions: `AES_ENCRYPTION_KEY=` + `SMTP_ENCRYPTION_KEY=` with generation command and rationale.
- [x] Startup guard: `src/app/(dashboard)/payroll/layout.tsx` checks `isSsnEncryptionConfigured()`, renders `<PayrollEncryptionGuard>` with generation instructions if missing. Demo mode bypasses.
- [x] Canonical `supabase/schema/schema.sql` appended with all 10 payroll tables + trigger + DO-block RLS loop.
- [x] TypeScript compiles clean (`tsc --noEmit` passes).

**User next step:** Run the 5 migration files against Supabase (in order). Then generate the two env keys and add to `.env.local`.

### Section B - Config layer ✅

- [x] `src/types/payroll.ts` - Row/Insert/Update for 9 tables + JSONB shape types + enum unions + UI labels
- [x] `src/lib/payroll/audit.ts` - `recordConfigChange()` helper with shallow-diff summary generator
- [x] `/payroll/config` index (3 cards: Organization, Federal, States)
- [x] `/payroll/config/organization` editor (singleton upsert, FEIN/ZIP validation)
- [x] `/payroll/config/federal` list of years + `/payroll/config/federal/[year]` editor with "Copy from prior year" action (bracket tab editor for single/mfj/mfs/hoh, FICA/FUTA/std-deductions sections, SHA-256 version hash)
- [x] `/payroll/config/states` list (grouped by state code) + `/payroll/config/states/new` picker + `/payroll/config/states/[code]/[year]` polymorphic editor (none/flat/flat_employee_elected/progressive/custom with per-method sub-editors)
- [x] Every config save logs to `config_change_history` via explicit `recordConfigChange()` call with UI-context summary
- [x] Sidebar `Payroll` nav entry (Users2 icon) between Expenses and Net Worth
- [x] Placeholder `/payroll` overview that links to `/payroll/config` (Section D will replace with real overview + setup wizard)
- [x] `tsc --noEmit` + `next build` both pass clean

### Section C - Calculation engine (pure TS)

- [ ] `src/lib/payroll/engine.ts` - orchestrator
- [ ] `src/lib/payroll/federal.ts` - Pub 15-T percentage method + FICA (with SS cap + Add Medicare threshold) + FUTA
- [ ] `src/lib/payroll/state/index.ts` - method dispatcher
- [ ] `src/lib/payroll/state/{none,flat,flat-employee-elected,progressive,custom}.ts`
- [ ] `src/lib/payroll/schedule.ts` - pay-date math (weekly/biweekly/semimonthly/monthly, with end-of-month logic)
- [ ] `src/lib/payroll/ytd.ts` - aggregate prior runs for caps/thresholds
- [ ] `src/lib/payroll/supplemental.ts` - 22% flat for off-cycle bonuses under $1M
- [ ] `src/lib/payroll/proration.ts` - mid-period hire/termination

(SSN encryption uses `src/lib/crypto/aes.ts` from Section A, imported where needed.)

### Section D - Onboarding wizard

- [ ] `src/components/features/payroll/payroll-setup-card.tsx` (4-step, mirrors tax-setup-card)
- [ ] Empty-state guard on `/payroll` page: `if (!organizationConfig) return <PayrollSetupCard />`
- [ ] Sidebar nav entry added to `src/components/layout/sidebar.tsx`

### Section E - Employee management

- [ ] `/payroll/employees` list (ExpensesListContent-style: mobile cards + desktop table + sort + tabs for All/W-2/1099/Terminated)
- [ ] `/payroll/employees/new` sectioned form (Basics + Employment + Federal W-4 + State + Live preview card)
- [ ] `/payroll/employees/[id]` edit-in-place + YTD summary + pay history table + trend chart + terminate/restore/delete actions
- [ ] SSN field: encrypt via `src/lib/crypto/aes.ts` on write, decrypt server-side only at form-generation time, MaskedValue display in UI (hover-to-reveal or "Show SSN" button with audit trail)

### Section F - Pay run workflows

- [ ] `/payroll` overview: StatCards + S Corp comp tracker (if `target_annual_comp` set) + upcoming pay-date batches + recent runs + right-sidebar widgets
- [ ] Year-boundary warning banner logic (shown Nov 1+ if no next-year config)
- [ ] `/payroll/run?date=YYYY-MM-DD` batch review (calculate preview for each due employee, per-row adjust dialog, Finalize All)
- [ ] Post-finalize action page: clean one-screen copy-first list of "pay these N people this amount" + upcoming tax deposits
- [ ] `/payroll/runs` history
- [ ] `/payroll/runs/[id]` detail: Payment Instructions card (huge copy-friendly numbers) + breakdown card + employer liabilities card + history timeline + mark paid / void / download PDF actions
- [ ] `/payroll/run/off-cycle` supplemental payment (applies 22% flat federal withholding rule)
- [ ] Void creates reversing run via `reverses_run_id`, never mutates original

### Section G - Tax deposits & forms

- [ ] On run finalize: auto-generate `payroll_tax_deposits` rows (federal 941 deposit per pay date or per monthly rollup based on depositor schedule; AZ A-1 deposit; FUTA accrual)
- [ ] Federal depositor schedule detection (monthly vs semi-weekly based on prior lookback)
- [ ] `/payroll/taxes` with tabs: Deposits · 941 · 940 · W-2/W-3 · State
- [ ] Deposits tab: list with due dates + amounts + EFTPS/state portal links + mark-paid dialog with confirmation number
- [ ] 941 generator: all line items computed from finalized runs for the quarter
- [ ] 940 generator: annual FUTA
- [ ] W-2 + W-3 generator per employee + company summary
- [ ] EFW2 fixed-width file builder per SSA Publication 42-007 (downloadable text file for BSO upload)
- [ ] AZ A-1-QRT quarterly generator
- [ ] AZ A-1-APR annual generator
- [ ] `@react-pdf/renderer` templates: pay stub, 941, 940, W-2, A-1-QRT, A-1-APR
- [ ] Mark-filed workflow with confirmation number tracking

### Section H - Integrations

- [ ] Main dashboard `/`: payroll costs roll into existing business-expense aggregations
- [ ] "Payroll YTD" StatCard on `/`
- [ ] Tax Estimator `/tax-payments`: on mark-paid of federal deposit, push optional entry into matching year's `tax_estimates.payments` JSONB
- [ ] `/settings/trash`: soft-deleted payroll records appear with restore action
- [ ] `/payroll/reports`: CSV exports (all runs for year, per-employee annual, tax summary) + zipped accountant package

### Section I - Email infrastructure (ported from Valiance Media Starter)

**Architecture:** single-account or multi-account SMTP, edited locally via UI, committed to git as `settings.json`. Production is read-only for email accounts. Passwords encrypted with AES-256-GCM via `SMTP_ENCRYPTION_KEY` env var.

#### Core modules

- [ ] `src/lib/email/crypto.ts` - re-exports from `src/lib/crypto/aes.ts` with `SMTP_ENCRYPTION_KEY` (separate from `AES_ENCRYPTION_KEY` used for SSN). Same algorithm, different key, isolates blast radius.
- [ ] `src/lib/email/types.ts` - `EmailAccount` shape: `{ id, label, host, port, secure, username, encryptedPassword, fromName, fromEmail, replyTo?, isDefault }`
- [ ] `src/lib/email/load-accounts.ts` - reads `settings.json`, returns `EmailAccount[]`. Handles missing file gracefully (returns `[]`).
- [ ] `src/lib/email/send-mail.ts` - port `sendTransactional` from Starter verbatim, minus `sendRelay` (not needed for payroll). Header-injection sanitization preserved. Returns `{ success, messageId?, error? }` - never throws to callers.

#### Settings UI

- [ ] `/settings/email` route (mirrors Starter's EmailSettings.tsx, restyled to admin's `.glass-card` + teal/copper palette + Plus Jakarta Sans)
- [ ] List view: account cards with label, from-email, default badge, verified badge, test-send button, edit, delete
- [ ] Add/edit form: label, host, port, secure, username, password (masked input, encrypted on save), fromName, fromEmail, replyTo, isDefault toggle
- [ ] "Generate SMTP_ENCRYPTION_KEY" button with copy-to-clipboard (new key = invalidates existing accounts; warn clearly)
- [ ] Test-send dialog: recipient, subject, body. Calls verify API, displays success/error.
- [ ] Dev-only notice banner in UI: "Email accounts edit locally and commit to git. Production reads static config."

#### API routes (mirrors Starter paths under `/api/settings/email/`)

- [ ] `GET/POST /api/settings/email` - list + create
- [ ] `PUT/DELETE /api/settings/email/[id]` - update + delete
- [ ] `POST /api/settings/email/test` - send test email
- [ ] `POST /api/settings/email/verify` - verify SMTP connection without sending
- [ ] `POST /api/settings/email/generate-key` - return a cryptographically random passphrase for `SMTP_ENCRYPTION_KEY`
- [ ] All routes write/read `settings.json` via a single lockfile-safe writer (prevent races if two tabs save simultaneously)
- [ ] `export const dynamic = "force-dynamic"` on each

#### Payroll integration points

- [ ] Payroll-run finalize flow: after finalize, offer "Email paystub to [employee.email]" button on post-finalize action page and on `/payroll/runs/[id]` detail
- [ ] Onboarding wizard step 1 (Organization): if any email accounts configured, show optional "Default sender" dropdown; if none, show dismissible "Set up email at Settings > Email" link
- [ ] Employee form: email field already collected; used as recipient when emailing paystubs
- [ ] Tax-deposit mark-paid: optional "Email confirmation to accountant" if a "Accountant Email" is set in `organization_config`
- [ ] Year-boundary warning banner: optionally email to signer if email configured (best-effort, never blocks)

#### Retirement of existing email path

- [ ] Keep `supabase/functions/process-automations` edge function's denomailer path for now (it uses Supabase secrets, different ecosystem). Decide in Polish section whether to migrate it to use the new unified `settings.json` + nodemailer path or leave separated.

#### Gotchas / decisions

- Two encryption keys (`AES_ENCRYPTION_KEY` for SSN, `SMTP_ENCRYPTION_KEY` for SMTP). Separating them means rotating one doesn't invalidate the other.
- `settings.json` committed by design; `.gitignore` must NOT exclude it. Document in README why this is safe (encrypted-at-rest, key in env).
- Lockfile pattern for concurrent writes: use `proper-lockfile` or a manual `settings.json.lock` check.
- Production deployments can't add new email accounts via UI. This is an accepted constraint, not a bug.

### Section J - Polish

- [ ] Demo mode: seed 3 employees, 6 runs, 4 deposits; block mutations
- [ ] Light + dark mode parity pass on every new component
- [ ] WCAG 2.1 AA pass: focus-visible rings, ARIA labels, keyboard navigation on batch review page, `aria-hidden` on decorative icons, `prefers-reduced-motion` wrappers on Framer animations
- [ ] Copy-to-clipboard affordance on every numeric value in Payment Instructions card
- [ ] README in `admin/` updated: setup, env vars, yearly tax-table update workflow, form-filing workflow, EFW2 upload steps
- [ ] Document in `admin/tasks/lessons.md` any patterns learned during implementation

**Estimated: ~28 working days end-to-end** (includes ~3 days for email infrastructure port).

---

## Yearly maintenance (after v1 ships)

Once per January:
- [ ] Create new `federal_tax_configs` row for the new year (UI: copy prior + update brackets/wage base/FUTA)
- [ ] Create new `state_tax_configs` row for each configured state
- [ ] ~30 min total

---

## Review section (fill after implementation)

_(To be populated as phases complete.)_
