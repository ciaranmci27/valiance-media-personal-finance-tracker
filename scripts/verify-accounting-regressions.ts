// Money bugs found in the November 2026 accounting review, each replayed against the real migrations.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureAccounts, fixtureAccountId as account } from "../src/lib/accounting/fixtures";
import { buildReportModel } from "../src/lib/accounting/report-model";
import { ownerTotals } from "../src/lib/accounting/owner-activity";
import { extendedCommandSchema } from "../src/lib/accounting/workflows";

let checks = 0;
const check = (actual: unknown, expected: unknown, label?: string) => {
  assert.deepEqual(actual, expected, label);
  checks++;
};

/** Fresh books with the fixture chart and one synthetic bank feed on account 1. */
async function books() {
  const db = await accountingTestDb();
  const cmd = async (command: object): Promise<any> =>
    (
      await db
        .query<{ r: any }>("SELECT accounting.operate($1) r", [JSON.stringify({ key: randomUUID(), command })])
        .catch((e) => {
          throw new Error(`${JSON.stringify(command)}: ${e.message}`);
        })
    ).rows[0].r;
  const raw = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => {
    await db.exec("RESET ROLE");
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  await cmd({
    type: "chart.seed",
    id: randomUUID(),
    accounts: fixtureAccounts.map((a) => ({ ...a, cash_kind: a.id === account(1) ? "bank" : "none" })),
  });
  const connection = randomUUID();
  await cmd({ type: "feed.claim", id: connection, name: "Synthetic bank", access_url_encrypted: "encrypted-fixture-not-a-secret-value", expected_version: 0 });
  await cmd({
    type: "feed.map",
    id: randomUUID(),
    expected_version: 0,
    account_id: account(1),
    connection_id: connection,
    provider_account_id: JSON.stringify(["synthetic", "checking"]).replace(",", ", "),
    coverage_from: "2026-01-01",
    movement_sign: 1,
  });
  const tx = (external: string, cents: string, description: string, day = "2026-01-12") => ({
    external_id: external,
    posted: Date.parse(`${day}T18:00:00Z`) / 1000,
    amount_cents: cents,
    description,
    state: "posted",
    hash: createHash("sha256").update(external).digest("hex"),
    raw: { synthetic: true },
  });
  /** One scheduled sync the way the edge function runs it: lease, one chunk, and "fail" on an error. */
  const sync = async (transactions: object[]): Promise<string> => {
    await db.exec("RESET ROLE; SET ROLE service_role");
    const run = randomUUID();
    const call = async (c: object) =>
      (await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [JSON.stringify({ id: connection, run_id: run, ...c })])).rows[0].r;
    try {
      const lease = await call({ action: "lease" });
      if (!lease.acquired) return "lease not acquired";
      await call({
        action: "complete",
        through: 1800000000,
        create_drafts: true,
        accounts: [
          {
            provider_connection_id: "synthetic",
            provider_account_id: "checking",
            currency: "USD",
            name: "Synthetic checking",
            institution: "Synthetic bank",
            balance_cents: "10000",
            balance_at: Date.parse("2026-01-31T18:00:00Z") / 1000,
            complete: true,
            transactions,
          },
        ],
      });
      return "ok";
    } catch (e) {
      await call({ action: "fail", code: "sync_failed", error: "The sync stopped before completion." }).catch(() => undefined);
      return `failed: ${(e as Error).message}`;
    } finally {
      await db.exec("RESET ROLE; SET ROLE authenticated");
    }
  };
  const entries = (description: string) =>
    raw<{ id: string; status: string; version: number }>(
      "SELECT id,status,version FROM accounting.journal_entries WHERE source_description=$1 ORDER BY created_at,id",
      [description],
    );
  const post = (lines: [string, string][], memo: string, date = "2026-01-15", extra: object = {}) =>
    cmd({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo,
      lines: lines.map(([account_id, amount_cents]) => ({ account_id, amount_cents })),
      ...extra,
    });
  const report = async (kind: string, params: object) =>
    (await db.query<{ r: any }>("SELECT accounting.report($1,$2) r", [kind, JSON.stringify(params)])).rows[0].r;
  return { db, cmd, raw, tx, sync, entries, post, report };
}

