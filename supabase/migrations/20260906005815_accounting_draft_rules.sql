BEGIN;
-- ACCOUNTING RULES BEGIN
CREATE OR REPLACE FUNCTION public.acct_normalize_description(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT lower(regexp_replace(btrim(coalesce(p_text,'')),'\s+',' ','g')); $$;
CREATE TABLE public.acct_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_rule_versions (
 rule_id uuid NOT NULL REFERENCES public.acct_rules(id),
 version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 priority integer NOT NULL CHECK(priority BETWEEN 1 AND 10000),
 enabled boolean NOT NULL DEFAULT false,
 description_mode text NOT NULL CHECK(description_mode IN ('exact','prefix','contains')),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 250),
 bank_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
 direction text NOT NULL CHECK(direction IN ('increase','decrease')),
 min_cents bigint NOT NULL CHECK(min_cents>=0),
 max_cents bigint NOT NULL CHECK(max_cents>0 AND max_cents>=min_cents),
 match_payee_id uuid REFERENCES public.acct_parties(id),
 category_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
 assign_payee_id uuid REFERENCES public.acct_parties(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(rule_id,version)
);
CREATE TABLE public.acct_payee_aliases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 party_id uuid NOT NULL REFERENCES public.acct_parties(id),
 match_mode text NOT NULL CHECK(match_mode IN ('exact','prefix')),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 250),
 enabled boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acct_alias_party ON public.acct_payee_aliases(party_id);
CREATE TABLE public.acct_rule_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rule_id uuid NOT NULL,
 rule_version integer NOT NULL,
 entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
 before_value jsonb NOT NULL,
 after_value jsonb NOT NULL,
 matched_aliases jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(rule_id,rule_version) REFERENCES public.acct_rule_versions(rule_id,version)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['acct_rules','acct_rule_versions','acct_payee_aliases','acct_rule_applications'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
  EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['acct_rule_versions','acct_rule_applications'] LOOP
  EXECUTE format('CREATE TRIGGER acct_rule_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_append_only()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.acct_rule_payee(p_description text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH matches AS (SELECT a.*,p.name FROM public.acct_payee_aliases a JOIN public.acct_parties p ON p.id=a.party_id AND NOT p.is_archived WHERE a.enabled AND CASE WHEN a.match_mode='exact' THEN public.acct_normalize_description(p_description)=public.acct_normalize_description(a.description) ELSE starts_with(public.acct_normalize_description(p_description),public.acct_normalize_description(a.description)) END)
 SELECT jsonb_build_object('party_id',CASE WHEN count(DISTINCT party_id)=1 THEN min(party_id::text) ELSE NULL END,'conflict',count(DISTINCT party_id)>1,'aliases',coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'party_id',party_id,'name',name,'description',description,'match_mode',match_mode) ORDER BY id),'[]')) FROM matches;
