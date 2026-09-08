BEGIN;
-- ACCOUNTING BANKING BEGIN
CREATE TABLE accounting.parties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE CHECK(length(btrim(name)) BETWEEN 1 AND 120),kind text NOT NULL CHECK(kind IN ('vendor','customer','both')),
 default_account_id uuid REFERENCES accounting.accounts ON DELETE RESTRICT,is_contractor boolean NOT NULL DEFAULT false,
 contractor_classification text NOT NULL DEFAULT 'unknown' CHECK(contractor_classification IN ('unknown','individual','corporation','foreign','other')),
 documentation_status text NOT NULL DEFAULT 'missing' CHECK(documentation_status IN ('missing','received','not_required')),notes text NOT NULL DEFAULT '',
 is_archived boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE accounting.payee_aliases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),party_id uuid NOT NULL REFERENCES accounting.parties ON DELETE RESTRICT,
 match_kind text NOT NULL CHECK(match_kind IN ('key','exact','prefix')),pattern text NOT NULL CHECK(length(btrim(pattern)) BETWEEN 1 AND 1000),enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users ON DELETE RESTRICT,
 UNIQUE(match_kind,pattern)
);
CREATE TABLE accounting.bank_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text NOT NULL DEFAULT 'simplefin' CHECK(provider='simplefin'),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','reconnect_required','disconnected')),access_url_encrypted text NOT NULL,key_version smallint NOT NULL DEFAULT 1 CHECK(key_version>0),
 scheduled boolean NOT NULL DEFAULT true,next_sync_at timestamptz,last_success_at timestamptz,last_error text NOT NULL DEFAULT '',lease_run_id uuid,lease_until timestamptz,
 checkpoint jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(checkpoint)='object'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((lease_run_id IS NULL)=(lease_until IS NULL))
);
CREATE TABLE accounting.bank_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL UNIQUE REFERENCES accounting.accounts ON DELETE RESTRICT,
 connection_id uuid REFERENCES accounting.bank_connections ON DELETE RESTRICT,provider_account_id text,institution text NOT NULL DEFAULT '',mask text NOT NULL DEFAULT '',
 movement_sign smallint NOT NULL DEFAULT 1 CHECK(movement_sign IN (-1,1)),coverage_from date,observed_balance_cents bigint,observed_at timestamptz,
 is_closed boolean NOT NULL DEFAULT false,closed_on date,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,provider_account_id),CHECK(NOT is_closed OR closed_on IS NOT NULL)
);
CREATE TABLE accounting.bank_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bank_account_id uuid NOT NULL REFERENCES accounting.bank_accounts ON DELETE RESTRICT,
 source text NOT NULL CHECK(source IN ('simplefin','csv','wave')),external_id text NOT NULL CHECK(length(external_id)>0),posted_date date NOT NULL,transacted_at timestamptz,
 amount_cents bigint NOT NULL CHECK(amount_cents>'-9223372036854775808'::bigint),description text NOT NULL,descriptor_key text NOT NULL,content_hash text NOT NULL,
 raw_payload jsonb NOT NULL,state text NOT NULL CHECK(state IN ('pending','posted')),review text NOT NULL DEFAULT 'unmatched' CHECK(review IN ('unmatched','matched','excluded')),
 excluded_reason text NOT NULL DEFAULT '',import_batch_id uuid,observed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(bank_account_id,external_id),CHECK(review<>'excluded' OR length(btrim(excluded_reason))>0)
);
CREATE INDEX bank_transactions_review ON accounting.bank_transactions(bank_account_id,review,posted_date);
CREATE INDEX bank_transactions_descriptor ON accounting.bank_transactions(descriptor_key,posted_date);
CREATE TABLE accounting.bank_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bank_transaction_id uuid NOT NULL REFERENCES accounting.bank_transactions ON DELETE RESTRICT,
 journal_line_id uuid NOT NULL REFERENCES accounting.journal_lines ON DELETE RESTRICT,amount_cents bigint NOT NULL CHECK(amount_cents>=0),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users ON DELETE RESTRICT,UNIQUE(bank_transaction_id,journal_line_id)
);
CREATE INDEX bank_matches_line ON accounting.bank_matches(journal_line_id);
CREATE TABLE accounting.documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),storage_path text NOT NULL UNIQUE,name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 240),mime text NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL DEFAULT 'receipt' CHECK(kind IN ('receipt','statement','payroll_register','source_export','report','other')),
 status text NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','linked','archived')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 uploaded_by uuid REFERENCES auth.users ON DELETE RESTRICT,uploaded_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_hash ON accounting.documents(sha256);
