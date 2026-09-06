import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  readCsv,
  bankGroups,
  type CsvOptions,
} from "../src/lib/accounting/imports/csv";
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
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number; count?: number } }>(
        "SELECT acct_operate($1,$2::jsonb) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  type Candidate = {
    id: string;
    version: number;
    eligible: boolean;
    reason: string;
    matches: { rule_id: string; version: number }[];
    winner: { rule_id: string; version: number };
    bank_amount_cents: string;
    lines: { account_id: string; amount_cents: string }[];
  };
  const preview = async (id: string | null = null) =>
    (
      await db.query<{
        r: { revision: string; total: number; rows: Candidate[] };
      }>("SELECT acct_rules_preview('2026-01-01','2026-12-31',$1,0) r", [id])
    ).rows[0].r;
  const draft = async (
    memo: string,
    amount = "-1999",
    category = account(11),
  ) =>
    cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-06-01",
      memo,
      lines: [
        { account_id: account(1), amount_cents: amount, memo: "" },
        {
          account_id: category,
          amount_cents: (-BigInt(amount)).toString(),
          memo: "",
        },
      ],
    });
  const ruleBase = {
    name: "Acme subscriptions",
    priority: 10,
    description_mode: "prefix",
    description: "ACME ",
    bank_account_id: account(1),
    direction: "decrease",
    min_cents: "100",
    max_cents: "2500",
    match_payee_id: null,
    category_account_id: account(6),
    assign_payee_id: null,
    reason: "Reviewed bounded subscription rule",
  };
  const activate = async (id: string, version: number, enabled = true) =>
    cmd({
      type: "rule.activate",
      id,
      expected_version: version,
      expected_revision: (await preview()).revision,
      reviewed: true,
      enabled,
      reason: "Preview checked against the source transactions",
    });
  try {
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: [
        ...fixtureAccounts.map((a) => ({
          ...a,
          cash_kind: a.id === account(1) ? "bank" : "none",
        })),
        {
          id: account(11),
          code: "5999",
          name: "Uncategorized expense",
          account_type: "expense",
          normal_side: "debit",
          purpose: "uncategorized_expense",
          cash_kind: "none",
        },
      ],
    });
    const first = await draft(" ACME    HOSTING "),
      second = await draft("Acme seats", "-2000"),
      large = await draft("Acme annual", "-50000");
    await draft("Other vendor", "-1000");
    const reviewed = await draft("ACME reviewed", "-1200", account(6));
    const posted = await draft("ACME previous", "-1300", account(6));
    await cmd({
      type: "entry.post",
      id: posted.id,
      expected_version: posted.version,
    });
    let rule = await cmd({
      type: "rule.save",
      id: randomUUID(),
      expected_version: 0,
      ...ruleBase,
    });
    check((await preview()).total, 0);
    let p = await preview(rule.id);
    check(p.total, 4);
    check(p.rows.find((r) => r.id === first.id)?.eligible, true);
    check(
      p.rows.some((r) => r.id === large.id),
      false,
    );
    check(
      p.rows.find((r) => r.id === reviewed.id)?.reason,
      "Category already reviewed",
    );
    check(
      p.rows.find((r) => r.id === posted.id)?.reason,
      "Posted history is preview only",
    );
    rule = await activate(rule.id, rule.version);
    p = await preview();
    check(p.rows.filter((r) => r.eligible).length, 2);
    const apply = (r: Candidate) => ({
      id: r.id,
      expected_version: r.version,
      rule_id: r.winner.rule_id,
      rule_version: r.winner.version,
    });
    const stale = {
      type: "rule.apply",
      id: randomUUID(),
      expected_revision: p.revision,
      entries: [apply(p.rows.find((r) => r.id === first.id)!)],
    };
    const party = await cmd({
      type: "party.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Acme",
      kind: "vendor",
      default_account_id: account(6),
      tax_classification: "corporation",
      documentation: "received",
      notes: "",
      is_archived: false,
    });
    await assert.rejects(cmd(stale), /ACCT_STALE_VERSION/);
    checks++;
    const alias = await cmd({
      type: "alias.save",
      id: randomUUID(),
      expected_version: 0,
      party_id: party.id,
      match_mode: "prefix",
      description: "acme",
      enabled: true,
    });
    const other = await cmd({
      type: "party.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Acme unrelated",
      kind: "vendor",
      default_account_id: null,
      tax_classification: "unreviewed",
      documentation: "missing",
      notes: "",
      is_archived: false,
    });
    const collision = await cmd({
      type: "alias.save",
      id: randomUUID(),
      expected_version: 0,
      party_id: other.id,
      match_mode: "exact",
      description: "acme hosting",
      enabled: true,
    });
    p = await preview();
    check(
      p.rows.find((r) => r.id === first.id)?.reason,
      "Conflicting payee aliases",
    );
    await cmd({
      type: "alias.save",
      id: collision.id,
      expected_version: collision.version,
      party_id: other.id,
      match_mode: "exact",
      description: "acme hosting",
      enabled: false,
    });
    let tie = await cmd({
      type: "rule.save",
      id: randomUUID(),
      expected_version: 0,
      ...ruleBase,
      name: "Overlapping rule",
    });
    tie = await activate(tie.id, tie.version);
    p = await preview();
    check(
      p.rows.find((r) => r.id === first.id)?.reason,
      "Rules share the winning priority",
    );
    await activate(tie.id, tie.version, false);
    p = await preview();
    const valid = apply(p.rows.find((r) => r.id === first.id)!);
    await assert.rejects(
      cmd({
        type: "rule.apply",
        id: randomUUID(),
        expected_revision: p.revision,
        entries: [valid, { ...valid, id: posted.id, expected_version: 2 }],
      }),
      /ACCT_RULE_INELIGIBLE/,
    );
    checks++;
    check(
      (await preview()).rows.find((r) => r.id === first.id)?.eligible,
      true,
    );
    p = await preview();
    const key = randomUUID(),
      operation = {
        type: "rule.apply",
        id: randomUUID(),
        expected_revision: p.revision,
        entries: p.rows.filter((r) => r.eligible).map(apply),
      };
    const applied = await cmd(operation, key);
    check(applied.count, 2);
    check(await cmd(operation, key), applied);
    p = await preview();
    check(p.rows.find((r) => r.id === first.id)?.eligible, false);
    check(p.rows.find((r) => r.id === first.id)?.bank_amount_cents, "-1999");
    check(
      p.rows
        .find((r) => r.id === second.id)
        ?.lines.some(
          (l) => l.account_id === account(6) && l.amount_cents === "2000",
        ),
      true,
    );
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<{ payee_id: string }>(
          "SELECT payee_id FROM acct_entry_context WHERE entry_id=$1",
          [first.id],
        )
      ).rows[0].payee_id,
      party.id,
    );
    check(
      (await db.query("SELECT * FROM acct_rule_applications")).rows.length,
      2,
    );
    check(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM acct_journal_entries WHERE id=$1",
          [first.id],
        )
      ).rows[0].status,
      "draft",
    );
    await assert.rejects(
      db.query("DELETE FROM acct_rule_versions"),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("SELECT acct_rules_view()"),
      /permission denied/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    const backup = (
      await db.query<{ r: { version: number; rule_applications: unknown[] } }>(
        "SELECT acct_books_backup() r",
      )
    ).rows[0].r;
    check(backup.version, 9);
    check(backup.rule_applications.length, 2);
    await assert.rejects(
      cmd({
        type: "rule.save",
        id: randomUUID(),
        expected_version: 0,
        ...ruleBase,
        min_cents: 0,
      }),
      /ACCT_INVALID_MONEY/,
    );
    checks++;
    const options: CsvOptions = {
      delimiter: ",",
      headerRow: 0,
      dateFormat: "yyyy-mm-dd",
      decimal: ".",
      thousands: "",
    };
    const table = readCsv(
      "id,date,memo,amount\nsource-invariant,2026-06-02,Source bank invariant,-88.99",
      options,
    );
    const groups = bankGroups(table, options, {
        date: "date",
        description: "memo",
        amount: "amount",
        externalId: "id",
        sign: "deposits_positive",
        accountId: account(1),
      }),
      batch = randomUUID(),
      group = randomUUID();
    await cmd({
      type: "import.create",
      id: batch,
      source_system: "csv",
      source_scope: "checking-test",
      file_hash: table.fileHash,
      mapping_hash: "a".repeat(64),
      file_name: "synthetic-bank.csv",
      mode: "bank",
      basis: "cash",
      expected_groups: 1,
      from: "2026-06-02",
      to: "2026-06-02",
    });
    await cmd({
      type: "import.stage",
      id: batch,
      expected_version: 1,
      groups: [{ ...groups[0], id: group, ordinal: 0 }],
    });
    await cmd({
      type: "import.apply",
      id: batch,
      expected_version: 2,
      group_ids: [group],
    });
    await db.exec("RESET ROLE");
    const imported = (
      await db.query<{ id: string; version: number }>(
        "SELECT e.id,e.version FROM acct_journal_entries e JOIN acct_import_groups g ON g.entry_id=e.id WHERE g.id=$1",
        [group],
      )
    ).rows[0];
    await db.exec("SET ROLE authenticated");
    const changed = {
      type: "draft.save",
      id: imported.id,
      expected_version: imported.version,
      entry_date: "2026-06-02",
      memo: "Source bank invariant",
      lines: [
        { account_id: account(1), amount_cents: "-9900" },
        { account_id: account(6), amount_cents: "9900" },
      ],
    };
    let saved = await cmd(changed);
    await assert.rejects(
      cmd({
        type: "entry.post",
        id: saved.id,
        expected_version: saved.version,
      }),
      /ACCT_BANK_SOURCE_CHANGED/,
    );
    checks++;
    saved = await cmd({
      ...changed,
      expected_version: saved.version,
      entry_date: "2026-06-03",
      lines: [
        { account_id: account(1), amount_cents: "-8899" },
        { account_id: account(6), amount_cents: "8899" },
      ],
    });
    await assert.rejects(
      cmd({
        type: "entry.post",
        id: saved.id,
        expected_version: saved.version,
      }),
      /ACCT_BANK_SOURCE_CHANGED/,
    );
    checks++;
    saved = await cmd({
      ...changed,
      expected_version: saved.version,
      lines: [
        { account_id: account(1), amount_cents: "-8899" },
        { account_id: account(6), amount_cents: "8899" },
      ],
    });
    await cmd({
      type: "entry.post",
      id: saved.id,
      expected_version: saved.version,
    });
    checks++;
    assert.ok(alias.id);
    console.log(
      `Rule previews, alias conflicts, atomic draft application, replay and history: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
