-- ============================================================================
-- VALIANCE ADMIN - DATABASE SCHEMA
-- ============================================================================
-- Run this file first in Supabase SQL Editor to create all tables
-- ============================================================================

-- ============================================================================
-- CLEANUP (only if you need to reset - comment out for first run)
-- ============================================================================
-- DROP TABLE IF EXISTS income_line_items CASCADE;
-- DROP TABLE IF EXISTS income_amounts CASCADE;
-- DROP TABLE IF EXISTS income_entries CASCADE;
-- DROP TABLE IF EXISTS income_sources CASCADE;
-- DROP TABLE IF EXISTS expense_history CASCADE;
-- DROP TABLE IF EXISTS expenses CASCADE;
-- DROP TABLE IF EXISTS net_worth CASCADE;
-- DROP FUNCTION IF EXISTS update_updated_at CASCADE;
-- DROP FUNCTION IF EXISTS record_expense_history CASCADE;

-- ============================================================================
-- SHARED FUNCTIONS
-- ============================================================================

-- Function to auto-update updated_at timestamp on any table
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TABLE 1: income_sources
-- Dynamic income categories that can be added/removed via UI
-- ============================================================================

CREATE TABLE income_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL,
  slug VARCHAR(50) NOT NULL UNIQUE,
  color VARCHAR(7) NOT NULL DEFAULT '#5B8A8A',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for filtering active sources
CREATE INDEX idx_income_sources_active ON income_sources(is_active, sort_order)
  WHERE deleted_at IS NULL;

-- Trigger for updated_at
CREATE TRIGGER income_sources_updated_at
  BEFORE UPDATE ON income_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE income_sources IS 'Dynamic income categories (e.g., E-Commerce, SaaS, Affiliate)';
COMMENT ON COLUMN income_sources.slug IS 'URL-safe identifier, must be unique';
COMMENT ON COLUMN income_sources.color IS 'Hex color code for charts and UI';
COMMENT ON COLUMN income_sources.sort_order IS 'Display order in tables and forms';

-- ============================================================================
-- TABLE 2: income_entries
-- Monthly income records - one row per month
-- ============================================================================

CREATE TABLE income_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month DATE NOT NULL UNIQUE,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ensure month is always first day of month
  CONSTRAINT income_entries_month_first_day CHECK (
    EXTRACT(DAY FROM month) = 1
  )
);

-- Index for date-based queries (most recent first)
CREATE INDEX idx_income_entries_month ON income_entries(month DESC)
  WHERE deleted_at IS NULL;

-- Trigger for updated_at
CREATE TRIGGER income_entries_updated_at
  BEFORE UPDATE ON income_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE income_entries IS 'Monthly income records - one entry per month';
COMMENT ON COLUMN income_entries.month IS 'First day of the month (e.g., 2026-01-01)';

-- ============================================================================
-- TABLE 3: income_amounts
-- Actual income values per source per month (join table)
-- ============================================================================

