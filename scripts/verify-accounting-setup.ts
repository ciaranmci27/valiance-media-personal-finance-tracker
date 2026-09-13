/**
 * The setup guide: the ordered step list built from feed state and the
 * year's counts, the rule that every step is provable or acknowledgeable,
 * and the SQL read and command behind it. Run with `--canonical` to build
 * the database from schema.sql instead of the migrations.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import type {
  FeedConnection,
  FeedData,
  FeedIdentity,
} from "../src/lib/accounting/feeds";
import {
  buildSetupGuide,
  claimGuide,
  type SetupStatus,
} from "../src/lib/accounting/setup-guide";

let n = 0;
const check = (label: string, ok: boolean) => {
  assert.ok(ok, label);
  n++;
};

// ---------------------------------------------------------------------------
// Pure builder

const clean: SetupStatus = {
  year: 2026,
  through: "2026-09-12",
  revision: "7",
  primary_system: "admin",
  acknowledged: {},
  accounts_total: 51,
  missing_purposes: [],
  profile: {
    legal_name: "Valiance Media LLC",
    entity_type: "llc",
    classification: "s_corp",
    since: null,
    timezone: "America/Phoenix",
    history_start: "2022-12-31",
  },
  unmapped_accounts: 0,
  runs_without_register: 0,
};

const connection = (patch: Partial<FeedConnection>): FeedConnection => ({
  id: "conn-1",
  name: "Mercury",
  status: "active",
  version: 1,
  scheduled: true,
  next_sync_at: null,
  last_success_at: null,
  last_error: "",
  lease_until: null,
  ...patch,
});

const identity = (patch: Partial<FeedIdentity>): FeedIdentity => ({
  id: "ident-1",
  connection_id: "conn-1",
  provider_connection_id: "p-conn",
  provider_account_id: "p-acct",
  name: "Checking",
  institution: "Mercury",
  currency: "USD",
  ownership: "unreviewed",
  version: 1,
  feed_account_id: null,
  last_seen_at: "2026-09-12T00:00:00Z",
  account: null,
  balance: null,
  ...patch,
});

const feeds = (patch: Partial<FeedData> = {}): FeedData => ({
  owner_id: "owner",
  connections: [connection({})],
  accounts: [],
  identities: [],
  runs: [],
  queue: [],
  ...patch,
});

const status = (patch: Partial<SetupStatus>): SetupStatus => ({ ...clean, ...patch });
const keys = (data: { steps: { key: string }[] }) => data.steps.map((s) => s.key);
const openKeys = (data: { steps: { key: string; acknowledged?: unknown }[] }) =>
  data.steps.filter((s) => !s.acknowledged).map((s) => s.key);

{
  const out = buildSetupGuide({ year: 2026, feeds: feeds(), status: clean });
  check("a configured install has only the business details left to confirm", JSON.stringify(keys(out)) === JSON.stringify(["profile"]));
  const profile = out.steps[0];
  check("the profile step is acknowledgeable, not provable, and its answer is about these values", /^profile:[a-z0-9]{1,16}$/.test(profile.acknowledge?.key ?? "") && profile.acknowledge?.label === "Looks right" && profile.level === "warning");
  check("the profile step reads back the seeded values in words", /Valiance Media LLC, an LLC taxed as an S-Corp, books in America\/Phoenix from Dec 31, 2022\./.test(profile.detail));
  check("the profile step links to Business settings", profile.action.target.kind === "link" && profile.action.target.href === "/settings/business");
  check("an election with no start year is called out, since it would apply to every year", /Set the year the S-Corp election took effect; until then every year is taxed that way\./.test(profile.detail));
  check("the cutoff the counts cover is passed through", out.through === "2026-09-12");
}
const profileKey = buildSetupGuide({ year: 2026, feeds: feeds(), status: clean }).steps[0].acknowledge!.key;
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds(),
    status: status({ acknowledged: { [profileKey]: { at: "2026-09-12T18:00:00Z" } } }),
  });
  check("an acknowledged step stays in the list, marked done", out.steps.length === 1 && out.steps[0].acknowledged?.at === "2026-09-12T18:00:00Z");
  check("nothing open once everything is acknowledged", openKeys(out).length === 0);
}
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds(),
    status: status({
      profile: { ...clean.profile!, legal_name: "Valiance Media Inc" },
      acknowledged: { [profileKey]: { at: "2026-09-12T18:00:00Z" } },
    }),
  });
  check("changing a business detail re-asks", openKeys(out).includes("profile") && out.steps[0].acknowledge!.key !== profileKey);
  check("and says why", /These changed since you last confirmed them\./.test(out.steps[0].detail));
  const fresh = buildSetupGuide({ year: 2026, feeds: feeds(), status: status({ profile: { ...clean.profile!, legal_name: "Valiance Media Inc" } }) });
  check("a first ask never claims anything changed", !/changed since/.test(fresh.steps[0].detail));
}
{
  const one = buildSetupGuide({
    year: 2026,
    feeds: feeds({ identities: [identity({})], accounts: [{ id: "fa-1" } as FeedData["accounts"][number]] }),
    status: clean,
  });
  const leftKey = one.steps.find((s) => s.key === "mapping-partial")!.acknowledge!.key;
  const two = buildSetupGuide({
    year: 2026,
    feeds: feeds({ identities: [identity({}), identity({ id: "ident-2" })], accounts: [{ id: "fa-1" } as FeedData["accounts"][number]] }),
    status: status({ acknowledged: { [leftKey]: { at: "2026-09-12T18:00:00Z" } } }),
  });
  const partial = two.steps.find((s) => s.key === "mapping-partial")!;
  check("a newly discovered account re-asks about the accounts left alone", !partial.acknowledged && /New accounts were discovered since you last looked\./.test(partial.detail));
  const same = buildSetupGuide({
    year: 2026,
    feeds: feeds({ identities: [identity({})], accounts: [{ id: "fa-1" } as FeedData["accounts"][number]] }),
    status: status({ acknowledged: { [leftKey]: { at: "2026-09-12T18:00:00Z" } } }),
  });
  check("the same accounts stay left alone", !!same.steps.find((s) => s.key === "mapping-partial")!.acknowledged);
}
{
  const first = buildSetupGuide({ year: 2026, feeds: feeds({ connections: [connection({ last_error: "SimpleFIN timed out" })] }), status: clean });
  const dismissKey = first.steps.find((s) => s.key === "sync:conn-1")!.acknowledge!.key;
  const again = buildSetupGuide({ year: 2026, feeds: feeds({ connections: [connection({ last_error: "SimpleFIN timed out" })] }), status: status({ acknowledged: { [dismissKey]: { at: "2026-09-12T18:00:00Z" } } }) });
  check("the same sync error stays dismissed", !!again.steps.find((s) => s.key === "sync:conn-1")!.acknowledged);
  const other = buildSetupGuide({ year: 2026, feeds: feeds({ connections: [connection({ last_error: "Provider records changed." })] }), status: status({ acknowledged: { [dismissKey]: { at: "2026-09-12T18:00:00Z" } } }) });
  const sync = other.steps.find((s) => s.key === "sync:conn-1")!;
  check("a different sync error re-asks and says so", !sync.acknowledged && /The error changed since you dismissed it\./.test(sync.detail));
}
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds(),
    status: status({ acknowledged: { "treatments:2025": { at: "2026-01-01T00:00:00Z" }, stray: { at: "x" } } }),
  });
  check("acknowledgements for other years or unknown keys are ignored", openKeys(out).includes("profile"));
}
{
  const out = buildSetupGuide({ year: 2026, feeds: feeds(), status: status({ accounts_total: 0, missing_purposes: ["uncategorized_income", "uncategorized_expense", "transfers_in_transit"] }) });
  check("an empty chart comes first and cannot be acknowledged", out.steps[0].key === "chart" && out.steps[0].level === "critical" && !out.steps[0].acknowledge);
  check("an empty chart hides the purposes step, which would say the same thing", !keys(out).includes("system-accounts"));
  check("the chart step links to Accounts", out.steps[0].action.target.kind === "link" && out.steps[0].action.target.href === "/accounting?view=accounts");
}
{
  const out = buildSetupGuide({ year: 2026, feeds: feeds(), status: status({ missing_purposes: ["uncategorized_income", "transfers_in_transit"] }) });
  check("missing purposes are named in the owner's words", out.steps[0].key === "system-accounts" && /need an Uncategorized income account and a Transfers in transit account\./.test(out.steps[0].detail) && /expand Advanced and pick its purpose/.test(out.steps[0].detail));
}
{
  const out = buildSetupGuide({ year: 2026, feeds: feeds({ connections: [] }), status: clean });
  const connect = out.steps.find((s) => s.key === "connect")!;
  check("no bank connection at all asks for one, and can be declined", connect && connect.level === "warning" && connect.acknowledge?.label === "Not using bank feeds" && connect.action.target.kind === "link" && connect.action.target.href === "/accounting?view=settings&section=feeds");
  check("the profile comes before connecting a bank", keys(out).indexOf("profile") < keys(out).indexOf("connect"));
}
{
  const out = buildSetupGuide({ year: 2026, feeds: null, status: clean });
  check("without a feeds read there is no bank step either way", !keys(out).includes("connect"));
}
{
  const out = buildSetupGuide({
    year: 2025,
    feeds: feeds(),
    status: status({ year: 2025, through: "2025-12-31", profile: { ...clean.profile!, since: 2026 } }),
  });
  check("an election that starts after the year is spelled out on the profile step", /the S-Corp election starts in 2026, after 2025\./.test(out.steps[0].detail) && !/took effect/.test(out.steps[0].detail));
}
{
  const everything = buildSetupGuide({
    year: 2026,
    feeds: feeds({
      connections: [
        connection({ id: "c-bad", name: "Chase", status: "reconnect_required" }),
        connection({ id: "c-sync", name: "Mercury", last_error: "SimpleFIN timed out" }),
      ],
      identities: [identity({ connection_id: "c-sync" })],
    }),
    status: status({
      primary_system: "wave",
      missing_purposes: ["transfers_in_transit"],
      unmapped_accounts: 18,
      runs_without_register: 2,
    }),
  });
  check(
    "every step, in the fixed priority order",
    JSON.stringify(keys(everything)) ===
      JSON.stringify([
        "system-accounts",
        "profile",
        "reconnect:c-bad",
        "mapping",
        "sync:c-sync",
        "primary",
        "treatments",
        "payroll-registers",
      ]),
  );
  check(
    "levels follow the step",
    everything.steps.map((s) => s.level).join(",") ===
      "critical,warning,critical,critical,warning,info,warning,info",
  );
  check(
    "every step is provable or acknowledgeable: critical ones clear from data, the rest carry an answer",
    everything.steps.every((s) => (s.level === "critical") === !s.acknowledge),
  );
  const ack = Object.fromEntries(everything.steps.filter((s) => s.acknowledge).map((s) => [s.key, s.acknowledge!]));
  check("year-scoped steps acknowledge for the year only", ack.treatments.key === "treatments:2026" && ack["payroll-registers"].key === "payroll-registers:2026");
  check("per-connection steps acknowledge per connection and per error", /^sync-c-sync:[a-z0-9]{1,16}$/.test(ack["sync:c-sync"].key) && ack["sync:c-sync"].label === "Dismiss");
  check("keeping Wave is an answer for the year", ack.primary.key === "primary:2026");
  check("every acknowledgement key fits the vocabulary the command accepts", Object.values(ack).every((a) => /^[a-z][a-z0-9-]*(:[a-z0-9]{1,16})?$/.test(a.key)));
  check("the answers are in the owner's words", ack.primary.label === "Keep Wave for now" && ack.treatments.label === "Skip this year");
  const treatments = everything.steps.find((s) => s.key === "treatments")!;
  check("treatments step counts the accounts and opens the review", treatments.title === "Give 18 accounts a tax treatment for 2026" && treatments.action.target.kind === "treatments");
  const payroll = everything.steps.find((s) => s.key === "payroll-registers")!;
  check("payroll step asks for the registers, not a report that does not exist", payroll.title === "Attach the Patriot register to 2 payroll runs" && /Open each run on the Payroll screen/.test(payroll.detail) && payroll.action.target.kind === "link" && payroll.action.target.href === "/accounting?view=records&section=payroll");
  check("no step ever keys on an unclearable control", !keys(everything).some((k) => ["imports", "adjustments", "classification", "payroll"].includes(k)));
  check("no dashes in the copy", everything.steps.every((s) => !/\u2014/.test(s.title + s.detail)));
}
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds({ identities: [identity({}), identity({ id: "ident-2", institution: "Chase" })] }),
    status: clean,
  });
  const mapping = out.steps.find((s) => s.key === "mapping")!;
  check("nothing mapped yet makes mapping critical and names the institutions", mapping.level === "critical" && /from Mercury and Chase/.test(mapping.detail) && !mapping.acknowledge);
}
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds({ identities: [identity({})], accounts: [{ id: "fa-1" } as FeedData["accounts"][number]] }),
    status: clean,
  });
  const partial = out.steps.find((s) => s.key === "mapping-partial")!;
  check("a partial mapping is a warning the owner can leave", partial.level === "warning" && partial.acknowledge?.label === "Leave them" && /1 discovered account still needs a decision/.test(partial.title));
}
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds({ connections: [connection({ status: "disconnected" })], identities: [identity({})] }),
    status: clean,
  });
  check("identities on a connection that is not active are not a step", !keys(out).some((k) => k.startsWith("mapping")));
}
{
  const out = buildSetupGuide({
    year: 2026,
    feeds: feeds({
      connections: [
        connection({ last_error: "Discover and review the company account mappings for Mercury" }),
        connection({ id: "c-2", last_error: "   " }),
      ],
    }),
    status: clean,
  });
  check("the mapping reminder and blank errors are not sync failures", !keys(out).some((k) => k.startsWith("sync")));
}
{
  const claim = claimGuide(2026);
  check("before the owner row exists the guide says exactly one thing", claim.steps.length === 1 && claim.steps[0].key === "claim" && claim.steps[0].level === "critical" && claim.steps[0].action.target.kind === "link" && claim.steps[0].action.target.href === "/accounting");
}

// ---------------------------------------------------------------------------
// SQL read and command

async function sql() {
  const db = await accountingTestDb(
    process.argv.includes("--canonical") ? "canonical" : "migrations",
  );
  try {
    const year = new Date().getFullYear();
    const setup = async (y: number, cutoff?: string) =>
      (
        await db.query<{ r: SetupStatus }>(
          cutoff
            ? "SELECT accounting.setup_status($1::integer,$2::date) r"
            : "SELECT accounting.setup_status($1::integer) r",
          cutoff ? [y, cutoff] : [y],
        )
      ).rows[0].r;
    const cmd = async (command: object) =>
      (
        await db.query<{ r: Record<string, string> }>(
          "SELECT accounting.operate($1::jsonb) r",
          [JSON.stringify({ key: randomUUID(), command })],
        )
      ).rows[0].r;
    const fails = async (run: () => Promise<unknown>, pattern: RegExp) => {
      try {
        await run();
        return false;
      } catch (e) {
        return pattern.test((e as Error).message);
      }
    };

    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: [fixtureAccountId(1), fixtureAccountId(9)].includes(a.id)
          ? "bank"
          : a.id === fixtureAccountId(3)
            ? "card"
            : "none",
      });

    const before = await setup(year);
    check("the chart and its system purposes are reported", before.accounts_total > 0 && Array.isArray(before.missing_purposes) && before.missing_purposes.length === 0);
    check("the business profile is reported in full", before.profile?.legal_name === "Valiance Media LLC" && before.profile.entity_type === "llc" && before.profile.classification === "s_corp" && before.profile.since === null && before.profile.timezone === "America/Phoenix" && typeof before.profile.history_start === "string");
    check("a fresh install has acknowledged nothing", JSON.stringify(before.acknowledged) === "{}");
    check("an empty year has nothing unmapped and no runs", before.unmapped_accounts === 0 && before.runs_without_register === 0);
    check("the cutoff defaults to the books' today", before.through.startsWith(`${year}-`));
    check("the primary system is reported", before.primary_system === "wave" || before.primary_system === "admin");

    // Acknowledge, read back, reopen.
    const ackVersion = (await cmd({ type: "setup.acknowledge", id: randomUUID(), key: "profile:1a2b3c", acknowledged: true })).version;
    const acked = await setup(year);
    check("an acknowledgement lands on the books with a timestamp", typeof acked.acknowledged["profile:1a2b3c"]?.at === "string" && typeof acked.acknowledged["profile:1a2b3c"]?.by === "string");
    await db.exec("RESET ROLE");
    const settingsVersion = (await db.query<{ v: number }>("SELECT version v FROM accounting.settings WHERE id=1")).rows[0].v;
    await db.exec("SET ROLE authenticated");
    check("acknowledging does not bump the settings version the Book settings form holds", String(ackVersion) === String(settingsVersion));
    await cmd({ type: "setup.acknowledge", id: randomUUID(), key: `treatments:${year}`, acknowledged: true });
    await cmd({ type: "setup.acknowledge", id: randomUUID(), key: "sync-3f2a9c1d-0000-4000-8000-000000000000:9k2z", acknowledged: true });
    await cmd({ type: "setup.acknowledge", id: randomUUID(), key: "profile:1a2b3c", acknowledged: false });
    const reopened = await setup(year);
    check("reopening removes only that key", reopened.acknowledged["profile:1a2b3c"] === undefined && typeof reopened.acknowledged[`treatments:${year}`]?.at === "string");
    check("a per-connection key with a uuid is accepted", typeof reopened.acknowledged["sync-3f2a9c1d-0000-4000-8000-000000000000:9k2z"]?.at === "string");
    check("a key outside the vocabulary is refused", await fails(() => cmd({ type: "setup.acknowledge", id: randomUUID(), key: "DROP TABLE", acknowledged: true }), /ACCT_INVALID_COMMAND/));
    check("a missing answer is refused", await fails(() => cmd({ type: "setup.acknowledge", id: randomUUID(), key: "profile" }), /ACCT_INVALID_COMMAND/));
    check("a suffix outside the vocabulary is refused", await fails(() => cmd({ type: "setup.acknowledge", id: randomUUID(), key: "profile:ABC DEF", acknowledged: true }), /ACCT_INVALID_COMMAND/));

    // Post two entries that touch an income and an expense account.
    const posted: string[] = [];
    for (const [income, expense] of [
      [fixtureAccountId(5), null],
      [null, fixtureAccountId(6)],
    ] as const) {
      const id = randomUUID();
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: `${year}-01-02`,
        memo: "Setup guide fixture",
        lines: income
          ? [
              { account_id: fixtureAccountId(1), amount_cents: "12345" },
              { account_id: income, amount_cents: "-12345" },
            ]
          : [
              { account_id: expense, amount_cents: "5000" },
              { account_id: fixtureAccountId(1), amount_cents: "-5000" },
            ],
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
      posted.push(id);
    }

    const open = await setup(year);
    check("accounts with posted activity and no treatment are counted", open.unmapped_accounts === 2);
    const source = (
      await db.query<{ r: { unmapped_accounts: number } }>(
        "SELECT accounting.tax_source($1::integer,$2::date) r",
        [year, open.through],
      )
    ).rows[0].r;
    check("the count agrees with the tax workpapers read", source.unmapped_accounts === open.unmapped_accounts);
    const early = await setup(year, `${year}-01-01`);
    check("an explicit cutoff is honoured", early.through === `${year}-01-01` && early.unmapped_accounts === 0);

    for (const [account, concept, bps] of [
      [fixtureAccountId(5), "ordinary_income", 10000],
      [fixtureAccountId(6), "ordinary_expense", 10000],
    ] as const)
      await cmd({
        type: "tax.mapping",
        id: randomUUID(),
        year,
        expected_version: 0,
        document_id: null,
        reason: "Setup guide fixture",
        verified: true,
        account_id: account,
        concept,
        deductible_bps: bps,
      });
    check("mapping every active account clears the count", (await setup(year)).unmapped_accounts === 0);

    // Payroll: a posted run without its register counts; one with it does not.
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-register.pdf",
      mime_type: "application/pdf",
      size_bytes: "12",
      content_hash: "8".repeat(64),
    });
    await db.exec("RESET ROLE");
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)", [doc.storage_path]);
    await db.exec("SET ROLE authenticated");
    await cmd({ type: "document.complete", id: doc.id, expected_version: doc.version });
    await db.exec("RESET ROLE");
    const insertRun = (provider: string, entry: string, document: string | null) =>
      db.query(
        "INSERT INTO accounting.payroll_runs(provider_run_id,pay_date,period_start,period_end,gross_cents,net_cents,employee_withholding_cents,employer_tax_cents,components,status,entry_id,document_id,ytd) VALUES($1,$2,$2,$2,100000,80000,20000,5000,'[]','posted',$3,$4,'{\"verified\":false}')",
        [provider, `${year}-01-02`, entry, document],
      );
    await insertRun("SETUP-RUN-1", posted[0], null);
    await db.exec("SET ROLE authenticated");
    check("a posted run without its register is counted", (await setup(year)).runs_without_register === 1);
    await db.exec("RESET ROLE");
    await insertRun("SETUP-RUN-2", posted[1], doc.id);
    await db.exec("SET ROLE authenticated");
    check("a run with its register on file is not", (await setup(year)).runs_without_register === 1);

    check("a future year is out of range", await fails(() => setup(year + 1), /ACCT_TAX_RANGE/));
    check("a cutoff outside the year is out of range", await fails(() => setup(year, `${year - 1}-12-31`), /ACCT_TAX_RANGE/));

    await db.exec("RESET ROLE; SET ROLE anon");
    check("anonymous callers are refused", await fails(() => setup(year), /permission denied|ACCT_FORBIDDEN/));
  } finally {
    await db.close();
  }
}

sql()
  .then(() => console.log(`Setup guide: ${n} checks passed.`))
  .catch((e) => {
    console.error(e.message, e.stack);
    process.exitCode = 1;
  });
