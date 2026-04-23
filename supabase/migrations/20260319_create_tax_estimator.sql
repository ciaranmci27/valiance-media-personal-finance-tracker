-- Migration: Create tax_estimates table
-- Tax Estimator Worksheet - one row per tax year, line items as JSONB arrays

CREATE TABLE IF NOT EXISTS tax_estimates (
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

CREATE INDEX IF NOT EXISTS idx_tax_estimates_year ON tax_estimates(tax_year DESC)
  WHERE deleted_at IS NULL;

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

ALTER TABLE tax_estimates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view tax_estimates"
  ON tax_estimates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert tax_estimates"
  ON tax_estimates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update tax_estimates"
  ON tax_estimates FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete tax_estimates"
  ON tax_estimates FOR DELETE TO authenticated USING (true);