$$;
CREATE OR REPLACE FUNCTION public.acct_rule_candidate(p_entry uuid,p_rule uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.acct_journal_entries;bank public.acct_journal_lines;category public.acct_journal_lines;party uuid;aliases jsonb;matches jsonb;winner jsonb;reason text:='';payload jsonb;
BEGIN
 SELECT * INTO e FROM public.acct_journal_entries WHERE id=p_entry;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.acct_journal_lines WHERE entry_id=e.id)<>2 THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=e.id AND p.cash_kind IN ('bank','cash','card'))<>1 THEN RETURN NULL; END IF;
 SELECT l.* INTO bank FROM public.acct_journal_lines l JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE l.entry_id=e.id AND p.cash_kind IN ('bank','cash','card');
 SELECT l.* INTO category FROM public.acct_journal_lines l JOIN public.acct_accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND l.id<>bank.id AND a.account_type IN ('income','expense');
 IF NOT FOUND OR category.amount_cents<>-bank.amount_cents THEN RETURN NULL; END IF;
 aliases:=public.acct_rule_payee(e.memo);SELECT payee_id INTO party FROM public.acct_entry_context WHERE entry_id=e.id;
 party:=coalesce(party,(aliases->>'party_id')::uuid);
 SELECT coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('min_cents',v.min_cents::text,'max_cents',v.max_cents::text,'category_name',a.name) ORDER BY v.priority,v.rule_id),'[]') INTO matches
 FROM public.acct_rule_versions v JOIN public.acct_rules r ON r.id=v.rule_id AND r.version=v.version JOIN public.acct_accounts a ON a.id=v.category_account_id AND NOT a.is_archived
 WHERE (v.enabled OR v.rule_id=p_rule) AND v.bank_account_id=bank.account_id AND (v.direction='increase')=(bank.amount_cents>0) AND abs(bank.amount_cents::numeric) BETWEEN v.min_cents AND v.max_cents AND (v.match_payee_id IS NULL OR v.match_payee_id=party)
 AND CASE v.description_mode WHEN 'exact' THEN public.acct_normalize_description(e.memo)=public.acct_normalize_description(v.description) WHEN 'prefix' THEN starts_with(public.acct_normalize_description(e.memo),public.acct_normalize_description(v.description)) ELSE strpos(public.acct_normalize_description(e.memo),public.acct_normalize_description(v.description))>0 END;
 winner:=matches->0;
 IF winner IS NULL THEN reason:='No matching rule';
 ELSIF (aliases->>'conflict')::boolean THEN reason:='Conflicting payee aliases';
 ELSIF jsonb_array_length(matches)>1 AND matches->0->>'priority'=matches->1->>'priority' THEN reason:='Rules share the winning priority';
 ELSIF e.status<>'draft' THEN reason:='Posted history is preview only';
 ELSIF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE account_id=category.account_id AND purpose IN ('uncategorized_income','uncategorized_expense')) THEN reason:='Category already reviewed';
 ELSIF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',e.entry_date)::date) THEN reason:='Period is locked';
 ELSIF EXISTS(SELECT 1 FROM public.acct_source_links sl WHERE sl.entry_id=e.id AND public.acct_bank_source_used(sl.source_record_id)<>0) THEN reason:='Source already has bank allocations';
 ELSIF winner->>'assign_payee_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=(winner->>'assign_payee_id')::uuid AND NOT is_archived) THEN reason:='Assigned payee is archived';
 ELSIF EXISTS(SELECT 1 FROM public.acct_entry_context c WHERE c.entry_id=e.id AND c.payee_id IS NOT NULL AND winner->>'assign_payee_id' IS NOT NULL AND c.payee_id<>(winner->>'assign_payee_id')::uuid) THEN reason:='Payee already reviewed';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order) INTO payload FROM public.acct_journal_lines l WHERE l.entry_id=e.id;
 RETURN jsonb_build_object('id',e.id,'version',e.version,'entry_date',e.entry_date,'memo',e.memo,'status',e.status,'bank_account_id',bank.account_id,'bank_amount_cents',bank.amount_cents::text,'category_account_id',category.account_id,'category_line_id',category.id,'payee_id',party,'aliases',aliases,'matches',matches,'winner',winner,'eligible',reason='','reason',reason,'lines',payload);
