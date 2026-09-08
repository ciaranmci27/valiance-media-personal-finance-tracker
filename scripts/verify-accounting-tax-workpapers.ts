import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  supportReportDocument,
  type SupportReportData,
  type SupportReportSnapshot,
} from "../src/lib/accounting/support-reports";
import { accountingTestDb } from "./accounting-test-db";
import {
  taxWorkpaperCommandSchema,
  type TaxSource,
} from "../src/lib/accounting/tax-workpapers";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const fail = async (fn: () => Promise<unknown>, code: string) => {
    await assert.rejects(fn, new RegExp(code));
    checks++;
  };
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  const sql = async (q: string, args: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return args.length ? await db.query(q, args) : await db.exec(q);
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const source = async (year = 2026, through = `${year}-08-31`) =>
    (
      await db.query<{ r: TaxSource }>(
        "SELECT accounting.tax_source($1,$2) r",
        [year, through],
      )
    ).rows[0].r;
  const bank = randomUUID(),
    income = randomUUID(),
    meals = randomUUID(),
    travel = randomUUID(),
    interest = randomUUID(),
    equity = randomUUID(),
    document = randomUUID();
  for (const [id, name, type, side] of [
    [bank, "Bank", "asset", "debit"],
    [income, "Consulting", "income", "credit"],
    [meals, "Meals", "expense", "debit"],
    [travel, "Travel", "expense", "debit"],
    [interest, "Interest", "income", "credit"],
    [equity, "Owner distributions", "equity", "credit"],
  ])
    await cmd({
      type: "account.create",
      id,
      name,
      code: "",
      account_type: type,
      normal_side: side,
    });
  const prepared = (await cmd({
    type: "document.prepare",
    id: document,
    original_name: "synthetic-tax.pdf",
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
    id: document,
    expected_version: prepared.version,
  });
  const post = async (account: string, amount: string, date = "2026-07-01") => {
    let r = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo: "Synthetic tax workpaper",
      lines: [
        { account_id: account, amount_cents: amount, memo: "" },
        {
          account_id: bank,
          amount_cents: (-BigInt(amount)).toString(),
          memo: "",
        },
      ],
    });
    r = await cmd({
      type: "entry.post",
      id: r.id,
      expected_version: r.version,
    });
    return r;
  };
  await post(income, "-100000");
  await post(meals, "10001");
  await post(travel, "10000");
  await post(interest, "-500");
  const initial = await source();
  check(initial.book_profit_cents, "80499");
  check(initial.unmapped_accounts, 4);
  check(initial.adjusted_ordinary_cents, "0");
  check(initial.year_settings?.classification, "s_corp");
  const common = {
    year: 2026,
    expected_version: 0,
    document_id: document,
    verified: true,
    reason: "Reviewed synthetic source, not a real return",
  };
  const map = (
    account_id: string,
    concept: string,
    bps: number,
    version = 0,
    year = 2026,
  ) => ({
    ...common,
    year,
    type: "tax.mapping",
    id: randomUUID(),
    expected_version: version,
    account_id,
    concept,
    deductible_bps: bps,
  });
  await cmd(map(income, "ordinary_income", 10000));
  await cmd(map(meals, "meals", 5000));
  await cmd(map(travel, "travel", 10000));
  await cmd(map(interest, "interest", 0));
  let s = await source();
  check(s.unmapped_accounts, 0);
  check(s.mapped_ordinary_cents, "84999");
  check(s.book_to_tax_cents, "4500");
  check(s.separately_stated.interest, "500");
  check(
    s.monthly.find((m) => m.month === "2026-07-01")?.ordinary_cents,
    "84999",
  );
  check(
    s.monthly.every((m) => !m.complete),
    true,
  );
  await fail(
    () => cmd(map(equity, "ordinary_expense", 10000)),
    "ACCT_TAX_MAPPING",
  );
  await fail(
    () => cmd(map(income, "ordinary_expense", 10000, 1)),
    "ACCT_TAX_MAPPING",
  );
  await fail(() => cmd(map(meals, "meals", 10001, 1)), "ACCT_TAX_MAPPING");
  await fail(
    () => cmd(map(income, "ordinary_income", 5000, 1)),
    "ACCT_TAX_MAPPING",
  );
  await fail(() => cmd(map(meals, "meals", 5000)), "ACCT_STALE_VERSION");
  const adjustment = {
    ...common,
    type: "tax.adjustment",
    id: randomUUID(),
    adjustment_key: randomUUID(),
    effective_date: "2026-08-01",
    concept: "ordinary_adjustment",
    amount_cents: "-2000",
    active: true,
  };
  const key = randomUUID();
  const a = await cmd(adjustment, key);
  check(await cmd(adjustment, key), a);
  await fail(
    () => cmd({ ...adjustment, amount_cents: "-3000" }, key),
    "ACCT_IDEMPOTENCY_CONFLICT",
  );
  s = await source();
  check(s.adjusted_ordinary_cents, "82999");
  check(s.adjustments[0].amount_cents, "-2000");
  check(
    s.monthly.find((m) => m.month === "2026-08-01")?.ordinary_cents,
    "-2000",
  );
  check((await source(2026, "2026-07-31")).adjustments.length, 0);
  await fail(
    () =>
      cmd({
        ...adjustment,
        id: randomUUID(),
        expected_version: 1,
        year: 2025,
        effective_date: "2025-08-01",
      }),
    "ACCT_TAX_OFFSET_REQUIRED",
  );
  await cmd({
    ...common,
    type: "tax.adjustment.save",
    id: randomUUID(),
    concept: "stock_basis_opening",
    amount_cents: "1000000",
    effective_date: "2026-01-01",
  });
  check((await source()).basis, null);
  await post(equity, "10000");
  check((await source()).adjusted_ordinary_cents, "82999");
  // Immutable adjustments are offset explicitly, never edited or deactivated.
  await cmd({
    ...adjustment,
    id: randomUUID(),
    amount_cents: "2000",
    reason: "Offset duplicate synthetic adjustment",
  });
  s = await source();
  check(s.adjusted_ordinary_cents, "84999");
  check(
    s.adjustments.some((x) => x.amount_cents === "-2000"),
    true,
  );
  await fail(
    () => sql("UPDATE accounting.tax_adjustments SET amount_cents=1"),
    "ACCT_IMMUTABLE_TAX_ADJUSTMENT",
  );
  await post(income, "-10000", "2025-07-01");
  await cmd(map(income, "ordinary_income", 10000, 0, 2025));
  await cmd(map(meals, "nondeductible", 0, 1));
  check((await source(2025)).adjusted_ordinary_cents, "10000");
  check((await source()).adjusted_ordinary_cents, "90000");
  await cmd(map(meals, "meals", 5000, 2));
  const odd = await post(meals, "3", "2026-08-04");
  check((await source()).adjusted_ordinary_cents, "84997");
  await cmd({
    type: "entry.reverse",
    id: odd.id,
    expected_version: odd.version,
    entry_date: "2026-08-05",
    reason: "Reverse odd-cent fixture",
  });
  check((await source()).adjusted_ordinary_cents, "84999");
  await cmd(map(meals, "nondeductible", 0, 3));
  const large = {
    ...adjustment,
    id: randomUUID(),
    adjustment_key: randomUUID(),
    amount_cents: "9007199254740993",
    expected_version: 0,
  };
  await cmd(large);
  check(
    (await source()).adjustments.find((x) => x.id === large.id)?.amount_cents,
    "9007199254740993",
  );
  check((await source()).adjusted_ordinary_cents, "9007199254830993");
  await cmd({
    ...large,
    id: randomUUID(),
    amount_cents: "-9007199254740993",
    reason: "Offset large synthetic adjustment",
  });
  await fail(() => source(2026, "2025-12-31"), "ACCT_TAX_RANGE");
  await fail(() => source(2100, "2100-12-31"), "ACCT_TAX_RANGE");
  await cmd({
    type: "period.lock",
    month: "2026-07-01",
    reason: "Synthetic optional close",
  });
  check(
    (await source()).monthly.find((m) => m.month === "2026-07-01")?.complete,
    true,
  );
  await cmd(map(meals, "meals", 5000, 4));
  check((await source()).adjusted_ordinary_cents, "84999");
  const before = (await source()).revision;
  await sql(
    "DELETE FROM storage.objects WHERE bucket_id='accounting-private' AND name=$1",
    [prepared.storage_path],
  );
  s = await source();
  check(s.year_settings?.current, true);
  check(s.unmapped_accounts, 0);
  check(s.unavailable_adjustments, 5);
  check(s.revision, before);
  await fail(
    () => cmd({ ...adjustment, id: randomUUID() }),
    "ACCT_DOCUMENT_UNAVAILABLE",
  );
  await db.query(
    "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
    [prepared.storage_path],
  );
  const filter = {
    report_id: "tax-workpapers",
    from: "2026-01-01",
    to: "2026-08-31",
    offset: 0,
  };
  const report = async (f: object = filter) =>
    (
      await db.query<{ r: SupportReportData & { tax_workpaper: TaxSource } }>(
        "SELECT accounting.support_report($1) r",
        [JSON.stringify(f)],
      )
    ).rows[0].r;
  const reportData = await report();
  check(reportData.total_cells.slice(2), ["80499", "84999", "4500"]);
  check(reportData.tax_workpaper.fingerprint, (await source()).fingerprint);
  check(
    reportData.tax_workpaper.accounts.filter((a) => a.line_count > 0).length,
    4,
  );
  check(
    reportData.notes.some((n) => n.includes("Separately stated items")),
    true,
  );
  check((await report({ ...filter, offset: 100 })).rows.length, 0);
  check(
    (await report({ ...filter, offset: 100 })).total_cells,
    reportData.total_cells,
  );
  await fail(() => report({ ...filter, from: "2026-07-01" }), "ACCT_TAX_RANGE");
  const snapshotId = randomUUID();
  const capture = {
    type: "report.support.capture",
    id: snapshotId,
    expected_revision: reportData.revision,
    filter,
  };
  const captureKey = randomUUID();
  await cmd(capture, captureKey);
  check((await source()).revision, reportData.revision);
  await cmd(map(meals, "meals", 10000, 5));
  check((await report()).total_cells[3], "79999");
  check((await cmd(capture, captureKey)).id, snapshotId);
  await fail(
    () => cmd({ ...capture, id: randomUUID() }),
    "ACCT_STALE_REVISION",
  );
  const saved = (
    await db.query<{ r: SupportReportSnapshot }>(
      "SELECT accounting.snapshot_read($1) r",
      [snapshotId],
    )
  ).rows[0].r;
  check(saved.payload.data.total_cells, reportData.total_cells);
  const printable = supportReportDocument(saved);
  check(printable.title, "Tax workpapers");
  check(
    printable.metadata.find(([label]) => label === "Period")?.[1],
    "2026-01-01 through 2026-08-31",
  );
  await fail(
    () => db.query("SELECT accounting.tax_lines(2026,'2026-08-31')"),
    "permission denied",
  );
  await fail(
    () => db.query("DELETE FROM accounting.tax_mappings"),
    "permission denied",
  );
  await db.exec("RESET ROLE; SET ROLE anon");
  await fail(
    () => db.query("SELECT accounting.tax_source(2026,'2026-08-31')"),
    "permission denied",
  );
  await db.exec("RESET ROLE;SET ROLE authenticated");
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
    randomUUID(),
  ]);
  await fail(() => source(), "ACCT_FORBIDDEN");
  console.log(`Accounting tax workpapers: ${checks} assertions passed.`);
  await db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
