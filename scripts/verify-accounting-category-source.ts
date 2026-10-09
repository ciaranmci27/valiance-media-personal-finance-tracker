import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
  fixtureOwner,
} from "../src/lib/accounting/fixtures";
import { categorySource } from "../src/lib/accounting/transactions";
import type { JournalEntry } from "../src/lib/accounting/contracts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MEMBER = "20000000-0000-4000-8000-0000000000d1";

/** The one-off history backfill lives only in its migration, between two markers; the suite runs that exact SQL. */
async function backfillSql() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = (await readdir(dir)).find((f) =>
    f.endsWith("_accounting_category_source.sql"),
  );
  assert.ok(file, "category source migration");
  const sql = (await readFile(new URL(file, dir), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const start = sql.indexOf("-- >>> category source backfill");
  const end = sql.indexOf("-- <<< category source backfill");
  assert.ok(start >= 0 && end > start, "backfill markers");
  return sql.slice(start, end);
}

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, note?: string) => {
    assert.deepEqual(actual, expected, note);
    checks++;
  };
  try {
    const cmd = async (c: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key: randomUUID(), command: c }),
        ])
      ).rows[0].r;
    const as = async (uid: string) => {
      await db.exec("RESET ROLE; SET ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
        uid,
      ]);
    };
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: [1, 9].some((n) => account(n) === a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      });
    const chart = (
      await db.query<{ r: any }>(
        "SELECT accounting.workspace('2026-01-01','2026-12-31','working') r",
      )
    ).rows[0].r.accounts as any[];
    const purpose = (p: string) =>
      chart.find((a) => (a.system_purpose ?? a.purpose) === p).id as string;
    const named = (n: string) => chart.find((a) => a.name === n).id as string;
    const software = named("Software");
    const office = named("Office expenses");
    const uncategorized = purpose("uncategorized_expense");

    // A second member who keeps the books with the owner.
    await db.exec("RESET ROLE");
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [MEMBER]);
    await db.query(
      "INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Sam Keeper','sam@fixture.test','admin')",
      [MEMBER],
    );
    await as(fixtureOwner);

    const connection = randomUUID();
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic bank",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    const feeds = {
      checking: account(1),
      card: account(3),
      savings: account(9),
    };
    for (const [name, id] of Object.entries(feeds))
      await cmd({
        type: "feed.map",
        id: randomUUID(),
        expected_version: 0,
        account_id: id,
        connection_id: connection,
        provider_account_id: JSON.stringify(["synthetic", name]).replace(
          ",",
          ", ",
        ),
        coverage_from: "2026-01-01",
        movement_sign: 1,
        institution: "Northwind",
        mask: id.slice(-4),
      });
    let serial = 0;
    /** One feed run as the worker: `[feed, date, cents, description]` per movement. */
    const sync = async (
      movements: [keyof typeof feeds, string, number, string][],
    ) => {
      await db.exec("RESET ROLE; SET ROLE service_role");
      const run = randomUUID();
      const call = async (c: any) =>
        (
          await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [
            JSON.stringify({ id: connection, run_id: run, ...c }),
          ])
        ).rows[0].r;
      assert.equal((await call({ action: "lease" })).acquired, true);
      await call({
        action: "complete",
        through: 1800000000,
        create_drafts: true,
        accounts: Object.keys(feeds).map((name) => ({
          provider_connection_id: "synthetic",
          provider_account_id: name,
          currency: "USD",
          name: `Synthetic ${name}`,
          institution: "Northwind",
          balance_cents: "10000",
          balance_at: Date.parse("2026-09-20T18:00:00Z") / 1000,
          complete: true,
          transactions: movements
            .filter((m) => m[0] === name)
            .map(([, date, cents, description]) => {
              serial++;
              return {
                external_id: `SRC-${serial}`,
                posted: Date.parse(`${date}T18:00:00Z`) / 1000,
                amount_cents: String(cents),
                description,
                state: "posted",
                hash: serial.toString(16).padStart(64, "0"),
                raw: { synthetic: true },
              };
            }),
        })),
      });
      await as(fixtureOwner);
    };
    const detail = async (id: string) =>
      (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
        .rows[0].r as JournalEntry & {
        category_source: string | null;
        category_actor: string | null;
        fill_source: string | null;
        version: number;
      };
    const bySource = async (description: string) => {
      const role = (await db.query<{ u: string }>("SELECT current_user u"))
        .rows[0].u;
      await db.exec("RESET ROLE");
      const found = (
        await db.query<{ id: string }>(
          "SELECT id FROM accounting.journal_entries WHERE source_description=$1 AND status<>'discarded'",
          [description],
        )
      ).rows;
      if (role !== "postgres") await db.exec(`SET ROLE ${role}`);
      assert.equal(found.length, 1, `one entry for ${description}`);
      return detail(found[0].id);
    };
    const source = (e: any) => [e.category_source, e.category_actor];
    const manual = (memo: string, cents: number, category: string) => ({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-06-02",
      memo,
      lines: [
        { account_id: feeds.checking, amount_cents: String(-cents), memo: "" },
        { account_id: category, amount_cents: String(cents), memo: "" },
      ],
    });

    // 1. A person in the browser: the owner's category is theirs, and only a changed category moves it.
    const draft = manual("Desk lamp", 4321, software);
    let saved = await cmd(draft);
    let e = await detail(saved.id);
    check(source(e), ["person", fixtureOwner]);
    check(e.categorized_by, {
      source: "person",
      self: true,
      actor_name: "Fixture Owner",
      actor_role: "owner",
    });
    await as(MEMBER);
    saved = await cmd({
      ...draft,
      type: "transaction.save",
      expected_version: saved.version,
      memo: "Desk lamp for the studio",
    });
    check(
      source(await detail(saved.id)),
      ["person", fixtureOwner],
      "same lines keep the source",
    );
    saved = await cmd({
      type: "entry.categorize",
      id: saved.id,
      expected_version: saved.version,
      account_id: office,
    });
    await as(fixtureOwner);
    e = await detail(saved.id);
    check(source(e), ["person", MEMBER]);
    check(e.categorized_by, {
      source: "person",
      self: false,
      actor_name: "Sam Keeper",
      actor_role: "admin",
    });
    // Review keeps the source; the posted entry still says who chose it.
    await cmd({ type: "entry.post", id: e.id, expected_version: e.version });
    e = await detail(saved.id);
    check([e.status, ...source(e)], ["posted", "person", MEMBER]);

    // 2. Uncategorized has no source.
    const open = await cmd(manual("Unknown charge", 777, uncategorized));
    e = await detail(open.id);
    check([source(e), e.categorized_by], [[null, null], null]);

    // 3. Edit: the same lines keep the source; a new category is the editor's.
    const lamp = await detail(saved.id);
    const sameLines = lamp.lines.map((l) => ({
      account_id: l.account_id,
      amount_cents: l.amount_cents,
      memo: l.memo,
    }));
    const moved = await cmd({
      type: "entry.correct",
      id: lamp.id,
      expected_version: lamp.version,
      reversal_date: "2026-06-03",
      entry_date: "2026-06-03",
      memo: lamp.memo,
      lines: sameLines,
      reason: "Paid a day later",
    });
    check(
      source(await detail(moved.id)),
      ["person", MEMBER],
      "kept lines keep the source",
    );
    let movedEntry = await detail(moved.id);
    const recategorized = await cmd({
      type: "entry.correct",
      id: movedEntry.id,
      expected_version: movedEntry.version,
      reversal_date: "2026-06-03",
      entry_date: "2026-06-03",
      memo: movedEntry.memo,
      lines: sameLines.map((l) =>
        l.account_id === office ? { ...l, account_id: software } : l,
      ),
      reason: "Belongs under software",
    });
    check(source(await detail(recategorized.id)), ["person", fixtureOwner]);

    // 4. Delete and restore: the restored copy keeps the source.
    movedEntry = await detail(recategorized.id);
    const reversal = await cmd({
      type: "entry.reverse",
      id: movedEntry.id,
      expected_version: movedEntry.version,
      entry_date: "2026-06-04",
      reason: "Not ours",
    });
    assert.ok(reversal.id);
    const restored = await cmd({
      type: "entry.restore",
      id: movedEntry.id,
      expected_version: (await detail(movedEntry.id)).version,
      entry_date: "2026-06-05",
      reason: "It was ours after all",
    });
    check(source(await detail(restored.id)), ["person", fixtureOwner]);

    // 5. The books on their own: last time's category, then reviewed, keeps saying so.
    await sync([["checking", "2026-08-04", -900, "POS TOOLCO #11111"]]);
    e = await bySource("POS TOOLCO #11111");
    check(
      [source(e), e.categorized_by],
      [[null, null], null],
      "a feed draft starts uncategorized",
    );
    const first = await cmd({
      type: "entry.categorize",
      id: e.id,
      expected_version: e.version,
      account_id: software,
    });
    await cmd({
      type: "entry.post",
      id: e.id,
      expected_version: first.version,
    });
    await sync([["checking", "2026-09-14", -900, "POS TOOLCO #22222"]]);
    let tool = await bySource("POS TOOLCO #22222");
    check([tool.fill_source, ...source(tool)], ["prior", "prior", null]);
    // Picking the same category again does not take credit for it.
    const again = await cmd({
      type: "entry.categorize",
      id: tool.id,
      expected_version: tool.version,
      account_id: software,
    });
    tool = await bySource("POS TOOLCO #22222");
    check([tool.fill_source, ...source(tool)], [null, "prior", null]);
    await cmd({
      type: "entry.post",
      id: tool.id,
      expected_version: again.version,
    });
    tool = await bySource("POS TOOLCO #22222");
    check(
      [tool.status, tool.fill, ...source(tool)],
      ["posted", undefined, "prior", null],
    );
    check(tool.categorized_by, { source: "prior" });

    // 6. A rule.
    const preview = async () =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.rules_preview(jsonb_build_object('from','2026-01-01','to','2026-12-31')) r",
        )
      ).rows[0].r;
    const rule = await cmd({
      type: "rule.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Hosting bills",
      priority: 10,
      description_mode: "prefix",
      description: "HOSTCO",
      bank_account_id: feeds.checking,
      direction: "decrease",
      min_cents: null,
      max_cents: null,
      match_payee_id: null,
      category_account_id: software,
      assign_payee_id: null,
      reason: "Hosting is software",
    });
    await cmd({
      type: "rule.activate",
      id: rule.id,
      expected_version: rule.version,
      expected_revision: (await preview()).revision,
      reviewed: true,
      enabled: true,
      reason: "Checked",
    });
    await sync([["checking", "2026-09-15", -2500, "HOSTCO MONTHLY"]]);
    const hosted = await bySource("HOSTCO MONTHLY");
    check(source(hosted), ["rule", null]);
    check(hosted.categorized_by, {
      source: "rule",
      rule_name: "Hosting bills",
    });

    // 7. The contact's default category.
    const party = await cmd({
      type: "party.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Paper Supply Co",
      roles: ["vendor"],
      default_account_id: office,
      tax_classification: "corporation",
      documentation: "received",
      notes: "",
      is_archived: false,
    });
    await cmd({
      type: "alias.save",
      id: randomUUID(),
      expected_version: 0,
      party_id: party.id,
      match_mode: "prefix",
      description: "paper supply",
      enabled: true,
    });
    await sync([["checking", "2026-09-16", -1250, "PAPER SUPPLY 0916"]]);
    const paper = await bySource("PAPER SUPPLY 0916");
    check(source(paper), ["payee_default", null]);

    // 8. A matched transfer: both legs, through confirmation. Not a transfer clears it.
    await sync([
      ["card", "2026-09-17", 3164, "AUTOPAY PAYMENT - THANK YOU"],
      [
        "checking",
        "2026-09-18",
        -3164,
        "Online Transfer / Payment: Debit to CARDCO EPAYMENT",
      ],
    ]);
    let card = await bySource("AUTOPAY PAYMENT - THANK YOU");
    check(source(card), ["transfer_pair", null]);
    await cmd({
      type: "transfer.confirm",
      id: card.id,
      expected_version: card.version,
    });
    card = await bySource("AUTOPAY PAYMENT - THANK YOU");
    const checking = await bySource(
      "Online Transfer / Payment: Debit to CARDCO EPAYMENT",
    );
    check(
      [card.status, ...source(card), checking.status, ...source(checking)],
      ["posted", "transfer_pair", null, "posted", "transfer_pair", null],
    );
    await sync([
      ["checking", "2026-09-19", -6100, "ONLINE TRANSFER 6100"],
      ["savings", "2026-09-19", 6100, "DEPOSIT 6100"],
    ]);
    const out = await bySource("ONLINE TRANSFER 6100");
    check(source(out), ["transfer_pair", null]);
    await cmd({
      type: "transfer.unpair",
      id: out.id,
      expected_version: out.version,
    });
    check(source(await bySource("ONLINE TRANSFER 6100")), [null, null]);
    check(source(await bySource("DEPOSIT 6100")), [null, null]);

    // 9. A posted entry's source is fixed; only the backfill may fill a missing one.
    const hostedNow = await detail(hosted.id);
    await cmd({
      type: "entry.post",
      id: hostedNow.id,
      expected_version: hostedNow.version,
    });
    await db.exec("RESET ROLE");
    const tryUpdate = (action: string | null, sql: string) =>
      db.transaction(async (tx) => {
        if (action)
          await tx.query("SELECT set_config('accounting.action',$1,true)", [
            action,
          ]);
        await tx.query(sql, [hosted.id]);
      });
    await assert.rejects(
      tryUpdate(
        null,
        "UPDATE accounting.journal_entries SET category_source='prior' WHERE id=$1",
      ),
      /ACCT_POSTED_IMMUTABLE/,
    );
    checks++;
    await assert.rejects(
      tryUpdate(
        "entry.source.backfill",
        "UPDATE accounting.journal_entries SET category_source='prior' WHERE id=$1",
      ),
      /ACCT_POSTED_IMMUTABLE/,
      "the backfill never changes a recorded source",
    );
    checks++;

    // 10. The backfill rebuilds every recorded source from the audit history alone.
    const snapshot = async () =>
      (
        await db.query<{
          id: string;
          category_source: string | null;
          category_actor: string | null;
        }>(
          "SELECT id,category_source,category_actor FROM accounting.journal_entries ORDER BY id",
        )
      ).rows;
    const live = await snapshot();
    check(
      live.filter((r) => r.category_source).length,
      10,
      "the scenarios recorded sources",
    );
    await db.exec(
      "ALTER TABLE accounting.journal_entries DISABLE TRIGGER USER; UPDATE accounting.journal_entries SET category_source=NULL,category_actor=NULL; ALTER TABLE accounting.journal_entries ENABLE TRIGGER USER;",
    );
    await db.exec(await backfillSql());
    const counts = (
      await db.query<{ r: Record<string, number> }>(
        "SELECT accounting.category_source_backfill() r",
      )
    ).rows[0].r;
    await db.exec("DROP FUNCTION accounting.category_source_backfill()");
    const rebuilt = await snapshot();
    // Reversal entries are never shown and carry no source either way.
    const reversals = new Set(
      (
        await db.query<{ id: string }>(
          "SELECT id FROM accounting.journal_entries WHERE reverses_entry_id IS NOT NULL OR status='discarded'",
        )
      ).rows.map((r) => r.id),
    );
    check(
      rebuilt.filter((r) => !reversals.has(r.id)),
      live.filter((r) => !reversals.has(r.id)),
      "backfill matches what the commands recorded",
    );
    check(
      Object.values(counts).reduce((s, n) => s + n, 0),
      live.filter((r) => r.category_source && !reversals.has(r.id)).length,
    );
    // Backfilled posted entries are audited like any change.
    check(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM accounting.audit_log WHERE action='entry.source.backfill' AND table_name='journal_entries'",
        )
      ).rows[0].n,
      live.filter((r) => r.category_source && !reversals.has(r.id)).length,
    );

    // 11. History the commands cannot write any more: a Wave import, and an operation with no evidence.
    await db.exec("BEGIN");
    await db.query(
      "SELECT set_config('accounting.action','import.apply',true)",
    );
    await db.query("SELECT set_config('accounting.operation_id',$1,true)", [
      randomUUID(),
    ]);
    await db.query("SELECT set_config('accounting.actor_kind','owner',true)");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [
      fixtureOwner,
    ]);
    const wave = (
      await db.query<{ r: any }>("SELECT accounting.ledger_command($1) r", [
        JSON.stringify({
          ...manual("Wave history row", 5150, office),
          origin: "wave",
        }),
      ])
    ).rows[0].r;
    await db.query("SELECT accounting.ledger_command($1)", [
      JSON.stringify({
        type: "entry.post",
        id: wave.id,
        expected_version: wave.version,
      }),
    ]);
    await db.exec("COMMIT");
    await db.exec(
      "ALTER TABLE accounting.journal_entries DISABLE TRIGGER USER; UPDATE accounting.journal_entries SET category_source=NULL,category_actor=NULL WHERE id='" +
        wave.id +
        "'; ALTER TABLE accounting.journal_entries ENABLE TRIGGER USER;",
    );
    await db.exec(await backfillSql());
    await db.query("SELECT accounting.category_source_backfill()");
    await db.exec("DROP FUNCTION accounting.category_source_backfill()");
    check(
      (
        await db.query<{ s: string }>(
          "SELECT category_source s FROM accounting.journal_entries WHERE id=$1",
          [wave.id],
        )
      ).rows[0].s,
      "wave_import",
    );

    // 12. An import marks what it writes; the feed worker never stamps a person.
    await as(fixtureOwner);
    await db.exec("BEGIN");
    await db.query(
      "SELECT set_config('accounting.category_source','gusto_import',true)",
    );
    const imported = await cmd(manual("Payroll for 2026-06-30", 90000, office));
    await db.exec("COMMIT");
    check(source(await detail(imported.id)), ["gusto_import", null]);
    await db.exec("RESET ROLE");
    const stamp = async (kind: string, actor: string | null) =>
      (
        await db.transaction(async (tx) => {
          await tx.query("SELECT set_config('accounting.actor_kind',$1,true)", [
            kind,
          ]);
          return tx.query<{ r: any }>(
            "SELECT accounting.category_stamp(NULL,$1::jsonb,NULL,NULL,$2::uuid) r",
            [
              JSON.stringify([
                { account_id: feeds.checking, amount_cents: "-100" },
                { account_id: office, amount_cents: "100" },
              ]),
              actor,
            ],
          );
        })
      ).rows[0].r;
    check(await stamp("worker", fixtureOwner), { source: null, actor: null });
    check(await stamp("api", MEMBER), { source: "api", actor: MEMBER });
    check(await stamp("owner", MEMBER), { source: "person", actor: MEMBER });
    // Bad input is left for the command's own checks, never a cast error here.
    check(
      (
        await db.query<{ k: string }>(
          'SELECT accounting.lines_key(\'[{"account_id":"X","amount_cents":"abc"}]\') k',
        )
      ).rows[0].k,
      "x:abc",
    );

    // 13. The presenter: one label per source, none while uncategorized.
    const base = { status: "posted", lines: [] } as unknown as JournalEntry;
    const view = (by: any, extra: Partial<JournalEntry> = {}) =>
      categorySource({ ...base, ...extra, categorized_by: by }, true);
    check(categorySource(base, false), null);
    check(view(null), {
      kind: "unknown",
      label: "Categorized, source not recorded",
    });
    check(view({ source: "person", self: true }), {
      kind: "you",
      label: "Categorized by you",
    });
    check(
      view({
        source: "person",
        self: false,
        actor_name: "Sam Keeper",
        actor_role: "admin",
      }),
      {
        kind: "member",
        label: "Categorized by Sam Keeper",
      },
    );
    check(
      view({
        source: "api",
        self: false,
        actor_name: "Alex A.",
        actor_role: "agent",
      }),
      {
        kind: "agent",
        label: "Categorized by Alex A.",
      },
    );
    check(
      view({
        source: "api",
        self: false,
        actor_name: "Sam Keeper",
        actor_role: "admin",
      }),
      {
        kind: "api",
        label: "Categorized through the API by Sam Keeper",
      },
    );
    check(view({ source: "rule", rule_name: "Hosting bills" }), {
      kind: "rule",
      label: "Categorized by rule: Hosting bills",
    });
    check(view({ source: "rule" })?.label, "Categorized by a rule");
    check(view({ source: "prior" }), {
      kind: "prior",
      label: "Suggested by the books: same as last time",
    });
    check(
      view({ source: "payee_default" }, { payee_name: "Paper Supply Co" }),
      {
        kind: "payee_default",
        label: "Suggested by the books: Paper Supply Co's default category",
      },
    );
    check(view({ source: "transfer_pair" }), {
      kind: "transfer",
      label: "Matched transfer, paired by the books",
    });
    check(view({ source: "gusto_import" }), {
      kind: "import",
      label: "From Gusto import",
    });
    check(view({ source: "patriot_import" })?.label, "From Patriot import");
    check(view({ source: "wave_import" })?.label, "From Wave history");
    // A draft read before the source was recorded falls back to how the books filled it.
    check(
      categorySource(
        {
          ...base,
          status: "draft",
          fill: { source: "rule", rule_name: "Old rule" },
        },
        true,
      ),
      { kind: "rule", label: "Categorized by rule: Old rule" },
    );
    // Real rows read through the API shape.
    check(categorySource(await detail(saved.id), true)?.kind, "member");
    check(categorySource(await detail(open.id), false), null);
    check(
      categorySource(await detail(hosted.id), true)?.label,
      "Categorized by rule: Hosting bills",
    );

    console.log(
      `Category source: recording, review, edits, restore, books fills, rules, transfers, imports, guard, backfill and presenter: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
