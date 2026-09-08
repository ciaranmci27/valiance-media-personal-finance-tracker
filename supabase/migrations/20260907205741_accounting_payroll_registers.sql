BEGIN;
-- ACCOUNTING PAYROLL REGISTERS BEGIN
CREATE TABLE accounting.payroll_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text NOT NULL DEFAULT 'patriot' CHECK(provider='patriot'),provider_run_id text NOT NULL UNIQUE,
 pay_date date NOT NULL,period_start date NOT NULL,period_end date NOT NULL CHECK(period_end>=period_start),gross_cents bigint NOT NULL CHECK(gross_cents>=0),net_cents bigint NOT NULL CHECK(net_cents>=0),employee_withholding_cents bigint NOT NULL CHECK(employee_withholding_cents>=0),employer_tax_cents bigint NOT NULL CHECK(employer_tax_cents>=0),
 components jsonb NOT NULL CHECK(jsonb_typeof(components)='array'),entry_id uuid UNIQUE REFERENCES accounting.journal_entries ON DELETE RESTRICT,document_id uuid REFERENCES accounting.documents ON DELETE RESTRICT,ytd jsonb,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','void')),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users ON DELETE RESTRICT,updated_at timestamptz NOT NULL DEFAULT now(),CHECK(status<>'posted' OR entry_id IS NOT NULL)
);
CREATE TABLE accounting.registers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('fixed_asset','loan')),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),account_id uuid NOT NULL REFERENCES accounting.accounts ON DELETE RESTRICT,contra_account_id uuid REFERENCES accounting.accounts ON DELETE RESTRICT,
 started_on date NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>=0),in_service_on date,method text NOT NULL DEFAULT '',schedule jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(schedule)='array'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disposed','paid_off')),ended_on date,notes text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(status='active' OR ended_on IS NOT NULL)
);
ALTER TABLE accounting.journal_entries ADD CONSTRAINT entries_register_fk FOREIGN KEY(register_id) REFERENCES accounting.registers ON DELETE RESTRICT;
ALTER TABLE accounting.document_links ADD CONSTRAINT document_payroll_fk FOREIGN KEY(payroll_run_id) REFERENCES accounting.payroll_runs ON DELETE RESTRICT;
ALTER TABLE accounting.document_links ADD CONSTRAINT document_register_fk FOREIGN KEY(register_id) REFERENCES accounting.registers ON DELETE RESTRICT;
CREATE FUNCTION accounting.register_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE tracked accounting.registers;invalid boolean;
BEGIN
 IF TG_LEVEL='STATEMENT' THEN PERFORM accounting.write_lock();RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';END IF;
 IF TG_TABLE_NAME='journal_entries' THEN
  IF TG_WHEN='AFTER' AND NEW.status='posted' AND NEW.register_id IS NOT NULL THEN
   SELECT * INTO tracked FROM accounting.registers WHERE id=NEW.register_id;
   WITH daily AS(SELECT e.entry_date,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=tracked.account_id),0) cost,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=tracked.contra_account_id),0) contra
    FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=tracked.id AND e.status='posted' GROUP BY e.entry_date),running AS(SELECT sum(cost) OVER(ORDER BY entry_date) cost,sum(contra) OVER(ORDER BY entry_date) contra FROM daily)
    SELECT coalesce(bool_or(CASE WHEN tracked.kind='loan' THEN cost>0 ELSE cost<0 OR contra>0 OR cost+contra<0 END),false) INTO invalid FROM running;
   IF invalid THEN RAISE EXCEPTION 'ACCT_REGISTER_NEGATIVE_BASIS';END IF;
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs p CROSS JOIN LATERAL jsonb_array_elements(p.components) component(value) JOIN accounting.journal_lines l ON l.id=(component.value->>'source_line_id')::uuid WHERE p.status='posted' AND component.value->>'kind'='noncash_reclass' AND l.entry_id=NEW.reverses_entry_id) THEN RAISE EXCEPTION 'ACCT_NONCASH_DEPENDENCY';END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.payroll_runs WHERE entry_id=NEW.reverses_entry_id AND status='posted') AND current_setting('accounting.action',true)<>'payroll.void' THEN RAISE EXCEPTION 'ACCT_PAYROLL_VOID_REQUIRED';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='payroll_runs' THEN
   IF OLD.status<>'draft' AND (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at']) THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
   IF OLD.status='void' OR (OLD.status='posted' AND NEW.status<>'void') THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
  ELSE
   IF (NEW.kind,NEW.account_id,NEW.contra_account_id,NEW.started_on,NEW.amount_cents) IS DISTINCT FROM (OLD.kind,OLD.account_id,OLD.contra_account_id,OLD.started_on,OLD.amount_cents) AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=OLD.id AND status='posted') THEN RAISE EXCEPTION 'ACCT_REGISTER_FINANCIAL_TERMS_FROZEN';END IF;
  END IF;
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $fn$;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_runs','registers'] LOOP
  EXECUTE format('ALTER TABLE accounting.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON accounting.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER write_lock BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH STATEMENT EXECUTE FUNCTION accounting.register_guard()',t);
  EXECUTE format('CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.register_guard()',t);
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.record_audit()',t);
 END LOOP;