async function deletedBankDraftStaysDeleted() {
  const b = await books();
  check(await b.sync([b.tx("personal-1", "-2500", "PERSONAL STORE")]), "ok");
  const [draft] = await b.entries("PERSONAL STORE");
  await b.cmd({ type: "draft.discard", id: draft.id, expected_version: draft.version, reason: "Deleted in Transactions", exclude_bank: true });
  check((await b.raw("SELECT review FROM accounting.bank_transactions WHERE external_id='personal-1'"))[0].review, "excluded");
  // Every sync re-reads the last 30 days; the deleted charge must not come back.
  check(await b.sync([b.tx("personal-1", "-2500", "PERSONAL STORE")]), "ok");
  check((await b.entries("PERSONAL STORE")).map((e) => e.status), ["discarded"], "deleted bank draft came back");
  await b.db.close();
}

async function rulesNeverStallTheSync() {
  const b = await books();
  const old = randomUUID();
  await b.cmd({ type: "account.create", id: old, name: "Old category", account_type: "expense", subtype: "operating_expense" });
  await b.cmd({ type: "rule.save", id: randomUUID(), expected_version: 0, name: "Coffee", priority: 10, enabled: true, description_mode: "contains", description: "COFFEE", category_account_id: old });
  const [acct] = await b.raw("SELECT version FROM accounting.accounts WHERE id=$1", [old]);
  await b.cmd({ type: "account.update", id: old, expected_version: acct.version, is_archived: true });
  check(await b.sync([b.tx("ok-1", "-1200", "GROCERY"), b.tx("coffee-1", "-450", "COFFEE SHOP 123")]), "ok", "archived rule category stalled the sync");
  check((await b.raw("SELECT count(*)::int n FROM accounting.bank_transactions"))[0].n, 2);
  const [coffee] = await b.entries("COFFEE SHOP 123");
  check(
    (await b.raw("SELECT count(*)::int n FROM accounting.journal_lines WHERE entry_id=$1 AND account_id=$2", [coffee.id, old]))[0].n,
    0,
    "a rule filed into an archived category",
  );
  await b.db.close();

  const s = await books();
  const other = randomUUID();
  await s.cmd({ type: "account.create", id: other, name: "Personal share", account_type: "expense", subtype: "operating_expense" });
  await s.cmd({
    type: "rule.save",
    id: randomUUID(),
    expected_version: 0,
    name: "Phone split",
    priority: 10,
    enabled: true,
    conditions: { description_mode: "contains", description: "PHONE" },
    actions: { splits: [{ account_id: account(6), share_bps: 9000 }, { account_id: other, share_bps: 1000 }] },
  });
  check(await s.sync([s.tx("phone-adj", "-5", "PHONE CO ADJUSTMENT"), s.tx("phone-bill", "-10000", "PHONE CO BILL")]), "ok", "a cents-sized split stalled the sync");
  const [adjustment] = await s.entries("PHONE CO ADJUSTMENT");
  check(adjustment.status, "draft", "the cents-sized charge waits for a person");
  const [bill] = await s.entries("PHONE CO BILL");
  check(
    (await s.raw("SELECT amount_cents::text a FROM accounting.journal_lines WHERE entry_id=$1 AND account_id IN ($2,$3) ORDER BY amount_cents DESC", [bill.id, account(6), other])).map((r) => r.a),
    ["9000", "1000"],
    "the split rule still splits an ordinary charge",
  );
  await s.db.close();
}

async function costOfSalesCounts() {
  const b = await books();
  const cogs = randomUUID();
  await b.cmd({ type: "account.create", id: cogs, name: "Contractors (cost of sales)", account_type: "expense", subtype: "cogs" });
  await b.post([[account(1), "500000"], [account(5), "-500000"]], "Client payment");
  await b.post([[account(1), "-200000"], [cogs, "200000"]], "Contractor");
  await b.post([[account(1), "-50000"], [account(6), "50000"]], "Software");
  const data = await b.report("profit_loss", { from: "2026-01-01", to: "2026-01-31" });
  check(
    [data.cost_of_goods_sold_cents, data.gross_profit_cents, data.operating_expense_cents],
    ["200000", "300000", "50000"],
  );
  const rows = new Map(buildReportModel("profit-loss", data).rows.map((r) => [r.label, r.values?.[0]]));
  check([rows.get("Total cost of sales"), rows.get("Gross profit")], ["200000", "300000"]);
  await b.db.close();
}

