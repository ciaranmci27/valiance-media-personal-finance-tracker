# Accounting target schema

Drafted 2026-09-07 as the build specification for right-sizing the accounting data layer. It replaces the 106-table `public.acct_*` design with 27 tables in a dedicated `accounting` schema. The ledger core keeps the shape and invariants the current build already got right. Everything else is collapsed to what a one-owner, cash-basis, S-corp bookkeeping system needs, with room to add tables later without touching the core.

Read section 1 (the six tables that matter) and section 4 (scenarios). Sections 2 and 3 follow from section 1 and can be skimmed.

## 0. Conventions

- Schema `accounting`. No `acct_` prefix. All functions fully qualify `accounting.` and set `search_path = ''`.
- Money is `bigint` cents. Debit positive, credit negative. Every posted entry sums to exactly zero. No floats anywhere in the ledger. Transport as integer-cent strings.
- Financial dates are `date`. Observations and audit use `timestamptz`. Books timezone lives once in `settings`.
- Primary keys are `uuid` with `gen_random_uuid()`. Mutable rows carry `version integer` for stale-write checks and `updated_at`. Immutable rows carry only `created_at` and `created_by`.
- Financial foreign keys are `ON DELETE RESTRICT`. Nothing financial is hard-deleted.
- Row-level security is enabled on every table. No grants to `anon`. `authenticated` reaches tables only through owner-checked functions. `service_role` may execute only the two worker functions. `GRANT USAGE ON SCHEMA accounting TO authenticated, service_role`.
- One audit log for the whole schema. No per-feature versions, voids, releases or supersessions tables.
- One command dispatcher, `accounting.operate(command jsonb)`, for every owner write. One report engine.
- Polymorphic links use typed nullable foreign-key columns with a check that exactly one is set, never a free-text `target_kind` plus bare id.

Target size: 27 tables, about 30 functions, about 10 triggers, 7 migration files (one per domain) generated once and applied fresh. The current 36-file chain is archived, not migrated.

Business identity (legal name, EIN, entity type, tax classification with its effective year, home state, fiscal year start, books timezone, earliest history date, owner and accountant contacts) lives in one admin-owned singleton, `public.business_profile`, shared with the tax estimator. The accounting schema reads it and never copies it. Its migration ships with Phase 1 in `public`, not in the `accounting` schema.

## 1. Core ledger (the six that matter, plus receipts)

### 1.1 `settings` (singleton)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `smallint` PK, check `= 1` | Exactly one row |
| `owner_user_id` | `uuid` → `auth.users` | The only identity allowed to read or write books |
| `primary_system` | `text` check in (`wave`, `admin`) | Which system is authoritative today |
| `primary_system_since` | `date` null | Effective date of the last change |
| `transfer_window_days` | `smallint` default 5 | Transfer candidate matching window |
| `financial_revision` | `bigint` default 0 | Bumped in the same transaction as any report-relevant write |
| `version`, `updated_at` | | |

Example row: `1, <owner uuid>, wave, null, 5, 0`.

Legal name, books timezone, fiscal year start month and earliest history date are not stored here. They live once in `public.business_profile` (review section 15), which the tax estimator and accounting both read. Accounting functions read the profile through one helper; changing `books_timezone` after any `bank_transactions` row exists is refused.

Replaces: `acct_settings`, `acct_book_preferences`, `acct_authority_events`, `acct_fiscal_years`.

### 1.2 `accounts`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `code` | `text` unique null | Optional numeric code |
| `name` | `text` | Display name, renameable (audited) |
| `type` | `text` check in (`asset`, `liability`, `equity`, `income`, `expense`) | Financial type; cannot change once the account has posted lines |
| `subtype` | `text` | `bank`, `card`, `cash`, `undeposited`, `transit`, `fixed_asset`, `accumulated_depreciation`, `loan`, `payroll_liability`, `owner_equity`, `retained_earnings`, `opening_balance`, `revenue`, `operating_expense`, `payroll_expense`, `uncategorized`, `other` |
| `is_contra` | `boolean` default false | Normal side flipped (accumulated depreciation) |
| `parent_id` | `uuid` → `accounts` null | One level of grouping for reports; no cycles |
| `system_purpose` | `text` unique null | Stable role independent of name: `uncategorized_income`, `uncategorized_expense`, `opening_retained_earnings`, `transfers_in_transit`, `undeposited_funds`, `due_to_shareholder`, `distributions`, `contributions`, `officer_wages`, `employer_payroll_taxes`, `merchant_fees` |
| `external_names` | `jsonb` default `{}` | Original labels from other systems, e.g. `{"wave": "Software Subscriptions"}` |
| `is_archived` | `boolean` default false | Archive only at zero balance; history stays valid |
| `version`, `created_at`, `updated_at` | | |

Example: `Software`, type `expense`, subtype `operating_expense`, parent `Operating expenses`, external_names `{"wave":"Software & Web Hosting"}`.

