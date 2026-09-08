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

-- ACCOUNTING CATALOG BEGIN

-- Generated by scripts/regenerate-accounting-schema.ts from the applied fresh catalog.

CREATE SCHEMA accounting;

REVOKE ALL ON SCHEMA accounting FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA accounting TO authenticated, service_role;

SET check_function_bodies = false;

CREATE TABLE accounting.accounts (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "code" text,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "subtype" text DEFAULT 'other'::text NOT NULL,
  "is_contra" boolean DEFAULT false NOT NULL,
  "parent_id" uuid,
  "system_purpose" text,
  "external_names" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "is_archived" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accounts_check" CHECK (((parent_id IS NULL) OR (parent_id <> id))),
  CONSTRAINT "accounts_code_check" CHECK (((code IS NULL) OR ((length(code) >= 1) AND (length(code) <= 20)))),
  CONSTRAINT "accounts_code_key" UNIQUE (code),
  CONSTRAINT "accounts_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "accounts_external_names_check" CHECK ((jsonb_typeof(external_names) = 'object'::text)),
  CONSTRAINT "accounts_external_names_not_null" NOT NULL external_names,
  CONSTRAINT "accounts_id_not_null" NOT NULL id,
  CONSTRAINT "accounts_is_archived_not_null" NOT NULL is_archived,
  CONSTRAINT "accounts_is_contra_not_null" NOT NULL is_contra,
  CONSTRAINT "accounts_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT "accounts_name_not_null" NOT NULL name,
  CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "accounts_pkey" PRIMARY KEY (id),
  CONSTRAINT "accounts_subtype_check" CHECK (((length(subtype) >= 1) AND (length(subtype) <= 100))),
  CONSTRAINT "accounts_subtype_not_null" NOT NULL subtype,
  CONSTRAINT "accounts_system_purpose_key" UNIQUE (system_purpose),
  CONSTRAINT "accounts_type_check" CHECK ((type = ANY (ARRAY['asset'::text, 'liability'::text, 'equity'::text, 'income'::text, 'expense'::text]))),
  CONSTRAINT "accounts_type_not_null" NOT NULL type,
  CONSTRAINT "accounts_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "accounts_version_check" CHECK ((version > 0)),
  CONSTRAINT "accounts_version_not_null" NOT NULL version
);

ALTER TABLE accounting.accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.audit_log (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_user_id" uuid,
  "actor_kind" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "table_name" text NOT NULL,
  "row_id" uuid NOT NULL,
  "action" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "reason" text DEFAULT ''::text NOT NULL,
  CONSTRAINT "audit_log_action_not_null" NOT NULL action,
  CONSTRAINT "audit_log_actor_kind_check" CHECK ((actor_kind = ANY (ARRAY['owner'::text, 'worker'::text, 'system'::text]))),
  CONSTRAINT "audit_log_actor_kind_not_null" NOT NULL actor_kind,
  CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "audit_log_at_not_null" NOT NULL at,
  CONSTRAINT "audit_log_id_not_null" NOT NULL id,
  CONSTRAINT "audit_log_operation_id_not_null" NOT NULL operation_id,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY (id),
  CONSTRAINT "audit_log_reason_not_null" NOT NULL reason,
  CONSTRAINT "audit_log_row_id_not_null" NOT NULL row_id,
  CONSTRAINT "audit_log_table_name_not_null" NOT NULL table_name
);

ALTER TABLE accounting.audit_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.bank_connections (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "provider" text DEFAULT 'simplefin'::text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "access_url_encrypted" text NOT NULL,
  "key_version" smallint DEFAULT 1 NOT NULL,
  "scheduled" boolean DEFAULT true NOT NULL,
  "next_sync_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_error" text DEFAULT ''::text NOT NULL,
  "lease_run_id" uuid,
  "lease_until" timestamp with time zone,
  "checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bank_connections_access_url_encrypted_not_null" NOT NULL access_url_encrypted,
  CONSTRAINT "bank_connections_check" CHECK (((lease_run_id IS NULL) = (lease_until IS NULL))),
  CONSTRAINT "bank_connections_checkpoint_check" CHECK ((jsonb_typeof(checkpoint) = 'object'::text)),
  CONSTRAINT "bank_connections_checkpoint_not_null" NOT NULL checkpoint,
  CONSTRAINT "bank_connections_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "bank_connections_id_not_null" NOT NULL id,
  CONSTRAINT "bank_connections_key_version_check" CHECK ((key_version > 0)),
  CONSTRAINT "bank_connections_key_version_not_null" NOT NULL key_version,
  CONSTRAINT "bank_connections_last_error_not_null" NOT NULL last_error,
  CONSTRAINT "bank_connections_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT "bank_connections_name_not_null" NOT NULL name,
  CONSTRAINT "bank_connections_pkey" PRIMARY KEY (id),
  CONSTRAINT "bank_connections_provider_check" CHECK ((provider = 'simplefin'::text)),
  CONSTRAINT "bank_connections_provider_not_null" NOT NULL provider,
  CONSTRAINT "bank_connections_scheduled_not_null" NOT NULL scheduled,
  CONSTRAINT "bank_connections_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'reconnect_required'::text, 'disconnected'::text]))),
  CONSTRAINT "bank_connections_status_not_null" NOT NULL status,
  CONSTRAINT "bank_connections_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "bank_connections_version_check" CHECK ((version > 0)),
  CONSTRAINT "bank_connections_version_not_null" NOT NULL version
);

ALTER TABLE accounting.bank_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.bank_accounts (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "connection_id" uuid,
  "provider_account_id" text,
  "institution" text DEFAULT ''::text NOT NULL,
  "mask" text DEFAULT ''::text NOT NULL,
  "movement_sign" smallint DEFAULT 1 NOT NULL,
  "coverage_from" date,
  "observed_balance_cents" bigint,
  "observed_at" timestamp with time zone,
  "is_closed" boolean DEFAULT false NOT NULL,
  "closed_on" date,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bank_accounts_account_id_fkey" FOREIGN KEY (account_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "bank_accounts_account_id_key" UNIQUE (account_id),
  CONSTRAINT "bank_accounts_account_id_not_null" NOT NULL account_id,
  CONSTRAINT "bank_accounts_check" CHECK (((NOT is_closed) OR (closed_on IS NOT NULL))),
  CONSTRAINT "bank_accounts_connection_id_fkey" FOREIGN KEY (connection_id) REFERENCES accounting.bank_connections(id) ON DELETE RESTRICT,
  CONSTRAINT "bank_accounts_connection_id_provider_account_id_key" UNIQUE (connection_id, provider_account_id),
  CONSTRAINT "bank_accounts_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "bank_accounts_id_not_null" NOT NULL id,
  CONSTRAINT "bank_accounts_institution_not_null" NOT NULL institution,
  CONSTRAINT "bank_accounts_is_closed_not_null" NOT NULL is_closed,
  CONSTRAINT "bank_accounts_mask_not_null" NOT NULL mask,
  CONSTRAINT "bank_accounts_movement_sign_check" CHECK ((movement_sign = ANY (ARRAY['-1'::integer, 1]))),
  CONSTRAINT "bank_accounts_movement_sign_not_null" NOT NULL movement_sign,
  CONSTRAINT "bank_accounts_pkey" PRIMARY KEY (id),
  CONSTRAINT "bank_accounts_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "bank_accounts_version_check" CHECK ((version > 0)),
  CONSTRAINT "bank_accounts_version_not_null" NOT NULL version
);

ALTER TABLE accounting.bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.command_receipts (
  "idempotency_key" uuid NOT NULL,
  "payload_hash" text NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "command_receipts_actor_user_id_fkey" FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "command_receipts_actor_user_id_not_null" NOT NULL actor_user_id,
  CONSTRAINT "command_receipts_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "command_receipts_idempotency_key_not_null" NOT NULL idempotency_key,
  CONSTRAINT "command_receipts_payload_hash_not_null" NOT NULL payload_hash,
  CONSTRAINT "command_receipts_pkey" PRIMARY KEY (idempotency_key),
  CONSTRAINT "command_receipts_result_not_null" NOT NULL result
);

ALTER TABLE accounting.command_receipts ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.documents (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "storage_path" text NOT NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "kind" text DEFAULT 'receipt'::text NOT NULL,
  "status" text DEFAULT 'inbox'::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "uploaded_by" uuid,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "documents_id_not_null" NOT NULL id,
  CONSTRAINT "documents_kind_check" CHECK ((kind = ANY (ARRAY['receipt'::text, 'statement'::text, 'payroll_register'::text, 'source_export'::text, 'report'::text, 'other'::text]))),
  CONSTRAINT "documents_kind_not_null" NOT NULL kind,
  CONSTRAINT "documents_mime_not_null" NOT NULL mime,
  CONSTRAINT "documents_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 240))),
  CONSTRAINT "documents_name_not_null" NOT NULL name,
  CONSTRAINT "documents_pkey" PRIMARY KEY (id),
  CONSTRAINT "documents_sha256_check" CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT "documents_sha256_not_null" NOT NULL sha256,
  CONSTRAINT "documents_size_bytes_check" CHECK (((size_bytes >= 1) AND (size_bytes <= 26214400))),
  CONSTRAINT "documents_size_bytes_not_null" NOT NULL size_bytes,
  CONSTRAINT "documents_status_check" CHECK ((status = ANY (ARRAY['inbox'::text, 'linked'::text, 'archived'::text]))),
  CONSTRAINT "documents_status_not_null" NOT NULL status,
  CONSTRAINT "documents_storage_path_key" UNIQUE (storage_path),
  CONSTRAINT "documents_storage_path_not_null" NOT NULL storage_path,
  CONSTRAINT "documents_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "documents_uploaded_at_not_null" NOT NULL uploaded_at,
  CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "documents_version_check" CHECK ((version > 0)),
  CONSTRAINT "documents_version_not_null" NOT NULL version
);

ALTER TABLE accounting.documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.history_checks (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "fiscal_year" smallint NOT NULL,
  "kind" text NOT NULL,
  "expected" jsonb NOT NULL,
  "actual" jsonb NOT NULL,
  "difference" jsonb NOT NULL,
  "status" text NOT NULL,
  "explanation" text DEFAULT ''::text NOT NULL,
  "document_id" uuid NOT NULL,
  "checked_by" uuid NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "history_checks_actual_not_null" NOT NULL actual,
  CONSTRAINT "history_checks_check" CHECK (((status <> 'explained'::text) OR (length(btrim(explanation)) > 0))),
  CONSTRAINT "history_checks_checked_at_not_null" NOT NULL checked_at,
  CONSTRAINT "history_checks_checked_by_fkey" FOREIGN KEY (checked_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "history_checks_checked_by_not_null" NOT NULL checked_by,
  CONSTRAINT "history_checks_difference_not_null" NOT NULL difference,
  CONSTRAINT "history_checks_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "history_checks_document_id_not_null" NOT NULL document_id,
  CONSTRAINT "history_checks_expected_not_null" NOT NULL expected,
  CONSTRAINT "history_checks_explanation_not_null" NOT NULL explanation,
  CONSTRAINT "history_checks_fiscal_year_check" CHECK (((fiscal_year >= 1900) AND (fiscal_year <= 2200))),
  CONSTRAINT "history_checks_fiscal_year_not_null" NOT NULL fiscal_year,
  CONSTRAINT "history_checks_id_not_null" NOT NULL id,
  CONSTRAINT "history_checks_kind_check" CHECK ((kind = ANY (ARRAY['annual_totals'::text, 'opening_balances'::text]))),
  CONSTRAINT "history_checks_kind_not_null" NOT NULL kind,
  CONSTRAINT "history_checks_pkey" PRIMARY KEY (id),
  CONSTRAINT "history_checks_status_check" CHECK ((status = ANY (ARRAY['matches'::text, 'explained'::text, 'mismatch'::text]))),
  CONSTRAINT "history_checks_status_not_null" NOT NULL status
);

ALTER TABLE accounting.history_checks ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.import_batches (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "source" text NOT NULL,
  "document_id" uuid,
  "file_hash" text,
  "mapping" jsonb NOT NULL,
  "status" text DEFAULT 'staged'::text NOT NULL,
  "row_count" integer NOT NULL,
  "applied_count" integer DEFAULT 0 NOT NULL,
  "checkpoint" integer DEFAULT 0 NOT NULL,
  "control_totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "coverage_from" date NOT NULL,
  "coverage_to" date NOT NULL,
  "parity_status" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_batches_applied_count_check" CHECK ((applied_count >= 0)),
  CONSTRAINT "import_batches_applied_count_not_null" NOT NULL applied_count,
  CONSTRAINT "import_batches_check" CHECK ((coverage_to >= coverage_from)),
  CONSTRAINT "import_batches_check1" CHECK ((((kind = 'bank'::text) AND (parity_status = 'n/a'::text)) OR ((kind = 'journal'::text) AND (parity_status <> 'n/a'::text)))),
  CONSTRAINT "import_batches_check2" CHECK ((applied_count <= row_count)),
  CONSTRAINT "import_batches_checkpoint_check" CHECK ((checkpoint >= 0)),
  CONSTRAINT "import_batches_checkpoint_not_null" NOT NULL checkpoint,
  CONSTRAINT "import_batches_control_totals_check" CHECK ((jsonb_typeof(control_totals) = 'object'::text)),
  CONSTRAINT "import_batches_control_totals_not_null" NOT NULL control_totals,
  CONSTRAINT "import_batches_coverage_from_not_null" NOT NULL coverage_from,
  CONSTRAINT "import_batches_coverage_to_not_null" NOT NULL coverage_to,
  CONSTRAINT "import_batches_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "import_batches_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "import_batches_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "import_batches_file_hash_check" CHECK ((file_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT "import_batches_file_hash_key" UNIQUE (file_hash),
  CONSTRAINT "import_batches_id_not_null" NOT NULL id,
  CONSTRAINT "import_batches_kind_check" CHECK ((kind = ANY (ARRAY['journal'::text, 'bank'::text]))),
  CONSTRAINT "import_batches_kind_not_null" NOT NULL kind,
  CONSTRAINT "import_batches_mapping_check" CHECK ((jsonb_typeof(mapping) = 'object'::text)),
  CONSTRAINT "import_batches_mapping_not_null" NOT NULL mapping,
  CONSTRAINT "import_batches_parity_status_check" CHECK ((parity_status = ANY (ARRAY['n/a'::text, 'pending'::text, 'verified'::text, 'mismatch'::text]))),
  CONSTRAINT "import_batches_parity_status_not_null" NOT NULL parity_status,
  CONSTRAINT "import_batches_pkey" PRIMARY KEY (id),
  CONSTRAINT "import_batches_row_count_check" CHECK (((row_count >= 0) AND (row_count <= 50000))),
  CONSTRAINT "import_batches_row_count_not_null" NOT NULL row_count,
  CONSTRAINT "import_batches_source_check" CHECK ((source = ANY (ARRAY['wave'::text, 'csv'::text, 'simplefin'::text]))),
  CONSTRAINT "import_batches_source_not_null" NOT NULL source,
  CONSTRAINT "import_batches_status_check" CHECK ((status = ANY (ARRAY['staged'::text, 'applying'::text, 'completed'::text, 'cancelled'::text]))),
  CONSTRAINT "import_batches_status_not_null" NOT NULL status,
  CONSTRAINT "import_batches_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "import_batches_version_check" CHECK ((version > 0)),
  CONSTRAINT "import_batches_version_not_null" NOT NULL version
);

ALTER TABLE accounting.import_batches ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.bank_transactions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "source" text NOT NULL,
  "external_id" text NOT NULL,
  "posted_date" date NOT NULL,
  "transacted_at" timestamp with time zone,
  "amount_cents" bigint NOT NULL,
  "description" text NOT NULL,
  "descriptor_key" text NOT NULL,
  "content_hash" text NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "state" text NOT NULL,
  "review" text DEFAULT 'unmatched'::text NOT NULL,
  "excluded_reason" text DEFAULT ''::text NOT NULL,
  "import_batch_id" uuid,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bank_transactions_amount_cents_check" CHECK ((amount_cents > '-9223372036854775808'::bigint)),
  CONSTRAINT "bank_transactions_amount_cents_not_null" NOT NULL amount_cents,
  CONSTRAINT "bank_transactions_bank_account_id_external_id_key" UNIQUE (bank_account_id, external_id),
  CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES accounting.bank_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "bank_transactions_bank_account_id_not_null" NOT NULL bank_account_id,
  CONSTRAINT "bank_transactions_check" CHECK (((review <> 'excluded'::text) OR (length(btrim(excluded_reason)) > 0))),
  CONSTRAINT "bank_transactions_content_hash_not_null" NOT NULL content_hash,
  CONSTRAINT "bank_transactions_description_not_null" NOT NULL description,
  CONSTRAINT "bank_transactions_descriptor_key_not_null" NOT NULL descriptor_key,
  CONSTRAINT "bank_transactions_excluded_reason_not_null" NOT NULL excluded_reason,
  CONSTRAINT "bank_transactions_external_id_check" CHECK ((length(external_id) > 0)),
  CONSTRAINT "bank_transactions_external_id_not_null" NOT NULL external_id,
  CONSTRAINT "bank_transactions_id_not_null" NOT NULL id,
  CONSTRAINT "bank_transactions_observed_at_not_null" NOT NULL observed_at,
  CONSTRAINT "bank_transactions_pkey" PRIMARY KEY (id),
  CONSTRAINT "bank_transactions_posted_date_not_null" NOT NULL posted_date,
  CONSTRAINT "bank_transactions_raw_payload_not_null" NOT NULL raw_payload,
  CONSTRAINT "bank_transactions_review_check" CHECK ((review = ANY (ARRAY['unmatched'::text, 'matched'::text, 'excluded'::text]))),
  CONSTRAINT "bank_transactions_review_not_null" NOT NULL review,
  CONSTRAINT "bank_transactions_source_check" CHECK ((source = ANY (ARRAY['simplefin'::text, 'csv'::text, 'wave'::text]))),
  CONSTRAINT "bank_transactions_source_not_null" NOT NULL source,
  CONSTRAINT "bank_transactions_state_check" CHECK ((state = ANY (ARRAY['pending'::text, 'posted'::text]))),
  CONSTRAINT "bank_transactions_state_not_null" NOT NULL state,
  CONSTRAINT "observations_import_fk" FOREIGN KEY (import_batch_id) REFERENCES accounting.import_batches(id) ON DELETE RESTRICT
);

ALTER TABLE accounting.bank_transactions ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.parties (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "default_account_id" uuid,
  "is_contractor" boolean DEFAULT false NOT NULL,
  "contractor_classification" text DEFAULT 'unknown'::text NOT NULL,
  "documentation_status" text DEFAULT 'missing'::text NOT NULL,
  "notes" text DEFAULT ''::text NOT NULL,
  "is_archived" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "parties_contractor_classification_check" CHECK ((contractor_classification = ANY (ARRAY['unknown'::text, 'individual'::text, 'corporation'::text, 'foreign'::text, 'other'::text]))),
  CONSTRAINT "parties_contractor_classification_not_null" NOT NULL contractor_classification,
  CONSTRAINT "parties_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "parties_default_account_id_fkey" FOREIGN KEY (default_account_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "parties_documentation_status_check" CHECK ((documentation_status = ANY (ARRAY['missing'::text, 'received'::text, 'not_required'::text]))),
  CONSTRAINT "parties_documentation_status_not_null" NOT NULL documentation_status,
  CONSTRAINT "parties_id_not_null" NOT NULL id,
  CONSTRAINT "parties_is_archived_not_null" NOT NULL is_archived,
  CONSTRAINT "parties_is_contractor_not_null" NOT NULL is_contractor,
  CONSTRAINT "parties_kind_check" CHECK ((kind = ANY (ARRAY['vendor'::text, 'customer'::text, 'both'::text]))),
  CONSTRAINT "parties_kind_not_null" NOT NULL kind,
  CONSTRAINT "parties_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT "parties_name_key" UNIQUE (name),
  CONSTRAINT "parties_name_not_null" NOT NULL name,
  CONSTRAINT "parties_notes_not_null" NOT NULL notes,
  CONSTRAINT "parties_pkey" PRIMARY KEY (id),
  CONSTRAINT "parties_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "parties_version_check" CHECK ((version > 0)),
  CONSTRAINT "parties_version_not_null" NOT NULL version
);

ALTER TABLE accounting.parties ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.payee_aliases (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "party_id" uuid NOT NULL,
  "match_kind" text NOT NULL,
  "pattern" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "payee_aliases_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "payee_aliases_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "payee_aliases_enabled_not_null" NOT NULL enabled,
  CONSTRAINT "payee_aliases_id_not_null" NOT NULL id,
  CONSTRAINT "payee_aliases_match_kind_check" CHECK ((match_kind = ANY (ARRAY['key'::text, 'exact'::text, 'prefix'::text]))),
  CONSTRAINT "payee_aliases_match_kind_not_null" NOT NULL match_kind,
  CONSTRAINT "payee_aliases_match_kind_pattern_key" UNIQUE (match_kind, pattern),
  CONSTRAINT "payee_aliases_party_id_fkey" FOREIGN KEY (party_id) REFERENCES accounting.parties(id) ON DELETE RESTRICT,
  CONSTRAINT "payee_aliases_party_id_not_null" NOT NULL party_id,
  CONSTRAINT "payee_aliases_pattern_check" CHECK (((length(btrim(pattern)) >= 1) AND (length(btrim(pattern)) <= 1000))),
  CONSTRAINT "payee_aliases_pattern_not_null" NOT NULL pattern,
  CONSTRAINT "payee_aliases_pkey" PRIMARY KEY (id),
  CONSTRAINT "payee_aliases_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "payee_aliases_version_check" CHECK ((version > 0)),
  CONSTRAINT "payee_aliases_version_not_null" NOT NULL version
);

ALTER TABLE accounting.payee_aliases ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.periods (
  "month" date NOT NULL,
  "status" text DEFAULT 'open'::text NOT NULL,
  "locked_at" timestamp with time zone,
  "locked_by" uuid,
  "close_snapshot" jsonb,
  "reopen_reason" text DEFAULT ''::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "periods_check" CHECK (((status = 'locked'::text) = (locked_at IS NOT NULL))),
  CONSTRAINT "periods_locked_by_fkey" FOREIGN KEY (locked_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "periods_month_check" CHECK ((EXTRACT(day FROM month) = (1)::numeric)),
  CONSTRAINT "periods_month_not_null" NOT NULL month,
  CONSTRAINT "periods_pkey" PRIMARY KEY (month),
  CONSTRAINT "periods_reopen_reason_not_null" NOT NULL reopen_reason,
  CONSTRAINT "periods_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'locked'::text]))),
  CONSTRAINT "periods_status_not_null" NOT NULL status,
  CONSTRAINT "periods_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "periods_version_check" CHECK ((version > 0)),
  CONSTRAINT "periods_version_not_null" NOT NULL version
);

ALTER TABLE accounting.periods ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.reconciliations (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "statement_start" date NOT NULL,
  "statement_end" date NOT NULL,
  "opening_balance_cents" bigint NOT NULL,
  "ending_balance_cents" bigint NOT NULL,
  "document_id" uuid,
  "status" text DEFAULT 'in_progress'::text NOT NULL,
  "difference_cents" bigint NOT NULL,
  "notes" text DEFAULT ''::text NOT NULL,
  "completed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reconciliations_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES accounting.bank_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "reconciliations_bank_account_id_not_null" NOT NULL bank_account_id,
  CONSTRAINT "reconciliations_check" CHECK ((statement_end >= statement_start)),
  CONSTRAINT "reconciliations_check1" CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
  CONSTRAINT "reconciliations_check2" CHECK (((status <> 'completed'::text) OR (difference_cents = 0))),
  CONSTRAINT "reconciliations_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "reconciliations_difference_cents_not_null" NOT NULL difference_cents,
  CONSTRAINT "reconciliations_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "reconciliations_ending_balance_cents_not_null" NOT NULL ending_balance_cents,
  CONSTRAINT "reconciliations_id_not_null" NOT NULL id,
  CONSTRAINT "reconciliations_notes_not_null" NOT NULL notes,
  CONSTRAINT "reconciliations_opening_balance_cents_not_null" NOT NULL opening_balance_cents,
  CONSTRAINT "reconciliations_pkey" PRIMARY KEY (id),
  CONSTRAINT "reconciliations_statement_end_not_null" NOT NULL statement_end,
  CONSTRAINT "reconciliations_statement_start_not_null" NOT NULL statement_start,
  CONSTRAINT "reconciliations_status_check" CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text]))),
  CONSTRAINT "reconciliations_status_not_null" NOT NULL status,
  CONSTRAINT "reconciliations_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "reconciliations_version_check" CHECK ((version > 0)),
  CONSTRAINT "reconciliations_version_not_null" NOT NULL version
);

