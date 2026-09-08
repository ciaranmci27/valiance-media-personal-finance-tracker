import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  supportReportDocument,
  type SupportReportSnapshot,
  type SupportReportData,
} from "../src/lib/accounting/support-reports";
import type { PayrollEmployee } from "../src/lib/accounting/payroll";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const fail = async (fn: () => Promise<unknown>, code: string) => {
    await assert.rejects(fn, new RegExp(code));
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{
        r: {
          id: string;
          version: number;
          entry_id?: string;
          storage_path?: string;
        };
      }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  const sql = async (q: string, args: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return await db.query(q, args);
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const doc = randomUUID(),
    wages = randomUUID(),
    payable = randomUUID();
  const prepared = (await cmd({
    type: "document.prepare",
    id: doc,
    original_name: "synthetic-register.pdf",
    mime_type: "application/pdf",
    size_bytes: "100",
    content_hash: "a".repeat(64),
  })) as { id: string; version: number; storage_path: string };
  await db.query(
    "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
    [prepared.storage_path],
  );
  await cmd({
    type: "document.complete",
    id: doc,
    expected_version: prepared.version,
  });
  for (const [id, name, type] of [
    [wages, "Officer wages", "expense"],
    [payable, "Net salary", "liability"],
  ])
    await cmd({
      type: "account.create",
      id,
      code: "",
      name,
      account_type: type,
      normal_side: type === "expense" ? "debit" : "credit",
    });
  type Year = {
    year: number;
    through: string;
    revision: string;
    fingerprint: string;
    run_count: number;
    drafts: number;
    employees: PayrollEmployee[];
    coverage: null | {
      current: boolean;
      version: number;
      employees: PayrollEmployee[];
    };
  };
  const year = async (through = "2026-08-31") =>
    (
      await db.query<{ r: Year }>(
        "SELECT accounting.payroll(jsonb_build_object('year',2026,'through',$1::text)) r",
        [through],
      )
    ).rows[0].r;
  const body = (date: string) => ({
    pay_date: date,
    period_from: date,
    period_to: date,
    declared_gross_cents: "100000",
    declared_net_cents: "100000",
    employees: [
      {
        key: "owner",
        name: "Synthetic officer",
        is_officer: true,
        gross_cash_cents: "100000",
        federal_taxable_cents: null,
        federal_withheld_cents: null,
      },
    ],
    components: [
      {
        key: "gross",
        kind: "officer_wages",
        label: "Officer wages",
        amount_cents: "100000",
        account_id: wages,
        offset_account_id: null,
        expected_on: null,
      },
      {
        key: "net",
        kind: "net_pay",
        label: "Net pay",
        amount_cents: "100000",
        account_id: payable,
        offset_account_id: null,
        expected_on: date,
      },
    ],
  });
  const save = async (date: string) =>
    cmd({
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: randomUUID(),
      body: body(date),
      ytd: {
        verified: true,
        through: date,
        employees: [
          {
            ...body(date).employees[0],
            federal_taxable_cents: "95000",
            federal_withheld_cents: "0",
            state_taxable_cents: null,
          },
        ],
      },
      document_id: doc,
      reason: "Synthetic register",
    });
  const approve = async (r: { id: string; version: number }) =>
    cmd({
      type: "payroll.approve",
      ...r,
      expected_version: r.version,
      mode: "new",
      template: "accrual",
      verified: true,
      reason: "Verified synthetic source",
    });
  const filter = {
    report_id: "payroll-register" as const,
    from: "2026-01-01",
    to: "2026-08-31",
    offset: 0,
  };
  const report = async (f: object = filter) =>
    (
      await db.query<{ r: SupportReportData }>(
        "SELECT accounting.support_report($1) r",
        [JSON.stringify(f)],
      )
    ).rows[0].r;
  check((await year()).employees, []);
  check((await report()).total_cells, ["Total", "", "0", "0", "0", "0"]);
  const run = await save("2026-08-15");
  check((await year()).drafts, 1);
  check((await report()).count, 0);
  const posted = await approve(run);
  let state = await year();
  check(state.run_count, 1);
  check(state.employees[0].gross_cash_cents, "100000");
  check(state.employees[0].federal_taxable_cents, null);
  check((await report()).total_cells, [
    "Total",
    "",
    "100000",
    "0",
    "0",
    "100000",
  ]);
  check((await report()).rows[0].run_id, run.id);
  check((await report({ ...filter, to: "2026-08-14" })).count, 0);
  check(state.coverage?.current, true);
  check(state.coverage?.employees[0].federal_taxable_cents, "95000");
  check(state.coverage?.employees[0].state_taxable_cents, null);
  check((await year("2026-08-30")).coverage?.current, true);
  check((await year("2026-08-14")).coverage, null);
  const snapshot = await cmd({
    type: "report.support.capture",
    id: randomUUID(),
    expected_revision: state.revision,
    filter,
  });
  check((await year()).revision, state.revision);
  const retained = (
    await db.query<{ r: SupportReportSnapshot }>(
      "SELECT accounting.snapshot_read($1) r",
      [snapshot.id],
    )
  ).rows[0].r;
  check(supportReportDocument(retained).rows.at(-1)?.cells, [
    "Total",
    "",
    "1000.00",
    "0.00",
    "0.00",
    "1000.00",
  ]);
  await cmd({
    type: "payroll.void",
    id: run.id,
    expected_version: posted.version,
    effective_date: "2026-09-01",
    reason: "Synthetic reversal",
  });
  check((await report()).total_cells[2], "100000");
  check((await report({ ...filter, to: "2026-09-01" })).count, 0);
  check((await year()).coverage?.current, true);
  check((await year("2026-09-01")).coverage, null);
  const extra = await save("2026-08-20");
  check((await year()).drafts, 1);
  await cmd({
    type: "payroll.discard",
    id: extra.id,
    expected_version: extra.version,
    reason: "Synthetic draft removed",
  });
  check((await year()).drafts, 0);
  // The latest run controls YTD. An older verified run cannot fill a later missing register.
  const latest = await cmd({
    type: "payroll.save",
    id: randomUUID(),
    expected_version: 0,
    provider_run_id: "SYNTHETIC-MISSING-YTD",
    document_id: doc,
    reason: "Synthetic latest register",
    body: body("2026-08-25"),
  });
  const latestPosted = await approve(latest);
  check((await year()).coverage, null);
  check((await year()).employees[0].gross_cash_cents, "200000");
  await cmd({
    type: "payroll.void",
    id: latest.id,
    expected_version: latestPosted.version,
    effective_date: "2026-08-26",
    reason: "Synthetic later run void",
  });
  check((await year()).coverage?.current, true);
  await sql(
    "DELETE FROM storage.objects WHERE bucket_id='accounting-private' AND name=$1",
    [prepared.storage_path],
  );
  check((await year()).coverage?.current, false);
  check(retained.payload.data.total_cells[2], "100000");
  await db.exec("SET ROLE anon");
  await fail(() => year(), "permission denied");
  await fail(
    () => db.query("SELECT * FROM accounting.payroll_runs"),
    "permission denied",
  );
  console.log(
    `Payroll reports, actual run facts and moving-cutoff YTD: ${checks} assertions passed.`,
  );
  await db.close();
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exit(1);
});
