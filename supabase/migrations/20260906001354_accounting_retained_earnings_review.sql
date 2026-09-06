-- Retained earnings posting requires source evidence and exact controls.
BEGIN;
-- ACCOUNTING RETAINED REVIEW BEGIN
CREATE TABLE public.acct_retained_reviews (
 id uuid PRIMARY KEY,
 entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
 entry_version integer NOT NULL CHECK(entry_version>0),
 kind text NOT NULL CHECK(kind IN ('opening','historical','correction')),
 original_entry_id uuid REFERENCES public.acct_journal_entries(id),
 source_group_id uuid REFERENCES public.acct_import_groups(id),
 document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 controls jsonb NOT NULL CHECK(jsonb_typeof(controls)='array'),
 reviewed_payload jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 3000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acct_retained_reviews_entry ON public.acct_retained_reviews(entry_id,entry_version);
ALTER TABLE public.acct_retained_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_retained_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.acct_retained_reviews FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement();
CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.acct_retained_reviews FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit();
CREATE TRIGGER acct_retained_review_immutable BEFORE UPDATE OR DELETE ON public.acct_retained_reviews FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();

CREATE OR REPLACE FUNCTION public.acct_retained_payload(p_entry uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('entry_date',e.entry_date,'memo',e.memo,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo,'sort_order',l.sort_order) ORDER BY l.sort_order,l.id) FROM public.acct_journal_lines l WHERE l.entry_id=e.id)) FROM public.acct_journal_entries e WHERE e.id=p_entry;
$$;
CREATE OR REPLACE FUNCTION public.acct_retained_review(p_entry uuid,p_kind text,p_document uuid,p_controls jsonb,p_reason text,p_actor uuid,p_original uuid DEFAULT NULL,p_group uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE entry public.acct_journal_entries;v_id uuid:=gen_random_uuid();actual jsonb;control jsonb;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 SELECT * INTO entry FROM public.acct_journal_entries WHERE id=p_entry AND status='draft';
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=p_entry AND p.purpose='opening_retained_earnings') THEN RAISE EXCEPTION 'ACCT_RETAINED_NOT_USED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=p_document AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF p_kind IN ('opening','historical') AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=p_entry AND a.account_type IN ('income','expense')) THEN RAISE EXCEPTION 'ACCT_NOMINAL_CLOSING_FORBIDDEN'; END IF;
 IF p_kind='opening' AND EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND entry_date<=entry.entry_date) THEN RAISE EXCEPTION 'ACCT_OPENING_HISTORY_EXISTS'; END IF;
 IF p_kind='correction' AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries original WHERE original.id=p_original AND original.status='posted' AND EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=original.id AND status='posted')) THEN RAISE EXCEPTION 'ACCT_RETAINED_CORRECTION'; END IF;
 IF p_kind='historical' AND NOT EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_import_batches b ON b.id=g.batch_id WHERE g.id=p_group AND b.source_document_id=p_document AND b.mode='journal' AND b.basis='cash' AND b.source_system=entry.primary_origin AND g.entry_date=entry.entry_date AND g.status='new') THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
 IF jsonb_typeof(p_controls) IS DISTINCT FROM 'array' OR jsonb_array_length(p_controls) NOT BETWEEN 2 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_controls) c WHERE c->>'amount_cents' IS NULL OR c->>'amount_cents'!~'^-?(0|[1-9][0-9]{0,18})$' OR abs((c->>'amount_cents')::numeric)>9223372036854775807) OR (SELECT count(*) FROM jsonb_array_elements(p_controls))<>(SELECT count(DISTINCT c->>'account_id') FROM jsonb_array_elements(p_controls) c) THEN RAISE EXCEPTION 'ACCT_INVALID_CONTROL'; END IF;
 SELECT jsonb_agg(jsonb_build_array(account_id,amount::text) ORDER BY account_id) INTO actual FROM (SELECT account_id,sum(amount_cents) amount FROM public.acct_journal_lines WHERE entry_id=p_entry GROUP BY account_id) totals;
 SELECT jsonb_agg(jsonb_build_array((c->>'account_id')::uuid,((c->>'amount_cents')::numeric)::text) ORDER BY (c->>'account_id')::uuid) INTO control FROM jsonb_array_elements(p_controls) c;
 IF actual IS DISTINCT FROM control THEN RAISE EXCEPTION 'ACCT_RETAINED_CONTROL_DIFFERENCE'; END IF;
 INSERT INTO public.acct_retained_reviews(id,entry_id,entry_version,kind,original_entry_id,source_group_id,document_id,controls,reviewed_payload,reason,created_by) VALUES(v_id,p_entry,entry.version,p_kind,p_original,p_group,p_document,p_controls,public.acct_retained_payload(p_entry),p_reason,p_actor);
 INSERT INTO public.acct_document_links(document_id,entry_id) VALUES(p_document,p_entry) ON CONFLICT DO NOTHING;
 RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION public.acct_retained_post_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status='posted' AND OLD.status='draft' AND NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=NEW.id AND p.purpose='opening_retained_earnings') AND NOT EXISTS(SELECT 1 FROM public.acct_retained_reviews r JOIN public.acct_document_states d ON d.document_id=r.document_id WHERE r.entry_id=NEW.id AND r.entry_version=OLD.version AND r.reviewed_payload=public.acct_retained_payload(NEW.id) AND d.state='available') THEN RAISE EXCEPTION 'ACCT_RETAINED_REVIEW_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_retained_post_guard BEFORE UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_retained_post_guard();