CREATE TABLE income_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES income_entries(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES income_sources(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One amount per source per entry
  UNIQUE(entry_id, source_id)
);

-- Indexes for lookups
CREATE INDEX idx_income_amounts_entry ON income_amounts(entry_id);
CREATE INDEX idx_income_amounts_source ON income_amounts(source_id);

-- Trigger for updated_at
CREATE TRIGGER income_amounts_updated_at
  BEFORE UPDATE ON income_amounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE income_amounts IS 'Income values linking entries to sources';
COMMENT ON COLUMN income_amounts.amount IS 'Income amount (can be negative for losses/refunds)';

-- ============================================================================
-- TABLE 4: income_line_items
-- Itemized income records that roll up into income_amounts
-- ============================================================================

CREATE TABLE income_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES income_entries(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES income_sources(id) ON DELETE RESTRICT,
  received_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  -- Provenance for externally-synced rows (e.g. CRM invoices via webhook).
  -- NULL for manual entries. See migration 20260725_create_invoice_income_sync.sql.
  external_source TEXT,
  external_ref TEXT,
  external_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT income_line_items_nonzero_amount CHECK (amount <> 0)
);

CREATE INDEX idx_income_line_items_entry ON income_line_items(entry_id, received_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_income_line_items_source ON income_line_items(source_id, received_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_income_line_items_received_date ON income_line_items(received_date DESC)
  WHERE deleted_at IS NULL;

-- One active row per (source, ref, type); NULL external_ref (manual rows) never collide.
CREATE UNIQUE INDEX idx_income_line_items_external
  ON income_line_items (external_source, external_ref, external_type)
  WHERE deleted_at IS NULL AND external_ref IS NOT NULL;
CREATE INDEX idx_income_line_items_external_ref
  ON income_line_items (external_source, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TRIGGER income_line_items_updated_at
  BEFORE UPDATE ON income_line_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE income_line_items IS 'Individual income items that roll up into monthly source totals';
COMMENT ON COLUMN income_line_items.received_date IS 'Date the income was received';
COMMENT ON COLUMN income_line_items.amount IS 'Income item amount (can be negative for refunds or losses)';

CREATE OR REPLACE FUNCTION validate_income_line_item_month()
RETURNS TRIGGER AS $$
DECLARE
  v_month DATE;
BEGIN
  SELECT month INTO v_month
  FROM income_entries
  WHERE id = NEW.entry_id;

  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Income entry % does not exist', NEW.entry_id;
  END IF;

  IF date_trunc('month', NEW.received_date)::date <> v_month THEN
    RAISE EXCEPTION 'Income item date % must fall within income entry month %', NEW.received_date, v_month;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER income_line_items_validate_month
  BEFORE INSERT OR UPDATE OF entry_id, received_date ON income_line_items
  FOR EACH ROW EXECUTE FUNCTION validate_income_line_item_month();

CREATE OR REPLACE FUNCTION recompute_income_amount(
  p_entry_id UUID,
  p_source_id UUID
)
RETURNS VOID AS $$
DECLARE
  v_total NUMERIC(12,2);
BEGIN
  SELECT ROUND(COALESCE(SUM(amount), 0), 2)
  INTO v_total
  FROM income_line_items
  WHERE entry_id = p_entry_id
    AND source_id = p_source_id
    AND deleted_at IS NULL;

  IF v_total = 0 THEN
    DELETE FROM income_amounts
    WHERE entry_id = p_entry_id
      AND source_id = p_source_id;
  ELSE
    INSERT INTO income_amounts (entry_id, source_id, amount)
    VALUES (p_entry_id, p_source_id, v_total)
    ON CONFLICT (entry_id, source_id)
    DO UPDATE SET
      amount = EXCLUDED.amount,
      updated_at = now();
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION soft_delete_empty_income_entry(p_entry_id UUID)
RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM income_line_items
    WHERE entry_id = p_entry_id
      AND deleted_at IS NULL
  ) THEN
    UPDATE income_entries
    SET deleted_at = now()
    WHERE id = p_entry_id
      AND deleted_at IS NULL;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_income_amount_from_line_items()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM recompute_income_amount(NEW.entry_id, NEW.source_id);

    IF NEW.deleted_at IS NOT NULL THEN
      PERFORM soft_delete_empty_income_entry(NEW.entry_id);
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.entry_id IS DISTINCT FROM NEW.entry_id
       OR OLD.source_id IS DISTINCT FROM NEW.source_id THEN
      PERFORM recompute_income_amount(OLD.entry_id, OLD.source_id);
      PERFORM soft_delete_empty_income_entry(OLD.entry_id);
    END IF;

    PERFORM recompute_income_amount(NEW.entry_id, NEW.source_id);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_income_amount(OLD.entry_id, OLD.source_id);
    PERFORM soft_delete_empty_income_entry(OLD.entry_id);
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER income_line_items_sync_amounts
  AFTER INSERT OR UPDATE OR DELETE ON income_line_items
  FOR EACH ROW EXECUTE FUNCTION sync_income_amount_from_line_items();

-- ----------------------------------------------------------------------------
-- webhook_receipts: generic inbound-webhook cursor. One row per
-- (source, external_ref) holding the last event applied, for idempotency +
-- out-of-order guarding. Reusable by any receiver, keyed by source. See
-- migration 20260725_create_invoice_income_sync.sql.
-- ----------------------------------------------------------------------------
CREATE TABLE webhook_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  last_event_id TEXT,
  last_status TEXT,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_ref)
);

CREATE TRIGGER webhook_receipts_updated_at
  BEFORE UPDATE ON webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE webhook_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view webhook_receipts"
  ON webhook_receipts FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- TABLE 5: expenses
-- Fixed recurring expenses with frequency support
-- ============================================================================

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  frequency VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'annual')),
  expense_type VARCHAR(20) NOT NULL
    CHECK (expense_type IN ('personal', 'business')),
  category VARCHAR(20)
    CHECK (category IN (
      'housing',
      'transport',
      'utilities',
      'health',
      'entertainment',
      'subscriptions',
      'software',
      'hosting',
      'marketing',
      'fees',
      'services',
      'contractors',
      'payroll',
      'insurance',
      'other'
    )),
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for filtering
CREATE INDEX idx_expenses_type ON expenses(expense_type)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_expenses_category ON expenses(category)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_expenses_active ON expenses(is_active, expense_type)
  WHERE deleted_at IS NULL AND is_active = true;

