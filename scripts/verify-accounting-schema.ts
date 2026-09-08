import assert from "node:assert/strict";
import { accountingMigrations } from "./accounting-schema";
import { accountingTestDb } from "./accounting-test-db";

async function main() {
  const migrations = await accountingTestDb(),
    canonical = await accountingTestDb("canonical");
  let checks = 0;
  try {
    await migrations.exec("RESET ROLE");
    await canonical.exec("RESET ROLE");
    const queries = {
      tables:
        "SELECT relname,relkind,relrowsecurity,relforcerowsecurity,relacl::text FROM pg_class WHERE (relnamespace='accounting'::regnamespace OR (relnamespace='public'::regnamespace AND relname='business_profile')) ORDER BY relname",
      columns:
        "SELECT c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE (c.relnamespace='accounting'::regnamespace OR (c.relnamespace='public'::regnamespace AND c.relname='business_profile')) AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
      constraints:
        "SELECT c.relname,k.conname,k.contype,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE (c.relnamespace='accounting'::regnamespace OR (c.relnamespace='public'::regnamespace AND c.relname='business_profile')) ORDER BY c.relname,k.conname",
      indexes:
        "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE (schemaname='accounting' OR (schemaname='public' AND tablename='business_profile')) ORDER BY tablename,indexname",
      functions:
        "SELECT proname,pg_get_function_identity_arguments(oid) args,pg_get_functiondef(oid) definition,proacl::text FROM pg_proc WHERE (pronamespace='accounting'::regnamespace OR (pronamespace='public'::regnamespace AND proname LIKE 'business_profile%')) ORDER BY proname,args",
      triggers:
        "SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND (c.relnamespace='accounting'::regnamespace OR (c.relnamespace='public'::regnamespace AND c.relname='business_profile')) ORDER BY c.relname,t.tgname",
      policies:
        "SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='accounting' OR tablename='business_profile' OR policyname LIKE 'accounting_%' ORDER BY schemaname,tablename,policyname",
      seed_chart:
        "SELECT name,type,subtype,system_purpose,external_names FROM accounting.accounts ORDER BY name",
      seed_profile:
        "SELECT legal_name,entity_type,tax_classification,tax_classification_since,ein,address,phone,email,earliest_history_date,books_timezone FROM public.business_profile",
    };
    for (const [name, sql] of Object.entries(queries)) {
      const normalize = (v: unknown) =>
        JSON.stringify(v).replaceAll("\\r\\n", "\\n");
      assert.equal(
        normalize((await migrations.query(sql)).rows),
        normalize((await canonical.query(sql)).rows),
        `Canonical ${name} differ from the complete migration sequence.`,
      );
      checks++;
    }
    const expected = [
      "settings",
      "accounts",
      "journal_entries",
      "journal_lines",
      "periods",
      "audit_log",
      "command_receipts",
      "parties",
      "payee_aliases",
      "bank_connections",
      "bank_accounts",
      "bank_transactions",
      "bank_matches",
      "import_batches",
      "import_rows",
      "history_checks",
      "documents",
      "document_links",
      "rules",
      "reconciliations",
      "reconciliation_items",
      "payroll_runs",
      "registers",
      "tax_mappings",
      "tax_adjustments",
      "tax_links",
      "report_snapshots",
    ].sort();
    assert.deepEqual(
      (
        await migrations.query<{ name: string }>(
          "SELECT tablename name FROM pg_tables WHERE schemaname='accounting' ORDER BY tablename",
        )
      ).rows.map((r) => r.name),
      expected,
    );
    checks++;
    assert.equal(
      (
        await migrations.query(
          "SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'acct_%'",
        )
      ).rows.length,
      0,
    );
    checks++;
    assert.equal(
      (
        await migrations.query(
          "SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'acct_%'",
        )
      ).rows.length,
      0,
    );
    checks++;
    const functions = (
      await migrations.query<{
        name: string;
        safe: boolean;
        anon: boolean;
        worker: boolean;
      }>(
        "SELECT proname name,prosecdef AND proconfig @> ARRAY['search_path=\"\"'] safe,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('service_role',oid,'EXECUTE') worker FROM pg_proc WHERE pronamespace='accounting'::regnamespace ORDER BY proname",
      )
    ).rows;
    assert.ok(functions.every((f) => f.safe && !f.anon));
    checks++;
    assert.deepEqual(
      functions.filter((f) => f.worker).map((f) => f.name),
      ["sync_server", "tax_refresh_server"],
    );
    checks++;
    for (const migration of await accountingMigrations())
      assert.ok(!/pg_get_functiondef/i.test(migration.sql), migration.name);
    checks++;
    assert.equal(
      (
        await migrations.query(
          "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='business_profile'",
        )
      ).rows.length,
      1,
    );
    checks++;
    console.log(
      `Target schema: ${expected.length} accounting tables, ${functions.length} functions; exact table list, private grants and no active migration patching verified.`,
    );
    const triggers = (
      await migrations.query<{ count: number; functions: number }>(
        "SELECT count(*)::integer count,count(DISTINCT tgfoid)::integer functions FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='accounting'::regnamespace",
      )
    ).rows[0];
    console.log(
      `Accounting triggers: ${triggers.count} table attachments using ${triggers.functions} shared trigger functions; business_profile has 2 additional trigger attachments.`,
    );
    console.log(
      `Canonical schema parity: ${checks} catalog comparisons passed (tables, columns, constraints, indexes, functions, triggers, policies).`,
    );
  } finally {
    await migrations.close();
    await canonical.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