Replaces: `acct_accounts`, `acct_account_profiles`, `acct_account_lifecycle`.

### 1.3 `journal_entries`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | Stable detail URL id |
| `entry_date` | `date` | The financial date; frozen after posting |
| `memo` | `text` | Editable display name (the "rename") |
| `source_description` | `text` null | Verbatim provider text at draft creation; null for manual entries; immutable |
| `descriptor_key` | `text` null | `accounting.descriptor_key(source_description)`; immutable; indexed |
| `origin` | `text` check in (`manual`, `simplefin`, `csv`, `wave`, `internal`) | Provenance of the entry itself; immutable |
| `kind` | `text` check in (`manual`, `income`, `expense`, `transfer`, `payroll`, `opening`, `owner`, `asset`, `loan`, `refund`, `correction`) | Drives templates, filters and reports |
| `status` | `text` check in (`draft`, `posted`, `discarded`) | Only drafts can be discarded; posted never reverts |
| `payee_id` | `uuid` → `parties` null | |
| `applied_rule_id` | `uuid` → `rules` null | Rule that pre-filled this draft, if any |
| `transfer_group_id` | `uuid` null | Shared by the two entries of a cross-date transfer; no table needed |
| `register_id` | `uuid` → `registers` null | Asset or loan this entry belongs to |
| `import_batch_id` | `uuid` → `import_batches` null | History or bank batch that created it |
| `reverses_entry_id` | `uuid` → `journal_entries` unique null | This entry is the full reversal of that one |
| `replaces_entry_id` | `uuid` → `journal_entries` null | This entry is the corrected replacement of that one |
| `reason` | `text` default `''` | Required for reversals, corrections and exclusions |
| `version`, `created_by`, `created_at`, `posted_at` | | `posted_at` non-null iff status is `posted` |

Frozen after posting: `entry_date`, `status` (except `posted` stays), `origin`, `kind`, `reverses_entry_id`, `replaces_entry_id`, all lines. Always frozen: `source_description`, `descriptor_key`. Editable after posting: `memo`, `payee_id`, `reason`, `register_id`.

Example: `2026-08-14`, memo `Amazon Web Services`, source_description `AMAZON WEB SERVICES AWS.AMAZON.CO 4534`, descriptor_key `AMAZON WEB SERVICES AWS AMAZON CO`, origin `simplefin`, kind `expense`, status `posted`, payee `Amazon Web Services`, applied_rule `AWS monthly`.

Replaces: `acct_journal_entries`, `acct_entry_context`, `acct_entry_corrections`, `acct_transfer_groups`, `acct_annotations`, `acct_journal_templates`, `acct_rule_applications`.

### 1.4 `journal_lines`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `entry_id` | `uuid` → `journal_entries` | Cannot be reparented |
| `account_id` | `uuid` → `accounts` | Archived accounts refuse new lines |
| `amount_cents` | `bigint` check `<> 0` | Debit positive, credit negative |
| `memo` | `text` default `''` | Per-line note (split descriptions) |
| `sort_order` | `smallint` | Unique per entry |
| `cash_class` | `text` null check in (`operating`, `investing`, `financing`, `transfer`) | Override for the cash movements report; derived from the counter-account subtype when null |

Deferred constraint trigger: when the entry is posted, at least two lines, a debit and a credit present, exact sum zero. Immutability trigger: no insert, update or delete on lines of a posted entry.

Replaces: `acct_journal_lines`, `acct_cash_allocations`.

### 1.5 `periods`

| Column | Type | Meaning |
| --- | --- | --- |
| `month` | `date` PK, check day = 1 | One row per calendar month, created on demand |
| `status` | `text` check in (`open`, `locked`) | |
| `locked_at`, `locked_by` | | |
| `close_snapshot` | `jsonb` null | Trial balance, P&L and balance sheet as of lock, with `financial_revision` |
| `reopen_reason` | `text` default `''` | Reopen requires a reason and is audited; the old snapshot stays in the audit row |
| `version` | | |

Posting into or re-dating into a locked month is refused by trigger. Locking refuses while any draft is dated in the month. Locking posts nothing. Year-end filing is a `report_snapshots` row of kind `year_end_package`, not a separate state machine.

Replaces: `acct_periods`, `acct_close_records`, `acct_close_reopens`, `acct_restatement_cases`, `acct_fiscal_years`.

### 1.6 `audit_log` (append-only)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `bigint` identity PK | |
| `at` | `timestamptz` | |
| `actor_user_id` | `uuid` null | Null for workers |
| `actor_kind` | `text` check in (`owner`, `worker`, `system`) | Human and worker are distinguishable |
| `operation_id` | `uuid` | Groups every row touched by one command |
| `table_name`, `row_id` | `text`, `uuid` | |
| `action` | `text` | `insert`, `update`, `post`, `discard`, `reverse`, `correct`, `lock`, `reopen`, `match`, `exclude`, `rule_apply`, `sync`, `import_apply`, `import_cancel`, ... |
| `before`, `after` | `jsonb` | Redacted diffs (no secrets) |
| `reason` | `text` default `''` | |