CREATE OR REPLACE FUNCTION public.acct_retained_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE entry public.acct_journal_entries;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF p_command->>'type'<>'retained.post' THEN RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 SELECT * INTO entry FROM public.acct_journal_entries WHERE id=(p_command->>'id')::uuid;
 IF entry.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 PERFORM public.acct_retained_review(entry.id,'opening',(p_command->>'document_id')::uuid,p_command->'controls',p_command->>'reason',p_actor);
 RETURN public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',entry.id,'expected_version',entry.version));
END $$;
REVOKE ALL ON FUNCTION public.acct_retained_payload(uuid),public.acct_retained_review(uuid,text,uuid,jsonb,text,uuid,uuid,uuid),public.acct_retained_post_guard(),public.acct_retained_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
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
    IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=(replacement->>'id')::uuid AND p.purpose='opening_retained_earnings') THEN
     PERFORM public.acct_retained_review((replacement->>'id')::uuid,'correction',(p_command->'retained_review'->>'document_id')::uuid,p_command->'retained_review'->'controls',p_command->>'reason',actor,original.id);
    END IF;
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by) VALUES(original.id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',original.id);
  ELSIF p_command->>'type'='retained.post' THEN result:=public.acct_retained_command(p_command,actor);
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
CREATE OR REPLACE FUNCTION public.acct_import_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  op text:=p_command->>'type'; v_id uuid:=(p_command->>'id')::uuid;
  batch public.acct_import_batches; g public.acct_import_groups; x jsonb; src uuid; candidate uuid; v_status text;
  result jsonb; saved jsonb; v_entry uuid; v_line uuid; v_uncategorized uuid; v_lines jsonb;
  v_count integer; v_posted integer:=0; v_drafted integer:=0;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='import.create' THEN
    SELECT * INTO batch FROM public.acct_import_batches WHERE source_system=p_command->>'source_system' AND source_scope=p_command->>'source_scope' AND file_hash=p_command->>'file_hash' AND mapping_hash=p_command->>'mapping_hash';
    IF FOUND THEN RETURN jsonb_build_object('id',batch.id,'version',batch.version,'existing',true); END IF;
    INSERT INTO public.acct_import_batches(id,source_system,source_scope,file_hash,mapping_hash,file_name,source_document_id,mode,basis,expected_groups,from_date,to_date,created_by)
    VALUES(v_id,p_command->>'source_system',p_command->>'source_scope',p_command->>'file_hash',p_command->>'mapping_hash',p_command->>'file_name',nullif(p_command->>'source_document_id','')::uuid,p_command->>'mode',p_command->>'basis',(p_command->>'expected_groups')::integer,(p_command->>'from')::date,(p_command->>'to')::date,p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1);
  END IF;
  IF op IN ('import.stage','import.apply','import.cancel','import.finish') THEN
    SELECT * INTO batch FROM public.acct_import_batches WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF batch.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF batch.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
  END IF;
  IF op='import.stage' THEN
    IF batch.status<>'staging' OR jsonb_typeof(p_command->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'groups') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_STAGE'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'groups') LOOP
      IF (x->>'ordinal')::integer<>(SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id) THEN RAISE EXCEPTION 'ACCT_IMPORT_CHECKPOINT'; END IF;
      IF (x->>'ordinal')::integer>=batch.expected_groups OR (x->>'entry_date')::date NOT BETWEEN batch.from_date AND batch.to_date THEN RAISE EXCEPTION 'ACCT_IMPORT_SCOPE'; END IF;
      INSERT INTO public.acct_source_records(source_system,source_scope,external_id,content_hash,raw_payload)
      VALUES(batch.source_system,batch.source_scope,x->>'external_id',x->>'source_hash',x->'raw')
      ON CONFLICT(source_system,source_scope,external_id,content_hash) DO NOTHING;
      SELECT id INTO src FROM public.acct_source_records WHERE source_system=batch.source_system AND source_scope=batch.source_scope AND external_id=x->>'external_id' AND content_hash=x->>'source_hash';
      SELECT l.entry_id INTO candidate FROM public.acct_source_links l JOIN public.acct_journal_entries e ON e.id=l.entry_id
        JOIN public.acct_source_records s ON s.id=l.source_record_id JOIN public.acct_import_groups previous ON previous.source_record_id=s.id
        WHERE s.source_system=batch.source_system AND s.source_scope=batch.source_scope AND s.external_id=x->>'external_id' AND previous.fingerprint=x->>'fingerprint' AND e.status<>'discarded' ORDER BY e.created_at LIMIT 1;
      v_status:=CASE WHEN candidate IS NOT NULL THEN 'duplicate' ELSE 'new' END;
      IF candidate IS NULL AND EXISTS(SELECT 1 FROM public.acct_source_records s JOIN public.acct_source_links l ON l.source_record_id=s.id WHERE s.source_system=batch.source_system AND s.source_scope=batch.source_scope AND s.external_id=x->>'external_id') THEN v_status:='exception'; END IF;
      IF batch.mode='bank' THEN
        IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id=(x->>'bank_account_id')::uuid AND p.cash_kind IN ('bank','cash','card') AND NOT a.is_archived) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
        IF candidate IS NULL THEN
          SELECT e.id INTO candidate FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id
          WHERE l.account_id=(x->>'bank_account_id')::uuid AND l.amount_cents=(x->>'bank_amount_cents')::bigint AND e.status<>'discarded' AND abs(e.entry_date-(x->>'entry_date')::date)<=5 ORDER BY abs(e.entry_date-(x->>'entry_date')::date),e.id LIMIT 1;
          IF candidate IS NOT NULL AND v_status='new' THEN v_status:='review'; END IF;
        END IF;
      ELSE
        PERFORM public.acct_validate_template(x->'lines');
      END IF;
      IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=date_trunc('month',(x->>'entry_date')::date)::date AND is_locked) AND v_status<>'duplicate' THEN v_status:='exception'; END IF;
      INSERT INTO public.acct_import_groups(id,batch_id,ordinal,source_record_id,fingerprint,identity_kind,entry_date,memo,lines,bank_account_id,bank_amount_cents,status,entry_id,candidate_entry_id,reason)
      VALUES((x->>'id')::uuid,v_id,(x->>'ordinal')::integer,src,x->>'fingerprint',x->>'identity_kind',(x->>'entry_date')::date,x->>'memo',coalesce(x->'lines','[]'),nullif(x->>'bank_account_id','')::uuid,nullif(x->>'bank_amount_cents','')::bigint,v_status,CASE WHEN v_status='duplicate' THEN candidate ELSE NULL END,candidate,CASE WHEN v_status='exception' THEN 'Changed source identity or locked financial period requires review.' ELSE '' END);
      IF v_status='duplicate' THEN INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(src,candidate) ON CONFLICT DO NOTHING; END IF;
    END LOOP;
    SELECT count(*) INTO v_count FROM public.acct_import_groups WHERE batch_id=v_id;
    UPDATE public.acct_import_batches SET version=version+1,status=CASE WHEN v_count=expected_groups THEN 'review' ELSE 'staging' END WHERE id=v_id;
  ELSIF op='import.resolve' THEN
    SELECT * INTO g FROM public.acct_import_groups WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    SELECT * INTO batch FROM public.acct_import_batches WHERE id=g.batch_id;
    IF batch.status NOT IN ('review','applying') OR g.status IN ('applied','duplicate','excluded') THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL'; END IF;
    IF g.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF p_command->>'resolution'='new' THEN
      IF g.status='exception' THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION'; END IF;
      UPDATE public.acct_import_groups SET status='new',version=version+1,candidate_entry_id=NULL,reason=p_command->>'reason' WHERE id=v_id;
    ELSIF p_command->>'resolution'='exclude' THEN
      UPDATE public.acct_import_groups SET status='excluded',version=version+1,reason=p_command->>'reason' WHERE id=v_id;
    ELSIF p_command->>'resolution'='match' THEN
      v_entry:=(p_command->>'entry_id')::uuid;
      IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_entry AND status='posted') THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
      IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id=v_entry) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
      IF batch.mode='bank' THEN
        SELECT id INTO v_line FROM public.acct_journal_lines WHERE entry_id=v_entry AND account_id=g.bank_account_id AND amount_cents=g.bank_amount_cents ORDER BY sort_order LIMIT 1;
        IF v_line IS NULL THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
        IF EXISTS(SELECT 1 FROM public.acct_bank_matches m JOIN public.acct_source_records s ON s.id=m.source_record_id JOIN public.acct_source_records current_source ON current_source.id=g.source_record_id
          WHERE m.entry_line_id=v_line AND s.source_system=current_source.source_system AND s.source_scope=current_source.source_scope AND s.external_id<>current_source.external_id) THEN RAISE EXCEPTION 'ACCT_MATCH_ALREADY_USED'; END IF;
        INSERT INTO public.acct_bank_matches(source_record_id,entry_line_id,amount_cents,created_by) VALUES(g.source_record_id,v_line,g.bank_amount_cents,p_actor);
      ELSE
        -- Journal evidence can attach only to the same date and complete line set.
        IF NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE id=v_entry AND entry_date=g.entry_date) OR
          (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM public.acct_journal_lines WHERE entry_id=v_entry) IS DISTINCT FROM
          (SELECT jsonb_agg(jsonb_build_array((j->>'account_id')::uuid,j->>'amount_cents') ORDER BY (j->>'account_id')::uuid,(j->>'amount_cents')::bigint) FROM jsonb_array_elements(g.lines) j) THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
      END IF;
      INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(g.source_record_id,v_entry) ON CONFLICT DO NOTHING;
      UPDATE public.acct_import_groups SET status='duplicate',entry_id=v_entry,version=version+1,reason=p_command->>'reason' WHERE id=v_id;
    ELSE RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    UPDATE public.acct_import_batches SET version=version+1 WHERE id=g.batch_id;
    RETURN jsonb_build_object('id',g.batch_id,'group_id',v_id);
  ELSIF op='import.apply' THEN
    IF batch.status NOT IN ('review','applying') OR batch.basis<>'cash' OR jsonb_array_length(p_command->'group_ids') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'group_ids') LOOP
      SELECT * INTO g FROM public.acct_import_groups WHERE id=(x#>>'{}')::uuid AND batch_id=v_id;
      IF NOT FOUND OR g.status<>'new' THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_READY'; END IF;
      v_entry:=gen_random_uuid();
      IF batch.mode='bank' THEN
        SELECT account_id INTO v_uncategorized FROM public.acct_account_profiles WHERE purpose=CASE WHEN g.bank_amount_cents>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
        IF v_uncategorized IS NULL THEN RAISE EXCEPTION 'ACCT_UNCATEGORIZED_ACCOUNT_REQUIRED'; END IF;
        v_lines:=jsonb_build_array(jsonb_build_object('account_id',g.bank_account_id,'amount_cents',g.bank_amount_cents::text,'memo',''),jsonb_build_object('account_id',v_uncategorized,'amount_cents',(-g.bank_amount_cents)::text,'memo',''));
      ELSE v_lines:=g.lines; END IF;
      -- Set provenance at creation, before any financial content is posted.
      INSERT INTO public.acct_journal_entries(id,entry_date,memo,primary_origin,created_by) VALUES(v_entry,g.entry_date,g.memo,batch.source_system,p_actor);
      saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',v_entry,'expected_version',1,'entry_date',g.entry_date,'memo',g.memo,'lines',v_lines));
      IF batch.mode='journal' THEN
        IF EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=v_entry AND p.purpose='opening_retained_earnings') THEN
         PERFORM public.acct_retained_review(v_entry,'historical',batch.source_document_id,(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount::text)) FROM (SELECT account_id,sum(amount_cents) amount FROM public.acct_journal_lines WHERE entry_id=v_entry GROUP BY account_id) controls),'Reviewed cash-basis source group imported with its original file',p_actor,NULL,g.id);
        END IF;
        PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',v_entry,'expected_version',saved->'version'));v_posted:=v_posted+1;
      ELSE v_drafted:=v_drafted+1; END IF;
      INSERT INTO public.acct_source_links(source_record_id,entry_id) VALUES(g.source_record_id,v_entry);
      UPDATE public.acct_import_groups SET status='applied',entry_id=v_entry,version=version+1 WHERE id=g.id;
    END LOOP;
    UPDATE public.acct_import_batches SET version=version+1,status='applying' WHERE id=v_id;
  ELSIF op='import.finish' THEN
    IF batch.status NOT IN ('review','applying') OR (SELECT count(*) FROM public.acct_import_groups WHERE batch_id=v_id)<>batch.expected_groups OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=v_id AND status NOT IN ('applied','duplicate','excluded')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
    UPDATE public.acct_import_batches SET status='completed',version=version+1 WHERE id=v_id;
  ELSIF op='import.cancel' THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_import_batches SET status='cancelled',version=version+1,error=p_command->>'reason' WHERE id=v_id;
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  SELECT jsonb_build_object('id',id,'version',version,'posted',v_posted,'drafted',v_drafted) INTO result FROM public.acct_import_batches WHERE id=v_id;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.acct_books_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;section text;rows jsonb;
BEGIN
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',6);
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations','bank_match_releases','retained_reviews'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
-- ACCOUNTING RETAINED REVIEW END

COMMIT;
