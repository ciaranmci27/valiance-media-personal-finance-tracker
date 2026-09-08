import { fixtureDatabaseUrl } from "./accounting-fixture-target";
import { Client } from "pg";
import {
  accountingMigrations,
  accountingTaxDependencySql,
} from "./accounting-schema";
import {
  fixtureOwner,
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import { randomUUID } from "node:crypto";

async function main() {
  const url = fixtureDatabaseUrl();
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const exists = await db.query(
      "SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS configured",
    );
    if (exists.rows[0].configured)
      throw new Error(
        "Fixture database already exists. Preserve it or rebuild with the verified test reset workflow.",
      );
    await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
    await db.query(`CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text,metadata jsonb DEFAULT '{}');
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO authenticated,anon;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated,anon;`);
    await db.query(await accountingTaxDependencySql());
    for (const migration of await accountingMigrations())
      await db.query(migration.sql);
    await db.query(
      "CREATE TABLE public.accounting_test_marker (label text PRIMARY KEY CHECK(label='synthetic-local-accounting')); INSERT INTO public.accounting_test_marker VALUES('synthetic-local-accounting'); REVOKE ALL ON public.accounting_test_marker FROM PUBLIC,anon,authenticated,service_role;",
    );
    await db.query("INSERT INTO auth.users VALUES($1);", [fixtureOwner]);
    await db.query(
      "INSERT INTO accounting.settings(owner_user_id) VALUES($1)",
      [fixtureOwner],
    );
    await db.query("SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
    const cmd = (data: object) =>
      db.query(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb))",
        [randomUUID(), JSON.stringify(data)],
      );
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind:
          a.id === fixtureAccountId(1) || a.id === fixtureAccountId(9)
            ? "bank"
            : a.id === fixtureAccountId(3)
              ? "card"
              : "none",
      })),
    });
    for (const e of fixtureEntries) {
      const id = randomUUID();
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: e.date,
        memo: e.memo,
        lines: e.lines.map(([n, amount_cents]) => ({
          account_id: fixtureAccountId(n),
          amount_cents,
          memo: "",
        })),
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
    }
    console.log(
      "Prepared isolated PostgreSQL fixture database with 11 posted journals.",
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
