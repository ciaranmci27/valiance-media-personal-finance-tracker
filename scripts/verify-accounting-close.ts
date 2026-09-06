import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
  fixtureOwner,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const cmd = async (command: object) =>
    (
      await db.query<{ r: { id: string; version: number } }>(
        "SELECT acct_execute($1,$2::jsonb) r",
        [randomUUID(), JSON.stringify(command)],
      )
    ).rows[0].r;
  const proof = async (id: string) =>
    (
      await db.query<{
        r: {
          ready: boolean;
          unmatched_items: number;
          statement_difference_cents: string;
          bridge_difference_cents: string;
        };
      }>("SELECT acct_reconciliation_proof($1) r", [id])
    ).rows[0].r;
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: [fixtureAccountId(1), fixtureAccountId(9)].includes(a.id)
          ? "bank"
          : a.id === fixtureAccountId(3)
            ? "card"
            : "none",
      })),
    });
    const lines: string[] = [];
    for (const [date, amount] of [
      ["2025-12-31", "10000"],
      ["2026-01-05", "10000"],
      ["2026-01-10", "-2500"],
    ]) {
      const id = randomUUID();
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: date,
        memo: "Reconciliation fixture",
        lines: [
          { account_id: fixtureAccountId(1), amount_cents: amount, memo: "" },
          {
            account_id: fixtureAccountId(2),
            amount_cents: (-BigInt(amount)).toString(),
            memo: "",
          },
        ],
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
      await db.exec("RESET ROLE");
      lines.push(
        (
          await db.query<{ id: string }>(
            "SELECT id FROM acct_journal_lines WHERE entry_id=$1 AND account_id=$2",
            [id, fixtureAccountId(1)],
          )
        ).rows[0].id,
      );
      await db.exec("SET ROLE authenticated");
    }
    const doc = randomUUID();
    await cmd({
      type: "document.prepare",
      id: doc,
      original_name: "fixture-statement.pdf",
      content_hash: "a".repeat(64),
      mime_type: "application/pdf",
      size_bytes: "10",
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [`${doc}/${"a".repeat(64)}`],
    );
    await cmd({ type: "document.complete", id: doc, expected_version: 1 });
    await db.exec("RESET ROLE");
    const id = randomUUID();
    await db.query(
      "INSERT INTO acct_reconciliations(id,account_id,from_date,to_date,opening_cents,ending_cents,declared_count,declared_debits_cents,declared_credits_cents,document_id,created_by) VALUES($1,$2,'2026-01-01','2026-01-31',10000,17500,3,10000,2500,$3,$4)",
      [id, fixtureAccountId(1), doc, fixtureOwner],
    );
    await db.query(
      "INSERT INTO acct_reconciliation_opening(reconciliation_id,entry_line_id,amount_cents) VALUES($1,$2,10000)",
      [id, lines[0]],
    );
    const items = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, amount] of ["10000", "-1000", "-1500"].entries())
      await db.query(
        "INSERT INTO acct_statement_items(id,reconciliation_id,ordinal,entry_date,description,amount_cents) VALUES($1,$2,$3,'2026-01-10','Statement item',$4)",
        [items[index], id, index, amount],
      );
    check((await proof(id)).unmatched_items, 3);
    check((await proof(id)).ready, false);
    for (const [index, amount] of ["10000", "-1000", "-1500"].entries())
      await db.query(
        "INSERT INTO acct_reconciliation_items(id,statement_item_id,entry_line_id,amount_cents) VALUES($1,$2,$3,$4)",
        [randomUUID(), items[index], lines[index === 0 ? 1 : 2], amount],
      );
    check((await proof(id)).ready, true);
    check((await proof(id)).bridge_difference_cents, "0");
    await assert.rejects(
      db.query(
        "INSERT INTO acct_reconciliation_items(id,statement_item_id,entry_line_id,amount_cents) VALUES($1,$2,$3,-1)",
        [randomUUID(), items[1], lines[2]],
      ),
      /ACCT_ALLOCATION_EXCEEDED/,
    );
    checks++;
    await db.query(
      "UPDATE acct_reconciliations SET status='completed',completed_at=now(),proof=acct_reconciliation_proof(id) WHERE id=$1",
      [id],
    );
    await assert.rejects(
      db.query("DELETE FROM acct_statement_items WHERE id=$1", [items[0]]),
      /ACCT_RECONCILIATION_FINAL/,
    );
    checks++;
    const feb = randomUUID();
    await db.query(
      "INSERT INTO acct_reconciliations(id,account_id,from_date,to_date,opening_cents,ending_cents,declared_count,declared_debits_cents,declared_credits_cents,predecessor_id,document_id,created_by) VALUES($1,$2,'2026-02-01','2026-02-28',17500,17500,2,1000,1000,$3,$4,$5)",
      [feb, fixtureAccountId(1), id, doc, fixtureOwner],
    );
    check((await proof(feb)).statement_difference_cents, "0");
    check((await proof(feb)).ready, false);
    await assert.rejects(
      db.query(
        "UPDATE acct_reconciliations SET status='completed',completed_at=now(),proof='{}' WHERE id=$1",
        [feb],
      ),
      /ACCT_RECONCILIATION_INCOMPLETE/,
    );
    checks++;
    const deposit = randomUUID();
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "draft.save",
      id: deposit,
      expected_version: 0,
      entry_date: "2026-03-05",
      memo: "Savings deposit",
      lines: [
        { account_id: fixtureAccountId(9), amount_cents: "500", memo: "" },
        { account_id: fixtureAccountId(2), amount_cents: "-500", memo: "" },
      ],
    });
    await cmd({ type: "entry.post", id: deposit, expected_version: 1 });
    await db.exec("RESET ROLE");
    const depositLine = (
      await db.query<{ id: string }>(
        "SELECT id FROM acct_journal_lines WHERE entry_id=$1 AND account_id=$2",
        [deposit, fixtureAccountId(9)],
      )
    ).rows[0].id;
    await db.exec("SET ROLE authenticated");
    const operate = async (value: object, key = randomUUID()) =>
      (
        await db.query<{ r: { id: string; version: number } }>(
          "SELECT acct_operate($1,$2::jsonb) r",
          [key, JSON.stringify(value)],
        )
      ).rows[0].r;
    const march = randomUUID(),
      marchItem = randomUUID();
    let state = await operate({
      type: "reconciliation.create",
      id: march,
      account_id: fixtureAccountId(9),
      from: "2026-03-01",
      to: "2026-03-31",
      opening_cents: "0",
      ending_cents: "500",
      declared_count: 1,
      declared_debits_cents: "500",
      declared_credits_cents: "0",
      document_id: doc,
    });
    check(state.version, 1);
    await assert.rejects(
      operate({
        type: "reconciliation.complete",
        id: march,
        expected_version: state.version,
      }),
      /ACCT_RECONCILIATION_INCOMPLETE/,
    );
    checks++;
    state = await operate({
      type: "reconciliation.items",
      id: march,
      expected_version: state.version,
      items: [
        {
          id: marchItem,
          ordinal: 0,
          entry_date: "2026-03-05",
          description: "Deposit",
          amount_cents: "500",
        },
      ],
    });
    state = await operate({
      type: "reconciliation.allocate",
      id: march,
      expected_version: state.version,
      allocations: [
        {
          id: randomUUID(),
          statement_item_id: marchItem,
          entry_line_id: depositLine,
          amount_cents: "500",
        },
      ],
    });
    const completion = {
        type: "reconciliation.complete",
        id: march,
        expected_version: state.version,
      },
      completionKey = randomUUID();
    check(
      await operate(completion, completionKey),
      await operate(completion, completionKey),
    );
    const late = randomUUID();
    await cmd({
      type: "draft.save",
      id: late,
      expected_version: 0,
      entry_date: "2026-03-06",
      memo: "Late savings correction",
      lines: [
        { account_id: fixtureAccountId(9), amount_cents: "1", memo: "" },
        { account_id: fixtureAccountId(2), amount_cents: "-1", memo: "" },
      ],
    });
    await cmd({ type: "entry.post", id: late, expected_version: 1 });
    const read = (
      await db.query<{
        r: { statement: { status: string }; proof: { ready: boolean } };
      }>("SELECT acct_reconciliation_view($1,NULL,0,'') r", [march])
    ).rows[0].r;
    check(read.statement.status, "superseded");
    check(read.proof.ready, true);
    const wrongDate = randomUUID();
    await cmd({
      type: "draft.save",
      id: wrongDate,
      expected_version: 0,
      entry_date: "2026-05-05",
      memo: "Misdated receipt",
      lines: [
        { account_id: fixtureAccountId(9), amount_cents: "900", memo: "" },
        { account_id: fixtureAccountId(5), amount_cents: "-900", memo: "" },
      ],
    });
    await cmd({ type: "entry.post", id: wrongDate, expected_version: 1 });
    await operate({
      type: "entry.correct",
      id: wrongDate,
      expected_version: 2,
      replacement_id: randomUUID(),
      reversal_date: "2026-05-05",
      entry_date: "2026-04-05",
      memo: "Correct receipt date",
      reason: "Actual receipt was in April",
      lines: [
        { account_id: fixtureAccountId(9), amount_cents: "900", memo: "" },
        { account_id: fixtureAccountId(5), amount_cents: "-900", memo: "" },
      ],
    });
    const monthly = async (from: string, to: string) =>
      (
        await db.query<{ r: { reports: { income_cents: string } } }>(
          "SELECT acct_workspace($1,$2) r",
          [from, to],
        )
      ).rows[0].r.reports.income_cents;
    check(await monthly("2026-04-01", "2026-04-30"), "900");
    check(await monthly("2026-05-01", "2026-05-31"), "0");
    const checklist = (
      await db.query<{ r: { ready: boolean; revision: string } }>(
        "SELECT acct_close_checklist('2026-01-01') r",
      )
    ).rows[0].r;
    check(checklist.ready, true);
    await operate({
      type: "year.configure",
      id: randomUUID(),
      year: 2026,
      classification: "s_corp",
      expected_revision: checklist.revision,
    });
    const revision = (
      await db.query<{ r: { revision: string } }>(
        "SELECT acct_close_checklist('2026-01-01') r",
      )
    ).rows[0].r.revision;
    await operate({
      type: "period.close",
      id: randomUUID(),
      month: "2026-01-01",
      expected_revision: revision,
    });
    await db.exec("RESET ROLE");
    const januaryVersion = (
      await db.query<{ version: number }>(
        "SELECT version FROM acct_reconciliations WHERE id=$1",
        [id],
      )
    ).rows[0].version;
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      operate({
        type: "reconciliation.reopen",
        id,
        expected_version: januaryVersion,
        reason: "Cannot silently invalidate a closed month",
      }),
      /ACCT_LATER_PERIOD_LOCKED/,
    );
    checks++;
    const latestRevision = async () =>
      (
        await db.query<{ r: { revision: string } }>(
          "SELECT acct_close_history() r",
        )
      ).rows[0].r.revision;
    await assert.rejects(
      operate({
        type: "account.lifecycle",
        id: fixtureAccountId(1),
        expected_version: 0,
        expected_revision: await latestRevision(),
        opened_on: "2026-02-01",
        closed_on: null,
        document_id: null,
        reason: "Invalid late opening date",
      }),
      /ACCT_ACCOUNT_LIFECYCLE/,
    );
    checks++;
    const cardStatement = randomUUID();
    await operate({
      type: "reconciliation.create",
      id: cardStatement,
      account_id: fixtureAccountId(3),
      from: "2026-03-01",
      to: "2026-03-31",
      opening_cents: "0",
      ending_cents: "0",
      declared_count: 0,
      declared_debits_cents: "0",
      declared_credits_cents: "0",
      document_id: doc,
    });
    await operate({
      type: "reconciliation.complete",
      id: cardStatement,
      expected_version: 1,
    });
    await operate({
      type: "account.lifecycle",
      id: fixtureAccountId(3),
      expected_version: 0,
      expected_revision: await latestRevision(),
      opened_on: "2026-03-01",
      closed_on: "2026-03-31",
      document_id: doc,
      reason: "Final zero-balance statement received",
    });
    const invalidCard = randomUUID();
    await cmd({
      type: "draft.save",
      id: invalidCard,
      expected_version: 0,
      entry_date: "2026-04-03",
      memo: "After account closure",
      lines: [
        { account_id: fixtureAccountId(3), amount_cents: "-100", memo: "" },
        { account_id: fixtureAccountId(6), amount_cents: "100", memo: "" },
      ],
    });
    await assert.rejects(
      cmd({ type: "entry.post", id: invalidCard, expected_version: 1 }),
      /ACCT_ACCOUNT_LIFECYCLE/,
    );
    checks++;
    console.log(
      `Statement reconciliation foundation: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
