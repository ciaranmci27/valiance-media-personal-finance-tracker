import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  try {
    const cmd = async (c: any) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key: randomUUID(), command: c }),
        ])
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind:
          a.id === fixtureAccountId(1) || a.id === fixtureAccountId(9)
            ? "bank"
            : a.id === fixtureAccountId(3)
              ? "card"
              : "none",
      });
    const connection = randomUUID(),
      bank = randomUUID(),
      providerKey = JSON.stringify(["synthetic", "checking"]).replace(
        ",",
        ", ",
      );
    await cmd({
      type: "feed.claim",
      id: connection,
      name: "Synthetic bank",
      access_url_encrypted: "encrypted-fixture-not-a-secret-value",
      expected_version: 0,
    });
    await cmd({
      type: "feed.map",
      id: bank,
      expected_version: 0,
      account_id: fixtureAccountId(1),
      connection_id: connection,
      provider_account_id: providerKey,
      coverage_from: "2026-01-01",
      movement_sign: 1,
    });
    const sync = async (txs: any[]) => {
      await db.exec("RESET ROLE; SET ROLE service_role");
      const run = randomUUID();
      const call = async (c: any) =>
        (
          await db.query<{ r: any }>("SELECT accounting.sync_server($1) r", [
            JSON.stringify({ id: connection, run_id: run, ...c }),
          ])
        ).rows[0].r;
      const lease = await call({ action: "lease" });
      assert.equal(lease.acquired, true);
      n++;
      const result = await call({
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
            balance_at: Date.parse("2026-09-07T18:00:00Z") / 1000,
            complete: true,
            transactions: txs,
          },
        ],
      });
      await db.exec("RESET ROLE; SET ROLE authenticated");
      return result;
    };
    const tx = {
      external_id: "SYN-1",
      posted: Date.parse("2026-09-07T18:00:00Z") / 1000,
      amount_cents: "-1234",
      description: "POS SYNTHETIC SOFTWARE #12345",
      state: "posted",
      hash: "a".repeat(64),
      raw: { synthetic: true },
    };
    const first = await sync([tx]);
    assert.equal(first.drafts, 1);
    assert.equal(first.new, 1);
    n += 2;
    assert.equal((await sync([tx])).new, 0);
    n++;
    const rows = (
      await db.query<{ r: any }>("SELECT accounting.transactions() r")
    ).rows[0].r.entries;
    assert.equal(rows.length, 1);
    n++;
    let e = rows[0];
    assert.equal(e.source_description, tx.description);
    assert.equal(e.descriptor_key, "SYNTHETIC SOFTWARE");
    n += 2;
    const lineId = e.lines[0].id;
    const reviewed = await cmd({
      type: "transaction.review",
      id: e.id,
      expected_version: e.version,
      entry_date: e.entry_date,
      memo: "Renamed software",
      context: { kind: "expense" },
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "-1234" },
        { account_id: fixtureAccountId(6), amount_cents: "1234" },
      ],
    });
    e = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
        reviewed.id,
      ])
    ).rows[0].r;
    assert.equal(
      e.lines.find((l: any) => l.account_id === fixtureAccountId(1)).id,
      lineId,
    );
    assert.equal(e.matches.length, 1);
    n += 2;
    const second = await sync([
      {
        ...tx,
        external_id: "SYN-2",
        posted: tx.posted + 86400,
        hash: "b".repeat(64),
      },
    ]);
    assert.equal(second.drafts, 1);
    n++;
    const pending = (
      await db.query<{ r: any }>("SELECT accounting.transactions($1) r", [
        JSON.stringify({ status: "draft" }),
      ])
    ).rows[0].r.entries[0];
    assert.equal(pending.memo, "Renamed software");
    assert.ok(
      pending.lines.some((l: any) => l.account_id === fixtureAccountId(6)),
    );
    n += 2;
    await cmd({
      type: "draft.discard",
      id: pending.id,
      expected_version: pending.version,
      reason: "Synthetic duplicate candidate",
    });
    await db.exec("RESET ROLE");
    assert.equal(
      (
        await db.query<Record<string, unknown>>(
          "SELECT review FROM accounting.bank_transactions WHERE external_id='SYN-2'",
        )
      ).rows[0].review,
      "unmatched",
    );
    n++;
    const actors = (
      await db.query<Record<string, unknown>>(
        "SELECT DISTINCT actor_kind,actor_user_id FROM accounting.audit_log WHERE table_name='bank_transactions' AND action='sync'",
      )
    ).rows;
    assert.deepEqual(actors, [{ actor_kind: "worker", actor_user_id: null }]);
    n++;
    await db.exec("SET ROLE authenticated");
    const transfer = await cmd({
      type: "transfer.create",
      id: randomUUID(),
      from_account_id: fixtureAccountId(1),
      to_account_id: fixtureAccountId(3),
      amount_cents: "10001",
      memo: "Synthetic card payment",
      outgoing_date: "2026-09-10",
      incoming_date: "2026-09-11",
    });
    assert.notEqual(transfer.outgoing_entry_id, transfer.incoming_entry_id);
    n++;
    const party = await cmd({
      type: "party.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Synthetic contractor",
      kind: "vendor",
      is_contractor: true,
    });
    assert.equal(party.version, 1);
    n++;
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic.pdf",
      mime_type: "application/pdf",
      content_hash: "c".repeat(64),
      size_bytes: "8",
    });
    await db.query<Record<string, unknown>>(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.id + "/" + "c".repeat(64)],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    const linked = await cmd({
      type: "document.link",
      id: doc.id,
      expected_version: doc.version + 1,
      entry_id: e.id,
    });
    assert.equal(linked.version, 3);
    n++;

    const rule = await cmd({
      type: "rule.save",
      id: randomUUID(),
      expected_version: 0,
      name: "Synthetic split",
      priority: 1,
      enabled: true,
      auto_post: true,
      conditions: { descriptor_key: { equals: "SYNTHETIC SOFTWARE" } },
      actions: {
        splits: [
          { account_id: fixtureAccountId(6), share_bps: 3333 },
          { account_id: fixtureAccountId(7), share_bps: 6667 },
        ],
        memo: "Rule label",
      },
    });
    await cmd({
      type: "alias.save",
      id: randomUUID(),
      expected_version: 0,
      party_id: party.id,
      match_kind: "key",
      pattern: "SYNTHETIC SOFTWARE",
      enabled: true,
    });
    const ruled = await sync([
      {
        ...tx,
        external_id: "SYN-RULE",
        posted: tx.posted + 2 * 86400,
        hash: "d".repeat(64),
      },
    ]);
    assert.equal(ruled.drafts, 1);
    n++;
    const ruledEntry = (
      await db.query<{ r: any }>("SELECT accounting.transactions($1) r", [
        JSON.stringify({ status: "draft" }),
      ])
    ).rows[0].r.entries[0];
    assert.equal(ruledEntry.memo, "Rule label");
    assert.equal(ruledEntry.applied_rule_id, rule.id);
    assert.equal(ruledEntry.payee_id, party.id);
    assert.equal(ruledEntry.status, "draft");
    n += 4;
    assert.deepEqual(
      ruledEntry.lines.map((l: any) => l.amount_cents),
      ["-1234", "411", "823"],
    );
    n++;
    await db.exec("RESET ROLE");
    const csv = randomUUID();
    await db.query<Record<string, unknown>>(
      `INSERT INTO accounting.bank_transactions(id,bank_account_id,source,external_id,posted_date,amount_cents,description,descriptor_key,content_hash,raw_payload,state) VALUES($1,$2,'csv','SYN-CSV','2026-09-07',-1234,'Synthetic duplicate','',repeat('e',64),'{}','posted')`,
      [csv, bank],
    );
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "bank.match",
      id: randomUUID(),
      bank_transaction_id: csv,
      reason: "Independent source corroboration",
      allocations: [{ line_id: lineId, amount_cents: "0" }],
    });
    const evidence = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [e.id])
    ).rows[0].r;
    assert.equal(evidence.matches.length, 2);
    assert.equal(
      evidence.matches.reduce(
        (sum: bigint, m: any) => sum + BigInt(m.amount_cents),
        BigInt("0"),
      ),
      BigInt("1234"),
    );
    n += 2;
    const conflict = await sync([
      { ...tx, amount_cents: "-2345", hash: "f".repeat(64) },
    ]);
    assert.equal(conflict.conflicts, 1);
    assert.equal(conflict.new, 0);
    n += 2;
    await db.exec("RESET ROLE");
    assert.equal(
      (
        await db.query<Record<string, unknown>>(
          "SELECT amount_cents::text n FROM accounting.bank_transactions WHERE external_id='SYN-1'",
        )
      ).rows[0].n,
      "-1234",
    );
    n++;
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "UPDATE accounting.bank_transactions SET amount_cents=-999 WHERE id=$1",
        [csv],
      ),
      /ACCT_IMMUTABLE_EVIDENCE/,
    );
    n++;
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      db.query<Record<string, unknown>>("SELECT accounting.sync_server($1)", [
        JSON.stringify({ id: connection, action: "lease" }),
      ]),
      /permission denied/,
    );
    n++;

    const leg = async (date: string, lines: any[]) => {
      const d = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "Synthetic transfer leg",
        lines,
      });
      return cmd({ type: "entry.post", id: d.id, expected_version: d.version });
    };
    await db.exec("RESET ROLE");
    const transit = (
      await db.query<Record<string, unknown>>(
        "SELECT id FROM accounting.accounts WHERE system_purpose='transfers_in_transit'",
      )
    ).rows[0].id;
    await db.exec("SET ROLE authenticated");
    const out = await leg("2026-10-01", [
      { account_id: fixtureAccountId(1), amount_cents: "-2000" },
      { account_id: transit, amount_cents: "2000" },
    ]);
    const inc = await leg("2026-10-03", [
      { account_id: transit, amount_cents: "-2000" },
      { account_id: fixtureAccountId(3), amount_cents: "2000" },
    ]);
    const group = await cmd({
      type: "transfer.link",
      id: randomUUID(),
      outgoing_entry_id: out.id,
      incoming_entry_id: inc.id,
      from_account_id: fixtureAccountId(1),
      to_account_id: fixtureAccountId(3),
      amount_cents: "2000",
      memo: "Synthetic linked legs",
    });
    assert.equal(
      (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          out.id,
        ])
      ).rows[0].r.transfer_group_id,
      group.id,
    );
    n++;
    await assert.rejects(
      cmd({
        type: "transfer.link",
        id: randomUUID(),
        outgoing_entry_id: out.id,
        incoming_entry_id: inc.id,
        from_account_id: fixtureAccountId(1),
        to_account_id: fixtureAccountId(3),
        amount_cents: "2000",
      }),
      /ACCT_TRANSFER_ALREADY_LINKED_OR_UNPOSTED/,
    );
    n++;
    await assert.rejects(
      cmd({
        type: "entry.reverse",
        id: out.id,
        expected_version: (
          await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
            out.id,
          ])
        ).rows[0].r.version,
        entry_date: "2026-10-04",
        reason: "Refuse single transfer leg",
      }),
      /ACCT_TRANSFER_REVERSE_TOGETHER/,
    );
    n++;
    await cmd({
      type: "transfer.reverse",
      id: group.id,
      outgoing_date: "2026-10-04",
      incoming_date: "2026-10-04",
      reason: "Synthetic reversal",
    });
    assert.ok(
      (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          out.id,
        ])
      ).rows[0].r.reversed_by_entry_id,
    );
    n++;
    await assert.rejects(
      cmd({
        type: "transfer.reverse",
        id: randomUUID(),
        outgoing_date: "2026-10-04",
        incoming_date: "2026-10-04",
        reason: "Missing group",
      }),
      /ACCT_NOT_FOUND/,
    );
    n++;
    await assert.rejects(
      cmd({
        type: "rule.save",
        id: randomUUID(),
        expected_version: 0,
        name: "Invalid split",
        conditions: { descriptor_key: { equals: "X" } },
        actions: {
          splits: [
            { account_id: fixtureAccountId(6), share_bps: 1 },
            { account_id: fixtureAccountId(7), share_bps: 1 },
          ],
        },
      }),
      /ACCT_INVALID_RULE/,
    );
    n++;
    await sync([
      {
        ...tx,
        external_id: "SYN-TRANSFER",
        amount_cents: "-5500",
        posted: Date.parse("2026-10-07T18:00:00Z") / 1000,
        hash: "1".repeat(64),
        description: "Synthetic transfer",
      },
    ]);
    const matchedTransfer = await cmd({
      type: "transfer.create",
      id: randomUUID(),
      from_account_id: fixtureAccountId(1),
      to_account_id: fixtureAccountId(3),
      amount_cents: "5500",
      memo: "Synthetic mapped transfer",
      outgoing_date: "2026-10-07",
      incoming_date: "2026-10-09",
    });
    assert.equal(
      (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          matchedTransfer.outgoing_entry_id,
        ])
      ).rows[0].r.matches.length,
      1,
    );
    n++;
    const discovered = randomUUID();
    await db.exec("RESET ROLE");
    await db.query<Record<string, unknown>>(
      "UPDATE accounting.bank_connections SET checkpoint=jsonb_set(checkpoint,'{discovery}',$2) WHERE id=$1",
      [
        connection,
        JSON.stringify({
          [discovered]: {
            provider_account_id: "synthetic-discovery",
            institution: "Synthetic bank",
          },
        }),
      ],
    );
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "feed.map",
      id: discovered,
      account_id: fixtureAccountId(9),
      expected_version: 0,
      ownership: "company",
    });
    await db.exec("RESET ROLE");
    assert.deepEqual(
      (
        await db.query<Record<string, unknown>>(
          "SELECT connection_id,provider_account_id FROM accounting.bank_accounts WHERE id=$1",
          [discovered],
        )
      ).rows[0],
      { connection_id: connection, provider_account_id: "synthetic-discovery" },
    );
    n++;
    await db.exec("SET ROLE authenticated");
    console.log(
      "Banking, matching, rules and worker isolation:",
      n,
      "checks passed",
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
