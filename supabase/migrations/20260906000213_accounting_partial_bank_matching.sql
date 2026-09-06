-- Bounded bank evidence allocations and redundant-draft resolution.
BEGIN;
-- ACCOUNTING BANK MATCHING BEGIN
ALTER TABLE public.acct_bank_matches DROP CONSTRAINT acct_bank_matches_source_record_id_key;
CREATE INDEX acct_bank_matches_source ON public.acct_bank_matches(source_record_id);
CREATE INDEX acct_bank_matches_line ON public.acct_bank_matches(entry_line_id);
CREATE TABLE public.acct_bank_match_releases (
 id uuid PRIMARY KEY,
 match_id uuid NOT NULL UNIQUE REFERENCES public.acct_bank_matches(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 reversal_entry_id uuid REFERENCES public.acct_journal_entries(id),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.acct_bank_match_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_bank_match_releases FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_bank_match_releases FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_bank_match_releases FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_bank_match_release_immutable BEFORE UPDATE OR DELETE ON public.acct_bank_match_releases FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();

CREATE OR REPLACE FUNCTION public.acct_bank_source_used(p_source uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(sum(abs(m.amount_cents::numeric)),0) FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=p_source WHERE s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id=current_source.external_id AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id);
$$;
CREATE OR REPLACE FUNCTION public.acct_bank_line_used(p_line uuid,p_source uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(sum(abs(m.amount_cents::numeric)),0) FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=p_source WHERE m.entry_line_id=p_line AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id);
$$;
CREATE OR REPLACE FUNCTION public.acct_bank_match_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.acct_import_groups;line public.acct_journal_lines;s public.acct_source_records;
BEGIN
 PERFORM public.acct_write_lock();
 SELECT * INTO s FROM public.acct_source_records WHERE id=NEW.source_record_id;
 SELECT * INTO g FROM public.acct_import_groups WHERE source_record_id=s.id AND bank_account_id IS NOT NULL ORDER BY id LIMIT 1;
 SELECT * INTO line FROM public.acct_journal_lines WHERE id=NEW.entry_line_id;
 IF g.id IS NULL OR line.account_id IS DISTINCT FROM g.bank_account_id OR sign(line.amount_cents) IS DISTINCT FROM sign(g.bank_amount_cents) OR sign(NEW.amount_cents) IS DISTINCT FROM sign(g.bank_amount_cents) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_entries e WHERE e.id=line.entry_id AND e.status='posted' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=e.id)) THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_import_groups other JOIN public.acct_source_records os ON os.id=other.source_record_id WHERE os.source_system=s.source_system AND os.source_scope=s.source_scope AND os.external_id=s.external_id AND (other.bank_account_id IS DISTINCT FROM g.bank_account_id OR other.bank_amount_cents IS DISTINCT FROM g.bank_amount_cents OR other.entry_date IS DISTINCT FROM g.entry_date)) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CONFLICT'; END IF;
 IF abs(NEW.amount_cents::numeric)>abs(g.bank_amount_cents::numeric)-public.acct_bank_source_used(s.id) OR abs(NEW.amount_cents::numeric)>abs(line.amount_cents::numeric)-public.acct_bank_line_used(line.id,s.id) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_bank_match_guard BEFORE INSERT ON public.acct_bank_matches FOR EACH ROW EXECUTE FUNCTION public.acct_bank_match_guard();

CREATE OR REPLACE FUNCTION public.acct_bank_group_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE used numeric;
BEGIN
 IF NEW.bank_account_id IS NOT NULL THEN
  used:=public.acct_bank_source_used(NEW.source_record_id);
  IF used>0 AND (NEW.status IN ('new','applied','excluded') OR NEW.status='duplicate' AND used<>abs(NEW.bank_amount_cents::numeric)) THEN RAISE EXCEPTION 'ACCT_BANK_PARTIAL_REVIEW'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_bank_group_guard BEFORE UPDATE ON public.acct_import_groups FOR EACH ROW EXECUTE FUNCTION public.acct_bank_group_guard();
