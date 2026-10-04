-- Rule suggestions.
--
-- A rule an agent proposes through the API (api_books_command 'rule.create')
-- was stored like a rule the owner made and paused, so on the Rules screen it
-- did not read as a suggestion. Rules gain the review state contacts have:
-- review_status ('confirmed' for the owner's rules, 'suggested' for one an
-- agent adds, until the owner approves or edits it) and suggested_by (the
-- agent's team member, from the API key, as party.save does for contacts).
--
-- Owner commands (banking_command):
-- - rule.save from the API stores a suggestion naming the agent; the owner's
--   save (an edit) makes the rule theirs (confirmed). Saving still pauses.
-- - rule.activate switching a rule on confirms it. A suggestion is approved
--   on the Rules screen by reviewing its preview and switching it on, one flow.
-- - rule.dismiss (new) deletes a suggestion that was never switched on and
--   never filled a transaction (ACCT_RULE_IN_USE otherwise). An owner rule
--   cannot be dismissed (ACCT_RULE_NOT_SUGGESTED); it is paused instead.
--   banking_guard lets exactly that delete through.
--
-- Readers:
-- - context('rules') adds per rule suggested_by_name; paused (why a rule is
--   off: 'edited' when an edit switched it off, 'paused' when the owner did,
--   'never_on' when it was never switched on, with when); and, for a
--   suggestion, what it would do today from accounting.rule_evidence (new):
--   how many live transactions it matches, how many are reviewed, how many
--   already sit in its category, how many drafts it would fill now, and the
--   agent's note when it gave one.
-- - context('manage') adds rule_suggestions, the count the Rules rail entry
--   shows.
-- - rules_list (the API and MCP rule list) adds review_status, suggested_by
--   and suggested_by_name.
-- - attention adds the info item suggested_rules, "N suggested rules are
--   waiting for approval", linking to the Rules screen, next to the one for
--   suggested contacts.
--
-- Backfill: a rule is an agent's when the audit row of its creation (table
-- rules, action rule.save, no before image) was written with actor_kind
-- 'api'. Every API write sets that kind through public.api_act, and the audit
-- row also keeps the key, so the suggester is the key's team member (or the
-- acting user's member). Such a rule stays a suggestion unless the owner has
-- since edited it or switched it on; then it is confirmed and keeps
-- suggested_by as history. The id pattern md5('rule:' || key) is not used:
-- it can only be checked against the command receipt, and the audit row says
-- the same thing directly.

BEGIN;

-- 1. The review state, as contacts have it.
ALTER TABLE accounting.rules
  ADD COLUMN review_status text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN suggested_by uuid,
  ADD CONSTRAINT rules_review_status_check CHECK (review_status IN ('suggested', 'confirmed')),
  ADD CONSTRAINT rules_suggested_by_fkey FOREIGN KEY (suggested_by) REFERENCES public.team_members(id) ON DELETE SET NULL;

-- 2. What a suggestion would do, for the Rules screen.
CREATE OR REPLACE FUNCTION accounting.rule_evidence(rule uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r accounting.rules; pattern text; result jsonb;
BEGIN
 SELECT * INTO r FROM accounting.rules WHERE id=rule;
 IF NOT FOUND THEN RETURN NULL; END IF;
 pattern:=upper(regexp_replace(btrim(coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1),'')),'\s+',' ','g'));
 -- What the rule matches in the books today, tested by the preview's own matcher on the live transactions whose text holds its pattern.
 SELECT jsonb_build_object('matches',count(*),'posted',count(*) FILTER(WHERE q.c->>'status'='posted'),
  'in_category',count(*) FILTER(WHERE r.actions?'account_id' AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.c->'lines') l WHERE l->>'account_id'=r.actions->>'account_id')),
  'ready',count(*) FILTER(WHERE (q.c->>'eligible')::boolean)) INTO result
 FROM (SELECT accounting.rule_candidate(e.id,r.id) c FROM accounting.journal_entries e
  WHERE e.status<>'discarded' AND pattern<>'' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries x WHERE x.reverses_entry_id=e.id)
   AND position(pattern IN upper(regexp_replace(coalesce(e.source_description,'')||' '||coalesce(e.memo,'')||' '||coalesce(e.descriptor_key,accounting.descriptor_key(e.memo),''),'\s+',' ','g')))>0) q
 WHERE q.c IS NOT NULL;
 -- The agent's own words when it proposed the rule, unless it gave none.
 RETURN result||jsonb_build_object('note',(SELECT nullif(nullif(btrim(a.reason),''),'Created through the API') FROM accounting.audit_log a WHERE a.table_name='rules' AND a.row_id=rule AND a.before IS NULL ORDER BY a.id LIMIT 1));
END $function$
;

