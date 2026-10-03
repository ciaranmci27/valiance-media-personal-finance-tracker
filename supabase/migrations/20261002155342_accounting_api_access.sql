-- Finance API, phase 1a: agents, a read-only books permission, API keys.
--
-- Agents get their own team role and sign-in, so the API acts as a named
-- person. accounting.read opens the six books reads the API serves
-- (workspace, transactions, entry_detail, report, report_lines, ledger)
-- through accounting.require_reader(), but only inside an API call
-- (api_act sets the api actor kind and key id; a browser session cannot), so
-- every read by a reader passes the key's scope, expiry, revoke, rate limit
-- and request log. Every other books
-- function keeps require_owner(), so a reader can never write. api.use is the
-- per-person switch for the API.
--
-- Keys follow the PM app's model after its phase 0: hashed, created and
-- revoked by the server, guarded for every role. public.api_act checks a key
-- and makes auth.uid() return its member for that transaction only (proved
-- against the live auth.uid() definition in scripts/verify-api-access.ts), so
-- every existing books check runs unchanged. Function bodies below are copied
-- from schema.sql with only the owner check changed.

ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_role_check;
ALTER TABLE public.team_members ADD CONSTRAINT team_members_role_check CHECK (role IN ('owner','admin','member','agent'));
ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('admin','member','agent'));

INSERT INTO public.role_permissions(role, permission_key) VALUES
  ('admin', 'accounting.read'), ('agent', 'accounting.read'), ('agent', 'accounting.draft'), ('agent', 'api.use')
ON CONFLICT DO NOTHING;

-- One live-key check for the books' owner and reader checks: inside an API
-- call only (public.api_act sets accounting.actor_kind 'api' and api.key_id),
-- the key must be live, the caller's own, scoped for `scope`, and the member
-- must still hold it.
CREATE OR REPLACE FUNCTION accounting.api_key_allows(actor uuid, scope text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 RETURN current_setting('accounting.actor_kind',true)='api' AND public.has_permission(scope) AND EXISTS(SELECT 1 FROM public.api_keys k JOIN public.team_members m ON m.id=k.team_member_id WHERE k.id::text=current_setting('api.key_id',true) AND m.auth_user_id=actor AND m.status='active' AND k.revoked_at IS NULL AND k.disabled_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now()) AND scope=ANY(k.scopes));
END $function$
;

REVOKE ALL ON FUNCTION accounting.api_key_allows(uuid,text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.api_key_allows(uuid,text) TO "postgres";

-- Readers: the owner of record, accounting.manage, or accounting.read inside an
-- API call: public.api_act sets accounting.actor_kind 'api' and api.key_id, and
-- the key must still be live, the caller's own and scoped for the books.
CREATE OR REPLACE FUNCTION accounting.require_reader()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=actor OR public.has_permission('accounting.manage') OR accounting.api_key_allows(actor,'accounting.read') OR accounting.api_key_allows(actor,'accounting.draft'))) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $function$
;

REVOKE ALL ON FUNCTION accounting.require_reader() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.require_reader() TO "postgres";

-- The books' change counter, cheap enough to poll.
CREATE OR REPLACE FUNCTION accounting.revision()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 RETURN (SELECT financial_revision::text FROM accounting.settings WHERE id=1);
END $function$
;

REVOKE ALL ON FUNCTION accounting.revision() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.revision() TO "postgres";

