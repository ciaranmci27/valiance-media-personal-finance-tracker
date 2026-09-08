import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import { extendedCommandSchema } from "../src/lib/accounting/workflows";
import { historyCompareSchema } from "../src/lib/accounting/history";
import {
  waveAccountProposals,
  waveReportControls,
} from "../src/lib/accounting/imports/wave";

/**
 * The Wave migration path the owner screens rely on: Wave names saved on
 * book accounts through chart.seed and account.update, report-level totals
 * compared and recorded through history_preview and history.check, and the
 * history view rows those screens render.
 */
const pnl = [
  "Profit and Loss",
  "Test Company",
  "Date Range: 2026-01-01 to 2026-12-31",
  "Report Type: Accrual (Paid & Unpaid)",
  '""',
  'ACCOUNT NUMBER,ACCOUNTS,"Jan 01, 2026 to Dec 31, 2026"',
  ',Total Income,"$500.00"',
  ",Total Cost of Goods Sold,$0.00",
  ',Gross Profit,"$500.00"',
  ",Total Operating Expenses,$200.00",
  ",Net Profit,$300.00",
  "",
].join("\n");
const balance = (asOf: string) =>
  [
    "Balance Sheet",
    "Test Company",
    `As of ${asOf}`,
    "Report Type: Accrual (Paid & Unpaid)",
    'ACCOUNT NUMBER,ACCOUNTS,"Dec 31"',
    ",Total Assets,$300.00",
    ",Total Liabilities,$0.00",
    ",Total Equity,$300.00",
    "",
  ].join("\n");
