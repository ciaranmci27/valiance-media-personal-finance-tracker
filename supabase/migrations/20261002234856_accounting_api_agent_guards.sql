-- Finance API guards for agents (from building the finance agent).
--
-- 1. Journal entries from the API are adjustments only. A draft may not put
--    a line on a bank, card or cash account (those movements come from the
--    feeds and imports), and a bank or card draft is categorized or split,
--    never rewritten. Until now this was only a prompt rule.
-- 2. Categorizing sets the entry's kind from the category, as the
--    Transactions screen does, so a draft moved to owner distributions stops
--    reading as an expense.
-- 3. Split amounts are sent as positive cents; for money in they are flipped
--    to the sign the books require, so a deposit can be split by amount.

-- What categorizing a transaction to an account means for its kind, the
-- rule the Transactions screen uses (categoryKind in categories.ts): owner
-- equity is owner; income on money out and expense on money in are refunds;
-- loans and fixed assets keep their own kind.
CREATE OR REPLACE FUNCTION public.api_category_kind(p_entry uuid, p_category uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE money_in boolean; category_type text; category_subtype text;
BEGIN
 SELECT coalesce(sum(l.amount_cents), 0) > 0 INTO money_in FROM accounting.journal_lines l JOIN accounting.accounts acc ON acc.id = l.account_id
  WHERE l.entry_id = p_entry AND acc.subtype IN ('bank', 'card', 'cash');
 SELECT type, subtype INTO category_type, category_subtype FROM accounting.accounts WHERE id = p_category;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN CASE
  WHEN category_subtype = 'owner_equity' THEN 'owner'
  WHEN category_type = 'income' THEN CASE WHEN money_in THEN 'income' ELSE 'refund' END
  WHEN category_type = 'expense' THEN CASE WHEN money_in THEN 'refund' ELSE 'expense' END
  WHEN category_subtype = 'loan' THEN 'loan'
  WHEN category_subtype = 'fixed_asset' THEN 'asset'
  WHEN money_in THEN 'income' ELSE 'expense' END;
END $fn$;

REVOKE ALL ON FUNCTION public.api_category_kind(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.api_books_command(p_key_hash text, p_operation text, p_key uuid, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
 a jsonb := coalesce(p_args, '{}'::jsonb);
 kinds text[] := ARRAY['manual', 'income', 'expense', 'refund', 'owner', 'loan', 'asset'];
 keys uuid[] := ARRAY[]::uuid[];
 cmd jsonb; result jsonb; results jsonb := '[]'::jsonb; item jsonb; i integer := 0; k uuid; bad text;
 current_status text; current_kind text; current_payee uuid; cash_sign integer;
 lines jsonb; splits jsonb; conditions jsonb; actions jsonb; matcher text;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN ('draft.create', 'draft.update', 'categorize', 'split', 'categorize.bulk', 'rule.create', 'payee.create') THEN
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
 ELSIF p_operation = 'payee.create' THEN
  cmd := jsonb_build_object('type', 'party.save', 'id', md5('payee:' || p_key::text)::uuid, 'expected_version', 0,
   'name', a->>'name', 'kind', a->>'kind', 'default_account_id', public.api_books_ref('category', a->>'default_account_id'),
   'notes', coalesce(a->>'notes', ''), 'is_contractor', false, 'is_archived', false);
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
 ELSE
  keys := ARRAY[p_key];
  result := accounting.operate(jsonb_build_object('key', p_key, 'command', cmd));
 END IF;

 SELECT string_agg(DISTINCT l.table_name || ':' || l.action, ', ') INTO bad
 FROM accounting.audit_log l
 WHERE l.operation_id = ANY (keys) AND (
  l.table_name NOT IN ('journal_entries', 'journal_lines', 'rules', 'parties', 'command_receipts', 'periods')
  -- A draft in a month with no period row opens one; it must stay open.
  OR (l.table_name = 'periods' AND (coalesce(l.after->>'status', 'open') <> 'open' OR coalesce(l.before->>'status', 'open') <> 'open'))
  OR (l.table_name = 'journal_entries' AND (coalesce(l.after->>'status', 'draft') <> 'draft' OR coalesce(l.before->>'status', 'draft') <> 'draft'))
  OR (l.table_name = 'rules' AND (l.before IS NOT NULL OR coalesce((l.after->>'auto_post')::boolean, false) OR coalesce((l.after->>'enabled')::boolean, false)))
  OR (l.table_name = 'parties' AND l.before IS NOT NULL));
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'API_DRAFTS_ONLY (%)', bad; END IF;
 RETURN result;
END $fn$;
