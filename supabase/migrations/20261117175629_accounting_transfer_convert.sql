-- Convert to transfer (Nov 2026): the owner links two movements the books already hold, on two of the
-- business's own bank, card or cash accounts, as the two sides of one transfer. A card credit balance
-- refunded by check in July and deposited in November is the case that needed it: the books held one
-- side as owner drawings and the other as uncategorized income, and no screen could link them.
--  * Nothing new moves. Each side keeps its own bank or card line, date, bank description and bank
--    evidence; only its other line changes, to Transfers in transit, the account every two-day
--    transfer already runs through (transfer.create, transfer.confirm). Its contact is cleared.
--  * A draft side is categorized in place and posted so the pair can be linked, then waits in Review
--    for the owner's tick like any other draft.
--  * A reviewed side is corrected the way every reviewed edit is (entry.correct): the original stays
--    in history as the earlier version, and a reversal and the corrected version are both dated on
--    its own day. A closed month, or a later closed month, refuses it until reopened.
--  * Only the owner: never a team member with the books, never an API key or agent. The automatic
--    matching window and its rules are untouched; this is a manual match at any distance.
--  * One command, one transaction: any refusal leaves both sides exactly as they were.
--  * A posted side that was waiting in Review keeps waiting after its correction.
--  * A converted pair never becomes a learned pattern for automatic matching (transfer_candidate).

