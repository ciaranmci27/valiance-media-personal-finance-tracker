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
  tax_year              INTEGER NOT NULL,
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
  -- IRC 199A limitation inputs. Above the threshold amount an SSTB loses the
  -- deduction entirely; any other business is capped by the greater of 50% of
  -- its W-2 wages or 25% of wages plus 2.5% of unadjusted property basis.
  is_sstb                 BOOLEAN NOT NULL DEFAULT FALSE,
  business_w2_wages       NUMERIC(12,2) NOT NULL DEFAULT 0,
  business_property_basis NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Additional standard deduction for the aged and the blind (IRC 63(f)).
  taxpayer_age_65       BOOLEAN NOT NULL DEFAULT FALSE,
  taxpayer_blind        BOOLEAN NOT NULL DEFAULT FALSE,
  spouse_age_65         BOOLEAN NOT NULL DEFAULT FALSE,
  spouse_blind          BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for year lookups (most common query)
CREATE INDEX idx_tax_estimates_year ON tax_estimates(tax_year DESC)
  WHERE deleted_at IS NULL;

-- One live estimate per year. Partial so a soft-deleted year can be re-created;
-- a plain UNIQUE would block it forever since reads filter on deleted_at.
CREATE UNIQUE INDEX idx_tax_estimates_year_unique_active ON tax_estimates(tax_year)
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

-- ACCOUNTING FOUNDATION BEGIN
-- Declarative accounting definitions. Owner provisioning is an operator action.
CREATE TABLE public.acct_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  books_timezone text NOT NULL DEFAULT 'America/Phoenix',
  financial_revision bigint NOT NULL DEFAULT 0 CHECK (financial_revision >= 0)
);
CREATE TABLE public.acct_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL DEFAULT '' CHECK (length(code) <= 20),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','equity','income','expense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit','credit')),
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX acct_account_code_unique ON public.acct_accounts(code) WHERE code <> '';
CREATE TABLE public.acct_periods (
  month_start date PRIMARY KEY CHECK (extract(day FROM month_start) = 1),
  is_locked boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date date NOT NULL CHECK (entry_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  memo text NOT NULL CHECK (length(btrim(memo)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','discarded')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  primary_origin text NOT NULL DEFAULT 'manual' CHECK (primary_origin IN ('manual','wave','simplefin','csv','internal')),
  reverses_entry_id uuid UNIQUE REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE INDEX acct_entries_date ON public.acct_journal_entries(entry_date, created_at, id);
CREATE TABLE public.acct_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.acct_accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND amount_cents > '-9223372036854775808'::bigint),
  memo text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
  UNIQUE (entry_id, sort_order)
);
CREATE INDEX acct_lines_account ON public.acct_journal_lines(account_id, entry_id);
CREATE TABLE public.acct_command_receipts (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  action text NOT NULL,
  actor_id uuid,
  operation_id text,
  before_value jsonb,
  after_value jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL CHECK (source_system IN ('wave','simplefin','csv','manual','internal')),
  source_scope text NOT NULL,
  external_id text NOT NULL,
  content_hash text NOT NULL,
  raw_payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_system, source_scope, external_id, content_hash)
);
CREATE TABLE public.acct_source_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES public.acct_source_records(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  UNIQUE(source_record_id, entry_id)
);
CREATE TABLE public.acct_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE,
  original_name text NOT NULL,
  content_hash text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.acct_documents(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id) ON DELETE RESTRICT,
  UNIQUE(document_id, entry_id)
);

CREATE OR REPLACE FUNCTION public.acct_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM public.acct_settings WHERE owner_user_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.acct_require_owner() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.acct_is_owner() THEN RAISE EXCEPTION 'ACCT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN auth.uid();
END $$;

-- One company's low-volume writes serialize on one row. Period locks use the
-- same row, avoiding lock-order races before taking entry/account locks.
CREATE OR REPLACE FUNCTION public.acct_write_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.acct_settings WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_CONFIGURED'; END IF;
END $$;
-- Acquire the company lock before tuple locks, including privileged direct DML.
CREATE OR REPLACE FUNCTION public.acct_lock_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_accounts','acct_periods','acct_journal_entries','acct_journal_lines'] LOOP
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.acct_require_open(p_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_month date := date_trunc('month',p_date)::date;
BEGIN
  PERFORM public.acct_write_lock();
  INSERT INTO public.acct_periods(month_start) VALUES(v_month) ON CONFLICT DO NOTHING;
  IF (SELECT is_locked FROM public.acct_periods WHERE month_start=v_month) THEN
    RAISE EXCEPTION 'ACCT_PERIOD_LOCKED';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.acct_guard_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
    IF NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.primary_origin <> OLD.primary_origin OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id THEN
      RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY';
    END IF;
    PERFORM public.acct_require_open(OLD.entry_date);
    NEW.version := OLD.version + 1;
  ELSIF NEW.status <> 'draft' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'ACCT_CREATE_DRAFT_FIRST';
  END IF;
  PERFORM public.acct_require_open(NEW.entry_date);
  RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_entry BEFORE INSERT OR UPDATE OR DELETE ON public.acct_journal_entries
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_entry();

CREATE OR REPLACE FUNCTION public.acct_guard_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_entry public.acct_journal_entries;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='UPDATE' AND (NEW.entry_id <> OLD.entry_id OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY';
  END IF;
  SELECT * INTO v_entry FROM public.acct_journal_entries
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END FOR UPDATE;
  IF v_entry.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  PERFORM public.acct_require_open(v_entry.entry_date);
  IF TG_OP <> 'DELETE' AND EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=NEW.account_id AND is_archived) THEN
    RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_line BEFORE INSERT OR UPDATE OR DELETE ON public.acct_journal_lines
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_line();

CREATE OR REPLACE FUNCTION public.acct_assert_balanced(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer; v_sum numeric;
BEGIN
  SELECT count(*),coalesce(sum(amount_cents),0) INTO v_count,v_sum FROM public.acct_journal_lines WHERE entry_id=p_id;
  IF v_count < 2 OR v_count > 100 OR v_sum <> 0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.acct_balance_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF TG_TABLE_NAME='acct_journal_entries' THEN v_id := NEW.id;
  ELSE v_id := CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_id AND status='posted') THEN
    PERFORM public.acct_assert_balanced(v_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER acct_entry_balance AFTER INSERT OR UPDATE ON public.acct_journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_balance_constraint();
CREATE CONSTRAINT TRIGGER acct_line_balance AFTER INSERT OR UPDATE OR DELETE ON public.acct_journal_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_balance_constraint();

CREATE OR REPLACE FUNCTION public.acct_guard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id <> OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
    IF (NEW.account_type <> OLD.account_type OR NEW.normal_side <> OLD.normal_side)
       AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE account_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
    IF NEW.is_archived AND NOT OLD.is_archived AND EXISTS(
      SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=OLD.id AND e.status IN ('draft','posted')
      HAVING coalesce(sum(l.amount_cents) FILTER(WHERE e.status='posted'),0) <> 0 OR count(*) FILTER(WHERE e.status='draft') > 0
    ) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_account BEFORE INSERT OR UPDATE OR DELETE ON public.acct_accounts
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_account();
CREATE OR REPLACE FUNCTION public.acct_guard_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' AND NEW.month_start <> OLD.month_start THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  IF NEW.is_locked AND (TG_OP='INSERT' OR NOT OLD.is_locked) THEN
    IF length(btrim(NEW.reason))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='draft'
      AND entry_date >= NEW.month_start AND entry_date < NEW.month_start + INTERVAL '1 month') THEN
      RAISE EXCEPTION 'ACCT_DRAFTS_REMAIN';
    END IF;
  END IF;
  NEW.changed_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER acct_guard_period BEFORE INSERT OR UPDATE OR DELETE ON public.acct_periods
FOR EACH ROW EXECUTE FUNCTION public.acct_guard_period();

CREATE OR REPLACE FUNCTION public.acct_record_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_before jsonb; v_after jsonb; v_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_before:=to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_after:=to_jsonb(NEW); END IF;
  -- JSON numbers lose bigint precision in browsers, including nested audit values.
  FOREACH v_key IN ARRAY ARRAY['amount_cents','financial_revision','size_bytes'] LOOP
    IF v_before ? v_key THEN v_before:=v_before||jsonb_build_object(v_key,v_before->>v_key); END IF;
    IF v_after ? v_key THEN v_after:=v_after||jsonb_build_object(v_key,v_after->>v_key); END IF;
  END LOOP;
  INSERT INTO public.acct_audit_log(table_name,action,actor_id,operation_id,before_value,after_value)
  VALUES(TG_TABLE_NAME,TG_OP,auth.uid(),nullif(current_setting('acct.operation_id',true),''),
    v_before,v_after);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.acct_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_settings','acct_accounts','acct_periods','acct_journal_entries','acct_journal_lines','acct_source_links','acct_documents','acct_document_links'] LOOP
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_audit()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['acct_audit_log','acct_command_receipts','acct_source_records','acct_source_links','acct_documents','acct_document_links'] LOOP
    EXECUTE format('CREATE TRIGGER acct_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.acct_command(p_key uuid, p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := public.acct_require_owner(); v_receipt public.acct_command_receipts;
  v_type text := p_command->>'type'; v_id uuid := (p_command->>'id')::uuid;
  v_entry public.acct_journal_entries; v_new_id uuid; v_result jsonb; v_line jsonb; v_index integer:=0;
BEGIN
  IF p_key IS NULL OR v_id IS NULL OR p_command IS NULL OR octet_length(p_command::text)>100000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();
  -- Recheck after waiting in case an operator changed the owner meanwhile.
  v_actor:=public.acct_require_owner();
  SELECT * INTO v_receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF v_receipt.actor_id<>v_actor OR v_receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN v_receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF v_type='account.create' THEN
    INSERT INTO public.acct_accounts(id,code,name,account_type,normal_side)
    VALUES(v_id,coalesce(p_command->>'code',''),btrim(p_command->>'name'),p_command->>'account_type',p_command->>'normal_side');
    v_result:=jsonb_build_object('id',v_id);
  ELSIF v_type='draft.save' THEN
    IF jsonb_typeof(p_command->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'lines')>100 THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id FOR UPDATE;
    IF FOUND THEN
      IF v_entry.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
      IF v_entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
      UPDATE public.acct_journal_entries SET entry_date=(p_command->>'entry_date')::date,memo=btrim(p_command->>'memo') WHERE id=v_id;
      DELETE FROM public.acct_journal_lines WHERE entry_id=v_id;
    ELSE
      IF (p_command->>'expected_version')::integer IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,created_by)
      VALUES(v_id,(p_command->>'entry_date')::date,btrim(p_command->>'memo'),v_actor);
    END IF;
    FOR v_line IN SELECT value FROM jsonb_array_elements(p_command->'lines') LOOP
      IF jsonb_typeof(v_line->'amount_cents') IS DISTINCT FROM 'string' OR (v_line->>'amount_cents') !~ '^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
      INSERT INTO public.acct_journal_lines(entry_id,account_id,amount_cents,memo,sort_order)
      VALUES(v_id,(v_line->>'account_id')::uuid,(v_line->>'amount_cents')::bigint,coalesce(v_line->>'memo',''),v_index);
      v_index:=v_index+1;
    END LOOP;
    SELECT jsonb_build_object('id',id,'version',version) INTO v_result FROM public.acct_journal_entries WHERE id=v_id;
  ELSIF v_type IN ('entry.post','draft.discard','entry.reverse') THEN
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF v_entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF v_type='entry.post' THEN
      IF v_entry.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
      PERFORM public.acct_assert_balanced(v_id);
      IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=v_id AND a.is_archived) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
      UPDATE public.acct_journal_entries SET status='posted',posted_at=now() WHERE id=v_id;
    ELSIF v_type='draft.discard' THEN
      IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
      UPDATE public.acct_journal_entries SET status='discarded' WHERE id=v_id;
    ELSE
      IF v_entry.status<>'posted' THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
      IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
      IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=v_id) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
      v_new_id:=gen_random_uuid();
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,created_by,primary_origin,reverses_entry_id)
      VALUES(v_new_id,(p_command->>'entry_date')::date,p_command->>'reason',v_actor,'internal',v_id);
      INSERT INTO public.acct_journal_lines(entry_id,account_id,amount_cents,memo,sort_order)
      SELECT v_new_id,account_id,-amount_cents,memo,sort_order FROM public.acct_journal_lines WHERE entry_id=v_id;
      UPDATE public.acct_journal_entries SET status='posted',posted_at=now() WHERE id=v_new_id;
      v_id:=v_new_id;
    END IF;
    SELECT jsonb_build_object('id',id,'version',version) INTO v_result FROM public.acct_journal_entries WHERE id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,v_actor,p_command,v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_workspace(p_from date, p_to date, p_entry_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_balances jsonb; v_entries jsonb; v_reports jsonb;
BEGIN
  PERFORM public.acct_require_owner();
  IF p_from IS NULL OR p_to IS NULL OR p_from>p_to OR p_from<DATE '1900-01-01' OR p_to>DATE '2100-12-31' THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  WITH b AS (
    SELECT a.*,coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date<p_from),0) AS opening,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=p_from),0) AS period,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=p_from AND l.amount_cents>0),0) AS debit,
      -coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=p_from AND l.amount_cents<0),0) AS credit,
      coalesce(sum(l.amount_cents),0) AS ending,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date<date_trunc('year',p_to)::date),0) AS prior,
      coalesce(sum(l.amount_cents) FILTER(WHERE e.entry_date>=date_trunc('year',p_to)::date),0) AS current_year
    FROM public.acct_accounts a LEFT JOIN
      (public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id AND e.status='posted' AND e.entry_date<=p_to)
      ON l.account_id=a.id GROUP BY a.id
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,'account_type',account_type,'normal_side',normal_side,'is_archived',is_archived,
      'opening_cents',opening::text,'period_cents',period::text,'debit_cents',debit::text,'credit_cents',credit::text,'ending_cents',ending::text) ORDER BY code,name),'[]'),
    jsonb_build_object(
      'income_cents',(-coalesce(sum(period) FILTER(WHERE account_type='income'),0))::text,
      'expense_cents',coalesce(sum(period) FILTER(WHERE account_type='expense'),0)::text,
      'net_income_cents',(-coalesce(sum(period) FILTER(WHERE account_type IN ('income','expense')),0))::text,
      'assets_cents',coalesce(sum(ending) FILTER(WHERE account_type='asset'),0)::text,
      'liabilities_cents',(-coalesce(sum(ending) FILTER(WHERE account_type='liability'),0))::text,
      'equity_cents',(-coalesce(sum(ending) FILTER(WHERE account_type='equity'),0))::text,
      'retained_cents',(-coalesce(sum(prior) FILTER(WHERE account_type IN ('income','expense')),0))::text,
      'year_income_cents',(-coalesce(sum(current_year) FILTER(WHERE account_type IN ('income','expense')),0))::text,
      'balance_difference_cents',coalesce(sum(ending),0)::text,'trial_balance_cents',coalesce(sum(ending),0)::text)
    INTO v_balances,v_reports FROM b;
  IF v_reports->>'trial_balance_cents'<>'0' THEN RAISE EXCEPTION 'ACCT_INTEGRITY_FAILURE'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY entry_date DESC,created_at DESC,id DESC),'[]') INTO v_entries FROM (
    SELECT e.*,(SELECT r.id FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed_by_entry_id,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order)
      FROM public.acct_journal_lines l WHERE l.entry_id=e.id),'[]') AS lines
    FROM public.acct_journal_entries e WHERE (p_entry_id IS NOT NULL AND e.id=p_entry_id)
      OR (p_entry_id IS NULL AND e.entry_date BETWEEN p_from AND p_to AND e.status<>'discarded')
    ORDER BY entry_date DESC,created_at DESC,id DESC LIMIT 200
  ) q;
  RETURN jsonb_build_object('legal_name',(SELECT legal_name FROM public.acct_settings),'revision',(SELECT financial_revision::text FROM public.acct_settings),
    'from',p_from,'to',p_to,'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY code,name),'[]') FROM public.acct_accounts a),
    'entries',v_entries,'entry_count',(SELECT count(*) FROM public.acct_journal_entries WHERE entry_date BETWEEN p_from AND p_to AND status<>'discarded'),
    'draft_count',(SELECT count(*) FROM public.acct_journal_entries WHERE status='draft' AND entry_date BETWEEN p_from AND p_to),
    'balances',v_balances,'reports',v_reports);
END $$;

CREATE OR REPLACE FUNCTION public.acct_export() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object('format','valiance-accounting-foundation','version',1,'generated_at',now(),
    'coverage_status','unverified','includes_document_files',false,
    'settings',(SELECT (to_jsonb(s)-'owner_user_id')||jsonb_build_object('financial_revision',s.financial_revision::text) FROM public.acct_settings s),
    'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM public.acct_accounts a),
    'entries',(SELECT coalesce(jsonb_agg(to_jsonb(e)),'[]') FROM public.acct_journal_entries e),
    'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text)),'[]') FROM public.acct_journal_lines l),
    'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM public.acct_periods p),
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM public.acct_source_records s),
    'source_links',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM public.acct_source_links s),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('size_bytes',d.size_bytes::text)),'[]') FROM public.acct_documents d),
    'document_links',(SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]') FROM public.acct_document_links d),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text)),'[]') FROM public.acct_audit_log a),
    'command_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM public.acct_command_receipts c));
END $$;

DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_settings','acct_accounts','acct_periods','acct_journal_entries','acct_journal_lines',
    'acct_command_receipts','acct_audit_log','acct_source_records','acct_source_links','acct_documents','acct_document_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role',t);
    -- Read through exact-cent functions only. Table grants stay revoked.
    EXECUTE format('CREATE POLICY acct_owner_read ON public.%I FOR SELECT TO authenticated USING (public.acct_is_owner())',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'acct\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.acct_is_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_command(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_workspace(date,date,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_export() TO authenticated;
-- ACCOUNTING FOUNDATION END


-- ACCOUNTING WORKFLOWS BEGIN
-- This module extends the immutable ledger; all writes use acct_execute.
CREATE OR REPLACE FUNCTION public.acct_record_workflow_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_before jsonb;v_after jsonb;v_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN v_before:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN v_after:=to_jsonb(NEW); END IF;
  FOR v_key IN SELECT key FROM jsonb_each(coalesce(v_after,v_before)) WHERE key LIKE '%\_cents' ESCAPE '\' OR key IN ('revision','financial_revision','size_bytes') LOOP
    IF v_before ? v_key THEN v_before:=v_before||jsonb_build_object(v_key,v_before->>v_key); END IF;
    IF v_after ? v_key THEN v_after:=v_after||jsonb_build_object(v_key,v_after->>v_key); END IF;
  END LOOP;
  INSERT INTO public.acct_audit_log(table_name,action,actor_id,operation_id,before_value,after_value) VALUES(TG_TABLE_NAME,TG_OP,auth.uid(),nullif(current_setting('acct.operation_id',true),''),v_before,v_after);
  RETURN NULL;
END $$;
CREATE TABLE public.acct_account_profiles (
  account_id uuid PRIMARY KEY REFERENCES public.acct_accounts(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  purpose text UNIQUE,
  cash_kind text NOT NULL DEFAULT 'none' CHECK(cash_kind IN ('none','bank','cash','card')),
  parent_account_id uuid REFERENCES public.acct_accounts(id) ON DELETE RESTRICT,
  subtype text NOT NULL DEFAULT '' CHECK(length(subtype)<=100),
  CHECK(parent_account_id IS DISTINCT FROM account_id)
);
CREATE TABLE public.acct_book_preferences (
  singleton boolean PRIMARY KEY DEFAULT true REFERENCES public.acct_settings(singleton),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  authority_mode text NOT NULL DEFAULT 'wave_primary' CHECK(authority_mode IN ('wave_primary','parallel_pilot','admin_primary')),
  primary_from date,
  history_start date,
  transfer_window_days integer NOT NULL DEFAULT 5 CHECK(transfer_window_days BETWEEN 0 AND 30),
  transit_alert_days integer NOT NULL DEFAULT 14 CHECK(transit_alert_days BETWEEN 1 AND 365),
  CHECK(authority_mode<>'admin_primary' OR primary_from IS NOT NULL)
);
CREATE TABLE public.acct_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('vendor','customer','both')),
  default_account_id uuid REFERENCES public.acct_accounts(id),
  tax_classification text NOT NULL DEFAULT 'unreviewed' CHECK(tax_classification IN ('unreviewed','individual','corporation','partnership','foreign','other')),
  documentation text NOT NULL DEFAULT 'missing' CHECK(documentation IN ('missing','requested','received','not_required')),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=3000),
  is_archived boolean NOT NULL DEFAULT false
);
CREATE TABLE public.acct_dimensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('project','business_line')),
  customer_id uuid REFERENCES public.acct_parties(id),
  is_archived boolean NOT NULL DEFAULT false
);
CREATE TABLE public.acct_entry_context (
  entry_id uuid PRIMARY KEY REFERENCES public.acct_journal_entries(id),
  kind text NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','income','expense','transfer','payroll','opening','owner','loan','asset','invoice_receipt','refund')),
  payee_id uuid REFERENCES public.acct_parties(id),
  customer_id uuid REFERENCES public.acct_parties(id),
  project_id uuid REFERENCES public.acct_dimensions(id),
  business_line_id uuid REFERENCES public.acct_dimensions(id),
  payment_rail text NOT NULL DEFAULT 'unknown' CHECK(payment_rail IN ('unknown','ach','check','cash','card','third_party','wire','other')),
  contractor_treatment text NOT NULL DEFAULT 'unreviewed' CHECK(contractor_treatment IN ('unreviewed','reportable','excluded')),
  contractor_reason text NOT NULL DEFAULT '' CHECK(length(contractor_reason)<=1000)
);
CREATE TABLE public.acct_entry_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_entry_id uuid NOT NULL UNIQUE REFERENCES public.acct_journal_entries(id),
  reversal_entry_id uuid NOT NULL UNIQUE REFERENCES public.acct_journal_entries(id),
  replacement_entry_id uuid UNIQUE REFERENCES public.acct_journal_entries(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_journal_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL UNIQUE CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  memo text NOT NULL CHECK(length(btrim(memo)) BETWEEN 1 AND 1000),
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 2 AND 100),
  is_archived boolean NOT NULL DEFAULT false
);
CREATE TABLE public.acct_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL UNIQUE CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object')
);
CREATE TABLE public.acct_report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('report','close','filing','restatement','historical_baseline')),
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  revision bigint NOT NULL,
  report_version integer NOT NULL DEFAULT 2,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);

CREATE OR REPLACE FUNCTION public.acct_context_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='UPDATE' AND NEW.entry_id<>OLD.entry_id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  v_id:=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_id AND status='draft') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  IF TG_OP<>'DELETE' THEN
    IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_dimensions WHERE id=NEW.project_id AND kind='project' AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_DIMENSION'; END IF;
    IF NEW.business_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_dimensions WHERE id=NEW.business_line_id AND kind='business_line' AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_DIMENSION'; END IF;
    IF NEW.contractor_treatment='excluded' AND length(btrim(NEW.contractor_reason))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER acct_context_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_entry_context FOR EACH ROW EXECUTE FUNCTION public.acct_context_guard();

CREATE OR REPLACE FUNCTION public.acct_profile_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_type text; v_parent uuid;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  SELECT account_type INTO v_type FROM public.acct_accounts WHERE id=NEW.account_id;
  IF (NEW.cash_kind IN ('bank','cash') AND v_type<>'asset') OR (NEW.cash_kind='card' AND v_type<>'liability') THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id<>OLD.account_id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
    IF (NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.cash_kind<>OLD.cash_kind) AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE account_id=NEW.account_id) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
    NEW.version:=OLD.version+1;
  END IF;
  v_parent:=NEW.parent_account_id;
  WHILE v_parent IS NOT NULL LOOP
    IF v_parent=NEW.account_id THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CYCLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=v_parent AND account_type=v_type) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_PARENT'; END IF;
    SELECT parent_account_id INTO v_parent FROM public.acct_account_profiles WHERE account_id=v_parent;
    IF v_parent IS NOT NULL THEN RAISE EXCEPTION 'ACCT_ACCOUNT_PARENT_DEPTH'; END IF;
  END LOOP;
  IF NEW.parent_account_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE parent_account_id=NEW.account_id) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_PARENT_DEPTH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_account_profiles FOR EACH ROW EXECUTE FUNCTION public.acct_profile_guard();

