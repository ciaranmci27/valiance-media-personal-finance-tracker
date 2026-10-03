-- Finance tools for agents, slice 3: totals by any dimension, recurring
-- charges found in the books, and the owner-only support reports through a
-- new read-only API scope.
--
-- The finance agent still paged through transactions for "month by month",
-- "by category", "by contact", "how has cash moved", "which charges repeat"
-- and "did a price go up", and could not read the payroll register, the 1099
-- worksheet or the tax workpapers at all. This migration adds what those
-- answers need. No table changes.
--
-- New reader functions (accounting.read is enough):
-- - breakdown(params): totals grouped by month, quarter, category, contact,
--   bank_account or role, aggregated in SQL. measure 'activity' (default) is
--   the profit and loss: income, expense and net per group, from income and
--   expense lines only, with the live-entry rule the reports use (posted, or
--   balanced drafts in working mode; posted is the SQL default). measure
--   'balance' is the ending balance per period end or per account, on each
--   account's normal side (cash held and card debt owed positive), for the
--   given accounts or, by default, every bank and cash account. Filters:
--   account_ids, account_types, payee (or 'unassigned'), role, kind and
--   bank_account (entries with a line on that money account). compare
--   'previous_period' (whole months shift by whole months) or
--   'previous_year', or explicit compare_from and compare_to, adds compare
--   and change to every row. Contact, category, bank account and role groups
--   are sorted biggest first and cut at top (default 20, at most 100), the
--   rest rolled into one Other row, so rows plus Other equal the total.
--   A contact with several roles counts once, under the first of owner,
--   employee, contractor, government, financial, client, vendor.
-- - recurring(params): series of money-out charges (one bank, card or cash
--   line, an expense line, never a transfer or a reversed pair), keyed by the
--   contact or, without one, the bank description (descriptor_key). Same-day
--   charges are one occurrence. The cadence comes from the median gap between
--   occurrences (weekly 5 to 9 days, monthly 25 to 35, quarterly 80 to 100,
--   annual 330 to 400) and at least 60% of the gaps must fit it; anything
--   else is not listed. Each series has its last, previous and average
--   amount, the latest price change, the next expected date, active or
--   stopped (stopped once no charge has come for 1.5 cadences) and the
--   annual cost at the last amount.
-- - breakdown_amounts(...) is a private helper for breakdown's rows.
--
-- Payroll and 1099 reports through the API: a new permission and API scope,
-- accounting.payroll. Agents hold it by default (role_permissions), but no
-- key carries it until the owner creates a key that includes it; existing
-- keys are not changed. public.api_accounting (restated) gains breakdown,
-- recurring and support_report. support_report is checked against
-- accounting.payroll instead of accounting.read, and before it runs the
-- transaction is set read only and api.command is set to 'payroll_read'.
-- require_owner and require_reader (restated) accept such a key only while
-- both hold, so support_report, contractor_report and tax_source can read for
-- it, and no write can happen in that transaction whatever is called. Every
-- other owner check is unchanged.

BEGIN;

-- 1. The new permission for agents (keys still need the scope, granted per key by the owner).
INSERT INTO public.role_permissions(role, permission_key) VALUES ('agent', 'accounting.payroll')
ON CONFLICT DO NOTHING;

-- 2. Owner and reader checks: a payroll-scoped key, inside a read-only API call only (restated in full).
CREATE OR REPLACE FUNCTION accounting.require_owner()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 -- A payroll-scoped key passes only inside public.api_accounting's support_report call, which makes the
 -- transaction read only before setting the flag, so this can never let the key write.
 IF NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=actor OR public.has_permission('accounting.manage') OR (current_setting('api.command',true)='drafts' AND accounting.api_key_allows(actor,'accounting.draft'))
  OR (current_setting('api.command',true)='payroll_read' AND current_setting('transaction_read_only')='on' AND accounting.api_key_allows(actor,'accounting.payroll')))) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.require_reader()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=actor OR public.has_permission('accounting.manage') OR accounting.api_key_allows(actor,'accounting.read') OR accounting.api_key_allows(actor,'accounting.draft')
  OR (current_setting('api.command',true)='payroll_read' AND current_setting('transaction_read_only')='on' AND accounting.api_key_allows(actor,'accounting.payroll')))) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $function$
