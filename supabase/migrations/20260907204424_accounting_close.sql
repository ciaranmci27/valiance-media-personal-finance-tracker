BEGIN;
-- ACCOUNTING CLOSE BEGIN
CREATE TABLE accounting.reconciliations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bank_account_id uuid NOT NULL REFERENCES accounting.bank_accounts ON DELETE RESTRICT,
 statement_start date NOT NULL,statement_end date NOT NULL CHECK(statement_end>=statement_start),opening_balance_cents bigint NOT NULL,ending_balance_cents bigint NOT NULL,
 document_id uuid REFERENCES accounting.documents ON DELETE RESTRICT,status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),difference_cents bigint NOT NULL,
 notes text NOT NULL DEFAULT '',completed_at timestamptz,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK((status='completed')=(completed_at IS NOT NULL)),CHECK(status<>'completed' OR difference_cents=0)
);
CREATE TABLE accounting.reconciliation_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reconciliation_id uuid NOT NULL REFERENCES accounting.reconciliations ON DELETE RESTRICT,journal_line_id uuid NOT NULL UNIQUE REFERENCES accounting.journal_lines ON DELETE RESTRICT,
 amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE accounting.document_links ADD CONSTRAINT document_reconciliation_fk FOREIGN KEY(reconciliation_id) REFERENCES accounting.reconciliations ON DELETE RESTRICT;
