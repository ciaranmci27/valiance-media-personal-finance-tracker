import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const cmd = async (command: object, key = randomUUID()) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key, command }),
      ])
    ).rows[0].r;
  const read = async <T>(sql: string, params: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const statement = async (id: string) =>
    (
      await read<any>(
        "SELECT *,difference_cents::text difference FROM accounting.reconciliations WHERE id=$1",
        [id],
      )
    )[0];
  const post = async (
    date: string,
    amount: string,
    bank = account(1),
    counter = account(2),
  ) => {
    let e = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo: "Synthetic reconciliation evidence",
      lines: [
        { account_id: bank, amount_cents: amount },
        { account_id: counter, amount_cents: (-BigInt(amount)).toString() },
      ],
    });
    e = await cmd({
      type: "entry.post",
      id: e.id,
      expected_version: e.version,
    });
    const detail = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [e.id])
    ).rows[0].r;
    return {
      entry: e,
      line: detail.lines.find((l: any) => l.account_id === bank),
    };
  };
  try {
    await cmd({
      type: "chart.seed",
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: [account(1), account(9)].includes(a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      })),
    });
    await post("2025-12-31", "10000");
    const deposit = await post("2026-01-05", "10000");
    const withdrawal = await post("2026-01-10", "-2500");
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic-statement.pdf",
      content_hash: "a".repeat(64),
      mime_type: "application/pdf",
      size_bytes: "10",
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
    let jan = await cmd({
      type: "reconciliation.create",
      id: randomUUID(),
      account_id: account(1),
      from: "2026-01-01",
      to: "2026-01-31",
      opening_cents: "10000",
      ending_cents: "17500",
      document_id: doc.id,
    });
    check((await statement(jan.id)).difference, "7500");
    const partial = randomUUID();
    jan = await cmd({
      type: "reconciliation.allocate",
      id: jan.id,
      expected_version: jan.version,
      allocations: [
        {
          id: randomUUID(),
          entry_line_id: deposit.line.id,
          amount_cents: "10000",
        },
        {
          id: partial,
          entry_line_id: withdrawal.line.id,
          amount_cents: "-1000",
        },
      ],
    });
    check((await statement(jan.id)).difference, "-1500");
    await assert.rejects(
      cmd({
        type: "reconciliation.complete",
        id: jan.id,
        expected_version: jan.version,
      }),
      /ACCT_RECONCILIATION_DIFFERENCE/,
    );
    checks++;
    jan = await cmd({
      type: "reconciliation.unmatch",
      id: jan.id,
      expected_version: jan.version,
      allocation_id: partial,
      reason: "Replace partial amount with full selected bank line",
    });
    await assert.rejects(
      cmd({
        type: "reconciliation.allocate",
        id: jan.id,
        expected_version: jan.version,
        allocations: [
          {
            id: randomUUID(),
            entry_line_id: withdrawal.line.id,
            amount_cents: "-2501",
          },
        ],
      }),
      /ACCT_RECONCILIATION_ALLOCATION/,
    );
    checks++;
    const allocated = randomUUID();
    jan = await cmd({
      type: "reconciliation.allocate",
      id: jan.id,
      expected_version: jan.version,
      allocations: [
        {
          id: allocated,
          entry_line_id: withdrawal.line.id,
          amount_cents: "-2500",
        },
      ],
    });
    check((await statement(jan.id)).difference, "0");
    jan = await cmd({
      type: "reconciliation.complete",
      id: jan.id,
      expected_version: jan.version,
    });
    await assert.rejects(
      cmd({
        type: "reconciliation.item.remove",
        id: jan.id,
        expected_version: jan.version,
        item_id: allocated,
        reason: "Refuse completed selection edits",
      }),
      /ACCT_RECONCILIATION_COMPLETED/,
    );
    checks++;
    let feb = await cmd({
      type: "reconciliation.create",
      id: randomUUID(),
      account_id: account(1),
      from: "2026-02-01",
      to: "2026-02-28",
      opening_cents: "17500",
      ending_cents: "17500",
    });
    check((await statement(feb.id)).difference, "0");
    await assert.rejects(
      cmd({
        type: "reconciliation.allocate",
        id: feb.id,
        expected_version: feb.version,
        allocations: [
          {
            id: randomUUID(),
            entry_line_id: deposit.line.id,
            amount_cents: "1",
          },
        ],
      }),
      /unique constraint/,
    );
    checks++;
    feb = await cmd({
      type: "reconciliation.complete",
      id: feb.id,
      expected_version: feb.version,
    });
    check((await statement(feb.id)).status, "completed");
    const saving = await post("2026-03-05", "500", account(9));
    let march = await cmd({
      type: "reconciliation.create",
      id: randomUUID(),
      account_id: account(9),
      from: "2026-03-01",
      to: "2026-03-31",
      opening_cents: "0",
      ending_cents: "500",
      document_id: doc.id,
    });
    check(march.version, 1);
    await assert.rejects(
      cmd({
        type: "reconciliation.complete",
        id: march.id,
        expected_version: march.version,
      }),
      /ACCT_RECONCILIATION_DIFFERENCE/,
    );
    checks++;
    march = await cmd({
      type: "reconciliation.allocate",
      id: march.id,
      expected_version: march.version,
      allocations: [
        {
          id: randomUUID(),
          entry_line_id: saving.line.id,
          amount_cents: "500",
        },
      ],
    });
    const completion = {
        type: "reconciliation.complete",
        id: march.id,
        expected_version: march.version,
      },
      key = randomUUID();
    check(await cmd(completion, key), await cmd(completion, key));
    await post("2026-03-06", "1", account(9));
    check((await statement(march.id)).status, "in_progress");
    check((await statement(march.id)).difference, "0");
    const wrong = await post("2026-05-05", "900", account(9), account(5));
    await assert.rejects(
      cmd({
        type: "entry.correct",
        id: wrong.entry.id,
        expected_version: wrong.entry.version,
        replacement_id: randomUUID(),
        reversal_date: "2026-05-05",
        entry_date: "2022-12-30",
        memo: "Before history boundary",
        reason: "Invalid correction date",
        lines: [
          { account_id: account(9), amount_cents: "900" },
          { account_id: account(5), amount_cents: "-900" },
        ],
      }),
      /ACCT_INVALID_CORRECTION_DATE_OR_REASON/,
    );
    checks++;
    await cmd({
      type: "entry.correct",
      id: wrong.entry.id,
      expected_version: wrong.entry.version,
      replacement_id: randomUUID(),
      reversal_date: "2026-05-05",
      entry_date: "2026-04-05",
      memo: "Correct receipt date",
      reason: "Actual receipt was in April",
      lines: [
        { account_id: account(9), amount_cents: "900" },
        { account_id: account(5), amount_cents: "-900" },
      ],
    });
    const monthly = async (from: string, to: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.workspace($1,$2) r", [
          from,
          to,
        ])
      ).rows[0].r.reports.income_cents;
    check(await monthly("2026-04-01", "2026-04-30"), "900");
    check(await monthly("2026-05-01", "2026-05-31"), "0");
    const checklist = (
      await db.query<{ r: any }>(
        "SELECT accounting.close_checklist('2026-01-01') r",
      )
    ).rows[0].r;
    check(checklist.ready, true);
    await cmd({
      type: "period.close",
      month: "2026-01-01",
      expected_revision: checklist.revision,
    });
    const before = (
      await read<any>(
        "SELECT close_snapshot FROM accounting.periods WHERE month='2026-01-01'",
      )
    )[0].close_snapshot;
    jan = await cmd({
      type: "reconciliation.reopen",
      id: jan.id,
      expected_version: jan.version,
      reason: "Review optional statement evidence",
    });
    check(
      (
        await read<any>(
          "SELECT close_snapshot FROM accounting.periods WHERE month='2026-01-01'",
        )
      )[0].close_snapshot,
      before,
    );
    const card = await cmd({
      type: "reconciliation.create",
      id: randomUUID(),
      account_id: account(3),
      from: "2026-03-01",
      to: "2026-03-31",
      opening_cents: "0",
      ending_cents: "0",
      document_id: doc.id,
    });
    await cmd({
      type: "reconciliation.complete",
      id: card.id,
      expected_version: card.version,
    });
    check((await statement(card.id)).status, "completed");
    await assert.rejects(
      db.query("SELECT * FROM accounting.reconciliation_items"),
      /permission denied/,
    );
    checks++;
    console.log(
      `Statement reconciliation, dated corrections and optional close evidence: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
