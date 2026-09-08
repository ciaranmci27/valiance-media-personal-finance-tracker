import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { accountingMigrations } from "./accounting-schema";

async function main() {
  const db = new PGlite();
  let checks = 0;
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
    for (const migration of await accountingMigrations()) {
      await db.exec(migration.sql);
      if (migration.name.endsWith("_business_profile.sql")) break;
    }
    const profile = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM public.business_profile",
      )
    ).rows[0];
    assert.equal(profile.legal_name, "Valiance Media LLC");
    assert.equal(profile.entity_type, "llc");
    assert.equal(profile.tax_classification, "s_corp");
    for (const key of [
      "tax_classification_since",
      "ein",
      "address",
      "owner_name",
      "accountant_email",
    ])
      assert.equal(profile[key], null);
    checks += 8;
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "SELECT * FROM public.business_profile",
      ),
      /permission denied/,
    );
    await assert.rejects(
      db.query<Record<string, unknown>>("SELECT public.business_profile_get()"),
      /permission denied/,
    );
    checks += 2;
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await db.query<Record<string, unknown>>(
      "SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false)",
    );
    assert.equal(
      (
        await db.query<{ r: { legal_name: string } }>(
          "SELECT public.business_profile_get() r",
        )
      ).rows[0].r.legal_name,
      "Valiance Media LLC",
    );
    await db.query<Record<string, unknown>>(
      "UPDATE public.business_profile SET legal_name='Synthetic profile company'",
    );
    assert.equal(
      (
        await db.query<Record<string, unknown>>(
          "SELECT version FROM public.business_profile",
        )
      ).rows[0].version,
      2,
    );
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "UPDATE public.business_profile SET books_timezone='Invalid/Timezone'",
      ),
      /ACCT_INVALID_TIMEZONE/,
    );
    await assert.rejects(
      db.query<Record<string, unknown>>("DELETE FROM public.business_profile"),
      /ACCT_PROFILE_REQUIRED/,
    );
    checks += 4;
    await db.exec(
      "RESET ROLE; CREATE SCHEMA accounting; CREATE TABLE accounting.bank_transactions(id integer); INSERT INTO accounting.bank_transactions VALUES(1); SET ROLE authenticated;",
    );
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "UPDATE public.business_profile SET books_timezone='UTC'",
      ),
      /ACCT_TIMEZONE_FROZEN/,
    );
    checks++;
    console.log(
      `Business profile: ${checks} assertions passed; seed, authenticated access and timezone guard verified.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