This is the only history mechanism. "Who undid what and why" for matches, reconciliations, payroll runs, registers, rules and imports is a query over this table. Triggers on every table write here; the audit trigger excludes itself.

Replaces: `acct_audit_log`, `acct_clearing_releases`, `acct_bank_match_releases`, `acct_reconciliation_supersessions`, `acct_payroll_voids`, `acct_register_voids`, `acct_invoice_acceptances`, `acct_history_invalidations`, `acct_history_review_invalidations`, `acct_rule_versions`, `acct_payroll_revisions`, `acct_manual_register_revisions`, `acct_tax_link_versions`, `acct_tax_payment_plan_versions`.

### 1.7 `command_receipts` (append-only)

| Column | Type | Meaning |
| --- | --- | --- |
| `idempotency_key` | `uuid` PK | Supplied by the client per payload |
| `payload_hash` | `text` | Same key with a different payload is refused |
| `actor_user_id` | `uuid` | |
| `result` | `jsonb` | Replayed on retry |
| `created_at` | | Prunable after 90 days |

## 2. Around the ledger

### 2.1 `parties`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `name` | `text` unique | |
| `kind` | `text` check in (`vendor`, `customer`, `both`) | |
| `default_account_id` | `uuid` → `accounts` null | Pre-fills category |
| `is_contractor` | `boolean` default false | The 1099 flag |
| `contractor_classification` | `text` check in (`unknown`, `individual`, `corporation`, `foreign`, `other`) | |
| `documentation_status` | `text` check in (`missing`, `received`, `not_required`) | W-9 on file |
| `notes` | `text` default `''` | |
| `is_archived`, `version`, `created_at`, `updated_at` | | |

No tax ids are stored. The year-end contractor report is a query: posted cash outflows by party where `is_contractor`, excluding card-rail entries, with the threshold for the year applied in the report function.

Replaces: `acct_parties`, `acct_contractor_reviews`.

### 2.2 `payee_aliases`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `party_id` | `uuid` → `parties` | |
| `match_kind` | `text` check in (`key`, `exact`, `prefix`) | `key` matches `descriptor_key` |
| `pattern` | `text` | Unique with `match_kind` |
| `enabled` | `boolean` default true | |
| `created_at`, `created_by` | | |

Created automatically ("remember this descriptor") when the owner assigns a payee to a bank-origin draft.

### 2.3 `bank_connections`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `provider` | `text` check in (`simplefin`) | |
| `name` | `text` | |
| `status` | `text` check in (`active`, `reconnect_required`, `disconnected`) | Disconnect stops sync and keeps evidence |
| `access_url_encrypted` | `text` | AES-GCM under `SIMPLEFIN_ENCRYPTION_KEY`; never returned to the browser |
| `key_version` | `smallint` | |
| `scheduled` | `boolean` default true | |
| `next_sync_at`, `last_success_at`, `last_error` | | Freshness for the UI |
| `lease_run_id`, `lease_until` | | One sync at a time |
| `checkpoint` | `jsonb` default `{}` | Per provider account: last posted timestamp successfully stored |
| `version`, `created_at`, `updated_at` | | |

Sync runs are audit rows (`action = 'sync'`, `after = {accounts, new, pending, errors}`). Request budgets and windows are runtime state inside the worker, not tables.

Replaces: `acct_feed_connections`, `acct_feed_claims`, `acct_feed_secrets`, `acct_feed_runs`, `acct_feed_requests`, `acct_feed_windows`, `acct_feed_gaps`.

### 2.4 `bank_accounts`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `account_id` | `uuid` → `accounts` unique | The ledger account (subtype bank, card or cash) |
| `connection_id` | `uuid` → `bank_connections` null | Null for CSV-only accounts |
| `provider_account_id` | `text` null | Reconnection updates this; history stays |
| `institution`, `mask` | `text` | Display |
| `movement_sign` | `smallint` check in (1, -1) | Normalizes provider sign so `+` always means money into the account |
| `coverage_from` | `date` null | Earliest date the feed or CSVs cover |
| `observed_balance_cents`, `observed_at` | | Latest provider balance, labelled as an observation |
| `is_closed`, `closed_on` | | Closed accounts stay reportable |
| `version`, `created_at`, `updated_at` | | |

Replaces: `acct_feed_accounts`, `acct_feed_identities`.

