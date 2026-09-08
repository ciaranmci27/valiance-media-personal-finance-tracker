import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureOwner,
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  try {
    const cmd = async (c: any, key = randomUUID()) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key, command: c }),
        ])
      ).rows[0].r;
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind:
          a.id === fixtureAccountId(1)
            ? "bank"
            : a.id === fixtureAccountId(3)
              ? "card"
              : "none",
      });
    for (const e of fixtureEntries) {
      const id = randomUUID();
      const s = await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: e.date,
        memo: e.memo,
        lines: e.lines.map(([a, m]) => ({
          account_id: fixtureAccountId(Number(a)),
          amount_cents: m,
        })),
      });
      await cmd({ type: "entry.post", id, expected_version: s.version });
      n++;
    }

    await db.exec("RESET ROLE");
    const totals = (
      await db.query<any>(`SELECT
 coalesce(sum(l.amount_cents) FILTER (WHERE a.type='asset'),0)::text assets,
 (-coalesce(sum(l.amount_cents) FILTER (WHERE a.type='liability'),0))::text liabilities,
 (-coalesce(sum(l.amount_cents) FILTER (WHERE a.type='equity'),0))::text equity,
 (-coalesce(sum(l.amount_cents) FILTER (WHERE a.type IN ('income','expense') AND e.entry_date>='2026-01-01'),0))::text net,
 (-coalesce(sum(l.amount_cents) FILTER (WHERE a.type IN ('income','expense') AND e.entry_date<'2026-01-01'),0))::text retained
 FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id JOIN accounting.accounts a ON a.id=l.account_id
 WHERE e.status='posted' AND e.entry_date<='2026-02-28'`)
    ).rows[0];
    assert.deepEqual(totals, {
      assets: "1278000",
      liabilities: "3000",
      equity: "1000000",
      net: "75000",
      retained: "200000",
    });
    n++;
    await db.exec("SET ROLE authenticated");

    const tests = [
      ["POS ACME DEBIT PURCHASE #12345", "ACME"],
      ["RECURRING EXAMPLE*1234 CHARGE", "EXAMPLE"],
      ["PAYMENT OAK STUDIO 09/07/2026", "OAK STUDIO"],
      ["ACH MAPLE 2026-09-07", "MAPLE"],
      ["CARD PINE 07.09.2026", "PINE"],
      ["CREDIT NOVA JANUARY 2, 2026", "NOVA"],
      ["DEBIT ORBIT 2 JAN 2026", "ORBIT"],
      ["  ACME   LABS 12345678  ", "ACME LABS"],
      ["STUDIO 54 #12", "STUDIO 54"],
      ["POS CREDIT UNION PAYMENT", "UNION"],
    ];
    for (const [raw, want] of tests) {
      const got = (
        await db.query<{ r: string }>(
          "SELECT accounting.descriptor_key($1) r",
          [raw],
        )
      ).rows[0].r;
      assert.equal(got, want, raw);
      n++;
    }
    const id = randomUUID();
    const c = {
      type: "transaction.review",
      id,
      expected_version: 0,
      entry_date: "2026-06-01",
      memo: "test",
      context: { kind: "expense" },
      lines: [
        { account_id: fixtureAccountId(3), amount_cents: "-4275" },
        { account_id: fixtureAccountId(6), amount_cents: "4275" },
      ],
    };
    const key = randomUUID();
    const saved = await cmd(c, key);
    assert.deepEqual(await cmd(c, key), saved);
    n++;
    await assert.rejects(
      cmd({ ...c, memo: "changed" }, key),
      /ACCT_IDEMPOTENCY_CONFLICT/,
    );
    n++;
    const detail = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id])
    ).rows[0].r;
    assert.equal(detail.status, "posted");
    n++;
    const reversed = await cmd({
      type: "entry.reverse",
      id,
      expected_version: saved.version,
      entry_date: "2026-06-01",
      reason: "synthetic correction",
    });
    assert.ok(reversed.id);
    n++;
    const draft = await cmd({
      ...c,
      type: "transaction.save",
      id: randomUUID(),
    });
    const split = await cmd({
      type: "entry.split",
      id: draft.id,
      expected_version: draft.version,
      splits: [
        { account_id: fixtureAccountId(6), share_bps: 5000 },
        { account_id: fixtureAccountId(7), share_bps: 5000 },
      ],
    });
    const splitDetail = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
        draft.id,
      ])
    ).rows[0].r;
    assert.deepEqual(
      splitDetail.lines.map((x: any) => x.amount_cents),
      ["-4275", "2138", "2137"],
    );
    n++;
    await cmd({
      type: "entry.post",
      id: draft.id,
      expected_version: split.version,
    });

    const rejects = async (p: Promise<unknown>, pattern: RegExp) => {
      await assert.rejects(p, pattern);
      n++;
    };
    await rejects(
      cmd({
        type: "entry.reverse",
        id: draft.id,
        expected_version: split.version + 1,
        entry_date: "2026-05-01",
        reason: "invalid earlier reversal",
      }),
      /ACCT_INVALID_REVERSAL_DATE/,
    );
    const unbalanced = await cmd({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-07-01",
      memo: "Unbalanced",
      lines: [{ account_id: fixtureAccountId(1), amount_cents: "100" }],
    });
    await rejects(
      cmd({
        type: "entry.post",
        id: unbalanced.id,
        expected_version: unbalanced.version,
      }),
      /ACCT_UNBALANCED/,
    );
    await rejects(
      cmd({
        type: "draft.save",
        id: unbalanced.id,
        expected_version: 99,
        entry_date: "2026-07-01",
        memo: "stale",
        lines: [],
      }),
      /ACCT_STALE_VERSION/,
    );
    await rejects(
      db.query("SELECT * FROM accounting.journal_lines"),
      /permission denied/,
    );
    await rejects(
      db.query("SELECT accounting.ledger_command($1)", [JSON.stringify(c)]),
      /permission denied/,
    );
    await rejects(
      db.query("SELECT accounting.require_open($1)", ["2026-07-01"]),
      /permission denied/,
    );
    await db.query(
      "SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false)",
    );
    await rejects(cmd(c), /ACCT_FORBIDDEN/);
    await rejects(
      db.query("SELECT accounting.transactions()"),
      /ACCT_FORBIDDEN/,
    );
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
    await db.exec("RESET ROLE");
    await rejects(
      db.query(
        "UPDATE accounting.journal_lines SET amount_cents=amount_cents+1 WHERE entry_id=$1",
        [id],
      ),
      /ACCT_IMMUTABLE/,
    );
    await rejects(
      db.query("DELETE FROM accounting.journal_lines WHERE entry_id=$1", [id]),
      /ACCT_IMMUTABLE/,
    );
    await rejects(
      db.query(
        "UPDATE accounting.journal_entries SET entry_date='2026-05-01' WHERE id=$1",
        [id],
      ),
      /ACCT_POSTED_IMMUTABLE/,
    );
    await rejects(
      db.query(
        "UPDATE accounting.journal_entries SET source_description='changed' WHERE id=$1",
        [id],
      ),
      /ACCT_IMMUTABLE_PROVENANCE/,
    );
    await rejects(
      db.query(
        "UPDATE accounting.journal_entries SET status='posted',posted_at=now() WHERE id=$1",
        [unbalanced.id],
      ),
      /ACCT_UNBALANCED/,
    );
    await rejects(
      db.query("DELETE FROM accounting.audit_log"),
      /ACCT_APPEND_ONLY/,
    );
    await rejects(
      db.query("DELETE FROM accounting.journal_entries WHERE id=$1", [
        unbalanced.id,
      ]),
      /ACCT_NO_HARD_DELETE/,
    );
    await rejects(
      db.query(
        "UPDATE accounting.periods SET status='locked',locked_at=now() WHERE month='2026-07-01'",
      ),
      /ACCT_DRAFTS_REMAIN/,
    );
    await db.query(
      "UPDATE accounting.periods SET status='locked',locked_at=now() WHERE month='2026-06-01'",
    );
    await db.exec("SET ROLE authenticated");
    await rejects(cmd({ ...c, id: randomUUID() }), /ACCT_PERIOD_LOCKED/);
    await rejects(
      cmd({ ...c, id: randomUUID(), entry_date: "2026-05-01" }),
      /ACCT_LATER_PERIOD_LOCKED/,
    );
    const postedDetail = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id])
    ).rows[0].r;
    await cmd({
      type: "entry.context",
      id,
      expected_version: postedDetail.version,
      memo: "Renamed while locked",
    });
    assert.equal(
      (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
        .rows[0].r.memo,
      "Renamed while locked",
    );
    n++;
    await db.exec("RESET ROLE; SET ROLE service_role");
    await rejects(
      db.query("SELECT accounting.operate($1)", [
        JSON.stringify({ key: randomUUID(), command: c }),
      ]),
      /permission denied/,
    );
    await rejects(
      db.query("DELETE FROM accounting.journal_lines"),
      /permission denied/,
    );
    await db.exec("RESET ROLE");
    const counts = (
      await db.query<{ n: number }>(
        "SELECT count(*)::int n FROM pg_class WHERE relnamespace='accounting'::regnamespace AND relkind='r' AND relname IN ('settings','accounts','journal_entries','journal_lines','periods','audit_log','command_receipts')",
      )
    ).rows[0].n;
    assert.equal(counts, 7);
    n++;

    // Catalog search_path spelling varies; independently require the empty setting on every function.
    const funcs = (
      await db.query<{ prosecdef: boolean; proconfig: string[] }>(
        "SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace='accounting'::regnamespace",
      )
    ).rows;
    assert.ok(
      funcs.every(
        (f) =>
          f.prosecdef &&
          f.proconfig.some(
            (v) => v === 'search_path=\"\"' || v === "search_path=",
          ),
      ),
    );
    n++;
    console.log(
      `Ledger core: ${n} checks passed, including descriptor normalization, exact balances, posting guards and permissions.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where);
  process.exitCode = 1;
});