CREATE OR REPLACE FUNCTION public.acct_validate_template(p_lines jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l jsonb; total numeric:=0; n integer:=0; v_amount bigint;
BEGIN
  IF jsonb_typeof(p_lines)<>'array' THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(l->'amount_cents') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
    v_amount:=(l->>'amount_cents')::bigint;
    IF v_amount=0 OR v_amount='-9223372036854775808'::bigint THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=(l->>'account_id')::uuid AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
    total:=total+v_amount;n:=n+1;
  END LOOP;
  IF total<>0 OR n<2 OR n>100 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
END $$;

-- Extended command dispatcher. The original command remains the primitive for
-- draft/post operations, including nested operations in one outer transaction.
CREATE OR REPLACE FUNCTION public.acct_execute(p_key uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=public.acct_require_owner(); receipt public.acct_command_receipts;
  op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid;
  v_result jsonb; v_profile public.acct_account_profiles; v_account public.acct_accounts;
  v_template public.acct_journal_templates; v_entry public.acct_journal_entries;
  reversal jsonb; replacement jsonb; v_version integer; x jsonb;
BEGIN
  IF p_key IS NULL OR p_command IS NULL OR v_id IS NULL OR octet_length(p_command::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();actor:=public.acct_require_owner();
  SELECT * INTO receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF op IN ('account.create','draft.save','entry.post','draft.discard','entry.reverse') THEN
    RETURN public.acct_command(p_key,p_command);
  ELSIF op='entry.bulkpost' THEN
    IF jsonb_typeof(p_command->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'entries') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'entries') LOOP
      PERFORM public.acct_command(gen_random_uuid(),x||jsonb_build_object('type','entry.post'));
    END LOOP;
    v_result:=jsonb_build_object('id',v_id,'posted',jsonb_array_length(p_command->'entries'));
  ELSIF op='transaction.save' THEN
    replacement:=public.acct_command(gen_random_uuid(),(p_command-'context')||jsonb_build_object('type','draft.save'));
    IF p_command ? 'context' THEN
      replacement:=public.acct_execute(gen_random_uuid(),(p_command->'context')||jsonb_build_object('type','entry.context','id',v_id,'expected_version',replacement->'version'));
    END IF;
    v_result:=replacement;
  ELSIF op='dimension.save' THEN
    SELECT version INTO v_version FROM public.acct_dimensions WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_dimensions WHERE id=v_id AND kind<>p_command->>'kind') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
    IF nullif(p_command->>'customer_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=(p_command->>'customer_id')::uuid AND kind IN ('customer','both') AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_CUSTOMER'; END IF;
    INSERT INTO public.acct_dimensions(id,name,kind,customer_id,is_archived) VALUES(v_id,btrim(p_command->>'name'),p_command->>'kind',nullif(p_command->>'customer_id','')::uuid,coalesce((p_command->>'is_archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,customer_id=excluded.customer_id,is_archived=excluded.is_archived,version=acct_dimensions.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='preferences.save' THEN
    SELECT version INTO v_version FROM public.acct_book_preferences WHERE singleton;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF p_command->>'authority_mode' NOT IN ('wave_primary','parallel_pilot') THEN RAISE EXCEPTION 'ACCT_PRIMARY_REQUIRES_ACCEPTANCE'; END IF;
    UPDATE public.acct_settings SET legal_name=btrim(p_command->>'legal_name') WHERE singleton;
    INSERT INTO public.acct_book_preferences(singleton,authority_mode,history_start,transfer_window_days,transit_alert_days)
    VALUES(true,p_command->>'authority_mode',nullif(p_command->>'history_start','')::date,(p_command->>'transfer_window_days')::integer,(p_command->>'transit_alert_days')::integer)
    ON CONFLICT(singleton) DO UPDATE SET authority_mode=excluded.authority_mode,history_start=excluded.history_start,transfer_window_days=excluded.transfer_window_days,transit_alert_days=excluded.transit_alert_days,version=acct_book_preferences.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='account.update' THEN
    SELECT * INTO v_account FROM public.acct_accounts WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    SELECT * INTO v_profile FROM public.acct_account_profiles WHERE account_id=v_id;
    IF coalesce(v_profile.version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    UPDATE public.acct_accounts SET name=btrim(p_command->>'name'),code=btrim(coalesce(p_command->>'code','')),is_archived=coalesce((p_command->>'is_archived')::boolean,false) WHERE id=v_id;
    INSERT INTO public.acct_account_profiles(account_id,purpose,cash_kind,parent_account_id,subtype)
    VALUES(v_id,nullif(p_command->>'purpose',''),coalesce(p_command->>'cash_kind','none'),nullif(p_command->>'parent_account_id','')::uuid,coalesce(p_command->>'subtype',''))
    ON CONFLICT(account_id) DO UPDATE SET purpose=excluded.purpose,cash_kind=excluded.cash_kind,parent_account_id=excluded.parent_account_id,subtype=excluded.subtype;
    SELECT jsonb_build_object('id',v_id,'version',version) INTO v_result FROM public.acct_account_profiles WHERE account_id=v_id;
  ELSIF op='chart.seed' THEN
    IF EXISTS(SELECT 1 FROM public.acct_accounts) THEN RAISE EXCEPTION 'ACCT_CHART_EXISTS'; END IF;
    IF jsonb_typeof(p_command->'accounts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'accounts') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'accounts') LOOP
      PERFORM public.acct_command(gen_random_uuid(),(x-'purpose'-'cash_kind')||jsonb_build_object('type','account.create'));
      INSERT INTO public.acct_account_profiles(account_id,purpose,cash_kind) VALUES((x->>'id')::uuid,nullif(x->>'purpose',''),coalesce(x->>'cash_kind','none'));
    END LOOP;
    v_result:=jsonb_build_object('id',v_id,'count',jsonb_array_length(p_command->'accounts'));
  ELSIF op='entry.context' THEN
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF v_entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    UPDATE public.acct_journal_entries SET memo=memo WHERE id=v_id;
    INSERT INTO public.acct_entry_context(entry_id,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason)
    VALUES(v_id,coalesce(p_command->>'kind','manual'),nullif(p_command->>'payee_id','')::uuid,nullif(p_command->>'customer_id','')::uuid,nullif(p_command->>'project_id','')::uuid,nullif(p_command->>'business_line_id','')::uuid,coalesce(p_command->>'payment_rail','unknown'),coalesce(p_command->>'contractor_treatment','unreviewed'),coalesce(p_command->>'contractor_reason',''))
    ON CONFLICT(entry_id) DO UPDATE SET kind=excluded.kind,payee_id=excluded.payee_id,customer_id=excluded.customer_id,project_id=excluded.project_id,business_line_id=excluded.business_line_id,payment_rail=excluded.payment_rail,contractor_treatment=excluded.contractor_treatment,contractor_reason=excluded.contractor_reason;
    v_result:=jsonb_build_object('id',v_id,'version',v_entry.version+1);
  ELSIF op='entry.correct' THEN
    SELECT * INTO v_entry FROM public.acct_journal_entries WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    PERFORM public.acct_validate_template(p_command->'lines');
    reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',v_id,'expected_version',p_command->'expected_version','entry_date',p_command->'entry_date','reason',p_command->'reason'));
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',p_command->'replacement_id','expected_version',0,'entry_date',p_command->'entry_date','memo',p_command->'memo','lines',p_command->'lines'));
    INSERT INTO public.acct_entry_context SELECT (replacement->>'id')::uuid,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason FROM public.acct_entry_context WHERE entry_id=v_id;
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by)
    VALUES(v_id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    v_result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',v_id);
  ELSIF op='entry.annotate' THEN
    INSERT INTO public.acct_annotations(id,entry_id,note,created_by) VALUES(v_id,(p_command->>'entry_id')::uuid,p_command->>'note',actor);
    v_result:=jsonb_build_object('id',v_id);
  ELSIF op='party.save' THEN
    SELECT version INTO v_version FROM public.acct_parties WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_parties(id,name,kind,default_account_id,tax_classification,documentation,notes,is_archived)
    VALUES(v_id,btrim(p_command->>'name'),p_command->>'kind',nullif(p_command->>'default_account_id','')::uuid,coalesce(p_command->>'tax_classification','unreviewed'),coalesce(p_command->>'documentation','missing'),coalesce(p_command->>'notes',''),coalesce((p_command->>'is_archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,default_account_id=excluded.default_account_id,tax_classification=excluded.tax_classification,documentation=excluded.documentation,notes=excluded.notes,is_archived=excluded.is_archived,version=acct_parties.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='template.save' THEN
    PERFORM public.acct_validate_template(p_command->'lines');
    SELECT version INTO v_version FROM public.acct_journal_templates WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_journal_templates(id,name,memo,lines,is_archived) VALUES(v_id,btrim(p_command->>'name'),p_command->>'memo',p_command->'lines',coalesce((p_command->>'is_archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,memo=excluded.memo,lines=excluded.lines,is_archived=excluded.is_archived,version=acct_journal_templates.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='view.save' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_command->'filters') k WHERE k NOT IN ('from','to','account','status','source','query','payee','project','business_line','missing_receipt','min_cents','max_cents')) THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
    SELECT version INTO v_version FROM public.acct_saved_views WHERE id=v_id;
    IF coalesce(v_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_saved_views(id,name,filters) VALUES(v_id,btrim(p_command->>'name'),p_command->'filters')
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters=excluded.filters,version=acct_saved_views.version+1;
    v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_version,0)+1);
  ELSIF op='report.snapshot' THEN
    x:=public.acct_workspace((p_command->>'from')::date,(p_command->>'to')::date);
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by)
    VALUES(v_id,'report',(p_command->>'from')::date,(p_command->>'to')::date,(x->>'revision')::bigint,x,actor);
    v_result:=jsonb_build_object('id',v_id);
  ELSIF op LIKE 'import.%' THEN
    v_result:=public.acct_import_command(p_command,actor);
  ELSIF op LIKE 'document.%' THEN
    v_result:=public.acct_document_command(p_command,actor);
  ELSE
    RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,actor,p_command,v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_register(p_filter jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb; v_total bigint; v_offset integer:=coalesce((p_filter->>'offset')::integer,0); v_limit integer:=coalesce((p_filter->>'limit')::integer,50);
BEGIN
  PERFORM public.acct_require_owner();
  IF v_offset<0 OR v_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  WITH matches AS (
    SELECT e.id FROM public.acct_journal_entries e LEFT JOIN public.acct_entry_context c ON c.entry_id=e.id
    WHERE (p_filter->>'from' IS NULL OR e.entry_date>=(p_filter->>'from')::date)
      AND (p_filter->>'to' IS NULL OR e.entry_date<=(p_filter->>'to')::date)
      AND (coalesce(p_filter->>'status','all')='all' OR e.status=p_filter->>'status')
      AND (p_filter->>'entry_id' IS NULL OR e.id=(p_filter->>'entry_id')::uuid)
      AND (p_filter->>'account' IS NULL OR EXISTS(SELECT 1 FROM public.acct_journal_lines l WHERE l.entry_id=e.id AND l.account_id=(p_filter->>'account')::uuid))
      AND (p_filter->>'payee' IS NULL OR c.payee_id=(p_filter->>'payee')::uuid)
      AND (p_filter->>'project' IS NULL OR c.project_id=(p_filter->>'project')::uuid)
      AND (p_filter->>'business_line' IS NULL OR c.business_line_id=(p_filter->>'business_line')::uuid)
      AND (p_filter->>'source' IS NULL OR e.primary_origin=p_filter->>'source' OR EXISTS(SELECT 1 FROM public.acct_source_links sl JOIN public.acct_source_records s ON s.id=sl.source_record_id WHERE sl.entry_id=e.id AND s.source_system=p_filter->>'source'))
      AND (NOT coalesce((p_filter->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM public.acct_document_links dl WHERE dl.entry_id=e.id))
      AND (p_filter->>'query' IS NULL OR e.memo ILIKE '%'||(p_filter->>'query')||'%' OR EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND (l.memo||' '||a.name) ILIKE '%'||(p_filter->>'query')||'%'))
      AND (p_filter->>'min_cents' IS NULL OR (SELECT coalesce(sum(amount_cents) FILTER(WHERE amount_cents>0),0) FROM public.acct_journal_lines WHERE entry_id=e.id)>=(p_filter->>'min_cents')::numeric)
      AND (p_filter->>'max_cents' IS NULL OR (SELECT coalesce(sum(amount_cents) FILTER(WHERE amount_cents>0),0) FROM public.acct_journal_lines WHERE entry_id=e.id)<=(p_filter->>'max_cents')::numeric)
  ), page AS (
    SELECT e.*,(SELECT r.id FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed_by_entry_id,
      (SELECT to_jsonb(c) FROM public.acct_entry_context c WHERE c.entry_id=e.id) AS context,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order),'[]') FROM public.acct_journal_lines l WHERE l.entry_id=e.id) AS lines
    FROM public.acct_journal_entries e JOIN matches m ON m.id=e.id ORDER BY e.entry_date DESC,e.created_at DESC,e.id DESC LIMIT v_limit OFFSET v_offset
  ) SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY entry_date DESC,created_at DESC,id DESC) FROM page p),'[]'),
    'total',(SELECT count(*) FROM matches),'offset',v_offset,'limit',v_limit,'revision',(SELECT financial_revision::text FROM public.acct_settings)) INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_account_ledger(p_account uuid,p_from date,p_to date,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric; v_result jsonb;
BEGIN
  PERFORM public.acct_require_owner();
  IF p_from>p_to OR p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  SELECT coalesce(sum(l.amount_cents),0) INTO v_open FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=p_account AND e.status='posted' AND e.entry_date<p_from;
  WITH running AS (
    SELECT l.id,l.entry_id,e.entry_date,e.created_at,l.sort_order,e.memo,l.memo AS line_memo,l.amount_cents::text AS amount_cents,
      (v_open+sum(l.amount_cents) OVER(ORDER BY e.entry_date,e.created_at,e.id,l.sort_order ROWS UNBOUNDED PRECEDING))::text AS running_cents
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=p_account AND e.status='posted' AND e.entry_date BETWEEN p_from AND p_to
  ), page AS (SELECT * FROM running ORDER BY entry_date,created_at,entry_id,sort_order,id LIMIT 100 OFFSET p_offset)
  SELECT jsonb_build_object('opening_cents',v_open::text,'total',(SELECT count(*) FROM running),'rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]')) INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_manage() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object(
    'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_account_profiles x),
    'parties',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM public.acct_parties x),
    'dimensions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY kind,name),'[]') FROM public.acct_dimensions x),
    'templates',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM public.acct_journal_templates x),
    'views',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM public.acct_saved_views x),
    'periods',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY month_start DESC),'[]') FROM public.acct_periods x),
    'preferences',(SELECT to_jsonb(x) FROM public.acct_book_preferences x));
END $$;

CREATE OR REPLACE FUNCTION public.acct_entry_evidence(p_entry uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object(
    'rules',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('rule_name',v.name) ORDER BY a.created_at,a.id),'[]') FROM public.acct_rule_applications a JOIN public.acct_rule_versions v ON v.rule_id=a.rule_id AND v.version=a.rule_version WHERE a.entry_id=p_entry),
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY observed_at),'[]') FROM public.acct_source_records s JOIN public.acct_source_links l ON l.source_record_id=s.id WHERE l.entry_id=p_entry),
    'notes',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at),'[]') FROM public.acct_annotations a WHERE entry_id=p_entry),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('size_bytes',d.size_bytes::text)),'[]') FROM public.acct_documents d JOIN public.acct_document_links l ON l.document_id=d.id WHERE l.entry_id=p_entry),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY recorded_at,id),'[]') FROM public.acct_audit_log a WHERE
      coalesce(a.after_value->>'id',a.before_value->>'id')=p_entry::text OR coalesce(a.after_value->>'entry_id',a.before_value->>'entry_id')=p_entry::text));
END $$;

DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_account_profiles','acct_book_preferences','acct_parties','acct_dimensions','acct_entry_context','acct_entry_corrections','acct_annotations','acct_journal_templates','acct_saved_views','acct_report_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['acct_entry_corrections','acct_annotations','acct_report_snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER acct_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'acct\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.acct_is_owner(),public.acct_command(uuid,jsonb),public.acct_workspace(date,date,uuid),public.acct_export(),public.acct_execute(uuid,jsonb),public.acct_register(jsonb),public.acct_account_ledger(uuid,date,date,integer),public.acct_manage(),public.acct_entry_evidence(uuid) TO authenticated;
-- ACCOUNTING WORKFLOWS END


-- ACCOUNTING IMPORTS BEGIN
CREATE TABLE public.acct_import_batches (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  source_system text NOT NULL CHECK(source_system IN ('wave','csv','simplefin')),
  source_scope text NOT NULL CHECK(length(source_scope) BETWEEN 1 AND 250),
  file_hash text NOT NULL CHECK(length(file_hash)=64),
  mapping_hash text NOT NULL CHECK(length(mapping_hash)=64),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 250),
  source_document_id uuid REFERENCES public.acct_documents(id),
  mode text NOT NULL CHECK(mode IN ('journal','bank')),
  basis text NOT NULL CHECK(basis IN ('cash','unconfirmed')),
  status text NOT NULL DEFAULT 'staging' CHECK(status IN ('staging','review','applying','completed','cancelled','failed')),
  expected_groups integer NOT NULL CHECK(expected_groups BETWEEN 1 AND 50000),
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  coverage_verified boolean NOT NULL DEFAULT false,
  error text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_system,source_scope,file_hash,mapping_hash)
);
CREATE TABLE public.acct_import_groups (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES public.acct_import_batches(id),
  ordinal integer NOT NULL CHECK(ordinal>=0),
  version integer NOT NULL DEFAULT 1,
  source_record_id uuid NOT NULL REFERENCES public.acct_source_records(id),
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  identity_kind text NOT NULL CHECK(identity_kind IN ('provider_id','fingerprint_multiplicity')),
  entry_date date NOT NULL,
  memo text NOT NULL,
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
  bank_account_id uuid REFERENCES public.acct_accounts(id),
  bank_amount_cents bigint CHECK(bank_amount_cents<>0 AND bank_amount_cents>'-9223372036854775808'::bigint),
  status text NOT NULL CHECK(status IN ('new','duplicate','review','exception','applied','excluded')),
  entry_id uuid REFERENCES public.acct_journal_entries(id),
  candidate_entry_id uuid REFERENCES public.acct_journal_entries(id),
  reason text NOT NULL DEFAULT '',
  UNIQUE(batch_id,ordinal),UNIQUE(batch_id,source_record_id)
);
CREATE INDEX acct_import_groups_batch_status ON public.acct_import_groups(batch_id,status,ordinal);
CREATE TABLE public.acct_bank_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES public.acct_source_records(id),
  entry_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);

CREATE OR REPLACE FUNCTION public.acct_import_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid;
  batch public.acct_import_batches; g public.acct_import_groups; x jsonb; src uuid; candidate uuid; v_status text;
  result jsonb; saved jsonb; v_entry uuid; v_line uuid; v_uncategorized uuid; v_lines jsonb;
  v_count integer; v_posted integer:=0; v_drafted integer:=0;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='import.create' THEN
    SELECT * INTO batch FROM public.acct_import_batches WHERE source_system=p_command->>'source_system' AND source_scope=p_command->>'source_scope' AND file_hash=p_command->>'file_hash' AND mapping_hash=p_command->>'mapping_hash';
    IF FOUND THEN RETURN jsonb_build_object('id',batch.id,'version',batch.version,'existing',true); END IF;
    INSERT INTO public.acct_import_batches(id,source_system,source_scope,file_hash,mapping_hash,file_name,source_document_id,mode,basis,expected_groups,from_date,to_date,created_by)
    VALUES(v_id,p_command->>'source_system',p_command->>'source_scope',p_command->>'file_hash',p_command->>'mapping_hash',p_command->>'file_name',nullif(p_command->>'source_document_id','')::uuid,p_command->>'mode',p_command->>'basis',(p_command->>'expected_groups')::integer,(p_command->>'from')::date,(p_command->>'to')::date,p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1);
  END IF;
  IF op IN ('import.stage','import.apply','import.cancel','import.finish') THEN
    SELECT * INTO batch FROM public.acct_import_batches WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF batch.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF batch.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  END IF;
  IF op='import.stage' THEN
    IF batch.status<>'staging' OR jsonb_typeof(p_command->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'groups') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_STAGE'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'groups') LOOP
      IF (x->>'ordinal')::integer<>(SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id) THEN RAISE EXCEPTION 'ACCT_IMPORT_CHECKPOINT'; END IF;
      IF (x->>'ordinal')::integer>=batch.expected_groups OR (x->>'entry_date')::date NOT BETWEEN batch.from_date AND batch.to_date THEN RAISE EXCEPTION 'ACCT_IMPORT_SCOPE'; END IF;
      INSERT INTO public.acct_source_records(source_system,source_scope,external_id,content_hash,raw_payload)
      VALUES(batch.source_system,batch.source_scope,x->>'external_id',x->>'source_hash',x->'raw')
      ON CONFLICT(source_system,source_scope,external_id,content_hash) DO NOTHING;
      SELECT id INTO src FROM public.acct_source_records WHERE source_system=batch.source_system AND source_scope=batch.source_scope AND external_id=x->>'external_id' AND content_hash=x->>'source_hash';
      SELECT l.entry_id INTO candidate FROM public.acct_source_links l JOIN public.acct_journal_entries e ON e.id=l.entry_id
        JOIN public.acct_source_records s ON s.id=l.source_record_id JOIN public.acct_import_groups previous ON previous.source_record_id=s.id
        WHERE s.source_system=batch.source_system AND s.source_scope=batch.source_scope AND s.external_id=x->>'external_id' AND previous.fingerprint=x->>'fingerprint' AND e.status<>'discarded' ORDER BY e.created_at LIMIT 1;
      v_status:=CASE WHEN candidate IS NOT NULL THEN 'duplicate' ELSE 'new' END;
      IF candidate IS NULL AND EXISTS(SELECT 1 FROM public.acct_source_records s JOIN public.acct_source_links l ON l.source_record_id=s.id WHERE s.source_system=batch.source_system AND s.source_scope=batch.source_scope AND s.external_id=x->>'external_id') THEN v_status:='exception'; END IF;
      IF batch.mode='bank' THEN
        IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id=(x->>'bank_account_id')::uuid AND p.cash_kind IN ('bank','cash','card') AND NOT a.is_archived) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
        IF candidate IS NULL THEN
          SELECT e.id INTO candidate FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
          WHERE l.account_id=(x->>'bank_account_id')::uuid AND l.amount_cents=(x->>'bank_amount_cents')::bigint AND e.status<>'discarded' AND abs(e.entry_date-(x->>'entry_date')::date)<=5 ORDER BY abs(e.entry_date-(x->>'entry_date')::date),e.id LIMIT 1;
          IF candidate IS NOT NULL AND v_status='new' THEN v_status:='review'; END IF;
        END IF;
      ELSE
        PERFORM public.acct_validate_template(x->'lines');
      END IF;
      IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=date_trunc('month',(x->>'entry_date')::date)::date AND is_locked) AND v_status<>'duplicate' THEN v_status:='exception'; END IF;
      INSERT INTO public.acct_import_groups(id,batch_id,ordinal,source_record_id,fingerprint,identity_kind,entry_date,memo,lines,bank_account_id,bank_amount_cents,status,entry_id,candidate_entry_id,reason)
      VALUES((x->>'id')::uuid,v_id,(x->>'ordinal')::integer,src,x->>'fingerprint',x->>'identity_kind',(x->>'entry_date')::date,x->>'memo',coalesce(x->'lines','[]'),nullif(x->>'bank_account_id','')::uuid,nullif(x->>'bank_amount_cents','')::bigint,v_status,CASE WHEN v_status='duplicate' THEN candidate ELSE NULL END,candidate,CASE WHEN v_status='exception' THEN 'Changed source identity or locked financial period requires review.' ELSE '' END);
      IF v_status='duplicate' THEN INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(src,candidate) ON CONFLICT DO NOTHING; END IF;
    END LOOP;
    SELECT count(*) INTO v_count FROM public.acct_import_groups WHERE batch_id=v_id;
    UPDATE public.acct_import_batches SET version=version+1,status=CASE WHEN v_count=expected_groups THEN 'review' ELSE 'staging' END WHERE id=v_id;
  ELSIF op='import.resolve' THEN
    SELECT * INTO g FROM public.acct_import_groups WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    SELECT * INTO batch FROM public.acct_import_batches WHERE id=g.batch_id;
    IF batch.status NOT IN ('review','applying') OR g.status IN ('applied','duplicate','excluded') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
    IF g.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF p_command->>'resolution'='new' THEN
      IF g.status='exception' THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION'; END IF;
      UPDATE public.acct_import_groups SET status='new',version=version+1,candidate_entry_id=NULL,reason=p_command->>'reason' WHERE id=v_id;
    ELSIF p_command->>'resolution'='exclude' THEN
      UPDATE public.acct_import_groups SET status='excluded',version=version+1,reason=p_command->>'reason' WHERE id=v_id;
    ELSIF p_command->>'resolution'='match' THEN
      v_entry:=(p_command->>'entry_id')::uuid;
      IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_entry AND status='posted') THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
      IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=v_entry) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
      IF batch.mode='bank' THEN
        SELECT id INTO v_line FROM public.acct_journal_lines WHERE entry_id=v_entry AND account_id=g.bank_account_id AND amount_cents=g.bank_amount_cents ORDER BY sort_order LIMIT 1;
        IF v_line IS NULL THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
        IF EXISTS(SELECT 1 FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=g.source_record_id
          WHERE m.entry_line_id=v_line AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id<>current_source.external_id) THEN RAISE EXCEPTION 'ACCT_MATCH_ALREADY_USED'; END IF;
        INSERT INTO public.acct_bank_matches(source_record_id,entry_line_id,amount_cents,created_by) VALUES(g.source_record_id,v_line,g.bank_amount_cents,p_actor);
      ELSE
        -- Journal evidence can attach only to the same date and complete line set.
        IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_entry AND entry_date=g.entry_date) OR
          (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM public.acct_journal_lines WHERE entry_id=v_entry) IS DISTINCT FROM
          (SELECT jsonb_agg(jsonb_build_array((j->>'account_id')::uuid,j->>'amount_cents') ORDER BY (j->>'account_id')::uuid,(j->>'amount_cents')::bigint) FROM jsonb_array_elements(g.lines) j) THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
      END IF;
      INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(g.source_record_id,v_entry) ON CONFLICT DO NOTHING;
      UPDATE public.acct_import_groups SET status='duplicate',entry_id=v_entry,version=version+1,reason=p_command->>'reason' WHERE id=v_id;
    ELSE RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    UPDATE public.acct_import_batches SET version=version+1 WHERE id=g.batch_id;
    RETURN jsonb_build_object('id',g.batch_id,'group_id',v_id);
  ELSIF op='import.apply' THEN
    IF batch.status NOT IN ('review','applying') OR batch.basis<>'cash' OR jsonb_array_length(p_command->'group_ids') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'group_ids') LOOP
      SELECT * INTO g FROM public.acct_import_groups WHERE id=(x#>>'{}')::uuid AND batch_id=v_id;
      IF NOT FOUND OR g.status<>'new' THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
      v_entry:=gen_random_uuid();
      IF batch.mode='bank' THEN
        SELECT account_id INTO v_uncategorized FROM public.acct_account_profiles WHERE purpose=CASE WHEN g.bank_amount_cents>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
        IF v_uncategorized IS NULL THEN RAISE EXCEPTION 'ACCT_UNCATEGORIZED_ACCOUNT_REQUIRED'; END IF;
        v_lines:=jsonb_build_array(jsonb_build_object('account_id',g.bank_account_id,'amount_cents',g.bank_amount_cents::text,'memo',''),jsonb_build_object('account_id',v_uncategorized,'amount_cents',(-g.bank_amount_cents)::text,'memo',''));
      ELSE v_lines:=g.lines; END IF;
      -- Set provenance at creation, before any financial content is posted.
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,primary_origin,created_by) VALUES(v_entry,g.entry_date,g.memo,batch.source_system,p_actor);
      saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',v_entry,'expected_version',1,'entry_date',g.entry_date,'memo',g.memo,'lines',v_lines));
      IF batch.mode='journal' THEN
        IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=v_entry AND p.purpose='opening_retained_earnings') THEN
         PERFORM public.acct_retained_review(v_entry,'historical',batch.source_document_id,(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount::text)) FROM (SELECT account_id,sum(amount_cents) amount FROM public.acct_journal_lines WHERE entry_id=v_entry GROUP BY account_id) controls),'Reviewed cash-basis source group imported with its original file',p_actor,NULL,g.id);
        END IF;
        PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',v_entry,'expected_version',saved->'version'));v_posted:=v_posted+1;
      ELSE v_drafted:=v_drafted+1; END IF;
      INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(g.source_record_id,v_entry);
      UPDATE public.acct_import_groups SET status='applied',entry_id=v_entry,version=version+1 WHERE id=g.id;
    END LOOP;
    UPDATE public.acct_import_batches SET version=version+1,status='applying' WHERE id=v_id;
  ELSIF op='import.finish' THEN
    IF batch.status NOT IN ('review','applying') OR (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id)<>batch.expected_groups OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=v_id AND status NOT IN ('applied','duplicate','excluded')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
    UPDATE public.acct_import_batches SET status='completed',version=version+1 WHERE id=v_id;
  ELSIF op='import.cancel' THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_import_batches SET status='cancelled',version=version+1,error=p_command->>'reason' WHERE id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  SELECT jsonb_build_object('id',id,'version',version,'posted',v_posted,'drafted',v_drafted) INTO result FROM public.acct_import_batches WHERE id=v_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.acct_imports(p_batch uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  IF p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  RETURN jsonb_build_object('batches',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY created_at DESC),'[]') FROM public.acct_import_batches b),
    'groups',(SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('bank_amount_cents',g.bank_amount_cents::text) ORDER BY ordinal),'[]') FROM (SELECT * FROM public.acct_import_groups WHERE batch_id=p_batch ORDER BY ordinal LIMIT 100 OFFSET p_offset) g),
    'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM public.acct_import_groups WHERE batch_id=p_batch GROUP BY status) s),
    'total',(SELECT count(*) FROM public.acct_import_groups WHERE batch_id=p_batch));
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_import_batches','acct_import_groups','acct_bank_matches'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  END LOOP;
END $$;
CREATE TRIGGER acct_bank_match_immutable BEFORE UPDATE OR DELETE ON public.acct_bank_matches FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
REVOKE ALL ON FUNCTION public.acct_import_command(jsonb,uuid),public.acct_imports(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_imports(uuid,integer) TO authenticated;
-- ACCOUNTING IMPORTS END


-- ACCOUNTING DOCUMENTS BEGIN
CREATE TABLE public.acct_document_states (
  document_id uuid PRIMARY KEY REFERENCES public.acct_documents(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','available','missing','archived')),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.acct_document_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid; state public.acct_document_states; v_exists boolean;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='document.prepare' THEN
    IF p_command->>'content_hash' !~ '^[a-f0-9]{64}$' OR (p_command->>'size_bytes')::bigint NOT BETWEEN 1 AND 20971520 OR length(p_command->>'original_name') NOT BETWEEN 1 AND 250 OR p_command->>'mime_type' NOT IN ('application/pdf','image/png','image/jpeg','image/webp','text/csv') THEN RAISE EXCEPTION 'ACCT_INVALID_DOCUMENT'; END IF;
    INSERT INTO public.acct_documents(id,storage_path,original_name,content_hash,mime_type,size_bytes) VALUES(v_id,v_id::text||'/'||(p_command->>'content_hash'),p_command->>'original_name',p_command->>'content_hash',p_command->>'mime_type',(p_command->>'size_bytes')::bigint);
    INSERT INTO public.acct_document_states(document_id,uploaded_by) VALUES(v_id,p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1,'storage_path',v_id::text||'/'||(p_command->>'content_hash'));
  END IF;
  SELECT * INTO state FROM public.acct_document_states WHERE document_id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF state.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='document.complete' THEN
    IF state.state<>'uploading' THEN RAISE EXCEPTION 'ACCT_DOCUMENT_STATE'; END IF;
    IF to_regclass('storage.objects') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS(SELECT 1 FROM storage.objects o JOIN public.acct_documents d ON d.storage_path=o.name WHERE o.bucket_id=''accounting-private'' AND d.id=$1)' INTO v_exists USING v_id;
      IF NOT v_exists THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    END IF;
    UPDATE public.acct_document_states SET state='available',version=version+1,updated_at=now() WHERE document_id=v_id;
  ELSIF op='document.link' THEN
    IF state.state<>'available' THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=(p_command->>'entry_id')::uuid AND status<>'discarded') THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    INSERT INTO public.acct_document_links(document_id,entry_id) VALUES(v_id,(p_command->>'entry_id')::uuid) ON CONFLICT DO NOTHING;
    UPDATE public.acct_document_states SET version=version+1,updated_at=now() WHERE document_id=v_id;
  ELSIF op='document.archive' THEN
    IF EXISTS(SELECT 1 FROM public.acct_document_links WHERE document_id=v_id) OR EXISTS(SELECT 1 FROM public.acct_import_batches WHERE source_document_id=v_id) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_document_states SET state='archived',version=version+1,updated_at=now() WHERE document_id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  RETURN jsonb_build_object('id',v_id,'version',state.version+1);
END $$;
CREATE OR REPLACE FUNCTION public.acct_documents_read(p_id uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  IF p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  RETURN jsonb_build_object('documents',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,id),'[]') FROM (
    SELECT d.id,d.storage_path,d.original_name,d.content_hash,d.mime_type,d.size_bytes::text,d.created_at,s.version,s.state,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'entry_date',e.entry_date)),'[]') FROM public.acct_document_links l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.document_id=d.id) AS entries
    FROM public.acct_documents d JOIN public.acct_document_states s ON s.document_id=d.id WHERE (p_id IS NULL AND s.state<>'archived') OR d.id=p_id ORDER BY d.created_at DESC,d.id LIMIT 100 OFFSET p_offset
  ) x),'total',(SELECT count(*) FROM public.acct_document_states WHERE state<>'archived'));