### 2.5 `bank_transactions` (immutable evidence)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `bank_account_id` | `uuid` → `bank_accounts` | |
| `source` | `text` check in (`simplefin`, `csv`, `wave`) | |
| `external_id` | `text` | Provider id, or a stable row hash for CSV; unique per bank account |
| `posted_date` | `date` | Provider posted timestamp converted once with `settings.books_timezone` |
| `transacted_at` | `timestamptz` null | |
| `amount_cents` | `bigint` | Normalized: positive is money in |
| `description` | `text` | Verbatim provider text; never edited |
| `descriptor_key` | `text` | Indexed |
| `content_hash` | `text` | Detects a provider changing a record |
| `raw_payload` | `jsonb` | The whole provider object |
| `state` | `text` check in (`pending`, `posted`) | Pending never creates drafts; may become posted |
| `review` | `text` check in (`unmatched`, `matched`, `excluded`) | The only mutable processing field besides `state` |
| `excluded_reason` | `text` default `''` | Required when excluded |
| `import_batch_id` | `uuid` → `import_batches` null | For CSV rows |
| `observed_at` | `timestamptz` | |

A movement that arrives twice (feed and CSV, or Wave then feed) attaches as a second `bank_matches` row to the same entry instead of a second observation creating a second draft. Matching before drafting: same account, same amount, date within `transfer_window_days` against existing bank-side lines.

Replaces: `acct_feed_observations`, `acct_feed_import_links`, `acct_statement_items`, `acct_statement_item_sources`, `acct_statement_amendments`, `acct_statement_files`.

### 2.6 `bank_matches`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `bank_transaction_id` | `uuid` → `bank_transactions` | |
| `journal_line_id` | `uuid` → `journal_lines` | The bank-side line |
| `amount_cents` | `bigint` | Usually the full amount; partial allowed for split deposits |
| `created_at`, `created_by` | | Removal is an audited delete with reason |

Constraint: allocations per transaction never exceed its amount; allocations per line never exceed the line. Unique on the pair.

Replaces: `acct_bank_matches`, `acct_bank_match_releases`, `acct_clearing_allocations`, `acct_clearing_releases`, `acct_obligation_reviews`.

### 2.7 `import_batches`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `kind` | `text` check in (`journal`, `bank`) | Wave history and journal CSVs are `journal`; bank CSVs and feed pulls are `bank` |
| `source` | `text` check in (`wave`, `csv`, `simplefin`) | |
| `document_id` | `uuid` → `documents` null | The uploaded file; null for feed pulls |
| `file_hash` | `text` unique null | Identical upload is a no-op |
| `mapping` | `jsonb` | Column map, formats, account map; `mapping_version` inside |
| `status` | `text` check in (`staged`, `applying`, `completed`, `cancelled`) | |
| `row_count`, `applied_count`, `checkpoint` | `integer` | Resumable in chunks |
| `control_totals` | `jsonb` | Source totals for comparison |
| `coverage_from`, `coverage_to` | `date` | |
| `parity_status` | `text` check in (`n/a`, `pending`, `verified`, `mismatch`) | Only `journal` history batches carry parity; bank batches are always `n/a`. Report gates look at `journal` batches only. |
| `version`, `created_by`, `created_at` | | |

Cancelling keeps applied rows and resets unapplied rows to `ready` so nothing disappears from any queue.

Replaces: `acct_import_batches`, `acct_import_comparisons`.

### 2.8 `import_rows`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `batch_id` | `uuid` → `import_batches` | |
| `ordinal` | `integer` | Unique per batch |
| `external_id` | `text` null | Stable source id when the export has one; unique per batch when present |
| `fingerprint` | `text` | Normalized journal-group fingerprint; reordering does not change it |
| `raw` | `jsonb` | The original row or row group, immutable |
| `parsed` | `jsonb` | `{entry_date, memo, lines[]}` proposal |
| `status` | `text` check in (`ready`, `duplicate`, `exception`, `applied`, `excluded`) | |
| `entry_id` | `uuid` → `journal_entries` null | Created or matched entry |
| `duplicate_of_entry_id` | `uuid` → `journal_entries` null | |
| `reason` | `text` default `''` | |

This is the provenance table: every historical entry points back to the exact source row. Comparing two exports of the same scope is a function over two batches' `external_id` and `fingerprint` columns, not a stored capture.

Replaces: `acct_import_groups`, `acct_source_records`, `acct_source_links`, `acct_history_dispositions`.

### 2.9 `history_checks`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `fiscal_year` | `smallint` | |
| `kind` | `text` check in (`annual_totals`, `opening_balances`) | |
| `expected` | `jsonb` | Totals from the Wave report on the same basis |
| `actual` | `jsonb` | Computed from the ledger at check time, with `financial_revision` |
| `difference` | `jsonb` | |
| `status` | `text` check in (`matches`, `explained`, `mismatch`) | |
| `explanation` | `text` default `''` | |
| `document_id` | `uuid` → `documents` | The Wave report |
| `checked_by`, `checked_at` | | |

A later posting dated inside a verified year flips its latest check to `mismatch` by trigger; the old row stays as history.

Replaces: `acct_history_checks`, `acct_retained_reviews`.

