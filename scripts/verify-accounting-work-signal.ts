/**
 * The work signal on the books revision read (accounting.work_signal and the
 * 'revision' read of public.api_accounting), on the pglite fixture.
 *
 * At every step the signal is compared with what the agents host dispatcher
 * used to compute from a full transactions read: review drafts, presented as
 * the API presents them, kept when status is draft, categorized is false and
 * transfer is false, ids sorted, hashed. Steps: an empty book; a bank feed
 * that brings drafts; a sync that brings nothing new (the revision moves, the
 * signal does not); a draft categorized, given a contact, put back to
 * Uncategorized; one arriving as another leaves; drafts that are not work
 * (categorized, a transfer, discarded); contacts over the last 30 days.
 */
import { createHash, randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureAccounts, fixtureOwner, fixtureAccountId as account } from "../src/lib/accounting/fixtures";
import { presentTransaction } from "../src/lib/accounting/transactions";
import type { JournalEntry } from "../src/lib/accounting/contracts";
import type { AccountProfile } from "../src/lib/accounting/workflows";

const AGENT = "10000000-0000-4000-8000-0000000000d2";
const LIVE_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $function$`;
const sha = (key: string) => createHash("sha256").update(key).digest("hex");
const fingerprintOf = (ids: string[]) => createHash("md5").update([...ids].sort().join(",")).digest("hex").slice(0, 16);

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 800)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQL answers are checked field by field
type Json = Record<string, any>;
interface Signal {
  actionable_drafts: { count: number; fingerprint: string; newest_at: string | null };
  contacts_needed: { count: number; since: string };
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date());
const day = (offset: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const noon = (offset: number) => Date.parse(`${day(offset)}T12:00:00-07:00`) / 1000;

async function main() {
  const db = await accountingTestDb();
  try {
    const superuser = async () => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    };
    const asOwner = async () => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
    };
    const owner = async (command: Json) => {
      await asOwner();
      return (await db.query<{ r: Json }>("SELECT accounting.operate($1) r", [JSON.stringify({ key: randomUUID(), command })])).rows[0].r;
    };
    const raw = async <T = Json>(sql: string, params: unknown[] = []) => {
      await superuser();
      return (await db.query<T>(sql, params)).rows;
    };
    const versionOf = async (id: string) => (await raw<{ version: number }>("SELECT version FROM accounting.journal_entries WHERE id=$1", [id]))[0].version;
    const revision = async () => (await raw<{ r: string }>("SELECT financial_revision::text r FROM accounting.settings WHERE id=1"))[0].r;
    /** The signal as the API reaches it: postgres, acting as the owner. */
    const signal = async (): Promise<Signal> => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
      return (await db.query<{ r: Signal }>("SELECT accounting.work_signal() r")).rows[0].r;
    };
    /** What the dispatcher computed: GET transactions?review=needed&status=draft, then draft, not categorized, not a transfer. */
    const dispatcher = async () => {
      const accounts = await raw<{ id: string; system_purpose: string | null; subtype: string; parent_id: string | null; type: string; version: number }>(
        "SELECT id,system_purpose,subtype,parent_id,type,version FROM accounting.accounts",
      );
      const profiles: AccountProfile[] = accounts.map((a) => ({
        account_id: a.id,
        version: a.version,
        purpose: a.system_purpose,
        cash_kind: (["bank", "cash", "card"].includes(a.subtype) ? a.subtype : "none") as AccountProfile["cash_kind"],
        parent_account_id: a.parent_id,
        subtype: a.subtype,
      }));
      await asOwner();
      const register = (
        await db.query<{ r: { entries: JournalEntry[] } }>("SELECT accounting.transactions($1,$2) r", [
          JSON.stringify({ status: "draft", review: "needs_review" }),
          JSON.stringify({ limit: 100 }),
        ])
      ).rows[0].r;
      const ids = register.entries
        .filter((entry) => {
          const view = presentTransaction(entry, profiles);
          return entry.status === "draft" && view.categorized === false && !view.transfer;
        })
        .map((entry) => entry.id);
      return { count: ids.length, fingerprint: fingerprintOf(ids), ids };
    };
    /** The register's own count of the rows contacts_needed counts. */
    const blankContacts = async (since: string) => {
      await asOwner();
      return (
        await db.query<{ r: { total: number } }>("SELECT accounting.transactions($1,'{}') r", [
          JSON.stringify({ from: since, payee: "unassigned", transfers: "exclude" }),
        ])
      ).rows[0].r.total;
    };
    const agrees = async (label: string) => {
      const [s, d] = [await signal(), await dispatcher()];
      check(
        `${label}: the signal matches the dispatcher's own computation`,
        s.actionable_drafts.count === d.count && s.actionable_drafts.fingerprint === d.fingerprint,
        { signal: s.actionable_drafts, dispatcher: d },
      );
      check(`${label}: contacts_needed matches the register`, s.contacts_needed.count === (await blankContacts(s.contacts_needed.since)), s.contacts_needed);
      return s;
    };

    await superuser();
    await db.exec(LIVE_AUTH_UID);
    for (const a of fixtureAccounts)
      await owner({
        type: "account.create",
        ...a,
        subtype: a.id === account(2) ? "transit" : a.id === account(8) ? "payroll_liability" : undefined,
        cash_kind: [account(1), account(9)].includes(a.id) ? "bank" : a.id === account(3) ? "card" : "none",
      });
    const uncategorizedExpense = (await raw<{ id: string }>("SELECT id FROM accounting.accounts WHERE system_purpose='uncategorized_expense'"))[0].id;

    // ---- An empty queue.
    const empty = await agrees("empty");
    check("empty: count 0, the hash of nothing, no newest", empty.actionable_drafts.count === 0 && empty.actionable_drafts.fingerprint === fingerprintOf([]) && empty.actionable_drafts.newest_at === null, empty);
    check("empty: contacts since 30 days ago", empty.contacts_needed.count === 0 && empty.contacts_needed.since === day(-30), empty.contacts_needed);

    // ---- A bank feed brings two transactions.
    const connection = randomUUID();
    await owner({ type: "feed.claim", id: connection, name: "Synthetic bank", access_url_encrypted: "synthetic-encrypted-access", expected_version: 0 });
    await owner({
      type: "feed.map",
      id: randomUUID(),
      expected_version: 0,
      account_id: account(1),
      connection_id: connection,
      provider_account_id: '["synthetic", "checking"]',
      coverage_from: day(-90),
    });
    let balance = 100000;
    const tx = (id: string, offset: number, cents: number, description: string) => ({
      external_id: id,
      posted: noon(offset),
      amount_cents: String(cents),
      description,
      state: "posted",
      hash: createHash("sha256").update(id).digest("hex"),
      raw: { synthetic: true },
    });
    const sync = async (transactions: Json[]) => {
      const run = randomUUID();
      balance += transactions.reduce((sum, t) => sum + Number(t.amount_cents), 0);
      await db.exec("RESET ROLE; SET ROLE service_role");
      try {
        await db.query("SELECT accounting.sync_server($1)", [JSON.stringify({ id: connection, run_id: run, action: "lease" })]);
        await db.query("SELECT accounting.sync_server($1)", [
          JSON.stringify({
            id: connection,
            run_id: run,
            action: "complete",
            create_drafts: true,
            accounts: [
              {
                provider_connection_id: "synthetic",
                provider_account_id: "checking",
                currency: "USD",
                name: "Synthetic checking",
                institution: "Synthetic",
                balance_cents: String(balance),
                balance_at: Math.floor(Date.now() / 1000),
                complete: true,
                through: String(Math.floor(Date.now() / 1000)),
                transactions,
              },
            ],
          }),
        ]);
      } finally {
        await db.exec("RESET ROLE; SET ROLE authenticated");
      }
    };
    const fedIds = async () => (await raw<{ id: string; memo: string }>("SELECT id,memo FROM accounting.journal_entries WHERE origin='simplefin' ORDER BY entry_date,id"));
    await sync([tx("s-1", -3, -1234, "SYNTHETIC SOFTWARE"), tx("s-2", -2, 5000, "CLIENT DEPOSIT")]);
    const fed = await fedIds();
    check("feed: two drafts arrived", fed.length === 2, fed);
    const [software, deposit] = [fed.find((r) => /SOFTWARE/i.test(r.memo))!.id, fed.find((r) => /DEPOSIT/i.test(r.memo))!.id];
    const arrived = await agrees("feed");
    check("feed: both are work", arrived.actionable_drafts.count === 2 && arrived.actionable_drafts.fingerprint === fingerprintOf([software, deposit]), arrived.actionable_drafts);
    check("feed: newest_at is fixed-width UTC", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(arrived.actionable_drafts.newest_at ?? ""), arrived.actionable_drafts.newest_at);
    check("feed: both need a contact", arrived.contacts_needed.count === 2, arrived.contacts_needed);

    // ---- A sync that brings nothing new: the revision moves, the signal does not.
    const before = await revision();
    await sync([tx("s-1", -3, -1234, "SYNTHETIC SOFTWARE"), tx("s-2", -2, 5000, "CLIENT DEPOSIT")]);
    await sync([]);
    const quiet = await agrees("quiet sync");
    check("quiet sync: the revision moved", BigInt(await revision()) > BigInt(before), { before, after: await revision() });
    check("quiet sync: the signal is unchanged", JSON.stringify(quiet) === JSON.stringify(arrived), { quiet, arrived });

    // ---- Categorized: it leaves the queue.
    await owner({ type: "entry.categorize", id: software, expected_version: await versionOf(software), account_id: account(6) });
    const categorized = await agrees("categorized");
    check("categorized: one left, a new fingerprint", categorized.actionable_drafts.count === 1 && categorized.actionable_drafts.fingerprint === fingerprintOf([deposit]), categorized.actionable_drafts);
    check("categorized: newest_at never moves later when work leaves", categorized.actionable_drafts.newest_at! <= arrived.actionable_drafts.newest_at!, categorized.actionable_drafts);

    // ---- A contact written to a waiting draft is not new work.
    const vendor = randomUUID();
    await owner({ type: "party.save", id: vendor, expected_version: 0, name: "Acme Client", roles: ["client"] });
    await owner({ type: "entry.context", id: deposit, expected_version: await versionOf(deposit), payee_id: vendor });
    const contacted = await agrees("contact");
    check("contact: the fingerprint is the same", JSON.stringify(contacted.actionable_drafts) === JSON.stringify(categorized.actionable_drafts), { contacted, categorized });
    check("contact: one fewer needs a contact", contacted.contacts_needed.count === 1, contacted.contacts_needed);

    // ---- Back to Uncategorized: the same set as before, the same fingerprint.
    await owner({ type: "entry.categorize", id: software, expected_version: await versionOf(software), account_id: uncategorizedExpense });
    const reverted = await agrees("reverted");
    check("reverted: the set and the fingerprint are what they were", reverted.actionable_drafts.count === 2 && reverted.actionable_drafts.fingerprint === arrived.actionable_drafts.fingerprint, reverted.actionable_drafts);

    // ---- One leaves as another arrives: the count stays, newest_at says it is new.
    await owner({ type: "entry.categorize", id: deposit, expected_version: await versionOf(deposit), account_id: account(5) });
    await sync([tx("s-3", -1, -2500, "SYNTHETIC HOSTING")]);
    const hosting = (await fedIds()).find((r) => /HOSTING/i.test(r.memo))!.id;
    const swapped = await agrees("swap");
    check(
      "swap: same count, new fingerprint, later newest_at",
      swapped.actionable_drafts.count === 2 &&
        swapped.actionable_drafts.fingerprint === fingerprintOf([software, hosting]) &&
        swapped.actionable_drafts.newest_at! > reverted.actionable_drafts.newest_at!,
      { swapped: swapped.actionable_drafts, reverted: reverted.actionable_drafts },
    );

    // ---- Drafts that are not work, and rows that never need a contact.
    const draft = async (date: string, memo: string, lines: [string, string][], extra: Json = {}) =>
      (
        await owner({
          type: "draft.save",
          id: randomUUID(),
          expected_version: 0,
          entry_date: date,
          memo,
          lines: lines.map(([id, cents]) => ({ account_id: id, amount_cents: cents })),
          ...extra,
        })
      ).id as string;
    const settled = await draft(day(-1), "Owner categorized", [[account(1), "-700"], [account(6), "700"]]);
    const sweep = await draft(day(-1), "Sweep to savings", [[account(9), "20000"], [account(1), "-20000"]], { kind: "transfer" });
    const loose = await draft(day(-1), "Typed by hand", [[account(1), "-300"], [uncategorizedExpense, "300"]]);
    const notWork = await agrees("not work");
    check(
      "not work: a categorized draft and a transfer leave the queue alone; an uncategorized one joins",
      notWork.actionable_drafts.count === 3 && notWork.actionable_drafts.fingerprint === fingerprintOf([software, hosting, loose]),
      notWork.actionable_drafts,
    );
    check("not work: the categorized draft still needs a contact, the transfer never does", notWork.contacts_needed.count === swapped.contacts_needed.count + 2, { notWork, swapped, settled, sweep });
    await owner({ type: "draft.discard", id: loose, expected_version: await versionOf(loose), reason: "Duplicate" });
    const discarded = await agrees("discarded");
    check("discarded: it leaves the queue and the contacts count", discarded.actionable_drafts.fingerprint === swapped.actionable_drafts.fingerprint && discarded.contacts_needed.count === notWork.contacts_needed.count - 1, discarded);

    // ---- Contacts: 30 days back, reversed pairs left out.
    const old = await draft(day(-45), "Old charge", [[account(1), "-900"], [account(6), "900"]]);
    await owner({ type: "entry.post", id: old, expected_version: await versionOf(old) });
    const wrong = await draft(day(-5), "Wrong charge", [[account(1), "-400"], [account(6), "400"]]);
    await owner({ type: "entry.post", id: wrong, expected_version: await versionOf(wrong) });
    await owner({ type: "entry.reverse", id: wrong, expected_version: await versionOf(wrong), reason: "Test reversal", entry_date: day(-5) });
    const windowed = await agrees("window");
    check("window: older than 30 days and reversed pairs do not count", windowed.contacts_needed.count === discarded.contacts_needed.count, { windowed, discarded });

    // ---- Through the API: the revision read carries the signal.
    await superuser();
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [AGENT]);
    await asOwner();
    const agentId = (
      await db.query<{ id: string }>("INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Alex','alex@agents.test','agent') RETURNING id", [AGENT])
    ).rows[0].id;
    await superuser();
    const secret = `vmfin_${randomUUID().replaceAll("-", "")}`;
    await db.query("INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,created_by,scopes) VALUES('k',$1,$2,$3,$3,$4)", [
      secret.slice(0, 14),
      sha(secret),
      agentId,
      ["accounting.read"],
    ]);
    await db.exec("BEGIN; SET LOCAL ROLE service_role;");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    let api: Json = {};
    try {
      api = (await db.query<{ r: Json }>("SELECT public.api_accounting($1,'revision','{}') r", [sha(secret)])).rows[0].r;
    } finally {
      await db.exec("COMMIT;");
    }
    const latest = await signal();
    check("api: revision unchanged in name and value", api.revision === (await revision()), api);
    check(
      "api: the work signal rides along",
      JSON.stringify(api.actionable_drafts) === JSON.stringify(latest.actionable_drafts) && JSON.stringify(api.contacts_needed) === JSON.stringify(latest.contacts_needed),
      { api, latest },
    );
    check("api: nothing else in the answer", Object.keys(api).sort().join() === "actionable_drafts,contacts_needed,revision", Object.keys(api));

    // ---- The reader check, and the indexes the queries can use.
    await db.exec("RESET ROLE; SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [randomUUID()]);
    const stranger = await db.query("SELECT accounting.work_signal()").then(
      () => "",
      (e: Error) => e.message,
    );
    check("reader check: a stranger is refused", /ACCT_FORBIDDEN|permission denied/.test(stranger), stranger);
    await superuser();
    await db.exec("SET enable_seqscan = off;");
    try {
      const plan = async (sql: string) => (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      const reversals = await plan("SELECT 1 FROM accounting.journal_entries re WHERE re.reverses_entry_id='00000000-0000-4000-8000-000000000000'");
      check("index: reversed pairs are found through entries_reverses", reversals.includes("entries_reverses"), reversals);
      const drafts = await plan("SELECT id FROM accounting.journal_entries WHERE status='draft'");
      check("index: the draft queue reads entries_review", drafts.includes("entries_review"), drafts);
      const recent = await plan(`SELECT id FROM accounting.journal_entries WHERE entry_date>='${day(-30)}' AND payee_id IS NULL`);
      check("index: recent rows read entries_date", recent.includes("entries_date"), recent);
      const lines = await plan("SELECT 1 FROM accounting.journal_lines WHERE entry_id='00000000-0000-4000-8000-000000000000'");
      check("index: an entry's lines read by entry", /journal_lines_entry_id_sort_order_key/.test(lines), lines);
    } finally {
      await db.exec("RESET enable_seqscan;");
    }
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`Work signal: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else console.log(`Work signal: ${passed} checks passed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