END $triggers$;
CREATE TRIGGER register_balance_guard AFTER INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.register_guard();
CREATE TRIGGER payroll_reversal_guard BEFORE INSERT ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.register_guard();
CREATE FUNCTION accounting.register_plan(requested_id uuid,body jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE reg accounting.registers;config jsonb;lines jsonb;action_kind text;action_date date;amount bigint;cost bigint;depreciation bigint;principal bigint;total bigint;
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO reg FROM accounting.registers WHERE registers.id=requested_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
   action_kind:=body->>'kind';action_date:=(body->>'date')::date;amount:=(body->>'amount_cents')::bigint;
   IF reg.status<>'active' OR action_date<reg.started_on OR amount<0 THEN RAISE EXCEPTION 'ACCT_REGISTER_ACTION';END IF;
   IF body?'schedule_row_key' AND EXISTS(SELECT 1 FROM jsonb_array_elements(reg.schedule) WHERE value->>'schedule_row_key'=body->>'schedule_row_key' AND value->>'entry_id' IS NOT NULL AND NOT value?'void') THEN RAISE EXCEPTION 'ACCT_REGISTER_ALREADY_POSTED';END IF;
   SELECT value INTO config FROM jsonb_array_elements(reg.schedule) WHERE value->>'kind'='configuration';
   IF (action_kind='depreciation' OR (action_kind='payment' AND coalesce((body->>'interest_cents')::bigint,0)>0)) AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(config->>'expense_account_id')::uuid AND type='expense') THEN RAISE EXCEPTION 'ACCT_REGISTER_EXPENSE_ACCOUNT';END IF;
   IF action_kind='payment' AND coalesce((body->>'fee_cents')::bigint,0)>0 AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(config->>'fee_account_id')::uuid AND type='expense') THEN RAISE EXCEPTION 'ACCT_REGISTER_EXPENSE_ACCOUNT';END IF;
   SELECT coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=reg.account_id),0),-coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=reg.contra_account_id),0) INTO cost,depreciation FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=reg.id AND e.status='posted' AND e.entry_date<=action_date;
   principal:=-cost;
   IF reg.kind='fixed_asset' AND action_kind='acquisition' THEN
    IF cost<>0 OR amount<>reg.amount_cents THEN RAISE EXCEPTION 'ACCT_REGISTER_COST';END IF;
    lines:=jsonb_build_array(jsonb_build_object('account_id',reg.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',body->'counter_account_id','amount_cents',(-amount)::text));
   ELSIF reg.kind='fixed_asset' AND action_kind='depreciation' THEN
    IF action_date<reg.in_service_on OR amount>cost-depreciation OR amount<=0 THEN RAISE EXCEPTION 'ACCT_DEPRECIATION_EXCEEDS_BASIS';END IF;
    lines:=jsonb_build_array(jsonb_build_object('account_id',config->'expense_account_id','amount_cents',amount::text),jsonb_build_object('account_id',reg.contra_account_id,'amount_cents',(-amount)::text));
   ELSIF reg.kind='fixed_asset' AND action_kind='disposal' THEN
    IF cost<=0 THEN RAISE EXCEPTION 'ACCT_REGISTER_COST';END IF;
    IF cost-depreciation-amount<>0 AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(body->>'gain_loss_account_id')::uuid AND type=CASE WHEN cost-depreciation-amount>0 THEN 'expense' ELSE 'income' END) THEN RAISE EXCEPTION 'ACCT_REGISTER_GAIN_LOSS_ACCOUNT';END IF;
    lines:=jsonb_build_array(jsonb_build_object('account_id',body->'counter_account_id','amount_cents',amount::text),jsonb_build_object('account_id',reg.contra_account_id,'amount_cents',depreciation::text),jsonb_build_object('account_id',reg.account_id,'amount_cents',(-cost)::text),jsonb_build_object('account_id',body->'gain_loss_account_id','amount_cents',(cost-depreciation-amount)::text));
   ELSIF reg.kind='loan' AND action_kind='draw' THEN
    lines:=jsonb_build_array(jsonb_build_object('account_id',body->'counter_account_id','amount_cents',amount::text),jsonb_build_object('account_id',reg.account_id,'amount_cents',(-amount)::text));
   ELSIF reg.kind='loan' AND action_kind='payment' THEN
    IF amount>principal OR amount<0 OR coalesce((body->>'interest_cents')::bigint,0)<0 OR coalesce((body->>'fee_cents')::bigint,0)<0 THEN RAISE EXCEPTION 'ACCT_LOAN_PAYMENT_EXCEEDS_PRINCIPAL';END IF;
    total:=amount+coalesce((body->>'interest_cents')::bigint,0)+coalesce((body->>'fee_cents')::bigint,0);
    lines:=jsonb_build_array(jsonb_build_object('account_id',reg.account_id,'amount_cents',amount::text),jsonb_build_object('account_id',config->'expense_account_id','amount_cents',coalesce(body->>'interest_cents','0')),jsonb_build_object('account_id',config->'fee_account_id','amount_cents',coalesce(body->>'fee_cents','0')),jsonb_build_object('account_id',body->'counter_account_id','amount_cents',(-total)::text));
   ELSE RAISE EXCEPTION 'ACCT_REGISTER_ACTION';END IF;
   SELECT jsonb_agg(value) INTO lines FROM jsonb_array_elements(lines) WHERE (value->>'amount_cents')::bigint<>0;
 RETURN jsonb_build_object('lines',coalesce(lines,'[]'),'cost_delta',CASE action_kind WHEN 'acquisition' THEN amount WHEN 'disposal' THEN -cost ELSE 0 END::text,
 'depreciation_delta',CASE action_kind WHEN 'depreciation' THEN amount WHEN 'disposal' THEN -depreciation ELSE 0 END::text,
 'principal_delta',CASE action_kind WHEN 'draw' THEN amount WHEN 'payment' THEN -amount ELSE 0 END::text,'gain_cents',CASE WHEN action_kind='disposal' THEN amount-cost+depreciation ELSE 0 END::text,
 'state',jsonb_build_object('cost_cents',CASE WHEN reg.kind='fixed_asset' THEN cost ELSE 0 END::text,'depreciation_cents',depreciation::text,'carrying_cents',CASE WHEN reg.kind='fixed_asset' THEN cost-depreciation ELSE 0 END::text,'principal_cents',CASE WHEN reg.kind='loan' THEN principal ELSE 0 END::text,'initialized',EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=reg.id AND status='posted' AND entry_date<=action_date),'disposed',reg.status='disposed' AND reg.ended_on<=action_date));
