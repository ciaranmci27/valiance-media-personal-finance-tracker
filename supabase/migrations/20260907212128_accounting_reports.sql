BEGIN;
-- ACCOUNTING REPORTS BEGIN
CREATE TABLE accounting.report_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('profit_loss','balance_sheet','trial_balance','general_ledger','cash_movements','year_end_package','month_close')),
 params jsonb NOT NULL,from_date date NOT NULL,to_date date NOT NULL CHECK(to_date>=from_date),financial_revision bigint NOT NULL,data jsonb NOT NULL,
 document_id uuid REFERENCES accounting.documents ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users ON DELETE RESTRICT
);
ALTER TABLE accounting.report_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON accounting.report_snapshots FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION accounting.report_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_SNAPSHOT';END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON accounting.report_snapshots FOR EACH ROW EXECUTE FUNCTION accounting.report_guard();
CREATE TRIGGER audit AFTER INSERT ON accounting.report_snapshots FOR EACH ROW EXECUTE FUNCTION accounting.record_audit();
CREATE FUNCTION accounting.report_validate(params jsonb) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;
CREATE FUNCTION accounting.report(kind text,params jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;
CREATE FUNCTION accounting.cash_lines(params jsonb) RETURNS TABLE(id uuid,entry_id uuid,account_id uuid,amount_cents numeric,classification text,allocation_index bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
$fn$;
CREATE FUNCTION accounting.report_lines(kind text,params jsonb,account uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;
CREATE FUNCTION accounting.ledger(account uuid,from_date date,to_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM accounting.require_owner();RETURN accounting.report_lines('general_ledger',jsonb_build_object('from',from_date,'to',to_date),account);
END $fn$;
CREATE FUNCTION accounting.workspace(from_date date,to_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r jsonb;tx jsonb;
BEGIN
 PERFORM accounting.require_owner();r:=accounting.report('summary',jsonb_build_object('from',from_date,'to',to_date));tx:=accounting.transactions(jsonb_build_object('from',from_date,'to',to_date));
 RETURN jsonb_build_object('legal_name',r->'legal_name','revision',r->'revision','from',from_date,'to',to_date,'accounts',r->'accounts','balances',r->'accounts','entries',tx->'entries','entry_count',tx->'total','draft_count',r->'quality'->'draft_count',
 'needs_review_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft'),'sync_due',EXISTS(SELECT 1 FROM accounting.bank_connections WHERE status='active' AND scheduled AND (last_success_at IS NULL OR last_success_at<now()-interval '6 hours')),
 'reports',r-ARRAY['legal_name','revision','definition_version','currency','basis','generated_at','filter','accounts','rows','totals','comparison','monthly','dimensions','cash','quality']);
END $fn$;
CREATE FUNCTION accounting.snapshot_read(id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM accounting.require_owner();RETURN (SELECT jsonb_build_object('id',s.id,'revision',financial_revision::text,'created_at',created_at,'payload',data,'document_id',document_id) FROM accounting.report_snapshots s WHERE s.id=snapshot_read.id);
END $fn$;
CREATE FUNCTION accounting.report_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;

CREATE FUNCTION accounting.support_report(params jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;
CREATE FUNCTION accounting.books_package(params jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;

REVOKE ALL ON FUNCTION accounting.report_validate(jsonb),accounting.report_guard(),accounting.report(text,jsonb),accounting.cash_lines(jsonb),accounting.report_lines(text,jsonb,uuid),accounting.ledger(uuid,date,date),accounting.workspace(date,date),accounting.snapshot_read(uuid),accounting.report_command(jsonb),accounting.support_report(jsonb),accounting.books_package(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.report(text,jsonb),accounting.report_lines(text,jsonb,uuid),accounting.ledger(uuid,date,date),accounting.workspace(date,date),accounting.snapshot_read(uuid),accounting.support_report(jsonb),accounting.books_package(jsonb) TO authenticated;
CREATE FUNCTION accounting.context(view text,params jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;
REVOKE ALL ON FUNCTION accounting.context(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.context(text,jsonb) TO authenticated;

-- ACCOUNTING REPORTS END
COMMIT;
