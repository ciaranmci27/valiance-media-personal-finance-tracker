# Accounting books specification

Status: consolidated implementation specification, 2026-09-05. No accounting implementation is claimed complete. This document supersedes the September 2 draft and the recommendations in `accounting-spec-review.md`. Build order and completion gates are in [accounting-build-plan.md](accounting-build-plan.md).

## 1. Product decisions and scope

Build a dependable Wave replacement inside `admin`: one company, one owner login, USD, calendar fiscal year, LLC taxed as an S corporation. Patriot continues to run payroll. `app` owns invoice creation and project management. The owner files the company and personal returns.

Accounting is its own area. Income, Expenses, Net Worth, their manual records, and the Tax Estimator remain. Accounting can supply explicitly linked values without replacing those features or silently overwriting personal data.

Import all available Wave accounting history into the real books. Imported economic transactions appear in the normal register, search, balances, and reports alongside new entries. There is no separate historical ledger or archive-only user experience. Source tracking distinguishes Wave, SimpleFIN, CSV, manual entries, and internal documents. Original export files remain supporting evidence.

Wave remains available through year end or longer at the owner's discretion. No date forces cancellation or cutover. Transition requires demonstrated parity and an explicit choice of authoritative system. Keeping the subscription does not require both systems to remain independently editable forever.

Full AI workflows, MCP, a polished REST API, and agent permissions are deferred. Reusable internal functions, stable IDs, provenance, and complete exports are required now. Linked business inputs and explicit projections in the existing tax estimator are in scope; unsupported tax calculations remain manual and visibly incomplete.

| Area | Initial delivery |
| --- | --- |
| Books | Chart, immutable double-entry ledger, manual entries/templates, corrections, audit, locks |
| History | Available Wave history in ordinary books, mappings, preview, source evidence, repeat-export comparison, parity proof |
| Banking | SimpleFIN, manual accounts, CSV, duplicate resolution, dated transfers, statement reconciliation |
| Workflow | Review inbox, rules, payees, document inbox, receipt matching, saved filters, bulk previews, keyboard review, optional project/client and business-line dimensions |
| Operations | Cash-basis receivables, complete invoice feed, partial payments/refunds, Patriot journal and liability clearing, manual asset/loan registers |
| Reports | P&L, balance sheet, cash movements, trial balance, GL/register, receivables, vendor/customer summaries, contractor worksheet, exports |
| Tax | Versioned mappings/adjustments, linked business profit and supported payroll data, projection assumptions, recorded payments, estimate snapshots |
| Reliability | Restricted write functions, exact money, concurrency protection, document/database backups, restore drills, staging/demo, accounting scenario tests |

Deferred: multi-entity, accrual-mode toggle, foreign-currency accounts/invoices, inventory, full accounts payable, payment processing, payroll execution, government filing/remittance, tax-basis/depreciation engines, receipt OCR, public API/AI interfaces, and general budgeting. USD amounts already converted by a bank are supported. Processor connectors are later; supported manual entries/evidence cover occasional payouts. Small loan/asset registers are bookkeeping aids, not calculation engines.

## 2. Implementation boundaries

Use the existing Next.js/React application, Supabase, component library, themes, responsive patterns, and masked currency displays. Do not scaffold another application.

| Path | Responsibility |
| --- | --- |
| `admin/src/app/(dashboard)/accounting/` | Pages and server loading |
| `admin/src/components/features/accounting/` | Accounting UI |
| `admin/src/lib/accounting/` | Exact money/dates, validated inputs, source adapters, report contracts |
| `admin/src/lib/accounting/server/` | Server-only orchestration and commands |
| `admin/supabase/schema/schema.sql` | Canonical final definitions edited in place |
| `admin/supabase/schema/seed.sql` | Default/reference data following repository conventions |
| `admin/supabase/migrations/` | Schema changes under migration rules |
| `admin/supabase/tests/`, `admin/scripts/` | Database and end-to-end accounting scenario verification |
| `admin/src/lib/demo/` | Synthetic fixtures independent of live data |
| `admin/src/lib/tax/`, `admin/src/lib/tax-core/` | Existing estimator and versioned tax configuration |

Existing `admin/src/lib/crypto/aes.ts` provides versioned Node encryption. SimpleFIN gets a separate key. Default bank worker is an authenticated Node job handler invoked on a schedule, with a persisted connection lease. Do not import the Node crypto helper into a Deno edge function without an explicitly verified compatible implementation.

Existing invoice receiver: `admin/src/app/api/webhooks/invoices/route.ts`; legacy income helper: `admin/src/lib/webhooks/reconcile-invoice-income.ts`; sender: `app/src/lib/webhooks/dispatch.ts`; emitter: `app/supabase/schema.sql`. The current emitter skips unpaid-only lifecycle changes and delivery is one attempt. Fix lifecycle/recovery for accounting while preserving legacy personal-income behavior until a linked replacement is explicitly enabled.

One migration file per commit. Check affected migration directories, reuse the working-tree migration, keep committed migrations immutable, and update canonical definitions. Split the two Supabase projects' migrations into separate commits when necessary. Every edit to an existing working-tree migration requires corrective delta SQL in chat. This plan change itself adds no migration.

## 3. Accounting policy and invariants

### 3.1 Policy

Canonical books use cash-basis revenue recognition with double-entry tracking of banks, cards, assets, liabilities, and equity. Issuing an invoice does not post AR/revenue to the GL; receivables are an operational subledger. Card purchases and payroll follow supported templates. Cash basis does not mean every accounting event is a checking-account movement. Tax differences remain explicit adjustments.

S-corp classification is the current setting, not a claim that every historical year had the same tax election. Record verified historical classification by fiscal year when it differs. Preserve original historical account labels and apply tax-year-appropriate mappings; importing years of books must not retroactively treat pre-election owner activity as S-corp payroll or distributions. A different legal entity remains outside this single-company scope and must be identified during source discovery.

`entry_date` is the financial date. Bank adapters propose the normalized posted date. Supported earlier economic dates, such as manual checks or receipts before bank clearing, require an explicit date/reason while retaining the bank posting date. Review time never determines financial recognition.

### 3.2 Enforced rules

| Rule | Enforcement |
| --- | --- |
| Posted entry balances | At least two nonzero lines, debit and credit present, exact signed sum zero; deferred DB constraint and command validation |
| Posted contents immutable | Block INSERT into posted entries and UPDATE/DELETE/reparent of posted lines; freeze financial date, state, accounts, amounts, dimensions |
| Corrections preserve history | Original and reversal both remain posted/included; replacement is a new entry with correction links |
| Period lock is effective | Financial writes acquire the same period lock as closing; evidence attachments may be added separately |
| Movement counted once | Match allocations cannot exceed either side; duplicate observations attach to existing movements |
| Evidence survives | Raw observations/original documents immutable; processing state is separate |
| Archives preserve history | Historical references remain valid; new activity cannot use archived accounts; archive only at zero balance with no unresolved activity |
| Reports reproducible | Posted-only default, exact math, explicit coverage and versions, retained close/filing snapshots |
| Changes attributed | Server-derived actor, operation ID, action, reason, timestamp, redacted before/after values |

