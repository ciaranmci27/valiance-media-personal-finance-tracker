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
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number; count?: number } }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
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
      }>("SELECT accounting.rules_preview(jsonb_build_object('from','2026-01-01','to','2026-12-31','rule_id',$1::uuid)) r", [id])
    ).rows[0].r;
  let uncategorized: string;
  const draft = async (
    memo: string,
    amount = "-1999",
    category = uncategorized,
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

      ],
    });
    await db.exec('RESET ROLE');
    uncategorized=(await db.query<{id:string}>("SELECT id FROM accounting.accounts WHERE system_purpose='uncategorized_expense'")).rows[0].id;
    await db.exec('SET ROLE authenticated');
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
    await assert.rejects(cmd(stale), /ACCT_STALE_REVISION/);
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
    const evidence = async () => (await db.query<{ value: { rules: { rule_name: string; rule_version: number; before_value: Candidate & { rule_id: string }; after_value: { lines: { amount_cents: string }[] } }[] } }>(
      "SELECT accounting.context('evidence', jsonb_build_object('id',$1::text)) value", [first.id],
    )).rows[0].value;
    const retained = (await evidence()).rules;
    check(retained.length, 1);
    check(retained[0].before_value.bank_amount_cents, "-1999");
    check(retained[0].after_value.lines.reduce((n, l) => n + BigInt(l.amount_cents), BigInt(0)), BigInt(0));
    await db.exec("RESET ROLE");
    await db.query("UPDATE accounting.rules SET name='Later synthetic name' WHERE id=$1", [retained[0].before_value.rule_id]);
    await db.exec("SET ROLE authenticated");
    check((await evidence()).rules, retained);
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
          "SELECT payee_id FROM accounting.journal_entries WHERE id=$1",
          [first.id],
        )
      ).rows[0].payee_id,
      party.id,
    );
    check(
      (await db.query("SELECT * FROM accounting.journal_entries WHERE applied_rule_id IS NOT NULL")).rows.length,
      2,
    );
    check(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM accounting.journal_entries WHERE id=$1",
          [first.id],
        )
      ).rows[0].status,
      "draft",
    );
    await assert.rejects(
      db.query("DELETE FROM accounting.audit_log"),
      /ACCT_APPEND_ONLY/,
    );
    checks++;
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("SELECT accounting.rules_preview()"),
      /permission denied/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    // Per-feature backup/version tables were removed. Applied rule IDs and the append-only audit retain the history.
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
    // The bank-import source invariants are tracked in the Phase 1 log for step 4,
    // after import.stage/import.apply exist. The same guards are exercised by verify-accounting-banking now.
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