ALTER TABLE accounting.reconciliations ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.registers (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "account_id" uuid NOT NULL,
  "contra_account_id" uuid,
  "started_on" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "in_service_on" date,
  "method" text DEFAULT ''::text NOT NULL,
  "schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "ended_on" date,
  "notes" text DEFAULT ''::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registers_account_id_fkey" FOREIGN KEY (account_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "registers_account_id_not_null" NOT NULL account_id,
  CONSTRAINT "registers_amount_cents_check" CHECK ((amount_cents >= 0)),
  CONSTRAINT "registers_amount_cents_not_null" NOT NULL amount_cents,
  CONSTRAINT "registers_check" CHECK (((status = 'active'::text) OR (ended_on IS NOT NULL))),
  CONSTRAINT "registers_contra_account_id_fkey" FOREIGN KEY (contra_account_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "registers_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "registers_id_not_null" NOT NULL id,
  CONSTRAINT "registers_kind_check" CHECK ((kind = ANY (ARRAY['fixed_asset'::text, 'loan'::text]))),
  CONSTRAINT "registers_kind_not_null" NOT NULL kind,
  CONSTRAINT "registers_method_not_null" NOT NULL method,
  CONSTRAINT "registers_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 160))),
  CONSTRAINT "registers_name_not_null" NOT NULL name,
  CONSTRAINT "registers_notes_not_null" NOT NULL notes,
  CONSTRAINT "registers_pkey" PRIMARY KEY (id),
  CONSTRAINT "registers_schedule_check" CHECK ((jsonb_typeof(schedule) = 'array'::text)),
  CONSTRAINT "registers_schedule_not_null" NOT NULL schedule,
  CONSTRAINT "registers_started_on_not_null" NOT NULL started_on,
  CONSTRAINT "registers_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'disposed'::text, 'paid_off'::text]))),
  CONSTRAINT "registers_status_not_null" NOT NULL status,
  CONSTRAINT "registers_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "registers_version_check" CHECK ((version > 0)),
  CONSTRAINT "registers_version_not_null" NOT NULL version
);

ALTER TABLE accounting.registers ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.report_snapshots (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "params" jsonb NOT NULL,
  "from_date" date NOT NULL,
  "to_date" date NOT NULL,
  "financial_revision" bigint NOT NULL,
  "data" jsonb NOT NULL,
  "document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "report_snapshots_check" CHECK ((to_date >= from_date)),
  CONSTRAINT "report_snapshots_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "report_snapshots_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "report_snapshots_data_not_null" NOT NULL data,
  CONSTRAINT "report_snapshots_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "report_snapshots_financial_revision_not_null" NOT NULL financial_revision,
  CONSTRAINT "report_snapshots_from_date_not_null" NOT NULL from_date,
  CONSTRAINT "report_snapshots_id_not_null" NOT NULL id,
  CONSTRAINT "report_snapshots_kind_check" CHECK ((kind = ANY (ARRAY['profit_loss'::text, 'balance_sheet'::text, 'trial_balance'::text, 'general_ledger'::text, 'cash_movements'::text, 'year_end_package'::text, 'month_close'::text]))),
  CONSTRAINT "report_snapshots_kind_not_null" NOT NULL kind,
  CONSTRAINT "report_snapshots_params_not_null" NOT NULL params,
  CONSTRAINT "report_snapshots_pkey" PRIMARY KEY (id),
  CONSTRAINT "report_snapshots_to_date_not_null" NOT NULL to_date
);

ALTER TABLE accounting.report_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.rules (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "conditions" jsonb NOT NULL,
  "actions" jsonb NOT NULL,
  "auto_post" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rules_actions_check" CHECK ((jsonb_typeof(actions) = 'object'::text)),
  CONSTRAINT "rules_actions_not_null" NOT NULL actions,
  CONSTRAINT "rules_auto_post_not_null" NOT NULL auto_post,
  CONSTRAINT "rules_conditions_check" CHECK ((jsonb_typeof(conditions) = 'object'::text)),
  CONSTRAINT "rules_conditions_not_null" NOT NULL conditions,
  CONSTRAINT "rules_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "rules_enabled_not_null" NOT NULL enabled,
  CONSTRAINT "rules_id_not_null" NOT NULL id,
  CONSTRAINT "rules_name_check" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT "rules_name_not_null" NOT NULL name,
  CONSTRAINT "rules_pkey" PRIMARY KEY (id),
  CONSTRAINT "rules_priority_check" CHECK (((priority >= 0) AND (priority <= 10000))),
  CONSTRAINT "rules_priority_not_null" NOT NULL priority,
  CONSTRAINT "rules_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "rules_version_check" CHECK ((version > 0)),
  CONSTRAINT "rules_version_not_null" NOT NULL version
);

ALTER TABLE accounting.rules ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.journal_entries (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "entry_date" date NOT NULL,
  "memo" text NOT NULL,
  "source_description" text,
  "descriptor_key" text,
  "origin" text DEFAULT 'manual'::text NOT NULL,
  "kind" text DEFAULT 'manual'::text NOT NULL,
  "status" text DEFAULT 'draft'::text NOT NULL,
  "payee_id" uuid,
  "applied_rule_id" uuid,
  "transfer_group_id" uuid,
  "register_id" uuid,
  "import_batch_id" uuid,
  "reverses_entry_id" uuid,
  "replaces_entry_id" uuid,
  "reason" text DEFAULT ''::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "posted_at" timestamp with time zone,
  CONSTRAINT "entries_import_fk" FOREIGN KEY (import_batch_id) REFERENCES accounting.import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT "entries_payee_fk" FOREIGN KEY (payee_id) REFERENCES accounting.parties(id) ON DELETE RESTRICT,
  CONSTRAINT "entries_register_fk" FOREIGN KEY (register_id) REFERENCES accounting.registers(id) ON DELETE RESTRICT,
  CONSTRAINT "entries_rule_fk" FOREIGN KEY (applied_rule_id) REFERENCES accounting.rules(id) ON DELETE RESTRICT,
  CONSTRAINT "journal_entries_check" CHECK ((reverses_entry_id <> id)),
  CONSTRAINT "journal_entries_check1" CHECK ((replaces_entry_id <> id)),
  CONSTRAINT "journal_entries_check2" CHECK (((status = 'posted'::text) = (posted_at IS NOT NULL))),
  CONSTRAINT "journal_entries_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "journal_entries_entry_date_check" CHECK (((entry_date >= '1900-01-01'::date) AND (entry_date <= '2100-12-31'::date))),
  CONSTRAINT "journal_entries_entry_date_not_null" NOT NULL entry_date,
  CONSTRAINT "journal_entries_id_not_null" NOT NULL id,
  CONSTRAINT "journal_entries_kind_check" CHECK ((kind = ANY (ARRAY['manual'::text, 'income'::text, 'expense'::text, 'transfer'::text, 'payroll'::text, 'opening'::text, 'owner'::text, 'asset'::text, 'loan'::text, 'refund'::text, 'correction'::text]))),
  CONSTRAINT "journal_entries_kind_not_null" NOT NULL kind,
  CONSTRAINT "journal_entries_memo_check" CHECK (((length(btrim(memo)) >= 1) AND (length(btrim(memo)) <= 1000))),
  CONSTRAINT "journal_entries_memo_not_null" NOT NULL memo,
  CONSTRAINT "journal_entries_origin_check" CHECK ((origin = ANY (ARRAY['manual'::text, 'simplefin'::text, 'csv'::text, 'wave'::text, 'internal'::text]))),
  CONSTRAINT "journal_entries_origin_not_null" NOT NULL origin,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY (id),
  CONSTRAINT "journal_entries_reason_not_null" NOT NULL reason,
  CONSTRAINT "journal_entries_replaces_entry_id_fkey" FOREIGN KEY (replaces_entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "journal_entries_reverses_entry_id_fkey" FOREIGN KEY (reverses_entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "journal_entries_reverses_entry_id_key" UNIQUE (reverses_entry_id),
  CONSTRAINT "journal_entries_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text, 'discarded'::text]))),
  CONSTRAINT "journal_entries_status_not_null" NOT NULL status,
  CONSTRAINT "journal_entries_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "journal_entries_version_check" CHECK ((version > 0)),
  CONSTRAINT "journal_entries_version_not_null" NOT NULL version
);

ALTER TABLE accounting.journal_entries ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.import_rows (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "external_id" text,
  "fingerprint" text NOT NULL,
  "raw" jsonb NOT NULL,
  "parsed" jsonb NOT NULL,
  "status" text DEFAULT 'ready'::text NOT NULL,
  "entry_id" uuid,
  "duplicate_of_entry_id" uuid,
  "reason" text DEFAULT ''::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_rows_batch_id_external_id_key" UNIQUE (batch_id, external_id),
  CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES accounting.import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT "import_rows_batch_id_not_null" NOT NULL batch_id,
  CONSTRAINT "import_rows_batch_id_ordinal_key" UNIQUE (batch_id, ordinal),
  CONSTRAINT "import_rows_check" CHECK (((status <> 'applied'::text) OR (entry_id IS NOT NULL))),
  CONSTRAINT "import_rows_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "import_rows_duplicate_of_entry_id_fkey" FOREIGN KEY (duplicate_of_entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "import_rows_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "import_rows_fingerprint_check" CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT "import_rows_fingerprint_not_null" NOT NULL fingerprint,
  CONSTRAINT "import_rows_id_not_null" NOT NULL id,
  CONSTRAINT "import_rows_ordinal_check" CHECK ((ordinal >= 0)),
  CONSTRAINT "import_rows_ordinal_not_null" NOT NULL ordinal,
  CONSTRAINT "import_rows_parsed_check" CHECK ((jsonb_typeof(parsed) = 'object'::text)),
  CONSTRAINT "import_rows_parsed_not_null" NOT NULL parsed,
  CONSTRAINT "import_rows_pkey" PRIMARY KEY (id),
  CONSTRAINT "import_rows_raw_not_null" NOT NULL raw,
  CONSTRAINT "import_rows_reason_not_null" NOT NULL reason,
  CONSTRAINT "import_rows_status_check" CHECK ((status = ANY (ARRAY['ready'::text, 'duplicate'::text, 'exception'::text, 'applied'::text, 'excluded'::text]))),
  CONSTRAINT "import_rows_status_not_null" NOT NULL status,
  CONSTRAINT "import_rows_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "import_rows_version_check" CHECK ((version > 0)),
  CONSTRAINT "import_rows_version_not_null" NOT NULL version
);

ALTER TABLE accounting.import_rows ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.journal_lines (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "entry_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "amount_cents" bigint NOT NULL,
  "memo" text DEFAULT ''::text NOT NULL,
  "sort_order" smallint NOT NULL,
  "cash_class" text,
  CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY (account_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "journal_lines_account_id_not_null" NOT NULL account_id,
  CONSTRAINT "journal_lines_amount_cents_check" CHECK (((amount_cents <> 0) AND (amount_cents > '-9223372036854775808'::bigint))),
  CONSTRAINT "journal_lines_amount_cents_not_null" NOT NULL amount_cents,
  CONSTRAINT "journal_lines_cash_class_check" CHECK ((cash_class = ANY (ARRAY['operating'::text, 'investing'::text, 'financing'::text, 'transfer'::text]))),
  CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "journal_lines_entry_id_not_null" NOT NULL entry_id,
  CONSTRAINT "journal_lines_entry_id_sort_order_key" UNIQUE (entry_id, sort_order),
  CONSTRAINT "journal_lines_id_not_null" NOT NULL id,
  CONSTRAINT "journal_lines_memo_check" CHECK ((length(memo) <= 500)),
  CONSTRAINT "journal_lines_memo_not_null" NOT NULL memo,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY (id),
  CONSTRAINT "journal_lines_sort_order_check" CHECK (((sort_order >= 0) AND (sort_order <= 999))),
  CONSTRAINT "journal_lines_sort_order_not_null" NOT NULL sort_order
);

ALTER TABLE accounting.journal_lines ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.bank_matches (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "bank_transaction_id" uuid NOT NULL,
  "journal_line_id" uuid NOT NULL,
  "amount_cents" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "bank_matches_amount_cents_check" CHECK ((amount_cents >= 0)),
  CONSTRAINT "bank_matches_amount_cents_not_null" NOT NULL amount_cents,
  CONSTRAINT "bank_matches_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES accounting.bank_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT "bank_matches_bank_transaction_id_journal_line_id_key" UNIQUE (bank_transaction_id, journal_line_id),
  CONSTRAINT "bank_matches_bank_transaction_id_not_null" NOT NULL bank_transaction_id,
  CONSTRAINT "bank_matches_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "bank_matches_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "bank_matches_id_not_null" NOT NULL id,
  CONSTRAINT "bank_matches_journal_line_id_fkey" FOREIGN KEY (journal_line_id) REFERENCES accounting.journal_lines(id) ON DELETE RESTRICT,
  CONSTRAINT "bank_matches_journal_line_id_not_null" NOT NULL journal_line_id,
  CONSTRAINT "bank_matches_pkey" PRIMARY KEY (id)
);

ALTER TABLE accounting.bank_matches ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.payroll_runs (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "provider" text DEFAULT 'patriot'::text NOT NULL,
  "provider_run_id" text NOT NULL,
  "pay_date" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "gross_cents" bigint NOT NULL,
  "net_cents" bigint NOT NULL,
  "employee_withholding_cents" bigint NOT NULL,
  "employer_tax_cents" bigint NOT NULL,
  "components" jsonb NOT NULL,
  "entry_id" uuid,
  "document_id" uuid,
  "ytd" jsonb,
  "status" text DEFAULT 'draft'::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payroll_runs_check" CHECK ((period_end >= period_start)),
  CONSTRAINT "payroll_runs_check1" CHECK (((status <> 'posted'::text) OR (entry_id IS NOT NULL))),
  CONSTRAINT "payroll_runs_components_check" CHECK ((jsonb_typeof(components) = 'array'::text)),
  CONSTRAINT "payroll_runs_components_not_null" NOT NULL components,
  CONSTRAINT "payroll_runs_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "payroll_runs_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "payroll_runs_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "payroll_runs_employee_withholding_cents_check" CHECK ((employee_withholding_cents >= 0)),
  CONSTRAINT "payroll_runs_employee_withholding_cents_not_null" NOT NULL employee_withholding_cents,
  CONSTRAINT "payroll_runs_employer_tax_cents_check" CHECK ((employer_tax_cents >= 0)),
  CONSTRAINT "payroll_runs_employer_tax_cents_not_null" NOT NULL employer_tax_cents,
  CONSTRAINT "payroll_runs_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "payroll_runs_entry_id_key" UNIQUE (entry_id),
  CONSTRAINT "payroll_runs_gross_cents_check" CHECK ((gross_cents >= 0)),
  CONSTRAINT "payroll_runs_gross_cents_not_null" NOT NULL gross_cents,
  CONSTRAINT "payroll_runs_id_not_null" NOT NULL id,
  CONSTRAINT "payroll_runs_net_cents_check" CHECK ((net_cents >= 0)),
  CONSTRAINT "payroll_runs_net_cents_not_null" NOT NULL net_cents,
  CONSTRAINT "payroll_runs_pay_date_not_null" NOT NULL pay_date,
  CONSTRAINT "payroll_runs_period_end_not_null" NOT NULL period_end,
  CONSTRAINT "payroll_runs_period_start_not_null" NOT NULL period_start,
  CONSTRAINT "payroll_runs_pkey" PRIMARY KEY (id),
  CONSTRAINT "payroll_runs_provider_check" CHECK ((provider = 'patriot'::text)),
  CONSTRAINT "payroll_runs_provider_not_null" NOT NULL provider,
  CONSTRAINT "payroll_runs_provider_run_id_key" UNIQUE (provider_run_id),
  CONSTRAINT "payroll_runs_provider_run_id_not_null" NOT NULL provider_run_id,
  CONSTRAINT "payroll_runs_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text, 'void'::text]))),
  CONSTRAINT "payroll_runs_status_not_null" NOT NULL status,
  CONSTRAINT "payroll_runs_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "payroll_runs_version_check" CHECK ((version > 0)),
  CONSTRAINT "payroll_runs_version_not_null" NOT NULL version
);

ALTER TABLE accounting.payroll_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.document_links (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL,
  "entry_id" uuid,
  "bank_transaction_id" uuid,
  "import_batch_id" uuid,
  "reconciliation_id" uuid,
  "payroll_run_id" uuid,
  "register_id" uuid,
  "party_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "document_import_fk" FOREIGN KEY (import_batch_id) REFERENCES accounting.import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT "document_links_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES accounting.bank_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT "document_links_check" CHECK ((num_nonnulls(entry_id, bank_transaction_id, import_batch_id, reconciliation_id, payroll_run_id, register_id, party_id) = 1)),
  CONSTRAINT "document_links_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "document_links_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "document_links_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "document_links_document_id_not_null" NOT NULL document_id,
  CONSTRAINT "document_links_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES accounting.journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT "document_links_id_not_null" NOT NULL id,
  CONSTRAINT "document_links_party_id_fkey" FOREIGN KEY (party_id) REFERENCES accounting.parties(id) ON DELETE RESTRICT,
  CONSTRAINT "document_links_pkey" PRIMARY KEY (id),
  CONSTRAINT "document_payroll_fk" FOREIGN KEY (payroll_run_id) REFERENCES accounting.payroll_runs(id) ON DELETE RESTRICT,
  CONSTRAINT "document_reconciliation_fk" FOREIGN KEY (reconciliation_id) REFERENCES accounting.reconciliations(id) ON DELETE RESTRICT,
  CONSTRAINT "document_register_fk" FOREIGN KEY (register_id) REFERENCES accounting.registers(id) ON DELETE RESTRICT
);

ALTER TABLE accounting.document_links ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.reconciliation_items (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "reconciliation_id" uuid NOT NULL,
  "journal_line_id" uuid NOT NULL,
  "amount_cents" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reconciliation_items_amount_cents_check" CHECK (((amount_cents <> 0) AND (amount_cents > '-9223372036854775808'::bigint))),
  CONSTRAINT "reconciliation_items_amount_cents_not_null" NOT NULL amount_cents,
  CONSTRAINT "reconciliation_items_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "reconciliation_items_id_not_null" NOT NULL id,
  CONSTRAINT "reconciliation_items_journal_line_id_fkey" FOREIGN KEY (journal_line_id) REFERENCES accounting.journal_lines(id) ON DELETE RESTRICT,
  CONSTRAINT "reconciliation_items_journal_line_id_key" UNIQUE (journal_line_id),
  CONSTRAINT "reconciliation_items_journal_line_id_not_null" NOT NULL journal_line_id,
  CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY (id),
  CONSTRAINT "reconciliation_items_reconciliation_id_fkey" FOREIGN KEY (reconciliation_id) REFERENCES accounting.reconciliations(id) ON DELETE RESTRICT,
  CONSTRAINT "reconciliation_items_reconciliation_id_not_null" NOT NULL reconciliation_id
);

ALTER TABLE accounting.reconciliation_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.settings (
  "id" smallint DEFAULT 1 NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "primary_system" text DEFAULT 'wave'::text NOT NULL,
  "primary_system_since" date,
  "transfer_window_days" smallint DEFAULT 5 NOT NULL,
  "financial_revision" bigint DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "settings_financial_revision_check" CHECK ((financial_revision >= 0)),
  CONSTRAINT "settings_financial_revision_not_null" NOT NULL financial_revision,
  CONSTRAINT "settings_id_check" CHECK ((id = 1)),
  CONSTRAINT "settings_id_not_null" NOT NULL id,
  CONSTRAINT "settings_owner_user_id_fkey" FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "settings_owner_user_id_not_null" NOT NULL owner_user_id,
  CONSTRAINT "settings_pkey" PRIMARY KEY (id),
  CONSTRAINT "settings_primary_system_check" CHECK ((primary_system = ANY (ARRAY['wave'::text, 'admin'::text]))),
  CONSTRAINT "settings_primary_system_not_null" NOT NULL primary_system,
  CONSTRAINT "settings_transfer_window_days_check" CHECK (((transfer_window_days >= 0) AND (transfer_window_days <= 30))),
  CONSTRAINT "settings_transfer_window_days_not_null" NOT NULL transfer_window_days,
  CONSTRAINT "settings_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "settings_version_check" CHECK ((version > 0)),
  CONSTRAINT "settings_version_not_null" NOT NULL version
);

ALTER TABLE accounting.settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.tax_adjustments (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tax_year" smallint NOT NULL,
  "concept" text NOT NULL,
  "effective_date" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "reason" text NOT NULL,
  "document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "tax_adjustments_amount_cents_check" CHECK ((amount_cents <> 0)),
  CONSTRAINT "tax_adjustments_amount_cents_not_null" NOT NULL amount_cents,
  CONSTRAINT "tax_adjustments_check" CHECK ((EXTRACT(year FROM effective_date) = (tax_year)::numeric)),
  CONSTRAINT "tax_adjustments_concept_not_null" NOT NULL concept,
  CONSTRAINT "tax_adjustments_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "tax_adjustments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT "tax_adjustments_document_id_fkey" FOREIGN KEY (document_id) REFERENCES accounting.documents(id) ON DELETE RESTRICT,
  CONSTRAINT "tax_adjustments_effective_date_not_null" NOT NULL effective_date,
  CONSTRAINT "tax_adjustments_id_not_null" NOT NULL id,
  CONSTRAINT "tax_adjustments_pkey" PRIMARY KEY (id),
  CONSTRAINT "tax_adjustments_reason_check" CHECK ((length(TRIM(BOTH FROM reason)) > 0)),
  CONSTRAINT "tax_adjustments_reason_not_null" NOT NULL reason,
  CONSTRAINT "tax_adjustments_tax_year_check" CHECK (((tax_year >= 1900) AND (tax_year <= 2100))),
  CONSTRAINT "tax_adjustments_tax_year_not_null" NOT NULL tax_year
);

ALTER TABLE accounting.tax_adjustments ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.tax_links (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tax_estimate_id" uuid NOT NULL,
  "tax_year" smallint NOT NULL,
  "cutoff_mode" text NOT NULL,
  "cutoff_date" date,
  "forecast_method" text NOT NULL,
  "forecast_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "results" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "financial_revision" bigint DEFAULT '-1'::integer NOT NULL,
  "status" text DEFAULT 'stale'::text NOT NULL,
  "error" text,
  "computed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tax_links_check" CHECK (((cutoff_mode <> 'fixed'::text) OR (cutoff_date IS NOT NULL))),
  CONSTRAINT "tax_links_check1" CHECK (((cutoff_date IS NULL) OR (EXTRACT(year FROM cutoff_date) = (tax_year)::numeric))),
  CONSTRAINT "tax_links_created_at_not_null" NOT NULL created_at,
  CONSTRAINT "tax_links_cutoff_mode_check" CHECK ((cutoff_mode = ANY (ARRAY['today'::text, 'fixed'::text]))),
  CONSTRAINT "tax_links_cutoff_mode_not_null" NOT NULL cutoff_mode,
  CONSTRAINT "tax_links_financial_revision_not_null" NOT NULL financial_revision,
  CONSTRAINT "tax_links_forecast_inputs_not_null" NOT NULL forecast_inputs,
  CONSTRAINT "tax_links_forecast_method_check" CHECK ((forecast_method = ANY (ARRAY['manual'::text, 'average_months'::text, 'prior_year_pattern'::text]))),
  CONSTRAINT "tax_links_forecast_method_not_null" NOT NULL forecast_method,
  CONSTRAINT "tax_links_id_not_null" NOT NULL id,
  CONSTRAINT "tax_links_inputs_not_null" NOT NULL inputs,
  CONSTRAINT "tax_links_pkey" PRIMARY KEY (id),
  CONSTRAINT "tax_links_results_not_null" NOT NULL results,
  CONSTRAINT "tax_links_status_check" CHECK ((status = ANY (ARRAY['fresh'::text, 'stale'::text, 'error'::text]))),
  CONSTRAINT "tax_links_status_not_null" NOT NULL status,
  CONSTRAINT "tax_links_tax_estimate_id_fkey" FOREIGN KEY (tax_estimate_id) REFERENCES tax_estimates(id) ON DELETE RESTRICT,
  CONSTRAINT "tax_links_tax_estimate_id_key" UNIQUE (tax_estimate_id),
  CONSTRAINT "tax_links_tax_estimate_id_not_null" NOT NULL tax_estimate_id,
  CONSTRAINT "tax_links_tax_year_check" CHECK (((tax_year >= 1900) AND (tax_year <= 2100))),
  CONSTRAINT "tax_links_tax_year_not_null" NOT NULL tax_year,
  CONSTRAINT "tax_links_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "tax_links_version_not_null" NOT NULL version
);

ALTER TABLE accounting.tax_links ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounting.tax_mappings (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tax_year" smallint NOT NULL,
  "account_id" uuid NOT NULL,
  "concept" text NOT NULL,
  "deductible_bps" integer DEFAULT 10000 NOT NULL,
  "separately_stated" boolean DEFAULT false NOT NULL,
  "notes" text DEFAULT ''::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tax_mappings_account_id_fkey" FOREIGN KEY (account_id) REFERENCES accounting.accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "tax_mappings_account_id_not_null" NOT NULL account_id,
  CONSTRAINT "tax_mappings_concept_not_null" NOT NULL concept,
  CONSTRAINT "tax_mappings_deductible_bps_check" CHECK (((deductible_bps >= 0) AND (deductible_bps <= 10000))),
  CONSTRAINT "tax_mappings_deductible_bps_not_null" NOT NULL deductible_bps,
  CONSTRAINT "tax_mappings_id_not_null" NOT NULL id,
  CONSTRAINT "tax_mappings_notes_not_null" NOT NULL notes,
  CONSTRAINT "tax_mappings_pkey" PRIMARY KEY (id),
  CONSTRAINT "tax_mappings_separately_stated_not_null" NOT NULL separately_stated,
  CONSTRAINT "tax_mappings_tax_year_account_id_key" UNIQUE (tax_year, account_id),
  CONSTRAINT "tax_mappings_tax_year_check" CHECK (((tax_year >= 1900) AND (tax_year <= 2100))),
  CONSTRAINT "tax_mappings_tax_year_not_null" NOT NULL tax_year,
  CONSTRAINT "tax_mappings_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "tax_mappings_version_not_null" NOT NULL version
);

ALTER TABLE accounting.tax_mappings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.business_profile (
  "id" smallint DEFAULT 1 NOT NULL,
  "legal_name" text NOT NULL,
  "dba" text,
  "entity_type" text NOT NULL,
  "ein" text,
  "formation_date" date,
  "state_of_formation" text,
  "address" jsonb,
  "phone" text,
  "email" text,
  "tax_classification" text NOT NULL,
  "tax_classification_since" smallint,
  "home_state" text,
  "is_sstb" boolean DEFAULT false NOT NULL,
  "fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
  "books_timezone" text DEFAULT 'America/Phoenix'::text NOT NULL,
  "earliest_history_date" date DEFAULT '2022-12-31'::date NOT NULL,
  "owner_name" text,
  "owner_title" text,
  "accountant_name" text,
  "accountant_email" text,
  "default_email_account_id" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_profile_address_check" CHECK (((address IS NULL) OR (jsonb_typeof(address) = 'object'::text))),
  CONSTRAINT "business_profile_books_timezone_not_null" NOT NULL books_timezone,
  CONSTRAINT "business_profile_earliest_history_date_not_null" NOT NULL earliest_history_date,
  CONSTRAINT "business_profile_ein_check" CHECK (((ein IS NULL) OR (ein ~ '^[0-9]{2}-?[0-9]{7}$'::text))),
  CONSTRAINT "business_profile_entity_type_check" CHECK ((entity_type = ANY (ARRAY['llc'::text, 'corporation'::text, 'sole_proprietorship'::text, 'partnership'::text]))),
  CONSTRAINT "business_profile_entity_type_not_null" NOT NULL entity_type,
  CONSTRAINT "business_profile_fiscal_year_start_month_check" CHECK (((fiscal_year_start_month >= 1) AND (fiscal_year_start_month <= 12))),
  CONSTRAINT "business_profile_fiscal_year_start_month_not_null" NOT NULL fiscal_year_start_month,
  CONSTRAINT "business_profile_id_check" CHECK ((id = 1)),
  CONSTRAINT "business_profile_id_not_null" NOT NULL id,
  CONSTRAINT "business_profile_is_sstb_not_null" NOT NULL is_sstb,
  CONSTRAINT "business_profile_legal_name_check" CHECK (((length(btrim(legal_name)) >= 1) AND (length(btrim(legal_name)) <= 200))),
  CONSTRAINT "business_profile_legal_name_not_null" NOT NULL legal_name,
  CONSTRAINT "business_profile_pkey" PRIMARY KEY (id),
  CONSTRAINT "business_profile_tax_classification_check" CHECK ((tax_classification = ANY (ARRAY['disregarded'::text, 's_corp'::text, 'c_corp'::text, 'partnership'::text]))),
  CONSTRAINT "business_profile_tax_classification_not_null" NOT NULL tax_classification,
  CONSTRAINT "business_profile_tax_classification_since_check" CHECK (((tax_classification_since >= 1900) AND (tax_classification_since <= 2100))),
  CONSTRAINT "business_profile_updated_at_not_null" NOT NULL updated_at,
  CONSTRAINT "business_profile_version_check" CHECK ((version > 0)),
  CONSTRAINT "business_profile_version_not_null" NOT NULL version
);

ALTER TABLE public.business_profile ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX accounts_wave_name ON accounting.accounts USING btree (((external_names ->> 'wave'::text))) WHERE ((external_names ->> 'wave'::text) IS NOT NULL);

CREATE INDEX audit_operation ON accounting.audit_log USING btree (operation_id, id);

CREATE INDEX audit_row ON accounting.audit_log USING btree (table_name, row_id, id DESC);

CREATE INDEX bank_matches_line ON accounting.bank_matches USING btree (journal_line_id);

CREATE INDEX bank_transactions_descriptor ON accounting.bank_transactions USING btree (descriptor_key, posted_date);

CREATE INDEX bank_transactions_review ON accounting.bank_transactions USING btree (bank_account_id, review, posted_date);

CREATE UNIQUE INDEX document_link_unique ON accounting.document_links USING btree (document_id, COALESCE(entry_id, bank_transaction_id, import_batch_id, reconciliation_id, payroll_run_id, register_id, party_id));

CREATE INDEX documents_hash ON accounting.documents USING btree (sha256);

CREATE INDEX history_checks_latest ON accounting.history_checks USING btree (fiscal_year, kind, checked_at DESC, id);

CREATE INDEX import_rows_identity ON accounting.import_rows USING btree (external_id, fingerprint);

CREATE INDEX import_rows_queue ON accounting.import_rows USING btree (batch_id, status, ordinal);

CREATE INDEX entries_date ON accounting.journal_entries USING btree (entry_date, id);

CREATE INDEX entries_descriptor ON accounting.journal_entries USING btree (descriptor_key, entry_date DESC) WHERE (descriptor_key IS NOT NULL);

CREATE INDEX entries_review ON accounting.journal_entries USING btree (entry_date DESC, id) WHERE (status = 'draft'::text);

CREATE INDEX lines_account ON accounting.journal_lines USING btree (account_id, entry_id);

CREATE INDEX tax_adjustments_year_date ON accounting.tax_adjustments USING btree (tax_year, effective_date);

CREATE OR REPLACE FUNCTION accounting.apply_treatment(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; bank accounting.journal_lines; candidate jsonb; previous jsonb; result jsonb; party uuid; category uuid;
BEGIN
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF e.status<>'draft' THEN RETURN jsonb_build_object('id',entry,'version',e.version); END IF;
 SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card');
 IF NOT FOUND THEN RETURN jsonb_build_object('id',entry,'version',e.version); END IF;
 SELECT party_id INTO party FROM accounting.payee_aliases a WHERE enabled AND ((match_kind='key' AND pattern=e.descriptor_key) OR (match_kind='exact' AND upper(pattern)=upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g'))) OR (match_kind='prefix' AND left(upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g')),length(pattern))=upper(pattern)))
 ORDER BY CASE match_kind WHEN 'key' THEN 0 WHEN 'exact' THEN 1 ELSE 2 END,length(pattern) DESC,id LIMIT 1;
 IF party IS NOT NULL THEN UPDATE accounting.journal_entries SET payee_id=party WHERE id=entry RETURNING * INTO e; END IF;
 candidate:=accounting.rule_candidate(entry);
 IF candidate IS NOT NULL AND (candidate->>'eligible')::boolean THEN
  IF candidate->'actions'?'splits' THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.split','id',entry,'expected_version',e.version,'splits',candidate->'actions'->'splits','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  ELSE
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',candidate->'actions'->>'account_id','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  END IF;
  UPDATE accounting.journal_entries SET applied_rule_id=(candidate->>'rule_id')::uuid WHERE id=entry RETURNING * INTO e;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after)
  VALUES(CASE WHEN current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE auth.uid() END,
   coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'),
   coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid()),'journal_entries',entry,'rule.applied',candidate,
   jsonb_build_object('version',e.version,'payee_id',e.payee_id,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount_cents::text,'memo',memo) ORDER BY sort_order) FROM accounting.journal_lines WHERE entry_id=entry)));
  IF (candidate->>'auto_post')::boolean AND (SELECT primary_system FROM accounting.settings WHERE id=1)='admin' THEN
   RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',entry,'expected_version',e.version));
  END IF;
 ELSIF e.descriptor_key IS NOT NULL THEN
  previous:=accounting.prior_summary(e.descriptor_key,bank.account_id,1);
  -- Reuse a single-category treatment only. A past split's proportions may not fit this purchase.
  IF jsonb_array_length(coalesce(previous->'entries'->0->'lines','[]'))=1 THEN
   category:=(previous->>'last_category')::uuid;
   IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
    result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',coalesce(e.payee_id::text,previous->>'payee_id'),'memo',coalesce(previous->>'memo',e.memo)));
    SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('id',entry,'version',e.version);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.balance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE entry uuid; e accounting.journal_entries; n integer; s numeric; reversed jsonb; original jsonb;
BEGIN
 IF TG_TABLE_NAME='journal_entries' THEN entry:=NEW.id; ELSIF TG_OP='DELETE' THEN entry:=OLD.entry_id; ELSE entry:=NEW.entry_id; END IF;
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF e.status='posted' THEN
  SELECT count(*),coalesce(sum(amount_cents),0) INTO n,s FROM accounting.journal_lines WHERE entry_id=entry;
  IF n<2 OR s<>0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
   SELECT jsonb_agg(jsonb_build_array(account_id,(-amount_cents)::text,sort_order) ORDER BY sort_order) INTO reversed FROM accounting.journal_lines WHERE entry_id=entry;
   SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text,sort_order) ORDER BY sort_order) INTO original FROM accounting.journal_lines WHERE entry_id=e.reverses_entry_id;
   IF reversed IS DISTINCT FROM original THEN RAISE EXCEPTION 'ACCT_REVERSAL_MUST_BE_EXACT'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.bank_review(filter jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;observation accounting.bank_transactions;ledger_account uuid;selected_id uuid:=(filter->>'id')::uuid;matches jsonb;drafts jsonb;candidates jsonb;candidate_count integer;
BEGIN
 PERFORM accounting.require_owner();
 IF selected_id IS NOT NULL THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=selected_id;
  IF NOT FOUND THEN SELECT o.* INTO observation FROM accounting.import_rows r JOIN accounting.bank_accounts b ON b.account_id=(r.parsed->>'bank_account_id')::uuid JOIN accounting.bank_transactions o ON o.bank_account_id=b.id AND o.external_id=r.external_id WHERE r.id=selected_id;END IF;
  IF observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT account_id INTO ledger_account FROM accounting.bank_accounts WHERE id=observation.bank_account_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'amount_cents',m.amount_cents::text,'release',NULL)),'[]') INTO matches FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=observation.id;
  SELECT coalesce(jsonb_agg(accounting.entry_detail(id)),'[]') INTO drafts FROM accounting.journal_entries e WHERE e.status='draft' AND EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id AND m.bank_transaction_id=observation.id);
  WITH matching AS(SELECT l.id line_id,e.id entry_id,e.entry_date,e.memo,l.amount_cents::text amount_cents,(abs(l.amount_cents::numeric)-coalesce((SELECT sum(amount_cents) FROM accounting.bank_matches WHERE journal_line_id=l.id),0))::text available_cents,abs(e.entry_date-observation.posted_date) days_apart
   FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=ledger_account AND e.status='posted' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id) AND sign(l.amount_cents)=sign(observation.amount_cents) AND abs(e.entry_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings) AND (filter->>'query' IS NULL OR e.memo ILIKE '%'||(filter->>'query')||'%')),
  eligible AS(SELECT * FROM matching WHERE available_cents::numeric>0),paged AS(SELECT * FROM eligible ORDER BY days_apart,entry_date,line_id LIMIT 50 OFFSET coalesce((filter->>'offset')::integer,0))
  SELECT (SELECT count(*) FROM eligible),(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY days_apart,entry_date,line_id),'[]') FROM paged p) INTO candidate_count,candidates;
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'source_conflict',EXISTS(SELECT 1 FROM accounting.import_rows WHERE id=selected_id AND status='exception'),'remaining_cents',CASE WHEN observation.review='matched' THEN '0' ELSE (abs(observation.amount_cents::numeric)-coalesce((SELECT sum(amount_cents) FROM accounting.bank_matches WHERE bank_transaction_id=observation.id),0))::text END,
   'total',candidate_count,'group',jsonb_build_object('id',selected_id,'bank_transaction_id',observation.id,'entry_date',observation.posted_date,'memo',observation.description,'bank_amount_cents',observation.amount_cents::text,'account_name',(SELECT name FROM accounting.accounts WHERE id=ledger_account),'source_system',observation.source,'source_scope',ledger_account::text,'status',observation.review),'drafts',drafts,'candidates',candidates,'matches',matches);
 END IF;
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'transactions',coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('amount_cents',o.amount_cents::text,
  'matches',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('amount_cents',m.amount_cents::text)),'[]') FROM accounting.bank_matches m WHERE m.bank_transaction_id=o.id)) ORDER BY o.posted_date DESC,o.id),'[]')) INTO result
 FROM (SELECT * FROM accounting.bank_transactions WHERE (filter->>'bank_account_id' IS NULL OR bank_account_id=(filter->>'bank_account_id')::uuid) ORDER BY posted_date DESC,id LIMIT 100 OFFSET coalesce((filter->>'offset')::integer,0)) o;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.banking_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
<<banking_command>>
DECLARE t text:=c->>'type'; key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 v integer; current_version integer; candidate_count integer; x jsonb; result jsonb; candidate jsonb; observation accounting.bank_transactions; doc accounting.documents; item accounting.journal_lines; existing jsonb;
 cond jsonb; actions jsonb; mapping_connection uuid; mapping_details jsonb; mapped_row accounting.bank_accounts; account uuid; transit uuid; outgoing jsonb; incoming jsonb; out_id uuid; in_id uuid; amount bigint; match_amount bigint; out_date date; in_date date;
