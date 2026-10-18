-- Reports compute an accrual basis. Every report reads its lines from accounting.report_source:
-- the ledger exactly as before on the cash basis and, with basis 'accrual', the accrual view's
-- computed adjustment lines (accounting.accrual_lines) beside it. Nothing is posted: the books
-- stay cash and every filing, close and package keeps reading cash. Revenue counts when earned
-- (approved time on the day worked, retainers and dated fees day by day over their service
-- period, other lines on the issue date); each source project's earned-less-billed position is
-- Unbilled work or Billed in advance; a linked deposit's cash revenue is taken back against the
-- invoice it paid; everything before the accrual start is one opening balance. The quality
-- section says what the accrual view rests on and where it could double count.
BEGIN;

CREATE OR REPLACE FUNCTION accounting.accrual_lines(params jsonb, boundaries date[])
 RETURNS TABLE(id uuid, entry_id uuid, entry_date date, account_id uuid, amount_cents bigint, payee_id uuid, memo text, sort_order integer, kind text, ref uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- The accrual view's adjustment lines, computed from the source mirror, earned work and deposit links. Nothing here is ever posted.
-- Every synthetic entry balances on its own:
--  * per source project and day: revenue credits for what was earned that day, receivable debits for invoices issued that day, and the
--    change in the project's contract position (earned less billed) as Unbilled work when positive or Billed in advance when negative;
--  * per linked deposit: the deposit's cash revenue taken back (its credit lines, mapped revenue accounts first) against the receivable;
--  * before the accrual start: one opening set dated the day before, with the offset in opening retained earnings, so the cash books'
--    earlier revenue is never counted twice.
-- Straight-line items (retainers, dated fees) earn day by day with cumulative rounding, emitted in segments that end on the given
-- boundary dates, so any sum the reports take between those dates is exact to the cent.
DECLARE cutover date; receivable uuid; unbilled uuid; deferred uuid; opening uuid; suspense uuid; last_day date;
 working boolean:=coalesce(params->>'mode','posted')='working';
BEGIN
 SELECT s.accrual_start INTO cutover FROM accounting.settings s WHERE s.id=1;
 SELECT a.id INTO receivable FROM accounting.accounts a WHERE a.system_purpose='accounts_receivable';
 SELECT a.id INTO unbilled FROM accounting.accounts a WHERE a.system_purpose='unbilled_revenue';
 SELECT a.id INTO deferred FROM accounting.accounts a WHERE a.system_purpose='deferred_revenue';
 SELECT a.id INTO opening FROM accounting.accounts a WHERE a.system_purpose='opening_retained_earnings';
 SELECT a.id INTO suspense FROM accounting.accounts a WHERE a.system_purpose='uncategorized_income';
 IF cutover IS NULL OR receivable IS NULL OR unbilled IS NULL OR deferred IS NULL OR opening IS NULL OR suspense IS NULL THEN RAISE EXCEPTION 'ACCT_ACCRUAL_NOT_SET_UP'; END IF;
 last_day:=(SELECT max(b) FROM unnest(boundaries) b);
 IF last_day IS NULL OR last_day<cutover-1 THEN RETURN; END IF;
 RETURN QUERY
 WITH billed_lines AS (
  SELECT i.id invoice_id,i.source_id,i.project_ref,i.issue_date,l->>'type' line_type,(l->>'amount_cents')::bigint amount,(l->>'service_from')::date service_from,(l->>'service_to')::date service_to
  FROM accounting.invoices i CROSS JOIN LATERAL jsonb_array_elements(i.lines) l
  WHERE i.removed_at IS NULL AND i.status IN ('issued','paid')
 ), items AS (
  -- What earns: every billed line except hourly ones (the time an hourly line bills is earned when worked, from earned work), plus
  -- earned work itself. Fixed and recurring lines with service dates earn across them; everything else on its issue date.
  SELECT b.source_id,b.project_ref,b.line_type,
   CASE WHEN b.line_type IN ('fixed','recurring') AND b.service_from IS NOT NULL THEN b.service_from ELSE b.issue_date END f,
   CASE WHEN b.line_type IN ('fixed','recurring') AND b.service_from IS NOT NULL THEN b.service_to ELSE b.issue_date END t,
   b.amount,CASE WHEN b.line_type IN ('fixed','recurring') AND b.service_from IS NOT NULL THEN 'retainer' ELSE 'invoice' END origin
  FROM billed_lines b WHERE b.line_type<>'hourly' AND b.amount<>0
  UNION ALL
  SELECT w.source_id,w.project_ref,CASE w.kind WHEN 'time' THEN 'hourly' ELSE 'recurring' END,w.earned_from,w.earned_to,w.amount_cents,CASE w.kind WHEN 'time' THEN 'time' ELSE 'retainer' END
  FROM accounting.earned_work w
 ), earned AS (
  SELECT it.source_id,it.project_ref,it.line_type,it.origin,greatest(seg.d,cutover-1) d,sum(
   (CASE WHEN seg.d>=it.t THEN it.amount ELSE round(it.amount*((seg.d-it.f)+1)::numeric/((it.t-it.f)+1))::bigint END)
   -(CASE WHEN seg.prior<it.f THEN 0 WHEN seg.prior>=it.t THEN it.amount ELSE round(it.amount*((seg.prior-it.f)+1)::numeric/((it.t-it.f)+1))::bigint END))::bigint cents
  FROM items it CROSS JOIN LATERAL (
   SELECT x.d,coalesce(lag(x.d) OVER (ORDER BY x.d),it.f-1) prior FROM (
    SELECT b d FROM unnest(boundaries||(cutover-1)) b WHERE b>=it.f AND b<it.t
    UNION SELECT it.t) x) seg
  WHERE seg.d<=last_day
  GROUP BY 1,2,3,4,5
 ), billed AS (
  SELECT i.id invoice_id,i.source_id,i.project_ref,greatest(i.issue_date,cutover-1) d,i.total_cents cents
  FROM accounting.invoices i WHERE i.removed_at IS NULL AND i.status IN ('issued','paid') AND i.issue_date<=last_day
 ), positions AS (
  SELECT p.source_id,p.project_ref,p.d,sum(p.earned)::bigint earned,sum(p.billed)::bigint billed FROM (
   SELECT e.source_id,e.project_ref,e.d,e.cents earned,0::bigint billed FROM earned e
   UNION ALL SELECT b.source_id,b.project_ref,b.d,0,b.cents FROM billed b) p
  GROUP BY 1,2,3
 ), contract AS (
  -- The project's position after each day, and before it: only the change in its positive part is unbilled, in its negative part deferred.
  SELECT c.*,
   sum(c.earned-c.billed) OVER (PARTITION BY c.source_id,c.project_ref ORDER BY c.d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) after_day,
   coalesce(sum(c.earned-c.billed) OVER (PARTITION BY c.source_id,c.project_ref ORDER BY c.d ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) before_day
  FROM positions c
 ), projects AS (
  SELECT s.id source_id,k.key project_ref,CASE WHEN k.value#>>'{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (k.value#>>'{}')::uuid END party_id
  FROM accounting.invoice_sources s CROSS JOIN LATERAL jsonb_each(s.party_map) k
 ), names AS (
  SELECT i.source_id,i.project_ref,max(nullif(i.project_name,'')) project_name FROM accounting.invoices i GROUP BY 1,2
 ), project_lines AS (
  SELECT e.source_id,e.project_ref,e.d,
   CASE WHEN e.d<cutover THEN opening ELSE coalesce((SELECT a.id FROM accounting.accounts a JOIN accounting.invoice_sources s ON s.id=e.source_id WHERE a.id::text=s.account_map->>e.line_type),suspense) END account_id,
   -e.cents amount,CASE WHEN e.d<cutover THEN 'opening' ELSE e.origin END kind,NULL::uuid ref,1 n
  FROM earned e WHERE e.cents<>0
  UNION ALL SELECT b.source_id,b.project_ref,b.d,receivable,b.cents,CASE WHEN b.d<cutover THEN 'opening' ELSE 'billing' END,b.invoice_id,2 FROM billed b WHERE b.cents<>0
  UNION ALL SELECT c.source_id,c.project_ref,c.d,unbilled,greatest(c.after_day,0)-greatest(c.before_day,0),'contract',NULL,3 FROM contract c WHERE greatest(c.after_day,0)<>greatest(c.before_day,0)
  UNION ALL SELECT c.source_id,c.project_ref,c.d,deferred,-(greatest(-c.after_day,0)-greatest(-c.before_day,0)),'contract',NULL,4 FROM contract c WHERE greatest(-c.after_day,0)<>greatest(-c.before_day,0)
 ), links AS (
  -- Links that count, whose deposit is in this report's books (posted, or a balanced draft in working mode), in link order per deposit.
  SELECT p.id link_id,p.invoice_id,p.entry_id,p.amount_cents,e.entry_date,e.payee_id,i.source_id,i.number,
   sum(p.amount_cents) OVER (PARTITION BY p.entry_id ORDER BY p.created_at,p.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)-p.amount_cents link_from
  FROM accounting.live_invoice_payments() lp JOIN accounting.invoice_payments p ON p.id=lp.id
  JOIN accounting.journal_entries e ON e.id=p.entry_id JOIN accounting.invoices i ON i.id=p.invoice_id
  WHERE (e.status='posted' OR (working AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
   AND e.entry_date<=last_day
 ), credits AS (
  -- A deposit's credit lines, the source's mapped revenue accounts first, laid end to end.
  SELECT l.entry_id,l.account_id,-l.amount_cents credit,
   sum(-l.amount_cents) OVER (PARTITION BY l.entry_id ORDER BY (EXISTS(SELECT 1 FROM accounting.invoice_sources s,jsonb_each_text(s.account_map) m WHERE m.value=l.account_id::text)) DESC,l.sort_order,l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)+l.amount_cents credit_from
  FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id
  WHERE l.amount_cents<0 AND a.subtype NOT IN ('bank','cash','card') AND l.entry_id IN (SELECT k.entry_id FROM links k)
 ), applied AS (
  -- Each link takes back the stretch of credit it covers; a link beyond what the deposit now credits takes back only what is there.
  SELECT k.link_id,k.invoice_id,k.entry_id,k.entry_date,k.payee_id,k.number,c.account_id,
   greatest(least(k.link_from+k.amount_cents,c.credit_from+c.credit)-greatest(k.link_from,c.credit_from),0) cents
  FROM links k JOIN credits c ON c.entry_id=k.entry_id
 ), collections AS (
  SELECT a.link_id,a.invoice_id,a.number,a.payee_id,greatest(a.entry_date,cutover-1) d,CASE WHEN a.entry_date<cutover THEN opening ELSE a.account_id END account_id,a.cents
  FROM applied a WHERE a.cents>0
 ), source_collected AS (
  -- Before the accrual start the source's own payment record stands in for links the books never made.
  SELECT i.id invoice_id,i.number,greatest(
   coalesce((SELECT sum((pay->>'amount_cents')::bigint) FROM jsonb_array_elements(i.payments) pay WHERE (pay->>'paid_date')::date<cutover),0)
   -coalesce((SELECT sum(c.cents) FROM collections c WHERE c.invoice_id=i.id AND c.d<cutover),0),0)::bigint cents
  FROM accounting.invoices i WHERE i.removed_at IS NULL AND i.status IN ('issued','paid') AND i.issue_date<cutover
 ), all_lines AS (
  SELECT 'project:'||pl.source_id||':'||pl.project_ref||':'||pl.d entry_key,pl.d,pl.account_id,pl.amount,pr.party_id,
   CASE WHEN pl.d<cutover THEN 'Accrual opening balance' ELSE 'Accrual: '||coalesce(nm.project_name,pl.project_ref) END memo,pl.n,pl.kind,pl.ref
  FROM project_lines pl LEFT JOIN projects pr ON pr.source_id=pl.source_id AND pr.project_ref=pl.project_ref LEFT JOIN names nm ON nm.source_id=pl.source_id AND nm.project_ref=pl.project_ref
  WHERE pl.amount<>0
  UNION ALL SELECT 'link:'||c.link_id,c.d,c.account_id,c.cents,c.payee_id,'Accrual: '||coalesce(nullif(c.number,''),'invoice')||' paid',1,CASE WHEN c.d<cutover THEN 'opening' ELSE 'collection' END,NULL FROM collections c
  UNION ALL SELECT 'link:'||c.link_id,c.d,receivable,-sum(c.cents)::bigint,max(c.payee_id::text)::uuid,'Accrual: '||coalesce(nullif(max(c.number),''),'invoice')||' paid',2,CASE WHEN c.d<cutover THEN 'opening' ELSE 'collection' END,c.invoice_id FROM collections c GROUP BY c.link_id,c.d,c.invoice_id
  UNION ALL SELECT 'collected:'||s.invoice_id,cutover-1,opening,s.cents,NULL,'Accrual opening balance',1,'opening',NULL FROM source_collected s WHERE s.cents>0
  UNION ALL SELECT 'collected:'||s.invoice_id,cutover-1,receivable,-s.cents,NULL,'Accrual opening balance',2,'opening',s.invoice_id FROM source_collected s WHERE s.cents>0
 )
 SELECT md5('accrual-line:'||l.entry_key||':'||l.account_id||':'||l.n||':'||coalesce(l.ref::text,''))::uuid,md5('accrual:'||l.entry_key)::uuid,l.d,l.account_id,l.amount::bigint,l.party_id,l.memo,l.n::integer,l.kind,l.ref
 FROM all_lines l WHERE l.amount<>0;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_source(params jsonb, boundaries date[] DEFAULT '{}'::date[])
 RETURNS TABLE(id uuid, entry_id uuid, entry_date date, status text, origin text, entry_memo text, account_id uuid, amount_cents bigint, payee_id uuid, line_memo text, sort_order integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- The lines every report reads: the ledger (posted, or balanced drafts in working mode) and, on the accrual basis, the accrual view's
-- computed adjustments. Cash basis is the ledger exactly as before.
BEGIN
 RETURN QUERY SELECT l.id,e.id,e.entry_date,e.status,e.origin,e.memo,l.account_id,l.amount_cents,e.payee_id,l.memo,l.sort_order::integer
 FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id
 WHERE (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id)))
  AND (params->>'payee' IS NULL OR (params->>'payee'='unassigned' AND e.payee_id IS NULL) OR e.payee_id::text=params->>'payee');
 IF coalesce(params->>'basis','cash')='accrual' THEN
  RETURN QUERY SELECT a.id,a.entry_id,a.entry_date,'posted'::text,'internal'::text,a.memo,a.account_id,a.amount_cents,a.payee_id,''::text,a.sort_order
  FROM accounting.accrual_lines(params,boundaries) a
  WHERE (params->>'payee' IS NULL OR (params->>'payee'='unassigned' AND a.payee_id IS NULL) OR a.payee_id::text=params->>'payee');
 END IF;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.accrual_summary(params jsonb, start_date date, end_date date, boundaries date[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- What the accrual view rests on, said plainly so it is never silently wrong: where it starts, what was earned in the range by kind,
-- the receivable split from customer credits, and every gap that would make it double count or miss revenue.
DECLARE cutover date; result jsonb;
BEGIN
 SELECT s.accrual_start INTO cutover FROM accounting.settings s WHERE s.id=1;
 WITH lines AS (SELECT * FROM accounting.accrual_lines(params,boundaries)),
 clients AS (SELECT DISTINCT (k.value#>>'{}') party FROM accounting.invoice_sources s CROSS JOIN LATERAL jsonb_each(s.party_map) k),
 receivables AS (SELECT l.ref invoice_id,sum(l.amount_cents) cents FROM lines l JOIN accounting.accounts a ON a.id=l.account_id
  WHERE a.system_purpose='accounts_receivable' AND l.entry_date<=end_date AND l.ref IS NOT NULL GROUP BY l.ref),
 deposits AS (
  -- Client money since the start that no invoice link accounts for: the cash books count it as income, and so may the accrual view.
  SELECT e.id,(SELECT -sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND l.amount_cents<0 AND a.type='income')
   -coalesce((SELECT sum(p.amount_cents) FROM accounting.live_invoice_payments() p WHERE p.entry_id=e.id),0) cents
  FROM accounting.journal_entries e
  WHERE e.payee_id::text IN (SELECT party FROM clients) AND e.entry_date BETWEEN greatest(start_date,cutover) AND end_date
   AND (e.status='posted' OR (params->>'mode'='working' AND e.status='draft')) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id=e.id)
 )
 SELECT jsonb_build_object(
  'accrual_start',cutover,
  'partial',start_date<cutover,
  'earned',(SELECT jsonb_build_object('time_cents',coalesce(sum(-l.amount_cents) FILTER(WHERE l.kind='time'),0)::text,'retainer_cents',coalesce(sum(-l.amount_cents) FILTER(WHERE l.kind='retainer'),0)::text,
    'invoice_cents',coalesce(sum(-l.amount_cents) FILTER(WHERE l.kind='invoice'),0)::text,'collected_back_cents',coalesce(sum(-l.amount_cents) FILTER(WHERE l.kind='collection'),0)::text)
   FROM lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE a.type='income' AND l.entry_date BETWEEN start_date AND end_date),
  'receivable_cents',(SELECT coalesce(sum(cents) FILTER(WHERE cents>0),0)::text FROM receivables),
  'customer_credit_cents',(SELECT coalesce(-sum(cents) FILTER(WHERE cents<0),0)::text FROM receivables),
  'unlinked_client_deposits',(SELECT jsonb_build_object('count',count(*),'cents',coalesce(sum(cents),0)::text) FROM deposits WHERE cents>0),
  'paid_at_source_unlinked',(SELECT jsonb_build_object('count',count(*),'cents',coalesce(sum(i.total_cents-coalesce(lk.cents,0)),0)::text)
   FROM accounting.invoices i LEFT JOIN (SELECT p.invoice_id,sum(p.amount_cents) cents FROM accounting.live_invoice_payments() p GROUP BY 1) lk ON lk.invoice_id=i.id
   WHERE i.removed_at IS NULL AND i.status='paid' AND i.issue_date>=cutover AND i.issue_date<=end_date AND coalesce(lk.cents,0)<i.total_cents),
  'unmapped_line_types',(SELECT coalesce(jsonb_agg(DISTINCT l->>'type'),'[]') FROM accounting.invoices i JOIN accounting.invoice_sources s ON s.id=i.source_id CROSS JOIN LATERAL jsonb_array_elements(i.lines) l
   WHERE i.removed_at IS NULL AND i.status IN ('issued','paid') AND NOT s.account_map ? (l->>'type')),
  'unmapped_projects',(SELECT count(DISTINCT (i.source_id,i.project_ref)) FROM accounting.invoices i JOIN accounting.invoice_sources s ON s.id=i.source_id
   WHERE i.removed_at IS NULL AND NOT s.party_map ? i.project_ref),
  'links_beyond_deposit',(SELECT count(*) FROM (SELECT p.entry_id FROM accounting.live_invoice_payments() p GROUP BY p.entry_id
   HAVING sum(p.amount_cents)>coalesce((SELECT -sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=p.entry_id AND l.amount_cents<0 AND a.subtype NOT IN ('bank','cash','card')),0)) x),
  'ended_links',(SELECT count(*) FROM accounting.invoice_payments p WHERE p.removed_at IS NOT NULL AND p.removed_reason IN ('Invoice removed at the source','Invoice voided at the source','Deposit discarded or reversed')),
  'stale_sources',(SELECT count(*) FROM accounting.invoice_sources s WHERE s.status='active' AND (s.last_synced_at IS NULL OR s.last_synced_at<now()-interval '24 hours')),
  'changed_after_lock',(SELECT count(*) FROM accounting.invoices i JOIN accounting.periods pr ON pr.status='locked' AND i.issue_date BETWEEN pr.month AND (pr.month+interval '1 month - 1 day')::date
   WHERE i.issue_date>=cutover AND i.updated_at>pr.locked_at)
 ) INTO result;
 RETURN result;
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
 accounts jsonb;totals jsonb;comparison jsonb;monthly jsonb;cash jsonb;quality jsonb;dimensions jsonb;result jsonb;basis text:=coalesce(params->>'basis','cash');bounds date[]:='{}';
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_reader();END IF;
 PERFORM accounting.report_validate(params);
 IF kind NOT IN ('profit_loss','balance_sheet','trial_balance','general_ledger','cash_movements','account_balances','summary','owner_activity','payee') THEN RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 IF start_date>end_date OR (compare_start IS NULL)<>(compare_end IS NULL) OR compare_start>compare_end THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 year_start:=make_date(extract(year FROM end_date)::integer,(SELECT fiscal_year_start_month FROM public.business_profile WHERE id=1),1);
 IF year_start>end_date THEN year_start:=(year_start-interval '1 year')::date;END IF;
 IF compare_end IS NOT NULL THEN compare_year_start:=make_date(extract(year FROM compare_end)::integer,(SELECT fiscal_year_start_month FROM public.business_profile WHERE id=1),1);IF compare_year_start>compare_end THEN compare_year_start:=(compare_year_start-interval '1 year')::date;END IF;END IF;
 -- The accrual view's straight-line earnings split on every date a total below is cut at, so each sum is exact.
 IF basis='accrual' THEN
  bounds:=ARRAY[start_date-1,end_date,year_start-1]||CASE WHEN compare_end IS NULL THEN '{}'::date[] ELSE ARRAY[compare_start-1,compare_end,compare_year_start-1] END
   ||(SELECT coalesce(array_agg((d+interval '1 month - 1 day')::date),'{}') FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d);
 END IF;
 WITH selected AS (
  SELECT s.entry_date,s.status,s.id,s.entry_id,s.account_id,s.amount_cents,s.line_memo memo,s.sort_order FROM accounting.report_source(params,bounds) s
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
 IF kind='balance_sheet' AND NOT params ?| ARRAY['account_ids','account_types','payee'] AND (totals->>'difference_cents')::numeric<>0 THEN RAISE EXCEPTION 'ACCT_BALANCE_SHEET_UNBALANCED';END IF;
 IF compare_start IS NOT NULL THEN comparison:=accounting.report(kind,(params-ARRAY['compare_from','compare_to','as_of'])||jsonb_build_object('from',compare_start,'to',compare_end))->'totals';
 ELSE comparison:=(SELECT jsonb_object_agg(key,'0'::text) FROM jsonb_each(totals));END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',month,'income_cents',income::text,'expense_cents',expense::text,'net_cents',(income-expense)::text) ORDER BY month),'[]') INTO monthly FROM (
 SELECT d::date AS month,-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) expense
 FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d
 LEFT JOIN accounting.report_source(params,bounds) l ON l.entry_date>=d::date AND l.entry_date<(d+interval '1 month')::date AND l.entry_date BETWEEN start_date AND end_date
 LEFT JOIN accounting.accounts a ON a.id=l.account_id GROUP BY d) m;
 SELECT coalesce(jsonb_agg(jsonb_build_object('classification',classification,'amount_cents',cents::text,'line_count',n) ORDER BY classification),'[]') INTO cash FROM (SELECT classification,sum(amount_cents) cents,count(DISTINCT id) n FROM accounting.cash_lines(params||jsonb_build_object('from',start_date,'to',end_date)) GROUP BY classification) c;
 SELECT jsonb_build_object('draft_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' AND entry_date BETWEEN start_date AND end_date),
 'unbalanced_drafts',(SELECT count(*) FROM accounting.journal_entries e WHERE e.status='draft' AND e.entry_date BETWEEN start_date AND end_date AND (SELECT count(*)<2 OR coalesce(sum(amount_cents),0)<>0 FROM accounting.journal_lines WHERE entry_id=e.id)),
 'unclassified_cash_lines',0,'uncategorized_lines',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE a.subtype='uncategorized' AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date),
 'reconciliations',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',b.account_id,'through',r.statement_end)),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE r.status='completed'),
 'feeds',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'last_success_at',last_success_at,'status',status)),'[]') FROM accounting.bank_connections)) INTO quality;
 IF basis='accrual' THEN quality:=quality||jsonb_build_object('accrual',accounting.accrual_summary(params,start_date,end_date,bounds));END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind','payee','id',party,'name',name,'income_cents',income::text,'expense_cents',expense::text,'compare_income_cents',compare_income::text,'compare_expense_cents',compare_expense::text)),'[]') INTO dimensions FROM (
 SELECT coalesce(l.payee_id::text,'unassigned') party,coalesce(p.name,'Unassigned') name,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND l.entry_date BETWEEN start_date AND end_date),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND l.entry_date BETWEEN start_date AND end_date),0) expense,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND l.entry_date BETWEEN compare_start AND compare_end),0) compare_income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND l.entry_date BETWEEN compare_start AND compare_end),0) compare_expense
 FROM accounting.report_source(params,bounds||CASE WHEN compare_end IS NULL OR basis<>'accrual' THEN '{}'::date[] ELSE ARRAY[compare_start-1,compare_end] END) l JOIN accounting.accounts a ON a.id=l.account_id LEFT JOIN accounting.parties p ON p.id=l.payee_id
 WHERE (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types'))) AND (l.entry_date BETWEEN start_date AND end_date OR l.entry_date BETWEEN compare_start AND compare_end) GROUP BY l.payee_id,p.name) q;
 result:=jsonb_build_object('legal_name',(SELECT legal_name FROM public.business_profile WHERE id=1),'revision',(SELECT financial_revision::text FROM accounting.settings),'definition_version',1,'currency','USD','basis',basis,'generated_at',now(),
 'filter',(params-'as_of')||jsonb_build_object('from',start_date,'to',end_date,'mode',coalesce(params->>'mode','posted'),'offset',coalesce((params->>'offset')::integer,0)),'accounts',accounts,'rows',accounts,'totals',totals,'comparison',comparison,'monthly',monthly,'dimensions',dimensions,'cash',cash,'quality',quality);
 RETURN result||jsonb_build_object('income_cents',totals->'income_cents','expense_cents',totals->'expense_cents','net_income_cents',totals->'net_cents','cost_of_goods_sold_cents',totals->'cogs_cents',
 'gross_profit_cents',((totals->>'income_cents')::numeric-(totals->>'cogs_cents')::numeric)::text,'operating_expense_cents',((totals->>'expense_cents')::numeric-(totals->>'cogs_cents')::numeric)::text,
 'assets_cents',totals->'assets_cents','liabilities_cents',totals->'liabilities_cents','equity_cents',totals->'equity_cents','retained_cents',totals->'prior_cents','year_income_cents',totals->'year_cents',
 'equity_total_cents',((totals->>'equity_cents')::numeric+(totals->>'prior_cents')::numeric+(totals->>'year_cents')::numeric)::text,'balance_difference_cents',totals->'difference_cents','trial_balance_cents',totals->'difference_cents');
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_lines(kind text, params jsonb, account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date:=(params->>'from')::date;end_date date:=coalesce((params->>'as_of')::date,(params->>'to')::date);offset_rows integer:=coalesce((params->>'offset')::integer,0);limit_rows integer:=coalesce((params->>'limit')::integer,100);result jsonb;opening numeric;bounds date[]:='{}';
BEGIN
 PERFORM accounting.require_reader();
 PERFORM accounting.report_validate(params);
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR offset_rows<0 OR limit_rows NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 IF report_lines.kind NOT IN ('general_ledger','profit_loss','balance_sheet','trial_balance','account_balances','cash_movements','owner_activity','summary','payee') THEN RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 IF account IS NOT NULL THEN params:=params||jsonb_build_object('account_ids',jsonb_build_array(account));END IF;
 params:=(params-'as_of')||jsonb_build_object('from',start_date,'to',end_date);
 -- Cash is cash on either basis; only the other ledgers read the accrual view's adjustments, split on the range edges and month ends.
 IF report_lines.kind='cash_movements' THEN params:=params-'basis';
 ELSIF params->>'basis'='accrual' THEN
  bounds:=ARRAY[start_date-1,end_date]||(SELECT coalesce(array_agg((d+interval '1 month - 1 day')::date),'{}') FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d);
 END IF;
 WITH selected AS (
 SELECT s.id,s.entry_id,s.account_id,s.amount_cents,s.line_memo memo,s.sort_order,s.entry_date,s.entry_memo,s.status,s.origin,a.name account_name,a.type account_type
 FROM accounting.report_source(params,bounds) s JOIN accounting.accounts a ON a.id=s.account_id
 WHERE s.entry_date<=end_date
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
 IF coalesce(params->>'basis','cash') NOT IN ('cash','accrual') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER';END IF;
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
   -- With an invoice source the accrual view's month is kept too, so a locked month's accrual figures can be compared later. The legal snapshot above stays cash.
   IF EXISTS(SELECT 1 FROM accounting.invoice_sources) AND (SELECT accrual_start FROM accounting.settings WHERE id=1)<=ending THEN
    BEGIN
     snapshot:=snapshot||jsonb_build_object('accrual',jsonb_build_object('profit_loss',accounting.report('profit_loss',jsonb_build_object('from',month_date,'to',ending,'basis','accrual'))->'totals',
      'balance_sheet',accounting.report('balance_sheet',jsonb_build_object('as_of',ending,'basis','accrual'))->'totals'));
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
   END IF;
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
   -- The open link when there is one; a closed account reconciles on its latest link.
   SELECT id INTO bank FROM accounting.bank_accounts WHERE account_id=(c->>'account_id')::uuid ORDER BY is_closed,created_at DESC,id LIMIT 1;
   IF bank IS NULL THEN INSERT INTO accounting.bank_accounts(account_id,is_closed,closed_on) SELECT ra.id,ra.closed_on IS NOT NULL,ra.closed_on FROM accounting.accounts ra WHERE ra.id=(c->>'account_id')::uuid RETURNING id INTO bank;END IF;
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

REVOKE ALL ON FUNCTION accounting.accrual_lines(jsonb, date[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.accrual_lines(jsonb, date[]) TO "postgres";

REVOKE ALL ON FUNCTION accounting.accrual_summary(jsonb, date, date, date[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.accrual_summary(jsonb, date, date, date[]) TO "postgres";

REVOKE ALL ON FUNCTION accounting.report_source(jsonb, date[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.report_source(jsonb, date[]) TO "postgres";

COMMIT;