### 2.10 `documents`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `storage_path` | `text` unique | Private bucket `accounting-private` |
| `name`, `mime`, `size_bytes` | | Validated by magic bytes on upload |
| `sha256` | `text` | Repeated uploads are detected, not deleted |
| `kind` | `text` check in (`receipt`, `statement`, `payroll_register`, `source_export`, `report`, `other`) | |
| `status` | `text` check in (`inbox`, `linked`, `archived`) | |
| `uploaded_by`, `uploaded_at` | | |

### 2.11 `document_links`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `document_id` | `uuid` → `documents` | |
| `entry_id` | `uuid` → `journal_entries` null | |
| `bank_transaction_id` | `uuid` → `bank_transactions` null | |
| `import_batch_id` | `uuid` → `import_batches` null | |
| `reconciliation_id` | `uuid` → `reconciliations` null | |
| `payroll_run_id` | `uuid` → `payroll_runs` null | |
| `register_id` | `uuid` → `registers` null | |
| `party_id` | `uuid` → `parties` null | |
| `created_at`, `created_by` | | |

Check: exactly one target column is non-null. Attaching a receipt to a posted or locked entry is allowed and changes no amounts.

Replaces: `acct_documents`, `acct_document_links`, `acct_document_states`.

### 2.12 `rules`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `name` | `text` | |
| `priority` | `integer` | Lower runs first; first match wins |
| `enabled` | `boolean` | |
| `conditions` | `jsonb` | `{descriptor_key: {equals|prefix|contains}, bank_account_id?, direction?, amount_min?, amount_max?}` |
| `actions` | `jsonb` | `{account_id, payee_id?, memo?, splits?: [{account_id, share_bps}]}` |
| `auto_post` | `boolean` default false | Off during pilot; per-rule opt-in later |
| `version`, `created_at`, `updated_at` | | |

Rules run when drafts are created (sync or import) and on "apply to history" previews. Which rule filled a draft is `journal_entries.applied_rule_id`; the rule's state at that moment is in the audit row.

Replaces: `acct_rules`, `acct_rule_versions`, `acct_rule_applications`, `acct_payee_aliases` partly (aliases keep the payee half).

### 2.13 `reconciliations` (optional tool)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `bank_account_id` | `uuid` → `bank_accounts` | |
| `statement_start`, `statement_end` | `date` | Independent of calendar months |
| `opening_balance_cents`, `ending_balance_cents` | `bigint` | Normalized sign, as on the statement |
| `document_id` | `uuid` → `documents` null | The statement |
| `status` | `text` check in (`in_progress`, `completed`) | Completed requires zero difference; a note cannot override |
| `difference_cents` | `bigint` | Recomputed on every save |
| `notes` | `text` default `''` | |
| `completed_at`, `version`, `created_at` | | |

A later posting dated inside a completed statement reopens it by trigger and writes an audit row; the old proof is in the audit row. Month lock does not require a reconciliation; the lighter close check compares the book balance to `bank_accounts.observed_balance_cents` and shows the difference.

Replaces: `acct_reconciliations`, `acct_reconciliation_opening`, `acct_reconciliation_supersessions`.

### 2.14 `reconciliation_items`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `reconciliation_id` | `uuid` → `reconciliations` | |
| `journal_line_id` | `uuid` → `journal_lines` | A bank-side line cleared on this statement |
| `amount_cents` | `bigint` | Partial clearing allowed, bounded by the line |
| `created_at` | | |

Unique on `journal_line_id` among in-progress and completed reconciliations of the same account.

### 2.15 `payroll_runs`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `provider` | `text` check in (`patriot`) | |
| `provider_run_id` | `text` unique | |
| `pay_date`, `period_start`, `period_end` | `date` | |
| `gross_cents`, `net_cents`, `employee_withholding_cents`, `employer_tax_cents` | `bigint` | Declared totals; components must reconcile to them |
| `components` | `jsonb` | `[{kind, amount_cents, account_id}]` for withholding, employer tax, retirement, other deductions, reimbursements, fees |
| `entry_id` | `uuid` → `journal_entries` null | The posted payroll entry |
| `document_id` | `uuid` → `documents` null | The register |
| `ytd` | `jsonb` null | Verified year-to-date wages and withholding through `pay_date`, for the tax link |
| `status` | `text` check in (`draft`, `posted`, `void`) | Void reverses the entry and is audited |
| `version`, `created_at`, `created_by` | | |

Cash-basis template: the two Patriot bank debits become one entry per run, net pay to Officer wages, tax deposit to Officer wages (withholding) plus Employer payroll taxes, with the bank transactions matched to the bank lines. No payables, no clearing step. The accrual-style template with liability accounts remains available as an alternative action on the same table if ever wanted.

Replaces: `acct_payroll_runs`, `acct_payroll_revisions`, `acct_payroll_postings`, `acct_payroll_obligations`, `acct_payroll_voids`, `acct_payroll_coverage`.

