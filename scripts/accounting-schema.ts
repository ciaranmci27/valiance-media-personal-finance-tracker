import { readFile, readdir } from "node:fs/promises";
export async function accountingMigrations() {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d{14}_accounting_.*\.sql$/.test(name))
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
