import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureOwner,
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import type { AccountingWorkspace } from "../src/lib/accounting/contracts";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  async function rejected(sql: string, params: unknown[], match: RegExp) {
    await assert.rejects(db.query(sql, params), match);
    checks++;
  }
  const cmd = async (payload: object, key = randomUUID()) => {
    const r = await db.query<{ result: { id: string; version: number } }>(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb)) as result",
      [key, JSON.stringify(payload)],
    );
    return r.rows[0].result;
  };
  const exportState = async <T = { r: unknown }>() => {
    await db.exec("RESET ROLE");
    try {
      return await db.query<T>(`SELECT jsonb_build_object(
      'settings',(SELECT to_jsonb(s)||jsonb_build_object('financial_revision',financial_revision::text) FROM accounting.settings s),
      'entries',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM accounting.journal_entries e),
      'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('amount_cents',amount_cents::text) ORDER BY id),'[]') FROM accounting.journal_lines l),
      'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('before_value',before,'after_value',after) ORDER BY id),'[]') FROM accounting.audit_log a),
      'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY idempotency_key),'[]') FROM accounting.command_receipts c)) r`);
    } finally {
      await asOwner();
    }
  };
  const asOwner = async () => {
    await db.exec("reset role; set role authenticated;");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
  };
  try {
    await db.exec("RESET ROLE");
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [
      "10000000-0000-4000-8000-000000000002",
    ]);
    await asOwner();
    for (const a of fixtureAccounts)
      await cmd({ type: "account.create", ...a });
    const entryIds: string[] = [];
    for (const e of fixtureEntries) {
      const id = randomUUID();
      entryIds.push(id);
      const save = {
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: e.date,
        memo: e.memo,
        lines: e.lines.map(([account, amount]) => ({
          account_id: fixtureAccountId(Number(account)),
          amount_cents: amount,
          memo: "",
        })),
      };
      const key = randomUUID();
      const first = await cmd(save, key);
      check(await cmd(save, key), first);
      await rejected(
        "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
        [key, JSON.stringify({ ...save, memo: "Different" })],
        /ACCT_IDEMPOTENCY_CONFLICT/,
      );
      await cmd({ type: "entry.post", id, expected_version: first.version });
    }
    const report = (
      await db.query<{ result: AccountingWorkspace }>(
        "select accounting.workspace('2026-01-01','2026-02-28') as result",
      )
    ).rows[0].result;
    check(report.reports.net_income_cents, "75000");
    check(report.reports.assets_cents, "1278000");
    check(report.reports.liabilities_cents, "3000");
    check(report.reports.equity_cents, "1000000");
    check(report.reports.retained_cents, "200000");
    check(report.reports.year_income_cents, "75000");
    check(report.reports.balance_difference_cents, "0");
    check(
      report.balances.find((a) => a.id === fixtureAccountId(2))?.ending_cents,
      "0",
    );
    const january = (
      await db.query<{ r: AccountingWorkspace }>(
        "select accounting.workspace('2026-01-01','2026-01-31') r",
      )
    ).rows[0].r;
    check(
      january.balances.find((a) => a.id === fixtureAccountId(2))?.ending_cents,
      "50000",
    );
    const unbalancedId = randomUUID();
    const draft = {
      type: "draft.save",
      id: unbalancedId,
      expected_version: 0,
      entry_date: "2026-03-01",
      memo: "Unbalanced draft",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "100", memo: "" },
      ],
    };
    await cmd(draft);
    const beforeFailure = (await exportState()).rows;
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [
        randomUUID(),
        JSON.stringify({
          type: "entry.post",
          id: unbalancedId,
          expected_version: 1,
        }),
      ],
      /ACCT_UNBALANCED/,
    );
    const afterFailure = (await exportState()).rows;
    // The timestamp may change; all financial, audit, and receipt state must not.
    const stableExport = (rows: unknown) =>
      JSON.parse(
        JSON.stringify(rows, (key, value) =>
          key === "generated_at" ? undefined : value,
        ),
      );
    check(stableExport(afterFailure), stableExport(beforeFailure));
    await cmd({ ...draft, expected_version: 1, memo: "Newer edit" });
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [randomUUID(), JSON.stringify({ ...draft, expected_version: 1 })],
      /ACCT_STALE_VERSION/,
    );
    await rejected(
      "insert into accounting.journal_entries(entry_date,memo,created_by) values('2026-01-01','Bypass',$1)",
      [fixtureOwner],
      /permission denied/,
    );
    await rejected(
      "select * from accounting.journal_lines",
      [],
      /permission denied/,
    );
    await rejected(
      "select accounting.require_open('2026-01-01')",
      [],
      /permission denied/,
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      "10000000-0000-4000-8000-000000000002",
    ]);
    await rejected(
      "select accounting.workspace('2026-01-01','2026-12-31')",
      [],
      /ACCT_FORBIDDEN/,
    );
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [randomUUID(), JSON.stringify(draft)],
      /ACCT_FORBIDDEN/,
    );
    await db.exec("reset role; set role service_role;");
    await rejected(
      "delete from accounting.journal_lines",
      [],
      /permission denied/,
    );
    await rejected(
      "select accounting.workspace('2026-01-01','2026-12-31')",
      [],
      /permission denied/,
    );
    // Privileged DML still encounters the financial guards. An administrator
    // capable of disabling triggers remains outside the application trust boundary.
    await db.exec("reset role;");
    // Even a direct status transition cannot bypass the deferred balance check.
    await rejected(
      "update accounting.journal_entries set status='posted',posted_at=now() where id=$1",
      [unbalancedId],
      /ACCT_UNBALANCED/,
    );
    check(
      (
        await db.query<{ status: string }>(
          "select status from accounting.journal_entries where id=$1",
          [unbalancedId],
        )
      ).rows[0].status,
      "draft",
    );
    await rejected(
      "insert into accounting.journal_lines(entry_id,account_id,amount_cents,sort_order) values($1,$2,100,20)",
      [entryIds[0], fixtureAccountId(1)],
      /ACCT_IMMUTABLE/,
    );
    await rejected(
      "update accounting.journal_lines set amount_cents=amount_cents+1 where entry_id=$1",
      [entryIds[0]],
      /ACCT_IMMUTABLE/,
    );
    await rejected(
      "delete from accounting.journal_lines where entry_id=$1",
      [entryIds[0]],
      /ACCT_IMMUTABLE/,
    );
    await rejected(
      "update accounting.journal_lines set entry_id=$1 where entry_id=$2",
      [unbalancedId, entryIds[0]],
      /ACCT_IMMUTABLE_IDENTITY/,
    );
    await rejected(
      "update accounting.journal_entries set entry_date='2026-03-01' where id=$1",
      [entryIds[0]],
      /ACCT_POSTED_IMMUTABLE/,
    );
    await rejected("delete from accounting.audit_log", [], /ACCT_APPEND_ONLY/);
    await rejected(
      "delete from accounting.journal_entries where id=$1",
      [unbalancedId],
      /ACCT_NO_HARD_DELETE/,
    );
    await rejected(
      "delete from accounting.accounts where id=$1",
      [fixtureAccountId(1)],
      /ACCT_NO_HARD_DELETE/,
    );
    await rejected(
      "update accounting.accounts set type='income' where id=$1",
      [fixtureAccountId(1)],
      /ACCT_ACCOUNT_IN_USE/,
    );
    await rejected(
      "update accounting.accounts set is_archived=true where id=$1",
      [fixtureAccountId(1)],
      /ACCT_ACCOUNT_IN_USE/,
    );
    await rejected(
      "update accounting.periods set status='locked',locked_at=now(),locked_by=auth.uid(),reopen_reason='Protect month' where month='2026-03-01'",
      [],
      /ACCT_DRAFTS_REMAIN/,
    );
    await db.exec(
      "update accounting.periods set status='locked',locked_at=now(),locked_by=auth.uid(),reopen_reason='Synthetic protected month' where month='2026-01-01'",
    );
    await asOwner();
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [
        randomUUID(),
        JSON.stringify({
          ...draft,
          id: randomUUID(),
          entry_date: "2026-01-01",
        }),
      ],
      /ACCT_PERIOD_LOCKED/,
    );
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [
        randomUUID(),
        JSON.stringify({
          type: "entry.reverse",
          id: entryIds[2],
          expected_version: 2,
          entry_date: "2026-01-10",
          reason: "Correction",
        }),
      ],
      /ACCT_PERIOD_LOCKED/,
    );
    const reversal = await cmd({
      type: "entry.reverse",
      id: entryIds[2],
      expected_version: 2,
      entry_date: "2026-02-10",
      reason: "Correct duplicate receipt",
    });
    check(Boolean(reversal.id), true);
    const corrected = (
      await db.query<{ r: AccountingWorkspace }>(
        "select accounting.workspace('2026-01-01','2026-02-28') r",
      )
    ).rows[0].r;
    check(corrected.reports.net_income_cents, "-125000");
    check(corrected.reports.balance_difference_cents, "0");
    check(
      corrected.entries.find((e) => e.id === entryIds[2])?.reversed_by_entry_id,
      reversal.id,
    );
    check(
      corrected.entries.find((e) => e.id === reversal.id)?.reverses_entry_id,
      entryIds[2],
    );
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [
        randomUUID(),
        JSON.stringify({
          type: "entry.reverse",
          id: entryIds[2],
          expected_version: 2,
          entry_date: "2026-02-10",
          reason: "Again",
        }),
      ],
      /ACCT_ALREADY_REVERSED/,
    );
    const exportData = (
      await exportState<{
        r: {
          lines: { amount_cents: string }[];
          entries: unknown[];
          audit: unknown[];
        };
      }>()
    ).rows[0].r;
    check(
      exportData.lines.every((l) => typeof l.amount_cents === "string"),
      true,
    );
    check(exportData.entries.length, fixtureEntries.length + 2);
    check(exportData.audit.length > 0, true);
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: "2099-01-01",
        memo: "Exact bigint boundary",
        lines: [
          {
            account_id: fixtureAccountId(1),
            amount_cents: "9223372036854775807",
            memo: "Above safe JS integer",
          },
          {
            account_id: fixtureAccountId(4),
            amount_cents: "-9223372036854775807",
            memo: "",
          },
        ],
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
    }
    const huge = (
      await db.query<{ r: AccountingWorkspace }>(
        "select accounting.workspace('2099-01-01','2099-12-31') r",
      )
    ).rows[0].r;
    check(
      huge.balances.find((a) => a.id === fixtureAccountId(1))?.debit_cents,
      "18446744073709551614",
    );
    check(huge.reports.balance_difference_cents, "0");
    const exact = (
      await exportState<{
        r: {
          settings: { financial_revision: string };
          lines: { amount_cents: string }[];
          audit: {
            before_value: Record<string, unknown> | null;
            after_value: Record<string, unknown> | null;
          }[];
        };
      }>()
    ).rows[0].r;
    check(typeof exact.settings.financial_revision, "string");
    check(
      exact.lines.filter((l) => l.amount_cents === "9223372036854775807")
        .length,
      2,
    );
    check(
      exact.audit.every((a) =>
        [a.before_value, a.after_value].every(
          (v) =>
            !v ||
            ["amount_cents", "financial_revision", "size_bytes"].every(
              (k) => !(k in v) || typeof v[k] === "string",
            ),
        ),
      ),
      true,
    );
    await db.exec("reset role; set role anon;");
    await rejected(
      "select accounting.workspace('2026-01-01','2026-12-31')",
      [],
      /permission denied/,
    );
    await rejected(
      "select accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))",
      [randomUUID(), JSON.stringify(draft)],
      /permission denied/,
    );
    console.log(
      `Accounting PostgreSQL: ${checks} assertions passed. PGlite executes real SQL; multi-connection races require staging verification.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