END $$;
CREATE OR REPLACE FUNCTION public.acct_document_object_allowed(p_path text,p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.acct_is_owner() AND EXISTS(SELECT 1 FROM public.acct_documents d JOIN public.acct_document_states s ON s.document_id=d.id WHERE d.storage_path=p_path AND (NOT p_write OR s.state='uploading'));
$$;
ALTER TABLE public.acct_document_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_document_states FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_document_states FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
REVOKE ALL ON FUNCTION public.acct_document_command(jsonb,uuid),public.acct_documents_read(uuid,integer),public.acct_document_object_allowed(text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_documents_read(uuid,integer),public.acct_document_object_allowed(text,boolean) TO authenticated;
DO $$ BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'CREATE POLICY acct_private_evidence_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id=''accounting-private'' AND public.acct_document_object_allowed(name,false))';
    EXECUTE 'CREATE POLICY acct_private_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id=''accounting-private'' AND public.acct_document_object_allowed(name,true))';
  END IF;
END $$;
-- ACCOUNTING DOCUMENTS END


-- ACCOUNTING EXPORTS BEGIN
CREATE OR REPLACE FUNCTION public.acct_books_export() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN public.acct_export()||jsonb_build_object('format','valiance-accounting-books','version',2,
    'coverage_status',CASE WHEN EXISTS(SELECT 1 FROM public.acct_import_batches WHERE status<>'completed' OR NOT coverage_verified) THEN 'unverified_imports' ELSE 'unverified' END,
    'account_profiles',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_account_profiles x),
    'book_preferences',(SELECT to_jsonb(x) FROM public.acct_book_preferences x),
    'parties',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_parties x),
    'dimensions',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_dimensions x),
    'entry_context',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_entry_context x),
    'entry_corrections',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_entry_corrections x),
    'annotations',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_annotations x),
    'journal_templates',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_journal_templates x),
    'saved_views',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_saved_views x),
    'report_snapshots',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('revision',x.revision::text)),'[]') FROM public.acct_report_snapshots x),
    'import_batches',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_import_batches x),
    'import_groups',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('bank_amount_cents',x.bank_amount_cents::text)),'[]') FROM public.acct_import_groups x),
    'bank_matches',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_cents',x.amount_cents::text)),'[]') FROM public.acct_bank_matches x),
    'document_states',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.acct_document_states x));
END $$;
REVOKE ALL ON FUNCTION public.acct_books_export() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_books_export() TO authenticated;
-- ACCOUNTING EXPORTS END

-- ACCOUNTING CLEARING BEGIN
CREATE TABLE public.acct_clearing_allocations (
  id uuid PRIMARY KEY,
  obligation_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  settlement_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  effective_date date NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(obligation_line_id<>settlement_line_id)
);
CREATE INDEX acct_clearing_obligation ON public.acct_clearing_allocations(obligation_line_id,effective_date);
CREATE INDEX acct_clearing_settlement ON public.acct_clearing_allocations(settlement_line_id,effective_date);
CREATE TABLE public.acct_clearing_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL UNIQUE REFERENCES public.acct_clearing_allocations(id),
  effective_date date NOT NULL,
  reversal_entry_id uuid REFERENCES public.acct_journal_entries(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_obligation_reviews (
  id uuid PRIMARY KEY,
  line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  as_of date NOT NULL,
  residual_cents bigint NOT NULL CHECK(residual_cents<>0),
  expected_resolution date NOT NULL CHECK(expected_resolution>as_of),
  document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_transfer_groups (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  outgoing_entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  incoming_entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  from_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
  to_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
  outgoing_date date NOT NULL,
  incoming_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','corrected')),
  memo text NOT NULL CHECK(length(btrim(memo)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(from_account_id<>to_account_id)
);

CREATE OR REPLACE FUNCTION public.acct_clearing_residual(p_line uuid,p_as_of date DEFAULT '2100-12-31') RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT l.amount_cents-sign(l.amount_cents)*coalesce((SELECT sum(a.amount_cents) FROM public.acct_clearing_allocations a WHERE (a.obligation_line_id=l.id OR a.settlement_line_id=l.id) AND a.effective_date<=p_as_of AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id AND r.effective_date<=p_as_of)),0) FROM public.acct_journal_lines l WHERE l.id=p_line;
$$;
CREATE OR REPLACE FUNCTION public.acct_clearing_capacity(p_line uuid,p_from date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH events AS (
   SELECT a.effective_date AS day,a.amount_cents::numeric AS delta FROM public.acct_clearing_allocations a WHERE p_line IN (a.obligation_line_id,a.settlement_line_id) AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id AND r.effective_date<=a.effective_date)
   UNION ALL SELECT r.effective_date,-a.amount_cents::numeric FROM public.acct_clearing_releases r JOIN public.acct_clearing_allocations a ON a.id=r.allocation_id WHERE p_line IN (a.obligation_line_id,a.settlement_line_id) AND r.effective_date>a.effective_date
 ), running AS (SELECT day,sum(sum(delta)) OVER(ORDER BY day) AS used FROM events GROUP BY day)
 SELECT abs(l.amount_cents::numeric)-greatest(coalesce((SELECT sum(delta) FROM events WHERE day<=p_from),0),coalesce((SELECT max(used) FROM running WHERE day>=p_from),0)) FROM public.acct_journal_lines l WHERE l.id=p_line;
$$;
CREATE OR REPLACE FUNCTION public.acct_clearing_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE obligation public.acct_journal_lines;settlement public.acct_journal_lines;obligation_date date;settlement_date date;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
  SELECT * INTO obligation FROM public.acct_journal_lines WHERE id=NEW.obligation_line_id;
  SELECT * INTO settlement FROM public.acct_journal_lines WHERE id=NEW.settlement_line_id;
  SELECT entry_date INTO obligation_date FROM public.acct_journal_entries WHERE id=obligation.entry_id AND status='posted';
  SELECT entry_date INTO settlement_date FROM public.acct_journal_entries WHERE id=settlement.entry_id AND status='posted';
  IF obligation.account_id IS DISTINCT FROM settlement.account_id OR obligation_date IS NULL OR settlement_date IS NULL OR sign(obligation.amount_cents)=sign(settlement.amount_cents) OR NEW.effective_date<>greatest(obligation_date,settlement_date) THEN RAISE EXCEPTION 'ACCT_CLEARING_LINES'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id IN (obligation.entry_id,settlement.entry_id)) AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE (id=obligation.entry_id AND reverses_entry_id=settlement.entry_id) OR (id=settlement.entry_id AND reverses_entry_id=obligation.entry_id)) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
  IF NEW.amount_cents>public.acct_clearing_capacity(obligation.id,NEW.effective_date) OR NEW.amount_cents>public.acct_clearing_capacity(settlement.id,NEW.effective_date) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_clearing_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_clearing_allocations FOR EACH ROW EXECUTE FUNCTION public.acct_clearing_guard();
CREATE OR REPLACE FUNCTION public.acct_clearing_reverse() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='posted' AND OLD.status='draft' AND NEW.reverses_entry_id IS NOT NULL THEN
    INSERT INTO public.acct_clearing_releases(allocation_id,effective_date,reversal_entry_id,reason,created_by)
    SELECT a.id,NEW.entry_date,NEW.id,'Journal reversal released this clearing allocation',NEW.created_by FROM public.acct_clearing_allocations a JOIN public.acct_journal_lines o ON o.id=a.obligation_line_id JOIN public.acct_journal_lines s ON s.id=a.settlement_line_id WHERE NEW.reverses_entry_id IN (o.entry_id,s.entry_id) ON CONFLICT(allocation_id) DO NOTHING;
    INSERT INTO public.acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by)
    SELECT gen_random_uuid(),original.id,reversal.id,abs(original.amount_cents),greatest(NEW.entry_date,e.entry_date),'Original and reversal offset one another',NEW.created_by
    FROM public.acct_journal_lines original JOIN public.acct_journal_entries e ON e.id=original.entry_id JOIN public.acct_journal_lines reversal ON reversal.entry_id=NEW.id AND reversal.sort_order=original.sort_order AND reversal.account_id=original.account_id AND reversal.amount_cents=-original.amount_cents
    JOIN public.acct_account_profiles p ON p.account_id=original.account_id
    WHERE original.entry_id=NEW.reverses_entry_id AND p.purpose IN ('transfers_in_transit','undeposited_funds','net_salary_payable','payroll_taxes_payable','payroll_deductions','retirement_payable','due_to_shareholder','due_from_shareholder','customer_funds','loans_payable','shareholder_loan');
    UPDATE public.acct_transfer_groups SET status='corrected',version=version+1 WHERE status='posted' AND NEW.reverses_entry_id IN (outgoing_entry_id,incoming_entry_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER acct_clearing_reverse AFTER UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_clearing_reverse();
CREATE OR REPLACE FUNCTION public.acct_clearing_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;effective date;residual numeric;a public.acct_clearing_allocations;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='clearing.allocate' THEN
    SELECT max(e.entry_date) INTO effective FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.id IN ((p_command->>'obligation_line_id')::uuid,(p_command->>'settlement_line_id')::uuid);
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',effective)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
    INSERT INTO public.acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by) VALUES(v_id,(p_command->>'obligation_line_id')::uuid,(p_command->>'settlement_line_id')::uuid,(p_command->>'amount_cents')::bigint,effective,p_command->>'reason',p_actor);
  ELSIF op='clearing.release' THEN
    SELECT * INTO a FROM public.acct_clearing_allocations WHERE id=(p_command->>'allocation_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF (p_command->>'effective_date')::date<a.effective_date THEN RAISE EXCEPTION 'ACCT_CLEARING_DATE'; END IF;
    PERFORM public.acct_require_open((p_command->>'effective_date')::date);
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',(p_command->>'effective_date')::date)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
    INSERT INTO public.acct_clearing_releases(id,allocation_id,effective_date,reason,created_by) VALUES(v_id,a.id,(p_command->>'effective_date')::date,p_command->>'reason',p_actor);
  ELSIF op='clearing.review' THEN
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.id=(p_command->>'line_id')::uuid AND e.status='posted' AND e.entry_date<=(p_command->>'as_of')::date) THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
    residual:=public.acct_clearing_residual((p_command->>'line_id')::uuid,(p_command->>'as_of')::date);
    IF residual IS DISTINCT FROM (p_command->>'residual_cents')::bigint OR residual=0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_obligation_reviews(id,line_id,as_of,residual_cents,expected_resolution,document_id,reason,created_by) VALUES(v_id,(p_command->>'line_id')::uuid,(p_command->>'as_of')::date,residual,(p_command->>'expected_resolution')::date,(p_command->>'document_id')::uuid,p_command->>'reason',p_actor);
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  RETURN jsonb_build_object('id',v_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_clearing_view(p_as_of date,p_account uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE rows jsonb;
BEGIN
  PERFORM public.acct_require_owner();
  WITH residuals AS (
    SELECT l.id,l.entry_id,e.entry_date,e.memo,l.account_id,a.name AS account_name,a.normal_side,l.amount_cents,public.acct_clearing_residual(l.id,p_as_of) AS residual,p.purpose
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_accounts a ON a.id=l.account_id LEFT JOIN public.acct_account_profiles p ON p.account_id=l.account_id
    WHERE e.status='posted' AND e.entry_date<=p_as_of AND (p_account IS NOT NULL AND l.account_id=p_account OR p_account IS NULL AND p.purpose IN ('transfers_in_transit','undeposited_funds','net_salary_payable','payroll_taxes_payable','payroll_deductions','retirement_payable','due_to_shareholder','due_from_shareholder','customer_funds','loans_payable','shareholder_loan'))
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('line_id',x.id,'entry_id',x.entry_id,'entry_date',x.entry_date,'memo',x.memo,'account_id',x.account_id,'account_name',x.account_name,'purpose',x.purpose,'normal_side',x.normal_side,'amount_cents',x.amount_cents::text,'residual_cents',x.residual::text,
    'review',(SELECT to_jsonb(r)||jsonb_build_object('residual_cents',r.residual_cents::text) FROM public.acct_obligation_reviews r WHERE r.line_id=x.id AND r.as_of=p_as_of AND r.residual_cents=x.residual ORDER BY created_at DESC,id LIMIT 1),
    'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text,'released',(SELECT to_jsonb(r) FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id)) ORDER BY effective_date,id),'[]') FROM public.acct_clearing_allocations a WHERE x.id IN (a.obligation_line_id,a.settlement_line_id))) ORDER BY x.entry_date,x.id),'[]') INTO rows FROM residuals x WHERE x.residual<>0;
  RETURN jsonb_build_object('as_of',p_as_of,'revision',(SELECT financial_revision::text FROM public.acct_settings),'rows',rows,
    'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY effective_date DESC,id),'[]') FROM (
      SELECT a.id,a.obligation_line_id,a.settlement_line_id,a.effective_date,a.amount_cents::text,a.reason,o.entry_id AS obligation_entry_id,s.entry_id AS settlement_entry_id,oe.memo AS obligation_memo,se.memo AS settlement_memo,ac.name AS account_name,(SELECT to_jsonb(r) FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id) AS released
      FROM public.acct_clearing_allocations a JOIN public.acct_journal_lines o ON o.id=a.obligation_line_id JOIN public.acct_journal_lines s ON s.id=a.settlement_line_id JOIN public.acct_journal_entries oe ON oe.id=o.entry_id JOIN public.acct_journal_entries se ON se.id=s.entry_id JOIN public.acct_accounts ac ON ac.id=o.account_id
      WHERE a.effective_date<=p_as_of AND (p_account IS NULL OR o.account_id=p_account) ORDER BY a.effective_date DESC,a.id LIMIT 500
    ) x));
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_clearing_allocations','acct_clearing_releases','acct_obligation_reviews','acct_transfer_groups'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
  END LOOP;
END $$;
CREATE TRIGGER acct_clearing_release_immutable BEFORE UPDATE OR DELETE ON public.acct_clearing_releases FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_obligation_review_immutable BEFORE UPDATE OR DELETE ON public.acct_obligation_reviews FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
REVOKE ALL ON FUNCTION public.acct_clearing_residual(uuid,date),public.acct_clearing_guard(),public.acct_clearing_reverse() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_clearing_capacity(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_clearing_command(jsonb,uuid),public.acct_clearing_view(date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_clearing_view(date,uuid) TO authenticated;
-- ACCOUNTING CLEARING END


-- ACCOUNTING CLOSE BEGIN
CREATE TABLE public.acct_reconciliations (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
  from_date date NOT NULL CHECK(from_date BETWEEN '1900-01-01'::date AND '2100-12-31'::date),
  to_date date NOT NULL CHECK(to_date>=from_date AND to_date<='2100-12-31'::date),
  opening_cents bigint NOT NULL,
  ending_cents bigint NOT NULL,
  declared_count integer NOT NULL CHECK(declared_count BETWEEN 0 AND 50000),
  declared_debits_cents bigint NOT NULL CHECK(declared_debits_cents>=0),
  declared_credits_cents bigint NOT NULL CHECK(declared_credits_cents>=0),
  predecessor_id uuid REFERENCES public.acct_reconciliations(id),
  document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','superseded','cancelled')),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=3000),
  proof jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  CHECK(predecessor_id IS DISTINCT FROM id),
  CHECK((status IN ('completed','superseded'))=(completed_at IS NOT NULL))
);
CREATE TABLE public.acct_reconciliation_supersessions (
  reconciliation_id uuid PRIMARY KEY REFERENCES public.acct_reconciliations(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acct_reconciliations_account_dates ON public.acct_reconciliations(account_id,to_date,status);
CREATE TABLE public.acct_statement_items (
  id uuid PRIMARY KEY,
  reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
  ordinal integer NOT NULL CHECK(ordinal>=0),
  entry_date date NOT NULL,
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
  UNIQUE(reconciliation_id,ordinal)
);
CREATE TABLE public.acct_reconciliation_items (
  id uuid PRIMARY KEY,
  statement_item_id uuid NOT NULL REFERENCES public.acct_statement_items(id),
  entry_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
  UNIQUE(statement_item_id,entry_line_id)
);
CREATE INDEX acct_reconciliation_line_allocations ON public.acct_reconciliation_items(entry_line_id);
CREATE TABLE public.acct_reconciliation_opening (
  reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
  entry_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
  PRIMARY KEY(reconciliation_id,entry_line_id)
);
CREATE TABLE public.acct_account_lifecycle (
  account_id uuid PRIMARY KEY REFERENCES public.acct_accounts(id),
  version integer NOT NULL DEFAULT 1,
  opened_on date NOT NULL CHECK(opened_on BETWEEN '1900-01-01'::date AND '2100-12-31'::date),
  closed_on date CHECK(closed_on>=opened_on AND closed_on<='2100-12-31'::date),
  closure_document_id uuid REFERENCES public.acct_documents(id),
  CHECK(closed_on IS NULL OR closure_document_id IS NOT NULL)
);
CREATE TABLE public.acct_close_records (
  id uuid PRIMARY KEY,
  month_start date NOT NULL REFERENCES public.acct_periods(month_start),
  snapshot_id uuid NOT NULL REFERENCES public.acct_report_snapshots(id),
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_close_reopens (
  id uuid PRIMARY KEY,
  close_id uuid NOT NULL UNIQUE REFERENCES public.acct_close_records(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_fiscal_years (
  year integer PRIMARY KEY CHECK(year BETWEEN 1900 AND 2100),
  version integer NOT NULL DEFAULT 1,
  classification text NOT NULL CHECK(classification IN ('s_corp','other','unverified')),
  filed_on date,
  filed_snapshot_id uuid REFERENCES public.acct_report_snapshots(id),
  filed_document_id uuid REFERENCES public.acct_documents(id),
  CHECK((filed_on IS NULL)=(filed_snapshot_id IS NULL)),
  CHECK(filed_on IS NULL OR filed_document_id IS NOT NULL)
);
CREATE TABLE public.acct_restatement_cases (
  id uuid PRIMARY KEY,
  fiscal_year integer NOT NULL REFERENCES public.acct_fiscal_years(year),
  version integer NOT NULL DEFAULT 1,
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 3000),
  support_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  original_snapshot_id uuid NOT NULL REFERENCES public.acct_report_snapshots(id),
  replacement_snapshot_id uuid REFERENCES public.acct_report_snapshots(id),
  affected_periods jsonb NOT NULL,
  filed_snapshots jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
  external_return_review text NOT NULL CHECK(external_return_review IN ('required','not_required_with_explanation')),
  return_review_explanation text NOT NULL CHECK(length(btrim(return_review_explanation)) BETWEEN 1 AND 3000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX acct_one_open_restatement ON public.acct_restatement_cases(fiscal_year) WHERE status='open';
CREATE TABLE public.acct_history_checks (
  id uuid PRIMARY KEY,
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  source_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  controls jsonb NOT NULL,
  account_controls jsonb NOT NULL,
  revision bigint NOT NULL,
  explanation text NOT NULL CHECK(length(btrim(explanation)) BETWEEN 1 AND 3000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_history_invalidations (
  check_id uuid PRIMARY KEY REFERENCES public.acct_history_checks(id),
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.acct_close_checklist(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE ending date:=(p_month+INTERVAL '1 month -1 day')::date;report jsonb;drafts integer;imports integer;feed_pending integer;missing integer;uncategorized integer;suspense integer;clearing integer;required_accounts jsonb;obligations jsonb;
BEGIN
  PERFORM public.acct_require_owner();IF extract(day FROM p_month)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  report:=public.acct_workspace(p_month,ending);
  SELECT count(*) INTO drafts FROM public.acct_journal_entries WHERE status='draft' AND entry_date<=ending;
  SELECT count(*) INTO imports FROM public.acct_import_batches b WHERE b.from_date<=ending AND (CASE WHEN b.mode='journal' THEN b.status<>'completed' OR NOT b.coverage_verified ELSE b.status NOT IN ('review','applying','completed') OR (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=b.id)<>b.expected_groups OR EXISTS(SELECT 1 FROM public.acct_import_groups ig LEFT JOIN public.acct_journal_entries ie ON ie.id=ig.entry_id WHERE ig.batch_id=b.id AND ig.entry_date<=ending AND (ig.status NOT IN ('applied','duplicate') OR ie.id IS NULL OR ie.status<>'posted')) END) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'));
  feed_pending:=public.acct_feed_unreviewed(ending);
  SELECT count(*) INTO uncategorized FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE e.status='posted' AND e.entry_date<=ending AND e.reverses_entry_id IS NULL AND p.purpose IN ('uncategorized_income','uncategorized_expense') AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id AND r.entry_date<=ending);
  SELECT count(*) INTO suspense FROM (SELECT l.account_id FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE e.status='posted' AND e.entry_date<=ending AND p.purpose='opening_balance_equity' GROUP BY l.account_id HAVING sum(l.amount_cents)<>0) x;
  WITH required AS (
    SELECT a.id,a.name,(SELECT r.id FROM public.acct_reconciliations r WHERE r.account_id=a.id AND r.status='completed' AND r.from_date<=ending AND r.to_date>=ending ORDER BY r.to_date LIMIT 1) AS reconciliation_id
    FROM public.acct_accounts a JOIN public.acct_account_profiles p ON p.account_id=a.id LEFT JOIN public.acct_account_lifecycle life ON life.account_id=a.id
    WHERE p.cash_kind IN ('bank','card','cash') AND (life.closed_on IS NULL OR life.closed_on>=p_month) AND (EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a.id AND e.status='posted' AND e.entry_date<=ending) OR EXISTS(SELECT 1 FROM public.acct_feed_accounts fa WHERE fa.account_id=a.id AND (to_timestamp(fa.history_start) AT TIME ZONE fa.posting_timezone)::date<=ending))
  ) SELECT count(*) FILTER(WHERE reconciliation_id IS NULL),coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') INTO missing,required_accounts FROM required x;
  obligations:=public.acct_clearing_view(ending)->'rows';
  SELECT count(*) INTO clearing FROM jsonb_array_elements(obligations) x WHERE NOT (
    -- A recorded later settlement can explain a genuine timing item.
    public.acct_clearing_residual((x->>'line_id')::uuid,'2100-12-31')=0
    OR EXISTS(SELECT 1 FROM public.acct_obligation_reviews r JOIN public.acct_document_states d ON d.document_id=r.document_id WHERE r.line_id=(x->>'line_id')::uuid AND r.as_of=ending AND r.residual_cents=(x->>'residual_cents')::numeric AND r.expected_resolution>ending AND d.state='available')
  );
  RETURN jsonb_build_object('month_start',p_month,'through',ending,'revision',report->'revision','drafts',drafts,'unverified_imports',imports,'unreviewed_feed_movements',feed_pending,'unreconciled_accounts',missing,'uncategorized_lines',uncategorized,'opening_suspense_accounts',suspense,'unexplained_clearing_lines',clearing,'accounts',required_accounts,'obligations',obligations,'reports',report,
    'month_ended',ending<=current_date,
    'ready',ending<=current_date AND drafts=0 AND imports=0 AND feed_pending=0 AND missing=0 AND uncategorized=0 AND suspense=0 AND clearing=0 AND report->'reports'->>'trial_balance_cents'='0' AND report->'reports'->>'balance_difference_cents'='0');
END $$;

CREATE OR REPLACE FUNCTION public.acct_period_impact(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
    'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY month_start),'[]') FROM public.acct_periods p WHERE month_start>=p_month AND is_locked),
    'filed_years',(SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY year),'[]') FROM public.acct_fiscal_years y WHERE year>=extract(year FROM p_month) AND filed_on IS NOT NULL));
END $$;
CREATE OR REPLACE FUNCTION public.acct_close_history() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
 'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY month_start DESC),'[]') FROM public.acct_periods p),
 'years',(SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY year DESC),'[]') FROM public.acct_fiscal_years y),
 'restatements',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,id),'[]') FROM public.acct_restatement_cases r),
 'closes',(SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('reopen',(SELECT to_jsonb(r) FROM public.acct_close_reopens r WHERE r.close_id=c.id)) ORDER BY c.month_start DESC,c.created_at DESC,c.id),'[]') FROM public.acct_close_records c),
 'lifecycle',(SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') FROM public.acct_account_lifecycle l));
END $$;
CREATE OR REPLACE FUNCTION public.acct_snapshot_read(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN (SELECT to_jsonb(s)||jsonb_build_object('revision',s.revision::text) FROM public.acct_report_snapshots s WHERE id=p_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_lifecycle_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a uuid:=(p_command->>'id')::uuid;life public.acct_account_lifecycle;opened date:=(p_command->>'opened_on')::date;closed date:=nullif(p_command->>'closed_on','')::date;document uuid:=nullif(p_command->>'document_id','')::uuid;earliest date;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE account_id=a AND cash_kind IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
 SELECT * INTO life FROM public.acct_account_lifecycle WHERE account_id=a;
 IF coalesce(life.version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 SELECT min(e.entry_date) INTO earliest FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a AND e.status='posted';
 IF opened IS NULL OR opened>earliest OR EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a AND e.status IN ('draft','posted') AND e.entry_date>closed) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_LIFECYCLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',least(coalesce(life.closed_on,closed),coalesce(closed,life.closed_on)))::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
 IF closed IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=document AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF (SELECT coalesce(sum(l.amount_cents),0) FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a AND e.status='posted' AND e.entry_date<=closed)<>0 OR NOT EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE account_id=a AND status='completed' AND to_date=closed AND ending_cents=0) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CLOSE_PROOF'; END IF;
 END IF;
 INSERT INTO public.acct_account_lifecycle(account_id,opened_on,closed_on,closure_document_id) VALUES(a,opened,closed,document) ON CONFLICT(account_id) DO UPDATE SET opened_on=excluded.opened_on,closed_on=excluded.closed_on,closure_document_id=excluded.closure_document_id,version=acct_account_lifecycle.version+1;
 RETURN jsonb_build_object('id',a,'version',coalesce(life.version,0)+1);
END $$;
CREATE OR REPLACE FUNCTION public.acct_period_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;month date:=(p_command->>'month')::date;ending date;proof jsonb;snapshot uuid;old_close uuid;v_period record;v_year integer;restatement public.acct_restatement_cases;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='year.configure' THEN
    v_year:=(p_command->>'year')::integer;
    IF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=v_year AND filed_on IS NOT NULL) THEN RAISE EXCEPTION 'ACCT_FILED_YEAR'; END IF;
    INSERT INTO public.acct_fiscal_years(year,classification) VALUES(v_year,p_command->>'classification') ON CONFLICT(year) DO UPDATE SET classification=excluded.classification,version=acct_fiscal_years.version+1;
    RETURN jsonb_build_object('id',v_id);
  END IF;
  IF op='year.file' THEN
    v_year:=(p_command->>'year')::integer;
    IF NOT EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=v_year AND classification<>'unverified' AND filed_on IS NULL) OR EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open') THEN RAISE EXCEPTION 'ACCT_FILED_YEAR'; END IF;
    IF (SELECT count(*) FROM public.acct_periods WHERE extract(year FROM month_start)=v_year AND is_locked)<>12 THEN RAISE EXCEPTION 'ACCT_YEAR_CLOSE_REQUIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF (p_command->>'filed_on')::date IS NULL OR (p_command->>'filed_on')::date>current_date OR (p_command->>'filed_on')::date<=make_date(v_year,12,31) THEN RAISE EXCEPTION 'ACCT_INVALID_DATE'; END IF;
    snapshot:=gen_random_uuid();
    proof:=public.acct_workspace(make_date(v_year,1,1),make_date(v_year,12,31));
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'filing',make_date(v_year,1,1),make_date(v_year,12,31),(proof->>'revision')::bigint,proof||jsonb_build_object('close_records',(SELECT jsonb_agg(to_jsonb(c) ORDER BY month_start) FROM public.acct_close_records c WHERE extract(year FROM month_start)=v_year AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id))),p_actor);
    UPDATE public.acct_fiscal_years SET filed_on=(p_command->>'filed_on')::date,filed_document_id=(p_command->>'document_id')::uuid,filed_snapshot_id=snapshot,version=version+1 WHERE year=v_year;
    RETURN jsonb_build_object('id',v_id,'snapshot_id',snapshot);
  ELSIF op='year.restatement.complete' THEN
    SELECT * INTO restatement FROM public.acct_restatement_cases WHERE id=v_id AND status='open';
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(restatement.affected_periods) m WHERE NOT EXISTS(SELECT 1 FROM public.acct_periods p WHERE p.month_start=m.value::date AND p.is_locked)) THEN RAISE EXCEPTION 'ACCT_YEAR_CLOSE_REQUIRED'; END IF;
    snapshot:=gen_random_uuid();proof:=public.acct_workspace(restatement.from_date,restatement.to_date);
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'restatement',restatement.from_date,restatement.to_date,(proof->>'revision')::bigint,proof||jsonb_build_object('case',to_jsonb(restatement),'annual_reports',(SELECT jsonb_agg(public.acct_workspace(make_date(y,1,1),make_date(y,12,31))) FROM generate_series(extract(year FROM restatement.from_date)::integer,extract(year FROM restatement.to_date)::integer) y)),p_actor);
    UPDATE public.acct_restatement_cases SET status='completed',replacement_snapshot_id=snapshot,version=version+1 WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'snapshot_id',snapshot);
  END IF;
  IF month IS NULL OR extract(day FROM month)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  ending:=(month+INTERVAL '1 month -1 day')::date;
  IF op='period.close' THEN
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=month AND is_locked) THEN RAISE EXCEPTION 'ACCT_PERIOD_ALREADY_CLOSED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=extract(year FROM month) AND classification<>'unverified') THEN RAISE EXCEPTION 'ACCT_YEAR_CLASSIFICATION_REQUIRED'; END IF;
    proof:=public.acct_close_checklist(month);
    IF NOT (proof->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_CLOSE_INCOMPLETE'; END IF;
    INSERT INTO public.acct_periods(month_start) VALUES(month) ON CONFLICT DO NOTHING;
    snapshot:=gen_random_uuid();
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'close',month,ending,(proof->>'revision')::bigint,proof,p_actor);
    INSERT INTO public.acct_close_records(id,month_start,snapshot_id,proof,created_by) VALUES(v_id,month,snapshot,proof,p_actor);
    UPDATE public.acct_periods SET is_locked=true,reason='Completed month close' WHERE month_start=month;
    RETURN jsonb_build_object('id',v_id,'snapshot_id',snapshot);
  ELSIF op IN ('period.reopen','year.restatement.begin') THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF op='year.restatement.begin' THEN
      IF EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open') THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_OPEN'; END IF;
      SELECT min(year) INTO v_year FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM month);
      IF v_year IS NULL THEN RAISE EXCEPTION 'ACCT_FILED_YEAR_REQUIRED'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
      SELECT (max(month_start)+INTERVAL '1 month -1 day')::date INTO ending FROM public.acct_periods WHERE is_locked AND month_start>=month;
      INSERT INTO public.acct_restatement_cases(id,fiscal_year,from_date,to_date,reason,support_document_id,original_snapshot_id,affected_periods,filed_snapshots,external_return_review,return_review_explanation,created_by)
      VALUES(v_id,v_year,month,ending,p_command->>'reason',(p_command->>'document_id')::uuid,(SELECT filed_snapshot_id FROM public.acct_fiscal_years WHERE year=v_year),(SELECT jsonb_agg(month_start ORDER BY month_start) FROM public.acct_periods WHERE is_locked AND month_start>=month),(SELECT jsonb_agg(to_jsonb(y) ORDER BY year) FROM public.acct_fiscal_years y WHERE filed_on IS NOT NULL AND year>=extract(year FROM month)),p_command->>'external_return_review',p_command->>'return_review_explanation',p_actor);
    ELSIF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM month)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
    -- Earlier changes affect every later close's opening balances and reports.
    FOR v_period IN SELECT month_start FROM public.acct_periods WHERE month_start>=month AND is_locked ORDER BY month_start LOOP
      SELECT c.id INTO old_close FROM public.acct_close_records c WHERE c.month_start=v_period.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id) ORDER BY created_at DESC,id LIMIT 1;
      IF old_close IS NULL THEN RAISE EXCEPTION 'ACCT_CLOSE_RECORD_MISSING'; END IF;
      INSERT INTO public.acct_close_reopens(id,close_id,reason,created_by) VALUES(gen_random_uuid(),old_close,p_command->>'reason',p_actor);
      UPDATE public.acct_periods SET is_locked=false,reason=p_command->>'reason' WHERE month_start=v_period.month_start;
    END LOOP;
    RETURN jsonb_build_object('id',v_id);
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.acct_later_period_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='posted' AND EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM NEW.entry_date)) AND NOT EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open' AND NEW.entry_date BETWEEN from_date AND to_date AND extract(year FROM to_date)>=(SELECT max(year) FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
  IF NEW.status='posted' AND EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>date_trunc('month',NEW.entry_date)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
  IF NEW.status='posted' AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_lifecycle a ON a.account_id=l.account_id WHERE l.entry_id=NEW.id AND (NEW.entry_date<a.opened_on OR NEW.entry_date>a.closed_on)) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_LIFECYCLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_later_period_guard BEFORE UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_later_period_guard();