Balance, completeness, correct categorization, and statement reconciliation are separate checks. A zero trial balance is not an overall green light.

### 3.3 Money and dates

Postgres amounts are signed `bigint` cents: debit positive, credit negative. TypeScript bookkeeping uses exact integer arithmetic. Transport uses integer-cent strings such as `"125050"`, not raw BigInt or potentially lossy JSON numbers. SQL aggregate `numeric` is allowed as an exact intermediate; range-check and serialize exactly.

USD parsing accepts `10`, `10.5`, `10.50`, and extra trailing zeros; rejects fractional cents and unsupported/ambiguous formats. CSV locale is explicit. Split rounding uses largest remainder with stable line-order tie breaking. Do not round discrepancies away.

Financial dates are `date`; observations/audit use UTC timestamps. Books timezone defaults to America/Phoenix. Preserve provider timestamps and conversion policy. Inclusive UI ranges map consistently to SQL bounds. Keep booked versus available balances and their actual observation cutoffs distinct.

## 4. State model and internal commands

| Object | States |
| --- | --- |
| Import | staged, validating, ready, applying, completed, failed, cancelled; counts/checkpoints persisted |
| Source processing | unmatched, matched, duplicate, excluded, exception; outside immutable evidence |
| Journal | draft, posted, discarded; only drafts can be discarded; posted never becomes voided/draft |
| Bank review | needs_review, ready, resolved, exception, derived from financial/matching state |
| Reconciliation | in_progress, completed, superseded; retain old completed versions |
| Period/year | open/locked periods; separate filed-package state and restatement versions |
| Document | inbox, linked, archived, plus upload/availability status |

After checking for existing activity, bank import normally creates a balanced draft against Uncategorized Income/Expense. Posting requires explicit owner approval or an individually enabled deterministic rule. Historical entries can be approved as a validated batch and become normal posted entries with original financial dates and current import timestamps.

Official reports/tax/exports default to posted entries. Working preview may include balanced drafts with a visible label and excluded-item counts; incomplete manual drafts never participate. Closing and reconciliation never silently post drafts.

Use authenticated server actions/routes and atomic DB functions, not browser sequences of independent table writes. Required command families: draft CRUD, validate/post, reverse/replace, import preview/apply, match/split/transfer, invoice settlement, payroll/clearing, reconcile/lock/reopen. A correction replacing a posted entry is atomic when approved as one operation.

Every mutation carries an idempotency key, payload hash, and expected record versions. Same key plus same payload returns the original result; different payload fails. Preserve command receipts for financial record retention. Actor comes from authenticated session/worker. Distinguish permission, stale-edit, locked-period, duplicate, evidence, and validation errors.

Lock order: affected periods in date order, then financial records in stable ID order. Posting and close lock the same period rows; missing period creation is atomic. Concurrent imports, approvals, matches, and payment allocations cannot over-apply records. Internal workers get only the operations they need. No general API product or AI proposal engine is required.

## 5. Logical data model

Use `acct_` tables in the existing database schema, not a schema named `acct_`. No `ledger_id`. UUIDs; mutable rows have versions/timestamps; immutable rows have creation metadata. Financial FKs restrict deletion. JSON holds raw payloads/snapshots, not the only representation of enforceable relationships. Small lookups may be consolidated if constraints/history remain intact.

### 5.1 Books and provenance

| Tables | Required contents |
| --- | --- |
| `acct_settings` | Singleton legal name, current S-corp classification, USD, fiscal year, timezone, earliest history date, authority mode/date, transfer window, monotonic financial revision, operational settings |
| `acct_accounts` | Unique optional code, name, type/subtype, normal side supporting contra accounts, parent, currency, system purpose, archive state |
| `acct_journal_entries`, `acct_journal_lines` | Date/memo/state, economic entry kind, primary origin, approval/import metadata; exact signed lines, account, payee, customer/project/business-line, tax-treatment ref |
| `acct_entry_corrections` | Original/reversal/replacement, reason/date/actor; one effective full reversal per original |
| `acct_import_batches`, `acct_import_items` | Source hashes/scope, parser/mapping versions, staged groups, matches, exceptions, approval, control totals, applied IDs/checkpoints |
| `acct_source_records` | Immutable source system/scope/external ID/revision/hash, raw payload, original date, observed time, batch |
| `acct_source_links` | Audited links to concrete entry/line/movement/invoice/document IDs, transformation role/version; validated exclusive target FKs |

Origin is provenance, not the economic identity. A Wave entry subsequently observed by SimpleFIN has evidence from both. Source record uniqueness uses the provider's documented scope. Accounts can be renamed with audit; financial types cannot be silently reclassified after use. Report grouping changes are versioned. Enforce one parent level and no cycles.

### 5.2 Banking and documents

| Tables | Required contents |
| --- | --- |
| `acct_bank_connections` | Provider, encrypted credential/key version, enabled state, lease, attempt/success timestamps, sanitized errors |
| `acct_bank_accounts`, `acct_bank_source_accounts` | Stable company account to ledger account, institution/currency/coverage; separate connection/provider IDs supporting reconnection |
| `acct_bank_transactions` | Canonical bank movement with dates, normalized sign/amount, description, processing version; raw evidence separate |
| `acct_bank_matches` | Movement to bank-side journal-line allocations, amount, status/version, actor; bounded on both sides |
| `acct_bank_balance_observations` | Booked/available balances, timestamp, source/sign/currency, sync batch |
| `acct_documents`, `acct_document_links` | Private object, name/MIME/size/hash, source/availability/inbox state; links to entries/lines/invoices/payroll/assets/imports/statements |
| `acct_payees`, `acct_payee_aliases` | Name/default account, contractor/tax classification/documentation, optional encrypted tax ID, notes; exact/prefix aliases with conflict handling |
| `acct_customers`, `acct_projects`, `acct_business_lines` | Local IDs, typed external refs/display history, optional dimensions, archived state |
| `acct_rules`, `acct_rule_versions`, `acct_saved_views` | Typed matching/actions, priority, approval/auto-post bounds, version history; validated filters/report configs |

### 5.3 Subledgers and close