const ledger = [
  "Transaction ID,Transaction Date,Account Name,Transaction Description,Transaction Line Description,Amount (One column), ,Debit Amount (Two Column Approach),Credit Amount (Two Column Approach),Other Accounts for this Transaction,Customer,Vendor,Invoice Number,Bill Number,Notes / Memo,Amount Before Sales Tax,Sales Tax Amount,Sales Tax Name,Transaction Date Added,Transaction Date Last Modified,Account Group,Account Type,Account ID",
  "1001,2026-03-01,Test Checking,Client payment,Client payment,500.00,,500.00,,Sales,Acme,,,,,,,,2026-03-01,2026-03-01,Asset,Cash and Bank,A1",
  "1001,2026-03-01,Sales,Client payment,Client payment,-500.00,,,500.00,Test Checking,Acme,,,,,,,,2026-03-01,2026-03-01,Income,Income,I1",
  "1002,2026-04-02,Software,Editor license,Editor license,200.00,,200.00,,Test Checking,,Vendor Co,,,,,,,2026-04-02,2026-04-02,Expense,Expense,E1",
  "1002,2026-04-02,Test Checking,Editor license,Editor license,-200.00,,,200.00,Software,,Vendor Co,,,,,,,2026-04-02,2026-04-02,Asset,Cash and Bank,A1",
  "1003,2026-05-05,Accounts Receivable,Invoice 12,Invoice 12,100.00,,100.00,,Sales,Acme,,12,,,,,,2026-05-05,2026-05-05,Asset,Receivable,R1",
  "1003,2026-05-05,Sales,Invoice 12,Invoice 12,-100.00,,,100.00,Accounts Receivable,Acme,,12,,,,,,2026-05-05,2026-05-05,Income,Income,I1",
  "",
].join("\n");

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;
  const command = async (value: object, key = randomUUID()) =>
    (
      await db.query<{ r: Json }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb)) r",
        [key, JSON.stringify(value)],
      )
    ).rows[0].r;
  const context = async (view: string) =>
    (
      await db.query<{ r: Json }>(
        "SELECT accounting.context($1,'{}'::jsonb) r",
        [view],
      )
    ).rows[0].r;
  const previewTotals = async (controls: object) =>
    (
      await db.query<{ r: Json }>(
        "SELECT accounting.history_preview($1::jsonb) r",
        [JSON.stringify(controls)],
      )
    ).rows[0].r;
  try {
    // Parsers: the report metadata sets the period and kind; the ledger classifies accounts.
    const parsedPnl = waveReportControls(pnl, "2022-12-31");
    check(
      [
        parsedPnl.fiscal_year,
        parsedPnl.kind,
        parsedPnl.report_kind,
        parsedPnl.from,
        parsedPnl.to,
      ],
      [2026, "annual_totals", "profit_loss", "2026-01-01", "2026-12-31"],
    );
    check(parsedPnl.expected, {
      income_cents: "50000",
      cost_of_goods_sold_cents: "0",
      gross_profit_cents: "50000",
      operating_expense_cents: "20000",
      expense_cents: "20000",
      net_income_cents: "30000",
    });
    const parsedBalance = waveReportControls(
      balance("2026-12-31"),
      "2022-12-31",
    );
    check(
      [
        parsedBalance.kind,
        parsedBalance.report_kind,
        parsedBalance.from,
        parsedBalance.to,
      ],
      ["annual_totals", "balance_sheet", "2026-01-01", "2026-12-31"],
    );
    check(parsedBalance.expected, {
      assets_cents: "30000",
      liabilities_cents: "0",
      equity_total_cents: "30000",
    });
    const opening = waveReportControls(balance("2022-12-31"), "2022-12-31");
    check(
      [opening.kind, opening.from, opening.to],
      ["opening_balances", "2022-12-31", "2022-12-31"],
    );
    check(
      waveAccountProposals(ledger).map((p) => [p.name, p.type, p.subtype]),
      [
        ["Test Checking", "asset", "bank"],
        ["Sales", "income", "revenue"],
        ["Software", "expense", "operating_expense"],
        ["Accounts Receivable", "asset", "receivable"],
      ],
    );

    // Account mapping: a new Wave-classified account through chart.seed, a Wave name on an existing account through account.update.
    await command({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === fixtureAccountId(1) ? "bank" : "none",
      })),
    });
    const waveId = randomUUID();
    const seed = {
      type: "chart.seed",
      id: randomUUID(),
      accounts: [
        {
          id: waveId,
          name: "Software",
          code: "",
          account_type: "expense",
          normal_side: "debit",
          subtype: "operating_expense",
          external_names: { wave: "Software" },
        },
      ],
    };
    check(extendedCommandSchema.safeParse(seed).success, true);
    await command(seed);
    const manage = await context("manage");
    const bank = manage.profiles.find(
      (p: Json) => p.account_id === fixtureAccountId(1),
    );
    const bankAccount = fixtureAccounts.find(
      (a) => a.id === fixtureAccountId(1),
    )!;
    const update = {
      type: "account.update",
      id: fixtureAccountId(1),
      expected_version: bank.version,
      name: bankAccount.name,
      code: bankAccount.code ?? "",
      purpose: bank.purpose,
      cash_kind: bank.cash_kind,
      parent_account_id: bank.parent_account_id,
      subtype: bank.subtype,
      is_archived: false,
      external_names: { wave: "Test Checking" },
    };
    check(extendedCommandSchema.safeParse(update).success, true);
    await command(update);
    const linked = await context("manage");
    const profile = (id: string) =>
      linked.profiles.find((p: Json) => p.account_id === id);
    check(profile(fixtureAccountId(1)).external_names, {
      wave: "Test Checking",
    });
    check(profile(fixtureAccountId(1)).subtype, bank.subtype);
    check(
      [
        profile(waveId).type,
        profile(waveId).subtype,
        profile(waveId).external_names,
      ],
      ["expense", "operating_expense", { wave: "Software" }],
    );
    // A second account cannot take a Wave name already in use.
    await assert.rejects(
      command({
        ...seed,
        id: randomUUID(),
        accounts: [{ ...seed.accounts[0], id: randomUUID() }],
      }),
      /accounts_wave_name|duplicate key/,
    );
    checks++;

    // Report-level comparison: every stated key is compared, and the keys the report SQL lacks are refused.
    const annual = {
      from: "2026-01-01",
      to: "2026-12-31",
      kind: "annual_totals",
      expected: {
        income_cents: "50000",
        cost_of_goods_sold_cents: "0",
        gross_profit_cents: "50000",
        operating_expense_cents: "20000",
        expense_cents: "20000",
        net_income_cents: "30000",
        assets_cents: "30000",
        liabilities_cents: "0",
        equity_total_cents: "30000",
      },
    };
    check(historyCompareSchema.safeParse(annual).success, true);
    const preview = await previewTotals(annual);
    check(
      Object.keys(preview.difference).sort(),
      Object.keys(annual.expected).sort(),
    );
    check(
      [preview.differences, preview.ready, preview.partial_year],
      [7, false, false],
    );
    check(
      [preview.actual.income_cents, preview.difference.income_cents],
      ["0", "-50000"],
    );
    check(
      [
        preview.actual.cost_of_goods_sold_cents,
        preview.difference.liabilities_cents,
      ],
      ["0", "0"],
    );
    await assert.rejects(
      previewTotals({
        ...annual,
        expected: { ...annual.expected, bogus_cents: "1" },
      }),
      /ACCT_UNKNOWN_CONTROL/,
    );
    checks++;
    const openingControls = {
      from: "2025-12-31",
      to: "2025-12-31",
      kind: "opening_balances",
      expected: {
        assets_cents: "0",
        liabilities_cents: "0",
        equity_total_cents: "0",
      },
    };
    check(historyCompareSchema.safeParse(openingControls).success, true);
    check((await previewTotals(openingControls)).differences, 0);
    await assert.rejects(
      previewTotals({ ...openingControls, expected: { assets_cents: "0" } }),
      /ACCT_CONTROL_TOTALS_REQUIRED/,
    );
    checks++;

    // Recording: the reports are the evidence; an explained mismatch, then a match, then locked months.
    const doc = randomUUID();
    await command({
      type: "document.prepare",
      id: doc,
      original_name: "wave-reports-2026.csv",
      content_hash: "c".repeat(64),
      mime_type: "text/csv",
      size_bytes: "10",
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [`${doc}/${"c".repeat(64)}`],
    );
    await command({ type: "document.complete", id: doc, expected_version: 1 });
    // Storing evidence advances the revision; the screen compares again before recording.
    const fresh = await previewTotals(annual);
    assert.notEqual(fresh.revision, preview.revision);
    checks++;
    const explained = {
      type: "history.check",
      id: randomUUID(),
      expected_revision: fresh.revision,
      fiscal_year: 2026,
      kind: "annual_totals",
      from: annual.from,
      to: annual.to,
      document_id: doc,
      reason:
        "Wave 2026 profit and loss and balance sheet export, Accrual (Paid & Unpaid).",
      explanation: "The 2026 ledger is not imported yet.",
      source_report_type: "Accrual (Paid & Unpaid)",
      expected: annual.expected,
    };
    check(extendedCommandSchema.safeParse(explained).success, true);
    await command(explained);
    const view = await context("history");
    const row = view.checks.find((h: Json) => h.id === explained.id);
    check(
      [
        row.status,
        row.kind,
        row.fiscal_year,
        row.invalidated,
        row.source_document_id,
      ],
      ["explained", "annual_totals", 2026, false, doc],
    );
    check(
      [row.expected.from, row.expected.to, row.from_date, row.to_date],
      ["2026-01-01", "2026-12-31", "2026-01-01", "2026-12-31"],
    );
    check(
      [
        row.expected.income_cents,
        row.actual.income_cents,
        row.difference.income_cents,
      ],
      ["50000", "0", "-50000"],
    );
    check(
      [typeof row.checked_at, typeof row.created_at, row.explanation],
      ["string", "string", explained.explanation],
    );
    const zero = Object.fromEntries(
      Object.keys(annual.expected).map((k) => [k, "0"]),
    );
    // Each recording advances the revision, so the screen compares again first.
    const matched = {
      ...explained,
      id: randomUUID(),
      expected_revision: (await previewTotals({ ...annual, expected: zero }))
        .revision,
      explanation: undefined,
      expected: zero,
    };
    delete matched.explanation;
    await command(matched);
    const later = await context("history");
    check(
      later.checks.find((h: Json) => h.id === matched.id).status,
      "matches",
    );
    // The list is newest first, so the screen's latest row is the one that counts.
    check(later.checks[0].id, matched.id);
    await command({
      type: "history.lock",
      id: randomUUID(),
      expected_revision: later.revision,
      history_id: matched.id,
    });
    const locked = (await context("manage")).periods.filter(
      (p: Json) => p.is_locked && p.month_start.startsWith("2026"),
    );
    check(locked.length, 12);
    // Months lock once; a second lock from another accepted check is refused.
    await assert.rejects(
      command({
        type: "history.lock",
        id: randomUUID(),
        expected_revision: later.revision,
        history_id: explained.id,
      }),
      /ACCT_PERIOD_LOCKED|ACCT_STALE_REVISION/,
    );
    checks++;
    console.log(`Wave report verification passed with ${checks} checks.`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
