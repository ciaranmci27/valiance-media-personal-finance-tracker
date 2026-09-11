-- Receipts: the documents read returns the linked journal entries (id, memo,
-- entry_date) the screen renders, next to the raw document links. The
-- Receipts section crashed on d.entries.length without this.
CREATE OR REPLACE FUNCTION accounting.documents(filter jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
 PERFORM accounting.require_owner();
 SELECT jsonb_build_object('documents',coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('original_name',d.name,'mime_type',d.mime,'content_hash',d.sha256,'size_bytes',d.size_bytes::text,'created_at',d.uploaded_at,'storage_key',d.storage_path,'state',CASE WHEN d.status='archived' THEN 'archived' WHEN EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path) THEN 'available' ELSE 'uploading' END,
  'links',(SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') FROM accounting.document_links l WHERE document_id=d.id),
  'entries',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'memo',e.memo,'entry_date',e.entry_date) ORDER BY e.entry_date DESC,e.id),'[]') FROM accounting.document_links l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.document_id=d.id)) ORDER BY uploaded_at DESC),'[]')) INTO result
 FROM accounting.documents d WHERE (filter->>'id' IS NULL OR d.id=(filter->>'id')::uuid) AND (filter->>'status' IS NULL OR d.status=filter->>'status');
 RETURN result;
END $fn$;

-- Payees: when aliases, rules and prior treatment leave a draft uncategorized,
-- the payee's default category fills it. Previously the field was saved but
-- never read.
CREATE OR REPLACE FUNCTION accounting.apply_treatment(entry uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 -- Still uncategorized after aliases, rules and prior treatment: fall back to the payee's default category.
 IF party IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=entry AND a.system_purpose IN ('uncategorized_income','uncategorized_expense')) THEN
  SELECT p.default_account_id INTO category FROM accounting.parties p WHERE p.id=party AND p.default_account_id IS NOT NULL;
  IF category IS NOT NULL AND EXISTS(SELECT 1 FROM accounting.accounts WHERE id=category AND NOT is_archived) THEN
   result:=accounting.ledger_command(jsonb_build_object('type','entry.categorize','id',entry,'expected_version',e.version,'account_id',category,'payee_id',party::text,'memo',e.memo));
   SELECT * INTO e FROM accounting.journal_entries WHERE id=entry;
  END IF;
 END IF;
 RETURN jsonb_build_object('id',entry,'version',e.version);
END $function$
;
