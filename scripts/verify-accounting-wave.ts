import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  waveJournalRows,
  waveAccountProposals,
  waveReportControls,
  readWaveCsv,
  isWaveLedger,
} from "../src/lib/accounting/imports/wave";
import { importCommandSchema } from "../src/lib/accounting/imports/contracts";
import { bankGroups, readCsv } from "../src/lib/accounting/imports/csv";
import {
  fixtureAccountId as account,
  fixtureAccounts,
} from "../src/lib/accounting/fixtures";
async function main() {
  const db = await accountingTestDb();
  let n = 0;
  try {
    const cmd = async (command: any, key = randomUUID()) =>
      (
        await db.query<{ r: any }>("SELECT accounting.operate($1) r", [
          JSON.stringify({ key, command }),
        ])
      ).rows[0].r;
    const check = (a: unknown, b: unknown) => {
      assert.deepEqual(a, b);
      n++;
    };
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    for (const a of fixtureAccounts)
      await cmd({
        type: "account.create",
        ...a,
        cash_kind: a.id === account(1) ? "bank" : "none",
      });
    const receivable = randomUUID();
    await cmd({
      type: "account.create",
      id: receivable,
      name: "Synthetic carryover",
      account_type: "asset",
      subtype: "receivable",
      expected_version: 0,
    });
    const headers = [
      "Transaction ID",
      "Transaction Date",
      "Account Name",
      "Transaction Description",
      "Transaction Line Description",
      "Debit Amount (Two Column Approach)",
      "Credit Amount (Two Column Approach)",
      "Account Group",
      "Account Type",
      "Account ID",
      " ",
    ];
    const rows = [
      [
        "SYN-OPEN",
        "2022-12-31",
        "Synthetic receivable",
        "Synthetic opening",
        "",
        "432.10",
        "0",
        "Asset",
        "Receivable",
        "",
        "",
      ],
      [
        "SYN-OPEN",
        "2022-12-31",
        "Synthetic equity",
        "Synthetic opening",
        "",
        "0",
        "432.10",
        "Equity",
        "Retained Earnings: Profit",
        "",
        "",
      ],
      [
        "SYN-COLLECT",
        "2023-01-02",
        "Synthetic bank",
        "Synthetic collection",
        "",
        "432.10",
        "0",
        "Asset",
        "Cash and Bank",
        "",
        "",
      ],
      [
        "SYN-COLLECT",
        "2023-01-02",
        "Synthetic receivable",
        "Synthetic collection",
        "",
        "0",
        "432.10",
        "Asset",
        "Receivable",
        "",
        "",
      ],
      [
        "SYN-ZERO",
        "2022-12-31",
        "Synthetic bank",
        "Synthetic zero",
        "",
        "0",
        "0",
        "Asset",
        "Cash and Bank",
        "",
        "",
      ],
      [
        "SYN-ZERO",
        "2022-12-31",
        "Synthetic equity",
        "Synthetic zero",
        "",
        "0",
        "0",
        "Equity",
        "Retained Earnings: Profit",
        "",
        "",
      ],
      [
        "SYN-OFFSET",
        "2022-12-31",
        "Synthetic expense",
        "Synthetic offset",
        "",
        "12.34",
        "0",
        "Expense",
        "Operating Expense",
        "",
        "",
      ],
      [
        "SYN-OFFSET",
        "2022-12-31",
        "Synthetic expense",
        "Synthetic offset",
        "",
        "0",
        "12.34",
        "Expense",
        "Operating Expense",
        "",
        "",
      ],
    ];
    const accounts = [
      {
        id: receivable,
        type: "asset",
        subtype: "receivable",
        external_names: { wave: "Synthetic receivable" },
      },
      {
        id: account(1),
        type: "asset",
        subtype: "bank",
        external_names: { wave: "Synthetic bank" },
      },
      {
        id: account(4),
        type: "equity",
        subtype: "owner_equity",
        external_names: { wave: "Synthetic equity" },
      },
      {
        id: account(6),
        type: "expense",
        subtype: "operating_expense",
        external_names: { wave: "Synthetic expense" },
      },
    ];
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    check(isWaveLedger(csv), true);
    check(isWaveLedger("id,date,memo,amount\nx,2026-01-01,Synthetic,5"), false);
    check(readWaveCsv(csv).headers.at(-1), " ");
    check(readWaveCsv(csv).rows.length, 8);
    check(
      waveAccountProposals(csv).find((a) => a.name === "Synthetic receivable")
        ?.subtype,
      "receivable",
    );
    const report = waveReportControls(
      "Synthetic company\nDate Range: 2023-01-01 to 2023-12-31\nReport Type: Accrual (Paid & Unpaid)\n,Total Income,100.00\n,Total Cost of Goods Sold,10.00\n,Gross Profit,90.00\n,Total Operating Expenses,20.00\n,Net Profit,70.00",
    );
    check(report.expected, {
      income_cents: "10000",
      cost_of_goods_sold_cents: "1000",
      gross_profit_cents: "9000",
      operating_expense_cents: "2000",
      expense_cents: "3000",
      net_income_cents: "7000",
    });
    check(report.source_report_type, "Accrual (Paid & Unpaid)");
    const parsed = waveJournalRows(csv, accounts);
    check(parsed.length, 4);
    check(
      parsed.every((g) => g.errors.length === 0),
      true,
    );
    check(parsed[2].lines.length, 0);
    assert.ok(parsed[2].exclusion_reason);
    n++;
    check(
      importCommandSchema.safeParse({
        type: "import.stage",
        id: randomUUID(),
        expected_version: 1,
        groups: parsed.map((g, ordinal) => ({
          ...g,
          id: randomUUID(),
          ordinal,
        })),
      }).success,
      true,
    );
    check(
      importCommandSchema.safeParse({
        type: "import.stage",
        id: randomUUID(),
        expected_version: 1,
        groups: [
          {
            ...parsed[0],
            id: randomUUID(),
            ordinal: 0,
            errors: ["Synthetic unresolved mapping"],
          },
        ],
      }).success,
      true,
    );
    check(
      parsed[3].lines.map((l) => l.amount_cents),
      ["1234", "-1234"],
    );
    check(parsed[0].raw[0]["Account ID"], "");
    check(
      waveJournalRows(
        [headers, ...[...rows].reverse()].map((r) => r.join(",")).join("\n"),
        accounts,
      )
        .map((g) => g.fingerprint)
        .sort(),
      parsed.map((g) => g.fingerprint).sort(),
    );
    assert.throws(
      () => waveJournalRows(csv, [...accounts, accounts[0]]),
      /more than one/,
    );
    n++;
    const create = async (
      source: string,
      kind: string,
      groups: any[],
      suffix: string,
    ) => {
      const id = randomUUID();
      const created = await cmd({
        type: "import.create",
        id,
        source_system: source,
        mode: kind,
        basis: "cash",
        source_scope: "synthetic-company",
        file_hash: hash(suffix),
        mapping_hash: hash("mapping"),
        file_name: "synthetic.csv",
        expected_groups: groups.length,
        from: "2022-12-31",
        to: "2026-12-31",
      });
      const stage = await cmd({
        type: "import.stage",
        id,
        expected_version: created.version,
        groups: groups.map((g, ordinal) => ({
          ...g,
          id: randomUUID(),
          ordinal,
        })),
      });
      return stage;
    };
    const state = async (id: string) =>
      (await db.query<{ r: any }>("SELECT accounting.imports($1) r", [id]))
        .rows[0].r;
    const first = await create("wave", "journal", parsed, "synthetic-original");
    let st = await state(first.id);
    check(st.counts.new, 3);
    check(st.counts.excluded, 1);
    const applied = await cmd({
      type: "import.apply",
      id: first.id,
      expected_version: first.version,
      group_ids: st.groups.map((g: any) => g.id),
    });
    check(applied.posted, 3);
    await cmd({
      type: "import.finish",
      id: first.id,
      expected_version: applied.version,
    });
    st = await state(first.id);
    check(st.groups.filter((g: any) => g.entry_id).length, 3);
    const collection = st.groups.find(
      (g: any) => g.external_id === "SYN-COLLECT",
    );
    const entry = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
        collection.entry_id,
      ])
    ).rows[0].r;
    check(entry.origin, "wave");
    check(entry.entry_date, "2023-01-02");
    check(
      entry.lines.map((l: any) => l.amount_cents),
      ["43210", "-43210"],
    );
    check(
      entry.lines.some((l: any) => l.account_id === account(5)),
      false,
    );
    check(entry.import_batch_id, first.id);
    const same = await create("wave", "journal", parsed, "synthetic-repeat");
    check((await state(same.id)).counts.duplicate, 3);
    const changed = parsed.map((g) =>
      g.external_id === "SYN-COLLECT"
        ? {
            ...g,
            fingerprint: hash("changed"),
            lines: g.lines.map((l) => ({
              ...l,
              amount_cents:
                BigInt(l.amount_cents) > BigInt("0") ? "40000" : "-40000",
            })),
          }
        : g,
    );
    const replacement = await create(
      "wave",
      "journal",
      changed,
      "synthetic-changed",
    );
    st = await state(replacement.id);
    check(st.counts.exception, 1);
    const diff = (
      await db.query<{ r: any }>("SELECT accounting.import_compare($1,$2) r", [
        first.id,
        replacement.id,
      ])
    ).rows[0].r;
    check(diff.counts.changed, 1);
    check(diff.counts.unchanged, 3);
    const changedRow = st.groups.find((g: any) => g.status === "exception");
    await cmd({
      type: "import.resolve",
      id: changedRow.id,
      expected_version: changedRow.version,
      resolution: "correct",
      reason: "Synthetic corrected export",
    });
    check(
      (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          entry.id,
        ])
      ).rows[0].r.lines.map((l: any) => l.amount_cents),
      ["43210", "-43210"],
    );
    assert.ok(
      (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          entry.id,
        ])
      ).rows[0].r.reversed_by_entry_id,
    );
    n++;
    const options = {
      delimiter: ",",
      headerRow: 0,
      dateFormat: "yyyy-mm-dd",
      decimal: ".",
      thousands: "",
    } as const;
    const bank = bankGroups(
      readCsv(
        "id,date,memo,amount\nSYN-BANK,2026-09-01,Synthetic software,-88.99\nSYN-BANK-2,2026-09-02,Synthetic software,-12.50",
        options,
      ),
      options,
      {
        date: "date",
        description: "memo",
        amount: "amount",
        externalId: "id",
        sign: "deposits_positive",
        accountId: account(1),
      },
    );
    const batch = await create("csv", "bank", bank, "synthetic-bank");
    st = await state(batch.id);
    const one = await cmd({
      type: "import.apply",
      id: batch.id,
      expected_version: batch.version,
      group_ids: [st.groups[0].id],
    });
    check(one.drafted, 1);
    const cancel = await cmd({
      type: "import.cancel",
      id: batch.id,
      expected_version: one.version,
      reason: "Synthetic interrupted upload",
    });
    st = await state(batch.id);
    check(
      st.groups.map((g: any) => g.status),
      ["applied", "ready"],
    );
    await db.exec("RESET ROLE");
    check(
      (
        await db.query<Record<string, unknown>>(
          "SELECT count(*)::integer n FROM accounting.bank_transactions WHERE import_batch_id=$1",
          [batch.id],
        )
      ).rows[0].n,
      2,
    );
    await db.exec("SET ROLE authenticated");
    const resume = await cmd({
      type: "import.resume",
      id: batch.id,
      expected_version: cancel.version,
    });
    const rest = await cmd({
      type: "import.apply",
      id: batch.id,
      expected_version: resume.version,
      group_ids: [st.groups[1].id],
    });
    check(rest.drafted, 1);
    st = await state(batch.id);
    check(st.batches.find((b: any) => b.id === batch.id).parity_status, "n/a");
    const originalDraft = (
      await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
        st.groups[0].entry_id,
      ])
    ).rows[0].r;
    await assert.rejects(
      cmd({
        type: "draft.save",
        id: originalDraft.id,
        expected_version: originalDraft.version,
        entry_date: originalDraft.entry_date,
        memo: "Attempt source rewrite",
        lines: [
          { account_id: account(1), amount_cents: "-9900" },
          { account_id: account(6), amount_cents: "9900" },
        ],
      }),
      /ACCT_MATCHED_LINE_IMMUTABLE/,
    );
    n++;
    await assert.rejects(
      cmd({
        type: "draft.save",
        id: originalDraft.id,
        expected_version: originalDraft.version,
        entry_date: "2026-09-03",
        memo: "Attempt source date rewrite",
        lines: originalDraft.lines,
      }),
      /ACCT_BANK_SOURCE_CHANGED/,
    );
    n++;
    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query<Record<string, unknown>>(
        "UPDATE accounting.import_rows SET raw='{}' WHERE id=$1",
        [changedRow.id],
      ),
      /ACCT_IMMUTABLE_EVIDENCE/,
    );
    n++;
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      db.query<Record<string, unknown>>("SELECT * FROM accounting.import_rows"),
      /permission denied/,
    );
    n++;
    console.log(
      `Wave adapter, import provenance, cancellation and correction: ${n} checks passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message, e.where, e.stack);
  process.exitCode = 1;
});