REVOKE ALL ON FUNCTION accounting.rule_evidence(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.rule_evidence(uuid) TO "postgres";

-- 3. Commands, guard and readers restated in full.
CREATE OR REPLACE FUNCTION accounting.banking_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 ELSIF TG_TABLE_NAME='document_links' AND TG_OP='DELETE' AND current_setting('accounting.action',true)='document.unlink' THEN RETURN OLD;
 -- A dismissed suggestion that never ran leaves nothing to keep; banking_command checks that before it deletes.
 ELSIF TG_TABLE_NAME='rules' AND TG_OP='DELETE' AND current_setting('accounting.action',true)='rule.dismiss' THEN
  IF OLD.review_status='suggested' AND NOT OLD.enabled THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCT_NO_HARD_DELETE';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('parties','payee_aliases','bank_accounts','bank_connections','documents','rules') THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.banking_command(c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
<<banking_command>>
DECLARE t text:=c->>'type'; key uuid:=coalesce((c->>'id')::uuid,gen_random_uuid());actor uuid:=CASE WHEN current_setting('role',true)='service_role' AND current_setting('accounting.actor_kind',true)='worker' THEN NULL ELSE accounting.require_owner() END;
 v integer; current_version integer; candidate_count integer; x jsonb; result jsonb; candidate jsonb; observation accounting.bank_transactions; doc accounting.documents; item accounting.journal_lines; existing jsonb;
 cond jsonb; actions jsonb; mapping_connection uuid; mapping_details jsonb; mapped_row accounting.bank_accounts; account uuid; transit uuid; leg accounting.journal_entries; mate accounting.journal_entries; outgoing jsonb; incoming jsonb; out_id uuid; in_id uuid; amount bigint; match_amount bigint; out_date date; in_date date;
 party_roles text[]; merge_from accounting.parties; merge_into accounting.parties; moved_entries integer; moved_aliases integer; moved_documents integer; moved_rules integer;
 rule_row accounting.rules;
BEGIN
 IF t='party.save' THEN
  SELECT version INTO current_version FROM accounting.parties WHERE id=key;
  IF (c->>'expected_version')::integer IS DISTINCT FROM coalesce(current_version,0) THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- One or more known roles, each stored once, in the list's own order.
  IF jsonb_typeof(c->'roles') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'roles')=0
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'roles') r WHERE jsonb_typeof(r) IS DISTINCT FROM 'string' OR NOT ((r#>>'{}')=ANY(ARRAY['client','vendor','contractor','employee','government','financial','owner']))) THEN RAISE EXCEPTION 'ACCT_INVALID_ROLES'; END IF;
  party_roles:=ARRAY(SELECT known.r FROM unnest(ARRAY['client','vendor','contractor','employee','government','financial','owner']) WITH ORDINALITY AS known(r,n) WHERE c->'roles' ? known.r ORDER BY known.n);
  -- A contact an agent adds is a suggestion that names the agent; the owner's save confirms it.
  INSERT INTO accounting.parties(id,name,roles,email,phone,website,default_account_id,contractor_classification,documentation_status,notes,is_archived,review_status,suggested_by)
  VALUES(key,c->>'name',party_roles,nullif(btrim(c->>'email'),''),nullif(btrim(c->>'phone'),''),nullif(btrim(c->>'website'),''),(c->>'default_account_id')::uuid,
   CASE WHEN coalesce(c->>'contractor_classification',c->>'tax_classification','unknown')='unreviewed' THEN 'unknown' WHEN c->>'tax_classification'='partnership' THEN 'other' ELSE coalesce(c->>'contractor_classification',c->>'tax_classification','unknown') END,
   CASE WHEN c->>'documentation'='requested' THEN 'missing' ELSE coalesce(c->>'documentation_status',c->>'documentation','missing') END,coalesce(c->>'notes',''),coalesce((c->>'is_archived')::boolean,false),
   CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'suggested' ELSE 'confirmed' END,
   CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN (SELECT k.team_member_id FROM public.api_keys k WHERE k.id::text=current_setting('api.key_id',true)) END)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,roles=excluded.roles,email=excluded.email,phone=excluded.phone,website=excluded.website,default_account_id=excluded.default_account_id,contractor_classification=excluded.contractor_classification,documentation_status=excluded.documentation_status,notes=excluded.notes,is_archived=excluded.is_archived,review_status=excluded.review_status RETURNING version INTO v;
 ELSIF t='party.approve' THEN
  IF jsonb_typeof(c->'ids') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'ids') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'ACCT_INVALID_COMMAND'; END IF;
  result:='[]';
  FOR x IN SELECT value FROM jsonb_array_elements(c->'ids') LOOP
   SELECT * INTO merge_from FROM accounting.parties WHERE id=(x#>>'{}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF c->'expected_versions' ? merge_from.id::text AND (c->'expected_versions'->>merge_from.id::text)::integer IS DISTINCT FROM merge_from.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   IF merge_from.review_status='suggested' THEN
    UPDATE accounting.parties SET review_status='confirmed' WHERE id=merge_from.id RETURNING version INTO v;
    result:=result||jsonb_build_array(jsonb_build_object('id',merge_from.id,'version',v));
   END IF;
  END LOOP;
  RETURN jsonb_build_object('id',key,'approved',result,'count',jsonb_array_length(result));
 ELSIF t='party.merge' THEN
  SELECT * INTO merge_from FROM accounting.parties WHERE id=(c->>'from_id')::uuid;
  SELECT * INTO merge_into FROM accounting.parties WHERE id=(c->>'into_id')::uuid;
  IF merge_from.id IS NULL OR merge_into.id IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF merge_from.id=merge_into.id OR merge_into.is_archived THEN RAISE EXCEPTION 'ACCT_INVALID_MERGE'; END IF;
  IF (c->>'from_version')::integer IS DISTINCT FROM merge_from.version OR (c->>'into_version')::integer IS DISTINCT FROM merge_into.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- A locked month keeps the contact its reports were closed with, so the merge waits until it reopens.
  SELECT min(entry_date) INTO out_date FROM accounting.journal_entries WHERE payee_id=merge_from.id AND status<>'discarded';
  IF out_date IS NOT NULL THEN PERFORM accounting.require_open(out_date); END IF;
  -- Discarded entries keep their contact: they cannot change, and the merged contact stays (archived) for them.
  UPDATE accounting.journal_entries SET payee_id=merge_into.id WHERE payee_id=merge_from.id AND status<>'discarded';
  GET DIAGNOSTICS moved_entries=ROW_COUNT;
  -- Alias patterns are unique across contacts, so every alias moves without a clash.
  UPDATE accounting.payee_aliases SET party_id=merge_into.id WHERE party_id=merge_from.id;
  GET DIAGNOSTICS moved_aliases=ROW_COUNT;
  -- A document already linked to both stays linked to each; only the other links move.
  UPDATE accounting.document_links d SET party_id=merge_into.id WHERE d.party_id=merge_from.id
   AND NOT EXISTS(SELECT 1 FROM accounting.document_links o WHERE o.document_id=d.document_id AND o.party_id=merge_into.id);
  GET DIAGNOSTICS moved_documents=ROW_COUNT;
  UPDATE accounting.rules r SET conditions=CASE WHEN r.conditions->>'payee_id'=merge_from.id::text THEN jsonb_set(r.conditions,'{payee_id}',to_jsonb(merge_into.id::text)) ELSE r.conditions END,
   actions=CASE WHEN r.actions->>'payee_id'=merge_from.id::text THEN jsonb_set(r.actions,'{payee_id}',to_jsonb(merge_into.id::text)) ELSE r.actions END
   WHERE r.conditions->>'payee_id'=merge_from.id::text OR r.actions->>'payee_id'=merge_from.id::text;
  GET DIAGNOSTICS moved_rules=ROW_COUNT;
  -- The kept contact gains the other's roles and fills its own blanks from it.
  UPDATE accounting.parties SET roles=ARRAY(SELECT known.r FROM unnest(ARRAY['client','vendor','contractor','employee','government','financial','owner']) WITH ORDINALITY AS known(r,n) WHERE known.r=ANY(merge_into.roles) OR known.r=ANY(merge_from.roles) ORDER BY known.n),
   email=coalesce(merge_into.email,merge_from.email),phone=coalesce(merge_into.phone,merge_from.phone),website=coalesce(merge_into.website,merge_from.website),
   default_account_id=coalesce(merge_into.default_account_id,merge_from.default_account_id),
   contractor_classification=CASE WHEN merge_into.contractor_classification='unknown' THEN merge_from.contractor_classification ELSE merge_into.contractor_classification END,
   documentation_status=CASE WHEN merge_into.documentation_status='missing' THEN merge_from.documentation_status ELSE merge_into.documentation_status END,
   notes=CASE WHEN merge_into.notes='' THEN merge_from.notes ELSE merge_into.notes END,review_status='confirmed'
   WHERE id=merge_into.id RETURNING version INTO v;
  UPDATE accounting.parties SET is_archived=true,review_status='confirmed' WHERE id=merge_from.id;
  RETURN jsonb_build_object('id',merge_into.id,'version',v,'from_id',merge_from.id,'moved',jsonb_build_object('entries',moved_entries,'aliases',moved_aliases,'documents',moved_documents,'rules',moved_rules));
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
   -- Switching a suggestion on after its preview is the owner's approval: it becomes theirs.
   UPDATE accounting.rules SET enabled=(c->>'enabled')::boolean,review_status=CASE WHEN (c->>'enabled')::boolean THEN 'confirmed' ELSE review_status END WHERE id=key RETURNING version INTO v;
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
   -- A rule an agent adds is a suggestion that names the agent; the owner's save makes it theirs.
   INSERT INTO accounting.rules(id,name,priority,enabled,conditions,actions,auto_post,review_status,suggested_by) VALUES(key,c->>'name',coalesce((c->>'priority')::integer,100),coalesce((c->>'enabled')::boolean,false),cond,actions,coalesce((c->>'auto_post')::boolean,false),
    CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN 'suggested' ELSE 'confirmed' END,
    CASE WHEN current_setting('accounting.actor_kind',true)='api' THEN (SELECT k.team_member_id FROM public.api_keys k WHERE k.id::text=current_setting('api.key_id',true)) END)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,conditions=excluded.conditions,actions=excluded.actions,enabled=excluded.enabled,auto_post=excluded.auto_post,review_status=excluded.review_status RETURNING version INTO v;
  END IF;
 ELSIF t='rule.dismiss' THEN
  SELECT * INTO rule_row FROM accounting.rules WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM rule_row.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  -- Only a suggestion is dismissed; the owner pauses a rule of their own instead.
  IF rule_row.review_status<>'suggested' THEN RAISE EXCEPTION 'ACCT_RULE_NOT_SUGGESTED'; END IF;
  -- A rule that was ever switched on or filled a transaction stays, so the history that names it keeps its source.
  IF rule_row.enabled
   OR EXISTS(SELECT 1 FROM accounting.audit_log a WHERE a.table_name='rules' AND a.row_id=key AND coalesce((a.after->>'enabled')::boolean,false))
   OR EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.applied_rule_id=key)
   OR EXISTS(SELECT 1 FROM accounting.audit_log a WHERE a.table_name='journal_entries' AND a.action='rule.applied' AND a.before->>'rule_id'=key::text) THEN RAISE EXCEPTION 'ACCT_RULE_IN_USE'; END IF;
  DELETE FROM accounting.rules WHERE id=key;
  RETURN jsonb_build_object('id',key,'dismissed',true);
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
 ELSIF t IN ('document.complete','document.link','document.archive','document.unlink') THEN
  SELECT * INTO doc FROM accounting.documents WHERE id=coalesce((c->>'document_id')::uuid,key);
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF c?'expected_version' AND (c->>'expected_version')::integer IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF t NOT IN ('document.archive','document.unlink') AND NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=doc.storage_path) THEN RAISE EXCEPTION 'ACCT_DOCUMENT_UNAVAILABLE'; END IF;
  IF t='document.link' THEN
   INSERT INTO accounting.document_links(document_id,entry_id,bank_transaction_id,reconciliation_id,payroll_run_id,register_id,party_id,created_by)
   VALUES(doc.id,(c->>'entry_id')::uuid,(c->>'bank_transaction_id')::uuid,(c->>'reconciliation_id')::uuid,(c->>'payroll_run_id')::uuid,(c->>'register_id')::uuid,(c->>'party_id')::uuid,actor) ON CONFLICT DO NOTHING;
  END IF;
  IF t IN ('document.archive','document.unlink') AND btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  IF t='document.unlink' THEN
   PERFORM set_config('accounting.action','document.unlink',true);
   DELETE FROM accounting.document_links WHERE document_id=doc.id AND entry_id=(c->>'entry_id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  END IF;
  UPDATE accounting.documents SET status=CASE t WHEN 'document.archive' THEN 'archived' WHEN 'document.link' THEN 'linked' WHEN 'document.unlink' THEN CASE WHEN EXISTS(SELECT 1 FROM accounting.document_links WHERE document_id=doc.id) THEN status ELSE 'inbox' END ELSE status END WHERE id=doc.id RETURNING version INTO v;
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
 ELSIF t='bank.exclude' THEN
  UPDATE accounting.bank_transactions SET review=CASE WHEN coalesce((c->>'excluded')::boolean,true) THEN 'excluded' ELSE 'unmatched' END,excluded_reason=coalesce(c->>'reason','') WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.release' THEN
  IF btrim(coalesce(c->>'reason',''))='' THEN RAISE EXCEPTION 'ACCT_REASON_REQUIRED'; END IF;
  DELETE FROM accounting.bank_matches WHERE id=(c->>'match_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
 ELSIF t='bank.match' THEN
  SELECT * INTO observation FROM accounting.bank_transactions WHERE id=coalesce(c->>'bank_transaction_id',c->>'group_id',c->>'id')::uuid;
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
 ELSIF t IN ('transfer.confirm','transfer.unpair') THEN
  SELECT * INTO leg FROM accounting.journal_entries WHERE id=key;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  IF (c->>'expected_version')::integer IS DISTINCT FROM leg.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
  IF leg.status<>'draft' OR leg.pair_entry_id IS NULL THEN RAISE EXCEPTION 'ACCT_TRANSFER_NOT_PAIRED'; END IF;
  IF t='transfer.unpair' THEN
   PERFORM accounting.transfer_unpair(key);
   RETURN jsonb_build_object('id',key,'version',(SELECT version FROM accounting.journal_entries WHERE id=key),'pair_entry_id',leg.pair_entry_id);
  END IF;
  SELECT * INTO mate FROM accounting.journal_entries WHERE id=leg.pair_entry_id;
  IF mate.status IS DISTINCT FROM 'draft' OR mate.pair_entry_id IS DISTINCT FROM key THEN RAISE EXCEPTION 'ACCT_TRANSFER_NOT_PAIRED'; END IF;
  SELECT id INTO transit FROM accounting.accounts WHERE system_purpose='transfers_in_transit';
  -- The pair must still be exactly a transfer through transit: one bank line and one transit line a side, opposite amounts, two accounts.
  IF (SELECT count(*) FROM accounting.journal_lines WHERE entry_id IN (key,mate.id))<>4
   OR (SELECT count(*) FROM accounting.journal_lines WHERE entry_id IN (key,mate.id) AND account_id=transit)<>2
   OR (SELECT count(DISTINCT l.account_id)<>2 OR sum(l.amount_cents)<>0 OR count(DISTINCT l.entry_id)<>2 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id IN (key,mate.id) AND a.subtype IN ('bank','cash','card'))
  THEN RAISE EXCEPTION 'ACCT_INVALID_TRANSFER'; END IF;
  account:=gen_random_uuid();
  UPDATE accounting.journal_entries SET pair_entry_id=NULL,transfer_group_id=account WHERE id IN (key,mate.id);
  FOR x IN SELECT jsonb_build_object('id',e.id,'version',e.version) FROM accounting.journal_entries e WHERE e.id IN (key,mate.id) ORDER BY e.entry_date,e.id LOOP
   PERFORM accounting.ledger_command(jsonb_build_object('type','entry.post','id',x->'id','expected_version',x->'version'));
  END LOOP;
  RETURN jsonb_build_object('id',key,'version',(SELECT version FROM accounting.journal_entries WHERE id=key),'transfer_group_id',account,'pair_entry_id',mate.id);
 ELSIF t='transfer.reverse' THEN
  IF NOT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE transfer_group_id=key AND reverses_entry_id IS NULL) THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  FOR x IN SELECT to_jsonb(e) FROM accounting.journal_entries e WHERE transfer_group_id=key AND reverses_entry_id IS NULL ORDER BY entry_date,id LOOP
   PERFORM accounting.ledger_command(jsonb_build_object('type','entry.reverse','id',x->'id','expected_version',x->'version','entry_date',CASE WHEN EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=(x->>'id')::uuid AND amount_cents<0 AND account_id<>(SELECT id FROM accounting.accounts WHERE system_purpose='transfers_in_transit')) THEN c->>'outgoing_date' ELSE c->>'incoming_date' END,'reason',c->'reason'));
  END LOOP;
 ELSE RAISE EXCEPTION 'ACCT_UNKNOWN_COMMAND: %',t;
 END IF;
 RETURN jsonb_strip_nulls(jsonb_build_object('id',key,'version',v));
