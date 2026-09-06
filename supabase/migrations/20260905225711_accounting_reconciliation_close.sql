-- Statement reconciliation, clearing timelines, calendar closes, and retained filing history.
BEGIN;

-- ACCOUNTING CLEARING BEGIN
CREATE TABLE public.acct_clearing_allocations (
  id uuid PRIMARY KEY,
  obligation_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  settlement_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  effective_date date NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(obligation_line_id<>settlement_line_id)
);
CREATE INDEX acct_clearing_obligation ON public.acct_clearing_allocations(obligation_line_id,effective_date);
CREATE INDEX acct_clearing_settlement ON public.acct_clearing_allocations(settlement_line_id,effective_date);
CREATE TABLE public.acct_clearing_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL UNIQUE REFERENCES public.acct_clearing_allocations(id),
  effective_date date NOT NULL,
  reversal_entry_id uuid REFERENCES public.acct_journal_entries(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_obligation_reviews (
  id uuid PRIMARY KEY,
  line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  as_of date NOT NULL,
  residual_cents bigint NOT NULL CHECK(residual_cents<>0),
  expected_resolution date NOT NULL CHECK(expected_resolution>as_of),
  document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_transfer_groups (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  outgoing_entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  incoming_entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  from_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
  to_account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
  outgoing_date date NOT NULL,
  incoming_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','corrected')),
  memo text NOT NULL CHECK(length(btrim(memo)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(from_account_id<>to_account_id)
);

CREATE OR REPLACE FUNCTION public.acct_clearing_residual(p_line uuid,p_as_of date DEFAULT '2100-12-31') RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT l.amount_cents-sign(l.amount_cents)*coalesce((SELECT sum(a.amount_cents) FROM public.acct_clearing_allocations a WHERE (a.obligation_line_id=l.id OR a.settlement_line_id=l.id) AND a.effective_date<=p_as_of AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id AND r.effective_date<=p_as_of)),0) FROM public.acct_journal_lines l WHERE l.id=p_line;
$$;
CREATE OR REPLACE FUNCTION public.acct_clearing_capacity(p_line uuid,p_from date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH events AS (
   SELECT a.effective_date AS day,a.amount_cents::numeric AS delta FROM public.acct_clearing_allocations a WHERE p_line IN (a.obligation_line_id,a.settlement_line_id) AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id AND r.effective_date<=a.effective_date)
   UNION ALL SELECT r.effective_date,-a.amount_cents::numeric FROM public.acct_clearing_releases r JOIN public.acct_clearing_allocations a ON a.id=r.allocation_id WHERE p_line IN (a.obligation_line_id,a.settlement_line_id) AND r.effective_date>a.effective_date
 ), running AS (SELECT day,sum(sum(delta)) OVER(ORDER BY day) AS used FROM events GROUP BY day)
 SELECT abs(l.amount_cents::numeric)-greatest(coalesce((SELECT sum(delta) FROM events WHERE day<=p_from),0),coalesce((SELECT max(used) FROM running WHERE day>=p_from),0)) FROM public.acct_journal_lines l WHERE l.id=p_line;
$$;
CREATE OR REPLACE FUNCTION public.acct_clearing_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE obligation public.acct_journal_lines;settlement public.acct_journal_lines;obligation_date date;settlement_date date;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
  SELECT * INTO obligation FROM public.acct_journal_lines WHERE id=NEW.obligation_line_id;
  SELECT * INTO settlement FROM public.acct_journal_lines WHERE id=NEW.settlement_line_id;
  SELECT entry_date INTO obligation_date FROM public.acct_journal_entries WHERE id=obligation.entry_id AND status='posted';
  SELECT entry_date INTO settlement_date FROM public.acct_journal_entries WHERE id=settlement.entry_id AND status='posted';
  IF obligation.account_id IS DISTINCT FROM settlement.account_id OR obligation_date IS NULL OR settlement_date IS NULL OR sign(obligation.amount_cents)=sign(settlement.amount_cents) OR NEW.effective_date<>greatest(obligation_date,settlement_date) THEN RAISE EXCEPTION 'ACCT_CLEARING_LINES'; END IF;
  IF EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id IN (obligation.entry_id,settlement.entry_id)) AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE (id=obligation.entry_id AND reverses_entry_id=settlement.entry_id) OR (id=settlement.entry_id AND reverses_entry_id=obligation.entry_id)) THEN RAISE EXCEPTION 'ACCT_ALREADY_REVERSED'; END IF;
  IF NEW.amount_cents>public.acct_clearing_capacity(obligation.id,NEW.effective_date) OR NEW.amount_cents>public.acct_clearing_capacity(settlement.id,NEW.effective_date) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_clearing_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_clearing_allocations FOR EACH ROW EXECUTE FUNCTION public.acct_clearing_guard();
CREATE OR REPLACE FUNCTION public.acct_clearing_reverse() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='posted' AND OLD.status='draft' AND NEW.reverses_entry_id IS NOT NULL THEN
    INSERT INTO public.acct_clearing_releases(allocation_id,effective_date,reversal_entry_id,reason,created_by)
    SELECT a.id,NEW.entry_date,NEW.id,'Journal reversal released this clearing allocation',NEW.created_by FROM public.acct_clearing_allocations a JOIN public.acct_journal_lines o ON o.id=a.obligation_line_id JOIN public.acct_journal_lines s ON s.id=a.settlement_line_id WHERE NEW.reverses_entry_id IN (o.entry_id,s.entry_id) ON CONFLICT(allocation_id) DO NOTHING;
    INSERT INTO public.acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by)
    SELECT gen_random_uuid(),original.id,reversal.id,abs(original.amount_cents),greatest(NEW.entry_date,e.entry_date),'Original and reversal offset one another',NEW.created_by
    FROM public.acct_journal_lines original JOIN public.acct_journal_entries e ON e.id=original.entry_id JOIN public.acct_journal_lines reversal ON reversal.entry_id=NEW.id AND reversal.sort_order=original.sort_order AND reversal.account_id=original.account_id AND reversal.amount_cents=-original.amount_cents
    JOIN public.acct_account_profiles p ON p.account_id=original.account_id
    WHERE original.entry_id=NEW.reverses_entry_id AND p.purpose IN ('transfers_in_transit','undeposited_funds','net_salary_payable','payroll_taxes_payable','payroll_deductions','retirement_payable','due_to_shareholder','due_from_shareholder','customer_funds','loans_payable','shareholder_loan');
    UPDATE public.acct_transfer_groups SET status='corrected',version=version+1 WHERE status='posted' AND NEW.reverses_entry_id IN (outgoing_entry_id,incoming_entry_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER acct_clearing_reverse AFTER UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_clearing_reverse();
CREATE OR REPLACE FUNCTION public.acct_clearing_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;effective date;residual numeric;a public.acct_clearing_allocations;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='clearing.allocate' THEN
    SELECT max(e.entry_date) INTO effective FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.id IN ((p_command->>'obligation_line_id')::uuid,(p_command->>'settlement_line_id')::uuid);
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',effective)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
    INSERT INTO public.acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by) VALUES(v_id,(p_command->>'obligation_line_id')::uuid,(p_command->>'settlement_line_id')::uuid,(p_command->>'amount_cents')::bigint,effective,p_command->>'reason',p_actor);
  ELSIF op='clearing.release' THEN
    SELECT * INTO a FROM public.acct_clearing_allocations WHERE id=(p_command->>'allocation_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF (p_command->>'effective_date')::date<a.effective_date THEN RAISE EXCEPTION 'ACCT_CLEARING_DATE'; END IF;
    PERFORM public.acct_require_open((p_command->>'effective_date')::date);
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',(p_command->>'effective_date')::date)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
    INSERT INTO public.acct_clearing_releases(id,allocation_id,effective_date,reason,created_by) VALUES(v_id,a.id,(p_command->>'effective_date')::date,p_command->>'reason',p_actor);
  ELSIF op='clearing.review' THEN
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.id=(p_command->>'line_id')::uuid AND e.status='posted' AND e.entry_date<=(p_command->>'as_of')::date) THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
    residual:=public.acct_clearing_residual((p_command->>'line_id')::uuid,(p_command->>'as_of')::date);
    IF residual IS DISTINCT FROM (p_command->>'residual_cents')::bigint OR residual=0 THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    INSERT INTO public.acct_obligation_reviews(id,line_id,as_of,residual_cents,expected_resolution,document_id,reason,created_by) VALUES(v_id,(p_command->>'line_id')::uuid,(p_command->>'as_of')::date,residual,(p_command->>'expected_resolution')::date,(p_command->>'document_id')::uuid,p_command->>'reason',p_actor);
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  RETURN jsonb_build_object('id',v_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_clearing_view(p_as_of date,p_account uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE rows jsonb;
BEGIN
  PERFORM public.acct_require_owner();
  WITH residuals AS (
    SELECT l.id,l.entry_id,e.entry_date,e.memo,l.account_id,a.name AS account_name,a.normal_side,l.amount_cents,public.acct_clearing_residual(l.id,p_as_of) AS residual,p.purpose
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_accounts a ON a.id=l.account_id LEFT JOIN public.acct_account_profiles p ON p.account_id=l.account_id
    WHERE e.status='posted' AND e.entry_date<=p_as_of AND (p_account IS NOT NULL AND l.account_id=p_account OR p_account IS NULL AND p.purpose IN ('transfers_in_transit','undeposited_funds','net_salary_payable','payroll_taxes_payable','payroll_deductions','retirement_payable','due_to_shareholder','due_from_shareholder','customer_funds','loans_payable','shareholder_loan'))
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('line_id',x.id,'entry_id',x.entry_id,'entry_date',x.entry_date,'memo',x.memo,'account_id',x.account_id,'account_name',x.account_name,'purpose',x.purpose,'normal_side',x.normal_side,'amount_cents',x.amount_cents::text,'residual_cents',x.residual::text,
    'review',(SELECT to_jsonb(r)||jsonb_build_object('residual_cents',r.residual_cents::text) FROM public.acct_obligation_reviews r WHERE r.line_id=x.id AND r.as_of=p_as_of AND r.residual_cents=x.residual ORDER BY created_at DESC,id LIMIT 1),
    'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text,'released',(SELECT to_jsonb(r) FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id)) ORDER BY effective_date,id),'[]') FROM public.acct_clearing_allocations a WHERE x.id IN (a.obligation_line_id,a.settlement_line_id))) ORDER BY x.entry_date,x.id),'[]') INTO rows FROM residuals x WHERE x.residual<>0;
  RETURN jsonb_build_object('as_of',p_as_of,'revision',(SELECT financial_revision::text FROM public.acct_settings),'rows',rows,
    'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY effective_date DESC,id),'[]') FROM (
      SELECT a.id,a.obligation_line_id,a.settlement_line_id,a.effective_date,a.amount_cents::text,a.reason,o.entry_id AS obligation_entry_id,s.entry_id AS settlement_entry_id,oe.memo AS obligation_memo,se.memo AS settlement_memo,ac.name AS account_name,(SELECT to_jsonb(r) FROM public.acct_clearing_releases r WHERE r.allocation_id=a.id) AS released
      FROM public.acct_clearing_allocations a JOIN public.acct_journal_lines o ON o.id=a.obligation_line_id JOIN public.acct_journal_lines s ON s.id=a.settlement_line_id JOIN public.acct_journal_entries oe ON oe.id=o.entry_id JOIN public.acct_journal_entries se ON se.id=s.entry_id JOIN public.acct_accounts ac ON ac.id=o.account_id
      WHERE a.effective_date<=p_as_of AND (p_account IS NULL OR o.account_id=p_account) ORDER BY a.effective_date DESC,a.id LIMIT 500
    ) x));
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_clearing_allocations','acct_clearing_releases','acct_obligation_reviews','acct_transfer_groups'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
  END LOOP;
END $$;
CREATE TRIGGER acct_clearing_release_immutable BEFORE UPDATE OR DELETE ON public.acct_clearing_releases FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_obligation_review_immutable BEFORE UPDATE OR DELETE ON public.acct_obligation_reviews FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
REVOKE ALL ON FUNCTION public.acct_clearing_residual(uuid,date),public.acct_clearing_guard(),public.acct_clearing_reverse() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_clearing_capacity(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_clearing_command(jsonb,uuid),public.acct_clearing_view(date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_clearing_view(date,uuid) TO authenticated;
-- ACCOUNTING CLEARING END


-- ACCOUNTING CLOSE BEGIN
CREATE TABLE public.acct_reconciliations (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  account_id uuid NOT NULL REFERENCES public.acct_accounts(id),
  from_date date NOT NULL CHECK(from_date BETWEEN '1900-01-01'::date AND '2100-12-31'::date),
  to_date date NOT NULL CHECK(to_date>=from_date AND to_date<='2100-12-31'::date),
  opening_cents bigint NOT NULL,
  ending_cents bigint NOT NULL,
  declared_count integer NOT NULL CHECK(declared_count BETWEEN 0 AND 50000),
  declared_debits_cents bigint NOT NULL CHECK(declared_debits_cents>=0),
  declared_credits_cents bigint NOT NULL CHECK(declared_credits_cents>=0),
  predecessor_id uuid REFERENCES public.acct_reconciliations(id),
  document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','superseded','cancelled')),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=3000),
  proof jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  CHECK(predecessor_id IS DISTINCT FROM id),
  CHECK((status IN ('completed','superseded'))=(completed_at IS NOT NULL))
);
CREATE TABLE public.acct_reconciliation_supersessions (
  reconciliation_id uuid PRIMARY KEY REFERENCES public.acct_reconciliations(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acct_reconciliations_account_dates ON public.acct_reconciliations(account_id,to_date,status);
CREATE TABLE public.acct_statement_items (
  id uuid PRIMARY KEY,
  reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
  ordinal integer NOT NULL CHECK(ordinal>=0),
  entry_date date NOT NULL,
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
  UNIQUE(reconciliation_id,ordinal)
);
CREATE TABLE public.acct_reconciliation_items (
  id uuid PRIMARY KEY,
  statement_item_id uuid NOT NULL REFERENCES public.acct_statement_items(id),
  entry_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
  UNIQUE(statement_item_id,entry_line_id)
);
CREATE INDEX acct_reconciliation_line_allocations ON public.acct_reconciliation_items(entry_line_id);
CREATE TABLE public.acct_reconciliation_opening (
  reconciliation_id uuid NOT NULL REFERENCES public.acct_reconciliations(id),
  entry_line_id uuid NOT NULL REFERENCES public.acct_journal_lines(id),
  amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND amount_cents>'-9223372036854775808'::bigint),
  PRIMARY KEY(reconciliation_id,entry_line_id)
);
CREATE TABLE public.acct_account_lifecycle (
  account_id uuid PRIMARY KEY REFERENCES public.acct_accounts(id),
  version integer NOT NULL DEFAULT 1,
  opened_on date NOT NULL CHECK(opened_on BETWEEN '1900-01-01'::date AND '2100-12-31'::date),
  closed_on date CHECK(closed_on>=opened_on AND closed_on<='2100-12-31'::date),
  closure_document_id uuid REFERENCES public.acct_documents(id),
  CHECK(closed_on IS NULL OR closure_document_id IS NOT NULL)
);
CREATE TABLE public.acct_close_records (
  id uuid PRIMARY KEY,
  month_start date NOT NULL REFERENCES public.acct_periods(month_start),
  snapshot_id uuid NOT NULL REFERENCES public.acct_report_snapshots(id),
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_close_reopens (
  id uuid PRIMARY KEY,
  close_id uuid NOT NULL UNIQUE REFERENCES public.acct_close_records(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE public.acct_fiscal_years (
  year integer PRIMARY KEY CHECK(year BETWEEN 1900 AND 2100),
  version integer NOT NULL DEFAULT 1,
  classification text NOT NULL CHECK(classification IN ('s_corp','other','unverified')),
  filed_on date,
  filed_snapshot_id uuid REFERENCES public.acct_report_snapshots(id),
  filed_document_id uuid REFERENCES public.acct_documents(id),
  CHECK((filed_on IS NULL)=(filed_snapshot_id IS NULL)),
  CHECK(filed_on IS NULL OR filed_document_id IS NOT NULL)
);
CREATE TABLE public.acct_restatement_cases (
  id uuid PRIMARY KEY,
  fiscal_year integer NOT NULL REFERENCES public.acct_fiscal_years(year),
  version integer NOT NULL DEFAULT 1,
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 3000),
  support_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  original_snapshot_id uuid NOT NULL REFERENCES public.acct_report_snapshots(id),
  replacement_snapshot_id uuid REFERENCES public.acct_report_snapshots(id),
  affected_periods jsonb NOT NULL,
  filed_snapshots jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
  external_return_review text NOT NULL CHECK(external_return_review IN ('required','not_required_with_explanation')),
  return_review_explanation text NOT NULL CHECK(length(btrim(return_review_explanation)) BETWEEN 1 AND 3000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX acct_one_open_restatement ON public.acct_restatement_cases(fiscal_year) WHERE status='open';
CREATE TABLE public.acct_history_checks (
  id uuid PRIMARY KEY,
  from_date date NOT NULL,
  to_date date NOT NULL CHECK(to_date>=from_date),
  source_document_id uuid NOT NULL REFERENCES public.acct_documents(id),
  controls jsonb NOT NULL,
  account_controls jsonb NOT NULL,
  revision bigint NOT NULL,
  explanation text NOT NULL CHECK(length(btrim(explanation)) BETWEEN 1 AND 3000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.acct_history_invalidations (
  check_id uuid PRIMARY KEY REFERENCES public.acct_history_checks(id),
  entry_id uuid NOT NULL REFERENCES public.acct_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.acct_close_checklist(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE ending date:=(p_month+INTERVAL '1 month -1 day')::date;report jsonb;drafts integer;imports integer;missing integer;uncategorized integer;suspense integer;clearing integer;required_accounts jsonb;obligations jsonb;
BEGIN
  PERFORM public.acct_require_owner();IF extract(day FROM p_month)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  report:=public.acct_workspace(p_month,ending);
  SELECT count(*) INTO drafts FROM public.acct_journal_entries WHERE status='draft' AND entry_date<=ending;
  SELECT count(*) INTO imports FROM public.acct_import_batches b WHERE b.from_date<=ending AND (b.status<>'completed' OR NOT b.coverage_verified) AND (b.status<>'cancelled' OR EXISTS(SELECT 1 FROM public.acct_import_groups WHERE batch_id=b.id AND status='applied'));
  SELECT count(*) INTO uncategorized FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE e.status='posted' AND e.entry_date<=ending AND e.reverses_entry_id IS NULL AND p.purpose IN ('uncategorized_income','uncategorized_expense') AND NOT EXISTS(SELECT 1 FROM public.acct_journal_entries r WHERE r.reverses_entry_id=e.id AND r.entry_date<=ending);
  SELECT count(*) INTO suspense FROM (SELECT l.account_id FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id JOIN public.acct_account_profiles p ON p.account_id=l.account_id WHERE e.status='posted' AND e.entry_date<=ending AND p.purpose='opening_balance_equity' GROUP BY l.account_id HAVING sum(l.amount_cents)<>0) x;
  WITH required AS (
    SELECT a.id,a.name,(SELECT r.id FROM public.acct_reconciliations r WHERE r.account_id=a.id AND r.status='completed' AND r.from_date<=ending AND r.to_date>=ending ORDER BY r.to_date LIMIT 1) AS reconciliation_id
    FROM public.acct_accounts a JOIN public.acct_account_profiles p ON p.account_id=a.id LEFT JOIN public.acct_account_lifecycle life ON life.account_id=a.id
    WHERE p.cash_kind IN ('bank','card','cash') AND (life.closed_on IS NULL OR life.closed_on>=p_month) AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a.id AND e.status='posted' AND e.entry_date<=ending)
  ) SELECT count(*) FILTER(WHERE reconciliation_id IS NULL),coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') INTO missing,required_accounts FROM required x;
  obligations:=public.acct_clearing_view(ending)->'rows';
  SELECT count(*) INTO clearing FROM jsonb_array_elements(obligations) x WHERE NOT (
    -- A recorded later settlement can explain a genuine timing item.
    public.acct_clearing_residual((x->>'line_id')::uuid,'2100-12-31')=0
    OR EXISTS(SELECT 1 FROM public.acct_obligation_reviews r JOIN public.acct_document_states d ON d.document_id=r.document_id WHERE r.line_id=(x->>'line_id')::uuid AND r.as_of=ending AND r.residual_cents=(x->>'residual_cents')::numeric AND r.expected_resolution>ending AND d.state='available')
  );
  RETURN jsonb_build_object('month_start',p_month,'through',ending,'revision',report->'revision','drafts',drafts,'unverified_imports',imports,'unreconciled_accounts',missing,'uncategorized_lines',uncategorized,'opening_suspense_accounts',suspense,'unexplained_clearing_lines',clearing,'accounts',required_accounts,'obligations',obligations,'reports',report,
    'month_ended',ending<=current_date,
    'ready',ending<=current_date AND drafts=0 AND imports=0 AND missing=0 AND uncategorized=0 AND suspense=0 AND clearing=0 AND report->'reports'->>'trial_balance_cents'='0' AND report->'reports'->>'balance_difference_cents'='0');
END $$;

CREATE OR REPLACE FUNCTION public.acct_period_impact(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.acct_require_owner();
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
    'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY month_start),'[]') FROM public.acct_periods p WHERE month_start>=p_month AND is_locked),
    'filed_years',(SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY year),'[]') FROM public.acct_fiscal_years y WHERE year>=extract(year FROM p_month) AND filed_on IS NOT NULL));
END $$;
CREATE OR REPLACE FUNCTION public.acct_close_history() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
 'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY month_start DESC),'[]') FROM public.acct_periods p),
 'years',(SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY year DESC),'[]') FROM public.acct_fiscal_years y),
 'restatements',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,id),'[]') FROM public.acct_restatement_cases r),
 'closes',(SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('reopen',(SELECT to_jsonb(r) FROM public.acct_close_reopens r WHERE r.close_id=c.id)) ORDER BY c.month_start DESC,c.created_at DESC,c.id),'[]') FROM public.acct_close_records c),
 'lifecycle',(SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') FROM public.acct_account_lifecycle l));
END $$;
CREATE OR REPLACE FUNCTION public.acct_snapshot_read(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 RETURN (SELECT to_jsonb(s)||jsonb_build_object('revision',s.revision::text) FROM public.acct_report_snapshots s WHERE id=p_id);
END $$;
CREATE OR REPLACE FUNCTION public.acct_lifecycle_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a uuid:=(p_command->>'id')::uuid;life public.acct_account_lifecycle;opened date:=(p_command->>'opened_on')::date;closed date:=nullif(p_command->>'closed_on','')::date;document uuid:=nullif(p_command->>'document_id','')::uuid;earliest date;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE account_id=a AND cash_kind IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
 SELECT * INTO life FROM public.acct_account_lifecycle WHERE account_id=a;
 IF coalesce(life.version,0) IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 SELECT min(e.entry_date) INTO earliest FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a AND e.status='posted';
 IF opened IS NULL OR opened>earliest OR EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a AND e.status IN ('draft','posted') AND e.entry_date>closed) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_LIFECYCLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',least(coalesce(life.closed_on,closed),coalesce(closed,life.closed_on)))::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
 IF closed IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=document AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF (SELECT coalesce(sum(l.amount_cents),0) FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=a AND e.status='posted' AND e.entry_date<=closed)<>0 OR NOT EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE account_id=a AND status='completed' AND to_date=closed AND ending_cents=0) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_CLOSE_PROOF'; END IF;
 END IF;
 INSERT INTO public.acct_account_lifecycle(account_id,opened_on,closed_on,closure_document_id) VALUES(a,opened,closed,document) ON CONFLICT(account_id) DO UPDATE SET opened_on=excluded.opened_on,closed_on=excluded.closed_on,closure_document_id=excluded.closure_document_id,version=acct_account_lifecycle.version+1;
 RETURN jsonb_build_object('id',a,'version',coalesce(life.version,0)+1);
END $$;
CREATE OR REPLACE FUNCTION public.acct_period_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;month date:=(p_command->>'month')::date;ending date;proof jsonb;snapshot uuid;old_close uuid;v_period record;v_year integer;restatement public.acct_restatement_cases;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='year.configure' THEN
    v_year:=(p_command->>'year')::integer;
    IF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=v_year AND filed_on IS NOT NULL) THEN RAISE EXCEPTION 'ACCT_FILED_YEAR'; END IF;
    INSERT INTO public.acct_fiscal_years(year,classification) VALUES(v_year,p_command->>'classification') ON CONFLICT(year) DO UPDATE SET classification=excluded.classification,version=acct_fiscal_years.version+1;
    RETURN jsonb_build_object('id',v_id);
  END IF;
  IF op='year.file' THEN
    v_year:=(p_command->>'year')::integer;
    IF NOT EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=v_year AND classification<>'unverified' AND filed_on IS NULL) OR EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open') THEN RAISE EXCEPTION 'ACCT_FILED_YEAR'; END IF;
    IF (SELECT count(*) FROM public.acct_periods WHERE extract(year FROM month_start)=v_year AND is_locked)<>12 THEN RAISE EXCEPTION 'ACCT_YEAR_CLOSE_REQUIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF (p_command->>'filed_on')::date IS NULL OR (p_command->>'filed_on')::date>current_date OR (p_command->>'filed_on')::date<=make_date(v_year,12,31) THEN RAISE EXCEPTION 'ACCT_INVALID_DATE'; END IF;
    snapshot:=gen_random_uuid();
    proof:=public.acct_workspace(make_date(v_year,1,1),make_date(v_year,12,31));
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'filing',make_date(v_year,1,1),make_date(v_year,12,31),(proof->>'revision')::bigint,proof||jsonb_build_object('close_records',(SELECT jsonb_agg(to_jsonb(c) ORDER BY month_start) FROM public.acct_close_records c WHERE extract(year FROM month_start)=v_year AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id))),p_actor);
    UPDATE public.acct_fiscal_years SET filed_on=(p_command->>'filed_on')::date,filed_document_id=(p_command->>'document_id')::uuid,filed_snapshot_id=snapshot,version=version+1 WHERE year=v_year;
    RETURN jsonb_build_object('id',v_id,'snapshot_id',snapshot);
  ELSIF op='year.restatement.complete' THEN
    SELECT * INTO restatement FROM public.acct_restatement_cases WHERE id=v_id AND status='open';
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(restatement.affected_periods) m WHERE NOT EXISTS(SELECT 1 FROM public.acct_periods p WHERE p.month_start=m.value::date AND p.is_locked)) THEN RAISE EXCEPTION 'ACCT_YEAR_CLOSE_REQUIRED'; END IF;
    snapshot:=gen_random_uuid();proof:=public.acct_workspace(restatement.from_date,restatement.to_date);
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'restatement',restatement.from_date,restatement.to_date,(proof->>'revision')::bigint,proof||jsonb_build_object('case',to_jsonb(restatement),'annual_reports',(SELECT jsonb_agg(public.acct_workspace(make_date(y,1,1),make_date(y,12,31))) FROM generate_series(extract(year FROM restatement.from_date)::integer,extract(year FROM restatement.to_date)::integer) y)),p_actor);
    UPDATE public.acct_restatement_cases SET status='completed',replacement_snapshot_id=snapshot,version=version+1 WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'snapshot_id',snapshot);
  END IF;
  IF month IS NULL OR extract(day FROM month)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  ending:=(month+INTERVAL '1 month -1 day')::date;
  IF op='period.close' THEN
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE month_start=month AND is_locked) THEN RAISE EXCEPTION 'ACCT_PERIOD_ALREADY_CLOSED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE year=extract(year FROM month) AND classification<>'unverified') THEN RAISE EXCEPTION 'ACCT_YEAR_CLASSIFICATION_REQUIRED'; END IF;
    proof:=public.acct_close_checklist(month);
    IF NOT (proof->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_CLOSE_INCOMPLETE'; END IF;
    INSERT INTO public.acct_periods(month_start) VALUES(month) ON CONFLICT DO NOTHING;
    snapshot:=gen_random_uuid();
    INSERT INTO public.acct_report_snapshots(id,kind,from_date,to_date,revision,payload,created_by) VALUES(snapshot,'close',month,ending,(proof->>'revision')::bigint,proof,p_actor);
    INSERT INTO public.acct_close_records(id,month_start,snapshot_id,proof,created_by) VALUES(v_id,month,snapshot,proof,p_actor);
    UPDATE public.acct_periods SET is_locked=true,reason='Completed month close' WHERE month_start=month;
    RETURN jsonb_build_object('id',v_id,'snapshot_id',snapshot);
  ELSIF op IN ('period.reopen','year.restatement.begin') THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF op='year.restatement.begin' THEN
      IF EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open') THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_OPEN'; END IF;
      SELECT min(year) INTO v_year FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM month);
      IF v_year IS NULL THEN RAISE EXCEPTION 'ACCT_FILED_YEAR_REQUIRED'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
      SELECT (max(month_start)+INTERVAL '1 month -1 day')::date INTO ending FROM public.acct_periods WHERE is_locked AND month_start>=month;
      INSERT INTO public.acct_restatement_cases(id,fiscal_year,from_date,to_date,reason,support_document_id,original_snapshot_id,affected_periods,filed_snapshots,external_return_review,return_review_explanation,created_by)
      VALUES(v_id,v_year,month,ending,p_command->>'reason',(p_command->>'document_id')::uuid,(SELECT filed_snapshot_id FROM public.acct_fiscal_years WHERE year=v_year),(SELECT jsonb_agg(month_start ORDER BY month_start) FROM public.acct_periods WHERE is_locked AND month_start>=month),(SELECT jsonb_agg(to_jsonb(y) ORDER BY year) FROM public.acct_fiscal_years y WHERE filed_on IS NOT NULL AND year>=extract(year FROM month)),p_command->>'external_return_review',p_command->>'return_review_explanation',p_actor);
    ELSIF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM month)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
    -- Earlier changes affect every later close's opening balances and reports.
    FOR v_period IN SELECT month_start FROM public.acct_periods WHERE month_start>=month AND is_locked ORDER BY month_start LOOP
      SELECT c.id INTO old_close FROM public.acct_close_records c WHERE c.month_start=v_period.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id) ORDER BY created_at DESC,id LIMIT 1;
      IF old_close IS NULL THEN RAISE EXCEPTION 'ACCT_CLOSE_RECORD_MISSING'; END IF;
      INSERT INTO public.acct_close_reopens(id,close_id,reason,created_by) VALUES(gen_random_uuid(),old_close,p_command->>'reason',p_actor);
      UPDATE public.acct_periods SET is_locked=false,reason=p_command->>'reason' WHERE month_start=v_period.month_start;
    END LOOP;
    RETURN jsonb_build_object('id',v_id);
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.acct_later_period_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='posted' AND EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM NEW.entry_date)) AND NOT EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open' AND NEW.entry_date BETWEEN from_date AND to_date AND extract(year FROM to_date)>=(SELECT max(year) FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
  IF NEW.status='posted' AND EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>date_trunc('month',NEW.entry_date)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
  IF NEW.status='posted' AND EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_account_lifecycle a ON a.account_id=l.account_id WHERE l.entry_id=NEW.id AND (NEW.entry_date<a.opened_on OR NEW.entry_date>a.closed_on)) THEN RAISE EXCEPTION 'ACCT_ACCOUNT_LIFECYCLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_later_period_guard BEFORE UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_later_period_guard();
