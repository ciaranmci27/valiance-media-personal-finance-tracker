/**
 * Slice 3 of the agent finance tools, in SQL on the pglite fixture: the
 * breakdown (totals by month, quarter, category, contact, bank account and
 * role; activity that adds up to the reports, balances that match them;
 * comparisons; top N with Other), recurring charges found in the books
 * (cadence, price change, active and stopped, what is left out), and the
 * owner-only support reports reached through public.api_accounting with the
 * accounting.payroll scope: refused without it, allowed with it, and never
 * able to write.
 */
import { createHash, randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureAccounts, fixtureOwner, fixtureAccountId as account } from "../src/lib/accounting/fixtures";

const AGENT = "10000000-0000-4000-8000-0000000000e1";
const LIVE_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $function$`;
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQL answers are checked field by field
type Json = Record<string, any>;
const big = (value: unknown) => BigInt(String(value ?? "0"));
const sum = (rows: Json[], field: string) => rows.reduce((n, r) => n + big(r?.[field]), BigInt(0));

async function main() {
  const db = await accountingTestDb();
  try {
    const superuser = async () => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    };
    const asOwner = async () => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
    };
    const owner = async (command: Json) => {
      await asOwner();
      return (await db.query<{ r: Json }>("SELECT accounting.operate($1) r", [JSON.stringify({ key: randomUUID(), command })])).rows[0].r;
    };
    const read = async (sql: string, params: unknown[] = []) => {
      await asOwner();
      return (await db.query<{ r: Json }>(sql, params)).rows[0].r;
    };
    const fails = async (sql: string, params: unknown[] = []) =>
      read(sql, params).then(
        () => "",
        (e: Error) => e.message,
      );
    const raw = async <T = Json>(sql: string, params: unknown[] = []) => {
      await superuser();
      return (await db.query<T>(sql, params)).rows;
    };
    const backdoor = async (sql: string, params: unknown[] = []) => {
      await superuser();
      await db.exec("SET session_replication_role = replica;");
      try {
        await db.query(sql, params);
      } finally {
        await db.exec("SET session_replication_role = origin;");
      }
    };

    await superuser();
    await db.exec(LIVE_AUTH_UID);
    for (const a of fixtureAccounts)
      await owner({
        type: "account.create",
        ...a,
        subtype: a.id === account(2) ? "transit" : a.id === account(8) ? "payroll_liability" : undefined,
        cash_kind: [account(1), account(9)].includes(a.id) ? "bank" : a.id === account(3) ? "card" : "none",
      });
    const labor = randomUUID();
    await owner({ type: "account.create", id: labor, code: "5300", name: "Contract labor", account_type: "expense", normal_side: "debit" });
    const office = (await raw<{ id: string }>("SELECT id FROM accounting.accounts WHERE name='Office expenses'"))[0].id;
    const ids: Record<string, string> = {};
    for (const [name, roles] of [
      ["Figma", ["vendor"]],
      ["Namecheap", ["vendor"]],
      ["Old Tool", ["vendor"]],
      ["Acme", ["client"]],
      ["Jane Designer", ["contractor", "vendor"]],
      ["Both Ways", ["vendor", "client"]],
      ["IRS", ["government"]],
    ] as const) {
      ids[name] = randomUUID();
      await owner({ type: "party.save", id: ids[name], expected_version: 0, name, roles });
    }
    /** A posted (or draft) two-line entry: money account n moves by cents, the other account takes the opposite. */
    const entry = async (date: string, memo: string, money: number | string, cents: number, other: number | string, extra: Json = {}, post = true) => {
      const acct = (v: number | string) => (typeof v === "number" ? account(v) : v);
      const saved = await owner({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo,
        lines: [
          { account_id: acct(money), amount_cents: String(cents) },
          { account_id: acct(other), amount_cents: String(-cents) },
        ],
        ...extra,
      });
      if (post) await owner({ type: "entry.post", id: saved.id, expected_version: saved.version });
      return saved.id as string;
    };

    // Figma on the card, monthly, 16.00 then 20.00 from April; June is two same-day charges of 10.00.
    for (const [date, cents] of [
      ["2025-01-15", 1600],
      ["2025-02-15", 1600],
      ["2025-03-15", 1600],
      ["2025-04-15", 2000],
      ["2025-05-15", 2000],
      ["2025-07-15", 2000],
      ["2025-08-15", 2000],
      ["2025-09-15", 2000],
    ] as const)
      await entry(date, "FIGMA MONTHLY", 3, -cents, 6, { kind: "expense", payee_id: ids.Figma });
    await entry("2025-06-15", "FIGMA SEAT A", 3, -1000, 6, { kind: "expense", payee_id: ids.Figma });
    await entry("2025-06-15", "FIGMA SEAT B", 3, -1000, 6, { kind: "expense", payee_id: ids.Figma });
    // Namecheap, yearly from checking.
    for (const date of ["2023-03-01", "2024-03-01", "2025-03-01"]) await entry(date, "NAMECHEAP RENEWAL", 1, -1500, office, { kind: "expense", payee_id: ids.Namecheap });
    // Old Tool, monthly until February.
    for (const date of ["2024-11-05", "2024-12-05", "2025-01-05", "2025-02-05"]) await entry(date, "OLD TOOL", 1, -900, 6, { kind: "expense", payee_id: ids["Old Tool"] });
    // Coffee, weekly, no contact: the series falls back to the bank description.
    const coffee: string[] = [];
    for (const date of ["2025-09-01", "2025-09-08", "2025-09-15", "2025-09-22"]) coffee.push(await entry(date, "BLUE BOTTLE", 3, -650, office, { kind: "expense" }));
    // Amazon, now and then, no contact: no cadence, never listed.
    const amazon: string[] = [];
    for (const date of ["2025-01-03", "2025-01-20", "2025-04-11", "2025-08-30"]) amazon.push(await entry(date, "AMAZON", 1, -4200, office, { kind: "expense" }));
    await backdoor("UPDATE accounting.journal_entries SET descriptor_key='BLUE BOTTLE' WHERE id = ANY($1::uuid[])", [coffee]);
    await backdoor("UPDATE accounting.journal_entries SET descriptor_key='AMAZON MKTPLACE' WHERE id = ANY($1::uuid[])", [amazon]);
    // Income, a contractor, a contact with two roles, a tax payment, a transfer, payroll and an unreviewed draft.
    await entry("2025-01-31", "Acme retainer", 1, 300000, 5, { kind: "income", payee_id: ids.Acme });
    await entry("2025-04-30", "Acme retainer", 1, 250000, 5, { kind: "income", payee_id: ids.Acme });
    await entry("2025-03-20", "Jane design work", 1, -80000, labor, { kind: "expense", payee_id: ids["Jane Designer"] });
    await entry("2025-05-10", "Both Ways sale", 1, 50000, 5, { kind: "income", payee_id: ids["Both Ways"] });
    await entry("2025-05-20", "Both Ways purchase", 1, -7000, 6, { kind: "expense", payee_id: ids["Both Ways"] });
    await entry("2025-04-15", "IRS penalty", 1, -5000, office, { kind: "expense", payee_id: ids.IRS });
    await entry("2025-02-01", "Sweep to savings", 9, 20000, 1, { kind: "transfer" });
    const salary = await entry("2025-06-25", "Salary journal", 7, 100000, 8, { kind: "payroll" });
    await entry("2025-06-26", "Net pay", 8, 100000, 1, { kind: "payroll" });
    await entry("2025-06-30", "Unreviewed software", 1, -3333, 6, { kind: "expense" }, false);

    // ---- Breakdown: activity adds up to the reports.
    const breakdown = (params: Json) => read("SELECT accounting.breakdown($1) r", [JSON.stringify(params)]);
    const report = (params: Json) => read("SELECT accounting.report('summary',$1) r", [JSON.stringify(params)]);
    const nine = { from: "2025-01-01", to: "2025-09-30" };
    for (const mode of ["posted", "working"]) {
      const byCategory = await breakdown({ ...nine, mode, group_by: "category" });
      const summary = await report({ ...nine, mode });
      check(`breakdown (${mode}): the total equals the report's income and expenses`, byCategory.total.income_cents === summary.income_cents && byCategory.total.expense_cents === summary.expense_cents && byCategory.total.net_cents === summary.net_income_cents, { total: byCategory.total, income: summary.income_cents, expense: summary.expense_cents });
      check(`breakdown (${mode}): category rows add up to the total`, sum(byCategory.rows, "income_cents") === big(byCategory.total.income_cents) && sum(byCategory.rows, "expense_cents") === big(byCategory.total.expense_cents) && byCategory.other === null, byCategory.rows);
      const software = byCategory.rows.find((r: Json) => r.key === account(6));
      const softwareReport = summary.accounts.find((a: Json) => a.id === account(6));
      check(`breakdown (${mode}): a category row equals that account in the report`, software?.expense_cents === softwareReport?.period_cents && software?.type === "expense" && software?.label === "Software", { software, softwareReport: softwareReport?.period_cents });
    }
    const working = await breakdown({ ...nine, mode: "working", group_by: "category" });
    const posted = await breakdown({ ...nine, group_by: "category" });
    check("breakdown: posted is the SQL default and leaves the unreviewed draft out", posted.book_mode === "posted" && big(working.total.expense_cents) - big(posted.total.expense_cents) === BigInt(3333), { posted: posted.total, working: working.total });

    const byMonth = await breakdown({ ...nine, group_by: "month" });
    check("breakdown: one row per month, empty months included, oldest first", byMonth.rows.length === 9 && byMonth.rows[0].key === "2025-01-01" && byMonth.rows[8].key === "2025-09-01" && byMonth.rows[0].label === "Jan 2025", byMonth.rows.map((r: Json) => r.key));
    check("breakdown: months add up to the total", sum(byMonth.rows, "expense_cents") === big(byMonth.total.expense_cents) && sum(byMonth.rows, "income_cents") === big(byMonth.total.income_cents));
    const march = await report({ from: "2025-03-01", to: "2025-03-31" });
    check("breakdown: a month row equals that month's report", byMonth.rows[2].expense_cents === march.expense_cents && byMonth.rows[2].income_cents === march.income_cents, { row: byMonth.rows[2], march: march.expense_cents });
    const byQuarter = await breakdown({ ...nine, group_by: "quarter" });
    check("breakdown: quarters", byQuarter.rows.map((r: Json) => r.label).join() === "Q1 2025,Q2 2025,Q3 2025" && sum(byQuarter.rows, "net_cents") === big(byQuarter.total.net_cents), byQuarter.rows);

    const byContact = await breakdown({ ...nine, group_by: "contact" });
    const figma = byContact.rows.find((r: Json) => r.key === ids.Figma);
    check("breakdown: a contact row is that contact's spending", figma?.expense_cents === "16800" && figma?.label === "Figma" && figma?.count === 10, figma);
    check("breakdown: transactions without a contact are one row", byContact.rows.some((r: Json) => r.key === "none" && r.label === "No contact"), byContact.rows.map((r: Json) => r.label));
    const viaPayee = await breakdown({ ...nine, group_by: "month", payee: ids.Figma });
    check("breakdown: the contact filter agrees with the contact row", viaPayee.total.expense_cents === figma?.expense_cents, viaPayee.total);
    const sorted = byContact.rows.map((r: Json) => big(r.income_cents) + big(r.expense_cents));
    check("breakdown: contact rows are biggest first", sorted.every((v: bigint, i: number) => i === 0 || sorted[i - 1] >= v), sorted.map(String));

    const topTwo = await breakdown({ ...nine, group_by: "contact", top: 2 });
    check("breakdown: top keeps that many rows", topTwo.rows.length === 2 && topTwo.rows[0].key === byContact.rows[0].key, topTwo.rows.map((r: Json) => r.label));
    check(
      "breakdown: top rows plus Other equal the total",
      topTwo.other?.groups === byContact.rows.length - 2 &&
        sum([...topTwo.rows, topTwo.other], "income_cents") === big(topTwo.total.income_cents) &&
        sum([...topTwo.rows, topTwo.other], "expense_cents") === big(topTwo.total.expense_cents) &&
        /^Other \(\d+ contacts\)$/.test(topTwo.other?.label),
      topTwo.other,
    );

    const byRole = await breakdown({ ...nine, group_by: "role" });
    const role = (key: string) => byRole.rows.find((r: Json) => r.key === key);
    check("breakdown: a contractor who is also a vendor counts as a contractor", role("contractor")?.expense_cents === "80000" && role("contractor")?.label === "Contractor", role("contractor"));
    check("breakdown: a client who is also a vendor counts once, as a client", role("client")?.income_cents === "600000" && role("client")?.expense_cents === "7000", role("client"));
    check("breakdown: government and no contact", role("government")?.expense_cents === "5000" && role("none")?.label === "No contact", byRole.rows);
    check("breakdown: roles add up to the total", sum(byRole.rows, "expense_cents") === big(byRole.total.expense_cents) && sum(byRole.rows, "income_cents") === big(byRole.total.income_cents));
    const contractors = await breakdown({ ...nine, group_by: "category", role: "contractor" });
    check("breakdown: the role filter keeps contacts holding that role", contractors.total.expense_cents === "80000" && contractors.rows[0]?.key === labor, contractors.rows);

    const byBank = await breakdown({ ...nine, group_by: "bank_account" });
    const card = byBank.rows.find((r: Json) => r.key === account(3));
    check("breakdown: the card's spending by bank account", card?.expense_cents === "19400" && card?.label === "Business card", card);
    check("breakdown: entries with no single bank account are one row (the salary journal)", byBank.rows.find((r: Json) => r.key === "none")?.expense_cents === "100000", byBank.rows);
    const onCard = await breakdown({ ...nine, group_by: "category", bank_account: account(3) });
    check("breakdown: the bank_account filter", onCard.total.expense_cents === "19400" && onCard.rows.length === 2, onCard.rows);
    const payroll = await breakdown({ ...nine, group_by: "category", kind: "payroll" });
    check("breakdown: the kind filter", payroll.total.expense_cents === "100000" && payroll.rows[0]?.key === account(7), payroll.total);
    const incomeOnly = await breakdown({ ...nine, group_by: "month", account_types: ["income"] });
    check("breakdown: account_types income", incomeOnly.total.expense_cents === "0" && incomeOnly.total.income_cents === "600000", incomeOnly.total);

    // Comparisons.
    const q2 = await breakdown({ from: "2025-04-01", to: "2025-06-30", group_by: "category", compare: "previous_period" });
    const q1 = await breakdown({ from: "2025-01-01", to: "2025-03-31", group_by: "category" });
    check("compare: previous_period of a quarter is the quarter before", q2.compare?.from === "2025-01-01" && q2.compare?.to === "2025-03-31", q2.compare);
    check("compare: the compared total is that period's total", q2.total.compare.expense_cents === q1.total.expense_cents && q2.total.compare.income_cents === q1.total.income_cents, { q2: q2.total, q1: q1.total });
    check(
      "compare: change is this period less that one",
      big(q2.total.change.net_cents) === big(q2.total.net_cents) - big(q1.total.net_cents) && q2.rows.every((r: Json) => big(r.change.expense_cents) === big(r.expense_cents) - big(r.compare.expense_cents)),
      q2.total,
    );
    const laborRow = q2.rows.find((r: Json) => r.key === labor);
    check("compare: a category only in the compared period still shows, at zero now", laborRow?.expense_cents === "0" && laborRow?.compare?.expense_cents === "80000", laborRow);
    const leap = await breakdown({ from: "2025-01-01", to: "2025-02-28", group_by: "category", compare: "previous_year" });
    check("compare: previous_year of whole months ends on the month's last day", leap.compare?.from === "2024-01-01" && leap.compare?.to === "2024-02-29", leap.compare);
    const partial = await breakdown({ from: "2025-01-01", to: "2025-09-17", group_by: "category", compare: "previous_year" });
    check("compare: previous_year of a partial period keeps the dates", partial.compare?.from === "2024-01-01" && partial.compare?.to === "2024-09-17", partial.compare);
    const sept = await breakdown({ from: "2025-09-01", to: "2025-09-30", group_by: "category", compare: "previous_period" });
    check("compare: September compares with all of August, not the 30 days before", sept.compare?.from === "2025-08-01" && sept.compare?.to === "2025-08-31", sept.compare);
    const months = await breakdown({ from: "2025-02-01", to: "2025-03-31", group_by: "month", compare: "previous_period" });
    check(
      "compare: each month meets the month the shift maps to it",
      months.rows[0].compare.expense_cents === "900" && months.rows[1].compare.expense_cents === "10900" && months.rows[1].compare.income_cents === "300000",
      months.rows,
    );
    const explicit = await breakdown({ from: "2025-04-01", to: "2025-06-30", group_by: "category", compare_from: "2025-01-01", compare_to: "2025-03-31" });
    check("compare: explicit dates give the same answer", JSON.stringify(explicit.total) === JSON.stringify(q2.total), explicit.total);
    const otherCompared = await breakdown({ from: "2025-04-01", to: "2025-06-30", group_by: "category", compare: "previous_period", top: 1 });
    check(
      "compare: top rows plus Other equal the total in both periods",
      sum([...otherCompared.rows, otherCompared.other], "expense_cents") === big(otherCompared.total.expense_cents) &&
        [...otherCompared.rows, otherCompared.other].reduce((n: bigint, r: Json) => n + big(r.compare.expense_cents), BigInt(0)) === big(otherCompared.total.compare.expense_cents),
      otherCompared,
    );

    // Balances.
    const cash = await breakdown({ from: "2025-01-01", to: "2025-09-30", group_by: "month", measure: "balance" });
    let balancesAgree = cash.rows.length === 9;
    for (const [i, end] of [
      [0, "2025-01-31"],
      [5, "2025-06-30"],
      [8, "2025-09-30"],
    ] as const) {
      const at = await report({ from: "2025-01-01", to: end });
      if (cash.rows[i]?.balance_cents !== at.totals.cash_ending_cents) balancesAgree = false;
    }
    check("balance: each month's cash equals the report's cash at that month end", balancesAgree, cash.rows);
    check("balance: the total is the balance at the end, not a sum of months", cash.total.balance_cents === cash.rows[8].balance_cents, cash.total);
    const accounts = await breakdown({ from: "2025-01-01", to: "2025-09-30", group_by: "category", measure: "balance", account_ids: [account(1), account(3)], compare: "previous_year" });
    const cardBalance = accounts.rows.find((r: Json) => r.key === account(3));
    check("balance: a card's balance is owed-positive", cardBalance?.balance_cents === "19400" && cardBalance?.compare?.balance_cents === "0" && cardBalance?.change?.balance_cents === "19400", cardBalance);
    check("balance: accounts add up to the total", sum(accounts.rows, "balance_cents") === big(accounts.total.balance_cents));
    const monthCompare = await breakdown({ from: "2025-02-01", to: "2025-03-31", group_by: "month", measure: "balance", compare: "previous_period" });
    const janEnd = await report({ from: "2025-01-01", to: "2025-01-31" });
    check("balance: a month compares with the end of the month the shift maps to it", monthCompare.rows[1]?.compare?.balance_cents === janEnd.totals.cash_ending_cents, { row: monthCompare.rows[1], jan: janEnd.totals.cash_ending_cents });

    // Refusals.
    for (const [label, params] of [
      ["activity on a balance sheet account type", { ...nine, group_by: "month", account_types: ["asset"] }],
      ["activity on a bank account id", { ...nine, group_by: "month", account_ids: [account(1)] }],
      ["a balance by contact", { ...nine, group_by: "contact", measure: "balance" }],
      ["a balance with a role filter", { ...nine, group_by: "month", measure: "balance", role: "vendor" }],
      ["an unknown group", { ...nine, group_by: "project" }],
      ["an unknown role", { ...nine, group_by: "month", role: "friend" }],
      ["compare with explicit dates too", { ...nine, group_by: "month", compare: "previous_year", compare_from: "2024-01-01", compare_to: "2024-02-01" }],
      ["top above 100", { ...nine, group_by: "contact", top: 101 }],
      ["a bank_account that is a category", { ...nine, group_by: "month", bank_account: account(6) }],
    ] as const) {
      const error = await fails("SELECT accounting.breakdown($1) r", [JSON.stringify(params)]);
      check(`breakdown refuses ${label}`, /ACCT_INVALID_FILTER/.test(error), error);
    }
    const backwards = await fails("SELECT accounting.breakdown($1) r", [JSON.stringify({ from: "2025-09-01", to: "2025-01-01", group_by: "month" })]);
    check("breakdown refuses a backwards range", /ACCT_REPORT_RANGE/.test(backwards), backwards);
    const tooLong = await fails("SELECT accounting.breakdown($1) r", [JSON.stringify({ from: "2010-01-01", to: "2025-01-01", group_by: "month" })]);
    check("breakdown refuses more than 120 periods", /ACCT_REPORT_RANGE/.test(tooLong), tooLong);

    // ---- Recurring charges.
    const recurring = (params: Json = {}) => read("SELECT accounting.recurring($1) r", [JSON.stringify({ as_of: "2025-10-01", ...params })]);
    const all = await recurring();
    const series = (name: string) => all.series.find((s: Json) => s.contact?.name === name || s.descriptor_key === name);
    const figmaSeries = series("Figma");
    check("recurring: monthly, active, the same-day charges are one", figmaSeries?.cadence === "monthly" && figmaSeries?.status === "active" && figmaSeries?.count === 9, figmaSeries);
    check(
      "recurring: last, previous, average and the price change with its date",
      figmaSeries?.last_cents === "2000" && figmaSeries?.previous_cents === "2000" && figmaSeries?.average_cents === "1867" && figmaSeries?.price_change?.on === "2025-04-15" && figmaSeries?.price_change?.from_cents === "1600" && figmaSeries?.price_change?.to_cents === "2000",
      figmaSeries,
    );
    check("recurring: next expected, annual cost, category and bank account", figmaSeries?.next_expected === "2025-10-15" && figmaSeries?.annual_cents === "24000" && figmaSeries?.category === "Software" && figmaSeries?.bank_account === "Business card", figmaSeries);
    const domain = series("Namecheap");
    check("recurring: a yearly renewal", domain?.cadence === "annual" && domain?.status === "active" && domain?.next_expected === "2026-03-01" && domain?.annual_cents === "1500" && domain?.price_change === null, domain);
    const old = series("Old Tool");
    check("recurring: stopped after 1.5 cadences without a charge", old?.cadence === "monthly" && old?.status === "stopped" && old?.last_date === "2025-02-05", old);
    const blue = series("BLUE BOTTLE");
    check("recurring: without a contact the bank description is the series", blue?.cadence === "weekly" && blue?.contact === null && blue?.status === "active" && blue?.annual_cents === String(650 * 52), blue);
    check("recurring: charges now and then are not listed", !series("AMAZON MKTPLACE"), all.series.map((s: Json) => s.descriptor_key));
    check("recurring: money in, single charges and transfers are not listed", !series("Acme") && !series("Jane Designer") && !all.series.some((s: Json) => /Sweep/.test(s.descriptor_key ?? "")), all.series.map((s: Json) => s.contact?.name ?? s.descriptor_key));
    check("recurring: active first, then by annual cost", all.series.map((s: Json) => s.contact?.name ?? s.descriptor_key).join() === "BLUE BOTTLE,Figma,Namecheap,Old Tool", all.series.map((s: Json) => s.contact?.name ?? s.descriptor_key));
    check("recurring: totals over active series", all.totals.active === 3 && all.totals.stopped === 1 && all.totals.active_annual_cents === String(650 * 52 + 24000 + 1500) && all.totals.active_monthly_cents === String(Math.round((650 * 52 + 24000 + 1500) / 12)), all.totals);
    const active = await recurring({ status: "active" });
    const stopped = await recurring({ status: "stopped" });
    check("recurring: status filters", active.total === 3 && !active.series.some((s: Json) => s.status === "stopped") && stopped.total === 1 && stopped.series[0]?.contact?.name === "Old Tool", { active: active.total, stopped: stopped.series });
    const many = await recurring({ min_count: 5 });
    check("recurring: min_count", many.series.length === 1 && many.series[0].contact?.name === "Figma", many.series.map((s: Json) => s.contact?.name ?? s.descriptor_key));
    const page = await recurring({ limit: 1, offset: 1 });
    check("recurring: pages", page.series.length === 1 && page.series[0].contact?.name === "Figma" && page.total === 4, page);
    const oneContact = await recurring({ contact: ids.Namecheap });
    check("recurring: contact filter", oneContact.total === 1 && oneContact.series[0].cadence === "annual", oneContact);
    const lateYear = await recurring({ as_of: "2026-12-01" });
    check("recurring: as_of moves the status", lateYear.series.every((s: Json) => s.status === "stopped"), lateYear.series.map((s: Json) => s.status));
    const badStatus = await fails("SELECT accounting.recurring($1) r", [JSON.stringify({ status: "paused" })]);
    check("recurring: an unknown status is refused", /ACCT_INVALID_FILTER/.test(badStatus), badStatus);

    // ---- Support reports through the API: the accounting.payroll scope.
    await backdoor(
      `INSERT INTO accounting.payroll_runs(provider_run_id,pay_date,period_start,period_end,gross_cents,net_cents,employee_withholding_cents,employer_tax_cents,components,entry_id,status)
       VALUES('run-1','2025-06-25','2025-06-01','2025-06-30',100000,100000,0,0,'[]',$1,'posted')`,
      [salary],
    );
    await superuser();
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [AGENT]);
    await asOwner();
    const agentId = (await db.query<{ id: string }>("INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Alex','alex@agents.test','agent') RETURNING id", [AGENT])).rows[0].id;
    await superuser();
    const keys: Record<string, string> = {};
    for (const [name, scopes] of [
      ["books", ["accounting.read", "accounting.draft"]],
      ["payroll", ["accounting.read", "accounting.payroll"]],
      ["payrollOnly", ["accounting.payroll"]],
    ] as const) {
      keys[name] = `vmfin_${randomUUID().replaceAll("-", "")}`;
      await db.query("INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,created_by,scopes) VALUES($1,$2,$3,$4,$4,$5)", [name, keys[name].slice(0, 14), hash(keys[name]), agentId, scopes]);
    }
    const auditRows = async () => (await raw<{ n: number }>("SELECT count(*)::int n FROM accounting.audit_log"))[0].n;
    /** One API read as PostgREST runs it: its own transaction, as service_role; `after` runs in the same transaction. */
    const api = async (key: string, name: string, args: Json, after?: string) => {
      await superuser();
      await db.exec("BEGIN; SET LOCAL ROLE service_role;");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      try {
        const r = (await db.query<{ r: Json }>("SELECT public.api_accounting($1,$2,$3) r", [hash(key), name, JSON.stringify(args)])).rows[0].r;
        let afterResult = "";
        if (after)
          afterResult = await db.query<{ v: string }>(after).then(
            (q) => String(q.rows[0]?.v ?? ""),
            (e: Error) => `error: ${e.message}`,
          );
        await db.exec("ROLLBACK;");
        return { r, error: "", after: afterResult };
      } catch (e) {
        await db.exec("ROLLBACK;");
        return { r: {} as Json, error: (e as Error).message, after: "" };
      }
    };
    const support = (id: string, from: string, to: string) => ({ params: { report_id: id, from, to, offset: 0, limit: 100 } });
    const before = await auditRows();

    const noScope = await api(keys.books, "support_report", support("payroll-register", "2025-01-01", "2025-12-31"));
    check("support: a key without accounting.payroll is refused", /API_SCOPE_MISSING/.test(noScope.error), noScope.error);
    const register = await api(keys.payroll, "support_report", support("payroll-register", "2025-01-01", "2025-12-31"));
    check("support: the payroll register with the scope", !register.error && register.r.count === 1 && register.r.rows[0]?.cells?.[2] === "100000" && register.r.total_cells?.[5] === "100000", register.error || register.r);
    const worksheet = await api(keys.payroll, "support_report", support("contractor-worksheet", "2025-01-01", "2025-12-31"));
    const jane = worksheet.r.rows?.find((r: Json) => r.contractor_party_id === ids["Jane Designer"]);
    check("support: the 1099 worksheet with the threshold", !worksheet.error && jane?.cells?.[3] === "80000" && worksheet.r.threshold_cents === "60000", worksheet.error || worksheet.r);
    const tax = await api(keys.payroll, "support_report", support("tax-workpapers", "2025-01-01", "2025-12-31"));
    const profit = await read("SELECT accounting.report('profit_loss',$1) r", [JSON.stringify({ from: "2025-01-01", to: "2025-12-31" })]);
    check("support: tax workpapers, book profit as the posted P&L", !tax.error && tax.r.tax_workpaper?.book_profit_cents === profit.net_income_cents && tax.r.total_cells?.[2] === profit.net_income_cents, tax.error || tax.r.total_cells);
    const only = await api(keys.payrollOnly, "support_report", support("tax-workpapers", "2025-01-01", "2025-12-31"));
    check("support: accounting.payroll alone reads the reports it needs", !only.error && only.r.tax_workpaper?.book_profit_cents === profit.net_income_cents, only.error);
    const onlyBooks = await api(keys.payrollOnly, "breakdown", { params: { ...nine, group_by: "month" } });
    check("support: accounting.payroll alone does not open other books reads", /API_SCOPE_MISSING/.test(onlyBooks.error), onlyBooks.error);
    const readOnly = await api(keys.payroll, "support_report", support("payroll-register", "2025-01-01", "2025-12-31"), "SELECT current_setting('transaction_read_only') v");
    check("support: the call leaves its transaction read only", readOnly.after === "on", readOnly.after);
    const write = await api(keys.payroll, "support_report", support("payroll-register", "2025-01-01", "2025-12-31"), "INSERT INTO accounting.audit_log(actor_kind,table_name,row_id,action) VALUES('api','x',gen_random_uuid(),'x') RETURNING 'wrote' v");
    check("support: nothing can write after it in that transaction", /read-only transaction/.test(write.after), write.after);
    check("support: no audit rows were written", (await auditRows()) === before);

    // The flag alone opens nothing: outside a read-only transaction the owner check refuses the key.
    // api_act is the server's (postgres only); the calls after it run as a signed-in role could.
    await superuser();
    await db.exec("BEGIN;");
    let sneak = "";
    try {
      await db.query("SELECT public.api_act($1,'accounting.payroll')", [hash(keys.payroll)]);
      await db.query("SELECT set_config('api.command','payroll_read',true)");
      await db.exec("SET LOCAL ROLE authenticated;");
      sneak = await db
        .query("SELECT accounting.operate($1)", [JSON.stringify({ key: randomUUID(), command: { type: "party.save", id: randomUUID(), expected_version: 0, name: "Sneaky", roles: ["vendor"] } })])
        .then(
          () => "wrote",
          (e: Error) => e.message,
        );
    } finally {
      await db.exec("ROLLBACK;");
    }
    check("support: the payroll flag without a read-only transaction cannot write", /ACCT_FORBIDDEN/.test(sneak), sneak);
    await superuser();
    await db.exec("BEGIN;");
    let direct = "";
    try {
      await db.query("SELECT public.api_act($1,'accounting.payroll')", [hash(keys.payroll)]);
      await db.query("SELECT set_config('api.command','payroll_read',true)");
      await db.exec("SET LOCAL ROLE authenticated;");
      direct = await db.query("SELECT accounting.support_report($1)", [JSON.stringify({ report_id: "payroll-register", from: "2025-01-01", to: "2025-12-31" })]).then(
        () => "read",
        (e: Error) => e.message,
      );
    } finally {
      await db.exec("ROLLBACK;");
    }
    check("support: the flag without a read-only transaction opens no read either", /ACCT_FORBIDDEN|permission denied/.test(direct), direct);

    // The member must hold the permission too, and a signed-in agent (no key) gets nothing.
    await raw("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'accounting.payroll','deny')", [agentId]);
    const denied = await api(keys.payroll, "support_report", support("payroll-register", "2025-01-01", "2025-12-31"));
    check("support: refused when the member no longer holds accounting.payroll", /API_MEMBER_PERMISSION_MISSING/.test(denied.error), denied.error);
    await raw("DELETE FROM public.team_member_permissions WHERE member_id=$1", [agentId]);
    await db.exec("RESET ROLE; SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [AGENT]);
    const session = await db.query("SELECT accounting.support_report($1)", [JSON.stringify({ report_id: "payroll-register", from: "2025-01-01", to: "2025-12-31" })]).then(
      () => "read",
      (e: Error) => e.message,
    );
    check("support: an agent's own sign-in cannot read it", /ACCT_FORBIDDEN/.test(session), session);
    const roleDefault = (await raw<{ n: number }>("SELECT count(*)::int n FROM public.role_permissions WHERE role='agent' AND permission_key='accounting.payroll'"))[0].n;
    check("support: agents hold accounting.payroll by default", roleDefault === 1);

    // The new reads through the API with a books key.
    const viaApi = await api(keys.books, "breakdown", { params: { ...nine, group_by: "month" } });
    check("api: breakdown with accounting.read", !viaApi.error && viaApi.r.total?.expense_cents === byMonth.total.expense_cents, viaApi.error);
    const recurringApi = await api(keys.books, "recurring", { params: { as_of: "2025-10-01" } });
    check("api: recurring with accounting.read", !recurringApi.error && recurringApi.r.total === 4, recurringApi.error);

    // Reads need the books' reader check.
    await db.exec("RESET ROLE; SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [randomUUID()]);
    const stranger = await db.query("SELECT accounting.breakdown($1)", [JSON.stringify({ ...nine, group_by: "month" })]).then(
      () => "",
      (e: Error) => e.message,
    );
    check("breakdown: a stranger is refused", /ACCT_FORBIDDEN|permission denied/.test(stranger), stranger);
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`Agent insights (books): ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else console.log(`Agent insights (books): ${passed} checks passed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
