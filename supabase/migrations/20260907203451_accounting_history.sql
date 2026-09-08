BEGIN;
-- ACCOUNTING HISTORY BEGIN
CREATE TABLE accounting.import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('journal','bank')),source text NOT NULL CHECK(source IN ('wave','csv','simplefin')),
 document_id uuid REFERENCES accounting.documents ON DELETE RESTRICT,file_hash text UNIQUE CHECK(file_hash ~ '^[0-9a-f]{64}$'),mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','applying','completed','cancelled')),row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 50000),applied_count integer NOT NULL DEFAULT 0 CHECK(applied_count>=0),checkpoint integer NOT NULL DEFAULT 0 CHECK(checkpoint>=0),
 control_totals jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(control_totals)='object'),coverage_from date NOT NULL,coverage_to date NOT NULL CHECK(coverage_to>=coverage_from),
 parity_status text NOT NULL CHECK(parity_status IN ('n/a','pending','verified','mismatch')),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='bank' AND parity_status='n/a') OR (kind='journal' AND parity_status<>'n/a')),CHECK(applied_count<=row_count)
);
CREATE TABLE accounting.import_rows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES accounting.import_batches ON DELETE RESTRICT,ordinal integer NOT NULL CHECK(ordinal>=0),external_id text,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),raw jsonb NOT NULL,parsed jsonb NOT NULL CHECK(jsonb_typeof(parsed)='object'),
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','duplicate','exception','applied','excluded')),entry_id uuid REFERENCES accounting.journal_entries ON DELETE RESTRICT,
 duplicate_of_entry_id uuid REFERENCES accounting.journal_entries ON DELETE RESTRICT,reason text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,ordinal),UNIQUE(batch_id,external_id),CHECK(status<>'applied' OR entry_id IS NOT NULL)
);
CREATE INDEX import_rows_identity ON accounting.import_rows(external_id,fingerprint);
CREATE INDEX import_rows_queue ON accounting.import_rows(batch_id,status,ordinal);
CREATE TABLE accounting.history_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),fiscal_year smallint NOT NULL CHECK(fiscal_year BETWEEN 1900 AND 2200),kind text NOT NULL CHECK(kind IN ('annual_totals','opening_balances')),
 expected jsonb NOT NULL,actual jsonb NOT NULL,difference jsonb NOT NULL,status text NOT NULL CHECK(status IN ('matches','explained','mismatch')),explanation text NOT NULL DEFAULT '',
 document_id uuid NOT NULL REFERENCES accounting.documents ON DELETE RESTRICT,checked_by uuid NOT NULL REFERENCES auth.users ON DELETE RESTRICT,checked_at timestamptz NOT NULL DEFAULT now(),CHECK(status<>'explained' OR length(btrim(explanation))>0)
);
CREATE INDEX history_checks_latest ON accounting.history_checks(fiscal_year,kind,checked_at DESC,id);
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_import_fk FOREIGN KEY(import_batch_id) REFERENCES accounting.import_batches ON DELETE RESTRICT;
ALTER TABLE accounting.bank_transactions ADD CONSTRAINT observations_import_fk FOREIGN KEY(import_batch_id) REFERENCES accounting.import_batches ON DELETE RESTRICT;
ALTER TABLE accounting.document_links ADD CONSTRAINT document_import_fk FOREIGN KEY(import_batch_id) REFERENCES accounting.import_batches ON DELETE RESTRICT;
CREATE FUNCTION accounting.history_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
   UPDATE accounting.history_checks SET status='mismatch' WHERE id IN (
    SELECT DISTINCT ON(fiscal_year,kind) id FROM accounting.history_checks WHERE fiscal_year>=extract(year FROM NEW.entry_date)::integer ORDER BY fiscal_year,kind,checked_at DESC,id DESC
   ) AND status<>'mismatch';
   UPDATE accounting.import_batches SET parity_status='mismatch' WHERE kind='journal' AND parity_status='verified' AND coverage_to>=NEW.entry_date;
  END IF;RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='history_checks' THEN
   IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NEW.status<>'mismatch' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_HISTORY';END IF;
  ELSE
   IF TG_TABLE_NAME='import_rows' THEN
    IF (NEW.batch_id,NEW.ordinal,NEW.external_id,NEW.fingerprint,NEW.raw,NEW.parsed) IS DISTINCT FROM (OLD.batch_id,OLD.ordinal,OLD.external_id,OLD.fingerprint,OLD.raw,OLD.parsed) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE';END IF;
   END IF;
   IF TG_TABLE_NAME='import_batches' THEN
    IF (NEW.kind,NEW.source,NEW.file_hash,NEW.mapping,NEW.row_count,NEW.coverage_from,NEW.coverage_to) IS DISTINCT FROM (OLD.kind,OLD.source,OLD.file_hash,OLD.mapping,OLD.row_count,OLD.coverage_from,OLD.coverage_to) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_EVIDENCE';END IF;
   END IF;
   NEW.version:=OLD.version+1;NEW.updated_at:=now();
  END IF;
 END IF;
 UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 RETURN NEW;
