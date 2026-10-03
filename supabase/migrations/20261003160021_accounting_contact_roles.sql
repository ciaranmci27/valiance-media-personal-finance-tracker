-- Contacts with roles.
--
-- Every business transaction should say who was paid or who paid, so the
-- books can answer "what did we spend with contractors" or "which clients
-- paid us most". The contact table (accounting.parties, "Contacts" on the
-- Manage screen, "contacts" in the API) gains roles, contact details, a
-- review state for contacts an agent suggests, and a duplicate guard.
--
-- Roles replace kind (vendor, customer, both) and is_contractor. A contact
-- holds one or more of client, vendor, contractor, employee, government,
-- financial (a bank or financial company) and owner. Existing rows move
-- over: customer becomes client, vendor stays vendor, both becomes client
-- and vendor, and the contractor flag adds contractor. Then kind and
-- is_contractor are dropped so there is one truth; the 1099 worksheet
-- (contractor_report and the contractor support report) reads the
-- contractor role.
--
-- New columns: email, phone and website (optional, length checked);
-- review_status ('confirmed' for the owner's contacts, 'suggested' for one an
-- agent adds through the API, until the owner approves or edits it);
-- suggested_by (the agent's team member); and name_key, generated from the
-- name by accounting.contact_name_key: lowercase, & read as "and",
-- punctuation and extra spaces gone, trailing legal suffixes (inc, llc, ltd,
-- co, corp, corporation, company, pbc, plc, lp, llp) dropped. A unique
-- constraint on name_key replaces the one on name, so "GitHub", "Github,
-- Inc." and "GITHUB INC" are one contact. The migration stops before that
-- constraint if two existing contacts share a key, naming them, so they can
-- be merged or renamed first. journal_entries gains an index on payee_id for
-- merges and per-contact reads.
--
-- Owner commands (banking_command):
-- - party.save takes roles (required, each stored once) and the contact
--   details instead of kind and is_contractor. The owner's save confirms a
--   suggested contact; an API save keeps it a suggestion naming the agent.
-- - party.approve confirms suggested contacts by id.
-- - party.merge moves one contact into another: its live transactions, its
--   bank description aliases (patterns are unique across contacts, so none
--   can clash), its document links (a document already linked to both stays
--   as it is) and the rules that name it. The kept contact gains its roles
--   and fills blank details from it; the merged contact is archived.
--   Discarded transactions keep their contact, since they cannot change. A
--   transaction in a locked month refuses the merge (ACCT_PERIOD_LOCKED or
--   ACCT_LATER_PERIOD_LOCKED) until that month is reopened.
--
-- API (api_books_command): contact.create, contact.update and
-- contact.assign replace payee.create.
-- - contact.create adds a suggested contact. public.api_contact_check refuses
--   an exact name key match (API_CONTACT_DUPLICATE, with the existing
--   contact) and a whole-word containment either way, such as "Google" and
--   "Google Workspace" (API_CONTACT_POSSIBLE_DUPLICATE, with the
--   candidates), unless the call lists every candidate in not_duplicate_of.
-- - contact.update changes a contact only while it is still a suggestion.
-- - contact.assign fills a blank contact on up to 100 transactions, drafts
--   or posted, all or nothing: never a transfer, a discarded entry, an entry
--   that already has a contact, a stale version or a locked month. With
--   remember, each bank description in the set becomes a key alias for the
--   contact unless another contact already owns it.
-- The after-command audit check now also allows adding an alias, changing a
-- suggested contact through contact.update and, for contact.assign only,
-- entry updates whose one change is a blank payee_id becoming set. Anything
-- else still rolls back with API_DRAFTS_ONLY.
--
-- Readers restated: payees_list (roles, details, review state, suggester
-- and transaction count), context('manage') (the suggester's name),
-- transactions (payee filter 'unassigned' for no contact), entry_detail
-- (payee_name), contractor_report and support_report (the contractor role).

BEGIN;

-- 1. The name key: what makes two contact names the same contact.
CREATE OR REPLACE FUNCTION accounting.contact_name_key(value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v text := lower(btrim(value));
BEGIN
 IF v IS NULL THEN RETURN NULL; END IF;
 -- Case, punctuation and spacing never make a different contact: "GitHub", "Github, Inc." and "GITHUB INC" share one key.
 v:=btrim(regexp_replace(replace(v,'&',' and '),'[^a-z0-9]+',' ','g'));
 -- Legal suffixes at the end go, however many there are; a name that is only a suffix keeps it.
 v:=regexp_replace(v,'( (inc|llc|ltd|co|corp|corporation|company|pbc|plc|lp|llp))+$','');
 RETURN coalesce(nullif(v,''),lower(btrim(value)));
END $function$
;

REVOKE ALL ON FUNCTION accounting.contact_name_key(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION accounting.contact_name_key(text) TO "postgres";

-- 2. New contact columns, in the order the snapshot lists them.
ALTER TABLE accounting.parties
  ADD COLUMN roles text[],
  ADD COLUMN email text,
  ADD COLUMN phone text,
  ADD COLUMN website text,
  ADD COLUMN review_status text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN suggested_by uuid,
  ADD COLUMN name_key text GENERATED ALWAYS AS (accounting.contact_name_key(name)) STORED,
  ADD CONSTRAINT parties_email_check CHECK (email IS NULL OR (length(btrim(email)) >= 3 AND length(btrim(email)) <= 254 AND position('@' IN email) > 1)),
  ADD CONSTRAINT parties_phone_check CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 40),
  ADD CONSTRAINT parties_website_check CHECK (website IS NULL OR length(btrim(website)) BETWEEN 1 AND 300),
  ADD CONSTRAINT parties_review_status_check CHECK (review_status IN ('suggested', 'confirmed')),
  ADD CONSTRAINT parties_suggested_by_fkey FOREIGN KEY (suggested_by) REFERENCES public.team_members(id) ON DELETE SET NULL;

-- 3. Roles from the old kind and contractor flag, then the old columns go.
SELECT set_config('accounting.reason', 'Contact roles replace kind and the contractor flag', true);
UPDATE accounting.parties SET roles = ARRAY(
  SELECT known.r FROM unnest(ARRAY['client','vendor','contractor','employee','government','financial','owner']) WITH ORDINALITY AS known(r, n)
  WHERE (known.r = 'client' AND kind IN ('customer', 'both'))
     OR (known.r = 'vendor' AND kind IN ('vendor', 'both'))
     OR (known.r = 'contractor' AND is_contractor)
  ORDER BY known.n);
ALTER TABLE accounting.parties
  ALTER COLUMN roles SET NOT NULL,
  ADD CONSTRAINT parties_roles_check CHECK (roles <@ ARRAY['client','vendor','contractor','employee','government','financial','owner']::text[] AND cardinality(roles) >= 1);

-- Two existing contacts with one name key must be merged or renamed by hand first.
DO $do$
DECLARE clash text;
BEGIN
 SELECT string_agg(names, '; ') INTO clash FROM (
  SELECT string_agg(name, ', ' ORDER BY name) AS names FROM accounting.parties GROUP BY name_key HAVING count(*) > 1) d;
 IF clash IS NOT NULL THEN RAISE EXCEPTION 'Contacts share a name key; merge or rename them first: %', clash; END IF;
END $do$;

ALTER TABLE accounting.parties DROP CONSTRAINT parties_name_key;
ALTER TABLE accounting.parties ADD CONSTRAINT parties_name_key_unique UNIQUE (name_key);
ALTER TABLE accounting.parties DROP COLUMN kind, DROP COLUMN is_contractor;

CREATE INDEX entries_payee ON accounting.journal_entries USING btree (payee_id) WHERE (payee_id IS NOT NULL);

-- 4. Readers and commands restated in full.

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
   UPDATE accounting.rules SET enabled=(c->>'enabled')::boolean WHERE id=key RETURNING version INTO v;
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
   INSERT INTO accounting.rules(id,name,priority,enabled,conditions,actions,auto_post) VALUES(key,c->>'name',coalesce((c->>'priority')::integer,100),coalesce((c->>'enabled')::boolean,false),cond,actions,coalesce((c->>'auto_post')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,conditions=excluded.conditions,actions=excluded.actions,enabled=excluded.enabled,auto_post=excluded.auto_post RETURNING version INTO v;
  END IF;
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
   'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('tax_classification',CASE WHEN contractor_classification='unknown' THEN 'unreviewed' ELSE contractor_classification END,'documentation',documentation_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by)) ORDER BY p.name),'[]') FROM accounting.parties p),
   'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('month_start',month,'is_locked',status='locked')),'[]') FROM accounting.periods p),
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
  RETURN jsonb_build_object('revision',(SELECT financial_revision::text FROM accounting.settings),'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('description_mode',coalesce(r.conditions->>'description_mode',(SELECT d.key FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) d LIMIT 1)),'description',coalesce(r.conditions->>'description',(SELECT value#>>'{}' FROM jsonb_each(coalesce(r.conditions->'descriptor_key','{}')) LIMIT 1)),'bank_account_id',r.conditions->'bank_account_id','direction',r.conditions->'direction','min_cents',coalesce(r.conditions->>'amount_min','0'),'max_cents',coalesce(r.conditions->>'amount_max','9223372036854775807'),'match_payee_id',r.conditions->'payee_id','category_account_id',r.actions->'account_id','assign_payee_id',r.actions->'payee_id','reason','') ORDER BY priority,id),'[]') FROM accounting.rules r),'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('party_name',p.name,'match_mode',a.match_kind,'description',a.pattern) ORDER BY a.pattern),'[]') FROM accounting.payee_aliases a JOIN accounting.parties p ON p.id=a.party_id));
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

CREATE OR REPLACE FUNCTION accounting.contractor_report(year integer, cutoff date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE 'contractor'=ANY(p.roles) GROUP BY p.id) rows;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.support_report(params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE report_id text:=params->>'report_id';start_date date:=(params->>'from')::date;end_date date:=(params->>'to')::date;rows jsonb;columns jsonb;total_cells jsonb;source jsonb;controls jsonb;notes jsonb:='[]';result jsonb;offset_rows integer:=coalesce((params->>'offset')::integer,0);limit_rows integer:=coalesce((params->>'limit')::integer,100);row_count integer;
BEGIN
 PERFORM accounting.require_owner();
 PERFORM accounting.report_validate(params);
 IF start_date IS NULL OR end_date IS NULL OR start_date>end_date OR offset_rows<0 OR limit_rows NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'ACCT_REPORT_RANGE';END IF;
 IF report_id='payroll-register' THEN
  columns:='[{"label":"Pay date","numeric":false},{"label":"Provider run","numeric":false},{"label":"Gross wages","numeric":true},{"label":"Employee withholding","numeric":true},{"label":"Employer taxes","numeric":true},{"label":"Net pay","numeric":true}]';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'run_id',p.id,'cells',jsonb_build_array(p.pay_date,p.provider_run_id,p.gross_cents::text,p.employee_withholding_cents::text,p.employer_tax_cents::text,p.net_cents::text)) ORDER BY pay_date,id),'[]'),
   jsonb_build_array('Total','',coalesce(sum(gross_cents),0)::text,coalesce(sum(employee_withholding_cents),0)::text,coalesce(sum(employer_tax_cents),0)::text,coalesce(sum(net_cents),0)::text) INTO rows,total_cells
  FROM accounting.payroll_runs p WHERE p.pay_date BETWEEN start_date AND end_date AND p.entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=p.entry_id AND re.status='posted' AND re.entry_date<=end_date);
  notes:=jsonb_build_array('Includes posted runs not reversed by the selected cutoff. A later void does not remove a run from an earlier report.');
 ELSIF report_id IN ('asset-register','loan-register') THEN
  columns:=CASE report_id WHEN 'asset-register' THEN '[{"label":"Asset","numeric":false},{"label":"Acquired","numeric":false},{"label":"Recorded cost","numeric":true},{"label":"Accumulated depreciation","numeric":true},{"label":"Carrying value","numeric":true}]'::jsonb ELSE '[{"label":"Loan","numeric":false},{"label":"Originated","numeric":false},{"label":"Principal balance","numeric":true}]'::jsonb END;
  WITH balances AS (
   SELECT r.id,r.kind,r.name,r.started_on,r.account_id,r.contra_account_id,coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=r.account_id),0) cost,-coalesce(sum(l.amount_cents) FILTER(WHERE l.account_id=r.contra_account_id),0) depreciation
   FROM accounting.registers r LEFT JOIN accounting.journal_entries e ON e.register_id=r.id AND e.status='posted' AND e.entry_date<=end_date LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id
   WHERE r.started_on<=end_date AND r.kind=CASE report_id WHEN 'asset-register' THEN 'fixed_asset' ELSE 'loan' END GROUP BY r.id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'register_id',id,'register_kind',CASE kind WHEN 'fixed_asset' THEN 'asset' ELSE 'loan' END,'cells',CASE kind WHEN 'fixed_asset' THEN jsonb_build_array(name,started_on,cost::text,depreciation::text,(cost-depreciation)::text) ELSE jsonb_build_array(name,started_on,(-cost)::text) END) ORDER BY name,id),'[]'),
  CASE report_id WHEN 'asset-register' THEN jsonb_build_array('Total','',coalesce(sum(cost),0)::text,coalesce(sum(depreciation),0)::text,coalesce(sum(cost-depreciation),0)::text) ELSE jsonb_build_array('Total','',(-coalesce(sum(cost),0))::text) END INTO rows,total_cells FROM balances;
  WITH scoped AS (
   SELECT l.account_id,sum(l.amount_cents) register_amount FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id JOIN accounting.registers r ON r.id=e.register_id AND l.account_id IN(r.account_id,r.contra_account_id)
   WHERE e.status='posted' AND e.entry_date<=end_date AND r.kind=CASE report_id WHEN 'asset-register' THEN 'fixed_asset' ELSE 'loan' END GROUP BY l.account_id
  ), balances AS (
   SELECT a.id,a.name,coalesce(s.register_amount,0) register_amount,coalesce(sum(l.amount_cents) FILTER(WHERE e.id IS NOT NULL),0) book_amount
   FROM accounting.accounts a LEFT JOIN scoped s ON s.account_id=a.id LEFT JOIN accounting.journal_lines l ON l.account_id=a.id LEFT JOIN accounting.journal_entries e ON e.id=l.entry_id AND e.status='posted' AND e.entry_date<=end_date
   WHERE a.subtype=CASE report_id WHEN 'asset-register' THEN 'fixed_asset' ELSE 'loan' END OR (report_id='asset-register' AND a.subtype='accumulated_depreciation') GROUP BY a.id,s.register_amount)
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('account_id',id,'name',name,'register_cents',register_amount::text,'book_cents',book_amount::text,'difference_cents',(book_amount-register_amount)::text) ORDER BY name,id),'[]'),'ready',coalesce(bool_and(register_amount=book_amount),true),'missing_documents',0) INTO controls FROM balances;
  notes:=jsonb_build_array('Balances include actual posted movements through the cutoff. Proposed schedule rows do not change the ledger.');
 ELSIF report_id='contractor-worksheet' THEN
  IF extract(year FROM start_date)<>extract(year FROM end_date) THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
  source:=accounting.contractor_report(extract(year FROM end_date)::integer);
  columns:='[{"label":"Payee","numeric":false},{"label":"Classification","numeric":false},{"label":"Documentation","numeric":false},{"label":"Cash paid net of refunds","numeric":true},{"label":"Card payments excluded","numeric":true}]';
  WITH paid AS (
   SELECT p.id,p.name,p.contractor_classification,p.documentation_status,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash')),0) cash,-coalesce(sum(l.amount_cents) FILTER(WHERE a.subtype='card'),0) card
   FROM accounting.parties p LEFT JOIN accounting.journal_entries e ON e.payee_id=p.id AND e.status='posted' AND e.entry_date BETWEEN start_date AND end_date LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id LEFT JOIN accounting.accounts a ON a.id=l.account_id WHERE 'contractor'=ANY(p.roles) GROUP BY p.id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'contractor_party_id',id,'cells',jsonb_build_array(name,contractor_classification,documentation_status,cash::text,card::text)) ORDER BY name,id),'[]'),jsonb_build_array('Total','','',coalesce(sum(cash),0)::text,coalesce(sum(card),0)::text) INTO rows,total_cells FROM paid;
  notes:=jsonb_build_array('Annual reporting threshold in cents: '||(source->>'threshold_cents')||'. Owner classifications and exclusions require review; this worksheet does not file a return.');
 ELSIF report_id='tax-workpapers' THEN
  IF start_date<>make_date(extract(year FROM end_date)::integer,1,1) THEN RAISE EXCEPTION 'ACCT_TAX_RANGE';END IF;
  source:=accounting.tax_source(extract(year FROM end_date)::integer,end_date);
  columns:='[{"label":"Account or adjustment","numeric":false},{"label":"Treatment","numeric":false},{"label":"Book profit contribution","numeric":true},{"label":"Ordinary taxable contribution","numeric":true},{"label":"Book-to-tax difference","numeric":true}]';
  SELECT coalesce(jsonb_agg(row ORDER BY label,id),'[]') INTO rows FROM (
   SELECT value->>'name' label,value->>'account_id' id,jsonb_build_object('id',value->'account_id','tax_kind','account','tax_account_id',value->'account_id','cells',jsonb_build_array(value->>'name',coalesce(value->'mapping'->>'concept','Unmapped'),value->>'book_cents',value->>'ordinary_cents',((value->>'ordinary_cents')::numeric-(value->>'book_cents')::numeric)::text)) row FROM jsonb_array_elements(source->'accounts') WHERE (value->>'line_count')::integer>0
   UNION ALL SELECT value->>'reason',value->>'id',jsonb_build_object('id',value->'id','tax_kind','adjustment','cells',jsonb_build_array(value->>'reason',value->>'concept','0',CASE WHEN value->>'concept' IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') THEN '0' ELSE value->>'amount_cents' END,CASE WHEN value->>'concept' IN ('stock_basis_opening','debt_basis_opening','interest','qualified_dividend','short_gain','long_gain','charity','tax_exempt') THEN '0' ELSE value->>'amount_cents' END)) FROM jsonb_array_elements(source->'adjustments')) q;
  total_cells:=jsonb_build_array('Total','',source->>'book_profit_cents',source->>'adjusted_ordinary_cents',source->>'book_to_tax_cents');
  notes:=jsonb_build_array('Tax workpapers use year-to-date posted activity through the cutoff. Separately stated items and basis amounts are retained in the attached tax source.');
 ELSE RAISE EXCEPTION 'ACCT_REPORT_KIND';END IF;
 row_count:=jsonb_array_length(rows);
 result:=jsonb_build_object('definition_version',1,'report_id',report_id,'legal_name',(SELECT legal_name FROM public.business_profile WHERE id=1),'revision',(SELECT financial_revision::text FROM accounting.settings),'filter',params- 'limit','columns',columns,
 'rows',(SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality>offset_rows AND ordinality<=offset_rows+limit_rows),'count',row_count,'total_cells',total_cells,'notes',notes);
 IF controls IS NOT NULL THEN result:=result||jsonb_build_object('controls',controls);END IF;
 IF report_id='tax-workpapers' THEN result:=result||jsonb_build_object('tax_workpaper',source);END IF;
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION accounting.payees_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM accounting.require_reader();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'roles',to_jsonb(p.roles),'email',p.email,'phone',p.phone,'website',p.website,'notes',p.notes,
  'default_account_id',p.default_account_id,'review_status',p.review_status,'suggested_by_name',(SELECT m.name FROM public.team_members m WHERE m.id=p.suggested_by),
  'is_archived',p.is_archived,'version',p.version,'transaction_count',(SELECT count(*) FROM accounting.journal_entries e WHERE e.payee_id=p.id AND e.status<>'discarded')) ORDER BY lower(p.name),p.id),'[]'::jsonb) FROM accounting.parties p);