REVOKE ALL ON FUNCTION public.acct_bank_group_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.acct_bank_reopen_source(p_source uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.acct_import_groups g SET status='review',entry_id=CASE WHEN EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=g.entry_id AND status='draft') THEN g.entry_id ELSE NULL END,version=version+1,reason=p_reason FROM public.acct_source_records s,public.acct_source_records current_source WHERE current_source.id=p_source AND s.id=g.source_record_id AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id=current_source.external_id AND g.status<>'excluded';
 UPDATE public.acct_import_batches b SET status=CASE WHEN status='completed' THEN 'review' ELSE status END,coverage_verified=false,version=version+1 WHERE EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_source_records s ON s.id=g.source_record_id JOIN public.acct_source_records current_source ON current_source.id=p_source WHERE g.batch_id=b.id AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id=current_source.external_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_bank_posting_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE match public.acct_bank_matches;
BEGIN
 IF NEW.status='posted' AND OLD.status='draft' THEN
  IF NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_source_records source ON source.id=g.source_record_id JOIN public.acct_source_records s ON s.source_system=source.source_system AND s.source_scope=source.source_scope AND s.external_id=source.external_id JOIN public.acct_bank_matches m ON m.source_record_id=s.id JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE (g.entry_id=NEW.id OR EXISTS(SELECT 1 FROM public.acct_source_links WHERE source_record_id=g.source_record_id AND entry_id=NEW.id)) AND l.entry_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id)) THEN RAISE EXCEPTION 'ACCT_BANK_PARTIAL_REVIEW'; END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
   FOR match IN SELECT m.* FROM public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE l.entry_id=NEW.reverses_entry_id AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) LOOP
    INSERT INTO public.acct_bank_match_releases(id,match_id,reason,reversal_entry_id,created_by) VALUES(gen_random_uuid(),match.id,'Matched entry reversed; bank evidence needs review',NEW.id,NEW.created_by);
    PERFORM public.acct_bank_reopen_source(match.source_record_id,'Matched posting reversed; review the remaining bank allocation');
   END LOOP;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_bank_posting_guard BEFORE UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_bank_posting_guard();