### 2.16 `registers`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `kind` | `text` check in (`fixed_asset`, `loan`) | |
| `name` | `text` | |
| `account_id` | `uuid` → `accounts` | Asset or liability account |
| `contra_account_id` | `uuid` → `accounts` null | Accumulated depreciation |
| `started_on` | `date` | Acquired or originated |
| `amount_cents` | `bigint` | Cost or original principal |
| `in_service_on` | `date` null | |
| `method` | `text` default `''` | Free text: straight line 5y, lender schedule, section 179 |
| `schedule` | `jsonb` default `[]` | Proposed periodic rows; each becomes a normal entry with `register_id` when posted |
| `status` | `text` check in (`active`, `disposed`, `paid_off`) | |
| `ended_on` | `date` null | |
| `notes`, `version`, `created_at`, `updated_at` | | |

Register balance equals the sum of entries with this `register_id` on its accounts; the register screen shows the difference, and nothing gates the month lock.

Replaces: `acct_manual_registers`, `acct_manual_register_revisions`, `acct_register_movements`, `acct_register_voids`.

### 2.17 `tax_mappings`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tax_year` | `smallint` | Mappings are per year; copy forward on demand |
| `account_id` | `uuid` → `accounts` | Unique with `tax_year` |
| `concept` | `text` | Stable tax concept: `gross_receipts`, `cogs`, `officer_compensation`, `salaries`, `payroll_taxes`, `rent`, `advertising`, `meals_50`, `travel`, `depreciation`, `interest`, `other_deduction`, `nondeductible`, `distribution`, `contribution`, `balance_sheet_only` |
| `deductible_bps` | `integer` default 10000 | 5000 for meals |
| `separately_stated` | `boolean` default false | |
| `notes`, `version`, `updated_at` | | |

### 2.18 `tax_adjustments`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tax_year` | `smallint` | |
| `concept` | `text` | Same vocabulary as mappings, plus `stock_basis_opening`, `debt_basis_opening` |
| `amount_cents` | `bigint` | Signed book-to-tax adjustment |
| `reason` | `text` | |
| `document_id` | `uuid` → `documents` null | |
| `created_at`, `created_by` | | Immutable; correct by adding an offsetting row |

### 2.19 `tax_links`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tax_estimate_id` | `uuid` → `public.tax_estimates` unique | The existing estimator row this feeds |
| `tax_year` | `smallint` | |
| `cutoff_mode` | `text` check in (`today`, `fixed`) | |
| `cutoff_date` | `date` null | |
| `forecast_method` | `text` check in (`manual`, `average_months`, `prior_year_pattern`) | |
| `forecast_inputs` | `jsonb` | Manual forecast, excluded months, prior-year safe-harbor facts |
| `inputs` | `jsonb` | Last computed business inputs (exact cents as strings) |
| `results` | `jsonb` | Last calculator output |
| `financial_revision` | `bigint` | Revision the inputs were computed from; stale when it lags `settings.financial_revision` |
| `status` | `text` check in (`fresh`, `stale`, `error`) | |
| `error`, `computed_at`, `version`, `created_at` | | |

Refresh happens on opening the estimate and from the worker. The payroll year-to-date section reads the latest `payroll_runs.ytd` on or before the cutoff, so a moving cutoff never demands a new attestation. Safe-harbor and installment math is a pure TypeScript function over `forecast_inputs` and the existing Tax Payments page; no plan tables.

Replaces: `acct_tax_links`, `acct_tax_link_versions`, `acct_tax_snapshots`, `acct_tax_jobs`, `acct_tax_years`, `acct_tax_basis`, `acct_tax_payment_plans`, `acct_tax_payment_plan_versions`, `acct_tax_payment_snapshots`.

### 2.20 `report_snapshots` (immutable)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `kind` | `text` check in (`profit_loss`, `balance_sheet`, `trial_balance`, `general_ledger`, `cash_movements`, `year_end_package`, `month_close`) | |
| `params` | `jsonb` | Range, basis, filters, comparison |
| `from_date`, `to_date` | `date` | |
| `financial_revision` | `bigint` | Every part of a package reads one revision |
| `data` | `jsonb` | Exact rows and totals as rendered |
| `document_id` | `uuid` → `documents` null | The PDF, CSV or ZIP |
| `created_at`, `created_by` | | |

Renames and mapping changes never rewrite a snapshot.

## 3. Functions and triggers (target)

Owner write path, one entry point: `accounting.operate(command jsonb) returns jsonb`. Command families: `draft.save`, `entry.post`, `entry.discard`, `entry.reverse`, `entry.correct`, `entry.categorize`, `entry.split`, `transfer.create`, `bank.match`, `bank.exclude`, `bank.sync_request`, `import.create`, `import.stage`, `import.apply`, `import.cancel`, `history.check`, `document.link`, `rule.save`, `rule.apply_preview`, `party.save`, `alias.save`, `reconciliation.save`, `reconciliation.complete`, `period.lock`, `period.reopen`, `payroll.save`, `payroll.post`, `register.save`, `tax.mapping.save`, `tax.adjustment.save`, `tax.link.save`, `report.capture`, `settings.save`. Every command: owner check, idempotency receipt, settings-row lock, expected-version check, audit rows under one `operation_id`, `financial_revision` bump when report-relevant.

