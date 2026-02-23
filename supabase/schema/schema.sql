-- ============================================================================
-- VALIANCE ADMIN - DATABASE SCHEMA
-- ============================================================================
-- Run this file first in Supabase SQL Editor to create all tables
-- ============================================================================

-- ============================================================================
-- CLEANUP (only if you need to reset - comment out for first run)
-- ============================================================================
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
-- TABLE 4: expenses
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