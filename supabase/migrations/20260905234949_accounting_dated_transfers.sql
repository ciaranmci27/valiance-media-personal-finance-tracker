-- Atomic dated transfers and guarded group reversal.
BEGIN;
-- ACCOUNTING TRANSFERS BEGIN
CREATE OR REPLACE FUNCTION public.acct_transfer_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE outgoing public.acct_journal_entries;incoming public.acct_journal_entries;transit uuid;
BEGIN
 PERFORM public.acct_write_lock();
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_APPEND_ONLY'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='posted' AND NEW.status='corrected' AND NEW.version=OLD.version+1 AND (to_jsonb(OLD)-'status'-'version')=(to_jsonb(NEW)-'status'-'version') AND EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND reverses_entry_id IN (OLD.outgoing_entry_id,OLD.incoming_entry_id)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ACCT_APPEND_ONLY';
 END IF;
 IF NEW.status<>'posted' OR NEW.version<>1 THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM public.acct_transfer_groups WHERE outgoing_entry_id IN (NEW.outgoing_entry_id,NEW.incoming_entry_id) OR incoming_entry_id IN (NEW.outgoing_entry_id,NEW.incoming_entry_id)) THEN RAISE EXCEPTION 'ACCT_TRANSFER_ALREADY_LINKED'; END IF;
 SELECT * INTO outgoing FROM public.acct_journal_entries WHERE id=NEW.outgoing_entry_id AND status='posted';
 SELECT * INTO incoming FROM public.acct_journal_entries WHERE id=NEW.incoming_entry_id AND status='posted';
 IF outgoing.id IS NULL OR incoming.id IS NULL OR outgoing.entry_date<>NEW.outgoing_date OR incoming.entry_date<>NEW.incoming_date OR EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE reverses_entry_id IN(outgoing.id,incoming.id)) THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 IF (SELECT count(*) FROM public.acct_account_profiles p JOIN public.acct_accounts a ON a.id=p.account_id WHERE p.account_id IN (NEW.from_account_id,NEW.to_account_id) AND ((p.cash_kind IN ('bank','cash') AND a.account_type='asset') OR (p.cash_kind='card' AND a.account_type='liability')))<>2 THEN RAISE EXCEPTION 'ACCT_BANK_ACCOUNT_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=outgoing.id AND account_id=NEW.from_account_id AND amount_cents=-NEW.amount_cents) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=incoming.id AND account_id=NEW.to_account_id AND amount_cents=NEW.amount_cents) THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 IF outgoing.id=incoming.id THEN
  IF (SELECT count(*) FROM public.acct_journal_lines WHERE entry_id=outgoing.id)<>2 THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 ELSE
  SELECT account_id INTO transit FROM public.acct_account_profiles WHERE purpose='transfers_in_transit';
  IF transit IS NULL OR (SELECT count(*) FROM public.acct_journal_lines WHERE entry_id IN(outgoing.id,incoming.id))<>4 OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=outgoing.id AND account_id=transit AND amount_cents=NEW.amount_cents) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_lines WHERE entry_id=incoming.id AND account_id=transit AND amount_cents=-NEW.amount_cents) THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
  IF coalesce((SELECT sum(a.amount_cents) FROM public.acct_clearing_allocations a JOIN public.acct_journal_lines o ON o.id=a.obligation_line_id JOIN public.acct_journal_lines i ON i.id=a.settlement_line_id WHERE o.account_id=transit AND i.account_id=transit AND ((o.entry_id=outgoing.id AND i.entry_id=incoming.id) OR (i.entry_id=outgoing.id AND o.entry_id=incoming.id)) AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases WHERE allocation_id=a.id)),0)<>NEW.amount_cents THEN RAISE EXCEPTION 'ACCT_TRANSFER_CLEARING_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acct_transfer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acct_transfer_groups FOR EACH ROW EXECUTE FUNCTION public.acct_transfer_guard();

CREATE OR REPLACE FUNCTION public.acct_transfer_reversal_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status='posted' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.acct_transfer_groups g WHERE NEW.reverses_entry_id IN(g.outgoing_entry_id,g.incoming_entry_id) AND
  (NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND reverses_entry_id=g.outgoing_entry_id) OR NOT EXISTS(SELECT 1 FROM public.acct_journal_entries WHERE status='posted' AND reverses_entry_id=g.incoming_entry_id))
 ) THEN RAISE EXCEPTION 'ACCT_TRANSFER_REVERSE_TOGETHER'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER acct_transfer_reversal_complete AFTER INSERT OR UPDATE ON public.acct_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_transfer_reversal_complete();

