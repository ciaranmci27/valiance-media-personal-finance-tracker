import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";

/**
 * The Manage cleanup's server changes: a receipt can be detached from one
 * transaction again, the transfers read serves one group by id with a
 * caller-chosen page size, and the tax workpaper history returns the
 * versions of one row in the shape the dialog renders.
 */
type Json = Record<string, any>;
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
  const cmd = async (c: object, key = randomUUID()): Promise<Json> =>
    (
      await db
        .query<{ r: Json }>(
          "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
          [key, JSON.stringify(c)],
        )
        .catch((e) => {
          throw new Error(`${JSON.stringify(c)}: ${e.message}`);
        })
    ).rows[0].r;
  const context = async (view: string, params: object): Promise<Json> =>
    (
      await db.query<{ r: Json }>(
        "SELECT accounting.context($1,$2::jsonb) r",
        [view, JSON.stringify(params)],
      )
    ).rows[0].r;
  const documents = async (): Promise<Json[]> =>
    (await db.query<{ r: Json }>("SELECT accounting.documents('{}'::jsonb) r"))
      .rows[0].r.documents;
  try {
    await db.exec(
      "RESET ROLE;INSERT INTO storage.buckets(id,name,public) VALUES('accounting-private','accounting-private',false) ON CONFLICT DO NOTHING;SET ROLE authenticated;",
    );
    const checking = randomUUID(),
      savings = randomUUID(),
      sales = randomUUID();
    for (const [id, name, type, side, cash_kind] of [
      [checking, "Checking", "asset", "debit", "bank"],
      [savings, "Savings", "asset", "debit", "bank"],
      [sales, "Sales", "income", "credit", "none"],
    ] as const)
      await cmd({
        type: "account.create",
        id,
        name,
        code: "",
        account_type: type,
        normal_side: side,
        cash_kind,
      });
    const post = async (memo: string, lines: object[]) => {
      let r = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: "2026-06-01",
        memo,
        lines,
      });
      r = await cmd({ type: "entry.post", id: r.id, expected_version: r.version });
      return r;
    };
    const sale = await post("Synthetic sale", [
      { account_id: checking, amount_cents: "5000", memo: "" },
      { account_id: sales, amount_cents: "-5000", memo: "" },
    ]);

    // A receipt attached to the wrong transaction can be detached, with a reason.
    const doc = randomUUID();
    const prepared = await cmd({
      type: "document.prepare",
      id: doc,
      original_name: "receipt.pdf",
      mime_type: "application/pdf",
      size_bytes: "10",
      content_hash: "b".repeat(64),
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [prepared.storage_path],
    );
    let version = (
      await cmd({
        type: "document.complete",
        id: doc,
        expected_version: prepared.version,
      })
    ).version;
    version = (
      await cmd({
        type: "document.link",
        id: doc,
        expected_version: version,
        entry_id: sale.id,
      })
    ).version;
    let row = (await documents()).find((d) => d.id === doc)!;
    check(row.status, "linked");
    check(
      row.entries.map((e: Json) => e.id),
      [sale.id],
    );
    await fail(
      () =>
        cmd({
          type: "document.unlink",
          id: doc,
          expected_version: version,
          entry_id: sale.id,
          reason: " ",
        }),
      "ACCT_REASON_REQUIRED",
    );
    await fail(
      () =>
        cmd({
          type: "document.unlink",
          id: doc,
          expected_version: version,
          entry_id: randomUUID(),
          reason: "Not attached there",
        }),
      "ACCT_NOT_FOUND",
    );
    version = (
      await cmd({
        type: "document.unlink",
        id: doc,
        expected_version: version,
        entry_id: sale.id,
        reason: "Attached to the wrong transaction",
      })
    ).version;
    row = (await documents()).find((d) => d.id === doc)!;
    check(row.status, "inbox");
    check(row.entries, []);
    // The audit log keeps the detached link; only the owner-facing tables are readable as the owner.
    await db.exec("RESET ROLE");
    try {
      check(
        (
          await db.query<{ n: number }>(
            "SELECT count(*)::int n FROM accounting.audit_log WHERE table_name='document_links' AND before IS NOT NULL AND after IS NULL",
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await db.exec("SET ROLE authenticated");
    }

    // The transfers read pages by the caller's size and serves one group by id.
    const one = await cmd({
      type: "transfer.create",
      id: randomUUID(),
      from_account_id: checking,
      to_account_id: savings,
      amount_cents: "100",
      memo: "Synthetic transfer one",
      outgoing_date: "2026-06-02",
      incoming_date: "2026-06-03",
    });
    await cmd({
      type: "transfer.create",
      id: randomUUID(),
      from_account_id: checking,
      to_account_id: savings,
      amount_cents: "200",
      memo: "Synthetic transfer two",
      outgoing_date: "2026-06-04",
      incoming_date: "2026-06-05",
    });
    const range = { from: "2026-06-01", to: "2026-06-30" };
    const all = await context("transfers", range);
    check(all.total, 2);
    check(all.groups.length, 2);
    const paged = await context("transfers", { ...range, limit: 1 });
    check(paged.total, 2);
    check(paged.groups.length, 1);
    check(paged.groups[0].amount_cents, "200");
    const second = await context("transfers", { ...range, limit: 1, offset: 1 });
    check(second.groups[0].amount_cents, "100");
    const byId = await context("transfers", {
      from: "2026-01-01",
      to: "2026-01-31",
      id: one.id,
    });
    check(byId.total, 1);
    check(byId.groups[0].id, one.id);
    check(byId.groups[0].amount_cents, "100");
    check((await context("transfers", { ...range, id: randomUUID() })).total, 0);
    const leg = (
      await db.query<{ r: Json }>("SELECT accounting.entry_detail($1) r", [
        one.outgoing_entry_id,
      ])
    ).rows[0].r;
    check(leg.transfer_group_id, one.id);

    // The tax history is one row's versions, newest first, with the fields the dialog shows.
    const mapping = {
      type: "tax.mapping",
      year: 2026,
      account_id: sales,
      concept: "ordinary_income",
      verified: true,
    };
    const first = await cmd({
      ...mapping,
      id: randomUUID(),
      expected_version: 0,
      deductible_bps: 10000,
      reason: "First look",
    });
    await cmd({
      ...mapping,
      id: randomUUID(),
      expected_version: first.version,
      concept: "interest",
      deductible_bps: 10000,
      reason: "Second look",
    });
    const history = await context("tax-history", {
      kind: "mapping",
      year: 2026,
      key: sales,
      offset: 0,
    });
    check(history.count, 2);
    check(
      history.rows.map((r: Json) => r.version),
      [2, 1],
    );
    check(
      history.rows.map((r: Json) => r.concept),
      ["interest", "gross_receipts"],
    );
    check(history.rows[0].deductible_bps, 10000);
    check(typeof history.rows[0].created_at, "string");
    check(
      (
        await context("tax-history", {
          kind: "mapping",
          year: 2025,
          key: sales,
          offset: 0,
        })
      ).count,
      0,
    );
    const adjustment = await cmd({
      type: "tax.adjustment",
      id: randomUUID(),
      year: 2026,
      expected_version: 0,
      verified: true,
      concept: "ordinary_adjustment",
      effective_date: "2026-06-30",
      amount_cents: "1500",
      reason: "Synthetic adjustment",
    });
    const adjustments = await context("tax-history", {
      kind: "adjustment",
      year: 2026,
      key: adjustment.id,
      offset: 0,
    });
    check(adjustments.count, 1);
    check(adjustments.rows[0].amount_cents, "1500");
    check(adjustments.rows[0].effective_date, "2026-06-30");
    check(adjustments.rows[0].reason, "Synthetic adjustment");
    check(adjustments.rows[0].version, 1);
    console.log(`Accounting manage cleanup: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