Owner reads: `workspace(from, to)`, `transactions(filter, page)`, `entry_detail(id)`, `prior_treatment(descriptor_key, bank_account_id, limit)`, `bank_review()`, `imports(batch?)`, `import_compare(batch_a, batch_b)`, `report(kind, params)`, `report_lines(kind, params, account)`, `ledger(account, from, to)`, `close_checklist(month)`, `documents(filter)`, `payroll(view)`, `registers()`, `contractor_report(year)`, `tax_source(year, cutoff)`, `tax_link(id)`.

Worker (service role only, bearer-secret gated at the route): `sync_server(command)` for bank feeds, `tax_refresh_server(command)`.

Helpers: `descriptor_key(text)`, `require_owner()`, `write_lock()`, `require_open(date)`.

Triggers: settings-row write lock (statement level on entries and lines), entry guard (freeze after post, period check on old and new dates), line guard (no writes under posted entries, no reparent, archived-account block), deferred balance check, audit on every table, bank_transactions immutability (only `state`, `review`, `excluded_reason` may change), bank_matches bounds, reconciliation reopen on later posting, history_checks mismatch on later posting, `financial_revision` bump.

About 30 functions and 10 triggers, down from 207 and 104.

## 4. Scenarios (each answered by naming the rows written)

1. **A SimpleFIN transaction arrives overnight.** Cron calls the sync route. `sync_server` pulls posted rows since `bank_connections.checkpoint`, inserts `bank_transactions` (raw description, payload, `descriptor_key`), skips pending ones, looks for an existing bank-side line with the same account, amount and a date inside the window. None found, so it inserts a `journal_entries` draft (memo and `source_description` from the descriptor, origin `simplefin`, kind by sign) with two `journal_lines` (bank line, counter line to `uncategorized_expense`), a `bank_matches` row, runs `rules` and sets `applied_rule_id` when one matches, then updates `checkpoint`, `last_success_at` and writes one audit row for the run. You log in and Needs review shows it.
2. **You categorize it, rename it, and later ask how you treated this payee before.** `entry.categorize` rewrites the counter line's `account_id`, sets `payee_id` and `memo`, offers to save a `payee_aliases` row keyed by `descriptor_key`. `entry.post` freezes lines and date. Later, `prior_treatment(descriptor_key, bank_account_id)` returns the posted entries with that key: memo, payee, category, split pattern, count, last date. The same function pre-fills the next draft with that key and is what an AI calls.
3. **You split a purchase across two categories.** `entry.split` replaces the counter line with two lines whose cents sum exactly to the bank line, largest-remainder rounding, stable order. Still one entry, one `bank_matches` row.
4. **A payment from checking to the card, and a refund on the card.** Two `bank_transactions` arrive on different days. The card side drafts first as a transfer candidate; when the checking side arrives inside the window, `transfer.create` builds two entries sharing `transfer_group_id` through `transfers_in_transit`, each on its own bank date, each matched to its observation. Same-day transfers make one entry with two bank lines. The refund is a `bank_transactions` row with positive amount on the card account; `entry.categorize` with kind `refund` credits the original expense account, and `reason` links the original entry.
5. **Patriot debits net pay and taxes.** Two `bank_transactions` arrive. `payroll.save` records the run from the register (document linked), `payroll.post` creates one entry dated on the pay date: debit Officer wages for gross, debit Employer payroll taxes, credit checking for net pay, credit checking for the tax deposit, matched to both observations. `ytd` on the run feeds the tax link.
6. **You attach a receipt.** Upload creates `documents` (hash, magic-byte check) in the private bucket; drop on a row creates `document_links.entry_id`. Works on posted and locked entries; amounts untouched.
7. **Wave history for 2023 is imported and later re-exported with one changed row.** `import.create` stores the file as a `documents` row and an `import_batches` row (kind `journal`, source `wave`, `file_hash`). `import.stage` parses into `import_rows` (raw, parsed, fingerprint, external id). `import.apply` creates posted entries at their original dates with `import_batch_id` and links each `import_rows.entry_id`. `history.check` records the annual totals against the Wave P&L. The second export is a new batch; `import_compare` reports unchanged, new, changed and missing by external id and fingerprint; the changed row is applied as `entry.correct` (reversal plus replacement) with a reason, never an overwrite.
8. **You lock August and run the P&L and Balance Sheet for the year.** `close_checklist('2026-08-01')` checks: no drafts dated in August, book balance per bank account versus `observed_balance_cents` with the difference shown, any `history_checks` mismatch inside the year. `period.lock` writes `close_snapshot` and status `locked`; posts nothing. `report('profit_loss', {from: 2026-01-01, to: 2026-12-31})` aggregates posted lines by account and parent; `report('balance_sheet', {as_of})` asserts assets equal liabilities plus equity with retained earnings computed from prior years and current-year income shown separately. `report.capture` stores a `report_snapshots` row with the PDF.
9. **A future AI asks for every transaction with the same descriptor and its history.** `transactions({descriptor_key})` plus `prior_treatment` plus `entry_detail` (lines, matches, documents, audit rows by `operation_id`). No fuzzy matching; exact keys and exact history.

