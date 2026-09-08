BEGIN;
-- ACCOUNTING TAX BEGIN
CREATE TABLE accounting.tax_mappings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tax_year smallint NOT NULL CHECK(tax_year BETWEEN 1900 AND 2100),
 account_id uuid NOT NULL REFERENCES accounting.accounts ON DELETE RESTRICT,concept text NOT NULL,
 deductible_bps integer NOT NULL DEFAULT 10000 CHECK(deductible_bps BETWEEN 0 AND 10000),separately_stated boolean NOT NULL DEFAULT false,
 notes text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tax_year,account_id)
);
CREATE TABLE accounting.tax_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tax_year smallint NOT NULL CHECK(tax_year BETWEEN 1900 AND 2100),concept text NOT NULL,
 effective_date date NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents<>0),reason text NOT NULL CHECK(length(trim(reason))>0),
 document_id uuid REFERENCES accounting.documents ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users ON DELETE RESTRICT,
 CHECK(extract(year FROM effective_date)=tax_year)
);
CREATE TABLE accounting.tax_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tax_estimate_id uuid NOT NULL UNIQUE REFERENCES public.tax_estimates ON DELETE RESTRICT,
 tax_year smallint NOT NULL CHECK(tax_year BETWEEN 1900 AND 2100),cutoff_mode text NOT NULL CHECK(cutoff_mode IN ('today','fixed')),
 cutoff_date date,forecast_method text NOT NULL CHECK(forecast_method IN ('manual','average_months','prior_year_pattern')),
 forecast_inputs jsonb NOT NULL DEFAULT '{}',inputs jsonb NOT NULL DEFAULT '{}',results jsonb NOT NULL DEFAULT '{}',financial_revision bigint NOT NULL DEFAULT -1,
 status text NOT NULL DEFAULT 'stale' CHECK(status IN ('fresh','stale','error')),error text,computed_at timestamptz,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(cutoff_mode<>'fixed' OR cutoff_date IS NOT NULL),
 CHECK(cutoff_date IS NULL OR extract(year FROM cutoff_date)=tax_year)
);
CREATE INDEX tax_adjustments_year_date ON accounting.tax_adjustments(tax_year,effective_date);
CREATE FUNCTION accounting.tax_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM accounting.write_lock();
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='tax_adjustments' AND TG_OP<>'INSERT') THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_TAX_ADJUSTMENT';END IF;
 IF TG_TABLE_NAME IN ('tax_adjustments','tax_mappings') THEN
  IF NEW.concept NOT IN ('gross_receipts','cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','interest','other_deduction','nondeductible','distribution','contribution','balance_sheet_only','qualified_dividend','short_gain','long_gain','charity','tax_exempt','ordinary_adjustment','stock_basis_opening','debt_basis_opening') THEN RAISE EXCEPTION 'ACCT_TAX_CONCEPT';END IF;
  IF TG_TABLE_NAME='tax_mappings' AND NEW.concept IN ('ordinary_adjustment','stock_basis_opening','debt_basis_opening') THEN RAISE EXCEPTION 'ACCT_TAX_CONCEPT';END IF;
 END IF;
 IF TG_TABLE_NAME='tax_mappings' THEN
  IF NEW.deductible_bps NOT BETWEEN 0 AND 10000 OR
   (NEW.concept='gross_receipts' AND (NEW.deductible_bps<>10000 OR NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='income'))) OR
   (NEW.concept IN ('cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','other_deduction','charity') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='expense')) OR
   (NEW.concept IN ('qualified_dividend','short_gain','long_gain','tax_exempt') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='income')) OR
   (NEW.concept='interest' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type IN ('income','expense'))) OR
   (NEW.concept IN ('distribution','contribution') AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND type='equity'))
   THEN RAISE EXCEPTION 'ACCT_TAX_MAPPING';END IF;
 END IF;
 IF TG_OP='UPDATE' THEN NEW.version:=CASE WHEN TG_TABLE_NAME='tax_links' AND current_setting('accounting.actor_kind',true)='worker' THEN OLD.version ELSE OLD.version+1 END;NEW.updated_at:=now();END IF;
 RETURN NEW;