BEGIN
 IF t='party.save' THEN
  SELECT version INTO current_version FROM accounting.parties WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  INSERT INTO accounting.parties(id,name,kind,default_account_id,is_contractor,contractor_classification,documentation_status,notes,is_archived)
  VALUES(key,c->>'name',c->>'kind',(c->>'default_account_id')::uuid,coalesce((c->>'is_contractor')::boolean,false),
   CASE WHEN coalesce(c->>'contractor_classification',c->>'tax_classification','unknown')='unreviewed' THEN 'unknown' WHEN c->>'tax_classification'='partnership' THEN 'other' ELSE coalesce(c->>'contractor_classification',c->>'tax_classification','unknown') END,
   CASE WHEN c->>'documentation'='requested' THEN 'missing' ELSE coalesce(c->>'documentation_status',c->>'documentation','missing') END,coalesce(c->>'notes',''),coalesce((c->>'is_archived')::boolean,false))
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,default_account_id=excluded.default_account_id,is_contractor=excluded.is_contractor,contractor_classification=excluded.contractor_classification,documentation_status=excluded.documentation_status,notes=excluded.notes,is_archived=excluded.is_archived RETURNING version INTO v;
 ELSIF t='alias.save' THEN
  SELECT version INTO current_version FROM accounting.payee_aliases WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) AND c?'expected_version' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  INSERT INTO accounting.payee_aliases(id,party_id,match_kind,pattern,enabled,created_by)
  VALUES(key,(c->>'party_id')::uuid,coalesce(c->>'match_kind',c->>'match_mode','key'),coalesce(c->>'pattern',c->>'description'),coalesce((c->>'enabled')::boolean,true),actor)
  ON CONFLICT(id) DO UPDATE SET party_id=excluded.party_id,match_kind=excluded.match_kind,pattern=excluded.pattern,enabled=excluded.enabled RETURNING id,version INTO key,v;
 ELSIF t IN ('rule.save','rule.activate') THEN
  SELECT version INTO current_version FROM accounting.rules WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='rule.activate' THEN
   UPDATE accounting.rules SET enabled=(c->>'enabled')::boolean WHERE id=key RETURNING version INTO v;
  ELSE
   cond:=coalesce(c->'conditions',jsonb_strip_nulls(jsonb_build_object('description_mode',c->'description_mode','description',c->'description','bank_account_id',c->'bank_account_id','direction',c->'direction','amount_min',c->'min_cents','amount_max',c->'max_cents','payee_id',c->'match_payee_id')));
   actions:=coalesce(c->'actions',jsonb_strip_nulls(jsonb_build_object('account_id',c->'category_account_id','payee_id',c->'assign_payee_id')));
   IF EXISTS(SELECT 1 FROM jsonb_each(cond) v WHERE v.key IN ('amount_min','amount_max') AND (jsonb_typeof(value)<>'string' OR (value#>>'{}')!~'^[0-9]+$')) THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   IF NOT(actions?'account_id' OR actions?'splits') OR (cond->>'amount_min')::numeric>(cond->>'amount_max')::numeric THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
   IF actions?'account_id' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(actions->>'account_id')::uuid AND NOT is_archived AND subtype NOT IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_INVALID_RULE_ACCOUNT'; END IF;
   IF actions?'splits' THEN
    IF jsonb_typeof(actions->'splits') IS DISTINCT FROM 'array' OR jsonb_array_length(actions->'splits')<2 THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(actions->'splits') s WHERE (s->>'share_bps') IS NULL OR (s->>'share_bps')!~'^[0-9]+$' OR (s->>'share_bps')::integer NOT BETWEEN 1 AND 9999
      OR NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(s->>'account_id')::uuid AND NOT is_archived AND subtype NOT IN ('bank','card','cash')))
      OR (SELECT sum((s->>'share_bps')::integer) FROM jsonb_array_elements(actions->'splits') s)<>10000 THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
   END IF;
   INSERT INTO accounting.rules(id,name,priority,enabled,conditions,actions,auto_post) VALUES(key,c->>'name',coalesce((c->>'priority')::integer,100),coalesce((c->>'enabled')::boolean,false),cond,actions,coalesce((c->>'auto_post')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,conditions=excluded.conditions,actions=excluded.actions,enabled=excluded.enabled,auto_post=excluded.auto_post RETURNING version INTO v;
  END IF;
 ELSIF t IN ('rule.apply','rule.apply_preview') THEN
  result:='[]';
  FOR x IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
   candidate:=accounting.rule_candidate((x->>'id')::uuid);
   IF t='rule.apply' AND (candidate IS NULL OR NOT (candidate->>'eligible')::boolean) THEN RAISE EXCEPTION 'ACCT_RULE_INELIGIBLE'; END IF;
   IF candidate IS NULL THEN CONTINUE; END IF;
   IF t='rule.apply' THEN
    IF (candidate->>'entry_version')::integer IS DISTINCT FROM (x->>'expected_version')::integer OR (candidate->>'rule_version')::integer IS DISTINCT FROM (x->>'rule_version')::integer OR candidate->>'rule_id' IS DISTINCT FROM x->>'rule_id' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    result:=result||jsonb_build_array(accounting.apply_treatment((x->>'id')::uuid));
   ELSE result:=result||jsonb_build_array(candidate); END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'entries',result,'count',jsonb_array_length(result));
 ELSIF t='document.prepare' THEN
  INSERT INTO accounting.documents(id,storage_path,name,mime,size_bytes,sha256,kind,uploaded_by)
   VALUES(key,key::text||'/'||coalesce(c->>'sha256',c->>'content_hash'),coalesce(c->>'name',c->>'original_name'),coalesce(c->>'mime',c->>'mime_type'),(c->>'size_bytes')::bigint,coalesce(c->>'sha256',c->>'content_hash'),coalesce(c->>'kind','receipt'),actor) RETURNING version INTO v;
  RETURN jsonb_build_object('id',key,'version',v,'storage_path',key::text||'/'||coalesce(c->>'sha256',c->>'content_hash'));
 ELSIF t IN ('document.complete','document.link','document.archive') THEN
  SELECT * INTO doc FROM accounting.documents WHERE id=coalesce((c->>'document_id')::uuid,key);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t<>'document.archive' AND NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=doc.storage_path) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF t='document.link' THEN
   INSERT INTO accounting.document_links(document_id,entry_id,bank_transaction_id,import_batch_id,reconciliation_id,payroll_run_id,register_id,party_id,created_by)
   VALUES(doc.id,(c->>'entry_id')::uuid,(c->>'bank_transaction_id')::uuid,(c->>'import_batch_id')::uuid,(c->>'reconciliation_id')::uuid,(c->>'payroll_run_id')::uuid,(c->>'register_id')::uuid,(c->>'party_id')::uuid,actor) ON CONFLICT DO NOTHING;
  END IF;
  IF t='document.archive' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  UPDATE accounting.documents SET status=CASE t WHEN 'document.archive' THEN 'archived' WHEN 'document.link' THEN 'linked' ELSE status END WHERE id=doc.id RETURNING version INTO v;
  key:=doc.id;
 ELSIF t='feed.claim' THEN
  IF c->>'claim_id' IS NOT NULL AND c->>'access_url_encrypted' IS NULL THEN
   INSERT INTO accounting.bank_connections(id,name,status,access_url_encrypted,checkpoint)
    VALUES(key,c->>'name','reconnect_required','',jsonb_build_object('claim',jsonb_build_object('id',c->>'claim_id','state','prepared'))) RETURNING version INTO v;
  ELSE
   IF length(coalesce(c->>'access_url_encrypted',''))<20 THEN RAISE EXCEPTION 'ACCT_ENCRYPTED_ACCESS_REQUIRED'; END IF;
   INSERT INTO accounting.bank_connections(id,name,access_url_encrypted,key_version) VALUES(key,c->>'name',c->>'access_url_encrypted',coalesce((c->>'key_version')::smallint,1)) RETURNING version INTO v;
  END IF;
 ELSIF t IN ('feed.disconnect','feed.schedule','bank.sync_request') THEN
  SELECT version INTO current_version FROM accounting.bank_connections WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF t<>'bank.sync_request' AND (c->>'expected_version')::integer IS DISTINCT FROM current_version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='feed.disconnect' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  UPDATE accounting.bank_connections SET status=CASE WHEN t='feed.disconnect' THEN 'disconnected' ELSE status END,
   scheduled=CASE WHEN t='feed.disconnect' THEN false WHEN t='feed.schedule' THEN (c->>'enabled')::boolean ELSE scheduled END,
   next_sync_at=CASE WHEN t='bank.sync_request' THEN now() ELSE next_sync_at END,
   lease_run_id=CASE WHEN t='feed.disconnect' THEN NULL ELSE lease_run_id END,lease_until=CASE WHEN t='feed.disconnect' THEN NULL ELSE lease_until END
   WHERE id=key RETURNING version INTO v;
 ELSIF t='feed.map' THEN
  IF c->>'connection_id' IS NULL THEN
   SELECT b.id,d.value INTO mapping_connection,mapping_details FROM accounting.bank_connections b CROSS JOIN LATERAL jsonb_each(coalesce(b.checkpoint->'discovery','{}')) d WHERE d.key=banking_command.key::text;
   IF FOUND THEN c:=c||jsonb_build_object('connection_id',mapping_connection,'provider_account_id',mapping_details->>'provider_account_id','institution',mapping_details->>'institution'); END IF;
  END IF;
  SELECT version INTO current_version FROM accounting.bank_accounts WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF coalesce(c->>'ownership','company')<>'company' THEN
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['discovery',key::text,'ownership'],c->'ownership',true) WHERE id=(c->>'connection_id')::uuid;
   RETURN jsonb_build_object('id',key,'version',coalesce(current_version,0));
  END IF;
  INSERT INTO accounting.bank_accounts(id,account_id,connection_id,provider_account_id,institution,mask,movement_sign,coverage_from)
  VALUES(key,(c->>'account_id')::uuid,(c->>'connection_id')::uuid,c->>'provider_account_id',coalesce(c->>'institution',''),coalesce(c->>'mask',''),coalesce((c->>'movement_sign')::smallint,1),coalesce((c->>'coverage_from')::date,(to_timestamp((c->>'history_start')::bigint) AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date))
  ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,connection_id=coalesce(excluded.connection_id,accounting.bank_accounts.connection_id),provider_account_id=coalesce(excluded.provider_account_id,accounting.bank_accounts.provider_account_id),movement_sign=excluded.movement_sign,coverage_from=excluded.coverage_from RETURNING version INTO v;
  IF c?'balance_sign' AND c->>'connection_id' IS NOT NULL THEN
   IF (c->>'balance_sign')::integer NOT IN (-1,1) THEN RAISE EXCEPTION 'ACCT_INVALID_BALANCE_SIGN'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=key) AND (c->>'balance_sign')::smallint IS DISTINCT FROM
     coalesce((SELECT (checkpoint->'balance_signs'->>key::text)::smallint FROM accounting.bank_connections WHERE id=(c->>'connection_id')::uuid),1)
     THEN RAISE EXCEPTION 'ACCT_BANK_MAPPING_FROZEN'; END IF;
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['balance_signs'],coalesce(checkpoint->'balance_signs','{}')||jsonb_build_object(key::text,(c->>'balance_sign')::smallint)) WHERE id=(c->>'connection_id')::uuid;
  END IF;
 ELSIF t='feed.skip' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  SELECT * INTO mapped_row FROM accounting.bank_accounts WHERE id=key;
  IF NOT FOUND OR mapped_row.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY[mapped_row.provider_account_id],to_jsonb(c->>'through')) WHERE id=mapped_row.connection_id;
  UPDATE accounting.bank_accounts SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t='feed.prepare' THEN RETURN jsonb_build_object('id',key,'prepared',0,'count',0);
 ELSIF t='bank.exclude' THEN
  UPDATE accounting.bank_transactions SET review=CASE WHEN coalesce((c->>'excluded')::boolean,true) THEN 'excluded' ELSE 'unmatched' END,excluded_reason=coalesce(c->>'reason','') WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.release' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  DELETE FROM accounting.bank_matches WHERE id=(c->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.match' THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=coalesce(c->>'bank_transaction_id',c->>'group_id',c->>'id')::uuid;
  IF NOT FOUND AND c->>'group_id' IS NOT NULL THEN
   SELECT o.* INTO observation FROM accounting.import_rows r JOIN accounting.bank_accounts b ON b.account_id=(r.parsed->>'bank_account_id')::uuid JOIN accounting.bank_transactions o ON o.bank_account_id=b.id AND o.external_id=r.external_id WHERE r.id=(c->>'group_id')::uuid;
  END IF;
  IF observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(c->'discard_drafts','[]')) LOOP
   PERFORM accounting.ledger_command(x||jsonb_build_object('type','draft.discard','reason',c->>'reason'));
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(c->'allocations',jsonb_build_array(jsonb_build_object('line_id',c->'journal_line_id','amount_cents',c->'amount_cents')))) LOOP
   INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,(x->>'line_id')::uuid,(x->>'amount_cents')::bigint,actor);
  END LOOP;
 ELSIF t='transfer.create' THEN
  amount:=(c->>'amount_cents')::bigint;out_date:=(c->>'outgoing_date')::date;in_date:=(c->>'incoming_date')::date;
  IF amount<=0 OR c->>'from_account_id'=c->>'to_account_id' OR (SELECT count(*) FROM accounting.accounts WHERE id IN ((c->>'from_account_id')::uuid,(c->>'to_account_id')::uuid) AND subtype IN ('bank','cash','card'))<>2 THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  outgoing:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',out_date,'memo',c->'memo','kind','transfer','lines',jsonb_build_array(jsonb_build_object('account_id',c->'from_account_id','amount_cents',(-amount)::text),jsonb_build_object('account_id',CASE WHEN out_date=in_date THEN (c->>'to_account_id')::uuid ELSE transit END,'amount_cents',amount::text))));
  out_id:=(outgoing->>'id')::uuid;
  UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=out_id RETURNING version INTO v;
  outgoing:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',out_id,'expected_version',v));
  in_id:=out_id;
  IF out_date<>in_date THEN
   incoming:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',in_date,'memo',c->'memo','kind','transfer','lines',jsonb_build_array(jsonb_build_object('account_id',transit,'amount_cents',(-amount)::text),jsonb_build_object('account_id',c->'to_account_id','amount_cents',amount::text))));
   in_id:=(incoming->>'id')::uuid;
   UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=in_id RETURNING version INTO v;
   incoming:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',in_id,'expected_version',v));
  END IF;
  -- Explicit creation of a transfer consumes only unambiguous matching bank evidence.
  FOR item IN SELECT l.* FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id IN(out_id,in_id) AND a.subtype IN ('bank','cash','card') LOOP
   SELECT count(*) INTO candidate_count FROM accounting.bank_transactions o JOIN accounting.bank_accounts b ON b.id=o.bank_account_id
    WHERE b.account_id=item.account_id AND o.amount_cents=item.amount_cents AND o.state='posted' AND o.review<>'excluded'
      AND o.posted_date=(SELECT entry_date FROM accounting.journal_entries WHERE id=item.entry_id)
      AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND (e.status<>'draft' OR e.origin NOT IN ('simplefin','csv')));
   IF candidate_count=1 THEN
    SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts b ON b.id=o.bank_account_id
     WHERE b.account_id=item.account_id AND o.amount_cents=item.amount_cents AND o.state='posted' AND o.review<>'excluded'
       AND o.posted_date=(SELECT entry_date FROM accounting.journal_entries WHERE id=item.entry_id)
       AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND (e.status<>'draft' OR e.origin NOT IN ('simplefin','csv')));
    FOR existing IN SELECT DISTINCT jsonb_build_object('id',e.id,'version',e.version) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=observation.id LOOP
     PERFORM set_config('accounting.reason','Replaced by owner-created transfer',true);
     PERFORM accounting.ledger_command(jsonb_build_object('type','draft.discard','id',existing->'id','expected_version',existing->'version','reason','Replaced by owner-created transfer'));
    END LOOP;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,item.id,abs(item.amount_cents),actor);
   END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'version',1,'outgoing_entry_id',out_id,'incoming_entry_id',in_id);
 ELSIF t='transfer.link' THEN
  out_id:=(c->>'outgoing_entry_id')::uuid;in_id:=(c->>'incoming_entry_id')::uuid;amount:=(c->>'amount_cents')::bigint;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  IF amount<=0 OR c->>'from_account_id'=c->>'to_account_id' THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=out_id AND status='posted' AND transfer_group_id IS NULL)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=in_id AND status='posted' AND transfer_group_id IS NULL) THEN RAISE EXCEPTION 'ACCT_TRANSFER_ALREADY_LINKED_OR_UNPOSTED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=out_id AND account_id=(c->>'from_account_id')::uuid AND amount_cents=-amount)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=in_id AND account_id=(c->>'to_account_id')::uuid AND amount_cents=amount) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF out_id<>in_id AND (NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=out_id AND account_id=transit AND amount_cents=amount)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=in_id AND account_id=transit AND amount_cents=-amount)) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF EXISTS(SELECT entry_id FROM accounting.journal_lines WHERE entry_id IN (out_id,in_id) GROUP BY entry_id HAVING count(*)<>2) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id IN(out_id,in_id);
  RETURN jsonb_build_object('id',key,'outgoing_entry_id',out_id,'incoming_entry_id',in_id);
 ELSIF t='transfer.reverse' THEN
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE transfer_group_id=key AND reverses_entry_id IS NULL) THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT to_jsonb(e) FROM accounting.journal_entries e WHERE transfer_group_id=key AND reverses_entry_id IS NULL ORDER BY entry_date,id LOOP
   PERFORM accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',x->'id','expected_version',x->'version','entry_date',CASE WHEN EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=(x->>'id')::uuid AND amount_cents<0 AND account_id<>(SELECT id FROM accounting.accounts WHERE system_purpose='transfers_in_transit')) THEN c->>'outgoing_date' ELSE c->>'incoming_date' END,'reason',c->'reason'));
  END LOOP;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.banking_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE observation accounting.bank_transactions; line accounting.journal_lines; movement accounting.bank_accounts; total numeric; capacity numeric; new_review text;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME NOT IN ('journal_lines','journal_entries') THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='INSERT' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.id=NEW.reverses_entry_id AND e.transfer_group_id IS NOT NULL AND (SELECT count(*) FROM accounting.journal_entries g WHERE g.transfer_group_id=e.transfer_group_id AND g.reverses_entry_id IS NULL)>1)
    AND current_setting('accounting.action',true)<>'transfer.reverse' THEN RAISE EXCEPTION 'ACCT_TRANSFER_REVERSE_TOGETHER'; END IF;
  IF TG_OP='UPDATE' AND NEW.entry_date<>OLD.entry_date AND OLD.origin IN ('simplefin','csv') AND EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
   IF (NEW.account_id,NEW.amount_cents,NEW.entry_id) IS DISTINCT FROM (OLD.account_id,OLD.amount_cents,OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='bank_transactions' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','review','excluded_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','review','excluded_reason']) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND OLD.state='posted' AND NEW.state<>'posted' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='INSERT' THEN NEW.descriptor_key:=coalesce(accounting.descriptor_key(NEW.description),''); END IF;
  IF NEW.review='excluded' AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_MATCH_EXISTS'; END IF;
 ELSIF TG_TABLE_NAME='bank_matches' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'ACCT_MATCH_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN
   IF btrim(coalesce(current_setting('accounting.reason',true),''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF OLD.amount_cents>0 AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.journal_line_id AND amount_cents=0) THEN RAISE EXCEPTION 'ACCT_RELEASE_CORROBORATION_FIRST'; END IF;
   RETURN OLD;
  END IF;
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=NEW.bank_transaction_id;
  SELECT * INTO line FROM accounting.journal_lines WHERE id=NEW.journal_line_id;
  SELECT * INTO movement FROM accounting.bank_accounts WHERE id=observation.bank_account_id;
  IF observation.state<>'posted' OR observation.review='excluded' OR line.account_id<>movement.account_id OR sign(line.amount_cents)<>sign(observation.amount_cents) THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH'; END IF;
  IF (SELECT status FROM accounting.journal_entries WHERE id=line.entry_id)='discarded' THEN RAISE EXCEPTION 'ACCT_MATCH_DISCARDED'; END IF;
  IF NEW.amount_cents=0 THEN
   -- Additional independent source evidence carries no second financial allocation.
   IF abs(line.amount_cents)<>abs(observation.amount_cents) OR NOT EXISTS(
    SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions other ON other.id=m.bank_transaction_id
    WHERE m.journal_line_id=line.id AND m.amount_cents=abs(line.amount_cents) AND other.source<>observation.source
      AND other.bank_account_id=observation.bank_account_id AND other.amount_cents=observation.amount_cents
      AND abs(other.posted_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
   ) THEN RAISE EXCEPTION 'ACCT_INVALID_CORROBORATION'; END IF;
  END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE bank_transaction_id=observation.id;
  IF total+NEW.amount_cents>abs(observation.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE journal_line_id=line.id;
  IF total+NEW.amount_cents>abs(line.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
 ELSIF TG_TABLE_NAME='bank_accounts' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.account_id,NEW.movement_sign) IS DISTINCT FROM (OLD.account_id,OLD.movement_sign) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_FROZEN'; END IF;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('parties','payee_aliases','bank_accounts','bank_connections','documents','rules') THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.books_package(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r jsonb;detail jsonb;result jsonb;support jsonb;inventory jsonb:='[]';issues jsonb:='[]';item text;mode text:=coalesce(params->>'view','preview');start_date date:=make_date((params->>'year')::integer,1,1);end_date date:=(params->>'through')::date;
BEGIN
 PERFORM accounting.require_owner();
 IF mode='history' THEN
  RETURN jsonb_build_object('count',(SELECT count(*) FROM accounting.report_snapshots WHERE kind='year_end_package' AND data->>'type'='books_package' AND (books_package.params->>'year' IS NULL OR extract(year FROM from_date)=(books_package.params->>'year')::integer)),
   'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'from_date',from_date,'to_date',to_date,'revision',financial_revision::text,'created_at',created_at,'review_items',data->'review_items') ORDER BY created_at DESC,id),'[]') FROM (SELECT * FROM accounting.report_snapshots WHERE kind='year_end_package' AND data->>'type'='books_package' AND (books_package.params->>'year' IS NULL OR extract(year FROM from_date)=(books_package.params->>'year')::integer) ORDER BY created_at DESC,id LIMIT 50 OFFSET coalesce((books_package.params->>'offset')::integer,0)) q));
 END IF;
 IF end_date IS NULL OR start_date IS NULL OR extract(year FROM end_date)<>(books_package.params->>'year')::integer OR end_date>(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 r:=accounting.report('summary',jsonb_build_object('from',start_date,'to',end_date));detail:=accounting.report_lines('general_ledger',jsonb_build_object('from',start_date,'to',end_date));
 FOREACH item IN ARRAY ARRAY['payroll-register','contractor-worksheet','asset-register','loan-register','tax-workpapers'] LOOP
  support:=accounting.support_report(jsonb_build_object('from',start_date,'to',end_date,'report_id',item,'limit',1));
  inventory:=inventory||jsonb_build_array(jsonb_build_object('id',item,'rows',support->'count'));
  IF support?'controls' AND NOT coalesce((support->'controls'->>'ready')::boolean,false) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind',item,'message','Register balances need review.'));END IF;
  IF item='tax-workpapers' AND (coalesce((support->'tax_workpaper'->>'unmapped_accounts')::integer,0)>0 OR coalesce((support->'tax_workpaper'->>'unavailable_adjustments')::integer,0)>0) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','tax','message','Tax mappings or adjustment evidence need review.'));END IF;
 END LOOP;
 IF NOT coalesce((accounting.payroll(jsonb_build_object('year',extract(year FROM end_date)::integer,'through',end_date))->'coverage'->>'current')::boolean,false) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','payroll','message','Provider year-to-date payroll evidence needs review.'));END IF;
 IF (r->'quality'->>'draft_count')::integer>0 THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','drafts','message','Draft transactions are excluded from posted reports.'));END IF;
 RETURN jsonb_build_object('year',(books_package.params->>'year')::integer,'through',end_date,'revision',r->'revision','legal_name',r->'legal_name','ledger_count',detail->'total','incomplete_imports',r->'quality'->'incomplete_imports',
 'review_items',issues,
 'notes',jsonb_build_array('Financial statements, ledger, payroll, contractor, register and tax support share one captured revision.'),
 'reports',inventory);
END $function$
;

CREATE OR REPLACE FUNCTION public.business_profile_get()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ACCT_AUTH_REQUIRED'; END IF;
  RETURN (SELECT to_jsonb(p) FROM public.business_profile p WHERE id=1);
END
$function$
;

CREATE OR REPLACE FUNCTION public.business_profile_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE has_observations boolean;
BEGIN
  IF TG_LEVEL = 'STATEMENT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(64219071);
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ACCT_PROFILE_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.books_timezone) THEN
    RAISE EXCEPTION 'ACCT_INVALID_TIMEZONE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
    IF NEW.books_timezone IS DISTINCT FROM OLD.books_timezone AND to_regclass('accounting.bank_transactions') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS(SELECT 1 FROM accounting.bank_transactions)' INTO has_observations;
      IF has_observations THEN RAISE EXCEPTION 'ACCT_TIMEZONE_FROZEN'; END IF;
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION accounting.cash_lines(params jsonb)
 RETURNS TABLE(id uuid, entry_id uuid, account_id uuid, amount_cents numeric, classification text, allocation_index bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 WITH cash AS (
 SELECT l.* FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id
 WHERE a.subtype IN ('bank','cash') AND e.entry_date BETWEEN (params->>'from')::date AND (params->>'to')::date AND (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
 AND (params->>'payee' IS NULL OR e.payee_id::text=params->>'payee' OR (params->>'payee'='unassigned' AND e.payee_id IS NULL))
 AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))
 ), weights AS (
 SELECT l.id,l.entry_id,l.account_id,l.amount_cents,c.id counter_id,c.sort_order,abs(c.amount_cents::numeric) weight,
 CASE WHEN l.cash_class IS NOT NULL THEN l.cash_class WHEN a.subtype IN ('bank','cash','transit') THEN 'transfer' WHEN a.type='equity' OR a.subtype='loan' THEN 'financing' WHEN a.subtype IN ('fixed_asset','accumulated_depreciation') THEN 'investing' ELSE 'operating' END classification,
 sum(abs(c.amount_cents::numeric)) OVER(PARTITION BY l.id) total_weight
 FROM cash l JOIN accounting.journal_lines c ON c.entry_id=l.entry_id AND sign(c.amount_cents)<>sign(l.amount_cents) JOIN accounting.accounts a ON a.id=c.account_id
 ), shares AS(SELECT *,floor(abs(amount_cents::numeric)*weight/total_weight) base,mod(abs(amount_cents::numeric)*weight,total_weight) remainder FROM weights),ranked AS (
 SELECT *,row_number() OVER(PARTITION BY id ORDER BY remainder DESC,sort_order,counter_id) rn,abs(amount_cents::numeric)-sum(base) OVER(PARTITION BY id) residual FROM shares)
 SELECT id,entry_id,account_id,sign(amount_cents)*(base+CASE WHEN rn<=residual THEN 1 ELSE 0 END),CASE classification WHEN 'transfer' THEN 'internal_transfer' ELSE classification END,sort_order::bigint
 FROM ranked WHERE base+CASE WHEN rn<=residual THEN 1 ELSE 0 END<>0
$function$
;

CREATE OR REPLACE FUNCTION accounting.close_checklist(month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE ending date:=(month+interval '1 month - 1 day')::date;drafts integer;mismatches integer;balances jsonb;observations jsonb;
BEGIN
 PERFORM accounting.require_owner();IF extract(day FROM month)<>1 THEN RAISE EXCEPTION 'ACCT_MONTH_REQUIRED';END IF;
 SELECT count(*) INTO drafts FROM accounting.journal_entries WHERE entry_date BETWEEN month AND ending AND status='draft';
 SELECT count(*) INTO mismatches FROM (SELECT DISTINCT ON(fiscal_year,kind) * FROM accounting.history_checks WHERE fiscal_year=extract(year FROM month) ORDER BY fiscal_year,kind,checked_at DESC,id DESC) checks WHERE status='mismatch';
 balances:=accounting.report('account_balances',jsonb_build_object('from',month,'to',ending));
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'account_id',b.account_id,'name',a.name,'book_cents',coalesce(r->>'ending_cents','0'),'observed_balance_cents',b.observed_balance_cents::text,'observed_at',b.observed_at,
  'difference_cents',CASE WHEN b.observed_balance_cents IS NULL THEN NULL ELSE (coalesce((r->>'ending_cents')::bigint,0)-b.observed_balance_cents)::text END) ORDER BY a.name),'[]') INTO observations
  FROM accounting.bank_accounts b JOIN accounting.accounts a ON a.id=b.account_id LEFT JOIN LATERAL (SELECT value r FROM jsonb_array_elements(balances->'rows') WHERE value->>'id'=b.account_id::text) q ON true WHERE NOT b.is_closed;
 RETURN jsonb_build_object('month',month,'month_start',month,'through',ending,'month_ended',ending<(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'reports',accounting.workspace(month,ending),'accounts',observations,'revision',(SELECT financial_revision::text FROM accounting.settings),'drafts',drafts,'history_mismatches',mismatches,'ready',drafts=0 AND mismatches=0,'banks',observations,
  'period',(SELECT to_jsonb(p) FROM accounting.periods p WHERE p.month=close_checklist.month));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.close_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type';key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=accounting.require_owner();r accounting.reconciliations;period accounting.periods;
 v integer;bank uuid;x jsonb;month_date date:=(c->>'month')::date;ending date;checklist jsonb;snapshot jsonb;
BEGIN
 IF t='period.close' THEN t:='period.lock';END IF;
 IF t='reconciliation.unmatch' THEN t:='reconciliation.item.remove';c:=c||jsonb_build_object('item_id',c->'allocation_id');PERFORM set_config('accounting.reason',coalesce(nullif(c->>'reason',''),'Owner removed reconciliation selection'),true);END IF;
 IF t IN ('period.lock','period.reopen') THEN
  IF month_date IS NULL OR extract(day FROM month_date)<>1 THEN RAISE EXCEPTION 'ACCT_MONTH_REQUIRED';END IF;
  SELECT * INTO period FROM accounting.periods WHERE month=month_date;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM coalesce(period.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='period.lock' THEN
   IF period.status='locked' THEN RAISE EXCEPTION 'ACCT_PERIOD_LOCKED';END IF;
   checklist:=accounting.close_checklist(month_date);
   IF (checklist->>'drafts')::integer<>0 THEN RAISE EXCEPTION 'ACCT_DRAFTS_EXIST';END IF;
   IF NOT (checklist->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_CLOSE_NOT_READY';END IF;
   ending:=(month_date+interval '1 month - 1 day')::date;
   snapshot:=jsonb_build_object('financial_revision',(SELECT financial_revision::text FROM accounting.settings),'trial_balance',accounting.report('trial_balance',jsonb_build_object('as_of',ending)),
    'profit_loss',accounting.report('profit_loss',jsonb_build_object('from',month_date,'to',ending)),'balance_sheet',accounting.report('balance_sheet',jsonb_build_object('as_of',ending)));
   INSERT INTO accounting.periods(month,status,locked_at,locked_by,close_snapshot) VALUES(month_date,'locked',now(),actor,snapshot)
    ON CONFLICT(month) DO UPDATE SET status='locked',locked_at=excluded.locked_at,locked_by=excluded.locked_by,close_snapshot=excluded.close_snapshot,reopen_reason='' RETURNING version INTO v;
  ELSE
   IF period.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'ACCT_PERIOD_NOT_LOCKED';END IF;
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   -- Reopening an earlier month also reopens dependent later snapshots atomically.
   UPDATE accounting.periods SET status='open',locked_at=NULL,locked_by=NULL,close_snapshot=NULL,reopen_reason=c->>'reason' WHERE month>=month_date AND status='locked';
   SELECT version INTO v FROM accounting.periods WHERE month=month_date;
  END IF;
 ELSIF t IN ('reconciliation.save','reconciliation.create') THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM coalesce(r.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF r.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
  bank:=(c->>'bank_account_id')::uuid;
  IF bank IS NULL THEN
   SELECT id INTO bank FROM accounting.bank_accounts WHERE account_id=(c->>'account_id')::uuid;
   IF bank IS NULL THEN INSERT INTO accounting.bank_accounts(account_id) VALUES((c->>'account_id')::uuid) RETURNING id INTO bank;END IF;
  END IF;
  INSERT INTO accounting.reconciliations(id,bank_account_id,statement_start,statement_end,opening_balance_cents,ending_balance_cents,document_id,difference_cents,notes)
   VALUES(key,bank,coalesce(c->>'statement_start',c->>'from')::date,coalesce(c->>'statement_end',c->>'to')::date,coalesce(c->>'opening_balance_cents',c->>'opening_cents')::bigint,coalesce(c->>'ending_balance_cents',c->>'ending_cents')::bigint,(c->>'document_id')::uuid,0,coalesce(c->>'notes',''))
   ON CONFLICT(id) DO UPDATE SET statement_start=excluded.statement_start,statement_end=excluded.statement_end,opening_balance_cents=excluded.opening_balance_cents,ending_balance_cents=excluded.ending_balance_cents,document_id=excluded.document_id,notes=excluded.notes RETURNING version INTO v;
  IF c?'items' THEN
   PERFORM set_config('accounting.reason',coalesce(c->>'reason','Owner updated reconciliation selection'),true);
   DELETE FROM accounting.reconciliation_items WHERE reconciliation_id=key;
   FOR x IN SELECT value FROM jsonb_array_elements(c->'items') LOOP
    INSERT INTO accounting.reconciliation_items(id,reconciliation_id,journal_line_id,amount_cents) VALUES(coalesce((x->>'id')::uuid,gen_random_uuid()),key,coalesce(x->>'journal_line_id',x->>'line_id')::uuid,(x->>'amount_cents')::bigint);
   END LOOP;
   UPDATE accounting.reconciliations SET updated_at=now() WHERE id=key RETURNING version INTO v;
  END IF;
 ELSIF t='reconciliation.allocate' THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'allocations') LOOP
   INSERT INTO accounting.reconciliation_items(id,reconciliation_id,journal_line_id,amount_cents) VALUES((x->>'id')::uuid,key,coalesce(x->>'journal_line_id',x->>'entry_line_id')::uuid,(x->>'amount_cents')::bigint);
  END LOOP;
  UPDATE accounting.reconciliations SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t IN ('reconciliation.complete','reconciliation.reopen','reconciliation.item.remove') THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='reconciliation.item.remove' THEN DELETE FROM accounting.reconciliation_items WHERE id=(c->>'item_id')::uuid AND reconciliation_id=key;
  ELSIF t='reconciliation.reopen' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
  UPDATE accounting.reconciliations SET status=CASE t WHEN 'reconciliation.complete' THEN 'completed' ELSE 'in_progress' END,completed_at=CASE WHEN t='reconciliation.complete' THEN now() ELSE NULL END WHERE id=key RETURNING version INTO v;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_build_object('id',key,'version',v);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.close_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r accounting.reconciliations;l accounting.journal_lines;entry accounting.journal_entries;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
   UPDATE accounting.reconciliations SET status='in_progress',completed_at=NULL WHERE status='completed' AND NEW.entry_date BETWEEN statement_start AND statement_end
    AND bank_account_id IN(SELECT b.id FROM accounting.journal_lines jl JOIN accounting.bank_accounts b ON b.account_id=jl.account_id WHERE jl.entry_id=NEW.id);
  END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='reconciliations' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.status='completed' AND NEW.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
   IF OLD.status='completed' AND (NEW.bank_account_id,NEW.statement_start,NEW.statement_end,NEW.opening_balance_cents,NEW.ending_balance_cents,NEW.document_id) IS DISTINCT FROM (OLD.bank_account_id,OLD.statement_start,OLD.statement_end,OLD.opening_balance_cents,OLD.ending_balance_cents,OLD.document_id) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
   NEW.version:=OLD.version+1;NEW.updated_at:=now();
  END IF;
  NEW.difference_cents:=NEW.ending_balance_cents-NEW.opening_balance_cents-coalesce((SELECT sum(amount_cents) FROM accounting.reconciliation_items WHERE reconciliation_id=NEW.id),0);
  IF NEW.status='completed' AND NEW.difference_cents<>0 THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_DIFFERENCE';END IF;
 ELSE
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'ACCT_ALLOCATION_IMMUTABLE';END IF;
  SELECT * INTO r FROM accounting.reconciliations WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
  IF r.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
  IF TG_OP='DELETE' THEN
   IF btrim(coalesce(current_setting('accounting.reason',true),''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   RETURN OLD;
  END IF;
  SELECT * INTO l FROM accounting.journal_lines WHERE id=NEW.journal_line_id;SELECT * INTO entry FROM accounting.journal_entries WHERE id=l.entry_id;
  IF l.account_id IS DISTINCT FROM (SELECT account_id FROM accounting.bank_accounts WHERE id=r.bank_account_id) OR entry.status IS DISTINCT FROM 'posted' OR entry.entry_date>r.statement_end OR sign(l.amount_cents)<>sign(NEW.amount_cents) OR abs(NEW.amount_cents)>abs(l.amount_cents) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_ALLOCATION';END IF;
 END IF;
 UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.context(view text, params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=accounting.require_owner();result jsonb;key uuid;selected_record jsonb;items jsonb;candidates jsonb;
BEGIN
 IF view='session' THEN RETURN jsonb_build_object('owner_id',actor); END IF;
 IF view='manage' THEN
  RETURN jsonb_build_object('profiles',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',id,'version',version,'purpose',system_purpose,'cash_kind',CASE WHEN subtype IN ('bank','cash','card') THEN subtype ELSE 'none' END,'parent_account_id',parent_id,'subtype',subtype,'type',type,'external_names',external_names) ORDER BY code,name),'[]') FROM accounting.accounts),
   'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('tax_classification',CASE WHEN contractor_classification='unknown' THEN 'unreviewed' ELSE contractor_classification END,'documentation',documentation_status) ORDER BY name),'[]') FROM accounting.parties p),
   'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked')),'[]') FROM accounting.periods p),
   'preferences',(SELECT to_jsonb(s)-ARRAY['owner_user_id','financial_revision']||jsonb_build_object('history_start',p.earliest_history_date,'legal_name',p.legal_name,'business_profile',to_jsonb(p)) FROM accounting.settings s CROSS JOIN public.business_profile p));
 ELSIF view='feeds' THEN
  RETURN jsonb_build_object('owner_id',actor,
   'connections',(SELECT coalesce(jsonb_agg(to_jsonb(c)-ARRAY['access_url_encrypted','key_version','checkpoint','lease_run_id'] ORDER BY created_at,id),'[]') FROM accounting.bank_connections c),
   'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id))),'[]') FROM accounting.bank_accounts b JOIN accounting.bank_connections c ON c.id=b.connection_id CROSS JOIN public.business_profile p),
   'identities',(SELECT coalesce(jsonb_agg(d.value||jsonb_build_object('connection_id',c.id,'provider_account_id',d.value->>'raw_provider_account_id','version',coalesce(b.version,0),'feed_account_id',b.id,'last_seen_at',c.updated_at,
    'account',CASE WHEN b.id IS NULL THEN NULL ELSE to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id)) END,
    'balance',jsonb_build_object('balance_cents',d.value->'balance_cents','available_cents',d.value->'available_cents','balance_at',d.value->'balance_at','issues','[]'::jsonb,'created_at',c.updated_at)) ORDER BY c.created_at,d.key),'[]') FROM accounting.bank_connections c CROSS JOIN public.business_profile p CROSS JOIN LATERAL jsonb_each(coalesce(c.checkpoint->'discovery','{}')) d LEFT JOIN accounting.bank_accounts b ON b.id=d.key::uuid),
   'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.operation_id,'connection_id',a.row_id,'actor_kind',a.actor_kind,'status',CASE WHEN (a.after->>'errors')::int>0 THEN 'incomplete' ELSE 'saved' END,'started_at',a.at,'finished_at',a.at,'error','') ORDER BY a.at DESC),'[]') FROM (SELECT * FROM accounting.audit_log WHERE table_name='bank_connections' AND action='sync' AND after ? 'accounts' ORDER BY at DESC LIMIT 100) a),
   'queue',(SELECT coalesce(jsonb_agg(jsonb_build_object('feed_account_id',b.id,'ready',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND o.review='unmatched' AND state='posted'),'pending',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND state='pending'))),'[]') FROM accounting.bank_accounts b));
 ELSIF view='rules' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('description_mode',coalesce(r.conditions->>'description_mode',(SELECT d.key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) d LIMIT 1)),'description',coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1)),'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction','min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id','reason','') ORDER BY priority,id),'[]') FROM accounting.rules r),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name,'match_mode',a.match_kind,'description',a.pattern) ORDER BY a.pattern),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id));
 ELSIF view='history' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'checks',(SELECT coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('from_date',make_date(fiscal_year,1,1),'to_date',make_date(fiscal_year,12,31),'source_document_id',document_id,'created_at',checked_at,'invalidated',status='mismatch','controls',expected) ORDER BY checked_at DESC),'[]') FROM accounting.history_checks h));
 ELSIF view='close-history' THEN
  RETURN jsonb_build_object('periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked') ORDER BY month DESC),'[]') FROM accounting.periods p),'reconciliations',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id));
 ELSIF view='tax' THEN
  SELECT id INTO key FROM public.tax_estimates WHERE tax_year=(context.params->>'year')::integer AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1;
  RETURN accounting.tax_link(key)||jsonb_build_object('_safe_harbor_context',jsonb_build_object('as_of',(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'financial_revision',(SELECT financial_revision::text FROM accounting.settings),'available_documents',(SELECT coalesce(jsonb_agg(d.id),'[]') FROM accounting.documents d WHERE d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 ELSIF view='evidence' THEN
  key:=(context.params->>'id')::uuid;PERFORM accounting.entry_detail(key);
  RETURN jsonb_build_object('sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'source_system',o.source,'external_id',o.external_id,'observed_at',o.observed_at,'raw_payload',o.raw_payload)) FROM accounting.bank_transactions o WHERE EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE m.bank_transaction_id=o.id AND l.entry_id=key)),'[]')||coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'source_system',b.source,'external_id',r.external_id,'observed_at',r.created_at,'raw_payload',r.raw)) FROM accounting.import_rows r JOIN accounting.import_batches b ON b.id=r.batch_id WHERE r.entry_id=key),'[]'),
   'notes',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.after->>'note_id','note',a.after->>'note','created_at',a.at) ORDER BY a.at),'[]') FROM accounting.audit_log a WHERE a.row_id=key AND a.action='entry.annotate' AND a.after ? 'note_id'),
   'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'original_name',d.name,'size_bytes',d.size_bytes::text,'mime_type',d.mime)),'[]') FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=key),
   'rules',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'rule_id',a.before->>'rule_id','rule_version',(a.before->>'rule_version')::integer,'rule_name',a.before->'winner'->>'name','created_at',a.at,'before_value',a.before,'after_value',a.after) ORDER BY a.id),'[]') FROM accounting.audit_log a WHERE a.row_id=key AND a.action='rule.applied'),
   'audit',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'table_name',a.table_name,'action',a.action,'recorded_at',a.at,'before_value',a.before,'after_value',a.after) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.row_id=key));
 ELSIF view='tax-snapshot' THEN RETURN accounting.tax_link((context.params->>'id')::uuid)->'snapshot';
 ELSIF view='period-impact' THEN
  RETURN jsonb_build_object('month',(context.params->>'month')::date,'revision',(SELECT financial_revision::text FROM accounting.settings),'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',p.month,'is_locked',p.status='locked') ORDER BY p.month),'[]') FROM accounting.periods p WHERE p.month>=(context.params->>'month')::date),'snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'from_date',from_date,'to_date',to_date,'revision',financial_revision::text) ORDER BY created_at DESC),'[]') FROM accounting.report_snapshots WHERE to_date>=(context.params->>'month')::date));
 ELSIF view='cash-review' THEN
  SELECT jsonb_build_object('line_id',l.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'account_name',a.name,'amount_cents',l.amount_cents::text,'version',e.version,'status',e.status,
   'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('classification',c.classification,'amount_cents',c.amount_cents::text,'note',CASE WHEN l.cash_class IS NULL THEN 'Derived from counter-account' ELSE e.reason END)),'[]') FROM accounting.cash_lines(jsonb_build_object('from',e.entry_date,'to',e.entry_date,'mode','working')) c WHERE c.id=l.id)) INTO result
   FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.accounts a ON a.id=l.account_id WHERE l.id=(context.params->>'line')::uuid;
  IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;RETURN result;
 ELSIF view='reconciliation' THEN
  key:=(context.params->>'id')::uuid;
  WITH records AS (SELECT r.*,b.account_id FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE (context.params->>'account' IS NULL OR b.account_id=(context.params->>'account')::uuid))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'statements',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]')) INTO result FROM records r;
  SELECT to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) INTO selected_record FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE r.id=key;
  IF key IS NOT NULL AND selected_record IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'journal_line_id',i.journal_line_id,'entry_date',e.entry_date,'description',e.memo,'amount_cents',i.amount_cents::text) ORDER BY e.entry_date,i.id),'[]') INTO items FROM accounting.reconciliation_items i JOIN accounting.journal_lines l ON l.id=i.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE i.reconciliation_id=key;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'amount_cents',l.amount_cents::text,'remaining_cents',(l.amount_cents-coalesce((SELECT sum(amount_cents) FROM accounting.reconciliation_items WHERE journal_line_id=l.id),0))::text) ORDER BY e.entry_date,l.id),'[]') INTO candidates FROM (SELECT l.* FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(selected_record->>'account_id',context.params->>'account')::uuid AND e.status='posted' AND (selected_record IS NULL OR e.entry_date<=(selected_record->>'statement_end')::date) ORDER BY e.entry_date,l.id LIMIT 100 OFFSET coalesce((context.params->>'offset')::int,0)) l JOIN accounting.journal_entries e ON e.id=l.entry_id;
  RETURN result||jsonb_build_object('statement',selected_record,'proof',CASE WHEN selected_record IS NULL THEN NULL ELSE jsonb_build_object('ready',(selected_record->>'difference_cents')::numeric=0,'statement_difference_cents',selected_record->>'difference_cents','item_count',jsonb_array_length(items)) END,'items',items,'item_count',jsonb_array_length(items),'lines',candidates,'line_count',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(selected_record->>'account_id',context.params->>'account')::uuid AND e.status='posted' AND (selected_record IS NULL OR e.entry_date<=(selected_record->>'statement_end')::date)));
 ELSIF view='transfers' THEN
  WITH movements AS (SELECT e.transfer_group_id,e.id,e.entry_date,e.memo,e.version,l.amount_cents,a.name,
    EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) reversed
    FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id WHERE e.status='posted' AND e.reverses_entry_id IS NULL AND e.transfer_group_id IS NOT NULL AND a.subtype IN ('bank','cash','card')),
  grouped AS (SELECT transfer_group_id id,max(version) version,CASE WHEN bool_or(reversed) THEN 'corrected' ELSE 'posted' END status,
   (array_agg(id ORDER BY entry_date,id) FILTER(WHERE amount_cents<0))[1] outgoing_entry_id,(array_agg(id ORDER BY entry_date,id) FILTER(WHERE amount_cents>0))[1] incoming_entry_id,
   min(entry_date) FILTER(WHERE amount_cents<0) outgoing_date,max(entry_date) FILTER(WHERE amount_cents>0) incoming_date,max(abs(amount_cents))::text amount_cents,min(memo) memo,
   max(name) FILTER(WHERE amount_cents<0) from_name,max(name) FILTER(WHERE amount_cents>0) to_name,
   min(entry_date) FILTER(WHERE amount_cents<0)<=(context.params->>'to')::date AND max(entry_date) FILTER(WHERE amount_cents>0)>(context.params->>'to')::date in_transit FROM movements GROUP BY transfer_group_id),
  scoped AS(SELECT * FROM grouped WHERE outgoing_date<=(context.params->>'to')::date AND incoming_date>=(context.params->>'from')::date),
  paged AS(SELECT * FROM scoped ORDER BY outgoing_date DESC,id LIMIT 100 OFFSET coalesce((context.params->>'offset')::int,0))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',(SELECT count(*) FROM scoped),'groups',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY outgoing_date DESC,id),'[]') FROM paged p)) INTO result;RETURN result;
 ELSIF view='tax-history' THEN
  RETURN jsonb_build_object('rows',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('recorded_at',at,'before_value',before,'after_value',after) ORDER BY at DESC),'[]') FROM (SELECT * FROM accounting.audit_log WHERE table_name IN ('tax_mappings','tax_adjustments','tax_links') AND (context.params->>'id' IS NULL OR row_id=(context.params->>'id')::uuid) ORDER BY at DESC LIMIT 100 OFFSET coalesce((context.params->>'offset')::integer,0)) a));
 END IF;
 RAISE EXCEPTION 'ACCT_INVALID_VIEW';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.contractor_report(year integer, cutoff date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE threshold bigint;result jsonb;through_date date:=coalesce(cutoff,make_date(year,12,31));
BEGIN
 PERFORM accounting.require_owner();
 IF extract(year FROM through_date)<>year THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 IF year BETWEEN 2022 AND 2025 THEN threshold:=60000;ELSIF year=2026 THEN threshold:=200000;ELSE RAISE EXCEPTION 'ACCT_CONTRACTOR_YEAR_RULE_REQUIRED';END IF;
 SELECT jsonb_build_object('year',year,'through',through_date,'revision',(SELECT financial_revision::text FROM accounting.settings),'threshold_cents',threshold::text,
  'rows',coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'contractor_classification',contractor_classification,'documentation_status',documentation_status,'paid_cents',paid::text,'card_cents',card::text,'meets_threshold',paid>=threshold) ORDER BY name,id),'[]')) INTO result FROM (
 SELECT p.id,p.name,p.contractor_classification,p.documentation_status,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash')),0) paid,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype='card'),0) card
 FROM accounting.parties p LEFT JOIN accounting.journal_entries e ON e.payee_id=p.id AND e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND through_date
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE p.is_contractor GROUP BY p.id) rows;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.descriptor_key(value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v text := upper(value);
BEGIN
 IF v IS NULL THEN RETURN NULL; END IF;
 v:=regexp_replace(v,'\*[[:space:]]*[0-9].*$','','g');
 v:=regexp_replace(v,'\m[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}\M',' ','g');
 v:=regexp_replace(v,'\m(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUN(E)?|JUL(Y)?|AUG(UST)?|SEP(TEMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)[[:space:]]+[0-9]{1,2}(,?[[:space:]]+[0-9]{4})?\M',' ','g');
 v:=regexp_replace(v,'\m[0-9]{1,2}[[:space:]]+(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUN(E)?|JUL(Y)?|AUG(UST)?|SEP(TEMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)([[:space:]]+[0-9]{4})?\M',' ','g');
 v:=regexp_replace(v,'#[[:space:]]*[0-9]+|[0-9]{4,}',' ','g');
 v:=regexp_replace(v,'\m(POS|DEBIT|CREDIT|PURCHASE|PAYMENT|CARD|ACH|RECURRING)\M',' ','g');
 RETURN btrim(regexp_replace(v,'[[:space:]]+',' ','g'));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.document_access(path text, uploading boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT EXISTS(SELECT 1 FROM accounting.settings WHERE owner_user_id=auth.uid()) AND EXISTS(SELECT 1 FROM accounting.documents WHERE storage_path=path AND status<>'archived') AND (NOT uploading OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=path))
$function$
;

CREATE OR REPLACE FUNCTION accounting.documents(filter jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT jsonb_build_object('documents',coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('original_name',d.name,'mime_type',d.mime,'content_hash',d.sha256,'size_bytes',d.size_bytes::text,'created_at',d.uploaded_at,'storage_key',d.storage_path,'state',CASE WHEN d.status='archived' THEN 'archived' WHEN EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path) THEN 'available' ELSE 'uploading' END,
  'links',(SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') FROM accounting.document_links l WHERE document_id=d.id)) ORDER BY uploaded_at DESC),'[]')) INTO result
 FROM accounting.documents d WHERE (filter->>'id' IS NULL OR d.id=(filter->>'id')::uuid) AND (filter->>'status' IS NULL OR d.status=filter->>'status');
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.entry_detail(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb; extra jsonb; bank_account uuid;
BEGIN
 PERFORM accounting.require_owner();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'context',jsonb_build_object('kind',e.kind,'payee_id',e.payee_id),'prior_treatment',NULL,
  'lines',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id),'[]')) INTO result
 FROM accounting.journal_entries e WHERE e.id=entry;
 IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY a.id),'[]') INTO extra FROM accounting.audit_log a WHERE a.row_id=entry;
 result:=result||jsonb_build_object('audit',extra,'matches','[]'::jsonb,'documents','[]'::jsonb);
 IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
  SELECT l.account_id INTO bank_account FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1;
  IF bank_account IS NOT NULL AND result->>'descriptor_key' IS NOT NULL THEN
   EXECUTE 'SELECT accounting.prior_summary($1,$2,10)' INTO extra USING result->>'descriptor_key',bank_account;
   result:=result||jsonb_build_object('prior_treatment',extra-ARRAY['entries','memo','last_date']);
  END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object(''amount_cents'',m.amount_cents::text)),''[]''::jsonb) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('matches',extra);
 END IF;
 IF to_regclass('accounting.document_links') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(d)),''[]''::jsonb) FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('documents',extra);
 END IF;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; a accounting.accounts; parent accounting.accounts; d date;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME IN ('audit_log','command_receipts') THEN
  IF TG_TABLE_NAME='command_receipts' THEN
   IF TG_OP='DELETE' AND OLD.created_at<now()-interval '90 days' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'ACCT_APPEND_ONLY';
 END IF;
 IF TG_TABLE_NAME='settings' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_SETTINGS_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN RAISE EXCEPTION 'ACCT_OWNER_IMMUTABLE'; END IF;
 ELSIF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='INSERT' THEN
   NEW.descriptor_key:=accounting.descriptor_key(NEW.source_description);
   PERFORM accounting.require_open(NEW.entry_date);
   INSERT INTO accounting.periods(month) VALUES(date_trunc('month',NEW.entry_date)::date) ON CONFLICT DO NOTHING;
  ELSE
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_description IS DISTINCT FROM OLD.source_description OR NEW.descriptor_key IS DISTINCT FROM OLD.descriptor_key OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_PROVENANCE'; END IF;
   IF OLD.transfer_group_id IS NOT NULL AND NEW.transfer_group_id IS DISTINCT FROM OLD.transfer_group_id THEN RAISE EXCEPTION 'ACCT_TRANSFER_GROUP_IMMUTABLE'; END IF;
   IF OLD.status='discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   IF OLD.status='posted' AND (to_jsonb(NEW)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','version','updated_at']) THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF OLD.status<>'posted' THEN PERFORM accounting.require_open(OLD.entry_date); PERFORM accounting.require_open(NEW.entry_date); END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
   SELECT * INTO e FROM accounting.journal_entries WHERE id=NEW.reverses_entry_id;
   IF e.status<>'posted' OR NEW.entry_date<e.entry_date OR btrim(NEW.reason)='' THEN RAISE EXCEPTION 'ACCT_INVALID_REVERSAL_DATE_OR_REASON'; END IF;
  END IF;
  IF NEW.replaces_entry_id IS NOT NULL THEN
   SELECT * INTO e FROM accounting.journal_entries WHERE id=NEW.replaces_entry_id;
   IF NEW.entry_date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) OR btrim(NEW.reason)='' THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.entry_id<>OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  PERFORM accounting.require_open(e.entry_date);
  IF TG_OP<>'DELETE' THEN
   SELECT * INTO a FROM accounting.accounts WHERE id=NEW.account_id;
   IF a.is_archived THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  IF TG_OP<>'DELETE' AND (
   (NEW.subtype IN ('bank','cash','undeposited','transit','fixed_asset','accumulated_depreciation','receivable') AND NEW.type<>'asset') OR
   (NEW.subtype IN ('card','loan','payroll_liability') AND NEW.type<>'liability') OR
   (NEW.subtype IN ('owner_equity','retained_earnings','opening_balance') AND NEW.type<>'equity') OR
   (NEW.subtype='revenue' AND NEW.type<>'income') OR
   (NEW.subtype IN ('operating_expense','payroll_expense') AND NEW.type<>'expense') OR
   (NEW.subtype IN ('bank','cash','card') AND NEW.is_contra) OR
   (NEW.subtype='accumulated_depreciation' AND NOT NEW.is_contra)
  ) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND';END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
   IF (NEW.type,NEW.subtype,NEW.is_contra) IS DISTINCT FROM (OLD.type,OLD.subtype,OLD.is_contra) AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.journal_entries posted_entry ON posted_entry.id=l.entry_id WHERE l.account_id=OLD.id AND posted_entry.status='posted') THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
   IF NEW.system_purpose IS DISTINCT FROM OLD.system_purpose AND OLD.system_purpose IS NOT NULL THEN RAISE EXCEPTION 'ACCT_SYSTEM_ACCOUNT'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
   SELECT * INTO parent FROM accounting.accounts WHERE id=NEW.parent_id;
   IF parent.parent_id IS NOT NULL OR parent.type<>NEW.type OR EXISTS(SELECT 1 FROM accounting.accounts WHERE parent_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_INVALID_ACCOUNT_PARENT'; END IF;
  END IF;
  IF NEW.is_archived AND (NEW.system_purpose IS NOT NULL OR coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.journal_entries posted_entry ON posted_entry.id=l.entry_id WHERE l.account_id=NEW.id AND posted_entry.status='posted'),0)<>0) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
 ELSIF TG_TABLE_NAME='periods' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.month<>OLD.month THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
   IF OLD.status='locked' AND NEW.status='open' AND btrim(NEW.reopen_reason)='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.status='locked' AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE status='draft' AND entry_date>=NEW.month AND entry_date<(NEW.month+interval '1 month')::date) THEN RAISE EXCEPTION 'ACCT_DRAFTS_REMAIN'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.history_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type';key uuid:=(c->>'id')::uuid;actor uuid:=accounting.require_owner();b accounting.import_batches;r accounting.import_rows;prior accounting.import_rows;
 x jsonb;proposal jsonb;result jsonb;kind text;source text;v integer;posted integer:=0;drafted integer:=0;skipped integer:=0;row_status text;why text;
 movement accounting.bank_accounts;observation accounting.bank_transactions;line uuid;candidate_count integer;category uuid;allocation bigint;financial_date date;amount bigint;all_complete boolean;expected jsonb;actual jsonb;differences jsonb;fiscal integer;
