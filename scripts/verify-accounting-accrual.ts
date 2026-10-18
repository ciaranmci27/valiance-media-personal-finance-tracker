import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";

/**
 * The accrual view against figures worked out by hand: advance and arrears
 * retainers, hourly time earned before it is billed, billing ahead of time,
 * a reimbursement presented net, a partial payment, a pre-cutover opening,
 * posted versus working, plus the identity that holds on every date
 * (accrual equity - cash equity = receivable + unbilled - deferred) and the
 * cash basis byte for byte against the functions it replaced.
 */
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, label?: string) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const cmd = async (c: object) =>
    (
      await db
        .query<{
          r: any;
        }>(
          "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
          [randomUUID(), JSON.stringify(c)],
        )
        .catch((e) => {
          throw new Error(`${JSON.stringify(c)}: ${e.message}`);
        })
    ).rows[0].r;
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const system = async <T>(fn: () => Promise<T>) => {
    await db.exec("RESET ROLE");
    try {
      return await fn();
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const report = (params: object, kind = "summary") =>
    one<any>("SELECT accounting.report($1,$2) r", [
      kind,
      JSON.stringify(params),
    ]);
  const accrual = (params: object, kind = "summary") =>
    report({ ...params, basis: "accrual" }, kind);
  const ending = (r: any, id: string) =>
    r.accounts.find((a: any) => a.id === id)?.ending_cents ?? "0";
  const period = (r: any, id: string) =>
    r.accounts.find((a: any) => a.id === id)?.period_cents ?? "0";
  const REV = account(5),
    EXP = account(6),
    BANK = account(1);

  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: [1, 9].some((n) => account(n) === a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      })),
    });
    // Before any source the accrual view has nothing to stand on, and says so.
    await assert.rejects(
      accrual({ from: "2026-01-01", to: "2026-01-31" }),
      /ACCT_ACCRUAL_NOT_SET_UP/,
    );
    checks++;
    const client = randomUUID();
    await cmd({
      type: "party.save",
      id: client,
      expected_version: 0,
      name: "Acme Estates",
      roles: ["client"],
    });
    const source = randomUUID();
    const saved = await cmd({
      type: "invoice_source.save",
      id: source,
      expected_version: 0,
      name: "PM app",
      base_url: "https://pm.example.com",
      api_key_encrypted: "v1:key",
      account_map: {
        hourly: REV,
        fixed: REV,
        recurring: REV,
        reimbursement: EXP,
      },
      party_map: { a: client },
    });
    const {
      accounts_receivable: AR,
      unbilled_revenue: UB,
      deferred_revenue: DF,
    } = saved.accounts;
    const prefs = await one<any>("SELECT accounting.context('manage') r");
    await cmd({
      type: "settings.save",
      id: randomUUID(),
      expected_version: prefs.preferences.version,
      accrual_start: "2026-01-01",
    });

    // ---- The source's invoices and earned work, written the way a sync writes them ----
    const invoice = (
      number: string,
      issued: string,
      status: string,
      lines: object[],
      payments: object[] = [],
    ) => ({ number, issued, status, lines, payments });
    const docs = {
      P0: invoice("P0", "2025-12-15", "issued", [
        {
          key: "p0",
          type: "fixed",
          amount_cents: "200000",
          service_from: null,
          service_to: null,
        },
      ]),
      P1: invoice(
        "P1",
        "2025-12-20",
        "paid",
        [
          {
            key: "p1",
            type: "recurring",
            amount_cents: "300000",
            service_from: "2026-01-01",
            service_to: "2026-01-31",
          },
        ],
        [
          {
            id: "hand",
            amount_cents: "300000",
            paid_date: "2025-12-28",
            recorded_via: "app",
            external_id: null,
          },
        ],
      ),
      R1: invoice("R1", "2026-01-25", "issued", [
        {
          key: "r1",
          type: "recurring",
          amount_cents: "300000",
          service_from: "2026-02-01",
          service_to: "2026-02-28",
        },
      ]),
      F1: invoice("F1", "2026-01-15", "issued", [
        {
          key: "f1",
          type: "fixed",
          amount_cents: "120000",
          service_from: null,
          service_to: null,
        },
        {
          key: "f1r",
          type: "reimbursement",
          amount_cents: "20000",
          service_from: null,
          service_to: null,
        },
      ]),
      H1: invoice("H1", "2026-02-10", "issued", [
        {
          key: "h1",
          type: "hourly",
          amount_cents: "150000",
          service_from: null,
          service_to: null,
        },
      ]),
      H2: invoice("H2", "2026-03-01", "issued", [
        {
          key: "h2",
          type: "hourly",
          amount_cents: "80000",
          service_from: null,
          service_to: null,
        },
      ]),
    };
    const ids: Record<string, string> = {};
    const sync = (fn: () => Promise<unknown>) =>
      system(async () => {
        await db.exec("BEGIN");
        await db.query(
          "SELECT set_config('accounting.action','invoice_source.sync',true)",
        );
        await fn();
        await db.exec("COMMIT");
      });
    await sync(async () => {
      for (const [key, d] of Object.entries(docs)) {
        ids[key] = randomUUID();
        const total = d.lines.reduce(
          (s, l: any) => s + BigInt(l.amount_cents),
          BigInt(0),
        );
        await db.query(
          `INSERT INTO accounting.invoices(id,source_id,external_id,number,project_ref,project_name,issue_date,status,total_cents,lines,payments)
           VALUES($1,$2,$3,$4,'a','Growth',$5,$6,$7,$8,$9)`,
          [
            ids[key],
            source,
            key,
            d.number,
            d.issued,
            d.status,
            total.toString(),
            JSON.stringify(d.lines),
            JSON.stringify(d.payments),
          ],
        );
      }
      for (const [ref, kind, from, to, cents] of [
        ["a:2026-01-20", "time", "2026-01-20", "2026-01-20", "100000"],
        ["a:2026-02-05", "time", "2026-02-05", "2026-02-05", "50000"],
        ["a:2026-03-15", "time", "2026-03-15", "2026-03-15", "50000"],
        ["r2:2026-03-01", "scheduled", "2026-03-01", "2026-03-31", "300000"],
      ])
        await db.query(
          "INSERT INTO accounting.earned_work(source_id,kind,external_ref,project_ref,earned_from,earned_to,amount_cents) VALUES($1,$2,$3,'a',$4,$5,$6)",
          [source, kind, ref, from, to, cents],
        );
    });
    // ---- Deposits in the cash books, posted, from the client ----
    const deposit = async (
      date: string,
      lines: [string, string][],
      post = true,
    ) => {
      const total = lines.reduce((s, [, c]) => s + BigInt(c), BigInt(0));
      const d = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: `Deposit ${date}`,
        payee_id: client,
        lines: [
          { account_id: BANK, amount_cents: total.toString(), memo: "" },
          ...lines.map(([a, c]) => ({
            account_id: a,
            amount_cents: `-${c}`,
            memo: "",
          })),
        ],
      });
      if (post)
        await cmd({
          type: "entry.post",
          id: d.id,
          expected_version: d.version,
        });
      return d.id as string;
    };
    const link = (entry: string, invoiceKey: string, cents: string) =>
      cmd({
        type: "invoice.link",
        id: randomUUID(),
        entry_id: entry,
        allocations: [{ invoice_id: ids[invoiceKey], amount_cents: cents }],
      });
    await deposit("2025-12-28", [[REV, "300000"]]); // P1 paid before the start, never linked
    const d0 = await deposit("2026-01-05", [[REV, "200000"]]);
    const d3 = await deposit("2026-02-01", [
      [REV, "120000"],
      [EXP, "20000"],
    ]);
    const d1 = await deposit("2026-02-03", [[REV, "300000"]]);
    const d2 = await deposit("2026-02-20", [[REV, "100000"]]);
    await link(d0, "P0", "200000");
    await link(d3, "F1", "140000");
    await link(d1, "R1", "300000");
    await link(d2, "H1", "100000");

    // ---- Income by month, worked out by hand ----
    const month = async (from: string, to: string) => {
      const r = await accrual({ from, to });
      return [
        r.totals.income_cents,
        r.totals.expense_cents,
        period(r, REV),
        period(r, EXP),
      ];
    };
    check(
      await month("2026-01-01", "2026-01-31"),
      ["520000", "-20000", "-520000", "-20000"],
      "January",
    );
    check(
      await month("2026-02-01", "2026-02-28"),
      ["350000", "0", "-350000", "0"],
      "February",
    );
    check(
      await month("2026-03-01", "2026-03-31"),
      ["350000", "0", "-350000", "0"],
      "March",
    );
    // Mid-month, straight-line earnings are exact to the cent: 300,000 x 15 / 31 by January 15th.
    check(
      (await accrual({ from: "2026-01-01", to: "2026-01-15" })).totals
        .income_cents,
      String(200000 + 145161 + 120000 - 200000),
    );

    // ---- The balance sheet on every date, and the identity behind it ----
    const position = async (asOf: string) => {
      const r = await accrual({ as_of: asOf }, "balance_sheet");
      const cash = await report({ as_of: asOf }, "balance_sheet");
      check(r.totals.difference_cents, "0", `balanced on ${asOf}`);
      const [ar, ub, df] = [
        ending(r, AR),
        ending(r, UB),
        String(-BigInt(ending(r, DF))),
      ];
      // Accrual equity less cash equity is exactly what is owed, earned unbilled, and billed in advance.
      check(
        BigInt(r.equity_total_cents) - BigInt(cash.equity_total_cents),
        BigInt(ar) + BigInt(ub) - BigInt(df),
        `identity on ${asOf}`,
      );
      return [ar, ub, df];
    };
    check(await position("2025-12-31"), ["200000", "0", "300000"]);
    check(await position("2026-01-15"), ["140000", "0", "154839"]);
    check(await position("2026-01-31"), ["440000", "0", "200000"]);
    check(await position("2026-02-28"), ["50000", "0", "0"]);
    check(await position("2026-03-10"), ["130000", "16774", "0"]);
    check(await position("2026-03-31"), ["130000", "270000", "0"]);
    for (const d of [
      "2026-01-01",
      "2026-01-24",
      "2026-01-25",
      "2026-02-01",
      "2026-02-11",
      "2026-03-01",
      "2026-06-30",
    ])
      await position(d);

    // ---- Customer income follows the invoice's client and the deposit's payee ----
    const jan = await accrual({ from: "2026-01-01", to: "2026-01-31" });
    check(
      jan.dimensions.find((d: any) => d.id === client)?.income_cents,
      "520000",
    );
    check(
      [
        jan.quality.accrual.accrual_start,
        jan.quality.accrual.partial,
        jan.quality.accrual.unlinked_client_deposits.count,
      ],
      ["2026-01-01", false, 0],
    );
    check(jan.quality.accrual.earned, {
      time_cents: "100000",
      retainer_cents: "300000",
      invoice_cents: "120000",
      collected_back_cents: "-200000",
    });
    check(jan.basis, "accrual");

    // ---- The ledger drilldown ties to the report ----
    const drill = await one<any>(
      "SELECT accounting.report_lines('general_ledger',$1,$2) r",
      [
        JSON.stringify({
          from: "2026-02-01",
          to: "2026-02-28",
          basis: "accrual",
        }),
        REV,
      ],
    );
    check(drill.total_cents, "-350000");
    check(
      drill.rows.some(
        (r: any) =>
          r.memo === "Accrual: R1 paid" || r.memo.startsWith("Accrual:"),
      ),
      true,
    );

    // ---- A comparison period reads the same view ----
    const compared = await accrual({
      from: "2026-02-01",
      to: "2026-02-28",
      compare_from: "2026-01-01",
      compare_to: "2026-01-31",
    });
    check(
      [compared.comparison.income_cents, compared.totals.income_cents],
      ["520000", "350000"],
    );

    // ---- An arrears retainer reads the same once it is invoiced ----
    await sync(async () => {
      await db.query(
        "DELETE FROM accounting.earned_work WHERE external_ref='r2:2026-03-01'",
      );
      ids.R3 = randomUUID();
      await db.query(
        `INSERT INTO accounting.invoices(id,source_id,external_id,number,project_ref,issue_date,status,total_cents,lines)
         VALUES($1,$2,'R3','R3','a','2026-04-01','issued',300000,$3)`,
        [
          ids.R3,
          source,
          JSON.stringify([
            {
              key: "r3",
              type: "recurring",
              amount_cents: "300000",
              service_from: "2026-03-01",
              service_to: "2026-03-31",
            },
          ]),
        ],
      );
    });
    check(
      await month("2026-03-01", "2026-03-31"),
      ["350000", "0", "-350000", "0"],
      "March once invoiced",
    );
    check(await position("2026-03-31"), ["130000", "270000", "0"]);
    // Billed on April 1st: the unbilled March retainer becomes a receivable, and H2's hours billed ahead show as deferred.
    check(await position("2026-04-01"), ["430000", "0", "30000"]);

    // ---- Posted versus working: a linked draft deposit counts only in working mode ----
    const d4 = await deposit("2026-03-20", [[REV, "80000"]], false);
    await link(d4, "H2", "80000");
    const posted = await accrual({ as_of: "2026-03-31" }, "balance_sheet");
    const working = await accrual(
      { as_of: "2026-03-31", mode: "working" },
      "balance_sheet",
    );
    check([ending(posted, AR), ending(working, AR)], ["130000", "50000"]);
    check(
      [
        working.totals.difference_cents,
        (
          await accrual({
            from: "2026-03-01",
            to: "2026-03-31",
            mode: "working",
          })
        ).totals.income_cents,
      ],
      ["0", "350000"],
    );

    // ---- An unlinked client deposit is called out, never hidden ----
    await deposit("2026-03-25", [[REV, "1000"]]);
    const march = await accrual({ from: "2026-03-01", to: "2026-03-31" });
    check(march.quality.accrual.unlinked_client_deposits, {
      count: 1,
      cents: "1000",
    });

    // ---- A discarded deposit's link stops counting: the receivable is owed again ----
    const draft = await one<any>("SELECT accounting.entry_detail($1) r", [d4]);
    await cmd({
      type: "draft.discard",
      id: d4,
      expected_version: draft.version,
      reason: "Duplicate",
    });
    check(
      ending(
        await accrual(
          { as_of: "2026-03-31", mode: "working" },
          "balance_sheet",
        ),
        AR,
      ),
      "130000",
    );

    // ---- A month locked with a source keeps its accrual figures beside the cash snapshot ----
    await cmd({ type: "period.lock", month: "2026-01-01" });
    const lockedSnap = await system(() =>
      one<any>(
        "SELECT close_snapshot r FROM accounting.periods WHERE month='2026-01-01'",
      ),
    );
    check(
      [
        lockedSnap.accrual.profit_loss.income_cents,
        lockedSnap.accrual.balance_sheet.difference_cents,
        lockedSnap.profit_loss.basis,
      ],
      ["520000", "0", "cash"],
    );

    // ---- Sales tax is owed, never earned --------------------------------------------
    const TAX = account(8);
    const source_row = await system(() =>
      one<number>(
        "SELECT version r FROM accounting.invoice_sources WHERE id=$1",
        [source],
      ),
    );
    await assert.rejects(
      cmd({
        type: "invoice_source.save",
        id: source,
        expected_version: source_row,
        account_map: {
          hourly: REV,
          fixed: REV,
          recurring: REV,
          reimbursement: EXP,
          tax: REV,
        },
      }),
      /ACCT_INVALID_ACCOUNT_MAP/,
    );
    checks++;
    await cmd({
      type: "invoice_source.save",
      id: source,
      expected_version: source_row,
      account_map: {
        hourly: REV,
        fixed: REV,
        recurring: REV,
        reimbursement: EXP,
        tax: TAX,
      },
    });
    await sync(async () => {
      await db.query(
        `INSERT INTO accounting.invoices(id,source_id,external_id,number,project_ref,issue_date,status,total_cents,lines)
         VALUES($1,$2,'T1','T1','a','2026-05-05','issued',10825,$3)`,
        [
          randomUUID(),
          source,
          JSON.stringify([
            {
              key: "t1",
              type: "fixed",
              amount_cents: "10000",
              service_from: null,
              service_to: null,
            },
            {
              key: "t1tax",
              type: "tax",
              amount_cents: "825",
              service_from: null,
              service_to: null,
            },
          ]),
        ],
      );
    });
    const may = await accrual({ from: "2026-05-01", to: "2026-05-31" });
    const mayBalance = await accrual({ as_of: "2026-05-31" }, "balance_sheet");
    check(
      [
        may.totals.income_cents,
        period(may, TAX),
        mayBalance.totals.difference_cents,
      ],
      ["10000", "-825", "0"],
    );

    // ---- The cash basis is byte for byte what the replaced functions returned ----
    const head = execFileSync(
      "git",
      ["show", "HEAD~0:admin/supabase/schema/schema.sql"],
      { cwd: new URL("../..", import.meta.url), maxBuffer: 64 * 1024 * 1024 },
    ).toString();
    const old = (name: string) => {
      const start = head.indexOf(
        `CREATE OR REPLACE FUNCTION accounting.${name}(`,
      );
      const end =
        head.indexOf("\nEND $function$\n;\n", start) +
        "\nEND $function$\n;\n".length;
      return head
        .slice(start, end)
        .replaceAll(`accounting.${name}(`, `accounting.${name}_before(`)
        .replaceAll(`${name}.kind`, `${name}_before.kind`);
    };
    if (!/accounting\.report_source/.test(old("report"))) {
      await system(async () => {
        await db.exec(old("report"));
        await db.exec(old("report_lines"));
        await db.exec(
          "GRANT EXECUTE ON FUNCTION accounting.report_before(text,jsonb), accounting.report_lines_before(text,jsonb,uuid) TO authenticated",
        );
      });
      const stable = (r: any) => ({
        ...r,
        generated_at: null,
        dimensions: [...r.dimensions].sort((a: any, b: any) =>
          a.id.localeCompare(b.id),
        ),
      });
      for (const [kind, params] of [
        ["summary", { from: "2026-01-01", to: "2026-03-31" }],
        ["summary", { from: "2026-01-01", to: "2026-03-31", mode: "working" }],
        ["summary", { from: "2026-02-01", to: "2026-02-28", payee: client }],
        [
          "summary",
          {
            from: "2026-01-01",
            to: "2026-03-31",
            account_types: ["income", "expense"],
          },
        ],
        [
          "summary",
          {
            from: "2026-02-01",
            to: "2026-03-31",
            compare_from: "2025-12-01",
            compare_to: "2026-01-31",
          },
        ],
        ["balance_sheet", { as_of: "2026-03-31" }],
        ["trial_balance", { as_of: "2026-02-15", mode: "working" }],
        ["profit_loss", { from: "2025-01-01", to: "2026-12-31" }],
      ] as const) {
        const now = await one<any>("SELECT accounting.report($1,$2) r", [
          kind,
          JSON.stringify(params),
        ]);
        const before = await one<any>(
          "SELECT accounting.report_before($1,$2) r",
          [kind, JSON.stringify(params)],
        );
        check(
          stable(now),
          stable(before),
          `cash ${kind} ${JSON.stringify(params)}`,
        );
      }
      for (const [kind, params, acct] of [
        ["general_ledger", { from: "2026-01-01", to: "2026-03-31" }, REV],
        [
          "general_ledger",
          { from: "2026-01-01", to: "2026-03-31", mode: "working" },
          null,
        ],
        ["cash_movements", { from: "2026-01-01", to: "2026-03-31" }, null],
        [
          "profit_loss",
          { from: "2026-01-01", to: "2026-03-31", payee: client },
          null,
        ],
      ] as const) {
        const now = await one<any>(
          "SELECT accounting.report_lines($1,$2,$3) r",
          [kind, JSON.stringify(params), acct],
        );
        const before = await one<any>(
          "SELECT accounting.report_lines_before($1,$2,$3) r",
          [kind, JSON.stringify(params), acct],
        );
        check(now, before, `cash lines ${kind}`);
      }
    } else
      console.log(
        "HEAD already has the accrual basis; the byte-for-byte cash comparison runs before it is committed.",
      );

    console.log(`Accrual basis: ${checks} checks passed.`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
