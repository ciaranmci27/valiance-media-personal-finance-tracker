import assert from "node:assert/strict";
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
        "SELECT relname,relkind,relrowsecurity,relforcerowsecurity,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'acct_%' ORDER BY relname",
      columns:
        "SELECT c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'acct_%' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
      constraints:
        "SELECT c.relname,k.conname,k.contype,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'acct_%' ORDER BY c.relname,k.conname",
      indexes:
        "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'acct_%' ORDER BY tablename,indexname",
      functions:
        "SELECT proname,pg_get_function_identity_arguments(oid) args,pg_get_functiondef(oid) definition,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'acct_%' ORDER BY proname,args",
      triggers:
        "SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname LIKE 'acct_%' ORDER BY c.relname,t.tgname",
      policies:
        "SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE tablename LIKE 'acct_%' OR policyname LIKE 'acct_%' ORDER BY schemaname,tablename,policyname",
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