CREATE TABLE accounting.document_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES accounting.documents ON DELETE RESTRICT,
 entry_id uuid REFERENCES accounting.journal_entries ON DELETE RESTRICT,bank_transaction_id uuid REFERENCES accounting.bank_transactions ON DELETE RESTRICT,
 import_batch_id uuid,reconciliation_id uuid,payroll_run_id uuid,register_id uuid,party_id uuid REFERENCES accounting.parties ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users ON DELETE RESTRICT,
 CHECK(num_nonnulls(entry_id,bank_transaction_id,import_batch_id,reconciliation_id,payroll_run_id,register_id,party_id)=1)
);
CREATE UNIQUE INDEX document_link_unique ON accounting.document_links(document_id,coalesce(entry_id,bank_transaction_id,import_batch_id,reconciliation_id,payroll_run_id,register_id,party_id));
CREATE TABLE accounting.rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),priority integer NOT NULL DEFAULT 100 CHECK(priority BETWEEN 0 AND 10000),
 enabled boolean NOT NULL DEFAULT false,conditions jsonb NOT NULL CHECK(jsonb_typeof(conditions)='object'),actions jsonb NOT NULL CHECK(jsonb_typeof(actions)='object'),auto_post boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_payee_fk FOREIGN KEY(payee_id) REFERENCES accounting.parties ON DELETE RESTRICT;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_rule_fk FOREIGN KEY(applied_rule_id) REFERENCES accounting.rules ON DELETE RESTRICT;
CREATE FUNCTION accounting.banking_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
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
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('parties','payee_aliases','bank_accounts','bank_connections','documents','rules') THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $fn$;
CREATE FUNCTION accounting.match_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE key uuid; total numeric; zero_evidence boolean; observation accounting.bank_transactions;
BEGIN
 IF TG_OP='DELETE' THEN key:=OLD.bank_transaction_id; ELSE key:=NEW.bank_transaction_id; END IF;
 SELECT * INTO observation FROM accounting.bank_transactions WHERE id=key;
 SELECT coalesce(sum(amount_cents),0),coalesce(bool_or(amount_cents=0),false) INTO total,zero_evidence FROM accounting.bank_matches WHERE bank_transaction_id=key;
 UPDATE accounting.bank_transactions SET review=CASE WHEN total=abs(observation.amount_cents::numeric) OR zero_evidence THEN 'matched' ELSE 'unmatched' END WHERE id=key;
 RETURN NULL;
END $fn$;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['parties','payee_aliases','bank_connections','bank_accounts','bank_transactions','bank_matches','documents','document_links','rules'] LOOP
  EXECUTE format('ALTER TABLE accounting.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON accounting.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER write_lock BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH STATEMENT EXECUTE FUNCTION accounting.banking_guard()',t);
  EXECUTE format('CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard()',t);
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.record_audit()',t);
 END LOOP;
END $triggers$;
CREATE TRIGGER match_review AFTER INSERT OR DELETE ON accounting.bank_matches FOR EACH ROW EXECUTE FUNCTION accounting.match_review();