CREATE OR REPLACE FUNCTION accounting.workspace(from_date date, to_date date, mode text DEFAULT 'posted'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r jsonb;tx jsonb;
BEGIN
 PERFORM accounting.require_reader();r:=accounting.report('summary',jsonb_build_object('from',from_date,'to',to_date,'mode',coalesce(mode,'posted')));tx:=accounting.transactions(jsonb_build_object('from',from_date,'to',to_date));
 RETURN jsonb_build_object('legal_name',r->'legal_name','revision',r->'revision','from',from_date,'to',to_date,'accounts',r->'accounts','balances',r->'accounts','entries',tx->'entries','entry_count',tx->'total','draft_count',r->'quality'->'draft_count',
 'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)),'sync_due',EXISTS(SELECT 1 FROM accounting.bank_connections WHERE status='active' AND scheduled AND (last_success_at IS NULL OR last_success_at<now()-interval '6 hours')),
 'reports',r-ARRAY['legal_name','revision','definition_version','currency','basis','generated_at','filter','accounts','rows','totals','comparison','monthly','dimensions','cash','quality']);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc'); q text:=nullif(btrim(coalesce(f->>'query','')),'');
BEGIN
 PERFORM accounting.require_reader();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded','reversed') OR (f->>'review' IS NOT NULL AND f->>'review' NOT IN ('needs_review','reviewed')) OR (f->>'from')::date>(f->>'to')::date THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH terms AS MATERIALIZED (SELECT kind,pattern,cents,op FROM accounting.search_terms(q)),
 candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude,m.amounts,
 CASE WHEN q IS NULL THEN NULL ELSE lower(concat_ws(' ',e.memo,e.source_description,e.kind,to_char(e.entry_date,'YYYY-MM-DD'),to_char(e.entry_date,'Mon FMDD, YYYY'),to_char(e.entry_date,'FMMonth FMDD, YYYY'),to_char(e.entry_date,'FMMM/FMDD/YYYY'),
  (SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),m.labels,
  (SELECT string_agg(bt.description,' ') FROM accounting.bank_matches bm JOIN accounting.journal_lines bl ON bl.id=bm.journal_line_id JOIN accounting.bank_transactions bt ON bt.id=bm.bank_transaction_id WHERE bl.entry_id=e.id))) END document
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits,array_agg(abs(l.amount_cents)) amounts,
  CASE WHEN q IS NULL THEN NULL ELSE string_agg(concat_ws(' ',a.code,a.name,l.memo,to_char(abs(l.amount_cents)/100.0,'FM999999999999990.00'),to_char(abs(l.amount_cents)/100.0,'FM999,999,999,999,990.00'),
   (SELECT string_agg(concat_ws(' ',b.institution,b.mask),' ') FROM accounting.bank_accounts b WHERE b.account_id=a.id)),' ') END labels
  FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (f->>'entry_id' IS NOT NULL OR CASE WHEN f->>'status'='reversed' THEN e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) ELSE e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) END)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) WHEN f->>'status'='reversed' THEN e.status='posted' ELSE e.status=f->>'status' END)
 AND (f->>'review' IS NULL OR CASE WHEN f->>'review'='reviewed' THEN e.status='posted' AND NOT e.review_pending ELSE e.status='draft' OR (e.status='posted' AND e.review_pending) END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR e.payee_id=(f->>'payee')::uuid)
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (q IS NULL OR (SELECT coalesce(bool_and(coalesce(CASE t.kind
  WHEN 'compare' THEN CASE t.op WHEN '>' THEN e.magnitude>t.cents WHEN '>=' THEN e.magnitude>=t.cents WHEN '<' THEN e.magnitude<t.cents ELSE e.magnitude<=t.cents END
  WHEN 'amount' THEN t.cents=ANY(e.amounts) OR t.cents=e.magnitude OR e.document ~ t.pattern
  WHEN 'dollars' THEN EXISTS(SELECT 1 FROM unnest(e.amounts||e.magnitude) v WHERE v/100=t.cents/100) OR e.document ~ t.pattern
  ELSE e.document LIKE '%'||t.pattern||'%' END,false)),true) FROM terms t))
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id))) INTO result;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.entry_detail(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb; extra jsonb; bank_account uuid;
BEGIN
 PERFORM accounting.require_reader();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'restored_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE restores_entry_id=e.id),
  'replacement_entry_id',(SELECT id FROM accounting.journal_entries WHERE replaces_entry_id=e.id LIMIT 1),
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (p.ytd->'patriot_import'->>'original_entry_id'=e.id::text AND p.ytd->'patriot_import'->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
  -- The own account on the other side of a linked transfer, so either leg can name where the money went or came from.
  'transfer_account_id',CASE WHEN e.transfer_group_id IS NOT NULL THEN (SELECT l.account_id FROM accounting.journal_entries g JOIN accounting.journal_lines l ON l.entry_id=g.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE g.transfer_group_id=e.transfer_group_id AND g.id<>e.id AND g.reverses_entry_id IS NULL AND a.subtype IN ('bank','card','cash') ORDER BY g.entry_date,l.sort_order LIMIT 1) END,
  'context',jsonb_build_object('kind',e.kind,'payee_id',e.payee_id),'prior_treatment',NULL,
  'lines',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id),'[]')) INTO result
 FROM accounting.journal_entries e WHERE e.id=entry;
 IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY a.id),'[]') INTO extra FROM accounting.audit_log a WHERE a.row_id=entry;
 result:=result||jsonb_build_object('audit',extra,'matches','[]'::jsonb,'documents','[]'::jsonb);
 IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
  SELECT l.account_id INTO bank_account FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1;
  IF bank_account IS NOT NULL AND result->>'descriptor_key' IS NOT NULL THEN
   EXECUTE 'SELECT accounting.prior_summary($1,$2,10)' INTO extra USING result->>'descriptor_key',bank_account;
   result:=result||jsonb_build_object('prior_treatment',extra-ARRAY['entries','memo','last_date']);
  END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object(''amount_cents'',m.amount_cents::text)),''[]''::jsonb) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('matches',extra);
  IF result->>'status'='draft' THEN
   -- What the books did to this draft on their own, and the transfer they would suggest when nothing was sure enough to pair.
   IF result->>'fill_source' IS NOT NULL THEN
    result:=result||jsonb_build_object('fill',jsonb_strip_nulls(jsonb_build_object('source',result->>'fill_source',
     'rule_name',CASE WHEN result->>'fill_source'='rule' THEN (SELECT name FROM accounting.rules WHERE id=(result->>'applied_rule_id')::uuid) END,
     'pair_entry_date',(SELECT p.entry_date FROM accounting.journal_entries p WHERE p.id=(result->>'pair_entry_id')::uuid),
     'pair_account_id',(SELECT l.account_id FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=(result->>'pair_entry_id')::uuid AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1))));
   END IF;
   EXECUTE 'SELECT accounting.transfer_candidate($1)' INTO extra USING entry;
   IF extra IS NOT NULL THEN result:=result||jsonb_build_object('transfer_suggestion',extra); END IF;
  END IF;
 END IF;
 IF to_regclass('accounting.document_links') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(d)),''[]''::jsonb) FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('documents',extra);
 END IF;
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
 accounts jsonb;totals jsonb;comparison jsonb;monthly jsonb;cash jsonb;quality jsonb;dimensions jsonb;result jsonb;
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_reader();END IF;
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
 IF kind='balance_sheet' AND NOT params ?| ARRAY['account_ids','account_types','payee'] AND (totals->>'difference_cents')::numeric<>0 THEN RAISE EXCEPTION 'ACCT_BALANCE_SHEET_UNBALANCED';END IF;
 IF compare_start IS NOT NULL THEN comparison:=accounting.report(kind,(params-ARRAY['compare_from','compare_to','as_of'])||jsonb_build_object('from',compare_start,'to',compare_end))->'totals';
 ELSE comparison:=(SELECT jsonb_object_agg(key,'0'::text) FROM jsonb_each(totals));END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',month,'income_cents',income::text,'expense_cents',expense::text,'net_cents',(income-expense)::text) ORDER BY month),'[]') INTO monthly FROM (
 SELECT d::date AS month,-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) income,coalesce(sum(l.amount_cents) FILTER(WHERE a.type='expense' AND (NOT params?'account_ids' OR a.id::text IN(SELECT jsonb_array_elements_text(params->'account_ids'))) AND (NOT params?'account_types' OR a.type IN(SELECT jsonb_array_elements_text(params->'account_types')))),0) expense
 FROM generate_series(date_trunc('month',start_date),date_trunc('month',end_date),interval '1 month') d
 LEFT JOIN accounting.journal_entries e ON e.entry_date>=d::date AND e.entry_date<(d+interval '1 month')::date AND e.entry_date BETWEEN start_date AND end_date AND (e.status='posted' OR (params->>'mode'='working' AND e.status='draft' AND (SELECT count(*)>=2 AND coalesce(sum(bl.amount_cents),0)=0 FROM accounting.journal_lines bl WHERE bl.entry_id=e.id))) AND (params->>'payee' IS NULL OR e.payee_id::text=params->>'payee' OR (params->>'payee'='unassigned' AND e.payee_id IS NULL))
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id GROUP BY d) m;
 SELECT coalesce(jsonb_agg(jsonb_build_object('classification',classification,'amount_cents',cents::text,'line_count',n) ORDER BY classification),'[]') INTO cash FROM (SELECT classification,sum(amount_cents) cents,count(DISTINCT id) n FROM accounting.cash_lines(params||jsonb_build_object('from',start_date,'to',end_date)) GROUP BY classification) c;
 SELECT jsonb_build_object('draft_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft' AND entry_date BETWEEN start_date AND end_date),
 'unbalanced_drafts',(SELECT count(*) FROM accounting.journal_entries e WHERE e.status='draft' AND e.entry_date BETWEEN start_date AND end_date AND (SELECT count(*)<2 OR coalesce(sum(amount_cents),0)<>0 FROM accounting.journal_lines WHERE entry_id=e.id)),
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
END $function$
;

