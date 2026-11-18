import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";

/**
 * Convert to transfer: two movements the books already hold become the two
 * sides of one linked transfer. Synthetic books only; nothing here reads or
 * writes the live books.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
    const refused = async (c: any, code: string, note?: string) => {
      await assert.rejects(
        cmd(c),
        (e: Error) => e.message.includes(code),
        note ?? code,
      );
      checks++;
    };
    /** Direct reads of the tables, outside the owner's row security. */
    const raw = async <T = any>(sql: string, params: unknown[] = []) => {
      await db.exec("RESET ROLE");
      try {
        return (await db.query<T>(sql, params)).rows;
      } finally {
        await db.exec("SET ROLE authenticated");
      }
    };
    const checking = account(1);
    const card = account(3);
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: a.id === checking ? "bank" : a.id === card ? "card" : "none",
      });
    const savings = randomUUID();
    await cmd({
      type: "account.create",
      id: savings,
      name: "Savings",
      account_type: "asset",
      cash_kind: "bank",
    });
    const drawings = randomUUID();
    await cmd({
      type: "account.create",
      id: drawings,
      name: "Owner Investment / Drawings",
      account_type: "equity",
      subtype: "owner_equity",
    });
    const software = randomUUID();
    await cmd({
      type: "account.create",
      id: software,
      name: "Software tools",
      account_type: "expense",
      subtype: "operating_expense",
    });
    const workspace = async (from = "2026-01-01", to = "2026-12-31") =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.workspace($1,$2,'working') r",
          [from, to],
        )
      ).rows[0].r;
    const chart = (await workspace()).accounts as any[];
    const purpose = (p: string) =>
      chart.find((a) => (a.system_purpose ?? a.purpose) === p).id as string;
    const transit = purpose("transfers_in_transit");
    const uncategorizedIncome = purpose("uncategorized_income");
    const balance = (books: any, id: string) =>
      books.balances.find((b: any) => b.id === id)?.ending_cents ?? "0";
    const entry = async (id: string) =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.transactions($1,'{}') r",
          [JSON.stringify({ entry_id: id })],
        )
      ).rows[0].r.entries[0];
    const revision = async () =>
      (
        await raw<{ r: string }>(
          "SELECT financial_revision::text r FROM accounting.settings",
        )
      )[0].r;

    // A bank feed on checking and savings, so their drafts carry real bank evidence.
    const connection = randomUUID();
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic bank",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    const feeds = { checking, card, savings };
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
          balance_cents: "0",
          balance_at: Date.parse("2026-11-16T18:00:00Z") / 1000,
          complete: true,
          transactions: movements
            .filter((m) => m[0] === name)
            .map(([, date, cents, description]) => {
              serial++;
              return {
                external_id: `SYN-${serial}`,
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
      await db.exec("RESET ROLE; SET ROLE authenticated");
    };
    const drafted = async (description: string) => {
      const rows = await raw<{ id: string }>(
        "SELECT id FROM accounting.journal_entries WHERE source_description=$1 AND status='draft'",
        [description],
      );
      assert.equal(rows.length, 1, `one draft for ${description}`);
      return entry(rows[0].id);
    };
    /** A reviewed transaction as the Wave import left it: posted, its own bank text, origin wave. */
    const imported = async (
      date: string,
      description: string,
      lines: [string, number][],
    ) => {
      const id = randomUUID();
      const saved = await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: date,
        memo: description,
        source_description: description,
        origin: "wave",
        kind: "owner",
        lines: lines.map(([account_id, cents]) => ({
          account_id,
          amount_cents: String(cents),
        })),
      });
      await cmd({ type: "entry.post", id, expected_version: saved.version });
      return entry(id);
    };
    const convert = (
      out: any,
      inn: any,
      cents: number,
      from: string,
      to: string,
      extra: Record<string, unknown> = {},
    ) => ({
      type: "transfer.convert",
      id: randomUUID(),
      outgoing_entry_id: out.id,
      outgoing_version: out.version,
      incoming_entry_id: inn.id,
      incoming_version: inn.version,
      from_account_id: from,
      to_account_id: to,
      amount_cents: String(cents),
      reason: "Card credit balance refunded by check and deposited",
      ...extra,
    });
    const lineSet = (e: any) =>
      e.lines
        .map((l: any) => `${l.account_id}:${l.amount_cents}`)
        .sort()
        .join(" ");

    // ---- 1. The real case, synthetic copy: July 17 card credit balance removed
    // (reviewed, Wave, owner drawings) and November 16 mobile check deposit
    // (draft, bank feed, uncategorized income), 122 days apart.
    const before = await workspace();
    const july = await imported("2026-07-17", "REMOVAL OF CREDIT BALANCE", [
      [card, -4127],
      [drawings, 4127],
    ]);
    await sync([["checking", "2026-11-16", 4127, "Mobile Check Deposit"]]);
    let november = await drafted("Mobile Check Deposit");
    check(
      [july.status, july.review_pending, july.primary_origin],
      ["posted", false, "wave"],
    );
    check(
      lineSet(november),
      lineSet({
        lines: [
          { account_id: checking, amount_cents: "4127" },
          { account_id: uncategorizedIncome, amount_cents: "-4127" },
        ],
      }),
    );
    check(november.matches.length, 1, "deposit carries its bank line");
    // Automatic matching is unchanged: 122 days is far outside its window, so nothing is suggested.
    check(november.transfer_suggestion, undefined);
    const novemberBankLine = november.lines.find(
      (l: any) => l.account_id === checking,
    ).id;
    let books = await workspace();
    check(balance(books, drawings), "4127", "drawings before");
    check(books.reports.income_cents, "4127", "uncategorized income before");

    const result = await cmd(
      convert(july, november, 4127, card, checking, {
        reason:
          "AMEX returned the card credit balance by check, deposited in checking",
      }),
    );
    check(
      result.incoming_entry_id,
      november.id,
      "the deposit is linked in place",
    );
    check(
      result.outgoing_entry_id !== july.id,
      true,
      "reviewed side is a corrected version",
    );
    const group = result.transfer_group_id;

    // The reviewed July side: the original stays as the earlier version, replaced on its own date.
    const original = await entry(july.id);
    const replacement = await entry(result.outgoing_entry_id);
    check(original.status, "posted");
    check(original.replacement_entry_id, replacement.id);
    check(original.reversed_by_entry_id !== null, true);
    check(
      original.primary_origin,
      "wave",
      "imported provenance kept on the original",
    );
    check(lineSet(original), lineSet(july), "original lines untouched");
    check(
      [
        replacement.entry_date,
        replacement.source_description,
        replacement.memo,
      ],
      ["2026-07-17", "REMOVAL OF CREDIT BALANCE", "REMOVAL OF CREDIT BALANCE"],
    );
    check(
      lineSet(replacement),
      lineSet({
        lines: [
          { account_id: card, amount_cents: "-4127" },
          { account_id: transit, amount_cents: "4127" },
        ],
      }),
    );
    check(
      [
        replacement.transfer_group_id,
        replacement.payee_id ?? null,
        replacement.status,
      ],
      [group, null, "posted"],
    );
    check(replacement.transfer_account_id, checking);
    const [reversal] = await raw(
      "SELECT entry_date::text,status,reason FROM accounting.journal_entries WHERE reverses_entry_id=$1",
      [july.id],
    );
    check(
      [reversal.entry_date, reversal.status],
      ["2026-07-17", "posted"],
      "reversal dated on the original's day",
    );
    check(
      reversal.reason,
      "AMEX returned the card credit balance by check, deposited in checking",
    );
    const [replaces] = await raw(
      "SELECT replaces_entry_id::text r FROM accounting.journal_entries WHERE id=$1",
      [replacement.id],
    );
    check(replaces.r, july.id, "the correction names what it replaces");

    // The November draft side: same entry, same bank line and evidence, now transit, still waiting in Review.
    november = await entry(november.id);
    check(
      [november.status, november.review_pending, november.transfer_group_id],
      ["posted", true, group],
    );
    check(
      lineSet(november),
      lineSet({
        lines: [
          { account_id: checking, amount_cents: "4127" },
          { account_id: transit, amount_cents: "-4127" },
        ],
      }),
    );
    check(
      november.lines.find((l: any) => l.account_id === checking).id,
      novemberBankLine,
      "bank line identity kept",
    );
    check(november.matches.length, 1, "bank evidence still attached");
    check(
      [
        november.primary_origin,
        november.source_description,
        november.entry_date,
      ],
      ["simplefin", "Mobile Check Deposit", "2026-11-16"],
    );
    check(november.payee_id ?? null, null, "transfer sides carry no contact");
    check(november.transfer_account_id, card);
    const bankRows = await raw(
      "SELECT count(*)::int n FROM accounting.bank_transactions WHERE description='Mobile Check Deposit'",
    );
    check(bankRows[0].n, 1, "no second bank movement");

    // Balances reconcile and nothing touches profit.
    books = await workspace();
    check(
      balance(books, drawings),
      balance(before, drawings),
      "drawings effect gone",
    );
    check(
      balance(books, uncategorizedIncome),
      "0",
      "uncategorized income gone",
    );
    check(balance(books, transit), "0", "transit clears once both sides land");
    check(balance(books, checking), "4127", "checking holds the deposit once");
    check(balance(books, card), "-4127", "card credit balance removed once");
    check(
      [books.reports.income_cents, books.reports.expense_cents],
      ["0", "0"],
    );
    const julyBooks = await workspace("2026-07-01", "2026-07-31");
    check(
      [julyBooks.reports.income_cents, julyBooks.reports.expense_cents],
      ["0", "0"],
    );
    check(
      balance(julyBooks, transit),
      "4127",
      "July ends with the check in transit",
    );
    check(balance(julyBooks, drawings), "0");
    const pl = (
      await db.query<{ r: any }>(
        'SELECT accounting.report(\'profit_loss\',\'{"from":"2026-01-01","to":"2026-12-31"}\') r',
      )
    ).rows[0].r;
    check(
      [pl.income_cents, pl.expense_cents, pl.net_income_cents],
      ["0", "0", "0"],
      "profit and loss is zero",
    );
    // The transfer is counted once: one group, both sides, one amount.
    const transfers = (
      await db.query<{ r: any }>(
        'SELECT accounting.context(\'transfers\',\'{"from":"2026-01-01","to":"2026-12-31"}\') r',
      )
    ).rows[0].r;
    check(transfers.total, 1);
    check(
      (({
        id,
        status,
        outgoing_entry_id,
        incoming_entry_id,
        outgoing_date,
        incoming_date,
        amount_cents,
      }) => ({
        id,
        status,
        outgoing_entry_id,
        incoming_entry_id,
        outgoing_date,
        incoming_date,
        amount_cents,
      }))(transfers.groups[0]),
      {
        id: group,
        status: "posted",
        outgoing_entry_id: replacement.id,
        incoming_entry_id: november.id,
        outgoing_date: "2026-07-17",
        incoming_date: "2026-11-16",
        amount_cents: "4127",
      },
    );
    const register = (
      await db.query<{ r: any }>(
        'SELECT accounting.transactions(\'{"transfers":"only"}\',\'{"limit":100}\') r',
      )
    ).rows[0].r;
    check(register.total, 2, "the register shows the two sides, no more");
    // The correction is on the record, with what it removed.
    const audit = await raw(
      "SELECT row_id::text,before,after,reason FROM accounting.audit_log WHERE action='transfer.converted' ORDER BY id",
    );
    check(
      audit.map((a: any) => a.row_id),
      [july.id, november.id],
    );
    check(audit[0].before.removed_lines, [
      {
        account_id: drawings,
        account: "Owner Investment / Drawings",
        amount_cents: "4127",
      },
    ]);
    check(audit[1].before.removed_lines[0].account_id, uncategorizedIncome);
    check(
      [audit[0].after.transfer_group_id, audit[0].before.status],
      [group, "posted"],
    );
    check(audit[1].before.status, "draft");
    // The draft side is still the owner's to review, the normal way.
    await cmd({
      type: "entry.review",
      id: november.id,
      expected_version: november.version,
      reviewed: true,
    });
    check((await entry(november.id)).review_pending, false);

    // ---- 2. Already linked: neither side converts again, and a replayed preview is stale.
    await refused(
      convert(
        { ...replacement, version: replacement.version - 1 },
        await entry(november.id),
        4127,
        card,
        checking,
      ),
      "ACCT_STALE_VERSION",
    );
    await refused(
      convert(original, await entry(november.id), 4127, card, checking),
      "ACCT_TRANSFER_SIDE_STATUS",
    );
    const linkedOut = await entry(replacement.id);
    await sync([["savings", "2026-08-02", 4127, "DEPOSIT 4127"]]);
    const stray = await drafted("DEPOSIT 4127");
    await refused(
      convert(linkedOut, stray, 4127, card, savings),
      "ACCT_TRANSFER_ALREADY_LINKED",
    );
    await cmd({
      type: "draft.discard",
      id: stray.id,
      expected_version: stray.version,
      reason: "Synthetic stray deposit",
    });

    // ---- 3. Draft out, reviewed in, widely separated: February card payment out of checking
    // (draft from the feed), October card payment received (reviewed, with its own bank evidence).
    await sync([["checking", "2026-02-10", -9050, "WEB PMT 9050"]]);
    const febOut = await drafted("WEB PMT 9050");
    await sync([["card", "2026-10-20", 9050, "PAYMENT RECEIVED"]]);
    let octIn = await drafted("PAYMENT RECEIVED");
    const categorized = await cmd({
      type: "entry.categorize",
      id: octIn.id,
      expected_version: octIn.version,
      account_id: software,
    });
    await cmd({
      type: "entry.post",
      id: octIn.id,
      expected_version: categorized.version,
    });
    octIn = await entry(octIn.id);
    check([octIn.status, octIn.matches.length], ["posted", 1]);
    check(
      febOut.transfer_suggestion,
      undefined,
      "no automatic match across eight months",
    );
    const second = await cmd(convert(febOut, octIn, 9050, checking, card));
    check(second.outgoing_entry_id, febOut.id);
    const octFixed = await entry(second.incoming_entry_id);
    check(
      [
        octFixed.entry_date,
        octFixed.matches.length,
        octFixed.source_description,
        octFixed.transfer_group_id,
      ],
      ["2026-10-20", 1, "PAYMENT RECEIVED", second.transfer_group_id],
      "bank evidence follows the reviewed side's correction",
    );
    check((await entry(febOut.id)).review_pending, true);
    // A hand-converted pair is not a learned pattern: the same two bank texts a week later are only suggested.
    await sync([
      ["checking", "2026-10-25", -1234, "WEB PMT 9050"],
      ["card", "2026-10-26", 1234, "PAYMENT RECEIVED"],
    ]);
    const laterOut = await drafted("WEB PMT 9050");
    check(
      laterOut.pair_entry_id ?? null,
      null,
      "not auto-paired from a converted transfer",
    );
    check(laterOut.transfer_suggestion?.signal ?? null, null);
    await cmd({
      type: "draft.discard",
      id: laterOut.id,
      expected_version: laterOut.version,
      reason: "Synthetic",
    });
    const laterIn = await drafted("PAYMENT RECEIVED");
    await cmd({
      type: "draft.discard",
      id: laterIn.id,
      expected_version: laterIn.version,
      reason: "Synthetic",
    });
    books = await workspace();
    check(
      [
        books.reports.income_cents,
        books.reports.expense_cents,
        balance(books, transit),
        balance(books, software),
      ],
      ["0", "0", "0", "0"],
    );

    // ---- 4. Invalid matches are refused and change nothing.
    await sync([
      ["checking", "2026-05-04", 2500, "DEPOSIT A"],
      ["savings", "2026-05-06", 2500, "DEPOSIT B"],
      ["savings", "2026-05-07", -2600, "WITHDRAWAL C"],
      ["checking", "2026-05-08", -2500, "WITHDRAWAL D"],
      ["checking", "2026-05-09", 2500, "DEPOSIT E"],
    ]);
    const a = await drafted("DEPOSIT A");
    const b = await drafted("DEPOSIT B");
    const c = await drafted("WITHDRAWAL C");
    const d = await drafted("WITHDRAWAL D");
    const e2 = await drafted("DEPOSIT E");
    const startRevision = await revision();
    await refused(
      convert(b, a, 2500, savings, checking),
      "ACCT_TRANSFER_DIRECTION",
      "both put money in",
    );
    await refused(
      convert(c, a, 2500, savings, checking),
      "ACCT_TRANSFER_AMOUNT",
      "amounts differ",
    );
    await refused(
      convert(d, e2, 2500, checking, checking),
      "ACCT_TRANSFER_SAME_ACCOUNT",
      "one account both sides",
    );
    await refused(
      convert(b, d, 2500, savings, checking),
      "ACCT_TRANSFER_DIRECTION",
      "sides swapped",
    );
    await refused(
      convert(d, b, 2500, checking, card),
      "ACCT_TRANSFER_CHANGED",
      "preview names another account",
    );
    await refused(
      convert(d, b, 2400, checking, savings),
      "ACCT_TRANSFER_CHANGED",
      "preview names another amount",
    );
    await refused(
      convert(d, d, 2500, checking, savings),
      "ACCT_INVALID_COMMAND",
      "same entry twice",
    );
    await refused(
      convert(d, b, 2500, checking, savings, { reason: "  " }),
      "ACCT_INVALID_COMMAND",
      "reason required",
    );
    await refused(
      convert(d, b, 2500, checking, savings, {
        incoming_version: b.version + 1,
      }),
      "ACCT_STALE_VERSION",
    );
    await refused(
      convert(d, b, 2500, checking, savings, {
        outgoing_version: d.version - 1,
      }),
      "ACCT_STALE_VERSION",
    );
    check(await revision(), startRevision, "refusals wrote nothing");
    check(
      lineSet(await entry(d.id)),
      lineSet(d),
      "refusals left the draft alone",
    );
    // A split movement on two own accounts is not one side.
    const twoBank = randomUUID();
    const tb = await cmd({
      type: "draft.save",
      id: twoBank,
      expected_version: 0,
      entry_date: "2026-05-10",
      memo: "Two accounts",
      lines: [
        { account_id: checking, amount_cents: "-2500" },
        { account_id: savings, amount_cents: "1000" },
        { account_id: software, amount_cents: "1500" },
      ],
    });
    await refused(
      convert({ id: twoBank, version: tb.version }, b, 2500, checking, savings),
      "ACCT_TRANSFER_SIDE_SHAPE",
    );
    // A deleted draft is not a side.
    const gone = await cmd({
      type: "draft.discard",
      id: e2.id,
      expected_version: e2.version,
      reason: "Synthetic duplicate",
    });
    await refused(
      convert(
        d,
        { id: e2.id, version: gone.version },
        2500,
        checking,
        checking,
      ),
      "ACCT_TRANSFER_SIDE_STATUS",
    );

    // A proposed pair is confirmed or declined first.
    await sync([
      ["checking", "2026-06-01", -3300, "ONLINE TRANSFER 3300"],
      ["savings", "2026-06-01", 3300, "ONLINE TRANSFER IN 3300"],
    ]);
    const proposed = await drafted("ONLINE TRANSFER 3300");
    check(proposed.pair_entry_id !== null, true);
    await refused(
      convert(proposed, b, 3300, checking, savings),
      "ACCT_TRANSFER_PAIR_CONFIRM",
    );

    // ---- 5. Only the owner: an admin with the books, and an API key acting as the owner, are refused.
    const admin = randomUUID();
    await db.exec("RESET ROLE");
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [admin]);
    await db.query(
      "INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Fixture Admin','admin@fixture.test','admin')",
      [admin],
    );
    await db.exec("SET ROLE authenticated");
    const owner = (
      await raw<{ r: string }>(
        "SELECT owner_user_id::text r FROM accounting.settings",
      )
    )[0].r;
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    await refused(
      convert(d, b, 2500, checking, savings),
      "ACCT_OWNER_ONLY",
      "admin refused",
    );
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      owner,
    ]);
    await db.query(
      "SELECT set_config('accounting.actor_kind','api',false), set_config('api.command','drafts',false)",
    );
    await refused(
      convert(d, b, 2500, checking, savings),
      "ACCT_OWNER_ONLY",
      "API refused",
    );
    await db.query(
      "SELECT set_config('accounting.actor_kind','',false), set_config('api.command','',false)",
    );

    // ---- 6. Closed months, and rollback when the second side fails after the first was corrected.
    // March holds a reviewed deposit; May holds a reviewed withdrawal. March closes.
    const marchIn = await imported("2026-03-12", "CHECK DEPOSIT 7700", [
      [savings, 7700],
      [drawings, -7700],
    ]);
    const mayOut = await imported("2026-05-20", "CREDIT BALANCE REFUND 7700", [
      [card, -7700],
      [drawings, 7700],
    ]);
    const marchOut = await imported("2026-03-20", "SAVINGS TO CHECKING 1200", [
      [savings, -1200],
      [drawings, 1200],
    ]);
    const febWithdrawal = await imported(
      "2026-02-14",
      "SAVINGS WITHDRAWAL 7700",
      [
        [savings, -7700],
        [drawings, 7700],
      ],
    );
    await sync([
      ["checking", "2026-06-15", 1200, "DEPOSIT 1200"],
      ["checking", "2026-11-03", 7700, "BRANCH DEPOSIT 7700"],
    ]);
    for (const m of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      const drafts = await raw(
        "SELECT id::text,version FROM accounting.journal_entries WHERE status='draft' AND date_trunc('month',entry_date)=$1::date",
        [m],
      );
      for (const x of drafts)
        await cmd({
          type: "entry.discard",
          id: x.id,
          expected_version: x.version,
          reason: "Clear month for close test",
        });
    }
    await cmd({ type: "period.lock", month: "2026-03-01" });
    const lockedRevision = await revision();
    const auditBefore = (
      await raw(
        "SELECT count(*)::int n FROM accounting.audit_log WHERE action='transfer.converted'",
      )
    )[0].n;
    // May (the outgoing side) is corrected first, then March refuses: everything rolls back.
    await refused(
      convert(mayOut, marchIn, 7700, card, savings),
      "ACCT_PERIOD_LOCKED",
    );
    check(await revision(), lockedRevision, "no write survived the refusal");
    const mayAfter = await entry(mayOut.id);
    check(
      [
        mayAfter.version,
        mayAfter.reversed_by_entry_id,
        mayAfter.transfer_group_id ?? null,
      ],
      [mayOut.version, null, null],
      "first side rolled back",
    );
    check(
      (
        await raw(
          "SELECT count(*)::int n FROM accounting.journal_entries WHERE reverses_entry_id IN ($1,$2) OR replaces_entry_id IN ($1,$2)",
          [mayOut.id, marchIn.id],
        )
      )[0].n,
      0,
    );
    check(
      (
        await raw(
          "SELECT count(*)::int n FROM accounting.audit_log WHERE action='transfer.converted'",
        )
      )[0].n,
      auditBefore,
    );
    // A closed month on the outgoing side refuses at once; a later closed month refuses the history before it.
    await refused(
      convert(marchOut, await drafted("DEPOSIT 1200"), 1200, savings, checking),
      "ACCT_PERIOD_LOCKED",
    );
    const novDeposit = await drafted("BRANCH DEPOSIT 7700");
    await refused(
      convert(febWithdrawal, novDeposit, 7700, savings, checking),
      "ACCT_LATER_PERIOD_LOCKED",
    );
    // Reopened with a reason, the same correction goes through.
    await cmd({
      type: "period.reopen",
      month: "2026-03-01",
      reason: "Link the credit balance refund",
    });
    // March was put back in Review by the owner; its correction must not tick it.
    const marchNow = await entry(marchIn.id);
    await cmd({
      type: "entry.review",
      id: marchIn.id,
      expected_version: marchNow.version,
      reviewed: false,
    });
    const beforeThird = await workspace();
    const third = await cmd(
      convert(mayOut, await entry(marchIn.id), 7700, card, savings),
    );
    check(typeof third.transfer_group_id, "string");
    check(
      [
        (await entry(third.outgoing_entry_id)).review_pending,
        (await entry(third.incoming_entry_id)).review_pending,
      ],
      [false, true],
      "a side waiting in Review keeps waiting after its correction",
    );
    books = await workspace();
    check(
      [
        books.reports.income_cents,
        books.reports.expense_cents,
        balance(books, transit),
      ],
      [
        beforeThird.reports.income_cents,
        beforeThird.reports.expense_cents,
        "0",
      ],
      "the third transfer moves neither profit nor transit",
    );
    check(
      [balance(books, card), balance(books, savings)],
      [balance(beforeThird, card), balance(beforeThird, savings)],
      "bank and card balances unchanged by relinking",
    );

    console.log(
      `Convert to transfer: reviewed and draft sides, separated dates, card credit balance, linked records, invalid matches, owner only, closed months, stale versions and rollback: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
