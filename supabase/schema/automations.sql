-- Automations Schema
-- Run this SQL in Supabase SQL Editor after the main schema.sql

-- ============================================
-- AUTOMATIONS TABLE
-- Core automation definitions
-- ============================================
CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  trigger_type VARCHAR(20) NOT NULL DEFAULT 'schedule',
  trigger_config JSONB NOT NULL DEFAULT '{}',
  -- trigger_config structure:
  -- {
  --   "frequency": "daily" | "weekly" | "monthly" | "quarterly" | "yearly",
  --   "time": "09:00",
  --   "timezone": "America/New_York",
  --   "day_of_week": 1,        -- 0-6 (Sun-Sat), for weekly
  --   "day_of_month": 1,       -- 1-28, for monthly/quarterly/yearly
  --   "month": 1,              -- 1-12, for yearly
  --   "months": [1,4,7,10],    -- for quarterly
  --   "duration_type": "forever" | "count" | "until",
  --   "run_count": 10,         -- for "count" duration
  --   "run_until": "2025-12-31", -- for "until" duration
  --   "runs_completed": 0      -- tracks completed runs
  -- }
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for finding due automations
CREATE INDEX IF NOT EXISTS idx_automations_next_run ON automations(next_run_at) WHERE is_active = true AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_automations_user_id ON automations(user_id);

-- ============================================
-- AUTOMATION_ACTIONS TABLE
-- Actions to execute per automation
-- ============================================
CREATE TABLE IF NOT EXISTS automation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  action_type VARCHAR(20) NOT NULL CHECK (action_type IN ('email', 'notification')),
  action_config JSONB NOT NULL DEFAULT '{}',
  -- email config: {"to": "email@example.com", "subject": "...", "body": "..."}
  -- notification config: {"title": "...", "message": "...", "link": "/dashboard"}
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_actions_automation_id ON automation_actions(automation_id);

-- ============================================
-- AUTOMATION_RUNS TABLE
-- Execution history
-- ============================================
CREATE TABLE IF NOT EXISTS automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_id ON automation_runs(automation_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status) WHERE status = 'running';

-- ============================================
-- NOTIFICATIONS TABLE
-- In-app notifications
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  message TEXT,
  link VARCHAR(500),
  is_read BOOLEAN NOT NULL DEFAULT false,
  automation_run_id UUID REFERENCES automation_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = false;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

-- Enable RLS on all tables
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Automations policies
CREATE POLICY "Users can view their own automations"
  ON automations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own automations"
  ON automations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own automations"
  ON automations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own automations"
  ON automations FOR DELETE
  USING (auth.uid() = user_id);

-- Automation actions policies (access through automation ownership)
CREATE POLICY "Users can view actions of their automations"
  ON automation_actions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM automations WHERE automations.id = automation_actions.automation_id AND automations.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert actions for their automations"
  ON automation_actions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM automations WHERE automations.id = automation_actions.automation_id AND automations.user_id = auth.uid()
  ));

CREATE POLICY "Users can update actions of their automations"
  ON automation_actions FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM automations WHERE automations.id = automation_actions.automation_id AND automations.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete actions of their automations"
  ON automation_actions FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM automations WHERE automations.id = automation_actions.automation_id AND automations.user_id = auth.uid()
  ));

-- Automation runs policies (access through automation ownership)
CREATE POLICY "Users can view runs of their automations"
  ON automation_runs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM automations WHERE automations.id = automation_runs.automation_id AND automations.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert runs for their automations"
  ON automation_runs FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM automations WHERE automations.id = automation_runs.automation_id AND automations.user_id = auth.uid()
  ));

-- Notifications policies
CREATE POLICY "Users can view their own notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own notifications"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own notifications"
  ON notifications FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- SERVICE ROLE POLICIES
-- Allow service role to process automations
-- ============================================

-- Service role bypass for automation processing
CREATE POLICY "Service role can select all automations"
  ON automations FOR SELECT
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role can update all automations"
  ON automations FOR UPDATE
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role can select all automation actions"
  ON automation_actions FOR SELECT
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role can insert automation runs"
  ON automation_runs FOR INSERT
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role can update automation runs"
  ON automation_runs FOR UPDATE
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role can insert notifications"
  ON notifications FOR INSERT
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_automations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS automations_updated_at ON automations;
CREATE TRIGGER automations_updated_at
  BEFORE UPDATE ON automations
  FOR EACH ROW
  EXECUTE FUNCTION update_automations_updated_at();

-- ============================================
-- PG_CRON SETUP
-- Run in SQL Editor after enabling pg_net extension
-- Replace <SUPABASE_URL> and <SERVICE_ROLE_KEY> with actual values
-- ============================================

-- Enable pg_net extension for HTTP requests (if not already enabled)
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule job to run every 15 minutes
-- Run this command after replacing the placeholders:
--
-- SELECT cron.schedule(
--   'process-automations',
--   '*/15 * * * *',
--   $$
--   SELECT net.http_post(
--     url := '<SUPABASE_URL>/functions/v1/process-automations',
--     headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
--     body := '{}'::jsonb
--   );
--   $$
-- );

-- To view scheduled jobs:
-- SELECT * FROM cron.job;

-- To unschedule:
-- SELECT cron.unschedule('process-automations');
