BEGIN;
-- ACCOUNTING LEDGER BEGIN
CREATE SCHEMA accounting;
REVOKE ALL ON SCHEMA accounting FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA accounting TO authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA accounting REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE accounting.settings (
 id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1), owner_user_id uuid NOT NULL REFERENCES auth.users ON DELETE RESTRICT,
 primary_system text NOT NULL DEFAULT 'wave' CHECK(primary_system IN ('wave','admin')), primary_system_since date,
 transfer_window_days smallint NOT NULL DEFAULT 5 CHECK(transfer_window_days BETWEEN 0 AND 30),
 financial_revision bigint NOT NULL DEFAULT 0 CHECK(financial_revision>=0), version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE accounting.accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE CHECK(code IS NULL OR length(code) BETWEEN 1 AND 20),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120), type text NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
 subtype text NOT NULL DEFAULT 'other' CHECK(length(subtype) BETWEEN 1 AND 100), is_contra boolean NOT NULL DEFAULT false,
 parent_id uuid REFERENCES accounting.accounts ON DELETE RESTRICT CHECK(parent_id IS NULL OR parent_id<>id),
 system_purpose text UNIQUE, external_names jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(external_names)='object'),
 is_archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_wave_name ON accounting.accounts((external_names->>'wave')) WHERE external_names->>'wave' IS NOT NULL;
CREATE TABLE accounting.journal_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_date date NOT NULL CHECK(entry_date BETWEEN '1900-01-01' AND '2100-12-31'),
 memo text NOT NULL CHECK(length(btrim(memo)) BETWEEN 1 AND 1000), source_description text, descriptor_key text,
 origin text NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','simplefin','csv','wave','internal')),
 kind text NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','income','expense','transfer','payroll','opening','owner','asset','loan','refund','correction')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','discarded')),
 payee_id uuid, applied_rule_id uuid, transfer_group_id uuid, register_id uuid, import_batch_id uuid,
 reverses_entry_id uuid UNIQUE REFERENCES accounting.journal_entries ON DELETE RESTRICT CHECK(reverses_entry_id<>id),
 replaces_entry_id uuid REFERENCES accounting.journal_entries ON DELETE RESTRICT CHECK(replaces_entry_id<>id),
 reason text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1 CHECK(version>0), created_by uuid REFERENCES auth.users ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz,
 CHECK((status='posted')=(posted_at IS NOT NULL))
);
CREATE INDEX entries_date ON accounting.journal_entries(entry_date,id);
CREATE INDEX entries_descriptor ON accounting.journal_entries(descriptor_key,entry_date DESC) WHERE descriptor_key IS NOT NULL;
CREATE INDEX entries_review ON accounting.journal_entries(entry_date DESC,id) WHERE status='draft';
CREATE TABLE accounting.journal_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_id uuid NOT NULL REFERENCES accounting.journal_entries ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES accounting.accounts ON DELETE RESTRICT,
 amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
 memo text NOT NULL DEFAULT '' CHECK(length(memo)<=500), sort_order smallint NOT NULL CHECK(sort_order BETWEEN 0 AND 999),
 cash_class text CHECK(cash_class IN ('operating','investing','financing','transfer')), UNIQUE(entry_id,sort_order)
);
CREATE INDEX lines_account ON accounting.journal_lines(account_id,entry_id);
CREATE TABLE accounting.periods (
 month date PRIMARY KEY CHECK(extract(day FROM month)=1), status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','locked')),
 locked_at timestamptz, locked_by uuid REFERENCES auth.users ON DELETE RESTRICT, close_snapshot jsonb,
 reopen_reason text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='locked')=(locked_at IS NOT NULL))
);
CREATE TABLE accounting.audit_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor_user_id uuid REFERENCES auth.users ON DELETE RESTRICT,
 actor_kind text NOT NULL CHECK(actor_kind IN ('owner','worker','system')), operation_id uuid NOT NULL,
 table_name text NOT NULL, row_id uuid NOT NULL, action text NOT NULL, before jsonb, after jsonb, reason text NOT NULL DEFAULT ''
);
CREATE INDEX audit_operation ON accounting.audit_log(operation_id,id);
CREATE INDEX audit_row ON accounting.audit_log(table_name,row_id,id DESC);
CREATE TABLE accounting.command_receipts (
 idempotency_key uuid PRIMARY KEY, payload_hash text NOT NULL, actor_user_id uuid NOT NULL REFERENCES auth.users ON DELETE RESTRICT,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION accounting.descriptor_key(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path='' AS $fn$
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
END $fn$;
CREATE FUNCTION accounting.require_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND owner_user_id=actor) THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
 RETURN actor;
END $fn$;
CREATE FUNCTION accounting.write_lock() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(64219071);
 PERFORM 1 FROM accounting.settings WHERE id=1 FOR UPDATE;
END $fn$;
CREATE FUNCTION accounting.require_open(d date) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM accounting.periods WHERE month=date_trunc('month',d)::date AND status='locked') THEN RAISE EXCEPTION 'ACCT_PERIOD_LOCKED'; END IF;
 IF EXISTS(SELECT 1 FROM accounting.periods WHERE month>date_trunc('month',d)::date AND status='locked') THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
