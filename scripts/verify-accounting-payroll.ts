import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const fail = async (fn: () => Promise<unknown>, code: string) => {
    await assert.rejects(fn, new RegExp(code));
    checks++;
  };
  const sql = async <T>(query: string, args: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return (await db.query<T>(query, args)).rows;
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const command = async (c: object, key = randomUUID()) =>
    (
      await db.query<{
        r: {
          id: string;
          version: number;
          entry_id?: string;
          storage_path?: string;
        };
      }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
        [key, JSON.stringify(c)],
      )
    ).rows[0].r;
  type Component = {
    key: string;
    kind: string;
    label: string;
    amount_cents: string;
    account_id: string | null;
    offset_account_id: string | null;
    expected_on: string | null;
    source_line_id?: string | null;
  };
  const date = "2026-08-15",
    document = randomUUID();
  const ids = Object.fromEntries(
    [
      "bank",
      "wages",
      "other_wages",
      "reimb",
      "tax_expense",
      "retire_expense",
      "benefit",
      "fees",
      "net",
      "tax",
      "retire",
      "deductions",
    ].map((k) => [k, randomUUID()]),
  );
  const components: Component[] = [];
  const add = (
    kind: string,
    amount: string,
    account: string,
    offset: string | null = null,
    due: string | null = null,
  ) =>
    components.push({
      key: kind,
      kind,
      label: kind.replaceAll("_", " "),
      amount_cents: amount,
      account_id: ids[account],
      offset_account_id: offset ? ids[offset] : null,
      expected_on: due,
    });
  add("officer_wages", "400000", "wages");
  add("other_wages", "100000", "other_wages");
  add("reimbursement", "20000", "reimb");
  add("net_pay", "420000", "net", null, "2026-08-15");
  add("employee_tax", "70000", "tax", null, "2026-09-30");
  add("retirement_deferral", "25000", "retire", null, "2026-08-31");
  add("other_deduction", "5000", "deductions", null, "2026-08-31");
  add("employer_tax", "35000", "tax_expense", "tax", "2026-09-30");
  add("employer_retirement", "10000", "retire_expense", "retire", "2026-08-31");
  add("employer_benefit", "5000", "benefit", "deductions", "2026-08-31");
  add("provider_fee", "1000", "fees", "deductions", "2026-08-31");
  const body = {
    pay_date: date,
    period_from: "2026-08-01",
    period_to: date,
    declared_gross_cents: "500000",
    declared_net_cents: "420000",
    components,
    employees: [
      {
        key: "owner",
        name: "Synthetic owner",
        is_officer: true,
        gross_cash_cents: "400000",
        federal_taxable_cents: "375000",
        federal_withheld_cents: "40000",
        state_taxable_cents: null,
        state_withheld_cents: null,
        social_security_wages_cents: null,
        medicare_wages_cents: null,
      },
      {
        key: "staff",
        name: "Synthetic staff",
        is_officer: false,
        gross_cash_cents: "100000",
      },
    ],
  };
  try {
    const detail = async (id: string) =>
      (
        await db.query<{ r: any }>(
          "SELECT accounting.payroll(jsonb_build_object('id',$1::text)) r",
          [id],
        )
      ).rows[0].r.rows[0];
    const entry = async (id: string) =>
      (await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [id]))
        .rows[0].r;
    for (const [name, id] of Object.entries(ids)) {
      const liability = ["net", "tax", "retire", "deductions"].includes(name),
        bank = name === "bank";
      await command({
        type: "account.create",
        id,
        name: "Synthetic " + name,
        account_type: bank ? "asset" : liability ? "liability" : "expense",
        subtype: bank
          ? "bank"
          : liability
            ? "payroll_liability"
            : "payroll_expense",
      });
    }
    const prepared = (await command({
      type: "document.prepare",
      id: document,
      original_name: "synthetic-payroll.pdf",
      mime_type: "application/pdf",
      size_bytes: "100",
      content_hash: "a".repeat(64),
    })) as { id: string; version: number; storage_path: string };
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [prepared.storage_path],
    );
    await command({
      type: "document.complete",
      id: document,
      expected_version: prepared.version,
    });
    const base = {
      type: "payroll.save",
      id: randomUUID(),
      expected_version: 0,
      provider_run_id: "PATRIOT-SYNTH-001",
      body,
      document_id: document,
      reason: "Synthetic register",
    };
    const key = randomUUID(),
      saved = await command(base, key);
    check(await command(base, key), saved);
    check(saved.version, 1);
    await fail(
      () => command({ ...base, id: randomUUID() }),
      "ACCT_PAYROLL_DUPLICATE|duplicate key",
    );
    await fail(() => command(base), "ACCT_STALE_VERSION");
    const approve = {
      type: "payroll.approve",
      id: saved.id,
      expected_version: saved.version,
      template: "accrual",
      mode: "new",
      verified: true,
      reason: "Verified synthetic components",
    };
    await fail(
      () => command({ ...approve, verified: false }),
      "ACCT_PAYROLL_EVIDENCE",
    );
    const tryInvalid = async (changed: object, error: string) => {
      const run = await command({
        ...base,
        id: randomUUID(),
        provider_run_id: randomUUID(),
        body: { ...body, ...changed },
      });
      await fail(
        () =>
          command({ ...approve, id: run.id, expected_version: run.version }),
        error,
      );
      await command({
        type: "payroll.discard",
        id: run.id,
        expected_version: run.version,
        reason: "Invalid synthetic draft",
      });
    };
    await tryInvalid(
      { declared_gross_cents: "500001" },
      "ACCT_PAYROLL_EMPLOYEE_TOTALS",
    );
    await tryInvalid(
      {
        components: components.filter((c) => c.kind !== "retirement_deferral"),
      },
      "ACCT_UNBALANCED",
    );
    await tryInvalid(
      { employees: [{ ...body.employees[0], gross_cash_cents: "500000" }] },
      "ACCT_PAYROLL_EMPLOYEE_TOTALS",
    );
    await tryInvalid(
      {
        components: components.map((c) =>
          c.kind === "net_pay" ? { ...c, account_id: ids.bank } : c,
        ),
      },
      "ACCT_PAYROLL_LIABILITY_ACCOUNT",
    );
    await tryInvalid(
      {
        components: components.map((c) =>
          c.kind === "other_deduction"
            ? { ...c, kind: "unsupported garnishment" }
            : c,
        ),
      },
      "ACCT_PAYROLL_UNSUPPORTED_COMPONENT",
    );
    const postKey = randomUUID(),
      posted = await command(approve, postKey);
    check(await command(approve, postKey), posted);
    const d = await detail(saved.id),
      e = await entry(posted.entry_id!);
    check(d.status, "posted");
    check(d.gross_cents, "500000");
    check(d.net_cents, "420000");
    check(d.employer_tax_cents, "35000");
    check(d.ytd.run_employees[0].federal_taxable_cents, "375000");
    check(
      e.lines.reduce(
        (n: bigint, l: any) => n + BigInt(l.amount_cents),
        BigInt("0"),
      ),
      BigInt("0"),
    );
    check(
      e.lines
        .filter((l: any) => l.account_id === ids.tax)
        .reduce((n: bigint, l: any) => n + BigInt(l.amount_cents), BigInt("0")),
      -BigInt("105000"),
    );
    await fail(
      () => command({ ...base, expected_version: posted.version }),
      "ACCT_PAYROLL_IMMUTABLE",
    );
    await fail(
      () =>
        command({
          type: "entry.reverse",
          id: posted.entry_id,
          expected_version: e.version,
          entry_date: date,
          reason: "Bypass payroll",
        }),
      "ACCT_PAYROLL_VOID_REQUIRED",
    );
    const settlement = async (amount: string) =>
      command({
        type: "transaction.review",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "Synthetic net disbursement",
        lines: [
          { account_id: ids.net, amount_cents: amount },
          { account_id: ids.bank, amount_cents: `-${amount}` },
        ],
      });
    await settlement("200000");
    await settlement("220000");
    check(
      (
        await sql<{ amount: string }>(
          "SELECT sum(amount_cents)::text amount FROM accounting.journal_lines WHERE account_id=$1",
          [ids.net],
        )
      )[0].amount,
      "0",
    );
    const before = (
      await sql<{ n: number }>(
        "SELECT count(*)::int n FROM accounting.journal_entries",
      )
    )[0].n;
    await command({
      type: "payroll.void",
      id: saved.id,
      expected_version: posted.version,
      effective_date: "2026-09-01",
      reason: "Synthetic correction",
    });
    check((await detail(saved.id)).status, "void");
    check(
      (
        await sql<{ n: number }>(
          "SELECT count(*)::int n FROM accounting.journal_entries",
        )
      )[0].n,
      before + 1,
    );
    const year = async (through: string) =>
      (
        await db.query<{ r: any }>("SELECT accounting.payroll($1) r", [
          JSON.stringify({ year: 2026, through }),
        ])
      ).rows[0].r;
    check((await year("2026-08-31")).employees[0].gross_cash_cents, "400000");
    check((await year("2026-09-06")).employees.length, 0);
    await fail(
      async () =>
        command({
          ...base,
          expected_version: (await detail(saved.id)).version,
        }),
      "ACCT_PAYROLL_IMMUTABLE",
    );
    const imported = await command({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo: "Synthetic historical payroll",
      lines: e.lines.map((l: any) => ({
        account_id: l.account_id,
        amount_cents: l.amount_cents,
      })),
    });
    const historicRun = await command({
      ...base,
      id: randomUUID(),
      provider_run_id: "SYN-HISTORY",
    });
    const historyCount = (
      await sql<{ n: number }>(
        "SELECT count(*)::int n FROM accounting.journal_entries",
      )
    )[0].n;
    const history = await command({
      ...approve,
      id: historicRun.id,
      expected_version: historicRun.version,
      mode: "historical",
      entry_id: imported.id,
      entry_version: imported.version,
    });
    check((await detail(history.id)).status, "posted");
    check(
      (
        await sql<{ n: number }>(
          "SELECT count(*)::int n FROM accounting.journal_entries",
        )
      )[0].n,
      historyCount,
    );
    const duplicate = await command({
      ...base,
      id: randomUUID(),
      provider_run_id: "SYN-DUP-HISTORY",
    });
    await fail(
      () =>
        command({
          ...approve,
          id: duplicate.id,
          expected_version: duplicate.version,
          mode: "historical",
          entry_id: imported.id,
          entry_version: imported.version,
        }),
      "duplicate key|ACCT_PAYROLL_JOURNAL",
    );
    await command({
      type: "payroll.discard",
      id: duplicate.id,
      expected_version: duplicate.version,
      reason: "Duplicate historic evidence",
    });
    const benefit = await command({
      type: "transaction.review",
      id: randomUUID(),
      expected_version: 0,
      entry_date: date,
      memo: "Synthetic health benefit",
      lines: [
        { account_id: ids.benefit, amount_cents: "20000" },
        { account_id: ids.bank, amount_cents: "-20000" },
      ],
    });
    const source = (await entry(benefit.id)).lines.find(
      (l: any) => l.account_id === ids.benefit,
    );
    const withBenefit = {
      ...body,
      components: [
        ...components,
        {
          key: "noncash",
          kind: "noncash_reclass",
          label: "Previously recorded health insurance",
          amount_cents: "20000",
          account_id: ids.wages,
          offset_account_id: ids.benefit,
          source_line_id: source.id,
          expected_on: null,
        },
      ],
    };
    const withSource = await command({
      ...base,
      id: randomUUID(),
      provider_run_id: "SYN-NONCASH",
      body: withBenefit,
    });
    await command({
      ...approve,
      id: withSource.id,
      expected_version: withSource.version,
    });
    const excess = await command({
      ...base,
      id: randomUUID(),
      provider_run_id: "SYN-NONCASH-EXCESS",
      body: withBenefit,
    });
    await fail(
      () =>
        command({
          ...approve,
          id: excess.id,
          expected_version: excess.version,
        }),
      "ACCT_NONCASH_CAPACITY",
    );
    await fail(
      () =>
        command({
          type: "entry.reverse",
          id: benefit.id,
          expected_version: benefit.version,
          entry_date: date,
          reason: "Bypass consumed benefit",
        }),
      "ACCT_NONCASH_DEPENDENCY",
    );
    await command({
      type: "payroll.discard",
      id: excess.id,
      expected_version: excess.version,
      reason: "Synthetic abandoned draft",
    });
    check((await detail(excess.id)).status, "void");
    await command({
      type: "period.lock",
      month: "2026-08-01",
      reason: "Synthetic period lock",
    });
    await fail(
      () =>
        command({ ...base, id: randomUUID(), provider_run_id: "SYN-LOCKED" }),
      "ACCT_PERIOD_LOCKED",
    );
    await db.exec("SET ROLE anon");
    await fail(() => detail(saved.id), "permission denied");
    await db.exec("SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      randomUUID(),
    ]);
    await fail(() => detail(saved.id), "ACCT_FORBIDDEN");
    console.log(
      `Payroll accrual alternative, source linkage and reversal guards: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.stack, e.where);
  process.exitCode = 1;
});