CREATE FUNCTION accounting.close_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r accounting.reconciliations;l accounting.journal_lines;entry accounting.journal_entries;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
   UPDATE accounting.reconciliations SET status='in_progress',completed_at=NULL WHERE status='completed' AND NEW.entry_date BETWEEN statement_start AND statement_end
    AND bank_account_id IN(SELECT b.id FROM accounting.journal_lines jl JOIN accounting.bank_accounts b ON b.account_id=jl.account_id WHERE jl.entry_id=NEW.id);
  END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='reconciliations' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.status='completed' AND NEW.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
   IF OLD.status='completed' AND (NEW.bank_account_id,NEW.statement_start,NEW.statement_end,NEW.opening_balance_cents,NEW.ending_balance_cents,NEW.document_id) IS DISTINCT FROM (OLD.bank_account_id,OLD.statement_start,OLD.statement_end,OLD.opening_balance_cents,OLD.ending_balance_cents,OLD.document_id) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
   NEW.version:=OLD.version+1;NEW.updated_at:=now();
  END IF;
  NEW.difference_cents:=NEW.ending_balance_cents-NEW.opening_balance_cents-coalesce((SELECT sum(amount_cents) FROM accounting.reconciliation_items WHERE reconciliation_id=NEW.id),0);
  IF NEW.status='completed' AND NEW.difference_cents<>0 THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_DIFFERENCE';END IF;
 ELSE
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'ACCT_ALLOCATION_IMMUTABLE';END IF;
  SELECT * INTO r FROM accounting.reconciliations WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
  IF r.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
  IF TG_OP='DELETE' THEN
   IF btrim(coalesce(current_setting('accounting.reason',true),''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   RETURN OLD;
  END IF;
  SELECT * INTO l FROM accounting.journal_lines WHERE id=NEW.journal_line_id;SELECT * INTO entry FROM accounting.journal_entries WHERE id=l.entry_id;
  IF l.account_id IS DISTINCT FROM (SELECT account_id FROM accounting.bank_accounts WHERE id=r.bank_account_id) OR entry.status IS DISTINCT FROM 'posted' OR entry.entry_date>r.statement_end OR sign(l.amount_cents)<>sign(NEW.amount_cents) OR abs(NEW.amount_cents)>abs(l.amount_cents) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_ALLOCATION';END IF;
 END IF;
 UPDATE accounting.settings SET financial_revision=financial_revision+1 WHERE id=1;
 RETURN NEW;
END $fn$;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['reconciliations','reconciliation_items'] LOOP
  EXECUTE format('ALTER TABLE accounting.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON accounting.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER write_lock BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH STATEMENT EXECUTE FUNCTION accounting.close_guard()',t);
  EXECUTE format('CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.close_guard()',t);
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.record_audit()',t);
 END LOOP;
END $triggers$;
CREATE TRIGGER reconciliation_reopen AFTER INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.close_guard();
CREATE FUNCTION accounting.close_checklist(month date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE ending date:=(month+interval '1 month - 1 day')::date;drafts integer;mismatches integer;balances jsonb;observations jsonb;
BEGIN
 PERFORM accounting.require_owner();IF extract(day FROM month)<>1 THEN RAISE EXCEPTION 'ACCT_MONTH_REQUIRED';END IF;
 SELECT count(*) INTO drafts FROM accounting.journal_entries WHERE entry_date BETWEEN month AND ending AND status='draft';
 SELECT count(*) INTO mismatches FROM (SELECT DISTINCT ON(fiscal_year,kind) * FROM accounting.history_checks WHERE fiscal_year=extract(year FROM month) ORDER BY fiscal_year,kind,checked_at DESC,id DESC) checks WHERE status='mismatch';
 balances:=accounting.report('account_balances',jsonb_build_object('from',month,'to',ending));
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'account_id',b.account_id,'name',a.name,'book_cents',coalesce(r->>'ending_cents','0'),'observed_balance_cents',b.observed_balance_cents::text,'observed_at',b.observed_at,
  'difference_cents',CASE WHEN b.observed_balance_cents IS NULL THEN NULL ELSE (coalesce((r->>'ending_cents')::bigint,0)-b.observed_balance_cents)::text END) ORDER BY a.name),'[]') INTO observations
  FROM accounting.bank_accounts b JOIN accounting.accounts a ON a.id=b.account_id LEFT JOIN LATERAL (SELECT value r FROM jsonb_array_elements(balances->'rows') WHERE value->>'id'=b.account_id::text) q ON true WHERE NOT b.is_closed;
 RETURN jsonb_build_object('month',month,'month_start',month,'through',ending,'month_ended',ending<(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'reports',accounting.workspace(month,ending),'accounts',observations,'revision',(SELECT financial_revision::text FROM accounting.settings),'drafts',drafts,'history_mismatches',mismatches,'ready',drafts=0 AND mismatches=0,'banks',observations,
  'period',(SELECT to_jsonb(p) FROM accounting.periods p WHERE p.month=close_checklist.month));
END $fn$;
CREATE FUNCTION accounting.close_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t text:=c->>'type';key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=accounting.require_owner();r accounting.reconciliations;period accounting.periods;
 v integer;bank uuid;x jsonb;month_date date:=(c->>'month')::date;ending date;checklist jsonb;snapshot jsonb;
BEGIN
 IF t='period.close' THEN t:='period.lock';END IF;
 IF t='reconciliation.unmatch' THEN t:='reconciliation.item.remove';c:=c||jsonb_build_object('item_id',c->'allocation_id');PERFORM set_config('accounting.reason',coalesce(nullif(c->>'reason',''),'Owner removed reconciliation selection'),true);END IF;
 IF t IN ('period.lock','period.reopen') THEN
  IF month_date IS NULL OR extract(day FROM month_date)<>1 THEN RAISE EXCEPTION 'ACCT_MONTH_REQUIRED';END IF;
  SELECT * INTO period FROM accounting.periods WHERE month=month_date;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM coalesce(period.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='period.lock' THEN
   IF period.status='locked' THEN RAISE EXCEPTION 'ACCT_PERIOD_LOCKED';END IF;
   checklist:=accounting.close_checklist(month_date);
   IF (checklist->>'drafts')::integer<>0 THEN RAISE EXCEPTION 'ACCT_DRAFTS_EXIST';END IF;
   IF NOT (checklist->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_CLOSE_NOT_READY';END IF;
   ending:=(month_date+interval '1 month - 1 day')::date;
   snapshot:=jsonb_build_object('financial_revision',(SELECT financial_revision::text FROM accounting.settings),'trial_balance',accounting.report('trial_balance',jsonb_build_object('as_of',ending)),
    'profit_loss',accounting.report('profit_loss',jsonb_build_object('from',month_date,'to',ending)),'balance_sheet',accounting.report('balance_sheet',jsonb_build_object('as_of',ending)));
   INSERT INTO accounting.periods(month,status,locked_at,locked_by,close_snapshot) VALUES(month_date,'locked',now(),actor,snapshot)
    ON CONFLICT(month) DO UPDATE SET status='locked',locked_at=excluded.locked_at,locked_by=excluded.locked_by,close_snapshot=excluded.close_snapshot,reopen_reason='' RETURNING version INTO v;
  ELSE
   IF period.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'ACCT_PERIOD_NOT_LOCKED';END IF;
   IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
   -- Reopening an earlier month also reopens dependent later snapshots atomically.
   UPDATE accounting.periods SET status='open',locked_at=NULL,locked_by=NULL,close_snapshot=NULL,reopen_reason=c->>'reason' WHERE month>=month_date AND status='locked';
   SELECT version INTO v FROM accounting.periods WHERE month=month_date;
  END IF;
 ELSIF t IN ('reconciliation.save','reconciliation.create') THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM coalesce(r.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF r.status='completed' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_COMPLETED';END IF;
  bank:=(c->>'bank_account_id')::uuid;
  IF bank IS NULL THEN
   SELECT id INTO bank FROM accounting.bank_accounts WHERE account_id=(c->>'account_id')::uuid;
   IF bank IS NULL THEN INSERT INTO accounting.bank_accounts(account_id) VALUES((c->>'account_id')::uuid) RETURNING id INTO bank;END IF;
  END IF;
  INSERT INTO accounting.reconciliations(id,bank_account_id,statement_start,statement_end,opening_balance_cents,ending_balance_cents,document_id,difference_cents,notes)
   VALUES(key,bank,coalesce(c->>'statement_start',c->>'from')::date,coalesce(c->>'statement_end',c->>'to')::date,coalesce(c->>'opening_balance_cents',c->>'opening_cents')::bigint,coalesce(c->>'ending_balance_cents',c->>'ending_cents')::bigint,(c->>'document_id')::uuid,0,coalesce(c->>'notes',''))
   ON CONFLICT(id) DO UPDATE SET statement_start=excluded.statement_start,statement_end=excluded.statement_end,opening_balance_cents=excluded.opening_balance_cents,ending_balance_cents=excluded.ending_balance_cents,document_id=excluded.document_id,notes=excluded.notes RETURNING version INTO v;
  IF c?'items' THEN
   PERFORM set_config('accounting.reason',coalesce(c->>'reason','Owner updated reconciliation selection'),true);
   DELETE FROM accounting.reconciliation_items WHERE reconciliation_id=key;
   FOR x IN SELECT value FROM jsonb_array_elements(c->'items') LOOP
    INSERT INTO accounting.reconciliation_items(id,reconciliation_id,journal_line_id,amount_cents) VALUES(coalesce((x->>'id')::uuid,gen_random_uuid()),key,coalesce(x->>'journal_line_id',x->>'line_id')::uuid,(x->>'amount_cents')::bigint);
   END LOOP;
   UPDATE accounting.reconciliations SET updated_at=now() WHERE id=key RETURNING version INTO v;
  END IF;
 ELSIF t='reconciliation.allocate' THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(c->'allocations') LOOP
   INSERT INTO accounting.reconciliation_items(id,reconciliation_id,journal_line_id,amount_cents) VALUES((x->>'id')::uuid,key,coalesce(x->>'journal_line_id',x->>'entry_line_id')::uuid,(x->>'amount_cents')::bigint);
  END LOOP;
  UPDATE accounting.reconciliations SET updated_at=now() WHERE id=key RETURNING version INTO v;
 ELSIF t IN ('reconciliation.complete','reconciliation.reopen','reconciliation.item.remove') THEN
  SELECT * INTO r FROM accounting.reconciliations WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF r.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='reconciliation.item.remove' THEN DELETE FROM accounting.reconciliation_items WHERE id=(c->>'item_id')::uuid AND reconciliation_id=key;
  ELSIF t='reconciliation.reopen' AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED';END IF;
  UPDATE accounting.reconciliations SET status=CASE t WHEN 'reconciliation.complete' THEN 'completed' ELSE 'in_progress' END,completed_at=CASE WHEN t='reconciliation.complete' THEN now() ELSE NULL END WHERE id=key RETURNING version INTO v;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_build_object('id',key,'version',v);
END $fn$;
REVOKE ALL ON FUNCTION accounting.close_guard(),accounting.close_command(jsonb),accounting.close_checklist(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.close_checklist(date) TO authenticated;
-- ACCOUNTING CLOSE END
COMMIT;