CREATE OR REPLACE FUNCTION public.acct_close_period_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.is_locked AND (TG_OP='INSERT' OR NOT OLD.is_locked) THEN
  IF EXISTS(SELECT 1 FROM public.acct_close_records c JOIN public.acct_report_snapshots s ON s.id=c.snapshot_id JOIN public.acct_history_checks h ON h.id=(c.proof->>'history_check_id')::uuid WHERE c.month_start=NEW.month_start AND s.kind='historical_baseline' AND c.proof->>'kind'='historical_baseline' AND h.from_date<=NEW.month_start AND h.to_date>=(NEW.month_start+INTERVAL '1 month -1 day')::date AND public.acct_history_check_current(h.id) AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens WHERE close_id=c.id) AND (public.acct_history_preview(h.from_date,h.to_date,h.controls->'monthly',h.account_controls,h.controls->'totals')->>'ready')::boolean) THEN RETURN NEW; END IF;
  IF NOT coalesce((public.acct_close_checklist(NEW.month_start)->>'ready')::boolean,false) OR NOT EXISTS(SELECT 1 FROM public.acct_close_records c WHERE c.month_start=NEW.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id)) THEN RAISE EXCEPTION 'ACCT_CLOSE_INCOMPLETE'; END IF;
 ELSIF TG_OP='UPDATE' AND OLD.is_locked AND NOT NEW.is_locked THEN
  IF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM NEW.month_start)) AND NOT EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open' AND NEW.month_start BETWEEN from_date AND to_date AND extract(year FROM to_date)>=(SELECT max(year) FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_close_records c WHERE c.month_start=NEW.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id)) THEN RAISE EXCEPTION 'ACCT_REOPEN_RECORD_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_close_period_guard BEFORE INSERT OR UPDATE ON public.acct_periods FOR EACH ROW EXECUTE FUNCTION public.acct_close_period_guard();

CREATE OR REPLACE FUNCTION public.acct_reconciliation_line_cleared(p_line uuid,p_cutoff date DEFAULT '2100-12-31',p_include uuid DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT sum(a.amount_cents) FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id JOIN public.acct_reconciliations r ON r.id=i.reconciliation_id WHERE a.entry_line_id=p_line AND i.entry_date<=p_cutoff AND (r.status='completed' OR (r.id=p_include AND r.status='in_progress'))),0)
 +coalesce((SELECT sum(o.amount_cents) FROM public.acct_reconciliation_opening o JOIN public.acct_reconciliations r ON r.id=o.reconciliation_id WHERE o.entry_line_id=p_line AND r.from_date<=p_cutoff+1 AND (r.status='completed' OR (r.id=p_include AND r.status='in_progress'))),0);
$$;
CREATE OR REPLACE FUNCTION public.acct_reconciliation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_reconciliation uuid;v_allocation uuid;r public.acct_reconciliations;item public.acct_statement_items;line public.acct_journal_lines;line_date date;used numeric;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_TABLE_NAME='acct_reconciliations' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
    IF TG_OP='UPDATE' THEN
      IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
      IF OLD.status<>'in_progress' AND NOT(OLD.status='completed' AND NEW.status='superseded' AND (to_jsonb(NEW)-'status'-'version')=(to_jsonb(OLD)-'status'-'version')) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
      NEW.version:=OLD.version+1;
      IF NEW.status='completed' AND OLD.status='in_progress' THEN
        IF (to_jsonb(NEW)-'status'-'version'-'proof'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version'-'proof'-'completed_at') OR NOT coalesce((public.acct_reconciliation_proof(OLD.id)->>'ready')::boolean,false) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_INCOMPLETE'; END IF;
      END IF;
    ELSIF NEW.status<>'in_progress' THEN
      RAISE EXCEPTION 'ACCT_RECONCILIATION_INCOMPLETE';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='acct_statement_items' THEN
    v_reconciliation:=CASE WHEN TG_OP='DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
    IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.reconciliation_id<>OLD.reconciliation_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  ELSIF TG_TABLE_NAME='acct_reconciliation_opening' THEN
    v_reconciliation:=CASE WHEN TG_OP='DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
  ELSE
    SELECT * INTO item FROM public.acct_statement_items WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.statement_item_id ELSE NEW.statement_item_id END;
    v_reconciliation:=item.reconciliation_id;
    IF TG_OP<>'DELETE' THEN v_allocation:=NEW.id; END IF;
    IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.statement_item_id<>OLD.statement_item_id OR NEW.entry_line_id<>OLD.entry_line_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  END IF;
  SELECT * INTO r FROM public.acct_reconciliations WHERE id=v_reconciliation;
  IF r.status IS DISTINCT FROM 'in_progress' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_FINAL'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='acct_statement_items' THEN
    IF NEW.entry_date NOT BETWEEN r.from_date AND r.to_date OR NEW.ordinal>=r.declared_count THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO line FROM public.acct_journal_lines WHERE id=NEW.entry_line_id;
  SELECT entry_date INTO line_date FROM public.acct_journal_entries WHERE id=line.entry_id AND status='posted';
  IF line.account_id IS DISTINCT FROM r.account_id OR line_date IS NULL OR line_date>r.to_date OR sign(NEW.amount_cents)<>sign(line.amount_cents) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_LINE'; END IF;
  IF TG_TABLE_NAME='acct_reconciliation_opening' THEN
    IF r.predecessor_id IS NOT NULL OR line_date>=r.from_date THEN RAISE EXCEPTION 'ACCT_OPENING_SCOPE'; END IF;
  ELSE
    IF sign(NEW.amount_cents)<>sign(item.amount_cents) OR line_date>item.entry_date THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
    SELECT coalesce(sum(abs(a.amount_cents::numeric)),0) INTO used FROM public.acct_reconciliation_items a WHERE statement_item_id=item.id AND a.id<>NEW.id;
    IF used+abs(NEW.amount_cents::numeric)>abs(item.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
  END IF;
  SELECT coalesce(sum(abs(a.amount_cents::numeric)),0) INTO used FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id JOIN public.acct_reconciliations s ON s.id=i.reconciliation_id WHERE a.entry_line_id=line.id AND s.status IN ('in_progress','completed') AND a.id IS DISTINCT FROM v_allocation;
  SELECT used+coalesce(sum(abs(o.amount_cents::numeric)),0) INTO used FROM public.acct_reconciliation_opening o JOIN public.acct_reconciliations s ON s.id=o.reconciliation_id WHERE o.entry_line_id=line.id AND s.status IN ('in_progress','completed') AND (TG_TABLE_NAME<>'acct_reconciliation_opening' OR o.reconciliation_id<>v_reconciliation);
  IF used+abs(NEW.amount_cents::numeric)>abs(line.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.acct_close_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;r public.acct_reconciliations;v_proof jsonb;x jsonb;v_amount bigint;line record;v_open numeric;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='reconciliation.create' THEN
    IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE account_id=(p_command->>'account_id')::uuid AND cash_kind IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE account_id=(p_command->>'account_id')::uuid AND status IN ('in_progress','completed') AND from_date<=(p_command->>'to')::date AND to_date>=(p_command->>'from')::date) THEN RAISE EXCEPTION 'ACCT_STATEMENT_OVERLAP'; END IF;
    IF nullif(p_command->>'predecessor_id','') IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id=(p_command->>'predecessor_id')::uuid AND status='completed' AND account_id=(p_command->>'account_id')::uuid AND to_date=(p_command->>'from')::date-1 AND ending_cents=(p_command->>'opening_cents')::bigint) THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
    ELSIF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE account_id=(p_command->>'account_id')::uuid AND status='completed') THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
    INSERT INTO public.acct_reconciliations(id,account_id,from_date,to_date,opening_cents,ending_cents,declared_count,declared_debits_cents,declared_credits_cents,predecessor_id,document_id,notes,created_by)
    VALUES(v_id,(p_command->>'account_id')::uuid,(p_command->>'from')::date,(p_command->>'to')::date,(p_command->>'opening_cents')::bigint,(p_command->>'ending_cents')::bigint,(p_command->>'declared_count')::integer,(p_command->>'declared_debits_cents')::bigint,(p_command->>'declared_credits_cents')::bigint,nullif(p_command->>'predecessor_id','')::uuid,(p_command->>'document_id')::uuid,coalesce(p_command->>'notes',''),p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1);
  END IF;
  SELECT * INTO r FROM public.acct_reconciliations WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF r.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='reconciliation.reopen' THEN
    IF r.status<>'completed' OR length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',r.from_date)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
    INSERT INTO public.acct_reconciliation_supersessions(reconciliation_id,reason,created_by) SELECT id,p_command->>'reason',p_actor FROM public.acct_reconciliations WHERE account_id=r.account_id AND status='completed' AND to_date>=r.to_date;
    UPDATE public.acct_reconciliations SET status='superseded' WHERE account_id=r.account_id AND status='completed' AND to_date>=r.to_date;
    RETURN jsonb_build_object('id',v_id,'version',r.version+1);
  END IF;
  IF r.status<>'in_progress' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_FINAL'; END IF;
  IF op='reconciliation.cancel' THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_reconciliations SET status='cancelled',notes=notes||E'\nCancelled: '||(p_command->>'reason'),proof=public.acct_reconciliation_proof(v_id) WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'version',r.version+1);
  ELSIF op='reconciliation.item.remove' THEN
    IF EXISTS(SELECT 1 FROM public.acct_reconciliation_items WHERE statement_item_id=(p_command->>'item_id')::uuid) THEN RAISE EXCEPTION 'ACCT_UNMATCH_FIRST'; END IF;
    DELETE FROM public.acct_statement_items WHERE id=(p_command->>'item_id')::uuid AND reconciliation_id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  ELSIF op='reconciliation.items' THEN
    IF jsonb_typeof(p_command->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'items') LOOP
      INSERT INTO public.acct_statement_items(id,reconciliation_id,ordinal,entry_date,description,amount_cents) VALUES((x->>'id')::uuid,v_id,(x->>'ordinal')::integer,(x->>'entry_date')::date,x->>'description',(x->>'amount_cents')::bigint);
    END LOOP;
  ELSIF op='reconciliation.opening' THEN
    IF r.predecessor_id IS NOT NULL OR (p_command->>'reviewed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_OPENING_SCOPE'; END IF;
    IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF jsonb_typeof(p_command->'outstanding') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'outstanding')>1000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_command->'outstanding'))<>(SELECT count(DISTINCT value->>'line_id') FROM jsonb_array_elements(p_command->'outstanding')) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'outstanding') LOOP
      IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.id=(x->>'line_id')::uuid AND l.account_id=r.account_id AND e.status='posted' AND e.entry_date<r.from_date AND sign(l.amount_cents)=sign((x->>'amount_cents')::bigint) AND abs((x->>'amount_cents')::numeric)<=abs(l.amount_cents::numeric)) THEN RAISE EXCEPTION 'ACCT_OPENING_SCOPE'; END IF;
    END LOOP;
    DELETE FROM public.acct_reconciliation_opening WHERE reconciliation_id=v_id;
    FOR line IN SELECT l.* FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=r.account_id AND e.status='posted' AND e.entry_date<r.from_date LOOP
      SELECT line.amount_cents-coalesce((SELECT (value->>'amount_cents')::bigint FROM jsonb_array_elements(p_command->'outstanding') WHERE (value->>'line_id')::uuid=line.id),0) INTO v_amount;
      IF v_amount<>0 THEN INSERT INTO public.acct_reconciliation_opening VALUES(v_id,line.id,v_amount); END IF;
    END LOOP;
    SELECT coalesce(sum(amount_cents),0) INTO v_open FROM public.acct_reconciliation_opening WHERE reconciliation_id=v_id;
    IF v_open<>r.opening_cents THEN RAISE EXCEPTION 'ACCT_OPENING_DIFFERENCE'; END IF;
  ELSIF op='reconciliation.allocate' THEN
    IF jsonb_typeof(p_command->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'allocations') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'allocations') LOOP
      IF NOT EXISTS(SELECT 1 FROM public.acct_statement_items WHERE id=(x->>'statement_item_id')::uuid AND reconciliation_id=v_id) THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
      INSERT INTO public.acct_reconciliation_items(id,statement_item_id,entry_line_id,amount_cents) VALUES((x->>'id')::uuid,(x->>'statement_item_id')::uuid,(x->>'entry_line_id')::uuid,(x->>'amount_cents')::bigint);
    END LOOP;
  ELSIF op='reconciliation.unmatch' THEN
    DELETE FROM public.acct_reconciliation_items a USING public.acct_statement_items i WHERE a.id=(p_command->>'allocation_id')::uuid AND i.id=a.statement_item_id AND i.reconciliation_id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  ELSIF op='reconciliation.complete' THEN
    v_proof:=public.acct_reconciliation_proof(v_id);
    IF NOT (v_proof->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_INCOMPLETE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=r.document_id AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_import_batches b ON b.id=g.batch_id WHERE g.bank_account_id=r.account_id AND g.entry_date BETWEEN r.from_date AND r.to_date AND g.status IN ('review','exception','new')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
    UPDATE public.acct_reconciliations SET status='completed',completed_at=now(),proof=v_proof||jsonb_build_object(
      'statement_items',(SELECT coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('amount_cents',i.amount_cents::text) ORDER BY ordinal),'[]') FROM public.acct_statement_items i WHERE reconciliation_id=v_id),
      'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text)),'[]') FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id WHERE i.reconciliation_id=v_id),
      'opening',(SELECT coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('amount_cents',o.amount_cents::text)),'[]') FROM public.acct_reconciliation_opening o WHERE reconciliation_id=v_id)) WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'version',r.version+1);
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  UPDATE public.acct_reconciliations SET notes=notes WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'version',r.version+1);
END $$;
CREATE OR REPLACE FUNCTION public.acct_operate(p_key uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=public.acct_require_owner();receipt public.acct_command_receipts;result jsonb;original public.acct_journal_entries;reversal jsonb;replacement jsonb;
BEGIN
  IF p_key IS NULL OR p_command IS NULL OR octet_length(p_command::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();actor:=public.acct_require_owner();
  SELECT * INTO receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF p_command->>'type'='import.cancel' AND EXISTS(SELECT 1 FROM public.acct_import_batches WHERE id=(p_command->>'id')::uuid AND (status='completed' OR coverage_verified)) THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  IF p_command->>'type'='entry.correct' THEN
    SELECT * INTO original FROM public.acct_journal_entries WHERE id=(p_command->>'id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    PERFORM public.acct_validate_template(p_command->'lines');
    reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',original.id,'expected_version',p_command->'expected_version','entry_date',coalesce(p_command->>'reversal_date',original.entry_date::text),'reason',p_command->'reason'));
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',p_command->'replacement_id','expected_version',0,'entry_date',p_command->'entry_date','memo',p_command->'memo','lines',p_command->'lines'));
    INSERT INTO public.acct_entry_context SELECT (replacement->>'id')::uuid,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason FROM public.acct_entry_context WHERE entry_id=original.id;
    IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=(replacement->>'id')::uuid AND p.purpose='opening_retained_earnings') THEN
     PERFORM public.acct_retained_review((replacement->>'id')::uuid,'correction',(p_command->'retained_review'->>'document_id')::uuid,p_command->'retained_review'->'controls',p_command->>'reason',actor,original.id);
    END IF;
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by) VALUES(original.id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',original.id);
  ELSIF p_command->>'type' LIKE 'feed.%' THEN result:=public.acct_feed_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'rule.%' OR p_command->>'type'='alias.save' THEN result:=public.acct_rules_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'statement.%' THEN result:=public.acct_statement_command(p_command,actor);
  ELSIF p_command->>'type'='retained.post' THEN result:=public.acct_retained_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'bank.%' THEN result:=public.acct_bank_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'transfer.%' THEN result:=public.acct_transfer_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'history.%' OR p_command->>'type'='import.resume' THEN result:=public.acct_history_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'reconciliation.%' THEN result:=public.acct_close_command(p_command,actor);
  ELSIF p_command->>'type'='account.lifecycle' THEN result:=public.acct_lifecycle_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'clearing.%' THEN result:=public.acct_clearing_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'period.%' OR p_command->>'type' LIKE 'year.%' THEN result:=public.acct_period_command(p_command,actor);
  ELSE RETURN public.acct_execute(p_key,p_command); END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF p_command->>'type' NOT LIKE 'feed.%' OR p_command->>'type'='feed.prepare' THEN UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton; END IF;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,actor,p_command,result);
  RETURN result;
END $$;
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_reconciliations FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_statement_items FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_reconciliation_items FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_reconciliation_opening FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();

CREATE OR REPLACE FUNCTION public.acct_reconciliation_proof(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_reconciliations;item_count integer;debits numeric;credits numeric;unmatched integer;opening numeric;book numeric;outstanding numeric;rows jsonb;
BEGIN
  PERFORM public.acct_require_owner();SELECT * INTO r FROM public.acct_reconciliations WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  SELECT count(*),coalesce(sum(amount_cents) FILTER(WHERE amount_cents>0),0),coalesce(-sum(amount_cents) FILTER(WHERE amount_cents<0),0) INTO item_count,debits,credits FROM public.acct_statement_items WHERE reconciliation_id=p_id;
  SELECT count(*) INTO unmatched FROM public.acct_statement_items i WHERE reconciliation_id=p_id AND i.amount_cents<>(SELECT coalesce(sum(amount_cents),0) FROM public.acct_reconciliation_items WHERE statement_item_id=i.id);
  IF r.predecessor_id IS NOT NULL THEN SELECT ending_cents INTO opening FROM public.acct_reconciliations WHERE id=r.predecessor_id AND status='completed' AND account_id=r.account_id AND to_date=r.from_date-1;
  ELSE SELECT coalesce(sum(amount_cents),0) INTO opening FROM public.acct_reconciliation_opening WHERE reconciliation_id=p_id; END IF;
  WITH amounts AS (
    SELECT l.id,l.entry_id,e.entry_date,e.memo,l.amount_cents,l.amount_cents-public.acct_reconciliation_line_cleared(l.id,r.to_date,p_id) AS residual
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=r.account_id AND e.status='posted' AND e.entry_date<=r.to_date
  ) SELECT coalesce(sum(amount_cents),0),coalesce(sum(residual),0),coalesce(jsonb_agg(jsonb_build_object('line_id',id,'entry_id',entry_id,'entry_date',entry_date,'memo',memo,'amount_cents',amount_cents::text,'outstanding_cents',residual::text) ORDER BY entry_date,id) FILTER(WHERE residual<>0),'[]') INTO book,outstanding,rows FROM amounts;
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'item_count',item_count,'declared_count',r.declared_count,'debits_cents',debits::text,'credits_cents',credits::text,'unmatched_items',unmatched,
    'opening_difference_cents',(opening-r.opening_cents)::text,'statement_difference_cents',(r.opening_cents+debits-credits-r.ending_cents)::text,
    'book_balance_cents',book::text,'outstanding_cents',outstanding::text,'bridge_difference_cents',(book-outstanding-r.ending_cents)::text,'outstanding',rows,
    'ready',opening IS NOT NULL AND opening=r.opening_cents AND item_count=r.declared_count AND debits=r.declared_debits_cents AND credits=r.declared_credits_cents AND unmatched=0 AND r.opening_cents+debits-credits=r.ending_cents AND book-outstanding=r.ending_cents);
END $$;

CREATE OR REPLACE FUNCTION public.acct_reconciliation_view(p_id uuid DEFAULT NULL,p_account uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_reconciliations;v_items jsonb;v_lines jsonb;v_count integer;
BEGIN
  PERFORM public.acct_require_owner();
  IF p_offset<0 OR length(p_query)>200 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  IF p_id IS NOT NULL THEN SELECT * INTO r FROM public.acct_reconciliations WHERE id=p_id;IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY ordinal),'[]') INTO v_items FROM (
    SELECT i.id,i.ordinal,i.entry_date,i.description,i.amount_cents::text,
      (i.amount_cents-(SELECT coalesce(sum(amount_cents),0) FROM public.acct_reconciliation_items WHERE statement_item_id=i.id))::text AS remaining_cents,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'entry_line_id',a.entry_line_id,'entry_id',l.entry_id,'amount_cents',a.amount_cents::text,'memo',e.memo)),'[]') FROM public.acct_reconciliation_items a JOIN public.acct_journal_lines l ON l.id=a.entry_line_id JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE a.statement_item_id=i.id) AS allocations
    FROM public.acct_statement_items i WHERE reconciliation_id=p_id ORDER BY ordinal LIMIT 100 OFFSET p_offset
  ) x;
  WITH candidates AS (
    SELECT l.id,l.entry_id,e.entry_date,e.memo,l.amount_cents::text,
      (l.amount_cents-public.acct_reconciliation_line_cleared(l.id,coalesce(r.to_date,'2100-12-31'::date),p_id))::text AS remaining_cents,
      (l.amount_cents-coalesce((SELECT sum(a.amount_cents) FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id JOIN public.acct_reconciliations s ON s.id=i.reconciliation_id WHERE a.entry_line_id=l.id AND s.status IN ('in_progress','completed')),0)-coalesce((SELECT sum(o.amount_cents) FROM public.acct_reconciliation_opening o JOIN public.acct_reconciliations s ON s.id=o.reconciliation_id WHERE o.entry_line_id=l.id AND s.status IN ('in_progress','completed')),0))::text AS available_cents
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(r.account_id,p_account) AND e.status='posted' AND (r.to_date IS NULL OR e.entry_date<=r.to_date) AND (p_query='' OR e.memo ILIKE '%'||p_query||'%' OR e.entry_date::text=p_query)
  ), page AS(SELECT * FROM candidates ORDER BY entry_date,id LIMIT 100 OFFSET p_offset)
  SELECT coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY entry_date,id) FROM page x),'[]'),(SELECT count(*) FROM candidates) INTO v_lines,v_count;
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
    'statements',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('opening_cents',x.opening_cents::text,'ending_cents',x.ending_cents::text,'declared_debits_cents',x.declared_debits_cents::text,'declared_credits_cents',x.declared_credits_cents::text) ORDER BY to_date DESC,id),'[]') FROM (SELECT * FROM public.acct_reconciliations WHERE p_account IS NULL OR account_id=p_account ORDER BY to_date DESC,id LIMIT 200) x),
    'statement',CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r)||jsonb_build_object('opening_cents',r.opening_cents::text,'ending_cents',r.ending_cents::text,'declared_debits_cents',r.declared_debits_cents::text,'declared_credits_cents',r.declared_credits_cents::text) END,
    'items',v_items,'item_count',(SELECT count(*) FROM public.acct_statement_items WHERE reconciliation_id=p_id),'lines',v_lines,'line_count',v_count,
    'next_ordinal',(SELECT min(n) FROM generate_series(0,r.declared_count-1) n WHERE NOT EXISTS(SELECT 1 FROM public.acct_statement_items WHERE reconciliation_id=p_id AND ordinal=n)),
    'proof',CASE WHEN r.id IS NULL THEN NULL WHEN r.status='in_progress' THEN public.acct_reconciliation_proof(r.id) ELSE r.proof END,
    'opening_book_cents',(SELECT coalesce(sum(l.amount_cents),0)::text FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=r.account_id AND e.status='posted' AND e.entry_date<r.from_date));
