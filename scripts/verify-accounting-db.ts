import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  fixtureOwner,
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import type { AccountingWorkspace } from "../src/lib/accounting/contracts";

async function main() {
  const db = new PGlite();
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
      "select public.acct_command($1,$2::jsonb) as result",
      [key, JSON.stringify(payload)],
    );
    return r.rows[0].result;
  };
  const asOwner = async () => {
    await db.exec("reset role; set role authenticated;");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
  };
  try {
    // Only the Supabase auth contract is stubbed. All ledger SQL executes in PostgreSQL.
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated, anon, service_role;
      grant execute on function auth.uid() to authenticated, anon, service_role;`);
    const schema = await readFile(
      new URL(
        "../supabase/migrations/20260905203346_accounting_foundation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const canonical = await readFile(
      new URL("../supabase/schema/schema.sql", import.meta.url),
      "utf8",
    );
    const block =
      /-- ACCOUNTING FOUNDATION BEGIN[\s\S]*?-- ACCOUNTING FOUNDATION END/;
    check(schema.match(block)?.[0], canonical.match(block)?.[0]);
    await db.exec(schema);
    await db.query("insert into auth.users(id) values($1),($2)", [
      fixtureOwner,
      "10000000-0000-4000-8000-000000000002",
    ]);
    await db.query(
      "insert into public.acct_settings(owner_user_id,legal_name) values($1,'Synthetic company')",
      [fixtureOwner],
    );
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
        "select public.acct_command($1,$2::jsonb)",
        [key, JSON.stringify({ ...save, memo: "Different" })],
        /ACCT_IDEMPOTENCY_CONFLICT/,
      );
      await cmd({ type: "entry.post", id, expected_version: first.version });
    }
    const report = (
      await db.query<{ result: AccountingWorkspace }>(
        "select acct_workspace('2026-01-01','2026-02-28') as result",
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
        "select acct_workspace('2026-01-01','2026-01-31') r",
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
    const beforeFailure = (await db.query("select acct_export() as r")).rows;
    await rejected(
      "select acct_command($1,$2::jsonb)",
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
    const afterFailure = (await db.query("select acct_export() as r")).rows;
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
      "select acct_command($1,$2::jsonb)",
      [randomUUID(), JSON.stringify({ ...draft, expected_version: 1 })],
      /ACCT_STALE_VERSION/,
    );
    await rejected(
      "insert into public.acct_journal_entries(entry_date,memo,created_by) values('2026-01-01','Bypass',$1)",
      [fixtureOwner],
      /permission denied/,
    );
    await rejected(
      "select * from public.acct_journal_lines",
      [],
      /permission denied/,
    );
    await rejected(
      "select public.acct_require_open('2026-01-01')",
      [],
      /permission denied/,
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      "10000000-0000-4000-8000-000000000002",
    ]);
    await rejected(
      "select acct_workspace('2026-01-01','2026-12-31')",
      [],
      /ACCT_FORBIDDEN/,
    );
    await rejected(
      "select acct_command($1,$2::jsonb)",
      [randomUUID(), JSON.stringify(draft)],
      /ACCT_FORBIDDEN/,
    );
    await db.exec("reset role; set role service_role;");
    await rejected(
      "delete from public.acct_journal_lines",
      [],
      /permission denied/,
    );
    await rejected("select acct_export()", [], /permission denied/);
    // Privileged DML still encounters the financial guards. An administrator
    // capable of disabling triggers remains outside the application trust boundary.
    await db.exec("reset role;");
    // Even a direct status transition cannot bypass the deferred balance check.
    await rejected(
      "update acct_journal_entries set status='posted',posted_at=now() where id=$1",
      [unbalancedId],
      /ACCT_UNBALANCED/,
    );
    check(
      (
        await db.query<{ status: string }>(
          "select status from acct_journal_entries where id=$1",
          [unbalancedId],
        )
      ).rows[0].status,
      "draft",
    );
    await rejected(
      "insert into acct_journal_lines(entry_id,account_id,amount_cents,sort_order) values($1,$2,100,20)",
      [entryIds[0], fixtureAccountId(1)],
      /ACCT_IMMUTABLE/,
    );
    await rejected(
      "update acct_journal_lines set amount_cents=amount_cents+1 where entry_id=$1",
      [entryIds[0]],
      /ACCT_IMMUTABLE/,
    );
    await rejected(
      "delete from acct_journal_lines where entry_id=$1",
      [entryIds[0]],
      /ACCT_IMMUTABLE/,
    );
    await rejected(
      "update acct_journal_lines set entry_id=$1 where entry_id=$2",
      [unbalancedId, entryIds[0]],
      /ACCT_IMMUTABLE_IDENTITY/,
    );
    await rejected(
      "update acct_journal_entries set entry_date='2026-03-01' where id=$1",
      [entryIds[0]],
      /ACCT_IMMUTABLE/,
    );
    await rejected("delete from acct_audit_log", [], /ACCT_APPEND_ONLY/);
    await rejected(
      "delete from acct_journal_entries where id=$1",
      [unbalancedId],
      /ACCT_NO_HARD_DELETE/,
    );
    await rejected(
      "delete from acct_accounts where id=$1",
      [fixtureAccountId(1)],
      /ACCT_NO_HARD_DELETE/,
    );
    await rejected(
      "update acct_accounts set account_type='income' where id=$1",
      [fixtureAccountId(1)],
      /ACCT_ACCOUNT_IN_USE/,
    );
    await rejected(
      "update acct_accounts set is_archived=true where id=$1",
      [fixtureAccountId(1)],
      /ACCT_ACCOUNT_IN_USE/,
    );
    await rejected(
      "update acct_periods set is_locked=true,reason='Protect month' where month_start='2026-03-01'",
      [],
      /ACCT_DRAFTS_REMAIN/,
    );
    await db.exec(
      "update acct_periods set is_locked=true,reason='Synthetic protected month' where month_start='2026-01-01'",
    );
    await asOwner();
    await rejected(
      "select acct_command($1,$2::jsonb)",
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
      "select acct_command($1,$2::jsonb)",
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
        "select acct_workspace('2026-01-01','2026-02-28') r",
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
      "select acct_command($1,$2::jsonb)",
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
      await db.query<{
        r: {
          lines: { amount_cents: string }[];
          entries: unknown[];
          audit: unknown[];
        };
      }>("select acct_export() r")
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
        "select acct_workspace('2099-01-01','2099-12-31') r",
      )
    ).rows[0].r;
    check(
      huge.balances.find((a) => a.id === fixtureAccountId(1))?.debit_cents,
      "18446744073709551614",
    );
    check(huge.reports.balance_difference_cents, "0");
    const exact = (
      await db.query<{
        r: {
          settings: { financial_revision: string };
          lines: { amount_cents: string }[];
          audit: {
            before_value: Record<string, unknown> | null;
            after_value: Record<string, unknown> | null;
          }[];
        };
      }>("select acct_export() r")
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
      "select acct_workspace('2026-01-01','2026-12-31')",
      [],
      /permission denied/,
    );
    await rejected(
      "select acct_command($1,$2::jsonb)",
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