END $$;
CREATE OR REPLACE FUNCTION public.acct_rules_view() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('id',v.rule_id,'min_cents',v.min_cents::text,'max_cents',v.max_cents::text,'history',(SELECT jsonb_agg(to_jsonb(h)||jsonb_build_object('min_cents',h.min_cents::text,'max_cents',h.max_cents::text) ORDER BY h.version DESC) FROM public.acct_rule_versions h WHERE h.rule_id=v.rule_id)) ORDER BY v.priority,v.name,v.rule_id),'[]') FROM public.acct_rules r JOIN public.acct_rule_versions v ON v.rule_id=r.id AND v.version=r.version),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name) ORDER BY a.description,a.id),'[]') FROM public.acct_payee_aliases a JOIN public.acct_parties p ON p.id=a.party_id));
END $$;
CREATE OR REPLACE FUNCTION public.acct_rules_preview(p_from date,p_to date,p_rule uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE rows jsonb;total integer;
BEGIN
 PERFORM public.acct_require_owner();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>3660 OR p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
 WITH candidates AS MATERIALIZED (SELECT public.acct_rule_candidate(e.id,p_rule) candidate FROM public.acct_journal_entries e WHERE e.entry_date BETWEEN p_from AND p_to AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries reversal WHERE reversal.reverses_entry_id=e.id))
 SELECT count(*),(SELECT coalesce(jsonb_agg(x.candidate ORDER BY x.candidate->>'entry_date',x.candidate->>'id'),'[]') FROM (SELECT candidate FROM candidates WHERE candidate IS NOT NULL AND jsonb_array_length(candidate->'matches')>0 AND (p_rule IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'matches') m WHERE m->>'rule_id'=p_rule::text)) ORDER BY candidate->>'entry_date',candidate->>'id' LIMIT 100 OFFSET p_offset) x) INTO total,rows FROM candidates WHERE candidate IS NOT NULL AND jsonb_array_length(candidate->'matches')>0 AND (p_rule IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'matches') m WHERE m->>'rule_id'=p_rule::text));
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'rows',rows,'total',total,'from',p_from,'to',p_to);
END $$;
CREATE OR REPLACE FUNCTION public.acct_rules_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';command_id uuid:=(p_command->>'id')::uuid;current_version integer;v public.acct_rule_versions;x jsonb;c jsonb;lines jsonb;saved jsonb;after_value jsonb;count integer:=0;assign uuid;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF op='alias.save' THEN
  SELECT a.version INTO current_version FROM public.acct_payee_aliases a WHERE a.id=command_id;
  IF coalesce(current_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=(p_command->>'party_id')::uuid AND (NOT is_archived OR (p_command->>'enabled')::boolean=false)) THEN RAISE EXCEPTION 'ACCT_INVALID_PAYEE'; END IF;
  INSERT INTO public.acct_payee_aliases(id,party_id,match_mode,description,enabled,created_by) VALUES(command_id,(p_command->>'party_id')::uuid,p_command->>'match_mode',public.acct_normalize_description(p_command->>'description'),(p_command->>'enabled')::boolean,p_actor)
  ON CONFLICT ON CONSTRAINT acct_payee_aliases_pkey DO UPDATE SET party_id=excluded.party_id,match_mode=excluded.match_mode,description=excluded.description,enabled=excluded.enabled,version=acct_payee_aliases.version+1;
  RETURN jsonb_build_object('id',command_id,'version',coalesce(current_version,0)+1);
 ELSIF op='rule.save' OR op='rule.activate' THEN
  SELECT r.version INTO current_version FROM public.acct_rules r WHERE r.id=command_id;
  IF coalesce(current_version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='rule.activate' THEN
   IF current_version IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF (p_command->>'reviewed')::boolean IS DISTINCT FROM true OR (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   SELECT * INTO v FROM public.acct_rule_versions WHERE rule_id=command_id AND acct_rule_versions.version=current_version;
  ELSE
   IF jsonb_typeof(p_command->'min_cents') IS DISTINCT FROM 'string' OR jsonb_typeof(p_command->'max_cents') IS DISTINCT FROM 'string' OR p_command->>'min_cents'!~'^[0-9]{1,19}$' OR p_command->>'max_cents'!~'^[0-9]{1,19}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
   v:=jsonb_populate_record(NULL::public.acct_rule_versions,p_command);
   v.enabled:=false;v.description:=public.acct_normalize_description(v.description);
  END IF;
  IF op='rule.save' OR (p_command->>'enabled')::boolean=true THEN
  IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id=v.bank_account_id AND p.cash_kind IN ('bank','cash','card') AND NOT a.is_archived) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.acct_accounts a LEFT JOIN public.acct_account_profiles p ON p.account_id=a.id WHERE a.id=v.category_account_id AND NOT a.is_archived AND a.account_type IN ('income','expense') AND coalesce(p.purpose,'') NOT IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_RULE_CATEGORY'; END IF;
  IF v.assign_payee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=v.assign_payee_id AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_PAYEE'; END IF;
  IF v.match_payee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.acct_parties WHERE id=v.match_payee_id AND NOT is_archived) THEN RAISE EXCEPTION 'ACCT_INVALID_PAYEE'; END IF;
  END IF;
  INSERT INTO public.acct_rules(id,created_by) VALUES(command_id,p_actor) ON CONFLICT ON CONSTRAINT acct_rules_pkey DO UPDATE SET version=acct_rules.version+1;
  INSERT INTO public.acct_rule_versions(rule_id,version,name,priority,enabled,description_mode,description,bank_account_id,direction,min_cents,max_cents,match_payee_id,category_account_id,assign_payee_id,reason,created_by)
  VALUES(command_id,coalesce(current_version,0)+1,v.name,v.priority,CASE WHEN op='rule.activate' THEN (p_command->>'enabled')::boolean ELSE false END,v.description_mode,v.description,v.bank_account_id,v.direction,v.min_cents,v.max_cents,v.match_payee_id,v.category_account_id,v.assign_payee_id,p_command->>'reason',p_actor);
  RETURN jsonb_build_object('id',command_id,'version',coalesce(current_version,0)+1);
 ELSIF op='rule.apply' THEN
  IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF jsonb_typeof(p_command->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'entries') NOT BETWEEN 1 AND 100 OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_command->'entries'))<>jsonb_array_length(p_command->'entries') THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_command->'entries') LOOP
   c:=public.acct_rule_candidate((x->>'id')::uuid,NULL);
   IF c IS NULL OR (c->>'eligible')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_RULE_INELIGIBLE'; END IF;
   IF c->>'version' IS DISTINCT FROM x->>'expected_version' OR c->'winner'->>'rule_id' IS DISTINCT FROM x->>'rule_id' OR c->'winner'->>'version' IS DISTINCT FROM x->>'rule_version' THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   SELECT jsonb_agg(CASE WHEN l->>'account_id'=c->>'category_account_id' THEN l||jsonb_build_object('account_id',c->'winner'->>'category_account_id') ELSE l END ORDER BY ordinal) INTO lines FROM jsonb_array_elements(c->'lines') WITH ORDINALITY AS item(l,ordinal);
   saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',c->>'id','expected_version',c->'version','entry_date',c->>'entry_date','memo',c->>'memo','lines',lines));
   assign:=coalesce((c->'winner'->>'assign_payee_id')::uuid,(c->>'payee_id')::uuid);
   IF assign IS NOT NULL THEN INSERT INTO public.acct_entry_context(entry_id,payee_id) VALUES((c->>'id')::uuid,assign) ON CONFLICT(entry_id) DO UPDATE SET payee_id=excluded.payee_id; END IF;
   after_value:=jsonb_build_object('version',saved->'version','lines',lines,'payee_id',assign);
   INSERT INTO public.acct_rule_applications(rule_id,rule_version,entry_id,before_value,after_value,matched_aliases,created_by) VALUES((c->'winner'->>'rule_id')::uuid,(c->'winner'->>'version')::integer,(c->>'id')::uuid,c,after_value,c->'aliases',p_actor);count:=count+1;
  END LOOP;
  RETURN jsonb_build_object('id',command_id,'count',count);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $$;
