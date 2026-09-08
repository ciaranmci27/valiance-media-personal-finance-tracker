import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { accountingMigrations } from "./accounting-schema";

async function main() {
  const migrations = await accountingMigrations();
  const drop = migrations.find((file) =>
    file.name.endsWith("_accounting_drop_legacy.sql"),
  );
  assert.ok(drop);
  assert.ok(migrations.every((file) => !file.name.includes("archive")));
  let checks = 2;
  async function fixture() {
    const db = new PGlite();
    // Invented minimal legacy objects. No archived file or real data is read.
    await db.exec(`CREATE TABLE public.personal_sentinel(id integer PRIMARY KEY);
      INSERT INTO public.personal_sentinel VALUES(7);
      CREATE TABLE public.acct_settings(id integer PRIMARY KEY);
      CREATE TABLE public.acct_journal_entries(id integer PRIMARY KEY);
      CREATE TABLE public.acct_journal_lines(id integer PRIMARY KEY, entry_id integer REFERENCES public.acct_journal_entries);
      CREATE FUNCTION public.acct_is_owner() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.objects(id integer, bucket_id text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY legacy_accounting ON storage.objects USING (bucket_id='accounting-private' AND public.acct_is_owner());
      CREATE POLICY personal_policy ON storage.objects USING (bucket_id='personal');`);
    return db;
  }
  for (const table of [
    "acct_settings",
    "acct_journal_entries",
    "acct_journal_lines",
  ]) {
    const db = await fixture();
    try {
      await db.exec(`INSERT INTO public.${table}(id) VALUES(1)`);
      await assert.rejects(db.exec(drop.sql), /ACCT_LEGACY_NOT_EMPTY/);
      await db.exec("ROLLBACK");
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            `SELECT count(*)::int n FROM public.${table}`,
          )
        ).rows[0].n,
        1,
      );
      checks += 2;
    } finally {
      await db.close();
    }
  }
  const db = await fixture();
  try {
    await db.exec(drop.sql);
    await db.exec(drop.sql);
    assert.equal(
      (
        await db.query<Record<string, unknown>>(
          "SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace AND left(relname,5)='acct_' ",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query<Record<string, unknown>>(
          "SELECT count(*)::int n FROM pg_proc WHERE pronamespace='public'::regnamespace AND left(proname,5)='acct_' ",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      (
        await db.query<Record<string, unknown>>(
          "SELECT id FROM public.personal_sentinel",
        )
      ).rows,
      [{ id: 7 }],
    );
    assert.deepEqual(
      (
        await db.query<Record<string, unknown>>(
          "SELECT policyname FROM pg_policies WHERE schemaname='storage'",
        )
      ).rows,
      [{ policyname: "personal_policy" }],
    );
    checks += 4;
  } finally {
    await db.close();
  }
  const external = await fixture();
  try {
    await external.exec(
      "CREATE VIEW public.keep_view AS SELECT * FROM public.acct_settings",
    );
    await assert.rejects(external.exec(drop.sql), /depend/);
    await external.exec("ROLLBACK");
    assert.equal(
      (
        await external.query<Record<string, unknown>>(
          "SELECT to_regclass('public.keep_view')::text n",
        )
      ).rows[0].n,
      "keep_view",
    );
    checks += 2;
  } finally {
    await external.close();
  }
  console.log(
    `Legacy drop: ${checks} assertions passed; populated tables and external dependencies preserved.`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