END $fn$;
CREATE FUNCTION accounting.payroll_plan(c jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE run accounting.payroll_runs;mode text:=coalesce(c->>'template','cash');bank uuid;wages uuid;taxes uuid;lines jsonb:='[]';x jsonb;amount bigint;action_kind text;
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO run FROM accounting.payroll_runs WHERE id=(c->>'id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
   IF run.status<>'draft' THEN RAISE EXCEPTION 'ACCT_PAYROLL_ALREADY_POSTED';END IF;
   IF c->>'verified'='false' THEN RAISE EXCEPTION 'ACCT_PAYROLL_EVIDENCE';END IF;
   IF jsonb_array_length(coalesce(run.ytd->'run_employees','[]'))>0 THEN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.ytd->'run_employees') WHERE coalesce(value->>'gross_cash_cents','')!~'^[0-9]+$') OR
     (SELECT sum((value->>'gross_cash_cents')::numeric) FROM jsonb_array_elements(run.ytd->'run_employees'))<>run.gross_cents OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(run.ytd->'run_employees') GROUP BY value->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'ACCT_PAYROLL_EMPLOYEE_TOTALS';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) WHERE value->>'kind' IN ('officer_wages','other_wages')) AND
     (SELECT coalesce(sum((value->>'gross_cash_cents')::numeric),0) FROM jsonb_array_elements(run.ytd->'run_employees') WHERE value->>'is_officer'='true')<>
     (SELECT coalesce(sum((value->>'amount_cents')::numeric),0) FROM jsonb_array_elements(run.components) WHERE value->>'kind'='officer_wages') THEN RAISE EXCEPTION 'ACCT_PAYROLL_EMPLOYEE_TOTALS';END IF;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM accounting.documents d JOIN storage.objects o ON o.name=d.storage_path AND o.bucket_id='accounting-private' WHERE d.id=run.document_id AND d.status<>'archived') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employee_tax') AND (SELECT sum((component.value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employee_tax')<>run.employee_withholding_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employer_tax') AND (SELECT sum((component.value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind'='employer_tax')<>run.employer_tax_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) WHERE value->>'kind'='net_pay') AND (SELECT sum((value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) WHERE value->>'kind'='net_pay')<>run.net_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   IF mode='cash' THEN
    IF run.gross_cents<>run.net_cents+run.employee_withholding_cents OR EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) WHERE value->>'kind' NOT IN ('officer_wages','other_wages','net_pay','employee_tax','employer_tax')) THEN RAISE EXCEPTION 'ACCT_CASH_PAYROLL_COMPONENTS_REQUIRE_EXPLICIT_TEMPLATE';END IF;
    bank:=(c->>'bank_account_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=bank AND subtype IN ('bank','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED';END IF;
    SELECT id INTO wages FROM accounting.accounts WHERE system_purpose='officer_wages';SELECT id INTO taxes FROM accounting.accounts WHERE system_purpose='employer_payroll_taxes';
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind' IN ('officer_wages','other_wages')) THEN
     IF (SELECT sum((component.value->>'amount_cents')::bigint) FROM jsonb_array_elements(run.components) component(value) WHERE component.value->>'kind' IN ('officer_wages','other_wages'))<>run.gross_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
     FOR x IN SELECT value FROM jsonb_array_elements(run.components) WHERE value->>'kind' IN ('officer_wages','other_wages') LOOP
      IF x->>'kind'='other_wages' AND x->>'account_id' IS NULL THEN RAISE EXCEPTION 'ACCT_PAYROLL_WAGE_ACCOUNT_REQUIRED';END IF;
      IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=coalesce((x->>'account_id')::uuid,wages) AND type='expense') THEN RAISE EXCEPTION 'ACCT_PAYROLL_WAGE_ACCOUNT_REQUIRED';END IF;
      lines:=lines||jsonb_build_array(jsonb_build_object('account_id',coalesce((x->>'account_id')::uuid,wages),'amount_cents',x->>'amount_cents'));
     END LOOP;
    ELSE lines:=jsonb_build_array(jsonb_build_object('account_id',wages,'amount_cents',run.gross_cents::text));END IF;
    lines:=lines||jsonb_build_array(jsonb_build_object('account_id',taxes,'amount_cents',run.employer_tax_cents::text),jsonb_build_object('account_id',bank,'amount_cents',(-run.net_cents)::text),jsonb_build_object('account_id',bank,'amount_cents',(-run.employee_withholding_cents-run.employer_tax_cents)::text));
   ELSIF mode='accrual' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(run.components) LOOP
     amount:=(x->>'amount_cents')::bigint;action_kind:=x->>'kind';
     IF action_kind IN ('officer_wages','other_wages','reimbursement','employer_tax','employer_retirement','employer_benefit','provider_fee','noncash_reclass') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(x->>'account_id')::uuid AND type='expense') THEN RAISE EXCEPTION 'ACCT_PAYROLL_EXPENSE_ACCOUNT';END IF;
     IF action_kind IN ('net_pay','employee_tax','retirement_deferral','other_deduction') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(x->>'account_id')::uuid AND type='liability') THEN RAISE EXCEPTION 'ACCT_PAYROLL_LIABILITY_ACCOUNT';END IF;
     IF action_kind IN ('employer_tax','employer_retirement','employer_benefit','provider_fee') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(x->>'offset_account_id')::uuid AND type='liability') THEN RAISE EXCEPTION 'ACCT_PAYROLL_LIABILITY_ACCOUNT';END IF;
     IF action_kind IN ('officer_wages','other_wages','reimbursement') THEN lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',amount::text));
     ELSIF action_kind IN ('net_pay','employee_tax','retirement_deferral','other_deduction') THEN lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',(-amount)::text));
     ELSIF action_kind='noncash_reclass' THEN
      IF NOT EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.id=(x->>'source_line_id')::uuid AND l.account_id=(x->>'offset_account_id')::uuid AND l.amount_cents>0 AND e.status='posted' AND e.entry_date<=run.pay_date AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=e.id)) THEN RAISE EXCEPTION 'ACCT_NONCASH_SOURCE_REQUIRED';END IF;
      IF (SELECT sum((part.value->>'amount_cents')::numeric) FROM jsonb_array_elements(run.components) part(value) WHERE part.value->>'kind'='noncash_reclass' AND part.value->>'source_line_id'=x->>'source_line_id')+coalesce((SELECT sum((component.value->>'amount_cents')::bigint) FROM accounting.payroll_runs p CROSS JOIN LATERAL jsonb_array_elements(p.components) component(value) WHERE p.status='posted' AND component.value->>'kind'='noncash_reclass' AND component.value->>'source_line_id'=x->>'source_line_id'),0)>(SELECT amount_cents FROM accounting.journal_lines WHERE id=(x->>'source_line_id')::uuid) THEN RAISE EXCEPTION 'ACCT_NONCASH_CAPACITY';END IF;
      lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',amount::text),jsonb_build_object('account_id',x->'offset_account_id','amount_cents',(-amount)::text));
     ELSIF action_kind IN ('employer_tax','employer_retirement','employer_benefit','provider_fee') THEN lines:=lines||jsonb_build_array(jsonb_build_object('account_id',x->'account_id','amount_cents',amount::text),jsonb_build_object('account_id',x->'offset_account_id','amount_cents',(-amount)::text));
     ELSE RAISE EXCEPTION 'ACCT_PAYROLL_UNSUPPORTED_COMPONENT';END IF;
    END LOOP;
    IF (SELECT coalesce(sum((value->>'amount_cents')::bigint),0) FROM jsonb_array_elements(run.components) WHERE value->>'kind' IN ('officer_wages','other_wages'))<>run.gross_cents OR (SELECT coalesce(sum((value->>'amount_cents')::bigint),0) FROM jsonb_array_elements(run.components) WHERE value->>'kind'='net_pay')<>run.net_cents THEN RAISE EXCEPTION 'ACCT_PAYROLL_TOTALS';END IF;
   ELSE RAISE EXCEPTION 'ACCT_PAYROLL_TEMPLATE';END IF;
   SELECT coalesce(jsonb_agg(value),'[]') INTO lines FROM jsonb_array_elements(lines) WHERE (value->>'amount_cents')::bigint<>0;
 IF jsonb_array_length(lines)<2 OR (SELECT sum((value->>'amount_cents')::numeric) FROM jsonb_array_elements(lines))<>0 THEN RAISE EXCEPTION 'ACCT_UNBALANCED';END IF;
 RETURN jsonb_build_object('ready',true,'issues','[]'::jsonb,'lines',lines,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text,
 'officer_cents',(SELECT coalesce(sum((value->>'amount_cents')::numeric),0)::text FROM jsonb_array_elements(run.components) WHERE value->>'kind'='officer_wages'),'other_wages_cents',(SELECT coalesce(sum((value->>'amount_cents')::numeric),0)::text FROM jsonb_array_elements(run.components) WHERE value->>'kind'='other_wages'),'reimbursements_cents',(SELECT coalesce(sum((value->>'amount_cents')::numeric),0)::text FROM jsonb_array_elements(run.components) WHERE value->>'kind'='reimbursement')));