END $$;
CREATE OR REPLACE FUNCTION public.acct_reconciliation_posting_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='posted' AND OLD.status='draft' THEN
    INSERT INTO public.acct_history_invalidations(check_id,entry_id) SELECT id,NEW.id FROM public.acct_history_checks WHERE to_date>=NEW.entry_date ON CONFLICT DO NOTHING;
    UPDATE public.acct_import_batches SET coverage_verified=false WHERE coverage_verified AND to_date>=NEW.entry_date;
    INSERT INTO public.acct_reconciliation_supersessions(reconciliation_id,reason,created_by)
    SELECT r.id,'A later posting changed the books within this statement scope',NEW.created_by FROM public.acct_reconciliations r WHERE r.status='completed' AND r.to_date>=NEW.entry_date AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=NEW.id AND account_id=r.account_id) ON CONFLICT DO NOTHING;
    UPDATE public.acct_reconciliations r SET status='superseded' WHERE r.status='completed' AND r.to_date>=NEW.entry_date AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=NEW.id AND account_id=r.account_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER acct_reconciliation_posting_changed AFTER UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_posting_changed();
CREATE OR REPLACE FUNCTION public.acct_document_statement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.state='archived' AND OLD.state<>'archived' AND (
    EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE support_document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_history_checks WHERE source_document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_obligation_reviews WHERE document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_account_lifecycle WHERE closure_document_id=NEW.document_id)
  ) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_document_statement_guard BEFORE UPDATE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_document_statement_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_reconciliations','acct_reconciliation_supersessions','acct_statement_items','acct_reconciliation_items','acct_reconciliation_opening','acct_account_lifecycle','acct_close_records','acct_close_reopens','acct_fiscal_years','acct_restatement_cases','acct_history_checks','acct_history_invalidations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
  END LOOP;
END $$;
CREATE TRIGGER acct_close_immutable BEFORE UPDATE OR DELETE ON public.acct_close_records FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_reopen_immutable BEFORE UPDATE OR DELETE ON public.acct_close_reopens FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_reconciliation_supersession_immutable BEFORE UPDATE OR DELETE ON public.acct_reconciliation_supersessions FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_history_check_immutable BEFORE UPDATE OR DELETE ON public.acct_history_checks FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_history_invalidation_immutable BEFORE UPDATE OR DELETE ON public.acct_history_invalidations FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
REVOKE ALL ON FUNCTION public.acct_reconciliation_line_cleared(uuid,date,uuid),public.acct_reconciliation_guard(),public.acct_reconciliation_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_close_command(jsonb,uuid),public.acct_operate(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_reconciliation_view(uuid,uuid,integer,text),public.acct_reconciliation_posting_changed() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_document_statement_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_close_checklist(date),public.acct_period_impact(date),public.acct_period_command(jsonb,uuid),public.acct_later_period_guard(),public.acct_close_period_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_close_history(),public.acct_snapshot_read(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_lifecycle_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.acct_books_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;section text;rows jsonb;
BEGIN
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',9,'credential_recovery','SimpleFIN access credentials are excluded. Restore the separate recovery keys and reconnect before enabling any bank worker.');
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations','bank_match_releases','retained_reviews','statement_files','statement_item_sources','statement_amendments','rules','rule_versions','payee_aliases','rule_applications','feed_connections','feed_claims','feed_accounts','feed_identities','feed_runs','feed_requests','feed_windows','feed_observations','feed_import_links','feed_gaps'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.acct_books_backup() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_books_backup() TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_close_history(),public.acct_snapshot_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_reconciliation_proof(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_operate(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_reconciliation_view(uuid,uuid,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_close_checklist(date),public.acct_period_impact(date) TO authenticated;
-- ACCOUNTING CLOSE END

-- ACCOUNTING HISTORY BEGIN
CREATE TABLE public.acct_history_dispositions (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES public.acct_import_groups(id),
 version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind IN ('annual_closing','unsupported')),
 document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 3000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(group_id,version)
);
CREATE TABLE public.acct_history_review_invalidations (
 check_id uuid PRIMARY KEY REFERENCES public.acct_history_checks(id),
 disposition_id uuid NOT NULL REFERENCES public.acct_history_dispositions(id),
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.acct_history_review_invalidations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_history_review_invalidations FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_history_review_invalidations FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_history_review_invalidations FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_history_review_invalidation_immutable BEFORE UPDATE OR DELETE ON public.acct_history_review_invalidations FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE OR REPLACE FUNCTION public.acct_history_check_current(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.acct_history_checks WHERE id=p_id) AND NOT EXISTS(SELECT 1 FROM public.acct_history_invalidations WHERE check_id=p_id) AND NOT EXISTS(SELECT 1 FROM public.acct_history_review_invalidations WHERE check_id=p_id);
$$;
REVOKE ALL ON FUNCTION public.acct_history_check_current(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.acct_history_dispositions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_history_dispositions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_history_dispositions FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_history_dispositions FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_history_disposition_immutable BEFORE UPDATE OR DELETE ON public.acct_history_dispositions FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();

CREATE OR REPLACE FUNCTION public.acct_closing_normalization_valid(p_group uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.acct_import_groups;year integer;line record;actual numeric;
BEGIN
 SELECT * INTO g FROM public.acct_import_groups WHERE id=p_group;
 IF g.status IS DISTINCT FROM 'excluded' OR g.bank_account_id IS NOT NULL OR jsonb_array_length(g.lines)<2 OR to_char(g.entry_date,'MM-DD') NOT IN ('01-01','12-31') THEN RETURN false; END IF;
 year:=extract(year FROM g.entry_date)::integer-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN 1 ELSE 0 END;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(g.lines) x LEFT JOIN public.acct_accounts a ON a.id=(x->>'account_id')::uuid LEFT JOIN public.acct_account_profiles p ON p.account_id=a.id WHERE a.id IS NULL OR NOT(a.account_type IN ('income','expense') OR coalesce(p.purpose='opening_retained_earnings',false))) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.lines) x JOIN public.acct_accounts a ON a.id=(x->>'account_id')::uuid WHERE a.account_type IN ('income','expense')) THEN RETURN false; END IF;
 IF (SELECT sum((x->>'amount_cents')::numeric) FROM jsonb_array_elements(g.lines) x)<>0 THEN RETURN false; END IF;
 FOR line IN SELECT a.id,coalesce(sum((x->>'amount_cents')::numeric),0) AS closing FROM public.acct_accounts a LEFT JOIN jsonb_array_elements(g.lines) x ON (x->>'account_id')::uuid=a.id WHERE a.account_type IN ('income','expense') GROUP BY a.id LOOP
  SELECT coalesce(sum(l.amount_cents),0) INTO actual FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=line.id AND e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND make_date(year,12,31);
  IF line.closing<>-actual THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_preview(p_from date,p_to date,p_monthly jsonb DEFAULT '[]',p_accounts jsonb DEFAULT '[]',p_totals jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE start_date date;end_date date;month_control jsonb;workspace jsonb;actual jsonb;monthly jsonb:='[]';accounts jsonb;differences integer:=0;source_errors integer;drafts integer;unclassified integer;expected_count integer:=0;v_key text;required_accounts integer;
BEGIN
 PERFORM public.acct_require_owner();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR extract(year FROM p_from)<>extract(year FROM p_to) OR p_from<'1900-01-01'::date OR p_to>'2100-12-31'::date THEN RAISE EXCEPTION 'ACCT_HISTORY_YEAR_RANGE'; END IF;
 IF jsonb_typeof(p_monthly) IS DISTINCT FROM 'array' OR jsonb_array_length(p_monthly)>12 OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_accounts)>1000 OR jsonb_typeof(p_totals) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF EXISTS(SELECT 1 FROM (
  SELECT x->>'income_cents' v FROM jsonb_array_elements(p_monthly) x UNION ALL SELECT x->>'expense_cents' FROM jsonb_array_elements(p_monthly) x UNION ALL SELECT x->>'net_income_cents' FROM jsonb_array_elements(p_monthly) x UNION ALL SELECT x->>'amount_cents' FROM jsonb_array_elements(p_accounts) x UNION ALL SELECT value#>>'{}' FROM jsonb_each(p_totals)
 ) amounts WHERE v IS NULL OR v!~'^-?(0|[1-9][0-9]{0,18})$' OR abs(v::numeric)>9223372036854775807) THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_monthly))<>(SELECT count(DISTINCT x->>'from') FROM jsonb_array_elements(p_monthly) x) OR (SELECT count(*) FROM jsonb_array_elements(p_accounts))<>(SELECT count(DISTINCT x->>'account_id') FROM jsonb_array_elements(p_accounts) x) THEN RAISE EXCEPTION 'ACCT_DUPLICATE_CONTROL'; END IF;
 FOR start_date IN SELECT greatest(d::date,p_from) FROM generate_series(date_trunc('month',p_from),date_trunc('month',p_to),INTERVAL '1 month') d LOOP
  end_date:=least((date_trunc('month',start_date)+INTERVAL '1 month -1 day')::date,p_to);expected_count:=expected_count+1;
  SELECT x INTO month_control FROM jsonb_array_elements(p_monthly) x WHERE x->>'from'=start_date::text AND x->>'to'=end_date::text;
  workspace:=public.acct_workspace(start_date,end_date);actual:=workspace->'reports';
  FOREACH v_key IN ARRAY ARRAY['income_cents','expense_cents','net_income_cents'] LOOP
   IF (month_control->>v_key)::numeric IS DISTINCT FROM (actual->>v_key)::numeric THEN differences:=differences+1; END IF;
  END LOOP;
  monthly:=monthly||jsonb_build_array(jsonb_build_object('from',start_date,'to',end_date,'actual',jsonb_build_object('income_cents',actual->'income_cents','expense_cents',actual->'expense_cents','net_income_cents',actual->'net_income_cents'),'source',month_control));
 END LOOP;
 IF jsonb_array_length(p_monthly)<>expected_count THEN differences:=differences+1; END IF;
 workspace:=public.acct_workspace(p_from,p_to);
 FOREACH v_key IN ARRAY ARRAY['assets_cents','liabilities_cents'] LOOP
  IF (p_totals->>v_key)::numeric IS DISTINCT FROM (workspace->'reports'->>v_key)::numeric THEN differences:=differences+1; END IF;
 END LOOP;
 IF (p_totals->>'equity_total_cents')::numeric IS DISTINCT FROM (workspace->'reports'->>'equity_cents')::numeric+(workspace->'reports'->>'retained_cents')::numeric+(workspace->'reports'->>'year_income_cents')::numeric THEN differences:=differences+1; END IF;
 WITH controls AS (
  SELECT b.value->>'id' AS account_id,b.value->>'code' AS code,b.value->>'name' AS name,b.value->>'account_type' AS account_type,CASE WHEN b.value->>'account_type' IN ('income','expense') THEN b.value->>'period_cents' ELSE b.value->>'ending_cents' END AS actual_cents,
   (SELECT x->>'amount_cents' FROM jsonb_array_elements(p_accounts) x WHERE x->>'account_id'=b.value->>'id') AS source_cents,
   ((CASE WHEN b.value->>'account_type' IN ('income','expense') THEN b.value->>'period_cents' ELSE b.value->>'ending_cents' END)::numeric<>0 OR EXISTS(SELECT 1 FROM public.acct_account_profiles p WHERE p.account_id=(b.value->>'id')::uuid AND p.cash_kind IN ('bank','card','cash') AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=p.account_id AND e.status='posted' AND e.entry_date<=p_to))) AS required
  FROM jsonb_array_elements(workspace->'balances') b WHERE NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p WHERE p.account_id=(b.value->>'id')::uuid AND p.purpose='opening_retained_earnings')
 ) SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY code,name),'[]'),count(*) FILTER(WHERE required),count(*) FILTER(WHERE (required OR source_cents IS NOT NULL) AND source_cents::numeric IS DISTINCT FROM actual_cents::numeric) INTO accounts,required_accounts,unclassified FROM controls c;
 differences:=differences+unclassified;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) x WHERE NOT EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=(x->>'account_id')::uuid)) THEN RAISE EXCEPTION 'ACCT_INVALID_ACCOUNT'; END IF;
 SELECT count(*) INTO drafts FROM public.acct_journal_entries WHERE status='draft' AND entry_date<=p_to;
 SELECT count(*) INTO source_errors FROM public.acct_import_batches b WHERE b.from_date<=p_to AND b.to_date>=p_from AND (b.status<>'completed' OR b.basis<>'cash' OR NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=b.source_document_id AND state='available')) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'));
 SELECT source_errors+count(*) INTO source_errors FROM public.acct_import_groups g JOIN public.acct_import_batches b ON b.id=g.batch_id WHERE g.entry_date BETWEEN p_from AND p_to AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups applied WHERE applied.batch_id=b.id AND applied.status='applied')) AND (
  g.status NOT IN ('applied','duplicate','excluded')
  OR g.status IN ('applied','duplicate') AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=g.entry_id AND status='posted')
  OR g.status='excluded' AND NOT EXISTS(SELECT 1 FROM public.acct_history_dispositions d JOIN public.acct_document_states s ON s.document_id=d.document_id WHERE d.group_id=g.id AND d.version=(SELECT max(version) FROM public.acct_history_dispositions WHERE group_id=g.id) AND d.kind='annual_closing' AND s.state='available' AND public.acct_closing_normalization_valid(g.id))
 );
 SELECT count(*) INTO unclassified FROM jsonb_array_elements(workspace->'balances') b JOIN public.acct_account_profiles p ON p.account_id=(b.value->>'id')::uuid WHERE p.purpose IN ('opening_balance_equity','uncategorized_income','uncategorized_expense') AND (b.value->>'ending_cents')::numeric<>0;
 RETURN jsonb_build_object('from',p_from,'to',p_to,'partial_year',p_from<>make_date(extract(year FROM p_from)::integer,1,1) OR p_to<>make_date(extract(year FROM p_from)::integer,12,31),'revision',workspace->'revision','monthly',monthly,'accounts',accounts,'required_accounts',required_accounts,'differences',differences,'source_errors',source_errors,'drafts',drafts,'unclassified_accounts',unclassified,'reports',workspace->'reports',
 'scope_ended',p_to<=current_date,'entity_verified',EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=extract(year FROM p_from) AND classification<>'unverified'),
 'ready',p_to<=current_date AND differences=0 AND source_errors=0 AND drafts=0 AND unclassified=0 AND EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=extract(year FROM p_from) AND classification<>'unverified'));
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;proof jsonb;batch public.acct_import_batches;g public.acct_import_groups;v_history public.acct_history_checks;month date;ending date;snapshot uuid;v_count integer:=0;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF op='import.resume' THEN
  SELECT * INTO batch FROM public.acct_import_batches WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF batch.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF batch.status NOT IN ('cancelled','failed') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  UPDATE public.acct_import_batches SET status=CASE WHEN (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id)<expected_groups THEN 'staging' ELSE 'review' END,error='',coverage_verified=false,version=version+1 WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'version',batch.version+1);
 END IF;
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF op='history.lock' THEN
  SELECT * INTO v_history FROM public.acct_history_checks WHERE id=(p_command->>'history_id')::uuid AND public.acct_history_check_current(id);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_HISTORY_INVALIDATED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=v_history.source_document_id AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  proof:=public.acct_history_preview(v_history.from_date,v_history.to_date,v_history.controls->'monthly',v_history.account_controls,v_history.controls->'totals');
  IF NOT (proof->>'ready')::boolean OR EXISTS(SELECT 1 FROM public.acct_import_batches b WHERE b.from_date<=v_history.to_date AND (b.status<>'completed' OR NOT b.coverage_verified) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'))) THEN RAISE EXCEPTION 'ACCT_HISTORY_DIFFERENCE'; END IF;
  FOR month IN SELECT d::date FROM generate_series(date_trunc('month',v_history.from_date),date_trunc('month',v_history.to_date),INTERVAL '1 month') d WHERE d::date>=v_history.from_date AND (d+INTERVAL '1 month -1 day')::date<=v_history.to_date LOOP
   ending:=(month+INTERVAL '1 month -1 day')::date;
   IF ending>current_date THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
   IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=month AND is_locked) THEN CONTINUE; END IF;
   INSERT INTO public.acct_periods(month_start) VALUES(month) ON CONFLICT DO NOTHING;
   snapshot:=gen_random_uuid();
   INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'historical_baseline',month,ending,(proof->>'revision')::bigint,jsonb_build_object('kind','historical_baseline','history_check_id',v_history.id,'parity',proof,'reports',public.acct_workspace(month,ending)),p_actor);
   INSERT INTO public.acct_close_records(id,month_start,snapshot_id,proof,created_by) SELECT gen_random_uuid(),month,snapshot,payload,p_actor FROM public.acct_report_snapshots WHERE id=snapshot;
   UPDATE public.acct_periods SET is_locked=true,reason='Historical baseline accepted from independent source reports' WHERE month_start=month;
   v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('id',v_id,'locked_months',v_count);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF op='history.disposition' THEN
  SELECT * INTO g FROM public.acct_import_groups WHERE id=(p_command->>'group_id')::uuid AND status='excluded';
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
  IF p_command->>'kind'='annual_closing' AND NOT public.acct_closing_normalization_valid(g.id) THEN RAISE EXCEPTION 'ACCT_CLOSING_NORMALIZATION'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=(date_trunc('year',g.entry_date)::date-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN INTERVAL '1 year' ELSE INTERVAL '0 year' END)) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
  INSERT INTO public.acct_history_dispositions(id,group_id,version,kind,document_id,reason,created_by) VALUES(v_id,g.id,coalesce((SELECT max(version) FROM public.acct_history_dispositions WHERE group_id=g.id),0)+1,p_command->>'kind',(p_command->>'document_id')::uuid,p_command->>'reason',p_actor);
  INSERT INTO public.acct_history_review_invalidations(check_id,disposition_id,reason) SELECT h.id,v_id,'Source normalization review changed' FROM public.acct_history_checks h WHERE h.to_date>=(date_trunc('year',g.entry_date)::date-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN INTERVAL '1 year' ELSE INTERVAL '0 year' END) ON CONFLICT DO NOTHING;
  UPDATE public.acct_import_batches SET coverage_verified=false WHERE coverage_verified AND to_date>=(date_trunc('year',g.entry_date)::date-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN INTERVAL '1 year' ELSE INTERVAL '0 year' END);
 ELSIF op='history.verify' THEN
  IF (p_command->>'cash_basis_confirmed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_HISTORY_BASIS'; END IF;
  proof:=public.acct_history_preview((p_command->>'from')::date,(p_command->>'to')::date,p_command->'monthly',p_command->'accounts',p_command->'totals');
  IF NOT (proof->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_HISTORY_DIFFERENCE'; END IF;
  INSERT INTO public.acct_history_checks(id,from_date,to_date,source_document_id,controls,account_controls,revision,explanation,created_by) VALUES(v_id,(p_command->>'from')::date,(p_command->>'to')::date,(p_command->>'document_id')::uuid,jsonb_build_object('monthly',p_command->'monthly','totals',p_command->'totals','proof',proof),p_command->'accounts',(proof->>'revision')::bigint,p_command->>'reason',p_actor);
  UPDATE public.acct_import_batches b SET coverage_verified=true,version=version+1 WHERE b.status='completed' AND NOT b.coverage_verified AND NOT EXISTS(
   SELECT 1 FROM generate_series(extract(year FROM b.from_date)::integer,extract(year FROM b.to_date)::integer) y WHERE NOT EXISTS(
    SELECT 1 FROM public.acct_history_checks h WHERE h.from_date<=greatest(b.from_date,make_date(y,1,1)) AND h.to_date>=least(b.to_date,make_date(y,12,31)) AND public.acct_history_check_current(h.id)
   )
  );
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 RETURN jsonb_build_object('id',v_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_view() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
 'checks',(SELECT coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('revision',h.revision::text,'invalidated',NOT public.acct_history_check_current(h.id),
  'eligible_months',(SELECT count(*) FROM generate_series(date_trunc('month',h.from_date),date_trunc('month',h.to_date),INTERVAL '1 month') d WHERE d::date>=h.from_date AND (d+INTERVAL '1 month -1 day')::date<=least(h.to_date,current_date)),
  'locked_months',(SELECT coalesce(jsonb_agg(c.month_start ORDER BY c.month_start),'[]') FROM public.acct_close_records c JOIN public.acct_periods p ON p.month_start=c.month_start WHERE c.proof->>'history_check_id'=h.id::text AND p.is_locked AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens WHERE close_id=c.id))
 ) ORDER BY h.from_date DESC,h.created_at DESC,h.id),'[]') FROM public.acct_history_checks h),
 'dispositions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY created_at DESC,id),'[]') FROM public.acct_history_dispositions d),
 'excluded',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'entry_date',g.entry_date,'memo',g.memo,'reason',g.reason,'batch_id',g.batch_id,'disposition',(SELECT to_jsonb(d) FROM public.acct_history_dispositions d WHERE d.group_id=g.id ORDER BY version DESC LIMIT 1)) ORDER BY g.entry_date,g.id),'[]') FROM public.acct_import_groups g WHERE status='excluded'),
 'years',(SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY year DESC),'[]') FROM public.acct_fiscal_years y));
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_document_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.state='archived' AND OLD.state<>'archived' AND EXISTS(SELECT 1 FROM public.acct_history_dispositions WHERE document_id=NEW.document_id) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_history_document_guard BEFORE UPDATE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_history_document_guard();

REVOKE ALL ON FUNCTION public.acct_history_view(),public.acct_history_document_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_history_view() TO authenticated;
REVOKE ALL ON FUNCTION public.acct_closing_normalization_valid(uuid),public.acct_history_preview(date,date,jsonb,jsonb,jsonb),public.acct_history_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_history_preview(date,date,jsonb,jsonb,jsonb) TO authenticated;


-- ACCOUNTING HISTORY END

-- ACCOUNTING TRANSFERS BEGIN
CREATE OR REPLACE FUNCTION public.acct_transfer_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE outgoing public.acct_journal_entries;incoming public.acct_journal_entries;transit uuid;
BEGIN
 PERFORM public.acct_write_lock();
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='posted' AND NEW.status='corrected' AND NEW.version=OLD.version+1 AND (to_jsonb(OLD)-'status'-'version')=(to_jsonb(NEW)-'status'-'version') AND EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND reverses_entry_id IN (OLD.outgoing_entry_id,OLD.incoming_entry_id)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ACCT_APPEND_ONLY';
 END IF;
 IF NEW.status<>'posted' OR NEW.version<>1 THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_transfer_groups WHERE outgoing_entry_id IN (NEW.outgoing_entry_id,NEW.incoming_entry_id) OR incoming_entry_id IN (NEW.outgoing_entry_id,NEW.incoming_entry_id)) THEN RAISE EXCEPTION 'ACCT_TRANSFER_ALREADY_LINKED'; END IF;
 SELECT * INTO outgoing FROM public.acct_journal_entries WHERE id=NEW.outgoing_entry_id AND status='posted';
 SELECT * INTO incoming FROM public.acct_journal_entries WHERE id=NEW.incoming_entry_id AND status='posted';
 IF outgoing.id IS NULL OR incoming.id IS NULL OR outgoing.entry_date<>NEW.outgoing_date OR incoming.entry_date<>NEW.incoming_date OR EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id IN(outgoing.id,incoming.id)) THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 IF (SELECT count(*) FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id IN (NEW.from_account_id,NEW.to_account_id) AND ((p.cash_kind IN ('bank','cash') AND a.account_type='asset') OR (p.cash_kind='card' AND a.account_type='liability')))<>2 THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=outgoing.id AND account_id=NEW.from_account_id AND amount_cents=-NEW.amount_cents) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=incoming.id AND account_id=NEW.to_account_id AND amount_cents=NEW.amount_cents) THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 IF outgoing.id=incoming.id THEN
  IF (SELECT count(*) FROM public.acct_journal_lines WHERE entry_id=outgoing.id)<>2 THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 ELSE
  SELECT account_id INTO transit FROM public.acct_account_profiles WHERE purpose='transfers_in_transit';
  IF transit IS NULL OR (SELECT count(*) FROM public.acct_journal_lines WHERE entry_id IN(outgoing.id,incoming.id))<>4 OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=outgoing.id AND account_id=transit AND amount_cents=NEW.amount_cents) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=incoming.id AND account_id=transit AND amount_cents=-NEW.amount_cents) THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
  IF coalesce((SELECT sum(a.amount_cents) FROM public.acct_clearing_allocations a JOIN public.acct_journal_lines o ON o.id=a.obligation_line_id JOIN public.acct_journal_lines i ON i.id=a.settlement_line_id WHERE o.account_id=transit AND i.account_id=transit AND ((o.entry_id=outgoing.id AND i.entry_id=incoming.id) OR (i.entry_id=outgoing.id AND o.entry_id=incoming.id)) AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases WHERE allocation_id=a.id)),0)<>NEW.amount_cents THEN RAISE EXCEPTION 'ACCT_TRANSFER_CLEARING_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_transfer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_transfer_groups FOR EACH ROW EXECUTE FUNCTION public.acct_transfer_guard();

CREATE OR REPLACE FUNCTION public.acct_transfer_reversal_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status='posted' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.acct_transfer_groups g WHERE NEW.reverses_entry_id IN(g.outgoing_entry_id,g.incoming_entry_id) AND
  (NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND reverses_entry_id=g.outgoing_entry_id) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND reverses_entry_id=g.incoming_entry_id))
 ) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REVERSE_TOGETHER'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER acct_transfer_reversal_complete AFTER INSERT OR UPDATE ON public.acct_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_transfer_reversal_complete();

