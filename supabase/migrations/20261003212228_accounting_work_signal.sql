-- A cheap "new work" signal on the books revision read, so the agents host
-- can tell new work from a sync that changed nothing an agent acts on.
--
-- The revision counter moves on every feed sync and every write, new work or
-- not. To decide whether to wake the finance agent, the dispatcher therefore
-- also listed up to 100 review drafts in full (every line, every name) and
-- picked out the ones the agent can act on, a read that grows with the queue.
-- This migration answers that question in SQL, in the same read as the
-- revision. No table changes.
--
-- 1. accounting.work_signal() (reader check, postgres only, reached through
--    the API): two small objects.
--    - actionable_drafts: the drafts the agent can act on, by exactly the
--      rules the API's transactions use (presentTransaction): a draft, not
--      part of a reversed pair, not a transfer (no transfer group, no proposed
--      pair, not every line on two or more money accounts) and not
--      categorized (fewer than two lines, a zero line, lines that do not add
--      up to zero, or a line on Uncategorized income, Uncategorized expense or
--      opening balance equity). count; fingerprint, the first 16 hex
--      characters of md5 over the sorted ids, so it moves exactly when the set
--      moves and not when a draft in it is edited (a contact or memo written
--      to a waiting draft is not new work); and newest_at, when the newest of
--      them reached the books (UTC, fixed width), so a draft that arrives as
--      another leaves still reads as new.
--    - contacts_needed: transactions dated in the last 30 days (books time
--      zone) with no contact, not discarded, not part of a reversed pair and
--      not a transfer: the rows a transactions search with contact=none,
--      transfers=exclude and from=since lists. count and since.
-- 2. entries_reverses: a partial index on journal_entries.reverses_entry_id.
--    Every register read leaves out reversed pairs with NOT EXISTS on that
--    column, which had no index, so each check read the whole table. The index
--    holds only reversals, so it stays tiny.
-- 3. public.api_accounting (restated in full): the revision read answers the
--    revision and the work signal together, from one snapshot.

BEGIN;

