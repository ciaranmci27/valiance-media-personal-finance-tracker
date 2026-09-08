import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  supportReportDocument,
  type SupportReportSnapshot,
} from "../src/lib/accounting/support-reports";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const fail = async (work: () => Promise<unknown>, error: RegExp) => {
    await assert.rejects(work, error);
    checks++;
  };
  const cmd = async (command: object, key = randomUUID()) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key, command }),
      ])
    ).rows[0].r;
  try {
    const accounts: Record<string, string> = {};
    for (const [name, type, subtype, is_contra] of [
      ["bank", "asset", "bank", false],
      ["asset", "asset", "fixed_asset", false],
      ["accum", "asset", "accumulated_depreciation", true],
      ["depreciation", "expense", "operating_expense", false],
      ["loss", "expense", "operating_expense", false],
      ["gain", "income", "revenue", false],
      ["loan", "liability", "loan", false],
      ["interest", "expense", "operating_expense", false],
      ["fees", "expense", "operating_expense", false],
    ] as const) {
      accounts[name] = randomUUID();
      await cmd({
        type: "account.create",
        id: accounts[name],
        name: "Synthetic " + name,
        account_type: type,
        subtype,
        is_contra,
      });
    }
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-register.pdf",
      mime_type: "application/pdf",
      size_bytes: "100",
      content_hash: "b".repeat(64),
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
    const detail = async (id: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.registers() r")
      ).rows[0].r.rows.find((r: any) => r.id === id);
    const entry = async (id: string) =>
      (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
        .rows[0].r;
    const assetBody = {
      name: "Synthetic workstation",
      started_on: "2026-01-01",
      in_service_on: "2026-01-02",
      initial_cents: "100000",
      account_id: accounts.asset,
      accumulated_account_id: accounts.accum,
      expense_account_id: accounts.depreciation,
      method: "Owner-provided book schedule",
      terms: "",
    };
    const create = async (kind: string, body: object) =>
      cmd({
        type: "register.save",
        id: randomUUID(),
        expected_version: 0,
        kind,
        body,
        document_id: doc.id,
        reason: "Synthetic register",
      });
    const post = async (
      register_id: string,
      body: object,
      extra: object = {},
    ) =>
      cmd({
        type: "register.post",
        id: randomUUID(),
        register_id,
        expected_version: (await detail(register_id)).version,
        body,
        mode: "new",
        document_id: doc.id,
        verified: true,
        reason: "Synthetic reviewed movement",
        ...extra,
      });
    const voidMovement = async (
      register_id: string,
      movement_id: string,
      date: string,
    ) =>
      cmd({
        type: "register.void",
        id: randomUUID(),
        register_id,
        expected_version: (await detail(register_id)).version,
        movement_id,
        date,
        reason: "Synthetic correction",
      });
    const report = async (
      report_id = "asset-register",
      to = "2026-08-31",
      extra: object = {},
    ) =>
      (
        await db.query<{ r: any }>("SELECT accounting.support_report($1) r", [
          JSON.stringify({
            report_id,
            from: to.slice(0, 7) + "-01",
            to,
            offset: 0,
            ...extra,
          }),
        ])
      ).rows[0].r;
    const asset = await create("asset", assetBody);
    check((await detail(asset.id)).book_cents, "0");
    const acquire = {
      kind: "acquisition",
      date: "2026-01-01",
      amount_cents: "100000",
      counter_account_id: accounts.bank,
    };
    await fail(
      () => post(asset.id, { ...acquire, amount_cents: "99999" }),
      /ACCT_REGISTER_COST/,
    );
    const planned=(await db.query<{r:any}>('SELECT accounting.registers($1) r',[JSON.stringify({view:'preview',id:asset.id,body:acquire})])).rows[0].r;
    check(planned.cost_delta,'100000');check(planned.lines,[{account_id:accounts.asset,amount_cents:'100000'},{account_id:accounts.bank,amount_cents:'-100000'}]);
    const acquired = await post(asset.id, acquire);
    const screen=(await db.query<{r:any}>('SELECT accounting.registers($1) r',[JSON.stringify({view:'detail',id:asset.id,date:'2026-01-01'})])).rows[0].r;
    check(screen.body.initial_cents,'100000');check(screen.state.carrying_cents,'100000');check(screen.movements[0].entry_id,acquired.entry_id);check(screen.record.body.name,'Synthetic workstation');

    check((await detail(asset.id)).book_cents, "100000");
    await fail(() => post(asset.id, acquire), /ACCT_REGISTER_COST/);
    await fail(
      async () =>
        cmd({
          type: "register.save",
          id: asset.id,
          kind: "asset",
          expected_version: (await detail(asset.id)).version,
          body: { ...assetBody, initial_cents: "200000" },
          reason: "Synthetic changed cost",
        }),
      /ACCT_REGISTER_FINANCIAL_TERMS_FROZEN/,
    );
    await fail(
      () =>
        post(asset.id, {
          kind: "depreciation",
          date: "2026-01-01",
          amount_cents: "1000",
        }),
      /ACCT_DEPRECIATION_EXCEEDS_BASIS/,
    );
    const dep = await post(asset.id, {
      kind: "depreciation",
      date: "2026-06-30",
      amount_cents: "20000",
    });
    check((await report()).total_cells, [
      "Total",
      "",
      "100000",
      "20000",
      "80000",
    ]);
    await fail(
      () =>
        post(asset.id, {
          kind: "depreciation",
          date: "2026-07-01",
          amount_cents: "80001",
        }),
      /ACCT_DEPRECIATION_EXCEEDS_BASIS/,
    );
    await fail(
      () => voidMovement(asset.id, acquired.entry_id, "2026-07-01"),
      /ACCT_REGISTER_NEGATIVE_BASIS/,
    );
    const disposal = {
      kind: "disposal",
      date: "2026-08-01",
      amount_cents: "75000",
      counter_account_id: accounts.bank,
      gain_loss_account_id: accounts.loss,
    };
    await fail(
      () =>
        post(asset.id, { ...disposal, gain_loss_account_id: accounts.gain }),
      /ACCT_REGISTER_GAIN_LOSS_ACCOUNT/,
    );
    const disposed = await post(asset.id, disposal);
    check(
      (await entry(disposed.entry_id)).lines.find(
        (l: any) => l.account_id === accounts.loss,
      ).amount_cents,
      "5000",
    );
    check((await report()).total_cells, ["Total", "", "0", "0", "0"]);
    check((await detail(asset.id)).status, "disposed");
    check(
      (await report("asset-register", "2026-07-31")).total_cells[4],
      "80000",
    );
    await fail(
      () => voidMovement(asset.id, dep.entry_id, "2026-08-02"),
      /ACCT_REGISTER_NEGATIVE_BASIS/,
    );
    await voidMovement(asset.id, disposed.entry_id, "2026-08-02");
    check((await report()).total_cells[4], "80000");
    await voidMovement(asset.id, dep.entry_id, "2026-08-02");
    check((await report()).total_cells[4], "100000");
    const loanBody = {
      name: "Synthetic equipment loan",
      started_on: "2026-01-01",
      initial_cents: "500000",
      account_id: accounts.loan,
      expense_account_id: accounts.interest,
      fee_account_id: accounts.fees,
      lender: "Synthetic lender",
      terms: "Amounts supplied by owner; no inferred interest",
    };
    const loan = await create("loan", loanBody);
    await post(loan.id, {
      kind: "draw",
      date: "2026-01-01",
      amount_cents: "500000",
      counter_account_id: accounts.bank,
    });
    check((await detail(loan.id)).book_cents, "-500000");
    const payment = {
      kind: "payment",
      date: "2026-02-01",
      amount_cents: "100000",
      interest_cents: "2500",
      fee_cents: "500",
      counter_account_id: accounts.bank,
    };
    const paymentEntry = await post(loan.id, payment);
    check(
      (await entry(paymentEntry.entry_id)).lines.find(
        (l: any) => l.account_id === accounts.bank,
      ).amount_cents,
      "-103000",
    );
    check((await detail(loan.id)).book_cents, "-400000");
    await fail(
      () =>
        post(loan.id, {
          ...payment,
          date: "2026-03-01",
          amount_cents: "400001",
        }),
      /ACCT_LOAN_PAYMENT_EXCEEDS_PRINCIPAL/,
    );
    await fail(
      () => post(loan.id, { ...payment, interest_cents: "-1" }),
      /ACCT_LOAN_PAYMENT_EXCEEDS_PRINCIPAL/,
    );
    // One journal can belong to one register in the target schema. Historical linkage never rewrites its lines.
    const original = await cmd({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-01-01",
      memo: "Synthetic original asset",
      lines: [
        { account_id: accounts.asset, amount_cents: "100000" },
        { account_id: accounts.bank, amount_cents: "-100000" },
      ],
    });
    const historyAsset = await create("asset", {
      ...assetBody,
      name: "Synthetic historic workstation",
    });
    await post(historyAsset.id, acquire, {
      mode: "historical",
      entry_id: original.id,
      entry_version: original.version,
    });
    check((await detail(historyAsset.id)).book_cents, "100000");
    const extra = await create("asset", {
      ...assetBody,
      name: "Synthetic duplicate history",
    });
    await fail(
      () =>
        post(extra.id, acquire, {
          mode: "historical",
          entry_id: original.id,
          entry_version: original.version,
        }),
      /ACCT_REGISTER_JOURNAL_MISMATCH|ACCT_STALE_VERSION/,
    );
    check((await report()).total_cells, ["Total", "", "200000", "0", "200000"]);
    check((await report("loan-register")).total_cells, ["Total", "", "400000"]);
    check(
      (await report("loan-register", "2026-01-31")).total_cells[2],
      "500000",
    );
    check((await report("asset-register", "2025-12-31")).count, 0);
    const result = await report();
    check(result.controls.ready, true);
    check(
      (await report("asset-register", "2026-08-31", { offset: 100 })).rows
        .length,
      0,
    );
    check(
      (await report("asset-register", "2026-08-31", { offset: 100 }))
        .total_cells[2],
      "200000",
    );
    const capture = {
      type: "report.support.capture",
      id: randomUUID(),
      expected_revision: result.revision,
      filter: result.filter,
    };
    const key = randomUUID();
    await cmd(capture, key);
    check((await cmd(capture, key)).id, capture.id);
    const retained = (
      await db.query<{ r: SupportReportSnapshot }>(
        "SELECT accounting.snapshot_read($1) r",
        [capture.id],
      )
    ).rows[0].r;
    check(supportReportDocument(retained).rows.at(-1)?.cells, [
      "Total",
      "",
      "2000.00",
      "0.00",
      "2000.00",
    ]);
    const mismatch = await cmd({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-08-15",
      memo: "Synthetic unregistered cost",
      lines: [
        { account_id: accounts.asset, amount_cents: "1000" },
        { account_id: accounts.bank, amount_cents: "-1000" },
      ],
    });
    check((await report()).controls.ready, false);
    check(
      (await report()).controls.rows.find(
        (r: any) => r.account_id === accounts.asset,
      ).difference_cents,
      "1000",
    );
    await fail(
      () => cmd({ ...capture, id: randomUUID() }),
      /ACCT_STALE_REVISION/,
    );
    await cmd({
      type: "entry.reverse",
      id: mismatch.id,
      expected_version: mismatch.version,
      entry_date: "2026-08-16",
      reason: "Synthetic difference correction",
    });
    check((await report()).controls.ready, true);
    const scheduled = {
      ...payment,
      date: "2026-08-10",
      amount_cents: "1000",
      interest_cents: "0",
      fee_cents: "0",
      schedule_row_key: "d".repeat(64),
    };
    const scheduledPost = await post(loan.id, scheduled);
    await fail(() => post(loan.id, scheduled), /ACCT_REGISTER_ALREADY_POSTED/);
    await voidMovement(loan.id, scheduledPost.entry_id, "2026-08-11");
    await post(loan.id, { ...scheduled, date: "2026-08-12" });
    check((await detail(loan.id)).book_cents, "-399000");
    check(retained.payload.data.total_cells[2], "200000");
    await fail(
      () =>
        create("asset", {
          ...assetBody,
          account_id: accounts.accum,
          accumulated_account_id: accounts.asset,
        }),
      /ACCT_REGISTER_ACCOUNT_TYPE/,
    );
    await cmd({
      type: "period.lock",
      month: "2026-07-01",
      reason: "Synthetic period lock",
    });
    await fail(
      () => post(loan.id, { ...payment, date: "2026-07-15" }),
      /ACCT_PERIOD_LOCKED/,
    );
    await db.exec("SET ROLE anon");
    await fail(() => detail(asset.id), /permission denied/);
    await fail(
      () => db.query("SELECT * FROM accounting.registers"),
      /permission denied/,
    );
    console.log(
      `Asset and loan movements, dated balances and retained controls: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.stack, e.where);
  process.exitCode = 1;
});
