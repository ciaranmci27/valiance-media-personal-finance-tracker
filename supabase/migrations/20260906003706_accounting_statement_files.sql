BEGIN;
-- ACCOUNTING STATEMENT FILES BEGIN
CREATE TABLE public.acct_statement_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
 document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 file_hash text NOT NULL CHECK(file_hash~'^[a-f0-9]{64}$'),
 mapping_hash text NOT NULL CHECK(mapping_hash~'^[a-f0-9]{64}$'),
 mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reconciliation_id,document_id,mapping_hash)
);
CREATE TABLE public.acct_statement_item_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
 file_id uuid NOT NULL REFERENCES public.acct_statement_files(id),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 500),
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),
 -- Preserve the original identity after an unmatched item is removed. Restoration is explicit.
 original_item_id uuid NOT NULL UNIQUE,
 source_row integer NOT NULL CHECK(source_row>0),
 entry_date date NOT NULL,
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
 raw_payload jsonb NOT NULL CHECK(jsonb_typeof(raw_payload)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reconciliation_id,external_id)
);
CREATE TABLE public.acct_statement_amendments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
 previous_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 next_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
 before_value jsonb NOT NULL,
 after_value jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['acct_statement_files','acct_statement_item_sources','acct_statement_amendments'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
  EXECUTE format('CREATE TRIGGER acct_statement_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.acct_statement_header(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT to_jsonb(r)||jsonb_build_object('opening_cents',r.opening_cents::text,'ending_cents',r.ending_cents::text,'declared_debits_cents',r.declared_debits_cents::text,'declared_credits_cents',r.declared_credits_cents::text) FROM public.acct_reconciliations r WHERE id=p_id;
$$;
CREATE OR REPLACE FUNCTION public.acct_statement_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_reconciliations;x jsonb;existing public.acct_statement_item_sources;file_id uuid;item_id uuid;slot integer;added integer:=0;skipped integer:=0;restored integer:=0;previous jsonb;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 SELECT * INTO r FROM public.acct_reconciliations WHERE id=(p_command->>'id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 IF r.status<>'in_progress' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_FINAL'; END IF;
 IF r.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
 IF p_command->>'type'='statement.import' THEN
  IF NOT EXISTS(SELECT 1 FROM public.acct_documents WHERE id=(p_command->>'document_id')::uuid AND content_hash=p_command->>'file_hash' AND mime_type='text/csv') THEN RAISE EXCEPTION 'ACCT_STATEMENT_SOURCE_FILE'; END IF;
  IF jsonb_typeof(p_command->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  INSERT INTO public.acct_statement_files(reconciliation_id,document_id,file_hash,mapping_hash,mapping,created_by) VALUES(r.id,(p_command->>'document_id')::uuid,p_command->>'file_hash',p_command->>'mapping_hash',p_command->'mapping',p_actor) ON CONFLICT DO NOTHING;
  SELECT id INTO file_id FROM public.acct_statement_files WHERE reconciliation_id=r.id AND document_id=(p_command->>'document_id')::uuid AND mapping_hash=p_command->>'mapping_hash';
  FOR x IN SELECT value FROM jsonb_array_elements(p_command->'items') LOOP
   IF x->>'amount_cents' IS NULL OR x->>'amount_cents'!~'^-?[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   IF (x->>'entry_date')::date NOT BETWEEN r.from_date AND r.to_date THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
   SELECT * INTO existing FROM public.acct_statement_item_sources WHERE reconciliation_id=r.id AND external_id=x->>'external_id';
   IF FOUND THEN
    IF existing.fingerprint<>x->>'fingerprint' OR existing.entry_date<>(x->>'entry_date')::date OR existing.description<>x->>'description' OR existing.amount_cents<>(x->>'amount_cents')::bigint THEN RAISE EXCEPTION 'ACCT_STATEMENT_SOURCE_CHANGED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_statement_items WHERE id=existing.original_item_id) THEN skipped:=skipped+1;CONTINUE; END IF;
    IF (p_command->>'restore_removed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_STATEMENT_ITEM_REMOVED'; END IF;
    item_id:=existing.original_item_id;restored:=restored+1;
   ELSE item_id:=gen_random_uuid();added:=added+1; END IF;
   SELECT coalesce(max(ordinal)+1,0) INTO slot FROM public.acct_statement_items WHERE reconciliation_id=r.id;
   IF slot>=r.declared_count THEN SELECT n INTO slot FROM generate_series(0,r.declared_count-1) n WHERE NOT EXISTS(SELECT 1 FROM public.acct_statement_items WHERE reconciliation_id=r.id AND ordinal=n) ORDER BY n LIMIT 1; END IF;
   IF slot IS NULL THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
   INSERT INTO public.acct_statement_items(id,reconciliation_id,ordinal,entry_date,description,amount_cents) VALUES(item_id,r.id,slot,(x->>'entry_date')::date,x->>'description',(x->>'amount_cents')::bigint);
   IF existing.id IS NULL THEN INSERT INTO public.acct_statement_item_sources(reconciliation_id,file_id,external_id,fingerprint,original_item_id,source_row,entry_date,description,amount_cents,raw_payload) VALUES(r.id,file_id,x->>'external_id',x->>'fingerprint',item_id,(x->>'source_row')::integer,(x->>'entry_date')::date,x->>'description',(x->>'amount_cents')::bigint,x->'raw'); END IF;
  END LOOP;
  UPDATE public.acct_reconciliations SET notes=notes WHERE id=r.id;
 ELSIF p_command->>'type'='statement.amend' THEN
  IF length(btrim(coalesce(p_command->>'reason',''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_statement_items WHERE reconciliation_id=r.id AND (entry_date NOT BETWEEN (p_command->>'from')::date AND (p_command->>'to')::date OR ordinal>=(p_command->>'declared_count')::integer)) THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id<>r.id AND account_id=r.account_id AND status IN ('in_progress','completed') AND from_date<=(p_command->>'to')::date AND to_date>=(p_command->>'from')::date) THEN RAISE EXCEPTION 'ACCT_STATEMENT_OVERLAP'; END IF;
  IF nullif(p_command->>'predecessor_id','') IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id=(p_command->>'predecessor_id')::uuid AND status='completed' AND account_id=r.account_id AND to_date=(p_command->>'from')::date-1 AND ending_cents=(p_command->>'opening_cents')::bigint) THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id<>r.id AND account_id=r.account_id AND status='completed') THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
  previous:=public.acct_statement_header(r.id);
  IF r.from_date<>(p_command->>'from')::date OR r.opening_cents<>(p_command->>'opening_cents')::bigint OR r.predecessor_id IS DISTINCT FROM nullif(p_command->>'predecessor_id','')::uuid THEN DELETE FROM public.acct_reconciliation_opening WHERE reconciliation_id=r.id; END IF;
  UPDATE public.acct_reconciliations SET from_date=(p_command->>'from')::date,to_date=(p_command->>'to')::date,opening_cents=(p_command->>'opening_cents')::bigint,ending_cents=(p_command->>'ending_cents')::bigint,declared_count=(p_command->>'declared_count')::integer,declared_debits_cents=(p_command->>'declared_debits_cents')::bigint,declared_credits_cents=(p_command->>'declared_credits_cents')::bigint,document_id=(p_command->>'document_id')::uuid,predecessor_id=nullif(p_command->>'predecessor_id','')::uuid,notes=coalesce(p_command->>'notes','') WHERE id=r.id;
  INSERT INTO public.acct_statement_amendments(reconciliation_id,previous_document_id,next_document_id,before_value,after_value,reason,created_by) VALUES(r.id,r.document_id,(p_command->>'document_id')::uuid,previous,public.acct_statement_header(r.id),p_command->>'reason',p_actor);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 RETURN jsonb_build_object('id',r.id,'version',(SELECT version FROM public.acct_reconciliations WHERE id=r.id),'added',added,'skipped',skipped,'restored',restored);
END $$;
CREATE OR REPLACE FUNCTION public.acct_statement_documents_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.state='archived' AND OLD.state<>'archived' AND (EXISTS(SELECT 1 FROM public.acct_statement_files WHERE document_id=NEW.document_id) OR EXISTS(SELECT 1 FROM public.acct_statement_amendments WHERE NEW.document_id IN(previous_document_id,next_document_id))) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_statement_documents_guard BEFORE UPDATE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_statement_documents_guard();
CREATE OR REPLACE FUNCTION public.acct_statement_sources(p_statement uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('files',(SELECT coalesce(jsonb_agg(to_jsonb(f)||jsonb_build_object('original_name',d.original_name,'rows',(SELECT count(*) FROM public.acct_statement_item_sources WHERE file_id=f.id)) ORDER BY f.created_at,f.id),'[]') FROM public.acct_statement_files f JOIN public.acct_documents d ON d.id=f.document_id WHERE reconciliation_id=p_statement),'amendments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at,id),'[]') FROM public.acct_statement_amendments a WHERE reconciliation_id=p_statement));
END $$;
REVOKE ALL ON FUNCTION public.acct_statement_header(uuid),public.acct_statement_command(jsonb,uuid),public.acct_statement_documents_guard(),public.acct_statement_sources(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_statement_sources(uuid) TO authenticated;
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
  ELSIF p_command->>'type' LIKE 'statement.%' THEN result:=public.acct_statement_command(p_command,actor);
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
CREATE OR REPLACE FUNCTION public.acct_books_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;section text;rows jsonb;
BEGIN
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',7);
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations','bank_match_releases','retained_reviews','statement_files','statement_item_sources','statement_amendments'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
-- ACCOUNTING STATEMENT FILES END

COMMIT;
