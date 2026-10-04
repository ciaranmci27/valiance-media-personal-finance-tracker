import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentCsv,
  reportDocument,
} from "../src/lib/accounting/report-document";
import { reportPdf } from "../src/lib/accounting/server/report-pdf";
import {
  afterBusinessSentence,
  bridgeSentence,
  cashBridge,
  cashFlowStatement,
  cashFlowTotals,
  cashMonths,
  cashRole,
  cashSeriesFilter,
  isEmptyCashFlow,
  PROFIT_CASH_LINES,
  profitCashSentence,
  profitToCash,
} from "../src/lib/accounting/cash-flow";
import { previousPeriod, samePeriodLastYear } from "../src/lib/accounting/profit-loss";
import {
  demoBalanceBreakdown,
  demoReportData,
  demoReportDetail,
} from "../src/lib/accounting/demo-reports";
import {
  reportFilterSchema,
  type DetailedReportSnapshot,
  type ReportAccount,
  type ReportData,
  type ReportFilter,
} from "../src/lib/accounting/reports";

/**
 * The cash flow presentation rules: how each balance is sorted, the bridge
 * and the statement adding up to the change in bank and cash on every
 * period, transfers between your own accounts and card payments never
 * counting twice, mixed owner accounts splitting, profit vs cash, the month
 * series, and the export layout. Set ACCOUNTING_REPORT_ARTIFACT_DIR to also
 * write the PDFs and CSVs.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const big = BigInt;
  const ZERO = big(0);
  const sum = (values: bigint[]) => values.reduce((s, v) => s + v, ZERO);

  // How each balance is sorted, from its kind, subtype and purpose.
  const role = (
    account_type: ReportAccount["account_type"],
    subtype: string | null,
    purpose: string | null = null,
    cash_kind: ReportAccount["cash_kind"] = "none",
  ) => cashRole({ account_type, subtype, purpose, cash_kind } as ReportAccount);
  check(role("asset", "bank", "checking", "bank"), "cash");
  check(role("asset", "cash", null, "cash"), "cash");
  check(role("liability", "card", "business_card", "card"), "card");
  check(role("asset", "transit", "transfers_in_transit"), "transit");
  check(role("asset", "other", "undeposited_funds"), "transit");
  check(role("asset", "accumulated_depreciation"), "depreciation");
  check(role("asset", "fixed_asset", "equipment"), "equipment");
  check(role("liability", "loan", "loans_payable"), "loan");
  check(role("liability", "other", "due_to_shareholder"), "loan");
  check(role("asset", "other", "due_from_shareholder"), "loan");
  check(role("asset", "receivable"), "customers");
  check(role("liability", "payroll_liability", "payroll_taxes_payable"), "owed");
  check(role("equity", "owner_equity", "distributions"), "owner");
  check(role("equity", "owner_equity", ""), "owner");
  check(role("equity", "opening_balance", "opening_balance_equity"), "opening");
  check(role("equity", "retained_earnings", "opening_retained_earnings"), "opening");
  check(role("asset", "other", "prepaid_expenses"), "other");
  check(role("income", "revenue", "consulting"), "result");
  check(role("expense", "operating_expense", "software"), "result");

  // Every period ties: the parts add up to the change in bank and cash, and
  // ending cash equals the bank and cash balances on the balance sheet.
  const periods: [string, string][] = [
    ["2024-01-01", "2024-12-31"],
    ["2025-01-01", "2025-12-31"],
    ["2025-07-01", "2025-09-30"],
    ["2026-01-01", "2026-10-03"],
    ["2026-09-01", "2026-09-30"],
    ["2026-10-01", "2026-10-03"],
    ["2024-03-15", "2026-06-10"],
  ];
  const filterOf = (from: string, to: string, mode: ReportFilter["mode"], compare?: { compare_from: string; compare_to: string }): ReportFilter => ({
    from,
    to,
    mode,
    offset: 0,
    ...(compare ?? {}),
  });
  const bankCash = (data: ReportData) =>
    sum(
      data.accounts
        .filter((a) => a.cash_kind === "bank" || a.cash_kind === "cash")
        .map((a) => big(a.ending_cents)),
    );
  for (const [from, to] of periods) {
    for (const mode of ["working", "posted"] as const) {
      const label = `${from} to ${to} ${mode}`;
      const data = demoReportData(filterOf(from, to, mode, previousPeriod(from, to)));
      const t = cashFlowTotals(data);
      check(t.difference, ZERO, `${label} ties`);
      check(t.cashIn + t.cashOut, t.change, `${label} in and out make the change`);
      check(t.ending, bankCash(data), `${label} ending cash is the bank and cash balances`);
      check(t.cashIn >= ZERO && t.cashOut <= ZERO, true);
      const bridge = cashBridge(data);
      check(t.starting + sum(bridge.lines.map((l) => l.amount)), t.ending, `${label} bridge`);
      check(
        bridge.lines.every((l) => !l.filter || reportFilterSchema.safeParse(l.filter).success),
        true,
      );
      const story = profitToCash(data);
      check(story.operating, t.operating, `${label} profit vs cash ends at operating`);
      check(story.profit + sum(story.lines.map((l) => l.amount)), story.operating);
      const magnitudes = story.lines
        .filter((l) => l.key !== "rest")
        .map((l) => (l.amount < ZERO ? -l.amount : l.amount));
      check(
        magnitudes.every((m, i) => i === 0 || m <= magnitudes[i - 1]),
        true,
        `${label} biggest reason first`,
      );
      // The statement, summary and every account, with its comparison.
      const before = demoReportData(filterOf(data.filter.compare_from!, data.filter.compare_to!, mode));
      const then = cashFlowTotals(before);
      for (const details of [false, true]) {
        const rows = cashFlowStatement(data, details);
        const row = (key: string) => rows.find((r) => r.key === key)!;
        check(big(row("change").values[0]), t.change, `${label} statement change`);
        check(big(row("starting").values[0]), t.starting);
        check(big(row("ending").values[0]), t.ending);
        check(big(row("t-operating").values[0]), t.operating);
        check(big(row("change").values[1]), then.change, `${label} comparison change`);
        check(big(row("t-operating").values[1]), then.operating, `${label} comparison operating`);
        check(big(row("ending").values[1]), then.ending);
        check(
          rows
            .filter((r) => r.kind !== "heading")
            .every((r) => big(r.values[2]) === big(r.values[0]) - big(r.values[1])),
          true,
        );
        // Each section's lines add up to its subtotal, and the sections to the change.
        const sections = new Map<string, bigint>();
        for (const r of rows)
          if (r.kind === "account")
            sections.set(r.section, (sections.get(r.section) ?? ZERO) + big(r.values[0]));
        for (const r of rows)
          if (r.kind === "subtotal" && r.key.startsWith("t-"))
            check(big(r.values[0]), sections.get(r.section), `${label} ${r.section} adds up`);
        check(
          sum([...sections.entries()].filter(([s]) => s !== "Cash").map(([, v]) => v)),
          t.change,
          `${label} sections add up to the change`,
        );
        check(
          rows.every(
            (r) => !r.detail || r.detail.every((d) => reportFilterSchema.safeParse(d).success),
          ),
          true,
        );
      }
    }
  }

  // Money between your own accounts: a savings transfer or a card payment
  // through transit never shows as cash in or out.
  const september = demoReportData(filterOf("2026-09-01", "2026-09-30", "working"));
  const sept = cashFlowTotals(september);
  const named = (data: ReportData, name: string) => data.accounts.find((a) => a.name === name)!;
  const transit = named(september, "Transfers in transit");
  // The transfer sent on the 30th is still on its way at the period end.
  check(transit.period_cents, "500000");
  check(sept.transit, big(-500000));
  check(cashBridge(september).lines.find((l) => l.key === "transit")?.label, "On its way between your accounts");
  const october = cashFlowTotals(demoReportData(filterOf("2026-10-01", "2026-10-03", "working")));
  check(october.transit, big(500000));
  check(
    cashBridge(demoReportData(filterOf("2026-10-01", "2026-10-03", "working"))).lines.find((l) => l.key === "transit")?.label,
    "Arrived from between your accounts",
  );
  // A month whose transfers land inside it has nothing in transit.
  const august = demoReportData(filterOf("2026-08-01", "2026-08-31", "working"));
  check(named(august, "Transfers in transit").period_cents, "0");
  check(cashBridge(august).lines.some((l) => l.key === "transit"), false);
  // The gross deposits into bank accounts include the transfers; cash in does not.
  const augustTotals = cashFlowTotals(august);
  const deposits = sum(
    august.accounts.filter((a) => a.cash_kind === "bank").map((a) => big(a.debit_cents)),
  );
  check(augustTotals.cashIn < deposits, true, "transfers between accounts are not cash in");

  // A synthetic month: $500 spent on the card, then the card paid through transit.
  const base = demoReportData(filterOf("2026-08-01", "2026-08-31", "working"));
  const like = (name: string, period: number, debit: number, credit: number): ReportAccount => ({
    ...named(base, name),
    period_cents: String(period),
    debit_cents: String(debit),
    credit_cents: String(credit),
  });
  const cardMonth: ReportData = {
    ...base,
    accounts: [
      like("Operating checking", -50000, 0, 50000),
      like("Transfers in transit", 0, 50000, 50000),
      like("Business card", 0, 50000, 50000),
      like("Software", 50000, 50000, 0),
    ],
    totals: {
      ...base.totals,
      net_cents: "-50000",
      cash_opening_cents: "100000",
      cash_ending_cents: "50000",
    },
  };
  const cardTotals = cashFlowTotals(cardMonth);
  check(cardTotals.difference, ZERO);
  check(cardTotals.operating, big(-50000));
  check(cardTotals.cashOut, big(-50000), "the card payment does not count twice");
  check(cardTotals.transit, ZERO);
  check(cashBridge(cardMonth).lines.map((l) => l.key), ["operating"]);
  check(profitToCash(cardMonth).lines.length, 0, "a card bought and paid in the month leaves no gap");
  // Opening balances entered are not money the owner put in.
  const openingMonth: ReportData = {
    ...base,
    accounts: [
      like("Operating checking", 250000, 250000, 0),
      { ...like("Opening retained earnings", -250000, 0, 250000) },
    ],
    totals: { ...base.totals, net_cents: "0", cash_opening_cents: "0", cash_ending_cents: "250000" },
  };
  const opening = cashFlowTotals(openingMonth);
  check(opening.opening, big(250000));
  check(opening.ownerIn, ZERO);
  check(cashBridge(openingMonth).lines.find((l) => l.key === "opening")?.label, "Opening balances entered");
  check(afterBusinessSentence(opening), "After that, opening balances added $2,500, so cash went up by $2,500.");

  // Mixed owner accounts split: credits are money in, debits money out.
  const year = demoReportData(filterOf("2025-01-01", "2025-12-31", "working"));
  const yt = cashFlowTotals(year);
  const owners = year.accounts.filter((a) => cashRole(a) === "owner");
  check(yt.ownerIn, sum(owners.map((a) => big(a.credit_cents))));
  check(yt.ownerOut, -sum(owners.map((a) => big(a.debit_cents))));
  check(yt.ownerIn + yt.ownerOut, -sum(owners.map((a) => big(a.period_cents))));
  const mixed = named(year, "Owner Investment / Drawings");
  check(big(mixed.credit_cents) > ZERO && big(mixed.debit_cents) > ZERO, true, "the demo's mixed account moves both ways");
  check(yt.ownerIn > -big(named(year, "Owner contributions").period_cents), true);
  const yearBridge = cashBridge(year).lines.map((l) => l.key);
  check(yearBridge.includes("ownerIn") && yearBridge.includes("ownerOut"), true);
  check(yearBridge.includes("equipment"), true);

  // Sentences.
  check(
    profitCashSentence(cardTotals, []),
    "The business lost $500, and running the business used $500 of cash.",
  );
  const ytd = demoReportData(filterOf("2026-01-01", "2026-10-03", "working"));
  const yd = cashFlowTotals(ytd);
  const ytdStory = profitToCash(ytd);
  check(
    /^You made \$[\d,]+ in profit, and running the business brought in \$[\d,]+ of cash: \$[\d,]+ (more|less), mostly because .+\.$/.test(
      profitCashSentence(yd, ytdStory.lines),
    ),
    true,
  );
  check(bridgeSentence(yd).startsWith(`Cash went ${yd.change > ZERO ? "up" : "down"} by $`), true);
  check(
    bridgeSentence({ ...yd, change: ZERO, ending: big(12345) }),
    "Cash ended where it started, at $123.45.",
  );
  check(afterBusinessSentence({ ...cardTotals }), null);

  // The month series: month-end bank and cash, and each month's profit.
  const months = cashMonths(ytd, demoBalanceBreakdown(cashSeriesFilter(ytd.filter)));
  check(months.length, 10);
  check(months.at(-1)?.ending, yd.ending);
  check(months.at(-1)?.partial, { from: "2026-10-01", to: "2026-10-03" });
  check(sum(months.map((m) => m.change)), yd.change);
  check(sum(months.map((m) => m.profit)), yd.profit);
  // Without the series the months carry the starting balance, never a guess.
  check(cashMonths(ytd, null).every((m) => m.ending === yd.starting), true);

  // Drill-downs: the ending cash line opens the bank and cash journal to date.
  const ending = cashFlowStatement(ytd, false).find((r) => r.key === "ending")!;
  const endingDetail = await demoReportDetail(reportFilterSchema.parse(ending.detail![0]));
  check(big(endingDetail.total_cents), yd.ending);
  const operatingDrill = cashBridge(ytd).lines[0].filter!;
  const income = await demoReportDetail(reportFilterSchema.parse(operatingDrill));
  check(big(income.total_cents), -yd.profit, "the operating drill opens the profit lines");

  // Nothing on the books.
  check(isEmptyCashFlow(demoReportData(filterOf("2019-01-01", "2019-12-31", "working"))), true);
  check(isEmptyCashFlow(ytd), false);

  // Exports: layout 2 is a flat sheet of every line, and the branded statement.
  const snapshot = (report: ReportData, layout?: 2, details = true): DetailedReportSnapshot => ({
    id: "00000000-0000-4000-8000-00000000c001",
    revision: report.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: {
      type: "detailed_report",
      export_definition: 1,
      data: report,
      options: { report_id: "cash-flow", show_zero: false, details, ...(layout ? { layout } : {}) },
    },
  });
  const compared = demoReportData(filterOf("2026-01-01", "2026-10-03", "working", samePeriodLastYear("2026-01-01", "2026-10-03")));
  const branded = reportDocument(snapshot(compared, 2));
  check(branded.columns, ["Section", "Line", "Amount", "Comparison", "Change"]);
  const csv = documentCsv(branded);
  check(csv.includes("$"), false);
  check(
    csv.includes(`"Cash","Ending cash",${(Number(compared.totals.cash_ending_cents) / 100).toFixed(2)},`),
    true,
  );
  check(csv.includes(`"Cash from running the business","Net profit",`), true);
  check(csv.includes("This operational cash movement"), false);
  check(csv.includes("indirect method"), true);
  check(branded.statement?.tiles.map((t) => t.label), ["Starting cash", "Cash in", "Cash out", "Ending cash"]);
  check(branded.statement?.accentTile, 3);
  check(branded.statement?.shareColumn, false);
  check(branded.statement?.columns, ["This period", "Comparison", "Change"]);
  check(branded.statement?.panels.map((p) => p.title), ["Where your cash came from and went", "Profit vs cash, explained"]);
  for (const panel of branded.statement!.panels)
    check(
      Math.round((panel.start?.amount ?? 0) * 100 + panel.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)),
      Math.round(panel.total.amount * 100),
      `${panel.title} adds up`,
    );
  const plainYtd = reportDocument(snapshot(ytd, 2));
  check(plainYtd.columns, ["Section", "Line", "Amount"]);
  check(plainYtd.statement?.columns, ["Amount"]);
  check(plainYtd.statement?.tiles[3].change?.endsWith("this period"), true);
  const summary = reportDocument(snapshot(ytd, 2, false));
  // The CSV always lists every account; the PDF follows the screen's choice.
  check(summary.rows.length, plainYtd.rows.length);
  check(
    (summary.statement?.rows.length ?? 0) <= (plainYtd.statement?.rows.length ?? 0),
    true,
  );
  const pdf = await reportPdf(branded);
  check(pdf.subarray(0, 5).toString(), "%PDF-");
  // Legacy exports (no layout) keep the older cash movement view.
  check(reportDocument(snapshot(ytd)).columns[0], "Account / category");

  const many: ReportData = {
    ...ytd,
    accounts: [
      ...ytd.accounts,
      ...Array.from({ length: 50 }, (_, i) => ({
        ...named(ytd, "Payroll taxes payable"),
        id: `f0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        code: `22${String(i).padStart(2, "0")}`,
        name: `Synthetic accrued liability ${i + 1} with a longer descriptive name`,
        // Pairs that cancel, so the long statement still ties.
        period_cents: String((i % 2 ? 1 : -1) * (1000 + Math.floor(i / 2) * 37)),
        ending_cents: String(5000 + i * 113),
      })),
    ],
  };
  // A long story folds its smaller changes into one line that still adds up.
  const longStory = profitToCash(many);
  check(longStory.lines.length, PROFIT_CASH_LINES + 1);
  check(longStory.lines.at(-1)?.key, "rest");
  check(longStory.lines.at(-1)?.label, `${profitToCash(ytd).lines.length + 50 - PROFIT_CASH_LINES} smaller changes`);
  check(longStory.operating, cashFlowTotals(many).operating);
  check(longStory.profit + sum(longStory.lines.map((l) => l.amount)), longStory.operating);
  check(longStory.lines.at(-1)?.filter?.account_ids?.length, profitToCash(ytd).lines.length + 50 - PROFIT_CASH_LINES);
  check(cashFlowTotals(many).difference, ZERO);

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cash-flow-compare.pdf"), pdf);
    await writeFile(join(dir, "cash-flow-compare.csv"), csv);
    await writeFile(join(dir, "cash-flow.pdf"), await reportPdf(plainYtd));
    await writeFile(join(dir, "cash-flow.csv"), documentCsv(plainYtd));
    await writeFile(join(dir, "cash-flow-summary.pdf"), await reportPdf(summary));
    const lastYear = reportDocument(snapshot(demoReportData(filterOf("2025-01-01", "2025-12-31", "working", previousPeriod("2025-01-01", "2025-12-31"))), 2));
    await writeFile(join(dir, "cash-flow-2025-compare.pdf"), await reportPdf(lastYear));
    await writeFile(
      join(dir, "cash-flow-long.pdf"),
      await reportPdf(reportDocument(snapshot(many, 2))),
    );
  }
  console.log(
    `Cash flow presentation, tie-out, transfers and export layout: ${checks} assertions passed.`,
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