BEGIN
 IF t='import.create' THEN
  SELECT * INTO b FROM accounting.import_batches WHERE file_hash=c->>'file_hash';
  IF FOUND THEN
   IF b.mapping->>'mapping_hash' IS DISTINCT FROM c->>'mapping_hash' THEN RAISE EXCEPTION 'ACCT_IMPORT_MAPPING_CONFLICT';END IF;
   RETURN jsonb_build_object('id',b.id,'version',b.version);
  END IF;
  kind:=coalesce(c->>'kind',c->>'mode');source:=coalesce(c->>'source',c->>'source_system');
  IF kind='journal' AND c->>'basis' IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'ACCT_CASH_BASIS_REQUIRED';END IF;
  INSERT INTO accounting.import_batches(id,kind,source,document_id,file_hash,mapping,row_count,coverage_from,coverage_to,parity_status,created_by,control_totals)
   VALUES(key,kind,source,coalesce(c->>'document_id',c->>'source_document_id')::uuid,c->>'file_hash',coalesce(c->'mapping','{}')||jsonb_build_object('mapping_version',1,'mapping_hash',c->'mapping_hash','source_scope',c->'source_scope','file_name',c->'file_name','basis',c->'basis'),
    (c->>'expected_groups')::integer,(c->>'from')::date,(c->>'to')::date,CASE kind WHEN 'bank' THEN 'n/a' ELSE 'pending' END,actor,coalesce(c->'control_totals','{}')) RETURNING version INTO v;
 ELSIF t IN ('import.stage','import.apply','import.finish','import.cancel','import.resume') THEN
  SELECT * INTO b FROM accounting.import_batches WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF b.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t IN ('import.cancel','import.resume') AND b.status='completed' THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL';END IF;
  IF t IN ('import.stage','import.apply','import.finish') AND b.status IN ('cancelled','completed') THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_ACTIVE';END IF;
  IF t='import.stage' THEN
   IF jsonb_array_length(c->'groups') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_CHUNK_REQUIRED';END IF;
   FOR x IN SELECT value FROM jsonb_array_elements(c->'groups') LOOP
    proposal:=x-ARRAY['id','ordinal','raw','fingerprint'];financial_date:=(x->>'entry_date')::date;row_status:='ready';why:='';prior:=NULL;
    IF financial_date NOT BETWEEN b.coverage_from AND b.coverage_to OR financial_date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_IMPORT_DATE_RANGE';END IF;
    IF (x->>'ordinal')::integer>=b.row_count THEN RAISE EXCEPTION 'ACCT_IMPORT_ROW_COUNT';END IF;
    IF jsonb_array_length(coalesce(x->'errors','[]'))>0 THEN row_status:='exception';why:='Source parsing errors require correction in a new import.';END IF;
    IF b.kind='journal' AND jsonb_array_length(coalesce(x->'lines','[]'))=0 AND x->>'exclusion_reason' IS NOT NULL THEN row_status:='excluded';why:=x->>'exclusion_reason';END IF;
    SELECT i.* INTO prior FROM accounting.import_rows i JOIN accounting.import_batches ib ON ib.id=i.batch_id
     WHERE ib.source=b.source AND ib.kind=b.kind AND ib.mapping->>'source_scope'=b.mapping->>'source_scope' AND i.external_id=x->>'external_id' AND ib.id<>b.id
     ORDER BY (i.entry_id IS NOT NULL) DESC,ib.created_at DESC,i.id LIMIT 1;
    IF prior.id IS NOT NULL THEN
     IF prior.fingerprint=x->>'fingerprint' AND prior.entry_id IS NOT NULL THEN row_status:='duplicate';why:='Identical source identity already imported';
     ELSIF prior.fingerprint<>x->>'fingerprint' THEN row_status:='exception';why:='Source identity changed; compare and correct the posted entry with a reason';END IF;
    END IF;
    INSERT INTO accounting.import_rows(id,batch_id,ordinal,external_id,fingerprint,raw,parsed,status,duplicate_of_entry_id,reason)
     VALUES((x->>'id')::uuid,key,(x->>'ordinal')::integer,x->>'external_id',x->>'fingerprint',x->'raw',proposal,row_status,prior.entry_id,why);
    IF b.kind='bank' THEN
     SELECT * INTO movement FROM accounting.bank_accounts WHERE account_id=(x->>'bank_account_id')::uuid;
     IF NOT FOUND THEN
      INSERT INTO accounting.bank_accounts(account_id,coverage_from) VALUES((x->>'bank_account_id')::uuid,financial_date) RETURNING * INTO movement;
     END IF;
     SELECT * INTO observation FROM accounting.bank_transactions WHERE bank_account_id=movement.id AND external_id=x->>'external_id';
     IF FOUND AND (observation.content_hash IS DISTINCT FROM x->>'source_hash' OR observation.amount_cents<>(x->>'bank_amount_cents')::bigint OR observation.posted_date<>financial_date) THEN
      UPDATE accounting.import_rows SET status='exception',reason='Provider identity changed; immutable observation retained' WHERE id=(x->>'id')::uuid;
     ELSIF NOT FOUND THEN
      INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,amount_cents,description,descriptor_key,content_hash,raw_payload,state,import_batch_id)
       VALUES(movement.id,b.source,x->>'external_id',financial_date,(x->>'bank_amount_cents')::bigint,x->>'memo',accounting.descriptor_key(x->>'memo'),coalesce(x->>'source_hash',x->>'fingerprint'),x->'raw','posted',b.id);
     END IF;
    END IF;
   END LOOP;
  ELSIF t='import.apply' THEN
   IF jsonb_array_length(c->'group_ids') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_CHUNK_REQUIRED';END IF;
   IF (SELECT count(*) FROM accounting.import_rows WHERE batch_id=key AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(c->'group_ids')))<>jsonb_array_length(c->'group_ids') THEN RAISE EXCEPTION 'ACCT_IMPORT_ROWS_REQUIRED';END IF;
   FOR r IN SELECT * FROM accounting.import_rows WHERE batch_id=key AND id IN(SELECT value::text::uuid FROM jsonb_array_elements_text(c->'group_ids')) ORDER BY ordinal LOOP
    IF r.status IN ('applied','duplicate','excluded') THEN skipped:=skipped+1;CONTINUE;END IF;
    IF r.status='exception' THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION';END IF;
    proposal:=r.parsed;
    IF jsonb_array_length(coalesce(proposal->'errors','[]'))>0 THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION';END IF;
    IF proposal->>'exclusion_reason' IS NOT NULL AND jsonb_array_length(proposal->'lines')=0 THEN UPDATE accounting.import_rows SET status='excluded',reason=proposal->>'exclusion_reason' WHERE id=r.id;skipped:=skipped+1;CONTINUE;END IF;
    IF r.duplicate_of_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.import_rows i WHERE i.entry_id=r.duplicate_of_entry_id AND i.fingerprint=r.fingerprint) THEN UPDATE accounting.import_rows SET status='duplicate' WHERE id=r.id;skipped:=skipped+1;CONTINUE;END IF;
    IF r.duplicate_of_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_CORRECTION_REQUIRED';END IF;
    IF b.kind='journal' THEN
     result:=accounting.ledger_command(proposal||jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'origin',b.source,'kind',coalesce(proposal->>'kind','manual'),'import_batch_id',b.id));
     result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',result->'id','expected_version',result->'version'));posted:=posted+1;
    ELSE
     SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts ba ON ba.id=o.bank_account_id WHERE ba.account_id=(proposal->>'bank_account_id')::uuid AND o.external_id=r.external_id;
     IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_SOURCE_REQUIRED';END IF;
     IF observation.review='excluded' THEN RAISE EXCEPTION 'ACCT_SOURCE_EXCLUDED';END IF;
     SELECT m.journal_line_id INTO line FROM accounting.bank_matches m WHERE bank_transaction_id=observation.id LIMIT 1;
     IF line IS NOT NULL THEN
      result:=jsonb_build_object('id',(SELECT entry_id FROM accounting.journal_lines WHERE id=line));
     ELSE
      amount:=observation.amount_cents;
      SELECT count(*),(array_agg(l.id ORDER BY l.id))[1] INTO candidate_count,line FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
       WHERE l.account_id=(proposal->>'bank_account_id')::uuid AND l.amount_cents=amount AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id) AND abs(e.entry_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings)
        AND (NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=l.id) OR EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions o ON o.id=m.bank_transaction_id WHERE m.journal_line_id=l.id AND m.amount_cents=abs(amount) AND o.source<>observation.source));
      IF candidate_count=1 THEN
       allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=line) THEN 0 ELSE abs(amount) END;
       INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,line,allocation,actor);
       result:=jsonb_build_object('id',(SELECT entry_id FROM accounting.journal_lines WHERE id=line));
      ELSE
       SELECT id INTO category FROM accounting.accounts WHERE system_purpose=CASE WHEN amount>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
       result:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',observation.posted_date,'memo',observation.description,'source_description',observation.description,'origin',b.source,'kind',CASE WHEN amount>0 THEN 'income' ELSE 'expense' END,'import_batch_id',b.id,
        'lines',jsonb_build_array(jsonb_build_object('account_id',proposal->'bank_account_id','amount_cents',amount::text),jsonb_build_object('account_id',category,'amount_cents',(-amount)::text))));
       SELECT id INTO line FROM accounting.journal_lines WHERE entry_id=(result->>'id')::uuid AND account_id=(proposal->>'bank_account_id')::uuid;
       INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,line,abs(amount),actor);
       PERFORM accounting.apply_treatment((result->>'id')::uuid);drafted:=drafted+1;
      END IF;
     END IF;
    END IF;
    UPDATE accounting.import_rows SET status='applied',entry_id=(result->>'id')::uuid WHERE id=r.id;
   END LOOP;
  ELSIF t='import.finish' THEN
   IF (SELECT count(*) FROM accounting.import_rows WHERE batch_id=key)<>b.row_count OR EXISTS(SELECT 1 FROM accounting.import_rows WHERE batch_id=key AND status IN ('ready','exception')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE';END IF;
  ELSIF t='import.cancel' THEN
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   UPDATE accounting.import_rows SET status='ready' WHERE batch_id=key AND status<>'applied';
  ELSIF t='import.resume' THEN
   IF b.status<>'cancelled' THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_CANCELLED';END IF;
  END IF;
  UPDATE accounting.import_batches SET status=CASE t WHEN 'import.cancel' THEN 'cancelled' WHEN 'import.resume' THEN 'staged' WHEN 'import.finish' THEN 'completed' WHEN 'import.apply' THEN 'applying' ELSE status END,
   applied_count=(SELECT count(*) FROM accounting.import_rows WHERE batch_id=key AND status='applied'),checkpoint=(SELECT coalesce(max(ordinal)+1,0) FROM accounting.import_rows WHERE batch_id=key AND status IN ('applied','duplicate','excluded')) WHERE id=key RETURNING version INTO v;
 ELSIF t='import.resolve' THEN
  SELECT * INTO r FROM accounting.import_rows WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF r.status='applied' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_HISTORY';END IF;
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
  IF c->>'resolution'='exclude' THEN UPDATE accounting.import_rows SET status='excluded',reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSIF c->>'resolution'='match' THEN
   IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=(c->>'entry_id')::uuid AND status='posted') THEN RAISE EXCEPTION 'ACCT_POSTED_ENTRY_REQUIRED';END IF;
   SELECT * INTO b FROM accounting.import_batches WHERE id=r.batch_id;
   IF b.kind='bank' THEN
    SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts ba ON ba.id=o.bank_account_id WHERE ba.account_id=(r.parsed->>'bank_account_id')::uuid AND o.external_id=r.external_id;
    SELECT l.id INTO line FROM accounting.journal_lines l WHERE entry_id=(c->>'entry_id')::uuid AND account_id=(r.parsed->>'bank_account_id')::uuid AND amount_cents=observation.amount_cents;
    IF line IS NULL OR observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH';END IF;
    allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=line) THEN 0 ELSE abs(observation.amount_cents) END;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,line,allocation,actor);
   ELSE
    IF (SELECT entry_date FROM accounting.journal_entries WHERE id=(c->>'entry_id')::uuid) IS DISTINCT FROM (r.parsed->>'entry_date')::date OR
     (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM accounting.journal_lines WHERE entry_id=(c->>'entry_id')::uuid) IS DISTINCT FROM
     (SELECT jsonb_agg(jsonb_build_array((value->>'account_id')::uuid,((value->>'amount_cents')::bigint)::text) ORDER BY (value->>'account_id')::uuid,(value->>'amount_cents')::bigint) FROM jsonb_array_elements(r.parsed->'lines')) THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH';END IF;
   END IF;
   UPDATE accounting.import_rows SET status='duplicate',entry_id=(c->>'entry_id')::uuid,duplicate_of_entry_id=(c->>'entry_id')::uuid,reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSIF c->>'resolution'='correct' THEN
   SELECT * INTO b FROM accounting.import_batches WHERE id=r.batch_id;
   IF b.kind<>'journal' OR r.duplicate_of_entry_id IS NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_CORRECTION_REQUIRED';END IF;
   result:=accounting.ledger_command(r.parsed||jsonb_build_object('type','entry.correct','id',r.duplicate_of_entry_id,'expected_version',(SELECT version FROM accounting.journal_entries WHERE id=r.duplicate_of_entry_id),'reason',c->>'reason'));
   UPDATE accounting.import_rows SET status='applied',entry_id=(result->>'id')::uuid,reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSIF c->>'resolution'='new' THEN
   IF r.duplicate_of_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_CORRECTION_REQUIRED';END IF;
   UPDATE accounting.import_rows SET status='ready',reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSE RAISE EXCEPTION 'ACCT_INVALID_RESOLUTION';END IF;
 ELSIF t='history.lock' THEN
  SELECT h.expected INTO expected FROM accounting.history_checks h WHERE h.id=(c->>'history_id')::uuid AND h.status IN ('matches','explained');
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_HISTORY_NOT_READY';END IF;
  FOR financial_date IN SELECT d::date FROM generate_series(date_trunc('month',(expected->>'from')::date),date_trunc('month',(expected->>'to')::date),interval '1 month') d LOOP
   PERFORM accounting.close_command(jsonb_build_object('type','period.lock','id',gen_random_uuid(),'month',financial_date));
  END LOOP;
 ELSIF t IN ('history.check','history.verify') THEN
  fiscal:=coalesce((c->>'fiscal_year')::integer,extract(year FROM (c->>'from')::date)::integer);kind:=coalesce(c->>'kind',CASE WHEN fiscal=extract(year FROM (SELECT earliest_history_date FROM public.business_profile WHERE id=1)) THEN 'opening_balances' ELSE 'annual_totals' END);
  expected:=coalesce(c->'expected',jsonb_build_object('monthly',c->'monthly','accounts',c->'accounts','totals',c->'totals'));
  IF NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=(c->>'document_id')::uuid AND d.status<>'archived') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
  result:=accounting.history_preview(c||jsonb_build_object('kind',kind,'from',coalesce(c->>'from',make_date(fiscal,1,1)::text),'to',coalesce(c->>'to',make_date(fiscal,12,31)::text)));
  actual:=result->'actual';differences:=result->'difference';
  row_status:=CASE WHEN (result->>'differences')::integer>0 OR (result->>'drafts')::integer>0 OR (result->>'source_errors')::integer>0 THEN CASE WHEN btrim(coalesce(c->>'explanation',''))<>'' AND (result->>'drafts')::integer=0 AND (result->>'source_errors')::integer=0 THEN 'explained' ELSE 'mismatch' END ELSE 'matches' END;
  IF t='history.verify' AND row_status='mismatch' THEN RAISE EXCEPTION 'ACCT_HISTORY_NOT_READY';END IF;
  INSERT INTO accounting.history_checks(id,fiscal_year,kind,expected,actual,difference,status,explanation,document_id,checked_by)
   VALUES(key,fiscal,kind,expected||jsonb_build_object('from',result->'from','to',result->'to'),actual||jsonb_build_object('financial_revision',(SELECT financial_revision::text FROM accounting.settings)),differences,row_status,coalesce(c->>'explanation',c->>'reason',''),(c->>'document_id')::uuid,actor);
  UPDATE accounting.import_batches ib SET parity_status=CASE WHEN row_status IN ('matches','explained') THEN 'verified' ELSE 'mismatch' END
   WHERE ib.kind='journal' AND ib.coverage_from>=(result->>'from')::date AND ib.coverage_to<=(result->>'to')::date AND ib.status='completed';
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v,'posted',posted,'drafted',drafted,'skipped',skipped));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.history_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
   UPDATE accounting.history_checks SET status='mismatch' WHERE id IN (
    SELECT DISTINCT ON(fiscal_year,kind) id FROM accounting.history_checks WHERE fiscal_year>=extract(year FROM NEW.entry_date)::integer ORDER BY fiscal_year,kind,checked_at DESC,id DESC
   ) AND status<>'mismatch';
   UPDATE accounting.import_batches SET parity_status='mismatch' WHERE kind='journal' AND parity_status='verified' AND coverage_to>=NEW.entry_date;
  END IF;RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='history_checks' THEN
   IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NEW.status<>'mismatch' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_HISTORY';END IF;
  ELSE
   IF TG_TABLE_NAME='import_rows' THEN
    IF (NEW.batch_id,NEW.ordinal,NEW.external_id,NEW.fingerprint,NEW.raw,NEW.parsed) IS DISTINCT FROM (OLD.batch_id,OLD.ordinal,OLD.external_id,OLD.fingerprint,OLD.raw,OLD.parsed) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE';END IF;
   END IF;
   IF TG_TABLE_NAME='import_batches' THEN
    IF (NEW.kind,NEW.source,NEW.file_hash,NEW.mapping,NEW.row_count,NEW.coverage_from,NEW.coverage_to) IS DISTINCT FROM (OLD.kind,OLD.source,OLD.file_hash,OLD.mapping,OLD.row_count,OLD.coverage_from,OLD.coverage_to) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE';END IF;
   END IF;
   NEW.version:=OLD.version+1;NEW.updated_at:=now();
  END IF;
 END IF;
 UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.history_preview(controls jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date:=(controls->>'from')::date;end_date date:=(controls->>'to')::date;expected jsonb:=coalesce(controls->'expected','{}');actual jsonb;difference jsonb:='{}';
 monthly jsonb:='[]';account_rows jsonb:='[]';balance jsonb;balances jsonb;period_report jsonb;item jsonb;source_row jsonb;value_key text;actual_value text;expected_value text;difference_count integer:=0;drafts integer;errors integer;
BEGIN
 PERFORM accounting.require_owner();
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR extract(year FROM start_date)<>extract(year FROM end_date) THEN RAISE EXCEPTION 'ACCT_HISTORY_SCOPE';END IF;
 balance:=accounting.report('balance_sheet',jsonb_build_object('as_of',end_date));
 actual:=accounting.report(CASE WHEN controls->>'kind'='opening_balances' THEN 'balance_sheet' ELSE 'profit_loss' END,jsonb_build_object('from',start_date,'to',end_date,'as_of',end_date));
 actual:=balance||actual;
 IF controls?'expected' THEN
  IF NOT(expected ?& CASE WHEN controls->>'kind'='opening_balances' THEN ARRAY['assets_cents','liabilities_cents','equity_total_cents'] ELSE ARRAY['income_cents','expense_cents','net_income_cents'] END) THEN RAISE EXCEPTION 'ACCT_CONTROL_TOTALS_REQUIRED';END IF;
  FOR value_key,expected_value IN SELECT key,value FROM jsonb_each_text(expected) LOOP
   actual_value:=actual->>value_key;
   IF actual_value IS NULL OR expected_value!~'^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_UNKNOWN_CONTROL';END IF;
   difference:=difference||jsonb_build_object(value_key,(actual_value::numeric-expected_value::numeric)::text);
   IF actual_value::numeric<>expected_value::numeric THEN difference_count:=difference_count+1;END IF;
  END LOOP;
 ELSE
  IF jsonb_typeof(controls->'monthly') IS DISTINCT FROM 'array' OR jsonb_typeof(controls->'accounts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_CONTROL_TOTALS_REQUIRED';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'monthly') m GROUP BY date_trunc('month',(m->>'from')::date) HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_DUPLICATE_CONTROL';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'accounts') a WHERE NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id::text=a->>'account_id')) THEN RAISE EXCEPTION 'ACCT_UNKNOWN_CONTROL';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'accounts') a GROUP BY a->>'account_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_DUPLICATE_CONTROL';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(controls->'monthly','[]')) LOOP
   IF (item->>'from')::date<start_date OR (item->>'to')::date>end_date OR (item->>'from')::date>(item->>'to')::date THEN RAISE EXCEPTION 'ACCT_HISTORY_SCOPE';END IF;
   IF (item->>'from')::date<>greatest(start_date,date_trunc('month',(item->>'from')::date)::date) OR (item->>'to')::date<>least(end_date,(date_trunc('month',(item->>'from')::date)+interval '1 month -1 day')::date) THEN RAISE EXCEPTION 'ACCT_HISTORY_SCOPE';END IF;
   period_report:=accounting.report('profit_loss',jsonb_build_object('from',item->'from','to',item->'to'));
   FOREACH value_key IN ARRAY ARRAY['income_cents','expense_cents','net_income_cents'] LOOP
    IF period_report->>value_key IS DISTINCT FROM item->>value_key THEN difference_count:=difference_count+1;END IF;
   END LOOP;
   monthly:=monthly||jsonb_build_array(jsonb_build_object('from',item->'from','to',item->'to','actual',period_report,'source',item));
  END LOOP;
  IF jsonb_array_length(monthly)<> (extract(year FROM end_date)::integer-extract(year FROM start_date)::integer)*12+extract(month FROM end_date)::integer-extract(month FROM start_date)::integer+1 THEN difference_count:=difference_count+1;END IF;
  balances:=accounting.report('account_balances',jsonb_build_object('from',start_date,'to',end_date));
  FOR item IN SELECT value FROM jsonb_array_elements(balances->'rows') LOOP
   actual_value:=CASE WHEN item->>'account_type' IN ('income','expense') THEN item->>'movement_cents' ELSE item->>'ending_cents' END;
   SELECT value INTO source_row FROM jsonb_array_elements(controls->'accounts') a WHERE a->>'account_id'=item->>'id';
   IF actual_value::numeric<>0 AND source_row IS NULL THEN difference_count:=difference_count+1;
   ELSIF source_row IS NOT NULL AND actual_value IS DISTINCT FROM source_row->>'amount_cents' THEN difference_count:=difference_count+1;END IF;
   account_rows:=account_rows||jsonb_build_array(jsonb_build_object('account_id',item->'id','code',item->'code','name',item->'name','account_type',item->'account_type','actual_cents',actual_value,'source_cents',source_row->'amount_cents','required',actual_value::numeric<>0));
  END LOOP;
  FOREACH value_key IN ARRAY ARRAY['assets_cents','liabilities_cents','equity_total_cents'] LOOP
   IF balance->>value_key IS DISTINCT FROM controls->'totals'->>value_key THEN difference_count:=difference_count+1;END IF;
  END LOOP;
  difference:=jsonb_build_object('differences',difference_count);
  actual:=jsonb_build_object('monthly',monthly,'accounts',account_rows,'totals',balance);
 END IF;
 SELECT count(*) INTO drafts FROM accounting.journal_entries WHERE entry_date BETWEEN start_date AND end_date AND status='draft';
 SELECT count(*) INTO errors FROM accounting.import_rows r JOIN accounting.import_batches b ON b.id=r.batch_id WHERE b.kind='journal' AND (r.parsed->>'entry_date')::date BETWEEN start_date AND end_date AND r.status IN ('ready','exception');
 RETURN jsonb_build_object('from',start_date,'to',end_date,'revision',(SELECT financial_revision::text FROM accounting.settings),'ready',difference_count=0 AND drafts=0 AND errors=0,
 'scope_ended',true,'entity_verified',true,'partial_year',start_date<>make_date(extract(year FROM start_date)::integer,1,1) OR end_date<>make_date(extract(year FROM end_date)::integer,12,31),
 'differences',difference_count,'source_errors',errors,'drafts',drafts,'unclassified_accounts',0,'required_accounts',(SELECT count(*) FROM jsonb_array_elements(account_rows) a WHERE (a->>'required')::boolean),
 'monthly',monthly,'accounts',account_rows,'reports',balance,'actual',actual,'difference',difference);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.import_compare(batch_a uuid, batch_b uuid, filter jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE a accounting.import_batches;b accounting.import_batches;items jsonb;filtered jsonb;start_date date;end_date date;offset_rows integer:=coalesce((filter->>'offset')::integer,0);change_filter text:=coalesce(filter->>'change','all');
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO a FROM accounting.import_batches WHERE id=batch_a;SELECT * INTO b FROM accounting.import_batches WHERE id=batch_b;
 IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
 start_date:=coalesce((filter->>'from')::date,greatest(a.coverage_from,b.coverage_from));end_date:=coalesce((filter->>'to')::date,least(a.coverage_to,b.coverage_to));
 IF batch_a=batch_b OR a.source<>b.source OR a.kind<>b.kind OR a.mapping->>'source_scope' IS DISTINCT FROM b.mapping->>'source_scope' OR start_date<greatest(a.coverage_from,b.coverage_from) OR end_date>least(a.coverage_to,b.coverage_to) OR start_date>end_date OR offset_rows<0 OR change_filter NOT IN ('all','differences','changed','source_only','new','missing','unchanged') THEN RAISE EXCEPTION 'ACCT_IMPORT_COMPARISON_SCOPE';END IF;
 IF (SELECT count(*) FROM accounting.import_rows WHERE batch_id=a.id)<>a.row_count OR (SELECT count(*) FROM accounting.import_rows WHERE batch_id=b.id)<>b.row_count THEN RAISE EXCEPTION 'ACCT_IMPORT_COMPARISON_STAGING';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',coalesce(l.external_id,r.external_id),'external_id',coalesce(l.external_id,r.external_id),'identity_kind',coalesce(l.parsed->>'identity_kind',r.parsed->>'identity_kind'),
  'before_id',l.id,'after_id',r.id,'earlier',CASE WHEN l.id IS NULL THEN NULL ELSE to_jsonb(l)||l.parsed||jsonb_build_object('raw_payload',l.raw) END,'later',CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r)||r.parsed||jsonb_build_object('raw_payload',r.raw) END,
  'change',CASE WHEN l.id IS NULL THEN 'new' WHEN r.id IS NULL THEN 'missing' WHEN l.fingerprint<>r.fingerprint THEN 'changed' WHEN l.parsed->>'source_hash' IS DISTINCT FROM r.parsed->>'source_hash' THEN 'source_only' ELSE 'unchanged' END) ORDER BY coalesce(l.external_id,r.external_id)),'[]') INTO items
  FROM (SELECT * FROM accounting.import_rows WHERE batch_id=batch_a) l FULL JOIN (SELECT * FROM accounting.import_rows WHERE batch_id=batch_b) r ON l.external_id=r.external_id
  WHERE (l.parsed->>'entry_date')::date BETWEEN start_date AND end_date OR (r.parsed->>'entry_date')::date BETWEEN start_date AND end_date;
 SELECT coalesce(jsonb_agg(value),'[]') INTO filtered FROM jsonb_array_elements(items) WHERE change_filter='all' OR (change_filter='differences' AND value->>'change'<>'unchanged') OR value->>'change'=change_filter;
 RETURN jsonb_build_object('batch_a',batch_a,'batch_b',batch_b,'earlier',to_jsonb(a),'later',to_jsonb(b),'from',start_date,'to',end_date,'revision',(SELECT financial_revision::text FROM accounting.settings),
 'mapping_changed',a.mapping->>'mapping_hash' IS DISTINCT FROM b.mapping->>'mapping_hash','basis_changed',a.mapping->>'basis' IS DISTINCT FROM b.mapping->>'basis','uncertain_identity_count',(SELECT count(*) FROM jsonb_array_elements(items) WHERE value->>'identity_kind'='fingerprint_multiplicity'),
 'total',jsonb_array_length(items),'filtered_total',jsonb_array_length(filtered),'offset',offset_rows,'rows',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('status',value->'change')),'[]') FROM (SELECT value FROM jsonb_array_elements(filtered) OFFSET offset_rows LIMIT 50) page),
 'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT value->>'change' status,count(*) n FROM jsonb_array_elements(items) GROUP BY value->>'change') q));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.imports(batch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT jsonb_build_object('batches',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('source_system',b.source,'source_scope',b.mapping->>'source_scope','file_name',b.mapping->>'file_name','mapping_hash',b.mapping->>'mapping_hash','mode',b.kind,'basis',b.mapping->>'basis','expected_groups',b.row_count,'from_date',b.coverage_from,'to_date',b.coverage_to,'error','') ORDER BY b.created_at DESC,b.id),'[]') FROM accounting.import_batches b),
 'groups',(SELECT coalesce(jsonb_agg(to_jsonb(r)||r.parsed||jsonb_build_object('candidate_entry_id',r.duplicate_of_entry_id) ORDER BY r.ordinal),'[]') FROM accounting.import_rows r WHERE batch_id=batch),
 'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}')||jsonb_build_object('new',coalesce(sum(n) FILTER(WHERE status='ready'),0)) FROM (SELECT status,count(*) n FROM accounting.import_rows WHERE batch_id=batch GROUP BY status) x),
 'total',(SELECT count(*) FROM accounting.import_rows WHERE batch_id=batch)) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.ledger(account uuid, from_date date, to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_owner();RETURN accounting.report_lines('general_ledger',jsonb_build_object('from',from_date,'to',to_date),account);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.ledger_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type'; k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid()); actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 e accounting.journal_entries; account_row accounting.accounts; v integer; x jsonb; line jsonb; idx integer; r jsonb; replacement jsonb; reversal jsonb;
 preserved uuid[]:='{}'; seen uuid[]:='{}'; existing_line uuid; original_date date; category uuid; bank_line accounting.journal_lines; total numeric; allocated bigint; remain bigint; share_sum bigint;
BEGIN
 IF t='cash.allocate' THEN
  SELECT * INTO bank_line FROM accounting.journal_lines WHERE id=k;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=bank_line.entry_id;
  IF e.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE';END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=bank_line.account_id AND subtype IN ('bank','cash','card')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED';END IF;
  IF btrim(coalesce(c->>'reason',''))='' OR jsonb_array_length(c->'allocations')<>1 THEN RAISE EXCEPTION 'ACCT_CASH_OVERRIDE_SINGLE_CLASS';END IF;
  IF (c->'allocations'->0->>'amount_cents')::bigint IS DISTINCT FROM bank_line.amount_cents THEN RAISE EXCEPTION 'ACCT_INVALID_CASH_ALLOCATION';END IF;
  UPDATE accounting.journal_lines SET cash_class=CASE c->'allocations'->0->>'classification' WHEN 'internal_transfer' THEN 'transfer' ELSE c->'allocations'->0->>'classification' END WHERE id=k;
  UPDATE accounting.journal_entries SET reason=c->>'reason' WHERE id=e.id RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t='entry.bulkpost' THEN
  r:='[]';
  IF jsonb_typeof(c->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'entries') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
   r:=r||jsonb_build_array(accounting.ledger_command(x||jsonb_build_object('type','entry.post')));
  END LOOP;
  RETURN jsonb_build_object('id',k,'entries',r);
 ELSIF t='chart.seed' THEN
  IF jsonb_typeof(c->'accounts')<>'array' OR jsonb_array_length(c->'accounts') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'accounts') supplied(value) JOIN accounting.accounts a ON a.id=(supplied.value->>'id')::uuid) THEN RAISE EXCEPTION 'ACCT_CHART_EXISTS'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'accounts') LOOP
   PERFORM accounting.ledger_command(x||jsonb_build_object('type','account.create'));
  END LOOP;
  RETURN jsonb_build_object('id',k);
 ELSIF t='account.create' THEN
  INSERT INTO accounting.accounts(id,code,name,type,subtype,is_contra,parent_id,system_purpose,external_names)
  VALUES(k,nullif(c->>'code',''),c->>'name',c->>'account_type',
    CASE WHEN c->>'subtype' IN ('bank','cash','card','receivable','transit','undeposited','fixed_asset','accumulated_depreciation','loan','payroll_liability','owner_equity','retained_earnings','opening_balance','revenue','operating_expense','payroll_expense','other','cogs','uncategorized') THEN c->>'subtype' ELSE coalesce(nullif(nullif(c->>'cash_kind',''),'none'),nullif(c->>'subtype',''),'other') END,
    CASE WHEN c ? 'normal_side' THEN (c->>'normal_side')<>CASE WHEN c->>'account_type' IN ('asset','expense') THEN 'debit' ELSE 'credit' END ELSE coalesce((c->>'is_contra')::boolean,false) END,
    coalesce(c->>'parent_account_id',c->>'parent_id')::uuid,nullif(coalesce(c->>'purpose',c->>'system_purpose'),''),coalesce(c->'external_names','{}')) RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t='account.update' THEN
  SELECT * INTO account_row FROM accounting.accounts WHERE id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM account_row.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.accounts SET name=coalesce(c->>'name',name),code=CASE WHEN c?'code' THEN nullif(c->>'code','') ELSE code END,
   subtype=CASE WHEN c->>'subtype' IN ('bank','cash','card','receivable','transit','undeposited','fixed_asset','accumulated_depreciation','loan','payroll_liability','owner_equity','retained_earnings','opening_balance','revenue','operating_expense','payroll_expense','other','cogs','uncategorized') THEN c->>'subtype' ELSE coalesce(nullif(nullif(c->>'cash_kind',''),'none'),nullif(c->>'subtype',''),subtype) END,
   parent_id=CASE WHEN c?'parent_account_id' OR c?'parent_id' THEN coalesce(c->>'parent_account_id',c->>'parent_id')::uuid ELSE parent_id END,
   system_purpose=CASE WHEN c?'purpose' THEN nullif(c->>'purpose','') ELSE system_purpose END,
   is_archived=coalesce((c->>'is_archived')::boolean,is_archived),external_names=coalesce(c->'external_names',external_names)
   WHERE id=k RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t IN ('draft.save','transaction.save','transaction.review') THEN
  IF jsonb_typeof(c->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'lines')>100 THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  IF FOUND THEN
   IF (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(l.id),ARRAY[]::uuid[]) FROM accounting.journal_lines l WHERE l.entry_id=$1 AND EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id)' INTO preserved USING k;
   END IF;
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND NOT (id=ANY(preserved));
   UPDATE accounting.journal_entries SET entry_date=(c->>'entry_date')::date,memo=c->>'memo',kind=coalesce(c->'context'->>'kind',c->>'kind',kind),
    payee_id=CASE WHEN c?'payee_id' OR c->'context'?'payee_id' THEN coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
  ELSE
   IF coalesce((c->>'expected_version')::integer,-1)<>0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   INSERT INTO accounting.journal_entries(id,entry_date,memo,source_description,origin,kind,payee_id,created_by,import_batch_id,register_id,reason)
    VALUES(k,(c->>'entry_date')::date,c->>'memo',c->>'source_description',coalesce(c->>'origin','manual'),coalesce(c->'context'->>'kind',c->>'kind','manual'),
    coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid,actor,(c->>'import_batch_id')::uuid,(c->>'register_id')::uuid,coalesce(c->>'reason','')) RETURNING version INTO v;
  END IF;
  idx:=0;
  FOR line IN SELECT value FROM jsonb_array_elements(c->'lines') LOOP
   IF coalesce(line->>'amount_cents','') !~ '^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
   SELECT id INTO existing_line FROM accounting.journal_lines WHERE id=ANY(preserved) AND NOT(id=ANY(seen))
    AND account_id=(line->>'account_id')::uuid AND amount_cents=(line->>'amount_cents')::bigint ORDER BY sort_order LIMIT 1;
   IF FOUND THEN
    seen:=array_append(seen,existing_line);
    UPDATE accounting.journal_lines SET memo=coalesce(line->>'memo','') WHERE id=existing_line;
   ELSE
    WHILE EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=k AND sort_order=idx) LOOP idx:=idx+1; END LOOP;
    INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
     VALUES(k,(line->>'account_id')::uuid,(line->>'amount_cents')::bigint,coalesce(line->>'memo',''),idx,line->>'cash_class');
    idx:=idx+1;
   END IF;
  END LOOP;
  IF cardinality(seen)<>cardinality(preserved) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  IF t='transaction.review' THEN
   IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
   RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t IN ('entry.post','entry.discard','draft.discard','entry.reverse','entry.correct','entry.context','entry.categorize','entry.split','entry.annotate') THEN
  IF t='entry.annotate' THEN k:=(c->>'entry_id')::uuid; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF t<>'entry.annotate' AND (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='entry.post' THEN
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
   UPDATE accounting.journal_entries SET status='posted',posted_at=now() WHERE id=k RETURNING version INTO v;
  ELSIF t IN ('entry.discard','draft.discard') THEN
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING k;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING k;
   END IF;
   UPDATE accounting.journal_entries SET status='discarded',reason=c->>'reason' WHERE id=k RETURNING version INTO v;
  ELSIF t IN ('entry.reverse','entry.correct') THEN
   IF e.status<>'posted' THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=k) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
   original_date:=coalesce(c->>'reversal_date',c->>'entry_date')::date;
   IF original_date IS NULL OR original_date<e.entry_date OR btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_INVALID_REVERSAL_DATE_OR_REASON'; END IF;
   INSERT INTO accounting.journal_entries(entry_date,memo,origin,kind,reverses_entry_id,reason,created_by,payee_id)
    VALUES(original_date,'Reversal: '||left(e.memo,990),'internal','correction',e.id,c->>'reason',actor,e.payee_id) RETURNING id,version INTO k,v;
   INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
    SELECT k,account_id,-amount_cents,memo,sort_order,cash_class FROM accounting.journal_lines WHERE entry_id=e.id;
   reversal:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    -- A reversal removes the financial treatment, so its bank evidence returns to review.
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING e.id;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING e.id;
   END IF;
   IF t='entry.correct' THEN
    IF (c->>'entry_date')::date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
    replacement:=accounting.ledger_command(c||jsonb_build_object('type','draft.save','id',coalesce((c->>'replacement_id')::uuid,gen_random_uuid()),'expected_version',0,'origin','internal','kind','correction','payee_id',e.payee_id));
    k:=(replacement->>'id')::uuid;
    UPDATE accounting.journal_entries SET replaces_entry_id=e.id WHERE id=k RETURNING version INTO v;
    replacement:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
    RETURN replacement||jsonb_build_object('reversal_id',reversal->'id','original_id',e.id);
   END IF;
   RETURN reversal;
  ELSIF t IN ('entry.context','entry.annotate') THEN
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),
    payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END,
    kind=CASE WHEN c?'kind' THEN c->>'kind' ELSE kind END,
    reason=coalesce(c->>'note',c->>'reason',reason),register_id=CASE WHEN c?'register_id' THEN (c->>'register_id')::uuid ELSE register_id END WHERE id=k RETURNING version INTO v;
   IF t='entry.annotate' THEN
    INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,after)
     VALUES(auth.uid(),'owner',current_setting('accounting.operation_id')::uuid,'journal_entries',k,'entry.annotate',jsonb_build_object('note_id',c->'id','note',c->'note'));
   END IF;
  ELSE
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   SELECT l.* INTO bank_line FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id
    WHERE l.entry_id=k AND a.subtype IN ('bank','card','cash');
   IF NOT FOUND OR (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.subtype IN ('bank','card','cash'))<>1 THEN RAISE EXCEPTION 'ACCT_SIMPLE_MOVEMENT_REQUIRED'; END IF;
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND id<>bank_line.id;
   -- Preserve the bank line's identity so existing observation matches stay attached.
   IF t='entry.categorize' THEN
    category:=coalesce(c->>'account_id',c->>'category_id')::uuid;
    IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REQUIRED'; END IF;
    INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,sort_order) VALUES(k,category,-bank_line.amount_cents,CASE WHEN bank_line.sort_order=0 THEN 1 ELSE 0 END);
   ELSE
    IF jsonb_typeof(c->'splits') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'splits') NOT BETWEEN 2 AND 99 THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'splits') WHERE (value?'share_bps') IS DISTINCT FROM ((c->'splits'->0)?'share_bps')) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
    IF (c->'splits'->0)?'share_bps' THEN
     SELECT sum((value->>'share_bps')::bigint) INTO share_sum FROM jsonb_array_elements(c->'splits');
     IF share_sum<>10000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'splits') WHERE (value->>'share_bps')::bigint<=0) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
     total:=abs(bank_line.amount_cents::numeric);
     SELECT (total-sum(trunc(total*(value->>'share_bps')::numeric/10000)))::bigint INTO remain FROM jsonb_array_elements(c->'splits');
    END IF;
    -- Allocation below works for exact-cent splits or basis-point shares without floating point.
    idx:=0; total:=0;
    FOR line IN SELECT value FROM jsonb_array_elements(c->'splits') LOOP
     IF line?'share_bps' THEN
      SELECT (trunc(abs(bank_line.amount_cents::numeric)*(line->>'share_bps')::numeric/10000)+CASE WHEN rank<=remain THEN 1 ELSE 0 END)::bigint * CASE WHEN bank_line.amount_cents>0 THEN -1 ELSE 1 END INTO allocated
      FROM (SELECT ordinality-1 ordinal,row_number() OVER(ORDER BY mod(abs(bank_line.amount_cents::numeric)*(value->>'share_bps')::numeric,10000) DESC,ordinality) rank FROM jsonb_array_elements(c->'splits') WITH ORDINALITY) ranked WHERE ordinal=idx;
     ELSE
      IF coalesce(line->>'amount_cents','')!~'^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
      allocated:=(line->>'amount_cents')::bigint;
     END IF;
     IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(line->>'account_id')::uuid AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REQUIRED'; END IF;
     IF allocated=0 OR sign(allocated)=sign(bank_line.amount_cents) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
     total:=total+allocated;
     INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order) VALUES(k,(line->>'account_id')::uuid,allocated,coalesce(line->>'memo',''),CASE WHEN idx>=bank_line.sort_order THEN idx+1 ELSE idx END);
     idx:=idx+1;
    END LOOP;
    IF total<>-bank_line.amount_cents THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
   END IF;
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),kind=coalesce(c->>'kind',kind),payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
   IF coalesce((c->>'remember')::boolean,false) AND e.descriptor_key IS NOT NULL THEN
    PERFORM accounting.banking_command(jsonb_build_object('type','alias.save','id',gen_random_uuid(),'party_id',c->'payee_id','match_kind','key','pattern',e.descriptor_key,'enabled',true,'expected_version',0));
   END IF;
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.match_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE key uuid; total numeric; zero_evidence boolean; observation accounting.bank_transactions;
BEGIN
 IF TG_OP='DELETE' THEN key:=OLD.bank_transaction_id; ELSE key:=NEW.bank_transaction_id; END IF;
 SELECT * INTO observation FROM accounting.bank_transactions WHERE id=key;
 SELECT coalesce(sum(amount_cents),0),coalesce(bool_or(amount_cents=0),false) INTO total,zero_evidence FROM accounting.bank_matches WHERE bank_transaction_id=key;
 UPDATE accounting.bank_transactions SET review=CASE WHEN total=abs(observation.amount_cents::numeric) OR zero_evidence THEN 'matched' ELSE 'unmatched' END WHERE id=key;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.operate(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c jsonb:=command->'command'; key uuid:=(command->>'key')::uuid; actor uuid; receipt accounting.command_receipts; hash text; result jsonb; t text; current_version integer; initialized boolean:=false;
BEGIN
 IF key IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM accounting.write_lock();
 t:=c->>'type'; actor:=auth.uid();
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t='settings.save' AND NOT EXISTS(SELECT 1 FROM accounting.settings) THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO accounting.settings(owner_user_id) VALUES(actor); initialized:=true;
 END IF;
 actor:=accounting.require_owner(); hash:=encode(sha256(convert_to(c::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM accounting.command_receipts WHERE idempotency_key=key;
 IF FOUND THEN
  IF receipt.actor_user_id<>actor OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 IF c?'expected_revision' AND (c->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM accounting.settings WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_REVISION'; END IF;
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t IN ('settings.save','preferences.save') THEN
  SELECT version INTO current_version FROM accounting.settings WHERE id=1;
  IF (c->>'expected_version')::integer IS DISTINCT FROM current_version AND NOT (initialized AND coalesce((c->>'expected_version')::integer,0)=0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.settings SET primary_system=coalesce(c->>'primary_system',CASE c->>'authority_mode' WHEN 'admin_primary' THEN 'admin' WHEN 'wave_primary' THEN 'wave' WHEN 'parallel_pilot' THEN 'wave' END,primary_system),
   primary_system_since=CASE WHEN c?'primary_system_since' THEN (c->>'primary_system_since')::date ELSE primary_system_since END,
   transfer_window_days=coalesce((c->>'transfer_window_days')::smallint,transfer_window_days),version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  IF c?'business_profile' THEN
   IF (c->>'profile_version')::integer IS DISTINCT FROM (SELECT version FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(c->'business_profile') k WHERE k NOT IN ('legal_name','dba','entity_type','ein','formation_date','state_of_formation','address','phone','email','tax_classification','tax_classification_since','home_state','is_sstb','fiscal_year_start_month','books_timezone','earliest_history_date','owner_name','owner_title','accountant_name','accountant_email','default_email_account_id')) THEN RAISE EXCEPTION 'ACCT_INVALID_PROFILE'; END IF;
   UPDATE public.business_profile p SET (legal_name,dba,entity_type,ein,formation_date,state_of_formation,address,phone,email,tax_classification,tax_classification_since,home_state,is_sstb,fiscal_year_start_month,books_timezone,earliest_history_date,owner_name,owner_title,accountant_name,accountant_email,default_email_account_id)=
    (SELECT v.legal_name,v.dba,v.entity_type,v.ein,v.formation_date,v.state_of_formation,v.address,v.phone,v.email,v.tax_classification,v.tax_classification_since,v.home_state,v.is_sstb,v.fiscal_year_start_month,v.books_timezone,v.earliest_history_date,v.owner_name,v.owner_title,v.accountant_name,v.accountant_email,v.default_email_account_id FROM jsonb_populate_record(p,c->'business_profile') v) WHERE p.id=1;
  ELSIF c?'legal_name' OR c->>'history_start' IS NOT NULL THEN
   UPDATE public.business_profile SET legal_name=coalesce(c->>'legal_name',legal_name),earliest_history_date=coalesce((c->>'history_start')::date,earliest_history_date) WHERE id=1;
  END IF;
  result:=jsonb_build_object('id',coalesce(c->>'id','1'),'version',current_version);
 ELSIF t LIKE 'account.%' OR t='chart.seed' OR t LIKE 'entry.%' OR t LIKE 'draft.%' OR t LIKE 'transaction.%' OR t='cash.allocate' THEN result:=accounting.ledger_command(c);
 ELSIF t LIKE 'bank.%' OR t LIKE 'feed.%' OR t LIKE 'transfer.%' OR t LIKE 'party.%' OR t LIKE 'alias.%' OR t LIKE 'rule.%' OR t LIKE 'document.%' THEN result:=accounting.banking_command(c);
 ELSIF t LIKE 'import.%' OR t LIKE 'history.%' THEN result:=accounting.history_command(c);
 ELSIF t LIKE 'period.%' OR t LIKE 'reconciliation.%' THEN result:=accounting.close_command(c);
 ELSIF t LIKE 'payroll.%' OR t LIKE 'register.%' THEN result:=accounting.register_command(c);
 ELSIF t LIKE 'tax.%' THEN result:=accounting.tax_command(c);
 ELSIF t LIKE 'report.%' OR t LIKE 'package.%' THEN result:=accounting.report_command(c);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 INSERT INTO accounting.command_receipts(idempotency_key,payload_hash,actor_user_id,result) VALUES(key,hash,actor,result);
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.payroll(view jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;employees jsonb;coverage jsonb;cutoff date:=coalesce((view->>'through')::date,(view->>'to')::date,(view->>'as_of')::date,(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile));y integer:=coalesce((view->>'year')::integer,extract(year FROM cutoff)::integer);latest accounting.payroll_runs;run accounting.payroll_runs;body jsonb;preview jsonb;record jsonb;posting jsonb;
BEGIN
 PERFORM accounting.require_owner();
 IF view->>'view'='detail' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=(view->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  body:=jsonb_build_object('pay_date',run.pay_date,'period_from',run.period_start,'period_to',run.period_end,'declared_gross_cents',run.gross_cents::text,'declared_net_cents',run.net_cents::text,'components',run.components,'employees',coalesce(run.ytd->'run_employees','[]'),'ytd',run.ytd);
  posting:=CASE WHEN run.entry_id IS NULL THEN NULL ELSE jsonb_build_object('id',run.entry_id,'entry_id',run.entry_id,'mode','new','void',(SELECT jsonb_build_object('effective_date',entry_date,'reason',reason,'reversal_entry_id',id) FROM accounting.journal_entries WHERE reverses_entry_id=run.entry_id)) END;
  record:=jsonb_build_object('run_id',run.id,'revision',run.version,'body',body,'body_text',body::text,'body_hash',encode(sha256(convert_to(body::text,'UTF8')),'hex'),'document_id',run.document_id,'reason','','created_at',run.updated_at,'posting',posting);
  IF run.status='draft' THEN
   BEGIN preview:=accounting.payroll_plan(view);EXCEPTION WHEN raise_exception THEN preview:=jsonb_build_object('ready',false,'issues',jsonb_build_array(SQLERRM),'lines','[]'::jsonb,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text,'officer_cents','0','other_wages_cents','0','reimbursements_cents','0'));END;
  ELSE preview:=jsonb_build_object('ready',false,'issues','[]'::jsonb,'lines',CASE WHEN run.entry_id IS NULL THEN '[]'::jsonb ELSE accounting.entry_detail(run.entry_id)->'lines' END,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text));END IF;
  RETURN jsonb_build_object('id',run.id,'version',run.version,'provider_run_id',run.provider_run_id,'head_revision',run.version,'status',CASE run.status WHEN 'void' THEN 'voided' ELSE run.status END,'register',record,'preview',preview,'posting',posting,
   'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('run_id',run.id,'revision',a.after->'version','body',a.after,'document_id',a.after->'document_id','reason',a.reason,'created_at',a.at) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.table_name='payroll_runs' AND a.row_id=run.id),'history_count',(SELECT count(*) FROM accounting.audit_log WHERE table_name='payroll_runs' AND row_id=run.id),'history_offset',0);
 END IF;

 IF view?'year' AND NOT (view?'through' OR view?'to' OR view?'as_of') THEN cutoff:=make_date(y,12,31);END IF;
 WITH filtered AS (
  SELECT * FROM accounting.payroll_runs r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'year' IS NULL OR extract(year FROM pay_date)=y) AND pay_date<=cutoff
   AND (view->>'from' IS NULL OR pay_date>=(view->>'from')::date) AND (view->>'status' IS NULL OR r.status=CASE view->>'status' WHEN 'voided' THEN 'void' ELSE view->>'status' END)
   AND (coalesce(view->>'query','')='' OR r.provider_run_id ILIKE '%'||(view->>'query')||'%')
 ), paged AS (SELECT * FROM filtered ORDER BY pay_date DESC,id LIMIT 100 OFFSET greatest(coalesce((view->>'offset')::integer,0),0))
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rows',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('gross_cents',gross_cents::text,'net_cents',net_cents::text,'employee_withholding_cents',employee_withholding_cents::text,'employer_tax_cents',employer_tax_cents::text) ORDER BY pay_date DESC,id),'[]') FROM paged r),
 'count',count(*),'totals',jsonb_build_object('gross_cents',coalesce(sum(gross_cents) FILTER(WHERE status<>'void'),0)::text,'net_cents',coalesce(sum(net_cents) FILTER(WHERE status<>'void'),0)::text,'drafts',count(*) FILTER(WHERE status='draft'))) INTO result FROM filtered;

 WITH active_runs AS (
  SELECT * FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff)
 ), per_employee AS (
  SELECT x.value FROM active_runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.ytd->'run_employees','[]')) x
 ), employee_totals AS (
  SELECT value->>'key' key,max(value->>'name') name,bool_or((value->>'is_officer')::boolean) is_officer,sum((value->>'gross_cash_cents')::numeric) gross,
   CASE WHEN bool_and(value->>'federal_taxable_cents' IS NOT NULL) THEN sum((value->>'federal_taxable_cents')::numeric)::text END federal_taxable,
   CASE WHEN bool_and(value->>'federal_withheld_cents' IS NOT NULL) THEN sum((value->>'federal_withheld_cents')::numeric)::text END federal_withheld,
   CASE WHEN bool_and(value->>'state_taxable_cents' IS NOT NULL) THEN sum((value->>'state_taxable_cents')::numeric)::text END state_taxable,
   CASE WHEN bool_and(value->>'state_withheld_cents' IS NOT NULL) THEN sum((value->>'state_withheld_cents')::numeric)::text END state_withheld,
   CASE WHEN bool_and(value->>'social_security_wages_cents' IS NOT NULL) THEN sum((value->>'social_security_wages_cents')::numeric)::text END social_security,
   CASE WHEN bool_and(value->>'medicare_wages_cents' IS NOT NULL) THEN sum((value->>'medicare_wages_cents')::numeric)::text END medicare
  FROM per_employee GROUP BY value->>'key')
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'name',name,'is_officer',is_officer,'gross_cash_cents',gross::text,'federal_taxable_cents',federal_taxable,'federal_withheld_cents',federal_withheld,'state_taxable_cents',state_taxable,'state_withheld_cents',state_withheld,'social_security_wages_cents',social_security,'medicare_wages_cents',medicare) ORDER BY name,key),'[]') INTO employees FROM employee_totals;
 SELECT p.* INTO latest FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff) ORDER BY p.pay_date DESC,p.created_at DESC,p.id LIMIT 1;
 IF latest.ytd->>'verified'='true' THEN coverage:=jsonb_build_object('id',latest.id,'tax_year',y,'version',latest.version,'through_date',cutoff,'source_through_date',latest.pay_date,'current',EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=latest.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)),'employees',coalesce(latest.ytd->'employees','[]'),'document_id',latest.document_id,'reason','Verified YTD from the latest recorded payroll run.','created_at',latest.created_at);END IF;
 result:=result||jsonb_build_object('year',y,'through',cutoff,'employees',employees,'coverage',coverage,
  'run_count',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff)),
  'drafts',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.status='draft' AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff));
 result:=result||jsonb_build_object('as_of',cutoff,'offset',coalesce((view->>'offset')::integer,0),'runs',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('head_revision',value->'version','status',CASE value->>'status' WHEN 'void' THEN 'voided' ELSE value->>'status' END)),'[]') FROM jsonb_array_elements(result->'rows')));
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.payroll_plan(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE run accounting.payroll_runs;mode text:=coalesce(c->>'template','cash');bank uuid;wages uuid;taxes uuid;lines jsonb:='[]';x jsonb;amount bigint;action_kind text;
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO run FROM accounting.payroll_runs WHERE id=(c->>'id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
   IF run.status<>'draft' THEN RAISE EXCEPTION 'ACCT_PAYROLL_ALREADY_POSTED';END IF;
   IF c->>'verified'='false' THEN RAISE EXCEPTION 'ACCT_PAYROLL_EVIDENCE';END IF;
   IF jsonb_array_length(coalesce(run.ytd->'run_employees','[]'))>0 THEN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.ytd->'run_employees') WHERE coalesce(value->>'gross_cash_cents','')!~'^[0-9]+$') OR
     (SELECT sum((value->>'gross_cash_cents')::numeric) FROM jsonb_array_elements(run.ytd->'run_employees'))<>run.gross_cents OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(run.ytd->'run_employees') GROUP BY value->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_PAYROLL_EMPLOYEE_TOTALS';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) WHERE value->>'kind' IN ('officer_wages','other_wages')) AND
     (SELECT coalesce(sum((value->>'gross_cash_cents')::numeric),0) FROM jsonb_array_elements(run.ytd->'run_employees') WHERE value->>'is_officer'='true')<>
     (SELECT coalesce(sum((value->>'amount_cents')::numeric),0) FROM jsonb_array_elements(run.components) WHERE value->>'kind'='officer_wages') THEN RAISE EXCEPTION 'ACCT_PAYROLL_EMPLOYEE_TOTALS';END IF;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=run.document_id AND d.status<>'archived') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employee_tax') AND (SELECT sum((component.value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employee_tax')<>run.employee_withholding_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employer_tax') AND (SELECT sum((component.value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employer_tax')<>run.employer_tax_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) WHERE value->>'kind'='net_pay') AND (SELECT sum((value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) WHERE value->>'kind'='net_pay')<>run.net_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   IF mode='cash' THEN
    IF run.gross_cents<>run.net_cents+run.employee_withholding_cents OR EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) WHERE value->>'kind' NOT IN ('officer_wages','other_wages','net_pay','employee_tax','employer_tax')) THEN RAISE EXCEPTION 'ACCT_CASH_PAYROLL_COMPONENTS_REQUIRE_EXPLICIT_TEMPLATE';END IF;
    bank:=(c->>'bank_account_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=bank AND subtype IN ('bank','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED';END IF;
    SELECT id INTO wages FROM accounting.accounts WHERE system_purpose='officer_wages';SELECT id INTO taxes FROM accounting.accounts WHERE system_purpose='employer_payroll_taxes';
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind' IN ('officer_wages','other_wages')) THEN
     IF (SELECT sum((component.value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind' IN ('officer_wages','other_wages'))<>run.gross_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
     FOR x IN SELECT value FROM jsonb_array_elements(run.components) WHERE value->>'kind' IN ('officer_wages','other_wages') LOOP
      IF x->>'kind'='other_wages' AND x->>'account_id' IS NULL THEN RAISE EXCEPTION 'ACCT_PAYROLL_WAGE_ACCOUNT_REQUIRED';END IF;
      IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=coalesce((x->>'account_id')::uuid,wages) AND type='expense') THEN RAISE EXCEPTION 'ACCT_PAYROLL_WAGE_ACCOUNT_REQUIRED';END IF;
      lines:=lines||jsonb_build_array(jsonb_build_object('account_id',coalesce((x->>'account_id')::uuid,wages),'amount_cents',x->>'amount_cents'));
     END LOOP;
    ELSE lines:=jsonb_build_array(jsonb_build_object('account_id',wages,'amount_cents',run.gross_cents::text));END IF;
    lines:=lines||jsonb_build_array(jsonb_build_object('account_id',taxes,'amount_cents',run.employer_tax_cents::text),jsonb_build_object('account_id',bank,'amount_cents',(-run.net_cents)::text),jsonb_build_object('account_id',bank,'amount_cents',(-run.employee_withholding_cents-run.employer_tax_cents)::text));
   ELSIF mode='accrual' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(run.components) LOOP
     amount:=(x->>'amount_cents')::bigint;action_kind:=x->>'kind';
     IF action_kind IN ('officer_wages','other_wages','reimbursement','employer_tax','employer_retirement','employer_benefit','provider_fee','noncash_reclass') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(x->>'account_id')::uuid AND type='expense') THEN RAISE EXCEPTION 'ACCT_PAYROLL_EXPENSE_ACCOUNT';END IF;
     IF action_kind IN ('net_pay','employee_tax','retirement_deferral','other_deduction') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(x->>'account_id')::uuid AND type='liability') THEN RAISE EXCEPTION 'ACCT_PAYROLL_LIABILITY_ACCOUNT';END IF;
     IF action_kind IN ('employer_tax','employer_retirement','employer_benefit','provider_fee') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(x->>'offset_account_id')::uuid AND type='liability') THEN RAISE EXCEPTION 'ACCT_PAYROLL_LIABILITY_ACCOUNT';END IF;
     IF action_kind IN ('officer_wages','other_wages','reimbursement') THEN lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',amount::text));
     ELSIF action_kind IN ('net_pay','employee_tax','retirement_deferral','other_deduction') THEN lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',(-amount)::text));
     ELSIF action_kind='noncash_reclass' THEN
      IF NOT EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.id=(x->>'source_line_id')::uuid AND l.account_id=(x->>'offset_account_id')::uuid AND l.amount_cents>0 AND e.status='posted' AND e.entry_date<=run.pay_date AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)) THEN RAISE EXCEPTION 'ACCT_NONCASH_SOURCE_REQUIRED';END IF;
      IF (SELECT sum((part.value->>'amount_cents')::numeric) FROM jsonb_array_elements(run.components) part(value) WHERE part.value->>'kind'='noncash_reclass' AND part.value->>'source_line_id'=x->>'source_line_id')+coalesce((SELECT sum((component.value->>'amount_cents')::bigint) FROM accounting.payroll_runs p CROSS JOIN LATERAL jsonb_array_elements(p.components) component(value) WHERE p.status='posted' AND component.value->>'kind'='noncash_reclass' AND component.value->>'source_line_id'=x->>'source_line_id'),0)>(SELECT amount_cents FROM accounting.journal_lines WHERE id=(x->>'source_line_id')::uuid) THEN RAISE EXCEPTION 'ACCT_NONCASH_CAPACITY';END IF;
      lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',amount::text),jsonb_build_object('account_id',x->'offset_account_id','amount_cents',(-amount)::text));
     ELSIF action_kind IN ('employer_tax','employer_retirement','employer_benefit','provider_fee') THEN lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',amount::text),jsonb_build_object('account_id',x->'offset_account_id','amount_cents',(-amount)::text));
     ELSE RAISE EXCEPTION 'ACCT_PAYROLL_UNSUPPORTED_COMPONENT';END IF;
    END LOOP;
    IF (SELECT coalesce(sum((value->>'amount_cents')::bigint),0) FROM jsonb_array_elements(run.components) WHERE value->>'kind' IN ('officer_wages','other_wages'))<>run.gross_cents OR (SELECT coalesce(sum((value->>'amount_cents')::bigint),0) FROM jsonb_array_elements(run.components) WHERE value->>'kind'='net_pay')<>run.net_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   ELSE RAISE EXCEPTION 'ACCT_PAYROLL_TEMPLATE';END IF;
   SELECT coalesce(jsonb_agg(value),'[]') INTO lines FROM jsonb_array_elements(lines) WHERE (value->>'amount_cents')::bigint<>0;
 IF jsonb_array_length(lines)<2 OR (SELECT sum((value->>'amount_cents')::numeric) FROM jsonb_array_elements(lines))<>0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED';END IF;
 RETURN jsonb_build_object('ready',true,'issues','[]'::jsonb,'lines',lines,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text,
 'officer_cents',(SELECT coalesce(sum((value->>'amount_cents')::numeric),0)::text FROM jsonb_array_elements(run.components) WHERE value->>'kind'='officer_wages'),'other_wages_cents',(SELECT coalesce(sum((value->>'amount_cents')::numeric),0)::text FROM jsonb_array_elements(run.components) WHERE value->>'kind'='other_wages'),'reimbursements_cents',(SELECT coalesce(sum((value->>'amount_cents')::numeric),0)::text FROM jsonb_array_elements(run.components) WHERE value->>'kind'='reimbursement')));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.prior_summary(key text, bank_account uuid, max_rows integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 WITH matched AS (
  SELECT e.* FROM accounting.journal_entries e WHERE e.status='posted' AND e.descriptor_key=key
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries reversal WHERE reversal.reverses_entry_id=e.id)
   AND e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id=bank_account)
 ), recent AS (SELECT * FROM matched ORDER BY entry_date DESC,created_at DESC,id LIMIT greatest(1,least(max_rows,100)))
 SELECT jsonb_build_object('count',(SELECT count(*) FROM matched),'last_date',(SELECT max(entry_date) FROM matched),
  'last_category',(SELECT l.account_id FROM recent e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE l.account_id<>bank_account ORDER BY e.entry_date DESC,e.created_at DESC,l.sort_order LIMIT 1),
  'payee_id',(SELECT payee_id FROM recent ORDER BY entry_date DESC,created_at DESC,id LIMIT 1),
  'memo',(SELECT memo FROM recent ORDER BY entry_date DESC,created_at DESC,id LIMIT 1),
  'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'payee_id',e.payee_id,'entry_date',e.entry_date,
   'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id<>bank_account)) ORDER BY e.entry_date DESC,e.created_at DESC,e.id) FROM recent e),'[]')) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.prior_treatment(descriptor_key text, bank_account_id uuid, max_rows integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN PERFORM accounting.require_owner(); RETURN accounting.prior_summary(descriptor_key,bank_account_id,max_rows); END $function$
;

CREATE OR REPLACE FUNCTION accounting.record_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE b jsonb; a jsonb; payload jsonb; actor uuid:=auth.uid(); op uuid; kind text; identity text; action_name text; money_key text;
BEGIN
 b:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END; a:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='settings' AND TG_OP='UPDATE' AND (b-'financial_revision')=(a-'financial_revision') THEN RETURN NULL; END IF;
 FOR money_key IN SELECT unnest(ARRAY['amount_cents','financial_revision','size_bytes','observed_balance_cents','gross_cents','net_cents','employee_withholding_cents','employer_tax_cents','difference_cents','opening_balance_cents','ending_balance_cents']) LOOP
  IF b?money_key AND b->money_key<>'null'::jsonb THEN b:=jsonb_set(b,ARRAY[money_key],to_jsonb(b->>money_key)); END IF;
  IF a?money_key AND a->money_key<>'null'::jsonb THEN a:=jsonb_set(a,ARRAY[money_key],to_jsonb(a->>money_key)); END IF;
 END LOOP;
 IF TG_TABLE_NAME='bank_connections' THEN
  b:=b-ARRAY['access_url_encrypted','checkpoint','last_error']; a:=a-ARRAY['access_url_encrypted','checkpoint','last_error'];
 END IF;
 IF TG_TABLE_NAME='bank_transactions' THEN b:=b-'raw_payload'; a:=a-'raw_payload'; END IF;
 IF TG_TABLE_NAME='tax_links' THEN b:=b-ARRAY['inputs','results','forecast_inputs']; a:=a-ARRAY['inputs','results','forecast_inputs']; END IF;
 op:=coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid());
 kind:=coalesce(nullif(current_setting('accounting.actor_kind',true),''),CASE WHEN actor IS NULL THEN 'system' ELSE 'owner' END);
 IF kind<>'owner' THEN actor:=NULL; END IF;
 payload:=coalesce(a,b); identity:=coalesce(payload->>'id',payload->>'month',payload->>'idempotency_key','1');
 action_name:=coalesce(nullif(current_setting('accounting.action',true),''),lower(TG_OP));
 INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after,reason)
 VALUES(actor,kind,op,TG_TABLE_NAME,CASE WHEN identity ~ '^[0-9a-f-]{36}$' THEN identity::uuid ELSE md5(TG_TABLE_NAME||':'||identity)::uuid END,action_name,b,a,coalesce(nullif(current_setting('accounting.reason',true),''),payload->>'reason',''));
 IF TG_TABLE_NAME IN ('accounts','journal_entries','journal_lines','tax_mappings','tax_adjustments','payroll_runs','registers') THEN
  UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 END IF;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.register_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type';key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=accounting.require_owner();run accounting.payroll_runs;reg accounting.registers;
 body jsonb:=coalesce(c->'body',c);components jsonb;lines jsonb:='[]';result jsonb;x jsonb;config jsonb;v integer;gross bigint;net bigint;withheld bigint;employer bigint;bank uuid;wages uuid;taxes uuid;entry uuid;amount bigint;cost bigint;depreciation bigint;principal bigint;total bigint;action_kind text;mode text:=coalesce(c->>'template','cash');action_date date;candidate_count integer;source_id uuid;bank_line record;discarded jsonb;match_list jsonb;
