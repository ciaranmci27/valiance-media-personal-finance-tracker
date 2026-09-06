# Accounting specification review

Reviewed 2026-09-05. Historical review of the original September 2 draft, retained for rationale. Superseded by the consolidated [accounting-spec.md](accounting-spec.md) and [accounting-build-plan.md](accounting-build-plan.md). Implement those documents, not this review. The final direction imports available Wave history into the normal ledger, preserves personal finance pages, defers AI/REST work, and keeps Wave available through year end or longer. No application or database changes were made during planning.

**Scope clarification from the owner, 2026-09-05:** The immediate priority is a dependable replacement for Wave, with access to years of existing accounting history. Accounting is its own area within admin. The Income, Expenses, and Net Worth pages remain and can progressively consume accounting-derived values alongside manual inputs. Automatic estimated-tax inputs are a desired payoff. Full AI workflows, MCP, and a polished REST API are deferred; the recommendations below about implementing those early are optional future design guidance, not initial delivery requirements. Preserve reusable internal bookkeeping/report functions, stable record identities, and complete exports to make later integrations straightforward.

The target is one company's books inside the existing personal finance app, with first-class APIs and AI assistance. The double-entry ledger, cash-basis receivables subledger, immutable posted entries, bank evidence, and report drill-down are sound starting choices. The highest-value work is making those boundaries precise. More reports and more automation cannot compensate for an ambiguous posting or reconciliation model.

Evidence: reviewed all 18 sections of `accounting-spec.md`, the current admin invoice receiver and reconciliation helper, the app webhook dispatcher and SQL emitter, the admin navigation, and the existing tax income importer. External documentation was checked for SimpleFIN, Supabase, and the tax/reporting claims cited below. No live bank, Wave, Patriot, or Supabase production configuration was inspected.

## Fix before implementing the core

### 1. Separate personal finances from company books

Spec: sections 5, 12, 18.

Retiring the personal Income and Expenses pages is a larger product change than adding company accounting. Company revenue, company profit, owner wages, distributions, and personal spending answer different questions. Keep a Personal area and a Company Books area. Share the interface and explicitly map selected data between them.

A personal purchase on a business checking account or business card must still explain the movement in that company's balance. It needs an appropriate shareholder, receivable, or other classification based on the facts. Excluding it creates a reconciliation hole. Reserve exclusion for duplicate observations or accounts/records outside the books, with a reason. Identify which accounts belong to the company at connection setup.

For the personal dashboard, label linked company values and avoid counting company cash alongside the same business ownership value in net worth. Do not count distributions a second time as business profit. Tax imports should identify their source and preserve personal W-2 and other income inputs.

### 2. Reconciliation needs statement items, not just matching balances

Spec: sections 3.9 and 8.

The proposed model has a balance snapshot but no record of which bank-side journal lines cleared a statement. Equal totals can hide one missing deposit and one missing withdrawal of the same amount. Statement cycles, especially credit cards, also need not align with calendar months.

Add statement start/end dates, opening/closing statement balances, the uploaded statement, and explicit membership of cleared bank-side lines. Preserve outstanding items across statements. A company book balance can legitimately differ from the raw statement balance because of identified outstanding items; the reconciled difference after those items must be zero.

Save an unfinished reconciliation with notes. Do not label an unexplained difference as completed. Keep per-account statement reconciliation separate from the company-wide calendar-month lock. Adjustments require a real entry with evidence; never create a balancing plug automatically.

### 3. Closing a month must not silently approve drafts

Spec: sections 3.3, 8, 9.

The spec says reconciliation needs no drafts, then says completion bulk-posts drafts, and locking posts remaining manual drafts. That permits unrelated or unfinished work to become official without a deliberate review.

Define separate states: imported evidence, proposed classification, balanced draft, posted, statement-cleared, and period-locked. A close checklist should block on unfinished drafts, missing statements, unresolved duplicates, and material unexplained clearing balances. Explicitly approved exceptions can remain visible where appropriate; they should not turn into invisible postings.

Use posted entries by default for official reports, exports, API answers, and tax inputs. Offer a clearly labelled working preview with balanced drafts. Show excluded draft count and amount beside the official result. Drafts missing complete lines cannot participate in a report that promises balance-sheet equality.

### 4. Invoice shortfalls are not automatically fees

Spec: sections 3.8, 5, 6.3.

Example: a $5,000 invoice receives $2,000. The natural result is $2,000 collected and $3,000 still outstanding. The current fee default could produce $5,000 revenue and $3,000 invented fees.

