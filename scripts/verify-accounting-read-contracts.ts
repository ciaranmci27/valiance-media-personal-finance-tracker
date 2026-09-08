import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import {
  readAccounting,
  type AccountingRpc,
} from "../src/lib/accounting/server/read";
import { extendedRequestSchema } from "../src/lib/accounting/workflows";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    n++;
  };
  const rpc: AccountingRpc = {
    async rpc(name, args = {}) {
      assert.match(name, /^[a-z_]+$/);
      for (const k of Object.keys(args)) assert.match(k, /^[a-z_]+$/);
      try {
        const keys = Object.keys(args);
        return {
          data: (
            await db.query<{ r: any }>(
              `SELECT accounting.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) r`,
              keys.map((k) =>
                typeof args[k] === "object" && args[k] !== null
                  ? JSON.stringify(args[k])
                  : args[k],
              ),
            )
          ).rows[0].r,
          error: null,
        };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
  const read = async (view: string, p: Record<string, unknown> = {}) => {
    const r = await readAccounting(rpc, view, p);
    assert.equal(r.error, null, `${view}: ${r.error?.message}`);
    n++;
    return r.data as any;
  };
  const cmd = async (command: object) =>
    read("operate", { p_key: randomUUID(), p_command: command });
  try {
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: [fixtureAccountId(1), fixtureAccountId(9)].includes(a.id)
          ? "bank"
          : a.id === fixtureAccountId(3)
            ? "card"
            : "none",
      });
    const entry = randomUUID();
    await cmd({
      type: "draft.save",
      id: entry,
      expected_version: 0,
      entry_date: "2026-06-01",
      memo: "Synthetic read contract",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "12345" },
        { account_id: fixtureAccountId(5), amount_cents: "-12345" },
      ],
    });
    await cmd({ type: "entry.post", id: entry, expected_version: 1 });
    const note = randomUUID();
    await cmd({
      type: "entry.annotate",
      id: note,
      entry_id: entry,
      note: "Synthetic evidence note",
    });
    const evidence = await read("evidence", { p_entry: entry });
    check(evidence.notes[0].id, note);
    check(evidence.notes[0].note, "Synthetic evidence note");
    check(Array.isArray(evidence.sources), true);
    check(typeof evidence.audit[0].recorded_at, "string");
    const workspace = await read("workspace", {
      p_from: "2026-01-01",
      p_to: "2026-06-30",
    });
    check(workspace.reports.net_income_cents, "12345");
    check(workspace.needs_review_count, 0);
    check(workspace.sync_due, false);
    check(workspace.entries[0].prior_treatment, null);
    const filtered = await read("workspace", {
      p_from: "2026-01-01",
      p_to: "2026-06-30",
      p_entry_id: entry,
    });
    check(filtered.entries.length, 1);
    const line = workspace.entries[0].lines.find(
      (l: any) => l.account_id === fixtureAccountId(1),
    );
    const cash = await read("cash-review", { p_line: line.id });
    check(cash.amount_cents, "12345");
    check(cash.allocations[0].classification, "operating");
    const rec = randomUUID();
    await cmd({
      type: "reconciliation.create",
      id: rec,
      account_id: fixtureAccountId(1),
      from: "2026-06-01",
      to: "2026-06-30",
      opening_cents: "0",
      ending_cents: "12345",
    });
    const reconciliation = await read("reconciliation", {
      p_id: rec,
      p_account: fixtureAccountId(1),
    });
    check(reconciliation.statement.ending_cents, "12345");
    check(reconciliation.proof.ready, false);
    check(reconciliation.lines[0].amount_cents, "12345");
    await cmd({
      type: "transfer.create",
      id: randomUUID(),
      from_account_id: fixtureAccountId(1),
      to_account_id: fixtureAccountId(9),
      amount_cents: "100",
      memo: "Synthetic transfer",
      outgoing_date: "2026-06-02",
      incoming_date: "2026-06-03",
    });
    const transfers = await read("transfers", {
      p_from: "2026-06-01",
      p_to: "2026-06-30",
    });
    check(transfers.groups[0].amount_cents, "100");
    check(transfers.total, 1);
    for (const view of [
      "manage",
      "feeds",
      "rules",
      "history",
      "close-history",
      "documents",
      "imports",
      "registers",
    ])
      await read(view);
    const profiles = (await read("manage")).profiles;
    check(
      profiles.find((p: any) => p.account_id === fixtureAccountId(1)).type,
      "asset",
    );
    check(profiles[0].external_names, {});
    await cmd({
      type: "rule.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Synthetic merchant",
      priority: 1,
      description_mode: "contains",
      description: "Synthetic",
      bank_account_id: fixtureAccountId(1),
      direction: "decrease",
      min_cents: "0",
      max_cents: "10000",
      match_payee_id: null,
      category_account_id: fixtureAccountId(6),
      assign_payee_id: null,
      reason: "Synthetic contract check",
    });
    const rule = (await read("rules")).rules[0];
    check(rule.description, "Synthetic");
    check(rule.max_cents, "10000");
    check(rule.category_account_id, fixtureAccountId(6));
    check(rule.match_payee_id, null);
    await read("register", {
      p_filter: { from: "2026-01-01", to: "2026-06-30", limit: 10 },
    });
    await read("bank-review");
    await read("rules-preview", { p_from: "2026-01-01", p_to: "2026-06-30" });
    await read("payroll", { p_filter: { year: 2026 } });
    await read("payroll-year", { p_year: 2026, p_through: "2026-06-30" });
    await read("tax", { p_year: 2026 });
    await read("tax-source", { p_year: 2026, p_through: "2026-06-30" });
    await read("contractors", { p_filter: { year: 2026 } });
    const filter = { from: "2026-01-01", to: "2026-06-30", mode: "posted" };
    for (const view of ["report", "ledger-report", "report-detail"])
      await read(view, { p_filter: filter });
    check(
      Array.isArray(
        (await read("ledger-report", { p_filter: filter })).accounts,
      ),
      true,
    );
    await read("account-ledger", {
      p_account: fixtureAccountId(1),
      p_from: filter.from,
      p_to: filter.to,
    });
    await read("period-impact", { p_month: "2026-06-01" });
    await read("close", { p_month: "2026-06-01" });
    check(
      extendedRequestSchema.safeParse({
        key: randomUUID(),
        command: {
          type: "entry.categorize",
          id: randomUUID(),
          expected_version: 1,
          account_id: fixtureAccountId(6),
        },
      }).success,
      true,
    );
    const splitRule = {
      type: "rule.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Synthetic split rule",
      priority: 3,
      reason: "Boundary test",
      conditions: {
        descriptor_key: { prefix: "SYNTHETIC" },
        amount_min: "1",
        amount_max: "99999",
      },
      actions: {
        splits: [
          { account_id: fixtureAccountId(6), share_bps: 6000 },
          { account_id: fixtureAccountId(7), share_bps: 4000 },
        ],
      },
    };
    const splitParsed = extendedRequestSchema.parse({
      key: randomUUID(),
      command: splitRule,
    });
    await cmd(splitParsed.command);
    check(
      (await read("rules")).rules.some((r: any) => r.id === splitRule.id),
      true,
    );
    check(
      extendedRequestSchema.safeParse({
        key: randomUUID(),
        command: {
          ...splitRule,
          actions: {
            splits: [
              { account_id: fixtureAccountId(6), share_bps: 6000 },
              { account_id: fixtureAccountId(7), share_bps: 3000 },
            ],
          },
        },
      }).success,
      false,
    );
    check(
      extendedRequestSchema.safeParse({
        key: randomUUID(),
        command: {
          type: "alias.save",
          id: randomUUID(),
          expected_version: 0,
          party_id: randomUUID(),
          match_kind: "key",
          pattern: "SYNTHETIC MERCHANT",
          enabled: true,
        },
      }).success,
      true,
    );
    for (const type of [
      "dimension.save",
      "template.save",
      "view.save",
      "tax.plan.save",
      "authority.change",
      "invoice.capture",
      "history.disposition",
    ])
      check(
        extendedRequestSchema.safeParse({
          key: randomUUID(),
          command: { type, id: randomUUID() },
        }).success,
        false,
      );
    check(
      (await readAccounting(rpc, "not-a-view")).error?.message,
      "ACCT_INVALID_VIEW",
    );
    await db.exec("SET ROLE anon");
    check((await readAccounting(rpc, "manage")).data, null);
    console.log(
      `Accounting HTTP view bridge and frozen read contracts: ${n} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.stack);
  process.exitCode = 1;
});
