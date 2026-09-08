import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
import { booksPackageDocuments } from "../src/lib/accounting/books-package-document";
import { booksPackageZip } from "../src/lib/accounting/server/books-package-zip";
import {
  booksPackageCommandSchema,
  type BooksPackageSnapshot,
  type BooksPackagePreview,
  type BooksPackageHistory,
} from "../src/lib/accounting/books-package";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const equal = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const fail = async (work: () => Promise<unknown>, error: RegExp) => {
    await assert.rejects(work, error);
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
      return await db.query(q, args);
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const preview = async (year = 2026, through = "2026-08-31") =>
    (
      await db.query<{ r: BooksPackagePreview }>(
        "SELECT accounting.books_package(jsonb_build_object('year',$1::int,'through',$2::text)) r",
        [year, through],
      )
    ).rows[0].r;
  const snapshot = async (id: string) =>
    (
      await db.query<{ r: BooksPackageSnapshot }>(
        "SELECT accounting.snapshot_read($1) r",
        [id],
      )
    ).rows[0].r;
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind:
          a.id === account(1) ? "bank" : a.id === account(3) ? "card" : "none",
      })),
    });
    const post = async (amount: string, date = "2026-08-01") => {
      const entry = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "=Synthetic export formula probe",
        lines: [
          { account_id: account(1), amount_cents: amount, memo: "" },
          {
            account_id: account(5),
            amount_cents: (-BigInt(amount)).toString(),
            memo: "",
          },
        ],
      });
      await cmd({
        type: "entry.post",
        id: entry.id,
        expected_version: entry.version,
      });
      return entry;
    };
    await post("9007199254740993");
    const prepared = (await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-package.pdf",
      mime_type: "application/pdf",
      size_bytes: "100",
      content_hash: "a".repeat(64),
    })) as { id: string; version: number; storage_path: string };
    const document = prepared.id;
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [prepared.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: document,
      expected_version: prepared.version,
    });
    const common = {
      year: 2026,
      expected_version: 0,
      document_id: document,
      reason: "Synthetic year-end support",
      verified: true,
    };
    await cmd({
      ...common,
      type: "tax.mapping",
      id: randomUUID(),
      account_id: account(5),
      concept: "ordinary_income",
      deductible_bps: 10000,
    });
    await cmd({
      ...common,
      type: "tax.adjustment",
      id: randomUUID(),
      adjustment_key: randomUUID(),
      effective_date: "2026-08-01",
      concept: "ordinary_adjustment",
      amount_cents: "-101",
      active: true,
    });
    const payable = randomUUID();
    await cmd({
      type: "account.create",
      id: payable,
      name: "Synthetic net pay",
      code: "",
      account_type: "liability",
      normal_side: "credit",
    });
    const run = await cmd({
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: "SYNTHETIC-PACKAGE",
      document_id: document,
      reason: "Synthetic payroll",
      body: {
        pay_date: "2026-08-15",
        period_from: "2026-08-01",
        period_to: "2026-08-15",
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
            label: "Cash wages",
            amount_cents: "100000",
            account_id: account(7),
            offset_account_id: null,
            expected_on: null,
          },
          {
            key: "net",
            kind: "net_pay",
            label: "Net salary",
            amount_cents: "100000",
            account_id: payable,
            offset_account_id: null,
            expected_on: "2026-08-15",
          },
        ],
      },
    });
    await cmd({
      type: "payroll.approve",
      id: run.id,
      expected_version: run.version,
      mode: "new",
      template: "accrual",
      verified: true,
      reason: "Synthetic payroll proof",
    });
    const p = await preview();
    equal(p.ledger_count, 4);
    equal(p.reports.length, 5);
    equal(
      p.review_items.some((x) => x.kind === "payroll"),
      true,
    );
    equal(
      booksPackageCommandSchema.safeParse({
        type: "report.books.capture",
        id: randomUUID(),
        expected_revision: p.revision,
        year: 2026,
        through: "2025-12-31",
      }).success,
      false,
    );
    await fail(() => preview(2025, "2026-08-31"), /ACCT_REPORT_RANGE/);
    await fail(() => preview(2099, "2099-01-01"), /ACCT_REPORT_RANGE/);
    await fail(
      () =>
        db.query(
          "SELECT accounting.report_command(jsonb_build_object('type','report.books.capture','through',$1::text))",
          ["2026-08-31"],
        ),
      /permission denied/,
    );
    const capture = {
        type: "report.books.capture",
        id: randomUUID(),
        expected_revision: p.revision,
        year: 2026,
        through: "2026-08-31",
      },
      key = randomUUID();
    const captured = await cmd(capture, key);
    equal(await cmd(capture, key), captured);
    equal((await preview()).revision, p.revision);
    await fail(
      () => cmd({ ...capture, through: "2026-08-30" }, key),
      /ACCT_IDEMPOTENCY_CONFLICT/,
    );
    const saved = await snapshot(captured.id),
      docs = booksPackageDocuments(saved);
    equal(docs.length, 14);
    equal(
      saved.payload.support.every((s) => s.revision === saved.revision),
      true,
    );
    equal(saved.payload.core.totals.net_cents, "9007199254640993");
    equal(saved.payload.ledger[0].amount_cents, "9007199254740993");
    equal(
      docs
        .find((d) => d.id === "officer-payroll-reconciliation")!
        .document.rows.some((r) => r.cells[2] === "Not supplied"),
      true,
    );
    equal(
      docs
        .find((d) => d.id === "account-mappings")!
        .document.rows.some((r) => r.cells.includes("gross receipts")),
      true,
    );
    equal(
      docs
        .find((d) => d.id === "tax-workpapers")!
        .document.rows.some((r) => r.cells.includes("-1.01")),
      true,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of booksPackageZip(saved, false)) chunks.push(chunk);
    const files = unzipSync(Buffer.concat(chunks));
    equal(Object.keys(files).length, 17);
    const manifest = JSON.parse(
      Buffer.from(files["manifest.json"]).toString(),
    ) as {
      financial_revision: string;
      files: { name: string; sha256: string; bytes: number }[];
    };
    equal(manifest.financial_revision, saved.revision);
    for (const file of manifest.files) {
      equal(
        createHash("sha256").update(files[file.name]).digest("hex"),
        file.sha256,
      );
      equal(files[file.name].length, file.bytes);
    }
    const csv = Buffer.from(files["csv/general-ledger.csv"]).toString();
    equal(csv.includes("90071992547409.93"), true);
    equal(csv.includes("\"'=Synthetic"), true);
    equal(
      Buffer.from(files["README.txt"])
        .toString()
        .includes("not a completed tax return"),
      true,
    );
    const broken = structuredClone(saved);
    broken.payload.support[0].revision = "0";
    assert.throws(() => booksPackageDocuments(broken), /inconsistent/);
    checks++;
    await post("123");
    equal(await snapshot(captured.id), saved);
    await fail(
      () => cmd({ ...capture, id: randomUUID() }),
      /ACCT_STALE_REVISION/,
    );
    const history = (
      await db.query<{ r: BooksPackageHistory }>(
        'SELECT accounting.books_package(\'{"year":2026,"view":"history","offset":0}\') r',
      )
    ).rows[0].r;
    equal(history.count, 1);
    equal(history.rows[0].id, captured.id);
    equal(
      (
        await db.query<{ r: BooksPackageHistory }>(
          'SELECT accounting.books_package(\'{"year":2026,"view":"history","offset":25}\') r',
        )
      ).rows[0].r.rows.length,
      0,
    );
    await fail(
      () =>
        sql("DELETE FROM accounting.report_snapshots WHERE id=$1", [
          captured.id,
        ]),
      /ACCT_IMMUTABLE|ACCT_NO_HARD_DELETE/,
    );
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      randomUUID(),
    ]);
    await fail(() => preview(), /ACCT_FORBIDDEN/);
    await fail(() => snapshot(captured.id), /ACCT_FORBIDDEN/);
    console.log(
      `Books package: ${checks} assertions passed (coherent revisions, exact cents, retained worksheets, ZIP manifests, replay and access).`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