CREATE OR REPLACE FUNCTION public.acct_close_period_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.is_locked AND (TG_OP='INSERT' OR NOT OLD.is_locked) THEN
    IF NOT coalesce((public.acct_close_checklist(NEW.month_start)->>'ready')::boolean,false) OR NOT EXISTS(SELECT 1 FROM public.acct_close_records c WHERE c.month_start=NEW.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id)) THEN RAISE EXCEPTION 'ACCT_CLOSE_INCOMPLETE'; END IF;
  ELSIF TG_OP='UPDATE' AND OLD.is_locked AND NOT NEW.is_locked THEN
    IF EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL AND year>=extract(year FROM NEW.month_start)) AND NOT EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE status='open' AND NEW.month_start BETWEEN from_date AND to_date AND extract(year FROM to_date)>=(SELECT max(year) FROM public.acct_fiscal_years WHERE filed_on IS NOT NULL)) THEN RAISE EXCEPTION 'ACCT_RESTATEMENT_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_close_records c WHERE c.month_start=NEW.month_start AND NOT EXISTS(SELECT 1 FROM public.acct_close_reopens r WHERE r.close_id=c.id)) THEN RAISE EXCEPTION 'ACCT_REOPEN_RECORD_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_close_period_guard BEFORE INSERT OR UPDATE ON public.acct_periods FOR EACH ROW EXECUTE FUNCTION public.acct_close_period_guard();