Make partial payment the normal short-payment path. Fees, discounts, withholding, write-offs, and currency differences need an explicit explanation and appropriate evidence. Handle overpayments, unapplied customer money, returned ACH payments, refunds, and an invoice edited after payment. A refund must update payment allocations as well as the ledger.

For a payment covering multiple revenue types, store how the collected amount was allocated to invoice lines, with deterministic cent rounding. Store gross amount applied and fee allocation clearly so one fee is not repeated across several invoices. Prevent over-allocation atomically.

### 5. The existing invoice feed cannot supply open receivables

Spec: sections 6.2 and 12. Confirmed in `app/supabase/schema.sql:1504-1516`.

The emitter returns without emitting for a new unpaid invoice, updates between unpaid states, and deletion of an unpaid invoice. A pull of the existing webhook event log would miss those events too. The current payload does contain due dates and line items for events that exist, but it does not solve lifecycle coverage.

Add a feed covering all relevant invoice lifecycle changes, plus an initial snapshot and catch-up mechanism including deletion/cancellation tombstones. Distinguish draft invoices from issued receivables. Use stable, typed project/customer references and snapshot display names. A project ID should not sometimes mean a contact ID.

Use a durable inbox, transactional per-invoice version checks, and a replayable pull. A global sequence alone needs care: database sequence allocation is not commit order, so a consumer must not permanently skip a lower-numbered event committed later. Use a cursor design with a tested completeness strategy or overlap and deduplication plus periodic snapshot repair.

The current dispatcher really does attempt delivery once; the receiver comment assumes retries. Change delivery behavior or guarantee recovery through the new feed. Book payment status must be derived from allocations, separately from the CRM's paid flag. The spec's `expecting payment` state is also missing from its declared status list.

### 6. Transfers need to preserve both posting dates

Spec: sections 5.1 and 9.

A transfer leaving checking on September 30 and arriving in savings on October 2 cannot use one two-bank-line entry with one date while preserving both statement balances. Use transfer clearing entries on each actual date whenever the dates differ, linked by one transfer group. Collapse that group into one review row for convenience.

Match bank observations to existing manual/payroll/payment entries before creating additional economic activity. Define matching at the bank-line level, with amount limits and uniqueness, so two import paths cannot explain the same movement twice. A document can drive several entries, and an entry can have several supporting documents; one polymorphic `source_ref` is insufficient for the complete evidence trail.

### 7. Credit cards should not be part of the cash total

Spec: sections 3.2 and 9.

The proposed cash-flow report includes credit card balances in its cash pool. A $1,000 card purchase changes debt without moving checking or savings. A later card payment moves cash. Treating both as cash accounts obscures that distinction.