END $function$
;

CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc'); q text:=nullif(btrim(coalesce(f->>'query','')),'');
BEGIN
 PERFORM accounting.require_reader();
 IF start_at<0 OR page_size NOT BETWEEN 1 AND 100 OR sort_by NOT IN ('date_desc','date_asc','amount_desc','amount_asc','description') OR coalesce(f->>'status','all') NOT IN ('all','draft','posted','discarded','reversed') OR (f->>'review' IS NOT NULL AND f->>'review' NOT IN ('needs_review','reviewed')) OR (f->>'from')::date>(f->>'to')::date THEN RAISE EXCEPTION 'ACCT_INVALID_FILTER'; END IF;
 WITH terms AS MATERIALIZED (SELECT kind,pattern,cents,op FROM accounting.search_terms(q)),
 candidates AS (
 SELECT e.*,CASE WHEN f->>'account' IS NOT NULL THEN abs(coalesce(m.selected_amount,0)) WHEN m.bank_count=1 THEN abs(m.bank_amount) ELSE coalesce(m.debits,0) END magnitude,m.amounts,
 CASE WHEN q IS NULL THEN NULL ELSE lower(concat_ws(' ',e.memo,e.source_description,e.kind,to_char(e.entry_date,'YYYY-MM-DD'),to_char(e.entry_date,'Mon FMDD, YYYY'),to_char(e.entry_date,'FMMonth FMDD, YYYY'),to_char(e.entry_date,'FMMM/FMDD/YYYY'),
  (SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),m.labels,
  (SELECT string_agg(bt.description,' ') FROM accounting.bank_matches bm JOIN accounting.journal_lines bl ON bl.id=bm.journal_line_id JOIN accounting.bank_transactions bt ON bt.id=bm.bank_transaction_id WHERE bl.entry_id=e.id))) END document
 FROM accounting.journal_entries e CROSS JOIN LATERAL (
 SELECT sum(l.amount_cents) FILTER(WHERE l.account_id=(f->>'account')::uuid) selected_amount,
  count(*) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_count,sum(l.amount_cents) FILTER(WHERE a.subtype IN ('bank','cash','card')) bank_amount,
  sum(l.amount_cents) FILTER(WHERE l.amount_cents>0) debits,array_agg(abs(l.amount_cents)) amounts,
  CASE WHEN q IS NULL THEN NULL ELSE string_agg(concat_ws(' ',a.code,a.name,l.memo,to_char(abs(l.amount_cents)/100.0,'FM999999999999990.00'),to_char(abs(l.amount_cents)/100.0,'FM999,999,999,999,990.00'),
   (SELECT string_agg(concat_ws(' ',b.institution,b.mask),' ') FROM accounting.bank_accounts b WHERE b.account_id=a.id)),' ') END labels
  FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) m
 ), matches AS (
 SELECT e.* FROM candidates e WHERE (f->>'from' IS NULL OR e.entry_date>=(f->>'from')::date) AND (f->>'to' IS NULL OR e.entry_date<=(f->>'to')::date)
 AND (f->>'entry_id' IS NOT NULL OR CASE WHEN f->>'status'='reversed' THEN e.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) ELSE e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id) END)
 AND (CASE WHEN coalesce(f->>'status','all')='all' THEN (e.status<>'discarded' OR f->>'entry_id' IS NOT NULL) WHEN f->>'status'='reversed' THEN e.status='posted' ELSE e.status=f->>'status' END)
 AND (f->>'review' IS NULL OR CASE WHEN f->>'review'='reviewed' THEN e.status='posted' AND NOT e.review_pending ELSE e.status='draft' OR (e.status='posted' AND e.review_pending) END)
 AND (f->>'entry_id' IS NULL OR e.id=(f->>'entry_id')::uuid)
 AND (f->>'account' IS NULL OR EXISTS(SELECT 1 FROM accounting.journal_lines WHERE entry_id=e.id AND account_id=(f->>'account')::uuid))
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR (f->>'payee'='unassigned' AND e.payee_id IS NULL) OR e.payee_id::text=f->>'payee')
 AND (NOT coalesce((f->>'missing_receipt')::boolean,false) OR NOT EXISTS(SELECT 1 FROM accounting.document_links dl JOIN accounting.documents d ON d.id=dl.document_id WHERE dl.entry_id=e.id AND d.status<>'archived' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='accounting-private' AND o.name=d.storage_path)))
 AND (f->>'descriptor_key' IS NULL OR e.descriptor_key=f->>'descriptor_key')
 AND (q IS NULL OR (SELECT coalesce(bool_and(coalesce(CASE t.kind
  WHEN 'compare' THEN CASE t.op WHEN '>' THEN e.magnitude>t.cents WHEN '>=' THEN e.magnitude>=t.cents WHEN '<' THEN e.magnitude<t.cents ELSE e.magnitude<=t.cents END
  WHEN 'amount' THEN t.cents=ANY(e.amounts) OR t.cents=e.magnitude OR e.document ~ t.pattern
  WHEN 'dollars' THEN EXISTS(SELECT 1 FROM unnest(e.amounts||e.magnitude) v WHERE v/100=t.cents/100) OR e.document ~ t.pattern
  ELSE e.document LIKE '%'||t.pattern||'%' END,false)),true) FROM terms t))
 AND (f->>'min_cents' IS NULL OR e.magnitude>=(f->>'min_cents')::bigint) AND (f->>'max_cents' IS NULL OR e.magnitude<=(f->>'max_cents')::bigint)
 ), ordered AS (
 SELECT *,row_number() OVER(ORDER BY CASE WHEN sort_by='date_asc' THEN entry_date END ASC,CASE WHEN sort_by='date_desc' THEN entry_date END DESC,
 CASE WHEN sort_by='amount_asc' THEN magnitude END ASC,CASE WHEN sort_by='amount_desc' THEN magnitude END DESC,
 CASE WHEN sort_by='description' THEN memo END ASC,id ASC) ordinal FROM matches
 ), selected AS (SELECT * FROM ordered ORDER BY ordinal OFFSET start_at LIMIT page_size)
 SELECT jsonb_build_object('entries',coalesce((SELECT jsonb_agg(accounting.entry_detail(id) ORDER BY ordinal) FROM selected),'[]'),
 'total',(SELECT count(*) FROM matches),'offset',start_at,'limit',page_size,'needs_review_count',(SELECT count(*) FROM accounting.journal_entries e WHERE (status='draft' OR (status='posted' AND review_pending)) AND e.reverses_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id=e.id))) INTO result;
 RETURN result;