CREATE OR REPLACE FUNCTION public.acct_transfer_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;outgoing uuid;incoming uuid;from_account uuid;to_account uuid;out_date date;in_date date;amount bigint;transit uuid;saved jsonb;out_line uuid;in_line uuid;allocated numeric;g public.acct_transfer_groups;reversal jsonb;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF op='transfer.reverse' THEN
  SELECT * INTO g FROM public.acct_transfer_groups WHERE id=v_id AND status='posted';
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
  reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',g.outgoing_entry_id,'expected_version',(SELECT version FROM public.acct_journal_entries WHERE id=g.outgoing_entry_id),'entry_date',p_command->'outgoing_date','reason',p_command->'reason'));
  IF g.outgoing_entry_id<>g.incoming_entry_id THEN
   saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',g.incoming_entry_id,'expected_version',(SELECT version FROM public.acct_journal_entries WHERE id=g.incoming_entry_id),'entry_date',p_command->'incoming_date','reason',p_command->'reason'));
  ELSE saved:=reversal; END IF;
  RETURN jsonb_build_object('id',v_id,'outgoing_reversal_id',reversal->'id','incoming_reversal_id',saved->'id');
 END IF;
 IF op NOT IN ('transfer.create','transfer.link') THEN RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 IF p_command->>'amount_cents' IS NULL OR p_command->>'amount_cents'!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
 amount:=(p_command->>'amount_cents')::bigint;from_account:=(p_command->>'from_account_id')::uuid;to_account:=(p_command->>'to_account_id')::uuid;
 IF from_account=to_account OR length(btrim(coalesce(p_command->>'memo',''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 SELECT account_id INTO transit FROM public.acct_account_profiles WHERE purpose='transfers_in_transit';
 IF op='transfer.create' THEN
  out_date:=(p_command->>'outgoing_date')::date;in_date:=(p_command->>'incoming_date')::date;
  IF out_date IS NULL OR in_date IS NULL OR least(out_date,in_date)<'1900-01-01'::date OR greatest(out_date,in_date)>'2100-12-31'::date THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  outgoing:=gen_random_uuid();incoming:=CASE WHEN out_date=in_date THEN outgoing ELSE gen_random_uuid() END;
  IF outgoing<>incoming AND transit IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSIT_ACCOUNT_REQUIRED'; END IF;
  saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',outgoing,'expected_version',0,'entry_date',out_date,'memo',p_command->'memo','lines',jsonb_build_array(jsonb_build_object('account_id',from_account,'amount_cents',(-amount)::text,'memo','Transfer out'),jsonb_build_object('account_id',CASE WHEN outgoing=incoming THEN to_account ELSE transit END,'amount_cents',amount::text,'memo','Transfer in'))));
  INSERT INTO public.acct_entry_context(entry_id,kind) VALUES(outgoing,'transfer');
  PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',outgoing,'expected_version',saved->'version'));
  IF outgoing<>incoming THEN
   saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',incoming,'expected_version',0,'entry_date',in_date,'memo',p_command->'memo','lines',jsonb_build_array(jsonb_build_object('account_id',transit,'amount_cents',(-amount)::text,'memo','Transfer in transit'),jsonb_build_object('account_id',to_account,'amount_cents',amount::text,'memo','Transfer received'))));
   INSERT INTO public.acct_entry_context(entry_id,kind) VALUES(incoming,'transfer');
   PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',incoming,'expected_version',saved->'version'));
  END IF;
 ELSE
  outgoing:=(p_command->>'outgoing_entry_id')::uuid;incoming:=(p_command->>'incoming_entry_id')::uuid;
  SELECT entry_date INTO out_date FROM public.acct_journal_entries WHERE id=outgoing AND status='posted';
  SELECT entry_date INTO in_date FROM public.acct_journal_entries WHERE id=incoming AND status='posted';
  IF out_date IS NULL OR in_date IS NULL THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
 END IF;
 IF outgoing<>incoming THEN
  SELECT id INTO out_line FROM public.acct_journal_lines WHERE entry_id=outgoing AND account_id=transit AND amount_cents=amount;
  SELECT id INTO in_line FROM public.acct_journal_lines WHERE entry_id=incoming AND account_id=transit AND amount_cents=-amount;
  IF out_line IS NULL OR in_line IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
  SELECT coalesce(sum(amount_cents),0) INTO allocated FROM public.acct_clearing_allocations WHERE ((obligation_line_id=out_line AND settlement_line_id=in_line) OR (settlement_line_id=out_line AND obligation_line_id=in_line)) AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases WHERE allocation_id=acct_clearing_allocations.id);
  IF allocated<amount THEN
   IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',greatest(out_date,in_date))::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
   INSERT INTO public.acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by) VALUES(gen_random_uuid(),out_line,in_line,amount-allocated,greatest(out_date,in_date),'Linked transfer legs',p_actor);
  END IF;
 END IF;
 INSERT INTO public.acct_transfer_groups(id,outgoing_entry_id,incoming_entry_id,from_account_id,to_account_id,outgoing_date,incoming_date,amount_cents,status,memo,created_by) VALUES(v_id,outgoing,incoming,from_account,to_account,out_date,in_date,amount,'posted',p_command->>'memo',p_actor);
 RETURN jsonb_build_object('id',v_id,'outgoing_entry_id',outgoing,'incoming_entry_id',incoming);
END $$;
CREATE OR REPLACE FUNCTION public.acct_transfers_view(p_from date,p_to date,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'total',(SELECT count(*) FROM public.acct_transfer_groups WHERE greatest(outgoing_date,incoming_date)>=p_from AND least(outgoing_date,incoming_date)<=p_to),'groups',(
  SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('amount_cents',g.amount_cents::text,'from_name',a.name,'to_name',b.name,'in_transit',g.status='posted' AND least(g.outgoing_date,g.incoming_date)<=p_to AND greatest(g.outgoing_date,g.incoming_date)>p_to) ORDER BY greatest(outgoing_date,incoming_date) DESC,g.id),'[]') FROM (SELECT * FROM public.acct_transfer_groups WHERE greatest(outgoing_date,incoming_date)>=p_from AND least(outgoing_date,incoming_date)<=p_to ORDER BY greatest(outgoing_date,incoming_date) DESC,id LIMIT 50 OFFSET p_offset) g JOIN public.acct_accounts a ON a.id=g.from_account_id JOIN public.acct_accounts b ON b.id=g.to_account_id
 ));
END $$;
REVOKE ALL ON FUNCTION public.acct_transfer_guard(),public.acct_transfer_reversal_complete(),public.acct_transfer_command(jsonb,uuid),public.acct_transfers_view(date,date,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_transfers_view(date,date,integer) TO authenticated;

-- ACCOUNTING TRANSFERS END

-- ACCOUNTING BANK MATCHING BEGIN

CREATE INDEX acct_bank_matches_source ON public.acct_bank_matches(source_record_id);
CREATE INDEX acct_bank_matches_line ON public.acct_bank_matches(entry_line_id);
CREATE TABLE public.acct_bank_match_releases (
 id uuid PRIMARY KEY,
 match_id uuid NOT NULL UNIQUE REFERENCES public.acct_bank_matches(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 reversal_entry_id uuid REFERENCES public.acct_journal_entries(id),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.acct_bank_match_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_bank_match_releases FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_bank_match_releases FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_bank_match_releases FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_bank_match_release_immutable BEFORE UPDATE OR DELETE ON public.acct_bank_match_releases FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();

CREATE OR REPLACE FUNCTION public.acct_bank_source_used(p_source uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(sum(abs(m.amount_cents::numeric)),0) FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=p_source WHERE s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id=current_source.external_id AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id);
$$;
CREATE OR REPLACE FUNCTION public.acct_bank_line_used(p_line uuid,p_source uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(sum(abs(m.amount_cents::numeric)),0) FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=p_source WHERE m.entry_line_id=p_line AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id);
$$;
CREATE OR REPLACE FUNCTION public.acct_bank_match_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.acct_import_groups;line public.acct_journal_lines;s public.acct_source_records;
BEGIN
 PERFORM public.acct_write_lock();
 SELECT * INTO s FROM public.acct_source_records WHERE id=NEW.source_record_id;
 SELECT * INTO g FROM public.acct_import_groups WHERE source_record_id=s.id AND bank_account_id IS NOT NULL ORDER BY id LIMIT 1;
 SELECT * INTO line FROM public.acct_journal_lines WHERE id=NEW.entry_line_id;
 IF g.id IS NULL OR line.account_id IS DISTINCT FROM g.bank_account_id OR sign(line.amount_cents) IS DISTINCT FROM sign(g.bank_amount_cents) OR sign(NEW.amount_cents) IS DISTINCT FROM sign(g.bank_amount_cents) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_entries e WHERE e.id=line.entry_id AND e.status='posted' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=e.id)) THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_import_groups other JOIN public.acct_source_records os ON os.id=other.source_record_id WHERE os.source_system=s.source_system AND os.source_scope=s.source_scope AND os.external_id=s.external_id AND (other.bank_account_id IS DISTINCT FROM g.bank_account_id OR other.bank_amount_cents IS DISTINCT FROM g.bank_amount_cents OR other.entry_date IS DISTINCT FROM g.entry_date)) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CONFLICT'; END IF;
 IF abs(NEW.amount_cents::numeric)>abs(g.bank_amount_cents::numeric)-public.acct_bank_source_used(s.id) OR abs(NEW.amount_cents::numeric)>abs(line.amount_cents::numeric)-public.acct_bank_line_used(line.id,s.id) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_bank_match_guard BEFORE INSERT ON public.acct_bank_matches FOR EACH ROW EXECUTE FUNCTION public.acct_bank_match_guard();

CREATE OR REPLACE FUNCTION public.acct_bank_group_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE used numeric;
BEGIN
 IF NEW.bank_account_id IS NOT NULL THEN
  used:=public.acct_bank_source_used(NEW.source_record_id);
  IF used>0 AND (NEW.status IN ('new','applied','excluded') OR NEW.status='duplicate' AND used<>abs(NEW.bank_amount_cents::numeric)) THEN RAISE EXCEPTION 'ACCT_BANK_PARTIAL_REVIEW'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_bank_group_guard BEFORE UPDATE ON public.acct_import_groups FOR EACH ROW EXECUTE FUNCTION public.acct_bank_group_guard();
REVOKE ALL ON FUNCTION public.acct_bank_group_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.acct_bank_reopen_source(p_source uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.acct_import_groups g SET status='review',entry_id=CASE WHEN EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=g.entry_id AND status='draft') THEN g.entry_id ELSE NULL END,version=version+1,reason=p_reason FROM public.acct_source_records s,public.acct_source_records current_source WHERE current_source.id=p_source AND s.id=g.source_record_id AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id=current_source.external_id AND g.status<>'excluded';
 UPDATE public.acct_import_batches b SET status=CASE WHEN status='completed' THEN 'review' ELSE status END,coverage_verified=false,version=version+1 WHERE EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_source_records s ON s.id=g.source_record_id JOIN public.acct_source_records current_source ON current_source.id=p_source WHERE g.batch_id=b.id AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id=current_source.external_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_bank_posting_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE match public.acct_bank_matches;
BEGIN
 IF NEW.status='posted' AND OLD.status='draft' THEN
  IF NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.acct_import_groups g WHERE g.bank_account_id IS NOT NULL AND (g.entry_id=NEW.id OR EXISTS(SELECT 1 FROM public.acct_source_links WHERE entry_id=NEW.id AND source_record_id=g.source_record_id)) AND (g.entry_date<>NEW.entry_date OR g.bank_amount_cents IS DISTINCT FROM (SELECT sum(amount_cents) FROM public.acct_journal_lines WHERE entry_id=NEW.id AND account_id=g.bank_account_id))) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
  IF NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_source_records source ON source.id=g.source_record_id JOIN public.acct_source_records s ON s.source_system=source.source_system AND s.source_scope=source.source_scope AND s.external_id=source.external_id JOIN public.acct_bank_matches m ON m.source_record_id=s.id JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE (g.entry_id=NEW.id OR EXISTS(SELECT 1 FROM public.acct_source_links WHERE source_record_id=g.source_record_id AND entry_id=NEW.id)) AND l.entry_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id)) THEN RAISE EXCEPTION 'ACCT_BANK_PARTIAL_REVIEW'; END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
   FOR match IN SELECT m.* FROM public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE l.entry_id=NEW.reverses_entry_id AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) LOOP
    INSERT INTO public.acct_bank_match_releases(id,match_id,reason,reversal_entry_id,created_by) VALUES(gen_random_uuid(),match.id,'Matched entry reversed; bank evidence needs review',NEW.id,NEW.created_by);
    PERFORM public.acct_bank_reopen_source(match.source_record_id,'Matched posting reversed; review the remaining bank allocation');
   END LOOP;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_bank_posting_guard BEFORE UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_bank_posting_guard();

CREATE OR REPLACE FUNCTION public.acct_bank_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;g public.acct_import_groups;s public.acct_source_records;match public.acct_bank_matches;x jsonb;entry public.acct_journal_entries;used numeric;ids uuid[];drafts uuid[]:='{}';target uuid;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF length(btrim(coalesce(p_command->>'reason',''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
 IF op='bank.release' THEN
  SELECT * INTO match FROM public.acct_bank_matches WHERE id=(p_command->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  INSERT INTO public.acct_bank_match_releases(id,match_id,reason,created_by) VALUES(v_id,match.id,p_command->>'reason',p_actor);
  PERFORM public.acct_bank_reopen_source(match.source_record_id,p_command->>'reason');
  RETURN jsonb_build_object('id',v_id);
 END IF;
 IF op<>'bank.match' THEN RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 SELECT * INTO g FROM public.acct_import_groups WHERE id=(p_command->>'group_id')::uuid AND bank_account_id IS NOT NULL AND status<>'excluded';
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_import_batches WHERE id=g.batch_id AND status IN ('staging','cancelled','failed')) THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 SELECT * INTO s FROM public.acct_source_records WHERE id=g.source_record_id;
 SELECT array_agg(src.id) INTO ids FROM public.acct_source_records src WHERE src.source_system=s.source_system AND src.source_scope=s.source_scope AND src.external_id=s.external_id;
 IF jsonb_typeof(p_command->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'allocations') NOT BETWEEN 0 AND 50 OR jsonb_typeof(coalesce(p_command->'discard_drafts','[]')) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF jsonb_array_length(p_command->'allocations')=0 AND public.acct_bank_source_used(s.id)<>abs(g.bank_amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_import_groups other JOIN public.acct_source_records os ON os.id=other.source_record_id WHERE os.id=ANY(ids) AND (other.bank_account_id IS DISTINCT FROM g.bank_account_id OR other.bank_amount_cents IS DISTINCT FROM g.bank_amount_cents OR other.entry_date IS DISTINCT FROM g.entry_date)) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CONFLICT'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_command->'allocations'))<>(SELECT count(DISTINCT item.value->>'line_id') FROM jsonb_array_elements(p_command->'allocations') item(value)) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_command->'allocations') LOOP
  IF x->>'amount_cents' IS NULL OR x->>'amount_cents'!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
  INSERT INTO public.acct_bank_matches(id,source_record_id,entry_line_id,amount_cents,created_by) VALUES(gen_random_uuid(),s.id,(x->>'line_id')::uuid,sign(g.bank_amount_cents)*(x->>'amount_cents')::bigint,p_actor);
  INSERT INTO public.acct_source_links(source_record_id,entry_id) SELECT s.id,entry_id FROM public.acct_journal_lines WHERE id=(x->>'line_id')::uuid ON CONFLICT DO NOTHING;
 END LOOP;
 used:=public.acct_bank_source_used(s.id);
 IF used=abs(g.bank_amount_cents::numeric) THEN
  SELECT l.entry_id INTO target FROM public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE m.source_record_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) ORDER BY m.created_at,m.id LIMIT 1;
  FOR entry IN SELECT DISTINCT e.* FROM public.acct_journal_entries e JOIN public.acct_import_groups groups ON groups.entry_id=e.id WHERE groups.source_record_id=ANY(ids) AND e.status='draft' LOOP
   drafts:=array_append(drafts,entry.id);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_command->'discard_drafts','[]')) d WHERE (d->>'id')::uuid=entry.id AND (d->>'expected_version')::integer=entry.version) THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_APPROVAL'; END IF;
   IF (SELECT count(*) FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=entry.id AND p.cash_kind IN ('bank','cash','card'))<>1 OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=entry.id AND account_id=g.bank_account_id AND amount_cents=g.bank_amount_cents) THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_CHANGED'; END IF;
   INSERT INTO public.acct_document_links(document_id,entry_id) SELECT d.document_id,l.entry_id FROM public.acct_document_links d CROSS JOIN public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE d.entry_id=entry.id AND m.source_record_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) ON CONFLICT DO NOTHING;
   PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.discard','id',entry.id,'expected_version',entry.version,'reason',p_command->'reason'));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_command->'discard_drafts','[]')) d WHERE NOT((d->>'id')::uuid=ANY(drafts))) THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_CHANGED'; END IF;
  INSERT INTO public.acct_source_links(source_record_id,entry_id) SELECT src,l.entry_id FROM unnest(ids) src CROSS JOIN public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE m.source_record_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) ON CONFLICT DO NOTHING;
  UPDATE public.acct_import_groups SET status='duplicate',entry_id=target,version=version+1,reason=p_command->>'reason' WHERE source_record_id=ANY(ids) AND status<>'excluded';
 ELSE
  IF jsonb_array_length(coalesce(p_command->'discard_drafts','[]'))>0 THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_APPROVAL'; END IF;
  UPDATE public.acct_import_groups SET status='review',version=version+1,reason='Partially matched; finish or release the bank allocation' WHERE source_record_id=ANY(ids) AND status<>'excluded';
 END IF;
 UPDATE public.acct_import_batches SET status=CASE WHEN status='completed' AND used<abs(g.bank_amount_cents::numeric) THEN 'review' ELSE status END,version=version+1,coverage_verified=false WHERE id IN(SELECT batch_id FROM public.acct_import_groups WHERE source_record_id=ANY(ids));
 RETURN jsonb_build_object('id',v_id,'group_id',g.id,'remaining_cents',(abs(g.bank_amount_cents::numeric)-used)::text);
END $$;

CREATE OR REPLACE FUNCTION public.acct_bank_review(p_group uuid,p_query text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.acct_import_groups;s public.acct_source_records;ids uuid[];candidates jsonb;total integer;
BEGIN
 PERFORM public.acct_require_owner();
 IF p_offset<0 OR length(p_query)>200 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 SELECT * INTO g FROM public.acct_import_groups WHERE id=p_group AND bank_account_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 SELECT * INTO s FROM public.acct_source_records WHERE id=g.source_record_id;
 SELECT array_agg(id) INTO ids FROM public.acct_source_records WHERE source_system=s.source_system AND source_scope=s.source_scope AND external_id=s.external_id;
 WITH available AS (
  SELECT l.id AS line_id,l.entry_id,e.entry_date,e.memo,l.amount_cents::text,(abs(l.amount_cents::numeric)-public.acct_bank_line_used(l.id,s.id))::text AS available_cents,abs(e.entry_date-g.entry_date) AS days_apart FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=g.bank_account_id AND sign(l.amount_cents)=sign(g.bank_amount_cents) AND e.status='posted' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=e.id) AND (p_query='' OR strpos(lower(e.memo),lower(p_query))>0 OR e.entry_date::text=p_query)
 ), eligible AS (SELECT * FROM available WHERE available_cents::numeric>0), page AS (SELECT * FROM eligible ORDER BY days_apart,entry_date,line_id LIMIT 25 OFFSET p_offset)
 SELECT (SELECT count(*) FROM eligible),coalesce(jsonb_agg(to_jsonb(page) ORDER BY days_apart,entry_date,line_id),'[]') INTO total,candidates FROM page;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'group',to_jsonb(g)||jsonb_build_object('bank_amount_cents',g.bank_amount_cents::text,'account_name',(SELECT name FROM public.acct_accounts WHERE id=g.bank_account_id),'source_system',s.source_system,'source_scope',s.source_scope),'source_conflict',EXISTS(SELECT 1 FROM public.acct_import_groups other WHERE other.source_record_id=ANY(ids) AND (other.bank_account_id IS DISTINCT FROM g.bank_account_id OR other.bank_amount_cents IS DISTINCT FROM g.bank_amount_cents OR other.entry_date IS DISTINCT FROM g.entry_date)),'remaining_cents',(abs(g.bank_amount_cents::numeric)-public.acct_bank_source_used(s.id))::text,'candidates',candidates,'total',total,
 'drafts',(SELECT coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('lines',(SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text,'account_name',a.name) ORDER BY l.sort_order) FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=e.id))),'[]') FROM (SELECT DISTINCT entry.* FROM public.acct_journal_entries entry JOIN public.acct_import_groups groups ON groups.entry_id=entry.id WHERE groups.source_record_id=ANY(ids) AND entry.status='draft') e),
 'matches',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('amount_cents',m.amount_cents::text,'entry_id',l.entry_id,'entry_date',e.entry_date,'memo',e.memo,'release',(SELECT to_jsonb(r) FROM public.acct_bank_match_releases r WHERE r.match_id=m.id)) ORDER BY m.created_at,m.id),'[]') FROM public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE m.source_record_id=ANY(ids)));
END $$;
REVOKE ALL ON FUNCTION public.acct_bank_source_used(uuid),public.acct_bank_line_used(uuid,uuid),public.acct_bank_match_guard(),public.acct_bank_reopen_source(uuid,text),public.acct_bank_posting_guard(),public.acct_bank_command(jsonb,uuid),public.acct_bank_review(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_bank_review(uuid,text,integer) TO authenticated;


-- ACCOUNTING BANK MATCHING END

-- ACCOUNTING RETAINED REVIEW BEGIN
CREATE TABLE public.acct_retained_reviews (
 id uuid PRIMARY KEY,
 entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
 entry_version integer NOT NULL CHECK(entry_version>0),
 kind text NOT NULL CHECK(kind IN ('opening','historical','correction')),
 original_entry_id uuid REFERENCES public.acct_journal_entries(id),
 source_group_id uuid REFERENCES public.acct_import_groups(id),
 document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 controls jsonb NOT NULL CHECK(jsonb_typeof(controls)='array'),
 reviewed_payload jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 3000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acct_retained_reviews_entry ON public.acct_retained_reviews(entry_id,entry_version);
ALTER TABLE public.acct_retained_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_retained_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_retained_reviews FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_retained_reviews FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_retained_review_immutable BEFORE UPDATE OR DELETE ON public.acct_retained_reviews FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();

CREATE OR REPLACE FUNCTION public.acct_retained_payload(p_entry uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('entry_date',e.entry_date,'memo',e.memo,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo,'sort_order',l.sort_order) ORDER BY l.sort_order,l.id) FROM public.acct_journal_lines l WHERE l.entry_id=e.id)) FROM public.acct_journal_entries e WHERE e.id=p_entry;
$$;
CREATE OR REPLACE FUNCTION public.acct_retained_review(p_entry uuid,p_kind text,p_document uuid,p_controls jsonb,p_reason text,p_actor uuid,p_original uuid DEFAULT NULL,p_group uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE entry public.acct_journal_entries;v_id uuid:=gen_random_uuid();actual jsonb;control jsonb;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 SELECT * INTO entry FROM public.acct_journal_entries WHERE id=p_entry AND status='draft';
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=p_entry AND p.purpose='opening_retained_earnings') THEN RAISE EXCEPTION 'ACCT_RETAINED_NOT_USED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=p_document AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF p_kind IN ('opening','historical') AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=p_entry AND a.account_type IN ('income','expense')) THEN RAISE EXCEPTION 'ACCT_NOMINAL_CLOSING_FORBIDDEN'; END IF;
 IF p_kind='opening' AND EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND entry_date<=entry.entry_date) THEN RAISE EXCEPTION 'ACCT_OPENING_HISTORY_EXISTS'; END IF;
 IF p_kind='correction' AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries original WHERE original.id=p_original AND original.status='posted' AND EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=original.id AND status='posted')) THEN RAISE EXCEPTION 'ACCT_RETAINED_CORRECTION'; END IF;
 IF p_kind='historical' AND NOT EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_import_batches b ON b.id=g.batch_id WHERE g.id=p_group AND b.source_document_id=p_document AND b.mode='journal' AND b.basis='cash' AND b.source_system=entry.primary_origin AND g.entry_date=entry.entry_date AND g.status='new') THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 IF jsonb_typeof(p_controls) IS DISTINCT FROM 'array' OR jsonb_array_length(p_controls) NOT BETWEEN 2 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_controls) c WHERE c->>'amount_cents' IS NULL OR c->>'amount_cents'!~'^-?(0|[1-9][0-9]{0,18})$' OR abs((c->>'amount_cents')::numeric)>9223372036854775807) OR (SELECT count(*) FROM jsonb_array_elements(p_controls))<>(SELECT count(DISTINCT c->>'account_id') FROM jsonb_array_elements(p_controls) c) THEN RAISE EXCEPTION 'ACCT_INVALID_CONTROL'; END IF;
 SELECT jsonb_agg(jsonb_build_array(account_id,amount::text) ORDER BY account_id) INTO actual FROM (SELECT account_id,sum(amount_cents) amount FROM public.acct_journal_lines WHERE entry_id=p_entry GROUP BY account_id) totals;
 SELECT jsonb_agg(jsonb_build_array((c->>'account_id')::uuid,((c->>'amount_cents')::numeric)::text) ORDER BY (c->>'account_id')::uuid) INTO control FROM jsonb_array_elements(p_controls) c;
 IF actual IS DISTINCT FROM control THEN RAISE EXCEPTION 'ACCT_RETAINED_CONTROL_DIFFERENCE'; END IF;
 INSERT INTO public.acct_retained_reviews(id,entry_id,entry_version,kind,original_entry_id,source_group_id,document_id,controls,reviewed_payload,reason,created_by) VALUES(v_id,p_entry,entry.version,p_kind,p_original,p_group,p_document,p_controls,public.acct_retained_payload(p_entry),p_reason,p_actor);
 INSERT INTO public.acct_document_links(document_id,entry_id) VALUES(p_document,p_entry) ON CONFLICT DO NOTHING;
 RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION public.acct_retained_post_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status='posted' AND OLD.status='draft' AND NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=NEW.id AND p.purpose='opening_retained_earnings') AND NOT EXISTS(SELECT 1 FROM public.acct_retained_reviews r JOIN public.acct_document_states d ON d.document_id=r.document_id WHERE r.entry_id=NEW.id AND r.entry_version=OLD.version AND r.reviewed_payload=public.acct_retained_payload(NEW.id) AND d.state='available') THEN RAISE EXCEPTION 'ACCT_RETAINED_REVIEW_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_retained_post_guard BEFORE UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_retained_post_guard();
CREATE OR REPLACE FUNCTION public.acct_retained_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE entry public.acct_journal_entries;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF p_command->>'type'<>'retained.post' THEN RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 SELECT * INTO entry FROM public.acct_journal_entries WHERE id=(p_command->>'id')::uuid;
 IF entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 PERFORM public.acct_retained_review(entry.id,'opening',(p_command->>'document_id')::uuid,p_command->'controls',p_command->>'reason',p_actor);
 RETURN public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',entry.id,'expected_version',entry.version));
END $$;
REVOKE ALL ON FUNCTION public.acct_retained_payload(uuid),public.acct_retained_review(uuid,text,uuid,jsonb,text,uuid,uuid,uuid),public.acct_retained_post_guard(),public.acct_retained_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;



-- ACCOUNTING RETAINED REVIEW END