CREATE OR REPLACE FUNCTION accounting.transfer_convert(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE key uuid:=(c->>'id')::uuid; out_id uuid:=(c->>'outgoing_entry_id')::uuid; in_id uuid:=(c->>'incoming_entry_id')::uuid;
 reason text:=btrim(coalesce(c->>'reason','')); amount bigint; transit uuid; side record; e accounting.journal_entries; bank accounting.journal_lines;
 out_bank accounting.journal_lines; in_bank accounting.journal_lines; result jsonb; linked uuid; linked_ids uuid[]:='{}'; removed jsonb;
BEGIN
 -- The owner alone. A team member with the books, an API key and an agent are all refused, even through operate.
 IF auth.uid() IS NULL OR coalesce(current_setting('accounting.actor_kind',true),'')='api' OR coalesce(current_setting('api.command',true),'')<>''
  OR NOT EXISTS(SELECT 1 FROM accounting.settings WHERE id=1 AND owner_user_id=auth.uid()) THEN RAISE EXCEPTION 'ACCT_OWNER_ONLY'; END IF;
 IF key IS NULL OR out_id IS NULL OR in_id IS NULL OR out_id=in_id OR reason='' OR length(reason)>1000
  OR coalesce(c->>'amount_cents','') !~ '^[0-9]{1,18}$' OR c->>'from_account_id' IS NULL OR c->>'to_account_id' IS NULL THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 amount:=(c->>'amount_cents')::bigint;
 IF amount<=0 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit' AND NOT is_archived;
 IF transit IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSIT_REQUIRED'; END IF;
 -- Both sides are locked in one order, so two corrections of the same pair cannot interleave.
 PERFORM 1 FROM accounting.journal_entries WHERE id IN (out_id,in_id) ORDER BY id FOR UPDATE;

 FOR side IN SELECT * FROM (VALUES (1,out_id,(c->>'outgoing_version')::integer),(2,in_id,(c->>'incoming_version')::integer)) s(n,entry_id,expected) ORDER BY n LOOP
  SELECT * INTO e FROM accounting.journal_entries WHERE id=side.entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF side.expected IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF e.status NOT IN ('draft','posted') OR e.reverses_entry_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id=e.id) THEN RAISE EXCEPTION 'ACCT_TRANSFER_SIDE_STATUS'; END IF;
  IF e.transfer_group_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_ALREADY_LINKED'; END IF;
  IF e.pair_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_PAIR_CONFIRM'; END IF;
  -- Money another workflow owns changes there: a register, a payroll run, an invoice payment, a reconciliation.
  IF e.register_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id AND p.status<>'void')
   OR EXISTS(SELECT 1 FROM accounting.invoice_payments p WHERE p.entry_id=e.id AND p.removed_at IS NULL)
   OR EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.reconciliation_items ri ON ri.journal_line_id=l.id WHERE l.entry_id=e.id) THEN RAISE EXCEPTION 'ACCT_CORRECTION_LINKED'; END IF;
  -- Each side is one movement: exactly one bank, card or cash line.
  IF (SELECT count(*) FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash','card'))<>1 THEN RAISE EXCEPTION 'ACCT_TRANSFER_SIDE_SHAPE'; END IF;
  SELECT l.* INTO bank FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.subtype IN ('bank','cash','card');
  IF side.n=1 THEN out_bank:=bank; ELSE in_bank:=bank; END IF;
 END LOOP;

 -- Lines are debit-positive for every account: money leaving a bank account, or a card's balance owed
 -- rising (a charge, or a credit balance paid back out), is a credit. So the outgoing side's line is
 -- negative and the incoming side's positive, for banks and cards alike, and the two cancel exactly.
 IF out_bank.account_id=in_bank.account_id THEN RAISE EXCEPTION 'ACCT_TRANSFER_SAME_ACCOUNT'; END IF;
 IF abs(out_bank.amount_cents)<>abs(in_bank.amount_cents) THEN RAISE EXCEPTION 'ACCT_TRANSFER_AMOUNT'; END IF;
 IF out_bank.amount_cents>=0 OR in_bank.amount_cents<=0 THEN RAISE EXCEPTION 'ACCT_TRANSFER_DIRECTION'; END IF;
 -- The preview the owner confirmed must still describe these two movements.
 IF out_bank.account_id<>(c->>'from_account_id')::uuid OR in_bank.account_id<>(c->>'to_account_id')::uuid OR in_bank.amount_cents<>amount THEN RAISE EXCEPTION 'ACCT_TRANSFER_CHANGED'; END IF;

 FOR side IN SELECT * FROM (VALUES (1,out_id,in_id),(2,in_id,out_id)) s(n,entry_id,other_id) ORDER BY n LOOP
  SELECT * INTO e FROM accounting.journal_entries WHERE id=side.entry_id;
  IF side.n=1 THEN bank:=out_bank; ELSE bank:=in_bank; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',l.account_id,'account',a.name,'amount_cents',l.amount_cents::text) ORDER BY l.sort_order),'[]') INTO removed
   FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND l.id<>bank.id;
  IF e.status='draft' THEN
   -- In place: the bank line and its evidence stay; the category becomes transit and the contact goes.
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',e.id,'expected_version',e.version,'account_id',transit,'kind','transfer','payee_id',NULL));
   result:=accounting.ledger_command(jsonb_build_object('type','entry.post','id',e.id,'expected_version',(result->>'version')::integer));
   -- Posted so the pair links; still the owner's to tick in Review, as the draft was.
   UPDATE accounting.journal_entries SET review_pending=true WHERE id=e.id;
   linked:=e.id;
  ELSE
   result:=accounting.ledger_command(jsonb_build_object('type','entry.correct','id',e.id,'expected_version',e.version,'replacement_id',gen_random_uuid(),
    'entry_date',e.entry_date,'reversal_date',e.entry_date,'memo',e.memo,'reason',reason,'payee_id',NULL,
    'lines',jsonb_build_array(jsonb_build_object('account_id',bank.account_id,'amount_cents',bank.amount_cents::text,'memo',bank.memo),
     jsonb_build_object('account_id',transit,'amount_cents',(-bank.amount_cents)::text))));
   linked:=(result->>'id')::uuid;
   -- A posted side still waiting for its tick keeps waiting: the correction is not the review.
   IF e.review_pending THEN UPDATE accounting.journal_entries SET review_pending=true WHERE id=linked; END IF;
  END IF;
  linked_ids:=linked_ids||linked;
  INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after,reason)
  VALUES(auth.uid(),'owner',coalesce(nullif(current_setting('accounting.operation_id',true),'')::uuid,key),'journal_entries',e.id,'transfer.converted',
   jsonb_build_object('status',e.status,'review_pending',e.review_pending,'kind',e.kind,'payee_id',e.payee_id,'removed_lines',removed),
   jsonb_build_object('transfer_group_id',key,'entry_id',linked,'counterpart_entry_id',side.other_id,'account_id',bank.account_id,'amount_cents',bank.amount_cents::text,'entry_date',e.entry_date),
   reason);
 END LOOP;

 UPDATE accounting.journal_entries SET transfer_group_id=key WHERE id=ANY(linked_ids);
 RETURN jsonb_build_object('id',key,'transfer_group_id',key,'outgoing_entry_id',linked_ids[1],'incoming_entry_id',linked_ids[2]);