CREATE OR REPLACE FUNCTION public.acct_reconciliation_line_cleared(p_line uuid,p_cutoff date DEFAULT '2100-12-31',p_include uuid DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT sum(a.amount_cents) FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id JOIN public.acct_reconciliations r ON r.id=i.reconciliation_id WHERE a.entry_line_id=p_line AND i.entry_date<=p_cutoff AND (r.status='completed' OR (r.id=p_include AND r.status='in_progress'))),0)
 +coalesce((SELECT sum(o.amount_cents) FROM public.acct_reconciliation_opening o JOIN public.acct_reconciliations r ON r.id=o.reconciliation_id WHERE o.entry_line_id=p_line AND r.from_date<=p_cutoff+1 AND (r.status='completed' OR (r.id=p_include AND r.status='in_progress'))),0);
$$;
CREATE OR REPLACE FUNCTION public.acct_reconciliation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_reconciliation uuid;v_allocation uuid;r public.acct_reconciliations;item public.acct_statement_items;line public.acct_journal_lines;line_date date;used numeric;
BEGIN
  PERFORM public.acct_write_lock();
  IF TG_TABLE_NAME='acct_reconciliations' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE'; END IF;
    IF TG_OP='UPDATE' THEN
      IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
      IF OLD.status<>'in_progress' AND NOT(OLD.status='completed' AND NEW.status='superseded' AND (to_jsonb(NEW)-'status'-'version')=(to_jsonb(OLD)-'status'-'version')) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE'; END IF;
      NEW.version:=OLD.version+1;
      IF NEW.status='completed' AND OLD.status='in_progress' THEN
        IF (to_jsonb(NEW)-'status'-'version'-'proof'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version'-'proof'-'completed_at') OR NOT coalesce((public.acct_reconciliation_proof(OLD.id)->>'ready')::boolean,false) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_INCOMPLETE'; END IF;
      END IF;
    ELSIF NEW.status<>'in_progress' THEN
      RAISE EXCEPTION 'ACCT_RECONCILIATION_INCOMPLETE';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='acct_statement_items' THEN
    v_reconciliation:=CASE WHEN TG_OP='DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
    IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.reconciliation_id<>OLD.reconciliation_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  ELSIF TG_TABLE_NAME='acct_reconciliation_opening' THEN
    v_reconciliation:=CASE WHEN TG_OP='DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
  ELSE
    SELECT * INTO item FROM public.acct_statement_items WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.statement_item_id ELSE NEW.statement_item_id END;
    v_reconciliation:=item.reconciliation_id;
    IF TG_OP<>'DELETE' THEN v_allocation:=NEW.id; END IF;
    IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.statement_item_id<>OLD.statement_item_id OR NEW.entry_line_id<>OLD.entry_line_id) THEN RAISE EXCEPTION 'ACCT_IMMUTABLE_IDENTITY'; END IF;
  END IF;
  SELECT * INTO r FROM public.acct_reconciliations WHERE id=v_reconciliation;
  IF r.status IS DISTINCT FROM 'in_progress' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_FINAL'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='acct_statement_items' THEN
    IF NEW.entry_date NOT BETWEEN r.from_date AND r.to_date OR NEW.ordinal>=r.declared_count THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO line FROM public.acct_journal_lines WHERE id=NEW.entry_line_id;
  SELECT entry_date INTO line_date FROM public.acct_journal_entries WHERE id=line.entry_id AND status='posted';
  IF line.account_id IS DISTINCT FROM r.account_id OR line_date IS NULL OR line_date>r.to_date OR sign(NEW.amount_cents)<>sign(line.amount_cents) THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_LINE'; END IF;
  IF TG_TABLE_NAME='acct_reconciliation_opening' THEN
    IF r.predecessor_id IS NOT NULL OR line_date>=r.from_date THEN RAISE EXCEPTION 'ACCT_OPENING_SCOPE'; END IF;
  ELSE
    IF sign(NEW.amount_cents)<>sign(item.amount_cents) OR line_date>item.entry_date THEN RAISE EXCEPTION 'ACCT_MATCH_AMOUNT'; END IF;
    SELECT coalesce(sum(abs(a.amount_cents::numeric)),0) INTO used FROM public.acct_reconciliation_items a WHERE statement_item_id=item.id AND a.id<>NEW.id;
    IF used+abs(NEW.amount_cents::numeric)>abs(item.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
  END IF;
  SELECT coalesce(sum(abs(a.amount_cents::numeric)),0) INTO used FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id JOIN public.acct_reconciliations s ON s.id=i.reconciliation_id WHERE a.entry_line_id=line.id AND s.status IN ('in_progress','completed') AND a.id IS DISTINCT FROM v_allocation;
  SELECT used+coalesce(sum(abs(o.amount_cents::numeric)),0) INTO used FROM public.acct_reconciliation_opening o JOIN public.acct_reconciliations s ON s.id=o.reconciliation_id WHERE o.entry_line_id=line.id AND s.status IN ('in_progress','completed') AND (TG_TABLE_NAME<>'acct_reconciliation_opening' OR o.reconciliation_id<>v_reconciliation);
  IF used+abs(NEW.amount_cents::numeric)>abs(line.amount_cents::numeric) THEN RAISE EXCEPTION 'ACCT_ALLOCATION_EXCEEDED'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.acct_close_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;r public.acct_reconciliations;v_proof jsonb;x jsonb;v_amount bigint;line record;v_open numeric;
BEGIN
  PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
  IF op='reconciliation.create' THEN
    IF NOT EXISTS(SELECT 1 FROM public.acct_account_profiles WHERE account_id=(p_command->>'account_id')::uuid AND cash_kind IN ('bank','card','cash')) THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=(p_command->>'document_id')::uuid AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE account_id=(p_command->>'account_id')::uuid AND status IN ('in_progress','completed') AND from_date<=(p_command->>'to')::date AND to_date>=(p_command->>'from')::date) THEN RAISE EXCEPTION 'ACCT_STATEMENT_OVERLAP'; END IF;
    IF nullif(p_command->>'predecessor_id','') IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE id=(p_command->>'predecessor_id')::uuid AND status='completed' AND account_id=(p_command->>'account_id')::uuid AND to_date=(p_command->>'from')::date-1 AND ending_cents=(p_command->>'opening_cents')::bigint) THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
    ELSIF EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE account_id=(p_command->>'account_id')::uuid AND status='completed') THEN RAISE EXCEPTION 'ACCT_STATEMENT_PREDECESSOR'; END IF;
    INSERT INTO public.acct_reconciliations(id,account_id,from_date,to_date,opening_cents,ending_cents,declared_count,declared_debits_cents,declared_credits_cents,predecessor_id,document_id,notes,created_by)
    VALUES(v_id,(p_command->>'account_id')::uuid,(p_command->>'from')::date,(p_command->>'to')::date,(p_command->>'opening_cents')::bigint,(p_command->>'ending_cents')::bigint,(p_command->>'declared_count')::integer,(p_command->>'declared_debits_cents')::bigint,(p_command->>'declared_credits_cents')::bigint,nullif(p_command->>'predecessor_id','')::uuid,(p_command->>'document_id')::uuid,coalesce(p_command->>'notes',''),p_actor);
    RETURN jsonb_build_object('id',v_id,'version',1);
  END IF;
  SELECT * INTO r FROM public.acct_reconciliations WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF r.version IS DISTINCT FROM (p_command->>'expected_version')::integer THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF op='reconciliation.reopen' THEN
    IF r.status<>'completed' OR length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',r.from_date)::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
    INSERT INTO public.acct_reconciliation_supersessions(reconciliation_id,reason,created_by) SELECT id,p_command->>'reason',p_actor FROM public.acct_reconciliations WHERE account_id=r.account_id AND status='completed' AND to_date>=r.to_date;
    UPDATE public.acct_reconciliations SET status='superseded' WHERE account_id=r.account_id AND status='completed' AND to_date>=r.to_date;
    RETURN jsonb_build_object('id',v_id,'version',r.version+1);
  END IF;
  IF r.status<>'in_progress' THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_FINAL'; END IF;
  IF op='reconciliation.cancel' THEN
    IF length(btrim(coalesce(p_command->>'reason','')))=0 THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
    UPDATE public.acct_reconciliations SET status='cancelled',notes=notes||E'\nCancelled: '||(p_command->>'reason'),proof=public.acct_reconciliation_proof(v_id) WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'version',r.version+1);
  ELSIF op='reconciliation.item.remove' THEN
    IF EXISTS(SELECT 1 FROM public.acct_reconciliation_items WHERE statement_item_id=(p_command->>'item_id')::uuid) THEN RAISE EXCEPTION 'ACCT_UNMATCH_FIRST'; END IF;
    DELETE FROM public.acct_statement_items WHERE id=(p_command->>'item_id')::uuid AND reconciliation_id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  ELSIF op='reconciliation.items' THEN
    IF jsonb_typeof(p_command->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'items') LOOP
      INSERT INTO public.acct_statement_items(id,reconciliation_id,ordinal,entry_date,description,amount_cents) VALUES((x->>'id')::uuid,v_id,(x->>'ordinal')::integer,(x->>'entry_date')::date,x->>'description',(x->>'amount_cents')::bigint);
    END LOOP;
  ELSIF op='reconciliation.opening' THEN
    IF r.predecessor_id IS NOT NULL OR (p_command->>'reviewed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCT_OPENING_SCOPE'; END IF;
    IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
    IF jsonb_typeof(p_command->'outstanding') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'outstanding')>1000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_command->'outstanding'))<>(SELECT count(DISTINCT value->>'line_id') FROM jsonb_array_elements(p_command->'outstanding')) THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'outstanding') LOOP
      IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.id=(x->>'line_id')::uuid AND l.account_id=r.account_id AND e.status='posted' AND e.entry_date<r.from_date AND sign(l.amount_cents)=sign((x->>'amount_cents')::bigint) AND abs((x->>'amount_cents')::numeric)<=abs(l.amount_cents::numeric)) THEN RAISE EXCEPTION 'ACCT_OPENING_SCOPE'; END IF;
    END LOOP;
    DELETE FROM public.acct_reconciliation_opening WHERE reconciliation_id=v_id;
    FOR line IN SELECT l.* FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=r.account_id AND e.status='posted' AND e.entry_date<r.from_date LOOP
      SELECT line.amount_cents-coalesce((SELECT (value->>'amount_cents')::bigint FROM jsonb_array_elements(p_command->'outstanding') WHERE (value->>'line_id')::uuid=line.id),0) INTO v_amount;
      IF v_amount<>0 THEN INSERT INTO public.acct_reconciliation_opening VALUES(v_id,line.id,v_amount); END IF;
    END LOOP;
    SELECT coalesce(sum(amount_cents),0) INTO v_open FROM public.acct_reconciliation_opening WHERE reconciliation_id=v_id;
    IF v_open<>r.opening_cents THEN RAISE EXCEPTION 'ACCT_OPENING_DIFFERENCE'; END IF;
  ELSIF op='reconciliation.allocate' THEN
    IF jsonb_typeof(p_command->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'allocations') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p_command->'allocations') LOOP
      IF NOT EXISTS(SELECT 1 FROM public.acct_statement_items WHERE id=(x->>'statement_item_id')::uuid AND reconciliation_id=v_id) THEN RAISE EXCEPTION 'ACCT_STATEMENT_SCOPE'; END IF;
      INSERT INTO public.acct_reconciliation_items(id,statement_item_id,entry_line_id,amount_cents) VALUES((x->>'id')::uuid,(x->>'statement_item_id')::uuid,(x->>'entry_line_id')::uuid,(x->>'amount_cents')::bigint);
    END LOOP;
  ELSIF op='reconciliation.unmatch' THEN
    DELETE FROM public.acct_reconciliation_items a USING public.acct_statement_items i WHERE a.id=(p_command->>'allocation_id')::uuid AND i.id=a.statement_item_id AND i.reconciliation_id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  ELSIF op='reconciliation.complete' THEN
    v_proof:=public.acct_reconciliation_proof(v_id);
    IF NOT (v_proof->>'ready')::boolean THEN RAISE EXCEPTION 'ACCT_RECONCILIATION_INCOMPLETE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.acct_document_states WHERE document_id=r.document_id AND state='available') THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
    IF EXISTS(SELECT 1 FROM public.acct_import_groups g JOIN public.acct_import_batches b ON b.id=g.batch_id WHERE g.bank_account_id=r.account_id AND g.entry_date BETWEEN r.from_date AND r.to_date AND g.status IN ('review','exception','new')) THEN RAISE EXCEPTION 'ACCT_IMPORT_INCOMPLETE'; END IF;
    UPDATE public.acct_reconciliations SET status='completed',completed_at=now(),proof=v_proof||jsonb_build_object(
      'statement_items',(SELECT coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('amount_cents',i.amount_cents::text) ORDER BY ordinal),'[]') FROM public.acct_statement_items i WHERE reconciliation_id=v_id),
      'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount_cents',a.amount_cents::text)),'[]') FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id WHERE i.reconciliation_id=v_id),
      'opening',(SELECT coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('amount_cents',o.amount_cents::text)),'[]') FROM public.acct_reconciliation_opening o WHERE reconciliation_id=v_id)) WHERE id=v_id;
    RETURN jsonb_build_object('id',v_id,'version',r.version+1);
  ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
  UPDATE public.acct_reconciliations SET notes=notes WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'version',r.version+1);
