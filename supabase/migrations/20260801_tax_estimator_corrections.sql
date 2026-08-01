-- ============================================================================
-- Tax estimator: uniqueness fix + inputs required for correct federal figures
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tax_year uniqueness ignored soft deletes
-- ----------------------------------------------------------------------------
-- The column carried a plain UNIQUE constraint while every read path filters on
-- `deleted_at IS NULL`. Soft-deleting a year therefore left the row in place and
-- permanently blocked re-creating that year: the insert failed on the unique
-- violation, and because supabase-js resolves with { error } rather than
-- throwing, the UI reported success and the user could never recover the year.
--
-- Replace it with a partial unique index so only live rows compete, matching the
-- pattern already used by income_line_items and email_accounts.

ALTER TABLE tax_estimates
  DROP CONSTRAINT IF EXISTS tax_estimates_tax_year_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_estimates_year_unique_active
  ON tax_estimates (tax_year)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2. Qualified business income (IRC 199A) limitation inputs
-- ----------------------------------------------------------------------------
-- Above the threshold amount, a specified service trade or business loses the
-- deduction entirely, but any other business is instead capped by the greater of
-- 50% of its W-2 wages or 25% of wages plus 2.5% of unadjusted property basis.
-- Without these three inputs the engine had to assume every business was an
-- SSTB, zeroing deductions that were actually allowable.

ALTER TABLE tax_estimates
  ADD COLUMN IF NOT EXISTS is_sstb BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS business_w2_wages NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS business_property_basis NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN tax_estimates.is_sstb IS
  'Specified service trade or business per IRC 199A(d)(2): health, law, accounting, consulting, athletics, financial services, etc. Loses the QBI deduction entirely above the threshold.';
COMMENT ON COLUMN tax_estimates.business_w2_wages IS
  'W-2 wages paid by the business, for the IRC 199A(b)(2)(B) wage limitation.';
COMMENT ON COLUMN tax_estimates.business_property_basis IS
  'Unadjusted basis immediately after acquisition (UBIA) of qualified property, for the 2.5% component of the QBI limitation.';

-- ----------------------------------------------------------------------------
-- 3. Additional standard deduction for the aged and the blind (IRC 63(f))
-- ----------------------------------------------------------------------------
-- 2025: $1,600 per condition, $2,000 if unmarried and not a surviving spouse.
-- Each taxpayer can qualify twice (65 or older AND blind).

ALTER TABLE tax_estimates
  ADD COLUMN IF NOT EXISTS taxpayer_age_65 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS taxpayer_blind BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS spouse_age_65 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS spouse_blind BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tax_estimates.taxpayer_age_65 IS
  'Taxpayer is 65 or older at year end; grants an additional standard deduction under IRC 63(f).';
COMMENT ON COLUMN tax_estimates.spouse_age_65 IS
  'Spouse is 65 or older at year end. Only meaningful for joint returns.';

-- Note: per-spouse attribution and material participation live inside the
-- existing income_sources JSONB (taxpayer, materially_participates) and need no
-- schema change.