END $function$
;

CREATE OR REPLACE FUNCTION accounting.context(view text, params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=accounting.require_owner();result jsonb;key uuid;selected_record jsonb;items jsonb;candidates jsonb;
BEGIN
 IF view='session' THEN RETURN jsonb_build_object('owner_id',actor); END IF;
 IF view='manage' THEN
  RETURN jsonb_build_object('profiles',(SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',id,'version',version,'purpose',system_purpose,'cash_kind',CASE WHEN subtype IN ('bank','cash','card') THEN subtype ELSE 'none' END,'parent_account_id',parent_id,'subtype',subtype,'type',type,'external_names',external_names) ORDER BY code,name),'[]') FROM accounting.accounts),
   'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('tax_classification',CASE WHEN contractor_classification='unknown' THEN 'unreviewed' ELSE contractor_classification END,'documentation',documentation_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by),'top_category',CASE WHEN t.account_id IS NULL THEN NULL ELSE jsonb_build_object('id',t.account_id,'name',t.account_name) END) ORDER BY p.name),'[]') FROM accounting.parties p LEFT JOIN accounting.contact_top_categories() t ON t.party_id=p.id),
   'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked')),'[]') FROM accounting.periods p),
   'rule_suggestions',(SELECT count(*) FROM accounting.rules WHERE review_status='suggested'),
   'preferences',(SELECT to_jsonb(s)-ARRAY['owner_user_id','financial_revision']||jsonb_build_object('history_start',p.earliest_history_date,'legal_name',p.legal_name,'business_profile',to_jsonb(p)) FROM accounting.settings s CROSS JOIN public.business_profile p));
 ELSIF view='feeds' THEN
  RETURN jsonb_build_object('owner_id',actor,
   'connections',(SELECT coalesce(jsonb_agg(to_jsonb(c)-ARRAY['access_url_encrypted','key_version','checkpoint','lease_run_id'] ORDER BY created_at,id),'[]') FROM accounting.bank_connections c),
   'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id))),'[]') FROM accounting.bank_accounts b JOIN accounting.bank_connections c ON c.id=b.connection_id CROSS JOIN public.business_profile p),
   'identities',(SELECT coalesce(jsonb_agg(d.value||jsonb_build_object('connection_id',c.id,'provider_account_id',d.value->>'raw_provider_account_id','version',coalesce(b.version,0),'feed_account_id',b.id,'last_seen_at',c.updated_at,
    'account',CASE WHEN b.id IS NULL THEN NULL ELSE to_jsonb(b)||jsonb_build_object('history_start',extract(epoch FROM (b.coverage_from::timestamp AT TIME ZONE p.books_timezone))::bigint::text,'checkpoint',c.checkpoint->>b.provider_account_id,'posting_timezone',p.books_timezone,'balance_sign',coalesce(c.checkpoint->'balance_signs'->b.id::text,'1'),'can_edit_settings',NOT EXISTS(SELECT 1 FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id)) END,
    'balance',jsonb_build_object('balance_cents',d.value->'balance_cents','available_cents',d.value->'available_cents','balance_at',d.value->'balance_at','issues','[]'::jsonb,'created_at',c.updated_at)) ORDER BY c.created_at,d.key),'[]') FROM accounting.bank_connections c CROSS JOIN public.business_profile p CROSS JOIN LATERAL jsonb_each(coalesce(c.checkpoint->'discovery','{}')) d LEFT JOIN accounting.bank_accounts b ON b.id=d.key::uuid),
   'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.operation_id,'connection_id',a.row_id,'actor_kind',a.actor_kind,'status',CASE WHEN (a.after->>'errors')::int>0 THEN 'incomplete' ELSE 'saved' END,'started_at',a.at,'finished_at',a.at,'error','') ORDER BY a.at DESC),'[]') FROM (SELECT * FROM accounting.audit_log WHERE table_name='bank_connections' AND action='sync' AND after ? 'accounts' ORDER BY at DESC LIMIT 100) a),
   'queue',(SELECT coalesce(jsonb_agg(jsonb_build_object('feed_account_id',b.id,'ready',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND o.review='unmatched' AND state='posted'),'pending',(SELECT count(*) FROM accounting.bank_transactions o WHERE o.bank_account_id=b.id AND state='pending'))),'[]') FROM accounting.bank_accounts b),
   'worker',(SELECT jsonb_build_object('last_tick_at',w.last_tick_at,'last_tick_due',w.last_tick_due,'source',w.source) FROM accounting.feed_worker w WHERE w.id=1));
 ELSIF view='rules' THEN
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('description_mode',coalesce(r.conditions->>'description_mode',(SELECT d.key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) d LIMIT 1)),'description',coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1)),'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction','min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id','reason','',
   'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=r.suggested_by),
   -- Why a rule is off: the change that switched it off (an edit or the owner's pause), or never switched on yet.
   'paused',CASE WHEN r.enabled THEN NULL ELSE coalesce((SELECT jsonb_build_object('cause',CASE a.action WHEN 'rule.save' THEN 'edited' WHEN 'rule.activate' THEN 'paused' ELSE 'other' END,'at',a.at) FROM accounting.audit_log a
    WHERE a.table_name='rules' AND a.row_id=r.id AND coalesce((a.before->>'enabled')::boolean,false) AND NOT coalesce((a.after->>'enabled')::boolean,false) ORDER BY a.id DESC LIMIT 1),jsonb_build_object('cause','never_on','at',r.created_at)) END,
   'suggestion',CASE WHEN r.review_status='suggested' THEN accounting.rule_evidence(r.id) END) ORDER BY priority,id),'[]') FROM accounting.rules r),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name,'match_mode',a.match_kind,'description',a.pattern) ORDER BY a.pattern),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id));
 ELSIF view='close-history' THEN
  RETURN jsonb_build_object('periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked') ORDER BY month DESC),'[]') FROM accounting.periods p),'reconciliations',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]') FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id));
 ELSIF view='tax' THEN
  SELECT id INTO key FROM public.tax_estimates WHERE tax_year=(context.params->>'year')::integer AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1;
  RETURN accounting.tax_link(key)||jsonb_build_object('_safe_harbor_context',jsonb_build_object('as_of',(SELECT (now() AT TIME ZONE books_timezone)::date FROM public.business_profile),'financial_revision',(SELECT financial_revision::text FROM accounting.settings),'available_documents',(SELECT coalesce(jsonb_agg(d.id),'[]') FROM accounting.documents d WHERE d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path))));
 ELSIF view='evidence' THEN
  key:=(context.params->>'id')::uuid;PERFORM accounting.entry_detail(key);
  RETURN jsonb_build_object('sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'source_system',o.source,'external_id',o.external_id,'observed_at',o.observed_at,'raw_payload',o.raw_payload)) FROM accounting.bank_transactions o WHERE EXISTS(SELECT 1 FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE m.bank_transaction_id=o.id AND l.entry_id=key)),'[]'),
   'notes',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.after->>'note_id','note',a.after->>'note','created_at',a.at) ORDER BY a.at),'[]') FROM accounting.audit_log a WHERE a.row_id=key AND a.action='entry.annotate' AND a.after ? 'note_id'),
   'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'original_name',d.name,'size_bytes',d.size_bytes::text,'mime_type',d.mime)),'[]') FROM accounting.documents d JOIN accounting.document_links l ON l.document_id=d.id WHERE l.entry_id=key),
   'rules',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'rule_id',a.before->>'rule_id','rule_version',(a.before->>'rule_version')::integer,'rule_name',a.before->'winner'->>'name','created_at',a.at,'before_value',a.before,'after_value',a.after) ORDER BY a.id),'[]') FROM accounting.audit_log a WHERE a.row_id=key AND a.action='rule.applied'),
   'audit',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'table_name',a.table_name,'action',a.action,'recorded_at',a.at,'before_value',a.before,'after_value',a.after) ORDER BY a.at DESC),'[]') FROM accounting.audit_log a WHERE a.row_id=key));
 ELSIF view='tax-snapshot' THEN RETURN accounting.tax_link((context.params->>'id')::uuid)->'snapshot';
 ELSIF view='period-impact' THEN
  RETURN jsonb_build_object('month',(context.params->>'month')::date,'revision',(SELECT financial_revision::text FROM accounting.settings),'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',p.month,'is_locked',p.status='locked') ORDER BY p.month),'[]') FROM accounting.periods p WHERE p.month>=(context.params->>'month')::date),'snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'from_date',from_date,'to_date',to_date,'revision',financial_revision::text) ORDER BY created_at DESC),'[]') FROM accounting.report_snapshots WHERE to_date>=(context.params->>'month')::date));
 ELSIF view='cash-review' THEN
  SELECT jsonb_build_object('line_id',l.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'account_name',a.name,'amount_cents',l.amount_cents::text,'version',e.version,'status',e.status,
   'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('classification',c.classification,'amount_cents',c.amount_cents::text,'note',CASE WHEN l.cash_class IS NULL THEN 'Derived from counter-account' ELSE e.reason END)),'[]') FROM accounting.cash_lines(jsonb_build_object('from',e.entry_date,'to',e.entry_date,'mode','working')) c WHERE c.id=l.id)) INTO result
   FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.accounts a ON a.id=l.account_id WHERE l.id=(context.params->>'line')::uuid;
  IF result IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;RETURN result;
 ELSIF view='reconciliation' THEN
  key:=(context.params->>'id')::uuid;
  WITH records AS (SELECT r.*,b.account_id FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE (context.params->>'account' IS NULL OR b.account_id=(context.params->>'account')::uuid))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'statements',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) ORDER BY statement_end DESC),'[]')) INTO result FROM records r;
  SELECT to_jsonb(r)||jsonb_build_object('account_id',b.account_id,'from_date',statement_start,'to_date',statement_end,'opening_cents',opening_balance_cents::text,'ending_cents',ending_balance_cents::text,'difference_cents',difference_cents::text) INTO selected_record FROM accounting.reconciliations r JOIN accounting.bank_accounts b ON b.id=r.bank_account_id WHERE r.id=key;
  IF key IS NOT NULL AND selected_record IS NULL THEN RAISE EXCEPTION 'ACCT_NOT_FOUND';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'journal_line_id',i.journal_line_id,'entry_date',e.entry_date,'description',e.memo,'amount_cents',i.amount_cents::text) ORDER BY e.entry_date,i.id),'[]') INTO items FROM accounting.reconciliation_items i JOIN accounting.journal_lines l ON l.id=i.journal_line_id JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE i.reconciliation_id=key;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'entry_id',e.id,'entry_date',e.entry_date,'memo',e.memo,'amount_cents',l.amount_cents::text,'remaining_cents',(l.amount_cents-coalesce((SELECT sum(amount_cents) FROM accounting.reconciliation_items WHERE journal_line_id=l.id),0))::text) ORDER BY e.entry_date,l.id),'[]') INTO candidates FROM (SELECT l.* FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(selected_record->>'account_id',context.params->>'account')::uuid AND e.status='posted' AND (selected_record IS NULL OR e.entry_date<=(selected_record->>'statement_end')::date) ORDER BY e.entry_date,l.id LIMIT 100 OFFSET coalesce((context.params->>'offset')::int,0)) l JOIN accounting.journal_entries e ON e.id=l.entry_id;
  RETURN result||jsonb_build_object('statement',selected_record,'proof',CASE WHEN selected_record IS NULL THEN NULL ELSE jsonb_build_object('ready',(selected_record->>'difference_cents')::numeric=0,'statement_difference_cents',selected_record->>'difference_cents','item_count',jsonb_array_length(items)) END,'items',items,'item_count',jsonb_array_length(items),'lines',candidates,'line_count',(SELECT count(*) FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE l.account_id=coalesce(selected_record->>'account_id',context.params->>'account')::uuid AND e.status='posted' AND (selected_record IS NULL OR e.entry_date<=(selected_record->>'statement_end')::date)));
 ELSIF view='transfers' THEN
  WITH movements AS (SELECT e.transfer_group_id,e.id,e.entry_date,e.memo,e.version,l.amount_cents,a.name,
    EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) reversed
    FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.accounts a ON a.id=l.account_id WHERE e.status='posted' AND e.reverses_entry_id IS NULL AND e.transfer_group_id IS NOT NULL AND a.subtype IN ('bank','cash','card')),
  grouped AS (SELECT transfer_group_id id,max(version) version,CASE WHEN bool_or(reversed) THEN 'corrected' ELSE 'posted' END status,
   (array_agg(id ORDER BY entry_date,id) FILTER(WHERE amount_cents<0))[1] outgoing_entry_id,(array_agg(id ORDER BY entry_date,id) FILTER(WHERE amount_cents>0))[1] incoming_entry_id,
   min(entry_date) FILTER(WHERE amount_cents<0) outgoing_date,max(entry_date) FILTER(WHERE amount_cents>0) incoming_date,max(abs(amount_cents))::text amount_cents,min(memo) memo,
   max(name) FILTER(WHERE amount_cents<0) from_name,max(name) FILTER(WHERE amount_cents>0) to_name,
   min(entry_date) FILTER(WHERE amount_cents<0)<=(context.params->>'to')::date AND max(entry_date) FILTER(WHERE amount_cents>0)>(context.params->>'to')::date in_transit FROM movements GROUP BY transfer_group_id),
  scoped AS(SELECT * FROM grouped WHERE CASE WHEN context.params->>'id' IS NOT NULL THEN id=(context.params->>'id')::uuid ELSE outgoing_date<=(context.params->>'to')::date AND incoming_date>=(context.params->>'from')::date END),
  paged AS(SELECT * FROM scoped ORDER BY outgoing_date DESC,id LIMIT least(greatest(coalesce((context.params->>'limit')::int,100),1),200) OFFSET coalesce((context.params->>'offset')::int,0))
  SELECT jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'total',(SELECT count(*) FROM scoped),'groups',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY outgoing_date DESC,id),'[]') FROM paged p)) INTO result;RETURN result;
 ELSIF view='tax-history' THEN
  WITH scoped AS (SELECT a.id,a.at,a.reason,a.after FROM accounting.audit_log a
   WHERE a.table_name=CASE context.params->>'kind' WHEN 'mapping' THEN 'tax_mappings' WHEN 'adjustment' THEN 'tax_adjustments' WHEN 'basis' THEN 'tax_links' ELSE 'tax_mappings' END
    AND a.after IS NOT NULL
    AND (context.params->>'year' IS NULL OR (a.after->>'tax_year')::integer=(context.params->>'year')::integer)
    AND (context.params->>'key' IS NULL OR a.row_id=(context.params->>'key')::uuid OR a.after->>'account_id'=context.params->>'key' OR a.after->>'id'=context.params->>'key'))
  SELECT jsonb_build_object('count',(SELECT count(*) FROM scoped),'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',coalesce((s.after->>'version')::integer,1),'created_at',s.at,
    'reason',coalesce(nullif(s.reason,''),s.after->>'reason',s.after->>'notes',''),'concept',s.after->>'concept','amount_cents',s.after->>'amount_cents','effective_date',s.after->>'effective_date',
    'deductible_bps',(s.after->>'deductible_bps')::integer,'through_date',s.after->>'cutoff_date','document_id',s.after->>'document_id') ORDER BY s.at DESC),'[]')
   FROM (SELECT * FROM scoped ORDER BY at DESC LIMIT 50 OFFSET coalesce((context.params->>'offset')::integer,0)) s)) INTO result;RETURN result;
 END IF;
 RAISE EXCEPTION 'ACCT_INVALID_VIEW';