END $fn$;
CREATE FUNCTION accounting.guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE e accounting.journal_entries; a accounting.accounts; parent accounting.accounts; d date;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock(); RETURN NULL; END IF;
 IF TG_TABLE_NAME IN ('audit_log','command_receipts') THEN
  IF TG_TABLE_NAME='command_receipts' THEN
   IF TG_OP='DELETE' AND OLD.created_at<now()-interval '90 days' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'ACCT_APPEND_ONLY';
 END IF;
 IF TG_TABLE_NAME='settings' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_SETTINGS_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN RAISE EXCEPTION 'ACCT_OWNER_IMMUTABLE'; END IF;
 ELSIF TG_TABLE_NAME='journal_entries' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='INSERT' THEN
   NEW.descriptor_key:=accounting.descriptor_key(NEW.source_description);
   PERFORM accounting.require_open(NEW.entry_date);
   INSERT INTO accounting.periods(month) VALUES(date_trunc('month',NEW.entry_date)::date) ON CONFLICT DO NOTHING;
  ELSE
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_description IS DISTINCT FROM OLD.source_description OR NEW.descriptor_key IS DISTINCT FROM OLD.descriptor_key OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_PROVENANCE'; END IF;
   IF OLD.transfer_group_id IS NOT NULL AND NEW.transfer_group_id IS DISTINCT FROM OLD.transfer_group_id THEN RAISE EXCEPTION 'ACCT_TRANSFER_GROUP_IMMUTABLE'; END IF;
   IF OLD.status='discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   IF OLD.status='posted' AND (to_jsonb(NEW)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['memo','payee_id','reason','register_id','transfer_group_id','version','updated_at']) THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF OLD.status<>'posted' THEN PERFORM accounting.require_open(OLD.entry_date); PERFORM accounting.require_open(NEW.entry_date); END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
   SELECT * INTO e FROM accounting.journal_entries WHERE id=NEW.reverses_entry_id;
   IF e.status<>'posted' OR NEW.entry_date<e.entry_date OR btrim(NEW.reason)='' THEN RAISE EXCEPTION 'ACCT_INVALID_REVERSAL_DATE_OR_REASON'; END IF;
  END IF;
  IF NEW.replaces_entry_id IS NOT NULL THEN
   SELECT * INTO e FROM accounting.journal_entries WHERE id=NEW.replaces_entry_id;
   IF NEW.entry_date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) OR btrim(NEW.reason)='' THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='journal_lines' THEN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.entry_id<>OLD.entry_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
  PERFORM accounting.require_open(e.entry_date);
  IF TG_OP<>'DELETE' THEN
   SELECT * INTO a FROM accounting.accounts WHERE id=NEW.account_id;
   IF a.is_archived THEN RAISE EXCEPTION 'ACCT_ACCOUNT_ARCHIVED'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  IF TG_OP<>'DELETE' AND (
   (NEW.subtype IN ('bank','cash','undeposited','transit','fixed_asset','accumulated_depreciation','receivable') AND NEW.type<>'asset') OR
   (NEW.subtype IN ('card','loan','payroll_liability') AND NEW.type<>'liability') OR
   (NEW.subtype IN ('owner_equity','retained_earnings','opening_balance') AND NEW.type<>'equity') OR
   (NEW.subtype='revenue' AND NEW.type<>'income') OR
   (NEW.subtype IN ('operating_expense','payroll_expense') AND NEW.type<>'expense') OR
   (NEW.subtype IN ('bank','cash','card') AND NEW.is_contra) OR
   (NEW.subtype='accumulated_depreciation' AND NOT NEW.is_contra)
  ) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_KIND';END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
   IF (NEW.type,NEW.subtype,NEW.is_contra) IS DISTINCT FROM (OLD.type,OLD.subtype,OLD.is_contra) AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.journal_entries posted_entry ON posted_entry.id=l.entry_id WHERE l.account_id=OLD.id AND posted_entry.status='posted') THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
   IF NEW.system_purpose IS DISTINCT FROM OLD.system_purpose AND OLD.system_purpose IS NOT NULL THEN RAISE EXCEPTION 'ACCT_SYSTEM_ACCOUNT'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
   SELECT * INTO parent FROM accounting.accounts WHERE id=NEW.parent_id;
   IF parent.parent_id IS NOT NULL OR parent.type<>NEW.type OR EXISTS(SELECT 1 FROM accounting.accounts WHERE parent_id=NEW.id) THEN RAISE EXCEPTION 'ACCT_INVALID_ACCOUNT_PARENT'; END IF;
  END IF;
  IF NEW.is_archived AND (NEW.system_purpose IS NOT NULL OR coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_lines l JOIN accounting.journal_entries posted_entry ON posted_entry.id=l.entry_id WHERE l.account_id=NEW.id AND posted_entry.status='posted'),0)<>0) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_IN_USE'; END IF;
 ELSIF TG_TABLE_NAME='periods' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.month<>OLD.month THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_ID'; END IF;
   IF OLD.status='locked' AND NEW.status='open' AND btrim(NEW.reopen_reason)='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
  END IF;
  IF NEW.status='locked' AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE status='draft' AND entry_date>=NEW.month AND entry_date<(NEW.month+interval '1 month')::date) THEN RAISE EXCEPTION 'ACCT_DRAFTS_REMAIN'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $fn$;