async function editKeepsTheNewContact() {
  const b = await books();
  const a = randomUUID(),
    c = randomUUID();
  await b.cmd({ type: "party.save", id: a, expected_version: 0, name: "Vendor A", roles: ["vendor"] });
  await b.cmd({ type: "party.save", id: c, expected_version: 0, name: "Vendor B", roles: ["vendor"] });
  const posted = await b.post([[account(1), "-3000"], [account(6), "3000"]], "Tool", "2026-01-15", { context: { kind: "expense", payee_id: a } });
  const [before] = await b.raw("SELECT version FROM accounting.journal_entries WHERE id=$1", [posted.id]);
  const correct = {
    type: "entry.correct",
    id: posted.id,
    expected_version: before.version,
    replacement_id: randomUUID(),
    entry_date: "2026-01-15",
    reversal_date: "2026-01-15",
    memo: "Tool",
    reason: "Edited in Transactions",
    lines: [{ account_id: account(1), amount_cents: "-3500" }, { account_id: account(6), amount_cents: "3500" }],
    payee_id: c,
  };
  check(extendedCommandSchema.safeParse(correct).success, true, "the edit form can send a contact");
  await b.cmd(correct);
  check((await b.raw("SELECT payee_id FROM accounting.journal_entries WHERE replaces_entry_id=$1", [posted.id]))[0].payee_id, c);
  // Without a contact the new version keeps the original's.
  const [replaced] = await b.raw("SELECT id,version FROM accounting.journal_entries WHERE replaces_entry_id=$1", [posted.id]);
  const { payee_id: _drop, ...keep } = correct;
  void _drop;
  await b.cmd({ ...keep, id: replaced.id, expected_version: replaced.version, replacement_id: randomUUID() });
  check((await b.raw("SELECT payee_id FROM accounting.journal_entries WHERE replaces_entry_id=$1", [replaced.id]))[0].payee_id, c);
  await b.db.close();
}

async function deletedDrawCountsOnce() {
  for (const action of ["delete", "edit"] as const) {
    const b = await books();
    const draw = await b.post([[account(1), "-500000"], [account(4), "500000"]], "Owner draw");
    const [e] = await b.raw("SELECT version FROM accounting.journal_entries WHERE id=$1", [draw.id]);
    if (action === "delete")
      await b.cmd({ type: "entry.reverse", id: draw.id, expected_version: e.version, entry_date: "2026-01-15", reason: "Deleted" });
    else
      await b.cmd({
        type: "entry.correct",
        id: draw.id,
        expected_version: e.version,
        replacement_id: randomUUID(),
        entry_date: "2026-01-16",
        reversal_date: "2026-01-15",
        memo: "Owner draw",
        reason: "Edited date",
        lines: [{ account_id: account(1), amount_cents: "-500000" }, { account_id: account(4), amount_cents: "500000" }],
      });
    const data = await b.report("owner_activity", { from: "2026-01-01", to: "2026-01-31" });
    const t = ownerTotals(data);
    check([t.putIn.toString(), t.takenOut.toString()], action === "delete" ? ["0", "0"] : ["0", "500000"], `owner totals after ${action}`);
    // The ledger's own debits and credits still show every line.
    const equity = data.accounts.find((a: any) => a.id === account(4));
    check([equity.debit_cents, equity.credit_cents], action === "delete" ? ["500000", "500000"] : ["1000000", "500000"]);
    // A reversal in a later period is that period's movement.
    const feb = await b.report("owner_activity", { from: "2026-01-16", to: "2026-01-31" });
    if (action === "edit") check(ownerTotals(feb).takenOut.toString(), "500000");
    await b.db.close();
  }
}

async function sameAmountChargesMatchOneEach() {
  const b = await books();
  await b.post([[account(1), "-2500"], [account(6), "2500"]], "Hosting (entered by hand)", "2026-01-12");
  await b.post([[account(1), "-2500"], [account(6), "2500"]], "Hosting (entered by hand)", "2026-01-12");
  check(await b.sync([b.tx("host-1", "-2500", "HOSTING CO"), b.tx("host-2", "-2500", "HOSTING CO")]), "ok");
  const rows = await b.raw<{ matched: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM accounting.bank_matches m WHERE m.journal_line_id=l.id) matched
     FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id AND l.account_id=$1
     WHERE l.amount_cents=-2500 AND e.status<>'discarded'`,
    [account(1)],
  );
  check(rows.map((r) => r.matched), [true, true], "two charges, two entries, each matched once");
  await b.db.close();
}

async function main() {
  await deletedBankDraftStaysDeleted();
  await rulesNeverStallTheSync();
  await costOfSalesCounts();
  await editKeepsTheNewContact();
  await deletedDrawCountsOnce();
  await sameAmountChargesMatchOneEach();
  console.log(`Accounting regressions: ${checks} checks passed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