## 5. What is removed from the current build (and where it went)

| Removed | Reason | Replacement |
| --- | --- | --- |
| Invoice mirror, settlements, customer funds, inbox, sync (16 tables, 9 UI files, the app-side lifecycle migration and transport rewrite) | `app` owns invoicing; cash basis recognizes the deposit; the HTTP boundary does not exist in a shared database | Later, if wanted: 2 tables reading `public.invoice_accounting_versions` directly |
| Authority and readiness gate | Inert beyond disabling two inputs | `settings.primary_system` and `primary_system_since`, audited |
| Recovery runner, events, alerts | Unproven on hosted Supabase; needs a private host | Ops task: scheduled `pg_dump --schema=accounting` plus bucket sync; a status line reads the audit log |
| Import comparison captures and history | A diff is a query | `import_compare()` function |
| Retained-earnings review, history invalidations | One-time scaffolding | `history_checks` rows |
| Statement amendments, item sources, statement files, reconciliation supersessions, restatement cases, obligation reviews, clearing allocations and releases | Reconciliation is optional; supersession is an audit row; clearing is unnecessary on cash-basis payroll | `reconciliations`, `reconciliation_items`, `audit_log` |
| Payroll obligations, postings, voids, revisions, coverage | Cash-basis template needs no liabilities | `payroll_runs` |
| Register movements, voids, revisions, loan schedule import | Movements are entries | `registers.schedule` and `journal_entries.register_id` |
| Contractor reviews | Per-transaction review queue is unusable | `parties.is_contractor` plus `contractor_report(year)` |
| Tax payment plans, plan versions, payment snapshots, tax years, tax basis, link versions, jobs, snapshots | Three tables and a snapshot fence for 60 lines of math | `tax_links` columns and a pure function |
| Book preferences, annotations, journal templates, saved views, dimensions, account profiles, account lifecycle, entry context | Columns on the owning table | `settings`, `accounts`, `journal_entries` |
| Eight undo tables, five version tables | One audit log | `audit_log` |
| Feed claims, secrets, requests, runs, windows, gaps, identities, import links | Runtime state and columns | `bank_connections`, `bank_accounts`, `bank_transactions` |
| `acct_command`, `acct_execute`, `acct_operate` | Three dispatchers | `operate` |
| `acct_workspace` and `acct_report` as separate engines | Two report engines | one `report` |
| `accounting-register.tsx`, the overview view | Dead | |

## 6. What survives the port unchanged or nearly so

`money.ts` (BigInt cents, parsing, largest-remainder allocation), `imports/csv.ts` (parsing, fingerprints, journal and bank group builders), `server/simplefin-transport.ts` and `simplefin-data.ts` (after the v1 envelope and timezone fixes), `server/document-storage.ts`, `report-model.ts` (rendering), `server/report-pdf.tsx`, `books-package-zip.ts`, the `AccountingPicker`, the Transactions list and editor, Reports hub and detail, Chart of accounts, Rules, Transfers, Documents, the PGlite test harness in `scripts/accounting-test-db.ts`, and every hard-coded expected value in the verify scripts that concerns the ledger, imports, feeds, reports and close. The verify scripts are ported by keeping their assertions and re-pointing setup at the new tables; a suite that only tested a removed feature is archived with it.

## 7. Delivery rules for the port

1. Migrations: seven files in `admin/supabase/migrations/`, one per domain, in the `accounting` schema, applied fresh. First a migration that drops `public.acct_*` after asserting `acct_journal_entries` and `acct_settings` are empty. The 36 existing files move to `admin/supabase/migrations/archive/accounting/`. `schema.sql` is regenerated from the applied result and `verify-accounting-schema.ts` keeps parity.
2. Supabase: add `accounting` to the API exposed schemas; `GRANT USAGE ON SCHEMA accounting TO authenticated, service_role`; revoke everything from `anon`; grant execute on owner functions to `authenticated` and on the two worker functions to `service_role` only. The app client factory in `access.ts` becomes `client.schema("accounting")`.
3. Every scenario in section 4 becomes a verify script with hard-coded expected cents, row counts and error codes, exercised through `operate` and the read functions against PGlite. Existing negative-path assertions (stale version, idempotency conflict, locked period, direct table write refused as `authenticated`, unbalanced post refused) are kept.
4. No `pg_get_functiondef` patching. A function is defined once, in full, in its domain file.
5. Names, not prefixes: `accounting.journal_entries`, never `accounting.acct_journal_entries`.
6. Nothing here changes the UI's design language. The Transactions, Reports, Accounts, Month end and More navigation from the review applies on top.