END $fn$;
CREATE FUNCTION accounting.register_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t text:=c->>'type';key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=accounting.require_owner();run accounting.payroll_runs;reg accounting.registers;
 body jsonb:=coalesce(c->'body',c);components jsonb;lines jsonb:='[]';result jsonb;x jsonb;config jsonb;v integer;gross bigint;net bigint;withheld bigint;employer bigint;bank uuid;wages uuid;taxes uuid;entry uuid;amount bigint;cost bigint;depreciation bigint;principal bigint;total bigint;action_kind text;mode text:=coalesce(c->>'template','cash');action_date date;candidate_count integer;source_id uuid;bank_line record;discarded jsonb;match_list jsonb;
BEGIN
 IF t='payroll.save' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(run.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF run.status IS NOT NULL AND run.status<>'draft' THEN RAISE EXCEPTION 'ACCT_PAYROLL_IMMUTABLE';END IF;
  PERFORM accounting.require_open((body->>'pay_date')::date);
  components:=coalesce(body->'components','[]');gross:=coalesce(body->>'gross_cents',body->>'declared_gross_cents')::bigint;net:=coalesce(body->>'net_cents',body->>'declared_net_cents')::bigint;
  SELECT coalesce(sum((value->>'amount_cents')::bigint) FILTER(WHERE value->>'kind'='employee_tax'),0),coalesce(sum((value->>'amount_cents')::bigint) FILTER(WHERE value->>'kind'='employer_tax'),0) INTO withheld,employer FROM jsonb_array_elements(components);
  withheld:=coalesce((body->>'employee_withholding_cents')::bigint,withheld);employer:=coalesce((body->>'employer_tax_cents')::bigint,employer);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(components) WHERE coalesce(value->>'amount_cents','')!~'^[0-9]+$' OR (value->>'amount_cents')::numeric>9223372036854775807) THEN RAISE EXCEPTION 'ACCT_INVALID_CENTS';END IF;
  INSERT INTO accounting.payroll_runs(id,provider_run_id,pay_date,period_start,period_end,gross_cents,net_cents,employee_withholding_cents,employer_tax_cents,components,document_id,ytd,created_by)
   VALUES(key,c->>'provider_run_id',(body->>'pay_date')::date,coalesce(body->>'period_start',body->>'period_from')::date,coalesce(body->>'period_end',body->>'period_to')::date,gross,net,withheld,employer,components,(c->>'document_id')::uuid,
    coalesce(c->'ytd',body->'ytd',jsonb_build_object('verified',false))||jsonb_build_object('run_employees',coalesce(body->'employees','[]')),actor)
   ON CONFLICT(id) DO UPDATE SET provider_run_id=excluded.provider_run_id,pay_date=excluded.pay_date,period_start=excluded.period_start,period_end=excluded.period_end,gross_cents=excluded.gross_cents,net_cents=excluded.net_cents,employee_withholding_cents=excluded.employee_withholding_cents,employer_tax_cents=excluded.employer_tax_cents,components=excluded.components,document_id=excluded.document_id,ytd=excluded.ytd RETURNING version INTO v;
 ELSIF t IN ('payroll.post','payroll.approve','payroll.void','payroll.discard') THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF run.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='payroll.discard' THEN
   IF run.status<>'draft' OR btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_PAYROLL_DISCARD';END IF;
   UPDATE accounting.payroll_runs SET status='void' WHERE id=key RETURNING version INTO v;
  ELSIF t='payroll.void' THEN
   IF run.status<>'posted' THEN RAISE EXCEPTION 'ACCT_PAYROLL_NOT_POSTED';END IF;
   result:=accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',run.entry_id,'expected_version',(SELECT version FROM accounting.journal_entries WHERE id=run.entry_id),'entry_date',c->>'effective_date','reason',c->>'reason'));
   UPDATE accounting.payroll_runs SET status='void' WHERE id=key RETURNING version INTO v;
  ELSE
   result:=accounting.payroll_plan(c);lines:=result->'lines';bank:=(c->>'bank_account_id')::uuid;
   IF coalesce(c->>'mode','new')='historical' THEN
    entry:=(c->>'entry_id')::uuid;
    IF c?'entry_version' AND (c->>'entry_version')::integer IS DISTINCT FROM (SELECT version FROM accounting.journal_entries WHERE id=entry) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
    IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=entry) THEN RAISE EXCEPTION 'ACCT_REVERSED_ENTRY';END IF;
    IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=entry AND status='posted' AND entry_date=run.pay_date) OR
     (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM accounting.journal_lines WHERE entry_id=entry) IS DISTINCT FROM
     (SELECT jsonb_agg(jsonb_build_array((value->>'account_id')::uuid,((value->>'amount_cents')::bigint)::text) ORDER BY (value->>'account_id')::uuid,(value->>'amount_cents')::bigint) FROM jsonb_array_elements(lines)) THEN RAISE EXCEPTION 'ACCT_PAYROLL_JOURNAL_MISMATCH';END IF;
   ELSE
    result:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',run.pay_date,'memo','Payroll '||run.provider_run_id,'kind','payroll','lines',lines));
    result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',result->'id','expected_version',result->'version'));entry:=(result->>'id')::uuid;
   END IF;
   UPDATE accounting.payroll_runs SET status='posted',entry_id=entry WHERE id=key RETURNING version INTO v;
   INSERT INTO accounting.document_links(document_id,payroll_run_id,created_by) VALUES(run.document_id,key,actor) ON CONFLICT DO NOTHING;
   match_list:=coalesce(c->'bank_matches','[]');
   IF jsonb_array_length(match_list)=0 AND mode='cash' THEN
    FOR bank_line IN SELECT * FROM accounting.journal_lines WHERE entry_id=entry AND account_id=bank LOOP
     SELECT count(*),(array_agg(o.id ORDER BY o.id))[1] INTO candidate_count,source_id FROM accounting.bank_transactions o JOIN accounting.bank_accounts ba ON ba.id=o.bank_account_id
      WHERE ba.account_id=bank AND o.amount_cents=bank_line.amount_cents AND o.state='posted' AND o.review<>'excluded' AND abs(o.posted_date-run.pay_date)<=(SELECT transfer_window_days FROM accounting.settings)
      AND NOT EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE m.bank_transaction_id=o.id AND e.status='posted');
     IF candidate_count=1 THEN match_list:=match_list||jsonb_build_array(jsonb_build_object('bank_transaction_id',source_id,'sort_order',bank_line.sort_order,'amount_cents',abs(bank_line.amount_cents)::text));END IF;
    END LOOP;
   END IF;
   FOR x IN SELECT value FROM jsonb_array_elements(match_list) LOOP
    SELECT coalesce(jsonb_agg(d),'[]') INTO discarded FROM (
     SELECT DISTINCT jsonb_build_object('id',e.id,'expected_version',e.version) d FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id
     WHERE m.bank_transaction_id=(x->>'bank_transaction_id')::uuid AND e.status='draft' AND e.origin IN ('csv','simplefin')) q;
    PERFORM set_config('accounting.reason','Matched payroll register',true);
    PERFORM accounting.banking_command(jsonb_build_object('type','bank.match','id',gen_random_uuid(),'bank_transaction_id',x->'bank_transaction_id','reason','Matched payroll register','discard_drafts',discarded,
      'allocations',jsonb_build_array(jsonb_build_object('line_id',(SELECT id FROM accounting.journal_lines WHERE entry_id=entry AND sort_order=(x->>'sort_order')::integer),'amount_cents',x->'amount_cents'))));
   END LOOP;
  END IF;
 ELSIF t='register.save' THEN
  SELECT * INTO reg FROM accounting.registers WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(reg.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  action_kind:=CASE WHEN c->>'kind'='asset' THEN 'fixed_asset' ELSE c->>'kind' END;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(body->>'account_id')::uuid AND type=CASE action_kind WHEN 'fixed_asset' THEN 'asset' ELSE 'liability' END AND subtype=CASE action_kind WHEN 'fixed_asset' THEN 'fixed_asset' ELSE 'loan' END) THEN RAISE EXCEPTION 'ACCT_REGISTER_ACCOUNT_TYPE';END IF;
  IF action_kind='fixed_asset' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=coalesce(body->>'contra_account_id',body->>'accumulated_account_id')::uuid AND type='asset' AND is_contra) THEN RAISE EXCEPTION 'ACCT_REGISTER_CONTRA_REQUIRED';END IF;
  config:=jsonb_strip_nulls(jsonb_build_object('kind','configuration','expense_account_id',body->'expense_account_id','fee_account_id',body->'fee_account_id','lender',body->'lender','document_id',c->'document_id'));
  INSERT INTO accounting.registers(id,kind,name,account_id,contra_account_id,started_on,amount_cents,in_service_on,method,schedule,notes)
   VALUES(key,action_kind,body->>'name',(body->>'account_id')::uuid,coalesce(body->>'contra_account_id',body->>'accumulated_account_id')::uuid,(body->>'started_on')::date,coalesce(body->>'amount_cents',body->>'initial_cents')::bigint,(body->>'in_service_on')::date,coalesce(body->>'method',''),jsonb_build_array(config)||coalesce(c->'schedule','[]'),coalesce(body->>'notes',body->>'terms',''))
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,account_id=excluded.account_id,contra_account_id=excluded.contra_account_id,started_on=excluded.started_on,amount_cents=excluded.amount_cents,in_service_on=excluded.in_service_on,method=excluded.method,notes=excluded.notes,
    schedule=jsonb_build_array(config)||(SELECT coalesce(jsonb_agg(value),'[]') FROM jsonb_array_elements(accounting.registers.schedule) WHERE value->>'kind'<>'configuration') RETURNING version INTO v;
 ELSIF t IN ('register.post','register.void') THEN
  SELECT * INTO reg FROM accounting.registers WHERE id=(c->>'register_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  IF reg.version IS DISTINCT FROM (c->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF t='register.void' THEN
   SELECT value INTO x FROM jsonb_array_elements(reg.schedule) WHERE value->>'entry_id'=c->>'movement_id' OR value->>'id'=c->>'movement_id';
   entry:=coalesce(x->>'entry_id',c->>'movement_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=entry AND register_id=reg.id) THEN RAISE EXCEPTION 'ACCT_REGISTER_MOVEMENT_REQUIRED';END IF;
   result:=accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',entry,'expected_version',(SELECT version FROM accounting.journal_entries WHERE id=entry),'entry_date',c->>'date','reason',c->>'reason'));
   UPDATE accounting.journal_entries SET register_id=reg.id WHERE id=(result->>'id')::uuid;
   UPDATE accounting.registers SET status='active',ended_on=NULL,schedule=(SELECT jsonb_agg(CASE WHEN value->>'entry_id'=entry::text THEN value||jsonb_build_object('void',result,'void_date',c->'date') ELSE value END) FROM jsonb_array_elements(schedule)) WHERE id=reg.id RETURNING version INTO v;
  ELSE
   result:=accounting.register_plan(reg.id,body);lines:=result->'lines';principal:=(result->'state'->>'principal_cents')::bigint;
   action_kind:=body->>'kind';action_date:=(body->>'date')::date;amount:=(body->>'amount_cents')::bigint;
   IF c->>'mode'='historical' THEN
    entry:=(c->>'entry_id')::uuid;
    IF c?'entry_version' AND (c->>'entry_version')::integer IS DISTINCT FROM (SELECT version FROM accounting.journal_entries WHERE id=entry) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
    IF EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=entry) THEN RAISE EXCEPTION 'ACCT_REVERSED_ENTRY';END IF;
    IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=entry AND status='posted' AND entry_date=action_date AND (register_id IS NULL OR register_id=reg.id)) OR
      (SELECT jsonb_agg(jsonb_build_array(account_id,amount_cents::text) ORDER BY account_id,amount_cents) FROM accounting.journal_lines WHERE entry_id=entry) IS DISTINCT FROM
      (SELECT jsonb_agg(jsonb_build_array((value->>'account_id')::uuid,((value->>'amount_cents')::bigint)::text) ORDER BY (value->>'account_id')::uuid,(value->>'amount_cents')::bigint) FROM jsonb_array_elements(lines)) THEN RAISE EXCEPTION 'ACCT_REGISTER_JOURNAL_MISMATCH';END IF;
    UPDATE accounting.journal_entries SET register_id=reg.id WHERE id=entry;
   ELSE
    result:=accounting.ledger_command(jsonb_build_object('type','draft.save','id',gen_random_uuid(),'expected_version',0,'entry_date',action_date,'memo',reg.name||': '||action_kind,'kind',CASE reg.kind WHEN 'fixed_asset' THEN 'asset' ELSE 'loan' END,'register_id',reg.id,'lines',lines));
    result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',result->'id','expected_version',result->'version'));entry:=(result->>'id')::uuid;
   END IF;
   UPDATE accounting.registers SET schedule=schedule||jsonb_build_array(body||jsonb_build_object('id',key,'entry_id',entry)),status=CASE WHEN action_kind='disposal' THEN 'disposed' WHEN action_kind='payment' AND amount=principal THEN 'paid_off' ELSE status END,
    ended_on=CASE WHEN action_kind='disposal' OR (action_kind='payment' AND amount=principal) THEN action_date ELSE ended_on END WHERE id=reg.id RETURNING version INTO v;
   IF c->>'document_id' IS NOT NULL THEN INSERT INTO accounting.document_links(document_id,entry_id,created_by) VALUES((c->>'document_id')::uuid,entry,actor) ON CONFLICT DO NOTHING;END IF;
  END IF;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v,'entry_id',entry));