CREATE FUNCTION accounting.balance_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE entry uuid; e accounting.journal_entries; n integer; s numeric; reversed jsonb; original jsonb;
BEGIN
 IF TG_TABLE_NAME='journal_entries' THEN entry:=NEW.id; ELSIF TG_OP='DELETE' THEN entry:=OLD.entry_id; ELSE entry:=NEW.entry_id; END IF;
 SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
 IF e.status='posted' THEN
  SELECT count(*),coalesce(sum(amount_cents),0) INTO n,s FROM accounting.journal_lines WHERE entry_id=entry;
  IF n<2 OR s<>0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
   SELECT jsonb_agg(jsonb_build_array(account_id,(-amount_cents)::text,sort_order) ORDER BY sort_order) INTO reversed FROM accounting.journal_lines WHERE entry_id=entry;
   SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text,sort_order) ORDER BY sort_order) INTO original FROM accounting.journal_lines WHERE entry_id=e.reverses_entry_id;
   IF reversed IS DISTINCT FROM original THEN RAISE EXCEPTION 'ACCT_REVERSAL_MUST_BE_EXACT'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $fn$;
CREATE FUNCTION accounting.record_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
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
 IF kind<>'owner' THEN actor:=NULL; END IF;
 payload:=coalesce(a,b); identity:=coalesce(payload->>'id',payload->>'month',payload->>'idempotency_key','1');
 action_name:=coalesce(nullif(current_setting('accounting.action',true),''),lower(TG_OP));
 INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after,reason)
 VALUES(actor,kind,op,TG_TABLE_NAME,CASE WHEN identity ~ '^[0-9a-f-]{36}$' THEN identity::uuid ELSE md5(TG_TABLE_NAME||':'||identity)::uuid END,action_name,b,a,coalesce(nullif(current_setting('accounting.reason',true),''),payload->>'reason',''));
 IF TG_TABLE_NAME IN ('accounts','journal_entries','journal_lines','tax_mappings','tax_adjustments','payroll_runs','registers') THEN
  UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 END IF;
 RETURN NULL;