CREATE OR REPLACE FUNCTION public.acct_transfer_command(p_command jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text:=p_command->>'type';v_id uuid:=(p_command->>'id')::uuid;outgoing uuid;incoming uuid;from_account uuid;to_account uuid;out_date date;in_date date;amount bigint;transit uuid;saved jsonb;out_line uuid;in_line uuid;allocated numeric;g public.acct_transfer_groups;reversal jsonb;
BEGIN
 PERFORM public.acct_require_owner();PERFORM public.acct_write_lock();
 IF (p_command->>'expected_revision')::bigint IS DISTINCT FROM (SELECT financial_revision FROM public.acct_settings) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
 IF op='transfer.reverse' THEN
  SELECT * INTO g FROM public.acct_transfer_groups WHERE id=v_id AND status='posted';
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
  reversal:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',g.outgoing_entry_id,'expected_version',(SELECT version FROM public.acct_journal_entries WHERE id=g.outgoing_entry_id),'entry_date',p_command->'outgoing_date','reason',p_command->'reason'));
  IF g.outgoing_entry_id<>g.incoming_entry_id THEN
   saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.reverse','id',g.incoming_entry_id,'expected_version',(SELECT version FROM public.acct_journal_entries WHERE id=g.incoming_entry_id),'entry_date',p_command->'incoming_date','reason',p_command->'reason'));
  ELSE saved:=reversal; END IF;
  RETURN jsonb_build_object('id',v_id,'outgoing_reversal_id',reversal->'id','incoming_reversal_id',saved->'id');
 END IF;
 IF op NOT IN ('transfer.create','transfer.link') THEN RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND'; END IF;
 IF p_command->>'amount_cents' IS NULL OR p_command->>'amount_cents'!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'ACCT_INVALID_MONEY'; END IF;
 amount:=(p_command->>'amount_cents')::bigint;from_account:=(p_command->>'from_account_id')::uuid;to_account:=(p_command->>'to_account_id')::uuid;
 IF from_account=to_account OR length(btrim(coalesce(p_command->>'memo',''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
 SELECT account_id INTO transit FROM public.acct_account_profiles WHERE purpose='transfers_in_transit';
 IF op='transfer.create' THEN
  out_date:=(p_command->>'outgoing_date')::date;in_date:=(p_command->>'incoming_date')::date;
  IF out_date IS NULL OR in_date IS NULL OR least(out_date,in_date)<'1900-01-01'::date OR greatest(out_date,in_date)>'2100-12-31'::date THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
  outgoing:=gen_random_uuid();incoming:=CASE WHEN out_date=in_date THEN outgoing ELSE gen_random_uuid() END;
  IF outgoing<>incoming AND transit IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSIT_ACCOUNT_REQUIRED'; END IF;
  saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',outgoing,'expected_version',0,'entry_date',out_date,'memo',p_command->'memo','lines',jsonb_build_array(jsonb_build_object('account_id',from_account,'amount_cents',(-amount)::text,'memo','Transfer out'),jsonb_build_object('account_id',CASE WHEN outgoing=incoming THEN to_account ELSE transit END,'amount_cents',amount::text,'memo','Transfer in'))));
  INSERT INTO public.acct_entry_context(entry_id,kind) VALUES(outgoing,'transfer');
  PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',outgoing,'expected_version',saved->'version'));
  IF outgoing<>incoming THEN
   saved:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','draft.save','id',incoming,'expected_version',0,'entry_date',in_date,'memo',p_command->'memo','lines',jsonb_build_array(jsonb_build_object('account_id',transit,'amount_cents',(-amount)::text,'memo','Transfer in transit'),jsonb_build_object('account_id',to_account,'amount_cents',amount::text,'memo','Transfer received'))));
   INSERT INTO public.acct_entry_context(entry_id,kind) VALUES(incoming,'transfer');
   PERFORM public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',incoming,'expected_version',saved->'version'));
  END IF;
 ELSE
  outgoing:=(p_command->>'outgoing_entry_id')::uuid;incoming:=(p_command->>'incoming_entry_id')::uuid;
  SELECT entry_date INTO out_date FROM public.acct_journal_entries WHERE id=outgoing AND status='posted';
  SELECT entry_date INTO in_date FROM public.acct_journal_entries WHERE id=incoming AND status='posted';
  IF out_date IS NULL OR in_date IS NULL THEN RAISE EXCEPTION 'ACCT_POSTED_REQUIRED'; END IF;
 END IF;
 IF outgoing<>incoming THEN
  SELECT id INTO out_line FROM public.acct_journal_lines WHERE entry_id=outgoing AND account_id=transit AND amount_cents=amount;
  SELECT id INTO in_line FROM public.acct_journal_lines WHERE entry_id=incoming AND account_id=transit AND amount_cents=-amount;
  IF out_line IS NULL OR in_line IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_INVALID'; END IF;
  SELECT coalesce(sum(amount_cents),0) INTO allocated FROM public.acct_clearing_allocations WHERE ((obligation_line_id=out_line AND settlement_line_id=in_line) OR (settlement_line_id=out_line AND obligation_line_id=in_line)) AND NOT EXISTS(SELECT 1 FROM public.acct_clearing_releases WHERE allocation_id=acct_clearing_allocations.id);
  IF allocated<amount THEN
   IF EXISTS(SELECT 1 FROM public.acct_periods WHERE is_locked AND month_start>=date_trunc('month',greatest(out_date,in_date))::date) THEN RAISE EXCEPTION 'ACCT_LATER_PERIOD_LOCKED'; END IF;
   INSERT INTO public.acct_clearing_allocations(id,obligation_line_id,settlement_line_id,amount_cents,effective_date,reason,created_by) VALUES(gen_random_uuid(),out_line,in_line,amount-allocated,greatest(out_date,in_date),'Linked transfer legs',p_actor);
  END IF;
 END IF;
 INSERT INTO public.acct_transfer_groups(id,outgoing_entry_id,incoming_entry_id,from_account_id,to_account_id,outgoing_date,incoming_date,amount_cents,status,memo,created_by) VALUES(v_id,outgoing,incoming,from_account,to_account,out_date,in_date,amount,'posted',p_command->>'memo',p_actor);
 RETURN jsonb_build_object('id',v_id,'outgoing_entry_id',outgoing,'incoming_entry_id',incoming);
END $$;
CREATE OR REPLACE FUNCTION public.acct_transfers_view(p_from date,p_to date,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.acct_require_owner();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_offset<0 THEN RAISE EXCEPTION 'ACCT_INVALID_RANGE'; END IF;
 RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM public.acct_settings),'total',(SELECT count(*) FROM public.acct_transfer_groups WHERE greatest(outgoing_date,incoming_date)>=p_from AND least(outgoing_date,incoming_date)<=p_to),'groups',(
  SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('amount_cents',g.amount_cents::text,'from_name',a.name,'to_name',b.name,'in_transit',g.status='posted' AND least(g.outgoing_date,g.incoming_date)<=p_to AND greatest(g.outgoing_date,g.incoming_date)>p_to) ORDER BY greatest(outgoing_date,incoming_date) DESC,g.id),'[]') FROM (SELECT * FROM public.acct_transfer_groups WHERE greatest(outgoing_date,incoming_date)>=p_from AND least(outgoing_date,incoming_date)<=p_to ORDER BY greatest(outgoing_date,incoming_date) DESC,id LIMIT 50 OFFSET p_offset) g JOIN public.acct_accounts a ON a.id=g.from_account_id JOIN public.acct_accounts b ON b.id=g.to_account_id
 ));
END $$;
REVOKE ALL ON FUNCTION public.acct_transfer_guard(),public.acct_transfer_reversal_complete(),public.acct_transfer_command(jsonb,uuid),public.acct_transfers_view(date,date,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acct_transfers_view(date,date,integer) TO authenticated;
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
    replacement:=public.acct_command(gen_random_uuid(),jsonb_build_object('type','entry.post','id',replacement->'id','expected_version',replacement->'version'));
    INSERT INTO public.acct_entry_corrections(original_entry_id,reversal_entry_id,replacement_entry_id,reason,created_by) VALUES(original.id,(reversal->>'id')::uuid,(replacement->>'id')::uuid,p_command->>'reason',actor);
    result:=jsonb_build_object('id',replacement->'id','version',replacement->'version','reversal_id',reversal->'id','original_id',original.id);
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
-- ACCOUNTING TRANSFERS END

COMMIT;
