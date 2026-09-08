import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureEntries,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import type { JournalEntry } from "../src/lib/accounting/contracts";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const query = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, args)).rows[0].r;
  const cmd = (c: object, key = randomUUID()) =>
    query<{ id: string; version: number; reversal_id?: string }>(
      "SELECT accounting.operate($1::jsonb) r",
      [JSON.stringify({key,command:c})],
    );
  const rejects = async (c: object, pattern: RegExp) => {
    await assert.rejects(cmd(c), pattern);
    checks++;
  };
  try {
    const seed = {
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts,
    };
    const key = randomUUID();
    check(await cmd(seed, key), await cmd(seed, key));
    await rejects({ ...seed, id: randomUUID() }, /ACCT_CHART_EXISTS/);
    const checking = fixtureAccountId(1);
    const profile = {
      type: "account.update",
      id: checking,
      expected_version: 1,
      name: "Operating checking",
      code: "1000",
      cash_kind: "bank",
      is_archived: false,
    };
    check((await cmd(profile)).version, 2);
    await rejects(profile, /ACCT_STALE_VERSION/);
    await rejects(
      { ...profile, expected_version: 2, cash_kind: "card" },
      /ACCT_ACCOUNT_KIND/,
    );
    const ids: string[] = [];
    for (const e of fixtureEntries) {
      const id = randomUUID();
      ids.push(id);
      await cmd({
        type: "draft.save",
        id,
        expected_version: 0,
        entry_date: e.date,
        memo: e.memo,
        lines: e.lines.map(([n, c]) => ({
          account_id: fixtureAccountId(n),
          amount_cents: c,
          memo: "",
        })),
      });
      await cmd({ type: "entry.post", id, expected_version: 1 });
    }
    await rejects(
      { ...profile, expected_version: 2, cash_kind: "cash" },
      /ACCT_ACCOUNT_IN_USE/,
    );
    type Register = { entries: JournalEntry[]; total: number; offset: number };
    const first = await query<Register>("SELECT accounting.transactions($1) r", [
      JSON.stringify({ limit: 3 }),
    ]);
    const second = await query<Register>("SELECT accounting.transactions($1) r", [
      JSON.stringify({ limit: 3, offset: 3 }),
    ]);
    check(first.total, 11);
    check(first.entries.length, 3);
    check(
      first.entries.some((e) => second.entries.some((s) => s.id === e.id)),
      false,
    );
    check(
      (
        await query<Register>("SELECT accounting.transactions($1) r", [
          JSON.stringify({ query: "software" }),
        ])
      ).total,
      2,
    );
    const ledger = await query<{
      opening_cents: string;
      rows: { running_cents: string }[];
    }>("SELECT accounting.ledger($1,'2026-01-01','2026-02-28') r", [
      checking,
    ]);
    check(ledger.opening_cents, "1200000");
    check(ledger.rows.at(-1)?.running_cents, "1228000");
    const replacementId = randomUUID();
    const correction = {
      type: "entry.correct",
      id: ids[3],
      expected_version: 2,
      replacement_id: replacementId,
      entry_date: "2026-02-15",
      reason: "Correct purchase classification",
      memo: "Corrected purchase",
      lines: [
        { account_id: fixtureAccountId(6), amount_cents: "13000", memo: "" },
        { account_id: fixtureAccountId(3), amount_cents: "-13000", memo: "" },
      ],
    };
    const correctionKey = randomUUID();
    const corrected = await cmd(correction, correctionKey);
    check(await cmd(correction, correctionKey), corrected);
    check(corrected.id, replacementId);
    check(
      (
        await query<{ reports: { net_income_cents: string } }>(
          "SELECT accounting.workspace('2026-01-01','2026-02-28') r",
        )
      ).reports.net_income_cents,
      "74000",
    );
    await rejects(
      { ...correction, replacement_id: randomUUID() },
      /ACCT_ALREADY_REVERSED/,
    );
    // Invalid replacement rolls back the preceding reversal as one transaction.
    const failed = {
      ...correction,
      id: ids[4],
      replacement_id: randomUUID(),
      memo: "",
    };
    await rejects(failed, /check constraint/);
    check(
      (
        await query<Register>("SELECT accounting.transactions($1) r", [
          JSON.stringify({ entry_id: ids[4] }),
        ])
      ).entries[0].reversed_by_entry_id,
      null,
    );
    const noteId = randomUUID();
    await cmd({
      type: "entry.annotate",
      id: noteId,
      entry_id: ids[0],
      note: "Late evidence note",
    });
    const annotated=await query<{audit:{after:{note_id?:string}}[]}>("SELECT accounting.entry_detail($1) r",[ids[0]]);
    check(annotated.audit.some(a=>a.after?.note_id===noteId),true);
    const draftId = randomUUID();
    await cmd({
      type: "draft.save",
      id: draftId,
      expected_version: 0,
      entry_date: "2026-03-01",
      memo: "Context draft",
      lines: [],
    });
    check(
      (
        await cmd({
          type: "entry.context",
          id: draftId,
          expected_version: 1,
          kind: "expense",
        })
      ).version,
      2,
    );
    await rejects(
      {
        type: "entry.context",
        id: ids[0],
        expected_version: 3,
        kind: "expense",
      },
      /ACCT_POSTED_IMMUTABLE/,
    );
    const snapshotId = randomUUID();
    const payeeId = randomUUID();
    await cmd({
      type: "party.save",
      id: payeeId,
      expected_version: 0,
      name: "Fixture customer",
      kind: "customer",
    });
    const atomicId = randomUUID();
    const transaction = {
      type: "transaction.save",
      id: atomicId,
      expected_version: 0,
      entry_date: "2026-03-02",
      memo: "Atomic context save",
      lines: [],
      context: {
        kind: "expense",
        payee_id: payeeId,
      },
    };
    check((await cmd(transaction)).version, 1);
    check(
      (
        await query<Register>("SELECT accounting.transactions($1) r", [
          JSON.stringify({ payee: payeeId }),
        ])
      ).total,
      1,
    );
    const rollbackId = randomUUID();
    await rejects(
      { ...transaction, id: rollbackId, context: { payee_id: randomUUID() } },
      /foreign key/,
    );
    check(
      (
        await query<Register>("SELECT accounting.transactions($1) r", [
          JSON.stringify({ entry_id: rollbackId }),
        ])
      ).total,
      0,
    );
    const bulkId = randomUUID();
    await cmd({
      ...transaction,
      id: bulkId,
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "10", memo: "" },
        { account_id: fixtureAccountId(2), amount_cents: "-10", memo: "" },
      ],
    });
    await rejects(
      {
        type: "entry.bulkpost",
        id: randomUUID(),
        entries: [
          { id: bulkId, expected_version: 1 },
          { id: atomicId, expected_version: 1 },
        ],
      },
      /ACCT_UNBALANCED/,
    );
    check(
      (
        await query<Register>("SELECT accounting.transactions($1) r", [
          JSON.stringify({ entry_id: bulkId }),
        ])
      ).entries[0].status,
      "draft",
    );
    await cmd({
      type: "report.snapshot",
      id: snapshotId,
      from: "2026-01-01",
      to: "2026-02-28",
    });
    const snapshot = await query<{revision:string;payload:unknown}>("SELECT accounting.snapshot_read($1) r",[snapshotId]);
    check(typeof snapshot.revision,"string");check(!!snapshot.payload,true);
    const sourcePosted=randomUUID(),sourceDraft=randomUUID();
    const movement={type:'draft.save',expected_version:0,entry_date:'2026-04-01',memo:'Synthetic descriptor review',source_description:'POS SYNTHETIC SOFTWARE #98765',lines:[{account_id:checking,amount_cents:'-700'},{account_id:fixtureAccountId(6),amount_cents:'700'}]};
    await cmd({...movement,id:sourcePosted});await cmd({type:'entry.post',id:sourcePosted,expected_version:1});
    await cmd({...movement,id:sourceDraft,entry_date:'2026-04-02'});
    const suggestion=await query<JournalEntry>('SELECT accounting.entry_detail($1) r',[sourceDraft]);
    check(suggestion.source_description,'POS SYNTHETIC SOFTWARE #98765');check(suggestion.descriptor_key,'SYNTHETIC SOFTWARE');
    check(suggestion.prior_treatment,{count:1,last_category:fixtureAccountId(6),payee_id:null});
    const settings=await query<{preferences:{version:number;business_profile:{version:number}}}>("SELECT accounting.context('manage') r");
    const saveSettings={type:'settings.save',id:randomUUID(),expected_version:settings.preferences.version,profile_version:settings.preferences.business_profile.version,primary_system:'admin',business_profile:{legal_name:'Synthetic profile update',tax_classification:'s_corp'}};
    check((await cmd(saveSettings)).version,2);await rejects({...saveSettings,id:randomUUID()},/ACCT_STALE_VERSION/);
    check((await query<{legal_name:string}>("SELECT accounting.workspace('2026-01-01','2026-04-30') r")).legal_name,'Synthetic profile update');
    await rejects({...saveSettings,id:randomUUID(),expected_version:2,profile_version:0,primary_system:'wave'},/ACCT_STALE_VERSION/);
    const state=await query<{preferences:{primary_system:string}}>("SELECT accounting.context('manage') r");check(state.preferences.primary_system,'admin');
    const cashLine=suggestion.lines.find(l=>l.account_id===checking)!;
    const override={type:'cash.allocate',id:cashLine.id,expected_version:1,reason:'Synthetic cash override',allocations:[{classification:'operating',amount_cents:'-700',note:'Synthetic classification'}]};
    check((await cmd(override)).version,2);await rejects({...override,expected_version:2,allocations:[{classification:'operating',amount_cents:'-699'}]},/ACCT_INVALID_CASH_ALLOCATION/);
    const fileId=randomUUID();await cmd({type:'document.prepare',id:fileId,original_name:'synthetic-receipt.pdf',mime_type:'application/pdf',content_hash:'d'.repeat(64),size_bytes:'8'});
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",[fileId+'/'+'d'.repeat(64)]);
    await cmd({type:'document.link',id:fileId,expected_version:1,entry_id:sourceDraft});
    check((await query<{total:number}>("SELECT accounting.transactions($1) r",[JSON.stringify({entry_id:sourceDraft,missing_receipt:true})])).total,0);
    check((await query<{total:number}>("SELECT accounting.transactions($1) r",[JSON.stringify({entry_id:sourcePosted,missing_receipt:true})])).total,1);
    await db.exec("RESET ROLE;");
    await assert.rejects(
      db.query("DELETE FROM accounting.report_snapshots WHERE id=$1", [snapshotId]),
      /ACCT_IMMUTABLE_SNAPSHOT/,
    );
    checks++;
    await db.exec("SET ROLE anon;");
    await assert.rejects(
      db.query("SELECT accounting.transactions('{}')"),
      /permission denied/,
    );
    checks++;
    console.log(`Accounting workflows: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
