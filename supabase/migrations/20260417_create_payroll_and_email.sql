-- Migration: Create payroll + email-accounts features
-- Creates 12 tables + triggers + RLS policies + 2026 seed data.
--
-- Email:
--   email_accounts           SMTP accounts with AES-256-GCM-encrypted passwords
--
-- Payroll tables:
--   organization_config      singleton: legal entity info for forms/headers
--   federal_tax_configs      per-year IRS config (brackets, FICA, FUTA, std deductions)
--   state_tax_configs        per-(state, year) polymorphic config
--   config_change_history    audit log for config edits
--   payroll_employees        employee roster with W-4 + state elections + encrypted SSN
--   payroll_runs             pay run ledger with immutable snapshots at finalize
--   payroll_run_history      event-sourced audit trail (trigger-driven)
--   payroll_tax_deposits     federal/state deposit tracking
--   payroll_deposit_history  event-sourced audit trail for deposits (trigger-driven)
--   payroll_forms            generated tax forms (941, 940, W-2, W-3, EFW2, A-1-QRT/APR)
--   payroll_audit_events     append-only log for sensitive actions (SSN reveals, rate-limit denials)
--
-- Immutability contract: finalized rows in payroll_runs snapshot their
-- employee + tax configs into the row. Editing configs after finalize never
-- retroactively changes past runs. Corrections use reverses_run_id, never
-- mutate the original.
--
-- SSN storage: payroll_employees.ssn_encrypted holds AES-256-GCM ciphertext
-- produced by src/lib/crypto/ssn.ts using AES_ENCRYPTION_KEY env var.
-- Legacy format: iv_hex:tag_hex:cipher_hex. v2+ format: v<N>:iv_hex:tag_hex:cipher_hex.
--
-- SMTP storage: email_accounts.encrypted_password holds AES-256-GCM ciphertext
-- produced by src/lib/email/crypto.ts using SMTP_ENCRYPTION_KEY env var.
-- Format: iv_hex:tag_hex:cipher_hex.

-- ============================================================================
-- TABLE 0: email_accounts
-- Referenced (unconstrained) by organization_config.default_email_account_id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label               TEXT NOT NULL,
  host                TEXT NOT NULL,
  port                INTEGER NOT NULL DEFAULT 465,
  secure              BOOLEAN NOT NULL DEFAULT TRUE,
  username            TEXT NOT NULL,
  encrypted_password  TEXT NOT NULL,
  from_name           TEXT NOT NULL,
  from_email          TEXT NOT NULL,
  reply_to            TEXT,
  is_default          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_username_host_unique
  ON email_accounts (LOWER(username), LOWER(host));

CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_single_default
  ON email_accounts (is_default) WHERE is_default = TRUE;

CREATE TRIGGER email_accounts_updated_at
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_accounts_all ON email_accounts
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

COMMENT ON TABLE  email_accounts IS 'SMTP accounts used for outbound mail. Passwords are AES-256-GCM encrypted.';
COMMENT ON COLUMN email_accounts.encrypted_password IS 'AES-256-GCM ciphertext in iv_hex:tag_hex:cipher_hex format, keyed on SMTP_ENCRYPTION_KEY.';
COMMENT ON COLUMN email_accounts.is_default IS 'Exactly one row may have is_default=TRUE (enforced by partial unique index).';

-- ============================================================================
-- TABLE 1: organization_config (singleton)
-- ============================================================================