BEGIN
 IF t='payroll.save' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(run.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF run.status IS NOT NULL AND run.status<>'draft' THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
  PERFORM accounting.require_open((body->>'pay_date')::date);
  components:=coalesce(body->'components','[]');gross:=coalesce(body->>'gross_cents',body->>'declared_gross_cents')::bigint;net:=coalesce(body->>'net_cents',body->>'declared_net_cents')::bigint;
  SELECT coalesce(sum((value->>'amount_cents')::bigint) FILTER(WHERE value->>'kind'='employee_tax'),0),coalesce(sum((value->>'amount_cents')::bigint) FILTER(WHERE value->>'kind'='employer_tax'),0) INTO withheld,employer FROM jsonb_array_elements(components);
  withheld:=coalesce((body->>'employee_withholding_cents')::bigint,withheld);employer:=coalesce((body->>'employer_tax_cents')::bigint,employer);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(components) WHERE coalesce(value->>'amount_cents','')!~'^[0-9]+$' OR (value->>'amount_cents')::numeric>9223372036854775807) THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS';END IF;
  INSERT INTO accounting.payroll_runs(id,provider_run_id,pay_date,period_start,period_end,gross_cents,net_cents,employee_withholding_cents,employer_tax_cents,components,document_id,ytd,created_by)
   VALUES(key,c->>'provider_run_id',(body->>'pay_date')::date,coalesce(body->>'period_start',body->>'period_from')::date,coalesce(body->>'period_end',body->>'period_to')::date,gross,net,withheld,employer,components,(c->>'document_id')::uuid,
    coalesce(c->'ytd',body->'ytd',jsonb_build_object('verified',false))||jsonb_build_object('run_employees',coalesce(body->'employees','[]')),actor)
   ON CONFLICT(id) DO UPDATE SET provider_run_id=excluded.provider_run_id,pay_date=excluded.pay_date,period_start=excluded.period_start,period_end=excluded.period_end,gross_cents=excluded.gross_cents,net_cents=excluded.net_cents,employee_withholding_cents=excluded.employee_withholding_cents,employer_tax_cents=excluded.employer_tax_cents,components=excluded.components,document_id=excluded.document_id,ytd=excluded.ytd RETURNING version INTO v;
 ELSIF t IN ('payroll.post','payroll.approve','payroll.void','payroll.discard') THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF run.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='payroll.discard' THEN
   IF run.status<>'draft' OR btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_PAYROLL_DISCARD';END IF;
   UPDATE accounting.payroll_runs SET status='void' WHERE id=key RETURNING version INTO v;
  ELSIF t='payroll.void' THEN
   IF run.status<>'posted' THEN RAISE EXCEPTION 'ACCT_PAYROLL_NOT_POSTED';END IF;
   result:=accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',run.entry_id,'expected_version',(SELECT version FROM accounting.journal_entries WHERE id=run.entry_id),'entry_date',c->>'effective_date','reason',c->>'reason'));
   UPDATE accounting.payroll_runs SET status='void' WHERE id=key RETURNING version INTO v;
  ELSE
   result:=accounting.payroll_plan(c);lines:=result->'lines';bank:=(c->>'bank_account_id')::uuid;
   IF coalesce(c->>'mode','new')='historical' THEN
    entry:=(c->>'entry_id')::uuid;
    IF c?'entry_version' AND (c->>'entry_version')::integer IS DISTINCT FROM (SELECT version FROM accounting.journal_entries WHERE id=entry) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
    IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=entry) THEN RAISE EXCEPTION 'ACCT_REVERSED_ENTRY';END IF;
    IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=entry AND status='posted' AND entry_date=run.pay_date) OR
     (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM accounting.journal_lines WHERE entry_id=entry) IS DISTINCT FROM
     (SELECT jsonb_agg(jsonb_build_array((value->>'account_id')::uuid,((value->>'amount_cents')::bigint)::text) ORDER BY (value->>'account_id')::uuid,(value->>'amount_cents')::bigint) FROM jsonb_array_elements(lines)) THEN RAISE EXCEPTION 'ACCT_PAYROLL_JOURNAL_MISMATCH';END IF;
   ELSE
    result:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',run.pay_date,'memo','Payroll '||run.provider_run_id,'kind','payroll','lines',lines));
    result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',result->'id','expected_version',result->'version'));entry:=(result->>'id')::uuid;
   END IF;
   UPDATE accounting.payroll_runs SET status='posted',entry_id=entry WHERE id=key RETURNING version INTO v;
   INSERT INTO accounting.document_links(document_id,payroll_run_id,created_by) VALUES(run.document_id,key,actor) ON CONFLICT DO NOTHING;
   match_list:=coalesce(c->'bank_matches','[]');
   IF jsonb_array_length(match_list)=0 AND mode='cash' THEN
    FOR bank_line IN SELECT * FROM accounting.journal_lines WHERE entry_id=entry AND account_id=bank LOOP
     SELECT count(*),(array_agg(o.id ORDER BY o.id))[1] INTO candidate_count,source_id FROM accounting.bank_transactions o JOIN accounting.bank_accounts ba ON ba.id=o.bank_account_id
      WHERE ba.account_id=bank AND o.amount_cents=bank_line.amount_cents AND o.state='posted' AND o.review<>'excluded' AND abs(o.posted_date-run.pay_date)<=(SELECT transfer_window_days FROM accounting.settings)
      AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND e.status='posted');
     IF candidate_count=1 THEN match_list:=match_list||jsonb_build_array(jsonb_build_object('bank_transaction_id',source_id,'sort_order',bank_line.sort_order,'amount_cents',abs(bank_line.amount_cents)::text));END IF;
    END LOOP;
   END IF;
   FOR x IN SELECT value FROM jsonb_array_elements(match_list) LOOP
    SELECT coalesce(jsonb_agg(d),'[]') INTO discarded FROM (
     SELECT DISTINCT jsonb_build_object('id',e.id,'expected_version',e.version) d FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id
     WHERE m.bank_transaction_id=(x->>'bank_transaction_id')::uuid AND e.status='draft' AND e.origin IN ('csv','simplefin')) q;
    PERFORM set_config('accounting.reason','Matched payroll register',true);
    PERFORM accounting.banking_command(jsonb_build_object('type','bank.match','id',gen_random_uuid(),'bank_transaction_id',x->'bank_transaction_id','reason','Matched payroll register','discard_drafts',discarded,
      'allocations',jsonb_build_array(jsonb_build_object('line_id',(SELECT id FROM accounting.journal_lines WHERE entry_id=entry AND sort_order=(x->>'sort_order')::integer),'amount_cents',x->'amount_cents'))));
   END LOOP;
  END IF;
 ELSIF t='register.save' THEN
  SELECT * INTO reg FROM accounting.registers WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(reg.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  action_kind:=CASE WHEN c->>'kind'='asset' THEN 'fixed_asset' ELSE c->>'kind' END;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(body->>'account_id')::uuid AND type=CASE action_kind WHEN 'fixed_asset' THEN 'asset' ELSE 'liability' END AND subtype=CASE action_kind WHEN 'fixed_asset' THEN 'fixed_asset' ELSE 'loan' END) THEN RAISE EXCEPTION 'ACCT_REGISTER_ACCOUNT_TYPE';END IF;
  IF action_kind='fixed_asset' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=coalesce(body->>'contra_account_id',body->>'accumulated_account_id')::uuid AND type='asset' AND is_contra) THEN RAISE EXCEPTION 'ACCT_REGISTER_CONTRA_REQUIRED';END IF;
  config:=jsonb_strip_nulls(jsonb_build_object('kind','configuration','expense_account_id',body->'expense_account_id','fee_account_id',body->'fee_account_id','lender',body->'lender','document_id',c->'document_id'));
  INSERT INTO accounting.registers(id,kind,name,account_id,contra_account_id,started_on,amount_cents,in_service_on,method,schedule,notes)
   VALUES(key,action_kind,body->>'name',(body->>'account_id')::uuid,coalesce(body->>'contra_account_id',body->>'accumulated_account_id')::uuid,(body->>'started_on')::date,coalesce(body->>'amount_cents',body->>'initial_cents')::bigint,(body->>'in_service_on')::date,coalesce(body->>'method',''),jsonb_build_array(config)||coalesce(c->'schedule','[]'),coalesce(body->>'notes',body->>'terms',''))
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,account_id=excluded.account_id,contra_account_id=excluded.contra_account_id,started_on=excluded.started_on,amount_cents=excluded.amount_cents,in_service_on=excluded.in_service_on,method=excluded.method,notes=excluded.notes,
    schedule=jsonb_build_array(config)||(SELECT coalesce(jsonb_agg(value),'[]') FROM jsonb_array_elements(accounting.registers.schedule) WHERE value->>'kind'<>'configuration') RETURNING version INTO v;
 ELSIF t IN ('register.post','register.void') THEN
  SELECT * INTO reg FROM accounting.registers WHERE id=(c->>'register_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF reg.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='register.void' THEN
   SELECT value INTO x FROM jsonb_array_elements(reg.schedule) WHERE value->>'entry_id'=c->>'movement_id' OR value->>'id'=c->>'movement_id';
   entry:=coalesce(x->>'entry_id',c->>'movement_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=entry AND register_id=reg.id) THEN RAISE EXCEPTION 'ACCT_REGISTER_MOVEMENT_REQUIRED';END IF;
   result:=accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',entry,'expected_version',(SELECT version FROM accounting.journal_entries WHERE id=entry),'entry_date',c->>'date','reason',c->>'reason'));
   UPDATE accounting.journal_entries SET register_id=reg.id WHERE id=(result->>'id')::uuid;
   UPDATE accounting.registers SET status='active',ended_on=NULL,schedule=(SELECT jsonb_agg(CASE WHEN value->>'entry_id'=entry::text THEN value||jsonb_build_object('void',result,'void_date',c->'date') ELSE value END) FROM jsonb_array_elements(schedule)) WHERE id=reg.id RETURNING version INTO v;
  ELSE
   result:=accounting.register_plan(reg.id,body);lines:=result->'lines';principal:=(result->'state'->>'principal_cents')::bigint;
   action_kind:=body->>'kind';action_date:=(body->>'date')::date;amount:=(body->>'amount_cents')::bigint;
   IF c->>'mode'='historical' THEN
    entry:=(c->>'entry_id')::uuid;
    IF c?'entry_version' AND (c->>'entry_version')::integer IS DISTINCT FROM (SELECT version FROM accounting.journal_entries WHERE id=entry) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
    IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=entry) THEN RAISE EXCEPTION 'ACCT_REVERSED_ENTRY';END IF;
    IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=entry AND status='posted' AND entry_date=action_date AND (register_id IS NULL OR register_id=reg.id)) OR
      (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM accounting.journal_lines WHERE entry_id=entry) IS DISTINCT FROM
      (SELECT jsonb_agg(jsonb_build_array((value->>'account_id')::uuid,((value->>'amount_cents')::bigint)::text) ORDER BY (value->>'account_id')::uuid,(value->>'amount_cents')::bigint) FROM jsonb_array_elements(lines)) THEN RAISE EXCEPTION 'ACCT_REGISTER_JOURNAL_MISMATCH';END IF;
    UPDATE accounting.journal_entries SET register_id=reg.id WHERE id=entry;
   ELSE
    result:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',action_date,'memo',reg.name||': '||action_kind,'kind',CASE reg.kind WHEN 'fixed_asset' THEN 'asset' ELSE 'loan' END,'register_id',reg.id,'lines',lines));
    result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',result->'id','expected_version',result->'version'));entry:=(result->>'id')::uuid;
   END IF;
   UPDATE accounting.registers SET schedule=schedule||jsonb_build_array(body||jsonb_build_object('id',key,'entry_id',entry)),status=CASE WHEN action_kind='disposal' THEN 'disposed' WHEN action_kind='payment' AND amount=principal THEN 'paid_off' ELSE status END,
    ended_on=CASE WHEN action_kind='disposal' OR (action_kind='payment' AND amount=principal) THEN action_date ELSE ended_on END WHERE id=reg.id RETURNING version INTO v;
   IF c->>'document_id' IS NOT NULL THEN INSERT INTO accounting.document_links(document_id,entry_id,created_by) VALUES((c->>'document_id')::uuid,entry,actor) ON CONFLICT DO NOTHING;END IF;
  END IF;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v,'entry_id',entry));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.register_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE tracked accounting.registers;invalid boolean;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF TG_WHEN='AFTER' AND NEW.status='posted' AND NEW.register_id IS NOT NULL THEN
   SELECT * INTO tracked FROM accounting.registers WHERE id=NEW.register_id;
   WITH daily AS(SELECT e.entry_date,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=tracked.account_id),0) cost,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=tracked.contra_account_id),0) contra
    FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=tracked.id AND e.status='posted' GROUP BY e.entry_date),running AS(SELECT sum(cost) OVER(ORDER BY entry_date) cost,sum(contra) OVER(ORDER BY entry_date) contra FROM daily)
    SELECT coalesce(bool_or(CASE WHEN tracked.kind='loan' THEN cost>0 ELSE cost<0 OR contra>0 OR cost+contra<0 END),false) INTO invalid FROM running;
   IF invalid THEN RAISE EXCEPTION 'ACCT_REGISTER_NEGATIVE_BASIS';END IF;
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs p CROSS JOIN LATERAL jsonb_array_elements(p.components) component(value) JOIN accounting.journal_lines l ON l.id=(component.value->>'source_line_id')::uuid WHERE p.status='posted' AND component.value->>'kind'='noncash_reclass' AND l.entry_id=NEW.reverses_entry_id) THEN RAISE EXCEPTION 'ACCT_NONCASH_DEPENDENCY';END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE entry_id=NEW.reverses_entry_id AND status='posted') AND current_setting('accounting.action',true)<>'payroll.void' THEN RAISE EXCEPTION 'ACCT_PAYROLL_VOID_REQUIRED';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='payroll_runs' THEN
   IF OLD.status<>'draft' AND (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at']) THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
   IF OLD.status='void' OR (OLD.status='posted' AND NEW.status<>'void') THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
  ELSE
   IF (NEW.kind,NEW.account_id,NEW.contra_account_id,NEW.started_on,NEW.amount_cents) IS DISTINCT FROM (OLD.kind,OLD.account_id,OLD.contra_account_id,OLD.started_on,OLD.amount_cents) AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=OLD.id AND status='posted') THEN RAISE EXCEPTION 'ACCT_REGISTER_FINANCIAL_TERMS_FROZEN';END IF;
  END IF;
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.register_plan(requested_id uuid, body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE reg accounting.registers;config jsonb;lines jsonb;action_kind text;action_date date;amount bigint;cost bigint;depreciation bigint;principal bigint;total bigint;
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO reg FROM accounting.registers WHERE registers.id=requested_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
   action_kind:=body->>'kind';action_date:=(body->>'date')::date;amount:=(body->>'amount_cents')::bigint;
   IF reg.status<>'active' OR action_date<reg.started_on OR amount<0 THEN RAISE EXCEPTION 'ACCT_REGISTER_ACTION';END IF;
   IF body?'schedule_row_key' AND EXISTS(SELECT 1 FROM jsonb_array_elements(reg.schedule) WHERE value->>'schedule_row_key'=body->>'schedule_row_key' AND value->>'entry_id' IS NOT NULL AND NOT value?'void') THEN RAISE EXCEPTION 'ACCT_REGISTER_ALREADY_POSTED';END IF;
   SELECT value INTO config FROM jsonb_array_elements(reg.schedule) WHERE value->>'kind'='configuration';
   IF (action_kind='depreciation' OR (action_kind='payment' AND coalesce((body->>'interest_cents')::bigint,0)>0)) AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(config->>'expense_account_id')::uuid AND type='expense') THEN RAISE EXCEPTION 'ACCT_REGISTER_EXPENSE_ACCOUNT';END IF;
   IF action_kind='payment' AND coalesce((body->>'fee_cents')::bigint,0)>0 AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(config->>'fee_account_id')::uuid AND type='expense') THEN RAISE EXCEPTION 'ACCT_REGISTER_EXPENSE_ACCOUNT';END IF;
   SELECT coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=reg.account_id),0),-coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=reg.contra_account_id),0) INTO cost,depreciation FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=reg.id AND e.status='posted' AND e.entry_date<=action_date;
   principal:=-cost;
   IF reg.kind='fixed_asset' AND action_kind='acquisition' THEN
    IF cost<>0 OR amount<>reg.amount_cents THEN RAISE EXCEPTION 'ACCT_REGISTER_COST';END IF;
    lines:=jsonb_build_array(jsonb_build_object('account_id',reg.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',body->'counter_account_id','amount_cents',(-amount)::text));
   ELSIF reg.kind='fixed_asset' AND action_kind='depreciation' THEN
    IF action_date<reg.in_service_on OR amount>cost-depreciation OR amount<=0 THEN RAISE EXCEPTION 'ACCT_DEPRECIATION_EXCEEDS_BASIS';END IF;
    lines:=jsonb_build_array(jsonb_build_object('account_id',config->'expense_account_id','amount_cents',amount::text),jsonb_build_object('account_id',reg.contra_account_id,'amount_cents',(-amount)::text));
   ELSIF reg.kind='fixed_asset' AND action_kind='disposal' THEN
    IF cost<=0 THEN RAISE EXCEPTION 'ACCT_REGISTER_COST';END IF;
    IF cost-depreciation-amount<>0 AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(body->>'gain_loss_account_id')::uuid AND type=CASE WHEN cost-depreciation-amount>0 THEN 'expense' ELSE 'income' END) THEN RAISE EXCEPTION 'ACCT_REGISTER_GAIN_LOSS_ACCOUNT';END IF;
    lines:=jsonb_build_array(jsonb_build_object('account_id',body->'counter_account_id','amount_cents',amount::text),jsonb_build_object('account_id',reg.contra_account_id,'amount_cents',depreciation::text),jsonb_build_object('account_id',reg.account_id,'amount_cents',(-cost)::text),jsonb_build_object('account_id',body->'gain_loss_account_id','amount_cents',(cost-depreciation-amount)::text));
   ELSIF reg.kind='loan' AND action_kind='draw' THEN
    lines:=jsonb_build_array(jsonb_build_object('account_id',body->'counter_account_id','amount_cents',amount::text),jsonb_build_object('account_id',reg.account_id,'amount_cents',(-amount)::text));
   ELSIF reg.kind='loan' AND action_kind='payment' THEN
    IF amount>principal OR amount<0 OR coalesce((body->>'interest_cents')::bigint,0)<0 OR coalesce((body->>'fee_cents')::bigint,0)<0 THEN RAISE EXCEPTION 'ACCT_LOAN_PAYMENT_EXCEEDS_PRINCIPAL';END IF;
    total:=amount+coalesce((body->>'interest_cents')::bigint,0)+coalesce((body->>'fee_cents')::bigint,0);
    lines:=jsonb_build_array(jsonb_build_object('account_id',reg.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',config->'expense_account_id','amount_cents',coalesce(body->>'interest_cents','0')),jsonb_build_object('account_id',config->'fee_account_id','amount_cents',coalesce(body->>'fee_cents','0')),jsonb_build_object('account_id',body->'counter_account_id','amount_cents',(-total)::text));
   ELSE RAISE EXCEPTION 'ACCT_REGISTER_ACTION';END IF;
   SELECT jsonb_agg(value) INTO lines FROM jsonb_array_elements(lines) WHERE (value->>'amount_cents')::bigint<>0;
 RETURN jsonb_build_object('lines',coalesce(lines,'[]'),'cost_delta',CASE action_kind WHEN 'acquisition' THEN amount WHEN 'disposal' THEN -cost ELSE 0 END::text,
 'depreciation_delta',CASE action_kind WHEN 'depreciation' THEN amount WHEN 'disposal' THEN -depreciation ELSE 0 END::text,
 'principal_delta',CASE action_kind WHEN 'draw' THEN amount WHEN 'payment' THEN -amount ELSE 0 END::text,'gain_cents',CASE WHEN action_kind='disposal' THEN amount-cost+depreciation ELSE 0 END::text,
 'state',jsonb_build_object('cost_cents',CASE WHEN reg.kind='fixed_asset' THEN cost ELSE 0 END::text,'depreciation_cents',depreciation::text,'carrying_cents',CASE WHEN reg.kind='fixed_asset' THEN cost-depreciation ELSE 0 END::text,'principal_cents',CASE WHEN reg.kind='loan' THEN principal ELSE 0 END::text,'initialized',EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=reg.id AND status='posted' AND entry_date<=action_date),'disposed',reg.status='disposed' AND reg.ended_on<=action_date));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.registers(view jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;detail jsonb;rows jsonb;cutoff date:=coalesce((view->>'date')::date,current_date);offset_rows integer:=coalesce((view->>'offset')::integer,0);total_count integer;
BEGIN
 PERFORM accounting.require_owner();
 IF view->>'view'='preview' THEN RETURN accounting.register_plan((view->>'id')::uuid,view->'body');END IF;
 SELECT count(*) INTO total_count FROM accounting.registers r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'kind' IS NULL OR r.kind=CASE view->>'kind' WHEN 'asset' THEN 'fixed_asset' ELSE view->>'kind' END) AND (view->>'query' IS NULL OR r.name ILIKE '%'||(view->>'query')||'%');
 WITH scoped AS (SELECT * FROM accounting.registers r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'kind' IS NULL OR r.kind=CASE view->>'kind' WHEN 'asset' THEN 'fixed_asset' ELSE view->>'kind' END) AND (view->>'query' IS NULL OR r.name ILIKE '%'||(view->>'query')||'%') ORDER BY name,id LIMIT 100 OFFSET offset_rows),
 shaped AS (SELECT r.*,coalesce((SELECT value FROM jsonb_array_elements(schedule) WHERE value->>'kind'='configuration'),'{}') config,
 coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=r.id AND e.status='posted' AND e.entry_date<=cutoff AND l.account_id=r.account_id),0) cost,
 -coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=r.id AND e.status='posted' AND e.entry_date<=cutoff AND l.account_id=r.contra_account_id),0) depreciation FROM scoped r)
 SELECT coalesce(jsonb_agg(to_jsonb(r)-ARRAY['cost','depreciation','config']||jsonb_build_object('kind',CASE r.kind WHEN 'fixed_asset' THEN 'asset' ELSE r.kind END,'amount_cents',amount_cents::text,'book_cents',cost::text,
 'body',jsonb_build_object('name',name,'started_on',started_on,'initial_cents',amount_cents::text,'account_id',account_id,'expense_account_id',config->'expense_account_id','terms',notes,'in_service_on',in_service_on,'accumulated_account_id',contra_account_id,'method',method,'lender',config->'lender','fee_account_id',config->'fee_account_id'),'document_id',config->'document_id',
 'state',jsonb_build_object('cost_cents',CASE WHEN r.kind='fixed_asset' THEN cost ELSE 0 END::text,'depreciation_cents',depreciation::text,'carrying_cents',CASE WHEN r.kind='fixed_asset' THEN cost-depreciation ELSE 0 END::text,'principal_cents',CASE WHEN r.kind='loan' THEN -cost ELSE 0 END::text,'initialized',EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=r.id AND status='posted' AND entry_date<=cutoff),'disposed',status='disposed' AND ended_on<=cutoff)) ORDER BY name,id),'[]') INTO rows FROM shaped r;
 IF view->>'view'='detail' THEN
  result:=rows->0;IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'entry_id',e.id,'kind',coalesce(item->>'kind',e.kind),'effective_date',e.entry_date,'mode',CASE WHEN item IS NULL THEN 'historical' ELSE 'new' END,'body',item,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text)) FROM accounting.journal_lines l WHERE l.entry_id=e.id),'document_id',(SELECT document_id FROM accounting.document_links WHERE entry_id=e.id LIMIT 1),'reason',e.reason,'void',(SELECT jsonb_build_object('effective_date',re.entry_date,'reason',re.reason,'reversal_entry_id',re.id) FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)) ORDER BY e.entry_date DESC,e.id),'[]') INTO detail
   FROM accounting.journal_entries e LEFT JOIN LATERAL (SELECT value item FROM jsonb_array_elements(result->'schedule') WHERE value->>'entry_id'=e.id::text LIMIT 1) schedule_item ON true WHERE e.register_id=(view->>'id')::uuid AND e.status='posted' AND e.reverses_entry_id IS NULL AND e.entry_date<=cutoff;
  RETURN result||jsonb_build_object('as_of',cutoff,'offset',offset_rows,'record',jsonb_build_object('revision',result->'version','body',result->'body','document_id',result->'document_id','reason',result->>'notes','created_at',result->'updated_at'),'movements',detail,'movement_count',jsonb_array_length(detail),
   'revisions',(SELECT coalesce(jsonb_agg(jsonb_build_object('revision',a.after->'version','body',a.after,'document_id',a.after->'schedule'->0->'document_id','reason',a.reason,'created_at',a.at) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.table_name='registers' AND a.row_id=(view->>'id')::uuid),'revision_count',(SELECT count(*) FROM accounting.audit_log a WHERE a.table_name='registers' AND a.row_id=(view->>'id')::uuid));
 END IF;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'as_of',cutoff,'offset',offset_rows,'count',total_count,'rows',rows);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report(kind text, params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date:=coalesce((params->>'from')::date,date_trunc('year',coalesce((params->>'as_of')::date,current_date))::date);
 end_date date:=coalesce((params->>'as_of')::date,(params->>'to')::date,current_date);year_start date;compare_year_start date;compare_start date:=(params->>'compare_from')::date;compare_end date:=(params->>'compare_to')::date;
 accounts jsonb;totals jsonb;comparison jsonb;monthly jsonb;cash jsonb;quality jsonb;dimensions jsonb;result jsonb;
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_owner();END IF;
 PERFORM accounting.report_validate(params);
 IF kind NOT IN ('profit_loss','balance_sheet','trial_balance','general_ledger','cash_movements','account_balances','summary','owner_activity','payee') THEN RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 IF start_date>end_date OR (compare_start IS NULL)<>(compare_end IS NULL) OR compare_start>compare_end THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 year_start:=make_date(extract(year FROM end_date)::integer,(SELECT fiscal_year_start_month FROM public.business_profile WHERE id=1),1);
 IF year_start>end_date THEN year_start:=(year_start-interval '1 year')::date;END IF;
 IF compare_end IS NOT NULL THEN compare_year_start:=make_date(extract(year FROM compare_end)::integer,(SELECT fiscal_year_start_month FROM public.business_profile WHERE id=1),1);IF compare_year_start>compare_end THEN compare_year_start:=(compare_year_start-interval '1 year')::date;END IF;END IF;
 WITH selected AS (
  SELECT e.entry_date,e.status,l.* FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id
  WHERE (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
    AND (params->>'payee' IS NULL OR (params->>'payee'='unassigned' AND e.payee_id IS NULL) OR e.payee_id::text=params->>'payee')
 ), rows AS (
 SELECT a.*,p.name parent_name,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<start_date),0) opening,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date AND l.amount_cents>0),0) debit,
  -coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date AND l.amount_cents<0),0) credit,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN start_date AND end_date),0) movement,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<=end_date),0) ending,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<year_start),0) prior,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN year_start AND end_date),0) current_year,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN compare_start AND compare_end),0) compare_movement,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<=compare_end),0) compare_ending,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date<compare_year_start),0) compare_prior,
  coalesce(sum(l.amount_cents) FILTER(WHERE l.entry_date BETWEEN compare_year_start AND compare_end),0) compare_year
 FROM accounting.accounts a LEFT JOIN accounting.accounts p ON p.id=a.parent_id LEFT JOIN selected l ON l.account_id=a.id
 WHERE (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))
 GROUP BY a.id,p.name
 )
 SELECT coalesce(jsonb_agg(to_jsonb(r)-ARRAY['opening','debit','credit','movement','ending','prior','current_year','compare_movement','compare_ending','compare_prior','compare_year']||jsonb_build_object(
  'code',coalesce(r.code,''),'account_type',r.type,'normal_side',CASE WHEN (r.type IN ('asset','expense'))<>r.is_contra THEN 'debit' ELSE 'credit' END,'parent_account_id',r.parent_id,'purpose',r.system_purpose,'cash_kind',CASE WHEN r.subtype IN ('bank','cash','card') THEN r.subtype ELSE 'none' END,
  'opening_cents',opening::text,'debit_cents',debit::text,'credit_cents',credit::text,'movement_cents',movement::text,'period_cents',movement::text,'ending_cents',ending::text,'prior_cents',prior::text,'year_cents',current_year::text,
  'compare_period_cents',compare_movement::text,'compare_ending_cents',compare_ending::text,'compare_prior_cents',compare_prior::text,'compare_year_cents',compare_year::text) ORDER BY r.code NULLS LAST,r.name,r.id),'[]') INTO accounts FROM rows r;
 WITH a AS(SELECT value r FROM jsonb_array_elements(accounts)),s AS(SELECT
  -coalesce(sum((r->>'period_cents')::numeric) FILTER(WHERE r->>'type'='income'),0) income,
  coalesce(sum((r->>'period_cents')::numeric) FILTER(WHERE r->>'type'='expense'),0) expense,
  coalesce(sum((r->>'period_cents')::numeric) FILTER(WHERE r->>'type'='expense' AND r->>'subtype'='cost_of_goods_sold'),0) cogs,
  coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'type'='asset'),0) assets,
  -coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'type'='liability'),0) liabilities,
  -coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'type'='equity'),0) equity,
  -coalesce(sum((r->>'prior_cents')::numeric) FILTER(WHERE r->>'type' IN ('income','expense')),0) prior,
  -coalesce(sum((r->>'year_cents')::numeric) FILTER(WHERE r->>'type' IN ('income','expense')),0) current_year,
  coalesce(sum((r->>'opening_cents')::numeric) FILTER(WHERE r->>'subtype' IN ('bank','cash')),0) cash_opening,
  coalesce(sum((r->>'ending_cents')::numeric) FILTER(WHERE r->>'subtype' IN ('bank','cash')),0) cash_ending
 FROM a)
 SELECT jsonb_build_object('income_cents',income::text,'expense_cents',expense::text,'cogs_cents',cogs::text,'net_cents',(income-expense)::text,'assets_cents',assets::text,'liabilities_cents',liabilities::text,'equity_cents',equity::text,'prior_cents',prior::text,'year_cents',current_year::text,'difference_cents',(assets-liabilities-equity-prior-current_year)::text,'cash_opening_cents',cash_opening::text,'cash_ending_cents',cash_ending::text) INTO totals FROM s;
 IF kind='balance_sheet' AND coalesce(params->>'mode','posted')='posted' AND NOT params ?| ARRAY['account_ids','account_types','payee'] AND (totals->>'difference_cents')::numeric<>0 THEN RAISE EXCEPTION 'ACCT_BALANCE_SHEET_UNBALANCED';END IF;
 IF compare_start IS NOT NULL THEN comparison:=accounting.report(kind,(params-ARRAY['compare_from','compare_to','as_of'])||jsonb_build_object('from',compare_start,'to',compare_end))->'totals';
 ELSE comparison:=(SELECT jsonb_object_agg(key,'0'::text) FROM jsonb_each(totals));END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',month,'income_cents',income::text,'expense_cents',expense::text,'net_cents',(income-expense)::text) ORDER BY month),'[]') INTO monthly FROM (
 SELECT d::date AS month,-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) expense
 FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d
 LEFT JOIN accounting.journal_entries e ON e.entry_date>=d::date AND e.entry_date<(d+interval '1 month')::date AND e.entry_date BETWEEN start_date AND end_date AND (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id))) AND (params->>'payee' IS NULL OR e.payee_id::text=params->>'payee' OR (params->>'payee'='unassigned' AND e.payee_id IS NULL))
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id GROUP BY d) m;
 SELECT coalesce(jsonb_agg(jsonb_build_object('classification',classification,'amount_cents',cents::text,'line_count',n) ORDER BY classification),'[]') INTO cash FROM (SELECT classification,sum(amount_cents) cents,count(DISTINCT id) n FROM accounting.cash_lines(params||jsonb_build_object('from',start_date,'to',end_date)) GROUP BY classification) c;
 SELECT jsonb_build_object('draft_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' AND entry_date BETWEEN start_date AND end_date),
 'unbalanced_drafts',(SELECT count(*) FROM accounting.journal_entries e WHERE e.status='draft' AND e.entry_date BETWEEN start_date AND end_date AND (SELECT coalesce(sum(amount_cents),0) FROM accounting.journal_lines WHERE entry_id=e.id)<>0),
 'incomplete_imports',(SELECT count(*) FROM accounting.import_batches ib WHERE ib.kind='journal' AND parity_status<>'verified' AND coverage_from<=end_date AND (report.kind IN ('balance_sheet','trial_balance','general_ledger','account_balances','summary','cash_movements') OR coverage_to>=start_date) AND (status<>'cancelled' OR applied_count>0)),
 'unclassified_cash_lines',0,'uncategorized_lines',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE a.subtype='uncategorized' AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date),
 'reconciliations',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',b.account_id,'through',r.statement_end)),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE r.status='completed'),
 'feeds',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'last_success_at',last_success_at,'status',status)),'[]') FROM accounting.bank_connections)) INTO quality;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind','payee','id',party,'name',name,'income_cents',income::text,'expense_cents',expense::text,'compare_income_cents',compare_income::text,'compare_expense_cents',compare_expense::text)),'[]') INTO dimensions FROM (
 SELECT coalesce(e.payee_id::text,'unassigned') party,coalesce(p.name,'Unassigned') name,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND e.entry_date BETWEEN start_date AND end_date),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND e.entry_date BETWEEN start_date AND end_date),0) expense,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND e.entry_date BETWEEN compare_start AND compare_end),0) compare_income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND e.entry_date BETWEEN compare_start AND compare_end),0) compare_expense
 FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id LEFT JOIN accounting.parties p ON p.id=e.payee_id
 WHERE (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id))) AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types'))) AND (params->>'payee' IS NULL OR e.payee_id::text=params->>'payee' OR (params->>'payee'='unassigned' AND e.payee_id IS NULL)) AND (e.entry_date BETWEEN start_date AND end_date OR e.entry_date BETWEEN compare_start AND compare_end) GROUP BY e.payee_id,p.name) q;
 result:=jsonb_build_object('legal_name',(SELECT legal_name FROM public.business_profile WHERE id=1),'revision',(SELECT financial_revision::text FROM accounting.settings),'definition_version',1,'currency','USD','basis','cash','generated_at',now(),
 'filter',(params-'as_of')||jsonb_build_object('from',start_date,'to',end_date,'mode',coalesce(params->>'mode','posted'),'offset',coalesce((params->>'offset')::integer,0)),'accounts',accounts,'rows',accounts,'totals',totals,'comparison',comparison,'monthly',monthly,'dimensions',dimensions,'cash',cash,'quality',quality);
 RETURN result||jsonb_build_object('income_cents',totals->'income_cents','expense_cents',totals->'expense_cents','net_income_cents',totals->'net_cents','cost_of_goods_sold_cents',totals->'cogs_cents',
 'gross_profit_cents',((totals->>'income_cents')::numeric-(totals->>'cogs_cents')::numeric)::text,'operating_expense_cents',((totals->>'expense_cents')::numeric-(totals->>'cogs_cents')::numeric)::text,
 'assets_cents',totals->'assets_cents','liabilities_cents',totals->'liabilities_cents','equity_cents',totals->'equity_cents','retained_cents',totals->'prior_cents','year_income_cents',totals->'year_cents',
 'equity_total_cents',((totals->>'equity_cents')::numeric+(totals->>'prior_cents')::numeric+(totals->>'year_cents')::numeric)::text,'balance_difference_cents',totals->'difference_cents','trial_balance_cents',totals->'difference_cents');
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());t text:=c->>'type';p jsonb:=coalesce(c->'params',c->'filter',jsonb_build_object('from',c->>'from','to',c->>'to'));r jsonb;payload jsonb;kind text;detail jsonb;rows jsonb;offset_rows integer:=0;revision bigint;actor uuid:=accounting.require_owner();report_id text:=c->'options'->>'report_id';parts jsonb;item text;support jsonb:='[]';
BEGIN
 SELECT financial_revision INTO revision FROM accounting.settings;
 IF c->>'expected_revision' IS NOT NULL AND (c->>'expected_revision')::bigint<>revision THEN RAISE EXCEPTION 'ACCT_STALE_REPORT';END IF;
 IF t='report.books.capture' THEN p:=jsonb_build_object('from',make_date((c->>'year')::integer,1,1),'to',(c->>'through')::date,'mode','posted');END IF;
 IF t='report.capture' AND coalesce(report_id,'')<>'general-ledger' AND p ?| ARRAY['account_ids','account_types','cash_class'] THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
 IF p->>'mode'='working' THEN RAISE EXCEPTION 'ACCT_POSTED_REPORT_REQUIRED';END IF;
 kind:=coalesce(c->>'kind',CASE report_id WHEN 'profit-loss' THEN 'profit_loss' WHEN 'balance-sheet' THEN 'balance_sheet' WHEN 'trial-balance' THEN 'trial_balance' WHEN 'general-ledger' THEN 'general_ledger' WHEN 'cash-flow' THEN 'cash_movements' ELSE 'profit_loss' END);
 IF t='report.books.capture' THEN kind:='year_end_package';END IF;
 r:=accounting.report(CASE WHEN kind='year_end_package' THEN 'summary' ELSE kind END,p);
 IF (r->'quality'->>'incomplete_imports')::integer>0 THEN RAISE EXCEPTION 'ACCT_IMPORT_PARITY_REQUIRED';END IF;
 p:=r->'filter';
 IF t='report.books.capture' AND extract(year FROM (p->>'to')::date)<>(c->>'year')::integer THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 IF t IN ('report.capture','report.snapshot') THEN
  payload:=jsonb_build_object('type','detailed_report','export_definition',1,'data',r,'options',coalesce(c->'options',jsonb_build_object('report_id',replace(kind,'_','-'),'show_zero',false,'details',true)));
  IF kind='general_ledger' THEN detail:=accounting.report_lines('general_ledger',p||jsonb_build_object('offset',0,'limit',100000));IF (detail->>'total')::integer>100000 THEN RAISE EXCEPTION 'ACCT_EXPORT_TOO_LARGE';END IF;payload:=jsonb_set(payload,'{ledger}',detail->'rows');END IF;
 ELSIF t='report.books.capture' THEN
  detail:=accounting.report_lines('general_ledger',p||jsonb_build_object('offset',0,'limit',100000));IF (detail->>'total')::integer>100000 THEN RAISE EXCEPTION 'ACCT_EXPORT_TOO_LARGE';END IF;
  FOREACH item IN ARRAY ARRAY['payroll-register','contractor-worksheet','asset-register','loan-register','tax-workpapers'] LOOP
   support:=support||jsonb_build_array(accounting.support_report(p||jsonb_build_object('report_id',item,'offset',0,'limit',100000)));
  END LOOP;
  payload:=jsonb_build_object('type','books_package','export_definition',1,'year',(c->>'year')::integer,'through',c->>'through','core',r,'ledger',detail->'rows','ledger_count',detail->'total','support',support,'payroll',accounting.payroll(jsonb_build_object('year',(c->>'year')::integer,'through',c->>'through')),
  'review_items',accounting.books_package(jsonb_build_object('year',(c->>'year')::integer,'through',c->>'through'))->'review_items','notes',jsonb_build_array('This package contains posted books and retained source references. Payroll and tax support are review worksheets, not a completed tax return.'),
  'account_mappings',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('profile',jsonb_build_object('account_id',value->'id','purpose',value->'purpose','cash_kind',value->'cash_kind','subtype',value->'subtype','parent_account_id',value->'parent_account_id'))),'[]') FROM jsonb_array_elements(r->'accounts')),
  'document_index',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'original_name',name,'content_hash',sha256,'mime_type',mime,'size_bytes',size_bytes::text,'state',CASE WHEN status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=documents.storage_path) THEN 'available' ELSE status END) ORDER BY uploaded_at,id),'[]') FROM accounting.documents));
 ELSIF t='report.support.capture' THEN
  kind:='year_end_package';
  payload:=jsonb_build_object('type','support_report','export_definition',1,'data',accounting.support_report(p||jsonb_build_object('report_id',c->'filter'->>'report_id','offset',0,'limit',100000)));
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';END IF;
 IF c->>'document_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=(c->>'document_id')::uuid AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.name=d.storage_path AND o.bucket_id='accounting-private')) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
 IF t='report.support.capture' AND jsonb_array_length(payload->'data'->'rows')<>(payload->'data'->>'count')::integer THEN RAISE EXCEPTION 'ACCT_EXPORT_TOO_LARGE';END IF;
 INSERT INTO accounting.report_snapshots(id,kind,params,from_date,to_date,financial_revision,data,document_id,created_by) VALUES(k,kind,p,(p->>'from')::date,(p->>'to')::date,revision,payload,(c->>'document_id')::uuid,actor);
 RETURN jsonb_build_object('id',k,'revision',revision::text);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_SNAPSHOT';END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_lines(kind text, params jsonb, account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date:=(params->>'from')::date;end_date date:=coalesce((params->>'as_of')::date,(params->>'to')::date);offset_rows integer:=coalesce((params->>'offset')::integer,0);limit_rows integer:=coalesce((params->>'limit')::integer,100);result jsonb;opening numeric;
