-- Itemized income ledger.
-- Existing monthly/source totals are preserved in income_amounts and backfilled
-- into one legacy line item per source per month.

CREATE TABLE income_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES income_entries(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES income_sources(id) ON DELETE RESTRICT,
  received_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
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

CREATE TRIGGER income_line_items_updated_at
  BEFORE UPDATE ON income_line_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE income_line_items IS 'Individual income items that roll up into monthly source totals';
COMMENT ON COLUMN income_line_items.received_date IS 'Date the income was received';
COMMENT ON COLUMN income_line_items.amount IS 'Income item amount (can be negative for refunds or losses)';

ALTER TABLE income_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view income_line_items"
  ON income_line_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert income_line_items"
  ON income_line_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update income_line_items"
  ON income_line_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete income_line_items"
  ON income_line_items FOR DELETE TO authenticated USING (true);

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
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.entry_id IS DISTINCT FROM NEW.entry_id
       OR OLD.source_id IS DISTINCT FROM NEW.source_id THEN
      PERFORM recompute_income_amount(OLD.entry_id, OLD.source_id);
      PERFORM soft_delete_empty_income_entry(OLD.entry_id);
    END IF;

    PERFORM recompute_income_amount(NEW.entry_id, NEW.source_id);

    IF NEW.deleted_at IS NOT NULL THEN
      PERFORM soft_delete_empty_income_entry(NEW.entry_id);
    END IF;

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

INSERT INTO income_line_items (
  entry_id,
  source_id,
  received_date,
  amount,
  notes,
  created_at,
  updated_at
)
SELECT
  ia.entry_id,
  ia.source_id,
  e.month,
  ia.amount,
  'Legacy monthly total',
  ia.created_at,
  ia.updated_at
FROM income_amounts ia
JOIN income_entries e ON e.id = ia.entry_id
WHERE ia.amount <> 0
  AND NOT EXISTS (
    SELECT 1
    FROM income_line_items ili
    WHERE ili.entry_id = ia.entry_id
      AND ili.source_id = ia.source_id
      AND ili.received_date = e.month
      AND ili.notes = 'Legacy monthly total'
  );
