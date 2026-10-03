-- Contacts grouped by what they are.
--
-- The Contacts list on the Manage screen is long and flat: most contacts are
-- vendors, and a run of restaurants buries the clients and contractors. The
-- app now groups contacts (clients, contractors, owner and payroll,
-- government, banking, then vendors by what the business buys from them).
-- Roles already say who someone is; for vendors the books also need to say
-- what they are, and the best evidence is where their money went.
--
-- Each contact therefore gains top_category: the account its live entries
-- (drafts and posted, never discarded) moved the most money through, as
-- {id, name}, or null when it has none. Amounts count by absolute value, so
-- a refund adds weight to its category rather than cancelling it. Ties go to
-- the account name. Money accounts (subtypes bank, card and cash), clearing
-- accounts (transit, undeposited) and the uncategorized catch-alls (subtype
-- uncategorized; system purposes uncategorized_income, uncategorized_expense
-- and transfers_in_transit) never count: they say how money moved, not what
-- it bought.
--
-- New: accounting.contact_top_categories(), one aggregate over every
-- contact's entries (journal_entries.payee_id, served by entries_payee),
-- private to the books like contact_name_key.
--
-- Readers restated: context('manage') and payees_list (the API's
-- books.contacts) add top_category to each contact row. No table changes.

BEGIN;

-- 1. Each contact's dominant category, computed in one aggregate over the entries_payee index.
CREATE OR REPLACE FUNCTION accounting.contact_top_categories()
 RETURNS TABLE(party_id uuid, account_id uuid, account_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 -- Each contact's dominant category: the account its live entries (drafts and posted) moved the most money through, by absolute amount.
 -- Money accounts, clearing accounts and the uncategorized catch-alls say nothing about what a contact is, so they never count.
 SELECT DISTINCT ON (t.payee_id) t.payee_id,t.account_id,t.name
 FROM (SELECT e.payee_id,l.account_id,a.name,sum(abs(l.amount_cents)) total
  FROM accounting.journal_entries e
  JOIN accounting.journal_lines l ON l.entry_id=e.id
  JOIN accounting.accounts a ON a.id=l.account_id
  WHERE e.payee_id IS NOT NULL AND e.status<>'discarded'
   AND a.subtype NOT IN ('bank','card','cash','transit','undeposited','uncategorized')
   AND coalesce(a.system_purpose,'') NOT IN ('uncategorized_income','uncategorized_expense','transfers_in_transit')
  GROUP BY e.payee_id,l.account_id,a.name) t
 ORDER BY t.payee_id,t.total DESC,t.name,t.account_id;
$function$
;

REVOKE ALL ON FUNCTION accounting.contact_top_categories() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.contact_top_categories() TO "postgres";

-- 2. context('manage'): each contact row gains top_category.
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
   'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('tax_classification',CASE WHEN contractor_classification='unknown' THEN 'unreviewed' ELSE contractor_classification END,'documentation',documentation_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by),'top_category',CASE WHEN t.account_id IS NULL THEN NULL ELSE jsonb_build_object('id',t.account_id,'name',t.account_name) END) ORDER BY p.name),'[]') FROM accounting.parties p LEFT JOIN accounting.contact_top_categories() t ON t.party_id=p.id),
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
   'queue',(SELECT coalesce(jsonb_agg(jsonb_build_object('feed_account_id',b.id,'ready',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND o.review='unmatched' AND state='posted'),'pending',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND state='pending'))),'[]') FROM accounting.bank_accounts b),
   'worker',(SELECT jsonb_build_object('last_tick_at',w.last_tick_at,'last_tick_due',w.last_tick_due,'source',w.source) FROM accounting.feed_worker w WHERE w.id=1));
 ELSIF view='rules' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('description_mode',coalesce(r.conditions->>'description_mode',(SELECT d.key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) d LIMIT 1)),'description',coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1)),'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction','min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id','reason','') ORDER BY priority,id),'[]') FROM accounting.rules r),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name,'match_mode',a.match_kind,'description',a.pattern) ORDER BY a.pattern),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id));
 ELSIF view='close-history' THEN
  RETURN jsonb_build_object('periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked') ORDER BY month DESC),'[]') FROM accounting.periods p),'reconciliations',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id));
 ELSIF view='tax' THEN
  SELECT id INTO key FROM public.tax_estimates WHERE tax_year=(context.params->>'year')::integer AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1;
  RETURN accounting.tax_link(key)||jsonb_build_object('_safe_harbor_context',jsonb_build_object('as_of',(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'financial_revision',(SELECT financial_revision::text FROM accounting.settings),'available_documents',(SELECT coalesce(jsonb_agg(d.id),'[]') FROM accounting.documents d WHERE d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 ELSIF view='evidence' THEN
  key:=(context.params->>'id')::uuid;PERFORM accounting.entry_detail(key);
  RETURN jsonb_build_object('sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'source_system',o.source,'external_id',o.external_id,'observed_at',o.observed_at,'raw_payload',o.raw_payload)) FROM accounting.bank_transactions o WHERE EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE m.bank_transaction_id=o.id AND l.entry_id=key)),'[]'),
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

-- 3. payees_list (the API's books.contacts): each row gains top_category.
CREATE OR REPLACE FUNCTION accounting.payees_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'roles',to_jsonb(p.roles),'email',p.email,'phone',p.phone,'website',p.website,'notes',p.notes,
  'default_account_id',p.default_account_id,'review_status',p.review_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by),
  'is_archived',p.is_archived,'version',p.version,'transaction_count',(SELECT count(*) FROM accounting.journal_entries e WHERE e.payee_id=p.id AND e.status<>'discarded'),'top_category',CASE WHEN t.account_id IS NULL THEN NULL ELSE jsonb_build_object('id',t.account_id,'name',t.account_name) END) ORDER BY lower(p.name),p.id),'[]'::jsonb) FROM accounting.parties p LEFT JOIN accounting.contact_top_categories() t ON t.party_id=p.id);
END $function$
;

COMMIT;
