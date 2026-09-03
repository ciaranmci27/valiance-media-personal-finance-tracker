# Accounting Module Specification

Status: DRAFT for discussion (2026-09-02). Nothing here is built.

Goal: replace Wave Accounting for Valiance Media with an accounting section inside `admin`. Small-business scope, cash basis, single entity, with the data model shaped so that later features (receivables reporting, a second entity, AI-driven categorization, automated tax liability) are additive rather than migrations.

Not a goal: a QuickBooks clone. Every feature below earns its place by being something Wave does today that we actually use, or by being a structural decision that is cheap now and expensive later.

---

## 1. Scope

### In scope (needed to switch off Wave)

- Chart of accounts with a seeded default for a consulting LLC
- Double-entry general ledger with append-only posted entries
- Bank and credit card transaction import via SimpleFIN
- Transaction review queue: categorize, split, match transfers, attach receipts
- Categorization rules (payee match) with AI suggestions as a later layer
- Manual journal entries
- Receivables as a cash-basis subledger fed by `app` invoices, with payment matching
- Vendors / payees, including contractor tagging for 1099 totals
- Monthly bank reconciliation and period locking
- Reports: P&L, Balance Sheet, Cash Flow, Trial Balance, General Ledger, Account Register, Aged Receivables, Income by Customer, Expenses by Vendor, 1099 Contractor Summary
- Year-end: computed retained earnings, no closing entries
- Opening balances and cutover from Wave
- Data export (CSV per report, full JSON dump)
- Read-only query surface for AI and the tax estimator

### Explicitly out of scope

- Payroll (abandoned module stays flagged off; wages come from the external payroll provider as imported bank transactions)
- Payment processing (Stripe et al.), invoice UI (owned by `app`), estimates, products, inventory
- Multi-currency with FX gain/loss and revaluation (see section 3.4)
- Accrual-basis reporting toggle (see section 6)
- Bills / accounts payable subledger (vendors yes, bills no, revisit if we ever carry unpaid bills across a month end)
- Sales tax collection and filing (services are not taxable in our situation; chart still has a liability account slot)
- Budgets, forecasting, multi-user roles beyond the single admin login
- Receipt OCR (attachments yes, extraction later)

---

## 2. Invariants (the rules that make "we are fucked" impossible)

1. **Every posted journal entry balances.** Sum of debits equals sum of credits, enforced by a deferred constraint trigger, not application code.
2. **Posted lines are never updated or deleted.** Trigger raises on UPDATE or DELETE of a posted `journal_lines` row and on changing a posted entry's date, ledger, or status. Applies to the service role too. Corrections are reversing entries linked to the original.
3. **Money is integer cents (`bigint`).** No `numeric`, no JS `number` arithmetic on amounts outside a formatter. Percentages and rates may be numeric; amounts never.
4. **Raw bank data is evidence and is immutable.** `bank_transactions` rows are insert-only, keyed on provider id, with the full provider JSON stored.
5. **Trial balance is always zero.** Checked after every post and by a scheduled job. A failure is a red banner across the whole app, not a log line.
6. **Locked periods reject writes.** Any entry, draft or posted, dated inside a locked period is refused unless the period is explicitly reopened, and reopening is audited.
7. **Nothing is hard-deleted.** Drafts are soft-deleted. Accounts are archived, never removed, and cannot be archived with a non-zero balance or any posted lines pointing at them without a successor.
8. **Every write is audited.** Actor, timestamp, before and after, on all accounting tables.
9. **Reports are SQL over the ledger.** No report is computed in JavaScript. Every figure on every report is reproducible from `journal_lines` alone.

---

## 3. Domain model

All tables prefixed `acct_` to keep them distinct from the legacy income/expense tables. UUID PKs, `created_at`, `updated_at`, `created_by`. Amounts are `bigint` cents. Dates are `date`, not timestamps, for anything that lands on a report.

### 3.1 Books settings (single set of books, decided 2026-09-02)

One set of books only. There is no `ledger_id` anywhere; any mention of it elsewhere in this document is superseded. `acct_settings` is a singleton row: `entity_type` (s_corp today; the column matches `tax_estimates.tax_classification` so the estimator and the books cannot disagree), `legal_name`, `fiscal_year_start_month` (1), `currency` (USD), `cutover_date`, `de_minimis_threshold_cents` (default from `tax-core` by year), `transfer_match_window_days` (default 5).

Entity type is S corp, which the labels and reports below assume: owner pay is W-2 wages (officer compensation), owner take-home beyond salary is a shareholder distribution, and the equity section tracks shareholder basis.

### 3.2 Chart of accounts

`acct_accounts`:
- `ledger_id`, `code` (optional short numeric code, unique per ledger when set), `name`, `description`
- `type`: asset | liability | equity | income | expense
- `subtype`: constrained per type, e.g. asset: bank, credit_card_is_not_here, accounts_receivable, other_current_asset, fixed_asset; liability: credit_card, accounts_payable, tax_payable, loan, other_liability; equity: owner_equity, owner_draw, owner_contribution, retained_earnings, opening_balance; income: revenue, other_income; expense: operating, cost_of_services, tax, other_expense
- `normal_balance`: debit | credit (derived from type, stored for query convenience)
- `is_system`: true for accounts the app relies on (Uncategorized Income, Uncategorized Expense, Opening Balance Equity, Retained Earnings placeholder, Owner Draw, Owner Contribution, Merchant Fees, Accounts Receivable). System accounts cannot be archived or retyped.
- `cash_flow_class`: operating | investing | financing | null. Used only by the cash flow report. Bank and credit card accounts are the cash pool and have null.
- `tax_line_hint`: optional free text mapping to a Schedule C / 1120-S line, for the tax estimator later
- `parent_id`: one level of nesting allowed for reporting rollups, no deeper
- `is_archived`