-- 1. The work signal.
CREATE OR REPLACE FUNCTION accounting.work_signal()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE since date; result jsonb;
BEGIN
 PERFORM accounting.require_reader();
 since:=(now() AT TIME ZONE coalesce((SELECT books_timezone FROM public.business_profile WHERE id=1),'America/Phoenix'))::date-30;
 WITH queue AS (
  -- Drafts the agent can act on, by the rules of the API's transactions (presentTransaction); a money line is a bank, cash or card account.
  SELECT e.id,e.created_at FROM accounting.journal_entries e CROSS JOIN LATERAL (
   SELECT count(*) AS line_count,count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) AS bank_count,
    count(DISTINCT l.account_id) FILTER(WHERE a.subtype IN ('bank','cash','card')) AS bank_accounts,
    coalesce(sum(l.amount_cents),0) AS total,coalesce(bool_or(l.amount_cents=0),false) AS zero_line,
    coalesce(bool_or(a.system_purpose IN ('uncategorized_income','uncategorized_expense','opening_balance_equity')),false) AS suspense
   FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
  WHERE e.status='draft' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)
   AND e.transfer_group_id IS NULL AND e.pair_entry_id IS NULL AND NOT (m.bank_accounts>1 AND m.bank_count=m.line_count)
   AND (m.line_count<2 OR m.zero_line OR m.total<>0 OR m.suspense)
 ), blank AS (
  -- Recent transactions without a contact: a register search with contact=none, transfers=exclude and from=since.
  SELECT e.id FROM accounting.journal_entries e CROSS JOIN LATERAL (
   SELECT count(*) AS line_count,count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) AS bank_count,
    count(DISTINCT l.account_id) FILTER(WHERE a.subtype IN ('bank','cash','card')) AS bank_accounts
   FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
  WHERE e.entry_date>=since AND e.payee_id IS NULL AND e.status<>'discarded' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)
   AND e.transfer_group_id IS NULL AND e.pair_entry_id IS NULL AND NOT (m.bank_accounts>1 AND m.bank_count=m.line_count)
 )
 SELECT jsonb_build_object(
  'actionable_drafts',(SELECT jsonb_build_object('count',count(*),'fingerprint',left(md5(coalesce(string_agg(q.id::text,',' ORDER BY q.id),'')),16),
   'newest_at',to_char(max(q.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM queue q),
  'contacts_needed',jsonb_build_object('count',(SELECT count(*) FROM blank),'since',since)) INTO result;
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION accounting.work_signal() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.work_signal() TO "postgres";

-- 2. Reversed pairs are found by reverses_entry_id.
CREATE INDEX IF NOT EXISTS entries_reverses ON accounting.journal_entries USING btree (reverses_entry_id) WHERE (reverses_entry_id IS NOT NULL);

-- 3. The revision read carries the work signal (restated in full).
CREATE OR REPLACE FUNCTION public.api_accounting(p_key_hash text, p_name text, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE a jsonb := coalesce(p_args, '{}'::jsonb); result jsonb;
BEGIN
 IF p_name IS NULL OR p_name NOT IN ('workspace', 'transactions', 'entry_detail', 'report', 'report_lines', 'ledger', 'revision', 'payees', 'rules', 'reconciliation', 'attention', 'breakdown', 'recurring', 'support_report') THEN
  RAISE EXCEPTION 'API_OPERATION_NOT_ALLOWED';
 END IF;
 IF p_name = 'support_report' THEN
  -- Payroll register, contractor worksheet and tax workpapers are owner-only reads. A key with accounting.payroll
  -- reaches them here only: the transaction turns read only first, so nothing after this can write, and
  -- require_owner and require_reader accept the key only while it is read only and the flag is set.
  PERFORM public.api_act(p_key_hash, 'accounting.payroll');
  PERFORM set_config('transaction_read_only', 'on', true);
  PERFORM set_config('api.command', 'payroll_read', true);
  result := accounting.support_report(coalesce(a->'params', '{}'::jsonb));
  IF result->>'report_id' = 'contractor-worksheet' THEN
   result := result || jsonb_build_object('threshold_cents', accounting.contractor_report(extract(year FROM (a->'params'->>'to')::date)::integer, (a->'params'->>'to')::date)->'threshold_cents');
  END IF;
  PERFORM set_config('api.command', '', true);
  RETURN result;
 END IF;
 PERFORM public.api_act(p_key_hash, 'accounting.read');
 RETURN CASE p_name
  WHEN 'workspace' THEN accounting.workspace((a->>'from_date')::date, (a->>'to_date')::date, coalesce(a->>'mode', 'posted'))
  WHEN 'transactions' THEN accounting.transactions(coalesce(a->'filter', '{}'::jsonb), coalesce(a->'page', '{}'::jsonb))
  WHEN 'entry_detail' THEN accounting.entry_detail((a->>'entry')::uuid)
  WHEN 'report' THEN accounting.report(a->>'kind', coalesce(a->'params', '{}'::jsonb))
  WHEN 'report_lines' THEN accounting.report_lines(a->>'kind', coalesce(a->'params', '{}'::jsonb), (a->>'account')::uuid)
  WHEN 'ledger' THEN accounting.ledger((a->>'account')::uuid, (a->>'from_date')::date, (a->>'to_date')::date)
  -- The counter, plus what the agent can act on (accounting.work_signal), so a poll can tell new work from a sync.
  WHEN 'revision' THEN jsonb_build_object('revision', accounting.revision()) || accounting.work_signal()
  WHEN 'payees' THEN jsonb_build_object('payees', accounting.payees_list())
  WHEN 'rules' THEN jsonb_build_object('rules', accounting.rules_list())
  WHEN 'reconciliation' THEN accounting.reconciliation_status(coalesce(a->'params', '{}'::jsonb))
  WHEN 'attention' THEN accounting.attention(coalesce(a->'params', '{}'::jsonb))
  WHEN 'breakdown' THEN accounting.breakdown(coalesce(a->'params', '{}'::jsonb))
  WHEN 'recurring' THEN accounting.recurring(coalesce(a->'params', '{}'::jsonb))
 END;
END $fn$;

COMMIT;
