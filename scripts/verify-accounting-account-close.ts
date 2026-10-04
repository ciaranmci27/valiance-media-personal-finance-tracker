import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import { closeRefusal } from "../src/lib/accounting/account-close";
import {
  feedKind,
  replacementSuggestions,
} from "../src/lib/accounting/feed-replacements";
import {
  bankIdentitiesByAccount,
  currentFeedAccount,
} from "../src/lib/accounting/bank-identity";
import type { FeedData } from "../src/lib/accounting/feeds";
import { extendedCommandSchema } from "../src/lib/accounting/workflows";

/**
 * Closing bank and card accounts, and moving a feed to a reissued card:
 * refusals with their reasons, history and reports unchanged, one open link
 * per account, no double import across the overlap, and the replacement
 * suggestion only for a quiet link of the same institution and kind.
 */
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const equal = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const rejects = async (work: Promise<unknown>, error: RegExp) => {
    await assert.rejects(work, error);
    checks++;
  };
  const cmd = async (c: object) => {
    // Every command the screens send passes the same schema the route uses.
    const parsed = extendedCommandSchema.safeParse(c);
    if ("expected_version" in c || "replaces" in c)
      assert.equal(
        parsed.success,
        true,
        JSON.stringify(parsed.error?.issues ?? []),
      );
    return (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key: randomUUID(), command: c }),
      ])
    ).rows[0].r;
  };
  // Server-side commands the screens never send (fixture setup) skip the schema.
  const setup = async (c: object) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key: randomUUID(), command: c }),
      ])
    ).rows[0].r;
  const raw = async (sql: string, params: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return (await db.query<any>(sql, params)).rows;
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const read = async (sql: string) =>
    (await db.query<{ r: any }>(sql)).rows[0].r;
  const version = async (id: string) =>
    (await raw("SELECT version FROM accounting.accounts WHERE id=$1", [id]))[0]
      .version as number;
  const draft = (date: string, lines: [string, string][]) =>
    setup({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo: "Synthetic entry",
      lines: lines.map(([account_id, amount_cents]) => ({
        account_id,
        amount_cents,
      })),
    });
  const post = async (date: string, lines: [string, string][]) => {
    const d = await draft(date, lines);
    return setup({ type: "entry.post", id: d.id, expected_version: d.version });
  };
  const discard = (d: { id: string; version: number }) =>
    setup({
      type: "draft.discard",
      id: d.id,
      expected_version: d.version,
      reason: "Synthetic cleanup",
    });
  try {
    for (const a of fixtureAccounts)
      await setup({
        type: "account.create",
        ...a,
        cash_kind:
          a.id === fixtureAccountId(1) || a.id === fixtureAccountId(9)
            ? "bank"
            : a.id === fixtureAccountId(3)
              ? "card"
              : "none",
      });
    const checking = fixtureAccountId(1),
      card = fixtureAccountId(3),
      software = fixtureAccountId(6);

    // --- Closing: refusals ---------------------------------------------------
    await post("2024-03-01", [
      [software, "5000"],
      [card, "-5000"],
    ]);
    let refusal = "";
    await rejects(
      cmd({
        type: "account.close",
        id: card,
        expected_version: await version(card),
        closed_on: "2024-03-04",
      }).catch((e) => {
        refusal = e.message;
        throw e;
      }),
      /ACCT_CLOSE_BALANCE/,
    );
    equal(
      closeRefusal(refusal),
      "This card still shows $50.00 owed on Mar 4, 2024. Record the payoff, then close it.",
    );
    await post("2024-03-04", [
      [card, "5000"],
      [checking, "-5000"],
    ]);
    const later = await draft("2024-05-01", [
      [software, "100"],
      [card, "-100"],
    ]);
    await rejects(
      cmd({
        type: "account.close",
        id: card,
        expected_version: await version(card),
        closed_on: "2024-03-04",
      }).catch((e) => {
        refusal = e.message;
        throw e;
      }),
      /ACCT_CLOSE_LATER_ENTRIES/,
    );
    equal(
      closeRefusal(refusal),
      "1 transaction is dated after Mar 4, 2024, the first on May 1, 2024. Choose a closing date on or after the last one.",
    );
    await discard(later);
    const waiting = await draft("2024-02-15", [
      [software, "100"],
      [card, "-100"],
    ]);
    await rejects(
      cmd({
        type: "account.close",
        id: card,
        expected_version: await version(card),
      }),
      /ACCT_CLOSE_DRAFTS/,
    );
    await discard(waiting);
    await rejects(
      cmd({
        type: "account.close",
        id: card,
        expected_version: await version(card),
        closed_on: "2099-01-01",
      }),
      /ACCT_CLOSE_DATE/,
    );
    await rejects(
      cmd({
        type: "account.close",
        id: software,
        expected_version: await version(software),
      }),
      /ACCT_CLOSE_KIND/,
    );

    // --- Closing: succeeds at $0, history and reports identical ------------------
    const strip = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(strip)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .filter(
                  ([k]) =>
                    ![
                      "closed_on",
                      "revision",
                      "generated_at",
                      "version",
                      "updated_at",
                    ].includes(k),
                )
                .map(([k, v]) => [k, strip(v)]),
            )
          : value;
    const reports = async () => ({
      bs: strip(
        await read(
          'SELECT accounting.report(\'balance_sheet\',\'{"from":"2024-01-01","to":"2024-12-31"}\') r',
        ),
      ),
      pl: strip(
        await read(
          'SELECT accounting.report(\'profit_loss\',\'{"from":"2024-01-01","to":"2024-12-31"}\') r',
        ),
      ),
      tb: strip(
        await read(
          'SELECT accounting.report(\'trial_balance\',\'{"from":"2024-01-01","to":"2024-03-02"}\') r',
        ),
      ),
      ledger: strip(
        await read(
          `SELECT accounting.ledger('${card}','2024-01-01','2024-12-31') r`,
        ),
      ),
    });
    const before = await reports();
    const closed = await cmd({
      type: "account.close",
      id: card,
      expected_version: await version(card),
    });
    // The default closing day is the last activity; discarded drafts do not count.
    equal(closed.closed_on, "2024-03-04");
    equal(await reports(), before, "reports read the same after closing");
    const workspace = await read(
      "SELECT accounting.workspace('2024-01-01','2024-12-31') r",
    );
    equal(
      workspace.accounts.find((a: any) => a.id === card).closed_on,
      "2024-03-04",
    );
    const manage = await read("SELECT accounting.context('manage') r");
    const profile = manage.profiles.find((p: any) => p.account_id === card);
    equal(
      [profile.closed_on, profile.last_activity_on],
      ["2024-03-04", "2024-03-04"],
    );
    const recon = await read(
      "SELECT accounting.reconciliation_status('{}'::jsonb) r",
    );
    const reconCard = recon.accounts.find((a: any) => a.account.id === card);
    equal(
      [reconCard.status, reconCard.account.closed_on],
      ["closed", "2024-03-04"],
    );
    // Nothing new after the closing day; history up to it stays editable.
    await rejects(
      draft("2024-04-01", [
        [software, "100"],
        [card, "-100"],
      ]),
      /ACCT_ACCOUNT_CLOSED/,
    );
    const history = await draft("2024-03-02", [
      [software, "100"],
      [card, "-100"],
    ]);
    await rejects(
      setup({
        type: "draft.save",
        id: history.id,
        expected_version: history.version,
        entry_date: "2024-04-02",
        memo: "Moved past the closing day",
        lines: [
          { account_id: software, amount_cents: "100" },
          { account_id: card, amount_cents: "-100" },
        ],
      }),
      /ACCT_ACCOUNT_CLOSED/,
    );
    await discard(history);
    await rejects(
      cmd({ type: "account.reopen", id: card, expected_version: 1 }),
      /ACCT_STALE_VERSION/,
    );
    await cmd({
      type: "account.reopen",
      id: card,
      expected_version: await version(card),
    });
    equal(
      (
        await raw("SELECT closed_on FROM accounting.accounts WHERE id=$1", [
          card,
        ])
      )[0].closed_on,
      null,
    );
    await discard(
      await draft("2024-04-01", [
        [software, "100"],
        [card, "-100"],
      ]),
    );
    checks++;

    // --- Closing an account with a feed closes the link; reopening restores it ---
    const connection = randomUUID();
    await setup({
      type: "feed.claim",
      id: connection,
      name: "Synthetic Amex",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    const savings = fixtureAccountId(9),
      savingsLink = randomUUID();
    await setup({
      type: "feed.map",
      id: savingsLink,
      expected_version: 0,
      account_id: savings,
      connection_id: connection,
      provider_account_id: '["amex", "savings"]',
      coverage_from: "2026-01-01",
    });
    const today = (
      await raw(
        "SELECT (now() AT TIME ZONE books_timezone)::date::text d FROM public.business_profile",
      )
    )[0].d as string;
    await cmd({
      type: "account.close",
      id: savings,
      expected_version: await version(savings),
    });
    equal(
      await raw(
        "SELECT is_closed,closed_on::text FROM accounting.bank_accounts WHERE id=$1",
        [savingsLink],
      ),
      [{ is_closed: true, closed_on: today }],
    );
    // A closed account takes no open feed link.
    await rejects(
      raw(
        "UPDATE accounting.bank_accounts SET is_closed=false,closed_on=NULL WHERE id=$1",
        [savingsLink],
      ),
      /ACCT_ACCOUNT_CLOSED/,
    );
    await cmd({
      type: "account.reopen",
      id: savings,
      expected_version: await version(savings),
    });
    equal(
      await raw(
        "SELECT is_closed,closed_on FROM accounting.bank_accounts WHERE id=$1",
        [savingsLink],
      ),
      [{ is_closed: false, closed_on: null }],
    );

    // --- A reissued card: link the new feed account to the same ledger account ---
    const amex = randomUUID();
    await setup({
      type: "account.create",
      id: amex,
      code: "2050",
      name: "Amex Business Gold",
      account_type: "liability",
      normal_side: "credit",
      cash_kind: "card",
    });
    const noon = (date: string) => Date.parse(`${date}T19:00:00Z`) / 1000;
    const provider = (
      id: string,
      name: string,
      transactions: object[] = [],
      institution = "American Express",
    ) => ({
      provider_connection_id: "amex",
      provider_account_id: id,
      currency: "USD",
      name,
      institution,
      balance_cents: "-3000",
      balance_at: noon("2026-08-28"),
      complete: true,
      through: String(noon("2026-08-29")),
      transactions,
    });
    const tx = (id: string, date: string, cents: string) => ({
      external_id: id,
      posted: noon(date),
      transacted_at: noon(date),
      amount_cents: cents,
      description: `SYNTHETIC ${id}`,
      state: "posted",
      hash: id.padEnd(64, "0").slice(0, 64),
      raw: { synthetic: true },
    });
    const sync = async (accounts: object[], discovery = false) => {
      await db.exec("RESET ROLE; SET ROLE service_role");
      const run = randomUUID();
      const call = async (c: object) =>
        (
          await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [
            JSON.stringify({ id: connection, run_id: run, ...c }),
          ])
        ).rows[0].r;
      try {
        const lease = await call({ action: "lease" });
        const result = await call({
          action: "complete",
          create_drafts: true,
          discovery,
          accounts,
        });
        return { lease, result };
      } finally {
        await db.exec("RESET ROLE; SET ROLE authenticated");
      }
    };
    const feeds = async () =>
      (await read("SELECT accounting.context('feeds') r")) as FeedData;
    const identityId = async (name: string) =>
      (await feeds()).identities.find((i) => i.name === name)!.id;
    await sync(
      [
        provider("card-2005", "Business Gold Card (-2005)"),
        provider("savings", "Savings"),
      ],
      true,
    );
    const oldLink = await identityId("Business Gold Card (-2005)");
    await cmd({
      type: "feed.map",
      id: oldLink,
      expected_version: 0,
      ownership: "company",
      account_id: amex,
      history_start: String(noon("2026-08-01")),
      posting_timezone: "America/Phoenix",
      movement_sign: 1,
      balance_sign: 1,
      reviewed: true,
      reason: "Synthetic mapping",
    });
    let { result } = await sync([
      provider("card-2005", "Business Gold Card (-2005)", [
        tx("old-1", "2026-08-10", "-1000"),
        tx("old-2", "2026-08-20", "-2000"),
      ]),
      provider("savings", "Savings"),
    ]);
    equal(result.new, 2);
    // Discovery now also returns the new card number, plus look-alikes that must not be suggested.
    await sync(
      [
        provider("card-2005", "Business Gold Card (-2005)"),
        provider("card-3007", "Business Gold Card (-3007)"),
        provider("chk-1", "Business Checking", [], "American Express"),
        provider("other-card", "Gold Card (-9999)", [], "Chase"),
        provider("savings", "Savings"),
      ],
      true,
    );
    const newLink = await identityId("Business Gold Card (-3007)");
    const kinds = new Map(
      (await read("SELECT accounting.context('manage') r")).profiles.map(
        (p: any) => [p.account_id, p.cash_kind],
      ),
    ) as Map<string, string>;
    let state = await feeds();
    equal(state.identities.map((i) => [i.name, feedKind(i)]).sort(), [
      ["Business Checking", "bank"],
      ["Business Gold Card (-2005)", "card"],
      ["Business Gold Card (-3007)", "card"],
      ["Gold Card (-9999)", "card"],
      ["Savings", "bank"],
    ]);
    equal(
      state.accounts.find((a) => a.id === oldLink)?.last_movement_on,
      "2026-08-20",
    );
    // Quiet for 30+ days: only the same-institution, same-kind account is offered.
    let suggestions = replacementSuggestions(state, kinds, "2026-10-04");
    equal(
      [...suggestions.values()].map((s) => [
        s.identity.name,
        s.replaces.id,
        s.accountId,
      ]),
      [["Business Gold Card (-3007)", oldLink, amex]],
    );
    // Not quiet yet: nothing.
    equal(replacementSuggestions(state, kinds, "2026-09-01").size, 0);
    // The provider stopped returning the old number: quiet even within 30 days.
    const stopped: FeedData = {
      ...state,
      identities: state.identities.map((i) =>
        i.id === oldLink ? { ...i, seen_at: (i.seen_at ?? 0) - 3 * 86400 } : i,
      ),
    };
    equal(
      [...replacementSuggestions(stopped, kinds, "2026-09-01").keys()],
      [newLink],
    );
    // A dismissed pair stays dismissed, across later discovery runs too.
    await cmd({
      type: "feed.dismiss",
      id: newLink,
      replaces: oldLink,
      reason: "Not a replacement",
    });
    await sync(
      [
        provider("card-2005", "Business Gold Card (-2005)"),
        provider("card-3007", "Business Gold Card (-3007)"),
        provider("savings", "Savings"),
      ],
      true,
    );
    state = await feeds();
    equal(state.identities.find((i) => i.id === newLink)?.not_replacing, [
      oldLink,
    ]);
    equal(replacementSuggestions(state, kinds, "2026-10-04").size, 0);
    // One open link per account: a second feed cannot map straight onto it.
    await rejects(
      cmd({
        type: "feed.map",
        id: newLink,
        expected_version: 0,
        ownership: "company",
        account_id: amex,
        history_start: String(noon("2026-08-01")),
        posting_timezone: "America/Phoenix",
        movement_sign: 1,
        balance_sign: 1,
        reviewed: true,
        reason: "Synthetic duplicate mapping",
      }),
      /bank_accounts_one_open_link/,
    );
    await cmd({
      type: "feed.link",
      id: newLink,
      expected_version: 0,
      account_id: amex,
      reason: "Linked as a replacement card",
    });
    await rejects(
      cmd({
        type: "feed.link",
        id: newLink,
        expected_version: 0,
        account_id: amex,
        reason: "Linked twice",
      }),
      /ACCT_STALE_VERSION/,
    );
    equal(
      await raw(
        "SELECT id::text,is_closed,closed_on::text,coverage_from::text FROM accounting.bank_accounts WHERE account_id=$1 ORDER BY is_closed DESC",
        [amex],
      ),
      [
        {
          id: oldLink,
          is_closed: true,
          closed_on: "2026-08-20",
          coverage_from: "2026-08-01",
        },
        {
          id: newLink,
          is_closed: false,
          closed_on: null,
          coverage_from: "2026-08-21",
        },
      ],
    );
    await rejects(
      raw(
        "INSERT INTO accounting.bank_accounts(account_id,is_closed) VALUES($1,false)",
        [amex],
      ),
      /bank_accounts_one_open_link/,
    );
    // Many closed links are fine.
    await raw(
      "INSERT INTO accounting.bank_accounts(account_id,is_closed,closed_on) VALUES($1,true,'2026-01-01')",
      [amex],
    );
    checks++;
    // The overlap is never imported twice; the retired number stops syncing.
    const sweep = await sync([
      provider("card-2005", "Business Gold Card (-2005)", [
        tx("old-3", "2026-08-28", "-700"),
      ]),
      provider("card-3007", "Business Gold Card (-3007)", [
        tx("new-overlap", "2026-08-20", "-2000"),
        tx("new-1", "2026-08-25", "-500"),
      ]),
      provider("savings", "Savings"),
    ]);
    equal(
      sweep.lease.identities.map((i: any) => i.provider_account_id).sort(),
      ["card-3007", "savings"],
    );
    equal(sweep.result.new, 1);
    equal(
      await raw(
        "SELECT b.id::text link,t.external_id FROM accounting.bank_transactions t JOIN accounting.bank_accounts b ON b.id=t.bank_account_id WHERE b.account_id=$1 ORDER BY t.posted_date",
        [amex],
      ),
      [
        { link: oldLink, external_id: "old-1" },
        { link: oldLink, external_id: "old-2" },
        { link: newLink, external_id: "new-1" },
      ],
    );
    // History stays on the one account, and the card shows the new number.
    equal(
      (
        await raw(
          "SELECT count(*)::int n FROM accounting.journal_lines WHERE account_id=$1",
          [amex],
        )
      )[0].n,
      3,
    );
    state = await feeds();
    equal(currentFeedAccount(state.accounts, amex)?.id, newLink);
    equal(
      bankIdentitiesByAccount(state).get(amex)?.name,
      "Business Gold Card (-3007)",
    );
    // The old link shows as retired.
    equal(
      state.identities.find((i) => i.id === oldLink)?.account?.is_closed,
      true,
    );
    // A closed account cannot take a new feed until it is reopened.
    await cmd({
      type: "account.close",
      id: card,
      expected_version: await version(card),
    });
    await rejects(
      cmd({
        type: "feed.link",
        id: await identityId("Gold Card (-9999)"),
        expected_version: 0,
        account_id: card,
        reason: "Synthetic",
      }),
      /ACCT_ACCOUNT_CLOSED/,
    );
    console.log(
      `Account close and feed link: ${checks} assertions passed (refusals, unchanged reports, reopen, one open link, overlap, replacement suggestions).`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