CREATE OR REPLACE FUNCTION public.acct_bank_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;g public.acct_import_groups;s public.acct_source_records;match public.acct_bank_matches;x jsonb;entry public.acct_journal_entries;used numeric;ids uuid[];drafts uuid[]:='{}';target uuid;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF length(btrim(coalesce(p_command->>'reason',''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
 IF op='bank.release' THEN
  SELECT * INTO match FROM public.acct_bank_matches WHERE id=(p_command->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  INSERT INTO public.acct_bank_match_releases(id,match_id,reason,created_by) VALUES(v_id,match.id,p_command->>'reason',p_actor);
  PERFORM public.acct_bank_reopen_source(match.source_record_id,p_command->>'reason');
  RETURN jsonb_build_object('id',v_id);
 END IF;
 IF op<>'bank.match' THEN RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 SELECT * INTO g FROM public.acct_import_groups WHERE id=(p_command->>'group_id')::uuid AND bank_account_id IS NOT NULL AND status<>'excluded';
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_import_batches WHERE id=g.batch_id AND status IN ('staging','cancelled','failed')) THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 SELECT * INTO s FROM public.acct_source_records WHERE id=g.source_record_id;
 SELECT array_agg(src.id) INTO ids FROM public.acct_source_records src WHERE src.source_system=s.source_system AND src.source_scope=s.source_scope AND src.external_id=s.external_id;
 IF jsonb_typeof(p_command->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'allocations') NOT BETWEEN 0 AND 50 OR jsonb_typeof(coalesce(p_command->'discard_drafts','[]')) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 IF jsonb_array_length(p_command->'allocations')=0 AND public.acct_bank_source_used(s.id)<>abs(g.bank_amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_import_groups other JOIN public.acct_source_records os ON os.id=other.source_record_id WHERE os.id=ANY(ids) AND (other.bank_account_id IS DISTINCT FROM g.bank_account_id OR other.bank_amount_cents IS DISTINCT FROM g.bank_amount_cents OR other.entry_date IS DISTINCT FROM g.entry_date)) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CONFLICT'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_command->'allocations'))<>(SELECT count(DISTINCT item.value->>'line_id') FROM jsonb_array_elements(p_command->'allocations') item(value)) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_command->'allocations') LOOP
  IF x->>'amount_cents' IS NULL OR x->>'amount_cents'!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
  INSERT INTO public.acct_bank_matches(id,source_record_id,entry_line_id,amount_cents,created_by) VALUES(gen_random_uuid(),s.id,(x->>'line_id')::uuid,sign(g.bank_amount_cents)*(x->>'amount_cents')::bigint,p_actor);
  INSERT INTO public.acct_source_links(source_record_id,entry_id) SELECT s.id,entry_id FROM public.acct_journal_lines WHERE id=(x->>'line_id')::uuid ON CONFLICT DO NOTHING;
 END LOOP;
 used:=public.acct_bank_source_used(s.id);
 IF used=abs(g.bank_amount_cents::numeric) THEN
  SELECT l.entry_id INTO target FROM public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE m.source_record_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) ORDER BY m.created_at,m.id LIMIT 1;
  FOR entry IN SELECT DISTINCT e.* FROM public.acct_journal_entries e JOIN public.acct_import_groups groups ON groups.entry_id=e.id WHERE groups.source_record_id=ANY(ids) AND e.status='draft' LOOP
   drafts:=array_append(drafts,entry.id);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_command->'discard_drafts','[]')) d WHERE (d->>'id')::uuid=entry.id AND (d->>'expected_version')::integer=entry.version) THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_APPROVAL'; END IF;
   IF (SELECT count(*) FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=entry.id AND p.cash_kind IN ('bank','cash','card'))<>1 OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=entry.id AND account_id=g.bank_account_id AND amount_cents=g.bank_amount_cents) THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_CHANGED'; END IF;
   INSERT INTO public.acct_document_links(document_id,entry_id) SELECT d.document_id,l.entry_id FROM public.acct_document_links d CROSS JOIN public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE d.entry_id=entry.id AND m.source_record_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) ON CONFLICT DO NOTHING;
   PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.discard','id',entry.id,'expected_version',entry.version,'reason',p_command->'reason'));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_command->'discard_drafts','[]')) d WHERE NOT((d->>'id')::uuid=ANY(drafts))) THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_CHANGED'; END IF;
  INSERT INTO public.acct_source_links(source_record_id,entry_id) SELECT src,l.entry_id FROM unnest(ids) src CROSS JOIN public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id WHERE m.source_record_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.acct_bank_match_releases WHERE match_id=m.id) ON CONFLICT DO NOTHING;
  UPDATE public.acct_import_groups SET status='duplicate',entry_id=target,version=version+1,reason=p_command->>'reason' WHERE source_record_id=ANY(ids) AND status<>'excluded';
 ELSE
  IF jsonb_array_length(coalesce(p_command->'discard_drafts','[]'))>0 THEN RAISE EXCEPTION 'ACCT_REDUNDANT_DRAFT_APPROVAL'; END IF;
  UPDATE public.acct_import_groups SET status='review',version=version+1,reason='Partially matched; finish or release the bank allocation' WHERE source_record_id=ANY(ids) AND status<>'excluded';
 END IF;
 UPDATE public.acct_import_batches SET status=CASE WHEN status='completed' AND used<abs(g.bank_amount_cents::numeric) THEN 'review' ELSE status END,version=version+1,coverage_verified=false WHERE id IN(SELECT batch_id FROM public.acct_import_groups WHERE source_record_id=ANY(ids));
 RETURN jsonb_build_object('id',v_id,'group_id',g.id,'remaining_cents',(abs(g.bank_amount_cents::numeric)-used)::text);
END $$;

