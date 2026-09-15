-- Transaction search: every word must match somewhere on the entry (memo, bank
-- descriptor, contact, category, line memo, bank institution and card mask, date,
-- amount). Quoted words search as one phrase, an amount matches any line or the
-- entry total, and > or < compare the total. A number matches text only on digit
-- boundaries (42 is not found inside a 4242 card mask), and LIKE wildcards in the
-- typed text are escaped, so 100% means the text 100%.
BEGIN;

CREATE OR REPLACE FUNCTION accounting.search_terms(query text)
 RETURNS TABLE(kind text, pattern text, cents bigint, op text)
 LANGUAGE sql
 IMMUTABLE STRICT SECURITY DEFINER
 SET search_path TO ''
AS $function$
 WITH raw AS (
  SELECT lower(btrim(coalesce(m.groups[1],m.groups[2]),' "')) term,m.ordinality
  FROM regexp_matches(left(query,200),'"([^"]*)"|(\S+)','g') WITH ORDINALITY m(groups,ordinality)
 ), terms AS (
  SELECT term,ordinality,substring(term FROM '^([<>]=?)') op,
   CASE WHEN term ~ '^([<>]=?|[-+])?\$?(\d{1,3}(,\d{3})+|\d{1,15})(\.\d{1,2})?$' THEN replace(regexp_replace(term,'^([<>]=?|[-+])?\$?',''),',','') END number
  FROM raw WHERE term<>'' AND ordinality<=12
 )
 SELECT CASE WHEN number IS NULL THEN 'text' WHEN op IS NOT NULL THEN 'compare' WHEN position('.' IN number)>0 THEN 'amount' ELSE 'dollars' END,
  CASE WHEN number IS NULL THEN replace(replace(replace(term,'\','\\'),'%','\%'),'_','\_') ELSE '(^|[^0-9])'||replace(number,'.','\.')||'([^0-9]|$)' END,
  CASE WHEN number IS NULL THEN NULL ELSE round(number::numeric*100)::bigint END,op
 FROM terms ORDER BY ordinality
$function$
;

REVOKE ALL ON FUNCTION accounting.search_terms(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION accounting.transactions(filter jsonb DEFAULT '{}'::jsonb, page jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE f jsonb:=filter||page; result jsonb; start_at integer:=coalesce((f->>'offset')::integer,0); page_size integer:=coalesce((f->>'limit')::integer,50); sort_by text:=coalesce(f->>'sort','date_desc'); q text:=nullif(btrim(coalesce(f->>'query','')),'');
BEGIN
 PERFORM accounting.require_owner();
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
 AND (f->>'source' IS NULL OR e.origin=f->>'source') AND (f->>'payee' IS NULL OR e.payee_id=(f->>'payee')::uuid)
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
COMMIT;