END $function$
;

CREATE OR REPLACE FUNCTION accounting.rules_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'priority',r.priority,'enabled',r.enabled,'auto_post',r.auto_post,'conditions',r.conditions,'actions',r.actions,'version',r.version,
  'review_status',r.review_status,'suggested_by',r.suggested_by,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=r.suggested_by)) ORDER BY r.priority,r.name,r.id),'[]'::jsonb) FROM accounting.rules r);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.attention(params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE zone text; today date; recon jsonb; info boolean; result jsonb;
BEGIN
 PERFORM accounting.require_reader();
 IF jsonb_typeof(params) IS DISTINCT FROM 'object' OR coalesce(params->>'include_info','true') NOT IN ('true','false') THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 info:=coalesce((params->>'include_info')::boolean,true);
 zone:=coalesce((SELECT books_timezone FROM public.business_profile WHERE id=1),'America/Phoenix');
 today:=(now() AT TIME ZONE zone)::date;
 recon:=accounting.reconciliation_status('{}'::jsonb);
 -- Each item's id is a hash of its kind and its subject, so the same issue keeps its id from one check to the next.
 -- Alerts are what justifies telling the owner now; info items are the standing backlog.
 WITH accounts AS (SELECT value AS r FROM jsonb_array_elements(recon->'accounts')),
 live AS (
  -- What the register lists: not discarded and not part of a reversed pair, with its one bank, card or cash line.
  SELECT e.id,e.entry_date,e.status,e.review_pending,e.memo,e.source_description,e.descriptor_key,e.transfer_group_id,e.created_at,m.bank_count,m.bank_amount,m.bank_account,m.debits,m.uncategorized,m.unbalanced
  FROM accounting.journal_entries e CROSS JOIN LATERAL (
   SELECT count(*) FILTER(WHERE a.subtype IN ('bank','card','cash')) AS bank_count,
    sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','card','cash')) AS bank_amount,
    (min(l.account_id::text) FILTER(WHERE a.subtype IN ('bank','card','cash')))::uuid AS bank_account,
    coalesce(sum(l.amount_cents) FILTER(WHERE l.amount_cents>0),0) AS debits,
    coalesce(bool_or(a.subtype='uncategorized' OR coalesce(a.system_purpose,'') IN ('uncategorized_income','uncategorized_expense')),false) AS uncategorized,
    count(*)<2 OR coalesce(sum(l.amount_cents),0)<>0 AS unbalanced
   FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
  WHERE e.status<>'discarded' AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id)
 ), waiting AS (
  SELECT w.*,CASE WHEN w.bank_count=1 THEN abs(w.bank_amount) ELSE w.debits END AS magnitude FROM live w WHERE w.status='draft' OR (w.status='posted' AND w.review_pending)
 ), items AS (
  -- The books and the bank disagree: an alert once it has lasted a day, info before that (often a sync in flight).
  SELECT 'recon_gap' AS kind,CASE WHEN (x.r->>'off_since')::timestamptz<now()-interval '24 hours' THEN 'alert' ELSE 'info' END AS severity,
   (x.r->'account'->>'id')||':'||coalesce(extract(epoch FROM (x.r->>'off_since')::timestamptz)::text,'') AS subject,
   (x.r->'account'->>'name')||' does not match the bank' AS title,
   'The bank reports '||accounting.usd_text((x.r->>'bank_cents')::numeric)||' and the books show '||accounting.usd_text((x.r->>'bank_cents')::numeric+(x.r->>'gap_cents')::numeric)
    ||' for the same day, a difference of '||accounting.usd_text(abs((x.r->>'gap_cents')::numeric))||'. A transaction the feed missed, or one recorded twice, can cause this.' AS detail,
   x.r->'off_since' AS since,(x.r->>'gap_cents')::numeric AS amount,'/accounting?view=accounts' AS link
  FROM accounts x WHERE x.r->>'gap_cents' IS NOT NULL AND (x.r->>'gap_cents')::numeric<>0
  UNION ALL
  -- A bank feed that is disconnected or has not synced for a day: new bank activity is not reaching the books.
  SELECT 'feed_down','alert',c.id::text||':'||coalesce(extract(epoch FROM c.last_success_at)::text,'never'),
   c.name||CASE WHEN c.status<>'active' THEN ' bank feed needs reconnecting' ELSE ' bank feed has not synced for over a day' END,
   'Last successful sync: '||coalesce(to_char(c.last_success_at AT TIME ZONE zone,'Mon FMDD, YYYY HH24:MI'),'never')
    ||CASE WHEN c.last_error<>'' THEN '. Last error: '||left(c.last_error,200) ELSE '' END||'. New bank transactions do not reach the books until it syncs.',
   to_jsonb(coalesce(c.last_success_at,c.created_at)),NULL::numeric,'/accounting?view=manage&section=feeds'
  FROM accounting.bank_connections c
  WHERE EXISTS(SELECT 1 FROM accounting.bank_accounts b WHERE b.connection_id=c.id AND NOT b.is_closed)
   AND (c.status<>'active' OR coalesce(c.last_success_at,c.created_at)<now()-interval '24 hours')
  UNION ALL
  -- One large transaction still waiting for review after two days.
  (SELECT 'large_unreviewed','alert',w.id::text,
   'Unreviewed '||accounting.usd_text(w.magnitude)||CASE WHEN w.uncategorized THEN ' uncategorized' ELSE '' END||' transaction',
   left(coalesce(nullif(w.source_description,''),w.memo),80)||', dated '||to_char(w.entry_date,'Mon FMDD, YYYY')||', waiting for review since '||to_char(w.created_at AT TIME ZONE zone,'Mon FMDD')||'.',
   to_jsonb(w.created_at),CASE WHEN w.bank_count=1 THEN w.bank_amount ELSE w.magnitude END,'/accounting?view=journal&entry='||w.id::text
  FROM waiting w WHERE w.magnitude>100000 AND w.created_at<now()-interval '2 days' ORDER BY w.magnitude DESC,w.id LIMIT 25)
  UNION ALL
  -- Two reviewed movements on the same account with the same amount and bank description, three days apart or less.
  (SELECT 'possible_duplicate','alert',x.id::text||':'||y.id::text,
   'Possible duplicate '||accounting.usd_text(abs(x.bank_amount))||' on '||a.name,
   'Two reviewed transactions with the same bank description ('||left(x.descriptor_key,60)||') and amount, dated '||to_char(x.entry_date,'Mon FMDD')||' and '||to_char(y.entry_date,'Mon FMDD, YYYY')||'.',
   to_jsonb(y.entry_date),x.bank_amount,'/accounting?view=journal&entry='||y.id::text
  FROM live x JOIN live y ON y.bank_account=x.bank_account AND y.bank_amount=x.bank_amount AND y.descriptor_key=x.descriptor_key AND y.id<>x.id
   AND (y.entry_date>x.entry_date OR (y.entry_date=x.entry_date AND y.id>x.id)) AND y.entry_date-x.entry_date<=3
   JOIN accounting.accounts a ON a.id=x.bank_account
  WHERE x.status='posted' AND y.status='posted' AND x.bank_count=1 AND y.bank_count=1 AND x.descriptor_key IS NOT NULL
   AND x.transfer_group_id IS NULL AND y.transfer_group_id IS NULL AND y.entry_date>=today-60
  ORDER BY y.entry_date DESC,x.id LIMIT 25)
  UNION ALL
  -- Drafts whose lines do not add up to zero: they stay out of every report until fixed.
  SELECT 'unbalanced_drafts','alert',string_agg(u.id::text,',' ORDER BY u.id),
   count(*)||CASE WHEN count(*)=1 THEN ' draft does not balance' ELSE ' drafts do not balance' END,
   'Their lines do not add up to zero, so they are left out of every report until fixed.',
   to_jsonb(min(u.created_at)),NULL::numeric,'/accounting?view=journal'
  FROM live u WHERE u.status='draft' AND u.unbalanced HAVING count(*)>0
  UNION ALL
  -- A closed month with bank activity the books never took in.
  SELECT 'closed_month_unmatched','alert',p.month::text,
   to_char(p.month,'FMMonth YYYY')||' is closed but has bank transactions not in the books',
   count(*)||' bank transaction(s), '||accounting.usd_text(sum(t.amount_cents))||' in total, arrived after the month was closed.',
   to_jsonb(p.month),sum(t.amount_cents)::numeric,'/accounting?view=close'
  FROM accounting.periods p JOIN accounting.bank_transactions t ON t.state='posted' AND t.review='unmatched' AND date_trunc('month',t.posted_date)::date=p.month
  WHERE p.status='locked' GROUP BY p.month
  UNION ALL
  SELECT 'review_backlog','info','all',
   count(*)||CASE WHEN count(*)=1 THEN ' transaction is' ELSE ' transactions are' END||' waiting for review',
   accounting.usd_text(sum(w.magnitude))||' in total; the oldest is dated '||to_char(min(w.entry_date),'Mon FMDD, YYYY')||'.',
   to_jsonb(min(w.entry_date)),sum(w.magnitude),'/accounting?view=journal'
  FROM waiting w HAVING count(*)>0
  UNION ALL
  SELECT 'suggested_contacts','info','all',
   count(*)||CASE WHEN count(*)=1 THEN ' suggested contact is' ELSE ' suggested contacts are' END||' waiting for approval',
   'Agents suggested them; the owner approves or merges them on the Contacts screen.',
   to_jsonb(min(p.created_at)),NULL::numeric,'/accounting?view=manage&section=payees'
  FROM accounting.parties p WHERE p.review_status='suggested' AND NOT p.is_archived HAVING count(*)>0
  UNION ALL
  SELECT 'suggested_rules','info','all',
   count(*)||CASE WHEN count(*)=1 THEN ' suggested rule is' ELSE ' suggested rules are' END||' waiting for approval',
   'Agents suggested them; the owner reviews and switches them on, or dismisses them, on the Rules screen.',
   to_jsonb(min(r.created_at)),NULL::numeric,'/accounting?view=manage&section=rules'
  FROM accounting.rules r WHERE r.review_status='suggested' HAVING count(*)>0
  UNION ALL
  SELECT 'uncategorized','info','all',
   count(DISTINCT u.id)||CASE WHEN count(DISTINCT u.id)=1 THEN ' transaction is' ELSE ' transactions are' END||' still uncategorized',
   accounting.usd_text(-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income'),0))||' money in and '||accounting.usd_text(coalesce(sum(l.amount_cents) FILTER(WHERE a.type<>'income'),0))||' money out are parked in Uncategorized.',
   to_jsonb(min(u.entry_date)),-coalesce(sum(l.amount_cents) FILTER(WHERE a.type='income'),0)+coalesce(sum(l.amount_cents) FILTER(WHERE a.type<>'income'),0),'/accounting?view=journal'
  FROM live u JOIN accounting.journal_lines l ON l.entry_id=u.id JOIN accounting.accounts a ON a.id=l.account_id
  WHERE u.uncategorized AND (a.subtype='uncategorized' OR coalesce(a.system_purpose,'') IN ('uncategorized_income','uncategorized_expense')) HAVING count(*)>0
 )
 SELECT jsonb_build_object('as_of',today,'checked_at',now(),'revision',(SELECT financial_revision::text FROM accounting.settings WHERE id=1),
  'alert',coalesce(bool_or(i.severity='alert'),false),
  'counts',jsonb_build_object('alert',count(*) FILTER(WHERE i.severity='alert'),'info',count(*) FILTER(WHERE i.severity='info')),
  'items',coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',left(md5(i.kind||':'||i.subject),16),'severity',i.severity,'kind',i.kind,'title',i.title,'detail',i.detail,
   'since',i.since,'amount_cents',i.amount::text,'link',i.link)) ORDER BY i.severity='info',i.kind,i.since::text,i.subject) FILTER(WHERE info OR i.severity='alert'),'[]'::jsonb)) INTO result FROM items i;
 RETURN result;