BEGIN
 PERFORM accounting.require_owner();
 PERFORM accounting.report_validate(params);
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR offset_rows<0 OR limit_rows NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 IF report_lines.kind NOT IN ('general_ledger','profit_loss','balance_sheet','trial_balance','account_balances','cash_movements','owner_activity','summary','payee') THEN RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 IF account IS NOT NULL THEN params:=params||jsonb_build_object('account_ids',jsonb_build_array(account));END IF;
 params:=(params-'as_of')||jsonb_build_object('from',start_date,'to',end_date);
 WITH selected AS (
 SELECT l.*,e.entry_date,e.memo entry_memo,e.status,e.origin,a.name account_name,a.type account_type
 FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.accounts a ON a.id=l.account_id
 WHERE e.entry_date<=end_date AND (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
 AND (params->>'payee' IS NULL OR e.payee_id::text=params->>'payee' OR (params->>'payee'='unassigned' AND e.payee_id IS NULL))
 AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))
 AND (report_lines.kind<>'owner_activity' OR a.type='equity') AND (report_lines.kind<>'profit_loss' OR a.type IN ('income','expense')) AND (report_lines.kind<>'cash_movements' OR a.subtype IN ('bank','cash'))
 ), scoped AS (
 SELECT s.id,s.entry_id,s.account_id,s.entry_date,s.entry_memo,s.memo,s.status,s.origin,s.account_name,s.account_type,s.sort_order,s.amount_cents::numeric amount_cents,NULL::text classification,0::bigint allocation_index FROM selected s WHERE report_lines.kind<>'cash_movements'
 UNION ALL SELECT s.id,s.entry_id,s.account_id,s.entry_date,s.entry_memo,s.memo,s.status,s.origin,s.account_name,s.account_type,s.sort_order,c.amount_cents,c.classification,c.allocation_index FROM selected s JOIN accounting.cash_lines(params||jsonb_build_object('from','1900-01-01')) c ON c.id=s.id WHERE report_lines.kind='cash_movements' AND (params->>'cash_class' IS NULL OR c.classification=params->>'cash_class')
 ), running AS (
 SELECT *,sum(amount_cents) OVER(PARTITION BY account_id ORDER BY entry_date,entry_id,sort_order,id,allocation_index ROWS UNBOUNDED PRECEDING) running_cents FROM scoped
 ), in_range AS(SELECT * FROM running WHERE entry_date>=start_date),paged AS(SELECT * FROM in_range ORDER BY entry_date,entry_id,sort_order,id,allocation_index LIMIT limit_rows OFFSET offset_rows)
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',(SELECT count(*) FROM in_range),'total_cents',(SELECT coalesce(sum(amount_cents),0)::text FROM in_range),
 'opening_cents',(SELECT coalesce(sum(amount_cents),0)::text FROM scoped WHERE entry_date<start_date),
 'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'entry_id',entry_id,'entry_date',entry_date,'memo',entry_memo,'line_memo',memo,'account_id',account_id,'account_name',account_name,'account_type',account_type,'amount_cents',amount_cents::text,'running_cents',running_cents::text,'status',status,'primary_origin',origin,'classification',classification,'allocation_index',allocation_index,'allocation_source',CASE WHEN report_lines.kind='cash_movements' THEN 'derived' ELSE NULL END) ORDER BY entry_date,entry_id,sort_order,id,allocation_index),'[]') FROM paged)) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_validate(params jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE ids jsonb;value text;
