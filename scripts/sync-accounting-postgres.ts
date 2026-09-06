import { Client } from "pg";
import { accountingMigrations } from "./accounting-schema";

// This installer only updates the marked, disposable local fixture database.
async function main() {
  const url =
    process.env.ACCOUNTING_TEST_DATABASE_URL ??
    "postgresql://postgres@127.0.0.1:5447/accounting_test";
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/accounting_test"
  )
    throw new Error("Only the dedicated loopback fixture database is allowed.");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const marker = await db.query("SELECT label FROM public.acct_test_marker");
    if (
      marker.rows.length !== 1 ||
      marker.rows[0].label !== "synthetic-local-accounting"
    )
      throw new Error("Fixture marker is missing.");
    for (const migration of await accountingMigrations()) {
      const tables = [
        ...migration.sql.matchAll(/CREATE TABLE public\.(acct_\w+)/g),
      ].map((m) => m[1]);
      const presence: boolean[] = [];
      for (const table of tables)
        presence.push(
          (
            await db.query("SELECT to_regclass($1) present", [
              `public.${table}`,
            ])
          ).rows[0].present !== null,
        );
      if (presence.length && presence.every((p) => !p)) {
        await db.query(migration.sql);
        continue;
      }
      if (presence.some((p) => !p))
        throw new Error(
          `Partially installed ${migration.name}. Rebuild a fresh marked fixture database or apply a reviewed corrective change.`,
        );
      await db.query("BEGIN");
      const functions =
        migration.sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) ?? [];
      for (const fn of functions) await db.query(fn);
      for (const grant of migration.sql.match(
        /^(?:REVOKE|GRANT)\b[\s\S]*?;/gm,
      ) ?? [])
        await db.query(grant);
      await db.query("COMMIT");
    }
    console.log(
      "Updated local fixture functions and installed new accounting migrations.",
    );
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