-- Trigger for updated_at
CREATE TRIGGER expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE expenses IS 'Fixed recurring monthly expenses';
COMMENT ON COLUMN expenses.frequency IS 'Payment frequency: weekly, monthly, quarterly, annual';
COMMENT ON COLUMN expenses.effective_date IS 'Date when this expense started';

-- ============================================================================
-- TABLE 5: expense_history
-- Event-sourced history tracking full lifecycle of expenses
-- ============================================================================

CREATE TABLE expense_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL
    CHECK (event_type IN ('created', 'updated', 'paused', 'activated', 'deleted')),
  amount NUMERIC(10,2) NOT NULL,
  frequency VARCHAR(20) NOT NULL,
  is_active BOOLEAN NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for looking up history by expense (excluding deleted)
CREATE INDEX idx_expense_history_expense ON expense_history(expense_id, changed_at DESC)
  WHERE deleted_at IS NULL;

-- Index for querying by event type
CREATE INDEX idx_expense_history_event_type ON expense_history(expense_id, event_type, changed_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE expense_history IS 'Event-sourced history of expense lifecycle changes';
COMMENT ON COLUMN expense_history.event_type IS 'Type of event: created, updated, paused, activated, deleted';
COMMENT ON COLUMN expense_history.is_active IS 'Whether expense was active at this point in time';

-- Function to auto-record expense history events
CREATE OR REPLACE FUNCTION record_expense_history()
RETURNS TRIGGER AS $$
BEGIN
  -- Handle INSERT (new expense created)
  IF TG_OP = 'INSERT' THEN
    INSERT INTO expense_history (expense_id, event_type, amount, frequency, is_active, notes)
    VALUES (NEW.id, 'created', NEW.amount, NEW.frequency, NEW.is_active, 'Expense created');
    RETURN NEW;
  END IF;

  -- Handle UPDATE
  IF TG_OP = 'UPDATE' THEN
    -- Check for soft delete (deleted_at was set)
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      INSERT INTO expense_history (expense_id, event_type, amount, frequency, is_active, notes)
      VALUES (NEW.id, 'deleted', NEW.amount, NEW.frequency, false, 'Expense deleted');
      RETURN NEW;
    END IF;

    -- Check for restore from trash (deleted_at was cleared)
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      INSERT INTO expense_history (expense_id, event_type, amount, frequency, is_active, notes)
      VALUES (NEW.id, 'activated', NEW.amount, NEW.frequency, NEW.is_active, 'Expense restored from trash');
      RETURN NEW;
    END IF;

    -- Check for pause (is_active changed to false)
    IF OLD.is_active = true AND NEW.is_active = false THEN
      INSERT INTO expense_history (expense_id, event_type, amount, frequency, is_active, notes)
      VALUES (NEW.id, 'paused', NEW.amount, NEW.frequency, false, 'Expense paused');
      RETURN NEW;
    END IF;

    -- Check for activate (is_active changed to true)
    IF OLD.is_active = false AND NEW.is_active = true THEN
      INSERT INTO expense_history (expense_id, event_type, amount, frequency, is_active, notes)
      VALUES (NEW.id, 'activated', NEW.amount, NEW.frequency, true, 'Expense activated');
      RETURN NEW;
    END IF;

    -- Check for amount or frequency update
    IF OLD.amount IS DISTINCT FROM NEW.amount OR OLD.frequency IS DISTINCT FROM NEW.frequency THEN
      INSERT INTO expense_history (expense_id, event_type, amount, frequency, is_active, notes)
      VALUES (NEW.id, 'updated', NEW.amount, NEW.frequency, NEW.is_active, 'Amount or frequency updated');
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for INSERT and UPDATE
CREATE TRIGGER expense_history_on_insert
  AFTER INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION record_expense_history();

CREATE TRIGGER expense_history_on_update
  AFTER UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION record_expense_history();

-- ============================================================================
-- TABLE 6: net_worth
-- Separate table for net worth tracking
-- ============================================================================

CREATE TABLE net_worth (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  amount NUMERIC(14,2) NOT NULL,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for date-based queries
CREATE INDEX idx_net_worth_date ON net_worth(date DESC)
  WHERE deleted_at IS NULL;

-- Trigger for updated_at
CREATE TRIGGER net_worth_updated_at
  BEFORE UPDATE ON net_worth
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE net_worth IS 'Net worth snapshots over time';

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE income_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE net_worth ENABLE ROW LEVEL SECURITY;

-- Policies: Allow authenticated users full access
-- (This is a single-user internal tool)

CREATE POLICY "Authenticated users can view income_sources"
  ON income_sources FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert income_sources"
  ON income_sources FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update income_sources"
  ON income_sources FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete income_sources"
  ON income_sources FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can view income_entries"
  ON income_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert income_entries"
  ON income_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update income_entries"
  ON income_entries FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete income_entries"
  ON income_entries FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can view income_amounts"
  ON income_amounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert income_amounts"
  ON income_amounts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update income_amounts"
  ON income_amounts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete income_amounts"
  ON income_amounts FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can view income_line_items"
  ON income_line_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert income_line_items"
  ON income_line_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update income_line_items"
  ON income_line_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete income_line_items"
  ON income_line_items FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can view expenses"
  ON expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert expenses"
  ON expenses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update expenses"
  ON expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete expenses"
  ON expenses FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can view expense_history"
  ON expense_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert expense_history"
  ON expense_history FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update expense_history"
  ON expense_history FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete expense_history"
  ON expense_history FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can view net_worth"
  ON net_worth FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert net_worth"
  ON net_worth FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update net_worth"
  ON net_worth FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete net_worth"
  ON net_worth FOR DELETE TO authenticated USING (true);

-- ============================================================================
-- TABLE 7: tax_estimates
-- Tax Estimator Worksheet - one row per tax year
-- Dynamic line items stored as JSONB arrays.
-- ============================================================================

CREATE TABLE tax_estimates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year              INTEGER NOT NULL UNIQUE,
  filing_status         VARCHAR(20) NOT NULL DEFAULT 'single'
                          CHECK (filing_status IN ('single', 'mfj', 'mfs', 'hoh')),
  income_sources        JSONB NOT NULL DEFAULT '[]',
  capital_gains         JSONB NOT NULL DEFAULT '[]',
  payments              JSONB NOT NULL DEFAULT '[]',
  additional_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  state                 VARCHAR(2),
  business_type         VARCHAR(20)
                          CHECK (business_type IN ('none', 'sole_prop', 'llc', 's_corp', 'c_corp', 'partnership')),
  tax_classification    VARCHAR(20)
                          CHECK (tax_classification IN ('sole_prop', 'disregarded', 's_corp', 'c_corp', 'partnership')),
  dependents            INTEGER NOT NULL DEFAULT 0,
  other_dependents      INTEGER NOT NULL DEFAULT 0,
  additional_credits    NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes                 TEXT,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for year lookups (most common query)
CREATE INDEX idx_tax_estimates_year ON tax_estimates(tax_year DESC)
  WHERE deleted_at IS NULL;

-- Trigger for updated_at
CREATE TRIGGER tax_estimates_updated_at
  BEFORE UPDATE ON tax_estimates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE tax_estimates IS 'Tax estimator worksheets, one per tax year';
COMMENT ON COLUMN tax_estimates.filing_status IS 'Filing status: single, mfj, mfs, hoh';
COMMENT ON COLUMN tax_estimates.income_sources IS 'JSON array of {id, name, amount, subject_to_se, income_type, linked_source_id?, linked_amount?, is_unlinked?}';
COMMENT ON COLUMN tax_estimates.state IS '2-letter US state code for state tax calculation';
COMMENT ON COLUMN tax_estimates.business_type IS 'Business structure: none, sole_prop, llc, s_corp, c_corp, partnership';
COMMENT ON COLUMN tax_estimates.tax_classification IS 'How the entity is taxed: sole_prop, disregarded, s_corp, c_corp, partnership';
COMMENT ON COLUMN tax_estimates.dependents IS 'Number of qualifying dependent children';
COMMENT ON COLUMN tax_estimates.capital_gains IS 'JSON array of {id, description, amount, term}';
COMMENT ON COLUMN tax_estimates.payments IS 'JSON array of {id, type, label, amount}';
COMMENT ON COLUMN tax_estimates.additional_deductions IS 'Additional deductions beyond standard/SE/QBI';

-- RLS for tax_estimates
ALTER TABLE tax_estimates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view tax_estimates"
  ON tax_estimates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert tax_estimates"
  ON tax_estimates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update tax_estimates"
  ON tax_estimates FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete tax_estimates"
  ON tax_estimates FOR DELETE TO authenticated USING (true);

-- ============================================================================
-- EMAIL ACCOUNTS
-- Referenced (unconstrained) by organization_config.default_email_account_id.
-- ============================================================================

CREATE TABLE email_accounts (
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

CREATE UNIQUE INDEX email_accounts_username_host_unique
  ON email_accounts (LOWER(username), LOWER(host));

CREATE UNIQUE INDEX email_accounts_single_default
  ON email_accounts (is_default) WHERE is_default = TRUE;

CREATE TRIGGER email_accounts_updated_at
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_accounts_all ON email_accounts
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

-- ============================================================================
-- PAYROLL FEATURE (11 tables)
-- See: supabase/migrations/20260417_payroll_*.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- organization_config (singleton)
-- ----------------------------------------------------------------------------

CREATE TABLE organization_config (
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

CREATE UNIQUE INDEX organization_config_singleton_idx
  ON organization_config ((1))
  WHERE deleted_at IS NULL;

CREATE TRIGGER organization_config_updated_at
  BEFORE UPDATE ON organization_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------------------
-- federal_tax_configs
-- ----------------------------------------------------------------------------

CREATE TABLE federal_tax_configs (
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

CREATE UNIQUE INDEX federal_tax_configs_year_unique
  ON federal_tax_configs(tax_year)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_federal_tax_configs_year
  ON federal_tax_configs(tax_year DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER federal_tax_configs_updated_at
  BEFORE UPDATE ON federal_tax_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------------------
-- state_tax_configs
-- ----------------------------------------------------------------------------

CREATE TABLE state_tax_configs (
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
  -- the "Pay at [portal]" links in the deposits UI.
  payment_portals     JSONB NOT NULL DEFAULT '{}',
  version_hash        VARCHAR(64) NOT NULL,
  notes               TEXT,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX state_tax_configs_state_year_unique
  ON state_tax_configs(state_code, tax_year)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_state_tax_configs_lookup
  ON state_tax_configs(state_code, tax_year DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER state_tax_configs_updated_at
  BEFORE UPDATE ON state_tax_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------------------
-- config_change_history
-- ----------------------------------------------------------------------------

CREATE TABLE config_change_history (
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

CREATE INDEX idx_config_change_history_ref
  ON config_change_history(config_type, config_id, changed_at DESC);

-- ----------------------------------------------------------------------------
-- payroll_employees
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_employees (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name             VARCHAR(100) NOT NULL,
  last_name              VARCHAR(100) NOT NULL,
  email                  VARCHAR(200),
  phone                  VARCHAR(30),
  address                JSONB NOT NULL DEFAULT '{}',
  ssn_encrypted          TEXT,
  ssn_key_version        SMALLINT,
  employment_type        VARCHAR(10) NOT NULL DEFAULT 'w2'
                           CHECK (employment_type IN ('w2', '1099')),
  hire_date              DATE NOT NULL,
  termination_date       DATE,
  status                 VARCHAR(20) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'terminated')),
  pay_amount             NUMERIC(12,2) NOT NULL,
  pay_frequency          VARCHAR(20) NOT NULL
                           CHECK (pay_frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly', 'annual')),
  pay_anchor_date        DATE NOT NULL,
  semimonthly_days       JSONB,
  monthly_day            INTEGER
                           CHECK (monthly_day IS NULL OR monthly_day BETWEEN 1 AND 31),
  pay_lag_days           INTEGER NOT NULL DEFAULT 0,
  target_annual_comp     NUMERIC(12,2),
  w4_filing_status       VARCHAR(20) NOT NULL DEFAULT 'single'
                           CHECK (w4_filing_status IN ('single', 'mfj', 'mfs', 'hoh')),
  w4_multiple_jobs       BOOLEAN NOT NULL DEFAULT false,
  w4_exempt              BOOLEAN NOT NULL DEFAULT false,
  w4_dependents_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  w4_other_income        NUMERIC(10,2) NOT NULL DEFAULT 0,
  w4_deductions          NUMERIC(10,2) NOT NULL DEFAULT 0,
  w4_extra_withholding   NUMERIC(10,2) NOT NULL DEFAULT 0,
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

CREATE INDEX idx_payroll_employees_status
  ON payroll_employees(status, last_name)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_payroll_employees_pay_anchor
  ON payroll_employees(pay_anchor_date)
  WHERE deleted_at IS NULL AND status = 'active';

CREATE INDEX idx_payroll_employees_ssn_key_version
  ON payroll_employees(ssn_key_version)
  WHERE ssn_encrypted IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER payroll_employees_updated_at
  BEFORE UPDATE ON payroll_employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------------------
-- payroll_runs (ledger)
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_runs (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id                  UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE RESTRICT,
  run_type                     VARCHAR(20) NOT NULL DEFAULT 'regular'
                                 CHECK (run_type IN ('regular', 'off_cycle', 'correction')),
  status                       VARCHAR(20) NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'finalized', 'paid', 'voided')),
  period_start                 DATE NOT NULL,
  period_end                   DATE NOT NULL,
  pay_date                     DATE NOT NULL,
  gross_pay                    NUMERIC(12,2) NOT NULL,
  federal_income_tax           NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_income_tax             NUMERIC(12,2) NOT NULL DEFAULT 0,
  social_security_employee     NUMERIC(12,2) NOT NULL DEFAULT 0,
  medicare_employee            NUMERIC(12,2) NOT NULL DEFAULT 0,
  additional_medicare          NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_disability_employee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_withholdings           JSONB NOT NULL DEFAULT '[]',
  net_pay                      NUMERIC(12,2) NOT NULL,
  social_security_employer     NUMERIC(12,2) NOT NULL DEFAULT 0,
  medicare_employer            NUMERIC(12,2) NOT NULL DEFAULT 0,
  futa                         NUMERIC(12,2) NOT NULL DEFAULT 0,
  suta                         NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_disability_employer    NUMERIC(12,2) NOT NULL DEFAULT 0,
  social_security_wages        NUMERIC(12,2) NOT NULL DEFAULT 0,
  medicare_wages               NUMERIC(12,2) NOT NULL DEFAULT 0,
  additional_medicare_wages    NUMERIC(12,2) NOT NULL DEFAULT 0,
  futa_wages                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  suta_wages                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  state_taxable_wages          NUMERIC(12,2) NOT NULL DEFAULT 0,
  ytd_stale                    BOOLEAN NOT NULL DEFAULT FALSE,
  ytd_stale_reason             TEXT,
  employee_snapshot            JSONB,
  federal_config_snapshot      JSONB,
  state_config_snapshot        JSONB,
  organization_snapshot        JSONB,
  finalized_at                 TIMESTAMPTZ,
  paid_at                      TIMESTAMPTZ,
  payment_method               VARCHAR(50),
  payment_reference            VARCHAR(200),
  stub_sent_at                 TIMESTAMPTZ,
  reverses_run_id              UUID REFERENCES payroll_runs(id) ON DELETE RESTRICT,
  void_reason                  TEXT,
  notes                        TEXT,
  deleted_at                   TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_runs_period_valid CHECK (period_end >= period_start),
  CONSTRAINT payroll_runs_pay_date_valid CHECK (pay_date >= period_end)
);

CREATE INDEX idx_payroll_runs_employee ON payroll_runs(employee_id, pay_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_payroll_runs_pay_date ON payroll_runs(pay_date DESC, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_payroll_runs_status   ON payroll_runs(status, pay_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_payroll_runs_reverses ON payroll_runs(reverses_run_id) WHERE reverses_run_id IS NOT NULL;

-- One non-voided run per (employee, run_type, period). Server actions check
-- this too, but the partial unique index closes the race between SELECT and
-- INSERT and catches any code path that skips the check. Voided and soft-
-- deleted rows are excluded so corrections (void + recreate) still work.
CREATE UNIQUE INDEX idx_payroll_runs_unique_period
  ON payroll_runs(employee_id, run_type, period_start, period_end)
  WHERE deleted_at IS NULL AND status <> 'voided';

CREATE INDEX idx_payroll_runs_ytd_stale
  ON payroll_runs(employee_id, pay_date)
  WHERE ytd_stale = TRUE AND deleted_at IS NULL;

CREATE TRIGGER payroll_runs_updated_at
  BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------------------
-- payroll_run_history (event-sourced audit)
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_run_history (
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

CREATE INDEX idx_payroll_run_history_run
  ON payroll_run_history(run_id, changed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_payroll_run_history_event
  ON payroll_run_history(run_id, event_type, changed_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION record_payroll_run_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
    VALUES (NEW.id, 'created', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run created');
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
      VALUES (NEW.id, 'deleted', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run soft-deleted');
      RETURN NEW;
    END IF;

    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      INSERT INTO payroll_run_history (run_id, event_type, status, gross_pay, net_pay, notes)
      VALUES (NEW.id, 'restored', NEW.status, NEW.gross_pay, NEW.net_pay, 'Run restored from trash');
      RETURN NEW;
    END IF;

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

-- ----------------------------------------------------------------------------
-- payroll_tax_deposits
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_tax_deposits (
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

CREATE INDEX idx_payroll_tax_deposits_due  ON payroll_tax_deposits(due_date, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_payroll_tax_deposits_type ON payroll_tax_deposits(deposit_type, period_end DESC) WHERE deleted_at IS NULL;

-- Only one active scheduled/late deposit per (type, period). Paid rows are
-- excluded: once a bucket is paid, any new liability in the same period
-- opens a new scheduled row for the delta. ON CONFLICT target in the
-- upsert_payroll_tax_deposit_run RPC depends on this exact predicate.
CREATE UNIQUE INDEX payroll_tax_deposits_active_bucket_uidx
  ON payroll_tax_deposits (deposit_type, period_end)
  WHERE status <> 'paid' AND deleted_at IS NULL;

CREATE TRIGGER payroll_tax_deposits_updated_at
  BEFORE UPDATE ON payroll_tax_deposits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------------------
-- upsert_payroll_tax_deposit_run RPC
-- Atomic upsert: adds p_run_id to the active bucket (creating the row if
-- absent) and re-aggregates amount from every included run. Called by
-- upsertDepositsForRun. Partial unique index above serialises conflicts.
-- Keep the per-type aggregation in sync with
-- lib/payroll/deposits-actions.ts#contributionForBucket.
-- ----------------------------------------------------------------------------

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

GRANT EXECUTE ON FUNCTION upsert_payroll_tax_deposit_run(
  TEXT, DATE, DATE, DATE, UUID, TEXT
) TO authenticated;

-- ----------------------------------------------------------------------------
-- payroll_deposit_history (event-sourced audit)
-- Mirrors payroll_run_history. Trigger-driven so every write path (the
-- upsert RPC, mark-paid, soft-delete, aggregation re-compute) is captured
-- without relying on caller discipline.
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_deposit_history (
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

CREATE INDEX idx_payroll_deposit_history_deposit
  ON payroll_deposit_history(deposit_id, changed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_payroll_deposit_history_event
  ON payroll_deposit_history(deposit_id, event_type, changed_at DESC)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- record_payroll_deposit_history() trigger function
-- Selects the first applicable event category per update. Pure no-op
-- updates (only updated_at ticked) are suppressed.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION record_payroll_deposit_history()
RETURNS TRIGGER AS $fn$
DECLARE
  v_event  TEXT;
  v_note   TEXT;
  v_actor  UUID;
  v_before JSONB;
  v_after  JSONB;
BEGIN
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
      v_event := 'updated';
      v_note  := 'Deposit fields updated';
    ELSE
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

-- ----------------------------------------------------------------------------
-- payroll_forms
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_forms (
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

CREATE INDEX idx_payroll_forms_year     ON payroll_forms(tax_year DESC, form_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_payroll_forms_employee ON payroll_forms(employee_id, tax_year DESC) WHERE deleted_at IS NULL AND employee_id IS NOT NULL;
CREATE INDEX idx_payroll_forms_status   ON payroll_forms(status, tax_year DESC) WHERE deleted_at IS NULL;

-- One active form per (form_type, tax_year, quarter, employee_id). Prevents
-- duplicate 941/940/W-2 rows from race conditions in the generate actions.
CREATE UNIQUE INDEX payroll_forms_unique_active
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

-- ----------------------------------------------------------------------------
-- payroll_audit_events (append-only audit trail for sensitive actions)
-- Append-only by RLS: authenticated users may SELECT and INSERT, never
-- UPDATE or DELETE. See migrations/20260417_create_payroll_and_email.sql
-- for event_type / metadata shape conventions.
-- ----------------------------------------------------------------------------

CREATE TABLE payroll_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID,
  actor_email     TEXT,
  event_type      TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX payroll_audit_events_created_at_idx ON payroll_audit_events (created_at DESC);
CREATE INDEX payroll_audit_events_event_type_idx ON payroll_audit_events (event_type, created_at DESC);
CREATE INDEX payroll_audit_events_target_idx     ON payroll_audit_events (target_type, target_id);
CREATE INDEX payroll_audit_events_actor_idx      ON payroll_audit_events (actor_user_id, created_at DESC);

ALTER TABLE payroll_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_audit_events_select ON payroll_audit_events
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY payroll_audit_events_insert ON payroll_audit_events
  FOR INSERT TO authenticated WITH CHECK (TRUE);

-- ----------------------------------------------------------------------------
-- RLS for the remaining 10 payroll tables (full CRUD)
-- ----------------------------------------------------------------------------

ALTER TABLE organization_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_tax_configs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_tax_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_change_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employees         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_tax_deposits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_deposit_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_forms             ENABLE ROW LEVEL SECURITY;

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