END $$;
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
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_reconciliations FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_statement_items FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_reconciliation_items FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();
CREATE TRIGGER acct_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_reconciliation_opening FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_guard();

CREATE OR REPLACE FUNCTION public.acct_reconciliation_proof(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_reconciliations;item_count integer;debits numeric;credits numeric;unmatched integer;opening numeric;book numeric;outstanding numeric;rows jsonb;
BEGIN
  PERFORM public.acct_require_owner();SELECT * INTO r FROM public.acct_reconciliations WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  SELECT count(*),coalesce(sum(amount_cents) FILTER(WHERE amount_cents>0),0),coalesce(-sum(amount_cents) FILTER(WHERE amount_cents<0),0) INTO item_count,debits,credits FROM public.acct_statement_items WHERE reconciliation_id=p_id;
  SELECT count(*) INTO unmatched FROM public.acct_statement_items i WHERE reconciliation_id=p_id AND i.amount_cents<>(SELECT coalesce(sum(amount_cents),0) FROM public.acct_reconciliation_items WHERE statement_item_id=i.id);
  IF r.predecessor_id IS NOT NULL THEN SELECT ending_cents INTO opening FROM public.acct_reconciliations WHERE id=r.predecessor_id AND status='completed' AND account_id=r.account_id AND to_date=r.from_date-1;
  ELSE SELECT coalesce(sum(amount_cents),0) INTO opening FROM public.acct_reconciliation_opening WHERE reconciliation_id=p_id; END IF;
  WITH amounts AS (
    SELECT l.id,l.entry_id,e.entry_date,e.memo,l.amount_cents,l.amount_cents-public.acct_reconciliation_line_cleared(l.id,r.to_date,p_id) AS residual
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=r.account_id AND e.status='posted' AND e.entry_date<=r.to_date
  ) SELECT coalesce(sum(amount_cents),0),coalesce(sum(residual),0),coalesce(jsonb_agg(jsonb_build_object('line_id',id,'entry_id',entry_id,'entry_date',entry_date,'memo',memo,'amount_cents',amount_cents::text,'outstanding_cents',residual::text) ORDER BY entry_date,id) FILTER(WHERE residual<>0),'[]') INTO book,outstanding,rows FROM amounts;
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'item_count',item_count,'declared_count',r.declared_count,'debits_cents',debits::text,'credits_cents',credits::text,'unmatched_items',unmatched,
    'opening_difference_cents',(opening-r.opening_cents)::text,'statement_difference_cents',(r.opening_cents+debits-credits-r.ending_cents)::text,
    'book_balance_cents',book::text,'outstanding_cents',outstanding::text,'bridge_difference_cents',(book-outstanding-r.ending_cents)::text,'outstanding',rows,
    'ready',opening IS NOT NULL AND opening=r.opening_cents AND item_count=r.declared_count AND debits=r.declared_debits_cents AND credits=r.declared_credits_cents AND unmatched=0 AND r.opening_cents+debits-credits=r.ending_cents AND book-outstanding=r.ending_cents);