BEGIN
 IF jsonb_typeof(params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
 IF coalesce(params->>'mode','posted') NOT IN ('posted','working') THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 IF params ?| ARRAY['customer','project','business_line'] THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
 IF params?'account_ids' THEN
  ids:=params->'account_ids';IF jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
  IF jsonb_array_length(ids) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) x WHERE NOT EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.id::text=x.value)) THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
 END IF;
 IF params?'account_types' THEN
  ids:=params->'account_types';IF jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
  IF jsonb_array_length(ids) NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) x WHERE x.value NOT IN ('asset','liability','equity','income','expense')) THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
 END IF;
 IF params?'payee' AND params->>'payee'<>'unassigned' AND NOT EXISTS(SELECT 1 FROM accounting.parties WHERE id::text=params->>'payee') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
 IF params?'cash_class' AND params->>'cash_class' NOT IN ('operating','investing','financing','internal_transfer','unclassified') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.require_open(d date)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM accounting.periods WHERE month=date_trunc('month',d)::date AND status='locked') THEN RAISE EXCEPTION 'ACCT_PERIOD_LOCKED'; END IF;
 IF EXISTS(SELECT 1 FROM accounting.periods WHERE month>date_trunc('month',d)::date AND status='locked') THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.require_owner()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND owner_user_id=actor) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.rule_candidate(entry uuid, rule_filter uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE e accounting.journal_entries; bank accounting.journal_lines; r accounting.rules; descriptor text; mode text; pattern text;
 matches jsonb:='[]';winner jsonb;why text:='';alias_count integer;
BEGIN
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF NOT FOUND OR e.status='discarded' THEN RETURN NULL; END IF;
 SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card');
 IF NOT FOUND OR (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card'))<>1 THEN RETURN NULL; END IF;
 FOR r IN SELECT * FROM accounting.rules WHERE (rule_filter IS NULL AND enabled) OR id=rule_filter ORDER BY priority,id LOOP
  descriptor:=upper(regexp_replace(btrim(CASE WHEN r.conditions?'description' THEN coalesce(e.source_description,e.memo) ELSE coalesce(e.descriptor_key,accounting.descriptor_key(e.memo)) END),'\s+',' ','g'));
  mode:=coalesce(r.conditions->>'description_mode',(SELECT key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1));
  pattern:=upper(regexp_replace(btrim(coalesce(r.conditions->>'description',r.conditions->'descriptor_key'->>mode)),'\s+',' ','g'));
  IF mode NOT IN ('exact','equals','prefix','contains') OR pattern IS NULL THEN CONTINUE; END IF;
  IF (mode IN ('exact','equals') AND descriptor<>pattern) OR (mode='prefix' AND left(descriptor,length(pattern))<>pattern) OR (mode='contains' AND position(pattern IN descriptor)=0) THEN CONTINUE; END IF;
  IF r.conditions->>'bank_account_id' IS NOT NULL AND (r.conditions->>'bank_account_id')::uuid<>bank.account_id THEN CONTINUE; END IF;
  IF r.conditions->>'direction' IN ('increase','in') AND bank.amount_cents<0 OR r.conditions->>'direction' IN ('decrease','out') AND bank.amount_cents>0 THEN CONTINUE; END IF;
  IF r.conditions->>'amount_min' IS NOT NULL AND abs(bank.amount_cents::numeric)<(r.conditions->>'amount_min')::numeric THEN CONTINUE; END IF;
  IF r.conditions->>'amount_max' IS NOT NULL AND abs(bank.amount_cents::numeric)>(r.conditions->>'amount_max')::numeric THEN CONTINUE; END IF;
  IF r.conditions->>'payee_id' IS NOT NULL AND e.payee_id IS DISTINCT FROM (r.conditions->>'payee_id')::uuid THEN CONTINUE; END IF;
  matches:=matches||jsonb_build_array(to_jsonb(r)||jsonb_build_object('rule_id',r.id,
   'description_mode',CASE WHEN mode='equals' THEN 'exact' ELSE mode END,'description',pattern,
   'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction',
   'min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),
   'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id',
   'category_name',coalesce((SELECT name FROM accounting.accounts WHERE id=(r.actions->>'account_id')::uuid),'Split categories'),'reason',''));
 END LOOP;
 IF jsonb_array_length(matches)=0 THEN RETURN NULL; END IF;
 winner:=matches->0;
 descriptor:=upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g'));
 SELECT count(DISTINCT party_id) INTO alias_count FROM accounting.payee_aliases a WHERE enabled AND
  ((match_kind='key' AND a.pattern=e.descriptor_key) OR (match_kind='exact' AND upper(a.pattern)=descriptor) OR (match_kind='prefix' AND left(descriptor,length(a.pattern))=upper(a.pattern)));
 IF e.status='posted' THEN why:='Posted history is preview only';
 ELSIF NOT EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN why:='Category already reviewed';
 ELSIF alias_count>1 THEN why:='Conflicting payee aliases';
 ELSIF (SELECT count(*) FROM jsonb_array_elements(matches) m WHERE m->>'priority'=winner->>'priority')>1 THEN why:='Rules share the winning priority'; END IF;
 RETURN winner||jsonb_build_object('id',e.id,'version',e.version,'entry_id',entry,'entry_version',e.version,'rule_id',winner->'id','rule_version',winner->'version',
  'entry_date',e.entry_date,'memo',e.memo,'status',e.status,'payee_id',e.payee_id,
  'aliases',jsonb_build_object('conflict',alias_count>1,'aliases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',p.name,'description',a.pattern)),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id WHERE a.enabled AND ((a.match_kind='key' AND a.pattern=e.descriptor_key) OR (a.match_kind='exact' AND upper(a.pattern)=descriptor) OR (a.match_kind='prefix' AND left(descriptor,length(a.pattern))=upper(a.pattern))))),
  'eligible',why='','reason',why,'winner',winner,'matches',matches,'bank_account_id',bank.account_id,'bank_amount_cents',bank.amount_cents::text,
  'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount_cents::text) ORDER BY sort_order) FROM accounting.journal_lines WHERE entry_id=entry));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.rules_preview(filter jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT coalesce(jsonb_agg(candidate ORDER BY entry_date,id),'[]') INTO result FROM (
 SELECT e.id,e.entry_date,accounting.rule_candidate(e.id,(filter->>'rule_id')::uuid) candidate FROM accounting.journal_entries e
 WHERE (filter->>'from' IS NULL OR e.entry_date>=(filter->>'from')::date) AND (filter->>'to' IS NULL OR e.entry_date<=(filter->>'to')::date)) q WHERE candidate IS NOT NULL;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',jsonb_array_length(result),'rows',result);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.snapshot_read(id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_owner();RETURN (SELECT jsonb_build_object('id',s.id,'revision',financial_revision::text,'created_at',created_at,'payload',data,'document_id',document_id) FROM accounting.report_snapshots s WHERE s.id=snapshot_read.id);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.support_report(params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE report_id text:=params->>'report_id';start_date date:=(params->>'from')::date;end_date date:=(params->>'to')::date;rows jsonb;columns jsonb;total_cells jsonb;source jsonb;controls jsonb;notes jsonb:='[]';result jsonb;offset_rows integer:=coalesce((params->>'offset')::integer,0);limit_rows integer:=coalesce((params->>'limit')::integer,100);row_count integer;
BEGIN
 PERFORM accounting.require_owner();
 PERFORM accounting.report_validate(params);
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR offset_rows<0 OR limit_rows NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 IF report_id='payroll-register' THEN
  columns:='[{"label":"Pay date","numeric":false},{"label":"Provider run","numeric":false},{"label":"Gross wages","numeric":true},{"label":"Employee withholding","numeric":true},{"label":"Employer taxes","numeric":true},{"label":"Net pay","numeric":true}]';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'run_id',p.id,'cells',jsonb_build_array(p.pay_date,p.provider_run_id,p.gross_cents::text,p.employee_withholding_cents::text,p.employer_tax_cents::text,p.net_cents::text)) ORDER BY pay_date,id),'[]'),
   jsonb_build_array('Total','',coalesce(sum(gross_cents),0)::text,coalesce(sum(employee_withholding_cents),0)::text,coalesce(sum(employer_tax_cents),0)::text,coalesce(sum(net_cents),0)::text) INTO rows,total_cells
  FROM accounting.payroll_runs p WHERE p.pay_date BETWEEN start_date AND end_date AND p.entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=end_date);
  notes:=jsonb_build_array('Includes posted runs not reversed by the selected cutoff. A later void does not remove a run from an earlier report.');
 ELSIF report_id IN ('asset-register','loan-register') THEN
  columns:=CASE report_id WHEN 'asset-register' THEN '[{"label":"Asset","numeric":false},{"label":"Acquired","numeric":false},{"label":"Recorded cost","numeric":true},{"label":"Accumulated depreciation","numeric":true},{"label":"Carrying value","numeric":true}]'::jsonb ELSE '[{"label":"Loan","numeric":false},{"label":"Originated","numeric":false},{"label":"Principal balance","numeric":true}]'::jsonb END;
  WITH balances AS (
   SELECT r.id,r.kind,r.name,r.started_on,r.account_id,r.contra_account_id,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=r.account_id),0) cost,-coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=r.contra_account_id),0) depreciation
   FROM accounting.registers r LEFT JOIN accounting.journal_entries e ON e.register_id=r.id AND e.status='posted' AND e.entry_date<=end_date LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id
   WHERE r.started_on<=end_date AND r.kind=CASE report_id WHEN 'asset-register' THEN 'fixed_asset' ELSE 'loan' END GROUP BY r.id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'register_id',id,'register_kind',CASE kind WHEN 'fixed_asset' THEN 'asset' ELSE 'loan' END,'cells',CASE kind WHEN 'fixed_asset' THEN jsonb_build_array(name,started_on,cost::text,depreciation::text,(cost-depreciation)::text) ELSE jsonb_build_array(name,started_on,(-cost)::text) END) ORDER BY name,id),'[]'),
  CASE report_id WHEN 'asset-register' THEN jsonb_build_array('Total','',coalesce(sum(cost),0)::text,coalesce(sum(depreciation),0)::text,coalesce(sum(cost-depreciation),0)::text) ELSE jsonb_build_array('Total','',(-coalesce(sum(cost),0))::text) END INTO rows,total_cells FROM balances;
  WITH scoped AS (
   SELECT l.account_id,sum(l.amount_cents) register_amount FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.registers r ON r.id=e.register_id AND l.account_id IN(r.account_id,r.contra_account_id)
   WHERE e.status='posted' AND e.entry_date<=end_date AND r.kind=CASE report_id WHEN 'asset-register' THEN 'fixed_asset' ELSE 'loan' END GROUP BY l.account_id
  ), balances AS (
   SELECT a.id,a.name,coalesce(s.register_amount,0) register_amount,coalesce(sum(l.amount_cents) FILTER(WHERE e.id IS NOT NULL),0) book_amount
   FROM accounting.accounts a LEFT JOIN scoped s ON s.account_id=a.id LEFT JOIN accounting.journal_lines l ON l.account_id=a.id LEFT JOIN accounting.journal_entries e ON e.id=l.entry_id AND e.status='posted' AND e.entry_date<=end_date
   WHERE a.subtype=CASE report_id WHEN 'asset-register' THEN 'fixed_asset' ELSE 'loan' END OR (report_id='asset-register' AND a.subtype='accumulated_depreciation') GROUP BY a.id,s.register_amount)
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('account_id',id,'name',name,'register_cents',register_amount::text,'book_cents',book_amount::text,'difference_cents',(book_amount-register_amount)::text) ORDER BY name,id),'[]'),'ready',coalesce(bool_and(register_amount=book_amount),true),'missing_documents',0) INTO controls FROM balances;
  notes:=jsonb_build_array('Balances include actual posted movements through the cutoff. Proposed schedule rows do not change the ledger.');
 ELSIF report_id='contractor-worksheet' THEN
  IF extract(year FROM start_date)<>extract(year FROM end_date) THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
  source:=accounting.contractor_report(extract(year FROM end_date)::integer);
  columns:='[{"label":"Payee","numeric":false},{"label":"Classification","numeric":false},{"label":"Documentation","numeric":false},{"label":"Cash paid net of refunds","numeric":true},{"label":"Card payments excluded","numeric":true}]';
  WITH paid AS (
   SELECT p.id,p.name,p.contractor_classification,p.documentation_status,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash')),0) cash,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype='card'),0) card
   FROM accounting.parties p LEFT JOIN accounting.journal_entries e ON e.payee_id=p.id AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE p.is_contractor GROUP BY p.id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'contractor_party_id',id,'cells',jsonb_build_array(name,contractor_classification,documentation_status,cash::text,card::text)) ORDER BY name,id),'[]'),jsonb_build_array('Total','','',coalesce(sum(cash),0)::text,coalesce(sum(card),0)::text) INTO rows,total_cells FROM paid;
  notes:=jsonb_build_array('Annual reporting threshold in cents: '||(source->>'threshold_cents')||'. Owner classifications and exclusions require review; this worksheet does not file a return.');
 ELSIF report_id='tax-workpapers' THEN
  IF start_date<>make_date(extract(year FROM end_date)::integer,1,1) THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
  source:=accounting.tax_source(extract(year FROM end_date)::integer,end_date);
  columns:='[{"label":"Account or adjustment","numeric":false},{"label":"Treatment","numeric":false},{"label":"Book profit contribution","numeric":true},{"label":"Ordinary taxable contribution","numeric":true},{"label":"Book-to-tax difference","numeric":true}]';
  SELECT coalesce(jsonb_agg(row ORDER BY label,id),'[]') INTO rows FROM (
   SELECT value->>'name' label,value->>'account_id' id,jsonb_build_object('id',value->'account_id','tax_kind','account','tax_account_id',value->'account_id','cells',jsonb_build_array(value->>'name',coalesce(value->'mapping'->>'concept','Unmapped'),value->>'book_cents',value->>'ordinary_cents',((value->>'ordinary_cents')::numeric-(value->>'book_cents')::numeric)::text)) row FROM jsonb_array_elements(source->'accounts') WHERE (value->>'line_count')::integer>0
   UNION ALL SELECT value->>'reason',value->>'id',jsonb_build_object('id',value->'id','tax_kind','adjustment','cells',jsonb_build_array(value->>'reason',value->>'concept','0',CASE WHEN value->>'concept' IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') THEN '0' ELSE value->>'amount_cents' END,CASE WHEN value->>'concept' IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') THEN '0' ELSE value->>'amount_cents' END)) FROM jsonb_array_elements(source->'adjustments')) q;
  total_cells:=jsonb_build_array('Total','',source->>'book_profit_cents',source->>'adjusted_ordinary_cents',source->>'book_to_tax_cents');
  notes:=jsonb_build_array('Tax workpapers use year-to-date posted activity through the cutoff. Separately stated items and basis amounts are retained in the attached tax source.');
 ELSE RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 row_count:=jsonb_array_length(rows);
 result:=jsonb_build_object('definition_version',1,'report_id',report_id,'legal_name',(SELECT legal_name FROM public.business_profile WHERE id=1),'revision',(SELECT financial_revision::text FROM accounting.settings),'filter',params- 'limit','columns',columns,
 'rows',(SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality>offset_rows AND ordinality<=offset_rows+limit_rows),'count',row_count,'total_cells',total_cells,'notes',notes);
 IF controls IS NOT NULL THEN result:=result||jsonb_build_object('controls',controls);END IF;
 IF report_id='tax-workpapers' THEN result:=result||jsonb_build_object('tax_workpaper',source);END IF;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.sync_server(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c accounting.bank_connections; ba accounting.bank_accounts; observation accounting.bank_transactions; a jsonb; tx jsonb; normalized jsonb;
 provider_key text; discover_id uuid; new_checkpoint jsonb; discovered jsonb; zone text; run uuid:=coalesce((command->>'run_id')::uuid,gen_random_uuid());
 run_complete boolean:=coalesce((command->>'complete')::boolean,true);count_new integer:=0;count_pending integer:=0;count_drafts integer:=0;count_conflicts integer:=0; book_date date; amount bigint; existing_id uuid;
 candidate_id uuid; candidate_count integer; allocation bigint; draft jsonb; bank_line uuid; category uuid; account_complete boolean; balance_sign smallint; seen jsonb; blocked jsonb; conflicts_before integer; partial boolean:=coalesce((command->>'partial')::boolean,false); discovery_only boolean:=coalesce((command->>'discovery')::boolean,false);
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'ACCT_WORKER_REQUIRED'; END IF;
 PERFORM accounting.write_lock();
 PERFORM set_config('accounting.operation_id',run::text,true);PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.action','sync',true);
 IF command->>'action'='due' THEN
  RETURN coalesce((SELECT jsonb_agg(id ORDER BY next_sync_at NULLS FIRST,id) FROM accounting.bank_connections WHERE status='active' AND scheduled AND (next_sync_at IS NULL OR next_sync_at<=now()) AND (lease_until IS NULL OR lease_until<=now())),'[]');
 END IF;
 SELECT * INTO c FROM accounting.bank_connections WHERE id=(command->>'id')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 IF command->>'action' IN ('claim.send','claim.complete','claim.fail') THEN
  IF c.status<>'reconnect_required' OR c.checkpoint->'claim'->>'id' IS DISTINCT FROM command->>'claim_id' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  IF command->>'action'='claim.send' THEN
   IF c.checkpoint->'claim'->>'state'<>'prepared' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,'{claim,state}','"sent"') WHERE id=c.id;
  ELSIF command->>'action'='claim.complete' THEN
   IF c.checkpoint->'claim'->>'state'<>'sent' OR length(coalesce(command->>'ciphertext',''))<20 THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET access_url_encrypted=command->>'ciphertext',key_version=coalesce((command->>'key_version')::smallint,1),status='active',last_error='',checkpoint=jsonb_set(checkpoint,'{claim,state}','"completed"') WHERE id=c.id;
  ELSE
   IF c.checkpoint->'claim'->>'state'<>'sent' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET last_error=left(coalesce(command->>'error','Connection setup failed'),1000),checkpoint=jsonb_set(checkpoint,'{claim,state}','"failed"') WHERE id=c.id;
  END IF;
  RETURN jsonb_build_object('id',c.id);
 END IF;
 IF command->>'action'='lease' THEN
  IF c.status<>'active' OR (c.lease_until>now() AND c.lease_run_id<>run) THEN RETURN jsonb_build_object('id',c.id,'acquired',false); END IF;
  UPDATE accounting.bank_connections SET lease_run_id=run,lease_until=now()+interval '5 minutes',checkpoint=jsonb_set(checkpoint,ARRAY['sync_run'],CASE WHEN c.lease_run_id=run AND c.lease_until>now() THEN coalesce(checkpoint->'sync_run','{}') ELSE jsonb_build_object('seen','[]'::jsonb,'complete',true) END) WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'acquired',true,'run_id',run,'access_url_encrypted',c.access_url_encrypted,'key_version',c.key_version,'checkpoint',c.checkpoint,'books_timezone',(SELECT books_timezone FROM public.business_profile WHERE id=1),
   'identities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'provider_connection_id',(b.provider_account_id::jsonb)->>0,'provider_account_id',(b.provider_account_id::jsonb)->>1,
    'history_start',extract(epoch FROM (coalesce(b.coverage_from,(SELECT earliest_history_date FROM public.business_profile WHERE id=1))::timestamp AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1)))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'resume_floor',NULL)) FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed),'[]'));
 END IF;
 IF c.lease_run_id IS DISTINCT FROM run OR c.lease_until<=now() OR c.status<>'active' THEN RAISE EXCEPTION 'ACCT_STALE_LEASE'; END IF;
 IF command->>'action'='fail' THEN
  UPDATE accounting.bank_connections SET last_error=left(coalesce(command->>'error','Bank sync failed'),1000),
   status=CASE WHEN coalesce((command->>'reconnect_required')::boolean,false) THEN 'reconnect_required' ELSE status END,
   next_sync_at=now()+interval '1 hour',lease_run_id=NULL,lease_until=NULL WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'status','error');
 END IF;
 IF command->>'action'<>'complete' OR jsonb_typeof(command->'accounts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 zone:=(SELECT books_timezone FROM public.business_profile WHERE id=1);new_checkpoint:=c.checkpoint;
 discovered:=coalesce(c.checkpoint->'discovery','{}');seen:=coalesce(c.checkpoint->'sync_run'->'seen','[]');blocked:=coalesce(c.checkpoint->'sync_run'->'blocked','[]');
 run_complete:=run_complete AND coalesce((c.checkpoint->'sync_run'->>'complete')::boolean,true);
 FOR a IN SELECT value FROM jsonb_array_elements(command->'accounts') LOOP
  provider_key:=jsonb_build_array(a->>'provider_connection_id',a->>'provider_account_id')::text;
  discover_id:=md5(c.id::text||':'||provider_key)::uuid;
  discovered:=jsonb_set(discovered,ARRAY[discover_id::text],jsonb_build_object('id',discover_id,'provider_account_id',provider_key,'raw_provider_account_id',a->>'provider_account_id','provider_connection_id',a->>'provider_connection_id','name',a->>'name','institution',a->>'institution','currency',a->>'currency','balance_cents',a->>'balance_cents','available_cents',a->>'available_cents','balance_at',a->'balance_at','ownership',coalesce(discovered->discover_id::text->>'ownership','unreviewed')));
  SELECT * INTO ba FROM accounting.bank_accounts WHERE connection_id=c.id AND provider_account_id=provider_key AND NOT is_closed;
  IF NOT FOUND THEN CONTINUE; END IF;
  IF a->>'currency'<>'USD' THEN run_complete:=false; CONTINUE; END IF;
  IF NOT seen ? provider_key THEN seen:=seen||jsonb_build_array(provider_key); END IF;
  balance_sign:=coalesce((new_checkpoint->'balance_signs'->>ba.id::text)::smallint,1);
  IF a->>'balance_cents' IS NOT NULL AND a->>'balance_at' IS NOT NULL THEN
   UPDATE accounting.bank_accounts SET observed_balance_cents=(a->>'balance_cents')::bigint*balance_sign,observed_at=to_timestamp((a->>'balance_at')::bigint) WHERE id=ba.id;
  END IF;
  IF discovery_only THEN CONTINUE; END IF;
  conflicts_before:=count_conflicts;account_complete:=coalesce((a->>'complete')::boolean,false) AND NOT blocked ? provider_key;
  IF coalesce((a->>'chunk_partial')::boolean,false) THEN account_complete:=false; END IF;
  FOR tx IN SELECT value FROM jsonb_array_elements(coalesce(a->'transactions','[]')) LOOP
   IF (tx->>'state' IN ('pending','nonfinancial') OR (tx->>'amount_cents')::bigint=0) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=ba.id AND external_id=tx->>'external_id' AND state='posted') THEN
    account_complete:=false;count_conflicts:=count_conflicts+1;CONTINUE;
   END IF;
   IF tx->>'state'='pending' THEN count_pending:=count_pending+1; CONTINUE; END IF;
   IF tx->>'state'='nonfinancial' OR (tx->>'amount_cents')::bigint=0 THEN CONTINUE; END IF;
   book_date:=(to_timestamp((tx->>'posted')::bigint) AT TIME ZONE zone)::date;
   amount:=(tx->>'amount_cents')::bigint*ba.movement_sign;
   IF ba.coverage_from IS NOT NULL AND book_date<ba.coverage_from THEN CONTINUE; END IF;
   SELECT * INTO observation FROM accounting.bank_transactions WHERE bank_account_id=ba.id AND external_id=tx->>'external_id';
   IF FOUND THEN
    IF observation.content_hash IS DISTINCT FROM tx->>'hash' OR observation.amount_cents<>amount OR observation.posted_date<>book_date THEN
     account_complete:=false;count_conflicts:=count_conflicts+1;CONTINUE;
    END IF;
   ELSE
    INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,transacted_at,amount_cents,description,descriptor_key,content_hash,raw_payload,state)
     VALUES(ba.id,'simplefin',tx->>'external_id',book_date,to_timestamp((tx->>'transacted_at')::bigint),amount,tx->>'description',accounting.descriptor_key(tx->>'description'),tx->>'hash',tx->'raw','posted') RETURNING * INTO observation;
    count_new:=count_new+1;
   END IF;
   IF observation.review<>'unmatched' OR EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=observation.id) THEN CONTINUE; END IF;
   SELECT count(*),(array_agg(l.id ORDER BY e.entry_date,l.id))[1] INTO candidate_count,candidate_id
    FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=ba.account_id AND l.amount_cents=amount AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
     AND abs(e.entry_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
     AND (NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=l.id)
      OR EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions o ON o.id=m.bank_transaction_id WHERE m.journal_line_id=l.id AND m.amount_cents=abs(amount) AND o.source<>observation.source AND o.bank_account_id=ba.id AND o.amount_cents=amount AND abs(o.posted_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)));
   IF candidate_count=1 THEN
    allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=candidate_id) THEN 0 ELSE abs(amount) END;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents) VALUES(observation.id,candidate_id,allocation);
   ELSIF coalesce((command->>'create_drafts')::boolean,false) THEN
    -- Closed-period evidence stays unmatched for owner resolution; never shift its date.
    IF EXISTS(SELECT 1 FROM accounting.periods WHERE status='locked' AND month>=date_trunc('month',book_date)::date) THEN CONTINUE; END IF;
    SELECT id INTO category FROM accounting.accounts WHERE system_purpose=CASE WHEN amount>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
    draft:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',book_date,'memo',observation.description,'source_description',observation.description,'origin','simplefin','kind',CASE WHEN amount>0 THEN 'income' ELSE 'expense' END,
     'lines',jsonb_build_array(jsonb_build_object('account_id',ba.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',category,'amount_cents',(-amount)::text))));
    SELECT id INTO bank_line FROM accounting.journal_lines WHERE entry_id=(draft->>'id')::uuid AND account_id=ba.account_id;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents) VALUES(observation.id,bank_line,abs(amount));
    PERFORM accounting.apply_treatment((draft->>'id')::uuid);count_drafts:=count_drafts+1;
   END IF;
  END LOOP;
  IF count_conflicts>conflicts_before AND NOT blocked ? provider_key THEN blocked:=blocked||jsonb_build_array(provider_key); END IF;
  IF NOT account_complete AND NOT coalesce((a->>'chunk_partial')::boolean,false) THEN run_complete:=false; END IF;
  IF account_complete THEN
   new_checkpoint:=jsonb_set(new_checkpoint,ARRAY[provider_key],coalesce(a->'through',command->'through','null'));
  END IF;
 END LOOP;
 IF NOT partial AND NOT discovery_only AND EXISTS(SELECT 1 FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed AND NOT seen ? b.provider_account_id) THEN run_complete:=false; END IF;
 new_checkpoint:=jsonb_set(new_checkpoint,ARRAY['discovery'],discovered);
 new_checkpoint:=jsonb_set(new_checkpoint,ARRAY['sync_run'],jsonb_build_object('seen',seen,'blocked',blocked,'complete',run_complete AND count_conflicts=0));
 UPDATE accounting.bank_connections SET checkpoint=new_checkpoint,last_success_at=CASE WHEN NOT partial AND NOT discovery_only AND count_conflicts=0 AND run_complete THEN now() ELSE last_success_at END,
  last_error=CASE WHEN count_conflicts>0 THEN 'Provider records changed. Original evidence was retained; review before advancing coverage.' WHEN NOT run_complete THEN 'The provider reported incomplete account data.' ELSE '' END,
  lease_run_id=CASE WHEN partial THEN run ELSE NULL END,lease_until=CASE WHEN partial THEN c.lease_until ELSE NULL END,next_sync_at=now()+CASE WHEN run_complete AND count_conflicts=0 THEN interval '6 hours' ELSE interval '1 hour' END WHERE id=c.id;
 INSERT INTO accounting.audit_log(actor_kind,operation_id,table_name,row_id,action,after)
  VALUES('worker',run,'bank_connections',c.id,'sync',jsonb_build_object('accounts',jsonb_array_length(command->'accounts'),'new',count_new,'pending',count_pending,'drafts',count_drafts,'errors',count_conflicts));
 RETURN jsonb_build_object('id',c.id,'new',count_new,'pending',count_pending,'drafts',count_drafts,'conflicts',count_conflicts,'complete',run_complete AND count_conflicts=0);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=c->>'type';k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());y integer:=coalesce((c->>'tax_year')::integer,(c->>'year')::integer);actor uuid:=accounting.require_owner();m accounting.tax_mappings;link accounting.tax_links;mapped_concept text:=c->>'concept';body jsonb:=coalesce(c->'body',c->'forecast_inputs');estimate public.tax_estimates;method text;