Define the cash pool explicitly and show card debt separately. If a net liquidity metric is useful, give it that label. Also define cash-flow classification for compound entries: payroll clearing and card settlements cannot always inherit a useful category merely from their immediate counter-account. A simple bank cash-movement report is a better initial promise than an underspecified formal direct-method statement. This recommendation follows the distinction between cash movements and noncash activity in the [SEC financial statement guide](https://www.sec.gov/about/reports-publications/investorpubsbegfinstmtguide).

### 8. Immutability and permissions need complete enforcement

Spec: sections 2, 3.3, 3.10, 11, 13.

Block INSERT into an already posted entry as well as UPDATE and DELETE. Otherwise a pair of new balancing lines can rewrite the meaning of a posted entry without violating its balance. Block moving a line between entries and changing a posted entry's date or financial state. Reversal must retain both original and reversal in report totals; do not also omit the original as voided.

Serialize posting against period close and prevent two requests from posting, matching, or approving the same item concurrently. Specify permitted transitions and immutable fields. Metadata changes such as added receipts can remain possible through separately audited operations.

Supabase service-role credentials bypass RLS. The promise that RLS denies changes even to that role is incorrect. Use scoped principals, table/function grants, controlled commands, and database triggers; do not give an AI agent a service-role key. Views and privileged functions require their own permissions review. [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).

Audit triggers must exclude the audit table itself to avoid recursion, redact credentials and sensitive payload fields, and distinguish the human, agent, and worker responsible for a change. Database owners remain an operational trust boundary; application triggers are not protection against someone authorized to disable them.

## Make the AI and API design foundational

### 9. One command interface for the UI, workers, and agents

Spec: section 13 and phase 7.

Reports over RPC are a starting point, but AI/API access cannot be a final wrapping phase if it is the product's main purpose. Define the command and query contract with the ledger. The existing browser-side Supabase patterns should not automatically become unrestricted accounting-table writes.

Use operations such as `get_report`, `get_transaction_evidence`, `propose_classification`, `propose_match`, `propose_journal`, `validate_proposal`, `approve_proposal`, and `reverse_entry`. Posting and approval permissions belong to the owner principal. A deterministic rules worker can post only under an explicitly approved rule policy.

Every write command needs a caller identity, an idempotency key, expected record versions, validation, and an atomic outcome. Define retries after timeouts and duplicate requests. API amounts should be integer-cent strings end to end; native JavaScript BigInt cannot be emitted directly as JSON, and ordinary JSON numbers do not preserve every bigint value.

Provide versioned request/response schemas, consistent error codes, stable pagination, and change cursors. Add a transactional event outbox for consumers that need to learn when entries or invoice allocations change. Keep a single internal deployment; this does not require a public API platform or multiple services.

### 10. Store complete proposals and the evidence behind them

A single `suggested_account_id` cannot represent a split, transfer, payroll entry, customer match, or reversal.

Store a structured proposal containing the action, target IDs and versions, proposed lines/allocations, evidence references, explanation, origin (rule/history/model), model/rule version, and review outcome. Approval must validate the current records again. Expire or regenerate stale proposals instead of overwriting a later human edit.

Separate permission to propose a rule from permission to activate it or enable automatic posting. Otherwise an agent prohibited from posting could indirectly post by creating an auto-post rule. Before activation show the rule's matches against historical transactions, excluded cases, overlapping rules, and amount bounds. Record the exact rule version on every automated posting.

Descriptions, invoice notes, and attachments are untrusted data, including when read by an LLM. They cannot authorize operations or change tool permissions. Give the model only the financial context it needs and exclude secrets, tax IDs, and unrelated personal-finance data. Bounded read tools are the default; free-form SQL, if offered at all, needs an independently enforced restricted database principal and resource limits.

### 11. AI answers need coverage and reproducibility

A report result should include its date range, currency, accounting basis, draft policy, source coverage start, latest successful sync per account, unreconciled periods, and a ledger/report revision identifier. A partial period must not look like a complete year.

An answer such as "software costs rose $420" should link to the relevant report and contributing lines and explain the comparison period. SQL/report functions supply arithmetic; the model explains the result. Save report snapshots at close and filing, including the mapping/report version, so later account renaming or tax mapping edits do not silently rewrite an exported historical package.

Receivables aging additionally needs historical invoice revisions, dated allocations, write-offs, and reversals. Today's invoice status cannot reproduce an as-of report for a previous month. General-ledger reports read journal lines; receivables and tax worksheets legitimately use additional authoritative records. Replace the contradictory invariant that every figure comes from journal lines alone.

## Additional correctness and operational gaps

### 12. Bank import needs separate evidence and processing states

Spec: sections 3.5, 4, 11.

Pin and test the supported SimpleFIN version. The current protocol page labels version 2 as a draft, while the spec assumes the earlier `org` shape. Handle body-level errors, incomplete responses, account identity, timestamps, and provider sign conventions explicitly. Numeric strings are not specified as requiring exactly two displayed decimal places. [SimpleFIN protocol](https://www.simplefin.org/protocol.html).

Preserve append-only raw observations and track the canonical transaction/matching status separately. If a provider returns changed data for an existing ID, surface the difference instead of silently skipping it. Reconnection must map back to the existing company account and not create a second history. A changed connection ID must not defeat duplicate detection.

Use the last successful coverage checkpoint plus an overlap window, not only "today minus 14 days." Stage late transactions for a locked period as exceptions instead of rolling back every other account's valid import. Commit a validated accounting operation atomically, but retain failed-run diagnostics outside the rolled-back transaction.

Parse representable USD values such as `10`, `10.5`, and `10.50` exactly to cents; reject unsupported fractional precision without silent rounding. Define timezone/date normalization and transaction-versus-balance timing. A provider's available balance is not a reconciled statement balance.

CSV import needs preview, sign/date mapping, duplicate candidates, stable source/file identities, and reversible import-batch tracking. A hash containing a running row index changes when rows are reordered. Preserve legitimate identical purchases; never silently deduplicate them by amount and date alone.

### 13. Payroll templates must reflect the actual register

Spec: sections 5.2 and 17.

Gross minus net is not necessarily all tax withholding: it can include retirement deferrals, other deductions, reimbursements, and noncash benefits. Keep the simple salary template, but validate it against a real Patriot register and support the actual liability categories used. Store payroll run IDs, register evidence, and allocations of multiple bank debits to each run. Unknown components should stop template approval.

Shareholder health insurance is not categorically outside the company ledger. When paid or reimbursed by the corporation, its corporate expense and payroll reporting need to tie together without double counting. Its shareholder tax treatment is another layer. A wages/distributions ratio is a management indicator, not a reasonable-compensation compliance test. [IRS S corporation compensation and medical insurance guidance](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues).

### 14. Narrow the tax-report promises

Spec: sections 9, 10, 12, 17.

The shareholder-basis formula omits important distinctions including stock versus debt basis, ordering and loss limitations. Company book equity is not a sufficient substitute. Use an explicit opening tax-basis input and an imported/manual worksheet until a separately specified calculation exists. [IRS Form 7203 instructions](https://www.irs.gov/instructions/i7203).

Schedule M-2 is not simply the equity rollforward, and mapped P&L lines are not the entire 1120-S input set. Call v1 an accounting support package for the return. Use versioned tax mappings and explicit book-to-tax adjustments rather than unstructured `tax_line_hint` as the calculation contract. Split meals from travel and capture deductible/nondeductible treatment where needed. [IRS Form 1120-S instructions](https://www.irs.gov/instructions/i1120s).

The tax estimator should consume mapped net business income with provenance, while preserving personal wages and other income. Do not subtract ledger expenses again from an already-net profit or treat shareholder distributions as another copy of that profit. Book-to-tax differences must be visible and editable.

### 15. Contractor reporting needs payment facts

Spec: sections 7 and 17.

A contractor boolean plus expense-account totals is not enough. Track payee tax classification, documentation status, payment rail, reportability decision, and exceptions. Payment-card and qualifying third-party-network transactions have different reporting responsibility; they should not be blindly included in the payer's NEC total. Reportable payment analysis can also differ from the sum of P&L expenses. [IRS reporting instructions](https://www.irs.gov/instructions/i1099mec).

Foreign status should not make a record disappear without supporting facts. Service location and the payment's character can create other reporting requirements. Flag incomplete documentation and leave filing to the external filing workflow. [IRS guidance on payments for personal services](https://www.irs.gov/individuals/international-taxpayers/pay-for-personal-services-performed).

### 16. Cutover needs historical balances and honest coverage

Spec: sections 8, 14, 15.

An October start cannot produce a complete annual 2026 P&L, contractor summary, or basis worksheet from Q4 activity alone. Computed retained earnings also needs an explicit opening amount when prior-year activity is absent. Resolve how opening retained earnings, current-year earnings, distributions, and other equity accounts are represented without double counting or leaving everything in Opening Balance Equity.

Use Q4 as a pilot with partial-year labels and retain Wave as the full-year 2026 source. Establish verified 2027 opening balances, including unresolved bank items, open invoices, clearing balances, and tax-basis inputs. If 2026 reporting is required inside admin, specify a complete import or an explicit historical-summary method first.

A go-live gate of "every invoice matched to a deposit" is wrong for legitimately unpaid invoices. Require all recorded payments to be explained and all outstanding invoices accounted for. Move cutover when the evidence is incomplete; the calendar date is not proof of readiness.

Preserve the originally filed package. Later corrections need an explicitly reviewed correction/restatement workflow; do not hard-code that every error discovered after filing belongs in current-year P&L. Keep book correction and tax-return amendment decisions separate.

### 17. Back up receipts and recovery dependencies too

Spec: section 11.

Supabase database backups do not include the Storage API's actual objects. Back up receipts, statements, payroll registers, and Wave exports independently, with manifests/checksums and a recovery path for encryption keys. [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups).

The spec uses an `acct_` table prefix, not an actual `acct_` schema. Specify the real dump scope and include dependent functions, triggers, permissions, identities, and migrations. A restore drill must verify report totals, sign-in, receipt downloads, and safe resumption of idempotent imports. Define recovery objectives and who receives backup failures.

## Highest-value UX changes

| Improvement | Concrete interaction | Benefit |
| --- | --- | --- |
| One review inbox | Group ready-to-confirm, needs explanation, transfers, invoice matches, duplicates, and sync exceptions. Keyboard next/previous, saved filters, bulk preview, persistent selection. | Most bookkeeping happens in one place. |
| Transaction evidence panel | Show the raw bank observation, proposed journal, receipt, related invoice/payroll run, applied rule, and history together. | Decisions become explainable without jumping between pages. |
| Guided close | Show statement coverage, outstanding items, unresolved drafts, clearing balances, and the last remaining blocker. Save progress. | "Books complete through August" becomes a meaningful status. |
| Explain this number | On a report or AI answer, open the exact contributing lines and comparison settings. | Faster investigation and trust in answers. |
| Rule preview and change review | "Apply to these 12 transactions" with exceptions and financial impact; explicit activation of recurring automation. | Reduces repetition without silently changing the books. |

Use one expandable Accounting navigation group with Overview, Review, Accounts & Reconcile, and Reports. Put chart editing, rules, connections, payees, and manual journal creation behind contextual links or a Manage area. Invoices should be directly reachable from receivables cards and the review inbox. Keep personal finance navigation intact.

Show actionable status: "Checking synced through Sep 4; 8 items need review; August reconciled." Avoid a green integrity badge based only on balanced journals. Balance does not prove completeness or correct categorization.

Make draft edits easy to undo. For posted entries, "Correct" should preview the reversal and replacement, affected periods, and report impact. Do not present an ordinary destructive delete. On mobile prioritize receipt capture and one-item review; let wide statement comparisons use the desktop layout.

## Recommended scope and order

1. Consolidate the spec: one company, personal/company boundary, posting state machine, reconciliation, import identity, and command permissions. Remove superseded requirements in place.
2. Build one complete path: import a checking/card statement, propose classifications, approve, reconcile, lock, and reproduce P&L/balance sheet with evidence. Include the API contract in this path.
3. Add complete invoice lifecycle sync and the actual Patriot register template, with reversal and partial-payment cases.
4. Add read-only AI explanations and structured proposals to the same commands. Add richer reports and reviewed tax worksheets after the basic reports tie out.
5. Complete restore and parallel-run checks before cutover. Keep processor integrations, automatic depreciation, accrual conversion, and multi-entity support outside the initial build.

## Contradictions to remove during the rewrite

| Current conflict | Resolution needed |
| --- | --- |
| `ledger_id` removed in sections 3.1/18 but still required in tables, RPCs, and section 17 | Remove obsolete references throughout. |
| Every report from journal lines, but aging comes from the invoice subledger | Define authoritative inputs per report. |
| Raw bank data is immutable, but status/link fields are mutable and later all updates are denied | Separate raw observations from processing state. |
| Posted status cannot change, but `voided` and reversal behavior are unspecified | Define one consistent correction/state model. |
| No posted lines may reference archived accounts | Preserve historical references; prevent new use of archived accounts. |
| Integrity job demands no entries in locked periods | Check unauthorized changes after lock, not the legitimate entries that were locked. |
| Single-currency fee flow mentions FX Loss without defining the account/policy | Add an explicit supported exception path or reject unsupported cases. |
| Reimbursement is called a contra account in one workflow and income in the chart | Choose the supported bookkeeping policy and map consistently. |
| Viewer role both out of scope and required; owner files but CPA is assumed | Keep owner-only v1 plus export, unless access for another person is actually needed. |
| Loans/assets both parked and supported | Define the exact initial manual-register scope. |
| All existing expense categories supposedly map one-to-one | Review mapping; personal and company categories do not share identical meanings. |
| Later accrual/multi-currency support promised as simply additive | Remove the guarantee; these require a separate accounting-policy and migration design. |

## Acceptance scenarios to add

Test business behavior as well as arithmetic. These fixtures should exercise commands, persistence, reports, and reversal paths together.

| Scenario | Required result |
| --- | --- |
| Same import/command replayed after a timeout | One economic posting and one allocation; caller receives the existing result. |
| User edits while an AI proposal is pending | Stale approval rejected; no human work overwritten. |
| Close races with a post | Exactly one valid serialized outcome; no posting slips into the locked month. |
| Missing deposit and withdrawal of equal amount | Equal net balance does not mark statement items reconciled. |
| Transfer on Sep 30 / Oct 2 | Both account statements tie on their own dates; transit is visible between dates. |
| $5,000 invoice / $2,000 receipt | $3,000 remains due; no invented fees. |
| ACH payment is later returned | Payment allocation reverses, invoice reopens appropriately, original evidence remains. |
| Unpaid invoice is issued, amended, then cancelled | Receivables and historical aging reflect every relevant state. |
| Receipt arrives for a locked-period transaction | Evidence can attach without changing posted financial amounts. |
| Reconnected feed overlaps a CSV import | Duplicate candidates preserve source evidence and do not double-post. |
| Personal purchase on company card | Card liability still ties; company expense is not inflated. |
| Prior-year retained earnings with no detailed history | Opening balance sheet and following-year earnings rollforward tie out. |
| Rule suggestion tries to enable automatic posting | Agent credential is denied even when proposal creation is allowed. |
| Full restore | Reports tie, attachments open, credentials recover, imports resume without duplication. |