END $fn$;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['settings','accounts','journal_entries','journal_lines','periods','audit_log','command_receipts'] LOOP
  EXECUTE format('ALTER TABLE accounting.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON accounting.%I FROM PUBLIC,anon,authenticated,service_role',t);
  IF t NOT IN ('audit_log','command_receipts') THEN
   EXECUTE format('CREATE TRIGGER write_lock BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH STATEMENT EXECUTE FUNCTION accounting.guard()',t);
   EXECUTE format('CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.guard()',t);
  ELSE
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.guard()',t);
  END IF;
  IF t<>'audit_log' THEN EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.record_audit()',t); END IF;
 END LOOP;
END $triggers$;
CREATE CONSTRAINT TRIGGER entry_balance AFTER INSERT OR UPDATE ON accounting.journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.balance_guard();
CREATE CONSTRAINT TRIGGER line_balance AFTER INSERT OR UPDATE OR DELETE ON accounting.journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.balance_guard();
CREATE FUNCTION accounting.ledger_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t text:=c->>'type'; k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid()); actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 e accounting.journal_entries; account_row accounting.accounts; v integer; x jsonb; line jsonb; idx integer; r jsonb; replacement jsonb; reversal jsonb;
 preserved uuid[]:='{}'; seen uuid[]:='{}'; existing_line uuid; original_date date; category uuid; bank_line accounting.journal_lines; total numeric; allocated bigint; remain bigint; share_sum bigint;