-- ACCOUNTING STATEMENT FILES BEGIN
CREATE TABLE public.acct_statement_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
 document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 file_hash text NOT NULL CHECK(file_hash~'^[a-f0-9]{64}$'),
 mapping_hash text NOT NULL CHECK(mapping_hash~'^[a-f0-9]{64}$'),
 mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reconciliation_id,document_id,mapping_hash)
);
CREATE TABLE public.acct_statement_item_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
 file_id uuid NOT NULL REFERENCES public.acct_statement_files(id),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 500),
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),
 -- Preserve the original identity after an unmatched item is removed. Restoration is explicit.
 original_item_id uuid NOT NULL UNIQUE,
 source_row integer NOT NULL CHECK(source_row>0),
 entry_date date NOT NULL,
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
 raw_payload jsonb NOT NULL CHECK(jsonb_typeof(raw_payload)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reconciliation_id,external_id)
);
CREATE TABLE public.acct_statement_amendments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
 previous_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 next_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 before_value jsonb NOT NULL,
 after_value jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['acct_statement_files','acct_statement_item_sources','acct_statement_amendments'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
  EXECUTE format('CREATE TRIGGER acct_statement_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.acct_statement_header(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT to_jsonb(r)||jsonb_build_object('opening_cents',r.opening_cents::text,'ending_cents',r.ending_cents::text,'declared_debits_cents',r.declared_debits_cents::text,'declared_credits_cents',r.declared_credits_cents::text) FROM public.acct_reconciliations r WHERE id=p_id;
$$;
CREATE OR REPLACE FUNCTION public.acct_statement_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_reconciliations;x jsonb;existing public.acct_statement_item_sources;file_id uuid;item_id uuid;slot integer;added integer:=0;skipped integer:=0;restored integer:=0;previous jsonb;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 SELECT * INTO r FROM public.acct_reconciliations WHERE id=(p_command->>'id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 IF r.status<>'in_progress' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_FINAL'; END IF;
 IF r.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF p_command->>'type'='statement.import' THEN
  IF NOT EXISTS(SELECT 1 FROM public.acct_documents WHERE id=(p_command->>'document_id')::uuid AND content_hash=p_command->>'file_hash' AND mime_type='text/csv') THEN RAISE EXCEPTION 'ACCT_STATEMENT_SOURCE_FILE'; END IF;
  IF jsonb_typeof(p_command->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  INSERT INTO public.acct_statement_files(reconciliation_id,document_id,file_hash,mapping_hash,mapping,created_by) VALUES(r.id,(p_command->>'document_id')::uuid,p_command->>'file_hash',p_command->>'mapping_hash',p_command->'mapping',p_actor) ON CONFLICT DO NOTHING;
  SELECT id INTO file_id FROM public.acct_statement_files WHERE reconciliation_id=r.id AND document_id=(p_command->>'document_id')::uuid AND mapping_hash=p_command->>'mapping_hash';
  FOR x IN SELECT value FROM jsonb_array_elements(p_command->'items') LOOP
   IF x->>'amount_cents' IS NULL OR x->>'amount_cents'!~'^-?[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   IF (x->>'entry_date')::date NOT BETWEEN r.from_date AND r.to_date THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
   SELECT * INTO existing FROM public.acct_statement_item_sources WHERE reconciliation_id=r.id AND external_id=x->>'external_id';
   IF FOUND THEN
    IF existing.fingerprint<>x->>'fingerprint' OR existing.entry_date<>(x->>'entry_date')::date OR existing.description<>x->>'description' OR existing.amount_cents<>(x->>'amount_cents')::bigint THEN RAISE EXCEPTION 'ACCT_STATEMENT_SOURCE_CHANGED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_statement_items WHERE id=existing.original_item_id) THEN skipped:=skipped+1;CONTINUE; END IF;
    IF (p_command->>'restore_removed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_STATEMENT_ITEM_REMOVED'; END IF;
    item_id:=existing.original_item_id;restored:=restored+1;
   ELSE item_id:=gen_random_uuid();added:=added+1; END IF;
   SELECT coalesce(max(ordinal)+1,0) INTO slot FROM public.acct_statement_items WHERE reconciliation_id=r.id;
   IF slot>=r.declared_count THEN SELECT n INTO slot FROM generate_series(0,r.declared_count-1) n WHERE NOT EXISTS(SELECT 1 FROM public.acct_statement_items WHERE reconciliation_id=r.id AND ordinal=n) ORDER BY n LIMIT 1; END IF;
   IF slot IS NULL THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
   INSERT INTO public.acct_statement_items(id,reconciliation_id,ordinal,entry_date,description,amount_cents) VALUES(item_id,r.id,slot,(x->>'entry_date')::date,x->>'description',(x->>'amount_cents')::bigint);
   IF existing.id IS NULL THEN INSERT INTO public.acct_statement_item_sources(reconciliation_id,file_id,external_id,fingerprint,original_item_id,source_row,entry_date,description,amount_cents,raw_payload) VALUES(r.id,file_id,x->>'external_id',x->>'fingerprint',item_id,(x->>'source_row')::integer,(x->>'entry_date')::date,x->>'description',(x->>'amount_cents')::bigint,x->'raw'); END IF;
  END LOOP;
  UPDATE public.acct_reconciliations SET notes=notes WHERE id=r.id;
 ELSIF p_command->>'type'='statement.amend' THEN
  IF length(btrim(coalesce(p_command->>'reason',''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_statement_items WHERE reconciliation_id=r.id AND (entry_date NOT BETWEEN (p_command->>'from')::date AND (p_command->>'to')::date OR ordinal>=(p_command->>'declared_count')::integer)) THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id<>r.id AND account_id=r.account_id AND status IN ('in_progress','completed') AND from_date<=(p_command->>'to')::date AND to_date>=(p_command->>'from')::date) THEN RAISE EXCEPTION 'ACCT_STATEMENT_OVERLAP'; END IF;
  IF nullif(p_command->>'predecessor_id','') IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id=(p_command->>'predecessor_id')::uuid AND status='completed' AND account_id=r.account_id AND to_date=(p_command->>'from')::date-1 AND ending_cents=(p_command->>'opening_cents')::bigint) THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id<>r.id AND account_id=r.account_id AND status='completed') THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
  previous:=public.acct_statement_header(r.id);
  IF r.from_date<>(p_command->>'from')::date OR r.opening_cents<>(p_command->>'opening_cents')::bigint OR r.predecessor_id IS DISTINCT FROM nullif(p_command->>'predecessor_id','')::uuid THEN DELETE FROM public.acct_reconciliation_opening WHERE reconciliation_id=r.id; END IF;
  UPDATE public.acct_reconciliations SET from_date=(p_command->>'from')::date,to_date=(p_command->>'to')::date,opening_cents=(p_command->>'opening_cents')::bigint,ending_cents=(p_command->>'ending_cents')::bigint,declared_count=(p_command->>'declared_count')::integer,declared_debits_cents=(p_command->>'declared_debits_cents')::bigint,declared_credits_cents=(p_command->>'declared_credits_cents')::bigint,document_id=(p_command->>'document_id')::uuid,predecessor_id=nullif(p_command->>'predecessor_id','')::uuid,notes=coalesce(p_command->>'notes','') WHERE id=r.id;
  INSERT INTO public.acct_statement_amendments(reconciliation_id,previous_document_id,next_document_id,before_value,after_value,reason,created_by) VALUES(r.id,r.document_id,(p_command->>'document_id')::uuid,previous,public.acct_statement_header(r.id),p_command->>'reason',p_actor);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 RETURN jsonb_build_object('id',r.id,'version',(SELECT version FROM public.acct_reconciliations WHERE id=r.id),'added',added,'skipped',skipped,'restored',restored);
END $$;
CREATE OR REPLACE FUNCTION public.acct_statement_documents_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.state='archived' AND OLD.state<>'archived' AND (EXISTS(SELECT 1 FROM public.acct_statement_files WHERE document_id=NEW.document_id) OR EXISTS(SELECT 1 FROM public.acct_statement_amendments WHERE NEW.document_id IN(previous_document_id,next_document_id))) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_statement_documents_guard BEFORE UPDATE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_statement_documents_guard();
CREATE OR REPLACE FUNCTION public.acct_statement_sources(p_statement uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('files',(SELECT coalesce(jsonb_agg(to_jsonb(f)||jsonb_build_object('original_name',d.original_name,'rows',(SELECT count(*) FROM public.acct_statement_item_sources WHERE file_id=f.id)) ORDER BY f.created_at,f.id),'[]') FROM public.acct_statement_files f JOIN public.acct_documents d ON d.id=f.document_id WHERE reconciliation_id=p_statement),'amendments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at,id),'[]') FROM public.acct_statement_amendments a WHERE reconciliation_id=p_statement));
END $$;
REVOKE ALL ON FUNCTION public.acct_statement_header(uuid),public.acct_statement_command(jsonb,uuid),public.acct_statement_documents_guard(),public.acct_statement_sources(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_statement_sources(uuid) TO authenticated;


-- ACCOUNTING STATEMENT FILES END

-- ACCOUNTING RULES BEGIN
CREATE OR REPLACE FUNCTION public.acct_normalize_description(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT lower(regexp_replace(btrim(coalesce(p_text,'')),'\s+',' ','g')); $$;
CREATE TABLE public.acct_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_rule_versions (
 rule_id uuid NOT NULL REFERENCES public.acct_rules(id),
 version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 priority integer NOT NULL CHECK(priority BETWEEN 1 AND 10000),
 enabled boolean NOT NULL DEFAULT false,
 description_mode text NOT NULL CHECK(description_mode IN ('exact','prefix','contains')),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 250),
 bank_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
 direction text NOT NULL CHECK(direction IN ('increase','decrease')),
 min_cents bigint NOT NULL CHECK(min_cents>=0),
 max_cents bigint NOT NULL CHECK(max_cents>0 AND max_cents>=min_cents),
 match_payee_id uuid REFERENCES public.acct_parties(id),
 category_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
 assign_payee_id uuid REFERENCES public.acct_parties(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(rule_id,version)
);
CREATE TABLE public.acct_payee_aliases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 party_id uuid NOT NULL REFERENCES public.acct_parties(id),
 match_mode text NOT NULL CHECK(match_mode IN ('exact','prefix')),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 250),
 enabled boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acct_alias_party ON public.acct_payee_aliases(party_id);
CREATE TABLE public.acct_rule_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rule_id uuid NOT NULL,
 rule_version integer NOT NULL,
 entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
 before_value jsonb NOT NULL,
 after_value jsonb NOT NULL,
 matched_aliases jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(rule_id,rule_version) REFERENCES public.acct_rule_versions(rule_id,version)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['acct_rules','acct_rule_versions','acct_payee_aliases','acct_rule_applications'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['acct_rule_versions','acct_rule_applications'] LOOP
  EXECUTE format('CREATE TRIGGER acct_rule_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.acct_rule_payee(p_description text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH matches AS (SELECT a.*,p.name FROM public.acct_payee_aliases a JOIN public.acct_parties p ON p.id=a.party_id AND NOT p.is_archived WHERE a.enabled AND CASE WHEN a.match_mode='exact' THEN public.acct_normalize_description(p_description)=public.acct_normalize_description(a.description) ELSE starts_with(public.acct_normalize_description(p_description),public.acct_normalize_description(a.description)) END)
 SELECT jsonb_build_object('party_id',CASE WHEN count(DISTINCT party_id)=1 THEN min(party_id::text) ELSE NULL END,'conflict',count(DISTINCT party_id)>1,'aliases',coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'party_id',party_id,'name',name,'description',description,'match_mode',match_mode) ORDER BY id),'[]')) FROM matches;
$$;
CREATE OR REPLACE FUNCTION public.acct_rule_candidate(p_entry uuid,p_rule uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.acct_journal_entries;bank public.acct_journal_lines;category public.acct_journal_lines;party uuid;aliases jsonb;matches jsonb;winner jsonb;reason text:='';payload jsonb;
BEGIN
 SELECT * INTO e FROM public.acct_journal_entries WHERE id=p_entry;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.acct_journal_lines WHERE entry_id=e.id)<>2 THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=e.id AND p.cash_kind IN ('bank','cash','card'))<>1 THEN RETURN NULL; END IF;
 SELECT l.* INTO bank FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=e.id AND p.cash_kind IN ('bank','cash','card');
 SELECT l.* INTO category FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND l.id<>bank.id AND a.account_type IN ('income','expense');
 IF NOT FOUND OR category.amount_cents<>-bank.amount_cents THEN RETURN NULL; END IF;
 aliases:=public.acct_rule_payee(e.memo);SELECT payee_id INTO party FROM public.acct_entry_context WHERE entry_id=e.id;
 party:=coalesce(party,(aliases->>'party_id')::uuid);
 SELECT coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('min_cents',v.min_cents::text,'max_cents',v.max_cents::text,'category_name',a.name) ORDER BY v.priority,v.rule_id),'[]') INTO matches
 FROM public.acct_rule_versions v JOIN public.acct_rules r ON r.id=v.rule_id AND r.version=v.version JOIN public.acct_accounts a ON a.id=v.category_account_id AND NOT a.is_archived
 WHERE (v.enabled OR v.rule_id=p_rule) AND v.bank_account_id=bank.account_id AND (v.direction='increase')=(bank.amount_cents>0) AND abs(bank.amount_cents::numeric) BETWEEN v.min_cents AND v.max_cents AND (v.match_payee_id IS NULL OR v.match_payee_id=party)
 AND CASE v.description_mode WHEN 'exact' THEN public.acct_normalize_description(e.memo)=public.acct_normalize_description(v.description) WHEN 'prefix' THEN starts_with(public.acct_normalize_description(e.memo),public.acct_normalize_description(v.description)) ELSE strpos(public.acct_normalize_description(e.memo),public.acct_normalize_description(v.description))>0 END;
 winner:=matches->0;
 IF winner IS NULL THEN reason:='No matching rule';
 ELSIF (aliases->>'conflict')::boolean THEN reason:='Conflicting payee aliases';
 ELSIF jsonb_array_length(matches)>1 AND matches->0->>'priority'=matches->1->>'priority' THEN reason:='Rules share the winning priority';
 ELSIF e.status<>'draft' THEN reason:='Posted history is preview only';
 ELSIF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE account_id=category.account_id AND purpose IN ('uncategorized_income','uncategorized_expense')) THEN reason:='Category already reviewed';
 ELSIF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',e.entry_date)::date) THEN reason:='Period is locked';
 ELSIF EXISTS(SELECT 1 FROM public.acct_source_links sl WHERE sl.entry_id=e.id AND public.acct_bank_source_used(sl.source_record_id)<>0) THEN reason:='Source already has bank allocations';
 ELSIF winner->>'assign_payee_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=(winner->>'assign_payee_id')::uuid AND NOT is_archived) THEN reason:='Assigned payee is archived';
 ELSIF EXISTS(SELECT 1 FROM public.acct_entry_context c WHERE c.entry_id=e.id AND c.payee_id IS NOT NULL AND winner->>'assign_payee_id' IS NOT NULL AND c.payee_id<>(winner->>'assign_payee_id')::uuid) THEN reason:='Payee already reviewed';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order) INTO payload FROM public.acct_journal_lines l WHERE l.entry_id=e.id;
 RETURN jsonb_build_object('id',e.id,'version',e.version,'entry_date',e.entry_date,'memo',e.memo,'status',e.status,'bank_account_id',bank.account_id,'bank_amount_cents',bank.amount_cents::text,'category_account_id',category.account_id,'category_line_id',category.id,'payee_id',party,'aliases',aliases,'matches',matches,'winner',winner,'eligible',reason='','reason',reason,'lines',payload);
END $$;
CREATE OR REPLACE FUNCTION public.acct_rules_view() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('id',v.rule_id,'min_cents',v.min_cents::text,'max_cents',v.max_cents::text,'history',(SELECT jsonb_agg(to_jsonb(h)||jsonb_build_object('min_cents',h.min_cents::text,'max_cents',h.max_cents::text) ORDER BY h.version DESC) FROM public.acct_rule_versions h WHERE h.rule_id=v.rule_id)) ORDER BY v.priority,v.name,v.rule_id),'[]') FROM public.acct_rules r JOIN public.acct_rule_versions v ON v.rule_id=r.id AND v.version=r.version),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name) ORDER BY a.description,a.id),'[]') FROM public.acct_payee_aliases a JOIN public.acct_parties p ON p.id=a.party_id));
END $$;
CREATE OR REPLACE FUNCTION public.acct_rules_preview(p_from date,p_to date,p_rule uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE rows jsonb;total integer;
BEGIN
 PERFORM public.acct_require_owner();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>3660 OR p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
 WITH candidates AS MATERIALIZED (SELECT public.acct_rule_candidate(e.id,p_rule) candidate FROM public.acct_journal_entries e WHERE e.entry_date BETWEEN p_from AND p_to AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries reversal WHERE reversal.reverses_entry_id=e.id))
 SELECT count(*),(SELECT coalesce(jsonb_agg(x.candidate ORDER BY x.candidate->>'entry_date',x.candidate->>'id'),'[]') FROM (SELECT candidate FROM candidates WHERE candidate IS NOT NULL AND jsonb_array_length(candidate->'matches')>0 AND (p_rule IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'matches') m WHERE m->>'rule_id'=p_rule::text)) ORDER BY candidate->>'entry_date',candidate->>'id' LIMIT 100 OFFSET p_offset) x) INTO total,rows FROM candidates WHERE candidate IS NOT NULL AND jsonb_array_length(candidate->'matches')>0 AND (p_rule IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'matches') m WHERE m->>'rule_id'=p_rule::text));
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'rows',rows,'total',total,'from',p_from,'to',p_to);
END $$;
CREATE OR REPLACE FUNCTION public.acct_rules_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';command_id uuid:=(p_command->>'id')::uuid;current_version integer;v public.acct_rule_versions;x jsonb;c jsonb;lines jsonb;saved jsonb;after_value jsonb;count integer:=0;assign uuid;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF op='alias.save' THEN
  SELECT a.version INTO current_version FROM public.acct_payee_aliases a WHERE a.id=command_id;
  IF coalesce(current_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=(p_command->>'party_id')::uuid AND (NOT is_archived OR (p_command->>'enabled')::boolean=false)) THEN RAISE EXCEPTION 'ACCT_INVALID_PAYEE'; END IF;
  INSERT INTO public.acct_payee_aliases(id,party_id,match_mode,description,enabled,created_by) VALUES(command_id,(p_command->>'party_id')::uuid,p_command->>'match_mode',public.acct_normalize_description(p_command->>'description'),(p_command->>'enabled')::boolean,p_actor)
  ON CONFLICT ON CONSTRAINT acct_payee_aliases_pkey DO UPDATE SET party_id=excluded.party_id,match_mode=excluded.match_mode,description=excluded.description,enabled=excluded.enabled,version=acct_payee_aliases.version+1;
  RETURN jsonb_build_object('id',command_id,'version',coalesce(current_version,0)+1);
 ELSIF op='rule.save' OR op='rule.activate' THEN
  SELECT r.version INTO current_version FROM public.acct_rules r WHERE r.id=command_id;
  IF coalesce(current_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='rule.activate' THEN
   IF current_version IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF (p_command->>'reviewed')::boolean IS DISTINCT FROM true OR (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   SELECT * INTO v FROM public.acct_rule_versions WHERE rule_id=command_id AND acct_rule_versions.version=current_version;
  ELSE
   IF jsonb_typeof(p_command->'min_cents') IS DISTINCT FROM 'string' OR jsonb_typeof(p_command->'max_cents') IS DISTINCT FROM 'string' OR p_command->>'min_cents'!~'^[0-9]{1,19}$' OR p_command->>'max_cents'!~'^[0-9]{1,19}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   v:=jsonb_populate_record(NULL::public.acct_rule_versions,p_command);
   v.enabled:=false;v.description:=public.acct_normalize_description(v.description);
  END IF;
  IF op='rule.save' OR (p_command->>'enabled')::boolean=true THEN
  IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id=v.bank_account_id AND p.cash_kind IN ('bank','cash','card') AND NOT a.is_archived) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.acct_accounts a LEFT JOIN public.acct_account_profiles p ON p.account_id=a.id WHERE a.id=v.category_account_id AND NOT a.is_archived AND a.account_type IN ('income','expense') AND coalesce(p.purpose,'') NOT IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_RULE_CATEGORY'; END IF;
  IF v.assign_payee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=v.assign_payee_id AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_PAYEE'; END IF;
  IF v.match_payee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=v.match_payee_id AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_PAYEE'; END IF;
  END IF;
  INSERT INTO public.acct_rules(id,created_by) VALUES(command_id,p_actor) ON CONFLICT ON CONSTRAINT acct_rules_pkey DO UPDATE SET version=acct_rules.version+1;
  INSERT INTO public.acct_rule_versions(rule_id,version,name,priority,enabled,description_mode,description,bank_account_id,direction,min_cents,max_cents,match_payee_id,category_account_id,assign_payee_id,reason,created_by)
  VALUES(command_id,coalesce(current_version,0)+1,v.name,v.priority,CASE WHEN op='rule.activate' THEN (p_command->>'enabled')::boolean ELSE false END,v.description_mode,v.description,v.bank_account_id,v.direction,v.min_cents,v.max_cents,v.match_payee_id,v.category_account_id,v.assign_payee_id,p_command->>'reason',p_actor);
  RETURN jsonb_build_object('id',command_id,'version',coalesce(current_version,0)+1);
 ELSIF op='rule.apply' THEN
  IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF jsonb_typeof(p_command->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'entries') NOT BETWEEN 1 AND 100 OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_command->'entries'))<>jsonb_array_length(p_command->'entries') THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_command->'entries') LOOP
   c:=public.acct_rule_candidate((x->>'id')::uuid,NULL);
   IF c IS NULL OR (c->>'eligible')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_RULE_INELIGIBLE'; END IF;
   IF c->>'version' IS DISTINCT FROM x->>'expected_version' OR c->'winner'->>'rule_id' IS DISTINCT FROM x->>'rule_id' OR c->'winner'->>'version' IS DISTINCT FROM x->>'rule_version' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   SELECT jsonb_agg(CASE WHEN l->>'account_id'=c->>'category_account_id' THEN l||jsonb_build_object('account_id',c->'winner'->>'category_account_id') ELSE l END ORDER BY ordinal) INTO lines FROM jsonb_array_elements(c->'lines') WITH ORDINALITY AS item(l,ordinal);
   saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',c->>'id','expected_version',c->'version','entry_date',c->>'entry_date','memo',c->>'memo','lines',lines));
   assign:=coalesce((c->'winner'->>'assign_payee_id')::uuid,(c->>'payee_id')::uuid);
   IF assign IS NOT NULL THEN INSERT INTO public.acct_entry_context(entry_id,payee_id) VALUES((c->>'id')::uuid,assign) ON CONFLICT(entry_id) DO UPDATE SET payee_id=excluded.payee_id; END IF;
   after_value:=jsonb_build_object('version',saved->'version','lines',lines,'payee_id',assign);
   INSERT INTO public.acct_rule_applications(rule_id,rule_version,entry_id,before_value,after_value,matched_aliases,created_by) VALUES((c->'winner'->>'rule_id')::uuid,(c->'winner'->>'version')::integer,(c->>'id')::uuid,c,after_value,c->'aliases',p_actor);count:=count+1;
  END LOOP;
  RETURN jsonb_build_object('id',command_id,'count',count);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $$;
REVOKE ALL ON FUNCTION public.acct_normalize_description(text),public.acct_rule_payee(text),public.acct_rule_candidate(uuid,uuid),public.acct_rules_view(),public.acct_rules_preview(date,date,uuid,integer),public.acct_rules_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_rules_view(),public.acct_rules_preview(date,date,uuid,integer) TO authenticated;




-- ACCOUNTING RULES END