END $fn$;
DO $tables$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['tax_mappings','tax_adjustments','tax_links'] LOOP
  EXECUTE format('ALTER TABLE accounting.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON accounting.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.tax_guard()',t);
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting.%I FOR EACH ROW EXECUTE FUNCTION accounting.record_audit()',t);
 END LOOP;
END $tables$;
CREATE FUNCTION accounting.tax_lines(year integer,cutoff date) RETURNS TABLE(line_id uuid,entry_id uuid,entry_date date,account_id uuid,book_cents numeric,ordinary_cents numeric,concept text,mapping_current boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT l.id,e.id,e.entry_date,a.id,-l.amount_cents::numeric,
 CASE WHEN m.separately_stated THEN 0 WHEN m.concept='gross_receipts' THEN -l.amount_cents::numeric
 WHEN m.concept IN ('cogs','officer_compensation','salaries','payroll_taxes','rent','advertising','meals_50','travel','depreciation','interest','other_deduction') THEN -round(l.amount_cents::numeric*m.deductible_bps/10000) ELSE 0 END,
 m.concept,m.id IS NOT NULL
 FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id
 LEFT JOIN accounting.tax_mappings m ON m.account_id=a.id AND m.tax_year=year
 WHERE e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND cutoff AND a.type IN ('income','expense')
$fn$;
CREATE FUNCTION accounting.tax_source(year integer,cutoff date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE accounts jsonb;adjustments jsonb;monthly jsonb;separate jsonb;result jsonb;ordinary numeric;adjusted numeric;book numeric;missing integer;report_data jsonb;
BEGIN
 IF NOT (current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker') THEN PERFORM accounting.require_owner();END IF;
 IF year IS NULL OR cutoff IS NULL OR year NOT BETWEEN 1900 AND 2100 OR extract(year FROM cutoff)<>year OR cutoff>(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
 report_data:=accounting.report('profit_loss',jsonb_build_object('from',make_date(year,1,1),'to',cutoff));book:=(report_data->>'net_income_cents')::numeric;
 WITH grouped AS(SELECT account_id,sum(book_cents) book,sum(ordinary_cents) ordinary,count(*) n FROM accounting.tax_lines(year,cutoff) GROUP BY account_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',a.id,'name',a.name,'code',a.code,'account_type',a.type,'mapping',CASE WHEN m.id IS NULL THEN NULL ELSE to_jsonb(m) END,
 'book_cents',coalesce(g.book,0)::text,'ordinary_cents',coalesce(g.ordinary,0)::text,'line_count',coalesce(g.n,0),'current',m.id IS NOT NULL) ORDER BY a.code,a.name,a.id),'[]') INTO accounts
 FROM accounting.accounts a LEFT JOIN grouped g ON g.account_id=a.id LEFT JOIN accounting.tax_mappings m ON m.account_id=a.id AND m.tax_year=year WHERE a.type IN ('income','expense') AND (g.n>0 OR NOT a.is_archived);
 SELECT coalesce(sum(ordinary_cents),0),count(DISTINCT account_id) FILTER(WHERE NOT mapping_current) INTO ordinary,missing FROM accounting.tax_lines(year,cutoff);
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text,'current',true,'active',true,'version',1) ORDER BY effective_date,id),'[]'),
 ordinary+coalesce(sum(a.amount_cents) FILTER(WHERE a.concept NOT IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt')),0)
 INTO adjustments,adjusted FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff;
 WITH months AS(SELECT d::date AS month FROM generate_series(make_date(year,1,1),date_trunc('month',cutoff),interval '1 month') d),
 lines AS(SELECT date_trunc('month',entry_date)::date AS month,sum(book_cents) book,sum(ordinary_cents) ordinary FROM accounting.tax_lines(year,cutoff) GROUP BY 1),
 adj AS(SELECT date_trunc('month',effective_date)::date AS month,sum(amount_cents) amount FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.concept NOT IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') GROUP BY 1)
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',m.month,'book_cents',coalesce(l.book,0)::text,'ordinary_cents',(coalesce(l.ordinary,0)+coalesce(a.amount,0))::text,
 'complete',(m.month+interval '1 month -1 day')::date<=cutoff AND EXISTS(SELECT 1 FROM accounting.periods p WHERE p.month=m.month AND p.status='locked')) ORDER BY m.month),'[]') INTO monthly FROM months m LEFT JOIN lines l USING(month) LEFT JOIN adj a USING(month);
 SELECT coalesce(jsonb_object_agg(concept,amount::text),'{}') INTO separate FROM (
 SELECT concept,sum(amount) amount FROM (
 SELECT m.concept,-sum(l.amount_cents)::numeric amount FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.tax_mappings m ON m.account_id=l.account_id AND m.tax_year=year WHERE e.status='posted' AND e.entry_date BETWEEN make_date(year,1,1) AND cutoff AND m.separately_stated GROUP BY m.concept
 UNION ALL SELECT a.concept,sum(a.amount_cents)::numeric FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.concept IN ('interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') GROUP BY a.concept) s GROUP BY concept) q;
 result:=jsonb_build_object('year',year,'through',cutoff,'revision',report_data->'revision','year_settings',(SELECT jsonb_build_object('classification',tax_classification,'current',tax_classification IS NOT NULL AND (tax_classification_since IS NULL OR tax_classification_since<=year)) FROM public.business_profile WHERE id=1),
 'accounts',accounts,'adjustments',adjustments,'basis',NULL,'monthly',monthly,'separately_stated',separate,'book_profit_cents',book::text,'mapped_ordinary_cents',ordinary::text,'adjusted_ordinary_cents',adjusted::text,'book_to_tax_cents',(adjusted-book)::text,'unmapped_accounts',missing,
 'drafts',report_data->'quality'->'draft_count','incomplete_imports',report_data->'quality'->'incomplete_imports',
 'unavailable_adjustments',(SELECT count(*) FROM accounting.tax_adjustments a WHERE a.tax_year=year AND a.effective_date<=cutoff AND a.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=a.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $fn$;
CREATE FUNCTION accounting.tax_command(c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t text:=c->>'type';k uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());y integer:=coalesce((c->>'tax_year')::integer,(c->>'year')::integer);actor uuid:=accounting.require_owner();m accounting.tax_mappings;link accounting.tax_links;mapped_concept text:=c->>'concept';body jsonb:=coalesce(c->'body',c->'forecast_inputs');estimate public.tax_estimates;method text;
BEGIN
 mapped_concept:=CASE mapped_concept WHEN 'ordinary_income' THEN 'gross_receipts' WHEN 'ordinary_expense' THEN 'other_deduction' WHEN 'officer_wages' THEN 'officer_compensation' WHEN 'meals' THEN 'meals_50' WHEN 'excluded_book' THEN 'balance_sheet_only' ELSE mapped_concept END;
 IF t IN ('tax.mapping','tax.mapping.save') THEN
  SELECT * INTO m FROM accounting.tax_mappings WHERE tax_year=y AND account_id=(c->>'account_id')::uuid;
  IF coalesce((c->>'expected_version')::integer,-1)<>coalesce(m.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(c->>'account_id')::uuid) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_NOT_FOUND';END IF;
  IF m.id IS NULL THEN INSERT INTO accounting.tax_mappings(id,tax_year,account_id,concept,deductible_bps,separately_stated,notes) VALUES(k,y,(c->>'account_id')::uuid,mapped_concept,coalesce((c->>'deductible_bps')::integer,CASE WHEN mapped_concept='meals_50' THEN 5000 ELSE 10000 END),coalesce((c->>'separately_stated')::boolean,mapped_concept IN ('qualified_dividend','short_gain','long_gain','charity','tax_exempt') OR (mapped_concept='interest' AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=(c->>'account_id')::uuid AND type='income'))),coalesce(c->>'notes',c->>'reason','')) RETURNING * INTO m;
  ELSE UPDATE accounting.tax_mappings SET concept=mapped_concept,deductible_bps=coalesce((c->>'deductible_bps')::integer,CASE WHEN mapped_concept='meals_50' THEN 5000 ELSE 10000 END),separately_stated=coalesce((c->>'separately_stated')::boolean,mapped_concept IN ('qualified_dividend','short_gain','long_gain','charity','tax_exempt') OR (mapped_concept='interest' AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=m.account_id AND type='income'))),notes=coalesce(c->>'notes',c->>'reason','') WHERE id=m.id RETURNING * INTO m;END IF;
  RETURN jsonb_build_object('id',m.id,'version',m.version);
 ELSIF t IN ('tax.adjustment','tax.adjustment.save') THEN
  IF coalesce((c->>'expected_version')::integer,0)<>0 OR c->>'active'='false' THEN RAISE EXCEPTION 'ACCT_TAX_OFFSET_REQUIRED';END IF;
  IF c->>'document_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=(c->>'document_id')::uuid AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE';END IF;
  INSERT INTO accounting.tax_adjustments(id,tax_year,concept,effective_date,amount_cents,reason,document_id,created_by) VALUES(k,y,mapped_concept,coalesce((c->>'effective_date')::date,make_date(y,12,31)),(c->>'amount_cents')::bigint,c->>'reason',(c->>'document_id')::uuid,actor);
  RETURN jsonb_build_object('id',k,'version',1);
 ELSIF t='tax.link.save' THEN
  SELECT * INTO link FROM accounting.tax_links WHERE id=k;
  IF coalesce((c->>'expected_version')::integer,-1)<>coalesce(link.version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION';END IF;
  SELECT * INTO estimate FROM public.tax_estimates WHERE id=coalesce((c->>'tax_estimate_id')::uuid,(c->>'estimate_id')::uuid) AND deleted_at IS NULL;
  IF estimate.id IS NULL THEN RAISE EXCEPTION 'ACCT_TAX_ESTIMATE_NOT_FOUND';END IF;
  IF link.id IS NOT NULL AND link.tax_estimate_id<>estimate.id THEN RAISE EXCEPTION 'ACCT_TAX_LINK_IDENTITY';END IF;
  IF body IS NULL OR jsonb_typeof(body)<>'object' OR extract(year FROM (body->>'through')::date)<>estimate.tax_year THEN RAISE EXCEPTION 'ACCT_TAX_LINK_SCOPE';END IF;
  method:=CASE body->'forecast'->>'method' WHEN 'average' THEN 'average_months' WHEN 'prior_pattern' THEN 'prior_year_pattern' ELSE body->'forecast'->>'method' END;
  IF link.id IS NULL THEN INSERT INTO accounting.tax_links(id,tax_estimate_id,tax_year,cutoff_mode,cutoff_date,forecast_method,forecast_inputs) VALUES(k,estimate.id,estimate.tax_year,body->>'cutoff_mode',(body->>'through')::date,method,body||jsonb_build_object('enabled',coalesce((c->>'enabled')::boolean,true),'reason',coalesce(c->>'reason',''))) RETURNING * INTO link;
  ELSE UPDATE accounting.tax_links SET cutoff_mode=body->>'cutoff_mode',cutoff_date=(body->>'through')::date,forecast_method=method,forecast_inputs=body||jsonb_build_object('enabled',coalesce((c->>'enabled')::boolean,true),'reason',coalesce(c->>'reason','')),status='stale',error=NULL,inputs=inputs-'_refresh' WHERE id=k RETURNING * INTO link;END IF;
  RETURN jsonb_build_object('id',link.id,'version',link.version);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $fn$;
CREATE FUNCTION accounting.tax_link(id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE l accounting.tax_links;e jsonb;personal_hash text;cutoff date;is_current boolean;
BEGIN
 PERFORM accounting.require_owner();SELECT * INTO l FROM accounting.tax_links WHERE tax_links.id=tax_link.id OR tax_estimate_id=tax_link.id;
 SELECT to_jsonb(t) INTO e FROM public.tax_estimates t WHERE t.id=coalesce(l.tax_estimate_id,tax_link.id) AND deleted_at IS NULL;
 personal_hash:=encode(sha256(convert_to(e::text,'UTF8')),'hex');
 cutoff:=CASE WHEN l.cutoff_mode='fixed' THEN l.cutoff_date ELSE least(make_date(l.tax_year,12,31),(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE business_profile.id=1))::date) END;
 is_current:=coalesce(l.status='fresh' AND l.financial_revision=(SELECT financial_revision FROM accounting.settings) AND l.inputs->>'personal_hash'=personal_hash AND l.inputs->>'through'=cutoff::text AND l.inputs->>'profile_hash'=encode(sha256(convert_to((SELECT to_jsonb(p)::text FROM public.business_profile p WHERE p.id=1),'UTF8')),'hex'),false);
 RETURN jsonb_build_object('estimate',e,'personal_hash',personal_hash,'current',is_current,'link',CASE WHEN l.id IS NULL THEN NULL ELSE (to_jsonb(l)-ARRAY['inputs','results'])||jsonb_build_object('financial_revision',l.financial_revision::text,'estimate_id',l.tax_estimate_id,'enabled',coalesce((l.forecast_inputs->>'enabled')::boolean,true),'body',l.forecast_inputs-ARRAY['enabled','reason'],'reason',coalesce(l.forecast_inputs->>'reason',''),'status',CASE WHEN l.status='fresh' AND NOT is_current THEN 'stale' ELSE l.status END) END,
 'snapshot',CASE WHEN l.computed_at IS NULL THEN NULL ELSE jsonb_build_object('id',l.id,'link_id',l.id,'link_version',l.inputs->'link_version','financial_revision',l.financial_revision::text,'personal_hash',l.inputs->'personal_hash','through_date',l.inputs->'through','created_at',l.computed_at,'payload',l.results,'inputs',l.inputs->'calculation') END);
END $fn$;
CREATE FUNCTION accounting.tax_refresh_server(command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t text:=command->>'type';l accounting.tax_links;e jsonb;cutoff date;ph text;profile_hash text;rev bigint;token uuid;calc jsonb;prior jsonb;exclusions jsonb;payroll jsonb;ytd_run accounting.payroll_runs;refresh jsonb;ids jsonb;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'ACCT_WORKER_REQUIRED';END IF;
 PERFORM accounting.write_lock();PERFORM set_config('accounting.actor_kind','worker',true);PERFORM set_config('accounting.operation_id',gen_random_uuid()::text,true);PERFORM set_config('accounting.action','tax_refresh',true);
 IF t='due' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id) ORDER BY computed_at NULLS FIRST,id),'[]') INTO ids FROM (
   SELECT tl.id,tl.computed_at FROM accounting.tax_links tl JOIN public.tax_estimates te ON te.id=tl.tax_estimate_id AND te.deleted_at IS NULL CROSS JOIN public.business_profile bp CROSS JOIN accounting.settings st
   WHERE coalesce((tl.forecast_inputs->>'enabled')::boolean,true) AND coalesce((tl.inputs->'_refresh'->>'until')::timestamptz,'-infinity')<=now() AND coalesce((tl.inputs->>'retry_after')::timestamptz,'-infinity')<=now()
   AND (tl.status<>'fresh' OR tl.financial_revision<>st.financial_revision OR tl.inputs->>'personal_hash' IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(te)::text,'UTF8')),'hex') OR tl.inputs->>'profile_hash' IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(bp)::text,'UTF8')),'hex') OR tl.inputs->>'through' IS DISTINCT FROM (CASE WHEN tl.cutoff_mode='fixed' THEN tl.cutoff_date ELSE least(make_date(tl.tax_year,12,31),(now() AT TIME ZONE bp.books_timezone)::date) END)::text)
   ORDER BY tl.computed_at NULLS FIRST,tl.id LIMIT 25) q;
  RETURN ids;
 END IF;
 SELECT * INTO l FROM accounting.tax_links WHERE id=(command->>'link_id')::uuid FOR UPDATE;
 IF l.id IS NULL THEN RAISE EXCEPTION 'ACCT_TAX_LINK_NOT_FOUND';END IF;
 SELECT to_jsonb(te) INTO e FROM public.tax_estimates te WHERE te.id=l.tax_estimate_id AND deleted_at IS NULL;
 IF e IS NULL THEN RETURN jsonb_build_object('state','disabled');END IF;
 ph:=encode(sha256(convert_to(e::text,'UTF8')),'hex');profile_hash:=encode(sha256(convert_to((SELECT to_jsonb(p)::text FROM public.business_profile p WHERE p.id=1),'UTF8')),'hex');SELECT financial_revision INTO rev FROM accounting.settings;
 cutoff:=CASE WHEN l.cutoff_mode='fixed' THEN l.cutoff_date ELSE least(make_date(l.tax_year,12,31),(now() AT TIME ZONE (SELECT books_timezone FROM public.business_profile WHERE id=1))::date) END;
 IF cutoff<make_date(l.tax_year,1,1) OR NOT coalesce((l.forecast_inputs->>'enabled')::boolean,true) THEN RETURN jsonb_build_object('state','disabled');END IF;
 IF t='start' THEN
  IF NOT coalesce((command->>'force')::boolean,false) AND l.status='fresh' AND l.financial_revision=rev AND l.inputs->>'personal_hash'=ph AND l.inputs->>'profile_hash'=profile_hash AND l.inputs->>'through'=cutoff::text THEN RETURN jsonb_build_object('state','fresh','snapshot_id',l.id);END IF;
  IF (l.inputs->'_refresh'->>'until')::timestamptz>now() THEN RETURN jsonb_build_object('state','busy');END IF;
  token:=gen_random_uuid();prior:=CASE WHEN l.forecast_method='prior_year_pattern' THEN accounting.tax_source(l.tax_year-1,make_date(l.tax_year-1,12,31)) ELSE NULL END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('entry_id',entry_id,'entry_date',entry_date,'ordinary_cents',amount::text)),'[]') INTO exclusions FROM (
   SELECT x.entry_id,x.entry_date,sum(x.ordinary_cents) amount FROM accounting.tax_lines(CASE WHEN l.forecast_method='prior_year_pattern' THEN l.tax_year-1 ELSE l.tax_year END,CASE WHEN l.forecast_method='prior_year_pattern' THEN make_date(l.tax_year-1,12,31) ELSE cutoff END) x WHERE x.entry_id::text IN(SELECT value->>'entry_id' FROM jsonb_array_elements(coalesce(l.forecast_inputs->'forecast'->'exclusions','[]'))) GROUP BY x.entry_id,x.entry_date) q;
  SELECT p.* INTO ytd_run FROM accounting.payroll_runs p JOIN accounting.journal_entries je ON je.id=p.entry_id WHERE p.pay_date BETWEEN make_date(l.tax_year,1,1) AND cutoff AND je.status='posted' AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=je.id AND re.status='posted' AND re.entry_date<=cutoff) ORDER BY p.pay_date DESC,p.created_at DESC,p.id LIMIT 1;
  IF ytd_run.id IS NOT NULL AND ytd_run.ytd->>'verified'='true' AND EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=ytd_run.document_id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)) THEN payroll:=jsonb_build_object('year',l.tax_year,'coverage',jsonb_build_object('current',true,'through_date',cutoff,'source_through_date',ytd_run.pay_date,'document_id',ytd_run.document_id,'employees',coalesce(ytd_run.ytd->'employees','[]')));END IF;
  calc:=jsonb_build_object('link',jsonb_build_object('id',l.id,'version',l.version,'body',l.forecast_inputs-ARRAY['enabled','reason']),'estimate',e,'source',accounting.tax_source(l.tax_year,cutoff),'forecast_evidence',jsonb_build_object('prior',prior,'exclusions',exclusions),'payroll',payroll,
  'manual_review_document_available',EXISTS(SELECT 1 FROM accounting.documents d WHERE d.id=(l.forecast_inputs->'manual_separate_review'->>'document_id')::uuid AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)),
  'after_cutoff_count',(SELECT count(*) FROM accounting.journal_entries WHERE status='posted' AND entry_date>cutoff AND entry_date<=make_date(l.tax_year,12,31)));
  refresh:=jsonb_build_object('token',token,'until',now()+interval '5 minutes','revision',rev::text,'personal_hash',ph,'profile_hash',profile_hash,'through',cutoff,'calculation',calc);
  UPDATE accounting.tax_links SET inputs=jsonb_set(inputs,'{_refresh}',refresh),status='stale',error=NULL WHERE id=l.id;
  RETURN jsonb_build_object('state','running','lease_token',token,'inputs',calc);
 ELSIF t IN ('finish','fail') THEN
  refresh:=l.inputs->'_refresh';
  IF t='finish' AND l.inputs->>'refresh_token'=command->>'lease_token' THEN
   IF l.results IS DISTINCT FROM command->'payload' THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT';END IF;RETURN jsonb_build_object('state','fresh','snapshot_id',l.id);END IF;
  IF refresh IS NULL OR refresh->>'token' IS DISTINCT FROM command->>'lease_token' OR (refresh->>'until')::timestamptz<=now() THEN RETURN jsonb_build_object('state','superseded');END IF;
  IF refresh->>'revision'<>rev::text OR refresh->>'personal_hash'<>ph OR refresh->>'profile_hash'<>profile_hash OR refresh->>'through'<>cutoff::text THEN
   UPDATE accounting.tax_links SET inputs=inputs-'_refresh',status='stale' WHERE id=l.id;RETURN jsonb_build_object('state','stale');END IF;
  IF t='fail' THEN UPDATE accounting.tax_links SET inputs=(inputs-'_refresh')||jsonb_build_object('retry_after',now()+interval '5 minutes'),status='error',error=left(command->>'error',2000) WHERE id=l.id;RETURN jsonb_build_object('state','failed');END IF;
  IF jsonb_typeof(command->'payload') IS DISTINCT FROM 'object' OR NOT command->'payload'?'outputs' OR NOT command->'payload'?'calculation' THEN RAISE EXCEPTION 'ACCT_TAX_RESULT';END IF;
  UPDATE accounting.tax_links SET inputs=(refresh-ARRAY['token','until','revision'])||jsonb_build_object('refresh_token',refresh->'token','link_version',refresh->'calculation'->'link'->'version'),results=command->'payload',financial_revision=rev,status='fresh',error=NULL,computed_at=now() WHERE id=l.id;
  RETURN jsonb_build_object('state','fresh','snapshot_id',l.id);
 END IF;
 RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND';
END $fn$;
REVOKE ALL ON FUNCTION accounting.tax_guard(),accounting.tax_lines(integer,date),accounting.tax_source(integer,date),accounting.tax_command(jsonb),accounting.tax_link(uuid),accounting.tax_refresh_server(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION accounting.tax_source(integer,date),accounting.tax_link(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.tax_refresh_server(jsonb) TO service_role;
-- ACCOUNTING TAX END
COMMIT;