REVOKE ALL ON FUNCTION public.acct_normalize_description(text),public.acct_rule_payee(text),public.acct_rule_candidate(uuid,uuid),public.acct_rules_view(),public.acct_rules_preview(date,date,uuid,integer),public.acct_rules_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_rules_view(),public.acct_rules_preview(date,date,uuid,integer) TO authenticated;
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
  ELSIF p_command->>'type' LIKE 'rule.%' OR p_command->>'type'='alias.save' THEN result:=public.acct_rules_command(p_command,actor);
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
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',8);
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups','history_dispositions','history_review_invalidations','bank_match_releases','retained_reviews','statement_files','statement_item_sources','statement_amendments','rules','rule_versions','payee_aliases','rule_applications'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.acct_bank_posting_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE match public.acct_bank_matches;
BEGIN
 IF NEW.status='posted' AND OLD.status='draft' THEN
  IF NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.acct_import_groups g WHERE g.bank_account_id IS NOT NULL AND (g.entry_id=NEW.id OR EXISTS(SELECT 1 FROM public.acct_source_links WHERE entry_id=NEW.id AND source_record_id=g.source_record_id)) AND (g.entry_date<>NEW.entry_date OR g.bank_amount_cents IS DISTINCT FROM (SELECT sum(amount_cents) FROM public.acct_journal_lines WHERE entry_id=NEW.id AND account_id=g.bank_account_id))) THEN RAISE EXCEPTION 'ACCT_BANK_SOURCE_CHANGED'; END IF;
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
CREATE OR REPLACE FUNCTION public.acct_entry_evidence(p_entry uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object(
    'rules',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('rule_name',v.name) ORDER BY a.created_at,a.id),'[]') FROM public.acct_rule_applications a JOIN public.acct_rule_versions v ON v.rule_id=a.rule_id AND v.version=a.rule_version WHERE a.entry_id=p_entry),
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY observed_at),'[]') FROM public.acct_source_records s JOIN public.acct_source_links l ON l.source_record_id=s.id WHERE l.entry_id=p_entry),
    'notes',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at),'[]') FROM public.acct_annotations a WHERE entry_id=p_entry),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('size_bytes',d.size_bytes::text)),'[]') FROM public.acct_documents d JOIN public.acct_document_links l ON l.document_id=d.id WHERE l.entry_id=p_entry),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY recorded_at,id),'[]') FROM public.acct_audit_log a WHERE
      coalesce(a.after_value->>'id',a.before_value->>'id')=p_entry::text OR coalesce(a.after_value->>'entry_id',a.before_value->>'entry_id')=p_entry::text));
END $$;
-- ACCOUNTING RULES END

COMMIT;
