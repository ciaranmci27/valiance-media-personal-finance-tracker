/**
 * The finance API test fixture shared by verify-api-http.ts and
 * verify-mcp.ts: the pglite books seeded as the books suites seed them,
 * tracker and tax rows, an agent member with two keys (everything, and books
 * only), and the PostgREST stand-in the real supabase-js client talks to.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accountingTestDb } from "./accounting-test-db";
import { startFakePostgrest } from "./fake-postgrest";
import { fixtureAccounts, fixtureEntries, fixtureAccountId as account, fixtureOwner } from "../src/lib/accounting/fixtures";

export const AGENT = "10000000-0000-4000-8000-0000000000b1";
const LIVE_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $function$`;

export async function seedApiFixture(options: { maxRows?: number } = {}) {
  const db = await accountingTestDb();
  let server: Awaited<ReturnType<typeof startFakePostgrest>> | undefined;
  try {
    await db.exec("RESET ROLE;");
    await db.exec(LIVE_AUTH_UID);

    // Books, as the books suites seed them (fixture owner session).
    await db.exec("SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
    const cmd = async (command: Record<string, unknown>) =>
      (await db.query<{ r: Record<string, unknown> }>("SELECT accounting.operate($1) r", [JSON.stringify({ key: randomUUID(), command })])).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        subtype: a.id === account(2) ? "transit" : a.id === account(8) ? "payroll_liability" : undefined,
        cash_kind: [account(1), account(9)].includes(a.id) ? "bank" : a.id === account(3) ? "card" : "none",
      });
    for (const f of fixtureEntries) {
      const e = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: f.date,
        memo: f.memo,
        lines: f.lines.map(([id, amount]) => ({ account_id: account(Number(id)), amount_cents: amount })),
      });
      await cmd({ type: "entry.post", id: e.id, expected_version: e.version });
    }
    const ownerRead = async <T>(sql: string, params: unknown[] = []) =>
      (await db.query<{ r: T }>(sql, params)).rows[0].r;
    const registerTotal = (
      await ownerRead<{ total: number }>("SELECT accounting.transactions($1,$2) r", [JSON.stringify({ from: "2026-01-01", to: "2026-12-31" }), "{}"])
    ).total;

    // Tracker tables, from the canonical schema.
    await db.exec("RESET ROLE;");
    const canonical = await readFile(new URL("../supabase/schema/schema.sql", import.meta.url), "utf8");
    for (const table of ["income_sources", "income_entries", "income_amounts", "income_line_items", "expenses", "net_worth"]) {
      const sql = canonical.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!sql) throw new Error(`schema.sql has no ${table}`);
      await db.exec(sql);
      await db.exec(`GRANT SELECT, INSERT, UPDATE ON public.${table} TO service_role;`);
    }
    await db.exec("GRANT SELECT ON public.tax_estimates, public.business_profile TO service_role;");
    const salary = (await db.query<{ id: string }>("INSERT INTO income_sources(name,slug) VALUES('Salary','salary') RETURNING id")).rows[0].id;
    const side = (await db.query<{ id: string }>("INSERT INTO income_sources(name,slug,sort_order) VALUES('Side work','side',1) RETURNING id")).rows[0].id;
    for (const [month, a, b] of [
      ["2026-08-01", "5000.00", "250.50"],
      ["2026-09-01", "5000.00", "0.00"],
    ]) {
      const entry = (await db.query<{ id: string }>("INSERT INTO income_entries(month) VALUES($1) RETURNING id", [month])).rows[0].id;
      await db.query("INSERT INTO income_amounts(entry_id,source_id,amount) VALUES($1,$2,$3),($1,$4,$5)", [entry, salary, a, side, b]);
    }
    await db.query("INSERT INTO income_entries(month,deleted_at) VALUES('2026-07-01',now())");
    await db.exec(`INSERT INTO expenses(name,amount,frequency,expense_type,category) VALUES
      ('Figma Professional','15.00','monthly','business','subscriptions'),
      ('Domain renewals','120.00','annual','business','hosting'),
      ('Gym','10.00','weekly','personal','health');
      INSERT INTO expenses(name,amount,frequency,expense_type,category,is_active) VALUES ('Old tool','99.00','monthly','business','software',false);
      INSERT INTO net_worth(date,amount) VALUES ('2026-06-30','120000.00'),('2026-09-30','131500.25');`);
    const taxInputs = {
      income_sources: [{ id: "s1", name: "Business", amount: 90000, subject_to_se: true, income_type: "business" }],
      payments: [{ id: "p1", type: "federal", category: "payment", quarter: "Q1", label: "Q1 federal", amount: 4000 }],
    };
    await db.query("INSERT INTO tax_estimates(tax_year,filing_status,income_sources,payments,state) VALUES(2026,'single',$1,$2,'AZ')", [
      JSON.stringify(taxInputs.income_sources),
      JSON.stringify(taxInputs.payments),
    ]);

    // An agent with a key for everything, and a narrower key.
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [AGENT]);
    await db.exec("SET ROLE authenticated;");
    const agentId = (
      await db.query<{ id: string }>("INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Jeff','jeff@agents.test','agent') RETURNING id", [AGENT])
    ).rows[0].id;
    for (const key of ["income.read", "income.manage", "expenses.read", "expenses.manage", "net_worth.read", "net_worth.manage", "tax.read"])
      await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,$2,'allow')", [agentId, key]);
    await db.exec("RESET ROLE;");
    const fullKey = `vmfin_${randomUUID().replaceAll("-", "")}`;
    const booksOnly = `vmfin_${randomUUID().replaceAll("-", "")}`;
    const hash = (k: string) => createHash("sha256").update(k).digest("hex");
    for (const [k, scopes] of [
      [
        fullKey,
        ["accounting.read", "accounting.draft", "income.read", "income.manage", "expenses.read", "expenses.manage", "net_worth.read", "net_worth.manage", "tax.read"],
      ],
      [booksOnly, ["accounting.read"]],
    ] as const)
      await db.query("INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,created_by,scopes) VALUES('k',$1,$2,$3,$3,$4)", [
        k.slice(0, 14),
        hash(k),
        agentId,
        scopes,
      ]);
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");

    // A cap of 2 rows per response (Supabase's default is 1000) makes every
    // tracker read page; totals below only add up if no page is lost.
    server = await startFakePostgrest(db, { maxRows: options.maxRows ?? 2 });
    process.env.NEXT_PUBLIC_SUPABASE_URL = server.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    return { db, server, fullKey, booksOnly, agentId, side, taxInputs, registerTotal, ownerRead, hash };
  } catch (error) {
    await server?.close();
    await db.close();
    throw error;
  }
}

/** Days from today in the books time zone (the fixture keeps America/Phoenix), as YYYY-MM-DD. */
export function booksDay(offset = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * A bank feed on the fixture's business card that agrees with the books five
 * days ago and reports $9.71 more owed from two days ago: a charge the feed
 * never sent. The balances go through sync_server, as the worker sends them.
 */
export async function seedCardGap(db: Awaited<ReturnType<typeof accountingTestDb>>) {
  const connection = randomUUID(),
    feed = randomUUID();
  await db.exec("RESET ROLE; SET ROLE authenticated;");
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
  const cmd = async (command: Record<string, unknown>) =>
    db.query("SELECT accounting.operate($1)", [JSON.stringify({ key: randomUUID(), command })]);
  await cmd({ type: "feed.claim", id: connection, name: "Synthetic Amex", access_url_encrypted: "synthetic-encrypted-access", expected_version: 0 });
  await cmd({
    type: "feed.map",
    id: feed,
    expected_version: 0,
    account_id: account(3),
    connection_id: connection,
    provider_account_id: '["synthetic", "card"]',
    coverage_from: "2025-12-01",
  });
  const noon = (offset: number) => Date.parse(`${booksDay(offset)}T12:00:00-07:00`) / 1000;
  await db.exec("RESET ROLE; SET ROLE service_role;");
  for (const [balance, at] of [
    ["0", noon(-5)],
    ["-971", noon(-2)],
  ] as const) {
    const run = randomUUID();
    await db.query("SELECT accounting.sync_server($1)", [JSON.stringify({ id: connection, run_id: run, action: "lease" })]);
    await db.query("SELECT accounting.sync_server($1)", [
      JSON.stringify({
        id: connection,
        run_id: run,
        action: "complete",
        discovery: true,
        accounts: [{ provider_connection_id: "synthetic", provider_account_id: "card", currency: "USD", name: "Synthetic card", institution: "Synthetic", balance_cents: balance, balance_at: at, complete: true, transactions: [] }],
      }),
    ]);
  }
  await db.exec("RESET ROLE;");
  await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  return { connection, feed, offSince: noon(-2) };
}
