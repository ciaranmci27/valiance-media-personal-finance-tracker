import assert from "node:assert/strict";
import { booksToday } from "../src/components/features/accounting/format";
import { correctionImpact } from "../src/lib/accounting/correction-impact";
import { AccountingRetryKeys } from "../src/lib/accounting/retry-keys";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { parsePatriot } from "../src/lib/accounting/patriot-import";
import { patriotItems } from "../src/lib/accounting/server/patriot-payload";
import {
  isTransactionReversed,
  canRestoreTransaction,
} from "../src/lib/accounting/transactions";

async function verify(source: "canonical" | "migrations") {
  const db = await accountingTestDb(source);
  const inspect = async (query: string, params: any[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return await db.query<any>(query, params);
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const cmd = async (command: object, key: string = randomUUID()) =>
    (
      await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key, command }),
      ])
    ).rows[0].r;
  const detail = async (id: string) =>
    (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
      .rows[0].r;
  const list = async (status = "all") =>
    (
      await db.query<{ r: any }>("SELECT accounting.transactions($1) r", [
        JSON.stringify({ status }),
      ])
    ).rows[0].r;
  const call = async (request: object) =>
    (
      await db.query<{ r: any[] }>("SELECT accounting.patriot_import($1) r", [
        JSON.stringify(request),
      ])
    ).rows[0].r;
  try {
    const ac = (await inspect("SELECT id,name FROM accounting.accounts")).rows;
    const bank = ac.find((a) => a.name === "Business checking")!.id;
    const income = ac.find((a) => a.name === "Service revenue")!.id;
    const post = async (date: string, memo: string, lines: object[]) => {
      const draft = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo,
        lines,
      });
      return cmd({
        type: "entry.post",
        id: draft.id,
        expected_version: draft.version,
      });
    };
    const original = await post("2026-09-01", "Lifecycle receipt", [
      { account_id: bank, amount_cents: "10000" },
      { account_id: income, amount_cents: "-10000" },
    ]);
    // Seed source evidence only; actual matching and all financial changes use owner commands.
    await db.exec("RESET ROLE");
    const ba = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.bank_accounts(account_id) VALUES($1) RETURNING id",
        [bank],
      )
    ).rows[0].id;
    const observation = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,amount_cents,description,content_hash,raw_payload,state) VALUES($1,'simplefin','lifecycle-source','2026-09-01',10000,'Lifecycle receipt',$2,'{}','posted') RETURNING id",
        [ba, "a".repeat(64)],
      )
    ).rows[0].id;
    await db.exec("SET ROLE authenticated");
    await cmd({
      type: "bank.match",
      id: randomUUID(),
      bank_transaction_id: observation,
      allocations: [
        {
          line_id: (await detail(original.id)).lines.find(
            (l: any) => l.account_id === bank,
          ).id,
          amount_cents: "10000",
        },
      ],
      reason: "Fixture match",
    });
    const reverseCommand = {
      type: "entry.reverse",
      id: original.id,
      expected_version: (await detail(original.id)).version,
      entry_date: "2026-09-02",
      reason: "Test reversal",
    };
    await assert.rejects(
      async () =>
        cmd({
          ...reverseCommand,
          type: "entry.correct",
          replacement_id: randomUUID(),
          reversal_date: "2026-09-01",
          memo: "Matched correction",
          lines: (await detail(original.id)).lines,
        }),
      /ACCT_CORRECTION_LINKED/,
    );
    assert.equal(
      (await detail(original.id)).matches.length,
      1,
      "blocked correction keeps bank matches",
    );
    const key = randomUUID();
    const reversal = await cmd(reverseCommand, key);
    assert.deepEqual(
      await cmd(reverseCommand, key),
      reversal,
      "idempotent reversal",
    );
    assert.equal(
      (await list()).entries.length,
      0,
      "both sides hidden from main view",
    );
    assert.equal(
      (await list("reversed")).entries.length,
      1,
      "one original per reversal in history",
    );
    const history = await list("reversed");
    assert.equal(history.total, 1, "pagination counts originals only");
    assert.equal(history.entries[0].id, original.id);
    assert.equal(history.entries[0].reversed_by_entry_id, reversal.id);
    assert.equal(
      (await detail(reversal.id)).reverses_entry_id,
      original.id,
      "offsetting entry remains accessible in details",
    );
    assert.equal(booksToday(new Date("2026-09-12T01:00:00Z")), "2026-09-11");
    assert.equal(booksToday(new Date("2026-09-12T08:00:00Z")), "2026-09-12");
    assert.ok(isTransactionReversed(await detail(original.id)));
    assert.ok(canRestoreTransaction(await detail(original.id)));
    assert.equal(
      (
        await inspect(
          "SELECT review FROM accounting.bank_transactions WHERE id=$1",
          [observation],
        )
      ).rows[0].review,
      "excluded",
      "bank evidence stays suppressed",
    );
    const restore = {
      type: "entry.restore",
      id: original.id,
      expected_version: (await detail(original.id)).version,
      entry_date: "2026-09-02",
      reason: "Restore test",
    };
    await assert.rejects(
      () => cmd({ ...restore, entry_date: "2026-09-01" }),
      /ACCT_RESTORE_DATE/,
    );
    const restored = await cmd(restore);
    assert.equal((await list()).entries[0].id, restored.id);
    assert.equal(
      (await detail(restored.id)).matches[0].bank_transaction_id,
      observation,
    );
    assert.equal((await detail(original.id)).restored_by_entry_id, restored.id);
    assert.equal(canRestoreTransaction(await detail(original.id)), false);
    await assert.rejects(() => cmd(restore), /ACCT_RESTORE_UNAVAILABLE/);
    assert.equal(
      (
        await inspect(
          "SELECT sum(l.amount_cents)::text n FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE account_id=$1 AND status='posted'",
          [bank],
        )
      ).rows[0].n,
      "10000",
    );
    await cmd({
      type: "entry.reverse",
      id: restored.id,
      expected_version: (await detail(restored.id)).version,
      entry_date: "2026-09-03",
      reason: "Second reversal",
    });
    const twice = await cmd({
      type: "entry.restore",
      id: restored.id,
      expected_version: (await detail(restored.id)).version,
      entry_date: "2026-09-03",
      reason: "Second restoration",
    });
    assert.equal(
      (await list()).entries[0].id,
      twice.id,
      "restoration chains remain usable",
    );
    await db.exec(
      "RESET ROLE; UPDATE accounting.periods SET status='locked',locked_at=now() WHERE month='2026-09-01'; SET ROLE authenticated",
    );
    await assert.rejects(
      () =>
        cmd({
          type: "entry.reverse",
          id: twice.id,
          expected_version: twice.version,
          entry_date: "2026-09-04",
          reason: "Locked period test",
        }),
      /ACCT_PERIOD_LOCKED/,
    );
    await db.exec(
      "RESET ROLE; SELECT set_config('accounting.reason','Fixture reopen',false); UPDATE accounting.periods SET status='open',locked_at=NULL,reopen_reason='Fixture reopen' WHERE month='2026-09-01'; SET ROLE authenticated",
    );
    // Reports retain the original effect before the reversal date.
    assert.equal(
      (
        await inspect(
          "SELECT sum(l.amount_cents)::text n FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id=l.entry_id WHERE account_id=$1 AND status='posted' AND entry_date='2026-09-01'",
          [bank],
        )
      ).rows[0].n,
      "10000",
    );
    const mapping = {
      wages: randomUUID(),
      employer_tax: randomUUID(),
      net_pay: randomUUID(),
      tax_payable: randomUUID(),
      officers: ["Sample"],
    };
    for (const name of [
      "wages",
      "employer_tax",
      "net_pay",
      "tax_payable",
    ] as const)
      await cmd({
        type: "account.create",
        id: mapping[name],
        name,
        account_type:
          name === "wages" || name === "employer_tax" ? "expense" : "liability",
        subtype:
          name === "wages" || name === "employer_tax"
            ? "payroll_expense"
            : "payroll_liability",
      });
    const report = parsePatriot(
      "Company Name: Example\nCompany ID: TEST\nEmployee: Sample\nGroup By: Check\n\nPay Date,Transaction Date,Pay Period,Source,Paycheck #,Location Name,Regular,Gross Pay,Federal Income Tax,Medicare,Social Security,Net Pay,Employer Medicare Tax,Employer Social Security\n9/1/2026,8/31/2026,8/1/2026 - 8/31/2026,Paycheck,,Office,2000,2000,100,29,124,1747,29,124",
    );
    const items = patriotItems(report, mapping);
    const doc = await cmd({
      type: "document.prepare",
      id: randomUUID(),
      original_name: "synthetic.csv",
      mime_type: "text/csv",
      size_bytes: "200",
      content_hash: "b".repeat(64),
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await cmd({
      type: "document.complete",
      id: doc.id,
      expected_version: doc.version,
    });
    const base = {
      company_id: report.company_id,
      company_name: report.company_name,
      mapping,
      document_id: doc.id,
      content_hash: "b".repeat(64),
      items,
    };
    const created = (
      await call({
        ...base,
        mode: "commit",
        items: items.map((i) => ({ ...i, choice: "new" })),
      })
    )[0];
    const run = async (id: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.payroll($1) r", [
          JSON.stringify({ id, view: "detail" }),
        ])
      ).rows[0].r;
    assert.equal((await run(created.run_id)).import_mode, "created");
    const undo = {
      type: "payroll.import.undo",
      id: created.run_id,
      expected_version: (await run(created.run_id)).version,
      effective_date: "2026-09-01",
      reason: "Reset import",
    };
    const undoKey = randomUUID();
    const undone = await cmd(undo, undoKey);
    assert.deepEqual(await cmd(undo, undoKey), undone);
    assert.equal(
      (await call({ ...base, mode: "preview" }))[0].state,
      "new",
      "undo permits reimport",
    );
    assert.equal((await run(created.run_id)).import_undone, true);
    assert.equal(
      (await detail(created.entry_id)).restore_workflow,
      "payroll",
      "payroll restores use reimport rather than bypassing the register",
    );
    const manual = await post("2026-09-01", "Payroll manual journal", [
      { account_id: mapping.wages, amount_cents: "200000" },
      { account_id: mapping.employer_tax, amount_cents: "15300" },
      { account_id: mapping.net_pay, amount_cents: "-174700" },
      { account_id: mapping.tax_payable, amount_cents: "-40600" },
    ]);
    assert.equal((await call({ ...base, mode: "preview" }))[0].state, "match");
    const linked = (
      await call({
        ...base,
        mode: "commit",
        items: items.map((i) => ({ ...i, choice: manual.id })),
      })
    )[0];
    assert.equal((await run(linked.run_id)).import_mode, "linked");
    await cmd({
      type: "payroll.import.undo",
      id: linked.run_id,
      expected_version: (await run(linked.run_id)).version,
      effective_date: "2026-09-01",
      reason: "Unlink report",
    });
    assert.equal(
      (await detail(manual.id)).reversed_by_entry_id,
      null,
      "manual journal remains intact",
    );
    assert.equal(
      (await call({ ...base, mode: "preview" }))[0].state,
      "match",
      "manual journal can be linked again",
    );
    // A nearby date with equal gross is explained using actual account amounts.
    const nearby = {
      ...base,
      items: items.map((i) => ({
        ...i,
        key: i.key.replace("2026-09-01", "2026-09-02"),
        body: { ...i.body, pay_date: "2026-09-02" },
      })),
    };
    const conflict = (await call({ ...nearby, mode: "preview" }))[0];
    assert.equal(conflict.state, "date_match");
    assert.equal(conflict.candidates[0].entry_date, "2026-09-01");
    assert.equal(conflict.candidates[0].lines.length, 4);
    const candidate = conflict.candidates[0];
    const dateChoice = (action: string, c = candidate) =>
      `${action}:${c.id}:${c.version}:${c.entry_date}`;
    const commitDate = (choice: string) =>
      call({
        ...nearby,
        mode: "commit",
        items: nearby.items.map((i) => ({ ...i, choice })),
      });
    await assert.rejects(
      () =>
        commitDate(`correct-date:${candidate.id}:999:${candidate.entry_date}`),
      /ACCT_PATRIOT_CHANGED/,
    );
    const changedAmounts = {
      ...nearby,
      items: nearby.items.map((i) => ({
        ...i,
        body: {
          ...i.body,
          components: i.body.components.map((c) =>
            c.kind === "employer_tax" ? { ...c, amount_cents: "15301" } : c,
          ),
        },
      })),
    };
    assert.equal(
      (await call({ ...changedAmounts, mode: "preview" }))[0].state,
      "conflict",
      "equal gross alone is not an exact match",
    );
    await assert.rejects(
      () =>
        call({
          ...changedAmounts,
          mode: "commit",
          items: changedAmounts.items.map((i) => ({
            ...i,
            choice: dateChoice("correct-date"),
          })),
        }),
      /ACCT_PATRIOT_CHANGED/,
    );
    await db.exec(
      "RESET ROLE; UPDATE accounting.periods SET status='locked',locked_at=now() WHERE month='2026-09-01'; SET ROLE authenticated",
    );
    assert.equal(
      (await call({ ...nearby, mode: "preview" }))[0].state,
      "conflict",
    );
    await assert.rejects(
      () => commitDate(dateChoice("correct-date")),
      /ACCT_PATRIOT_CHANGED/,
    );
    await db.exec(
      "RESET ROLE; SELECT set_config('accounting.reason','Fixture reopen',false); UPDATE accounting.periods SET status='open',locked_at=NULL,reopen_reason='Fixture reopen' WHERE month='2026-09-01'; SET ROLE authenticated",
    );
    const dateLinked = (await commitDate(dateChoice("link-date")))[0];
    assert.equal(
      dateLinked.entry_id,
      manual.id,
      "date-only link keeps original journal",
    );
    assert.equal((await detail(manual.id)).entry_date, "2026-09-01");
    await cmd({
      type: "payroll.import.undo",
      id: dateLinked.run_id,
      expected_version: (await run(dateLinked.run_id)).version,
      effective_date: "2026-09-02",
      reason: "Test correction alternative",
    });
    const refreshed = (await call({ ...nearby, mode: "preview" }))[0]
      .candidates[0];
    const corrected = (
      await commitDate(dateChoice("correct-date", refreshed))
    )[0];
    const replacement = await detail(corrected.entry_id);
    assert.equal(replacement.entry_date, "2026-09-02");
    assert.equal(replacement.replaces_entry_id, manual.id);
    const priorReversal = await detail(
      (await detail(manual.id)).reversed_by_entry_id,
    );
    assert.equal(
      priorReversal.entry_date,
      "2026-09-01",
      "correction cancels expense on the original date",
    );
    assert.equal(
      (await call({ ...nearby, mode: "preview" }))[0].state,
      "duplicate",
    );
    assert.equal(
      (await run(corrected.run_id)).import_mode,
      "linked",
      "undo preserves corrected preexisting journal",
    );
    await cmd({
      type: "payroll.import.undo",
      id: corrected.run_id,
      expected_version: (await run(corrected.run_id)).version,
      effective_date: "2026-09-02",
      reason: "Undo report link",
    });
    assert.equal((await detail(corrected.entry_id)).reversed_by_entry_id, null);
    // The common month-end case must also support correcting backwards into July.
    const earlier = {
      ...nearby,
      items: nearby.items.map((i) => ({
        ...i,
        key: i.key.replace("2026-09-02", "2026-08-31"),
        body: { ...i.body, pay_date: "2026-08-31" },
      })),
    };
    const earlierCandidate = (await call({ ...earlier, mode: "preview" }))[0]
      .candidates[0];
    const backward = (
      await call({
        ...earlier,
        mode: "commit",
        items: earlier.items.map((i) => ({
          ...i,
          choice: dateChoice("correct-date", earlierCandidate),
        })),
      })
    )[0];
    assert.equal((await detail(backward.entry_id)).entry_date, "2026-08-31");
    const entryHistory = async (id: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.entry_history($1) r", [
          id,
        ])
      ).rows[0].r;
    const chain = await entryHistory(backward.entry_id);
    assert.equal(
      chain.reference,
      manual.id,
      "one stable reference through repeated corrections",
    );
    assert.equal(
      chain.entries.length,
      5,
      "original, two reversals, and two replacements remain accessible",
    );
    assert.equal((await entryHistory(priorReversal.id)).reference, manual.id);
    assert.ok(
      chain.documents.some((d: any) => d.id === doc.id),
      "linked payroll report available throughout history",
    );
    const correctable = await post("2026-09-03", "Correction integrity", [
      { account_id: bank, amount_cents: "10000" },
      { account_id: income, amount_cents: "-10000" },
    ]);
    await cmd({
      type: "document.link",
      id: randomUUID(),
      document_id: doc.id,
      entry_id: correctable.id,
    });
    const command = {
      type: "entry.correct",
      id: correctable.id,
      expected_version: (await detail(correctable.id)).version,
      replacement_id: randomUUID(),
      reversal_date: "2026-09-03",
      entry_date: "2026-09-04",
      memo: "Corrected receipt",
      reason: "Fix amount",
      lines: [
        { account_id: bank, amount_cents: "12000" },
        { account_id: income, amount_cents: "-12000" },
      ],
    };
    const countEntries = async () =>
      (
        await inspect(
          "SELECT count(*)::integer n FROM accounting.journal_entries",
        )
      ).rows[0].n;
    const beforeCount = await countEntries();
    await assert.rejects(
      () =>
        cmd({
          ...command,
          lines: [
            { account_id: bank, amount_cents: "12000" },
            { account_id: income, amount_cents: "-11000" },
          ],
        }),
      /ACCT_UNBALANCED/,
    );
    assert.equal(
      await countEntries(),
      beforeCount,
      "invalid replacement rolls back its reversal too",
    );
    assert.equal((await detail(correctable.id)).reversed_by_entry_id, null);
    const retry = new AccountingRetryKeys();
    const lostResponse = await cmd(command, retry.keyFor(command));
    const recovered = await cmd(command, retry.keyFor(command));
    assert.deepEqual(
      recovered,
      lostResponse,
      "lost response retry returns the same correction",
    );
    assert.equal(
      await countEntries(),
      beforeCount + 2,
      "retry adds no duplicate ledger entries",
    );
    retry.complete(command);
    assert.ok(
      (await detail(recovered.id)).documents.some((d: any) => d.id === doc.id),
      "receipt follows replacement",
    );
    assert.equal((await entryHistory(recovered.id)).reference, correctable.id);
    const periodAmounts = (
      await inspect(
        "SELECT e.entry_date::text AS entry_date,sum(l.amount_cents)::text amount FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id=e.id WHERE e.id=ANY($1::uuid[]) AND e.status='posted' AND l.account_id=$2 GROUP BY e.entry_date ORDER BY e.entry_date",
        [[correctable.id, recovered.id, recovered.reversal_id], bank],
      )
    ).rows;
    assert.deepEqual(
      periodAmounts,
      [
        { entry_date: "2026-09-03", amount: "0" },
        { entry_date: "2026-09-04", amount: "12000" },
      ],
      "dated ledger retains all original, reversal and replacement effects",
    );
    const chart = new Map(
      (
        await inspect(
          "SELECT id,name,type account_type,CASE WHEN (type IN ('asset','expense')) <> is_contra THEN 'debit' ELSE 'credit' END normal_side FROM accounting.accounts",
        )
      ).rows.map((a: any) => [a.id, a]),
    );
    const effect = correctionImpact(
      (await detail(correctable.id)).lines,
      command.lines,
      chart as any,
    );
    assert.equal(effect.find((r) => r.id === bank)?.change, BigInt(2000));
    assert.equal(
      effect.find((r) => r.id === income)?.change,
      BigInt(2000),
      "credit-normal income shows an increase",
    );
    await db.exec("SET ROLE anon");
    await assert.rejects(
      () => entryHistory(correctable.id),
      /permission denied|ACCT_FORBIDDEN/,
    );
    await assert.rejects(
      () => cmd(restore),
      /permission denied|ACCT_FORBIDDEN/,
    );
    console.log(
      `${source}: reversal, bank suppression, restoration chains, payroll undo/link/reimport and comparison checks passed`,
    );
  } finally {
    await db.close();
  }
}
verify(
  process.env.ACCOUNTING_SCHEMA_SOURCE === "canonical"
    ? "canonical"
    : "migrations",
).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