-- ACCOUNTING SIMPLEFIN BEGIN
CREATE TABLE public.acct_feed_connections (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'claiming' CHECK(status IN ('claiming','active','reconnect_required','disconnected')),
 version integer NOT NULL DEFAULT 1, generation integer NOT NULL DEFAULT 1,
 scheduled boolean NOT NULL DEFAULT false, next_sync_at timestamptz, retry_at timestamptz,
 last_success_at timestamptz, last_error text NOT NULL DEFAULT '',
 lease_run_id uuid, lease_until timestamptz, created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_feed_secrets (
 connection_id uuid PRIMARY KEY REFERENCES public.acct_feed_connections(id),
 ciphertext text NOT NULL CHECK(length(ciphertext) BETWEEN 50 AND 20000 AND ciphertext ~ '^v[1-9][0-9]*:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'),
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_feed_claims (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES public.acct_feed_connections(id), generation integer NOT NULL,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','transmitting','completed','failed')),
 error text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(connection_id,generation)
);
CREATE TABLE public.acct_feed_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL UNIQUE REFERENCES public.acct_accounts(id),
 history_start bigint NOT NULL CHECK(history_start BETWEEN 1 AND 4133980800), checkpoint bigint, resume_floor bigint,
 posting_timezone text NOT NULL CHECK(posting_timezone IN ('UTC','America/Phoenix')),
 movement_sign integer NOT NULL CHECK(movement_sign IN (-1,1)), balance_sign integer NOT NULL CHECK(balance_sign IN (-1,1)),
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(checkpoint IS NULL OR checkpoint>=history_start), CHECK(resume_floor IS NULL OR resume_floor BETWEEN history_start AND checkpoint)
);
CREATE TABLE public.acct_feed_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid NOT NULL REFERENCES public.acct_feed_connections(id),
 provider_connection_id text NOT NULL CHECK(length(provider_connection_id) BETWEEN 1 AND 500), provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 500),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 500), institution text NOT NULL CHECK(length(institution)<=500), currency text NOT NULL CHECK(length(currency)<=500),
 observed_generation integer NOT NULL, approved_generation integer,
 ownership text NOT NULL DEFAULT 'unreviewed' CHECK(ownership IN ('unreviewed','company','personal','ignored')),
 feed_account_id uuid REFERENCES public.acct_feed_accounts(id), version integer NOT NULL DEFAULT 1,
 last_seen_at timestamptz NOT NULL DEFAULT now(), last_attempt_at timestamptz,
 UNIQUE(connection_id,provider_connection_id,provider_account_id), CHECK((ownership='company')=(feed_account_id IS NOT NULL))
);
CREATE TABLE public.acct_feed_runs (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES public.acct_feed_connections(id), generation integer NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('owner','worker')), requested_by uuid REFERENCES auth.users(id),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','partial','failed','expired')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error text NOT NULL DEFAULT '',
 CHECK((actor_kind='owner')=(requested_by IS NOT NULL))
);
CREATE TABLE public.acct_feed_requests (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES public.acct_feed_runs(id),
 identity_id uuid REFERENCES public.acct_feed_identities(id), from_stamp bigint NOT NULL, to_stamp bigint NOT NULL,
 discovery boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(to_stamp>from_stamp AND to_stamp-from_stamp<=7776000), UNIQUE(run_id,identity_id)
);
CREATE INDEX acct_feed_request_time ON public.acct_feed_requests(created_at);
CREATE TABLE public.acct_feed_windows (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES public.acct_feed_requests(id), identity_id uuid NOT NULL REFERENCES public.acct_feed_identities(id),
 feed_account_id uuid REFERENCES public.acct_feed_accounts(id), protocol text NOT NULL CHECK(length(protocol)<100),
 response_hash text NOT NULL CHECK(response_hash ~ '^[0-9a-f]{64}$'), account_hash text NOT NULL CHECK(account_hash ~ '^[0-9a-f]{64}$'),
 balance_cents bigint, available_cents bigint, balance_at bigint NOT NULL, issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'),
 complete_response boolean NOT NULL, expected_count integer NOT NULL CHECK(expected_count BETWEEN 0 AND 50000),
 status text NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','accepted','incomplete')),
 received_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,identity_id), CHECK(received_count BETWEEN 0 AND expected_count)
);
CREATE TABLE public.acct_feed_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), window_id uuid NOT NULL REFERENCES public.acct_feed_windows(id), ordinal integer NOT NULL CHECK(ordinal>=0),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 500), state text NOT NULL CHECK(state IN ('posted','pending','nonfinancial')),
 posted bigint NOT NULL CHECK(posted BETWEEN 0 AND 4133980800), transacted_at bigint CHECK(transacted_at BETWEEN 0 AND 4133980800),
 amount_cents bigint NOT NULL CHECK(amount_cents>'-9223372036854775808'::bigint), description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'), raw_payload jsonb NOT NULL CHECK(jsonb_typeof(raw_payload)='object'),
 UNIQUE(window_id,ordinal), UNIQUE(window_id,external_id), CHECK(state<>'posted' OR posted>0 AND amount_cents<>0)
);
CREATE TABLE public.acct_feed_import_links (
 observation_id uuid PRIMARY KEY REFERENCES public.acct_feed_observations(id), group_id uuid NOT NULL REFERENCES public.acct_import_groups(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_feed_gaps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feed_account_id uuid NOT NULL REFERENCES public.acct_feed_accounts(id),
 from_stamp bigint NOT NULL, to_stamp bigint NOT NULL CHECK(to_stamp>from_stamp),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000), created_by uuid REFERENCES auth.users(id),
 document_id uuid REFERENCES public.acct_documents(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(feed_account_id,from_stamp,to_stamp)
);

-- Feed tables deliberately do not increment financial_revision. A network sync
-- cannot change the ledger. Runs retain the authenticated worker/owner identity.
CREATE OR REPLACE FUNCTION public.acct_feed_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.acct_audit_log(table_name,action,actor_id,operation_id,before_value,after_value)
 VALUES(TG_TABLE_NAME,TG_OP,auth.uid(),nullif(current_setting('acct.operation_id',true),''),CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END);
 RETURN coalesce(NEW,OLD);
END $$;
CREATE OR REPLACE FUNCTION public.acct_feed_assert_lease(p_run uuid) RETURNS public.acct_feed_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_feed_runs;c public.acct_feed_connections;
BEGIN
 SELECT * INTO r FROM public.acct_feed_runs WHERE id=p_run;
 SELECT * INTO c FROM public.acct_feed_connections WHERE id=r.connection_id FOR UPDATE;
 IF r.id IS NULL OR r.status<>'running' OR c.status<>'active' OR c.lease_run_id IS DISTINCT FROM r.id OR c.generation<>r.generation OR c.lease_until IS NULL OR c.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'ACCT_FEED_LEASE'; END IF;
 UPDATE public.acct_feed_connections SET lease_until=clock_timestamp()+interval '2 minutes' WHERE id=c.id;
 PERFORM set_config('acct.operation_id',r.id::text,true);
 RETURN r;
END $$;

-- This is the only service-role entry point. It cannot post, alter journals,
-- create a connection, choose account mappings, or enable a schedule.
CREATE OR REPLACE FUNCTION public.acct_feed_server(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type'; c public.acct_feed_connections; r public.acct_feed_runs; a public.acct_feed_identities;
 f public.acct_feed_accounts; q public.acct_feed_requests; w public.acct_feed_windows; claim public.acct_feed_claims;
 actor uuid; v_id uuid; x jsonb; n integer; count_before integer; result jsonb; is_complete boolean;
BEGIN
 IF p_command IS NULL OR octet_length(p_command::text)>4000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM public.acct_write_lock();
 IF op='due' THEN
  RETURN (SELECT coalesce(jsonb_agg(id),'[]') FROM (SELECT id FROM public.acct_feed_connections WHERE status='active' AND scheduled AND coalesce(next_sync_at,'-infinity')<=now() AND coalesce(retry_at,'-infinity')<=now() AND coalesce(lease_until,'-infinity')<=now() ORDER BY next_sync_at NULLS FIRST,id LIMIT 4) s);
 ELSIF op IN ('claim.send','claim.complete','claim.fail') THEN
  SELECT * INTO claim FROM public.acct_feed_claims WHERE id=(p_command->>'id')::uuid;
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=claim.connection_id;
  IF claim.id IS NULL OR c.generation<>claim.generation THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  IF op='claim.complete' AND claim.status='completed' AND c.status='active' AND EXISTS(SELECT 1 FROM public.acct_feed_secrets WHERE connection_id=c.id AND ciphertext=p_command->>'ciphertext') THEN RETURN jsonb_build_object('id',c.id); END IF;
  IF c.status<>'claiming' OR claim.status IS DISTINCT FROM (CASE WHEN op='claim.send' THEN 'started' ELSE 'transmitting' END) THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  PERFORM set_config('acct.operation_id',claim.id::text,true);
  IF op='claim.send' THEN
   UPDATE public.acct_feed_claims SET status='transmitting' WHERE id=claim.id;
  ELSIF op='claim.complete' THEN
   INSERT INTO public.acct_feed_secrets(connection_id,ciphertext) VALUES(c.id,p_command->>'ciphertext') ON CONFLICT(connection_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,changed_at=now();
   UPDATE public.acct_feed_connections SET status='active',last_error='',retry_at=NULL,version=version+1 WHERE id=c.id;
   UPDATE public.acct_feed_claims SET status='completed',completed_at=now() WHERE id=claim.id;
  ELSE
   UPDATE public.acct_feed_connections SET status='reconnect_required',last_error=left(p_command->>'error',1000),version=version+1 WHERE id=c.id;
   UPDATE public.acct_feed_claims SET status='failed',error=left(p_command->>'error',1000),completed_at=now() WHERE id=claim.id;
  END IF;
  RETURN jsonb_build_object('id',c.id);
 ELSIF op='lease' THEN
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=(p_command->>'id')::uuid;
  actor:=nullif(p_command->>'actor_id','')::uuid;
  IF c.id IS NULL OR c.status<>'active' OR actor IS NOT NULL AND actor IS DISTINCT FROM (SELECT owner_user_id FROM public.acct_settings) OR actor IS NULL AND (NOT c.scheduled OR coalesce(c.next_sync_at,'-infinity')>now()) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  IF coalesce(c.retry_at,'-infinity')>now() THEN RAISE EXCEPTION 'ACCT_FEED_BACKOFF'; END IF;
  IF coalesce(c.lease_until,'-infinity')>clock_timestamp() THEN RAISE EXCEPTION 'ACCT_FEED_BUSY'; END IF;
  UPDATE public.acct_feed_runs SET status='expired',finished_at=now(),error='A prior sync stopped before releasing its lease. Its saved observations remain available.' WHERE id=c.lease_run_id AND status='running';
  v_id:=(p_command->>'run_id')::uuid;
  INSERT INTO public.acct_feed_runs(id,connection_id,generation,actor_kind,requested_by) VALUES(v_id,c.id,c.generation,CASE WHEN actor IS NULL THEN 'worker' ELSE 'owner' END,actor);
  PERFORM set_config('acct.operation_id',v_id::text,true);
  UPDATE public.acct_feed_connections SET lease_run_id=v_id,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=c.id;
  RETURN jsonb_build_object('id',v_id,'ciphertext',(SELECT ciphertext FROM public.acct_feed_secrets WHERE connection_id=c.id),'identities',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT i.id,i.provider_connection_id,i.provider_account_id,fa.history_start::text,fa.checkpoint::text,fa.resume_floor::text FROM public.acct_feed_identities i JOIN public.acct_feed_accounts fa ON fa.id=i.feed_account_id WHERE i.connection_id=c.id AND i.ownership='company' AND i.approved_generation=c.generation AND i.observed_generation=c.generation ORDER BY i.last_attempt_at NULLS FIRST,i.id LIMIT 4) s));
 END IF;
 r:=public.acct_feed_assert_lease((p_command->>'run_id')::uuid);
 SELECT * INTO c FROM public.acct_feed_connections WHERE id=r.connection_id;
 IF op='request' THEN
  IF (SELECT count(*) FROM public.acct_feed_requests rq JOIN public.acct_feed_runs sr ON sr.id=rq.run_id WHERE sr.connection_id=c.id AND rq.created_at>now()-interval '24 hours')>=24 THEN RAISE EXCEPTION 'ACCT_FEED_QUOTA'; END IF;
  IF (SELECT count(*) FROM public.acct_feed_requests WHERE run_id=r.id)>=4 THEN RAISE EXCEPTION 'ACCT_FEED_QUOTA'; END IF;
  IF NOT coalesce((p_command->>'discovery')::boolean,false) THEN
   SELECT * INTO a FROM public.acct_feed_identities WHERE id=(p_command->>'identity_id')::uuid AND connection_id=c.id AND ownership='company' AND approved_generation=c.generation AND observed_generation=c.generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
   SELECT * INTO f FROM public.acct_feed_accounts WHERE id=a.feed_account_id;
   IF (p_command->>'from')::bigint IS DISTINCT FROM greatest(f.history_start,coalesce(f.checkpoint,f.history_start)-432000,coalesce(f.resume_floor,f.history_start)) OR (p_command->>'to')::bigint>extract(epoch FROM now())::bigint+1 THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
   UPDATE public.acct_feed_identities SET last_attempt_at=now() WHERE id=a.id;
  ELSIF r.actor_kind<>'owner' THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO public.acct_feed_requests(id,run_id,identity_id,from_stamp,to_stamp,discovery) VALUES((p_command->>'id')::uuid,r.id,a.id,(p_command->>'from')::bigint,(p_command->>'to')::bigint,coalesce((p_command->>'discovery')::boolean,false));
  RETURN jsonb_build_object('id',p_command->>'id');
 ELSIF op='window.begin' THEN
  SELECT * INTO q FROM public.acct_feed_requests WHERE id=(p_command->>'request_id')::uuid AND run_id=r.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  SELECT * INTO a FROM public.acct_feed_identities WHERE connection_id=c.id AND provider_connection_id=p_command->>'provider_connection_id' AND provider_account_id=p_command->>'provider_account_id';
  IF NOT q.discovery AND (a.id IS NULL OR a.id<>q.identity_id OR a.approved_generation<>c.generation OR a.ownership<>'company') THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  IF a.id IS NULL THEN
   INSERT INTO public.acct_feed_identities(connection_id,provider_connection_id,provider_account_id,name,institution,currency,observed_generation) VALUES(c.id,p_command->>'provider_connection_id',p_command->>'provider_account_id',p_command->>'name',p_command->>'institution',p_command->>'currency',c.generation) RETURNING * INTO a;
  ELSE
   UPDATE public.acct_feed_identities SET name=p_command->>'name',institution=p_command->>'institution',currency=p_command->>'currency',observed_generation=c.generation,last_seen_at=now() WHERE id=a.id;
  END IF;
  IF (q.discovery OR p_command->>'currency'<>'USD') AND (p_command->>'expected_count')::integer<>0 THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  INSERT INTO public.acct_feed_windows(id,request_id,identity_id,feed_account_id,protocol,response_hash,account_hash,balance_cents,available_cents,balance_at,issues,complete_response,expected_count)
  VALUES((p_command->>'id')::uuid,q.id,a.id,CASE WHEN NOT q.discovery THEN a.feed_account_id END,p_command->>'protocol',p_command->>'response_hash',p_command->>'account_hash',nullif(p_command->>'balance_cents','')::bigint,nullif(p_command->>'available_cents','')::bigint,(p_command->>'balance_at')::bigint,p_command->'issues',NOT q.discovery AND p_command->>'currency'='USD' AND coalesce((p_command->>'complete')::boolean,false),(p_command->>'expected_count')::integer);
  RETURN jsonb_build_object('id',p_command->>'id');
 ELSIF op IN ('window.append','window.finish') THEN
  SELECT w0.* INTO w FROM public.acct_feed_windows w0 JOIN public.acct_feed_requests q0 ON q0.id=w0.request_id WHERE w0.id=(p_command->>'id')::uuid AND q0.run_id=r.id;
  IF NOT FOUND OR w.status<>'receiving' THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
  SELECT * INTO q FROM public.acct_feed_requests WHERE id=w.request_id;
  IF op='window.append' THEN
   IF jsonb_typeof(p_command->'transactions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'transactions') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
   count_before:=w.received_count;
   IF (p_command->>'offset')::integer IS DISTINCT FROM count_before THEN RAISE EXCEPTION 'ACCT_IMPORT_CHECKPOINT'; END IF;
   FOR x IN SELECT value FROM jsonb_array_elements(p_command->'transactions') LOOP
    IF x->>'state'='posted' AND ((x->>'posted')::bigint<q.from_stamp OR (x->>'posted')::bigint>=q.to_stamp) THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
    INSERT INTO public.acct_feed_observations(window_id,ordinal,external_id,state,posted,transacted_at,amount_cents,description,content_hash,raw_payload)
    VALUES(w.id,count_before,x->>'external_id',x->>'state',(x->>'posted')::bigint,nullif(x->>'transacted_at','')::bigint,(x->>'amount_cents')::bigint,x->>'description',x->>'hash',x->'raw');count_before:=count_before+1;
   END LOOP;
   UPDATE public.acct_feed_windows SET received_count=count_before WHERE id=w.id;
  ELSE
   IF w.received_count<>w.expected_count THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
   IF EXISTS(SELECT 1 FROM public.acct_feed_observations current_o JOIN public.acct_feed_observations old_o ON old_o.external_id=current_o.external_id JOIN public.acct_feed_windows old_w ON old_w.id=old_o.window_id WHERE current_o.window_id=w.id AND old_w.feed_account_id=w.feed_account_id AND old_w.created_at<w.created_at AND old_o.state='posted' AND current_o.state<>'posted') THEN
    w.complete_response:=false;
    UPDATE public.acct_feed_windows SET complete_response=false,issues=issues||jsonb_build_array(jsonb_build_object('code','source_regression','message','A previously posted bank movement is now pending or nonfinancial. Its earlier accounting treatment requires review.')) WHERE id=w.id;
   END IF;
   UPDATE public.acct_feed_windows SET status=CASE WHEN complete_response THEN 'accepted' ELSE 'incomplete' END WHERE id=w.id;
   -- Exact repeat observations inherit the existing reviewed source-group link.
   -- No source/ledger rows are inserted or changed by the worker.
   INSERT INTO public.acct_feed_import_links(observation_id,group_id)
   SELECT current_o.id,matched.group_id FROM public.acct_feed_observations current_o CROSS JOIN LATERAL (
    SELECT fl.group_id FROM public.acct_feed_observations old_o JOIN public.acct_feed_windows old_w ON old_w.id=old_o.window_id JOIN public.acct_feed_import_links fl ON fl.observation_id=old_o.id
    WHERE old_w.feed_account_id=w.feed_account_id AND old_o.external_id=current_o.external_id AND old_o.content_hash=current_o.content_hash AND old_o.posted=current_o.posted AND old_o.amount_cents=current_o.amount_cents AND old_o.state=current_o.state ORDER BY old_w.created_at LIMIT 1
   ) matched WHERE current_o.window_id=w.id ON CONFLICT DO NOTHING;
   IF w.complete_response AND w.feed_account_id IS NOT NULL THEN
    UPDATE public.acct_feed_accounts SET checkpoint=greatest(coalesce(checkpoint,history_start),q.to_stamp) WHERE id=w.feed_account_id;
    IF q.to_stamp<extract(epoch FROM now()-interval '5 days')::bigint AND NOT EXISTS(SELECT 1 FROM public.acct_feed_observations WHERE window_id=w.id AND state='posted') THEN
     INSERT INTO public.acct_feed_gaps(feed_account_id,from_stamp,to_stamp,reason) VALUES(w.feed_account_id,q.from_stamp,q.to_stamp,'The provider returned no posted history for this older window. Confirm coverage with original statements or a historical CSV import.') ON CONFLICT DO NOTHING;
    END IF;
   END IF;
  END IF;
  RETURN jsonb_build_object('id',w.id);
 ELSIF op='finish' THEN
  is_complete:=coalesce((p_command->>'complete')::boolean,false) AND NOT EXISTS(SELECT 1 FROM public.acct_feed_windows w0 JOIN public.acct_feed_requests q0 ON q0.id=w0.request_id WHERE q0.run_id=r.id AND NOT q0.discovery AND w0.status<>'accepted');
  IF EXISTS(SELECT 1 FROM public.acct_feed_requests q0 WHERE q0.run_id=r.id AND NOT q0.discovery AND NOT EXISTS(SELECT 1 FROM public.acct_feed_windows w0 WHERE w0.request_id=q0.id AND w0.identity_id=q0.identity_id AND w0.status='accepted')) THEN is_complete:=false; END IF;
  UPDATE public.acct_feed_runs SET status=CASE WHEN is_complete THEN 'completed' ELSE 'partial' END,finished_at=now(),error=left(coalesce(p_command->>'error',''),1000) WHERE id=r.id;
  UPDATE public.acct_feed_connections SET lease_until=NULL,lease_run_id=NULL,next_sync_at=now()+interval '24 hours'+make_interval(secs=>floor(random()*3600)::integer),last_success_at=CASE WHEN is_complete THEN now() ELSE last_success_at END,last_error=left(coalesce(p_command->>'error',''),1000) WHERE id=c.id;
  RETURN jsonb_build_object('id',r.id,'complete',is_complete);
 ELSIF op='fail' THEN
  UPDATE public.acct_feed_runs SET status='failed',finished_at=now(),error=left(p_command->>'error',1000) WHERE id=r.id;
  UPDATE public.acct_feed_connections SET lease_until=NULL,lease_run_id=NULL,last_error=left(p_command->>'error',1000),retry_at=now()+make_interval(secs=>greatest(60,least(coalesce((p_command->>'retry_seconds')::integer,3600),86400))),status=CASE WHEN p_command->>'code'='access_revoked' THEN 'reconnect_required' ELSE status END WHERE id=c.id;
  RETURN jsonb_build_object('id',r.id);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $$;

CREATE OR REPLACE FUNCTION public.acct_feed_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';c public.acct_feed_connections;a public.acct_feed_identities;f public.acct_feed_accounts;
 v_id uuid:=(p_command->>'id')::uuid;v_feed uuid;v_start bigint;v_checkpoint bigint;v_groups jsonb;v_batch uuid;result jsonb;x record;g record;v_offset integer:=0;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF op='feed.claim' THEN
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=v_id;
  IF FOUND THEN
   IF c.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   UPDATE public.acct_feed_runs SET status='expired',finished_at=now(),error='Connection replaced by its owner.' WHERE id=c.lease_run_id AND status='running';
   UPDATE public.acct_feed_connections SET status='claiming',generation=generation+1,version=version+1,name=p_command->>'name',scheduled=false,lease_run_id=NULL,lease_until=NULL,last_error='' WHERE id=v_id RETURNING * INTO c;
   DELETE FROM public.acct_feed_secrets WHERE connection_id=v_id;
  ELSE
   IF (p_command->>'expected_version')::integer IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   INSERT INTO public.acct_feed_connections(id,name,created_by) VALUES(v_id,p_command->>'name',p_actor) RETURNING * INTO c;
  END IF;
  INSERT INTO public.acct_feed_claims(id,connection_id,generation,created_by) VALUES((p_command->>'claim_id')::uuid,c.id,c.generation,p_actor);
  RETURN jsonb_build_object('id',c.id,'claim_id',p_command->>'claim_id','version',c.version);
 ELSIF op IN ('feed.disconnect','feed.schedule') THEN
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='feed.disconnect' THEN
   IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   UPDATE public.acct_feed_runs SET status='expired',finished_at=now(),error='Disconnected by its owner.' WHERE id=c.lease_run_id AND status='running';
   UPDATE public.acct_feed_connections SET status='disconnected',scheduled=false,generation=generation+1,version=version+1,lease_run_id=NULL,lease_until=NULL WHERE id=v_id;
   DELETE FROM public.acct_feed_secrets WHERE connection_id=v_id;
  ELSE
   IF c.status<>'active' OR coalesce((p_command->>'enabled')::boolean,false) AND NOT EXISTS(SELECT 1 FROM public.acct_feed_identities WHERE connection_id=c.id AND ownership='company' AND approved_generation=c.generation) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
   UPDATE public.acct_feed_connections SET scheduled=(p_command->>'enabled')::boolean,next_sync_at=coalesce(next_sync_at,now()+make_interval(secs=>floor(random()*3600)::integer)),version=version+1 WHERE id=v_id;
  END IF;
  RETURN jsonb_build_object('id',v_id,'version',c.version+1);
 ELSIF op='feed.map' THEN
  SELECT * INTO a FROM public.acct_feed_identities WHERE id=v_id;
  SELECT * INTO c FROM public.acct_feed_connections WHERE id=a.connection_id;
  IF a.id IS NULL OR c.status<>'active' OR a.observed_generation<>c.generation THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  IF a.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF coalesce(c.lease_until,'-infinity')>now() THEN RAISE EXCEPTION 'ACCT_FEED_BUSY'; END IF;
  IF coalesce((p_command->>'reviewed')::boolean,false) IS NOT TRUE OR length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF p_command->>'ownership'='company' THEN
   IF a.currency<>'USD' OR NOT EXISTS(SELECT 1 FROM public.acct_accounts aa JOIN public.acct_account_profiles ap ON ap.account_id=aa.id WHERE aa.id=(p_command->>'account_id')::uuid AND NOT aa.is_archived AND ap.cash_kind IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
   SELECT * INTO f FROM public.acct_feed_accounts WHERE account_id=(p_command->>'account_id')::uuid;
   v_start:=(p_command->>'history_start')::bigint;
   IF v_start>extract(epoch FROM now())::bigint THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
   IF f.id IS NULL THEN
    INSERT INTO public.acct_feed_accounts(account_id,history_start,posting_timezone,movement_sign,balance_sign,created_by) VALUES((p_command->>'account_id')::uuid,v_start,p_command->>'posting_timezone',(p_command->>'movement_sign')::integer,(p_command->>'balance_sign')::integer,p_actor) RETURNING * INTO f;
   ELSE
    IF f.history_start<>v_start OR f.posting_timezone<>p_command->>'posting_timezone' OR f.movement_sign<>(p_command->>'movement_sign')::integer OR f.balance_sign<>(p_command->>'balance_sign')::integer THEN
     IF EXISTS(SELECT 1 FROM public.acct_feed_windows WHERE feed_account_id=f.id) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_IMMUTABLE'; END IF;
     IF f.version IS DISTINCT FROM (p_command->>'expected_feed_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
     UPDATE public.acct_feed_accounts SET history_start=v_start,posting_timezone=p_command->>'posting_timezone',movement_sign=(p_command->>'movement_sign')::integer,balance_sign=(p_command->>'balance_sign')::integer,checkpoint=NULL,resume_floor=NULL,version=version+1 WHERE id=f.id RETURNING * INTO f;
    END IF;
   END IF;
   IF a.feed_account_id IS NOT NULL AND a.feed_account_id<>f.id AND EXISTS(SELECT 1 FROM public.acct_feed_windows WHERE identity_id=a.id AND feed_account_id IS NOT NULL) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_IMMUTABLE'; END IF;
   IF EXISTS(SELECT 1 FROM public.acct_feed_identities i JOIN public.acct_feed_connections ic ON ic.id=i.connection_id WHERE i.id<>a.id AND i.feed_account_id=f.id AND ic.status='active' AND i.approved_generation=ic.generation) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_DUPLICATE'; END IF;
   v_feed:=f.id;
  ELSIF p_command->>'ownership' NOT IN ('personal','ignored') THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING'; END IF;
  UPDATE public.acct_feed_identities SET feed_account_id=v_feed,ownership=p_command->>'ownership',approved_generation=c.generation,version=version+1 WHERE id=a.id;
  RETURN jsonb_build_object('id',a.id,'version',a.version+1);
 ELSIF op='feed.skip' THEN
  SELECT * INTO f FROM public.acct_feed_accounts WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF f.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_feed_identities i JOIN public.acct_feed_connections c0 ON c0.id=i.connection_id WHERE i.feed_account_id=f.id AND coalesce(c0.lease_until,'-infinity')>now()) THEN RAISE EXCEPTION 'ACCT_FEED_BUSY'; END IF;
  v_checkpoint:=coalesce(f.checkpoint,f.history_start);v_start:=(p_command->>'through')::bigint;
  IF v_start<=v_checkpoint OR v_start>extract(epoch FROM now())::bigint OR length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_FEED_WINDOW'; END IF;
  INSERT INTO public.acct_feed_gaps(feed_account_id,from_stamp,to_stamp,reason,created_by) VALUES(f.id,v_checkpoint,v_start,p_command->>'reason',p_actor);
  UPDATE public.acct_feed_accounts SET checkpoint=v_start,resume_floor=v_start,version=version+1 WHERE id=f.id;
  RETURN jsonb_build_object('id',f.id,'version',f.version+1);
 ELSIF op='feed.prepare' THEN
  SELECT * INTO f FROM public.acct_feed_accounts WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  -- Latest observation per canonical provider identity; pending never becomes a
  -- financial draft. Older versions stay available as immutable source evidence.
  SELECT jsonb_agg(jsonb_build_object('observation_id',o.id,'external_id',o.external_id,'source_hash',o.content_hash,'entry_date',(to_timestamp(o.posted) AT TIME ZONE f.posting_timezone)::date,'memo',o.description,'bank_account_id',f.account_id,'bank_amount_cents',(o.amount_cents*f.movement_sign)::text,'identity_kind','provider_id','lines','[]'::jsonb,'raw',o.raw_payload,'fingerprint',encode(sha256(convert_to(jsonb_build_array(f.account_id,(to_timestamp(o.posted) AT TIME ZONE f.posting_timezone)::date,(o.amount_cents*f.movement_sign)::text)::text,'UTF8')),'hex'))) INTO v_groups
  FROM (SELECT latest.* FROM (SELECT DISTINCT ON (o0.external_id) o0.* FROM public.acct_feed_observations o0 JOIN public.acct_feed_windows w0 ON w0.id=o0.window_id WHERE w0.feed_account_id=f.id AND w0.status IN ('accepted','incomplete') ORDER BY o0.external_id,w0.created_at DESC,w0.id DESC) latest WHERE latest.state='posted' AND NOT EXISTS(SELECT 1 FROM public.acct_feed_import_links fl WHERE fl.observation_id=latest.id) ORDER BY latest.posted,latest.external_id LIMIT 50) o;
  IF v_groups IS NULL THEN RETURN jsonb_build_object('count',0); END IF;
  v_batch:=gen_random_uuid();
  result:=public.acct_import_command(jsonb_build_object('type','import.create','id',v_batch,'source_system','simplefin','source_scope',f.id::text,'file_hash',encode(sha256(convert_to(v_groups::text,'UTF8')),'hex'),'mapping_hash',encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex'),'file_name','SimpleFIN: '||(SELECT name FROM public.acct_accounts WHERE id=f.account_id),'mode','bank','basis','cash','expected_groups',jsonb_array_length(v_groups),'from',(SELECT min(value->>'entry_date') FROM jsonb_array_elements(v_groups)),'to',(SELECT max(value->>'entry_date') FROM jsonb_array_elements(v_groups))),p_actor);
  v_batch:=(result->>'id')::uuid;
  SELECT jsonb_agg(value||jsonb_build_object('id',gen_random_uuid(),'ordinal',ordinality-1) ORDER BY ordinality) INTO v_groups FROM jsonb_array_elements(v_groups) WITH ORDINALITY;
  result:=public.acct_import_command(jsonb_build_object('type','import.stage','id',v_batch,'expected_version',result->'version','groups',v_groups),p_actor);
  INSERT INTO public.acct_feed_import_links(observation_id,group_id) SELECT (value->>'observation_id')::uuid,(value->>'id')::uuid FROM jsonb_array_elements(v_groups);
  RETURN result||jsonb_build_object('count',jsonb_array_length(v_groups));
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $$;

CREATE OR REPLACE FUNCTION public.acct_feed_gap_covered(p_gap uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(daterange((to_timestamp(g.from_stamp) AT TIME ZONE f.posting_timezone)::date,(to_timestamp(g.to_stamp-1) AT TIME ZONE f.posting_timezone)::date,'[]') <@ (
 SELECT range_agg(daterange(s.from_date,s.to_date,'[]')) FROM (
  SELECT r.from_date,r.to_date FROM public.acct_reconciliations r WHERE r.account_id=f.account_id AND r.status='completed'
  UNION ALL SELECT h.from_date,h.to_date FROM public.acct_history_checks h WHERE public.acct_history_check_current(h.id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.account_controls) ac WHERE ac->>'account_id'=f.account_id::text)
 ) s),false) FROM public.acct_feed_gaps g JOIN public.acct_feed_accounts f ON f.id=g.feed_account_id WHERE g.id=p_gap;
$$;
REVOKE ALL ON FUNCTION public.acct_feed_gap_covered(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.acct_feed_view() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('owner_id',auth.uid(),'connections',(SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('requests_today',(SELECT count(*) FROM public.acct_feed_requests q JOIN public.acct_feed_runs r ON r.id=q.run_id WHERE r.connection_id=c.id AND q.created_at>now()-interval '24 hours')) ORDER BY c.created_at),'[]') FROM public.acct_feed_connections c),
 'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(fa)||jsonb_build_object('history_start',fa.history_start::text,'checkpoint',fa.checkpoint::text,'can_edit_settings',NOT EXISTS(SELECT 1 FROM public.acct_feed_windows fw WHERE fw.feed_account_id=fa.id))),'[]') FROM public.acct_feed_accounts fa),
 'identities',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('account',CASE WHEN f.id IS NOT NULL THEN to_jsonb(f)||jsonb_build_object('history_start',f.history_start::text,'checkpoint',f.checkpoint::text,'can_edit_settings',NOT EXISTS(SELECT 1 FROM public.acct_feed_windows fw WHERE fw.feed_account_id=f.id)) END,'balance',(SELECT to_jsonb(w)||jsonb_build_object('balance_cents',w.balance_cents::text,'available_cents',w.available_cents::text) FROM public.acct_feed_windows w WHERE w.identity_id=a.id ORDER BY w.created_at DESC,w.id DESC LIMIT 1)) ORDER BY a.institution,a.name),'[]') FROM public.acct_feed_identities a LEFT JOIN public.acct_feed_accounts f ON f.id=a.feed_account_id),
 'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.started_at DESC),'[]') FROM (SELECT * FROM public.acct_feed_runs ORDER BY started_at DESC LIMIT 40) r),
 'gaps',(SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('from_stamp',g.from_stamp::text,'to_stamp',g.to_stamp::text,'covered',public.acct_feed_gap_covered(g.id)) ORDER BY g.created_at DESC),'[]') FROM public.acct_feed_gaps g),
 'queue',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT latest.feed_account_id,count(*) FILTER(WHERE latest.state='posted' AND fl.observation_id IS NULL) ready,count(*) FILTER(WHERE latest.state='pending') pending FROM (SELECT DISTINCT ON (w.feed_account_id,o.external_id) w.feed_account_id,o.id,o.state FROM public.acct_feed_observations o JOIN public.acct_feed_windows w ON w.id=o.window_id WHERE w.feed_account_id IS NOT NULL AND w.status IN ('accepted','incomplete') ORDER BY w.feed_account_id,o.external_id,w.created_at DESC,w.id DESC) latest LEFT JOIN public.acct_feed_import_links fl ON fl.observation_id=latest.id GROUP BY latest.feed_account_id) s));
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['acct_feed_connections','acct_feed_secrets','acct_feed_claims','acct_feed_accounts','acct_feed_identities','acct_feed_runs','acct_feed_requests','acct_feed_windows','acct_feed_observations','acct_feed_import_links','acct_feed_gaps'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  IF t NOT IN ('acct_feed_secrets','acct_feed_observations') THEN EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_feed_audit()',t); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['acct_feed_requests','acct_feed_observations','acct_feed_import_links','acct_feed_gaps'] LOOP
  EXECUTE format('CREATE TRIGGER acct_feed_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.acct_feed_audit(),public.acct_feed_assert_lease(uuid),public.acct_feed_server(jsonb),public.acct_feed_command(jsonb,uuid),public.acct_feed_view() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_feed_server(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.acct_feed_view() TO authenticated;





CREATE OR REPLACE FUNCTION public.acct_feed_unreviewed(p_through date) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT count(*)::integer FROM (
  SELECT DISTINCT ON (w.feed_account_id,o.external_id) o.id,o.state,o.posted,f.posting_timezone
  FROM public.acct_feed_observations o JOIN public.acct_feed_windows w ON w.id=o.window_id JOIN public.acct_feed_accounts f ON f.id=w.feed_account_id
  WHERE w.status IN ('accepted','incomplete') ORDER BY w.feed_account_id,o.external_id,w.created_at DESC,w.id DESC
 ) latest WHERE latest.state='posted' AND (to_timestamp(latest.posted) AT TIME ZONE latest.posting_timezone)::date<=p_through AND NOT EXISTS(SELECT 1 FROM public.acct_feed_import_links fl WHERE fl.observation_id=latest.id);
$$;
REVOKE ALL ON FUNCTION public.acct_feed_unreviewed(date) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.acct_feed_window_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'receiving' THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','received_count','complete_response','issues']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','received_count','complete_response','issues']) OR NEW.received_count<OLD.received_count OR NOT OLD.complete_response AND NEW.complete_response THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.acct_feed_window_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_feed_window_immutable BEFORE UPDATE OR DELETE ON public.acct_feed_windows FOR EACH ROW EXECUTE FUNCTION public.acct_feed_window_guard();
-- ACCOUNTING SIMPLEFIN END
