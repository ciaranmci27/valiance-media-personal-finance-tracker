import { Client } from "pg";
import { accountingMigrations } from "./accounting-schema";
import {
  fixtureOwner,
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import { randomUUID } from "node:crypto";

async function main() {
  const url =
    process.env.ACCOUNTING_TEST_DATABASE_URL ??
    "postgresql://postgres@127.0.0.1:5447/accounting_test";
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/accounting_test"
  )
    throw new Error(
      "Only the dedicated local accounting_test database is allowed.",
    );
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const exists = await db.query(
      "SELECT to_regclass('public.acct_settings') AS configured",
    );
    if (exists.rows[0].configured)
      throw new Error(
        "Fixture database already exists. Preserve it or rebuild with the verified test reset workflow.",
      );
    await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
    for (const migration of await accountingMigrations())
      await db.query(migration.sql);
    await db.query(
      "CREATE TABLE public.acct_test_marker (label text PRIMARY KEY CHECK(label='synthetic-local-accounting')); INSERT INTO public.acct_test_marker VALUES('synthetic-local-accounting'); REVOKE ALL ON public.acct_test_marker FROM PUBLIC,anon,authenticated,service_role;",
    );
    await db.query("INSERT INTO auth.users VALUES($1);", [fixtureOwner]);
    await db.query(
      "INSERT INTO acct_settings(owner_user_id,legal_name) VALUES($1,'Synthetic review company')",
      [fixtureOwner],
    );
    await db.query("SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
    const cmd = (data: object) =>
      db.query("SELECT acct_execute($1,$2::jsonb)", [
        randomUUID(),
        JSON.stringify(data),
      ]);
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