END $fn$;
CREATE FUNCTION accounting.payroll(view jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;employees jsonb;coverage jsonb;cutoff date:=coalesce((view->>'through')::date,(view->>'to')::date,(view->>'as_of')::date,(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile));y integer:=coalesce((view->>'year')::integer,extract(year FROM cutoff)::integer);latest accounting.payroll_runs;run accounting.payroll_runs;body jsonb;preview jsonb;record jsonb;posting jsonb;
BEGIN
 PERFORM accounting.require_owner();
 IF view->>'view'='detail' THEN
  SELECT * INTO run FROM accounting.payroll_runs WHERE id=(view->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  body:=jsonb_build_object('pay_date',run.pay_date,'period_from',run.period_start,'period_to',run.period_end,'declared_gross_cents',run.gross_cents::text,'declared_net_cents',run.net_cents::text,'components',run.components,'employees',coalesce(run.ytd->'run_employees','[]'),'ytd',run.ytd);
  posting:=CASE WHEN run.entry_id IS NULL THEN NULL ELSE jsonb_build_object('id',run.entry_id,'entry_id',run.entry_id,'mode','new','void',(SELECT jsonb_build_object('effective_date',entry_date,'reason',reason,'reversal_entry_id',id) FROM accounting.journal_entries WHERE reverses_entry_id=run.entry_id)) END;
  record:=jsonb_build_object('run_id',run.id,'revision',run.version,'body',body,'body_text',body::text,'body_hash',encode(sha256(convert_to(body::text,'UTF8')),'hex'),'document_id',run.document_id,'reason','','created_at',run.updated_at,'posting',posting);
  IF run.status='draft' THEN
   BEGIN preview:=accounting.payroll_plan(view);EXCEPTION WHEN raise_exception THEN preview:=jsonb_build_object('ready',false,'issues',jsonb_build_array(SQLERRM),'lines','[]'::jsonb,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text,'officer_cents','0','other_wages_cents','0','reimbursements_cents','0'));END;
  ELSE preview:=jsonb_build_object('ready',false,'issues','[]'::jsonb,'lines',CASE WHEN run.entry_id IS NULL THEN '[]'::jsonb ELSE accounting.entry_detail(run.entry_id)->'lines' END,'totals',jsonb_build_object('gross_cents',run.gross_cents::text,'net_cents',run.net_cents::text,'employer_cents',run.employer_tax_cents::text,'deductions_cents',run.employee_withholding_cents::text));END IF;
  RETURN jsonb_build_object('id',run.id,'version',run.version,'provider_run_id',run.provider_run_id,'head_revision',run.version,'status',CASE run.status WHEN 'void' THEN 'voided' ELSE run.status END,'register',record,'preview',preview,'posting',posting,
   'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('run_id',run.id,'revision',a.after->'version','body',a.after,'document_id',a.after->'document_id','reason',a.reason,'created_at',a.at) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.table_name='payroll_runs' AND a.row_id=run.id),'history_count',(SELECT count(*) FROM accounting.audit_log WHERE table_name='payroll_runs' AND row_id=run.id),'history_offset',0);
 END IF;

 IF view?'year' AND NOT (view?'through' OR view?'to' OR view?'as_of') THEN cutoff:=make_date(y,12,31);END IF;
 WITH filtered AS (
  SELECT * FROM accounting.payroll_runs r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'year' IS NULL OR extract(year FROM pay_date)=y) AND pay_date<=cutoff
   AND (view->>'from' IS NULL OR pay_date>=(view->>'from')::date) AND (view->>'status' IS NULL OR r.status=CASE view->>'status' WHEN 'voided' THEN 'void' ELSE view->>'status' END)
   AND (coalesce(view->>'query','')='' OR r.provider_run_id ILIKE '%'||(view->>'query')||'%')
 ), paged AS (SELECT * FROM filtered ORDER BY pay_date DESC,id LIMIT 100 OFFSET greatest(coalesce((view->>'offset')::integer,0),0))
 SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rows',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('gross_cents',gross_cents::text,'net_cents',net_cents::text,'employee_withholding_cents',employee_withholding_cents::text,'employer_tax_cents',employer_tax_cents::text) ORDER BY pay_date DESC,id),'[]') FROM paged r),
 'count',count(*),'totals',jsonb_build_object('gross_cents',coalesce(sum(gross_cents) FILTER(WHERE status<>'void'),0)::text,'net_cents',coalesce(sum(net_cents) FILTER(WHERE status<>'void'),0)::text,'drafts',count(*) FILTER(WHERE status='draft'))) INTO result FROM filtered;

 WITH active_runs AS (
  SELECT * FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff)
 ), per_employee AS (
  SELECT x.value FROM active_runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.ytd->'run_employees','[]')) x
 ), employee_totals AS (
  SELECT value->>'key' key,max(value->>'name') name,bool_or((value->>'is_officer')::boolean) is_officer,sum((value->>'gross_cash_cents')::numeric) gross,
   CASE WHEN bool_and(value->>'federal_taxable_cents' IS NOT NULL) THEN sum((value->>'federal_taxable_cents')::numeric)::text END federal_taxable,
   CASE WHEN bool_and(value->>'federal_withheld_cents' IS NOT NULL) THEN sum((value->>'federal_withheld_cents')::numeric)::text END federal_withheld,
   CASE WHEN bool_and(value->>'state_taxable_cents' IS NOT NULL) THEN sum((value->>'state_taxable_cents')::numeric)::text END state_taxable,
   CASE WHEN bool_and(value->>'state_withheld_cents' IS NOT NULL) THEN sum((value->>'state_withheld_cents')::numeric)::text END state_withheld,
   CASE WHEN bool_and(value->>'social_security_wages_cents' IS NOT NULL) THEN sum((value->>'social_security_wages_cents')::numeric)::text END social_security,
   CASE WHEN bool_and(value->>'medicare_wages_cents' IS NOT NULL) THEN sum((value->>'medicare_wages_cents')::numeric)::text END medicare
  FROM per_employee GROUP BY value->>'key')
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'name',name,'is_officer',is_officer,'gross_cash_cents',gross::text,'federal_taxable_cents',federal_taxable,'federal_withheld_cents',federal_withheld,'state_taxable_cents',state_taxable,'state_withheld_cents',state_withheld,'social_security_wages_cents',social_security,'medicare_wages_cents',medicare) ORDER BY name,key),'[]') INTO employees FROM employee_totals;
 SELECT p.* INTO latest FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff) ORDER BY p.pay_date DESC,p.created_at DESC,p.id LIMIT 1;
 IF latest.ytd->>'verified'='true' THEN coverage:=jsonb_build_object('id',latest.id,'tax_year',y,'version',latest.version,'through_date',cutoff,'source_through_date',latest.pay_date,'current',EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=latest.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)),'employees',coalesce(latest.ytd->'employees','[]'),'document_id',latest.document_id,'reason','Verified YTD from the latest recorded payroll run.','created_at',latest.created_at);END IF;
 result:=result||jsonb_build_object('year',y,'through',cutoff,'employees',employees,'coverage',coverage,
  'run_count',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.entry_id IS NOT NULL AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=cutoff)),
  'drafts',(SELECT count(*) FROM accounting.payroll_runs p WHERE p.status='draft' AND p.pay_date BETWEEN make_date(y,1,1) AND cutoff));
 result:=result||jsonb_build_object('as_of',cutoff,'offset',coalesce((view->>'offset')::integer,0),'runs',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('head_revision',value->'version','status',CASE value->>'status' WHEN 'void' THEN 'voided' ELSE value->>'status' END)),'[]') FROM jsonb_array_elements(result->'rows')));
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $fn$;
CREATE FUNCTION accounting.registers(view jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;detail jsonb;rows jsonb;cutoff date:=coalesce((view->>'date')::date,current_date);offset_rows integer:=coalesce((view->>'offset')::integer,0);total_count integer;
BEGIN
 PERFORM accounting.require_owner();
 IF view->>'view'='preview' THEN RETURN accounting.register_plan((view->>'id')::uuid,view->'body');END IF;
 SELECT count(*) INTO total_count FROM accounting.registers r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'kind' IS NULL OR r.kind=CASE view->>'kind' WHEN 'asset' THEN 'fixed_asset' ELSE view->>'kind' END) AND (view->>'query' IS NULL OR r.name ILIKE '%'||(view->>'query')||'%');
 WITH scoped AS (SELECT * FROM accounting.registers r WHERE (view->>'id' IS NULL OR r.id=(view->>'id')::uuid) AND (view->>'kind' IS NULL OR r.kind=CASE view->>'kind' WHEN 'asset' THEN 'fixed_asset' ELSE view->>'kind' END) AND (view->>'query' IS NULL OR r.name ILIKE '%'||(view->>'query')||'%') ORDER BY name,id LIMIT 100 OFFSET offset_rows),
 shaped AS (SELECT r.*,coalesce((SELECT value FROM jsonb_array_elements(schedule) WHERE value->>'kind'='configuration'),'{}') config,
 coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=r.id AND e.status='posted' AND e.entry_date<=cutoff AND l.account_id=r.account_id),0) cost,
 -coalesce((SELECT sum(l.amount_cents) FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.register_id=r.id AND e.status='posted' AND e.entry_date<=cutoff AND l.account_id=r.contra_account_id),0) depreciation FROM scoped r)
 SELECT coalesce(jsonb_agg(to_jsonb(r)-ARRAY['cost','depreciation','config']||jsonb_build_object('kind',CASE r.kind WHEN 'fixed_asset' THEN 'asset' ELSE r.kind END,'amount_cents',amount_cents::text,'book_cents',cost::text,
 'body',jsonb_build_object('name',name,'started_on',started_on,'initial_cents',amount_cents::text,'account_id',account_id,'expense_account_id',config->'expense_account_id','terms',notes,'in_service_on',in_service_on,'accumulated_account_id',contra_account_id,'method',method,'lender',config->'lender','fee_account_id',config->'fee_account_id'),'document_id',config->'document_id',
 'state',jsonb_build_object('cost_cents',CASE WHEN r.kind='fixed_asset' THEN cost ELSE 0 END::text,'depreciation_cents',depreciation::text,'carrying_cents',CASE WHEN r.kind='fixed_asset' THEN cost-depreciation ELSE 0 END::text,'principal_cents',CASE WHEN r.kind='loan' THEN -cost ELSE 0 END::text,'initialized',EXISTS(SELECT 1 FROM accounting.journal_entries WHERE register_id=r.id AND status='posted' AND entry_date<=cutoff),'disposed',status='disposed' AND ended_on<=cutoff)) ORDER BY name,id),'[]') INTO rows FROM shaped r;
 IF view->>'view'='detail' THEN
  result:=rows->0;IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'entry_id',e.id,'kind',coalesce(item->>'kind',e.kind),'effective_date',e.entry_date,'mode',CASE WHEN item IS NULL THEN 'historical' ELSE 'new' END,'body',item,'lines',(SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'amount_cents',l.amount_cents::text)) FROM accounting.journal_lines l WHERE l.entry_id=e.id),'document_id',(SELECT document_id FROM accounting.document_links WHERE entry_id=e.id LIMIT 1),'reason',e.reason,'void',(SELECT jsonb_build_object('effective_date',re.entry_date,'reason',re.reason,'reversal_entry_id',re.id) FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)) ORDER BY e.entry_date DESC,e.id),'[]') INTO detail
   FROM accounting.journal_entries e LEFT JOIN LATERAL (SELECT value item FROM jsonb_array_elements(result->'schedule') WHERE value->>'entry_id'=e.id::text LIMIT 1) schedule_item ON true WHERE e.register_id=(view->>'id')::uuid AND e.status='posted' AND e.reverses_entry_id IS NULL AND e.entry_date<=cutoff;
  RETURN result||jsonb_build_object('as_of',cutoff,'offset',offset_rows,'record',jsonb_build_object('revision',result->'version','body',result->'body','document_id',result->'document_id','reason',result->>'notes','created_at',result->'updated_at'),'movements',detail,'movement_count',jsonb_array_length(detail),
   'revisions',(SELECT coalesce(jsonb_agg(jsonb_build_object('revision',a.after->'version','body',a.after,'document_id',a.after->'schedule'->0->'document_id','reason',a.reason,'created_at',a.at) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.table_name='registers' AND a.row_id=(view->>'id')::uuid),'revision_count',(SELECT count(*) FROM accounting.audit_log a WHERE a.table_name='registers' AND a.row_id=(view->>'id')::uuid));
 END IF;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'as_of',cutoff,'offset',offset_rows,'count',total_count,'rows',rows);
END $fn$;
CREATE FUNCTION accounting.contractor_report(year integer,cutoff date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE threshold bigint;result jsonb;through_date date:=coalesce(cutoff,make_date(year,12,31));
BEGIN
 PERFORM accounting.require_owner();
 IF extract(year FROM through_date)<>year THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 IF year BETWEEN 2022 AND 2025 THEN threshold:=60000;ELSIF year=2026 THEN threshold:=200000;ELSE RAISE EXCEPTION 'ACCT_CONTRACTOR_YEAR_RULE_REQUIRED';END IF;
 SELECT jsonb_build_object('year',year,'through',through_date,'revision',(SELECT financial_revision::text FROM accounting.settings),'threshold_cents',threshold::text,
  'rows',coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'contractor_classification',contractor_classification,'documentation_status',documentation_status,'paid_cents',paid::text,'card_cents',card::text,'meets_threshold',paid>=threshold) ORDER BY name,id),'[]')) INTO result FROM (
 SELECT p.id,p.name,p.contractor_classification,p.documentation_status,
 -coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash')),0) paid,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype='card'),0) card
 FROM accounting.parties p LEFT JOIN accounting.journal_entries e ON e.payee_id=p.id AND e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND through_date
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE p.is_contractor GROUP BY p.id) rows;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION accounting.register_guard(),accounting.payroll_plan(jsonb),accounting.register_plan(uuid,jsonb),accounting.register_command(jsonb),accounting.payroll(jsonb),accounting.registers(jsonb),accounting.contractor_report(integer,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.payroll(jsonb),accounting.registers(jsonb),accounting.contractor_report(integer,date) TO authenticated;
-- ACCOUNTING PAYROLL REGISTERS END
COMMIT;
