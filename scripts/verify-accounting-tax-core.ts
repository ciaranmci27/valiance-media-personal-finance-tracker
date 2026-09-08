import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
import { calculateTaxLink } from "../src/lib/accounting/tax-refresh";
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
    const server = async (command: any) => {
      await db.exec("RESET ROLE; SET ROLE service_role");
      try {
        return (
          await db.query<{ r: any }>(
            "SELECT accounting.tax_refresh_server($1) r",
            [JSON.stringify(command)],
          )
        ).rows[0].r;
      } finally {
        await db.exec("RESET ROLE; SET ROLE authenticated");
      }
    };
    const source = async () =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.tax_source(2026,'2026-08-31') r",
        )
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({ type: "account.create", ...a });
    const meals = randomUUID();
    await cmd({
      type: "account.create",
      id: meals,
      name: "Synthetic meals",
      account_type: "expense",
      expected_version: 0,
    });
    const post = async (date: string, lines: any[]) => {
      const d = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "Synthetic tax evidence",
        lines,
      });
      return cmd({ type: "entry.post", id: d.id, expected_version: d.version });
    };
    await post("2026-01-05", [
      { account_id: account(1), amount_cents: "89999" },
      { account_id: account(5), amount_cents: "-100000" },
      { account_id: meals, amount_cents: "10001" },
    ]);
    check((await source()).book_profit_cents, "89999");
    check((await source()).unmapped_accounts, 2);
    await cmd({
      type: "tax.mapping",
      id: randomUUID(),
      year: 2026,
      account_id: account(5),
      expected_version: 0,
      concept: "ordinary_income",
      deductible_bps: 10000,
    });
    const mapping = await cmd({
      type: "tax.mapping.save",
      id: randomUUID(),
      tax_year: 2026,
      account_id: meals,
      expected_version: 0,
      concept: "meals_50",
    });
    check((await source()).adjusted_ordinary_cents, "94999");
    check((await source()).book_to_tax_cents, "5000");
    check((await source()).monthly[0].ordinary_cents, "94999");
    const adj = await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-02-01",
      amount_cents: "100",
      reason: "Synthetic adjustment",
    });
    check((await source()).adjusted_ordinary_cents, "95099");
    await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-02-01",
      amount_cents: "-100",
      reason: "Offset synthetic adjustment",
    });
    check((await source()).adjusted_ordinary_cents, "94999");
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query(
        "UPDATE accounting.tax_adjustments SET amount_cents=1 WHERE id=$1",
        [adj.id],
      ),
      /ACCT_IMMUTABLE/,
    );
    n++;
    await db.exec("SET ROLE authenticated");
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "Synthetic adjustment.pdf",
      mime_type: "application/pdf",
      size_bytes: "10",
      content_hash: "2".repeat(64),
    });
    await assert.rejects(
      cmd({
        type: "tax.adjustment.save",
        tax_year: 2026,
        concept: "ordinary_adjustment",
        effective_date: "2026-09-01",
        amount_cents: "10",
        document_id: doc.id,
        reason: "Not uploaded yet",
      }),
      /ACCT_DOCUMENT_UNAVAILABLE/,
    );
    n++;
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-08-01",
      amount_cents: "10",
      document_id: doc.id,
      reason: "Uploaded support",
    });
    await cmd({
      type: "tax.adjustment.save",
      tax_year: 2026,
      concept: "ordinary_adjustment",
      effective_date: "2026-08-01",
      amount_cents: "-10",
      document_id: doc.id,
      reason: "Offset with support",
    });
    check((await source()).unavailable_adjustments, 0);
    await db.exec("RESET ROLE");
    const estimate = randomUUID();
    await db.query(
      "INSERT INTO public.tax_estimates(id,tax_year,income_sources,tax_classification) VALUES($1,2026,$2,'s_corp')",
      [
        estimate,
        JSON.stringify([
          {
            id: "business",
            name: "Synthetic business",
            amount: 12345,
            income_type: "k1",
            subject_to_se: false,
          },
        ]),
      ],
    );
    await db.exec("SET ROLE authenticated");
    const body = {
      cutoff_mode: "fixed",
      through: "2026-08-31",
      business_target_id: "business",
      forecast: { method: "manual", remaining_cents: "0" },
      separate_targets: [],
      payroll: null,
      manual_separate_review: null,
    };
    let link = await cmd({
      type: "tax.link.save",
      id: randomUUID(),
      estimate_id: estimate,
      expected_version: 0,
      enabled: true,
      body,
      reason: "Synthetic linkage",
    });
    const view = async () =>
      (
        await db.query<{ r: any }>("SELECT accounting.tax_link($1) r", [
          link.id,
        ])
      ).rows[0].r;
    const claim = await server({ type: "start", link_id: link.id });
    check(claim.state, "running");
    const payload = calculateTaxLink(claim.inputs);
    check(payload.calculation.overlay.income[0].amount_cents, "94999");
    check((await server({ type: "start", link_id: link.id })).state, "busy");
    check(
      (
        await server({
          type: "finish",
          link_id: link.id,
          lease_token: claim.lease_token,
          payload,
        })
      ).state,
      "fresh",
    );
    check((await view()).current, true);
    check(
      (
        await server({
          type: "finish",
          link_id: link.id,
          lease_token: claim.lease_token,
          payload,
        })
      ).state,
      "fresh",
    );
    check((await view()).estimate.income_sources[0].amount, 12345);
    await cmd({
      type: "tax.mapping.save",
      id: mapping.id,
      tax_year: 2026,
      account_id: meals,
      expected_version: mapping.version,
      concept: "meals_50",
      deductible_bps: 5000,
      notes: "Synthetic revision",
    });
    check((await view()).current, false);
    const stale = await server({ type: "start", link_id: link.id });
    await post("2026-03-01", [
      { account_id: account(1), amount_cents: "1" },
      { account_id: account(5), amount_cents: "-1" },
    ]);
    check(
      (
        await server({
          type: "finish",
          link_id: link.id,
          lease_token: stale.lease_token,
          payload: calculateTaxLink(stale.inputs),
        })
      ).state,
      "stale",
    );
    const personal = await server({ type: "start", link_id: link.id });
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE public.tax_estimates SET additional_deductions=10 WHERE id=$1",
      [estimate],
    );
    await db.exec("SET ROLE authenticated");
    check(
      (
        await server({
          type: "finish",
          link_id: link.id,
          lease_token: personal.lease_token,
          payload: calculateTaxLink(personal.inputs),
        })
      ).state,
      "stale",
    );
    await assert.rejects(
      db.query('SELECT accounting.tax_refresh_server(\'{"type":"due"}\')'),
      /permission denied/,
    );
    n++;
    await assert.rejects(
      db.query("SELECT * FROM accounting.tax_links"),
      /permission denied/,
    );
    n++;
    console.log("Tax inputs and refresh integration:", n, "checks passed");
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
    e.query?.slice(Number(e.position) - 100, Number(e.position) + 150),
  );
  process.exitCode = 1;
});