Seed a default chart on ledger creation (section 10).

### 3.3 Journal

`acct_journal_entries`:
- `ledger_id`, `entry_date`, `memo`
- `status`: draft | posted | voided
- `source`: bank_import | manual | invoice_payment | opening_balance | reversal | system
- `source_ref`: polymorphic pointer (table + id) to the bank transaction, invoice payment, etc.
- `reverses_entry_id`: set on a reversal, and the original gets `reversed_by_entry_id`
- `posted_at`, `posted_by`, `voided_at`, `voided_by`
- `attachment_count` (denormalized)

`acct_journal_lines`:
- `entry_id`, `account_id`, `amount_cents` (signed: positive = debit, negative = credit, so a balanced entry sums to zero), `line_memo`, `payee_id` (nullable), `customer_ref` (nullable, for income by customer), `sort_order`
- Constraint trigger: on transaction commit, every touched entry with status posted must sum to zero and have at least two lines.

**Draft vs posted.** Import creates draft entries. Drafts are editable and show in the review queue. Drafts are included in reports, flagged, so bank balances always tie to the bank even before review. Posting makes an entry immutable. Posting happens when the user confirms a transaction in the review queue, in bulk when a month is reconciled, or automatically when a period is locked. Corrections to posted entries are reversals plus a new entry. This keeps the immutability guarantee where it matters (reviewed books) without tripling ledger volume for every recategorization during review.

`acct_attachments`: `entry_id`, storage path, filename, mime, size, uploaded_by. Supabase Storage bucket `acct-receipts`, private, signed URLs only.

### 3.4 Currency

Single currency, USD, is fine and is not the problem it sounds like. The situations that look multi-currency are not:
- A foreign client pays a USD invoice by wire: the bank receives USD. Record the USD deposit. Any wire fee is Merchant Fees / Bank Fees.
- A client pays in EUR and the bank converts: the bank deposit is already in USD. Record the USD amount. The gap against the invoice is a fee or FX loss expense line on the payment match (section 6.3). No FX accounting needed.
- A foreign SaaS charges in EUR on the company card: the card statement shows USD. Import records USD.

What single currency cannot do: hold a balance in a non-USD account, or invoice in a non-USD currency and track the receivable in that currency. `app` invoices are USD-hardcoded anyway. If that changes, the ledger needs a currency per account, a rate table, and FX gain/loss accounts. To keep that additive: `currency` column on `acct_accounts` and `acct_bank_accounts` with a CHECK forcing USD for now, and no code that assumes the column is absent.

### 3.5 Banking

`acct_bank_connections`: `ledger_id`, `provider` (simplefin), `access_url_encrypted` (AES-256-GCM via the existing `encryptWith` helper, own env key `SIMPLEFIN_ENCRYPTION_KEY`), `label`, `last_sync_at`, `last_sync_status`, `last_error`, `is_active`.

`acct_bank_accounts`: `connection_id`, `provider_account_id`, `institution_name`, `display_name`, `account_id` (FK to `acct_accounts`, the ledger account this feed posts to, subtype bank or credit_card), `currency`, `last_balance_cents`, `last_balance_date`, `available_balance_cents`, `import_start_date`, `is_active`. Unique on (`connection_id`, `provider_account_id`).

`acct_bank_transactions`: `bank_account_id`, `provider_txn_id`, `posted_date`, `transacted_at`, `amount_cents` (sign as reported: negative is money out), `description`, `payee_raw`, `memo`, `pending`, `raw_json`, `imported_at`, `import_batch_id`, `status`: unreviewed | reviewed | excluded, `entry_id` (the journal entry this transaction is explained by, nullable while unreviewed only if we choose not to auto-draft; see workflow). Unique on (`bank_account_id`, `provider_txn_id`). Insert-only; status and `entry_id` are the only mutable columns, and changes are audited.

`acct_import_batches`: one per sync run: `connection_id`, `started_at`, `finished_at`, `accounts_seen`, `transactions_new`, `transactions_skipped`, `balance_checks` JSON, `error`.

### 3.6 Payees and customers

`acct_payees`: `ledger_id`, `name`, `normalized_name`, `default_account_id` (nullable), `is_contractor` (1099 candidate), `tax_id_encrypted` (nullable, only if we ever generate 1099s ourselves), `notes`, `is_archived`.

`acct_payee_aliases`: `payee_id`, `pattern` (exact or prefix match against normalized bank description). This is what turns "SQ *CONTRACTOR NAME 8823" into a known payee.

Customers are not a table here. Income by customer keys on `customer_ref`, which holds the `app` contact or project id carried by the invoice payment. Manual entries can leave it null.

### 3.7 Rules