CREATE OR REPLACE FUNCTION accounting.report_lines(kind text, params jsonb, account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE start_date date:=(params->>'from')::date;end_date date:=coalesce((params->>'as_of')::date,(params->>'to')::date);offset_rows integer:=coalesce((params->>'offset')::integer,0);limit_rows integer:=coalesce((params->>'limit')::integer,100);result jsonb;opening numeric;
BEGIN
 PERFORM accounting.require_reader();
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
END $function$
;

CREATE OR REPLACE FUNCTION accounting.ledger(account uuid, from_date date, to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();RETURN accounting.report_lines('general_ledger',jsonb_build_object('from',from_date,'to',to_date),account);
END $function$
;

-- API keys for the finance API. Same model as the PM app after its phase 0:
-- the server creates and revokes keys, members only read the keys they own
-- (the owner reads all), and the guard holds for every role.
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  team_member_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_team_member ON public.api_keys(team_member_id);

-- Fixed one-minute windows per key, counted by api_authorize.
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, window_start)
);

-- One row per API request, refusals included, written by the server.
CREATE TABLE IF NOT EXISTS public.api_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL,
  team_member_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  operation TEXT,
  status INTEGER NOT NULL,
  error_code TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_requests_at ON public.api_requests(at DESC);
CREATE INDEX IF NOT EXISTS idx_api_requests_key ON public.api_requests(api_key_id, at DESC);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_keys, public.api_rate_limits, public.api_requests FROM PUBLIC, anon, authenticated;
-- Every column but key_hash: the hash never leaves the server.
GRANT SELECT (id, name, key_prefix, team_member_id, created_by, scopes, expires_at, last_used_at, disabled_at, revoked_at, created_at, updated_at) ON public.api_keys TO authenticated;
GRANT SELECT ON public.api_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys, public.api_rate_limits, public.api_requests TO service_role;

DROP POLICY IF EXISTS api_keys_select ON public.api_keys;
CREATE POLICY api_keys_select ON public.api_keys FOR SELECT TO authenticated
  USING (team_member_id = public.current_team_member_id() OR created_by = public.current_team_member_id()
    OR public.current_team_member_role() = 'owner');
DROP POLICY IF EXISTS api_requests_select ON public.api_requests;
CREATE POLICY api_requests_select ON public.api_requests FOR SELECT TO authenticated
  USING (team_member_id = public.current_team_member_id() OR public.current_team_member_role() = 'owner');