END $function$
;

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
  'payroll_run_id',(SELECT id FROM accounting.payroll_runs WHERE entry_id=e.id AND status='posted'),
  'restore_workflow',CASE WHEN e.transfer_group_id IS NOT NULL THEN 'transfer' WHEN e.register_id IS NOT NULL THEN 'register' WHEN EXISTS(SELECT 1 FROM accounting.payroll_runs p WHERE p.entry_id=e.id OR (p.ytd->'patriot_import'->>'original_entry_id'=e.id::text AND p.ytd->'patriot_import'->>'journal_mode'='created')) THEN 'payroll' ELSE NULL END,
  -- The own account on the other side of a linked transfer, so either leg can name where the money went or came from.
  'transfer_account_id',CASE WHEN e.transfer_group_id IS NOT NULL THEN (SELECT l.account_id FROM accounting.journal_entries g JOIN accounting.journal_lines l ON l.entry_id=g.id JOIN accounting.accounts a ON a.id=l.account_id
   WHERE g.transfer_group_id=e.transfer_group_id AND g.id<>e.id AND g.reverses_entry_id IS NULL AND a.subtype IN ('bank','card','cash') ORDER BY g.entry_date,l.sort_order LIMIT 1) END,
  'payee_name',(SELECT p.name FROM accounting.parties p WHERE p.id=e.payee_id),
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
 RETURN result;