END $function$
;

REVOKE ALL ON FUNCTION accounting.transfer_convert(jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.transfer_convert(jsonb) TO "postgres";

-- Routing: transfer.convert goes to its own function; every other transfer command still goes to banking_command.
CREATE OR REPLACE FUNCTION accounting.operate(command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c jsonb:=command->'command'; key uuid:=(command->>'key')::uuid; actor uuid; receipt accounting.command_receipts; hash text; result jsonb; t text; current_version integer; initialized boolean:=false;
BEGIN
 IF key IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>1000000 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
 PERFORM accounting.write_lock();
 t:=c->>'type'; actor:=auth.uid();
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind',CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'api' ELSE 'owner' END,true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t='settings.save' AND NOT EXISTS(SELECT 1 FROM accounting.settings) THEN
  IF actor IS NULL OR (EXISTS(SELECT 1 FROM public.team_members) AND coalesce(public.current_team_member_role(),'')<>'owner') THEN RAISE EXCEPTION 'ACCT_FORBIDDEN'; END IF;
  INSERT INTO accounting.settings(owner_user_id) VALUES(actor); initialized:=true;
 END IF;
 actor:=accounting.require_owner(); hash:=encode(sha256(convert_to(c::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM accounting.command_receipts WHERE idempotency_key=key;
 IF FOUND THEN
  IF receipt.actor_user_id<>actor OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'ACCT_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 IF c?'expected_revision' AND (c->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM accounting.settings WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_REVISION'; END IF;
 PERFORM set_config('accounting.operation_id',key::text,true); PERFORM set_config('accounting.actor_kind',CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'api' ELSE 'owner' END,true);
 PERFORM set_config('accounting.action',t,true); PERFORM set_config('accounting.reason',coalesce(c->>'reason',''),true);
 IF t IN ('settings.save','preferences.save') THEN
  SELECT version INTO current_version FROM accounting.settings WHERE id=1;
  IF (c->>'expected_version')::integer IS DISTINCT FROM current_version AND NOT (initialized AND coalesce((c->>'expected_version')::integer,0)=0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF c ? 'accrual_start' AND c->>'accrual_start' IS NOT NULL AND extract(day FROM (c->>'accrual_start')::date)<>1 THEN RAISE EXCEPTION 'ACCT_INVALID_ACCRUAL_START'; END IF;
  UPDATE accounting.settings SET primary_system=coalesce(c->>'primary_system',CASE c->>'authority_mode' WHEN 'admin_primary' THEN 'admin' WHEN 'wave_primary' THEN 'wave' WHEN 'parallel_pilot' THEN 'wave' END,primary_system),
   primary_system_since=CASE WHEN c?'primary_system_since' THEN (c->>'primary_system_since')::date ELSE primary_system_since END,
   transfer_window_days=coalesce((c->>'transfer_window_days')::smallint,transfer_window_days),accrual_start=CASE WHEN c ? 'accrual_start' THEN (c->>'accrual_start')::date ELSE accrual_start END,financial_revision=financial_revision+CASE WHEN c ? 'accrual_start' AND (c->>'accrual_start')::date IS DISTINCT FROM accrual_start THEN 1 ELSE 0 END,version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  IF c?'business_profile' THEN
   IF (c->>'profile_version')::integer IS DISTINCT FROM (SELECT version FROM public.business_profile WHERE id=1) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(c->'business_profile') k WHERE k NOT IN ('legal_name','dba','entity_type','ein','formation_date','state_of_formation','address','phone','email','tax_classification','tax_classification_since','home_state','is_sstb','fiscal_year_start_month','books_timezone','earliest_history_date','owner_name','owner_title','accountant_name','accountant_email','default_email_account_id')) THEN RAISE EXCEPTION 'ACCT_INVALID_PROFILE'; END IF;
   UPDATE public.business_profile p SET (legal_name,dba,entity_type,ein,formation_date,state_of_formation,address,phone,email,tax_classification,tax_classification_since,home_state,is_sstb,fiscal_year_start_month,books_timezone,earliest_history_date,owner_name,owner_title,accountant_name,accountant_email,default_email_account_id)=
    (SELECT v.legal_name,v.dba,v.entity_type,v.ein,v.formation_date,v.state_of_formation,v.address,v.phone,v.email,v.tax_classification,v.tax_classification_since,v.home_state,v.is_sstb,v.fiscal_year_start_month,v.books_timezone,v.earliest_history_date,v.owner_name,v.owner_title,v.accountant_name,v.accountant_email,v.default_email_account_id FROM jsonb_populate_record(p,c->'business_profile') v) WHERE p.id=1;
  ELSIF c?'legal_name' OR c->>'history_start' IS NOT NULL THEN
   UPDATE public.business_profile SET legal_name=coalesce(c->>'legal_name',legal_name),earliest_history_date=coalesce((c->>'history_start')::date,earliest_history_date) WHERE id=1;
  END IF;
  result:=jsonb_build_object('id',coalesce(c->>'id','1'),'version',current_version);
 ELSIF t='setup.acknowledge' THEN
  IF coalesce(c->>'key','') !~ '^[a-z][a-z0-9-]*(:[a-z0-9]{1,16})?$' OR jsonb_typeof(c->'acknowledged') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  UPDATE accounting.settings SET setup=CASE WHEN (c->>'acknowledged')::boolean THEN setup||jsonb_build_object(c->>'key',jsonb_build_object('at',now(),'by',actor)) ELSE setup-(c->>'key') END,updated_at=now() WHERE id=1 RETURNING version INTO current_version;
  result:=jsonb_build_object('id',coalesce(c->>'id',c->>'key'),'version',current_version);
 ELSIF t IN ('entry.restore','payroll.import.undo') THEN result:=accounting.lifecycle_command(c);
 ELSIF t LIKE 'account.%' OR t='chart.seed' OR t LIKE 'entry.%' OR t LIKE 'draft.%' OR t LIKE 'transaction.%' OR t='cash.allocate' THEN result:=accounting.ledger_command(c);
 ELSIF t='transfer.convert' THEN result:=accounting.transfer_convert(c);
 ELSIF t LIKE 'bank.%' OR t LIKE 'feed.%' OR t LIKE 'transfer.%' OR t LIKE 'party.%' OR t LIKE 'alias.%' OR t LIKE 'rule.%' OR t LIKE 'document.%' THEN result:=accounting.banking_command(c);
 ELSIF t LIKE 'period.%' OR t LIKE 'reconciliation.%' THEN result:=accounting.close_command(c);
 ELSIF t LIKE 'payroll.%' OR t LIKE 'register.%' THEN result:=accounting.register_command(c);
 ELSIF t LIKE 'tax.%' THEN result:=accounting.tax_command(c);
 ELSIF t LIKE 'report.%' OR t LIKE 'package.%' THEN result:=accounting.report_command(c);
 ELSIF t LIKE 'invoice.%' OR t LIKE 'invoice_source.%' THEN result:=accounting.invoice_command(c);
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 INSERT INTO accounting.command_receipts(idempotency_key,payload_hash,actor_user_id,result) VALUES(key,hash,actor,result);
 RETURN result;
END $function$
;

-- A transfer converted by hand teaches the matcher nothing: its descriptors never become a learned pair.
CREATE OR REPLACE FUNCTION accounting.transfer_candidate(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE mine record; theirs record; win integer; n integer; back integer; signal text; a text; b text; ka text; kb text;
 kw constant text:='\m(TRANSFER|AUTOPAY|EPAYMENT|E-PAYMENT|ONLINE PMT|MOBILE PMT)\M|PAYMENT[[:space:]-]*THANK YOU';
BEGIN
 SELECT * INTO mine FROM accounting.transfer_legs() t WHERE t.entry_id=entry;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT transfer_window_days INTO win FROM accounting.settings WHERE id=1;
 SELECT count(*) INTO n FROM accounting.transfer_legs() t WHERE t.entry_id<>entry AND t.account_id<>mine.account_id AND t.amount_cents=-mine.amount_cents AND abs(t.entry_date-mine.entry_date)<=win;
 IF n=0 THEN RETURN NULL; END IF;
 SELECT * INTO theirs FROM accounting.transfer_legs() t WHERE t.entry_id<>entry AND t.account_id<>mine.account_id AND t.amount_cents=-mine.amount_cents AND abs(t.entry_date-mine.entry_date)<=win
  ORDER BY abs(t.entry_date-mine.entry_date),t.entry_date,t.entry_id LIMIT 1;
 -- Mutual: the counterpart must have this movement as its only candidate too, or two payments of one amount could cross.
 SELECT count(*) INTO back FROM accounting.transfer_legs() t WHERE t.entry_id<>theirs.entry_id AND t.account_id<>theirs.account_id AND t.amount_cents=-theirs.amount_cents AND abs(t.entry_date-theirs.entry_date)<=win;
 IF n=1 AND back=1 THEN
  SELECT upper(coalesce(source_description,memo)),descriptor_key INTO a,ka FROM accounting.journal_entries WHERE id=entry;
  SELECT upper(coalesce(source_description,memo)),descriptor_key INTO b,kb FROM accounting.journal_entries WHERE id=theirs.entry_id;
  IF ka IS NOT NULL AND kb IS NOT NULL AND EXISTS(
   -- Learned: a posted transfer between the same two accounts, the same way round, claimed bank lines with these two descriptors.
   SELECT 1 FROM accounting.journal_entries g1
    JOIN accounting.journal_lines l1 ON l1.entry_id=g1.id AND l1.account_id=mine.account_id AND sign(l1.amount_cents)=sign(mine.amount_cents)
    JOIN accounting.bank_matches m1 ON m1.journal_line_id=l1.id
    JOIN accounting.bank_transactions o1 ON o1.id=m1.bank_transaction_id AND o1.descriptor_key=ka
    JOIN accounting.journal_entries g2 ON g2.transfer_group_id=g1.transfer_group_id AND g2.status='posted' AND g2.reverses_entry_id IS NULL
    JOIN accounting.journal_lines l2 ON l2.entry_id=g2.id AND l2.account_id=theirs.account_id AND sign(l2.amount_cents)=sign(theirs.amount_cents)
    JOIN accounting.bank_matches m2 ON m2.journal_line_id=l2.id
    JOIN accounting.bank_transactions o2 ON o2.id=m2.bank_transaction_id AND o2.descriptor_key=kb
    WHERE g1.transfer_group_id IS NOT NULL AND g1.status='posted' AND g1.reverses_entry_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries r WHERE r.reverses_entry_id IN (g1.id,g2.id))
     -- A transfer the owner converted by hand is one judgement, not a pattern: it teaches the matcher nothing.
     AND NOT EXISTS(SELECT 1 FROM accounting.audit_log ca WHERE ca.table_name='journal_entries' AND ca.action='transfer.converted'
      AND ca.row_id IN (g1.id,g2.id,g1.replaces_entry_id,g2.replaces_entry_id))) THEN signal:='learned';
  ELSIF EXISTS(
   -- One side's bank text names the other side's account: its institution or the last digits of its number.
   SELECT 1 FROM accounting.bank_accounts ba CROSS JOIN LATERAL (SELECT CASE WHEN ba.account_id=theirs.account_id THEN a ELSE b END txt) d
    WHERE ba.account_id IN (mine.account_id,theirs.account_id)
     AND ((length(btrim(ba.institution))>=3 AND position(upper(btrim(ba.institution)) IN d.txt)>0)
      OR (substring(ba.mask from '[0-9]{4,}') IS NOT NULL AND position(substring(ba.mask from '[0-9]{4,}') IN d.txt)>0))) THEN signal:='names_account';
  ELSIF a ~ kw OR b ~ kw THEN signal:='keyword';
  END IF;
 END IF;
 RETURN jsonb_build_object('counterpart_id',theirs.entry_id,'account_id',theirs.account_id,'entry_date',theirs.entry_date,'ambiguous',n<>1 OR back<>1,'signal',signal);
END $function$
;