`acct_rules`: `ledger_id`, `priority`, `is_active`, match conditions (payee pattern, description pattern, amount range, bank account, direction), actions (set account, set payee, mark as transfer to account X, split template), `auto_post` (false by default; when true the rule posts without review, only for boring recurring charges the user opts in), `hit_count`, `last_hit_at`.

Rules run at import. A rule hit fills the draft entry. Nothing posts without review unless `auto_post` is on for that rule.

### 3.8 Receivables subledger

`acct_invoices`: mirror of `app` invoices relevant to the books. `ledger_id`, `external_source` (vm_app_invoice), `external_ref`, `invoice_number`, `customer_ref`, `customer_name`, `issue_date`, `due_date`, `amount_cents`, `line_items` JSON (type and amount per line, for revenue account mapping), `status` (open | partially_paid | paid | written_off | cancelled), `last_event_sequence`. Fed by the existing webhook, replacing the direct write to `income_line_items`.

`acct_invoice_payments`: `invoice_id`, `entry_id` (the posted deposit entry), `amount_applied_cents`, `fee_cents`, `applied_date`. One deposit can pay several invoices and one invoice can be paid by several deposits.

### 3.9 Periods and reconciliation

`acct_periods`: `ledger_id`, `period_start`, `period_end` (calendar months), `status`: open | locked, `locked_at`, `locked_by`, `reopened_at`, `reopened_by`, `reopen_reason`. Year lock is twelve month locks plus a `year_closed` flag on a small `acct_fiscal_years` table that records the filed return date.

`acct_reconciliations`: `bank_account_id`, `period_id`, `statement_end_date`, `statement_balance_cents`, `ledger_balance_cents` (snapshot at completion), `difference_cents`, `status`: in_progress | completed, `completed_at`, `notes`. Completing a reconciliation with non-zero difference is allowed only with a note and is shown as a warning until resolved.

### 3.11 Explaining documents

A bank transaction is explained by exactly one journal entry, but that entry may be driven by an external document: an invoice payment, a processor payout, a payroll register line, a loan schedule row. `acct_journal_entries.source` and `source_ref` already carry this. Rule for the review queue: every "explain this deposit or debit with X" action goes through the same interface, `explainTransaction(txn, document) -> draft entry lines`. Invoice payment and payroll clearing implement it in v1; processor payouts and loans implement it later without touching the queue or the ledger.

### 3.12 Fixed assets and loans (robust, not bare minimum)

