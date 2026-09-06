-- Independent historical controls, normalization evidence, and baseline locks.
BEGIN;

-- ACCOUNTING HISTORY BEGIN
CREATE TABLE public.acct_history_dispositions (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES public.acct_import_groups(id),
 version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind IN ('annual_closing','unsupported')),
 document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 3000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(group_id,version)
);
CREATE TABLE public.acct_history_review_invalidations (
 check_id uuid PRIMARY KEY REFERENCES public.acct_history_checks(id),
 disposition_id uuid NOT NULL REFERENCES public.acct_history_dispositions(id),
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.acct_history_review_invalidations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_history_review_invalidations FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_history_review_invalidations FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_history_review_invalidations FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_history_review_invalidation_immutable BEFORE UPDATE OR DELETE ON public.acct_history_review_invalidations FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE OR REPLACE FUNCTION public.acct_history_check_current(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.acct_history_checks WHERE id=p_id) AND NOT EXISTS(SELECT 1 FROM public.acct_history_invalidations WHERE check_id=p_id) AND NOT EXISTS(SELECT 1 FROM public.acct_history_review_invalidations WHERE check_id=p_id);
$$;
REVOKE ALL ON FUNCTION public.acct_history_check_current(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.acct_history_dispositions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_history_dispositions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_history_dispositions FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_history_dispositions FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_history_disposition_immutable BEFORE UPDATE OR DELETE ON public.acct_history_dispositions FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();

CREATE OR REPLACE FUNCTION public.acct_closing_normalization_valid(p_group uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.acct_import_groups;year integer;line record;actual numeric;
BEGIN
 SELECT * INTO g FROM public.acct_import_groups WHERE id=p_group;
 IF g.status IS DISTINCT FROM 'excluded' OR g.bank_account_id IS NOT NULL OR jsonb_array_length(g.lines)<2 OR to_char(g.entry_date,'MM-DD') NOT IN ('01-01','12-31') THEN RETURN false; END IF;
 year:=extract(year FROM g.entry_date)::integer-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN 1 ELSE 0 END;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(g.lines) x LEFT JOIN public.acct_accounts a ON a.id=(x->>'account_id')::uuid LEFT JOIN public.acct_account_profiles p ON p.account_id=a.id WHERE a.id IS NULL OR NOT(a.account_type IN ('income','expense') OR coalesce(p.purpose='opening_retained_earnings',false))) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.lines) x JOIN public.acct_accounts a ON a.id=(x->>'account_id')::uuid WHERE a.account_type IN ('income','expense')) THEN RETURN false; END IF;
 IF (SELECT sum((x->>'amount_cents')::numeric) FROM jsonb_array_elements(g.lines) x)<>0 THEN RETURN false; END IF;
 FOR line IN SELECT a.id,coalesce(sum((x->>'amount_cents')::numeric),0) AS closing FROM public.acct_accounts a LEFT JOIN jsonb_array_elements(g.lines) x ON (x->>'account_id')::uuid=a.id WHERE a.account_type IN ('income','expense') GROUP BY a.id LOOP
  SELECT coalesce(sum(l.amount_cents),0) INTO actual FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=line.id AND e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND make_date(year,12,31);
  IF line.closing<>-actual THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_preview(p_from date,p_to date,p_monthly jsonb DEFAULT '[]',p_accounts jsonb DEFAULT '[]',p_totals jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE start_date date;end_date date;month_control jsonb;workspace jsonb;actual jsonb;monthly jsonb:='[]';accounts jsonb;differences integer:=0;source_errors integer;drafts integer;unclassified integer;expected_count integer:=0;v_key text;required_accounts integer;
BEGIN
 PERFORM public.acct_require_owner();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR extract(year FROM p_from)<>extract(year FROM p_to) OR p_from<'1900-01-01'::date OR p_to>'2100-12-31'::date THEN RAISE EXCEPTION 'ACCT_HISTORY_YEAR_RANGE'; END IF;
 IF jsonb_typeof(p_monthly) IS DISTINCT FROM 'array' OR jsonb_array_length(p_monthly)>12 OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_accounts)>1000 OR jsonb_typeof(p_totals) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF EXISTS(SELECT 1 FROM (
  SELECT x->>'income_cents' v FROM jsonb_array_elements(p_monthly) x UNION ALL SELECT x->>'expense_cents' FROM jsonb_array_elements(p_monthly) x UNION ALL SELECT x->>'net_income_cents' FROM jsonb_array_elements(p_monthly) x UNION ALL SELECT x->>'amount_cents' FROM jsonb_array_elements(p_accounts) x UNION ALL SELECT value#>>'{}' FROM jsonb_each(p_totals)
 ) amounts WHERE v IS NULL OR v!~'^-?(0|[1-9][0-9]{0,18})$' OR abs(v::numeric)>9223372036854775807) THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_monthly))<>(SELECT count(DISTINCT x->>'from') FROM jsonb_array_elements(p_monthly) x) OR (SELECT count(*) FROM jsonb_array_elements(p_accounts))<>(SELECT count(DISTINCT x->>'account_id') FROM jsonb_array_elements(p_accounts) x) THEN RAISE EXCEPTION 'ACCT_DUPLICATE_CONTROL'; END IF;
 FOR start_date IN SELECT greatest(d::date,p_from) FROM generate_series(date_trunc('month',p_from),date_trunc('month',p_to),INTERVAL '1 month') d LOOP
  end_date:=least((date_trunc('month',start_date)+INTERVAL '1 month -1 day')::date,p_to);expected_count:=expected_count+1;
  SELECT x INTO month_control FROM jsonb_array_elements(p_monthly) x WHERE x->>'from'=start_date::text AND x->>'to'=end_date::text;
  workspace:=public.acct_workspace(start_date,end_date);actual:=workspace->'reports';
  FOREACH v_key IN ARRAY ARRAY['income_cents','expense_cents','net_income_cents'] LOOP
   IF (month_control->>v_key)::numeric IS DISTINCT FROM (actual->>v_key)::numeric THEN differences:=differences+1; END IF;
  END LOOP;
  monthly:=monthly||jsonb_build_array(jsonb_build_object('from',start_date,'to',end_date,'actual',jsonb_build_object('income_cents',actual->'income_cents','expense_cents',actual->'expense_cents','net_income_cents',actual->'net_income_cents'),'source',month_control));
 END LOOP;
 IF jsonb_array_length(p_monthly)<>expected_count THEN differences:=differences+1; END IF;
 workspace:=public.acct_workspace(p_from,p_to);
 FOREACH v_key IN ARRAY ARRAY['assets_cents','liabilities_cents'] LOOP
  IF (p_totals->>v_key)::numeric IS DISTINCT FROM (workspace->'reports'->>v_key)::numeric THEN differences:=differences+1; END IF;
 END LOOP;
 IF (p_totals->>'equity_total_cents')::numeric IS DISTINCT FROM (workspace->'reports'->>'equity_cents')::numeric+(workspace->'reports'->>'retained_cents')::numeric+(workspace->'reports'->>'year_income_cents')::numeric THEN differences:=differences+1; END IF;
 WITH controls AS (
  SELECT b.value->>'id' AS account_id,b.value->>'code' AS code,b.value->>'name' AS name,b.value->>'account_type' AS account_type,CASE WHEN b.value->>'account_type' IN ('income','expense') THEN b.value->>'period_cents' ELSE b.value->>'ending_cents' END AS actual_cents,
   (SELECT x->>'amount_cents' FROM jsonb_array_elements(p_accounts) x WHERE x->>'account_id'=b.value->>'id') AS source_cents,
   ((CASE WHEN b.value->>'account_type' IN ('income','expense') THEN b.value->>'period_cents' ELSE b.value->>'ending_cents' END)::numeric<>0 OR EXISTS(SELECT 1 FROM public.acct_account_profiles p WHERE p.account_id=(b.value->>'id')::uuid AND p.cash_kind IN ('bank','card','cash') AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=p.account_id AND e.status='posted' AND e.entry_date<=p_to))) AS required
  FROM jsonb_array_elements(workspace->'balances') b WHERE NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p WHERE p.account_id=(b.value->>'id')::uuid AND p.purpose='opening_retained_earnings')
 ) SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY code,name),'[]'),count(*) FILTER(WHERE required),count(*) FILTER(WHERE (required OR source_cents IS NOT NULL) AND source_cents::numeric IS DISTINCT FROM actual_cents::numeric) INTO accounts,required_accounts,unclassified FROM controls c;
 differences:=differences+unclassified;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) x WHERE NOT EXISTS(SELECT 1 FROM public.acct_accounts WHERE id=(x->>'account_id')::uuid)) THEN RAISE EXCEPTION 'ACCT_INVALID_ACCOUNT'; END IF;
 SELECT count(*) INTO drafts FROM public.acct_journal_entries WHERE status='draft' AND entry_date<=p_to;
 SELECT count(*) INTO source_errors FROM public.acct_import_batches b WHERE b.from_date<=p_to AND b.to_date>=p_from AND (b.status<>'completed' OR b.basis<>'cash' OR NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=b.source_document_id AND state='available')) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'));
 SELECT source_errors+count(*) INTO source_errors FROM public.acct_import_groups g JOIN public.acct_import_batches b ON b.id=g.batch_id WHERE g.entry_date BETWEEN p_from AND p_to AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups applied WHERE applied.batch_id=b.id AND applied.status='applied')) AND (
  g.status NOT IN ('applied','duplicate','excluded')
  OR g.status IN ('applied','duplicate') AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=g.entry_id AND status='posted')
  OR g.status='excluded' AND NOT EXISTS(SELECT 1 FROM public.acct_history_dispositions d JOIN public.acct_document_states s ON s.document_id=d.document_id WHERE d.group_id=g.id AND d.version=(SELECT max(version) FROM public.acct_history_dispositions WHERE group_id=g.id) AND d.kind='annual_closing' AND s.state='available' AND public.acct_closing_normalization_valid(g.id))
 );
 SELECT count(*) INTO unclassified FROM jsonb_array_elements(workspace->'balances') b JOIN public.acct_account_profiles p ON p.account_id=(b.value->>'id')::uuid WHERE p.purpose IN ('opening_balance_equity','uncategorized_income','uncategorized_expense') AND (b.value->>'ending_cents')::numeric<>0;
 RETURN jsonb_build_object('from',p_from,'to',p_to,'partial_year',p_from<>make_date(extract(year FROM p_from)::integer,1,1) OR p_to<>make_date(extract(year FROM p_from)::integer,12,31),'revision',workspace->'revision','monthly',monthly,'accounts',accounts,'required_accounts',required_accounts,'differences',differences,'source_errors',source_errors,'drafts',drafts,'unclassified_accounts',unclassified,'reports',workspace->'reports',
 'scope_ended',p_to<=current_date,'entity_verified',EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=extract(year FROM p_from) AND classification<>'unverified'),
 'ready',p_to<=current_date AND differences=0 AND source_errors=0 AND drafts=0 AND unclassified=0 AND EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=extract(year FROM p_from) AND classification<>'unverified'));
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;proof jsonb;batch public.acct_import_batches;g public.acct_import_groups;v_history public.acct_history_checks;month date;ending date;snapshot uuid;v_count integer:=0;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF op='import.resume' THEN
  SELECT * INTO batch FROM public.acct_import_batches WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF batch.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF batch.status NOT IN ('cancelled','failed') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  UPDATE public.acct_import_batches SET status=CASE WHEN (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id)<expected_groups THEN 'staging' ELSE 'review' END,error='',coverage_verified=false,version=version+1 WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'version',batch.version+1);
 END IF;
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF op='history.lock' THEN
  SELECT * INTO v_history FROM public.acct_history_checks WHERE id=(p_command->>'history_id')::uuid AND public.acct_history_check_current(id);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_HISTORY_INVALIDATED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=v_history.source_document_id AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  proof:=public.acct_history_preview(v_history.from_date,v_history.to_date,v_history.controls->'monthly',v_history.account_controls,v_history.controls->'totals');
  IF NOT (proof->>'ready')::boolean OR EXISTS(SELECT 1 FROM public.acct_import_batches b WHERE b.from_date<=v_history.to_date AND (b.status<>'completed' OR NOT b.coverage_verified) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'))) THEN RAISE EXCEPTION 'ACCT_HISTORY_DIFFERENCE'; END IF;
  FOR month IN SELECT d::date FROM generate_series(date_trunc('month',v_history.from_date),date_trunc('month',v_history.to_date),INTERVAL '1 month') d WHERE d::date>=v_history.from_date AND (d+INTERVAL '1 month -1 day')::date<=v_history.to_date LOOP
   ending:=(month+INTERVAL '1 month -1 day')::date;
   IF ending>current_date THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
   IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=month AND is_locked) THEN CONTINUE; END IF;
   INSERT INTO public.acct_periods(month_start) VALUES(month) ON CONFLICT DO NOTHING;
   snapshot:=gen_random_uuid();
   INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'historical_baseline',month,ending,(proof->>'revision')::bigint,jsonb_build_object('kind','historical_baseline','history_check_id',v_history.id,'parity',proof,'reports',public.acct_workspace(month,ending)),p_actor);
   INSERT INTO public.acct_close_records(id,month_start,snapshot_id,proof,created_by) SELECT gen_random_uuid(),month,snapshot,payload,p_actor FROM public.acct_report_snapshots WHERE id=snapshot;
   UPDATE public.acct_periods SET is_locked=true,reason='Historical baseline accepted from independent source reports' WHERE month_start=month;
   v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('id',v_id,'locked_months',v_count);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF op='history.disposition' THEN
  SELECT * INTO g FROM public.acct_import_groups WHERE id=(p_command->>'group_id')::uuid AND status='excluded';
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
  IF p_command->>'kind'='annual_closing' AND NOT public.acct_closing_normalization_valid(g.id) THEN RAISE EXCEPTION 'ACCT_CLOSING_NORMALIZATION'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=(date_trunc('year',g.entry_date)::date-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN INTERVAL '1 year' ELSE INTERVAL '0 year' END)) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
  INSERT INTO public.acct_history_dispositions(id,group_id,version,kind,document_id,reason,created_by) VALUES(v_id,g.id,coalesce((SELECT max(version) FROM public.acct_history_dispositions WHERE group_id=g.id),0)+1,p_command->>'kind',(p_command->>'document_id')::uuid,p_command->>'reason',p_actor);
  INSERT INTO public.acct_history_review_invalidations(check_id,disposition_id,reason) SELECT h.id,v_id,'Source normalization review changed' FROM public.acct_history_checks h WHERE h.to_date>=(date_trunc('year',g.entry_date)::date-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN INTERVAL '1 year' ELSE INTERVAL '0 year' END) ON CONFLICT DO NOTHING;
  UPDATE public.acct_import_batches SET coverage_verified=false WHERE coverage_verified AND to_date>=(date_trunc('year',g.entry_date)::date-CASE WHEN to_char(g.entry_date,'MM-DD')='01-01' THEN INTERVAL '1 year' ELSE INTERVAL '0 year' END);
 ELSIF op='history.verify' THEN
  IF (p_command->>'cash_basis_confirmed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_HISTORY_BASIS'; END IF;
  proof:=public.acct_history_preview((p_command->>'from')::date,(p_command->>'to')::date,p_command->'monthly',p_command->'accounts',p_command->'totals');
  IF NOT (proof->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_HISTORY_DIFFERENCE'; END IF;
  INSERT INTO public.acct_history_checks(id,from_date,to_date,source_document_id,controls,account_controls,revision,explanation,created_by) VALUES(v_id,(p_command->>'from')::date,(p_command->>'to')::date,(p_command->>'document_id')::uuid,jsonb_build_object('monthly',p_command->'monthly','totals',p_command->'totals','proof',proof),p_command->'accounts',(proof->>'revision')::bigint,p_command->>'reason',p_actor);
  UPDATE public.acct_import_batches b SET coverage_verified=true,version=version+1 WHERE b.status='completed' AND NOT b.coverage_verified AND NOT EXISTS(
   SELECT 1 FROM generate_series(extract(year FROM b.from_date)::integer,extract(year FROM b.to_date)::integer) y WHERE NOT EXISTS(
    SELECT 1 FROM public.acct_history_checks h WHERE h.from_date<=greatest(b.from_date,make_date(y,1,1)) AND h.to_date>=least(b.to_date,make_date(y,12,31)) AND public.acct_history_check_current(h.id)
   )
  );
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 RETURN jsonb_build_object('id',v_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_view() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
 'checks',(SELECT coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('revision',h.revision::text,'invalidated',NOT public.acct_history_check_current(h.id),
  'eligible_months',(SELECT count(*) FROM generate_series(date_trunc('month',h.from_date),date_trunc('month',h.to_date),INTERVAL '1 month') d WHERE d::date>=h.from_date AND (d+INTERVAL '1 month -1 day')::date<=least(h.to_date,current_date)),
  'locked_months',(SELECT coalesce(jsonb_agg(c.month_start ORDER BY c.month_start),'[]') FROM public.acct_close_records c JOIN public.acct_periods p ON p.month_start=c.month_start WHERE c.proof->>'history_check_id'=h.id::text AND p.is_locked AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens WHERE close_id=c.id))
 ) ORDER BY h.from_date DESC,h.created_at DESC,h.id),'[]') FROM public.acct_history_checks h),
 'dispositions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY created_at DESC,id),'[]') FROM public.acct_history_dispositions d),
 'excluded',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'entry_date',g.entry_date,'memo',g.memo,'reason',g.reason,'batch_id',g.batch_id,'disposition',(SELECT to_jsonb(d) FROM public.acct_history_dispositions d WHERE d.group_id=g.id ORDER BY version DESC LIMIT 1)) ORDER BY g.entry_date,g.id),'[]') FROM public.acct_import_groups g WHERE status='excluded'),
 'years',(SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY year DESC),'[]') FROM public.acct_fiscal_years y));