END $fn$;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['import_batches','import_rows','history_checks'] LOOP
  EXECUTE format('ALTER TABLE accounting.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON accounting.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER write_lock BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH STATEMENT EXECUTE FUNCTION accounting.history_guard()',t);
  EXECUTE format('CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.history_guard()',t);
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.record_audit()',t);
 END LOOP;
END $triggers$;
CREATE TRIGGER history_invalidate AFTER INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.history_guard();
CREATE FUNCTION accounting.history_preview(controls jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE start_date date:=(controls->>'from')::date;end_date date:=(controls->>'to')::date;expected jsonb:=coalesce(controls->'expected','{}');actual jsonb;difference jsonb:='{}';
 monthly jsonb:='[]';account_rows jsonb:='[]';balance jsonb;balances jsonb;period_report jsonb;item jsonb;source_row jsonb;value_key text;actual_value text;expected_value text;difference_count integer:=0;drafts integer;errors integer;
BEGIN
 PERFORM accounting.require_owner();
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR extract(year FROM start_date)<>extract(year FROM end_date) THEN RAISE EXCEPTION 'ACCT_HISTORY_SCOPE';END IF;
 balance:=accounting.report('balance_sheet',jsonb_build_object('as_of',end_date));
 actual:=accounting.report(CASE WHEN controls->>'kind'='opening_balances' THEN 'balance_sheet' ELSE 'profit_loss' END,jsonb_build_object('from',start_date,'to',end_date,'as_of',end_date));
 actual:=balance||actual;
 IF controls?'expected' THEN
  IF NOT(expected ?& CASE WHEN controls->>'kind'='opening_balances' THEN ARRAY['assets_cents','liabilities_cents','equity_total_cents'] ELSE ARRAY['income_cents','expense_cents','net_income_cents'] END) THEN RAISE EXCEPTION 'ACCT_CONTROL_TOTALS_REQUIRED';END IF;
  FOR value_key,expected_value IN SELECT key,value FROM jsonb_each_text(expected) LOOP
   actual_value:=actual->>value_key;
   IF actual_value IS NULL OR expected_value!~'^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_UNKNOWN_CONTROL';END IF;
   difference:=difference||jsonb_build_object(value_key,(actual_value::numeric-expected_value::numeric)::text);
   IF actual_value::numeric<>expected_value::numeric THEN difference_count:=difference_count+1;END IF;
  END LOOP;
 ELSE
  IF jsonb_typeof(controls->'monthly') IS DISTINCT FROM 'array' OR jsonb_typeof(controls->'accounts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_CONTROL_TOTALS_REQUIRED';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'monthly') m GROUP BY date_trunc('month',(m->>'from')::date) HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_DUPLICATE_CONTROL';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'accounts') a WHERE NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id::text=a->>'account_id')) THEN RAISE EXCEPTION 'ACCT_UNKNOWN_CONTROL';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'accounts') a GROUP BY a->>'account_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_DUPLICATE_CONTROL';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(controls->'monthly','[]')) LOOP
   IF (item->>'from')::date<start_date OR (item->>'to')::date>end_date OR (item->>'from')::date>(item->>'to')::date THEN RAISE EXCEPTION 'ACCT_HISTORY_SCOPE';END IF;
   IF (item->>'from')::date<>greatest(start_date,date_trunc('month',(item->>'from')::date)::date) OR (item->>'to')::date<>least(end_date,(date_trunc('month',(item->>'from')::date)+interval '1 month -1 day')::date) THEN RAISE EXCEPTION 'ACCT_HISTORY_SCOPE';END IF;
   period_report:=accounting.report('profit_loss',jsonb_build_object('from',item->'from','to',item->'to'));
   FOREACH value_key IN ARRAY ARRAY['income_cents','expense_cents','net_income_cents'] LOOP
    IF period_report->>value_key IS DISTINCT FROM item->>value_key THEN difference_count:=difference_count+1;END IF;
   END LOOP;
   monthly:=monthly||jsonb_build_array(jsonb_build_object('from',item->'from','to',item->'to','actual',period_report,'source',item));
  END LOOP;
  IF jsonb_array_length(monthly)<> (extract(year FROM end_date)::integer-extract(year FROM start_date)::integer)*12+extract(month FROM end_date)::integer-extract(month FROM start_date)::integer+1 THEN difference_count:=difference_count+1;END IF;
  balances:=accounting.report('account_balances',jsonb_build_object('from',start_date,'to',end_date));
  FOR item IN SELECT value FROM jsonb_array_elements(balances->'rows') LOOP
   actual_value:=CASE WHEN item->>'account_type' IN ('income','expense') THEN item->>'movement_cents' ELSE item->>'ending_cents' END;
   SELECT value INTO source_row FROM jsonb_array_elements(controls->'accounts') a WHERE a->>'account_id'=item->>'id';
   IF actual_value::numeric<>0 AND source_row IS NULL THEN difference_count:=difference_count+1;
   ELSIF source_row IS NOT NULL AND actual_value IS DISTINCT FROM source_row->>'amount_cents' THEN difference_count:=difference_count+1;END IF;
   account_rows:=account_rows||jsonb_build_array(jsonb_build_object('account_id',item->'id','code',item->'code','name',item->'name','account_type',item->'account_type','actual_cents',actual_value,'source_cents',source_row->'amount_cents','required',actual_value::numeric<>0));
  END LOOP;
  FOREACH value_key IN ARRAY ARRAY['assets_cents','liabilities_cents','equity_total_cents'] LOOP
   IF balance->>value_key IS DISTINCT FROM controls->'totals'->>value_key THEN difference_count:=difference_count+1;END IF;
  END LOOP;
  difference:=jsonb_build_object('differences',difference_count);
  actual:=jsonb_build_object('monthly',monthly,'accounts',account_rows,'totals',balance);
 END IF;
 SELECT count(*) INTO drafts FROM accounting.journal_entries WHERE entry_date BETWEEN start_date AND end_date AND status='draft';
 SELECT count(*) INTO errors FROM accounting.import_rows r JOIN accounting.import_batches b ON b.id=r.batch_id WHERE b.kind='journal' AND (r.parsed->>'entry_date')::date BETWEEN start_date AND end_date AND r.status IN ('ready','exception');
 RETURN jsonb_build_object('from',start_date,'to',end_date,'revision',(SELECT financial_revision::text FROM accounting.settings),'ready',difference_count=0 AND drafts=0 AND errors=0,
 'scope_ended',true,'entity_verified',true,'partial_year',start_date<>make_date(extract(year FROM start_date)::integer,1,1) OR end_date<>make_date(extract(year FROM end_date)::integer,12,31),
 'differences',difference_count,'source_errors',errors,'drafts',drafts,'unclassified_accounts',0,'required_accounts',(SELECT count(*) FROM jsonb_array_elements(account_rows) a WHERE (a->>'required')::boolean),
 'monthly',monthly,'accounts',account_rows,'reports',balance,'actual',actual,'difference',difference);
END $fn$;
CREATE FUNCTION accounting.history_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t text:=c->>'type';key uuid:=(c->>'id')::uuid;actor uuid:=accounting.require_owner();b accounting.import_batches;r accounting.import_rows;prior accounting.import_rows;
 x jsonb;proposal jsonb;result jsonb;kind text;source text;v integer;posted integer:=0;drafted integer:=0;skipped integer:=0;row_status text;why text;
 movement accounting.bank_accounts;observation accounting.bank_transactions;line uuid;candidate_count integer;category uuid;allocation bigint;financial_date date;amount bigint;all_complete boolean;expected jsonb;actual jsonb;differences jsonb;fiscal integer;
BEGIN
 IF t='import.create' THEN
  SELECT * INTO b FROM accounting.import_batches WHERE file_hash=c->>'file_hash';
  IF FOUND THEN
   IF b.mapping->>'mapping_hash' IS DISTINCT FROM c->>'mapping_hash' THEN RAISE EXCEPTION 'ACCT_IMPORT_MAPPING_CONFLICT';END IF;
   RETURN jsonb_build_object('id',b.id,'version',b.version);
  END IF;
  kind:=coalesce(c->>'kind',c->>'mode');source:=coalesce(c->>'source',c->>'source_system');
  IF kind='journal' AND c->>'basis' IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'ACCT_CASH_BASIS_REQUIRED';END IF;
  INSERT INTO accounting.import_batches(id,kind,source,document_id,file_hash,mapping,row_count,coverage_from,coverage_to,parity_status,created_by,control_totals)
   VALUES(key,kind,source,coalesce(c->>'document_id',c->>'source_document_id')::uuid,c->>'file_hash',coalesce(c->'mapping','{}')||jsonb_build_object('mapping_version',1,'mapping_hash',c->'mapping_hash','source_scope',c->'source_scope','file_name',c->'file_name','basis',c->'basis'),
    (c->>'expected_groups')::integer,(c->>'from')::date,(c->>'to')::date,CASE kind WHEN 'bank' THEN 'n/a' ELSE 'pending' END,actor,coalesce(c->'control_totals','{}')) RETURNING version INTO v;
 ELSIF t IN ('import.stage','import.apply','import.finish','import.cancel','import.resume') THEN
  SELECT * INTO b FROM accounting.import_batches WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF b.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t IN ('import.cancel','import.resume') AND b.status='completed' THEN RAISE EXCEPTION 'ACCT_IMPORT_FINAL';END IF;
  IF t IN ('import.stage','import.apply','import.finish') AND b.status IN ('cancelled','completed') THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_ACTIVE';END IF;
  IF t='import.stage' THEN
   IF jsonb_array_length(c->'groups') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_CHUNK_REQUIRED';END IF;
   FOR x IN SELECT value FROM jsonb_array_elements(c->'groups') LOOP
    proposal:=x-ARRAY['id','ordinal','raw','fingerprint'];financial_date:=(x->>'entry_date')::date;row_status:='ready';why:='';prior:=NULL;
    IF financial_date NOT BETWEEN b.coverage_from AND b.coverage_to OR financial_date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_IMPORT_DATE_RANGE';END IF;
    IF (x->>'ordinal')::integer>=b.row_count THEN RAISE EXCEPTION 'ACCT_IMPORT_ROW_COUNT';END IF;
    IF jsonb_array_length(coalesce(x->'errors','[]'))>0 THEN row_status:='exception';why:='Source parsing errors require correction in a new import.';END IF;
    IF b.kind='journal' AND jsonb_array_length(coalesce(x->'lines','[]'))=0 AND x->>'exclusion_reason' IS NOT NULL THEN row_status:='excluded';why:=x->>'exclusion_reason';END IF;
    SELECT i.* INTO prior FROM accounting.import_rows i JOIN accounting.import_batches ib ON ib.id=i.batch_id
     WHERE ib.source=b.source AND ib.kind=b.kind AND ib.mapping->>'source_scope'=b.mapping->>'source_scope' AND i.external_id=x->>'external_id' AND ib.id<>b.id
     ORDER BY (i.entry_id IS NOT NULL) DESC,ib.created_at DESC,i.id LIMIT 1;
    IF prior.id IS NOT NULL THEN
     IF prior.fingerprint=x->>'fingerprint' AND prior.entry_id IS NOT NULL THEN row_status:='duplicate';why:='Identical source identity already imported';
     ELSIF prior.fingerprint<>x->>'fingerprint' THEN row_status:='exception';why:='Source identity changed; compare and correct the posted entry with a reason';END IF;
    END IF;
    INSERT INTO accounting.import_rows(id,batch_id,ordinal,external_id,fingerprint,raw,parsed,status,duplicate_of_entry_id,reason)
     VALUES((x->>'id')::uuid,key,(x->>'ordinal')::integer,x->>'external_id',x->>'fingerprint',x->'raw',proposal,row_status,prior.entry_id,why);
    IF b.kind='bank' THEN
     SELECT * INTO movement FROM accounting.bank_accounts WHERE account_id=(x->>'bank_account_id')::uuid;
     IF NOT FOUND THEN
      INSERT INTO accounting.bank_accounts(account_id,coverage_from) VALUES((x->>'bank_account_id')::uuid,financial_date) RETURNING * INTO movement;
     END IF;
     SELECT * INTO observation FROM accounting.bank_transactions WHERE bank_account_id=movement.id AND external_id=x->>'external_id';
     IF FOUND AND (observation.content_hash IS DISTINCT FROM x->>'source_hash' OR observation.amount_cents<>(x->>'bank_amount_cents')::bigint OR observation.posted_date<>financial_date) THEN
      UPDATE accounting.import_rows SET status='exception',reason='Provider identity changed; immutable observation retained' WHERE id=(x->>'id')::uuid;
     ELSIF NOT FOUND THEN
      INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,amount_cents,description,descriptor_key,content_hash,raw_payload,state,import_batch_id)
       VALUES(movement.id,b.source,x->>'external_id',financial_date,(x->>'bank_amount_cents')::bigint,x->>'memo',accounting.descriptor_key(x->>'memo'),coalesce(x->>'source_hash',x->>'fingerprint'),x->'raw','posted',b.id);
     END IF;
    END IF;
   END LOOP;
  ELSIF t='import.apply' THEN
   IF jsonb_array_length(c->'group_ids') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'ACCT_IMPORT_CHUNK_REQUIRED';END IF;
   IF (SELECT count(*) FROM accounting.import_rows WHERE batch_id=key AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(c->'group_ids')))<>jsonb_array_length(c->'group_ids') THEN RAISE EXCEPTION 'ACCT_IMPORT_ROWS_REQUIRED';END IF;
   FOR r IN SELECT * FROM accounting.import_rows WHERE batch_id=key AND id IN(SELECT value::text::uuid FROM jsonb_array_elements_text(c->'group_ids')) ORDER BY ordinal LOOP
    IF r.status IN ('applied','duplicate','excluded') THEN skipped:=skipped+1;CONTINUE;END IF;
    IF r.status='exception' THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION';END IF;
    proposal:=r.parsed;
    IF jsonb_array_length(coalesce(proposal->'errors','[]'))>0 THEN RAISE EXCEPTION 'ACCT_IMPORT_EXCEPTION';END IF;
    IF proposal->>'exclusion_reason' IS NOT NULL AND jsonb_array_length(proposal->'lines')=0 THEN UPDATE accounting.import_rows SET status='excluded',reason=proposal->>'exclusion_reason' WHERE id=r.id;skipped:=skipped+1;CONTINUE;END IF;
    IF r.duplicate_of_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.import_rows i WHERE i.entry_id=r.duplicate_of_entry_id AND i.fingerprint=r.fingerprint) THEN UPDATE accounting.import_rows SET status='duplicate' WHERE id=r.id;skipped:=skipped+1;CONTINUE;END IF;
    IF r.duplicate_of_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_CORRECTION_REQUIRED';END IF;
    IF b.kind='journal' THEN
     result:=accounting.ledger_command(proposal||jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'origin',b.source,'kind',coalesce(proposal->>'kind','manual'),'import_batch_id',b.id));
     result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',result->'id','expected_version',result->'version'));posted:=posted+1;
    ELSE
     SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts ba ON ba.id=o.bank_account_id WHERE ba.account_id=(proposal->>'bank_account_id')::uuid AND o.external_id=r.external_id;
     IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_SOURCE_REQUIRED';END IF;
     IF observation.review='excluded' THEN RAISE EXCEPTION 'ACCT_SOURCE_EXCLUDED';END IF;
     SELECT m.journal_line_id INTO line FROM accounting.bank_matches m WHERE bank_transaction_id=observation.id LIMIT 1;
     IF line IS NOT NULL THEN
      result:=jsonb_build_object('id',(SELECT entry_id FROM accounting.journal_lines WHERE id=line));
     ELSE
      amount:=observation.amount_cents;
      SELECT count(*),(array_agg(l.id ORDER BY l.id))[1] INTO candidate_count,line FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
       WHERE l.account_id=(proposal->>'bank_account_id')::uuid AND l.amount_cents=amount AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id) AND abs(e.entry_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings)
        AND (NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=l.id) OR EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions o ON o.id=m.bank_transaction_id WHERE m.journal_line_id=l.id AND m.amount_cents=abs(amount) AND o.source<>observation.source));
      IF candidate_count=1 THEN
       allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=line) THEN 0 ELSE abs(amount) END;
       INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,line,allocation,actor);
       result:=jsonb_build_object('id',(SELECT entry_id FROM accounting.journal_lines WHERE id=line));
      ELSE
       SELECT id INTO category FROM accounting.accounts WHERE system_purpose=CASE WHEN amount>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
       result:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',observation.posted_date,'memo',observation.description,'source_description',observation.description,'origin',b.source,'kind',CASE WHEN amount>0 THEN 'income' ELSE 'expense' END,'import_batch_id',b.id,
        'lines',jsonb_build_array(jsonb_build_object('account_id',proposal->'bank_account_id','amount_cents',amount::text),jsonb_build_object('account_id',category,'amount_cents',(-amount)::text))));
       SELECT id INTO line FROM accounting.journal_lines WHERE entry_id=(result->>'id')::uuid AND account_id=(proposal->>'bank_account_id')::uuid;
       INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,line,abs(amount),actor);
       PERFORM accounting.apply_treatment((result->>'id')::uuid);drafted:=drafted+1;
      END IF;
     END IF;
    END IF;
    UPDATE accounting.import_rows SET status='applied',entry_id=(result->>'id')::uuid WHERE id=r.id;
   END LOOP;
  ELSIF t='import.finish' THEN
   IF (SELECT count(*) FROM accounting.import_rows WHERE batch_id=key)<>b.row_count OR EXISTS(SELECT 1 FROM accounting.import_rows WHERE batch_id=key AND status IN ('ready','exception')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE';END IF;
  ELSIF t='import.cancel' THEN
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   UPDATE accounting.import_rows SET status='ready' WHERE batch_id=key AND status<>'applied';
  ELSIF t='import.resume' THEN
   IF b.status<>'cancelled' THEN RAISE EXCEPTION 'ACCT_IMPORT_NOT_CANCELLED';END IF;
  END IF;
  UPDATE accounting.import_batches SET status=CASE t WHEN 'import.cancel' THEN 'cancelled' WHEN 'import.resume' THEN 'staged' WHEN 'import.finish' THEN 'completed' WHEN 'import.apply' THEN 'applying' ELSE status END,
   applied_count=(SELECT count(*) FROM accounting.import_rows WHERE batch_id=key AND status='applied'),checkpoint=(SELECT coalesce(max(ordinal)+1,0) FROM accounting.import_rows WHERE batch_id=key AND status IN ('applied','duplicate','excluded')) WHERE id=key RETURNING version INTO v;
 ELSIF t='import.resolve' THEN
  SELECT * INTO r FROM accounting.import_rows WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF r.status='applied' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_HISTORY';END IF;
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
  IF c->>'resolution'='exclude' THEN UPDATE accounting.import_rows SET status='excluded',reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSIF c->>'resolution'='match' THEN
   IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=(c->>'entry_id')::uuid AND status='posted') THEN RAISE EXCEPTION 'ACCT_POSTED_ENTRY_REQUIRED';END IF;
   SELECT * INTO b FROM accounting.import_batches WHERE id=r.batch_id;
   IF b.kind='bank' THEN
    SELECT o.* INTO observation FROM accounting.bank_transactions o JOIN accounting.bank_accounts ba ON ba.id=o.bank_account_id WHERE ba.account_id=(r.parsed->>'bank_account_id')::uuid AND o.external_id=r.external_id;
    SELECT l.id INTO line FROM accounting.journal_lines l WHERE entry_id=(c->>'entry_id')::uuid AND account_id=(r.parsed->>'bank_account_id')::uuid AND amount_cents=observation.amount_cents;
    IF line IS NULL OR observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH';END IF;
    allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=line) THEN 0 ELSE abs(observation.amount_cents) END;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents,created_by) VALUES(observation.id,line,allocation,actor);
   ELSE
    IF (SELECT entry_date FROM accounting.journal_entries WHERE id=(c->>'entry_id')::uuid) IS DISTINCT FROM (r.parsed->>'entry_date')::date OR
     (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM accounting.journal_lines WHERE entry_id=(c->>'entry_id')::uuid) IS DISTINCT FROM
     (SELECT jsonb_agg(jsonb_build_array((value->>'account_id')::uuid,((value->>'amount_cents')::bigint)::text) ORDER BY (value->>'account_id')::uuid,(value->>'amount_cents')::bigint) FROM jsonb_array_elements(r.parsed->'lines')) THEN RAISE EXCEPTION 'ACCT_MATCH_MISMATCH';END IF;
   END IF;
   UPDATE accounting.import_rows SET status='duplicate',entry_id=(c->>'entry_id')::uuid,duplicate_of_entry_id=(c->>'entry_id')::uuid,reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSIF c->>'resolution'='correct' THEN
   SELECT * INTO b FROM accounting.import_batches WHERE id=r.batch_id;
   IF b.kind<>'journal' OR r.duplicate_of_entry_id IS NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_CORRECTION_REQUIRED';END IF;
   result:=accounting.ledger_command(r.parsed||jsonb_build_object('type','entry.correct','id',r.duplicate_of_entry_id,'expected_version',(SELECT version FROM accounting.journal_entries WHERE id=r.duplicate_of_entry_id),'reason',c->>'reason'));
   UPDATE accounting.import_rows SET status='applied',entry_id=(result->>'id')::uuid,reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSIF c->>'resolution'='new' THEN
   IF r.duplicate_of_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_IMPORT_CORRECTION_REQUIRED';END IF;
   UPDATE accounting.import_rows SET status='ready',reason=c->>'reason' WHERE id=key RETURNING version INTO v;
  ELSE RAISE EXCEPTION 'ACCT_INVALID_RESOLUTION';END IF;
 ELSIF t='history.lock' THEN
  SELECT h.expected INTO expected FROM accounting.history_checks h WHERE h.id=(c->>'history_id')::uuid AND h.status IN ('matches','explained');
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_HISTORY_NOT_READY';END IF;
  FOR financial_date IN SELECT d::date FROM generate_series(date_trunc('month',(expected->>'from')::date),date_trunc('month',(expected->>'to')::date),interval '1 month') d LOOP
   PERFORM accounting.close_command(jsonb_build_object('type','period.lock','id',gen_random_uuid(),'month',financial_date));
  END LOOP;
 ELSIF t IN ('history.check','history.verify') THEN
  fiscal:=coalesce((c->>'fiscal_year')::integer,extract(year FROM (c->>'from')::date)::integer);kind:=coalesce(c->>'kind',CASE WHEN fiscal=extract(year FROM (SELECT earliest_history_date FROM public.business_profile WHERE id=1)) THEN 'opening_balances' ELSE 'annual_totals' END);
  expected:=coalesce(c->'expected',jsonb_build_object('monthly',c->'monthly','accounts',c->'accounts','totals',c->'totals'));
  IF NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=(c->>'document_id')::uuid AND d.status<>'archived') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
  result:=accounting.history_preview(c||jsonb_build_object('kind',kind,'from',coalesce(c->>'from',make_date(fiscal,1,1)::text),'to',coalesce(c->>'to',make_date(fiscal,12,31)::text)));
  actual:=result->'actual';differences:=result->'difference';
  row_status:=CASE WHEN (result->>'differences')::integer>0 OR (result->>'drafts')::integer>0 OR (result->>'source_errors')::integer>0 THEN CASE WHEN btrim(coalesce(c->>'explanation',''))<>'' AND (result->>'drafts')::integer=0 AND (result->>'source_errors')::integer=0 THEN 'explained' ELSE 'mismatch' END ELSE 'matches' END;
  IF t='history.verify' AND row_status='mismatch' THEN RAISE EXCEPTION 'ACCT_HISTORY_NOT_READY';END IF;
  INSERT INTO accounting.history_checks(id,fiscal_year,kind,expected,actual,difference,status,explanation,document_id,checked_by)
   VALUES(key,fiscal,kind,expected||jsonb_build_object('from',result->'from','to',result->'to'),actual||jsonb_build_object('financial_revision',(SELECT financial_revision::text FROM accounting.settings)),differences,row_status,coalesce(c->>'explanation',c->>'reason',''),(c->>'document_id')::uuid,actor);
  UPDATE accounting.import_batches ib SET parity_status=CASE WHEN row_status IN ('matches','explained') THEN 'verified' ELSE 'mismatch' END
   WHERE ib.kind='journal' AND ib.coverage_from>=(result->>'from')::date AND ib.coverage_to<=(result->>'to')::date AND ib.status='completed';
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v,'posted',posted,'drafted',drafted,'skipped',skipped));
END $fn$;
CREATE FUNCTION accounting.imports(batch uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT jsonb_build_object('batches',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('source_system',b.source,'source_scope',b.mapping->>'source_scope','file_name',b.mapping->>'file_name','mapping_hash',b.mapping->>'mapping_hash','mode',b.kind,'basis',b.mapping->>'basis','expected_groups',b.row_count,'from_date',b.coverage_from,'to_date',b.coverage_to,'error','') ORDER BY b.created_at DESC,b.id),'[]') FROM accounting.import_batches b),
 'groups',(SELECT coalesce(jsonb_agg(to_jsonb(r)||r.parsed||jsonb_build_object('candidate_entry_id',r.duplicate_of_entry_id) ORDER BY r.ordinal),'[]') FROM accounting.import_rows r WHERE batch_id=batch),
 'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}')||jsonb_build_object('new',coalesce(sum(n) FILTER(WHERE status='ready'),0)) FROM (SELECT status,count(*) n FROM accounting.import_rows WHERE batch_id=batch GROUP BY status) x),
 'total',(SELECT count(*) FROM accounting.import_rows WHERE batch_id=batch)) INTO result;
 RETURN result;