-- A revoke is final, the secret and creation time never change, and a key
-- never moves to another member. team_member_id and created_by may still
-- become NULL: their foreign keys are ON DELETE SET NULL, which runs as an
-- UPDATE and fires this trigger.
CREATE OR REPLACE FUNCTION public.api_keys_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
  RAISE EXCEPTION 'API key % is revoked; a revoke cannot be changed', OLD.id USING ERRCODE = '42501';
 END IF;
 IF NEW.key_hash IS DISTINCT FROM OLD.key_hash OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'API key % secret and creation time cannot change', OLD.id USING ERRCODE = '42501';
 END IF;
 IF (NEW.team_member_id IS DISTINCT FROM OLD.team_member_id AND NEW.team_member_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
  RAISE EXCEPTION 'API key % cannot move to another member', OLD.id USING ERRCODE = '42501';
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER api_keys_guard BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard();

-- Checks a key and acts as its member for the rest of this transaction only:
-- auth.uid() reads request.jwt.claim.sub first, so every books check, policy
-- and has_permission() then sees the member, exactly as for their browser
-- session. Both locks must hold: the scope is on the key AND the member holds
-- the permission, plus api.use. accounting.actor_kind 'api' keeps the feed
-- worker's service_role bypass closed. Raises API_* codes the server maps to
-- HTTP statuses.
CREATE OR REPLACE FUNCTION public.api_act(p_key_hash text, p_permission text) RETURNS public.api_keys LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE k public.api_keys; m public.team_members;
BEGIN
 SELECT * INTO k FROM public.api_keys WHERE key_hash = p_key_hash;
 IF NOT FOUND OR k.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'API_KEY_INVALID'; END IF;
 IF k.disabled_at IS NOT NULL THEN RAISE EXCEPTION 'API_KEY_DISABLED'; END IF;
 IF k.expires_at IS NOT NULL AND k.expires_at <= now() THEN RAISE EXCEPTION 'API_KEY_EXPIRED'; END IF;
 SELECT * INTO m FROM public.team_members WHERE id = k.team_member_id;
 IF NOT FOUND OR m.status <> 'active' OR m.auth_user_id IS NULL THEN RAISE EXCEPTION 'API_MEMBER_INACTIVE'; END IF;
 PERFORM set_config('request.jwt.claim.sub', m.auth_user_id::text, true);
 PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', m.auth_user_id, 'role', 'authenticated')::text, true);
 PERFORM set_config('accounting.actor_kind', 'api', true);
 PERFORM set_config('api.key_id', k.id::text, true);
 IF NOT public.has_permission('api.use') THEN RAISE EXCEPTION 'API_MEMBER_NO_API'; END IF;
 IF NOT (p_permission = ANY (k.scopes)) THEN RAISE EXCEPTION 'API_SCOPE_MISSING'; END IF;
 IF NOT public.has_permission(p_permission) THEN RAISE EXCEPTION 'API_MEMBER_PERMISSION_MISSING'; END IF;
 RETURN k;
END $fn$;

-- Once per HTTP request: api_act, then the rate limit (120 a minute per key;
-- a refused call rolls its count back) and last use.
CREATE OR REPLACE FUNCTION public.api_authorize(p_key_hash text, p_permission text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE k public.api_keys; n integer; w timestamptz := date_trunc('minute', now());
BEGIN
 k := public.api_act(p_key_hash, p_permission);
 INSERT INTO public.api_rate_limits AS r (api_key_id, window_start, used) VALUES (k.id, w, 1)
  ON CONFLICT (api_key_id, window_start) DO UPDATE SET used = r.used + 1
  RETURNING r.used INTO n;
 IF n > 120 THEN RAISE EXCEPTION 'API_RATE_LIMITED'; END IF;
 DELETE FROM public.api_rate_limits WHERE api_key_id = k.id AND window_start < w - interval '1 hour';
 UPDATE public.api_keys SET last_used_at = now() WHERE id = k.id;
 RETURN jsonb_build_object('key_id', k.id, 'member_id', k.team_member_id, 'limit', 120,
  'remaining', 120 - n, 'reset_at', w + interval '1 minute');
END $fn$;

-- The books reads the API may make, each as the key's member. The permission
-- is decided here, not by the caller, and anything not listed is refused:
-- no commands, no worker functions, no evidence or settings views, and not
-- bank_review, whose rows carry the provider's raw payload.
CREATE OR REPLACE FUNCTION public.api_accounting(p_key_hash text, p_name text, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE a jsonb := coalesce(p_args, '{}'::jsonb);
BEGIN
 IF p_name IS NULL OR p_name NOT IN ('workspace', 'transactions', 'entry_detail', 'report', 'report_lines', 'ledger', 'revision', 'payees', 'rules') THEN
  RAISE EXCEPTION 'API_OPERATION_NOT_ALLOWED';
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
 END;
END $fn$;

REVOKE ALL ON FUNCTION public.api_keys_guard(), public.api_act(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_authorize(text, text), public.api_accounting(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_authorize(text, text), public.api_accounting(text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Phase 2: agents write to the books as drafts for the owner's review.
-- accounting.draft lets an API key prepare drafts, categorize and split
-- drafts, and create rules (never auto-posting) and payees, through
-- public.api_books_command only. Writes run through accounting.operate as the
-- key's member; require_owner accepts a drafter only inside that call.
-- operate keeps the 'api' actor kind so the audit trail names the key
-- (audit_log.api_key_id defaults from the transaction's api.key_id).
-- ---------------------------------------------------------------------------

ALTER TABLE accounting.audit_log ADD COLUMN IF NOT EXISTS api_key_id uuid DEFAULT (NULLIF(current_setting('api.key_id', true), ''))::uuid;
ALTER TABLE accounting.audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind_check;
ALTER TABLE accounting.audit_log ADD CONSTRAINT audit_log_actor_kind_check CHECK (actor_kind = ANY (ARRAY['owner', 'worker', 'system', 'api']));

CREATE OR REPLACE FUNCTION accounting.require_owner()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND (owner_user_id=actor OR public.has_permission('accounting.manage') OR (current_setting('api.command',true)='drafts' AND accounting.api_key_allows(actor,'accounting.draft')))) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.record_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE b jsonb; a jsonb; payload jsonb; actor uuid:=auth.uid(); op uuid; kind text; identity text; action_name text; money_key text;
BEGIN
 b:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END; a:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='settings' AND TG_OP='UPDATE' AND (b-'financial_revision')=(a-'financial_revision') THEN RETURN NULL; END IF;
 FOR money_key IN SELECT unnest(ARRAY['amount_cents','financial_revision','size_bytes','observed_balance_cents','gross_cents','net_cents','employee_withholding_cents','employer_tax_cents','difference_cents','opening_balance_cents','ending_balance_cents']) LOOP
  IF b?money_key AND b->money_key<>'null'::jsonb THEN b:=jsonb_set(b,ARRAY[money_key],to_jsonb(b->>money_key)); END IF;
  IF a?money_key AND a->money_key<>'null'::jsonb THEN a:=jsonb_set(a,ARRAY[money_key],to_jsonb(a->>money_key)); END IF;
 END LOOP;
 IF TG_TABLE_NAME='bank_connections' THEN
  b:=b-ARRAY['access_url_encrypted','checkpoint','last_error']; a:=a-ARRAY['access_url_encrypted','checkpoint','last_error'];
 END IF;
 IF TG_TABLE_NAME='bank_transactions' THEN b:=b-'raw_payload'; a:=a-'raw_payload'; END IF;
 IF TG_TABLE_NAME='tax_links' THEN b:=b-ARRAY['inputs','results','forecast_inputs']; a:=a-ARRAY['inputs','results','forecast_inputs']; END IF;
 op:=coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid());
 kind:=coalesce(nullif(current_setting('accounting.actor_kind',true),''),CASE WHEN actor IS NULL THEN 'system' ELSE 'owner' END);
 IF kind NOT IN ('owner','api') THEN actor:=NULL; END IF;
 payload:=coalesce(a,b); identity:=coalesce(payload->>'id',payload->>'month',payload->>'idempotency_key','1');
 action_name:=coalesce(nullif(current_setting('accounting.action',true),''),lower(TG_OP));
 INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after,reason)
 VALUES(actor,kind,op,TG_TABLE_NAME,CASE WHEN identity ~ '^[0-9a-f-]{36}$' THEN identity::uuid ELSE md5(TG_TABLE_NAME||':'||identity)::uuid END,action_name,b,a,coalesce(nullif(current_setting('accounting.reason',true),''),payload->>'reason',''));
 IF TG_TABLE_NAME IN ('accounts','journal_entries','journal_lines','tax_mappings','tax_adjustments','payroll_runs','registers') THEN
  UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 END IF;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.operate(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c jsonb:=command->'command'; key uuid:=(command->>'key')::uuid; actor uuid; receipt accounting.command_receipts; hash text; result jsonb; t text; current_version integer; initialized boolean:=false;
BEGIN
 IF key IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM accounting.write_lock();
 t:=c->>'type'; actor:=auth.uid();
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind',CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'api' ELSE 'owner' END,true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t='settings.save' AND NOT EXISTS(SELECT 1 FROM accounting.settings) THEN
  IF actor IS NULL OR (EXISTS(SELECT 1 FROM public.team_members) AND coalesce(public.current_team_member_role(),'')<>'owner') THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO accounting.settings(owner_user_id) VALUES(actor); initialized:=true;
 END IF;
 actor:=accounting.require_owner(); hash:=encode(sha256(convert_to(c::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM accounting.command_receipts WHERE idempotency_key=key;
 IF FOUND THEN
  IF receipt.actor_user_id<>actor OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 IF c?'expected_revision' AND (c->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM accounting.settings WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_REVISION'; END IF;
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind',CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'api' ELSE 'owner' END,true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t IN ('settings.save','preferences.save') THEN
  SELECT version INTO current_version FROM accounting.settings WHERE id=1;
  IF (c->>'expected_version')::integer IS DISTINCT FROM current_version AND NOT (initialized AND coalesce((c->>'expected_version')::integer,0)=0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.settings SET primary_system=coalesce(c->>'primary_system',CASE c->>'authority_mode' WHEN 'admin_primary' THEN 'admin' WHEN 'wave_primary' THEN 'wave' WHEN 'parallel_pilot' THEN 'wave' END,primary_system),
   primary_system_since=CASE WHEN c?'primary_system_since' THEN (c->>'primary_system_since')::date ELSE primary_system_since END,
   transfer_window_days=coalesce((c->>'transfer_window_days')::smallint,transfer_window_days),version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  IF c?'business_profile' THEN
   IF (c->>'profile_version')::integer IS DISTINCT FROM (SELECT version FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(c->'business_profile') k WHERE k NOT IN ('legal_name','dba','entity_type','ein','formation_date','state_of_formation','address','phone','email','tax_classification','tax_classification_since','home_state','is_sstb','fiscal_year_start_month','books_timezone','earliest_history_date','owner_name','owner_title','accountant_name','accountant_email','default_email_account_id')) THEN RAISE EXCEPTION 'ACCT_INVALID_PROFILE'; END IF;
   UPDATE public.business_profile p SET (legal_name,dba,entity_type,ein,formation_date,state_of_formation,address,phone,email,tax_classification,tax_classification_since,home_state,is_sstb,fiscal_year_start_month,books_timezone,earliest_history_date,owner_name,owner_title,accountant_name,accountant_email,default_email_account_id)=
    (SELECT v.legal_name,v.dba,v.entity_type,v.ein,v.formation_date,v.state_of_formation,v.address,v.phone,v.email,v.tax_classification,v.tax_classification_since,v.home_state,v.is_sstb,v.fiscal_year_start_month,v.books_timezone,v.earliest_history_date,v.owner_name,v.owner_title,v.accountant_name,v.accountant_email,v.default_email_account_id FROM jsonb_populate_record(p,c->'business_profile') v) WHERE p.id=1;
  ELSIF c?'legal_name' OR c->>'history_start' IS NOT NULL THEN
   UPDATE public.business_profile SET legal_name=coalesce(c->>'legal_name',legal_name),earliest_history_date=coalesce((c->>'history_start')::date,earliest_history_date) WHERE id=1;
  END IF;
  result:=jsonb_build_object('id',coalesce(c->>'id','1'),'version',current_version);
 ELSIF t='setup.acknowledge' THEN
  IF coalesce(c->>'key','') !~ '^[a-z][a-z0-9-]*(:[a-z0-9]{1,16})?$' OR jsonb_typeof(c->'acknowledged') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  UPDATE accounting.settings SET setup=CASE WHEN (c->>'acknowledged')::boolean THEN setup||jsonb_build_object(c->>'key',jsonb_build_object('at',now(),'by',actor)) ELSE setup-(c->>'key') END,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  result:=jsonb_build_object('id',coalesce(c->>'id',c->>'key'),'version',current_version);
 ELSIF t IN ('entry.restore','payroll.import.undo') THEN result:=accounting.lifecycle_command(c);
 ELSIF t LIKE 'account.%' OR t='chart.seed' OR t LIKE 'entry.%' OR t LIKE 'draft.%' OR t LIKE 'transaction.%' OR t='cash.allocate' THEN result:=accounting.ledger_command(c);
 ELSIF t LIKE 'bank.%' OR t LIKE 'feed.%' OR t LIKE 'transfer.%' OR t LIKE 'party.%' OR t LIKE 'alias.%' OR t LIKE 'rule.%' OR t LIKE 'document.%' THEN result:=accounting.banking_command(c);
 ELSIF t LIKE 'import.%' OR t LIKE 'history.%' THEN result:=accounting.history_command(c);
 ELSIF t LIKE 'period.%' OR t LIKE 'reconciliation.%' THEN result:=accounting.close_command(c);
 ELSIF t LIKE 'payroll.%' OR t LIKE 'register.%' THEN result:=accounting.register_command(c);
 ELSIF t LIKE 'tax.%' THEN result:=accounting.tax_command(c);
 ELSIF t LIKE 'report.%' OR t LIKE 'package.%' THEN result:=accounting.report_command(c);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 INSERT INTO accounting.command_receipts(idempotency_key,payload_hash,actor_user_id,result) VALUES(key,hash,actor,result);
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.payees_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'kind',p.kind,'default_account_id',p.default_account_id,'is_archived',p.is_archived,'version',p.version) ORDER BY lower(p.name),p.id),'[]'::jsonb) FROM accounting.parties p);
END $function$
;

REVOKE ALL ON FUNCTION accounting.payees_list() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.payees_list() TO "postgres";

CREATE OR REPLACE FUNCTION accounting.rules_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'priority',r.priority,'enabled',r.enabled,'auto_post',r.auto_post,'conditions',r.conditions,'actions',r.actions,'version',r.version) ORDER BY r.priority,r.name,r.id),'[]'::jsonb) FROM accounting.rules r);
END $function$
;

REVOKE ALL ON FUNCTION accounting.rules_list() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.rules_list() TO "postgres";

-- Idempotency for API creates: the first answer per key and Idempotency-Key
-- is stored and replayed on a retry, and a different request under the same
-- key is refused. Each claim carries a token, so only the request holding the
-- claim can finish or release it. Rows older than 7 days are cleared as new
-- ones arrive.
CREATE TABLE IF NOT EXISTS public.api_idempotency (
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL,
  claim_token UUID,
  status INTEGER,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, idempotency_key)
);
ALTER TABLE public.api_idempotency ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE public.api_idempotency ENABLE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS public.api_idempotency_finish(text, uuid, integer, jsonb);
DROP FUNCTION IF EXISTS public.api_idempotency_release(text, uuid);
REVOKE ALL ON public.api_idempotency FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_idempotency TO service_role;

CREATE OR REPLACE FUNCTION public.api_idempotency_claim(p_key_hash text, p_idempotency_key uuid, p_request_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE k uuid; r public.api_idempotency; token uuid := gen_random_uuid();
BEGIN
 SELECT id INTO k FROM public.api_keys WHERE key_hash = p_key_hash AND revoked_at IS NULL;
 IF k IS NULL THEN RAISE EXCEPTION 'API_KEY_INVALID'; END IF;
 DELETE FROM public.api_idempotency WHERE api_key_id = k AND created_at < now() - interval '7 days';
 INSERT INTO public.api_idempotency(api_key_id, idempotency_key, request_hash, claim_token) VALUES (k, p_idempotency_key, p_request_hash, token)
  ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN jsonb_build_object('state', 'new', 'token', token); END IF;
 SELECT * INTO r FROM public.api_idempotency WHERE api_key_id = k AND idempotency_key = p_idempotency_key FOR UPDATE;
 IF r.request_hash <> p_request_hash THEN RETURN jsonb_build_object('state', 'conflict'); END IF;
 IF r.status IS NULL THEN
  -- A claim left by a request that died is taken over after 15 minutes, far
  -- past any request's run time, so two requests never run for one key.
  IF r.created_at < now() - interval '15 minutes' THEN
   UPDATE public.api_idempotency SET created_at = now(), claim_token = token WHERE api_key_id = k AND idempotency_key = p_idempotency_key;
   RETURN jsonb_build_object('state', 'new', 'token', token);
  END IF;
  RETURN jsonb_build_object('state', 'busy');
 END IF;
 RETURN jsonb_build_object('state', 'replay', 'status', r.status, 'response', r.response);
END $fn$;

CREATE OR REPLACE FUNCTION public.api_idempotency_finish(p_key_hash text, p_idempotency_key uuid, p_token uuid, p_status integer, p_response jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
 UPDATE public.api_idempotency i SET status = p_status, response = p_response
 FROM public.api_keys k
 WHERE k.key_hash = p_key_hash AND i.api_key_id = k.id AND i.idempotency_key = p_idempotency_key AND i.claim_token = p_token;
END $fn$;

CREATE OR REPLACE FUNCTION public.api_idempotency_release(p_key_hash text, p_idempotency_key uuid, p_token uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
 DELETE FROM public.api_idempotency i USING public.api_keys k
 WHERE k.key_hash = p_key_hash AND i.api_key_id = k.id AND i.idempotency_key = p_idempotency_key
  AND i.status IS NULL AND i.claim_token = p_token;
END $fn$;

-- References an agent may make: a live payee, and an open account of the
-- right kind. Categories are any account that is not bank, card or cash;
-- bank accounts are exactly those.
CREATE OR REPLACE FUNCTION public.api_books_ref(p_kind text, p_id text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v uuid;
BEGIN
 IF p_id IS NULL THEN RETURN NULL; END IF;
 BEGIN
  v := p_id::uuid;
 EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'API_INVALID_INPUT';
 END;
 IF p_kind = 'payee' AND NOT EXISTS (SELECT 1 FROM accounting.parties WHERE id = v AND NOT is_archived) THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
 IF p_kind = 'category' AND NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = v AND NOT is_archived AND subtype NOT IN ('bank', 'card', 'cash')) THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
 IF p_kind = 'bank' AND NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = v AND NOT is_archived AND subtype IN ('bank', 'card', 'cash')) THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
 RETURN v;
END $fn$;

-- Books writes from the API, drafts only. Each operation builds its command
-- from scratch (nothing the caller sends is forwarded as is) and runs it
-- through accounting.operate as the key's member, so every books rule,
-- version check and receipt applies. Rules made here are always disabled:
-- the owner switches them on, so an agent cannot steer imports or outrank the
-- owner's rules. Then, independently of the allowlist, the command's own
-- audit rows are checked: if anything left draft, a posted entry changed, a
-- rule could auto-post or run, a period left open, or an existing rule or
-- payee was changed, the whole command rolls back with API_DRAFTS_ONLY.
CREATE OR REPLACE FUNCTION public.api_books_command(p_key_hash text, p_operation text, p_key uuid, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
 a jsonb := coalesce(p_args, '{}'::jsonb);
 kinds text[] := ARRAY['manual', 'income', 'expense', 'refund', 'owner', 'loan', 'asset'];
 keys uuid[] := ARRAY[]::uuid[];
 cmd jsonb; result jsonb; results jsonb := '[]'::jsonb; item jsonb; i integer := 0; k uuid; bad text;
 current_status text; current_kind text; current_payee uuid;
 lines jsonb; splits jsonb; conditions jsonb; actions jsonb; matcher text;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN ('draft.create', 'draft.update', 'categorize', 'split', 'categorize.bulk', 'rule.create', 'payee.create') THEN
  RAISE EXCEPTION 'API_COMMAND_NOT_ALLOWED';
 END IF;
 IF p_key IS NULL THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
 PERFORM public.api_act(p_key_hash, 'accounting.draft');
 PERFORM set_config('api.command', 'drafts', true);
 IF a ? 'lines' THEN
  SELECT jsonb_agg(jsonb_build_object('account_id', l->>'account_id', 'amount_cents', l->>'amount_cents', 'memo', coalesce(l->>'memo', '')) ORDER BY n)
   INTO lines FROM jsonb_array_elements(a->'lines') WITH ORDINALITY AS t(l, n);
 END IF;

 IF p_operation IN ('draft.create', 'draft.update') THEN
  IF a ? 'kind' AND jsonb_typeof(a->'kind') <> 'null' AND NOT ((a->>'kind') = ANY (kinds)) THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  IF p_operation = 'draft.update' THEN
   SELECT status, kind, payee_id INTO current_status, current_kind, current_payee FROM accounting.journal_entries WHERE id = (a->>'id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF current_status <> 'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
  END IF;
  -- An update keeps the kind and payee the caller leaves out.
  cmd := jsonb_build_object('type', 'draft.save',
   'id', CASE WHEN p_operation = 'draft.create' THEN md5('draft:' || p_key::text)::uuid ELSE (a->>'id')::uuid END,
   'expected_version', CASE WHEN p_operation = 'draft.create' THEN 0 ELSE (a->>'expected_version')::integer END,
   'entry_date', a->>'entry_date', 'memo', a->>'memo', 'lines', coalesce(lines, '[]'::jsonb),
   'kind', CASE WHEN a ? 'kind' AND jsonb_typeof(a->'kind') <> 'null' THEN a->>'kind' ELSE coalesce(current_kind, 'manual') END,
   'payee_id', CASE WHEN a ? 'payee_id' THEN a->'payee_id' ELSE to_jsonb(current_payee) END);
  IF p_operation = 'draft.create' THEN cmd := cmd || jsonb_build_object('origin', 'manual'); END IF;
 ELSIF p_operation = 'categorize' THEN
  PERFORM public.api_books_ref('category', a->>'account_id');
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.categorize', 'id', (a->>'id')::uuid,
   'expected_version', (a->>'expected_version')::integer, 'account_id', (a->>'account_id')::uuid,
   'payee_id', a->'payee_id', 'memo', a->'memo')) || jsonb_build_object('remember', false);
 ELSIF p_operation = 'split' THEN
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('account_id', public.api_books_ref('category', s->>'account_id'),
    'amount_cents', s->'amount_cents', 'share_bps', s->'share_bps')) ORDER BY n)
   INTO splits FROM jsonb_array_elements(a->'splits') WITH ORDINALITY AS t(s, n);
  cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.split', 'id', (a->>'id')::uuid,
   'expected_version', (a->>'expected_version')::integer, 'splits', splits, 'payee_id', a->'payee_id', 'memo', a->'memo'));
 ELSIF p_operation = 'rule.create' THEN
  -- Conditions and actions are rebuilt from the allowed fields, and every
  -- account and payee they name must exist and fit.
  IF jsonb_typeof(a->'conditions') <> 'object' OR jsonb_typeof(a->'actions') <> 'object'
     OR jsonb_typeof(a->'conditions'->'descriptor_key') <> 'object' THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  SELECT key INTO matcher FROM jsonb_object_keys(a->'conditions'->'descriptor_key') AS key LIMIT 1;
  IF matcher IS NULL OR matcher NOT IN ('equals', 'prefix', 'contains')
     OR (SELECT count(*) FROM jsonb_object_keys(a->'conditions'->'descriptor_key')) <> 1
     OR length(btrim(coalesce(a->'conditions'->'descriptor_key'->>matcher, ''))) = 0 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  conditions := jsonb_strip_nulls(jsonb_build_object(
   'descriptor_key', jsonb_build_object(matcher, btrim(a->'conditions'->'descriptor_key'->>matcher)),
   'bank_account_id', public.api_books_ref('bank', a->'conditions'->>'bank_account_id'),
   'direction', a->'conditions'->>'direction',
   'amount_min', a->'conditions'->>'amount_min',
   'amount_max', a->'conditions'->>'amount_max',
   'payee_id', public.api_books_ref('payee', a->'conditions'->>'payee_id')));
  IF a->'actions' ? 'splits' THEN
   SELECT jsonb_agg(jsonb_build_object('account_id', public.api_books_ref('category', s->>'account_id'), 'share_bps', (s->>'share_bps')::integer) ORDER BY n)
    INTO splits FROM jsonb_array_elements(a->'actions'->'splits') WITH ORDINALITY AS t(s, n);
   actions := jsonb_build_object('splits', coalesce(splits, '[]'::jsonb));
  ELSE
   actions := jsonb_build_object('account_id', public.api_books_ref('category', a->'actions'->>'account_id'));
  END IF;
  actions := actions || jsonb_strip_nulls(jsonb_build_object(
   'payee_id', public.api_books_ref('payee', a->'actions'->>'payee_id'), 'memo', a->'actions'->>'memo'));
  cmd := jsonb_build_object('type', 'rule.save', 'id', md5('rule:' || p_key::text)::uuid, 'expected_version', 0,
   'reason', coalesce(nullif(a->>'reason', ''), 'Created through the API'), 'name', a->>'name',
   'priority', coalesce((a->>'priority')::integer, 100), 'enabled', false,
   'auto_post', false, 'conditions', conditions, 'actions', actions);
 ELSIF p_operation = 'payee.create' THEN
  cmd := jsonb_build_object('type', 'party.save', 'id', md5('payee:' || p_key::text)::uuid, 'expected_version', 0,
   'name', a->>'name', 'kind', a->>'kind', 'default_account_id', public.api_books_ref('category', a->>'default_account_id'),
   'notes', coalesce(a->>'notes', ''), 'is_contractor', false, 'is_archived', false);
 END IF;

 IF p_operation = 'categorize.bulk' THEN
  IF jsonb_typeof(a->'items') <> 'array' OR jsonb_array_length(a->'items') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(a->'items') LOOP
   i := i + 1;
   k := md5(p_key::text || ':' || i)::uuid;
   keys := array_append(keys, k);
   PERFORM public.api_books_ref('category', item->>'account_id');
   IF item ? 'payee_id' THEN PERFORM public.api_books_ref('payee', item->>'payee_id'); END IF;
   cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.categorize', 'id', (item->>'id')::uuid,
    'expected_version', (item->>'expected_version')::integer, 'account_id', (item->>'account_id')::uuid,
    'payee_id', item->'payee_id')) || jsonb_build_object('remember', false);
   results := results || jsonb_build_array(accounting.operate(jsonb_build_object('key', k, 'command', cmd)));
  END LOOP;
  result := jsonb_build_object('results', results);
 ELSE
  keys := ARRAY[p_key];
  result := accounting.operate(jsonb_build_object('key', p_key, 'command', cmd));
 END IF;

 SELECT string_agg(DISTINCT l.table_name || ':' || l.action, ', ') INTO bad
 FROM accounting.audit_log l
 WHERE l.operation_id = ANY (keys) AND (
  l.table_name NOT IN ('journal_entries', 'journal_lines', 'rules', 'parties', 'command_receipts', 'periods')
  -- A draft in a month with no period row opens one; it must stay open.
  OR (l.table_name = 'periods' AND (coalesce(l.after->>'status', 'open') <> 'open' OR coalesce(l.before->>'status', 'open') <> 'open'))
  OR (l.table_name = 'journal_entries' AND (coalesce(l.after->>'status', 'draft') <> 'draft' OR coalesce(l.before->>'status', 'draft') <> 'draft'))
  OR (l.table_name = 'rules' AND (l.before IS NOT NULL OR coalesce((l.after->>'auto_post')::boolean, false) OR coalesce((l.after->>'enabled')::boolean, false)))
  OR (l.table_name = 'parties' AND l.before IS NOT NULL));
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'API_DRAFTS_ONLY (%)', bad; END IF;
 RETURN result;
END $fn$;

REVOKE ALL ON FUNCTION public.api_books_ref(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_idempotency_claim(text, uuid, text), public.api_idempotency_finish(text, uuid, uuid, integer, jsonb), public.api_idempotency_release(text, uuid, uuid), public.api_books_command(text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_idempotency_claim(text, uuid, text), public.api_idempotency_finish(text, uuid, uuid, integer, jsonb), public.api_idempotency_release(text, uuid, uuid), public.api_books_command(text, text, uuid, jsonb) TO service_role;
