/**
 * The books side of the agent finance tools, in SQL on the pglite fixture:
 * the register's kind and transfer filters and totals over every match,
 * contacts' first and last dates and money in and out, the balance history
 * sync_server keeps, the reconciliation (gap and since when), the attention
 * list (alerts, stable ids), and missed.create, the one API write that may
 * touch a money account, with every guard it has.
 */
import { createHash, randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureAccounts, fixtureOwner, fixtureAccountId as account } from "../src/lib/accounting/fixtures";

const AGENT = "10000000-0000-4000-8000-0000000000d1";
const LIVE_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $function$`;
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 800)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQL answers are checked field by field
type Json = Record<string, any>;

/** Today and day arithmetic in the books time zone (the fixture keeps America/Phoenix). */
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date());
const day = (offset: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
/** Noon in Phoenix on that day, as the epoch seconds a feed reports. */
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
    const read = async (sql: string, params: unknown[] = []) => {
      await asOwner();
      return (await db.query<{ r: Json }>(sql, params)).rows[0].r;
    };
    /** A private books function (postgres only, as the API reaches it), still as the owner. */
    const privateRead = async (sql: string) => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
      return (await db.query<{ r: Json }>(sql)).rows[0].r;
    };
    const raw = async <T = Json>(sql: string, params: unknown[] = []) => {
      await superuser();
      return (await db.query<T>(sql, params)).rows;
    };
    /** Direct test-only edits (dates, descriptors) without the books' triggers. */
    const backdoor = async (sql: string, params: unknown[] = []) => {
      await superuser();
      await db.exec("SET session_replication_role = replica;");
      try {
        await db.query(sql, params);
      } finally {
        await db.exec("SET session_replication_role = origin;");
      }
    };
    /** A posted (or draft) entry by the owner. */
    const entry = async (date: string, memo: string, lines: [number, string][], extra: Json = {}, post = true) => {
      const saved = await owner({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo,
        lines: lines.map(([n, cents]) => ({ account_id: account(n), amount_cents: cents })),
        ...extra,
      });
      if (post) await owner({ type: "entry.post", id: saved.id, expected_version: saved.version });
      return saved.id as string;
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

    // ---- The register: kind and transfer filters, totals over every match.
    const vendor = randomUUID();
    await owner({ type: "party.save", id: vendor, expected_version: 0, name: "Figma", roles: ["vendor"] });
    const client = randomUUID();
    await owner({ type: "party.save", id: client, expected_version: 0, name: "Acme Client", roles: ["client"] });
    const software = await entry(day(-40), "Figma annual", [[6, "12000"], [1, "-12000"]], { kind: "expense", payee_id: vendor });
    await entry(day(-38), "Acme invoice", [[1, "50000"], [5, "-50000"]], { kind: "income", payee_id: client });
    await entry(day(-36), "Figma refund", [[1, "3000"], [6, "-3000"]], { kind: "refund", payee_id: vendor });
    const sweep = await entry(day(-35), "Sweep to savings", [[9, "20000"], [1, "-20000"]], { kind: "transfer" });
    const cardCharge = await entry(day(-30), "Card software", [[6, "971"], [3, "-971"]], { kind: "expense", payee_id: vendor });
    const range = { from: day(-60), to: today };
    const register = (filter: Json, page: Json = {}) => read("SELECT accounting.transactions($1,$2) r", [JSON.stringify({ ...range, ...filter }), JSON.stringify(page)]);

    const all = await register({}, { limit: 2 });
    check("totals: count covers every match, not the page", all.totals?.count === 5 && all.entries.length === 2 && all.total === 5, all.totals);
    check("totals: money in is the deposits and the refund", all.totals?.in_cents === "53000", all.totals);
    check("totals: money out is the purchase and the card charge", all.totals?.out_cents === "12971", all.totals);
    check("totals: net is in less out", all.totals?.net_cents === "40029", all.totals);
    check("totals: a two-account transfer counts but adds to neither side", all.totals?.without_bank_line === 1, all.totals);
    const refunds = await register({ kind: "refund" });
    check("kind: refund only", refunds.total === 1 && refunds.entries[0]?.memo === "Figma refund", refunds.total);
    const transfersOnly = await register({ transfers: "only" });
    check("transfers=only lists the sweep", transfersOnly.total === 1 && transfersOnly.entries[0]?.id === sweep, transfersOnly.total);
    const noTransfers = await register({ transfers: "exclude" });
    check("transfers=exclude leaves it out", noTransfers.total === 4 && noTransfers.totals.without_bank_line === 0, noTransfers.totals);
    const biggest = await register({ transfers: "exclude" }, { sort: "amount_desc", limit: 1 });
    check("sort=amount_desc puts the biggest first", biggest.entries[0]?.memo === "Acme invoice", biggest.entries[0]?.memo);
    const smallest = await register({}, { sort: "amount_asc", limit: 1 });
    check("sort=amount_asc puts the smallest first", smallest.entries[0]?.id === cardCharge, smallest.entries[0]?.memo);
    const oldest = await register({}, { sort: "date_asc", limit: 1 });
    check("sort=date_asc puts the oldest first", oldest.entries[0]?.id === software, oldest.entries[0]?.memo);
    const band = await register({ min_cents: "3000", max_cents: "12000" });
    check("min_cents and max_cents bound the size", band.total === 2 && band.totals.in_cents === "3000" && band.totals.out_cents === "12000", band.totals);
    const vendorRows = await register({ payee: vendor });
    check("totals follow the contact filter", vendorRows.totals.in_cents === "3000" && vendorRows.totals.out_cents === "12971", vendorRows.totals);
    const badKind = await read("SELECT accounting.transactions($1,'{}') r", [JSON.stringify({ kind: "bogus" })]).then(
      () => "",
      (e: Error) => e.message,
    );
    check("an unknown kind is refused", /ACCT_INVALID_FILTER/.test(badKind), badKind);
    const badTransfers = await read("SELECT accounting.transactions($1,'{}') r", [JSON.stringify({ transfers: "maybe" })]).then(
      () => "",
      (e: Error) => e.message,
    );
    check("an unknown transfers value is refused", /ACCT_INVALID_FILTER/.test(badTransfers), badTransfers);

    // ---- Contacts: first and last seen, money in and out, as the register adds them.
    const contacts = (await privateRead("SELECT accounting.payees_list() r")) as unknown as Json[];
    const figma = contacts.find((c) => c.id === vendor);
    check("contacts: first and last date", figma?.first_date === day(-40) && figma?.last_date === day(-30), figma);
    check("contacts: money in and out match the register's totals", figma?.in_cents === vendorRows.totals.in_cents && figma?.out_cents === vendorRows.totals.out_cents, figma);
    const acme = contacts.find((c) => c.id === client);
    check("contacts: a client's deposits are money in", acme?.in_cents === "50000" && acme?.out_cents === "0", acme);
    const reversed = await entry(day(-20), "Wrong charge", [[6, "500"], [1, "-500"]], { kind: "expense", payee_id: vendor });
    await owner({ type: "entry.reverse", id: reversed, expected_version: (await raw<{ version: number }>("SELECT version FROM accounting.journal_entries WHERE id=$1", [reversed]))[0].version, reason: "Test reversal", entry_date: day(-20) });
    const afterReverse = ((await privateRead("SELECT accounting.payees_list() r")) as unknown as Json[]).find((c) => c.id === vendor);
    const reversedPair = (await raw<{ n: number }>("SELECT count(*)::int n FROM accounting.journal_entries WHERE reverses_entry_id=$1", [reversed]))[0].n;
    check(
      "contacts: a reversed pair leaves the totals and dates as the register shows them",
      reversedPair === 1 && afterReverse?.out_cents === "12971" && afterReverse?.last_date === day(-30),
      { afterReverse, reversedPair },
    );

    // ---- A card feed, its balance history, and the reconciliation.
    const connection = randomUUID(),
      cardFeed = randomUUID();
    await owner({ type: "feed.claim", id: connection, name: "Synthetic Amex", access_url_encrypted: "synthetic-encrypted-access", expected_version: 0 });
    await owner({
      type: "feed.map",
      id: cardFeed,
      expected_version: 0,
      account_id: account(3),
      connection_id: connection,
      provider_account_id: '["synthetic", "card"]',
      coverage_from: day(-90),
    });
    const sync = async (balance: string, at: number) => {
      const run = randomUUID();
      await db.exec("RESET ROLE; SET ROLE service_role");
      try {
        await db.query("SELECT accounting.sync_server($1)", [JSON.stringify({ id: connection, run_id: run, action: "lease" })]);
        await db.query("SELECT accounting.sync_server($1)", [
          JSON.stringify({
            id: connection,
            run_id: run,
            action: "complete",
            discovery: true,
            accounts: [
              { provider_connection_id: "synthetic", provider_account_id: "card", currency: "USD", name: "Synthetic card", institution: "Synthetic", balance_cents: balance, balance_at: at, complete: true, transactions: [] },
            ],
          }),
        ]);
      } finally {
        await db.exec("RESET ROLE; SET ROLE authenticated");
      }
    };
    // The books owe 971 on the card from day -30. The bank agrees on day -8,
    // then reports 971 more owed from day -4: a charge the feed never sent.
    await sync("-971", noon(-8));
    let recon = await read("SELECT accounting.reconciliation_status($1) r", [JSON.stringify({ account: account(3) })]);
    let card = recon.accounts[0];
    check("reconciliation: a matching card shows no gap", card?.gap_cents === "0" && card?.off_since === null && card?.status === "ok", card);
    check("reconciliation: card amounts are owed-positive", card?.book_cents === "971" && card?.bank_cents === "971", card);
    await sync("-1942", noon(-4));
    await sync("-1942", noon(-2));
    const history = await raw<{ balance_cents: string; observed_at: Date }>("SELECT balance_cents::text, observed_at FROM accounting.balance_observations WHERE bank_account_id=$1 ORDER BY observed_at", [cardFeed]);
    check("sync_server: every reported balance is kept", history.length === 3 && history.map((h) => h.balance_cents).join() === "-971,-1942,-1942", history);
    await sync("-1942", noon(-2));
    check("sync_server: the same report again adds no row", (await raw("SELECT 1 FROM accounting.balance_observations WHERE bank_account_id=$1", [cardFeed])).length === 3);
    recon = await read("SELECT accounting.reconciliation_status($1) r", [JSON.stringify({ account: account(3) })]);
    card = recon.accounts[0];
    check("reconciliation: the gap is books minus bank, owed-positive", card?.gap_cents === "-971" && card?.status === "gap", card);
    check("reconciliation: off since the first report that disagreed", Date.parse(card?.off_since) === noon(-4) * 1000, card?.off_since);
    check("reconciliation: the feed is named and not stale", card?.feed?.connection === "Synthetic Amex" && card?.feed?.stale === false, card?.feed);
    const everything = await read("SELECT accounting.reconciliation_status('{}') r");
    const checking = everything.accounts.find((a: Json) => a.account.id === account(1));
    check("reconciliation: every money account, unmapped ones as no_feed", everything.accounts.length === 6 && everything.accounts.filter((a: Json) => a.status === "no_feed").length === 5 && checking?.status === "no_feed" && checking?.bank_cents === null && checking?.gap_cents === null, everything.accounts.map((a: Json) => a.status));
    check("reconciliation: book balances, working and posted", checking?.book_cents === "21000" && checking?.book_posted_cents === "21000", checking);
    const notMoney = await read("SELECT accounting.reconciliation_status($1) r", [JSON.stringify({ account: account(6) })]).then(
      () => "",
      (e: Error) => e.message,
    );
    check("reconciliation: a category is not a money account", /ACCT_NOT_FOUND/.test(notMoney), notMoney);
    const offSince = (await raw<{ t: Date | null }>("SELECT accounting.balance_off_since($1) t", [cardFeed]))[0].t;
    check("balance_off_since agrees", offSince?.getTime() === noon(-4) * 1000, offSince);

    // ---- Attention.
    const first = await read("SELECT accounting.attention('{}') r");
    const gapItem = first.items.find((i: Json) => i.kind === "recon_gap");
    check("attention: a gap older than a day is an alert", first.alert === true && gapItem?.severity === "alert" && gapItem?.amount_cents === "-971", first);
    check("attention: the gap item names the account and suggests a missed transaction", /Business card/.test(gapItem?.title) && /missed/.test(gapItem?.detail), gapItem);
    const second = await read("SELECT accounting.attention('{}') r");
    check("attention: the same issue keeps its id", second.items.find((i: Json) => i.kind === "recon_gap")?.id === gapItem?.id && /^[0-9a-f]{16}$/.test(gapItem?.id ?? ""), second.items);
    const alertsOnly = await read("SELECT accounting.attention($1) r", [JSON.stringify({ include_info: false })]);
    check("attention: include_info=false leaves only alerts", alertsOnly.items.every((i: Json) => i.severity === "alert") && alertsOnly.counts.info >= 0, alertsOnly.items);

    // ---- missed.create, through the API's write entry point.
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
      hash(secret),
      agentId,
      ["accounting.read", "accounting.draft"],
    ]);
    const write = async (operation: string, idem: string, args: Json) => {
      await superuser();
      await db.exec("BEGIN; SET LOCAL ROLE service_role;");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      try {
        const result = await db.query<{ r: Json }>("SELECT public.api_books_command($1,$2,$3,$4) r", [hash(secret), operation, idem, JSON.stringify(args)]);
        await db.exec("COMMIT;");
        return { r: result.rows[0].r, error: "" };
      } catch (e) {
        await db.exec("ROLLBACK;");
        return { r: {} as Json, error: (e as Error).message };
      }
    };
    const missed = (args: Json, idem = randomUUID()) =>
      write("missed.create", idem, { bank_account_id: account(3), entry_date: day(-5), amount_cents: "-971", description: "OPENAI CHATGPT", account_id: account(6), ...args });
    const entriesOn = async () => (await raw<{ n: number }>("SELECT count(*)::int n FROM accounting.journal_lines WHERE account_id=$1", [account(3)]))[0].n;
    const before = await entriesOn();

    const exceeds = await missed({ amount_cents: "-1000" });
    check("missed: more than the gap is refused", /API_MISSED_EXCEEDS_GAP/.test(exceeds.error) && /"closes_with_cents": "-971"/.test(exceeds.error), exceeds.error);
    const wrongWay = await missed({ amount_cents: "971" });
    check("missed: the direction that widens the gap is refused", /API_MISSED_WRONG_DIRECTION/.test(wrongWay.error), wrongWay.error);
    const duplicate = await missed({ entry_date: day(-25) });
    check("missed: the same amount within 10 days is a likely duplicate, naming it", /API_MISSED_DUPLICATE/.test(duplicate.error) && duplicate.error.includes(cardCharge), duplicate.error);
    const noGap = await missed({ bank_account_id: account(1), amount_cents: "-500" });
    check("missed: no gap, no missed transaction", /API_MISSED_NO_GAP/.test(noGap.error), noGap.error);
    const afterBalance = await missed({ entry_date: today });
    check("missed: a date after the bank's balance is refused", /API_MISSED_AFTER_BALANCE/.test(afterBalance.error), afterBalance.error);
    const future = await missed({ entry_date: day(3) });
    check("missed: a future date is refused", /API_MISSED_DATE/.test(future.error), future.error);
    const notCategory = await missed({ account_id: account(1) });
    check("missed: the category cannot be a money account", /API_INVALID_INPUT/.test(notCategory.error), notCategory.error);
    const notBank = await missed({ bank_account_id: account(6) });
    check("missed: the account must be a bank, card or cash account", /API_INVALID_INPUT/.test(notBank.error), notBank.error);
    check("missed: refusals wrote nothing", (await entriesOn()) === before);

    // The audit check rolls back anything beyond the one draft and its lines.
    await superuser();
    await db.exec(`CREATE FUNCTION public.test_sneak() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
      BEGIN IF NEW.memo LIKE 'SNEAK%' THEN UPDATE accounting.journal_entries SET memo=memo||' (touched)' WHERE id='${sweep}'::uuid; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_sneak AFTER INSERT ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION public.test_sneak();`);
    const sneak = await missed({ description: "SNEAK CHARGE" });
    check("missed: touching any other entry rolls the whole command back", /API_DRAFTS_ONLY/.test(sneak.error) && (await entriesOn()) === before, sneak.error);
    await superuser();
    await db.exec("DROP TRIGGER test_sneak ON accounting.journal_entries; DROP FUNCTION public.test_sneak();");

    // Other draft commands still cannot write a money account line.
    const noCash = await write("draft.create", randomUUID(), {
      entry_date: day(-5),
      memo: "Sneaky card charge",
      lines: [
        { account_id: account(6), amount_cents: "971" },
        { account_id: account(3), amount_cents: "-971" },
      ],
    });
    check("draft.create still refuses a card line", /API_DRAFTS_NO_CASH/.test(noCash.error), noCash.error);

    const idem = randomUUID();
    const added = await missed({ contact_id: undefined, payee_id: vendor, note: "Owner said ChatGPT charged twice" }, idem);
    check("missed: within the gap it becomes a draft", !added.error && typeof added.r.id === "string", added.error);
    const draft = (await raw<Json>("SELECT status, origin, kind, memo, reason, source_description, payee_id FROM accounting.journal_entries WHERE id=$1", [added.r.id]))[0];
    check("missed: a draft, never posted, origin manual", draft?.status === "draft" && draft?.origin === "manual" && draft?.kind === "expense", draft);
    check("missed: tagged for the owner with the agent's name", /missed by the bank feed, added by Alex/.test(draft?.memo) && /^Added by Alex: missed by bank feed\. Owner said/.test(draft?.reason) && draft?.source_description === "OPENAI CHATGPT", draft);
    check("missed: it names the contact", draft?.payee_id === vendor, draft);
    const lines = await raw<{ account_id: string; amount_cents: string }>("SELECT account_id, amount_cents::text FROM accounting.journal_lines WHERE entry_id=$1 ORDER BY sort_order", [added.r.id]);
    check("missed: two lines, the card and the category", lines.length === 2 && lines[0].account_id === account(3) && lines[0].amount_cents === "-971" && lines[1].account_id === account(6) && lines[1].amount_cents === "971", lines);
    const replay = await missed({ contact_id: undefined, payee_id: vendor, note: "Owner said ChatGPT charged twice" }, idem);
    check("missed: a retry with the same key replays without rechecking", replay.r.id === added.r.id && !replay.error, replay.error);
    card = (await read("SELECT accounting.reconciliation_status($1) r", [JSON.stringify({ account: account(3) })])).accounts[0];
    check("missed: the gap closes in working mode", card?.gap_cents === "0" && card?.off_since === null && card?.status === "ok", card);
    check("missed: the posted balance does not move until the owner reviews", card?.book_posted_cents === "971" && card?.book_cents === "1942", card);
    const again = await missed({ entry_date: day(-12) });
    check("missed: once the gap is closed nothing more is accepted", /API_MISSED_NO_GAP/.test(again.error), again.error);
    const audited = await raw<{ actor_kind: string }>("SELECT DISTINCT actor_kind FROM accounting.audit_log WHERE row_id=$1", [added.r.id]);
    check("missed: audited as the API", audited.length === 1 && audited[0].actor_kind === "api", audited);
    const calm = await read("SELECT accounting.attention('{}') r");
    check("attention: with the gap closed there is no recon alert", !calm.items.some((i: Json) => i.kind === "recon_gap") && calm.alert === false, calm.items);
    check("attention: the new draft shows in the review backlog", calm.items.some((i: Json) => i.kind === "review_backlog" && i.severity === "info"), calm.items);

    // A feed silent for over a day, a big transaction waiting two days, a duplicate charge.
    await backdoor("UPDATE accounting.bank_connections SET created_at=now()-interval '3 days' WHERE id=$1", [connection]);
    const big = await entry(day(-6), "Server purchase", [[6, "150000"], [1, "-150000"]], { kind: "expense" }, false);
    await backdoor("UPDATE accounting.journal_entries SET created_at=now()-interval '3 days' WHERE id=$1", [big]);
    const dupA = await entry(day(-9), "NOTION LABS", [[6, "1600"], [1, "-1600"]], { kind: "expense" });
    const dupB = await entry(day(-7), "NOTION LABS", [[6, "1600"], [1, "-1600"]], { kind: "expense" });
    await backdoor("UPDATE accounting.journal_entries SET descriptor_key='NOTION LABS' WHERE id IN ($1,$2)", [dupA, dupB]);
    const busy = await read("SELECT accounting.attention('{}') r");
    const kinds = (severity: string) => busy.items.filter((i: Json) => i.severity === severity).map((i: Json) => i.kind).sort();
    check("attention: feed down, large unreviewed and duplicate are alerts", busy.alert === true && ["feed_down", "large_unreviewed", "possible_duplicate"].every((k) => kinds("alert").includes(k)), kinds("alert"));
    check("attention: counts agree with the items", busy.counts.alert === kinds("alert").length && busy.counts.info === kinds("info").length, busy.counts);
    const dupItem = busy.items.find((i: Json) => i.kind === "possible_duplicate");
    check("attention: the duplicate links to the later charge", dupItem?.link === `/accounting?view=journal&entry=${dupB}` && dupItem?.amount_cents === "-1600", dupItem);
    const bigItem = busy.items.find((i: Json) => i.kind === "large_unreviewed");
    check("attention: the large item carries its amount and link", bigItem?.amount_cents === "-150000" && bigItem?.link?.endsWith(big), bigItem);
    const stale = (await read("SELECT accounting.reconciliation_status($1) r", [JSON.stringify({ account: account(3) })])).accounts[0];
    check("reconciliation: a feed silent for a day is stale_feed", stale?.status === "stale_feed" && stale?.feed?.stale === true, stale);
    const busyAgain = await read("SELECT accounting.attention('{}') r");
    check(
      "attention: every id is stable across checks",
      JSON.stringify(busy.items.map((i: Json) => i.id).sort()) === JSON.stringify(busyAgain.items.map((i: Json) => i.id).sort()),
    );

    // Reads need the books' reader check.
    await db.exec("RESET ROLE; SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [randomUUID()]);
    const stranger = await db.query("SELECT accounting.attention('{}')").then(
      () => "",
      (e: Error) => e.message,
    );
    check("attention: a stranger is refused", /ACCT_FORBIDDEN|permission denied/.test(stranger), stranger);
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`Agent tools (books): ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else console.log(`Agent tools (books): ${passed} checks passed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
