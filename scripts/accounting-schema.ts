import { readFile, readdir } from "node:fs/promises";
/** Existing app dependency, reproduced only inside isolated accounting fixtures. */
export async function accountingTaxDependencySql() {
  const canonical = await readFile(
    new URL("../supabase/schema/schema.sql", import.meta.url),
    "utf8",
  );
  const table = canonical.match(
    /CREATE TABLE tax_estimates \([\s\S]*?\n\);/,
  )?.[0];
  if (!table) throw new Error("Canonical tax-estimator dependency is missing.");
  return (
    table +
    "\nCREATE UNIQUE INDEX idx_tax_estimates_year_unique_active ON public.tax_estimates(tax_year) WHERE deleted_at IS NULL;"
  );
}
export async function accountingMigrations() {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const names = (await readdir(directory))
    // Deliberately non-recursive: historical migrations are never applied.
    .filter((name) => /^\d{14}_(?:accounting_.*|business_profile)\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, directory), "utf8"),
    })),
  );
  return migrations;
}
export async function accountingCanonicalSql() {
  const canonical = await readFile(
    new URL("../supabase/schema/schema.sql", import.meta.url),
    "utf8",
  );
  const blocks = [
    ...canonical.matchAll(
      /-- ACCOUNTING ([A-Z ]+) BEGIN[\s\S]*?-- ACCOUNTING \1 END/g,
    ),
  ].map((m) => m[0]);
  if (!blocks.length)
    throw new Error("Canonical accounting schema is missing.");
  return blocks.join("\n\n");
}
