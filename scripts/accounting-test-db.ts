import {
  accountingMigrations,
  accountingCanonicalSql,
} from "./accounting-schema";
import { PGlite } from "@electric-sql/pglite";
import { fixtureOwner } from "../src/lib/accounting/fixtures";

export async function accountingTestDb(
  source: "migrations" | "canonical" = "migrations",
) {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon,service_role;`);
  await db.exec(`CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text,metadata jsonb DEFAULT '{}');
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO authenticated,anon;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated,anon;`);
  if (source === "canonical") await db.exec(await accountingCanonicalSql());
  else
    for (const migration of await accountingMigrations())
      await db.exec(migration.sql);
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [fixtureOwner]);
  await db.query(
    "INSERT INTO public.acct_settings(owner_user_id,legal_name) VALUES($1,'Accounting test company')",
    [fixtureOwner],
  );
  await db.exec("SET ROLE authenticated;");
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
    fixtureOwner,
  ]);
  return db;
}