BEGIN
 IF t='cash.allocate' THEN
  SELECT * INTO bank_line FROM accounting.journal_lines WHERE id=k;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=bank_line.entry_id;
  IF e.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE';END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=bank_line.account_id AND subtype IN ('bank','cash','card')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED';END IF;
  IF btrim(coalesce(c->>'reason',''))='' OR jsonb_array_length(c->'allocations')<>1 THEN RAISE EXCEPTION 'ACCT_CASH_OVERRIDE_SINGLE_CLASS';END IF;
  IF (c->'allocations'->0->>'amount_cents')::bigint IS DISTINCT FROM bank_line.amount_cents THEN RAISE EXCEPTION 'ACCT_INVALID_CASH_ALLOCATION';END IF;
  UPDATE accounting.journal_lines SET cash_class=CASE c->'allocations'->0->>'classification' WHEN 'internal_transfer' THEN 'transfer' ELSE c->'allocations'->0->>'classification' END WHERE id=k;
  UPDATE accounting.journal_entries SET reason=c->>'reason' WHERE id=e.id RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t='entry.bulkpost' THEN
  r:='[]';
  IF jsonb_typeof(c->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'entries') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
   r:=r||jsonb_build_array(accounting.ledger_command(x||jsonb_build_object('type','entry.post')));
  END LOOP;
  RETURN jsonb_build_object('id',k,'entries',r);
 ELSIF t='chart.seed' THEN
  IF jsonb_typeof(c->'accounts')<>'array' OR jsonb_array_length(c->'accounts') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'accounts') supplied(value) JOIN accounting.accounts a ON a.id=(supplied.value->>'id')::uuid) THEN RAISE EXCEPTION 'ACCT_CHART_EXISTS'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'accounts') LOOP
   PERFORM accounting.ledger_command(x||jsonb_build_object('type','account.create'));
  END LOOP;
  RETURN jsonb_build_object('id',k);
 ELSIF t='account.create' THEN
  INSERT INTO accounting.accounts(id,code,name,type,subtype,is_contra,parent_id,system_purpose,external_names)
  VALUES(k,nullif(c->>'code',''),c->>'name',c->>'account_type',
    CASE WHEN c->>'subtype' IN ('bank','cash','card','receivable','transit','undeposited','fixed_asset','accumulated_depreciation','loan','payroll_liability','owner_equity','retained_earnings','opening_balance','revenue','operating_expense','payroll_expense','other','cogs','uncategorized') THEN c->>'subtype' ELSE coalesce(nullif(nullif(c->>'cash_kind',''),'none'),nullif(c->>'subtype',''),'other') END,
    CASE WHEN c ? 'normal_side' THEN (c->>'normal_side')<>CASE WHEN c->>'account_type' IN ('asset','expense') THEN 'debit' ELSE 'credit' END ELSE coalesce((c->>'is_contra')::boolean,false) END,
    coalesce(c->>'parent_account_id',c->>'parent_id')::uuid,nullif(coalesce(c->>'purpose',c->>'system_purpose'),''),coalesce(c->'external_names','{}')) RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t='account.update' THEN
  SELECT * INTO account_row FROM accounting.accounts WHERE id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM account_row.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  UPDATE accounting.accounts SET name=coalesce(c->>'name',name),code=CASE WHEN c?'code' THEN nullif(c->>'code','') ELSE code END,
   subtype=CASE WHEN c->>'subtype' IN ('bank','cash','card','receivable','transit','undeposited','fixed_asset','accumulated_depreciation','loan','payroll_liability','owner_equity','retained_earnings','opening_balance','revenue','operating_expense','payroll_expense','other','cogs','uncategorized') THEN c->>'subtype' ELSE coalesce(nullif(nullif(c->>'cash_kind',''),'none'),nullif(c->>'subtype',''),subtype) END,
   parent_id=CASE WHEN c?'parent_account_id' OR c?'parent_id' THEN coalesce(c->>'parent_account_id',c->>'parent_id')::uuid ELSE parent_id END,
   system_purpose=CASE WHEN c?'purpose' THEN nullif(c->>'purpose','') ELSE system_purpose END,
   is_archived=coalesce((c->>'is_archived')::boolean,is_archived),external_names=coalesce(c->'external_names',external_names)
   WHERE id=k RETURNING version INTO v;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t IN ('draft.save','transaction.save','transaction.review') THEN
  IF jsonb_typeof(c->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'lines')>100 THEN RAISE EXCEPTION 'ACCT_INVALID_LINES'; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  IF FOUND THEN
   IF (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(l.id),ARRAY[]::uuid[]) FROM accounting.journal_lines l WHERE l.entry_id=$1 AND EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id)' INTO preserved USING k;
   END IF;
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND NOT (id=ANY(preserved));
   UPDATE accounting.journal_entries SET entry_date=(c->>'entry_date')::date,memo=c->>'memo',kind=coalesce(c->'context'->>'kind',c->>'kind',kind),
    payee_id=CASE WHEN c?'payee_id' OR c->'context'?'payee_id' THEN coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
  ELSE
   IF coalesce((c->>'expected_version')::integer,-1)<>0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   INSERT INTO accounting.journal_entries(id,entry_date,memo,source_description,origin,kind,payee_id,created_by,import_batch_id,register_id,reason)
    VALUES(k,(c->>'entry_date')::date,c->>'memo',c->>'source_description',coalesce(c->>'origin','manual'),coalesce(c->'context'->>'kind',c->>'kind','manual'),
    coalesce(c->>'payee_id',c->'context'->>'payee_id')::uuid,actor,(c->>'import_batch_id')::uuid,(c->>'register_id')::uuid,coalesce(c->>'reason','')) RETURNING version INTO v;
  END IF;
  idx:=0;
  FOR line IN SELECT value FROM jsonb_array_elements(c->'lines') LOOP
   IF coalesce(line->>'amount_cents','') !~ '^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
   SELECT id INTO existing_line FROM accounting.journal_lines WHERE id=ANY(preserved) AND NOT(id=ANY(seen))
    AND account_id=(line->>'account_id')::uuid AND amount_cents=(line->>'amount_cents')::bigint ORDER BY sort_order LIMIT 1;
   IF FOUND THEN
    seen:=array_append(seen,existing_line);
    UPDATE accounting.journal_lines SET memo=coalesce(line->>'memo','') WHERE id=existing_line;
   ELSE
    WHILE EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=k AND sort_order=idx) LOOP idx:=idx+1; END LOOP;
    INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
     VALUES(k,(line->>'account_id')::uuid,(line->>'amount_cents')::bigint,coalesce(line->>'memo',''),idx,line->>'cash_class');
    idx:=idx+1;
   END IF;
  END LOOP;
  IF cardinality(seen)<>cardinality(preserved) THEN RAISE EXCEPTION 'ACCT_MATCHED_LINE_IMMUTABLE'; END IF;
  IF t='transaction.review' THEN
   IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
   RETURN accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSIF t IN ('entry.post','entry.discard','draft.discard','entry.reverse','entry.correct','entry.context','entry.categorize','entry.split','entry.annotate') THEN
  IF t='entry.annotate' THEN k:=(c->>'entry_id')::uuid; END IF;
  SELECT * INTO e FROM accounting.journal_entries WHERE id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF t<>'entry.annotate' AND (c->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t='entry.post' THEN
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN RAISE EXCEPTION 'ACCT_CATEGORY_REQUIRED'; END IF;
   UPDATE accounting.journal_entries SET status='posted',posted_at=now() WHERE id=k RETURNING version INTO v;
  ELSIF t IN ('entry.discard','draft.discard') THEN
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING k;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING k;
   END IF;
   UPDATE accounting.journal_entries SET status='discarded',reason=c->>'reason' WHERE id=k RETURNING version INTO v;
  ELSIF t IN ('entry.reverse','entry.correct') THEN
   IF e.status<>'posted' THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=k) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
   original_date:=coalesce(c->>'reversal_date',c->>'entry_date')::date;
   IF original_date IS NULL OR original_date<e.entry_date OR btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_INVALID_REVERSAL_DATE_OR_REASON'; END IF;
   INSERT INTO accounting.journal_entries(entry_date,memo,origin,kind,reverses_entry_id,reason,created_by,payee_id)
    VALUES(original_date,'Reversal: '||left(e.memo,990),'internal','correction',e.id,c->>'reason',actor,e.payee_id) RETURNING id,version INTO k,v;
   INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order,cash_class)
    SELECT k,account_id,-amount_cents,memo,sort_order,cash_class FROM accounting.journal_lines WHERE entry_id=e.id;
   reversal:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
   IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
    -- A reversal removes the financial treatment, so its bank evidence returns to review.
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1 AND m.amount_cents=0' USING e.id;
    EXECUTE 'DELETE FROM accounting.bank_matches m USING accounting.journal_lines l WHERE m.journal_line_id=l.id AND l.entry_id=$1' USING e.id;
   END IF;
   IF t='entry.correct' THEN
    IF (c->>'entry_date')::date<(SELECT earliest_history_date FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_INVALID_CORRECTION_DATE_OR_REASON'; END IF;
    replacement:=accounting.ledger_command(c||jsonb_build_object('type','draft.save','id',coalesce((c->>'replacement_id')::uuid,gen_random_uuid()),'expected_version',0,'origin','internal','kind','correction','payee_id',e.payee_id));
    k:=(replacement->>'id')::uuid;
    UPDATE accounting.journal_entries SET replaces_entry_id=e.id WHERE id=k RETURNING version INTO v;
    replacement:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',k,'expected_version',v));
    RETURN replacement||jsonb_build_object('reversal_id',reversal->'id','original_id',e.id);
   END IF;
   RETURN reversal;
  ELSIF t IN ('entry.context','entry.annotate') THEN
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),
    payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END,
    kind=CASE WHEN c?'kind' THEN c->>'kind' ELSE kind END,
    reason=coalesce(c->>'note',c->>'reason',reason),register_id=CASE WHEN c?'register_id' THEN (c->>'register_id')::uuid ELSE register_id END WHERE id=k RETURNING version INTO v;
   IF t='entry.annotate' THEN
    INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,after)
     VALUES(auth.uid(),'owner',current_setting('accounting.operation_id')::uuid,'journal_entries',k,'entry.annotate',jsonb_build_object('note_id',c->'id','note',c->'note'));
   END IF;
  ELSE
   IF e.status<>'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   SELECT l.* INTO bank_line FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id
    WHERE l.entry_id=k AND a.subtype IN ('bank','card','cash');
   IF NOT FOUND OR (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=k AND a.subtype IN ('bank','card','cash'))<>1 THEN RAISE EXCEPTION 'ACCT_SIMPLE_MOVEMENT_REQUIRED'; END IF;
   DELETE FROM accounting.journal_lines WHERE entry_id=k AND id<>bank_line.id;
   -- Preserve the bank line's identity so existing observation matches stay attached.
   IF t='entry.categorize' THEN
    category:=coalesce(c->>'account_id',c->>'category_id')::uuid;
    IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REQUIRED'; END IF;
    INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,sort_order) VALUES(k,category,-bank_line.amount_cents,CASE WHEN bank_line.sort_order=0 THEN 1 ELSE 0 END);
   ELSE
    IF jsonb_typeof(c->'splits') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'splits') NOT BETWEEN 2 AND 99 THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'splits') WHERE (value?'share_bps') IS DISTINCT FROM ((c->'splits'->0)?'share_bps')) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
    IF (c->'splits'->0)?'share_bps' THEN
     SELECT sum((value->>'share_bps')::bigint) INTO share_sum FROM jsonb_array_elements(c->'splits');
     IF share_sum<>10000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'splits') WHERE (value->>'share_bps')::bigint<=0) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
     total:=abs(bank_line.amount_cents::numeric);
     SELECT (total-sum(trunc(total*(value->>'share_bps')::numeric/10000)))::bigint INTO remain FROM jsonb_array_elements(c->'splits');
    END IF;
    -- Allocation below works for exact-cent splits or basis-point shares without floating point.
    idx:=0; total:=0;
    FOR line IN SELECT value FROM jsonb_array_elements(c->'splits') LOOP
     IF line?'share_bps' THEN
      SELECT (trunc(abs(bank_line.amount_cents::numeric)*(line->>'share_bps')::numeric/10000)+CASE WHEN rank<=remain THEN 1 ELSE 0 END)::bigint * CASE WHEN bank_line.amount_cents>0 THEN -1 ELSE 1 END INTO allocated
      FROM (SELECT ordinality-1 ordinal,row_number() OVER(ORDER BY mod(abs(bank_line.amount_cents::numeric)*(value->>'share_bps')::numeric,10000) DESC,ordinality) rank FROM jsonb_array_elements(c->'splits') WITH ORDINALITY) ranked WHERE ordinal=idx;
     ELSE
      IF coalesce(line->>'amount_cents','')!~'^-?[0-9]+$' THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS'; END IF;
      allocated:=(line->>'amount_cents')::bigint;
     END IF;
     IF EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(line->>'account_id')::uuid AND subtype IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REQUIRED'; END IF;
     IF allocated=0 OR sign(allocated)=sign(bank_line.amount_cents) THEN RAISE EXCEPTION 'ACCT_INVALID_SPLIT'; END IF;
     total:=total+allocated;
     INSERT INTO accounting.journal_lines(entry_id,account_id,amount_cents,memo,sort_order) VALUES(k,(line->>'account_id')::uuid,allocated,coalesce(line->>'memo',''),CASE WHEN idx>=bank_line.sort_order THEN idx+1 ELSE idx END);
     idx:=idx+1;
    END LOOP;
    IF total<>-bank_line.amount_cents THEN RAISE EXCEPTION 'ACCT_UNBALANCED'; END IF;
   END IF;
   UPDATE accounting.journal_entries SET memo=coalesce(c->>'memo',memo),kind=coalesce(c->>'kind',kind),payee_id=CASE WHEN c?'payee_id' THEN (c->>'payee_id')::uuid ELSE payee_id END WHERE id=k RETURNING version INTO v;
   IF coalesce((c->>'remember')::boolean,false) AND e.descriptor_key IS NOT NULL THEN
    PERFORM accounting.banking_command(jsonb_build_object('type','alias.save','id',gen_random_uuid(),'party_id',c->'payee_id','match_kind','key','pattern',e.descriptor_key,'enabled',true,'expected_version',0));
   END IF;
  END IF;
  RETURN jsonb_build_object('id',k,'version',v);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