END $$;
CREATE OR REPLACE FUNCTION public.acct_history_document_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.state='archived' AND OLD.state<>'archived' AND EXISTS(SELECT 1 FROM public.acct_history_dispositions WHERE document_id=NEW.document_id) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_history_document_guard BEFORE UPDATE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_history_document_guard();
CREATE OR REPLACE FUNCTION public.acct_close_period_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.is_locked AND (TG_OP='INSERT' OR NOT OLD.is_locked) THEN
  IF EXISTS(SELECT 1 FROM public.acct_close_records c JOIN public.acct_report_snapshots s ON s.id=c.snapshot_id JOIN public.acct_history_checks h ON h.id=(c.proof->>'history_check_id')::uuid WHERE c.month_start=NEW.month_start AND s.kind='historical_baseline' AND c.proof->>'kind'='historical_baseline' AND h.from_date<=NEW.month_start AND h.to_date>=(NEW.month_start+INTERVAL '1 month -1 day')::date AND public.acct_history_check_current(h.id) AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens WHERE close_id=c.id) AND (public.acct_history_preview(h.from_date,h.to_date,h.controls->'monthly',h.account_controls,h.controls->'totals')->>'ready')::boolean) THEN RETURN NEW; END IF;
  IF NOT coalesce((public.acct_close_checklist(NEW.month_start)->>'ready')::boolean,false) OR NOT EXISTS(SELECT 1 FROM public.acct_close_records c WHERE c.month_start=NEW.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id)) THEN RAISE EXCEPTION 'ACCT_CLOSE_INCOMPLETE'; END IF;
 ELSIF TG_OP='UPDATE' AND OLD.is_locked AND NOT NEW.is_locked THEN
  IF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM NEW.month_start)) AND NOT EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open' AND NEW.month_start BETWEEN from_date AND to_date AND extract(year FROM to_date)>=(SELECT max(year) FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_close_records c WHERE c.month_start=NEW.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id)) THEN RAISE EXCEPTION 'ACCT_REOPEN_RECORD_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.acct_history_view(),public.acct_history_document_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_history_view() TO authenticated;
