-- Two reads were doing work no screen used. The workspace (every books page load and every
-- save) built the first 50 transactions in full, about half a second on the live books, though
-- every screen reads its transactions from the register. Each transaction read also looked up
-- its history by row id alone, which audit_row's index (table name first) cannot serve, so
-- every row of a register page scanned the whole audit log.

CREATE OR REPLACE FUNCTION accounting.entry_detail(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb; extra jsonb; bank_account uuid;
BEGIN
 PERFORM accounting.require_reader();
 SELECT to_jsonb(e)||jsonb_build_object('primary_origin',e.origin,
  'reversed_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE reverses_entry_id=e.id),
  'restored_by_entry_id',(SELECT id FROM accounting.journal_entries WHERE restores_entry_id=e.id),
  'replacement_entry_id',(SELECT id FROM accounting.journal_entries WHERE replaces_entry_id=e.id LIMIT 1),
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted' ORDER BY pay_date,id LIMIT 1),
  'payroll_run_ids',(SELECT coalesce(jsonb_agg(id ORDER BY pay_date,id),'[]'::jsonb) FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (coalesce(p.ytd->'patriot_import',p.ytd->'gusto_import')->>'original_entry_id'=e.id::text AND coalesce(p.ytd->'patriot_import',p.ytd->'gusto_import')->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
  -- The own account on the other side of a linked transfer, so either leg can name where the money went or came from.
  'transfer_account_id',CASE WHEN e.transfer_group_id IS NOT NULL THEN (SELECT l.account_id FROM accounting.journal_entries g JOIN accounting.journal_lines l ON l.entry_id=g.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE g.transfer_group_id=e.transfer_group_id AND g.id<>e.id AND g.reverses_entry_id IS NULL AND a.subtype IN ('bank','card','cash') ORDER BY g.entry_date,l.sort_order LIMIT 1) END,
  'payee_name',(SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),
  -- Who or what chose the category, kept through review: a person, an API key's member, a rule, the books' own fill, a matched transfer or an import.
  'categorized_by',CASE WHEN e.category_source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('source',e.category_source,
   'self',CASE WHEN e.category_actor IS NOT NULL THEN e.category_actor=auth.uid() END,
   'actor_name',(SELECT m.name FROM public.team_members m WHERE m.auth_user_id=e.category_actor),
   'actor_role',(SELECT m.role FROM public.team_members m WHERE m.auth_user_id=e.category_actor),
   'rule_name',CASE WHEN e.category_source='rule' THEN (SELECT r.name FROM accounting.rules r WHERE r.id=e.applied_rule_id) END)) END,
  'context',jsonb_build_object('kind',e.kind,'payee_id',e.payee_id),'prior_treatment',NULL,
  'lines',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',l.amount_cents::text) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id),'[]')) INTO result
 FROM accounting.journal_entries e WHERE e.id=entry;
 IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 -- The table name lets the lookup use audit_row's index; without it every entry read scanned the whole log.
 SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) ORDER BY a.id),'[]') INTO extra FROM accounting.audit_log a WHERE a.table_name='journal_entries' AND a.row_id=entry;
 result:=result||jsonb_build_object('audit',extra,'matches','[]'::jsonb,'documents','[]'::jsonb);
 IF to_regclass('accounting.bank_matches') IS NOT NULL THEN
  SELECT l.account_id INTO bank_account FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1;
  IF bank_account IS NOT NULL AND result->>'descriptor_key' IS NOT NULL THEN
   EXECUTE 'SELECT accounting.prior_summary($1,$2,10)' INTO extra USING result->>'descriptor_key',bank_account;
   result:=result||jsonb_build_object('prior_treatment',extra-ARRAY['entries','memo','last_date']);
  END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object(''amount_cents'',m.amount_cents::text)),''[]''::jsonb) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('matches',extra);
  IF result->>'status'='draft' THEN
   -- What the books did to this draft on their own, and the transfer they would suggest when nothing was sure enough to pair.
   IF result->>'fill_source' IS NOT NULL THEN
    result:=result||jsonb_build_object('fill',jsonb_strip_nulls(jsonb_build_object('source',result->>'fill_source',
     'rule_name',CASE WHEN result->>'fill_source'='rule' THEN (SELECT name FROM accounting.rules WHERE id=(result->>'applied_rule_id')::uuid) END,
     'pair_entry_date',(SELECT p.entry_date FROM accounting.journal_entries p WHERE p.id=(result->>'pair_entry_id')::uuid),
     'pair_account_id',(SELECT l.account_id FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=(result->>'pair_entry_id')::uuid AND a.subtype IN ('bank','card','cash') ORDER BY l.sort_order LIMIT 1))));
   END IF;
   EXECUTE 'SELECT accounting.transfer_candidate($1)' INTO extra USING entry;
   IF extra IS NOT NULL THEN result:=result||jsonb_build_object('transfer_suggestion',extra); END IF;
  END IF;
 END IF;
 IF to_regclass('accounting.document_links') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(d)),''[]''::jsonb) FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=$1' INTO extra USING entry;
  result:=result||jsonb_build_object('documents',extra);
 END IF;
 -- The invoices this deposit pays, and the open invoices it looks like it pays while some of it is still unapplied.
 result:=result||jsonb_build_object('invoice_links',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'invoice_id',i.id,'number',i.number,'project_name',i.project_name,'amount_cents',p.amount_cents::text,'matched_by',p.matched_by,'sync_state',p.sync_state,'last_error',p.last_error,'live',accounting.invoice_payment_live(p.id)) ORDER BY i.issue_date,i.number,p.id),'[]') FROM accounting.invoice_payments p JOIN accounting.invoices i ON i.id=p.invoice_id WHERE p.entry_id=entry AND p.removed_at IS NULL));
 extra:=accounting.invoice_candidates(entry);
 IF extra IS NOT NULL THEN result:=result||jsonb_build_object('invoice_suggestion',extra); END IF;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.workspace(from_date date, to_date date, mode text DEFAULT 'posted'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r jsonb;
BEGIN
 -- Balances and report totals only: the screens read their transactions from the register, page by page.
 PERFORM accounting.require_reader();r:=accounting.report('summary',jsonb_build_object('from',from_date,'to',to_date,'mode',coalesce(mode,'posted')));
 RETURN jsonb_build_object('legal_name',r->'legal_name','revision',r->'revision','from',from_date,'to',to_date,'accounts',r->'accounts','balances',r->'accounts','draft_count',r->'quality'->'draft_count',
 'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)),'sync_due',EXISTS(SELECT 1 FROM accounting.bank_connections WHERE status='active' AND scheduled AND (last_success_at IS NULL OR last_success_at<now()-interval '6 hours')),
 'reports',r-ARRAY['legal_name','revision','definition_version','currency','basis','generated_at','filter','accounts','rows','totals','comparison','monthly','dimensions','cash','quality']);
END $function$
;
