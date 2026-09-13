-- Manage cleanup: the transfers read serves one group by id with a caller-chosen page size,
-- the tax workpaper history returns the versions of one row in the shape the dialog renders,
-- and a receipt can be detached from a transaction again (the only delete the link guard allows).
BEGIN;

CREATE OR REPLACE FUNCTION accounting.context(view text, params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  scoped AS(SELECT * FROM grouped WHERE CASE WHEN context.params->>'id' IS NOT NULL THEN id=(context.params->>'id')::uuid ELSE outgoing_date<=(context.params->>'to')::date AND incoming_date>=(context.params->>'from')::date END),
  paged AS(SELECT * FROM scoped ORDER BY outgoing_date DESC,id LIMIT least(greatest(coalesce((context.params->>'limit')::int,100),1),200) OFFSET coalesce((context.params->>'offset')::int,0))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',(SELECT count(*) FROM scoped),'groups',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY outgoing_date DESC,id),'[]') FROM paged p)) INTO result;RETURN result;
 ELSIF view='tax-history' THEN
  WITH scoped AS (SELECT a.id,a.at,a.reason,a.after FROM accounting.audit_log a
   WHERE a.table_name=CASE context.params->>'kind' WHEN 'mapping' THEN 'tax_mappings' WHEN 'adjustment' THEN 'tax_adjustments' WHEN 'basis' THEN 'tax_links' ELSE 'tax_mappings' END
    AND a.after IS NOT NULL
    AND (context.params->>'year' IS NULL OR (a.after->>'tax_year')::integer=(context.params->>'year')::integer)
    AND (context.params->>'key' IS NULL OR a.row_id=(context.params->>'key')::uuid OR a.after->>'account_id'=context.params->>'key' OR a.after->>'id'=context.params->>'key'))
  SELECT jsonb_build_object('count',(SELECT count(*) FROM scoped),'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',coalesce((s.after->>'version')::integer,1),'created_at',s.at,
    'reason',coalesce(nullif(s.reason,''),s.after->>'reason',s.after->>'notes',''),'concept',s.after->>'concept','amount_cents',s.after->>'amount_cents','effective_date',s.after->>'effective_date',
    'deductible_bps',(s.after->>'deductible_bps')::integer,'through_date',s.after->>'cutoff_date','document_id',s.after->>'document_id') ORDER BY s.at DESC),'[]')
   FROM (SELECT * FROM scoped ORDER BY at DESC LIMIT 50 OFFSET coalesce((context.params->>'offset')::integer,0)) s)) INTO result;RETURN result;
 END IF;
 RAISE EXCEPTION 'ACCT_INVALID_VIEW';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.contractor_report(year integer, cutoff date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE threshold bigint;result jsonb;through_date date:=coalesce(cutoff,make_date(year,12,31));
BEGIN
 PERFORM accounting.require_owner();
 IF extract(year FROM through_date)<>year THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 IF year BETWEEN 2022 AND 2025 THEN threshold:=60000;ELSIF year=2026 THEN threshold:=200000;ELSE RAISE EXCEPTION 'ACCT_CONTRACTOR_YEAR_RULE_REQUIRED';END IF;
 SELECT jsonb_build_object('year',year,'through',through_date,'revision',(SELECT financial_revision::text FROM accounting.settings),'threshold_cents',threshold::text,
  'rows',coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'contractor_classification',contractor_classification,'documentation_status',documentation_status,'paid_cents',paid::text,'card_cents',card::text,'meets_threshold',paid>=threshold) ORDER BY name,id),'[]')) INTO result FROM (
 SELECT p.id,p.name,p.contractor_classification,p.documentation_status,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash')),0) paid,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype='card'),0) card
 FROM accounting.parties p LEFT JOIN accounting.journal_entries e ON e.payee_id=p.id AND e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND through_date
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE p.is_contractor GROUP BY p.id) rows;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.descriptor_key(value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v text := upper(value);
BEGIN
 IF v IS NULL THEN RETURN NULL; END IF;
 v:=regexp_replace(v,'\*[[:space:]]*[0-9].*$','','g');
 v:=regexp_replace(v,'\m[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}\M',' ','g');
 v:=regexp_replace(v,'\m(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUN(E)?|JUL(Y)?|AUG(UST)?|SEP(TEMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)[[:space:]]+[0-9]{1,2}(,?[[:space:]]+[0-9]{4})?\M',' ','g');
 v:=regexp_replace(v,'\m[0-9]{1,2}[[:space:]]+(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUN(E)?|JUL(Y)?|AUG(UST)?|SEP(TEMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)([[:space:]]+[0-9]{4})?\M',' ','g');
 v:=regexp_replace(v,'#[[:space:]]*[0-9]+|[0-9]{4,}',' ','g');
 v:=regexp_replace(v,'\m(POS|DEBIT|CREDIT|PURCHASE|PAYMENT|CARD|ACH|RECURRING)\M',' ','g');
 RETURN btrim(regexp_replace(v,'[[:space:]]+',' ','g'));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.document_access(path text, uploading boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT EXISTS(SELECT 1 FROM accounting.settings WHERE owner_user_id=auth.uid()) AND EXISTS(SELECT 1 FROM accounting.documents WHERE storage_path=path AND status<>'archived') AND (NOT uploading OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=path))
$function$
;

CREATE OR REPLACE FUNCTION accounting.banking_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
<<banking_command>>
DECLARE t text:=c->>'type'; key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 v integer; current_version integer; candidate_count integer; x jsonb; result jsonb; candidate jsonb; observation accounting.bank_transactions; doc accounting.documents; item accounting.journal_lines; existing jsonb;
 cond jsonb; actions jsonb; mapping_connection uuid; mapping_details jsonb; mapped_row accounting.bank_accounts; account uuid; transit uuid; outgoing jsonb; incoming jsonb; out_id uuid; in_id uuid; amount bigint; match_amount bigint; out_date date; in_date date;
BEGIN
 IF t='party.save' THEN
  SELECT version INTO current_version FROM accounting.parties WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  INSERT INTO accounting.parties(id,name,kind,default_account_id,is_contractor,contractor_classification,documentation_status,notes,is_archived)
  VALUES(key,c->>'name',c->>'kind',(c->>'default_account_id')::uuid,coalesce((c->>'is_contractor')::boolean,false),
   CASE WHEN coalesce(c->>'contractor_classification',c->>'tax_classification','unknown')='unreviewed' THEN 'unknown' WHEN c->>'tax_classification'='partnership' THEN 'other' ELSE coalesce(c->>'contractor_classification',c->>'tax_classification','unknown') END,
   CASE WHEN c->>'documentation'='requested' THEN 'missing' ELSE coalesce(c->>'documentation_status',c->>'documentation','missing') END,coalesce(c->>'notes',''),coalesce((c->>'is_archived')::boolean,false))
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,default_account_id=excluded.default_account_id,is_contractor=excluded.is_contractor,contractor_classification=excluded.contractor_classification,documentation_status=excluded.documentation_status,notes=excluded.notes,is_archived=excluded.is_archived RETURNING version INTO v;
 ELSIF t='alias.save' THEN
  SELECT version INTO current_version FROM accounting.payee_aliases WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) AND c?'expected_version' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  INSERT INTO accounting.payee_aliases(id,party_id,match_kind,pattern,enabled,created_by)
  VALUES(key,(c->>'party_id')::uuid,coalesce(c->>'match_kind',c->>'match_mode','key'),coalesce(c->>'pattern',c->>'description'),coalesce((c->>'enabled')::boolean,true),actor)
  ON CONFLICT(id) DO UPDATE SET party_id=excluded.party_id,match_kind=excluded.match_kind,pattern=excluded.pattern,enabled=excluded.enabled RETURNING id,version INTO key,v;
 ELSIF t IN ('rule.save','rule.activate') THEN
  SELECT version INTO current_version FROM accounting.rules WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='rule.activate' THEN
   UPDATE accounting.rules SET enabled=(c->>'enabled')::boolean WHERE id=key RETURNING version INTO v;
  ELSE
   cond:=coalesce(c->'conditions',jsonb_strip_nulls(jsonb_build_object('description_mode',c->'description_mode','description',c->'description','bank_account_id',c->'bank_account_id','direction',c->'direction','amount_min',c->'min_cents','amount_max',c->'max_cents','payee_id',c->'match_payee_id')));
   actions:=coalesce(c->'actions',jsonb_strip_nulls(jsonb_build_object('account_id',c->'category_account_id','payee_id',c->'assign_payee_id')));
   IF EXISTS(SELECT 1 FROM jsonb_each(cond) v WHERE v.key IN ('amount_min','amount_max') AND (jsonb_typeof(value)<>'string' OR (value#>>'{}')!~'^[0-9]+$')) THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   IF NOT(actions?'account_id' OR actions?'splits') OR (cond->>'amount_min')::numeric>(cond->>'amount_max')::numeric THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
   IF actions?'account_id' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(actions->>'account_id')::uuid AND NOT is_archived AND subtype NOT IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_INVALID_RULE_ACCOUNT'; END IF;
   IF actions?'splits' THEN
    IF jsonb_typeof(actions->'splits') IS DISTINCT FROM 'array' OR jsonb_array_length(actions->'splits')<2 THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(actions->'splits') s WHERE (s->>'share_bps') IS NULL OR (s->>'share_bps')!~'^[0-9]+$' OR (s->>'share_bps')::integer NOT BETWEEN 1 AND 9999
      OR NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(s->>'account_id')::uuid AND NOT is_archived AND subtype NOT IN ('bank','card','cash')))
      OR (SELECT sum((s->>'share_bps')::integer) FROM jsonb_array_elements(actions->'splits') s)<>10000 THEN RAISE EXCEPTION 'ACCT_INVALID_RULE'; END IF;
   END IF;
   INSERT INTO accounting.rules(id,name,priority,enabled,conditions,actions,auto_post) VALUES(key,c->>'name',coalesce((c->>'priority')::integer,100),coalesce((c->>'enabled')::boolean,false),cond,actions,coalesce((c->>'auto_post')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,conditions=excluded.conditions,actions=excluded.actions,enabled=excluded.enabled,auto_post=excluded.auto_post RETURNING version INTO v;
  END IF;
 ELSIF t IN ('rule.apply','rule.apply_preview') THEN
  result:='[]';
  FOR x IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
   candidate:=accounting.rule_candidate((x->>'id')::uuid);
   IF t='rule.apply' AND (candidate IS NULL OR NOT (candidate->>'eligible')::boolean) THEN RAISE EXCEPTION 'ACCT_RULE_INELIGIBLE'; END IF;
   IF candidate IS NULL THEN CONTINUE; END IF;
   IF t='rule.apply' THEN
    IF (candidate->>'entry_version')::integer IS DISTINCT FROM (x->>'expected_version')::integer OR (candidate->>'rule_version')::integer IS DISTINCT FROM (x->>'rule_version')::integer OR candidate->>'rule_id' IS DISTINCT FROM x->>'rule_id' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    result:=result||jsonb_build_array(accounting.apply_treatment((x->>'id')::uuid));
   ELSE result:=result||jsonb_build_array(candidate); END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'entries',result,'count',jsonb_array_length(result));
 ELSIF t='document.prepare' THEN
  INSERT INTO accounting.documents(id,storage_path,name,mime,size_bytes,sha256,kind,uploaded_by)
   VALUES(key,key::text||'/'||coalesce(c->>'sha256',c->>'content_hash'),coalesce(c->>'name',c->>'original_name'),coalesce(c->>'mime',c->>'mime_type'),(c->>'size_bytes')::bigint,coalesce(c->>'sha256',c->>'content_hash'),coalesce(c->>'kind','receipt'),actor) RETURNING version INTO v;
  RETURN jsonb_build_object('id',key,'version',v,'storage_path',key::text||'/'||coalesce(c->>'sha256',c->>'content_hash'));
 ELSIF t IN ('document.complete','document.link','document.archive','document.unlink') THEN
  SELECT * INTO doc FROM accounting.documents WHERE id=coalesce((c->>'document_id')::uuid,key);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t NOT IN ('document.archive','document.unlink') AND NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=doc.storage_path) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF t='document.link' THEN
   INSERT INTO accounting.document_links(document_id,entry_id,bank_transaction_id,import_batch_id,reconciliation_id,payroll_run_id,register_id,party_id,created_by)
   VALUES(doc.id,(c->>'entry_id')::uuid,(c->>'bank_transaction_id')::uuid,(c->>'import_batch_id')::uuid,(c->>'reconciliation_id')::uuid,(c->>'payroll_run_id')::uuid,(c->>'register_id')::uuid,(c->>'party_id')::uuid,actor) ON CONFLICT DO NOTHING;
  END IF;
  IF t IN ('document.archive','document.unlink') AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF t='document.unlink' THEN
   PERFORM set_config('accounting.action','document.unlink',true);
   DELETE FROM accounting.document_links WHERE document_id=doc.id AND entry_id=(c->>'entry_id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  END IF;
  UPDATE accounting.documents SET status=CASE t WHEN 'document.archive' THEN 'archived' WHEN 'document.link' THEN 'linked' WHEN 'document.unlink' THEN CASE WHEN EXISTS(SELECT 1 FROM accounting.document_links WHERE document_id=doc.id) THEN status ELSE 'inbox' END ELSE status END WHERE id=doc.id RETURNING version INTO v;
  key:=doc.id;
 ELSIF t='feed.claim' THEN
  IF c->>'claim_id' IS NOT NULL AND c->>'access_url_encrypted' IS NULL THEN
   INSERT INTO accounting.bank_connections(id,name,status,access_url_encrypted,checkpoint)
    VALUES(key,c->>'name','reconnect_required','',jsonb_build_object('claim',jsonb_build_object('id',c->>'claim_id','state','prepared'))) RETURNING version INTO v;
  ELSE
   IF length(coalesce(c->>'access_url_encrypted',''))<20 THEN RAISE EXCEPTION 'ACCT_ENCRYPTED_ACCESS_REQUIRED'; END IF;
   INSERT INTO accounting.bank_connections(id,name,access_url_encrypted,key_version) VALUES(key,c->>'name',c->>'access_url_encrypted',coalesce((c->>'key_version')::smallint,1)) RETURNING version INTO v;
  END IF;
 ELSIF t IN ('feed.disconnect','feed.schedule','bank.sync_request') THEN
  SELECT version INTO current_version FROM accounting.bank_connections WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF t<>'bank.sync_request' AND (c->>'expected_version')::integer IS DISTINCT FROM current_version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='feed.disconnect' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  UPDATE accounting.bank_connections SET status=CASE WHEN t='feed.disconnect' THEN 'disconnected' ELSE status END,
   scheduled=CASE WHEN t='feed.disconnect' THEN false WHEN t='feed.schedule' THEN (c->>'enabled')::boolean ELSE scheduled END,
   next_sync_at=CASE WHEN t='bank.sync_request' THEN now() ELSE next_sync_at END,
   lease_run_id=CASE WHEN t='feed.disconnect' THEN NULL ELSE lease_run_id END,lease_until=CASE WHEN t='feed.disconnect' THEN NULL ELSE lease_until END
   WHERE id=key RETURNING version INTO v;
 ELSIF t='feed.map' THEN
  IF c->>'connection_id' IS NULL THEN
   SELECT b.id,d.value INTO mapping_connection,mapping_details FROM accounting.bank_connections b CROSS JOIN LATERAL jsonb_each(coalesce(b.checkpoint->'discovery','{}')) d WHERE d.key=banking_command.key::text;
   IF FOUND THEN c:=c||jsonb_build_object('connection_id',mapping_connection,'provider_account_id',mapping_details->>'provider_account_id','institution',mapping_details->>'institution'); END IF;
  END IF;
  SELECT version INTO current_version FROM accounting.bank_accounts WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF coalesce(c->>'ownership','company')<>'company' THEN
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['discovery',key::text,'ownership'],c->'ownership',true) WHERE id=(c->>'connection_id')::uuid;
   RETURN jsonb_build_object('id',key,'version',coalesce(current_version,0));
  END IF;
  INSERT INTO accounting.bank_accounts(id,account_id,connection_id,provider_account_id,institution,mask,movement_sign,coverage_from)
  VALUES(key,(c->>'account_id')::uuid,(c->>'connection_id')::uuid,c->>'provider_account_id',coalesce(c->>'institution',''),coalesce(c->>'mask',''),coalesce((c->>'movement_sign')::smallint,1),coalesce((c->>'coverage_from')::date,(to_timestamp((c->>'history_start')::bigint) AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date))
  ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,connection_id=coalesce(excluded.connection_id,accounting.bank_accounts.connection_id),provider_account_id=coalesce(excluded.provider_account_id,accounting.bank_accounts.provider_account_id),movement_sign=excluded.movement_sign,coverage_from=excluded.coverage_from RETURNING version INTO v;
  IF c?'balance_sign' AND c->>'connection_id' IS NOT NULL THEN
   IF (c->>'balance_sign')::integer NOT IN (-1,1) THEN RAISE EXCEPTION 'ACCT_INVALID_BALANCE_SIGN'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=key) AND (c->>'balance_sign')::smallint IS DISTINCT FROM
     coalesce((SELECT (checkpoint->'balance_signs'->>key::text)::smallint FROM accounting.bank_connections WHERE id=(c->>'connection_id')::uuid),1)
     THEN RAISE EXCEPTION 'ACCT_BANK_MAPPING_FROZEN'; END IF;
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY['balance_signs'],coalesce(checkpoint->'balance_signs','{}')||jsonb_build_object(key::text,(c->>'balance_sign')::smallint)) WHERE id=(c->>'connection_id')::uuid;
  END IF;
 ELSIF t='feed.skip' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  SELECT * INTO mapped_row FROM accounting.bank_accounts WHERE id=key;
  IF NOT FOUND OR mapped_row.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,ARRAY[mapped_row.provider_account_id],to_jsonb(c->>'through')) WHERE id=mapped_row.connection_id;
  UPDATE accounting.bank_accounts SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t='feed.prepare' THEN RETURN jsonb_build_object('id',key,'prepared',0,'count',0);
 ELSIF t='bank.exclude' THEN
  UPDATE accounting.bank_transactions SET review=CASE WHEN coalesce((c->>'excluded')::boolean,true) THEN 'excluded' ELSE 'unmatched' END,excluded_reason=coalesce(c->>'reason','') WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.release' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  DELETE FROM accounting.bank_matches WHERE id=(c->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.match' THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=coalesce(c->>'bank_transaction_id',c->>'group_id',c->>'id')::uuid;
  IF NOT FOUND AND c->>'group_id' IS NOT NULL THEN
   SELECT o.* INTO observation FROM accounting.import_rows r JOIN accounting.bank_accounts b ON b.account_id=(r.parsed->>'bank_account_id')::uuid JOIN accounting.bank_transactions o ON o.bank_account_id=b.id AND o.external_id=r.external_id WHERE r.id=(c->>'group_id')::uuid;
  END IF;
  IF observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(c->'discard_drafts','[]')) LOOP
   PERFORM accounting.ledger_command(x||jsonb_build_object('type','draft.discard','reason',c->>'reason'));
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(c->'allocations',jsonb_build_array(jsonb_build_object('line_id',c->'journal_line_id','amount_cents',c->'amount_cents')))) LOOP
   INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,(x->>'line_id')::uuid,(x->>'amount_cents')::bigint,actor);
  END LOOP;
 ELSIF t='transfer.create' THEN
  amount:=(c->>'amount_cents')::bigint;out_date:=(c->>'outgoing_date')::date;in_date:=(c->>'incoming_date')::date;
  IF amount<=0 OR c->>'from_account_id'=c->>'to_account_id' OR (SELECT count(*) FROM accounting.accounts WHERE id IN ((c->>'from_account_id')::uuid,(c->>'to_account_id')::uuid) AND subtype IN ('bank','cash','card'))<>2 THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  outgoing:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',out_date,'memo',c->'memo','kind','transfer','lines',jsonb_build_array(jsonb_build_object('account_id',c->'from_account_id','amount_cents',(-amount)::text),jsonb_build_object('account_id',CASE WHEN out_date=in_date THEN (c->>'to_account_id')::uuid ELSE transit END,'amount_cents',amount::text))));
  out_id:=(outgoing->>'id')::uuid;
  UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=out_id RETURNING version INTO v;
  outgoing:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',out_id,'expected_version',v));
  in_id:=out_id;
  IF out_date<>in_date THEN
   incoming:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',in_date,'memo',c->'memo','kind','transfer','lines',jsonb_build_array(jsonb_build_object('account_id',transit,'amount_cents',(-amount)::text),jsonb_build_object('account_id',c->'to_account_id','amount_cents',amount::text))));
   in_id:=(incoming->>'id')::uuid;
   UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=in_id RETURNING version INTO v;
   incoming:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',in_id,'expected_version',v));
  END IF;
  -- Explicit creation of a transfer consumes only unambiguous matching bank evidence.
  FOR item IN SELECT l.* FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id IN(out_id,in_id) AND a.subtype IN ('bank','cash','card') LOOP
   SELECT count(*) INTO candidate_count FROM accounting.bank_transactions o JOIN accounting.bank_accounts b ON b.id=o.bank_account_id
    WHERE b.account_id=item.account_id AND o.amount_cents=item.amount_cents AND o.state='posted' AND o.review<>'excluded'
      AND o.posted_date=(SELECT entry_date FROM accounting.journal_entries WHERE id=item.entry_id)
      AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND (e.status<>'draft' OR e.origin NOT IN ('simplefin','csv')));
   IF candidate_count=1 THEN
    SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts b ON b.id=o.bank_account_id
     WHERE b.account_id=item.account_id AND o.amount_cents=item.amount_cents AND o.state='posted' AND o.review<>'excluded'
       AND o.posted_date=(SELECT entry_date FROM accounting.journal_entries WHERE id=item.entry_id)
       AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND (e.status<>'draft' OR e.origin NOT IN ('simplefin','csv')));
    FOR existing IN SELECT DISTINCT jsonb_build_object('id',e.id,'version',e.version) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=observation.id LOOP
     PERFORM set_config('accounting.reason','Replaced by owner-created transfer',true);
     PERFORM accounting.ledger_command(jsonb_build_object('type','draft.discard','id',existing->'id','expected_version',existing->'version','reason','Replaced by owner-created transfer'));
    END LOOP;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,item.id,abs(item.amount_cents),actor);
   END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'version',1,'outgoing_entry_id',out_id,'incoming_entry_id',in_id);
 ELSIF t='transfer.link' THEN
  out_id:=(c->>'outgoing_entry_id')::uuid;in_id:=(c->>'incoming_entry_id')::uuid;amount:=(c->>'amount_cents')::bigint;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  IF amount<=0 OR c->>'from_account_id'=c->>'to_account_id' THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=out_id AND status='posted' AND transfer_group_id IS NULL)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=in_id AND status='posted' AND transfer_group_id IS NULL) THEN RAISE EXCEPTION 'ACCT_TRANSFER_ALREADY_LINKED_OR_UNPOSTED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=out_id AND account_id=(c->>'from_account_id')::uuid AND amount_cents=-amount)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=in_id AND account_id=(c->>'to_account_id')::uuid AND amount_cents=amount) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF out_id<>in_id AND (NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=out_id AND account_id=transit AND amount_cents=amount)
   OR NOT EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=in_id AND account_id=transit AND amount_cents=-amount)) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  IF EXISTS(SELECT entry_id FROM accounting.journal_lines WHERE entry_id IN (out_id,in_id) GROUP BY entry_id HAVING count(*)<>2) THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id IN(out_id,in_id);
  RETURN jsonb_build_object('id',key,'outgoing_entry_id',out_id,'incoming_entry_id',in_id);
 ELSIF t='transfer.reverse' THEN
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE transfer_group_id=key AND reverses_entry_id IS NULL) THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT to_jsonb(e) FROM accounting.journal_entries e WHERE transfer_group_id=key AND reverses_entry_id IS NULL ORDER BY entry_date,id LOOP
   PERFORM accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',x->'id','expected_version',x->'version','entry_date',CASE WHEN EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=(x->>'id')::uuid AND amount_cents<0 AND account_id<>(SELECT id FROM accounting.accounts WHERE system_purpose='transfers_in_transit')) THEN c->>'outgoing_date' ELSE c->>'incoming_date' END,'reason',c->'reason'));
  END LOOP;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.banking_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE observation accounting.bank_transactions; line accounting.journal_lines; movement accounting.bank_accounts; total numeric; capacity numeric; new_review text;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME NOT IN ('journal_lines','journal_entries') THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='INSERT' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.id=NEW.reverses_entry_id AND e.transfer_group_id IS NOT NULL AND (SELECT count(*) FROM accounting.journal_entries g WHERE g.transfer_group_id=e.transfer_group_id AND g.reverses_entry_id IS NULL)>1)
    AND current_setting('accounting.action',true)<>'transfer.reverse' THEN RAISE EXCEPTION 'ACCT_TRANSFER_REVERSE_TOGETHER'; END IF;
  IF TG_OP='UPDATE' AND NEW.entry_date<>OLD.entry_date AND OLD.origin IN ('simplefin','csv') AND EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
   IF (NEW.account_id,NEW.amount_cents,NEW.entry_id) IS DISTINCT FROM (OLD.account_id,OLD.amount_cents,OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='bank_transactions' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','review','excluded_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','review','excluded_reason']) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND OLD.state='posted' AND NEW.state<>'posted' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='INSERT' THEN NEW.descriptor_key:=coalesce(accounting.descriptor_key(NEW.description),''); END IF;
  IF NEW.review='excluded' AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_MATCH_EXISTS'; END IF;
 ELSIF TG_TABLE_NAME='bank_matches' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'ACCT_MATCH_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN
   IF btrim(coalesce(current_setting('accounting.reason',true),''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF OLD.amount_cents>0 AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.journal_line_id AND amount_cents=0) THEN RAISE EXCEPTION 'ACCT_RELEASE_CORROBORATION_FIRST'; END IF;
   RETURN OLD;
  END IF;
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=NEW.bank_transaction_id;
  SELECT * INTO line FROM accounting.journal_lines WHERE id=NEW.journal_line_id;
  SELECT * INTO movement FROM accounting.bank_accounts WHERE id=observation.bank_account_id;
  IF observation.state<>'posted' OR observation.review='excluded' OR line.account_id<>movement.account_id OR sign(line.amount_cents)<>sign(observation.amount_cents) THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH'; END IF;
  IF (SELECT status FROM accounting.journal_entries WHERE id=line.entry_id)='discarded' THEN RAISE EXCEPTION 'ACCT_MATCH_DISCARDED'; END IF;
  IF NEW.amount_cents=0 THEN
   -- Additional independent source evidence carries no second financial allocation.
   IF abs(line.amount_cents)<>abs(observation.amount_cents) OR NOT EXISTS(
    SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions other ON other.id=m.bank_transaction_id
    WHERE m.journal_line_id=line.id AND m.amount_cents=abs(line.amount_cents) AND other.source<>observation.source
      AND other.bank_account_id=observation.bank_account_id AND other.amount_cents=observation.amount_cents
      AND abs(other.posted_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
   ) THEN RAISE EXCEPTION 'ACCT_INVALID_CORROBORATION'; END IF;
  END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE bank_transaction_id=observation.id;
  IF total+NEW.amount_cents>abs(observation.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE journal_line_id=line.id;
  IF total+NEW.amount_cents>abs(line.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
 ELSIF TG_TABLE_NAME='bank_accounts' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.account_id,NEW.movement_sign) IS DISTINCT FROM (OLD.account_id,OLD.movement_sign) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_FROZEN'; END IF;
 ELSIF TG_TABLE_NAME='document_links' AND TG_OP='DELETE' AND current_setting('accounting.action',true)='document.unlink' THEN RETURN OLD;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('parties','payee_aliases','bank_accounts','bank_connections','documents','rules') THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.books_package(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.business_profile_get()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ACCT_AUTH_REQUIRED'; END IF;
  RETURN (SELECT to_jsonb(p) FROM public.business_profile p WHERE id=1);
END
$function$
;

CREATE OR REPLACE FUNCTION accounting.banking_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE observation accounting.bank_transactions; line accounting.journal_lines; movement accounting.bank_accounts; total numeric; capacity numeric; new_review text;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME NOT IN ('journal_lines','journal_entries') THEN UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1; END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='INSERT' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.id=NEW.reverses_entry_id AND e.transfer_group_id IS NOT NULL AND (SELECT count(*) FROM accounting.journal_entries g WHERE g.transfer_group_id=e.transfer_group_id AND g.reverses_entry_id IS NULL)>1)
    AND current_setting('accounting.action',true)<>'transfer.reverse' THEN RAISE EXCEPTION 'ACCT_TRANSFER_REVERSE_TOGETHER'; END IF;
  IF TG_OP='UPDATE' AND NEW.entry_date<>OLD.entry_date AND OLD.origin IN ('simplefin','csv') AND EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
   IF (NEW.account_id,NEW.amount_cents,NEW.entry_id) IS DISTINCT FROM (OLD.account_id,OLD.amount_cents,OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='bank_transactions' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','review','excluded_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','review','excluded_reason']) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='UPDATE' AND OLD.state='posted' AND NEW.state<>'posted' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE'; END IF;
  IF TG_OP='INSERT' THEN NEW.descriptor_key:=coalesce(accounting.descriptor_key(NEW.description),''); END IF;
  IF NEW.review='excluded' AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_MATCH_EXISTS'; END IF;
 ELSIF TG_TABLE_NAME='bank_matches' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'ACCT_MATCH_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN
   IF btrim(coalesce(current_setting('accounting.reason',true),''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF OLD.amount_cents>0 AND EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=OLD.journal_line_id AND amount_cents=0) THEN RAISE EXCEPTION 'ACCT_RELEASE_CORROBORATION_FIRST'; END IF;
   RETURN OLD;
  END IF;
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=NEW.bank_transaction_id;
  SELECT * INTO line FROM accounting.journal_lines WHERE id=NEW.journal_line_id;
  SELECT * INTO movement FROM accounting.bank_accounts WHERE id=observation.bank_account_id;
  IF observation.state<>'posted' OR observation.review='excluded' OR line.account_id<>movement.account_id OR sign(line.amount_cents)<>sign(observation.amount_cents) THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH'; END IF;
  IF (SELECT status FROM accounting.journal_entries WHERE id=line.entry_id)='discarded' THEN RAISE EXCEPTION 'ACCT_MATCH_DISCARDED'; END IF;
  IF NEW.amount_cents=0 THEN
   -- Additional independent source evidence carries no second financial allocation.
   IF abs(line.amount_cents)<>abs(observation.amount_cents) OR NOT EXISTS(
    SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions other ON other.id=m.bank_transaction_id
    WHERE m.journal_line_id=line.id AND m.amount_cents=abs(line.amount_cents) AND other.source<>observation.source
      AND other.bank_account_id=observation.bank_account_id AND other.amount_cents=observation.amount_cents
      AND abs(other.posted_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
   ) THEN RAISE EXCEPTION 'ACCT_INVALID_CORROBORATION'; END IF;
  END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE bank_transaction_id=observation.id;
  IF total+NEW.amount_cents>abs(observation.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
  SELECT coalesce(sum(amount_cents),0) INTO total FROM accounting.bank_matches WHERE journal_line_id=line.id;
  IF total+NEW.amount_cents>abs(line.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_MATCH_OVERALLOCATED'; END IF;
 ELSIF TG_TABLE_NAME='bank_accounts' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.account_id,NEW.movement_sign) IS DISTINCT FROM (OLD.account_id,OLD.movement_sign) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=OLD.id) THEN RAISE EXCEPTION 'ACCT_FEED_MAPPING_FROZEN'; END IF;
 ELSIF TG_TABLE_NAME='document_links' AND TG_OP='DELETE' AND current_setting('accounting.action',true)='document.unlink' THEN RETURN OLD;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('parties','payee_aliases','bank_accounts','bank_connections','documents','rules') THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.books_package(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.business_profile_get()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ACCT_AUTH_REQUIRED'; END IF;
  RETURN (SELECT to_jsonb(p) FROM public.business_profile p WHERE id=1);
END
$function$
;

COMMIT;
