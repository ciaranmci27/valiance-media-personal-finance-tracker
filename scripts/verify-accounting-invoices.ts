import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";

type Candidate = {
  reason: string;
  auto: boolean;
  ambiguous: boolean;
  remaining_cents: string;
  invoices: { invoice_id: string; number: string; amount_cents: string }[];
};

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const rejects = async (p: Promise<unknown>, code: RegExp) => {
    await assert.rejects(p, code);
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db
        .query<{
          r: any;
        }>("SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r", [key, JSON.stringify(c)])
        .catch((e) => {
          throw new Error(`${JSON.stringify(c)}: ${e.message}`);
        })
    ).rows[0].r;
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const asSystem = async <T>(fn: () => Promise<T>) => {
    await db.exec("RESET ROLE");
    try {
      return await fn();
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const revision = () =>
    asSystem(() =>
      one<string>("SELECT financial_revision::text r FROM accounting.settings"),
    );
  // The mirror is the source's word: only a sync may write it, so the suite writes it the way a sync would.
  const mirror = (source: string, rows: Record<string, unknown>[]) =>
    asSystem(async () => {
      await db.exec("BEGIN");
      await db.query(
        "SELECT set_config('accounting.action','invoice_source.sync',true)",
      );
      for (const row of rows)
        await db.query(
          `INSERT INTO accounting.invoices(id,source_id,external_id,number,project_ref,project_name,issue_date,status,total_cents,lines)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]')`,
          [
            row.id,
            source,
            row.id,
            row.number,
            row.project,
            `Project ${row.project}`,
            row.issued,
            row.status ?? "issued",
            row.total,
          ],
        );
      await db.exec("COMMIT");
    });
  const deposit = async (
    date: string,
    cents: string,
    payee?: string,
    category?: string,
  ) =>
    cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo: `Deposit ${cents}`,
      payee_id: payee,
      lines: [
        { account_id: account(1), amount_cents: cents, memo: "" },
        {
          account_id: category ?? incomeSuspense,
          amount_cents: `-${cents}`,
          memo: "",
        },
      ],
    });
  const candidate = (entry: string) =>
    one<Candidate | null>(
      "SELECT accounting.entry_detail($1)->'invoice_suggestion' r",
      [entry],
    );
  const detail = (entry: string) =>
    one<any>("SELECT accounting.entry_detail($1) r", [entry]);
  const receivables = (view: object = {}) =>
    one<any>("SELECT accounting.receivables($1) r", [JSON.stringify(view)]);
  let incomeSuspense = "";

  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: [1, 9].some((n) => account(n) === a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      })),
    });
    incomeSuspense = await asSystem(() =>
      one<string>(
        "SELECT id r FROM accounting.accounts WHERE system_purpose='uncategorized_income'",
      ),
    );
    const clientA = randomUUID(),
      vendor = randomUUID();
    await cmd({
      type: "party.save",
      id: clientA,
      expected_version: 0,
      name: "Acme Estates",
      roles: ["client"],
    });
    await cmd({
      type: "party.save",
      id: vendor,
      expected_version: 0,
      name: "Paper Supply",
      roles: ["vendor"],
    });

    // ---- Connection --------------------------------------------------------
    const source = randomUUID();
    const base = {
      type: "invoice_source.save",
      id: source,
      expected_version: 0,
      name: "PM app",
      base_url: "https://pm.example.com/",
      api_key_encrypted: "v1:iv:tag:cipher",
      account_map: {
        hourly: account(5),
        fixed: account(5),
        recurring: account(5),
      },
      party_map: { "proj-a": clientA },
    };
    await rejects(
      cmd({ ...base, base_url: "http://pm.example.com" }),
      /ACCT_INVALID_SOURCE_URL/,
    );
    await rejects(
      cmd({ ...base, api_key_encrypted: "" }),
      /ACCT_SOURCE_KEY_REQUIRED/,
    );
    await rejects(
      cmd({ ...base, account_map: { hourly: account(6) } }),
      /ACCT_INVALID_ACCOUNT_MAP/,
    );
    await rejects(
      cmd({ ...base, account_map: { tips: account(5) } }),
      /ACCT_INVALID_ACCOUNT_MAP/,
    );
    await rejects(
      cmd({ ...base, account_map: { hourly: incomeSuspense } }),
      /ACCT_INVALID_ACCOUNT_MAP/,
    );
    await rejects(
      cmd({ ...base, party_map: { "proj-a": vendor } }),
      /ACCT_INVALID_PARTY_MAP/,
    );
    const saved = await cmd(base);
    check(saved.version, 1);
    check(Object.keys(saved.accounts).sort(), [
      "accounts_receivable",
      "deferred_revenue",
      "unbilled_revenue",
    ]);
    // The first connection starts the accrual view on the first of a year, and creates its three lines once.
    check(
      await asSystem(() =>
        one<string>(
          "SELECT to_char(accrual_start,'MM-DD') r FROM accounting.settings",
        ),
      ),
      "01-01",
    );
    await rejects(cmd({ ...base, expected_version: 0 }), /ACCT_STALE_VERSION/);
    const resaved = await cmd({
      type: "invoice_source.save",
      id: source,
      expected_version: 1,
      auto_link: true,
    });
    check(resaved.version, 2);
    check(resaved.accounts, saved.accounts);
    check(
      await asSystem(() =>
        one<number>(
          "SELECT count(*)::int r FROM accounting.accounts WHERE system_purpose IN ('accounts_receivable','unbilled_revenue','deferred_revenue')",
        ),
      ),
      3,
    );
    // The trailing slash is dropped, and the key never leaves the database or reaches the audit log.
    const read = await receivables();
    check(read.sources[0].base_url, "https://pm.example.com");
    check("api_key_encrypted" in read.sources[0], false);
    check(
      await asSystem(() =>
        one<number>(
          "SELECT count(*)::int r FROM accounting.audit_log WHERE table_name='invoice_sources' AND (after ? 'api_key_encrypted' OR before ? 'api_key_encrypted')",
        ),
      ),
      0,
    );
    const second = randomUUID();
    await rejects(
      cmd({ ...base, id: second, base_url: "https://pm.example.com" }),
      /ACCT_SOURCE_EXISTS/,
    );

    // ---- The accrual lines are never posted to ------------------------------
    await rejects(
      cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: "2026-05-01",
        memo: "Manual receivable",
        lines: [
          {
            account_id: saved.accounts.accounts_receivable,
            amount_cents: "1000",
            memo: "",
          },
          { account_id: account(5), amount_cents: "-1000", memo: "" },
        ],
      }),
      /ACCT_ACCRUAL_ACCOUNT/,
    );

    // ---- The mirror is source-only ------------------------------------------
    await rejects(
      asSystem(() =>
        db.query(
          "INSERT INTO accounting.invoices(source_id,external_id,project_ref,issue_date,status,total_cents) VALUES($1,'x','proj-a','2026-01-01','issued',1)",
          [source],
        ),
      ),
      /ACCT_SOURCE_ONLY/,
    );
    const inv = {
      one: randomUUID(),
      two: randomUUID(),
      three: randomUUID(),
      other: randomUUID(),
      voided: randomUUID(),
      draft: randomUUID(),
      small: randomUUID(),
    };
    await mirror(source, [
      {
        id: inv.one,
        number: "INV-1",
        project: "proj-a",
        issued: "2026-03-01",
        total: "500000",
      },
      {
        id: inv.two,
        number: "INV-2",
        project: "proj-a",
        issued: "2026-03-15",
        total: "200000",
      },
      {
        id: inv.three,
        number: "INV-3",
        project: "proj-a",
        issued: "2026-04-01",
        total: "300000",
      },
      {
        id: inv.other,
        number: "INV-4",
        project: "proj-b",
        issued: "2026-03-01",
        total: "123400",
      },
      {
        id: inv.voided,
        number: "INV-5",
        project: "proj-a",
        issued: "2026-03-01",
        total: "500000",
        status: "void",
      },
      {
        id: inv.draft,
        number: "INV-6",
        project: "proj-a",
        issued: "2026-03-01",
        total: "777700",
        status: "draft",
      },
      {
        id: inv.small,
        number: "INV-7",
        project: "proj-b",
        issued: "2026-03-01",
        total: "100000",
      },
    ]);
    check((await receivables()).total, 5);

    // ---- Matching -------------------------------------------------------------
    const d1 = await deposit("2026-03-10", "500000", clientA);
    const d2 = await deposit("2026-04-05", "500000", clientA);
    const d3 = await deposit("2026-03-20", "123400");
    const expense = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-03-11",
      memo: "Paper",
      lines: [
        { account_id: account(1), amount_cents: "-5000", memo: "" },
        { account_id: account(6), amount_cents: "5000", memo: "" },
      ],
    });
    const first = await candidate(d1.id);
    // One open invoice for the client at exactly the amount (the voided one never counts): links on its own.
    check(
      [
        first?.reason,
        first?.auto,
        first?.ambiguous,
        first?.invoices.map((i) => i.number),
      ],
      ["exact_client", true, false, ["INV-1"]],
    );
    // An unknown payer: a unique amount anywhere is only a suggestion.
    const third = await candidate(d3.id);
    check(
      [third?.reason, third?.auto, third?.invoices.map((i) => i.number)],
      ["exact_amount", false, ["INV-4"]],
    );
    check(await candidate(expense.id), null);

    const before = await revision();
    const auto = await cmd({ type: "invoice.auto_link", id: randomUUID() });
    check(auto.count, 1);
    check(auto.links[0].entry_id, d1.id);
    check(BigInt(await revision()) > BigInt(before), true);
    check(
      (await cmd({ type: "invoice.auto_link", id: randomUUID() })).count,
      0,
    );
    const linked = (await detail(d1.id)).invoice_links;
    check(
      [
        linked.length,
        linked[0].number,
        linked[0].matched_by,
        linked[0].sync_state,
        linked[0].live,
      ],
      [1, "INV-1", "rule", "pending", true],
    );
    check(await candidate(d1.id), null);

    // Two of the client's invoices come to exactly the second deposit: suggested, never linked on its own.
    const pair = await candidate(d2.id);
    check(
      [pair?.reason, pair?.auto, pair?.invoices.map((i) => i.number)],
      ["sum_client", false, ["INV-2", "INV-3"]],
    );

    // ---- Linking ---------------------------------------------------------------
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: expense.id,
        allocations: [{ invoice_id: inv.other, amount_cents: "5000" }],
      }),
      /ACCT_LINK_DEPOSIT_REQUIRED/,
    );
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: d3.id,
        allocations: [{ invoice_id: inv.other, amount_cents: "200000" }],
      }),
      /ACCT_LINK_EXCEEDS_INVOICE/,
    );
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: d3.id,
        allocations: [{ invoice_id: inv.one, amount_cents: "1000" }],
      }),
      /ACCT_LINK_INVOICE_NOT_OPEN/,
    );
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: d3.id,
        allocations: [{ invoice_id: inv.draft, amount_cents: "1000" }],
      }),
      /ACCT_LINK_INVOICE_NOT_OPEN/,
    );
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: d3.id,
        allocations: [
          { invoice_id: inv.other, amount_cents: "123400" },
          { invoice_id: inv.small, amount_cents: "1" },
        ],
      }),
      /ACCT_LINK_EXCEEDS_DEPOSIT/,
    );
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: d3.id,
        allocations: [{ invoice_id: inv.other, amount_cents: "-5" }],
      }),
      /ACCT_INVALID_COMMAND/,
    );
    const both = await cmd({
      type: "invoice.link",
      id: randomUUID(),
      entry_id: d2.id,
      expected_version: d2.version,
      allocations: [
        { invoice_id: inv.two, amount_cents: "200000" },
        { invoice_id: inv.three, amount_cents: "300000" },
      ],
    });
    check(both.links.length, 2);
    // A partial payment leaves the rest of the invoice open.
    await cmd({
      type: "invoice.link",
      id: randomUUID(),
      entry_id: d3.id,
      allocations: [{ invoice_id: inv.small, amount_cents: "60000" }],
    });
    const open = await receivables({ status: "open" });
    const small = open.invoices.find((i: any) => i.number === "INV-7");
    check([small.linked_cents, small.outstanding_cents], ["60000", "40000"]);
    check(open.invoices.map((i: any) => i.number).sort(), ["INV-4", "INV-7"]);
    // The deposit had 123,400 and applied 60,000: the rest no longer matches INV-4 exactly.
    check(await candidate(d3.id), null);

    // ---- A link is fixed; it only ends ------------------------------------------
    const link = (await detail(d1.id)).invoice_links[0];
    await rejects(
      asSystem(() =>
        db.query(
          "UPDATE accounting.invoice_payments SET amount_cents=1 WHERE id=$1",
          [link.id],
        ),
      ),
      /ACCT_LINK_IMMUTABLE/,
    );
    await rejects(
      asSystem(() =>
        db.query("DELETE FROM accounting.invoice_payments WHERE id=$1", [
          link.id,
        ]),
      ),
      /ACCT_NO_HARD_DELETE/,
    );
    // Push bookkeeping never moves the books revision.
    const quiet = await revision();
    await asSystem(() =>
      db.query(
        "UPDATE accounting.invoice_payments SET attempts=1 WHERE id=$1",
        [link.id],
      ),
    );
    check(await revision(), quiet);
    const bumped = await asSystem(() =>
      one<number>(
        "SELECT version r FROM accounting.invoice_payments WHERE id=$1",
        [link.id],
      ),
    );
    await rejects(
      cmd({ type: "invoice.unlink", id: link.id, expected_version: bumped }),
      /ACCT_REASON_REQUIRED/,
    );
    await rejects(
      cmd({
        type: "invoice.unlink",
        id: link.id,
        expected_version: bumped - 1,
        reason: "Wrong invoice",
      }),
      /ACCT_STALE_VERSION/,
    );
    await cmd({
      type: "invoice.unlink",
      id: link.id,
      expected_version: bumped,
      reason: "Wrong invoice",
    });
    check(
      await asSystem(() =>
        one<string>(
          "SELECT sync_state r FROM accounting.invoice_payments WHERE id=$1",
          [link.id],
        ),
      ),
      "removed",
    );
    check((await detail(d1.id)).invoice_links, []);
    // An ended link is never redone by the matcher, though the owner can still link it by hand.
    check(
      (await cmd({ type: "invoice.auto_link", id: randomUUID() })).count,
      0,
    );
    check((await candidate(d1.id))?.reason, "exact_client");

    // ---- Links stop counting when their deposit goes away ------------------------
    const d2now = await detail(d2.id);
    await cmd({
      type: "draft.discard",
      id: d2.id,
      expected_version: d2now.version,
      reason: "Duplicate import",
    });
    const after = await receivables({ status: "open" });
    check(after.invoices.map((i: any) => i.number).sort(), [
      "INV-1",
      "INV-2",
      "INV-3",
      "INV-4",
      "INV-7",
    ]);
    const two = (await receivables({ status: "all" })).invoices.find(
      (i: any) => i.number === "INV-2",
    );
    check(
      [two.links.length, two.links[0].live, two.outstanding_cents],
      [1, false, "200000"],
    );

    // ---- Locked months -------------------------------------------------------------
    const january = await deposit("2026-01-12", "100000", clientA, account(5));
    const posted = await detail(january.id);
    await cmd({
      type: "entry.post",
      id: january.id,
      expected_version: posted.version,
    });
    await cmd({ type: "period.lock", month: "2026-01-01" });
    await rejects(
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: january.id,
        allocations: [{ invoice_id: inv.small, amount_cents: "1000" }],
      }),
      /ACCT_PERIOD_LOCKED/,
    );

    // ---- The accrual start is the first of a month ---------------------------------
    const prefs = await one<any>("SELECT accounting.context('manage') r");
    await rejects(
      cmd({
        type: "settings.save",
        id: randomUUID(),
        expected_version: prefs.preferences.version,
        accrual_start: "2026-02-15",
      }),
      /ACCT_INVALID_ACCRUAL_START/,
    );
    const moved = await revision();
    await cmd({
      type: "settings.save",
      id: randomUUID(),
      expected_version: prefs.preferences.version,
      accrual_start: "2026-02-01",
    });
    check((await receivables()).accrual_start, "2026-02-01");
    check(BigInt(await revision()) > BigInt(moved), true);

    console.log(`Invoice sources and deposit links: ${checks} checks passed.`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