END $function$
;

-- 4. Rules agents already created become suggestions.
-- >>> rule suggestions backfill
SELECT set_config('accounting.action', 'rule.backfill', true);
SELECT set_config('accounting.reason', 'Rules agents created through the API become suggestions', true);
UPDATE accounting.rules r SET suggested_by = s.member,
  review_status = CASE WHEN r.enabled OR EXISTS (SELECT 1 FROM accounting.audit_log o
    WHERE o.table_name = 'rules' AND o.row_id = r.id AND o.id > s.audit_id AND o.actor_kind = 'owner' AND o.action IN ('rule.save', 'rule.activate'))
   THEN 'confirmed' ELSE 'suggested' END
FROM (
  SELECT DISTINCT ON (a.row_id) a.row_id, a.id AS audit_id, coalesce(k.team_member_id, m.id) AS member
  FROM accounting.audit_log a
  LEFT JOIN public.api_keys k ON k.id = a.api_key_id
  LEFT JOIN public.team_members m ON m.auth_user_id = a.actor_user_id
  WHERE a.table_name = 'rules' AND a.action = 'rule.save' AND a.before IS NULL AND a.actor_kind = 'api'
  ORDER BY a.row_id, a.id) s
WHERE r.id = s.row_id AND r.review_status = 'confirmed' AND r.suggested_by IS NULL;
-- <<< rule suggestions backfill

COMMIT;