`acct_fixed_assets`: `name`, `acquired_date`, `cost_cents`, `asset_account_id`, `purchase_entry_id`, `method` (free text, the return's method), `disposed_date`, `disposal_entry_id`, `notes`. Depreciation is a manual entry per year using a template that pulls the asset list; no calculation engine. Purchases above the de minimis threshold in review prompt "capitalize?" and create the register row.

`acct_loans`: `name`, `liability_account_id`, `lender_payee_id`, `original_cents`, `rate_bps`, `start_date`, `schedule` JSON (period, principal, interest). Optional; none exist today. When present, a bank debit to the lender prefills the principal and interest split from the schedule row for that date.

### 3.10 Audit

`acct_audit_log`: `table_name`, `row_id`, `action`, `actor`, `at`, `before` JSON, `after` JSON. Written by a generic trigger on every `acct_` table. Insert-only, no RLS delete.

---

## 4. Bank import (SimpleFIN)

Protocol summary (verify against live bridge before building; the pending-transaction id behaviour in particular must be tested empirically):
- User buys a SimpleFIN Bridge subscription, connects institutions in their UI, and generates a one-time setup token.
- We POST the decoded token once to claim an access URL. The access URL embeds basic-auth credentials. Store it encrypted. The setup token is dead after claim.
- Sync is `GET {access_url}/accounts?start-date=&end-date=&pending=0`. Response: accounts with `id`, `org`, `name`, `currency`, `balance`, `available-balance`, `balance-date`, and `transactions[]` each with `id`, `posted`, `amount` (decimal string), `description`, `payee`, `memo`, `pending`, `transacted_at`.

Rules:
- **Posted transactions only** flow into the ledger. Pending transactions are fetched separately for a "coming soon" preview strip and never create entries. This sidesteps the pending id churn problem entirely.
- **Idempotent** on (`bank_account_id`, `provider_txn_id`). Re-importing a window is always safe. Default window is last 14 days on a scheduled sync, custom window for backfill.
- **Amount parsing** from decimal string to integer cents via a strict parser. Anything that does not parse to exactly two decimals fails the batch, never rounds.
- **Balance check** every sync: store the provider balance and date on the bank account, compute the ledger balance (posted plus draft) as of that date, and record the difference on the batch. Non-zero difference after all transactions up to that date are reviewed is surfaced on the dashboard.
- **Schedule**: daily, via the existing `process-automations` edge function pattern or a new `acct-sync` edge function on pg_cron, plus a manual "sync now" button. Sync runs are logged as import batches.
- **Failure mode**: a sync error never partially applies. Batch is a transaction; on error nothing lands and the connection shows the error with retry.
- **Manual CSV import** as the fallback path for institutions SimpleFIN cannot reach, with the same dedup key derived from a hash of (date, amount, description, running index) and the same review flow. Also used for the Wave history import at cutover.

---

## 5. Transaction workflows

Each imported transaction gets a **draft journal entry** on import: bank account line for the amount, counter line to Uncategorized Income or Uncategorized Expense depending on sign, or to whatever the rules engine resolved. The review queue is the list of transactions whose entry is still draft.

Review actions (all edit the draft; confirming posts it):

1. **Categorize**: pick the counter account, optional payee, optional customer, optional memo. Most common action, must be keyboard-fast.
2. **Split**: replace the counter line with several lines. Sum must equal the bank amount; the UI shows the remainder and refuses to confirm otherwise.
3. **Transfer**: pair with another unreviewed transaction of opposite sign in another bank account within a date window. Produces one entry with two bank lines and marks both transactions reviewed. Covers credit card payments, savings sweeps, moving money between banks. See 5.1 for the matching design.
4. **Invoice payment**: pick one or more open invoices. Lines: bank (deposit), revenue accounts per invoice line type (hourly and fixed to Consulting Revenue, recurring to Retainer Revenue, reimbursement to a Reimbursed Expenses contra account), and Merchant Fees for any shortfall between invoice total and deposit. Records `acct_invoice_payments` and updates invoice status.
5. **Refund**: an incoming amount categorized to an expense account (vendor refunded us) or an outgoing amount to a revenue account (we refunded a client). Just categorization with the sign going the other way; the UI labels it so the user is not confused.
6. **Owner activity**: owner draw (money out to the owner), owner contribution (money in from the owner), personal expense paid on the business card (categorize to Owner Draw), business expense paid personally (manual entry: Dr Expense, Cr Owner Contribution). Entity type drives the labels: distributions and shareholder loans for an S corp, draws and contributions for a disregarded LLC.
7. **Exclude**: mark a transaction as not belonging in the books (duplicate the bank itself produced, or a personal transaction on a mixed account). Requires a reason. Excluded transactions still exist as evidence and appear in a filterable list. The draft entry is soft-deleted.
8. **Attach receipt**: upload to the entry.
9. **Confirm**: posts the entry. Bulk confirm on selected rows.

### 5.1 Transfer matching (better than Wave)

Wave suggests a counterpart by amount inside a date window and makes you accept each one. Ours:

- **Candidate scoring**, not a single filter. Score every unreviewed opposite-sign transaction in another cash account on: exact amount (required), date distance (the window is a setting, default 5 days, because card payments and interbank transfers post on different days), description tokens (an account's last four digits or the other institution's name appearing in the description), and history (this account pair has matched before at this amount or on this day of month). Show the top candidate inline on the row with a one-click accept; show the rest behind a picker.
- **Learned pairs.** Accepting a match offers to save a transfer rule for the pair (checking to credit card, "PAYMENT THANK YOU" pattern). A transfer rule with `auto_post` on matches and posts without review when there is exactly one candidate and the descriptions fit the pattern. This is what makes the monthly card payment disappear from the queue entirely.
- **Both sides in one row.** The review queue collapses a matched pair into one line showing both accounts, so the user reviews the transfer once, not twice.
- **In-transit tracking.** If one side is categorized as a transfer to account X but X has not produced the counterpart within the window, the entry posts against a system "Transfers in Transit" clearing account and the dashboard flags it. When the counterpart arrives it clears the transit line. Anything in transit for more than 14 days is an alert. This is the case Wave gets wrong: a transfer initiated on the 31st and received on the 2nd straddles a month end and Wave leaves one side dangling.
- **Reconciliation awareness.** The reconciliation screen lists unmatched transfers first, since they are the usual cause of a difference.

### 5.2 Payroll and liability clearing

Payroll is run at Patriot. The current manual practice in Wave, one journal entry per pay run (gross wages and employer taxes debited, net salary payable and taxes payable credited), is correct and stays. What changes is that it becomes a template and the bank side becomes automatic:

- **Payroll entry template.** Inputs: pay date, gross wages, employer taxes, net pay. Derived: employee withholding = gross minus net; taxes payable = withholding plus employer taxes. Produces the four-line entry from the screenshot in Wave, prefilled from the previous run since salary is fixed, with an officer-compensation flag on the wages line so the S corp reports can separate owner wages from any other payroll. Optional CSV import of the Patriot payroll register to fill the inputs.
- **Liability clearing.** Bank debits from Patriot (net pay, federal deposit, state deposit, Patriot fee) are recognized by a payee alias and categorized to Net Salary Payable, Taxes Payable, or Payroll Fees. Payable accounts get a clearing view: open credits from payroll entries on one side, bank debits on the other, and the running balance. The balance should return to zero after every cycle; a non-zero payable balance older than the pay frequency is a dashboard warning. This is the same mechanic as transfer matching applied to a liability account, and it also covers any other accrued liability (a tax deposit, a loan payment).

Manual journal entries: full form with N lines, live balance indicator, cannot save as posted unless balanced. Used for opening balances, corrections, in-kind contributions, and anything without a bank transaction.

Reversal: from any posted entry, "reverse" creates a mirrored posted entry dated today (or a chosen open date) and links both. "Reverse and re-enter" opens a prefilled draft of the original for editing.

Recurring manual entries: skip. Recurring things come through the bank.

---

## 6. Receivables on a cash basis

### 6.1 Design choice

Two options exist. Post invoices to Accounts Receivable in the general ledger (Dr AR / Cr Revenue on issue, Dr Bank / Cr AR on payment) and compute cash-basis reports by backing out unpaid AR. Or keep AR as a subledger outside the general ledger and post revenue only when cash lands.

**Decision: subledger.** The mixed-ledger approach makes every cash-basis report a derived calculation with partial-payment edge cases, which is exactly the class of bug we cannot afford. The subledger approach means the general ledger is purely cash and every report reads straight from it, while Aged Receivables, open invoices, and expected cash come from `acct_invoices`. If accrual reporting is ever genuinely needed, adding AR posting is an additive feature with its own flag, and the subledger data already exists to backfill it.

### 6.2 Invoice feed

The existing webhook from `app` keeps its signing, sequence, and idempotency. The receiver changes from "write income line items" to "upsert `acct_invoices`". Invoice paid in `app` sets the subledger status to expecting payment, it does not create revenue. Revenue is recognized when the deposit is matched. If a deposit is matched before `app` marks it paid, the match is the truth and the invoice shows paid in the books regardless.

Fix the known gap while we are there: the sender does not retry, the receiver assumes it does. Either add a bounded retry to the dispatcher in `app` or add a nightly reconciliation pull where `admin` asks `app` for invoices changed since its last sequence. The pull is more robust and is the recommendation.

### 6.3 Payment matching

Auto-suggest matches for unreviewed deposits: exact amount against open invoices, then amount minus a plausible fee (2 to 4 percent, or a fixed wire fee), then customer name in the bank description. The user confirms. Shortfall goes to Merchant Fees by default with an override to Bank Fees or FX Loss.

### 6.4 Write-offs

Mark an invoice written off with a date and reason. No ledger impact on a cash basis. Shows on Aged Receivables history and Income by Customer as uncollected.

---

## 7. Payees, contractors, 1099

Every bank transaction gets a payee, resolved by alias match at import, or set during review, which offers to save the alias. Payee has a default account so the next transaction from them pre-fills.

Contractors are payees with `is_contractor`. The 1099 Contractor Summary report sums posted expense lines by contractor payee for a calendar year and flags those over the reporting threshold. Threshold is a constant in `tax-core` by year, not hardcoded in the report. We do not generate 1099 forms; the report is what you hand to whoever files them.

---

## 8. Reconciliation and period close

Monthly, per bank account:
1. Open the reconciliation for the month. Statement balance defaults to the SimpleFIN balance on the period end date if a sync captured it, else typed in.
2. Screen shows: ledger balance as of period end, statement balance, difference, count of unreviewed transactions in the period, count of drafts.
3. Difference is zero and no drafts remain: complete. Bulk-posts every draft in the period for that account.
4. Difference is non-zero: the screen lists candidate causes (unreviewed transactions, transactions dated outside the window, transfers matched to the wrong date) and refuses to complete without a note.

Month lock: when every bank account in the month is reconciled, offer to lock the month. Locking posts any remaining drafts (manual entries) and refuses future writes dated in it. Reopen requires a reason and is audited.

Year close: nothing is posted. Retained earnings on the balance sheet is computed as the sum of all income and expense lines dated before the fiscal year start, plus the current year net income shown on its own line. When the tax return is filed, mark the fiscal year closed, which locks all twelve months and records the filing date.

---

## 9. Reports

All reports are Postgres functions taking (`ledger_id`, date range or as-of date, `include_drafts` boolean default true with a visible indicator). Each returns rows that the UI renders and that the export writes to CSV unchanged. Every report has "compare to prior period" and "by month columns" where it makes sense.

| Report | Definition |
|---|---|
| Profit and Loss | Income and expense accounts, lines dated in range, grouped by type then parent then account. Net income at bottom. Optional monthly columns. |
| Balance Sheet | Asset, liability, equity balances as of date. Equity section includes computed retained earnings and current year net income. Must equal: assets = liabilities + equity, asserted in the function. |
| Cash Flow | Direct method. Net change in bank and credit card accounts for the range, broken down by the `cash_flow_class` of the counter accounts. Reconciles opening cash to closing cash, asserted. |
| Trial Balance | Every account with debit and credit totals for the range and ending balance. Totals must be equal, asserted. |
| General Ledger | Every posted (and optionally draft) line in range, grouped by account with running balance. |
| Account Register | One account, all lines, running balance, filters. The drill-down target from every other report. |
| Aged Receivables | Open invoices bucketed by days past due as of date, from the subledger. |
| Income by Customer | Revenue lines grouped by `customer_ref` for the range, with invoice count. |
| Expenses by Vendor | Expense lines grouped by payee for the range. |
| 1099 Contractor Summary | Expense lines by contractor payee for a calendar year with threshold flag. |
| Owner Equity Summary | Contributions, draws or distributions, and net income for the year. Feeds the tax estimator for pass-through entities. |
| Officer Compensation | Wages lines flagged officer compensation, employer taxes, and shareholder health insurance for the year. Feeds the 1120-S and the reasonable-compensation check. |
| Shareholder Basis | Rollforward: opening basis, plus contributions, plus ordinary income, minus distributions, minus nondeductible expenses, equals closing basis. Distributions above basis are flagged because they are taxable. Wave does not offer this and it matters for an S corp. |
| Distributions vs Salary | Ratio of distributions to officer wages for the year, with a configurable warning threshold. A sanity check on reasonable compensation, not tax advice. |
| Return Package (1120-S) | P&L mapped by `tax_line_hint` to 1120-S lines, balance sheet as Schedule L, equity rollforward as M-2, officer compensation, distributions. Everything the return needs from the books, in return order. |
| Uncategorized | Everything sitting in Uncategorized Income or Expense. A permanent to-do list, shown on the dashboard. |

Drill-down: every number on every report links to the register filtered to the lines that produced it. This is the single most useful thing Wave gets right.

---

## 10. Default chart of accounts

Seeded on ledger creation, all editable except system accounts. Codes are suggestions.

**Assets**: 1000 Checking (bank), 1010 Savings (bank), 1100 Accounts Receivable (system, unused on cash basis but present), 1200 Transfers in Transit (system, clearing), 1500 Equipment (fixed asset), 1510 Accumulated Depreciation (contra), 1900 Uncategorized Asset.
**Liabilities**: 2000 Business Credit Card (credit_card), 2100 Accounts Payable (system, unused), 2200 Sales Tax Payable, 2300 Net Salary Payable (payroll clearing), 2310 Payroll Taxes Payable (payroll clearing), 2400 Loans, 2900 Loan from Shareholder.
**Equity**: 3000 Shareholder Capital, 3100 Shareholder Contributions (system), 3200 Shareholder Distributions (system), 3900 Opening Balance Equity (system), Retained Earnings (system, computed, not postable).
**Income**: 4000 Consulting Revenue, 4100 Retainer Revenue, 4200 Product or SaaS Revenue, 4300 Affiliate and Referral Income, 4800 Reimbursed Expenses, 4900 Other Income, 4990 Uncategorized Income (system).
**Expenses**: 5000 Contractors, 5100 Software and Subscriptions, 5200 Hosting and Infrastructure, 5300 AI and API Usage, 5400 Marketing and Advertising, 5500 Professional Services (legal, accounting), 5600 Merchant and Bank Fees (system), 5700 Office and Equipment, 5800 Travel and Meals, 5900 Insurance, 6000 Officer Compensation (payroll, officer flag), 6010 Other Wages (payroll), 6100 Payroll Employer Taxes, 6150 Payroll Service Fees, 6160 Shareholder Health Insurance, 6200 Taxes and Licenses, 6300 Education and Training, 6400 Depreciation, 6900 Other Expense, 6990 Uncategorized Expense (system).

The existing 15 admin expense categories map onto this list one to one for migration.

---

## 11. Safety, integrity, operations

- **Backups**: confirm Supabase point-in-time recovery is enabled on the project. Add a nightly `pg_dump` of the `acct_` schema to off-platform object storage, retained 90 days, plus a monthly snapshot retained forever. Test a restore once before go-live and once a year.
- **Environments**: a separate Supabase project (or at least schema) for staging. The existing demo mode gets an accounting demo dataset so UI work never touches real books.
- **Scheduled integrity job** (daily): trial balance is zero, every posted entry balances, no posted line points at an archived account, every bank account ledger balance matches the last provider balance as of that date within the unreviewed set, no entries dated in locked periods. Results on the dashboard, failures emailed via the existing automation email path.
- **Tests**: pgTAP suite for the triggers (balance constraint, immutability, period lock, audit). TypeScript property tests for the cents parser, split arithmetic, transfer pairing, and report functions against generated ledgers (random balanced entries, assert trial balance zero and balance sheet identity for every date). Golden-file tests for each report against a fixed fixture ledger.
- **Migrations**: additive only against `acct_` tables once live. Any destructive schema change ships with a verified backup and a dry run on staging.
- **RLS**: same single-tenant model as the rest of admin, but `acct_audit_log` and `acct_bank_transactions` deny UPDATE and DELETE to every role including service.
- **Secrets**: SimpleFIN access URL under its own key, rotated independently of SMTP and SSN keys.

---

## 12. Integration with the existing apps

**admin**
- New sidebar section "Accounting": Dashboard, Transactions (review queue plus register), Accounts, Payees, Invoices (subledger), Reconcile, Reports, Journal, Settings (connections, rules, periods).
- Legacy Income and Expenses pages: keep read-only during the parallel run, then retire. The recurring `expenses` table stays useful as a budget baseline; convert it into a rule seed if wanted.
- Tax estimator: replace the income import modal with a P&L pull. Business income and deductible expenses come from the ledger by `tax_line_hint`, owner draws and estimated payments from the Owner Equity Summary. This is the first automation payoff.
- Net worth: unchanged, though bank account balances can now be pulled from `acct_bank_accounts` rather than typed.
- Dashboard: add cash position, unreviewed count, uncategorized total, month-to-date P&L, integrity status.

**app**
- No changes to invoicing. The webhook payload already carries what the subledger needs.
- Add the changes-since pull endpoint (section 6.2) under the existing v1 API with an API key.
- Later: expose "paid in books" status back to `app` so the CRM can mark an invoice paid from the bank match instead of by hand. Out of scope for v1.

---

## 13. AI and API surface

Everything below is read-only or proposes drafts. Nothing lets an agent post.

- Postgres functions for every report, callable via Supabase RPC with an API key.
- `acct_query` views: flattened journal with account names, payee names, period status, for ad hoc SQL.
- A small MCP server (later) with tools: `get_report(name, range)`, `list_unreviewed()`, `suggest_categorization(txn_id)`, `propose_rule(...)`. Suggestions write to a `suggested_account_id` on the draft entry that the review queue shows as a hint.
- Categorization suggestions: rules first, then nearest-neighbour on the user's own history (same payee, similar amount), then an LLM call with the chart of accounts and the description. Log every suggestion and whether it was accepted so the rules engine can learn which payees deserve an alias.

---

## 14. Migration and cutover from Wave

1. Pick the cutover date: 2027-01-01. Parallel-run Q4 2026 (October to December) in both systems.
2. Export from Wave: chart of accounts, all transactions for 2026, balance sheet as of 2026-09-30 and again as of 2026-12-31.
3. Build the chart in admin, mapping Wave accounts to ours.
4. Opening balances as of 2026-09-30 as one posted entry against Opening Balance Equity, for each balance sheet account.
5. Connect SimpleFIN with a start date of 2026-10-01, or CSV import the same window.
6. Categorize Q4 in both systems. At each month end, compare P&L and balance sheet line by line. Three clean months is the go-live gate.
7. On 2027-01-01: lock 2026, keep Wave read-only for history, stop entering there.
8. Prior years stay in Wave exports, archived as CSV and PDF in Supabase storage. Do not import history into the ledger; the balance sheet carries forward through opening balances.

---

## 15. Phases

1. **Foundation**: schema, triggers, audit, cents utilities, pgTAP, backups, staging, demo dataset. No UI. Exit: property tests green, restore drill done.
2. **Chart and journal**: accounts UI, manual entries, reversal, register, trial balance, period locks. Exit: opening balance entry from a Wave export reproduces Wave's balance sheet.
3. **Banking**: SimpleFIN claim and sync, CSV import, review queue with all nine actions, payees and aliases, rules, transfer suggestion, attachments. Exit: one full month categorized and balance check zero.
4. **Receivables**: webhook receiver retarget, invoices subledger, payment matching, aged receivables, changes-since pull. Exit: every Q4 invoice matched to a deposit.
5. **Reports and reconciliation**: all report functions with drill-down, monthly reconciliation flow, year close, exports. Exit: month-end tie-out against Wave.
6. **Wiring and payoff**: tax estimator on the ledger, dashboard, legacy pages read-only, integrity job emails. Exit: Q4 parallel run complete, cutover.
7. **AI surface**: RPC exposure, suggestion pipeline, MCP server.
8. **Processor integrations (bonus, after cutover)**: Stripe, Shopify Payments, PayPal payout import. Not needed today since clients pay by ACH, so this ships only once the core has survived a full quarter. The core is built so these plug in: a bank deposit can be explained by an invoice, a payout record, or a payroll entry through one "explained by" mechanism (section 3.11), so a processor integration is a payout importer plus a matcher, with no change to the ledger.

---

## 16. Open questions

1. Entity type today: disregarded LLC, or S corp? Drives equity account naming, whether owner pay is a distribution or payroll wages, and how estimated tax payments are classified (owner draw for pass-through, tax expense for a C corp).
2. Are there mixed-use accounts (personal spending on a business card or vice versa)? If yes, the Exclude and Owner Draw flows need to be first-class; if no, they can be plainer.
3. Does anyone other than Ciaran need access, e.g. an accountant with read-only reports at tax time? Affects whether a viewer role is in v1.
4. Do we want `app` to learn "paid" from the bank match (section 12, later item) in v1 or after?
5. Which institutions are in play? SimpleFIN coverage should be checked for each before committing to it over CSV.
6. Retention of Wave: keep the subscription for history for a year after cutover, or export everything and cancel immediately?

---

## 17. Gaps found on second review (2026-09-02)

Things a real year of books hits that the draft above does not handle. Each is either added to scope or explicitly parked.

### Added to scope

- **Payment processor payouts.** If any revenue arrives through Stripe, Shopify Payments, PayPal, or similar, the bank sees one net payout covering many sales minus fees, refunds, and chargebacks. Categorizing the deposit as revenue is wrong by the fee amount and loses per-sale detail. Needs a payout workflow: import the processor payout report (CSV or API), create one entry per payout with gross sales, refunds, fees, and net to bank, and match it to the bank deposit. Design the review queue so a bank deposit can be explained by a payout record the same way it can be explained by an invoice. Whether this is v1 depends on open question 7.
- **Payroll journal from the provider.** Patriot runs payroll. The bank shows net pay, tax deposits, and the Patriot fee as separate debits. Booking those as-is understates wages and hides employer taxes. Correct treatment per pay run: gross wages expense, employer payroll tax expense, and withheld amounts as the difference. Add a payroll entry template that takes gross, employee withholding, employer tax, and net from the Patriot payroll register and produces one balanced entry, then matches the net pay and tax deposit bank debits to it. For an S corp this also feeds officer compensation and W-2 wages for the QBI calculation in the tax estimator.
- **Fixed assets and depreciation, minimal.** Most equipment goes straight to expense under the de minimis safe harbor (currently $2,500 per item; the constant lives in `tax-core` by year). Anything above it needs a fixed asset register: purchase entry to a fixed asset account, and an annual depreciation entry posted from the CPA schedule. The register is a small table; depreciation is a manual entry with a template. No depreciation calculation engine.
- **Loans and lines of credit.** If any exist, a payment splits into principal (liability) and interest (expense). Add a loan record with a schedule import so the split is prefilled during review. Parked unless open question 8 says yes.
- **CPA year-end workflow.** The person filing the return is the correctness backstop. They need: trial balance and general ledger export in a format they accept, the ability to post adjusting journal entries dated 12/31 into an otherwise locked year (a specific adjusting source with its own audit trail), and a read-only viewer login. Add a viewer role and an accountant package export: trial balance, general ledger, P&L, balance sheet, 1099 summary, fixed asset register, all as CSV and PDF for the year.
- **Prior-period corrections after filing.** Once a year is marked filed, it is never reopened. Errors found later are posted in the current period as prior-period adjustments with a memo referencing the original. Enforce: reopen is only allowed on unfiled years.
- **Contractor residency for 1099.** Foreign contractors paid through Wise, Deel, or wire are not 1099 reportable. Add `is_us_person` to payees; the 1099 summary filters on contractor and US.
- **Revenue by payer for 1099 reconciliation.** Clients send 1099-NEC, processors send 1099-K. Add a report of revenue lines grouped by payer for a calendar year so received forms can be checked against the books.
- **Duplicate detection across import paths.** Moving an account from CSV to SimpleFIN, or re-importing a CSV, produces the same transaction with different ids. Add fuzzy duplicate detection (same account, same date, same amount, similar description) that flags candidates for human confirmation rather than silently skipping.
- **Optimistic concurrency on drafts.** A draft edited by the user and an agent suggestion at the same time must not clobber. Version column on draft entries, reject stale writes.
- **Pile-up nagging.** Books are only as right as the review discipline. Weekly digest email via the existing automations path: unreviewed count, uncategorized total, sync failures, balance mismatches, days since last reconciliation.
- **Exit format.** Full general ledger export in a layout QuickBooks and Xero can import (date, account, debit, credit, memo, name), so leaving this system is a CSV, not a project.

### Tax-side items that stay out of the ledger

These are deductions or adjustments with no bank transaction, or that live at the owner level. They belong in the tax estimator as an adjustments list, not as journal entries: home office, mileage, S corp shareholder health insurance, retirement contributions (Solo 401k, SEP), half of self-employment tax, QBI. The estimator already has `additional_deductions`; extend it to itemized adjustments with a note per line.

### Where the maintenance burden actually is

The ledger has no rules that change year to year. Debits equal credits in 2026 and in 2036. What changes:

| Layer | Changes | Frequency | Who fixes |
|---|---|---|---|
| Ledger, reports, reconciliation | Nothing | Never | n/a |
| Bank feed | Institution re-auth, SimpleFIN outages | A few times a year | User re-links in SimpleFIN; no code |
| Tax constants (brackets, thresholds, de minimis, 1099 limit) | Yearly | Every January | Already true today for the estimator; one file per year in `tax-core` |
| Chart of accounts, rules | As the business changes | Ongoing | User, in the UI, no code |
| Framework and dependency upgrades | Same as the rest of the monorepo | Ongoing | Same as today |

Nothing in this module files with, remits to, or registers with any government. That is the difference from the payroll module, which failed on a compliance wall (IRS deposit authorization), not on arithmetic. Wave does no filing either, so the replacement target has no compliance component.

### What scale means here

Transaction volume is not a concern; Postgres handles millions of lines and a consulting business produces thousands a year. Scaling risks are feature-shaped, and the rule is: build the books, buy anything that files with a government.

- More entities: `ledger_id` from day one. Cheap.
- More people: viewer role in v1, editor roles later. Moderate.
- Accrual reporting: additive behind a flag. Moderate.
- Multi-currency balances: currency columns exist, FX logic does not. Significant.
- Physical products with inventory and COGS at scale: not this system. Buy software.
- Sales tax filing, payroll, 1099 e-file: never this system. Buy software, import its reports.

## 18. Decisions and remaining questions

Answered 2026-09-02:
- Entity: single-member LLC taxed as an S corp. Payroll runs at Patriot; the per-run journal entry is kept as a template (5.2).
- No payment processors today; clients pay by ACH. Stripe, Shopify Payments, PayPal are a bonus phase after cutover (phase 8), built on the explaining-documents interface (3.11).
- The owner files the return (1120-S plus personal). Reports must cover what Wave offers and add the S corp set (section 9).
- No loans or capitalized equipment today, but both are supported with small tables (3.12) rather than left out.
- Exactly one set of books. `ledger_id` removed.

Still open:
1. Mixed-use accounts: any personal spending on business accounts or the reverse?
2. Should `app` learn "paid" from the bank match in v1?
3. Institutions in play, for SimpleFIN coverage.
4. Wave retention after cutover.
5. Foreign contractors or foreign payment rails (Wise, Deel, wire)?
6. Rough transaction volume per month across all accounts.
7. Who holds the off-platform backups, and is Supabase point-in-time recovery enabled today?
8. Shareholder health insurance and any retirement plan contributions: do these run through Patriot payroll (they should for an S corp, so they show on the W-2) or get paid directly from the business account?