| Tables | Required contents |
| --- | --- |
| `acct_invoices`, `acct_invoice_revisions` | External identity, issue/due date, customer/project, currency, source lifecycle/revision, immutable financial/line snapshots |
| `acct_invoice_allocations`, `acct_invoice_adjustments` | Invoice line/revision, settlement entry/line, gross/cash/fee amounts, effective date, reversal; dated credit/write-off/cancellation evidence |
| `acct_external_inbox` | Received invoice events, verified source/version, processing/retry/error state; immutable payload |
| `acct_transfer_groups`, `acct_clearing_allocations` | Linked dated entries/movements; obligation debit/credit allocations, residuals, reversals |
| `acct_payroll_runs` | Patriot identity/register inputs, pay date, journal, officer detail, deductions/liabilities, documents |
| `acct_fixed_assets`, `acct_loans` | Manual register records and links specified in section 12 |
| `acct_cash_flow_allocations` | Cash-side line, signed classified amount, operating/investing/financing/internal-transfer class, supporting obligation |
| `acct_reconciliations`, `acct_reconciliation_items` | Statement range/balances/document, version, exact cleared bank-side lines, proof, completion actor/time |
| `acct_periods`, `acct_fiscal_years` | Lock history, verified historical tax classification, filed-package reference, controlled restatement history |

### 5.4 Reports, tax, audit

| Tables | Required contents |
| --- | --- |
| `acct_report_snapshots` | Parameters, exact totals/rows, data/report/mapping versions, coverage/warnings, exported documents |
| `acct_tax_mappings`, `acct_tax_adjustments` | Year/version, stable tax concepts, deductible treatment, source refs, reviewed manual adjustments |
| `acct_tax_links`, `acct_tax_snapshots` | Existing estimator target IDs, range/revision, projection assumptions, inputs/results/refresh state |
| `acct_command_receipts`, `acct_audit_log` | Idempotent financial outcomes and append-only redacted audit; audit trigger excludes itself |

Do not create deferred AI tables or generic integration infrastructure to anticipate future features.

## 6. Chart and retained earnings

Map and preserve the existing Wave chart rather than force all history into new defaults. Preserve original account names/codes in source mappings. Any merge needs a preview. Personal Expenses categories are not assumed to map one-to-one.

| Group | Defaults for new books/activity |
| --- | --- |
| Assets | Checking, Savings, Transfers in Transit, Undeposited Funds, Equipment, Accumulated Depreciation, Due from Shareholder |
| Liabilities | Business Card, Net Salary Payable, Payroll Taxes Payable, Other Payroll Deductions, Retirement Contributions Payable, Customer Funds Pending Classification, Loans, Loan from Shareholder, Due to Shareholder |
| Equity | Shareholder Capital, Contributions, Distributions, Opening Balance Equity, Opening Retained Earnings |
| Income | Consulting, Retainers, Product/SaaS, Affiliate/Referral, Customer Reimbursements, Other, Uncategorized Income |
| Expense | Contractors, Software, Hosting, AI/API, Marketing, Professional Services, Merchant Fees, Bank Fees, Office Supplies, Travel, Meals, Insurance, Officer Compensation, Other Wages, Employer Payroll Taxes, Payroll Fees, Shareholder Health Insurance, Employer Retirement Contributions, Taxes/Licenses, Education, Depreciation, Interest, Documented FX Differences, Other, Uncategorized Expense |

System purposes have stable IDs independent of names. Opening Retained Earnings is postable only by verified historical/opening import or reviewed correction. Report retained earnings equals that balance plus all earlier fiscal years' net income. Current-year net income displays separately. New books do not post annual nominal-account closing entries; normalize historical source closing entries to avoid double counting (section 7).

Customer reimbursement defaults to gross revenue plus the company's related expense when company costs are billed onward. Documented agency/pass-through money uses clearing under an explicit policy. Never infer this merely from the label reimbursement. Personal reporting can exclude reimbursement revenue without changing company books.

## 7. Wave history in the normal ledger

### 7.1 Import experience

Upload available accounting exports, chart data, reports, and receipts. Preview covered years, source totals, account mappings, balanced journal groups, duplicates, and exceptions. Approve a validated batch/year instead of recategorizing each historical transaction. Accepted entries become ordinary posted entries at their original financial dates with current import/approval timestamps.