END $fn$;
CREATE FUNCTION accounting.operate(command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE c jsonb:=command->'command'; key uuid:=(command->>'key')::uuid; actor uuid; receipt accounting.command_receipts; hash text; result jsonb; t text; current_version integer; initialized boolean:=false;
BEGIN
 IF key IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM accounting.write_lock();
 t:=c->>'type'; actor:=auth.uid();
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t='settings.save' AND NOT EXISTS(SELECT 1 FROM accounting.settings) THEN
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO accounting.settings(owner_user_id) VALUES(actor); initialized:=true;
 END IF;
 actor:=accounting.require_owner(); hash:=encode(sha256(convert_to(c::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM accounting.command_receipts WHERE idempotency_key=key;
 IF FOUND THEN
  IF receipt.actor_user_id<>actor OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 IF c?'expected_revision' AND (c->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM accounting.settings WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_REVISION'; END IF;
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind','owner',true);
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
END $fn$;
CREATE FUNCTION accounting.entry_detail(entry uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb; extra jsonb; bank_account uuid;
BEGIN
 PERFORM accounting.require_owner();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
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
 END IF;
 IF to_regclass('accounting.document_links') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(d)),''[]''::jsonb) FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('documents',extra);
 END IF;
 RETURN result;
END $fn$;
CREATE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}',page jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc');
BEGIN
 PERFORM accounting.require_owner();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded') OR (f->>'from')::date>(f->>'to')::date THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) ELSE e.status=f->>'status' END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR e.payee_id=(f->>'payee')::uuid)
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (f->>'query' IS NULL OR e.memo ILIKE '%'||(f->>'query')||'%' OR e.source_description ILIKE '%'||(f->>'query')||'%')
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='draft')) INTO result;
 RETURN result;
END $fn$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA accounting FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.operate(jsonb),accounting.transactions(jsonb,jsonb),accounting.entry_detail(uuid),accounting.descriptor_key(text) TO authenticated;
-- No accounts are seeded. The chart comes from the owner's own data (the Wave
-- import creates accounts with Wave's classification) or from the Accounts
-- screen, where system roles such as transfers in transit and the two
-- uncategorized accounts are assigned by purpose.
-- ACCOUNTING LEDGER END
COMMIT;