END $function$
;

-- The duplicate guard for contacts the API adds or renames. The same name key
-- (case, punctuation and legal suffixes ignored) is the same contact, archived
-- or not: API_CONTACT_DUPLICATE names it so the caller uses that one. A key
-- that holds the other as whole words ("Google" and "Google Workspace") may
-- be the same: API_CONTACT_POSSIBLE_DUPLICATE lists the candidates, unless the
-- call names every one of them in not_duplicate_of after looking at them.
-- The details ride in the message as JSON after the code.
CREATE OR REPLACE FUNCTION public.api_contact_check(p_name text, p_self uuid, p_not_duplicate_of jsonb) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE nk text := accounting.contact_name_key(p_name); existing jsonb; candidates jsonb; cleared jsonb := CASE WHEN jsonb_typeof(p_not_duplicate_of) = 'array' THEN p_not_duplicate_of ELSE '[]'::jsonb END;
BEGIN
 IF nk IS NULL THEN RETURN; END IF;
 SELECT jsonb_build_object('id', p.id, 'name', p.name, 'roles', to_jsonb(p.roles), 'review_status', p.review_status, 'is_archived', p.is_archived) INTO existing
  FROM accounting.parties p WHERE p.name_key = nk AND p.id IS DISTINCT FROM p_self;
 IF existing IS NOT NULL THEN RAISE EXCEPTION 'API_CONTACT_DUPLICATE %', jsonb_build_object('existing', existing); END IF;
 IF length(nk) < 3 THEN RETURN; END IF;
 SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'roles', to_jsonb(p.roles), 'review_status', p.review_status, 'is_archived', p.is_archived) ORDER BY p.name, p.id) INTO candidates
  FROM accounting.parties p
  WHERE p.id IS DISTINCT FROM p_self AND length(p.name_key) >= 3
   AND (position(' ' || nk || ' ' IN ' ' || p.name_key || ' ') > 0 OR position(' ' || p.name_key || ' ' IN ' ' || nk || ' ') > 0);
 IF candidates IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(candidates) AS c(candidate)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(cleared) AS s(value) WHERE lower(s.value) = c.candidate->>'id')) THEN
  RAISE EXCEPTION 'API_CONTACT_POSSIBLE_DUPLICATE %', jsonb_build_object('candidates', candidates);
 END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.api_contact_check(text, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Books writes from the API, drafts only. Each operation builds its command
-- from scratch (nothing the caller sends is forwarded as is) and runs it
-- through accounting.operate as the key's member, so every books rule,
-- version check and receipt applies. Rules made here are always disabled:
-- the owner switches them on, so an agent cannot steer imports or outrank the
-- owner's rules. Contacts made here are suggestions the owner approves, and
-- only a suggestion can change. Assigning a contact fills a blank contact on
-- a transaction, posted or not, in an open month, and touches nothing else.
-- Then, independently of the allowlist, the command's own audit rows are
-- checked: if anything left draft, a posted entry changed beyond that blank
-- contact, a rule could auto-post or run, a period left open, an existing
-- rule, alias or confirmed contact was changed, the whole command rolls back
-- with API_DRAFTS_ONLY.
CREATE OR REPLACE FUNCTION public.api_books_command(p_key_hash text, p_operation text, p_key uuid, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
 a jsonb := coalesce(p_args, '{}'::jsonb);
 kinds text[] := ARRAY['manual', 'income', 'expense', 'refund', 'owner', 'loan', 'asset'];
 keys uuid[] := ARRAY[]::uuid[];
 cmd jsonb; result jsonb; results jsonb := '[]'::jsonb; item jsonb; i integer := 0; k uuid; bad text;
 current_status text; current_kind text; current_payee uuid; cash_sign integer;
 lines jsonb; splits jsonb; conditions jsonb; actions jsonb; matcher text;
 -- Records, not table row types: this block is created before the accounting schema.
 contact record; contact_id uuid; e record; descriptor text; alias_owner jsonb;
 remembered jsonb := '[]'::jsonb; already jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN ('draft.create', 'draft.update', 'categorize', 'split', 'categorize.bulk', 'rule.create', 'contact.create', 'contact.update', 'contact.assign') THEN
  RAISE EXCEPTION 'API_COMMAND_NOT_ALLOWED';
 END IF;
 IF p_key IS NULL THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
 PERFORM public.api_act(p_key_hash, 'accounting.draft');
 PERFORM set_config('api.command', 'drafts', true);
 IF a ? 'lines' THEN
  SELECT jsonb_agg(jsonb_build_object('account_id', l->>'account_id', 'amount_cents', l->>'amount_cents', 'memo', coalesce(l->>'memo', '')) ORDER BY n)
   INTO lines FROM jsonb_array_elements(a->'lines') WITH ORDINALITY AS t(l, n);
 END IF;

 IF p_operation IN ('draft.create', 'draft.update') THEN
  IF a ? 'kind' AND jsonb_typeof(a->'kind') <> 'null' AND NOT ((a->>'kind') = ANY (kinds)) THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  IF p_operation = 'draft.update' THEN
   SELECT status, kind, payee_id INTO current_status, current_kind, current_payee FROM accounting.journal_entries WHERE id = (a->>'id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF current_status <> 'draft' THEN RAISE EXCEPTION 'ACCT_POSTED_IMMUTABLE'; END IF;
   -- A bank or card transaction is categorized or split, never rewritten.
   IF EXISTS (SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts acc ON acc.id = l.account_id
      WHERE l.entry_id = (a->>'id')::uuid AND acc.subtype IN ('bank', 'card', 'cash')) THEN RAISE EXCEPTION 'API_DRAFTS_NO_CASH'; END IF;
  END IF;
  -- Journal entries from the API are adjustments. Bank, card and cash
  -- movements come only from the feeds and imports.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(lines, '[]'::jsonb)) AS t(l) JOIN accounting.accounts acc ON acc.id = (l->>'account_id')::uuid
     WHERE acc.subtype IN ('bank', 'card', 'cash')) THEN RAISE EXCEPTION 'API_DRAFTS_NO_CASH'; END IF;
  -- An update keeps the kind and payee the caller leaves out.
  cmd := jsonb_build_object('type', 'draft.save',
   'id', CASE WHEN p_operation = 'draft.create' THEN md5('draft:' || p_key::text)::uuid ELSE (a->>'id')::uuid END,
   'expected_version', CASE WHEN p_operation = 'draft.create' THEN 0 ELSE (a->>'expected_version')::integer END,
   'entry_date', a->>'entry_date', 'memo', a->>'memo', 'lines', coalesce(lines, '[]'::jsonb),
   'kind', CASE WHEN a ? 'kind' AND jsonb_typeof(a->'kind') <> 'null' THEN a->>'kind' ELSE coalesce(current_kind, 'manual') END,
   'payee_id', CASE WHEN a ? 'payee_id' THEN a->'payee_id' ELSE to_jsonb(current_payee) END);
  IF p_operation = 'draft.create' THEN cmd := cmd || jsonb_build_object('origin', 'manual'); END IF;
 ELSIF p_operation = 'categorize' THEN
  PERFORM public.api_books_ref('category', a->>'account_id');
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  -- The category sets the kind, as the Transactions screen does.
  cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.categorize', 'id', (a->>'id')::uuid,
   'expected_version', (a->>'expected_version')::integer, 'account_id', (a->>'account_id')::uuid,
   'kind', public.api_category_kind((a->>'id')::uuid, (a->>'account_id')::uuid),
   'payee_id', a->'payee_id', 'memo', a->'memo')) || jsonb_build_object('remember', false);
 ELSIF p_operation = 'split' THEN
  IF a ? 'payee_id' THEN PERFORM public.api_books_ref('payee', a->>'payee_id'); END IF;
  -- Callers send amounts as positive cents. Category lines take the opposite
  -- sign of the bank line, so a deposit's amounts are flipped here.
  SELECT sign(sum(l.amount_cents)) INTO cash_sign FROM accounting.journal_lines l JOIN accounting.accounts acc ON acc.id = l.account_id
   WHERE l.entry_id = (a->>'id')::uuid AND acc.subtype IN ('bank', 'card', 'cash');
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('account_id', public.api_books_ref('category', s->>'account_id'),
    'amount_cents', CASE WHEN s ? 'amount_cents' AND coalesce(cash_sign, 0) > 0 THEN to_jsonb((-((s->>'amount_cents')::bigint))::text) ELSE s->'amount_cents' END,
    'share_bps', s->'share_bps')) ORDER BY n)
   INTO splits FROM jsonb_array_elements(a->'splits') WITH ORDINALITY AS t(s, n);
  cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.split', 'id', (a->>'id')::uuid,
   'expected_version', (a->>'expected_version')::integer, 'splits', splits, 'payee_id', a->'payee_id', 'memo', a->'memo'));
 ELSIF p_operation = 'rule.create' THEN
  -- Conditions and actions are rebuilt from the allowed fields, and every
  -- account and payee they name must exist and fit.
  IF jsonb_typeof(a->'conditions') <> 'object' OR jsonb_typeof(a->'actions') <> 'object'
     OR jsonb_typeof(a->'conditions'->'descriptor_key') <> 'object' THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  SELECT key INTO matcher FROM jsonb_object_keys(a->'conditions'->'descriptor_key') AS key LIMIT 1;
  IF matcher IS NULL OR matcher NOT IN ('equals', 'prefix', 'contains')
     OR (SELECT count(*) FROM jsonb_object_keys(a->'conditions'->'descriptor_key')) <> 1
     OR length(btrim(coalesce(a->'conditions'->'descriptor_key'->>matcher, ''))) = 0 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  conditions := jsonb_strip_nulls(jsonb_build_object(
   'descriptor_key', jsonb_build_object(matcher, btrim(a->'conditions'->'descriptor_key'->>matcher)),
   'bank_account_id', public.api_books_ref('bank', a->'conditions'->>'bank_account_id'),
   'direction', a->'conditions'->>'direction',
   'amount_min', a->'conditions'->>'amount_min',
   'amount_max', a->'conditions'->>'amount_max',
   'payee_id', public.api_books_ref('payee', a->'conditions'->>'payee_id')));
  IF a->'actions' ? 'splits' THEN
   SELECT jsonb_agg(jsonb_build_object('account_id', public.api_books_ref('category', s->>'account_id'), 'share_bps', (s->>'share_bps')::integer) ORDER BY n)
    INTO splits FROM jsonb_array_elements(a->'actions'->'splits') WITH ORDINALITY AS t(s, n);
   actions := jsonb_build_object('splits', coalesce(splits, '[]'::jsonb));
  ELSE
   actions := jsonb_build_object('account_id', public.api_books_ref('category', a->'actions'->>'account_id'));
  END IF;
  actions := actions || jsonb_strip_nulls(jsonb_build_object(
   'payee_id', public.api_books_ref('payee', a->'actions'->>'payee_id'), 'memo', a->'actions'->>'memo'));
  cmd := jsonb_build_object('type', 'rule.save', 'id', md5('rule:' || p_key::text)::uuid, 'expected_version', 0,
   'reason', coalesce(nullif(a->>'reason', ''), 'Created through the API'), 'name', a->>'name',
   'priority', coalesce((a->>'priority')::integer, 100), 'enabled', false,
   'auto_post', false, 'conditions', conditions, 'actions', actions);
 ELSIF p_operation = 'contact.create' THEN
  -- A retry of a create that already ran replays its receipt in operate, so
  -- the duplicate guard only looks at a new request.
  IF NOT EXISTS (SELECT 1 FROM accounting.command_receipts WHERE idempotency_key = p_key) THEN
   PERFORM public.api_contact_check(a->>'name', NULL, a->'not_duplicate_of');
  END IF;
  cmd := jsonb_build_object('type', 'party.save', 'id', md5('contact:' || p_key::text)::uuid, 'expected_version', 0,
   'name', a->>'name', 'roles', a->'roles', 'email', a->>'email', 'phone', a->>'phone', 'website', a->>'website',
   'default_account_id', public.api_books_ref('category', a->>'default_account_id'),
   'notes', coalesce(a->>'notes', ''), 'is_archived', false);
 ELSIF p_operation = 'contact.update' THEN
  SELECT * INTO contact FROM accounting.parties WHERE id = (a->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
  -- Once the owner confirms a contact it is theirs.
  IF contact.review_status <> 'suggested' THEN RAISE EXCEPTION 'API_CONTACT_CONFIRMED'; END IF;
  IF a ? 'name' THEN PERFORM public.api_contact_check(a->>'name', contact.id, a->'not_duplicate_of'); END IF;
  -- An update keeps every field the caller leaves out, and the owner's contractor details.
  cmd := jsonb_build_object('type', 'party.save', 'id', contact.id, 'expected_version', (a->>'expected_version')::integer,
   'name', coalesce(a->>'name', contact.name), 'roles', coalesce(a->'roles', to_jsonb(contact.roles)),
   'email', CASE WHEN a ? 'email' THEN a->>'email' ELSE contact.email END,
   'phone', CASE WHEN a ? 'phone' THEN a->>'phone' ELSE contact.phone END,
   'website', CASE WHEN a ? 'website' THEN a->>'website' ELSE contact.website END,
   'notes', CASE WHEN a ? 'notes' THEN coalesce(a->>'notes', '') ELSE contact.notes END,
   'default_account_id', CASE WHEN a ? 'default_account_id' THEN public.api_books_ref('category', a->>'default_account_id') ELSE contact.default_account_id END,
   'contractor_classification', contact.contractor_classification, 'documentation_status', contact.documentation_status,
   'is_archived', contact.is_archived);
 ELSIF p_operation = 'contact.assign' THEN
  contact_id := public.api_books_ref('payee', a->>'contact_id');
  IF contact_id IS NULL OR jsonb_typeof(a->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'entries') NOT BETWEEN 1 AND 100
     OR (SELECT count(DISTINCT lower(value->>'id')) FROM jsonb_array_elements(a->'entries')) <> jsonb_array_length(a->'entries') THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  -- All or nothing: the first entry that does not fit refuses the whole call.
  FOR item IN SELECT value FROM jsonb_array_elements(a->'entries') LOOP
   i := i + 1;
   SELECT * INTO e FROM accounting.journal_entries WHERE id = (item->>'id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACCT_NOT_FOUND'; END IF;
   IF e.status = 'discarded' THEN RAISE EXCEPTION 'ACCT_DISCARDED'; END IF;
   -- Money between the business's own accounts has no contact.
   IF e.transfer_group_id IS NOT NULL OR e.pair_entry_id IS NOT NULL OR e.kind = 'transfer' THEN
    RAISE EXCEPTION 'API_CONTACT_TRANSFER %', jsonb_build_object('entry_id', e.id);
   END IF;
   -- Only a blank contact is filled; one already chosen stays the owner's call.
   IF e.payee_id IS NOT NULL THEN
    RAISE EXCEPTION 'API_CONTACT_ALREADY_SET %', jsonb_build_object('entry_id', e.id,
     'contact', (SELECT jsonb_build_object('id', p.id, 'name', p.name) FROM accounting.parties p WHERE p.id = e.payee_id));
   END IF;
   IF (item->>'expected_version')::integer IS DISTINCT FROM e.version THEN RAISE EXCEPTION 'ACCT_STALE_VERSION'; END IF;
   -- A posted entry changes no lock of its own here, so the closed months are checked first.
   PERFORM accounting.require_open(e.entry_date);
   k := md5(p_key::text || ':' || i)::uuid;
   keys := array_append(keys, k);
   result := accounting.operate(jsonb_build_object('key', k, 'command',
    jsonb_build_object('type', 'entry.context', 'id', e.id, 'expected_version', e.version, 'payee_id', contact_id)));
   results := results || jsonb_build_array(jsonb_build_object('id', e.id, 'version', result->'version'));
  END LOOP;
  -- Remember: each bank description in the set fills this contact on future
  -- feed transactions, unless another contact already owns it.
  IF coalesce((a->>'remember')::boolean, false) THEN
   FOR descriptor IN SELECT DISTINCT je.descriptor_key FROM accounting.journal_entries je
     WHERE je.id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(a->'entries')) AND nullif(btrim(je.descriptor_key), '') IS NOT NULL ORDER BY 1 LOOP
    SELECT jsonb_build_object('id', p.id, 'name', p.name) INTO alias_owner FROM accounting.payee_aliases al JOIN accounting.parties p ON p.id = al.party_id
     WHERE al.match_kind = 'key' AND al.pattern = descriptor;
    IF alias_owner IS NULL THEN
     k := md5(p_key::text || ':alias:' || descriptor)::uuid;
     keys := array_append(keys, k);
     PERFORM accounting.operate(jsonb_build_object('key', k, 'command', jsonb_build_object('type', 'alias.save',
      'id', md5('alias:' || p_key::text || ':' || descriptor)::uuid, 'expected_version', 0, 'party_id', contact_id,
      'match_kind', 'key', 'pattern', descriptor, 'enabled', true)));
     remembered := remembered || to_jsonb(descriptor);
    ELSIF alias_owner->>'id' = contact_id::text THEN
     already := already || to_jsonb(descriptor);
    ELSE
     skipped := skipped || jsonb_build_array(jsonb_build_object('descriptor_key', descriptor, 'contact', alias_owner));
    END IF;
   END LOOP;
  END IF;
  result := jsonb_build_object('id', contact_id, 'entries', results, 'remembered', remembered,
   'already_remembered', already, 'not_remembered', skipped);
 END IF;

 IF p_operation = 'categorize.bulk' THEN
  IF jsonb_typeof(a->'items') <> 'array' OR jsonb_array_length(a->'items') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'API_INVALID_INPUT'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(a->'items') LOOP
   i := i + 1;
   k := md5(p_key::text || ':' || i)::uuid;
   keys := array_append(keys, k);
   PERFORM public.api_books_ref('category', item->>'account_id');
   IF item ? 'payee_id' THEN PERFORM public.api_books_ref('payee', item->>'payee_id'); END IF;
   cmd := jsonb_strip_nulls(jsonb_build_object('type', 'entry.categorize', 'id', (item->>'id')::uuid,
    'expected_version', (item->>'expected_version')::integer, 'account_id', (item->>'account_id')::uuid,
    'kind', public.api_category_kind((item->>'id')::uuid, (item->>'account_id')::uuid),
    'payee_id', item->'payee_id')) || jsonb_build_object('remember', false);
   results := results || jsonb_build_array(accounting.operate(jsonb_build_object('key', k, 'command', cmd)));
  END LOOP;
  result := jsonb_build_object('results', results);
 ELSIF p_operation <> 'contact.assign' THEN
  keys := ARRAY[p_key];
  result := accounting.operate(jsonb_build_object('key', p_key, 'command', cmd));
 END IF;

 SELECT string_agg(DISTINCT l.table_name || ':' || l.action, ', ') INTO bad
 FROM accounting.audit_log l
 WHERE l.operation_id = ANY (keys) AND (
  l.table_name NOT IN ('journal_entries', 'journal_lines', 'rules', 'parties', 'payee_aliases', 'command_receipts', 'periods')
  -- A draft in a month with no period row opens one; it must stay open.
  OR (l.table_name = 'periods' AND (coalesce(l.after->>'status', 'open') <> 'open' OR coalesce(l.before->>'status', 'open') <> 'open'))
  OR (l.table_name = 'journal_entries' AND p_operation <> 'contact.assign' AND (coalesce(l.after->>'status', 'draft') <> 'draft' OR coalesce(l.before->>'status', 'draft') <> 'draft'))
  -- Assigning a contact changes exactly one thing on an entry: a blank contact becomes set.
  OR (l.table_name = 'journal_entries' AND p_operation = 'contact.assign' AND NOT (l.before IS NOT NULL AND l.after IS NOT NULL
   AND l.before->>'payee_id' IS NULL AND l.after->>'payee_id' IS NOT NULL
   AND (l.after - ARRAY['payee_id', 'version', 'updated_at']) = (l.before - ARRAY['payee_id', 'version', 'updated_at'])))
  OR (l.table_name = 'journal_lines' AND p_operation = 'contact.assign')
  OR (l.table_name = 'rules' AND (l.before IS NOT NULL OR coalesce((l.after->>'auto_post')::boolean, false) OR coalesce((l.after->>'enabled')::boolean, false)))
  -- A contact from the API is a suggestion, and only a suggestion changes.
  OR (l.table_name = 'parties' AND (coalesce(l.after->>'review_status', '') <> 'suggested'
   OR (l.before IS NOT NULL AND (p_operation <> 'contact.update' OR l.before->>'review_status' <> 'suggested'))))
  -- An alias is only ever added, and only by remember.
  OR (l.table_name = 'payee_aliases' AND (l.before IS NOT NULL OR p_operation <> 'contact.assign')));
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'API_DRAFTS_ONLY (%)', bad; END IF;
 RETURN result;
END $fn$;

COMMIT;
