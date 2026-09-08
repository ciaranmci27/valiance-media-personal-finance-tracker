import assert from "node:assert/strict";
import {payrollCommandSchema} from '../src/lib/accounting/payroll';
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  try {
    const check = (a: unknown, b: unknown) => {
      assert.deepEqual(a, b);
      n++;
    };
    const cmd = async (command: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key: randomUUID(), command }),
        ])
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: a.id === account(1) ? "bank" : "none",
      });
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-payroll.pdf",
      mime_type: "application/pdf",
      size_bytes: "12",
      content_hash: "8".repeat(64),
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    const run = await cmd(payrollCommandSchema.parse({
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: "SYNTHETIC-PAYROLL-001",
      reason: "Synthetic cash payroll approval source",
      document_id: doc.id,
      body: {
        pay_date: "2026-09-01",
        period_start: "2026-08-16",
        period_end: "2026-08-31",
        gross_cents: "500000",
        net_cents: "380000",
        employee_withholding_cents: "120000",
        employer_tax_cents: "38250",
        components: [
          { kind: "employee_tax", amount_cents: "120000" },
          { kind: "employer_tax", amount_cents: "38250" },
        ],
      },
      ytd: {
        verified: true,
        through: "2026-09-01",
        federal_taxable_cents: "3000000",
        federal_withheld_cents: "400000",
      },
    }));
    const preview=(await db.query<{r:any}>('SELECT accounting.payroll($1) r',[JSON.stringify({view:'detail',id:run.id,bank_account_id:account(1)})])).rows[0].r;
    check(preview.preview.ready,true);check(preview.preview.totals.gross_cents,'500000');check(preview.preview.lines.map((l:any)=>l.amount_cents),['500000','38250','-380000','-158250']);check(preview.register.body.declared_net_cents,'380000');
    const missingBank=(await db.query<{r:any}>('SELECT accounting.payroll($1) r',[JSON.stringify({view:'detail',id:run.id})])).rows[0].r;
    check(missingBank.preview.ready,false);check(missingBank.preview.issues,['ACCT_BANK_ACCOUNT_REQUIRED']);
    const listing=async(view:object)=>(await db.query<{r:any}>('SELECT accounting.payroll($1) r',[JSON.stringify(view)])).rows[0].r;
    check((await listing({year:2026,as_of:'2026-08-31'})).count,0);
    check((await listing({year:2026,as_of:'2026-09-01',query:'NO-MATCH'})).count,0);
    const page=await listing({year:2026,as_of:'2026-09-01',offset:1});check(page.rows.length,0);check(page.count,1);check(page.totals.gross_cents,'500000');
    await db.exec("RESET ROLE");
    const mapped = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.bank_accounts(account_id) VALUES($1) RETURNING id",
        [account(1)],
      )
    ).rows[0];
    await db.exec("SET ROLE authenticated");
    await db.exec("RESET ROLE");
    for (const [external, amount] of [
      ["SYN-NET", "-380000"],
      ["SYN-TAX", "-158250"],
    ])
      await db.query(
        "INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,amount_cents,description,descriptor_key,content_hash,raw_payload,state) VALUES($1,'csv',$2,'2026-09-01',$3,'Synthetic payroll','','fixture-hash','{}','posted')",
        [mapped.id, external, amount],
      );
    await db.exec("SET ROLE authenticated");
    const posted = await cmd({
      type: "payroll.post",
      id: run.id,
      expected_version: run.version,
      bank_account_id: account(1),
    });
    const e = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
        posted.entry_id,
      ])
    ).rows[0].r;
    check(
      e.lines.map((l: any) => l.amount_cents),
      ["500000", "38250", "-380000", "-158250"],
    );
    check(e.lines.filter((l: any) => l.account_id === account(1)).length, 2);
    check(e.matches.length, 2);
    await assert.rejects(
      cmd({
        type: "entry.reverse",
        id: e.id,
        expected_version: e.version,
        entry_date: "2026-09-01",
        reason: "Bypass payroll",
      }),
      /ACCT_PAYROLL_VOID_REQUIRED/,
    );
    n++;
    await cmd({
      type: "payroll.void",
      id: run.id,
      expected_version: posted.version,
      effective_date: "2026-09-02",
      reason: "Synthetic void",
    });
    check(
      (await db.query<{ r: any }>("SELECT accounting.payroll() r")).rows[0].r
        .rows[0].status,
      "void",
    );
    const asset = randomUUID(),
      contra = randomUUID(),
      expense = randomUUID();
    for (const a of [
      {
        id: asset,
        name: "Synthetic asset",
        account_type: "asset",
        subtype: "fixed_asset",
      },
      {
        id: contra,
        name: "Synthetic accumulated depreciation",
        account_type: "asset",
        subtype: "accumulated_depreciation",
        is_contra: true,
      },
      {
        id: expense,
        name: "Synthetic depreciation expense",
        account_type: "expense",
        subtype: "operating_expense",
      },
    ])
      await cmd({ type: "account.create", expected_version: 0, ...a });
    let register = await cmd({
      type: "register.save",
      id: randomUUID(),
      expected_version: 0,
      kind: "asset",
      body: {
        name: "Synthetic workstation",
        started_on: "2026-01-01",
        in_service_on: "2026-01-01",
        initial_cents: "240000",
        account_id: asset,
        accumulated_account_id: contra,
        expense_account_id: expense,
        method: "Owner-provided schedule",
        terms: "",
      },
    });
    let movement = await cmd({
      type: "register.post",
      id: randomUUID(),
      register_id: register.id,
      expected_version: register.version,
      body: {
        kind: "acquisition",
        date: "2026-01-01",
        amount_cents: "240000",
        counter_account_id: account(1),
      },
      mode: "new",
      reason: "Synthetic asset purchase",
    });
    const depreciation = await cmd({
      type: "register.post",
      id: randomUUID(),
      register_id: register.id,
      expected_version: movement.version,
      body: { kind: "depreciation", date: "2026-01-31", amount_cents: "4000" },
      mode: "new",
      reason: "Synthetic schedule amount",
    });
    await assert.rejects(
      cmd({
        type: "register.post",
        id: randomUUID(),
        register_id: register.id,
        expected_version: depreciation.version,
        body: {
          kind: "depreciation",
          date: "2026-02-28",
          amount_cents: "240000",
        },
        mode: "new",
        reason: "Excess depreciation",
      }),
      /ACCT_DEPRECIATION_EXCEEDS_BASIS/,
    );
    n++;
    check(
      (await db.query<{ r: any }>("SELECT accounting.registers() r")).rows[0].r
        .rows[0].book_cents,
      "240000",
    );
    const r = (
      await db.query<{ r: any }>(
        'SELECT accounting.report(\'profit_loss\',\'{"from":"2026-01-01","to":"2026-12-31"}\') r',
      )
    ).rows[0].r;
    check(r.expense_cents, "4000");
    check(r.assets_cents, "-4000");
    check(r.balance_difference_cents, "0");

    const loanAccount = randomUUID();
    await cmd({
      type: "account.create",
      id: loanAccount,
      name: "Synthetic loan",
      account_type: "liability",
      subtype: "loan",
      expected_version: 0,
    });
    const loan = await cmd({
      type: "register.save",
      id: randomUUID(),
      expected_version: 0,
      kind: "loan",
      body: {
        name: "Synthetic financing",
        started_on: "2026-01-01",
        initial_cents: "100000",
        account_id: loanAccount,
        expense_account_id: expense,
        fee_account_id: expense,
        lender: "Synthetic lender",
        terms: "",
      },
    });
    const draw = await cmd({
      type: "register.post",
      id: randomUUID(),
      register_id: loan.id,
      expected_version: loan.version,
      body: {
        kind: "draw",
        date: "2026-01-01",
        amount_cents: "100000",
        counter_account_id: account(1),
      },
      mode: "new",
      reason: "Synthetic loan proceeds",
    });
    const payment = await cmd({
      type: "register.post",
      id: randomUUID(),
      register_id: loan.id,
      expected_version: draw.version,
      body: {
        kind: "payment",
        date: "2026-02-01",
        amount_cents: "10000",
        interest_cents: "1000",
        fee_cents: "200",
        counter_account_id: account(1),
      },
      mode: "new",
      reason: "Synthetic principal and interest",
    });
    const loanState = (
      await db.query<{ r: any }>("SELECT accounting.registers() r")
    ).rows[0].r.rows.find((row: any) => row.id === loan.id);
    check(loanState.book_cents, "-90000");
    await assert.rejects(
      cmd({
        type: "register.post",
        id: randomUUID(),
        register_id: loan.id,
        expected_version: payment.version,
        body: {
          kind: "payment",
          date: "2026-02-02",
          amount_cents: "90001",
          counter_account_id: account(1),
        },
        mode: "new",
        reason: "Excess principal",
      }),
      /ACCT_LOAN_PAYMENT_EXCEEDS_PRINCIPAL/,
    );
    n++;

    const accrual = await cmd({
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: "SYN-ACCRUAL",
      document_id: doc.id,
      body: {
        pay_date: "2026-10-01",
        period_start: "2026-09-01",
        period_end: "2026-09-30",
        gross_cents: "100000",
        net_cents: "80000",
        components: [
          {
            kind: "officer_wages",
            amount_cents: "100000",
            account_id: account(7),
          },
          { kind: "net_pay", amount_cents: "80000", account_id: account(8) },
          {
            kind: "employee_tax",
            amount_cents: "20000",
            account_id: account(8),
          },
          {
            kind: "employer_tax",
            amount_cents: "7650",
            account_id: expense,
            offset_account_id: account(8),
          },
        ],
      },
    });
    const accrue = await cmd({
      type: "payroll.approve",
      id: accrual.id,
      expected_version: accrual.version,
      template: "accrual",
      mode: "new",
    });
    check(
      (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          accrue.entry_id,
        ])
      ).rows[0].r.lines.map((l: any) => l.amount_cents),
      ["100000", "-80000", "-20000", "7650", "-7650"],
    );
    await assert.rejects(
      cmd({
        type: "payroll.post",
        id: accrual.id,
        expected_version: accrual.version,
        bank_account_id: account(1),
      }),
      /ACCT_STALE_VERSION/,
    );
    n++;
    await assert.rejects(
      cmd({
        type: "payroll.discard",
        id: accrual.id,
        expected_version: accrue.version,
        reason: "Invalid discard",
      }),
      /ACCT_PAYROLL_DISCARD/,
    );
    n++;
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query("UPDATE accounting.payroll_runs SET gross_cents=1 WHERE id=$1", [
        accrual.id,
      ]),
      /ACCT_PAYROLL_IMMUTABLE/,
    );
    n++;
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      db.query("SELECT * FROM accounting.payroll_runs"),
      /permission denied/,
    );
    n++;
    const contractors = (
      await db.query<{ r: any }>("SELECT accounting.contractor_report(2026) r")
    ).rows[0].r;
    check(contractors.threshold_cents, "200000");
    const beforeVoid = (
      await db.query<{ r: any }>(
        'SELECT accounting.payroll(\'{"year":2026,"through":"2026-09-01"}\') r',
      )
    ).rows[0].r;
    check(beforeVoid.run_count, 1);
    check(beforeVoid.coverage.current, true);
    check(
      (
        await db.query<{ r: any }>(
          'SELECT accounting.payroll(\'{"year":2026,"through":"2026-09-02"}\') r',
        )
      ).rows[0].r.run_count,
      0,
    );
    const mismatch = await cmd({
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: "SYN-NET-MISMATCH",
      document_id: doc.id,
      body: {
        pay_date: "2026-11-01",
        period_start: "2026-10-01",
        period_end: "2026-10-31",
        gross_cents: "10000",
        net_cents: "10000",
        components: [{ kind: "net_pay", amount_cents: "9999" }],
      },
    });
    await assert.rejects(
      cmd({
        type: "payroll.post",
        id: mismatch.id,
        expected_version: mismatch.version,
        bank_account_id: account(1),
      }),
      /ACCT_PAYROLL_TOTALS/,
    );
    n++;
    let benefit = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-10-01",
      memo: "Synthetic original benefit",
      lines: [
        { account_id: expense, amount_cents: "5000" },
        { account_id: account(1), amount_cents: "-5000" },
      ],
    });
    benefit = await cmd({
      type: "entry.post",
      id: benefit.id,
      expected_version: benefit.version,
    });
    const sourceLine = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
        benefit.id,
      ])
    ).rows[0].r.lines.find((l: any) => l.account_id === expense);
    const component = {
      kind: "noncash_reclass",
      amount_cents: "4000",
      account_id: account(7),
      offset_account_id: expense,
      source_line_id: sourceLine.id,
    };
    const over = await cmd({
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: "SYN-NONCASH-DUPLICATE",
      document_id: doc.id,
      body: {
        pay_date: "2026-11-01",
        period_start: "2026-10-01",
        period_end: "2026-10-31",
        gross_cents: "10000",
        net_cents: "10000",
        components: [
          {
            kind: "officer_wages",
            amount_cents: "10000",
            account_id: account(7),
          },
          { kind: "net_pay", amount_cents: "10000", account_id: account(8) },
          component,
          component,
        ],
      },
    });
    await assert.rejects(
      cmd({
        type: "payroll.post",
        id: over.id,
        expected_version: over.version,
        template: "accrual",
      }),
      /ACCT_NONCASH_CAPACITY/,
    );
    n++;
    console.log("Payroll and register integration:", n, "checks passed");
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    e.message,
    e.where,
    "position",
    e.position,
    e.query?.slice(Number(e.position) - 100, Number(e.position) + 120),
  );
  process.exitCode = 1;
});
