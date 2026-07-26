-- ============================================================================
-- Invoice -> income sync
-- ----------------------------------------------------------------------------
-- Links income line items back to the source CRM invoice so the webhook
-- receiver can reconcile idempotently: one row per (invoice, line-item type),
-- revived/updated/soft-deleted to always mirror the invoice's current state.
-- Manual ledger entries leave all external_* columns NULL and are untouched.
-- ============================================================================

ALTER TABLE income_line_items
  ADD COLUMN IF NOT EXISTS external_source TEXT,
  ADD COLUMN IF NOT EXISTS external_ref TEXT,
  ADD COLUMN IF NOT EXISTS external_type TEXT;

COMMENT ON COLUMN income_line_items.external_source IS 'Origin system for synced rows (e.g. vm_app_invoice); NULL for manual entries';
COMMENT ON COLUMN income_line_items.external_ref IS 'Source record id (e.g. CRM invoice id) this row mirrors';
COMMENT ON COLUMN income_line_items.external_type IS 'Sub-key within the source record (e.g. invoice line-item type)';

-- One active row per (source, ref, type). NULL external_ref (manual rows) never
-- collide, so manual ledger entries are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_income_line_items_external
  ON income_line_items (external_source, external_ref, external_type)
  WHERE deleted_at IS NULL AND external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_income_line_items_external_ref
  ON income_line_items (external_source, external_ref)
  WHERE external_ref IS NOT NULL;

-- Per-source-record cursor. Enforces idempotency and drops out-of-order events:
-- the receiver skips any event whose sequence <= last_sequence for that record.
CREATE TABLE IF NOT EXISTS webhook_receipts (
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

COMMENT ON TABLE webhook_receipts IS 'Generic inbound-webhook cursor: last event applied per (source, external_ref), for idempotency + out-of-order guarding. Reusable across webhook types.';

CREATE TRIGGER webhook_receipts_updated_at
  BEFORE UPDATE ON webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE webhook_receipts ENABLE ROW LEVEL SECURITY;

-- The receiver writes with the service role (bypasses RLS). Authenticated users
-- may read the cursor for visibility.
CREATE POLICY "Authenticated users can view webhook_receipts"
  ON webhook_receipts FOR SELECT TO authenticated USING (true);