END $fn$;
CREATE FUNCTION accounting.import_compare(batch_a uuid,batch_b uuid,filter jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE a accounting.import_batches;b accounting.import_batches;items jsonb;filtered jsonb;start_date date;end_date date;offset_rows integer:=coalesce((filter->>'offset')::integer,0);change_filter text:=coalesce(filter->>'change','all');
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO a FROM accounting.import_batches WHERE id=batch_a;SELECT * INTO b FROM accounting.import_batches WHERE id=batch_b;
 IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
 start_date:=coalesce((filter->>'from')::date,greatest(a.coverage_from,b.coverage_from));end_date:=coalesce((filter->>'to')::date,least(a.coverage_to,b.coverage_to));
 IF batch_a=batch_b OR a.source<>b.source OR a.kind<>b.kind OR a.mapping->>'source_scope' IS DISTINCT FROM b.mapping->>'source_scope' OR start_date<greatest(a.coverage_from,b.coverage_from) OR end_date>least(a.coverage_to,b.coverage_to) OR start_date>end_date OR offset_rows<0 OR change_filter NOT IN ('all','differences','changed','source_only','new','missing','unchanged') THEN RAISE EXCEPTION 'ACCT_IMPORT_COMPARISON_SCOPE';END IF;
 IF (SELECT count(*) FROM accounting.import_rows WHERE batch_id=a.id)<>a.row_count OR (SELECT count(*) FROM accounting.import_rows WHERE batch_id=b.id)<>b.row_count THEN RAISE EXCEPTION 'ACCT_IMPORT_COMPARISON_STAGING';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',coalesce(l.external_id,r.external_id),'external_id',coalesce(l.external_id,r.external_id),'identity_kind',coalesce(l.parsed->>'identity_kind',r.parsed->>'identity_kind'),
  'before_id',l.id,'after_id',r.id,'earlier',CASE WHEN l.id IS NULL THEN NULL ELSE to_jsonb(l)||l.parsed||jsonb_build_object('raw_payload',l.raw) END,'later',CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r)||r.parsed||jsonb_build_object('raw_payload',r.raw) END,
  'change',CASE WHEN l.id IS NULL THEN 'new' WHEN r.id IS NULL THEN 'missing' WHEN l.fingerprint<>r.fingerprint THEN 'changed' WHEN l.parsed->>'source_hash' IS DISTINCT FROM r.parsed->>'source_hash' THEN 'source_only' ELSE 'unchanged' END) ORDER BY coalesce(l.external_id,r.external_id)),'[]') INTO items
  FROM (SELECT * FROM accounting.import_rows WHERE batch_id=batch_a) l FULL JOIN (SELECT * FROM accounting.import_rows WHERE batch_id=batch_b) r ON l.external_id=r.external_id
  WHERE (l.parsed->>'entry_date')::date BETWEEN start_date AND end_date OR (r.parsed->>'entry_date')::date BETWEEN start_date AND end_date;
 SELECT coalesce(jsonb_agg(value),'[]') INTO filtered FROM jsonb_array_elements(items) WHERE change_filter='all' OR (change_filter='differences' AND value->>'change'<>'unchanged') OR value->>'change'=change_filter;
 RETURN jsonb_build_object('batch_a',batch_a,'batch_b',batch_b,'earlier',to_jsonb(a),'later',to_jsonb(b),'from',start_date,'to',end_date,'revision',(SELECT financial_revision::text FROM accounting.settings),
 'mapping_changed',a.mapping->>'mapping_hash' IS DISTINCT FROM b.mapping->>'mapping_hash','basis_changed',a.mapping->>'basis' IS DISTINCT FROM b.mapping->>'basis','uncertain_identity_count',(SELECT count(*) FROM jsonb_array_elements(items) WHERE value->>'identity_kind'='fingerprint_multiplicity'),
 'total',jsonb_array_length(items),'filtered_total',jsonb_array_length(filtered),'offset',offset_rows,'rows',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('status',value->'change')),'[]') FROM (SELECT value FROM jsonb_array_elements(filtered) OFFSET offset_rows LIMIT 50) page),
 'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT value->>'change' status,count(*) n FROM jsonb_array_elements(items) GROUP BY value->>'change') q));
END $fn$;
REVOKE ALL ON FUNCTION accounting.history_guard(),accounting.history_preview(jsonb),accounting.history_command(jsonb),accounting.imports(uuid),accounting.import_compare(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.history_preview(jsonb),accounting.imports(uuid),accounting.import_compare(uuid,uuid,jsonb) TO authenticated;
-- ACCOUNTING HISTORY END
COMMIT;