END $$;

CREATE OR REPLACE FUNCTION public.acct_reconciliation_view(p_id uuid DEFAULT NULL,p_account uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.acct_reconciliations;v_items jsonb;v_lines jsonb;v_count integer;
BEGIN
  PERFORM public.acct_require_owner();
  IF p_offset<0 OR length(p_query)>200 THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
  IF p_id IS NOT NULL THEN SELECT * INTO r FROM public.acct_reconciliations WHERE id=p_id;IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY ordinal),'[]') INTO v_items FROM (
    SELECT i.id,i.ordinal,i.entry_date,i.description,i.amount_cents::text,
      (i.amount_cents-(SELECT coalesce(sum(amount_cents),0) FROM public.acct_reconciliation_items WHERE statement_item_id=i.id))::text AS remaining_cents,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'entry_line_id',a.entry_line_id,'entry_id',l.entry_id,'amount_cents',a.amount_cents::text,'memo',e.memo)),'[]') FROM public.acct_reconciliation_items a JOIN public.acct_journal_lines l ON l.id=a.entry_line_id JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE a.statement_item_id=i.id) AS allocations
    FROM public.acct_statement_items i WHERE reconciliation_id=p_id ORDER BY ordinal LIMIT 100 OFFSET p_offset
  ) x;
  WITH candidates AS (
    SELECT l.id,l.entry_id,e.entry_date,e.memo,l.amount_cents::text,
      (l.amount_cents-public.acct_reconciliation_line_cleared(l.id,coalesce(r.to_date,'2100-12-31'::date),p_id))::text AS remaining_cents,
      (l.amount_cents-coalesce((SELECT sum(a.amount_cents) FROM public.acct_reconciliation_items a JOIN public.acct_statement_items i ON i.id=a.statement_item_id JOIN public.acct_reconciliations s ON s.id=i.reconciliation_id WHERE a.entry_line_id=l.id AND s.status IN ('in_progress','completed')),0)-coalesce((SELECT sum(o.amount_cents) FROM public.acct_reconciliation_opening o JOIN public.acct_reconciliations s ON s.id=o.reconciliation_id WHERE o.entry_line_id=l.id AND s.status IN ('in_progress','completed')),0))::text AS available_cents
    FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(r.account_id,p_account) AND e.status='posted' AND (r.to_date IS NULL OR e.entry_date<=r.to_date) AND (p_query='' OR e.memo ILIKE '%'||p_query||'%' OR e.entry_date::text=p_query)
  ), page AS(SELECT * FROM candidates ORDER BY entry_date,id LIMIT 100 OFFSET p_offset)
  SELECT coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY entry_date,id) FROM page x),'[]'),(SELECT count(*) FROM candidates) INTO v_lines,v_count;
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),
    'statements',(SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('opening_cents',x.opening_cents::text,'ending_cents',x.ending_cents::text,'declared_debits_cents',x.declared_debits_cents::text,'declared_credits_cents',x.declared_credits_cents::text) ORDER BY to_date DESC,id),'[]') FROM (SELECT * FROM public.acct_reconciliations WHERE p_account IS NULL OR account_id=p_account ORDER BY to_date DESC,id LIMIT 200) x),
    'statement',CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r)||jsonb_build_object('opening_cents',r.opening_cents::text,'ending_cents',r.ending_cents::text,'declared_debits_cents',r.declared_debits_cents::text,'declared_credits_cents',r.declared_credits_cents::text) END,
    'items',v_items,'item_count',(SELECT count(*) FROM public.acct_statement_items WHERE reconciliation_id=p_id),'lines',v_lines,'line_count',v_count,
    'next_ordinal',(SELECT min(n) FROM generate_series(0,r.declared_count-1) n WHERE NOT EXISTS(SELECT 1 FROM public.acct_statement_items WHERE reconciliation_id=p_id AND ordinal=n)),
    'proof',CASE WHEN r.id IS NULL THEN NULL WHEN r.status='in_progress' THEN public.acct_reconciliation_proof(r.id) ELSE r.proof END,
    'opening_book_cents',(SELECT coalesce(sum(l.amount_cents),0)::text FROM public.acct_journal_lines l JOIN public.acct_journal_entries e ON e.id=l.entry_id WHERE l.account_id=r.account_id AND e.status='posted' AND e.entry_date<r.from_date));