CREATE OR REPLACE FUNCTION public.acct_bank_review(p_group uuid,p_query text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.acct_import_groups;s public.acct_source_records;ids uuid[];candidates jsonb;total integer;
BEGIN
 PERFORM public.acct_require_owner();
 IF p_offset<0 OR length(p_query)>200 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 SELECT * INTO g FROM public.acct_import_groups WHERE id=p_group AND bank_account_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 SELECT * INTO s FROM public.acct_source_records WHERE id=g.source_record_id;
 SELECT array_agg(id) INTO ids FROM public.acct_source_records WHERE source_system=s.source_system AND source_scope=s.source_scope AND external_id=s.external_id;
 WITH available AS (
  SELECT l.id AS line_id,l.entry_id,e.entry_date,e.memo,l.amount_cents::text,(abs(l.amount_cents::numeric)-public.acct_bank_line_used(l.id,s.id))::text AS available_cents,abs(e.entry_date-g.entry_date) AS days_apart FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=g.bank_account_id AND sign(l.amount_cents)=sign(g.bank_amount_cents) AND e.status='posted' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=e.id) AND (p_query='' OR strpos(lower(e.memo),lower(p_query))>0 OR e.entry_date::text=p_query)
 ), eligible AS (SELECT * FROM available WHERE available_cents::numeric>0), page AS (SELECT * FROM eligible ORDER BY days_apart,entry_date,line_id LIMIT 25 OFFSET p_offset)
 SELECT (SELECT count(*) FROM eligible),coalesce(jsonb_agg(to_jsonb(page) ORDER BY days_apart,entry_date,line_id),'[]') INTO total,candidates FROM page;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'group',to_jsonb(g)||jsonb_build_object('bank_amount_cents',g.bank_amount_cents::text,'account_name',(SELECT name FROM public.acct_accounts WHERE id=g.bank_account_id),'source_system',s.source_system,'source_scope',s.source_scope),'source_conflict',EXISTS(SELECT 1 FROM public.acct_import_groups other WHERE other.source_record_id=ANY(ids) AND (other.bank_account_id IS DISTINCT FROM g.bank_account_id OR other.bank_amount_cents IS DISTINCT FROM g.bank_amount_cents OR other.entry_date IS DISTINCT FROM g.entry_date)),'remaining_cents',(abs(g.bank_amount_cents::numeric)-public.acct_bank_source_used(s.id))::text,'candidates',candidates,'total',total,
 'drafts',(SELECT coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('lines',(SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text,'account_name',a.name) ORDER BY l.sort_order) FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=e.id))),'[]') FROM (SELECT DISTINCT entry.* FROM public.acct_journal_entries entry JOIN public.acct_import_groups groups ON groups.entry_id=entry.id WHERE groups.source_record_id=ANY(ids) AND entry.status='draft') e),
 'matches',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('amount_cents',m.amount_cents::text,'entry_id',l.entry_id,'entry_date',e.entry_date,'memo',e.memo,'release',(SELECT to_jsonb(r) FROM public.acct_bank_match_releases r WHERE r.match_id=m.id)) ORDER BY m.created_at,m.id),'[]') FROM public.acct_bank_matches m JOIN public.acct_journal_lines l ON l.id=m.entry_line_id JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE m.source_record_id=ANY(ids)));
END $$;
REVOKE ALL ON FUNCTION public.acct_bank_source_used(uuid),public.acct_bank_line_used(uuid,uuid),public.acct_bank_match_guard(),public.acct_bank_reopen_source(uuid,text),public.acct_bank_posting_guard(),public.acct_bank_command(jsonb,uuid),public.acct_bank_review(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_bank_review(uuid,text,integer) TO authenticated;
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
  ELSIF p_command->>'type' LIKE 'bank.%' THEN result:=public.acct_bank_command(p_command,actor);
  ELSIF p_command->>'type' LIKE 'transfer.%' THEN result:=public.acct_transfer_command(p_command,actor);
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
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',5);
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations','bank_match_releases'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
-- ACCOUNTING BANK MATCHING END

COMMIT;