REVOKE ALL ON FUNCTION public.acct_closing_normalization_valid(uuid),public.acct_history_preview(date,date,jsonb,jsonb,jsonb),public.acct_history_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_history_preview(date,date,jsonb,jsonb,jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.acct_operate(p_key uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=public.acct_require_owner();receipt public.acct_command_receipts;result jsonb;original public.acct_journal_entries;reversal jsonb;replacement jsonb;
BEGIN
  IF p_key IS NULL OR p_command IS NULL OR octet_length(p_command::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  PERFORM public.acct_write_lock();actor:=public.acct_require_owner();
  SELECT * INTO receipt FROM public.acct_command_receipts WHERE id=p_key;
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.payload<>p_command THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN receipt.result;
  END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  IF p_command->>'type'='import.cancel' AND EXISTS(SELECT 1 FROM public.acct_import_batches WHERE id=(p_command->>'id')::uuid AND (status='completed' OR coverage_verified)) THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  IF p_command->>'type'='entry.correct' THEN
    SELECT * INTO original FROM public.acct_journal_entries WHERE id=(p_command->>'id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    PERFORM public.acct_validate_template(p_command->'lines');
    reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',original.id,'expected_version',p_command->'expected_version','entry_date',coalesce(p_command->>'reversal_date',original.entry_date::text),'reason',p_command->'reason'));
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',p_command->'replacement_id','expected_version',0,'entry_date',p_command->'entry_date','memo',p_command->'memo','lines',p_command->'lines'));
    INSERT INTO public.acct_entry_context SELECT (replacement->>'id')::uuid,kind,payee_id,customer_id,project_id,business_line_id,payment_rail,contractor_treatment,contractor_reason FROM public.acct_entry_context WHERE entry_id=original.id;
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by) VALUES(original.id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',original.id);
  ELSIF p_command->>'type' LIKE 'history.%' OR p_command->>'type'='import.resume' THEN result:=public.acct_history_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'reconciliation.%' THEN result:=public.acct_close_command(p_command,actor);
  ELSIF p_command->>'type'='account.lifecycle' THEN result:=public.acct_lifecycle_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'clearing.%' THEN result:=public.acct_clearing_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'period.%' OR p_command->>'type' LIKE 'year.%' THEN result:=public.acct_period_command(p_command,actor);
  ELSE RETURN public.acct_execute(p_key,p_command); END IF;
  PERFORM set_config('acct.operation_id',p_key::text,true);
  UPDATE public.acct_settings SET financial_revision=financial_revision+1 WHERE singleton;
  INSERT INTO public.acct_command_receipts(id,actor_id,payload,result) VALUES(p_key,actor,p_command,result);
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.acct_books_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;section text;rows jsonb;
BEGIN
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',4);
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
-- ACCOUNTING HISTORY END

COMMIT;