;

-- 3. Totals by any dimension.
CREATE OR REPLACE FUNCTION accounting.breakdown_amounts(income numeric, expense numeric, entries bigint, compare_income numeric, compare_expense numeric, compared boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- One breakdown row's money: income and expense as the profit and loss shows them (both positive), their net,
 -- the entries counted, and with a comparison the compared figures and the change (this period less that one).
 SELECT jsonb_build_object('income_cents',income::text,'expense_cents',expense::text,'net_cents',(income-expense)::text,'count',entries)
  ||CASE WHEN compared THEN jsonb_build_object(
   'compare',jsonb_build_object('income_cents',compare_income::text,'expense_cents',compare_expense::text,'net_cents',(compare_income-compare_expense)::text),
   'change',jsonb_build_object('income_cents',(income-compare_income)::text,'expense_cents',(expense-compare_expense)::text,'net_cents',((income-expense)-(compare_income-compare_expense))::text))
  ELSE '{}'::jsonb END;
$function$
;

REVOKE ALL ON FUNCTION accounting.breakdown_amounts(numeric,numeric,bigint,numeric,numeric,boolean) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.breakdown_amounts(numeric,numeric,bigint,numeric,numeric,boolean) TO "postgres";

CREATE OR REPLACE FUNCTION accounting.breakdown(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date; end_date date; compare_start date; compare_end date; shift interval; unit text; step interval; top_n integer; timed boolean; result jsonb;
 measure text:=coalesce(params->>'measure','activity'); dimension text:=params->>'group_by'; working boolean:=coalesce(params->>'mode','posted')='working';
BEGIN
 PERFORM accounting.require_reader();
 PERFORM accounting.report_validate(params);
 start_date:=(params->>'from')::date; end_date:=(params->>'to')::date; top_n:=coalesce((params->>'top')::integer,20);
 compare_start:=(params->>'compare_from')::date; compare_end:=(params->>'compare_to')::date;
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR (compare_start IS NULL)<>(compare_end IS NULL) OR compare_start>compare_end THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE'; END IF;
 IF measure NOT IN ('activity','balance') OR coalesce(dimension,'') NOT IN ('month','quarter','category','contact','bank_account','role') OR top_n NOT BETWEEN 1 AND 100
  OR coalesce(params->>'role','client') NOT IN ('client','vendor','contractor','employee','government','financial','owner')
  OR coalesce(params->>'kind','manual') NOT IN ('manual','income','expense','transfer','payroll','opening','owner','asset','loan','refund','correction')
  OR coalesce(params->>'compare','previous_period') NOT IN ('previous_period','previous_year') OR (params ? 'compare' AND compare_start IS NOT NULL)
  OR (params->>'bank_account' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.id::text=params->>'bank_account' AND a.subtype IN ('bank','card','cash')))
  -- Activity is the profit and loss, so only income and expense accounts; a balance has no contact, role or kind.
  OR (measure='activity' AND EXISTS(SELECT 1 FROM accounting.accounts a WHERE a.id::text IN (SELECT jsonb_array_elements_text(coalesce(params->'account_ids','[]'::jsonb))) AND a.type NOT IN ('income','expense')))
  OR (measure='activity' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(params->'account_types','[]'::jsonb)) t WHERE t.value NOT IN ('income','expense')))
  OR (measure='balance' AND (dimension IN ('contact','role') OR params ?| ARRAY['payee','role','kind','bank_account'])) THEN
  RAISE EXCEPTION 'ACCT_INVALID_FILTER';
 END IF;
 timed:=dimension IN ('month','quarter');
 unit:=CASE WHEN dimension='quarter' THEN 'quarter' ELSE 'month' END;
 step:=CASE WHEN dimension='quarter' THEN interval '3 months' ELSE interval '1 month' END;
 IF timed AND (SELECT count(*) FROM generate_series(date_trunc(unit,start_date),date_trunc(unit,end_date),step))>120 THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE'; END IF;
 -- The comparison: the period just before (whole months shift by whole months, so September compares with August,
 -- not the 30 days before it) or the same dates a year earlier. A month bucket meets the bucket the shift maps to it.
 IF params->>'compare'='previous_year' THEN
  shift:=interval '1 year';
 ELSIF params->>'compare'='previous_period' THEN
  shift:=CASE WHEN start_date=date_trunc('month',start_date)::date AND end_date=(date_trunc('month',end_date)+interval '1 month -1 day')::date
   THEN make_interval(months=>((extract(year FROM end_date)-extract(year FROM start_date))*12+extract(month FROM end_date)-extract(month FROM start_date)+1)::integer)
   ELSE make_interval(days=>end_date-start_date+1) END;
 ELSIF compare_start IS NOT NULL THEN
  shift:=CASE WHEN start_date=date_trunc('month',start_date)::date AND compare_start=date_trunc('month',compare_start)::date
   THEN make_interval(months=>((extract(year FROM start_date)-extract(year FROM compare_start))*12+extract(month FROM start_date)-extract(month FROM compare_start))::integer)
   ELSE make_interval(days=>start_date-compare_start) END;
 END IF;
 IF params ? 'compare' THEN
  compare_start:=(start_date-shift)::date;
  compare_end:=CASE WHEN extract(day FROM shift)=0 AND end_date=(date_trunc('month',end_date)+interval '1 month -1 day')::date
   THEN (date_trunc('month',(end_date-shift)::date)+interval '1 month -1 day')::date ELSE (end_date-shift)::date END;
 END IF;
 IF measure='activity' THEN
  WITH live AS (
   -- The reports' live entries (posted, or balanced drafts in working mode) in either period, after the entry filters.
   SELECT e.id,e.entry_date,e.payee_id,m.money_account
   FROM accounting.journal_entries e CROSS JOIN LATERAL (
    SELECT count(*) AS line_count,coalesce(sum(l.amount_cents),0) AS balance,
     CASE WHEN count(DISTINCT l.account_id) FILTER(WHERE a.subtype IN ('bank','card','cash'))=1 THEN (min(l.account_id::text) FILTER(WHERE a.subtype IN ('bank','card','cash')))::uuid END AS money_account
    FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
   WHERE (e.entry_date BETWEEN start_date AND end_date OR e.entry_date BETWEEN compare_start AND compare_end)
    AND (e.status='posted' OR (working AND e.status='draft' AND m.line_count>=2 AND m.balance=0))
    AND (params->>'payee' IS NULL OR (params->>'payee'='unassigned' AND e.payee_id IS NULL) OR e.payee_id::text=params->>'payee')
    AND (params->>'kind' IS NULL OR e.kind=params->>'kind')
    AND (params->>'role' IS NULL OR EXISTS(SELECT 1 FROM accounting.parties p WHERE p.id=e.payee_id AND params->>'role'=ANY(p.roles)))
    AND (params->>'bank_account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id AND bl.account_id::text=params->>'bank_account'))
  ), lines AS (
   -- Income and expense lines, once for the period they fall in and once for the comparison they fall in.
   SELECT w.is_compare,x.id,x.payee_id,x.money_account,l.account_id,
    CASE WHEN a.type='income' THEN -l.amount_cents ELSE 0 END AS income,CASE WHEN a.type='expense' THEN l.amount_cents ELSE 0 END AS expense,
    date_trunc(unit,CASE WHEN w.is_compare THEN (x.entry_date+shift)::date ELSE x.entry_date END)::date AS bucket
   FROM live x CROSS JOIN (VALUES (false),(true)) AS w(is_compare) JOIN accounting.journal_lines l ON l.entry_id=x.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE CASE WHEN w.is_compare THEN x.entry_date BETWEEN compare_start AND compare_end ELSE x.entry_date BETWEEN start_date AND end_date END
    AND a.type IN ('income','expense')
    AND (NOT params?'account_ids' OR a.id::text IN (SELECT jsonb_array_elements_text(params->'account_ids')))
    AND (NOT params?'account_types' OR a.type IN (SELECT jsonb_array_elements_text(params->'account_types')))
  ), keyed AS (
   SELECT l.*,CASE dimension
     WHEN 'category' THEN l.account_id::text
     WHEN 'contact' THEN coalesce(l.payee_id::text,'none')
     WHEN 'bank_account' THEN coalesce(l.money_account::text,'none')
     -- One role per contact, the most specific first, so each line counts once.
     WHEN 'role' THEN coalesce((SELECT r.role FROM accounting.parties p CROSS JOIN LATERAL unnest(ARRAY['owner','employee','contractor','government','financial','client','vendor']) WITH ORDINALITY AS r(role,n)
      WHERE p.id=l.payee_id AND r.role=ANY(p.roles) ORDER BY r.n LIMIT 1),'none')
     ELSE l.bucket::text END AS key
   FROM lines l
  ), grouped AS (
   SELECT k.key,coalesce(sum(k.income) FILTER(WHERE NOT k.is_compare),0) AS income,coalesce(sum(k.expense) FILTER(WHERE NOT k.is_compare),0) AS expense,count(DISTINCT k.id) FILTER(WHERE NOT k.is_compare) AS n,
    coalesce(sum(k.income) FILTER(WHERE k.is_compare),0) AS c_income,coalesce(sum(k.expense) FILTER(WHERE k.is_compare),0) AS c_expense
   FROM keyed k GROUP BY k.key
  ), buckets AS (
   SELECT d::date::text AS key FROM generate_series(date_trunc(unit,start_date),date_trunc(unit,end_date),step) d WHERE timed
  ), grouped_rows AS (
   -- Every period in the range, empty ones included; other dimensions list the groups that have money.
   SELECT b.key,coalesce(g.income,0) AS income,coalesce(g.expense,0) AS expense,coalesce(g.n,0) AS n,coalesce(g.c_income,0) AS c_income,coalesce(g.c_expense,0) AS c_expense FROM buckets b LEFT JOIN grouped g ON g.key=b.key
   UNION ALL SELECT g.key,g.income,g.expense,g.n,g.c_income,g.c_expense FROM grouped g WHERE NOT timed
  ), ranked AS (
   SELECT r.*,CASE dimension
     WHEN 'month' THEN to_char(r.key::date,'Mon YYYY')
     WHEN 'quarter' THEN 'Q'||extract(quarter FROM r.key::date)||' '||extract(year FROM r.key::date)
     WHEN 'category' THEN (SELECT a.name FROM accounting.accounts a WHERE a.id::text=r.key)
     WHEN 'bank_account' THEN coalesce((SELECT a.name FROM accounting.accounts a WHERE a.id::text=r.key),'No single bank account')
     WHEN 'contact' THEN coalesce((SELECT p.name FROM accounting.parties p WHERE p.id::text=r.key),'No contact')
     ELSE CASE WHEN r.key='none' THEN 'No contact' ELSE initcap(r.key) END END AS label,
    CASE WHEN dimension='category' THEN (SELECT a.type FROM accounting.accounts a WHERE a.id::text=r.key) END AS account_type,
    row_number() OVER (ORDER BY CASE WHEN timed THEN r.key END,abs(r.income)+abs(r.expense) DESC,abs(r.c_income)+abs(r.c_expense) DESC,r.key) AS position
   FROM grouped_rows r
  )
  SELECT jsonb_build_object(
   'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.key,'label',r.label)||CASE WHEN r.account_type IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('type',r.account_type) END
    ||accounting.breakdown_amounts(r.income,r.expense,r.n,r.c_income,r.c_expense,compare_start IS NOT NULL) ORDER BY r.position) FROM ranked r WHERE timed OR r.position<=top_n),'[]'::jsonb),
   'other',(SELECT jsonb_build_object('label','Other ('||(SELECT count(*) FROM ranked r WHERE r.position>top_n)||CASE dimension WHEN 'category' THEN ' categories)' WHEN 'contact' THEN ' contacts)' WHEN 'role' THEN ' roles)' ELSE ' accounts)' END,
     'groups',(SELECT count(*) FROM ranked r WHERE r.position>top_n))
    ||accounting.breakdown_amounts(coalesce(sum(k.income) FILTER(WHERE NOT k.is_compare),0),coalesce(sum(k.expense) FILTER(WHERE NOT k.is_compare),0),count(DISTINCT k.id) FILTER(WHERE NOT k.is_compare),
     coalesce(sum(k.income) FILTER(WHERE k.is_compare),0),coalesce(sum(k.expense) FILTER(WHERE k.is_compare),0),compare_start IS NOT NULL)
    FROM keyed k WHERE NOT timed AND k.key IN (SELECT r.key FROM ranked r WHERE r.position>top_n) HAVING count(*)>0),
   'total',(SELECT accounting.breakdown_amounts(coalesce(sum(l.income) FILTER(WHERE NOT l.is_compare),0),coalesce(sum(l.expense) FILTER(WHERE NOT l.is_compare),0),count(DISTINCT l.id) FILTER(WHERE NOT l.is_compare),
     coalesce(sum(l.income) FILTER(WHERE l.is_compare),0),coalesce(sum(l.expense) FILTER(WHERE l.is_compare),0),compare_start IS NOT NULL) FROM lines l)) INTO result;
 ELSE
  WITH chosen AS (
   -- The accounts asked for, or every bank and cash account (the cash position); each on its normal side.
   SELECT a.id,CASE WHEN (a.type IN ('asset','expense'))<>a.is_contra THEN 1 ELSE -1 END AS sign
   FROM accounting.accounts a
   WHERE CASE WHEN params?'account_ids' THEN a.id::text IN (SELECT jsonb_array_elements_text(params->'account_ids'))
    WHEN params?'account_types' THEN a.type IN (SELECT jsonb_array_elements_text(params->'account_types'))
    ELSE a.subtype IN ('bank','cash') END
  ), moves AS (
   SELECT l.account_id,e.entry_date,l.amount_cents*c.sign AS amount
   FROM accounting.journal_lines l JOIN chosen c ON c.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id
   WHERE e.entry_date<=greatest(end_date,coalesce(compare_end,end_date))
    AND (e.status='posted' OR (working AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
  ), points AS (
   -- Each period's end (the last, partial one ends at `to`), or each account at `to`.
   SELECT d::date::text AS key,NULL::uuid AS account_id,least((d+step-interval '1 day')::date,end_date) AS at FROM generate_series(date_trunc(unit,start_date),date_trunc(unit,end_date),step) d WHERE timed
   UNION ALL SELECT c.id::text,c.id,end_date FROM chosen c WHERE NOT timed
  ), measured AS (
   SELECT p.*,CASE WHEN compare_start IS NULL THEN NULL WHEN NOT timed THEN compare_end
     WHEN extract(day FROM shift)=0 AND p.at=(date_trunc('month',p.at)+interval '1 month -1 day')::date THEN (date_trunc('month',(p.at-shift)::date)+interval '1 month -1 day')::date
     ELSE (p.at-shift)::date END AS compare_at
   FROM points p
  ), valued AS (
   SELECT m.*,coalesce((SELECT sum(v.amount) FROM moves v WHERE v.entry_date<=m.at AND (m.account_id IS NULL OR v.account_id=m.account_id)),0) AS balance,
    coalesce((SELECT sum(v.amount) FROM moves v WHERE v.entry_date<=m.compare_at AND (m.account_id IS NULL OR v.account_id=m.account_id)),0) AS compare_balance
   FROM measured m
  ), ranked AS (
   SELECT v.*,CASE dimension
     WHEN 'month' THEN to_char(v.key::date,'Mon YYYY')
     WHEN 'quarter' THEN 'Q'||extract(quarter FROM v.key::date)||' '||extract(year FROM v.key::date)
     ELSE (SELECT a.name FROM accounting.accounts a WHERE a.id=v.account_id) END AS label,
    (SELECT a.type FROM accounting.accounts a WHERE a.id=v.account_id) AS account_type,
    row_number() OVER (ORDER BY CASE WHEN timed THEN v.key END,abs(v.balance) DESC,abs(v.compare_balance) DESC,v.key) AS position
   FROM valued v
  )
  SELECT jsonb_build_object(
   'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.key,'label',r.label)||CASE WHEN r.account_type IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('type',r.account_type) END
    ||jsonb_build_object('balance_cents',r.balance::text)
    ||CASE WHEN compare_start IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('compare',jsonb_build_object('balance_cents',r.compare_balance::text),'change',jsonb_build_object('balance_cents',(r.balance-r.compare_balance)::text)) END
    ORDER BY r.position) FROM ranked r WHERE timed OR r.position<=top_n),'[]'::jsonb),
   'other',(SELECT jsonb_build_object('label','Other ('||count(*)||' accounts)','groups',count(*),'balance_cents',sum(r.balance)::text)
     ||CASE WHEN compare_start IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('compare',jsonb_build_object('balance_cents',sum(r.compare_balance)::text),'change',jsonb_build_object('balance_cents',(sum(r.balance)-sum(r.compare_balance))::text)) END
    FROM ranked r WHERE NOT timed AND r.position>top_n HAVING count(*)>0),
   'total',(SELECT jsonb_build_object('balance_cents',coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=end_date),0)::text)
     ||CASE WHEN compare_start IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('compare',jsonb_build_object('balance_cents',coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=compare_end),0)::text),
      'change',jsonb_build_object('balance_cents',(coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=end_date),0)-coalesce(sum(v.amount) FILTER(WHERE v.entry_date<=compare_end),0))::text)) END
    FROM moves v)) INTO result;
 END IF;
 RETURN jsonb_build_object('from',start_date,'to',end_date,'book_mode',CASE WHEN working THEN 'working' ELSE 'posted' END,'measure',measure,'group_by',dimension,'top',top_n,
  'compare',CASE WHEN compare_start IS NULL THEN NULL ELSE jsonb_build_object('from',compare_start,'to',compare_end) END)
  ||result
  ||jsonb_build_object('quality',jsonb_build_object(
   'draft_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' AND entry_date BETWEEN start_date AND end_date),
   'unbalanced_drafts',(SELECT count(*) FROM accounting.journal_entries e WHERE e.status='draft' AND e.entry_date BETWEEN start_date AND end_date AND (SELECT count(*)<2 OR coalesce(sum(amount_cents),0)<>0 FROM accounting.journal_lines WHERE entry_id=e.id)),
   'uncategorized_lines',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE a.subtype='uncategorized' AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date),
   'unclassified_cash_lines',0),
   'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1));
