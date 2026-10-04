import type {
  BreakdownData,
  ReportAccount,
  ReportData,
  ReportDetail,
  ReportFilter,
  ReportTotals,
} from "./reports";

/**
 * A synthetic studio's books for demo mode, so the profit and loss renders
 * in full without a database. Every figure is generated from a fixed seed:
 * nothing here is, or is derived from, real company data. Reports are built
 * from the same journal lines the drill-down lists, so totals, months,
 * contacts and comparisons always agree with each other.
 */

const ZERO = BigInt(0);
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const partyId = (n: number) =>
  `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type DemoAccount = {
  n: number;
  code: string;
  name: string;
  type: ReportAccount["account_type"];
  purpose: string;
  subtype?: string;
  cash?: "bank" | "card";
};
const ACCOUNTS: DemoAccount[] = [
  { n: 1, code: "1000", name: "Operating checking", type: "asset", purpose: "checking", subtype: "bank", cash: "bank" },
  { n: 2, code: "1010", name: "Reserve savings", type: "asset", purpose: "savings", subtype: "bank", cash: "bank" },
  { n: 3, code: "2000", name: "Business card", type: "liability", purpose: "business_card", subtype: "card", cash: "card" },
  { n: 10, code: "4000", name: "Consulting revenue", type: "income", purpose: "consulting" },
  { n: 11, code: "4100", name: "Retainer revenue", type: "income", purpose: "retainers" },
  { n: 12, code: "4200", name: "Product and SaaS revenue", type: "income", purpose: "products" },
  { n: 13, code: "4300", name: "Affiliate and referral revenue", type: "income", purpose: "affiliate" },
  { n: 14, code: "4800", name: "Interest income", type: "income", purpose: "other_income" },
  { n: 20, code: "5000", name: "Contractors", type: "expense", purpose: "contractors" },
  { n: 21, code: "5100", name: "Software", type: "expense", purpose: "software" },
  { n: 22, code: "5110", name: "Hosting", type: "expense", purpose: "hosting" },
  { n: 23, code: "5120", name: "AI and API services", type: "expense", purpose: "ai_api" },
  { n: 24, code: "5200", name: "Marketing", type: "expense", purpose: "marketing" },
  { n: 25, code: "5300", name: "Professional services", type: "expense", purpose: "professional_services" },
  { n: 26, code: "5410", name: "Bank fees", type: "expense", purpose: "bank_fees" },
  { n: 27, code: "5500", name: "Office supplies", type: "expense", purpose: "office_supplies" },
  { n: 28, code: "5600", name: "Travel", type: "expense", purpose: "travel" },
  { n: 29, code: "5610", name: "Meals", type: "expense", purpose: "meals" },
  { n: 30, code: "5700", name: "Insurance", type: "expense", purpose: "insurance" },
  { n: 31, code: "6000", name: "Officer compensation", type: "expense", purpose: "officer_compensation" },
  { n: 32, code: "6200", name: "Employer payroll taxes", type: "expense", purpose: "employer_payroll_taxes" },
  { n: 33, code: "6210", name: "Payroll fees", type: "expense", purpose: "payroll_fees" },
  { n: 34, code: "6500", name: "Taxes and licenses", type: "expense", purpose: "taxes_licenses" },
  { n: 35, code: "6600", name: "Education", type: "expense", purpose: "education" },
];

const PARTIES = [
  { n: 1, name: "Northwind Traders", roles: ["client"] },
  { n: 2, name: "Contoso Health", roles: ["client"] },
  { n: 3, name: "Fabrikam Labs", roles: ["client"] },
  { n: 4, name: "Tailspin Toys", roles: ["client"] },
  { n: 5, name: "Litware Inc.", roles: ["client"] },
  { n: 6, name: "Partner Program Co.", roles: ["client"] },
  { n: 7, name: "Demo Community Bank", roles: ["financial"] },
  { n: 8, name: "Online store payouts", roles: ["financial"] },
  { n: 10, name: "Alex Morgan", roles: ["employee", "owner"] },
  { n: 11, name: "Payroll Service Co.", roles: ["vendor"] },
  { n: 12, name: "Federal tax deposits", roles: ["government"] },
  { n: 13, name: "Jordan Rivera Design", roles: ["contractor"] },
  { n: 14, name: "Sam Lee Development", roles: ["contractor"] },
  { n: 15, name: "Cloudhost Inc.", roles: ["vendor"] },
  { n: 16, name: "Pixel Software", roles: ["vendor"] },
  { n: 17, name: "Model API Co.", roles: ["vendor"] },
  { n: 18, name: "Brightline Ads", roles: ["vendor"] },
  { n: 19, name: "Ledger & Co. CPAs", roles: ["vendor"] },
  { n: 20, name: "Paper & Ink Supply", roles: ["vendor"] },
  { n: 21, name: "Skyline Air", roles: ["vendor"] },
  { n: 22, name: "Corner Cafe", roles: ["vendor"] },
  { n: 23, name: "Shield Insurance", roles: ["vendor"] },
  { n: 24, name: "State licensing office", roles: ["government"] },
  { n: 25, name: "Course Academy", roles: ["vendor"] },
];

/** The synthetic contacts with their roles, for the role tags. */
export const demoParties = PARTIES.map((p) => ({
  id: partyId(p.n),
  name: p.name,
  roles: p.roles,
}));

type Line = {
  key: string;
  date: string;
  account: number;
  party: number | null;
  /** Positive: income received or expense paid. */
  cents: bigint;
  memo: string;
  draft: boolean;
};

/** A small fixed-seed generator, so the demo is identical on every load. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let ledger: Line[] | null = null;
function lines(): Line[] {
  if (ledger) return ledger;
  const out: Line[] = [];
  const rand = random(20261003);
  const between = (lo: number, hi: number) =>
    Math.round((lo + (hi - lo) * rand()) * 100);
  const add = (
    year: number,
    month: number,
    day: number,
    account: number,
    party: number | null,
    cents: number,
    memo: string,
  ) => {
    cents = Math.round(cents);
    if (cents <= 0) return;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    out.push({
      key: `${date}-${out.length}`,
      date,
      account,
      party,
      cents: BigInt(cents),
      memo,
      // The newest bank activity is still waiting for a review.
      draft: date >= "2026-09-26" && date <= "2026-10-03" && out.length % 3 === 0,
    });
  };
  for (let year = 2024; year <= 2026; year++)
    for (let month = 1; month <= 12; month++) {
      const growth = year === 2024 ? 0.62 : year === 2025 ? 0.8 : 1.15;
      const ramp = 1 + (month - 1) * 0.025;
      // Consulting: two anchor clients and a long tail, paid mid and late month.
      const consulting = between(15000, 23000) * growth * ramp;
      const weights: [number, number][] =
        year === 2026
          ? [[1, 0.5], [2, 0.3], [3, 0.12], [4, 0.05], [5, 0.03]]
          : [[1, 0.36], [2, 0.24], [3, 0.2], [4, 0.12], [5, 0.08]];
      for (const [party, weight] of weights)
        add(year, month, party === 1 ? 14 : 24, 10, party, Math.round((consulting * weight) / 100) * 100, "Client payment");
      if (year === 2026 && month >= 3)
        add(year, month, 2, 11, 2, 350000, "Monthly retainer");
      if (year === 2025 && month === 12)
        add(year, month, 2, 11, 2, 20000, "Retainer deposit");
      add(year, month, 8, 12, 8, between(400, 900) * growth * (year === 2026 ? 2.2 : 1), "Store payout");
      if (month % 2 === 0)
        add(year, month, 19, 13, 6, between(150, 700) * growth, "Referral commission");
      add(year, month, 28, 14, 7, between(8, 30) * (year - 2022), "Interest paid");
      // Payroll: the owner's salary on the 1st, taxes and the provider's fee.
      const salary = year === 2026 ? 750000 : year === 2025 ? 600000 : 450000;
      add(year, month, 1, 31, 10, salary, "Payroll");
      add(year, month, 1, 32, 12, Math.round(salary * 0.0765), "Payroll taxes");
      add(year, month, 1, 33, 11, 4500, "Payroll service");
      // Contractors in busy months.
      if (month % 3 !== 1)
        add(year, month, 11, 20, 13, between(1200, 3800) * growth, "Design sprint");
      if (year >= 2025 && month % 4 === 2)
        add(year, month, 21, 20, 14, between(1500, 4200), "Development hours");
      add(year, month, 3, 21, 16, between(450, 900) + (month === 1 ? 480000 : 0), month === 1 ? "Annual software plans" : "Software subscriptions");
      add(year, month, 5, 22, 15, between(220, 520) * growth, "Hosting");
      add(year, month, 6, 23, 17, between(60, 240) * (year === 2026 ? 3.2 : 1), "API usage");
      if (month % 2 === 1 || year === 2026)
        add(year, month, 9, 24, 18, between(300, 1900) * growth, "Ad spend");
      if (month === 3 || month === 4)
        add(year, month, 15, 25, 19, between(1100, 1800), "Tax preparation");
      add(year, month, 27, 26, 7, 2500, "Account fee");
      add(year, month, 12, 27, 20, between(60, 420), "Supplies");
      if (month % 3 === 0 || (year === 2026 && month === 2))
        add(year, month, 17, 28, 21, between(900, 2600) + (year === 2026 && month === 2 ? 900000 : 0), year === 2026 && month === 2 ? "Conference travel" : "Client visit");
      add(year, month, 18, 29, 22, between(90, 320), "Client lunch");
      if (month === 2)
        add(year, month, 10, 30, 23, year === 2026 ? 2400000 : 360000, year === 2026 ? "Insurance, prepaid two years" : "Annual insurance");
      if (month === 3) add(year, month, 20, 34, 24, 80000, "Annual license");
      if (month === 6 || month === 10)
        add(year, month, 22, 35, 25, between(200, 600), "Course");
    }
  ledger = out.sort((a, b) => a.date.localeCompare(b.date));
  return ledger;
}

const byNumber = new Map(ACCOUNTS.map((a) => [a.n, a]));
const partyName = new Map(PARTIES.map((p) => [p.n, p.name]));

function live(line: Line, filter: { mode: string; payee?: string }) {
  if (line.draft && filter.mode !== "working") return false;
  if (!filter.payee) return true;
  return filter.payee === "unassigned"
    ? line.party === null
    : line.party !== null && partyId(line.party) === filter.payee;
}
const inRange = (date: string, from?: string, to?: string) =>
  !!from && !!to && date >= from && date <= to;

/** A synthetic profit and loss for any period, comparison, scope and contact. */
export function demoReportData(filter: ReportFilter): ReportData {
  const all = lines().filter((l) => live(l, filter));
  const current = all.filter((l) => inRange(l.date, filter.from, filter.to));
  const previous = all.filter((l) =>
    inRange(l.date, filter.compare_from, filter.compare_to),
  );
  const sum = (set: Line[], match: (l: Line) => boolean) =>
    set.reduce((s, l) => (match(l) ? s + l.cents : s), ZERO);
  const typeOf = (l: Line) => byNumber.get(l.account)!.type;
  const totals = (set: Line[]): ReportTotals => {
    const income = sum(set, (l) => typeOf(l) === "income"),
      expense = sum(set, (l) => typeOf(l) === "expense");
    return {
      income_cents: income.toString(),
      cogs_cents: "0",
      expense_cents: expense.toString(),
      net_cents: (income - expense).toString(),
      assets_cents: "0",
      liabilities_cents: "0",
      equity_cents: "0",
      prior_cents: "0",
      year_cents: (income - expense).toString(),
      difference_cents: "0",
      cash_opening_cents: "0",
      cash_ending_cents: "0",
    };
  };
  const t = totals(current);
  const accounts: ReportAccount[] = ACCOUNTS.map((a) => {
    const signed = (set: Line[]) => {
      if (a.type === "income") return -sum(set, (l) => l.account === a.n);
      if (a.type === "expense") return sum(set, (l) => l.account === a.n);
      // Every receipt and payment runs through checking.
      if (a.n === 1)
        return (
          sum(set, (l) => typeOf(l) === "income") -
          sum(set, (l) => typeOf(l) === "expense")
        );
      return ZERO;
    };
    const period = signed(current),
      compare = signed(previous);
    return {
      id: id(a.n),
      name: a.name,
      code: a.code,
      account_type: a.type,
      normal_side: a.type === "asset" || a.type === "expense" ? "debit" : "credit",
      is_archived: false,
      parent_account_id: null,
      parent_name: null,
      subtype: a.subtype ?? (a.type === "income" ? "revenue" : a.type === "expense" ? "operating_expense" : "other"),
      purpose: a.purpose,
      cash_kind: a.cash ?? "none",
      opening_cents: "0",
      debit_cents: (period > ZERO ? period : ZERO).toString(),
      credit_cents: (period < ZERO ? -period : ZERO).toString(),
      period_cents: period.toString(),
      ending_cents: period.toString(),
      prior_cents: "0",
      year_cents: period.toString(),
      compare_period_cents: compare.toString(),
      compare_ending_cents: compare.toString(),
      compare_prior_cents: "0",
      compare_year_cents: compare.toString(),
    };
  });
  const monthly: ReportData["monthly"] = [];
  for (
    let m = new Date(`${filter.from.slice(0, 7)}-01T00:00:00Z`);
    m.toISOString().slice(0, 7) <= filter.to.slice(0, 7);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
  ) {
    const key = m.toISOString().slice(0, 7);
    const set = current.filter((l) => l.date.startsWith(key));
    const income = sum(set, (l) => typeOf(l) === "income"),
      expense = sum(set, (l) => typeOf(l) === "expense");
    monthly.push({
      month: `${key}-01`,
      income_cents: income.toString(),
      expense_cents: expense.toString(),
      net_cents: (income - expense).toString(),
    });
  }
  const contacts = new Set(
    [...current, ...previous].map((l) => (l.party === null ? "unassigned" : partyId(l.party))),
  );
  const ofContact = (set: Line[], contact: string, type: string) =>
    sum(
      set,
      (l) =>
        typeOf(l) === type &&
        (l.party === null ? "unassigned" : partyId(l.party)) === contact,
    ).toString();
  const drafts = lines().filter(
    (l) => l.draft && inRange(l.date, filter.from, filter.to),
  ).length;
  return {
    legal_name: "Demo Studio LLC",
    revision: "4821",
    definition_version: 1,
    currency: "USD",
    basis: "cash",
    generated_at: `${filter.to}T15:00:00Z`,
    filter: { ...filter, offset: 0 },
    accounts,
    totals: t,
    comparison: filter.compare_from ? totals(previous) : totals([]),
    monthly,
    dimensions: [...contacts].map((contact) => ({
      kind: "payee" as const,
      id: contact,
      name:
        contact === "unassigned"
          ? "Unassigned"
          : (PARTIES.find((p) => partyId(p.n) === contact)?.name ?? "Contact"),
      income_cents: ofContact(current, contact, "income"),
      expense_cents: ofContact(current, contact, "expense"),
      compare_income_cents: ofContact(previous, contact, "income"),
      compare_expense_cents: ofContact(previous, contact, "expense"),
    })),
    cash: [],
    quality: {
      draft_count: drafts,
      unbalanced_drafts: 0,
      unclassified_cash_lines: 0,
      uncategorized_lines: 0,
      reconciliations: [
        { account_id: id(1), through: "2026-08-31" },
        { account_id: id(2), through: "2026-08-31" },
      ],
      feeds: [
        {
          name: "Demo Community Bank",
          last_success_at: "2026-10-03T14:05:00Z",
          status: "active",
        },
      ],
    },
  };
}

/**
 * The monthly comparison as accounting.breakdown answers it: each comparison
 * line lands in the month it compares with (whole months shift by months,
 * anything else by days).
 */
export function demoBreakdown(filter: ReportFilter): BreakdownData {
  const report = demoReportData(filter);
  const all = lines().filter((l) => live(l, filter));
  const monthStart = (d: string) => d.slice(8, 10) === "01";
  const byMonths =
    !!filter.compare_from && monthStart(filter.from) && monthStart(filter.compare_from);
  const monthShift = byMonths
    ? (Number(filter.from.slice(0, 4)) - Number(filter.compare_from!.slice(0, 4))) * 12 +
      Number(filter.from.slice(5, 7)) -
      Number(filter.compare_from!.slice(5, 7))
    : 0;
  const dayShift = filter.compare_from
    ? (Date.parse(filter.from) - Date.parse(filter.compare_from)) / 86400000
    : 0;
  const bucket = (date: string) => {
    if (byMonths) {
      const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + monthShift, 1));
      return d.toISOString().slice(0, 7);
    }
    return new Date(Date.parse(date) + dayShift * 86400000).toISOString().slice(0, 7);
  };
  const compare = new Map<string, { income: bigint; expense: bigint }>();
  for (const l of all) {
    if (!inRange(l.date, filter.compare_from, filter.compare_to)) continue;
    const key = bucket(l.date),
      entry = compare.get(key) ?? { income: ZERO, expense: ZERO };
    if (byNumber.get(l.account)!.type === "income") entry.income += l.cents;
    else if (byNumber.get(l.account)!.type === "expense") entry.expense += l.cents;
    compare.set(key, entry);
  }
  return {
    from: filter.from,
    to: filter.to,
    compare: filter.compare_from
      ? { from: filter.compare_from, to: filter.compare_to! }
      : null,
    rows: report.monthly.map((m) => {
      const c = compare.get(m.month.slice(0, 7)) ?? { income: ZERO, expense: ZERO };
      return {
        key: m.month,
        label: m.month.slice(0, 7),
        count: 0,
        income_cents: m.income_cents,
        expense_cents: m.expense_cents,
        net_cents: m.net_cents,
        ...(filter.compare_from
          ? {
              compare: {
                income_cents: c.income.toString(),
                expense_cents: c.expense.toString(),
                net_cents: (c.income - c.expense).toString(),
              },
            }
          : {}),
      };
    }),
    total: {
      income_cents: report.totals.income_cents,
      expense_cents: report.totals.expense_cents,
      net_cents: report.totals.net_cents,
    },
    revision: report.revision,
  };
}

/** The journal lines behind a drill-down, the way report_lines pages them. */
export async function demoReportDetail(
  filter: ReportFilter,
): Promise<ReportDetail> {
  const matching = lines().filter((l) => {
    const account = byNumber.get(l.account)!;
    return (
      live(l, filter) &&
      inRange(l.date, filter.from, filter.to) &&
      (!filter.account_ids || filter.account_ids.includes(id(l.account))) &&
      (!filter.account_types ||
        (filter.account_types as string[]).includes(account.type))
    );
  });
  let running = ZERO;
  const rows = matching.map((l) => {
    const account = byNumber.get(l.account)!;
    // Journal sign: income is a credit (negative), expense a debit.
    const amount = account.type === "income" ? -l.cents : l.cents;
    running += amount;
    return {
      id: `line-${l.key}`,
      entry_id: `entry-${l.key}`,
      entry_date: l.date,
      memo: `${l.memo}${l.party !== null ? `, ${partyName.get(l.party)}` : ""}`,
      line_memo: "",
      account_id: id(l.account),
      account_name: account.name,
      account_type: account.type,
      amount_cents: amount.toString(),
      running_cents: running.toString(),
      status: l.draft ? "draft" : "posted",
      primary_origin: "bank_feed",
    };
  });
  const offset = filter.offset ?? 0;
  return {
    revision: "4821",
    total: rows.length,
    total_cents: running.toString(),
    opening_cents: "0",
    rows: rows.slice(offset, offset + 100),
  };
}
