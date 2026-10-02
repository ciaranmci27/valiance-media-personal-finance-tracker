/**
 * Payroll access: the payroll tables follow accounting.manage instead of
 * letting every signed-in person read and write them. Runs the migration
 * against the isolated pglite fixture (team access loaded, fixtureOwner is the
 * owner) over stand-ins for the eleven payroll tables, created with the open
 * policies the payroll module shipped.
 */
import { readFile } from "node:fs/promises";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureOwner } from "../src/lib/accounting/fixtures";

const MIGRATION = new URL(
  "../supabase/migrations/20261002083831_payroll_access.sql",
  import.meta.url,
);
const ADMIN = "10000000-0000-4000-8000-00000000000a";
const MEMBER = "10000000-0000-4000-8000-00000000000b";
const GRANTED = "10000000-0000-4000-8000-00000000000d";
const STRANGER = "10000000-0000-4000-8000-00000000000c";

const FULL = [
  "organization_config",
  "federal_tax_configs",
  "state_tax_configs",
  "payroll_employees",
  "payroll_runs",
  "payroll_tax_deposits",
  "payroll_forms",
];
const APPEND_ONLY = [
  "config_change_history",
  "payroll_run_history",
  "payroll_deposit_history",
  "payroll_audit_events",
];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean) {
  if (ok) passed++;
  else failures.push(label);
}

async function main() {
  const db = await accountingTestDb();
  try {
    const as = async (uid: string) => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
    };
    const superuser = async () => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    };
    /** Rows the statement touched, or -1 when Postgres refused it. */
    const touched = async (sql: string) => {
      try {
        const result = await db.query(sql);
        return result.affectedRows ?? result.rows.length;
      } catch {
        return -1;
      }
    };
    const visible = async (table: string) =>
      (await db.query(`SELECT 1 FROM public.${table}`)).rows.length;

    // The tables as the payroll module left them: open to everyone signed in.
    await superuser();
    for (const table of [...FULL, ...APPEND_ONLY]) {
      await db.exec(`CREATE TABLE public.${table}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text);
        ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO authenticated;
        INSERT INTO public.${table}(note) VALUES ('seed');`);
      if (table === "payroll_audit_events") {
        await db.exec(`CREATE POLICY payroll_audit_events_select ON public.${table} FOR SELECT TO authenticated USING (TRUE);
          CREATE POLICY payroll_audit_events_insert ON public.${table} FOR INSERT TO authenticated WITH CHECK (TRUE);`);
      } else {
        for (const [verb, clause] of [
          ["view", "FOR SELECT TO authenticated USING (true)"],
          ["insert", "FOR INSERT TO authenticated WITH CHECK (true)"],
          ["update", "FOR UPDATE TO authenticated USING (true) WITH CHECK (true)"],
          ["delete", "FOR DELETE TO authenticated USING (true)"],
        ])
          await db.exec(`CREATE POLICY "Authenticated users can ${verb} ${table}" ON public.${table} ${clause}`);
      }
    }

    // The people: an admin (accounting.manage by role default), a member
    // (no money keys), a member granted accounting.manage personally, and a
    // signed-in stranger with no team row.
    for (const id of [ADMIN, MEMBER, GRANTED, STRANGER])
      await db.query("INSERT INTO auth.users(id) VALUES($1)", [id]);
    await as(fixtureOwner);
    await db.query(
      `INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES
        ($1,'Ada Admin','ada@example.com','admin'),
        ($2,'Mel Member','mel@example.com','member'),
        ($3,'Gil Granted','gil@example.com','member')`,
      [ADMIN, MEMBER, GRANTED],
    );
    await db.query(
      `INSERT INTO public.team_member_permissions(member_id,permission_key,effect)
        SELECT id,'accounting.manage','allow' FROM public.team_members WHERE auth_user_id=$1`,
      [GRANTED],
    );

    // The hole, before the migration.
    await as(MEMBER);
    check("before: a member reads employees", (await visible("payroll_employees")) === 1);
    check("before: a member rewrites the FEIN row", (await touched("UPDATE public.organization_config SET note='x'")) === 1);

    await superuser();
    const migration = await readFile(MIGRATION, "utf8");
    await db.exec(migration);
    await db.exec(migration); // safe to re-run

    const policies = (
      await db.query<{ n: number }>(
        "SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'Authenticated users can %'",
      )
    ).rows[0].n;
    check("no open payroll policy is left", policies === 0);

    for (const who of [fixtureOwner, ADMIN, GRANTED]) {
      await as(who);
      for (const table of [...FULL, ...APPEND_ONLY]) {
        check(`${who} reads ${table}`, (await visible(table)) >= 1);
        check(`${who} inserts into ${table}`, (await touched(`INSERT INTO public.${table}(note) VALUES ('new')`)) === 1);
      }
      for (const table of FULL) {
        check(`${who} updates ${table}`, (await touched(`UPDATE public.${table} SET note='edited' WHERE note<>'new'`)) >= 1);
        check(`${who} deletes from ${table}`, (await touched(`DELETE FROM public.${table} WHERE note='new'`)) === 1);
      }
      for (const table of APPEND_ONLY) {
        check(`${who} cannot update ${table}`, (await touched(`UPDATE public.${table} SET note='edited'`)) <= 0);
        check(`${who} cannot delete from ${table}`, (await touched(`DELETE FROM public.${table}`)) <= 0);
      }
    }

    for (const who of [MEMBER, STRANGER]) {
      await as(who);
      for (const table of [...FULL, ...APPEND_ONLY]) {
        check(`${who} sees nothing in ${table}`, (await visible(table)) === 0);
        check(`${who} cannot insert into ${table}`, (await touched(`INSERT INTO public.${table}(note) VALUES ('x')`)) === -1);
        check(`${who} cannot update ${table}`, (await touched(`UPDATE public.${table} SET note='x'`)) <= 0);
        check(`${who} cannot delete from ${table}`, (await touched(`DELETE FROM public.${table}`)) <= 0);
      }
    }

    await superuser();
    const intact = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM (${[...FULL, ...APPEND_ONLY]
          .map((t) => `SELECT 1 FROM public.${t} WHERE note='seed' OR note='edited'`)
          .join(" UNION ALL ")}) rows`,
      )
    ).rows[0].n;
    check("refused writes left the seed rows in place", intact >= FULL.length + APPEND_ONLY.length);
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`Payroll access: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Payroll access: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