CREATE TRIGGER bank_entry_date_guard BEFORE INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();
CREATE TRIGGER bank_line_match_guard BEFORE UPDATE OR DELETE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.banking_guard();
CREATE FUNCTION accounting.prior_summary(key text,bank_account uuid,max_rows integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
 WITH matched AS (
  SELECT e.* FROM accounting.journal_entries e WHERE e.status='posted' AND e.descriptor_key=key
   AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries reversal WHERE reversal.reverses_entry_id=e.id)
   AND e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id=bank_account)
 ), recent AS (SELECT * FROM matched ORDER BY entry_date DESC,created_at DESC,id LIMIT greatest(1,least(max_rows,100)))
 SELECT jsonb_build_object('count',(SELECT count(*) FROM matched),'last_date',(SELECT max(entry_date) FROM matched),
  'last_category',(SELECT l.account_id FROM recent e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE l.account_id<>bank_account ORDER BY e.entry_date DESC,e.created_at DESC,l.sort_order LIMIT 1),
  'payee_id',(SELECT payee_id FROM recent ORDER BY entry_date DESC,created_at DESC,id LIMIT 1),
  'memo',(SELECT memo FROM recent ORDER BY entry_date DESC,created_at DESC,id LIMIT 1),
  'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'payee_id',e.payee_id,'entry_date',e.entry_date,
   'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text,'memo',l.memo) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id AND l.account_id<>bank_account)) ORDER BY e.entry_date DESC,e.created_at DESC,e.id) FROM recent e),'[]')) INTO result;
 RETURN result;
END $fn$;
CREATE FUNCTION accounting.prior_treatment(descriptor_key text,bank_account_id uuid,max_rows integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN PERFORM accounting.require_owner(); RETURN accounting.prior_summary(descriptor_key,bank_account_id,max_rows); END $fn$;
CREATE FUNCTION accounting.rule_candidate(entry uuid,rule_filter uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE e accounting.journal_entries; bank accounting.journal_lines; r accounting.rules; descriptor text; mode text; pattern text;
 matches jsonb:='[]';winner jsonb;why text:='';alias_count integer;
BEGIN
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF NOT FOUND OR e.status='discarded' THEN RETURN NULL; END IF;
 SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card');
 IF NOT FOUND OR (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card'))<>1 THEN RETURN NULL; END IF;
 FOR r IN SELECT * FROM accounting.rules WHERE (rule_filter IS NULL AND enabled) OR id=rule_filter ORDER BY priority,id LOOP
  descriptor:=upper(regexp_replace(btrim(CASE WHEN r.conditions?'description' THEN coalesce(e.source_description,e.memo) ELSE coalesce(e.descriptor_key,accounting.descriptor_key(e.memo)) END),'\s+',' ','g'));
  mode:=coalesce(r.conditions->>'description_mode',(SELECT key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1));
  pattern:=upper(regexp_replace(btrim(coalesce(r.conditions->>'description',r.conditions->'descriptor_key'->>mode)),'\s+',' ','g'));
  IF mode NOT IN ('exact','equals','prefix','contains') OR pattern IS NULL THEN CONTINUE; END IF;
  IF (mode IN ('exact','equals') AND descriptor<>pattern) OR (mode='prefix' AND left(descriptor,length(pattern))<>pattern) OR (mode='contains' AND position(pattern IN descriptor)=0) THEN CONTINUE; END IF;
  IF r.conditions->>'bank_account_id' IS NOT NULL AND (r.conditions->>'bank_account_id')::uuid<>bank.account_id THEN CONTINUE; END IF;
  IF r.conditions->>'direction' IN ('increase','in') AND bank.amount_cents<0 OR r.conditions->>'direction' IN ('decrease','out') AND bank.amount_cents>0 THEN CONTINUE; END IF;
  IF r.conditions->>'amount_min' IS NOT NULL AND abs(bank.amount_cents::numeric)<(r.conditions->>'amount_min')::numeric THEN CONTINUE; END IF;
  IF r.conditions->>'amount_max' IS NOT NULL AND abs(bank.amount_cents::numeric)>(r.conditions->>'amount_max')::numeric THEN CONTINUE; END IF;
  IF r.conditions->>'payee_id' IS NOT NULL AND e.payee_id IS DISTINCT FROM (r.conditions->>'payee_id')::uuid THEN CONTINUE; END IF;
  matches:=matches||jsonb_build_array(to_jsonb(r)||jsonb_build_object('rule_id',r.id,
   'description_mode',CASE WHEN mode='equals' THEN 'exact' ELSE mode END,'description',pattern,
   'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction',
   'min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),
   'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id',
   'category_name',coalesce((SELECT name FROM accounting.accounts WHERE id=(r.actions->>'account_id')::uuid),'Split categories'),'reason',''));
 END LOOP;
 IF jsonb_array_length(matches)=0 THEN RETURN NULL; END IF;
 winner:=matches->0;
 descriptor:=upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g'));
 SELECT count(DISTINCT party_id) INTO alias_count FROM accounting.payee_aliases a WHERE enabled AND
  ((match_kind='key' AND a.pattern=e.descriptor_key) OR (match_kind='exact' AND upper(a.pattern)=descriptor) OR (match_kind='prefix' AND left(descriptor,length(a.pattern))=upper(a.pattern)));
 IF e.status='posted' THEN why:='Posted history is preview only';
 ELSIF NOT EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN why:='Category already reviewed';
 ELSIF alias_count>1 THEN why:='Conflicting payee aliases';
 ELSIF (SELECT count(*) FROM jsonb_array_elements(matches) m WHERE m->>'priority'=winner->>'priority')>1 THEN why:='Rules share the winning priority'; END IF;
 RETURN winner||jsonb_build_object('id',e.id,'version',e.version,'entry_id',entry,'entry_version',e.version,'rule_id',winner->'id','rule_version',winner->'version',
  'entry_date',e.entry_date,'memo',e.memo,'status',e.status,'payee_id',e.payee_id,
  'aliases',jsonb_build_object('conflict',alias_count>1,'aliases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',p.name,'description',a.pattern)),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id WHERE a.enabled AND ((a.match_kind='key' AND a.pattern=e.descriptor_key) OR (a.match_kind='exact' AND upper(a.pattern)=descriptor) OR (a.match_kind='prefix' AND left(descriptor,length(a.pattern))=upper(a.pattern))))),
  'eligible',why='','reason',why,'winner',winner,'matches',matches,'bank_account_id',bank.account_id,'bank_amount_cents',bank.amount_cents::text,
  'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount_cents::text) ORDER BY sort_order) FROM accounting.journal_lines WHERE entry_id=entry));
END $fn$;
CREATE FUNCTION accounting.rules_preview(filter jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT coalesce(jsonb_agg(candidate ORDER BY entry_date,id),'[]') INTO result FROM (
 SELECT e.id,e.entry_date,accounting.rule_candidate(e.id,(filter->>'rule_id')::uuid) candidate FROM accounting.journal_entries e
 WHERE (filter->>'from' IS NULL OR e.entry_date>=(filter->>'from')::date) AND (filter->>'to' IS NULL OR e.entry_date<=(filter->>'to')::date)) q WHERE candidate IS NOT NULL;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',jsonb_array_length(result),'rows',result);
END $fn$;
CREATE FUNCTION accounting.apply_treatment(entry uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE e accounting.journal_entries; bank accounting.journal_lines; candidate jsonb; previous jsonb; result jsonb; party uuid; category uuid;
BEGIN
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF e.status<>'draft' THEN RETURN jsonb_build_object('id',entry,'version',e.version); END IF;
 SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','cash','card');
 IF NOT FOUND THEN RETURN jsonb_build_object('id',entry,'version',e.version); END IF;
 SELECT party_id INTO party FROM accounting.payee_aliases a WHERE enabled AND ((match_kind='key' AND pattern=e.descriptor_key) OR (match_kind='exact' AND upper(pattern)=upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g'))) OR (match_kind='prefix' AND left(upper(regexp_replace(btrim(coalesce(e.source_description,e.memo)),'\s+',' ','g')),length(pattern))=upper(pattern)))
 ORDER BY CASE match_kind WHEN 'key' THEN 0 WHEN 'exact' THEN 1 ELSE 2 END,length(pattern) DESC,id LIMIT 1;
 IF party IS NOT NULL THEN UPDATE accounting.journal_entries SET payee_id=party WHERE id=entry RETURNING * INTO e; END IF;
 candidate:=accounting.rule_candidate(entry);
 IF candidate IS NOT NULL AND (candidate->>'eligible')::boolean THEN
  IF candidate->'actions'?'splits' THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.split','id',entry,'expected_version',e.version,'splits',candidate->'actions'->'splits','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  ELSE
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',candidate->'actions'->>'account_id','memo',coalesce(candidate->'actions'->>'memo',e.memo),'payee_id',coalesce(candidate->'actions'->>'payee_id',e.payee_id::text)));
  END IF;
  UPDATE accounting.journal_entries SET applied_rule_id=(candidate->>'rule_id')::uuid WHERE id=entry RETURNING * INTO e;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after)
  VALUES(CASE WHEN current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE auth.uid() END,
   coalesce(nullif(current_setting('accounting.actor_kind',true),''),'owner'),
   coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,gen_random_uuid()),'journal_entries',entry,'rule.applied',candidate,
   jsonb_build_object('version',e.version,'payee_id',e.payee_id,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'amount_cents',amount_cents::text,'memo',memo) ORDER BY sort_order) FROM accounting.journal_lines WHERE entry_id=entry)));
  IF (candidate->>'auto_post')::boolean AND (SELECT primary_system FROM accounting.settings WHERE id=1)='admin' THEN
   RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',entry,'expected_version',e.version));
  END IF;
 ELSIF e.descriptor_key IS NOT NULL THEN
  previous:=accounting.prior_summary(e.descriptor_key,bank.account_id,1);
  -- Reuse a single-category treatment only. A past split's proportions may not fit this purchase.
  IF jsonb_array_length(coalesce(previous->'entries'->0->'lines','[]'))=1 THEN
   category:=(previous->>'last_category')::uuid;
   IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
    result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',coalesce(e.payee_id::text,previous->>'payee_id'),'memo',coalesce(previous->>'memo',e.memo)));
    SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('id',entry,'version',e.version);
END $fn$;
CREATE FUNCTION accounting.banking_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
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
 ELSIF t IN ('document.complete','document.link','document.archive') THEN
  SELECT * INTO doc FROM accounting.documents WHERE id=coalesce((c->>'document_id')::uuid,key);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t<>'document.archive' AND NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=doc.storage_path) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF t='document.link' THEN
   INSERT INTO accounting.document_links(document_id,entry_id,bank_transaction_id,import_batch_id,reconciliation_id,payroll_run_id,register_id,party_id,created_by)
   VALUES(doc.id,(c->>'entry_id')::uuid,(c->>'bank_transaction_id')::uuid,(c->>'import_batch_id')::uuid,(c->>'reconciliation_id')::uuid,(c->>'payroll_run_id')::uuid,(c->>'register_id')::uuid,(c->>'party_id')::uuid,actor) ON CONFLICT DO NOTHING;
  END IF;
  IF t='document.archive' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  UPDATE accounting.documents SET status=CASE t WHEN 'document.archive' THEN 'archived' WHEN 'document.link' THEN 'linked' ELSE status END WHERE id=doc.id RETURNING version INTO v;
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
END $fn$;
CREATE FUNCTION accounting.sync_server(command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE c accounting.bank_connections; ba accounting.bank_accounts; observation accounting.bank_transactions; a jsonb; tx jsonb; normalized jsonb;
 provider_key text; discover_id uuid; new_checkpoint jsonb; discovered jsonb; zone text; run uuid:=coalesce((command->>'run_id')::uuid,gen_random_uuid());
 run_complete boolean:=coalesce((command->>'complete')::boolean,true);count_new integer:=0;count_pending integer:=0;count_drafts integer:=0;count_conflicts integer:=0; book_date date; amount bigint; existing_id uuid;
 candidate_id uuid; candidate_count integer; allocation bigint; draft jsonb; bank_line uuid; category uuid; account_complete boolean; balance_sign smallint; seen jsonb; blocked jsonb; conflicts_before integer; partial boolean:=coalesce((command->>'partial')::boolean,false); discovery_only boolean:=coalesce((command->>'discovery')::boolean,false);
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'ACCT_WORKER_REQUIRED'; END IF;
 PERFORM accounting.write_lock();
 PERFORM set_config('accounting.operation_id',run::text,true);PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.action','sync',true);
 IF command->>'action'='due' THEN
  RETURN coalesce((SELECT jsonb_agg(id ORDER BY next_sync_at NULLS FIRST,id) FROM accounting.bank_connections WHERE status='active' AND scheduled AND (next_sync_at IS NULL OR next_sync_at<=now()) AND (lease_until IS NULL OR lease_until<=now())),'[]');
 END IF;
 SELECT * INTO c FROM accounting.bank_connections WHERE id=(command->>'id')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 IF command->>'action' IN ('claim.send','claim.complete','claim.fail') THEN
  IF c.status<>'reconnect_required' OR c.checkpoint->'claim'->>'id' IS DISTINCT FROM command->>'claim_id' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
  IF command->>'action'='claim.send' THEN
   IF c.checkpoint->'claim'->>'state'<>'prepared' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,'{claim,state}','"sent"') WHERE id=c.id;
  ELSIF command->>'action'='claim.complete' THEN
   IF c.checkpoint->'claim'->>'state'<>'sent' OR length(coalesce(command->>'ciphertext',''))<20 THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET access_url_encrypted=command->>'ciphertext',key_version=coalesce((command->>'key_version')::smallint,1),status='active',last_error='',checkpoint=jsonb_set(checkpoint,'{claim,state}','"completed"') WHERE id=c.id;
  ELSE
   IF c.checkpoint->'claim'->>'state'<>'sent' THEN RAISE EXCEPTION 'ACCT_FEED_CLAIM'; END IF;
   UPDATE accounting.bank_connections SET last_error=left(coalesce(command->>'error','Connection setup failed'),1000),checkpoint=jsonb_set(checkpoint,'{claim,state}','"failed"') WHERE id=c.id;
  END IF;
  RETURN jsonb_build_object('id',c.id);
 END IF;
 IF command->>'action'='lease' THEN
  IF c.status<>'active' OR (c.lease_until>now() AND c.lease_run_id<>run) THEN RETURN jsonb_build_object('id',c.id,'acquired',false); END IF;
  UPDATE accounting.bank_connections SET lease_run_id=run,lease_until=now()+interval '5 minutes',checkpoint=jsonb_set(checkpoint,ARRAY['sync_run'],CASE WHEN c.lease_run_id=run AND c.lease_until>now() THEN coalesce(checkpoint->'sync_run','{}') ELSE jsonb_build_object('seen','[]'::jsonb,'complete',true) END) WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'acquired',true,'run_id',run,'access_url_encrypted',c.access_url_encrypted,'key_version',c.key_version,'checkpoint',c.checkpoint,'books_timezone',(SELECT books_timezone FROM public.business_profile WHERE id=1),
   'identities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'provider_connection_id',(b.provider_account_id::jsonb)->>0,'provider_account_id',(b.provider_account_id::jsonb)->>1,
    'history_start',extract(epoch FROM (coalesce(b.coverage_from,(SELECT earliest_history_date FROM public.business_profile WHERE id=1))::timestamp AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1)))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'resume_floor',NULL)) FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed),'[]'));
 END IF;
 IF c.lease_run_id IS DISTINCT FROM run OR c.lease_until<=now() OR c.status<>'active' THEN RAISE EXCEPTION 'ACCT_STALE_LEASE'; END IF;
 IF command->>'action'='fail' THEN
  UPDATE accounting.bank_connections SET last_error=left(coalesce(command->>'error','Bank sync failed'),1000),
   status=CASE WHEN coalesce((command->>'reconnect_required')::boolean,false) THEN 'reconnect_required' ELSE status END,
   next_sync_at=now()+interval '1 hour',lease_run_id=NULL,lease_until=NULL WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'status','error');
 END IF;
 IF command->>'action'<>'complete' OR jsonb_typeof(command->'accounts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 zone:=(SELECT books_timezone FROM public.business_profile WHERE id=1);new_checkpoint:=c.checkpoint;
 discovered:=coalesce(c.checkpoint->'discovery','{}');seen:=coalesce(c.checkpoint->'sync_run'->'seen','[]');blocked:=coalesce(c.checkpoint->'sync_run'->'blocked','[]');
 run_complete:=run_complete AND coalesce((c.checkpoint->'sync_run'->>'complete')::boolean,true);
 FOR a IN SELECT value FROM jsonb_array_elements(command->'accounts') LOOP
  provider_key:=jsonb_build_array(a->>'provider_connection_id',a->>'provider_account_id')::text;
  discover_id:=md5(c.id::text||':'||provider_key)::uuid;
  discovered:=jsonb_set(discovered,ARRAY[discover_id::text],jsonb_build_object('id',discover_id,'provider_account_id',provider_key,'raw_provider_account_id',a->>'provider_account_id','provider_connection_id',a->>'provider_connection_id','name',a->>'name','institution',a->>'institution','currency',a->>'currency','balance_cents',a->>'balance_cents','available_cents',a->>'available_cents','balance_at',a->'balance_at','ownership',coalesce(discovered->discover_id::text->>'ownership','unreviewed')));
  SELECT * INTO ba FROM accounting.bank_accounts WHERE connection_id=c.id AND provider_account_id=provider_key AND NOT is_closed;
  IF NOT FOUND THEN CONTINUE; END IF;
  IF a->>'currency'<>'USD' THEN run_complete:=false; CONTINUE; END IF;
  IF NOT seen ? provider_key THEN seen:=seen||jsonb_build_array(provider_key); END IF;
  balance_sign:=coalesce((new_checkpoint->'balance_signs'->>ba.id::text)::smallint,1);
  IF a->>'balance_cents' IS NOT NULL AND a->>'balance_at' IS NOT NULL THEN
   UPDATE accounting.bank_accounts SET observed_balance_cents=(a->>'balance_cents')::bigint*balance_sign,observed_at=to_timestamp((a->>'balance_at')::bigint) WHERE id=ba.id;
  END IF;
  IF discovery_only THEN CONTINUE; END IF;
  conflicts_before:=count_conflicts;account_complete:=coalesce((a->>'complete')::boolean,false) AND NOT blocked ? provider_key;
  IF coalesce((a->>'chunk_partial')::boolean,false) THEN account_complete:=false; END IF;
  FOR tx IN SELECT value FROM jsonb_array_elements(coalesce(a->'transactions','[]')) LOOP
   IF (tx->>'state' IN ('pending','nonfinancial') OR (tx->>'amount_cents')::bigint=0) AND EXISTS(SELECT 1 FROM accounting.bank_transactions WHERE bank_account_id=ba.id AND external_id=tx->>'external_id' AND state='posted') THEN
    account_complete:=false;count_conflicts:=count_conflicts+1;CONTINUE;
   END IF;
   IF tx->>'state'='pending' THEN count_pending:=count_pending+1; CONTINUE; END IF;
   IF tx->>'state'='nonfinancial' OR (tx->>'amount_cents')::bigint=0 THEN CONTINUE; END IF;
   book_date:=(to_timestamp((tx->>'posted')::bigint) AT TIME ZONE zone)::date;
   amount:=(tx->>'amount_cents')::bigint*ba.movement_sign;
   IF ba.coverage_from IS NOT NULL AND book_date<ba.coverage_from THEN CONTINUE; END IF;
   SELECT * INTO observation FROM accounting.bank_transactions WHERE bank_account_id=ba.id AND external_id=tx->>'external_id';
   IF FOUND THEN
    IF observation.content_hash IS DISTINCT FROM tx->>'hash' OR observation.amount_cents<>amount OR observation.posted_date<>book_date THEN
     account_complete:=false;count_conflicts:=count_conflicts+1;CONTINUE;
    END IF;
   ELSE
    INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,transacted_at,amount_cents,description,descriptor_key,content_hash,raw_payload,state)
     VALUES(ba.id,'simplefin',tx->>'external_id',book_date,to_timestamp((tx->>'transacted_at')::bigint),amount,tx->>'description',accounting.descriptor_key(tx->>'description'),tx->>'hash',tx->'raw','posted') RETURNING * INTO observation;
    count_new:=count_new+1;
   END IF;
   IF observation.review<>'unmatched' OR EXISTS(SELECT 1 FROM accounting.bank_matches WHERE bank_transaction_id=observation.id) THEN CONTINUE; END IF;
   SELECT count(*),(array_agg(l.id ORDER BY e.entry_date,l.id))[1] INTO candidate_count,candidate_id
    FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=ba.account_id AND l.amount_cents=amount AND e.status IN ('draft','posted') AND e.reverses_entry_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)
     AND abs(e.entry_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)
     AND (NOT EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=l.id)
      OR EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.bank_transactions o ON o.id=m.bank_transaction_id WHERE m.journal_line_id=l.id AND m.amount_cents=abs(amount) AND o.source<>observation.source AND o.bank_account_id=ba.id AND o.amount_cents=amount AND abs(o.posted_date-book_date)<=(SELECT transfer_window_days FROM accounting.settings WHERE id=1)));
   IF candidate_count=1 THEN
    allocation:=CASE WHEN EXISTS(SELECT 1 FROM accounting.bank_matches WHERE journal_line_id=candidate_id) THEN 0 ELSE abs(amount) END;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents) VALUES(observation.id,candidate_id,allocation);
   ELSIF coalesce((command->>'create_drafts')::boolean,false) THEN
    -- Closed-period evidence stays unmatched for owner resolution; never shift its date.
    IF EXISTS(SELECT 1 FROM accounting.periods WHERE status='locked' AND month>=date_trunc('month',book_date)::date) THEN CONTINUE; END IF;
    SELECT id INTO category FROM accounting.accounts WHERE system_purpose=CASE WHEN amount>0 THEN 'uncategorized_income' ELSE 'uncategorized_expense' END;
    draft:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',book_date,'memo',observation.description,'source_description',observation.description,'origin','simplefin','kind',CASE WHEN amount>0 THEN 'income' ELSE 'expense' END,
     'lines',jsonb_build_array(jsonb_build_object('account_id',ba.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',category,'amount_cents',(-amount)::text))));
    SELECT id INTO bank_line FROM accounting.journal_lines WHERE entry_id=(draft->>'id')::uuid AND account_id=ba.account_id;
    INSERT INTO accounting.bank_matches(bank_transaction_id,journal_line_id,amount_cents) VALUES(observation.id,bank_line,abs(amount));
    PERFORM accounting.apply_treatment((draft->>'id')::uuid);count_drafts:=count_drafts+1;
   END IF;
  END LOOP;
  IF count_conflicts>conflicts_before AND NOT blocked ? provider_key THEN blocked:=blocked||jsonb_build_array(provider_key); END IF;
  IF NOT account_complete AND NOT coalesce((a->>'chunk_partial')::boolean,false) THEN run_complete:=false; END IF;
  IF account_complete THEN
   new_checkpoint:=jsonb_set(new_checkpoint,ARRAY[provider_key],coalesce(a->'through',command->'through','null'));
  END IF;
 END LOOP;
 IF NOT partial AND NOT discovery_only AND EXISTS(SELECT 1 FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed AND NOT seen ? b.provider_account_id) THEN run_complete:=false; END IF;
 new_checkpoint:=jsonb_set(new_checkpoint,ARRAY['discovery'],discovered);
 new_checkpoint:=jsonb_set(new_checkpoint,ARRAY['sync_run'],jsonb_build_object('seen',seen,'blocked',blocked,'complete',run_complete AND count_conflicts=0));
 UPDATE accounting.bank_connections SET checkpoint=new_checkpoint,last_success_at=CASE WHEN NOT partial AND NOT discovery_only AND count_conflicts=0 AND run_complete THEN now() ELSE last_success_at END,
  last_error=CASE WHEN count_conflicts>0 THEN 'Provider records changed. Original evidence was retained; review before advancing coverage.' WHEN NOT run_complete THEN 'The provider reported incomplete account data.' ELSE '' END,
  lease_run_id=CASE WHEN partial THEN run ELSE NULL END,lease_until=CASE WHEN partial THEN c.lease_until ELSE NULL END,next_sync_at=now()+CASE WHEN run_complete AND count_conflicts=0 THEN interval '6 hours' ELSE interval '1 hour' END WHERE id=c.id;
 INSERT INTO accounting.audit_log(actor_kind,operation_id,table_name,row_id,action,after)
  VALUES('worker',run,'bank_connections',c.id,'sync',jsonb_build_object('accounts',jsonb_array_length(command->'accounts'),'new',count_new,'pending',count_pending,'drafts',count_drafts,'errors',count_conflicts));
 RETURN jsonb_build_object('id',c.id,'new',count_new,'pending',count_pending,'drafts',count_drafts,'conflicts',count_conflicts,'complete',run_complete AND count_conflicts=0);
END $fn$;
CREATE FUNCTION accounting.document_access(path text, uploading boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT EXISTS(SELECT 1 FROM accounting.settings WHERE owner_user_id=auth.uid()) AND EXISTS(SELECT 1 FROM accounting.documents WHERE storage_path=path AND status<>'archived') AND (NOT uploading OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=path))
$fn$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('accounting-private','accounting-private',false,26214400,ARRAY['application/pdf','image/png','image/jpeg','image/webp','text/csv','application/zip']) ON CONFLICT(id) DO NOTHING;
CREATE POLICY accounting_private_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='accounting-private' AND accounting.document_access(name));
CREATE POLICY accounting_private_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='accounting-private' AND accounting.document_access(name,true));
CREATE FUNCTION accounting.documents(filter jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT jsonb_build_object('documents',coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('original_name',d.name,'mime_type',d.mime,'content_hash',d.sha256,'size_bytes',d.size_bytes::text,'created_at',d.uploaded_at,'storage_key',d.storage_path,'state',CASE WHEN d.status='archived' THEN 'archived' WHEN EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path) THEN 'available' ELSE 'uploading' END,
  'links',(SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') FROM accounting.document_links l WHERE document_id=d.id)) ORDER BY uploaded_at DESC),'[]')) INTO result
 FROM accounting.documents d WHERE (filter->>'id' IS NULL OR d.id=(filter->>'id')::uuid) AND (filter->>'status' IS NULL OR d.status=filter->>'status');
 RETURN result;
END $fn$;
CREATE FUNCTION accounting.bank_review(filter jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;observation accounting.bank_transactions;ledger_account uuid;selected_id uuid:=(filter->>'id')::uuid;matches jsonb;drafts jsonb;candidates jsonb;candidate_count integer;
BEGIN
 PERFORM accounting.require_owner();
 IF selected_id IS NOT NULL THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=selected_id;
  IF NOT FOUND THEN SELECT o.* INTO observation FROM accounting.import_rows r JOIN accounting.bank_accounts b ON b.account_id=(r.parsed->>'bank_account_id')::uuid JOIN accounting.bank_transactions o ON o.bank_account_id=b.id AND o.external_id=r.external_id WHERE r.id=selected_id;END IF;
  IF observation.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT account_id INTO ledger_account FROM accounting.bank_accounts WHERE id=observation.bank_account_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'amount_cents',m.amount_cents::text,'release',NULL)),'[]') INTO matches FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=observation.id;
  SELECT coalesce(jsonb_agg(accounting.entry_detail(id)),'[]') INTO drafts FROM accounting.journal_entries e WHERE e.status='draft' AND EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id AND m.bank_transaction_id=observation.id);
  WITH matching AS(SELECT l.id line_id,e.id entry_id,e.entry_date,e.memo,l.amount_cents::text amount_cents,(abs(l.amount_cents::numeric)-coalesce((SELECT sum(amount_cents) FROM accounting.bank_matches WHERE journal_line_id=l.id),0))::text available_cents,abs(e.entry_date-observation.posted_date) days_apart
   FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=ledger_account AND e.status='posted' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id) AND sign(l.amount_cents)=sign(observation.amount_cents) AND abs(e.entry_date-observation.posted_date)<=(SELECT transfer_window_days FROM accounting.settings) AND (filter->>'query' IS NULL OR e.memo ILIKE '%'||(filter->>'query')||'%')),
  eligible AS(SELECT * FROM matching WHERE available_cents::numeric>0),paged AS(SELECT * FROM eligible ORDER BY days_apart,entry_date,line_id LIMIT 50 OFFSET coalesce((filter->>'offset')::integer,0))
  SELECT (SELECT count(*) FROM eligible),(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY days_apart,entry_date,line_id),'[]') FROM paged p) INTO candidate_count,candidates;
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'source_conflict',EXISTS(SELECT 1 FROM accounting.import_rows WHERE id=selected_id AND status='exception'),'remaining_cents',CASE WHEN observation.review='matched' THEN '0' ELSE (abs(observation.amount_cents::numeric)-coalesce((SELECT sum(amount_cents) FROM accounting.bank_matches WHERE bank_transaction_id=observation.id),0))::text END,
   'total',candidate_count,'group',jsonb_build_object('id',selected_id,'bank_transaction_id',observation.id,'entry_date',observation.posted_date,'memo',observation.description,'bank_amount_cents',observation.amount_cents::text,'account_name',(SELECT name FROM accounting.accounts WHERE id=ledger_account),'source_system',observation.source,'source_scope',ledger_account::text,'status',observation.review),'drafts',drafts,'candidates',candidates,'matches',matches);
 END IF;
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'transactions',coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('amount_cents',o.amount_cents::text,
  'matches',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('amount_cents',m.amount_cents::text)),'[]') FROM accounting.bank_matches m WHERE m.bank_transaction_id=o.id)) ORDER BY o.posted_date DESC,o.id),'[]')) INTO result
 FROM (SELECT * FROM accounting.bank_transactions WHERE (filter->>'bank_account_id' IS NULL OR bank_account_id=(filter->>'bank_account_id')::uuid) ORDER BY posted_date DESC,id LIMIT 100 OFFSET coalesce((filter->>'offset')::integer,0)) o;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.banking_guard(),accounting.match_review(),accounting.prior_summary(text,uuid,integer),accounting.rule_candidate(uuid,uuid),accounting.rules_preview(jsonb),accounting.apply_treatment(uuid),accounting.banking_command(jsonb),accounting.sync_server(jsonb),accounting.document_access(text,boolean),accounting.documents(jsonb),accounting.bank_review(jsonb),accounting.prior_treatment(text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.sync_server(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION accounting.rules_preview(jsonb),accounting.document_access(text,boolean),accounting.documents(jsonb),accounting.bank_review(jsonb),accounting.prior_treatment(text,uuid,integer) TO authenticated;
-- ACCOUNTING BANKING END
COMMIT;