END $$;
CREATE OR REPLACE FUNCTION public.acct_reconciliation_posting_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='posted' AND OLD.status='draft' THEN
    INSERT INTO public.acct_history_invalidations(check_id,entry_id) SELECT id,NEW.id FROM public.acct_history_checks WHERE to_date>=NEW.entry_date ON CONFLICT DO NOTHING;
    UPDATE public.acct_import_batches SET coverage_verified=false WHERE coverage_verified AND to_date>=NEW.entry_date;
    INSERT INTO public.acct_reconciliation_supersessions(reconciliation_id,reason,created_by)
    SELECT r.id,'A later posting changed the books within this statement scope',NEW.created_by FROM public.acct_reconciliations r WHERE r.status='completed' AND r.to_date>=NEW.entry_date AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=NEW.id AND account_id=r.account_id) ON CONFLICT DO NOTHING;
    UPDATE public.acct_reconciliations r SET status='superseded' WHERE r.status='completed' AND r.to_date>=NEW.entry_date AND EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=NEW.id AND account_id=r.account_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER acct_reconciliation_posting_changed AFTER UPDATE ON public.acct_journal_entries FOR EACH ROW EXECUTE FUNCTION public.acct_reconciliation_posting_changed();
CREATE OR REPLACE FUNCTION public.acct_document_statement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.state='archived' AND OLD.state<>'archived' AND (
    EXISTS(SELECT 1 FROM public.acct_reconciliations WHERE document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_fiscal_years WHERE filed_document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_restatement_cases WHERE support_document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_history_checks WHERE source_document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_obligation_reviews WHERE document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM public.acct_account_lifecycle WHERE closure_document_id=NEW.document_id)
  ) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_LINKED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acct_document_statement_guard BEFORE UPDATE ON public.acct_document_states FOR EACH ROW EXECUTE FUNCTION public.acct_document_statement_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acct_reconciliations','acct_reconciliation_supersessions','acct_statement_items','acct_reconciliation_items','acct_reconciliation_opening','acct_account_lifecycle','acct_close_records','acct_close_reopens','acct_fiscal_years','acct_restatement_cases','acct_history_checks','acct_history_invalidations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE TRIGGER acct_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.acct_lock_statement()',t);
    EXECUTE format('CREATE TRIGGER acct_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.acct_record_workflow_audit()',t);
  END LOOP;