END $function$
;

REVOKE ALL ON FUNCTION accounting.breakdown(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.breakdown(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.breakdown(jsonb) TO "authenticated";

-- 4. Recurring charges found in the books.
CREATE OR REPLACE FUNCTION accounting.recurring(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE zone text; as_of date; since date; result jsonb; min_count integer; start_at integer; page_size integer;
 wanted text:=coalesce(params->>'status','all'); working boolean:=coalesce(params->>'mode','posted')='working';
BEGIN
 PERFORM accounting.require_reader();
 IF jsonb_typeof(params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 min_count:=coalesce((params->>'min_count')::integer,3); start_at:=coalesce((params->>'offset')::integer,0); page_size:=coalesce((params->>'limit')::integer,50);
 IF coalesce(params->>'mode','posted') NOT IN ('posted','working') OR wanted NOT IN ('all','active','stopped') OR min_count NOT BETWEEN 2 AND 100 OR start_at<0 OR page_size NOT BETWEEN 1 AND 100
  OR (params->>'contact' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.parties p WHERE p.id::text=params->>'contact')) THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 zone:=coalesce((SELECT books_timezone FROM public.business_profile WHERE id=1),'America/Phoenix');
 as_of:=coalesce((params->>'as_of')::date,(now() AT TIME ZONE zone)::date);
 -- 37 months back by default: enough for three charges of a yearly renewal.
 since:=coalesce((params->>'from')::date,(as_of-interval '37 months')::date);
 IF since>as_of THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE'; END IF;
 WITH charges AS (
  -- Money out on exactly one bank, card or cash line, paying at least one expense account. Transfers, card payments
  -- and reversed pairs never count. The series is the contact, or the bank description when there is none.
  SELECT e.id,e.entry_date,e.payee_id,nullif(btrim(e.descriptor_key),'') AS descriptor,-m.bank_amount AS amount,m.bank_account,m.category
  FROM accounting.journal_entries e CROSS JOIN LATERAL (
   SELECT count(*) FILTER(WHERE a.subtype IN ('bank','card','cash')) AS bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','card','cash')) AS bank_amount,
    (min(l.account_id::text) FILTER(WHERE a.subtype IN ('bank','card','cash')))::uuid AS bank_account,
    (array_agg(l.account_id ORDER BY l.amount_cents DESC,l.id) FILTER(WHERE a.type='expense'))[1] AS category,
    count(*) AS line_count,coalesce(sum(l.amount_cents),0) AS balance
   FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
  WHERE e.entry_date BETWEEN since AND as_of AND (e.status='posted' OR (working AND e.status='draft' AND m.line_count>=2 AND m.balance=0))
   AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)
   AND e.transfer_group_id IS NULL AND e.pair_entry_id IS NULL AND e.kind<>'transfer'
   AND m.bank_count=1 AND m.bank_amount<0 AND m.category IS NOT NULL
   AND (e.payee_id IS NOT NULL OR nullif(btrim(e.descriptor_key),'') IS NOT NULL)
   AND (params->>'contact' IS NULL OR e.payee_id::text=params->>'contact')
 ), occurrences AS (
  -- Two charges in one series on the same day are one payment.
  SELECT coalesce('c:'||c.payee_id::text,'d:'||c.descriptor) AS series,c.entry_date,sum(c.amount) AS amount,
   (array_agg(c.bank_account ORDER BY c.amount DESC,c.id))[1] AS bank_account,(array_agg(c.category ORDER BY c.amount DESC,c.id))[1] AS category,
   (array_agg(c.descriptor ORDER BY c.amount DESC,c.id) FILTER(WHERE c.descriptor IS NOT NULL))[1] AS descriptor,(array_agg(c.payee_id) FILTER(WHERE c.payee_id IS NOT NULL))[1] AS payee_id
  FROM charges c GROUP BY 1,2
 ), ordered AS (
  SELECT o.*,o.entry_date-lag(o.entry_date) OVER w AS gap,lag(o.amount) OVER w AS previous
  FROM occurrences o WINDOW w AS (PARTITION BY o.series ORDER BY o.entry_date)
 ), series AS (
  SELECT o.series,count(*) AS occurrences,min(o.entry_date) AS first_date,max(o.entry_date) AS last_date,
   percentile_cont(0.5) WITHIN GROUP (ORDER BY o.gap) AS median_gap,array_agg(o.gap) FILTER(WHERE o.gap IS NOT NULL) AS gaps,round(avg(o.amount)) AS average,
   (array_agg(o.amount ORDER BY o.entry_date DESC))[1] AS last_amount,(array_agg(o.amount ORDER BY o.entry_date DESC))[2] AS previous_amount,
   -- The latest occurrence whose amount differs from the one before it.
   (array_agg(jsonb_build_object('on',o.entry_date,'from_cents',o.previous::text,'to_cents',o.amount::text) ORDER BY o.entry_date DESC) FILTER(WHERE o.previous IS NOT NULL AND o.previous<>o.amount))[1] AS price_change,
   (array_agg(o.bank_account ORDER BY o.entry_date DESC))[1] AS bank_account,(array_agg(o.category ORDER BY o.entry_date DESC))[1] AS category,
   (array_agg(o.descriptor ORDER BY o.entry_date DESC) FILTER(WHERE o.descriptor IS NOT NULL))[1] AS descriptor,(array_agg(o.payee_id) FILTER(WHERE o.payee_id IS NOT NULL))[1] AS payee_id
  FROM ordered o GROUP BY o.series HAVING count(*)>=min_count
 ), classified AS (
  -- The cadence the median gap falls in, and at least 60% of the gaps must fit it too: a vendor bought from
  -- now and then is not a subscription. A series that fits no cadence is not listed.
  SELECT s.*,c.cadence,c.step,c.nominal,c.per_year FROM series s JOIN LATERAL (
   SELECT v.cadence,v.step,v.nominal,v.per_year FROM (VALUES ('weekly',interval '7 days',5,9,7,52),('monthly',interval '1 month',25,35,30,12),('quarterly',interval '3 months',80,100,91,4),('annual',interval '1 year',330,400,365,1))
    AS v(cadence,step,low,high,nominal,per_year)
   WHERE s.median_gap BETWEEN v.low AND v.high AND (SELECT (count(*) FILTER(WHERE g BETWEEN v.low AND v.high))::numeric/count(*) FROM unnest(s.gaps) AS g)>=0.6
  ) c ON true
 ), scored AS (
  -- Stopped once no charge has come for one and a half cadences.
  SELECT c.*,(c.last_date+c.step)::date AS next_expected,c.last_amount*c.per_year AS annual,
   CASE WHEN as_of-c.last_date>1.5*c.nominal THEN 'stopped' ELSE 'active' END AS status
  FROM classified c
 ), listed AS (
  SELECT s.*,row_number() OVER (ORDER BY s.status='stopped',s.annual DESC,s.last_date DESC,s.series) AS position FROM scored s WHERE wanted='all' OR s.status=wanted
 )
 SELECT jsonb_build_object('as_of',as_of,'from',since,'min_count',min_count,'book_mode',CASE WHEN working THEN 'working' ELSE 'posted' END,'status',wanted,
  'total',(SELECT count(*) FROM listed),'offset',start_at,'limit',page_size,
  'totals',(SELECT jsonb_build_object('active',count(*) FILTER(WHERE s.status='active'),'stopped',count(*) FILTER(WHERE s.status='stopped'),
   'active_annual_cents',coalesce(sum(s.annual) FILTER(WHERE s.status='active'),0)::text,'active_monthly_cents',round(coalesce(sum(s.annual) FILTER(WHERE s.status='active'),0)/12.0)::text) FROM scored s),
  'series',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'contact',CASE WHEN l.payee_id IS NULL THEN NULL ELSE jsonb_build_object('id',l.payee_id,'name',(SELECT p.name FROM accounting.parties p WHERE p.id=l.payee_id)) END,
    'descriptor_key',l.descriptor,'category',(SELECT a.name FROM accounting.accounts a WHERE a.id=l.category),'bank_account',(SELECT a.name FROM accounting.accounts a WHERE a.id=l.bank_account),
    'cadence',l.cadence,'count',l.occurrences,'first_date',l.first_date,'last_date',l.last_date,'next_expected',l.next_expected,'status',l.status,
    'last_cents',l.last_amount::text,'previous_cents',l.previous_amount::text,'average_cents',l.average::text,'price_change',l.price_change,'annual_cents',l.annual::text) ORDER BY l.position)
   FROM listed l WHERE l.position>start_at AND l.position<=start_at+page_size),'[]'::jsonb),
  'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1)) INTO result;
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION accounting.recurring(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.recurring(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION accounting.recurring(jsonb) TO "authenticated";

-- 5. The API reads the two new reads and the support reports (restated in full).
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
  WHEN 'revision' THEN jsonb_build_object('revision', accounting.revision())
  WHEN 'payees' THEN jsonb_build_object('payees', accounting.payees_list())
  WHEN 'rules' THEN jsonb_build_object('rules', accounting.rules_list())
  WHEN 'reconciliation' THEN accounting.reconciliation_status(coalesce(a->'params', '{}'::jsonb))
  WHEN 'attention' THEN accounting.attention(coalesce(a->'params', '{}'::jsonb))
  WHEN 'breakdown' THEN accounting.breakdown(coalesce(a->'params', '{}'::jsonb))
  WHEN 'recurring' THEN accounting.recurring(coalesce(a->'params', '{}'::jsonb))
 END;
END $fn$;

COMMIT;