Wave documents journal/transaction exports and a separate receipt-image export. Inspect real files before implementing their adapter: stable IDs, journal grouping, report basis, and receipt associations are not guaranteed by that documentation. [Wave data exports](https://support.waveapps.com/hc/en-us/articles/4411360860692-Download-your-account-data).

### 7.2 Reconstruction and basis gate

Reconstruct journal groups, not independent bank rows that duplicate transfers or lose splits. Preserve economic dates, exact amounts, mapped accounts, counterparties/dimensions where available, memos, and original grouping. Retain source files, parser/mapping versions, and per-group links explaining normalization.

Determine whether exports contain cash-basis postings, accrual AR/AP, invoice-issue revenue, or annual closing entries. Do not mix policies in the canonical ledger. If conversion is needed, fixture-test an explicit transformation: invoice issuance becomes subledger history, actual supported collections become cash-basis revenue, AP/payments follow their documented cash treatment, and non-economic annual closing rows remain linked evidence of normalization rather than duplicate income/retained earnings. Every economic source transaction must remain represented in ordinary books.

Missing evidence blocks affected batches and identifies the additional report/export required. Never invent balancing counterpart lines, drop economic records, downgrade to an archive-only experience, or label incomplete history complete. Compare with Wave reports on the same basis and explain presentation differences.

### 7.3 Opening and coverage

Prefer full available history from inception. Otherwise use a verified opening trial balance immediately before the earliest supported activity, preferably a fiscal-year boundary. A midyear start requires earlier-year activity for a complete annual report or an explicit partial-year label. A balance sheet cannot supply missing YTD transactions.

Opening balances distinguish assets, liabilities, capital/contributions/distributions, and retained earnings. Resolve Opening Balance Equity suspense before baseline acceptance. Do not duplicate existing source opening entries. Import open invoices, outstanding checks/deposits, and clearing obligations alongside the opening control balances.

A full historical ledger continues through cutover: no second January 1 opening entry is added on top. Book history does not itself prove shareholder tax basis; import supporting tax worksheets separately.

### 7.4 Reimports and source changes

Provider IDs are scoped to the Wave business and record type. Exact file hashes make identical uploads no-ops. Where stable IDs are absent, use normalized journal-group fingerprints, preserved multiplicity, and batch mapping. Reordered rows must not create new activity; genuine identical purchases remain distinct. Ambiguous identity needs review.

Later export comparison: unchanged records attach evidence; new records stage; changed records show a correction preview. A missing row is not a deletion unless the export's scope/completeness proves it. No source may overwrite a posted entry or locked year. Posted corrections use the same review/reversal rules as manual corrections.

Large imports can commit bounded chunks, each group atomic with a durable replay receipt. Until the full scope passes totals, mark coverage `import_in_progress`, block closing/official exports for it, and show status. Retry resumes without duplication. Cancellation preserves applied rows and a remaining-work report; removing posted imports requires a correction plan.

### 7.5 Acceptance and historical locks

| Check | Gate |
| --- | --- |
| Source | Every economic group accounted for; rejected/transformed groups explained |
| Books | Balanced entries, verified bank/card balances, trial balance, equity rollforward |
| Reports | Annual/monthly P&L and year-end balance sheets tied to same-basis Wave reports or reviewed mapping explanations |
| Open items | Receivables, clearing balances, outstanding statement movements, historical refunds represented |
| Evidence | Original exports retained, proven receipt links attached, unlinked documents visibly queued |

Lock accepted historical periods. Source reconciliation flags are evidence, not fabricated local statement matches. When detailed statements/items are unavailable, record `historical_baseline_accepted` with parity proof rather than claiming a local completed reconciliation. These remain ordinary posted transactions, searchable and correctable under normal locks.

## 8. Bank feeds, CSV, and overlap

Only company accounts become company ledger accounts. Identify ownership during setup. A personal purchase in a company account needs an appropriate shareholder/receivable classification; excluding it leaves the company balance unexplained. Personal accounts stay outside the company feed in v1; business costs paid personally use a manual reimbursement/contribution entry.

Claim SimpleFIN server-side. Validate provider HTTPS hosts and redirects, reject private-network destinations, encrypt the returned URL under a separate key, and redact credentials. Disconnect stops sync but retains evidence.

Pin a tested protocol version: the current protocol page calls v2 a draft. Handle account identities, sign/date conventions, body-level errors, and incomplete coverage even with HTTP 200. Pending data may appear as a preview but never posts. [SimpleFIN protocol](https://www.simplefin.org/protocol.html).

Daily sync plus Sync now uses a connection lease, bounded retries, successful checkpoints, and overlap. Recover outages from the checkpoint, not only today's last 14 days. Respect verified provider limits/history; use CSV for unavailable gaps. Successful accounts may commit while another fails, but failed coverage never advances. Diagnostics survive rollback. Newly arrived records for locked periods become exceptions, not current-date entries or blockers for every account.

Keep balance observations, booked versus available balances, and timestamps. Test card charge/payment/refund/credit-balance signs and bank overdrafts. No automatic journal plug for mismatches.

Before drafting, resolve the stable bank account and search existing movements/bank-side ledger lines. Proven source identity can link automatically; fuzzy cross-source amount/date/account/description matches are suggestions. A Wave entry later seen by SimpleFIN gains evidence without another posting. Reconnection maps new provider IDs to the existing account without new history/opening balances. Changed source amounts/dates retain previous observations and trigger review.

CSV preview chooses account, header/date/locale/sign mapping and shows sample debits/credits, errors, counts, totals, and duplicate candidates. Journal-import and bank-import modes are distinct. A row-order hash alone cannot deduplicate repeated files. Exclusion requires a reason and addresses an observation, not an unexplained company movement.

## 9. Daily transaction workflow and UX

### 9.1 Navigation and review

Preserve existing navigation. Add one Accounting group: Overview, Transactions, Accounts & Reconcile, Reports, and Manage. Invoices, payees, documents, rules, imports, manual journal, assets/loans, and settings are reachable from contextual links and Manage. Transactions has Review and All transactions views; imported history belongs in All transactions by default.

Overview shows cash in bank, card debt separately, monthly posted profit, review count, receivables due, feed coverage, books-complete-through date, and actionable exceptions. Do not present an estimated tax reserve as a company liability or an automatic distribution recommendation.

Review groups ready items, needs explanation, transfers, invoice matches, duplicate candidates, and import exceptions. Filters include date, account, state, payee, amount, dimension, missing receipt, and source. Source filtering finds entries with any linked evidence from that provider, not only their primary origin. All transaction rows link to stable detail URLs.

The evidence panel contains original bank/source data, current/proposed journal, linked receipts/invoices/payroll, rule used, and audit history. Preserve keyboard focus and selection through edits. Support next/previous, searchable categories, split remainder, saved filters, and bulk previews showing count, totals, affected dates, and rejected items before approval. No invisible selection of off-screen filtered records.

### 9.2 Actions

| Action | Behavior |
| --- | --- |
| Categorize | Choose counter-account/payee, optional dimensions and memo; show prior treatment without auto-rewriting history |
| Split | Multiple counter-lines with exact remaining amount, optional per-line dimensions/tax treatment, stable cent allocation |
| Match existing | Attach imported movement to manual/payment/payroll entry; discard only the redundant draft atomically; posted duplication requires correction |
| Transfer | Link dated sides and transit state as below; one review group for user convenience |
| Invoice receipt | Allocate cash to open invoices/lines; partial payment default, explicit fees/discounts |
| Refund | Link original payment/purchase where possible; reverse appropriate revenue/expense and allocations at supported date |
| Owner activity | Distribution, contribution, shareholder loan, reimbursement due/paid, or personal charge; clear S-corp labels and evidence |
| Exclude | Reasoned duplicate/out-of-scope source observation; do not exclude real company cash/card movement |
| Post | Explicit single/bulk approval after validation; approved historical batch is equivalent approval |
| Correct | Preview original, reversal/replacement, period and report impact; preserve statement history |

Business expense paid personally defaults to a reviewed Due to Shareholder reimbursement entry; contribution is an explicit alternate classification. Repayment clears the payable rather than creating another expense. Personal spending on a company card is recorded to the appropriate shareholder/distribution/receivable account, not company operating expense. Payroll, loans, and distributions are distinct action labels.

### 9.3 Transfers and clearing

Candidate matching requires opposite signed amounts and different supported accounts, then scores dates, descriptions, and previously approved patterns. Default window five days is configurable. Same-date interbank transfers may use one two-bank-line entry. Different dates require two entries through Transfers in Transit, preserving each bank posting date. One group collapses them in the UI. Stale transit over fourteen days is actionable, with configurable exceptions.

Credit card payment clears card liability, not an expense. Its bank/card posting dates may differ and use an appropriate payment-in-transit clearing path. A transfer rule cannot silently match an ambiguous counterpart. Removing/changing a posted match follows correction and reconciliation invalidation rules.

Payroll and other liabilities have an obligation view: originating credits, allocated settlements, and residual balance. Aggregate zero alone is not sufficient if wrong obligations were matched. Amounts cannot be allocated twice; corrections reverse allocations with their journal.

### 9.4 Rules, templates, documents

Rules match explicit normalized payee/description/account/direction/amount conditions in stable priority order. A single winning categorization rule applies unless an explicitly composed action template is configured. Conflicts are visible. Preview matches and exceptions over history before activation; retroactive changes are opt-in with a financial preview.

Rules initially fill drafts. Automatic posting is disabled during history import/pilot and can be enabled per tested rule after owner approval, with account/amount bounds, unique-match requirements, and exact rule-version audit. Enabling a rule is separate from saving a suggestion. Duplicate/locked-period/ambiguous items can never auto-post. No LLM is involved.

Support Copy as draft and saved journal/split templates. Copying does not copy reconciliation state, source identity, invoice allocations, or a prior posting's approval. Payroll template amounts are validated against the actual current register, not trusted solely because salary was unchanged last month.

Document inbox supports drag/drop and mobile file/camera upload before or after bank import. Store receipts, statements, payroll registers, and source reports; attach during review. Hashes identify repeated uploads without deleting legitimate evidence links. Missing receipt filters and payee pages show evidence gaps. No OCR required.

Mobile prioritizes receipt capture and one-item review. Desktop supports wide statements/registers. Use existing light/dark themes, accessible labels/focus, non-color state indicators, masked amounts, and unsaved-change protection. Future visual checks follow the Playwright screenshots skill and `.playwright/` rules.

## 10. Invoice feed and receivables

### 10.1 Source lifecycle

Invoice creation/editing remains in `app`; accounting owns booked settlement allocations. Keep source status and settlement status separate. New CRM invoices marked paid mean payment expected/claimed until supported by books. An accounting allocation does not automatically rewrite the CRM in v1; show mismatch and a link to the invoice. Automatic paid-status write-back is deferred.

Extend the source to cover issued/unpaid invoices, relevant amendments, payment claims, cancellations, deletions, and drafts. Draft invoices do not count as receivables. Mirror stable customer/project IDs separately and preserve revisions/display names. New drafts becoming issued create receivables; partial settlement is derived from allocations, not a source paid flag.

Bootstrap from a paginated consistent snapshot containing relevant invoices and tombstones. Process signed events through a durable inbox with schema/signature/size validation and atomic per-invoice revision checks. Preserve the existing personal-income receiver path so deploying accounting does not stop current income updates or duplicate them.

Implement bounded delivery retries plus periodic authoritative reconciliation pull. Do not assume SQL sequence allocation is commit order. For this small installation, a complete nightly invoice snapshot/diff with tombstones and per-invoice monotonic versions is the initial correctness backstop; use a snapshot token for paging. Events provide timeliness. Invoice updates during a snapshot are caught by version checks/events or the following complete scan. Bootstrap remains provisional until snapshot plus catch-up converge. A missed event must eventually self-heal without depending on manual resend.

### 10.2 Payment rules

| Case | Required result |
| --- | --- |
| $2,000 against $5,000 invoice | $2,000 collected, $3,000 outstanding; no invented fee |
| Documented $100 fee on $5,000 receipt | $4,900 bank, $100 fee, $5,000 revenue/applied; explicit evidence and approval |
| Several invoices/one deposit | Allocate gross collections per invoice/line; allocate fees once, exact totals |
| Several deposits/one invoice | Remaining balance reflects each dated allocation; cannot exceed supported outstanding amount |
| Overpayment/unidentified receipt | Explicit unresolved customer funds state; require reviewed deposit/revenue/liability policy before close/tax export |
| Returned ACH/refund | Dated journal correction/refund and allocation reversal, outstanding amount updated, original evidence retained |
| Discount/write-off/cancellation | Dated subledger event and correct cash-book impact; cash-basis write-off of never-recognized income does not invent bad-debt expense |
| Source invoice amended after settlement | Preserve settled revision; queue discrepancy/credit or correction, never rewrite posted revenue |

Allocate partial receipts to selected line types or a displayed proportional proposal using exact rounding. Match gross applied, fees, and actual cash explicitly. Historical Wave receipts already in the ledger are linked to imported/CRM invoices without posting revenue again. Never match old invoices merely by invoice number without source/customer/amount/date confirmation.

Historical aging uses dated invoice revisions, allocations, credits, write-offs, and reversals. Current state alone cannot reconstruct an earlier month. Mark coverage gaps where original issue/settlement history is unavailable rather than fabricate past aging.

## 11. Patriot payroll and owner records

Patriot remains the payroll/tax-remittance authority. Import or enter one payroll register per run with stable provider ID, pay date, supporting file, and verified inputs. Template covers gross wages, officer portion, employer taxes, net pay, employee tax withholding, retirement deferrals, other deductions, reimbursements, and noncash benefits when present.

Post explicit wages/employer expense and liability lines; bank net-pay and deposit debits clear those liabilities. Patriot service fees are separate expenses. Gross minus net is not assumed to equal tax withholding. Unsupported register components stop approval until mapped. Retirement liabilities and reimbursements are distinct from tax liabilities. Preserve a simple current-run form while allowing the actual register's components.

Show run-level open obligations, matched disbursements, expected settlement dates, and aging. A legitimately not-yet-due quarterly/annual obligation is not a stale error just because a pay cycle passed. Reuse an existing Wave payroll journal when importing provider evidence rather than post it again.

Officer wage and personal W-2 taxable wage figures are separate measures where benefits/deferrals differ. Use verified provider data for W-2 estimate inputs and document year-to-date coverage. Shareholder health-insurance payment, corporate expense, payroll inclusion, and personal deduction must link without duplicate expense/deduction. Salary/distribution comparison is descriptive, not a reasonable-compensation test. [IRS S corporation compensation guidance](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues).

## 12. Assets, loans, contractor and year-end support

### 12.1 Manual registers

Assets store acquisition/in-service dates, cost, asset and accumulated-depreciation accounts, purchase entry, depreciation/disposal entries, method/source schedule, and documents. Annual depreciation and disposal use reviewed templates. A threshold can suggest review for capitalization, but price alone does not authorize a tax election or deduction. No automatic depreciation engine.

Loans store lender, liability account, principal, terms, source schedule, and linked principal/interest payments. Imported schedules propose splits; actual lender statement and balance remain the evidence. Do not compute an unexplained interest amount to force agreement. No loan is required to finish v1 if none exists; the manual register/template must work on fixtures.

### 12.2 Contractor worksheet

Track payee tax classification, documentation status, payment rail, service/payment character, reportability decision, and exceptions. Worksheet reconciles gross paid and excluded amounts with reasons, rather than simply adding all contractor P&L expenses. Preserve underlying transactions and applicable tax-year rules. Missing documentation is visible; collecting raw TINs is optional, encrypted, and not needed merely to list payees.

Payment cards and qualifying third-party-network payments have different reporting responsibility. Foreign status alone is not a complete decision; service location and payment character can create other reporting needs. Filing remains external. [IRS 1099 instructions](https://www.irs.gov/instructions/i1099mec), [IRS personal-services guidance](https://www.irs.gov/individuals/international-taxpayers/pay-for-personal-services-performed).

### 12.3 Return support

Export a books support package: TB, GL, P&L, balance sheet, cash movement report, account mappings, owner activity, officer/payroll reconciliation, contractor worksheet, asset schedule, and explicit tax adjustments. Do not label it a completed 1120-S or imply Schedule M-2 equals book equity.

Stock/debt basis uses imported/manual supported worksheets with year/version/source; automatic calculation is deferred. Track missing opening basis and unresolved limitations before using losses/distribution tax consequences. [IRS Form 7203](https://www.irs.gov/instructions/i7203), [IRS Form 1120-S instructions](https://www.irs.gov/instructions/i1120s).

## 13. Statement reconciliation and period close

### 13.1 Statement workflow

Statement range is independent of calendar month. Store statement document, start/end dates, signed opening/ending balances, predecessor reconciliation, cleared ledger bank-line amounts, and completion proof. Normalize card/bank signs once. Partial line clearing is permitted only through explicit bounded allocations; no amount can clear twice across active statements.

Match statement items, not just a final net balance. Carry outstanding checks/deposits and prior uncleared items forward. Formula: normalized statement opening balance plus selected cleared movements equals normalized ending balance. Separately bridge book balance at cutoff to statement balance using identified outstanding items; both proofs must agree. The UI explains timing differences without manufacturing entries.

Allow saving unfinished work with notes. Completed requires zero unexplained difference, all statement items explained, approved posted entries for cleared amounts, and no unresolved duplicates affecting the statement. Notes cannot override a nonzero difference. Never auto-create a balancing plug or post drafts on completion. Provider balance suggestions are labelled observations; the actual statement is authoritative for reconciliation.

Changes affecting completed reconciliations invalidate/supersede the relevant version and block a new close until revalidated. Preserve the old statement proof. Attaching a receipt does not invalidate amounts. Closed/archived bank accounts remain available for historical reporting without requiring statements forever after closure.

### 13.2 Close checklist

| Requirement | Gate |
| --- | --- |
| Coverage | Required account feeds/imports complete; relevant statement coverage and cutoff bridges documented |
| Review | No incomplete financial drafts, unresolved duplicate/posting conflicts, or unexplained cash/card activity in period |
| Clearing | Transfers/payroll/customer suspense explained; legitimate outstanding obligations carry evidence and expected resolution |
| Reports | Posted TB and balance sheet proof valid; uncategorized/suspense items resolved or explicitly reported as blocking exceptions |
| Snapshot | Save close reports, mapping/version, reconciliation references, lock actor/time |

All relevant bank accounts must have completed statement reconciliation covering the period or a documented statement-cycle bridge from the latest completed statement. A note does not substitute for unreconciled movements. Do not require a card statement ending on the calendar month's last day. Default close remains blocked if coverage cannot be demonstrated.

Locking posts nothing. Reopen unfiled periods requires reason, preview of affected reports/statements, and audit. Record previously supplied exports as superseded where affected.

### 13.3 Year end and filed years

No annual closing journal in new activity. Carry balances continuously; report earlier income/expense history through computed retained earnings plus verified opening retained earnings. Save the filed package and filing date separately from the lock.

Filed-year correction requires a dedicated owner-reviewed restatement workflow: preserve the originally filed snapshot, document the proposed financial date and supporting correction, open a controlled adjustment window, create correction entries, revalidate reports, and relock as a new version. Track whether an external amended return review is needed; do not automatically amend or assume every discovered error belongs in current-year P&L. Ordinary reopen cannot bypass this workflow.

## 14. Reports and data access

Financial aggregation happens in SQL over the canonical ledger or explicit subledger; UI charts format results. Report inputs include range/as-of date, posted versus working mode, filters, comparison period, and monthly grouping. Results include exact cents, currency, accounting basis, covered dates, unreviewed counts, feed freshness, reconciled-through status, and report/data/mapping versions.

Increment the financial revision transactionally when a command changes report-relevant financial data. Generate multi-part reports and exports against one consistent database snapshot and record that revision; independent requests reading different moments cannot be labelled one report. Source freshness and document metadata can have separate revisions without changing historical amounts.

| Report | Definition and behavior |
| --- | --- |
| P&L | Posted income/expenses in range, grouped by account/parent, net income, monthly and prior-period comparisons |
| Balance sheet | Assets/liabilities/equity as of date, verified opening retained earnings plus prior net income and current net income, identity asserted |
| Trial balance | Opening balances, range debits/credits, ending balances; full-ledger totals agree |
| GL/account register | Original entries and corrections, chronological stable running balance, filters, source evidence, drill-down |
| Cash Flow: Bank cash movements | Opening bank/cash balance to closing; classified actual cash movements, internal/transit movement shown separately; card liability is not cash |
| Receivables/aging | Dated subledger revisions/allocations, outstanding amounts by due date as of selected date |
| Income by customer/project/business line | Collected recognized revenue with directly attributed costs shown separately; unallocated costs remain visible |
| Expenses by vendor/category | Exact posted expense totals, optional dimensions, comparison periods |
| Owner/payroll | Contributions, distributions, shareholder balances, wages/employer taxes/benefits, payroll clearing proof |
| Contractor/year-end | Reviewed payment worksheet and support package from section 12 |

Cash movements are a clearly labelled operational report, not a claim of a fully standards-compliant statement of cash flows. Card purchases do not move bank cash; their later payment does. Use cash-line allocations for operating/investing/financing classifications, carrying documented obligation classifications through card/payroll settlements. Unallocated classifications are visible and block a claim of fully classified cash flow. Interbank transfers cancel when both sides are inside the range; cross-boundary transit appears explicitly so the opening/closing bank cash bridge still agrees. Bank availability and card debt have separate dashboard values.

Every report number drills into contributing lines with the same filters/basis. Optional project/client/business-line tags are separate from GL accounts. A spending or margin view must label missing/unallocated dimensions and does not claim full project profitability without overhead attribution. Saved views store validated parameters, never arbitrary SQL.

CSV exports use documented columns and exact decimal conversion; PDF matches the displayed report. Full JSON export is versioned and contains accounts, journal lines, dimensions, source mappings, invoices/allocations, audit/corrections, coverage, and document manifests. Include an attachment bundle and checksums. Exclude secrets. A generic GL CSV is portable data, not a promise of direct import into every competitor.

On closed/filing reports retain both rendered data and definition versions. Account rename/report-group/tax-mapping changes cannot silently rewrite an already supplied snapshot. Source origin never changes report arithmetic. A partially imported scope is explicitly unavailable for official reporting.

## 15. Automatic inputs and projections for the Tax Estimator

### 15.1 Integration, not a second tax engine

Reuse `calculateFullTax` and existing tax-year configuration. Its S-corp templates already separate Officer Salary and Business Profit. Add an explicit link for the business component of a chosen year's existing estimate. Preserve other wages, spouse/other income, capital gains, deductions, credits, and manual payment entries.

Versioned tax mappings identify stable tax concepts, deductible treatment, separately stated amounts, and book-to-tax adjustments. Do not drive calculation from a free-text `tax_line_hint`. Meals and travel are distinct; custom account mappings require review. Actual net business profit is adjusted once; never subtract its expenses again or add distributions as another copy of profit.

The books supply supported business inputs, not every fact for the personal return. Estimated tax depends on other income, payments, deductions, credits, and annual expectations. Missing inputs and unsupported loss/basis limitations remain visible. [IRS estimated-tax guidance](https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes).

### 15.2 Actuals, projection, and payment target

| Value | Rule |
| --- | --- |
| Recorded YTD | Posted mapped amounts through chosen cutoff; display reviewed/reconciled coverage and missing accounts |
| Remaining-year projection | Owner selects manual forecast, average of selected complete months, or supported prior-year monthly pattern; show period and one-off exclusions |
| Estimated annual liability | Existing calculator with linked and personal inputs plus documented adjustments; label unsupported/incomplete cases |
| Already paid | Verified taxpayer/jurisdiction withholding and estimated payments, with source/date links; corporate payroll tax deposits are not automatically personal income-tax payments |
| Remaining target/reserve | Separate projected annual shortfall from a supported installment/safe-harbor target; display assumptions and payment dates |

Default to recorded actuals plus an explicitly chosen forecast; no silent annualization. Do not average an incomplete month as zero or hide negative profit. Payroll taxable-wage/withholding projection uses verified Patriot data when available, otherwise the existing manual inputs remain. Projected future withholding and actual paid-to-date are separate.

Never compute an installment recommendation by blindly dividing remaining annual tax by remaining quarters. Add a jurisdiction/year-specific payment schedule and validated target calculation when supported. Federal prior-year safe-harbor data and higher-income treatment require explicit inputs; state rules are separate. If a schedule method is unsupported, show annual forecast and a manual payment target instead of a fabricated recommendation. Formal annualized-income installment calculations are deferred until independently specified/tested.

Recalculate linked estimates when approved postings, relevant mappings/adjustments, or verified payroll/payment facts change. Use durable revision-based invalidation: refresh on opening an estimate and in a scheduled reconciliation pass so a missed background job does not leave silent stale data. Show last refresh, source period, changes since prior snapshot, and errors. Save input/output/assumption versions for comparison.

Exact cents cross into the existing number-based estimator only through one tested, bounded conversion layer. No money rounding is spread through UI code. Reuse and extend `admin/scripts/verify-tax.ts`; linking does not by itself certify every existing calculation.

## 16. Personal finance pages remain independent

Keep all existing routes and manual records. Do not automatically retarget invoice events away from personal Income during the parallel run. Company history import does not create years of duplicate personal income entries.

Tax linking ships first. General Income/Expenses/Net Worth linking is a later integration step after the books are reliable, and is not required to replace Wave. Its contract is fixed now: each opted-in value has a source, account/dimension mapping, period, data revision, freshness, and a target identity. Refresh updates that linked value, never unrelated manual records. Manual adjustments are separate rows/fields. Disconnect preserves an explicit snapshot and history.

Income must label whether it shows revenue, profit, wages, or distributions. Expenses can compare actual selected business spending against the existing recurring-cost baseline. Net Worth links are only to explicitly selected ownership values/accounts and must not count company cash again inside the same business equity value. No cross-page amount is linked merely because two categories share a name.

If linking replaces a current invoice-derived personal source, provide a preview, effective date, and deduplication/migration of that target source; never run both contributors into the same total. Existing expense baseline entries are not historical bank transactions and are not imported into the company ledger.

## 17. Permissions, evidence, and future integration

Owner-only v1 uses an explicit authorized owner identity, not any authenticated account. Public signups or demo credentials cannot access books. No multi-user role UI required. Background workers may stage/import or run approved deterministic operations; financial posting authority remains controlled. Export is owner-only.

Restrict table grants and execute privileges; financial writes go through audited DB functions and triggers. Supabase service-role credentials bypass RLS, so deny policies alone do not enforce immutability. Privileged functions have fixed search paths, explicit actor authorization, bounded inputs, and revoked public execute. Protect views as well as tables. Never expose service credentials to browser/AI. [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).

Audit includes human/worker identity, operation/batch ID, time, before/after and reason, but excludes secrets/raw TINs and avoids auditing itself recursively. Credentials remain under independent versioned encryption keys. Database administrators remain an operational trust boundary; triggers do not claim protection against an administrator disabling them.

Documents use private storage and owner-authorized expiring download URLs. Validate file size/type/content, escape displayed provider text, and prevent executable uploads from being served as trusted HTML. Sensitive payroll/tax documents are not part of generic future AI context by default. Raw source descriptions are evidence, never instructions that grant permission.

Future AI/API adapters can call the same internal reads/commands under separately designed scopes. Stable IDs, provenance, report metadata, idempotency, and exact transport values are enough preparation now. Do not build arbitrary SQL execution, agent proposal storage, API key screens, or broad permissions as part of this release.

## 18. Backup, recovery, and operations

Back up database records and actual document objects independently. Supabase database backups contain Storage metadata, not the stored receipt files. Verify current PITR availability/configuration rather than assume it is enabled. [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups).

Default operational target: no more than 24 hours of unrecoverable changes with daily off-platform backups, and restore within one business day. Improve the data-loss window with PITR where enabled. Define an encrypted recovery package for keys/role setup outside the live database. Backup scope includes `acct_` tables plus required functions, triggers, roles/grants, migration version, dependencies, documents and manifests. It is not a dump of a nonexistent `acct_` schema.

Retain daily off-platform backups for 90 days and monthly snapshots indefinitely unless the owner chooses another policy; source accounting documents and audit have no automatic deletion in v1. Storage costs and retention owner are deployment inputs. Test a clean-environment restore before real-book acceptance, after material backup changes, and at least annually. Verify sign-in, document download, report totals, decryption/relink path, and idempotent sync resumption, not just database restore success.

Use a separate staging Supabase project with synthetic or deliberately sanitized fixtures; no production data in public demo. Accounting UI is feature-flagged until ready. No worker runs against live banks during demo/testing. Source credentials are server-only; schedule endpoints authenticate their invoker.

Daily integrity checks cover posted balance, orphan/over-allocated links, invalid mutations after lock, completed-statement proofs, overdue import/backup jobs, coverage gaps, stale clearing obligations, and source/bank mismatches at comparable cutoffs. Existing valid entries in locked periods and historical lines pointing to archived accounts are not errors.

Dashboard shows actionable issues. Optional owner-enabled weekly digest summarizes unresolved items; urgent integrity/backup failures use the configured operational alert path. Deduplicate notifications until state changes. Unknown/missing bank observations never appear as zero balances. Maintenance includes adapter/report/security changes as needed; do not claim the accounting layer will never need maintenance.

## 19. Parallel use of Wave and transition

### 19.1 Authority modes

| Mode | Rules |
| --- | --- |
| Historical baseline | Import and verify all supported years; Wave is the comparison authority while exceptions are resolved |
| Parallel pilot | Wave remains authoritative for agreed periods; admin receives normal ledger entries and independent bank evidence; disagreements are reviewed |
| Admin primary | Owner selects effective date after acceptance; admin is authoritative for new activity; Wave remains accessible as long as desired |

Record the mode, effective date, account coverage, and historical verification in settings. Keeping Wave paid is independent of authority. No automatic two-way sync is promised. During pilot, new Wave exports reconcile to existing admin entries without duplicating SimpleFIN/manual postings. Post-cutover Wave changes still appear as import differences, never silently override admin.

### 19.2 Acceptance before selecting admin primary

1. Available historical scope is imported into ordinary books and yearly/bank control totals are verified; remaining limitations are explicit and do not prevent required reporting.
2. At least three consecutive monthly closes on the actual account set tie against Wave and statements, including real payroll and invoice collections. Extend the pilot when material discrepancies remain.
3. Repeat imports, overlapping sources, missed invoice events, corrections, and a complete restore have been demonstrated without duplication or data loss.
4. Core reports, tax input links, document retrieval, and exports work on the actual data; the owner can perform the normal bookkeeping workflow.
5. Owner records the primary-system date. Wave cancellation is a separate later decision and is never an implementation gate or automated action.

Starting near year end does not shorten these gates. Open invoices may legitimately remain unpaid; the gate is complete/explained payments and outstanding balances, not every invoice being settled.

## 20. Acceptance scenarios

These scenarios require persisted commands, reports, and correction behavior, not tests that merely repeat an implementation formula. Exact fixtures and test commands are established in the first build packet.

### 20.1 History and imports

| Scenario | Expected result |
| --- | --- |
| Multi-year Wave fixture with split, transfer, refund, opening equity and payroll | Ordinary posted entries, source trace, annual/bank controls correct |
| Reimport identical or reordered export | No duplicate financial activity, preserved genuine identical purchases |
| Wave and SimpleFIN overlap | One economic movement, both evidence sources visible |
| Wave source entry changes/disappears | Versioned difference review; no silent posted mutation/deletion |
| Accrual/closing rows in Wave export | Explicit tested normalization or blocked batch with required evidence; no mixed-basis report |
| Partial chunk failure/retry/cancel | Applied groups remain known, retries exactly once, incomplete coverage blocks official use |
| Reconnection, long outage, late locked-period transaction | Stable identity, recoverable coverage, explicit exception |

### 20.2 Ledger and settlement

| Scenario | Expected result |
| --- | --- |
| Attempt INSERT/UPDATE/DELETE/reparent on posted lines | Rejected under all ordinary application/worker principals |
| Same command retried after timeout | Existing result returned; different payload with same key rejected |
| Concurrent post/close or two matches | One valid serialized outcome, no bypass or over-allocation |
| Transfer Sept 30 / Oct 2 | Own dates retained, transit explained, each statement/report ties |
| Card purchase followed by payment | One expense/asset event, one liability settlement; cash only moves on payment |
| $5,000 invoice / $2,000 receipt, documented fee, overpayment | Correct residual/allocation; no inferred fees or unchecked tax classification |
| Returned ACH and amended paid invoice | Dated allocation correction and discrepancy workflow, original history preserved |
| Business cost paid personally and reimbursement | Expense once; repayment clears shareholder payable |
| Payroll with deferral/benefit and multiple debits | Correct expense/liability/wage measures, run-level clearing |

### 20.3 Reports, close, integration

| Scenario | Expected result |
| --- | --- |
| Missing equal deposit/withdrawal | Net balance does not falsely complete statement reconciliation |
| Credit card statement spans months | Statement reconciliation and calendar lock work with proven cutoff bridge |
| Draft remains at close | Close blocks; no auto-post |
| Late receipt attached to locked entry | Evidence added without changing amounts or reopening books |
| Filed-year correction | Original filed snapshot retained, controlled restatement and relock |
| Earlier-year retained earnings and continuous cutover | Correct equity; no duplicate January opening balance |
| Historical aging after later payment/write-off | As-of amounts use dated subledger history |
| Rename account/change report mapping | New display supported; saved close/export unchanged |
| Tax link refresh and manual personal entries | Business updates once, personal inputs preserved, actual/projection distinguished |
| Unsupported payment schedule/loss basis | Explicit missing support, no invented tax target |
| Legacy invoice income plus new accounting | Existing personal behavior maintained, no duplicate target contributions |
| Owner/demo/worker permission boundaries | Unauthorized reads/postings rejected; no secrets in exports/logs |
| Complete off-platform restore | Reports tie, documents open, keys recover/relink, imports resume once |

## 21. Inputs needed at implementation gates

These do not block starting the foundation or synthetic fixtures. They block only the relevant live-data acceptance step. Defaults above govern routine implementation choices.

| Input | Needed before |
| --- | --- |
| Actual Wave export samples, chart, cash-basis reports and earliest available history | Finalizing history adapter and accepting baseline |
| Bank/card institutions, account ownership, statement samples and SimpleFIN setup | Live bank adapter/sign/coverage validation |
| Actual Patriot register, benefit/retirement components and payment pattern | Accepting payroll mapping and linked wage/withholding inputs |
| Open invoice/customer history and any legacy Wave invoice IDs | Receivables bootstrap and historical payment matching |
| Owner identity, staging/production project selection, backup destination/key custodian, PITR status | Production activation and recovery acceptance |
| Prior-year return/payment data and manual tax facts | Supported payment targets and complete tax estimate inputs |
| Desired Wave-primary/admin-primary dates | Transition settings; no forced cancellation date |

Unknowns are recorded as specific adapter/configuration gates. Do not claim the entire build is blocked merely because live samples are not yet supplied. Do not claim a gate passed without its evidence.