CREATE TABLE IF NOT EXISTS organization_config (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name                 VARCHAR(200) NOT NULL,
  fein                       VARCHAR(10)  NOT NULL,
  state_tax_id               VARCHAR(50),
  state_ui_id                VARCHAR(50),
  address                    JSONB NOT NULL DEFAULT '{}',
  signer_name                VARCHAR(200) NOT NULL,
  signer_title               VARCHAR(100),
  phone                      VARCHAR(30),
  email                      VARCHAR(200),
  accountant_email           VARCHAR(200),
  default_email_account_id   VARCHAR(100),
  federal_deposit_schedule   VARCHAR(20) NOT NULL DEFAULT 'monthly'
                               CHECK (federal_deposit_schedule IN ('monthly', 'semiweekly')),
  state_deposit_schedule     VARCHAR(20) NOT NULL DEFAULT 'monthly'
                               CHECK (state_deposit_schedule IN ('quarterly', 'monthly', 'semiweekly')),
  deleted_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_config_singleton_idx
  ON organization_config ((1))
  WHERE deleted_at IS NULL;

CREATE TRIGGER organization_config_updated_at
  BEFORE UPDATE ON organization_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  organization_config IS 'Singleton row: legal entity info used on forms and in headers.';
COMMENT ON COLUMN organization_config.fein IS 'Federal EIN, "XX-XXXXXXX" (9 digits + dash).';
COMMENT ON COLUMN organization_config.address IS '{line1, line2?, city, state, zip}';
COMMENT ON COLUMN organization_config.default_email_account_id IS 'Optional FK-like reference to email_accounts.id (unconstrained to allow soft deletes).';
COMMENT ON COLUMN organization_config.federal_deposit_schedule IS
  'IRS Form 941 deposit frequency. Monthly: deposits due by the 15th of the following month. Semiweekly: Wed/Thu/Fri paydays due by Wednesday, Sat/Sun/Mon/Tue paydays due by Friday.';
COMMENT ON COLUMN organization_config.state_deposit_schedule IS
  'State withholding deposit frequency. For AZ, based on quarterly withholding thresholds per A1-WP instructions.';

-- ============================================================================
-- TABLE 2: federal_tax_configs
-- ============================================================================

CREATE TABLE IF NOT EXISTS federal_tax_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year        INTEGER NOT NULL,
  brackets        JSONB NOT NULL,
  fica            JSONB NOT NULL,
  futa            JSONB NOT NULL,
  std_deductions  JSONB NOT NULL,
  version_hash    VARCHAR(64) NOT NULL,
  notes           TEXT,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS federal_tax_configs_year_unique
  ON federal_tax_configs(tax_year)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_federal_tax_configs_year
  ON federal_tax_configs(tax_year DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER federal_tax_configs_updated_at
  BEFORE UPDATE ON federal_tax_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  federal_tax_configs IS 'Per-year IRS config: brackets (Pub 15-T), FICA, FUTA, standard deductions.';
COMMENT ON COLUMN federal_tax_configs.brackets IS 'Pub 15-T percentage method tables keyed by filing_status and period.';
COMMENT ON COLUMN federal_tax_configs.fica IS '{ss_rate, ss_wage_base, medicare_rate, additional_medicare_threshold, additional_medicare_rate}';
COMMENT ON COLUMN federal_tax_configs.futa IS '{rate, wage_base}';
COMMENT ON COLUMN federal_tax_configs.std_deductions IS '{single, mfj, mfs, hoh}';
COMMENT ON COLUMN federal_tax_configs.version_hash IS 'SHA-256 of normalized JSON fingerprint; audit integrity check.';

-- ============================================================================
-- TABLE 3: state_tax_configs
-- ============================================================================

CREATE TABLE IF NOT EXISTS state_tax_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code          VARCHAR(2) NOT NULL,
  tax_year            INTEGER NOT NULL,
  calculation_method  VARCHAR(30) NOT NULL
                        CHECK (calculation_method IN ('none', 'flat', 'flat_employee_elected', 'progressive', 'custom')),
  config              JSONB NOT NULL DEFAULT '{}',
  sdi_config          JSONB NOT NULL DEFAULT '{}',
  suta_config         JSONB NOT NULL DEFAULT '{}',
  -- Per-deposit-type payment portal metadata (URL, agency, form, steps).
  -- Keyed by deposit_type (state_withholding/state_suta/state_sdi). Drives
  -- the data-driven "Pay at [portal]" links in the deposits UI.
  payment_portals     JSONB NOT NULL DEFAULT '{}',
  version_hash        VARCHAR(64) NOT NULL,
  notes               TEXT,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS state_tax_configs_state_year_unique
  ON state_tax_configs(state_code, tax_year)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_state_tax_configs_lookup
  ON state_tax_configs(state_code, tax_year DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER state_tax_configs_updated_at
  BEFORE UPDATE ON state_tax_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  state_tax_configs IS 'Per-(state, year) polymorphic config. Shape of config depends on calculation_method.';
COMMENT ON COLUMN state_tax_configs.calculation_method IS 'Dispatcher: none | flat | flat_employee_elected (AZ) | progressive | custom.';
COMMENT ON COLUMN state_tax_configs.config IS 'Shape depends on calculation_method. See src/lib/payroll/state/.';
COMMENT ON COLUMN state_tax_configs.sdi_config IS '{rate, wage_base, side} (empty object if state has no SDI).';
COMMENT ON COLUMN state_tax_configs.suta_config IS '{newEmployerRate, wageBase, rangeMin, rangeMax, formsDue[]}';
COMMENT ON COLUMN state_tax_configs.payment_portals IS 'Per-deposit-type payment portal metadata (URL, agency, form, steps) keyed by state_withholding/state_suta/state_sdi. Drives the "Pay at [portal]" deep links in the deposits UI.';

-- ============================================================================
-- TABLE 4: config_change_history
-- ============================================================================

CREATE TABLE IF NOT EXISTS config_change_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_type     VARCHAR(30) NOT NULL
                    CHECK (config_type IN ('organization', 'federal', 'state')),
  config_id       UUID NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_values      JSONB,
  new_values      JSONB,
  change_summary  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_change_history_ref
  ON config_change_history(config_type, config_id, changed_at DESC);

COMMENT ON TABLE config_change_history IS 'Audit log: every edit to organization_config, federal_tax_configs, or state_tax_configs writes a row here. Written from the client via an explicit call, not a trigger, so the change_summary can carry UI context.';

-- ============================================================================
-- TABLE 5: payroll_employees
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_employees (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  first_name             VARCHAR(100) NOT NULL,
  last_name              VARCHAR(100) NOT NULL,
  email                  VARCHAR(200),
  phone                  VARCHAR(30),
  address                JSONB NOT NULL DEFAULT '{}',
  ssn_encrypted          TEXT,
  ssn_key_version        SMALLINT,

  -- Employment
  employment_type        VARCHAR(10) NOT NULL DEFAULT 'w2'
                           CHECK (employment_type IN ('w2', '1099')),
  hire_date              DATE NOT NULL,
  termination_date       DATE,
  status                 VARCHAR(20) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'terminated')),

  -- Compensation
  pay_amount             NUMERIC(12,2) NOT NULL,
  pay_frequency          VARCHAR(20) NOT NULL
                           CHECK (pay_frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly', 'annual')),
  pay_anchor_date        DATE NOT NULL,
  semimonthly_days       JSONB,
  monthly_day            INTEGER
                           CHECK (monthly_day IS NULL OR monthly_day BETWEEN 1 AND 31),
  pay_lag_days           INTEGER NOT NULL DEFAULT 0,
  target_annual_comp     NUMERIC(12,2),

  -- Federal W-4
  w4_filing_status       VARCHAR(20) NOT NULL DEFAULT 'single'
                           CHECK (w4_filing_status IN ('single', 'mfj', 'mfs', 'hoh')),
  w4_multiple_jobs       BOOLEAN NOT NULL DEFAULT false,
  w4_exempt              BOOLEAN NOT NULL DEFAULT false,
  w4_dependents_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  w4_other_income        NUMERIC(10,2) NOT NULL DEFAULT 0,
  w4_deductions          NUMERIC(10,2) NOT NULL DEFAULT 0,
  w4_extra_withholding   NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- State withholding
  state_code             VARCHAR(2) NOT NULL,
  state_config           JSONB NOT NULL DEFAULT '{}',

  notes                  TEXT,
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payroll_employees_ssn_key_version_chk CHECK (
    (ssn_encrypted IS NULL AND ssn_key_version IS NULL)
    OR (ssn_encrypted IS NOT NULL AND ssn_key_version IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_status
  ON payroll_employees(status, last_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_pay_anchor
  ON payroll_employees(pay_anchor_date)
  WHERE deleted_at IS NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_payroll_employees_ssn_key_version
  ON payroll_employees(ssn_key_version)
  WHERE ssn_encrypted IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER payroll_employees_updated_at
  BEFORE UPDATE ON payroll_employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  payroll_employees IS 'Employee roster. W-4 + state elections + pay schedule anchor.';
COMMENT ON COLUMN payroll_employees.ssn_encrypted IS 'AES-256-GCM via AES_ENCRYPTION_KEY. Legacy format: iv_hex:tag_hex:cipher_hex. v2+ format: v<N>:iv_hex:tag_hex:cipher_hex.';
COMMENT ON COLUMN payroll_employees.ssn_key_version IS 'AES key version used to encrypt ssn_encrypted. Null when ssn_encrypted is null. 1 = AES_ENCRYPTION_KEY, 2 = AES_ENCRYPTION_KEY_V2, etc.';
COMMENT ON COLUMN payroll_employees.w4_exempt IS 'True when the employee has claimed "Exempt" on Form W-4. Federal income tax withholding is zeroed for both regular and supplemental runs. FICA and FUTA still apply. An exempt claim expires Feb 15 of the following year per IRS rules; the admin must collect a fresh W-4 to keep it.';
COMMENT ON COLUMN payroll_employees.pay_amount IS 'Dollars per pay_frequency period (weekly/biweekly/semimonthly/monthly) or annual salary when frequency=annual.';
COMMENT ON COLUMN payroll_employees.pay_anchor_date IS 'Reference pay date. schedule.ts computes all subsequent pay dates from this.';
COMMENT ON COLUMN payroll_employees.semimonthly_days IS 'E.g. [15, 30] or [1, 15]. Null unless pay_frequency=semimonthly.';
COMMENT ON COLUMN payroll_employees.monthly_day IS 'Day of month 1-31. Null unless pay_frequency=monthly. If > days-in-month the schedule rolls back to last day.';
COMMENT ON COLUMN payroll_employees.pay_lag_days IS 'Days between period end and pay date (e.g. 5 = paid 5 days after the period closes).';
COMMENT ON COLUMN payroll_employees.target_annual_comp IS 'Optional S Corp reasonable-comp benchmark used by the progress widget.';
COMMENT ON COLUMN payroll_employees.state_config IS 'Polymorphic. For AZ: {rate: 0.020, dependents: 0}. Shape matches state_tax_configs.calculation_method.';

-- ============================================================================
-- TABLE 6: payroll_runs (the ledger)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id                  UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE RESTRICT,

  run_type                     VARCHAR(20) NOT NULL DEFAULT 'regular'
                                 CHECK (run_type IN ('regular', 'off_cycle', 'correction')),
  status                       VARCHAR(20) NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'finalized', 'paid', 'voided')),

  -- Period
  period_start                 DATE NOT NULL,
  period_end                   DATE NOT NULL,
  pay_date                     DATE NOT NULL,

  -- Gross + employee withholdings
  gross_pay                    NUMERIC(12,2) NOT NULL,
  federal_income_tax           NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_income_tax             NUMERIC(12,2) NOT NULL DEFAULT 0,
  social_security_employee     NUMERIC(12,2) NOT NULL DEFAULT 0,
  medicare_employee            NUMERIC(12,2) NOT NULL DEFAULT 0,
  additional_medicare          NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_disability_employee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_withholdings           JSONB NOT NULL DEFAULT '[]',
  net_pay                      NUMERIC(12,2) NOT NULL,

  -- Taxable wage bases (persisted for 941 / W-2 precision)
  social_security_wages        NUMERIC(12,2) NOT NULL DEFAULT 0,
  medicare_wages               NUMERIC(12,2) NOT NULL DEFAULT 0,
  additional_medicare_wages    NUMERIC(12,2) NOT NULL DEFAULT 0,
  futa_wages                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  suta_wages                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_taxable_wages          NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Employer liabilities
  social_security_employer     NUMERIC(12,2) NOT NULL DEFAULT 0,
  medicare_employer            NUMERIC(12,2) NOT NULL DEFAULT 0,
  futa                         NUMERIC(12,2) NOT NULL DEFAULT 0,
  suta                         NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_disability_employer    NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- YTD-staleness flag (set by voidRun when an upstream void invalidates
  -- cap/threshold math stored on this row)
  ytd_stale                    BOOLEAN NOT NULL DEFAULT FALSE,
  ytd_stale_reason             TEXT,

  -- Immutable snapshots taken at finalize time
  employee_snapshot            JSONB,
  federal_config_snapshot      JSONB,
  state_config_snapshot        JSONB,
  organization_snapshot        JSONB,

  -- Finalization / payment
  finalized_at                 TIMESTAMPTZ,
  paid_at                      TIMESTAMPTZ,
  payment_method               VARCHAR(50),
  payment_reference            VARCHAR(200),

  -- Pay stub email delivery (AZ ARS § 23-351(D): written itemized earnings
  -- statement required each pay period). NULL = never sent; UI surfaces a
  -- "Resend stub" action in that case.
  stub_sent_at                 TIMESTAMPTZ,

  -- Void / correction
  reverses_run_id              UUID REFERENCES payroll_runs(id) ON DELETE RESTRICT,
  void_reason                  TEXT,

  notes                        TEXT,
  deleted_at                   TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payroll_runs_period_valid  CHECK (period_end >= period_start),
  CONSTRAINT payroll_runs_pay_date_valid CHECK (pay_date >= period_end)
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_employee
  ON payroll_runs(employee_id, pay_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_pay_date
  ON payroll_runs(pay_date DESC, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_status
  ON payroll_runs(status, pay_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_reverses
  ON payroll_runs(reverses_run_id)
  WHERE reverses_run_id IS NOT NULL;

-- Enforce one non-voided run per (employee, run_type, period). Voided and
-- soft-deleted rows are excluded so corrections remain possible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_unique_period
  ON payroll_runs(employee_id, run_type, period_start, period_end)
  WHERE deleted_at IS NULL AND status <> 'voided';

-- Partial lookup for the dashboard "runs needing correction" count.
CREATE INDEX IF NOT EXISTS idx_payroll_runs_ytd_stale
  ON payroll_runs(employee_id, pay_date)
  WHERE ytd_stale = TRUE AND deleted_at IS NULL;

CREATE TRIGGER payroll_runs_updated_at
  BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  payroll_runs IS 'Pay run ledger. Finalized rows are immutable; corrections use reverses_run_id.';
COMMENT ON COLUMN payroll_runs.run_type IS 'regular: scheduled. off_cycle: bonus/supplemental (22% flat fed). correction: reverser row.';
COMMENT ON COLUMN payroll_runs.status IS 'draft: previewable and editable. finalized: snapshots taken, locked. paid: bank transfer confirmed. voided: superseded by reverser.';
COMMENT ON COLUMN payroll_runs.employee_snapshot IS 'Full employee row at finalize time. Source of truth for historical re-rendering of paystubs.';
COMMENT ON COLUMN payroll_runs.reverses_run_id IS 'If set, this run cancels out the referenced run. The original is never mutated.';
COMMENT ON COLUMN payroll_runs.social_security_wages IS 'Taxable wages subject to Social Security (capped at SS wage base). Feeds 941 Line 5a and W-2 Box 3.';
COMMENT ON COLUMN payroll_runs.medicare_wages IS 'Taxable wages subject to Medicare (no cap). Feeds 941 Line 5c and W-2 Box 5.';
COMMENT ON COLUMN payroll_runs.additional_medicare_wages IS 'Portion of Medicare wages above the $200k YTD threshold. Feeds 941 Line 5d.';
COMMENT ON COLUMN payroll_runs.futa_wages IS 'Taxable wages subject to FUTA (capped at $7,000 YTD per employee). Feeds 940 Line 3 / Line 5.';
COMMENT ON COLUMN payroll_runs.suta_wages IS 'Taxable wages subject to state unemployment (state-specific cap). Feeds state UC filings.';
COMMENT ON COLUMN payroll_runs.state_taxable_wages IS 'Taxable wages subject to state income tax (gross - pre-tax 401(k) - pre-tax Section 125 for conforming states like AZ). Feeds W-2 Box 16 and W-3 aggregate. Zero on runs finalized before 2026-04-19; aggregator falls back to Box 1.';
COMMENT ON COLUMN payroll_runs.ytd_stale IS 'True when an upstream run was voided after this run finalized, so the stored YTD-dependent values (FICA caps, Additional Medicare, FUTA cap, supplemental thresholds) were computed against wages that no longer apply.';
COMMENT ON COLUMN payroll_runs.ytd_stale_reason IS 'Human-readable explanation of why ytd_stale is set. Typically identifies the upstream run id and void date.';
COMMENT ON COLUMN payroll_runs.stub_sent_at IS 'Timestamp of the most recent successful pay stub email. NULL means the stub has not yet been delivered; the run detail page shows a "Resend stub" action in that case.';

-- ============================================================================
-- TABLE 7: payroll_run_history (event-sourced audit)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_run_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  event_type   VARCHAR(30) NOT NULL
                 CHECK (event_type IN ('created', 'updated', 'finalized', 'paid', 'voided', 'deleted', 'restored')),
  status       VARCHAR(20) NOT NULL,
  gross_pay    NUMERIC(12,2) NOT NULL,
  net_pay      NUMERIC(12,2) NOT NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes        TEXT,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_run_history_run
  ON payroll_run_history(run_id, changed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_run_history_event
  ON payroll_run_history(run_id, event_type, changed_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE  payroll_run_history IS 'Event-sourced audit trail mirroring expense_history pattern.';
COMMENT ON COLUMN payroll_run_history.event_type IS 'Lifecycle event: created | updated | finalized | paid | voided | deleted | restored.';

-- ============================================================================
-- record_payroll_run_history() trigger
-- Mirrors record_expense_history() structure.
-- ============================================================================

CREATE OR REPLACE FUNCTION record_payroll_run_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
    VALUES (NEW.id, 'created', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run created');
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Soft delete
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
      VALUES (NEW.id, 'deleted', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run soft-deleted');
      RETURN NEW;
    END IF;

    -- Restore from trash
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
      VALUES (NEW.id, 'restored', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run restored from trash');
      RETURN NEW;
    END IF;

    -- Status transitions
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'finalized' THEN
        INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
        VALUES (NEW.id, 'finalized', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run finalized (snapshots taken)');
        RETURN NEW;
      ELSIF NEW.status = 'paid' THEN
        INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
        VALUES (NEW.id, 'paid', NEW.status, NEW.gross_pay, NEW.net_pay, 'Marked paid');
        RETURN NEW;
      ELSIF NEW.status = 'voided' THEN
        INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
        VALUES (NEW.id, 'voided', NEW.status, NEW.gross_pay, NEW.net_pay, COALESCE(NEW.void_reason, 'Run voided'));
        RETURN NEW;
      END IF;
    END IF;

    -- Plain data updates (only meaningful for drafts; finalized rows should not change numbers)
    IF OLD.gross_pay IS DISTINCT FROM NEW.gross_pay OR OLD.net_pay IS DISTINCT FROM NEW.net_pay THEN
      INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
      VALUES (NEW.id, 'updated', NEW.status, NEW.gross_pay, NEW.net_pay, 'Amounts updated');
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_run_history_on_insert
  AFTER INSERT ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION record_payroll_run_history();

CREATE TRIGGER payroll_run_history_on_update
  AFTER UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION record_payroll_run_history();

-- ============================================================================
-- TABLE 8: payroll_tax_deposits
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_tax_deposits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_type         VARCHAR(30) NOT NULL
                         CHECK (deposit_type IN ('federal_941', 'federal_940', 'state_withholding', 'state_suta', 'state_sdi')),
  period_start         DATE NOT NULL,
  period_end           DATE NOT NULL,
  due_date             DATE NOT NULL,
  amount               NUMERIC(12,2) NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'paid', 'late')),
  paid_at              TIMESTAMPTZ,
  payment_reference    VARCHAR(200),
  included_run_ids     UUID[] NOT NULL DEFAULT '{}',
  notes                TEXT,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payroll_tax_deposits_period_valid CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_payroll_tax_deposits_due
  ON payroll_tax_deposits(due_date, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_tax_deposits_type
  ON payroll_tax_deposits(deposit_type, period_end DESC)
  WHERE deleted_at IS NULL;

-- Only one active scheduled/late deposit per (type, period). Paid rows are
-- excluded: once a bucket is paid, any new liability in the same period
-- opens a new scheduled row for the delta.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_tax_deposits_active_bucket_uidx
  ON payroll_tax_deposits (deposit_type, period_end)
  WHERE status <> 'paid' AND deleted_at IS NULL;

CREATE TRIGGER payroll_tax_deposits_updated_at
  BEFORE UPDATE ON payroll_tax_deposits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  payroll_tax_deposits IS 'Generated by the run-finalize flow. Tracks 941/940/state deposits with due dates.';
COMMENT ON COLUMN payroll_tax_deposits.included_run_ids IS 'payroll_runs.id values rolled into this deposit (for audit trace).';

-- Atomic upsert RPC: adds p_run_id to the active bucket (creating the row
-- if absent) and re-aggregates amount from every included run. Safe under
-- concurrent calls: the partial unique index serialises conflicting inserts
-- and the follow-up UPDATE runs in the same transaction. The per-type
-- aggregation mirrors lib/payroll/deposits-actions.ts contributionForBucket.
-- Keep these in sync when deposit types change.
CREATE OR REPLACE FUNCTION upsert_payroll_tax_deposit_run(
  p_deposit_type   TEXT,
  p_period_start   DATE,
  p_period_end     DATE,
  p_due_date       DATE,
  p_run_id         UUID,
  p_notes          TEXT
)
RETURNS UUID
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO payroll_tax_deposits (
    deposit_type, period_start, period_end, due_date,
    amount, status, included_run_ids, notes
  )
  VALUES (
    p_deposit_type, p_period_start, p_period_end, p_due_date,
    0, 'scheduled', ARRAY[p_run_id], p_notes
  )
  ON CONFLICT (deposit_type, period_end)
    WHERE status <> 'paid' AND deleted_at IS NULL
  DO UPDATE
    SET included_run_ids = CASE
          WHEN p_run_id = ANY(payroll_tax_deposits.included_run_ids)
            THEN payroll_tax_deposits.included_run_ids
            ELSE array_append(payroll_tax_deposits.included_run_ids, p_run_id)
        END,
        due_date     = EXCLUDED.due_date,
        period_start = EXCLUDED.period_start,
        notes        = COALESCE(EXCLUDED.notes, payroll_tax_deposits.notes);

  UPDATE payroll_tax_deposits d
     SET amount = (
       SELECT ROUND(COALESCE(SUM(
         CASE p_deposit_type
           WHEN 'federal_941' THEN
             r.federal_income_tax
             + r.social_security_employee + r.social_security_employer
             + r.medicare_employee        + r.medicare_employer
             + r.additional_medicare
           WHEN 'state_withholding' THEN r.state_income_tax
           WHEN 'federal_940'       THEN r.futa
           WHEN 'state_suta'        THEN r.suta
           WHEN 'state_sdi'         THEN r.state_disability_employer
           ELSE 0
         END
       ), 0), 2)
         FROM payroll_runs r
        WHERE r.id = ANY(d.included_run_ids)
          AND r.status IN ('finalized', 'paid')
          AND r.deleted_at IS NULL
     )
   WHERE d.deposit_type = p_deposit_type
     AND d.period_end   = p_period_end
     AND d.status <> 'paid'
     AND d.deleted_at IS NULL;

  RETURN (
    SELECT id
      FROM payroll_tax_deposits
     WHERE deposit_type = p_deposit_type
       AND period_end   = p_period_end
       AND status <> 'paid'
       AND deleted_at IS NULL
     LIMIT 1
  );
END;
$fn$;

COMMENT ON FUNCTION upsert_payroll_tax_deposit_run IS
  'Atomically adds a finalized run to its active deposit bucket and recomputes the bucket amount. Called by upsertDepositsForRun.';

GRANT EXECUTE ON FUNCTION upsert_payroll_tax_deposit_run(
  TEXT, DATE, DATE, DATE, UUID, TEXT
) TO authenticated;

-- ============================================================================
-- TABLE 8a: payroll_deposit_history (event-sourced audit)
-- Mirrors the payroll_run_history pattern. Trigger-driven so every write path
-- (the upsert RPC, mark-paid, soft-delete, aggregation re-compute) is captured
-- without relying on caller discipline.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_deposit_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id      UUID NOT NULL REFERENCES payroll_tax_deposits(id) ON DELETE CASCADE,
  event_type      VARCHAR(30) NOT NULL
                    CHECK (event_type IN (
                      'created', 'amount_changed', 'runs_changed', 'paid',
                      'unpaid', 'marked_late', 'note_updated', 'deleted',
                      'restored', 'updated'
                    )),
  status          VARCHAR(20) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  before_snapshot JSONB,
  after_snapshot  JSONB,
  changed_by      UUID,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_deposit_history_deposit
  ON payroll_deposit_history(deposit_id, changed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_deposit_history_event
  ON payroll_deposit_history(deposit_id, event_type, changed_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE  payroll_deposit_history IS 'Trigger-driven audit trail for every mutation on payroll_tax_deposits.';
COMMENT ON COLUMN payroll_deposit_history.event_type IS 'Event kind: created | amount_changed | runs_changed | paid | unpaid | marked_late | note_updated | deleted | restored | updated.';
COMMENT ON COLUMN payroll_deposit_history.changed_by IS 'auth.uid() at the time of mutation. Null for direct DB writes (backfills, psql).';
COMMENT ON COLUMN payroll_deposit_history.before_snapshot IS 'Deposit row pre-change (minus id/created_at/updated_at); null on insert.';
COMMENT ON COLUMN payroll_deposit_history.after_snapshot  IS 'Deposit row post-change (minus id/created_at/updated_at); always populated (no hard deletes).';

-- ============================================================================
-- record_payroll_deposit_history() trigger
-- Selects the first applicable event category per update to keep history
-- focused. Pure no-op updates (only updated_at ticked) are suppressed.
-- ============================================================================

CREATE OR REPLACE FUNCTION record_payroll_deposit_history()
RETURNS TRIGGER AS $fn$
DECLARE
  v_event  TEXT;
  v_note   TEXT;
  v_actor  UUID;
  v_before JSONB;
  v_after  JSONB;
BEGIN
  -- auth.uid() is Supabase-provided; returns NULL when no JWT context (psql,
  -- backfills). Wrapped in a NULL-safe call that degrades to NULL if the
  -- function is missing (e.g. local tests without the auth schema).
  BEGIN
    v_actor := auth.uid();
  EXCEPTION WHEN undefined_function THEN
    v_actor := NULL;
  END;

  IF TG_OP = 'INSERT' THEN
    v_after := ((to_jsonb(NEW) - 'id') - 'created_at') - 'updated_at';
    INSERT INTO payroll_deposit_history (
      deposit_id, event_type, status, amount,
      before_snapshot, after_snapshot, changed_by, notes
    ) VALUES (
      NEW.id, 'created', NEW.status, NEW.amount,
      NULL, v_after, v_actor, 'Deposit created'
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_event := 'deleted';
      v_note  := 'Deposit soft-deleted';
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      v_event := 'restored';
      v_note  := 'Deposit restored from trash';
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'paid' THEN
        v_event := 'paid';
        v_note  := 'Marked paid'
                 || COALESCE(' (ref ' || NEW.payment_reference || ')', '');
      ELSIF OLD.status = 'paid' AND NEW.status = 'scheduled' THEN
        v_event := 'unpaid';
        v_note  := 'Reverted to scheduled';
      ELSIF NEW.status = 'late' THEN
        v_event := 'marked_late';
        v_note  := 'Flagged past due';
      ELSE
        v_event := 'updated';
        v_note  := 'Status: ' || OLD.status || ' -> ' || NEW.status;
      END IF;
    ELSIF OLD.included_run_ids IS DISTINCT FROM NEW.included_run_ids THEN
      v_event := 'runs_changed';
      v_note  := 'Included runs: '
               || COALESCE(array_length(OLD.included_run_ids, 1), 0)::text
               || ' -> '
               || COALESCE(array_length(NEW.included_run_ids, 1), 0)::text;
    ELSIF OLD.amount IS DISTINCT FROM NEW.amount THEN
      v_event := 'amount_changed';
      v_note  := 'Amount: ' || OLD.amount::text || ' -> ' || NEW.amount::text;
    ELSIF OLD.notes IS DISTINCT FROM NEW.notes THEN
      v_event := 'note_updated';
      v_note  := 'Notes updated';
    ELSIF OLD.payment_reference IS DISTINCT FROM NEW.payment_reference
       OR OLD.paid_at           IS DISTINCT FROM NEW.paid_at
       OR OLD.due_date          IS DISTINCT FROM NEW.due_date
       OR OLD.period_start      IS DISTINCT FROM NEW.period_start
       OR OLD.period_end        IS DISTINCT FROM NEW.period_end THEN
      -- Catch-all for mutations that bypass the main transitions above:
      -- direct payment_reference/paid_at overwrites, period or due-date
      -- corrections. Logged as a generic `updated` event so nothing slips
      -- past the audit trail.
      v_event := 'updated';
      v_note  := 'Deposit fields updated';
    ELSE
      -- No meaningful change (idempotent UPDATE from the upsert RPC or a
      -- same-value write). Do not log.
      RETURN NEW;
    END IF;

    v_before := ((to_jsonb(OLD) - 'id') - 'created_at') - 'updated_at';
    v_after  := ((to_jsonb(NEW) - 'id') - 'created_at') - 'updated_at';

    INSERT INTO payroll_deposit_history (
      deposit_id, event_type, status, amount,
      before_snapshot, after_snapshot, changed_by, notes
    ) VALUES (
      NEW.id, v_event, NEW.status, NEW.amount,
      v_before, v_after, v_actor, v_note
    );
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_deposit_history_on_insert
  AFTER INSERT ON payroll_tax_deposits
  FOR EACH ROW EXECUTE FUNCTION record_payroll_deposit_history();

CREATE TRIGGER payroll_deposit_history_on_update
  AFTER UPDATE ON payroll_tax_deposits
  FOR EACH ROW EXECUTE FUNCTION record_payroll_deposit_history();

-- ============================================================================
-- TABLE 9: payroll_forms
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_forms (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_type             VARCHAR(30) NOT NULL
                          CHECK (form_type IN ('941', '940', 'w2', 'w3', 'efw2', 'a1_qrt', 'a1_apr', 'other')),
  tax_year              INTEGER NOT NULL,
  quarter               INTEGER CHECK (quarter IS NULL OR quarter BETWEEN 1 AND 4),
  employee_id           UUID REFERENCES payroll_employees(id) ON DELETE RESTRICT,
  status                VARCHAR(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'generated', 'filed')),
  form_data             JSONB NOT NULL DEFAULT '{}',
  generated_at          TIMESTAMPTZ,
  filed_at              TIMESTAMPTZ,
  confirmation_number   VARCHAR(100),
  notes                 TEXT,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_forms_year
  ON payroll_forms(tax_year DESC, form_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_forms_employee
  ON payroll_forms(employee_id, tax_year DESC)
  WHERE deleted_at IS NULL AND employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_forms_status
  ON payroll_forms(status, tax_year DESC)
  WHERE deleted_at IS NULL;

-- Enforces one active form per (form_type, tax_year, quarter, employee_id).
-- W-2 keys on employee UUID; company-wide forms use a constant sentinel UUID
-- so their dedupe key ignores employee_id. Soft-deleted rows are excluded so
-- voided-then-regenerated workflows still work.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_forms_unique_active
  ON payroll_forms (
    form_type,
    tax_year,
    COALESCE(quarter, 0),
    COALESCE(employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE deleted_at IS NULL;

CREATE TRIGGER payroll_forms_updated_at
  BEFORE UPDATE ON payroll_forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE  payroll_forms IS 'Generated tax forms: 941, 940, W-2/W-3, EFW2 file, AZ A-1-QRT/APR.';
COMMENT ON COLUMN payroll_forms.employee_id IS 'Null for company-wide forms (941, 940, W-3, EFW2, A-1-QRT, A-1-APR). Set for per-employee forms (W-2).';
COMMENT ON COLUMN payroll_forms.form_data IS 'All computed line items. Shape depends on form_type.';

-- ============================================================================
-- TABLE 10: payroll_audit_events (append-only audit trail)
-- ============================================================================
-- Generic audit log for sensitive payroll actions (SSN reveals, rate-limit
-- denials, etc.). Append-only by RLS convention: authenticated users may
-- SELECT and INSERT, but never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS payroll_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID,
  actor_email     TEXT,
  event_type      TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS payroll_audit_events_created_at_idx
  ON payroll_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_audit_events_event_type_idx
  ON payroll_audit_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_audit_events_target_idx
  ON payroll_audit_events (target_type, target_id);
CREATE INDEX IF NOT EXISTS payroll_audit_events_actor_idx
  ON payroll_audit_events (actor_user_id, created_at DESC);

ALTER TABLE payroll_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_audit_events_select ON payroll_audit_events
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY payroll_audit_events_insert ON payroll_audit_events
  FOR INSERT TO authenticated WITH CHECK (TRUE);

COMMENT ON TABLE  payroll_audit_events IS 'Append-only audit log for sensitive payroll actions (e.g., SSN reveals, rate-limit denials). No UPDATE or DELETE policies by design.';
COMMENT ON COLUMN payroll_audit_events.event_type IS 'Short action identifier. Examples: ssn_reveal, ssn_reveal_failed, ssn_reveal_rate_limited.';
COMMENT ON COLUMN payroll_audit_events.target_type IS 'Type of the target resource. Example: payroll_employee.';
COMMENT ON COLUMN payroll_audit_events.metadata IS 'Event-specific details. For ssn_reveal: {remaining_in_window: number}. For ssn_reveal_failed: {reason: string, error?: string}. For ssn_reveal_rate_limited: {max, window_ms, reset_at}.';

-- ============================================================================
-- ROW LEVEL SECURITY (single-user tool: authenticated can CRUD)
-- ============================================================================

ALTER TABLE organization_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_tax_configs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_tax_configs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_change_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employees      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_tax_deposits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_deposit_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_forms            ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'organization_config', 'federal_tax_configs', 'state_tax_configs',
    'config_change_history', 'payroll_employees', 'payroll_runs',
    'payroll_run_history', 'payroll_tax_deposits', 'payroll_deposit_history',
    'payroll_forms'
  ]) LOOP
    EXECUTE format('CREATE POLICY "Authenticated users can view %I" ON %I FOR SELECT TO authenticated USING (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "Authenticated users can insert %I" ON %I FOR INSERT TO authenticated WITH CHECK (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "Authenticated users can update %I" ON %I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "Authenticated users can delete %I" ON %I FOR DELETE TO authenticated USING (true)', tbl, tbl);
  END LOOP;
END $$;

-- ============================================================================
-- 2026 TAX CONFIG SEED
-- ============================================================================
-- Values verified against IRS Publication 15-T (2026), Pub 15 (2026), and
-- Arizona Department of Revenue guidance for tax year 2026:
--   FICA: SS 6.2% each side, wage base $184,500. Medicare 1.45%. Add Medicare 0.9% over $200k employee-side only.
--   FUTA: 0.6% on first $7,000.
--   Standard deductions: Single $16,100 / MFJ $32,200 / MFS $16,100 / HoH $24,150.
--   Percentage-method brackets: Pub 15-T 2026 Worksheet 1A (annual payroll period).
--   AZ: 2.5% flat income tax, A-4 employee-elected rates 0.5%-3.5% (0.5% steps), new-employer SUTA 2.0% on first $8,000.
--
-- Per-year values are editable from the admin payroll config UI, so future
-- years (2027+) can be added via a new federal_tax_configs row rather than a
-- migration. OBBBA's tip/overtime deductions do not apply to our salaried-only
-- scope.

INSERT INTO federal_tax_configs (tax_year, brackets, fica, futa, std_deductions, version_hash, notes)
VALUES (
  2026,
  '{
    "period": "annual",
    "source": "IRS Publication 15-T (2026), Worksheet 1A - Percentage Method, Annual Payroll Period",
    "w4_step2_unchecked": {
      "single": [
        {"min": 0,        "max": 6400,    "rate": 0.00, "base_tax": 0},
        {"min": 6400,     "max": 17500,   "rate": 0.10, "base_tax": 0},
        {"min": 17500,    "max": 41100,   "rate": 0.12, "base_tax": 1110},
        {"min": 41100,    "max": 93450,   "rate": 0.22, "base_tax": 3942},
        {"min": 93450,    "max": 193600,  "rate": 0.24, "base_tax": 15459},
        {"min": 193600,   "max": 241150,  "rate": 0.32, "base_tax": 39495},
        {"min": 241150,   "max": 596650,  "rate": 0.35, "base_tax": 54709},
        {"min": 596650,   "max": null,    "rate": 0.37, "base_tax": 179132.5}
      ],
      "mfj": [
        {"min": 0,        "max": 17000,   "rate": 0.00, "base_tax": 0},
        {"min": 17000,    "max": 39500,   "rate": 0.10, "base_tax": 0},
        {"min": 39500,    "max": 106700,  "rate": 0.12, "base_tax": 2250},
        {"min": 106700,   "max": 211400,  "rate": 0.22, "base_tax": 10314},
        {"min": 211400,   "max": 403700,  "rate": 0.24, "base_tax": 33348},
        {"min": 403700,   "max": 518150,  "rate": 0.32, "base_tax": 79500},
        {"min": 518150,   "max": 768700,  "rate": 0.35, "base_tax": 116144},
        {"min": 768700,   "max": null,    "rate": 0.37, "base_tax": 203836.5}
      ],
      "mfs": [
        {"min": 0,        "max": 8500,    "rate": 0.00, "base_tax": 0},
        {"min": 8500,     "max": 19750,   "rate": 0.10, "base_tax": 0},
        {"min": 19750,    "max": 53350,   "rate": 0.12, "base_tax": 1125},
        {"min": 53350,    "max": 105700,  "rate": 0.22, "base_tax": 5157},
        {"min": 105700,   "max": 201850,  "rate": 0.24, "base_tax": 16674},
        {"min": 201850,   "max": 259075,  "rate": 0.32, "base_tax": 39750},
        {"min": 259075,   "max": 384350,  "rate": 0.35, "base_tax": 58072},
        {"min": 384350,   "max": null,    "rate": 0.37, "base_tax": 101918.25}
      ],
      "hoh": [
        {"min": 0,        "max": 13900,   "rate": 0.00, "base_tax": 0},
        {"min": 13900,    "max": 30900,   "rate": 0.10, "base_tax": 0},
        {"min": 30900,    "max": 78750,   "rate": 0.12, "base_tax": 1700},
        {"min": 78750,    "max": 117250,  "rate": 0.22, "base_tax": 7442},
        {"min": 117250,   "max": 208250,  "rate": 0.24, "base_tax": 15912},
        {"min": 208250,   "max": 258250,  "rate": 0.32, "base_tax": 37752},
        {"min": 258250,   "max": 609000,  "rate": 0.35, "base_tax": 53752},
        {"min": 609000,   "max": null,    "rate": 0.37, "base_tax": 176514.5}
      ]
    },
    "step2_additive": {
      "mfj": 12900,
      "other": 8600
    }
  }'::jsonb,

  '{
    "ss_rate": 0.062,
    "ss_wage_base": 184500,
    "medicare_rate": 0.0145,
    "additional_medicare_rate": 0.009,
    "additional_medicare_threshold": 200000
  }'::jsonb,

  '{
    "rate": 0.006,
    "wage_base": 7000
  }'::jsonb,

  '{
    "single": 16100,
    "mfj": 32200,
    "mfs": 16100,
    "hoh": 24150
  }'::jsonb,

  'pending_first_save',
  'Seeded 2026-04-17. Brackets, FICA wage base, FUTA, and standard deductions reflect IRS Publication 15-T (2026). Admins can edit per-year values via the federal config UI.'
)
ON CONFLICT (tax_year) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO state_tax_configs (state_code, tax_year, calculation_method, config, sdi_config, suta_config, payment_portals, version_hash, notes)
VALUES (
  'AZ',
  2026,
  'flat_employee_elected',
  '{
    "actualTaxRate": 0.025,
    "rates": [0.005, 0.010, 0.015, 0.020, 0.025, 0.030, 0.035],
    "defaultRate": 0.020,
    "form": "A-4",
    "notes": "Employee selects A-4 rate; actual AZ income tax is 2.5% flat. Default 2.0% applies if no A-4 is filed."
  }'::jsonb,
  '{}'::jsonb,
  '{
    "newEmployerRate": 0.020,
    "wageBase": 8000,
    "rangeMin": 0.0003,
    "rangeMax": 0.0836,
    "formsDue": ["A-1-QRT quarterly", "A-1-APR annual"]
  }'::jsonb,
  '{
    "state_withholding": {
      "portal": "AZTaxes",
      "agency": "Arizona Department of Revenue",
      "url": "https://www.aztaxes.gov/",
      "form": "A1-WP",
      "steps": [
        "Log in to AZTaxes.gov",
        "Select Withholding Tax, then Make a Payment",
        "Choose form A1-WP (Arizona Withholding Payment Voucher)",
        "Pick the deposit period shown in the deposits list, enter the amount, and submit via ACH Debit",
        "Record the AZTaxes confirmation number and mark this deposit paid in the admin"
      ]
    },
    "state_suta": {
      "portal": "AZ DES Tax",
      "agency": "Arizona Department of Economic Security - Unemployment Tax",
      "url": "https://uitax.azdes.gov/",
      "form": "UC-018 / UC-020",
      "steps": [
        "Log in to uitax.azdes.gov with your UI account credentials",
        "Open Quarterly Reports for the quarter shown in the deposits list",
        "File UC-018 (Quarterly Wage Report) and UC-020 (Quarterly Tax Report) together",
        "Submit the tax payment via ACH Debit at the end of the filing",
        "Record the DES confirmation and mark this deposit paid in the admin"
      ]
    },
    "state_sdi": null
  }'::jsonb,
  'pending_first_save',
  'Seeded 2026-04-17. AZ values unchanged from 2025 (Bloomberg Tax confirmation Apr 2026). AZ has no SDI.'
)
ON CONFLICT (state_code, tax_year) WHERE deleted_at IS NULL DO NOTHING;
