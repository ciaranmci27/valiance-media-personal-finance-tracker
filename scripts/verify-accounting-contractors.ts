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
    const bank = randomUUID(),
      card = randomUUID(),
      expense = randomUUID(),
      equity = randomUUID(),
      party = randomUUID();
    for (const [id, name, account_type, subtype] of [
      [bank, "Synthetic bank", "asset", "bank"],
      [card, "Synthetic card", "liability", "card"],
      [expense, "Synthetic services", "expense", "operating_expense"],
      [equity, "Synthetic owner", "equity", "owner_equity"],
    ])
      await cmd({ type: "account.create", id, name, account_type, subtype });
    await cmd({
      type: "party.save",
      id: party,
      expected_version: 0,
      name: "Synthetic contractor",
      kind: "vendor",
      is_contractor: true,
      contractor_classification: "individual",
      documentation_status: "received",
    });
    const journal = async (
      counter = bank,
      amount = "100000",
      date = "2026-08-01",
    ) => {
      let e = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "Synthetic contractor payment",
        payee_id: party,
        lines: [
          { account_id: expense, amount_cents: amount },
          { account_id: counter, amount_cents: (-BigInt(amount)).toString() },
        ],
      });
      return cmd({ type: "entry.post", id: e.id, expected_version: e.version });
    };
    const read = async (year = 2026) =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.contractor_report($1) r",
          [year],
        )
      ).rows[0].r;
    const paid = await journal();
    await journal(bank, "50000", "2025-08-01");
    await journal(card);
    await journal(bank, "-1000", "2026-08-02");
    await journal(equity, "20000");
    let view = await read();
    check(view.rows.length, 1);
    check(view.rows[0].paid_cents, "99000");
    check(view.rows[0].card_cents, "100000");
    check(view.rows[0].meets_threshold, false);
    check(view.threshold_cents, "200000");
    const cutoff = (await db.query<{r:any}>('SELECT accounting.contractor_report($1,$2) r',[2026,'2026-08-01'])).rows[0].r;
    check(cutoff.through,'2026-08-01');check(cutoff.rows[0].paid_cents,'100000');
    await fail(()=>db.query('SELECT accounting.contractor_report($1,$2)',[2026,'2025-12-31']),/ACCT_TAX_RANGE/);
    check((await read(2025)).threshold_cents, "60000");
    check((await read(2025)).rows[0].paid_cents, "50000");
    check((await read(2024)).threshold_cents, "60000");
    await fail(() => read(2027), /ACCT_CONTRACTOR_YEAR_RULE_REQUIRED/);
    const filter = {
      report_id: "contractor-worksheet",
      from: "2026-01-01",
      to: "2026-08-31",
      offset: 0,
    };
    const report = async (extra: object = {}) =>
      (
        await db.query<{ r: any }>("SELECT accounting.support_report($1) r", [
          JSON.stringify({ ...filter, ...extra }),
        ])
      ).rows[0].r;
    const summary = await report();
    check(summary.total_cells, ["Total", "", "", "99000", "100000"]);
    check((await report({ to: "2026-08-01" })).total_cells[3], "100000");
    check((await report({ offset: 100 })).rows.length, 0);
    check((await report({ offset: 100 })).total_cells, summary.total_cells);
    await fail(() => report({ from: "2025-01-01" }), /ACCT_TAX_RANGE/);
    const capture = {
      type: "report.support.capture",
      id: randomUUID(),
      expected_revision: summary.revision,
      filter,
    };
    const key = randomUUID();
    const captured = await cmd(capture, key);
    check(await cmd(capture, key), captured);
    const saved = (
      await db.query<{ r: SupportReportSnapshot }>(
        "SELECT accounting.snapshot_read($1) r",
        [captured.id],
      )
    ).rows[0].r;
    check(supportReportDocument(saved).rows.at(-1)?.cells, [
      "Total",
      "",
      "",
      "990.00",
      "1000.00",
    ]);
    await journal(bank, "101000");
    check((await read()).rows[0].paid_cents, "200000");
    check((await read()).rows[0].meets_threshold, true);
    await cmd({
      type: "entry.reverse",
      id: paid.id,
      expected_version: paid.version,
      entry_date: "2026-08-03",
      reason: "Synthetic refund correction",
    });
    check((await read()).rows[0].paid_cents, "100000");
    check(saved.payload.data.total_cells[3], "99000");
    await fail(
      () => cmd({ ...capture, id: randomUUID() }),
      /ACCT_STALE_REVISION/,
    );
    await cmd({
      type: "period.lock",
      month: "2026-08-01",
      reason: "Synthetic optional close",
    });
    // Classification changes are audited metadata, not payment allocations or tax filings.
    await cmd({
      type: "party.save",
      id: party,
      expected_version: 1,
      name: "Synthetic renamed contractor",
      kind: "vendor",
      is_contractor: true,
      contractor_classification: "corporation",
      documentation_status: "missing",
    });
    view = await read();
    check(view.rows[0].contractor_classification, "corporation");
    check(view.rows[0].documentation_status, "missing");
    check(view.rows[0].paid_cents, "100000");
    check(saved.payload.data.rows[0].cells[0], "Synthetic contractor");
    await db.exec("SET ROLE anon");
    await fail(() => read(), /permission denied/);
    await fail(
      () => db.query("SELECT * FROM accounting.parties"),
      /permission denied/,
    );
    await db.exec("SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      randomUUID(),
    ]);
    await fail(() => read(), /ACCT_FORBIDDEN/);
    console.log(
      `Contractor cash, card exclusions, refunds and retained worksheets: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