END $$;
CREATE TRIGGER acct_close_immutable BEFORE UPDATE OR DELETE ON public.acct_close_records FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_reopen_immutable BEFORE UPDATE OR DELETE ON public.acct_close_reopens FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_reconciliation_supersession_immutable BEFORE UPDATE OR DELETE ON public.acct_reconciliation_supersessions FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_history_check_immutable BEFORE UPDATE OR DELETE ON public.acct_history_checks FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
CREATE TRIGGER acct_history_invalidation_immutable BEFORE UPDATE OR DELETE ON public.acct_history_invalidations FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
REVOKE ALL ON FUNCTION public.acct_reconciliation_line_cleared(uuid,date,uuid),public.acct_reconciliation_guard(),public.acct_reconciliation_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_close_command(jsonb,uuid),public.acct_operate(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_reconciliation_view(uuid,uuid,integer,text),public.acct_reconciliation_posting_changed() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_document_statement_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_close_checklist(date),public.acct_period_impact(date),public.acct_period_command(jsonb,uuid),public.acct_later_period_guard(),public.acct_close_period_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_close_history(),public.acct_snapshot_read(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acct_lifecycle_command(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.acct_books_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;section text;rows jsonb;
BEGIN
 PERFORM public.acct_require_owner();result:=public.acct_books_export()||jsonb_build_object('version',3);
 FOREACH section IN ARRAY ARRAY['reconciliations','reconciliation_supersessions','statement_items','reconciliation_items','reconciliation_opening','account_lifecycle','close_records','close_reopens','fiscal_years','restatement_cases','history_checks','history_invalidations','clearing_allocations','clearing_releases','obligation_reviews','transfer_groups'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN (key LIKE ''%%_cents'' OR key IN (''revision'',''financial_revision'')) AND value<>''null''::jsonb THEN to_jsonb(value#>>''{}'') ELSE value END) FROM jsonb_each(to_jsonb(x))) ORDER BY to_jsonb(x)::text),''[]'') FROM public.%I x','acct_'||section) INTO rows;
  result:=result||jsonb_build_object(section,rows);
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.acct_books_backup() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_books_backup() TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_close_history(),public.acct_snapshot_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_reconciliation_proof(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_operate(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_reconciliation_view(uuid,uuid,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_close_checklist(date),public.acct_period_impact(date) TO authenticated;
-- ACCOUNTING CLOSE END

COMMIT;