BEGIN
 mapped_concept:=CASE mapped_concept WHEN 'ordinary_income' THEN 'gross_receipts' WHEN 'ordinary_expense' THEN 'other_deduction' WHEN 'officer_wages' THEN 'officer_compensation' WHEN 'meals' THEN 'meals_50' WHEN 'excluded_book' THEN 'balance_sheet_only' ELSE mapped_concept END;
 IF t IN ('tax.mapping','tax.mapping.save') THEN
  SELECT * INTO m FROM accounting.tax_mappings WHERE tax_year=y AND account_id=(c->>'account_id')::uuid;
  IF coalesce((c->>'expected_version')::integer,-1)<>coalesce(m.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(c->>'account_id')::uuid) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_NOT_FOUND';END IF;
  IF m.id IS NULL THEN INSERT INTO accounting.tax_mappings(id,tax_year,account_id,concept,deductible_bps,separately_stated,notes) VALUES(k,y,(c->>'account_id')::uuid,mapped_concept,coalesce((c->>'deductible_bps')::integer,CASE WHEN mapped_concept='meals_50' THEN 5000 ELSE 10000 END),coalesce((c->>'separately_stated')::boolean,mapped_concept IN ('qualified_dividend','short_gain','long_gain','charity','tax_exempt') OR (mapped_concept='interest' AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(c->>'account_id')::uuid AND type='income'))),coalesce(c->>'notes',c->>'reason','')) RETURNING * INTO m;
  ELSE UPDATE accounting.tax_mappings SET concept=mapped_concept,deductible_bps=coalesce((c->>'deductible_bps')::integer,CASE WHEN mapped_concept='meals_50' THEN 5000 ELSE 10000 END),separately_stated=coalesce((c->>'separately_stated')::boolean,mapped_concept IN ('qualified_dividend','short_gain','long_gain','charity','tax_exempt') OR (mapped_concept='interest' AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=m.account_id AND type='income'))),notes=coalesce(c->>'notes',c->>'reason','') WHERE id=m.id RETURNING * INTO m;END IF;
  RETURN jsonb_build_object('id',m.id,'version',m.version);
 ELSIF t IN ('tax.adjustment','tax.adjustment.save') THEN
  IF coalesce((c->>'expected_version')::integer,0)<>0 OR c->>'active'='false' THEN RAISE EXCEPTION 'ACCT_TAX_OFFSET_REQUIRED';END IF;
  IF c->>'document_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=(c->>'document_id')::uuid AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
  INSERT INTO accounting.tax_adjustments(id,tax_year,concept,effective_date,amount_cents,reason,document_id,created_by) VALUES(k,y,mapped_concept,coalesce((c->>'effective_date')::date,make_date(y,12,31)),(c->>'amount_cents')::bigint,c->>'reason',(c->>'document_id')::uuid,actor);
  RETURN jsonb_build_object('id',k,'version',1);
 ELSIF t='tax.link.save' THEN
  SELECT * INTO link FROM accounting.tax_links WHERE id=k;
  IF coalesce((c->>'expected_version')::integer,-1)<>coalesce(link.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  SELECT * INTO estimate FROM public.tax_estimates WHERE id=coalesce((c->>'tax_estimate_id')::uuid,(c->>'estimate_id')::uuid) AND deleted_at IS NULL;
  IF estimate.id IS NULL THEN RAISE EXCEPTION 'ACCT_TAX_ESTIMATE_NOT_FOUND';END IF;
  IF link.id IS NOT NULL AND link.tax_estimate_id<>estimate.id THEN RAISE EXCEPTION 'ACCT_TAX_LINK_IDENTITY';END IF;
  IF body IS NULL OR jsonb_typeof(body)<>'object' OR extract(year FROM (body->>'through')::date)<>estimate.tax_year THEN RAISE EXCEPTION 'ACCT_TAX_LINK_SCOPE';END IF;
  method:=CASE body->'forecast'->>'method' WHEN 'average' THEN 'average_months' WHEN 'prior_pattern' THEN 'prior_year_pattern' ELSE body->'forecast'->>'method' END;
  IF link.id IS NULL THEN INSERT INTO accounting.tax_links(id,tax_estimate_id,tax_year,cutoff_mode,cutoff_date,forecast_method,forecast_inputs) VALUES(k,estimate.id,estimate.tax_year,body->>'cutoff_mode',(body->>'through')::date,method,body||jsonb_build_object('enabled',coalesce((c->>'enabled')::boolean,true),'reason',coalesce(c->>'reason',''))) RETURNING * INTO link;
  ELSE UPDATE accounting.tax_links SET cutoff_mode=body->>'cutoff_mode',cutoff_date=(body->>'through')::date,forecast_method=method,forecast_inputs=body||jsonb_build_object('enabled',coalesce((c->>'enabled')::boolean,true),'reason',coalesce(c->>'reason','')),status='stale',error=NULL,inputs=inputs-'_refresh' WHERE id=k RETURNING * INTO link;END IF;
  RETURN jsonb_build_object('id',link.id,'version',link.version);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.write_lock();
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='tax_adjustments' AND TG_OP<>'INSERT') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_TAX_ADJUSTMENT';END IF;
 IF TG_TABLE_NAME IN ('tax_adjustments','tax_mappings') THEN
  IF NEW.concept NOT IN ('gross_receipts','cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','interest','other_deduction','nondeductible','distribution','contribution','balance_sheet_only','qualified_dividend','short_gain','long_gain','charity','tax_exempt','ordinary_adjustment','stock_basis_opening','debt_basis_opening') THEN RAISE EXCEPTION 'ACCT_TAX_CONCEPT';END IF;
  IF TG_TABLE_NAME='tax_mappings' AND NEW.concept IN ('ordinary_adjustment','stock_basis_opening','debt_basis_opening') THEN RAISE EXCEPTION 'ACCT_TAX_CONCEPT';END IF;
 END IF;
 IF TG_TABLE_NAME='tax_mappings' THEN
  IF NEW.deductible_bps NOT BETWEEN 0 AND 10000 OR
   (NEW.concept='gross_receipts' AND (NEW.deductible_bps<>10000 OR NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='income'))) OR
   (NEW.concept IN ('cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','other_deduction','charity') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='expense')) OR
   (NEW.concept IN ('qualified_dividend','short_gain','long_gain','tax_exempt') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='income')) OR
   (NEW.concept='interest' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type IN ('income','expense'))) OR
   (NEW.concept IN ('distribution','contribution') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='equity'))
   THEN RAISE EXCEPTION 'ACCT_TAX_MAPPING';END IF;
 END IF;
 IF TG_OP='UPDATE' THEN NEW.version:=CASE WHEN TG_TABLE_NAME='tax_links' AND current_setting('accounting.actor_kind',true)='worker' THEN OLD.version ELSE OLD.version+1 END;NEW.updated_at:=now();END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_lines(year integer, cutoff date)
 RETURNS TABLE(line_id uuid, entry_id uuid, entry_date date, account_id uuid, book_cents numeric, ordinary_cents numeric, concept text, mapping_current boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT l.id,e.id,e.entry_date,a.id,-l.amount_cents::numeric,
 CASE WHEN m.separately_stated THEN 0 WHEN m.concept='gross_receipts' THEN -l.amount_cents::numeric
 WHEN m.concept IN ('cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','interest','other_deduction') THEN -round(l.amount_cents::numeric*m.deductible_bps/10000) ELSE 0 END,
 m.concept,m.id IS NOT NULL
 FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id
 LEFT JOIN accounting.tax_mappings m ON m.account_id=a.id AND m.tax_year=year
 WHERE e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND cutoff AND a.type IN ('income','expense')
$function$
;

CREATE OR REPLACE FUNCTION accounting.tax_link(id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE l accounting.tax_links;e jsonb;personal_hash text;cutoff date;is_current boolean;
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO l FROM accounting.tax_links WHERE tax_links.id=tax_link.id OR tax_estimate_id=tax_link.id;
 SELECT to_jsonb(t) INTO e FROM public.tax_estimates t WHERE t.id=coalesce(l.tax_estimate_id,tax_link.id) AND deleted_at IS NULL;
 personal_hash:=encode(sha256(convert_to(e::text,'UTF8')),'hex');
 cutoff:=CASE WHEN l.cutoff_mode='fixed' THEN l.cutoff_date ELSE least(make_date(l.tax_year,12,31),(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE business_profile.id=1))::date) END;
 is_current:=coalesce(l.status='fresh' AND l.financial_revision=(SELECT financial_revision FROM accounting.settings) AND l.inputs->>'personal_hash'=personal_hash AND l.inputs->>'through'=cutoff::text AND l.inputs->>'profile_hash'=encode(sha256(convert_to((SELECT to_jsonb(p)::text FROM public.business_profile p WHERE p.id=1),'UTF8')),'hex'),false);
 RETURN jsonb_build_object('estimate',e,'personal_hash',personal_hash,'current',is_current,'link',CASE WHEN l.id IS NULL THEN NULL ELSE (to_jsonb(l)-ARRAY['inputs','results'])||jsonb_build_object('financial_revision',l.financial_revision::text,'estimate_id',l.tax_estimate_id,'enabled',coalesce((l.forecast_inputs->>'enabled')::boolean,true),'body',l.forecast_inputs-ARRAY['enabled','reason'],'reason',coalesce(l.forecast_inputs->>'reason',''),'status',CASE WHEN l.status='fresh' AND NOT is_current THEN 'stale' ELSE l.status END) END,
 'snapshot',CASE WHEN l.computed_at IS NULL THEN NULL ELSE jsonb_build_object('id',l.id,'link_id',l.id,'link_version',l.inputs->'link_version','financial_revision',l.financial_revision::text,'personal_hash',l.inputs->'personal_hash','through_date',l.inputs->'through','created_at',l.computed_at,'payload',l.results,'inputs',l.inputs->'calculation') END);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_refresh_server(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE t text:=command->>'type';l accounting.tax_links;e jsonb;cutoff date;ph text;profile_hash text;rev bigint;token uuid;calc jsonb;prior jsonb;exclusions jsonb;payroll jsonb;ytd_run accounting.payroll_runs;refresh jsonb;ids jsonb;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'ACCT_WORKER_REQUIRED';END IF;
 PERFORM accounting.write_lock();PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.operation_id',gen_random_uuid()::text,true);PERFORM set_config('accounting.action','tax_refresh',true);
 IF t='due' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id) ORDER BY computed_at NULLS FIRST,id),'[]') INTO ids FROM (
   SELECT tl.id,tl.computed_at FROM accounting.tax_links tl JOIN public.tax_estimates te ON te.id=tl.tax_estimate_id AND te.deleted_at IS NULL CROSS JOIN public.business_profile bp CROSS JOIN accounting.settings st
   WHERE coalesce((tl.forecast_inputs->>'enabled')::boolean,true) AND coalesce((tl.inputs->'_refresh'->>'until')::timestamptz,'-infinity')<=now() AND coalesce((tl.inputs->>'retry_after')::timestamptz,'-infinity')<=now()
   AND (tl.status<>'fresh' OR tl.financial_revision<>st.financial_revision OR tl.inputs->>'personal_hash' IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(te)::text,'UTF8')),'hex') OR tl.inputs->>'profile_hash' IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(bp)::text,'UTF8')),'hex') OR tl.inputs->>'through' IS DISTINCT FROM (CASE WHEN tl.cutoff_mode='fixed' THEN tl.cutoff_date ELSE least(make_date(tl.tax_year,12,31),(now() AT TIME ZONE bp.books_timezone)::date) END)::text)
   ORDER BY tl.computed_at NULLS FIRST,tl.id LIMIT 25) q;
  RETURN ids;
 END IF;
 SELECT * INTO l FROM accounting.tax_links WHERE id=(command->>'link_id')::uuid FOR UPDATE;
 IF l.id IS NULL THEN RAISE EXCEPTION 'ACCT_TAX_LINK_NOT_FOUND';END IF;
 SELECT to_jsonb(te) INTO e FROM public.tax_estimates te WHERE te.id=l.tax_estimate_id AND deleted_at IS NULL;
 IF e IS NULL THEN RETURN jsonb_build_object('state','disabled');END IF;
 ph:=encode(sha256(convert_to(e::text,'UTF8')),'hex');profile_hash:=encode(sha256(convert_to((SELECT to_jsonb(p)::text FROM public.business_profile p WHERE p.id=1),'UTF8')),'hex');SELECT financial_revision INTO rev FROM accounting.settings;
 cutoff:=CASE WHEN l.cutoff_mode='fixed' THEN l.cutoff_date ELSE least(make_date(l.tax_year,12,31),(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date) END;
 IF cutoff<make_date(l.tax_year,1,1) OR NOT coalesce((l.forecast_inputs->>'enabled')::boolean,true) THEN RETURN jsonb_build_object('state','disabled');END IF;
 IF t='start' THEN
  IF NOT coalesce((command->>'force')::boolean,false) AND l.status='fresh' AND l.financial_revision=rev AND l.inputs->>'personal_hash'=ph AND l.inputs->>'profile_hash'=profile_hash AND l.inputs->>'through'=cutoff::text THEN RETURN jsonb_build_object('state','fresh','snapshot_id',l.id);END IF;
  IF (l.inputs->'_refresh'->>'until')::timestamptz>now() THEN RETURN jsonb_build_object('state','busy');END IF;
  token:=gen_random_uuid();prior:=CASE WHEN l.forecast_method='prior_year_pattern' THEN accounting.tax_source(l.tax_year-1,make_date(l.tax_year-1,12,31)) ELSE NULL END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('entry_id',entry_id,'entry_date',entry_date,'ordinary_cents',amount::text)),'[]') INTO exclusions FROM (
   SELECT x.entry_id,x.entry_date,sum(x.ordinary_cents) amount FROM accounting.tax_lines(CASE WHEN l.forecast_method='prior_year_pattern' THEN l.tax_year-1 ELSE l.tax_year END,CASE WHEN l.forecast_method='prior_year_pattern' THEN make_date(l.tax_year-1,12,31) ELSE cutoff END) x WHERE x.entry_id::text IN(SELECT value->>'entry_id' FROM jsonb_array_elements(coalesce(l.forecast_inputs->'forecast'->'exclusions','[]'))) GROUP BY x.entry_id,x.entry_date) q;
  SELECT p.* INTO ytd_run FROM accounting.payroll_runs p JOIN accounting.journal_entries je ON je.id=p.entry_id WHERE p.pay_date BETWEEN make_date(l.tax_year,1,1) AND cutoff AND je.status='posted' AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=je.id AND re.status='posted' AND re.entry_date<=cutoff) ORDER BY p.pay_date DESC,p.created_at DESC,p.id LIMIT 1;
  IF ytd_run.id IS NOT NULL AND ytd_run.ytd->>'verified'='true' AND EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=ytd_run.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)) THEN payroll:=jsonb_build_object('year',l.tax_year,'coverage',jsonb_build_object('current',true,'through_date',cutoff,'source_through_date',ytd_run.pay_date,'document_id',ytd_run.document_id,'employees',coalesce(ytd_run.ytd->'employees','[]')));END IF;
  calc:=jsonb_build_object('link',jsonb_build_object('id',l.id,'version',l.version,'body',l.forecast_inputs-ARRAY['enabled','reason']),'estimate',e,'source',accounting.tax_source(l.tax_year,cutoff),'forecast_evidence',jsonb_build_object('prior',prior,'exclusions',exclusions),'payroll',payroll,
  'manual_review_document_available',EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=(l.forecast_inputs->'manual_separate_review'->>'document_id')::uuid AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)),
  'after_cutoff_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='posted' AND entry_date>cutoff AND entry_date<=make_date(l.tax_year,12,31)));
  refresh:=jsonb_build_object('token',token,'until',now()+interval '5 minutes','revision',rev::text,'personal_hash',ph,'profile_hash',profile_hash,'through',cutoff,'calculation',calc);
  UPDATE accounting.tax_links SET inputs=jsonb_set(inputs,'{_refresh}',refresh),status='stale',error=NULL WHERE id=l.id;
  RETURN jsonb_build_object('state','running','lease_token',token,'inputs',calc);
 ELSIF t IN ('finish','fail') THEN
  refresh:=l.inputs->'_refresh';
  IF t='finish' AND l.inputs->>'refresh_token'=command->>'lease_token' THEN
   IF l.results IS DISTINCT FROM command->'payload' THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT';END IF;RETURN jsonb_build_object('state','fresh','snapshot_id',l.id);END IF;
  IF refresh IS NULL OR refresh->>'token' IS DISTINCT FROM command->>'lease_token' OR (refresh->>'until')::timestamptz<=now() THEN RETURN jsonb_build_object('state','superseded');END IF;
  IF refresh->>'revision'<>rev::text OR refresh->>'personal_hash'<>ph OR refresh->>'profile_hash'<>profile_hash OR refresh->>'through'<>cutoff::text THEN
   UPDATE accounting.tax_links SET inputs=inputs-'_refresh',status='stale' WHERE id=l.id;RETURN jsonb_build_object('state','stale');END IF;
  IF t='fail' THEN UPDATE accounting.tax_links SET inputs=(inputs-'_refresh')||jsonb_build_object('retry_after',now()+interval '5 minutes'),status='error',error=left(command->>'error',2000) WHERE id=l.id;RETURN jsonb_build_object('state','failed');END IF;
  IF jsonb_typeof(command->'payload') IS DISTINCT FROM 'object' OR NOT command->'payload'?'outputs' OR NOT command->'payload'?'calculation' THEN RAISE EXCEPTION 'ACCT_TAX_RESULT';END IF;
  UPDATE accounting.tax_links SET inputs=(refresh-ARRAY['token','until','revision'])||jsonb_build_object('refresh_token',refresh->'token','link_version',refresh->'calculation'->'link'->'version'),results=command->'payload',financial_revision=rev,status='fresh',error=NULL,computed_at=now() WHERE id=l.id;
  RETURN jsonb_build_object('state','fresh','snapshot_id',l.id);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.tax_source(year integer, cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE accounts jsonb;adjustments jsonb;monthly jsonb;separate jsonb;result jsonb;ordinary numeric;adjusted numeric;book numeric;missing integer;report_data jsonb;
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_owner();END IF;
 IF year IS NULL OR cutoff IS NULL OR year NOT BETWEEN 1900 AND 2100 OR extract(year FROM cutoff)<>year OR cutoff>(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 report_data:=accounting.report('profit_loss',jsonb_build_object('from',make_date(year,1,1),'to',cutoff));book:=(report_data->>'net_income_cents')::numeric;
 WITH grouped AS(SELECT account_id,sum(book_cents) book,sum(ordinary_cents) ordinary,count(*) n FROM accounting.tax_lines(year,cutoff) GROUP BY account_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',a.id,'name',a.name,'code',a.code,'account_type',a.type,'mapping',CASE WHEN m.id IS NULL THEN NULL ELSE to_jsonb(m) END,
 'book_cents',coalesce(g.book,0)::text,'ordinary_cents',coalesce(g.ordinary,0)::text,'line_count',coalesce(g.n,0),'current',m.id IS NOT NULL) ORDER BY a.code,a.name,a.id),'[]') INTO accounts
 FROM accounting.accounts a LEFT JOIN grouped g ON g.account_id=a.id LEFT JOIN accounting.tax_mappings m ON m.account_id=a.id AND m.tax_year=year WHERE a.type IN ('income','expense') AND (g.n>0 OR NOT a.is_archived);
 SELECT coalesce(sum(ordinary_cents),0),count(DISTINCT account_id) FILTER(WHERE NOT mapping_current) INTO ordinary,missing FROM accounting.tax_lines(year,cutoff);
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text,'current',true,'active',true,'version',1) ORDER BY effective_date,id),'[]'),
 ordinary+coalesce(sum(a.amount_cents) FILTER(WHERE a.concept NOT IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt')),0)
 INTO adjustments,adjusted FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff;
 WITH months AS(SELECT d::date AS month FROM generate_series(make_date(year,1,1),date_trunc('month',cutoff),interval '1 month') d),
 lines AS(SELECT date_trunc('month',entry_date)::date AS month,sum(book_cents) book,sum(ordinary_cents) ordinary FROM accounting.tax_lines(year,cutoff) GROUP BY 1),
 adj AS(SELECT date_trunc('month',effective_date)::date AS month,sum(amount_cents) amount FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.concept NOT IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') GROUP BY 1)
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',m.month,'book_cents',coalesce(l.book,0)::text,'ordinary_cents',(coalesce(l.ordinary,0)+coalesce(a.amount,0))::text,
 'complete',(m.month+interval '1 month -1 day')::date<=cutoff AND EXISTS(SELECT 1 FROM accounting.periods p WHERE p.month=m.month AND p.status='locked')) ORDER BY m.month),'[]') INTO monthly FROM months m LEFT JOIN lines l USING(month) LEFT JOIN adj a USING(month);
 SELECT coalesce(jsonb_object_agg(concept,amount::text),'{}') INTO separate FROM (
 SELECT concept,sum(amount) amount FROM (
 SELECT m.concept,-sum(l.amount_cents)::numeric amount FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.tax_mappings m ON m.account_id=l.account_id AND m.tax_year=year WHERE e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND cutoff AND m.separately_stated GROUP BY m.concept
 UNION ALL SELECT a.concept,sum(a.amount_cents)::numeric FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.concept IN ('interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') GROUP BY a.concept) s GROUP BY concept) q;
 result:=jsonb_build_object('year',year,'through',cutoff,'revision',report_data->'revision','year_settings',(SELECT jsonb_build_object('classification',tax_classification,'current',tax_classification IS NOT NULL AND (tax_classification_since IS NULL OR tax_classification_since<=year)) FROM public.business_profile WHERE id=1),
 'accounts',accounts,'adjustments',adjustments,'basis',NULL,'monthly',monthly,'separately_stated',separate,'book_profit_cents',book::text,'mapped_ordinary_cents',ordinary::text,'adjusted_ordinary_cents',adjusted::text,'book_to_tax_cents',(adjusted-book)::text,'unmapped_accounts',missing,
 'drafts',report_data->'quality'->'draft_count','incomplete_imports',report_data->'quality'->'incomplete_imports',
 'unavailable_adjustments',(SELECT count(*) FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=a.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc');
BEGIN
 PERFORM accounting.require_owner();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded') OR (f->>'from')::date>(f->>'to')::date THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) ELSE e.status=f->>'status' END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR e.payee_id=(f->>'payee')::uuid)
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (f->>'query' IS NULL OR e.memo ILIKE '%'||(f->>'query')||'%' OR e.source_description ILIKE '%'||(f->>'query')||'%')
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft')) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.workspace(from_date date, to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r jsonb;tx jsonb;
BEGIN
 PERFORM accounting.require_owner();r:=accounting.report('summary',jsonb_build_object('from',from_date,'to',to_date));tx:=accounting.transactions(jsonb_build_object('from',from_date,'to',to_date));
 RETURN jsonb_build_object('legal_name',r->'legal_name','revision',r->'revision','from',from_date,'to',to_date,'accounts',r->'accounts','balances',r->'accounts','entries',tx->'entries','entry_count',tx->'total','draft_count',r->'quality'->'draft_count',
 'needs_review_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft'),'sync_due',EXISTS(SELECT 1 FROM accounting.bank_connections WHERE status='active' AND scheduled AND (last_success_at IS NULL OR last_success_at<now()-interval '6 hours')),
 'reports',r-ARRAY['legal_name','revision','definition_version','currency','basis','generated_at','filter','accounts','rows','totals','comparison','monthly','dimensions','cash','quality']);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.write_lock()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(64219071);
 PERFORM 1 FROM accounting.settings WHERE id=1 FOR UPDATE;
END $function$
;

REVOKE ALL ON TABLE accounting.accounts FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.accounts TO "postgres";

GRANT SELECT ON TABLE accounting.accounts TO "postgres";

GRANT UPDATE ON TABLE accounting.accounts TO "postgres";

GRANT DELETE ON TABLE accounting.accounts TO "postgres";

GRANT TRUNCATE ON TABLE accounting.accounts TO "postgres";

GRANT REFERENCES ON TABLE accounting.accounts TO "postgres";

GRANT TRIGGER ON TABLE accounting.accounts TO "postgres";

GRANT MAINTAIN ON TABLE accounting.accounts TO "postgres";

REVOKE ALL ON TABLE accounting.audit_log FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.audit_log TO "postgres";

GRANT SELECT ON TABLE accounting.audit_log TO "postgres";

GRANT UPDATE ON TABLE accounting.audit_log TO "postgres";

GRANT DELETE ON TABLE accounting.audit_log TO "postgres";

GRANT TRUNCATE ON TABLE accounting.audit_log TO "postgres";

GRANT REFERENCES ON TABLE accounting.audit_log TO "postgres";

GRANT TRIGGER ON TABLE accounting.audit_log TO "postgres";

GRANT MAINTAIN ON TABLE accounting.audit_log TO "postgres";

REVOKE ALL ON TABLE accounting.bank_accounts FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.bank_accounts TO "postgres";

GRANT SELECT ON TABLE accounting.bank_accounts TO "postgres";

GRANT UPDATE ON TABLE accounting.bank_accounts TO "postgres";

GRANT DELETE ON TABLE accounting.bank_accounts TO "postgres";

GRANT TRUNCATE ON TABLE accounting.bank_accounts TO "postgres";

GRANT REFERENCES ON TABLE accounting.bank_accounts TO "postgres";

GRANT TRIGGER ON TABLE accounting.bank_accounts TO "postgres";

GRANT MAINTAIN ON TABLE accounting.bank_accounts TO "postgres";

REVOKE ALL ON TABLE accounting.bank_connections FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.bank_connections TO "postgres";

GRANT SELECT ON TABLE accounting.bank_connections TO "postgres";

GRANT UPDATE ON TABLE accounting.bank_connections TO "postgres";

GRANT DELETE ON TABLE accounting.bank_connections TO "postgres";

GRANT TRUNCATE ON TABLE accounting.bank_connections TO "postgres";

GRANT REFERENCES ON TABLE accounting.bank_connections TO "postgres";

GRANT TRIGGER ON TABLE accounting.bank_connections TO "postgres";

GRANT MAINTAIN ON TABLE accounting.bank_connections TO "postgres";

REVOKE ALL ON TABLE accounting.bank_matches FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.bank_matches TO "postgres";

GRANT SELECT ON TABLE accounting.bank_matches TO "postgres";

GRANT UPDATE ON TABLE accounting.bank_matches TO "postgres";

GRANT DELETE ON TABLE accounting.bank_matches TO "postgres";

GRANT TRUNCATE ON TABLE accounting.bank_matches TO "postgres";

GRANT REFERENCES ON TABLE accounting.bank_matches TO "postgres";

GRANT TRIGGER ON TABLE accounting.bank_matches TO "postgres";

GRANT MAINTAIN ON TABLE accounting.bank_matches TO "postgres";

REVOKE ALL ON TABLE accounting.bank_transactions FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.bank_transactions TO "postgres";

GRANT SELECT ON TABLE accounting.bank_transactions TO "postgres";

GRANT UPDATE ON TABLE accounting.bank_transactions TO "postgres";

GRANT DELETE ON TABLE accounting.bank_transactions TO "postgres";

GRANT TRUNCATE ON TABLE accounting.bank_transactions TO "postgres";

GRANT REFERENCES ON TABLE accounting.bank_transactions TO "postgres";

GRANT TRIGGER ON TABLE accounting.bank_transactions TO "postgres";

GRANT MAINTAIN ON TABLE accounting.bank_transactions TO "postgres";

REVOKE ALL ON TABLE accounting.command_receipts FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.command_receipts TO "postgres";

GRANT SELECT ON TABLE accounting.command_receipts TO "postgres";

GRANT UPDATE ON TABLE accounting.command_receipts TO "postgres";

GRANT DELETE ON TABLE accounting.command_receipts TO "postgres";

GRANT TRUNCATE ON TABLE accounting.command_receipts TO "postgres";

GRANT REFERENCES ON TABLE accounting.command_receipts TO "postgres";

GRANT TRIGGER ON TABLE accounting.command_receipts TO "postgres";

GRANT MAINTAIN ON TABLE accounting.command_receipts TO "postgres";

REVOKE ALL ON TABLE accounting.document_links FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.document_links TO "postgres";

GRANT SELECT ON TABLE accounting.document_links TO "postgres";

GRANT UPDATE ON TABLE accounting.document_links TO "postgres";

GRANT DELETE ON TABLE accounting.document_links TO "postgres";

GRANT TRUNCATE ON TABLE accounting.document_links TO "postgres";

GRANT REFERENCES ON TABLE accounting.document_links TO "postgres";

GRANT TRIGGER ON TABLE accounting.document_links TO "postgres";

GRANT MAINTAIN ON TABLE accounting.document_links TO "postgres";

REVOKE ALL ON TABLE accounting.documents FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.documents TO "postgres";

GRANT SELECT ON TABLE accounting.documents TO "postgres";

GRANT UPDATE ON TABLE accounting.documents TO "postgres";

GRANT DELETE ON TABLE accounting.documents TO "postgres";

GRANT TRUNCATE ON TABLE accounting.documents TO "postgres";

GRANT REFERENCES ON TABLE accounting.documents TO "postgres";

GRANT TRIGGER ON TABLE accounting.documents TO "postgres";

GRANT MAINTAIN ON TABLE accounting.documents TO "postgres";

REVOKE ALL ON TABLE accounting.history_checks FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.history_checks TO "postgres";

GRANT SELECT ON TABLE accounting.history_checks TO "postgres";

GRANT UPDATE ON TABLE accounting.history_checks TO "postgres";

GRANT DELETE ON TABLE accounting.history_checks TO "postgres";

GRANT TRUNCATE ON TABLE accounting.history_checks TO "postgres";

GRANT REFERENCES ON TABLE accounting.history_checks TO "postgres";

GRANT TRIGGER ON TABLE accounting.history_checks TO "postgres";

GRANT MAINTAIN ON TABLE accounting.history_checks TO "postgres";

REVOKE ALL ON TABLE accounting.import_batches FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.import_batches TO "postgres";

GRANT SELECT ON TABLE accounting.import_batches TO "postgres";

GRANT UPDATE ON TABLE accounting.import_batches TO "postgres";

GRANT DELETE ON TABLE accounting.import_batches TO "postgres";

GRANT TRUNCATE ON TABLE accounting.import_batches TO "postgres";

GRANT REFERENCES ON TABLE accounting.import_batches TO "postgres";

GRANT TRIGGER ON TABLE accounting.import_batches TO "postgres";

GRANT MAINTAIN ON TABLE accounting.import_batches TO "postgres";

REVOKE ALL ON TABLE accounting.import_rows FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.import_rows TO "postgres";

GRANT SELECT ON TABLE accounting.import_rows TO "postgres";

GRANT UPDATE ON TABLE accounting.import_rows TO "postgres";

GRANT DELETE ON TABLE accounting.import_rows TO "postgres";

GRANT TRUNCATE ON TABLE accounting.import_rows TO "postgres";

GRANT REFERENCES ON TABLE accounting.import_rows TO "postgres";

GRANT TRIGGER ON TABLE accounting.import_rows TO "postgres";

GRANT MAINTAIN ON TABLE accounting.import_rows TO "postgres";

REVOKE ALL ON TABLE accounting.journal_entries FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.journal_entries TO "postgres";

GRANT SELECT ON TABLE accounting.journal_entries TO "postgres";

GRANT UPDATE ON TABLE accounting.journal_entries TO "postgres";

GRANT DELETE ON TABLE accounting.journal_entries TO "postgres";

GRANT TRUNCATE ON TABLE accounting.journal_entries TO "postgres";

GRANT REFERENCES ON TABLE accounting.journal_entries TO "postgres";

GRANT TRIGGER ON TABLE accounting.journal_entries TO "postgres";

GRANT MAINTAIN ON TABLE accounting.journal_entries TO "postgres";

REVOKE ALL ON TABLE accounting.journal_lines FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.journal_lines TO "postgres";

GRANT SELECT ON TABLE accounting.journal_lines TO "postgres";

GRANT UPDATE ON TABLE accounting.journal_lines TO "postgres";

GRANT DELETE ON TABLE accounting.journal_lines TO "postgres";

GRANT TRUNCATE ON TABLE accounting.journal_lines TO "postgres";

GRANT REFERENCES ON TABLE accounting.journal_lines TO "postgres";

GRANT TRIGGER ON TABLE accounting.journal_lines TO "postgres";

GRANT MAINTAIN ON TABLE accounting.journal_lines TO "postgres";

REVOKE ALL ON TABLE accounting.parties FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.parties TO "postgres";

GRANT SELECT ON TABLE accounting.parties TO "postgres";

GRANT UPDATE ON TABLE accounting.parties TO "postgres";

GRANT DELETE ON TABLE accounting.parties TO "postgres";

GRANT TRUNCATE ON TABLE accounting.parties TO "postgres";

GRANT REFERENCES ON TABLE accounting.parties TO "postgres";

GRANT TRIGGER ON TABLE accounting.parties TO "postgres";

GRANT MAINTAIN ON TABLE accounting.parties TO "postgres";

REVOKE ALL ON TABLE accounting.payee_aliases FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.payee_aliases TO "postgres";

GRANT SELECT ON TABLE accounting.payee_aliases TO "postgres";

GRANT UPDATE ON TABLE accounting.payee_aliases TO "postgres";

GRANT DELETE ON TABLE accounting.payee_aliases TO "postgres";

GRANT TRUNCATE ON TABLE accounting.payee_aliases TO "postgres";

GRANT REFERENCES ON TABLE accounting.payee_aliases TO "postgres";

GRANT TRIGGER ON TABLE accounting.payee_aliases TO "postgres";

GRANT MAINTAIN ON TABLE accounting.payee_aliases TO "postgres";

REVOKE ALL ON TABLE accounting.payroll_runs FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.payroll_runs TO "postgres";

GRANT SELECT ON TABLE accounting.payroll_runs TO "postgres";

GRANT UPDATE ON TABLE accounting.payroll_runs TO "postgres";

GRANT DELETE ON TABLE accounting.payroll_runs TO "postgres";

GRANT TRUNCATE ON TABLE accounting.payroll_runs TO "postgres";

GRANT REFERENCES ON TABLE accounting.payroll_runs TO "postgres";

GRANT TRIGGER ON TABLE accounting.payroll_runs TO "postgres";

GRANT MAINTAIN ON TABLE accounting.payroll_runs TO "postgres";

REVOKE ALL ON TABLE accounting.periods FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.periods TO "postgres";

GRANT SELECT ON TABLE accounting.periods TO "postgres";

GRANT UPDATE ON TABLE accounting.periods TO "postgres";

GRANT DELETE ON TABLE accounting.periods TO "postgres";

GRANT TRUNCATE ON TABLE accounting.periods TO "postgres";

GRANT REFERENCES ON TABLE accounting.periods TO "postgres";

GRANT TRIGGER ON TABLE accounting.periods TO "postgres";

GRANT MAINTAIN ON TABLE accounting.periods TO "postgres";

REVOKE ALL ON TABLE accounting.reconciliation_items FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.reconciliation_items TO "postgres";

GRANT SELECT ON TABLE accounting.reconciliation_items TO "postgres";

GRANT UPDATE ON TABLE accounting.reconciliation_items TO "postgres";

GRANT DELETE ON TABLE accounting.reconciliation_items TO "postgres";

GRANT TRUNCATE ON TABLE accounting.reconciliation_items TO "postgres";

GRANT REFERENCES ON TABLE accounting.reconciliation_items TO "postgres";

GRANT TRIGGER ON TABLE accounting.reconciliation_items TO "postgres";

GRANT MAINTAIN ON TABLE accounting.reconciliation_items TO "postgres";

REVOKE ALL ON TABLE accounting.reconciliations FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.reconciliations TO "postgres";

GRANT SELECT ON TABLE accounting.reconciliations TO "postgres";

GRANT UPDATE ON TABLE accounting.reconciliations TO "postgres";

GRANT DELETE ON TABLE accounting.reconciliations TO "postgres";

GRANT TRUNCATE ON TABLE accounting.reconciliations TO "postgres";

GRANT REFERENCES ON TABLE accounting.reconciliations TO "postgres";

GRANT TRIGGER ON TABLE accounting.reconciliations TO "postgres";

GRANT MAINTAIN ON TABLE accounting.reconciliations TO "postgres";

REVOKE ALL ON TABLE accounting.registers FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.registers TO "postgres";

GRANT SELECT ON TABLE accounting.registers TO "postgres";

GRANT UPDATE ON TABLE accounting.registers TO "postgres";

GRANT DELETE ON TABLE accounting.registers TO "postgres";

GRANT TRUNCATE ON TABLE accounting.registers TO "postgres";

GRANT REFERENCES ON TABLE accounting.registers TO "postgres";

GRANT TRIGGER ON TABLE accounting.registers TO "postgres";

GRANT MAINTAIN ON TABLE accounting.registers TO "postgres";

REVOKE ALL ON TABLE accounting.report_snapshots FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.report_snapshots TO "postgres";

GRANT SELECT ON TABLE accounting.report_snapshots TO "postgres";

GRANT UPDATE ON TABLE accounting.report_snapshots TO "postgres";

GRANT DELETE ON TABLE accounting.report_snapshots TO "postgres";

GRANT TRUNCATE ON TABLE accounting.report_snapshots TO "postgres";

GRANT REFERENCES ON TABLE accounting.report_snapshots TO "postgres";

GRANT TRIGGER ON TABLE accounting.report_snapshots TO "postgres";

GRANT MAINTAIN ON TABLE accounting.report_snapshots TO "postgres";

REVOKE ALL ON TABLE accounting.rules FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.rules TO "postgres";

GRANT SELECT ON TABLE accounting.rules TO "postgres";

GRANT UPDATE ON TABLE accounting.rules TO "postgres";

GRANT DELETE ON TABLE accounting.rules TO "postgres";

GRANT TRUNCATE ON TABLE accounting.rules TO "postgres";

GRANT REFERENCES ON TABLE accounting.rules TO "postgres";

GRANT TRIGGER ON TABLE accounting.rules TO "postgres";

GRANT MAINTAIN ON TABLE accounting.rules TO "postgres";

REVOKE ALL ON TABLE accounting.settings FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.settings TO "postgres";

GRANT SELECT ON TABLE accounting.settings TO "postgres";

GRANT UPDATE ON TABLE accounting.settings TO "postgres";

GRANT DELETE ON TABLE accounting.settings TO "postgres";

GRANT TRUNCATE ON TABLE accounting.settings TO "postgres";

GRANT REFERENCES ON TABLE accounting.settings TO "postgres";

GRANT TRIGGER ON TABLE accounting.settings TO "postgres";

GRANT MAINTAIN ON TABLE accounting.settings TO "postgres";

REVOKE ALL ON TABLE accounting.tax_adjustments FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.tax_adjustments TO "postgres";

GRANT SELECT ON TABLE accounting.tax_adjustments TO "postgres";

GRANT UPDATE ON TABLE accounting.tax_adjustments TO "postgres";

GRANT DELETE ON TABLE accounting.tax_adjustments TO "postgres";

GRANT TRUNCATE ON TABLE accounting.tax_adjustments TO "postgres";

GRANT REFERENCES ON TABLE accounting.tax_adjustments TO "postgres";

GRANT TRIGGER ON TABLE accounting.tax_adjustments TO "postgres";

GRANT MAINTAIN ON TABLE accounting.tax_adjustments TO "postgres";

REVOKE ALL ON TABLE accounting.tax_links FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.tax_links TO "postgres";

GRANT SELECT ON TABLE accounting.tax_links TO "postgres";

GRANT UPDATE ON TABLE accounting.tax_links TO "postgres";

GRANT DELETE ON TABLE accounting.tax_links TO "postgres";

GRANT TRUNCATE ON TABLE accounting.tax_links TO "postgres";

GRANT REFERENCES ON TABLE accounting.tax_links TO "postgres";

GRANT TRIGGER ON TABLE accounting.tax_links TO "postgres";

GRANT MAINTAIN ON TABLE accounting.tax_links TO "postgres";

REVOKE ALL ON TABLE accounting.tax_mappings FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE accounting.tax_mappings TO "postgres";

GRANT SELECT ON TABLE accounting.tax_mappings TO "postgres";

GRANT UPDATE ON TABLE accounting.tax_mappings TO "postgres";

GRANT DELETE ON TABLE accounting.tax_mappings TO "postgres";

GRANT TRUNCATE ON TABLE accounting.tax_mappings TO "postgres";

GRANT REFERENCES ON TABLE accounting.tax_mappings TO "postgres";

GRANT TRIGGER ON TABLE accounting.tax_mappings TO "postgres";

GRANT MAINTAIN ON TABLE accounting.tax_mappings TO "postgres";

REVOKE ALL ON TABLE public.business_profile FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE public.business_profile TO "postgres";

GRANT SELECT ON TABLE public.business_profile TO "postgres";

GRANT UPDATE ON TABLE public.business_profile TO "postgres";

GRANT DELETE ON TABLE public.business_profile TO "postgres";

GRANT TRUNCATE ON TABLE public.business_profile TO "postgres";

GRANT REFERENCES ON TABLE public.business_profile TO "postgres";

GRANT TRIGGER ON TABLE public.business_profile TO "postgres";

GRANT MAINTAIN ON TABLE public.business_profile TO "postgres";

GRANT INSERT ON TABLE public.business_profile TO "authenticated";

GRANT SELECT ON TABLE public.business_profile TO "authenticated";

GRANT UPDATE ON TABLE public.business_profile TO "authenticated";

GRANT DELETE ON TABLE public.business_profile TO "authenticated";

REVOKE ALL ON FUNCTION accounting.apply_treatment(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.apply_treatment(uuid) TO "postgres";

REVOKE ALL ON FUNCTION accounting.balance_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.balance_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.bank_review(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.bank_review(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.bank_review(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.banking_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.banking_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.banking_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.banking_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.books_package(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.books_package(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.books_package(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION business_profile_get() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION business_profile_get() TO "postgres";

GRANT EXECUTE ON FUNCTION business_profile_get() TO "authenticated";

REVOKE ALL ON FUNCTION business_profile_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION business_profile_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.cash_lines(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.cash_lines(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.close_checklist(date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.close_checklist(date) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.close_checklist(date) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.close_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.close_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.close_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.close_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.context(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.context(text,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.context(text,jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.contractor_report(integer,date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.contractor_report(integer,date) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.contractor_report(integer,date) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.descriptor_key(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.descriptor_key(text) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.descriptor_key(text) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.document_access(text,boolean) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.document_access(text,boolean) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.document_access(text,boolean) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.documents(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.documents(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.documents(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.entry_detail(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.entry_detail(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.entry_detail(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.history_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.history_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.history_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.history_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.history_preview(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.history_preview(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.history_preview(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.import_compare(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.import_compare(uuid,uuid,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.import_compare(uuid,uuid,jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.imports(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.imports(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.imports(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.ledger(uuid,date,date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.ledger(uuid,date,date) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.ledger(uuid,date,date) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.ledger_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.ledger_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.match_review() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.match_review() TO "postgres";

REVOKE ALL ON FUNCTION accounting.operate(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.operate(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.operate(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.payroll(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.payroll(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.payroll(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.payroll_plan(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.payroll_plan(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.prior_summary(text,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.prior_summary(text,uuid,integer) TO "postgres";

REVOKE ALL ON FUNCTION accounting.prior_treatment(text,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.prior_treatment(text,uuid,integer) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.prior_treatment(text,uuid,integer) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.record_audit() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.record_audit() TO "postgres";

REVOKE ALL ON FUNCTION accounting.register_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.register_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.register_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.register_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.register_plan(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.register_plan(uuid,jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.registers(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.registers(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.registers(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.report(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.report(text,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.report(text,jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.report_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.report_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.report_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.report_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.report_lines(text,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.report_lines(text,jsonb,uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.report_lines(text,jsonb,uuid) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.report_validate(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.report_validate(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.require_open(date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.require_open(date) TO "postgres";

REVOKE ALL ON FUNCTION accounting.require_owner() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.require_owner() TO "postgres";

REVOKE ALL ON FUNCTION accounting.rule_candidate(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.rule_candidate(uuid,uuid) TO "postgres";

REVOKE ALL ON FUNCTION accounting.rules_preview(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.rules_preview(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.rules_preview(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.snapshot_read(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.snapshot_read(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.snapshot_read(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.support_report(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.support_report(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.support_report(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.sync_server(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.sync_server(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.sync_server(jsonb) TO "service_role";

REVOKE ALL ON FUNCTION accounting.tax_command(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.tax_command(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION accounting.tax_guard() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.tax_guard() TO "postgres";

REVOKE ALL ON FUNCTION accounting.tax_lines(integer,date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.tax_lines(integer,date) TO "postgres";

REVOKE ALL ON FUNCTION accounting.tax_link(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.tax_link(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.tax_link(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.tax_refresh_server(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.tax_refresh_server(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.tax_refresh_server(jsonb) TO "service_role";

REVOKE ALL ON FUNCTION accounting.tax_source(integer,date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.tax_source(integer,date) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.tax_source(integer,date) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.transactions(jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.transactions(jsonb,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.transactions(jsonb,jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.workspace(date,date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.workspace(date,date) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.workspace(date,date) TO "authenticated";

REVOKE ALL ON FUNCTION accounting.write_lock() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.write_lock() TO "postgres";

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.accounts FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.accounts FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.accounts FOR EACH STATEMENT EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON accounting.audit_log FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.bank_accounts FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_accounts FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_accounts FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.bank_connections FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_connections FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_connections FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.bank_matches FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_matches FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER match_review AFTER INSERT OR DELETE ON accounting.bank_matches FOR EACH ROW EXECUTE FUNCTION accounting.match_review();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_matches FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.bank_transactions FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_transactions FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.bank_transactions FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER business_profile_guard BEFORE INSERT OR DELETE OR UPDATE ON public.business_profile FOR EACH ROW EXECUTE FUNCTION business_profile_guard();

CREATE TRIGGER business_profile_lock BEFORE INSERT OR DELETE OR UPDATE ON public.business_profile FOR EACH STATEMENT EXECUTE FUNCTION business_profile_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.command_receipts FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON accounting.command_receipts FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.document_links FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.document_links FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.document_links FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.documents FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.documents FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.documents FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.history_checks FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.history_checks FOR EACH ROW EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.history_checks FOR EACH STATEMENT EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.import_batches FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.import_batches FOR EACH ROW EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.import_batches FOR EACH STATEMENT EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.import_rows FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.import_rows FOR EACH ROW EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.import_rows FOR EACH STATEMENT EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER bank_entry_date_guard BEFORE INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE CONSTRAINT TRIGGER entry_balance AFTER INSERT OR UPDATE ON accounting.journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.balance_guard();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER history_invalidate AFTER INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.history_guard();

CREATE TRIGGER payroll_reversal_guard BEFORE INSERT ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.register_guard();

CREATE TRIGGER reconciliation_reopen AFTER INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.close_guard();

CREATE TRIGGER register_balance_guard AFTER INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.register_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.journal_entries FOR EACH STATEMENT EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER bank_line_match_guard BEFORE DELETE OR UPDATE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE CONSTRAINT TRIGGER line_balance AFTER INSERT OR DELETE OR UPDATE ON accounting.journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.balance_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.journal_lines FOR EACH STATEMENT EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.parties FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.parties FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.parties FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.payee_aliases FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.payee_aliases FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.payee_aliases FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.payroll_runs FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.payroll_runs FOR EACH ROW EXECUTE FUNCTION accounting.register_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.payroll_runs FOR EACH STATEMENT EXECUTE FUNCTION accounting.register_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.periods FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.periods FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.periods FOR EACH STATEMENT EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.reconciliation_items FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.reconciliation_items FOR EACH ROW EXECUTE FUNCTION accounting.close_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.reconciliation_items FOR EACH STATEMENT EXECUTE FUNCTION accounting.close_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.reconciliations FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.reconciliations FOR EACH ROW EXECUTE FUNCTION accounting.close_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.reconciliations FOR EACH STATEMENT EXECUTE FUNCTION accounting.close_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.registers FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.registers FOR EACH ROW EXECUTE FUNCTION accounting.register_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.registers FOR EACH STATEMENT EXECUTE FUNCTION accounting.register_guard();

CREATE TRIGGER audit AFTER INSERT ON accounting.report_snapshots FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE DELETE OR UPDATE ON accounting.report_snapshots FOR EACH ROW EXECUTE FUNCTION accounting.report_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.rules FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.rules FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.rules FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.settings FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.settings FOR EACH ROW EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER write_lock BEFORE INSERT OR DELETE OR UPDATE ON accounting.settings FOR EACH STATEMENT EXECUTE FUNCTION accounting.guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.tax_adjustments FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.tax_adjustments FOR EACH ROW EXECUTE FUNCTION accounting.tax_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.tax_links FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.tax_links FOR EACH ROW EXECUTE FUNCTION accounting.tax_guard();

CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON accounting.tax_mappings FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();

CREATE TRIGGER guard BEFORE INSERT OR DELETE OR UPDATE ON accounting.tax_mappings FOR EACH ROW EXECUTE FUNCTION accounting.tax_guard();

CREATE POLICY "business_profile_delete" ON public.business_profile AS PERMISSIVE FOR DELETE TO "authenticated" USING (true);

CREATE POLICY "business_profile_insert" ON public.business_profile AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "business_profile_read" ON public.business_profile AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "business_profile_update" ON public.business_profile AS PERMISSIVE FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);

CREATE POLICY "accounting_private_read" ON storage.objects AS PERMISSIVE FOR SELECT TO "authenticated" USING (((bucket_id = 'accounting-private'::text) AND accounting.document_access(name)));

CREATE POLICY "accounting_private_upload" ON storage.objects AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((bucket_id = 'accounting-private'::text) AND accounting.document_access(name, true)));

INSERT INTO public.business_profile(legal_name,entity_type,tax_classification) VALUES ('Valiance Media LLC','llc','s_corp');

INSERT INTO accounting.accounts(name,type,subtype,system_purpose) VALUES
 ('Business checking','asset','bank',NULL),
 ('Business credit card','liability','card',NULL),
 ('Cash on hand','asset','cash',NULL),
 ('Due to shareholder','liability','loan','due_to_shareholder'),
 ('Employer payroll taxes','expense','payroll_expense','employer_payroll_taxes'),
 ('Merchant fees','expense','operating_expense','merchant_fees'),
 ('Office expenses','expense','operating_expense',NULL),
 ('Officer wages','expense','payroll_expense','officer_wages'),
 ('Opening retained earnings','equity','retained_earnings','opening_retained_earnings'),
 ('Owner contributions','equity','owner_equity','contributions'),
 ('Owner distributions','equity','owner_equity','distributions'),
 ('Service revenue','income','revenue',NULL),
 ('Software','expense','operating_expense',NULL),
 ('Transfers in transit','asset','transit','transfers_in_transit'),
 ('Uncategorized expense','expense','uncategorized','uncategorized_expense'),
 ('Uncategorized income','income','uncategorized','uncategorized_income'),
 ('Undeposited funds','asset','undeposited','undeposited_funds');

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES ('accounting-private','accounting-private','f','26214400','{application/pdf,image/png,image/jpeg,image/webp,text/csv,application/zip}');

SET check_function_bodies = true;

-- ACCOUNTING CATALOG END
