import type { RecurringData, RecurringFilter } from "./recurring";
import type { SupportReportData, SupportReportFilter, SupportReportId } from "./support-reports";
import type { TaxAdjustment, TaxConcept, TaxSource } from "./tax-workpapers";
import type { PayrollEmployee } from "./payroll";
import type { RegisterDetail, RegisterView } from "./registers";
import type { PayrollYearRead, PayrollYearRun } from "./payroll-register";
import type {
  BreakdownData,
  BreakdownFilter,
  ReportAccount,
  ReportData,
  ReportDetail,
  ReportFilter,
  ReportTotals,
} from "./reports";

/**
 * A synthetic studio's books for demo mode, so the profit and loss and the
 * balance sheet render in full without a database. Every figure is generated from a fixed seed:
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
  /** A contra account keeps the opposite normal side (accumulated depreciation). */
  contra?: boolean;
};
const ACCOUNTS: DemoAccount[] = [
  { n: 1, code: "1000", name: "Operating checking", type: "asset", purpose: "checking", subtype: "bank", cash: "bank" },
  { n: 2, code: "1010", name: "Reserve savings", type: "asset", purpose: "savings", subtype: "bank", cash: "bank" },
  { n: 3, code: "2000", name: "Business card", type: "liability", purpose: "business_card", subtype: "card", cash: "card" },
  { n: 4, code: "2110", name: "Payroll taxes payable", type: "liability", purpose: "payroll_taxes_payable", subtype: "payroll_liability" },
  { n: 5, code: "2100", name: "Net salary payable", type: "liability", purpose: "net_salary_payable", subtype: "payroll_liability" },
  { n: 6, code: "2500", name: "Equipment loan", type: "liability", purpose: "loans_payable", subtype: "loan" },
  { n: 7, code: "1500", name: "Equipment", type: "asset", purpose: "equipment", subtype: "fixed_asset" },
  { n: 8, code: "1590", name: "Accumulated depreciation", type: "asset", purpose: "accumulated_depreciation", subtype: "accumulated_depreciation", contra: true },
  { n: 9, code: "1200", name: "Transfers in transit", type: "asset", purpose: "transfers_in_transit", subtype: "transit" },
  { n: 40, code: "3100", name: "Owner contributions", type: "equity", purpose: "contributions", subtype: "owner_equity" },
  { n: 41, code: "3200", name: "Owner distributions", type: "equity", purpose: "distributions", subtype: "owner_equity" },
  { n: 42, code: "3300", name: "Owner Investment / Drawings", type: "equity", purpose: "", subtype: "owner_equity" },
  { n: 43, code: "3910", name: "Opening retained earnings", type: "equity", purpose: "opening_retained_earnings", subtype: "retained_earnings" },
  { n: 44, code: "3000", name: "Owner's Equity", type: "equity", purpose: "", subtype: "owner_equity" },
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
  { n: 36, code: "6700", name: "Depreciation", type: "expense", purpose: "depreciation" },
  { n: 37, code: "6990", name: "Uncategorized expense", type: "expense", purpose: "uncategorized_expense" },
  { n: 38, code: "6800", name: "Interest expense", type: "expense", purpose: "interest_expense" },
  { n: 45, code: "2600", name: "Loan from shareholder", type: "liability", purpose: "shareholder_loan", subtype: "loan" },
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
  { n: 9, name: "Adventure Works", roles: ["client"] },
  // A long name, so the lists are seen to truncate rather than scroll sideways.
  { n: 26, name: "Fourth Coffee Roasters and Hospitality Group of the Pacific Northwest", roles: ["client"] },
  { n: 10, name: "Alex Morgan", roles: ["employee", "owner"] },
  { n: 11, name: "Payroll Service Co.", roles: ["vendor"] },
  { n: 12, name: "Federal tax deposits", roles: ["government"] },
  { n: 13, name: "Jordan Rivera Design", roles: ["contractor"], tax: ["individual", "received"] },
  { n: 14, name: "Sam Lee Development", roles: ["contractor"], tax: ["unknown", "missing"] },
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
  { n: 27, name: "Canvas Studio Apps", roles: ["vendor"] },
  { n: 28, name: "Projectly", roles: ["vendor"] },
  // Contractors of every kind, so the contractor worksheet has each case:
  // a corporation, card and bank payments, a foreign contractor, one under
  // the line, one with no W-9, a type of Other and one not paid this year.
  { n: 29, name: "Northbeam Analytics LLC", roles: ["contractor"], tax: ["corporation", "received"] },
  { n: 30, name: "Maya Chen Photography", roles: ["contractor"], tax: ["individual", "missing"] },
  { n: 31, name: "Lucia Ortega Translation", roles: ["contractor"], tax: ["foreign", "not_required"] },
  { n: 32, name: "Riverside Copywriting", roles: ["contractor"], tax: ["individual", "received"] },
  { n: 33, name: "Orbit Event Staffing", roles: ["contractor"], tax: ["individual", "missing"] },
  { n: 34, name: "Quill and Pine Editing", roles: ["contractor"], tax: ["other", "received"] },
  { n: 35, name: "Harbor Bookkeeping Help", roles: ["contractor"], tax: ["individual", "received"] },
] as { n: number; name: string; roles: string[]; tax?: [string, string] }[];

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
        // Litware stops paying after June 2026; Adventure Works starts in May.
        if (!(year === 2026 && party === 5 && month > 6))
          add(year, month, party === 1 ? 14 : 24, 10, party, Math.round((consulting * weight) / 100) * 100, "Client payment");
      if (year === 2026 && month >= 3)
        add(year, month, 2, 11, 2, 350000, "Monthly retainer");
      if (year === 2025 && month === 12)
        add(year, month, 2, 11, 2, 20000, "Retainer deposit");
      if (year === 2026 && month >= 5)
        add(year, month, 18, 10, 9, month === 8 ? 840000 : 240000, "Project milestone");
      if (year === 2026 && month >= 7 && month <= 9)
        add(year, month, 9, 10, 26, 32000 + month * 1000, "Workshop");
      // Two card charges nobody has sorted yet.
      if (year === 2026 && (month === 8 || month === 9))
        add(year, month, 23, 37, null, month === 8 ? 6450 : 12300, "Card charge, not sorted yet");
      // A few deposits nobody has matched to a client yet.
      if (year >= 2025 && month % 3 === 2)
        add(year, month, 21, 10, null, 45000 + month * 1500, "Mobile check deposit");
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
      // Two fixed-price plans: one started in May 2026, one went up in July 2026.
      if (year === 2026 && month >= 5) add(year, month, 15, 21, 27, 4900, "Canvas Studio Apps plan");
      if (year >= 2025) add(year, month, 8, 21, 28, year === 2026 && month >= 7 ? 3900 : 2900, "Projectly plan");
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

/** One journal line: debit positive, credit negative, as the books keep them. */
type JournalLine = { account: number; amount: bigint };
type Entry = {
  key: string;
  date: string;
  memo: string;
  party: number | null;
  draft: boolean;
  lines: JournalLine[];
};

/** Expenses the studio puts on the business card; the rest leave checking. */
const CARD_PAID = new Set([21, 22, 23, 24, 27, 29, 35, 37]);
const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (year: number, month: number) => `${year}-${pad(month)}`;

/**
 * The studio's whole journal, double entry. Every profit and loss line above
 * becomes an entry against checking, savings, the card or payroll taxes
 * payable; balance-sheet activity is added around it: the opening capital
 * and retained earnings, card payments, payroll tax deposits, an equipment
 * loan, a laptop, quarterly owner distributions, savings transfers and one
 * payroll advance that leaves Net salary payable below zero.
 */
let journal: Entry[] | null = null;
function entries(): Entry[] {
  if (journal) return journal;
  const out: Entry[] = [];
  const push = (
    date: string,
    memo: string,
    party: number | null,
    lines: JournalLine[],
    draft = false,
    key = `${date}-j${out.length}`,
  ) => out.push({ key, date, memo, party, draft, lines });
  const cards = new Map<string, bigint>(),
    taxes = new Map<string, bigint>();
  const accrue = (map: Map<string, bigint>, date: string, amount: bigint) =>
    map.set(date.slice(0, 7), (map.get(date.slice(0, 7)) ?? ZERO) + amount);
  for (const l of lines()) {
    const a = byNumber.get(l.account)!;
    let counter: JournalLine[];
    if (a.type === "income")
      counter = [{ account: l.account === 14 ? 2 : 1, amount: l.cents }];
    else if (l.account === 31) {
      // Net pay leaves checking; the withholding waits in payroll taxes payable.
      const withheld = (l.cents * BigInt(20)) / BigInt(100);
      counter = [
        { account: 1, amount: -(l.cents - withheld) },
        { account: 4, amount: -withheld },
      ];
      accrue(taxes, l.date, withheld);
    } else if (l.account === 32) {
      counter = [{ account: 4, amount: -l.cents }];
      accrue(taxes, l.date, l.cents);
    } else if (CARD_PAID.has(l.account)) {
      counter = [{ account: 3, amount: -l.cents }];
      accrue(cards, l.date, l.cents);
    } else counter = [{ account: 1, amount: -l.cents }];
    push(
      l.date,
      l.memo,
      l.party,
      [
        { account: l.account, amount: a.type === "income" ? -l.cents : l.cents },
        ...counter,
      ],
      l.draft,
      l.key,
    );
  }
  const move = (
    date: string,
    memo: string,
    party: number | null,
    debit: number,
    credit: number,
    cents: number | bigint,
  ) => {
    const amount = BigInt(cents);
    if (amount > ZERO)
      push(date, memo, party, [
        { account: debit, amount },
        { account: credit, amount: -amount },
      ]);
  };
  move("2023-12-31", "Opening balance from the prior books", null, 1, 43, 800000);
  move("2024-01-02", "Owner contribution", 10, 1, 40, 2500000);
  // One owner account carries money both ways, as imported charts often do.
  move("2024-06-03", "Owner transfer in", 10, 1, 42, 150000);
  move("2024-11-15", "Owner transfer in", 10, 1, 42, 1200000);
  move("2025-03-10", "Owner draw", 10, 42, 1, 450000);
  move("2025-09-22", "Owner transfer in", 10, 1, 42, 600000);
  move("2026-01-12", "Owner draw", 10, 42, 1, 900000);
  move("2026-07-08", "Owner draw", 10, 42, 1, 350000);
  move("2023-12-31", "Opening owner's equity", null, 1, 44, 215500);
  move("2025-02-03", "Equipment loan funded", 7, 1, 6, 1000000);
  move("2025-06-12", "Laptop", null, 7, 3, 320000);
  accrue(cards, "2025-06-12", BigInt(320000));
  move("2026-08-29", "Payroll advance", 10, 5, 1, 25000);
  // Sent on the last day of September, landed in October.
  move("2026-09-30", "Transfer to savings", null, 9, 1, 500000);
  move("2026-10-01", "Transfer from checking", null, 2, 9, 500000);
  let loan = BigInt(1000000);
  for (let year = 2024; year <= 2026; year++)
    for (let month = 1; month <= 12; month++) {
      const key = monthKey(year, month);
      const next = month === 12 ? monthKey(year + 1, 1) : monthKey(year, month + 1);
      // Last month's card charges are paid on the 25th; payroll taxes on the 15th.
      move(`${next}-25`, "Card payment", null, 9, 1, cards.get(key) ?? ZERO);
      move(`${next}-26`, "Card payment received", null, 3, 9, cards.get(key) ?? ZERO);
      move(`${next}-15`, "Payroll tax deposit", 12, 4, 1, taxes.get(key) ?? ZERO);
      if (month % 3 === 0)
        move(
          `${key}-28`,
          "Owner distribution",
          10,
          41,
          1,
          year === 2024 ? 600000 : year === 2025 ? 1200000 : 1500000,
        );
      if (year >= 2025 && month % 3 === 1)
        move(`${key}-05`, "Transfer to savings", null, 9, 1, 300000);
      if (year >= 2025 && month % 3 === 1)
        move(`${key}-06`, "Transfer from checking", null, 2, 9, 300000);
      // Equipment wears out over three years: an expense, but no cash leaves.
      if (key >= "2025-07")
        move(`${key}-28`, "Depreciation", null, 36, 8, 8889);
      if (key >= "2025-03" && loan > ZERO) {
        move(`${key}-20`, "Loan payment", 7, 6, 1, BigInt(50000));
        loan -= BigInt(50000);
      }
    }
  // The other contractors, after everything else so the entries above keep
  // their keys. Paid from checking unless noted; one card charge is paid off
  // the next month like the rest of the card.
  const paid = (date: string, party: number, cents: number, memo: string) =>
    move(date, memo, party, 20, 1, cents);
  paid("2024-11-12", 35, 140000, "Year-end catch-up");
  paid("2025-10-15", 29, 180000, "Analytics setup");
  paid("2025-09-09", 32, 90000, "Website copy");
  paid("2026-03-19", 29, 240000, "Dashboard build");
  paid("2026-07-16", 29, 240000, "Dashboard build");
  paid("2026-02-26", 31, 160000, "Translation, Spanish site");
  paid("2026-06-25", 31, 200000, "Translation, onboarding guides");
  paid("2026-05-07", 32, 140000, "Case study copy");
  paid("2026-08-27", 33, 275000, "Event staff, client launch");
  paid("2026-09-10", 34, 220000, "Editing, annual report");
  paid("2026-08-12", 30, 65000, "Headshots, prints");
  move("2026-04-22", "Product photography", 30, 20, 3, 185000);
  move("2026-05-25", "Card payment", null, 9, 1, 185000);
  move("2026-05-26", "Card payment received", null, 3, 9, 185000);
  // Jordan returned a deposit for sprint hours not used.
  move("2026-05-14", "Refund, unused sprint hours", 13, 1, 20, 30000);
  // A camera kit in the asset register, depreciated monthly, and a monitor
  // arm booked to Equipment outside the register.
  move("2026-02-18", "Studio camera kit", null, 7, 1, 240000);
  for (let month = 3; month <= 12; month++)
    move(`2026-${pad(month)}-28`, "Depreciation, camera kit", null, 36, 8, 6667);
  move("2026-08-05", "Monitor arm and dock", null, 7, 1, 38000);
  // The owner lent the business $5,000 in April 2026, repaid $500 a month
  // with interest at half a percent a month on what is still owed.
  move("2026-04-15", "Loan from Alex Morgan", 10, 1, 45, 500000);
  let lent = BigInt(500000);
  for (let month = 5; month <= 12 && lent > ZERO; month++) {
    const interest = lent / BigInt(200);
    push(`2026-${pad(month)}-15`, "Shareholder loan payment", 10, [
      { account: 45, amount: BigInt(50000) },
      { account: 38, amount: interest },
      { account: 1, amount: -(BigInt(50000) + interest) },
    ]);
    lent -= BigInt(50000);
  }
  journal = out.sort((a, b) => a.date.localeCompare(b.date));
  return journal;
}

function live(entry: Entry, filter: { mode: string; payee?: string }) {
  if (entry.draft && filter.mode !== "working") return false;
  if (!filter.payee) return true;
  return filter.payee === "unassigned"
    ? entry.party === null
    : entry.party !== null && partyId(entry.party) === filter.payee;
}
const inRange = (date: string, from?: string, to?: string) =>
  !!from && !!to && date >= from && date <= to;
const typeOf = (n: number) => byNumber.get(n)!.type;
const yearStart = (date: string) => `${date.slice(0, 4)}-01-01`;

/** Sum the lines of `set` that pass `match`. */
function total(
  set: Entry[],
  match: (line: JournalLine, entry: Entry) => boolean,
): bigint {
  let s = ZERO;
  for (const e of set) for (const l of e.lines) if (match(l, e)) s += l.amount;
  return s;
}

/** A synthetic report for any period or as-of date, comparison, scope and contact. */
export function demoReportData(filter: ReportFilter): ReportData {
  const all = entries().filter((e) => live(e, filter));
  const comparing = !!filter.compare_from && !!filter.compare_to;
  const until = (date?: string) => all.filter((e) => !!date && e.date <= date);
  const between = (from?: string, to?: string) =>
    all.filter((e) => inRange(e.date, from, to));
  const current = between(filter.from, filter.to);
  const previous = comparing
    ? between(filter.compare_from, filter.compare_to)
    : [];
  const ending = until(filter.to),
    compareEnding = comparing ? until(filter.compare_to) : [];
  const before = (date: string) => all.filter((e) => e.date < date);
  const priorSet = before(yearStart(filter.to)),
    yearSet = between(yearStart(filter.to), filter.to);
  const comparePrior = comparing ? before(yearStart(filter.compare_to!)) : [],
    compareYear = comparing
      ? between(yearStart(filter.compare_to!), filter.compare_to)
      : [];
  const of = (n: number) => (l: JournalLine) => l.account === n;
  const ofType = (type: string) => (l: JournalLine) => typeOf(l.account) === type;
  const result = (l: JournalLine) =>
    typeOf(l.account) === "income" || typeOf(l.account) === "expense";
  const totals = (
    period: Entry[],
    end: Entry[],
    prior: Entry[],
    year: Entry[],
    start = filter.from,
  ): ReportTotals => {
    const income = -total(period, ofType("income")),
      expense = total(period, ofType("expense")),
      assets = total(end, ofType("asset")),
      liabilities = -total(end, ofType("liability")),
      equity = -total(end, ofType("equity")),
      priorProfit = -total(prior, result),
      yearProfit = -total(year, result);
    return {
      income_cents: income.toString(),
      cogs_cents: "0",
      expense_cents: expense.toString(),
      net_cents: (income - expense).toString(),
      assets_cents: assets.toString(),
      liabilities_cents: liabilities.toString(),
      equity_cents: equity.toString(),
      prior_cents: priorProfit.toString(),
      year_cents: yearProfit.toString(),
      difference_cents: (
        assets -
        liabilities -
        equity -
        priorProfit -
        yearProfit
      ).toString(),
      cash_opening_cents: total(
        before(start),
        (l) => ["bank", "cash"].includes(byNumber.get(l.account)!.cash ?? ""),
      ).toString(),
      cash_ending_cents: total(end, (l) =>
        ["bank", "cash"].includes(byNumber.get(l.account)!.cash ?? ""),
      ).toString(),
    };
  };
  const accounts: ReportAccount[] = ACCOUNTS.map((a) => {
    const period = total(current, of(a.n)),
      opening = total(before(filter.from), of(a.n));
    const debit = current.reduce(
      (s, e) =>
        s + e.lines.reduce((t, l) => (l.account === a.n && l.amount > ZERO ? t + l.amount : t), ZERO),
      ZERO,
    );
    return {
      id: id(a.n),
      name: a.name,
      code: a.code,
      account_type: a.type,
      normal_side:
        (a.type === "asset" || a.type === "expense") !== !!a.contra
          ? "debit"
          : "credit",
      is_archived: false,
      parent_account_id: null,
      parent_name: null,
      subtype:
        a.subtype ??
        (a.type === "income"
          ? "revenue"
          : a.type === "expense"
            ? "operating_expense"
            : "other"),
      purpose: a.purpose || null,
      cash_kind: a.cash ?? "none",
      opening_cents: opening.toString(),
      debit_cents: debit.toString(),
      credit_cents: (debit - period).toString(),
      period_cents: period.toString(),
      ending_cents: total(ending, of(a.n)).toString(),
      prior_cents: total(priorSet, of(a.n)).toString(),
      year_cents: total(yearSet, of(a.n)).toString(),
      compare_period_cents: total(previous, of(a.n)).toString(),
      compare_ending_cents: total(compareEnding, of(a.n)).toString(),
      compare_prior_cents: total(comparePrior, of(a.n)).toString(),
      compare_year_cents: total(compareYear, of(a.n)).toString(),
    };
  });
  const monthly: ReportData["monthly"] = [];
  for (
    let m = new Date(`${filter.from.slice(0, 7)}-01T00:00:00Z`);
    m.toISOString().slice(0, 7) <= filter.to.slice(0, 7);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
  ) {
    const key = m.toISOString().slice(0, 7);
    const set = current.filter((e) => e.date.startsWith(key));
    const income = -total(set, ofType("income")),
      expense = total(set, ofType("expense"));
    monthly.push({
      month: `${key}-01`,
      income_cents: income.toString(),
      expense_cents: expense.toString(),
      net_cents: (income - expense).toString(),
    });
  }
  const contactOf = (e: Entry) =>
    e.party === null ? "unassigned" : partyId(e.party);
  const touched = [...current, ...previous].filter((e) => e.lines.some(result));
  const contacts = new Set(touched.map(contactOf));
  const ofContact = (set: Entry[], contact: string, type: "income" | "expense") => {
    const amount = total(
      set,
      (l, e) => typeOf(l.account) === type && contactOf(e) === contact,
    );
    return (type === "income" ? -amount : amount).toString();
  };
  const drafts = entries().filter(
    (e) => e.draft && inRange(e.date, filter.from, filter.to),
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
    totals: totals(current, ending, priorSet, yearSet),
    comparison: totals(
      previous,
      compareEnding,
      comparePrior,
      compareYear,
      filter.compare_from ?? filter.from,
    ),
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
  const all = entries().filter((e) => live(e, filter));
  const monthStart = (d: string) => d.slice(8, 10) === "01";
  const byMonths =
    !!filter.compare_from &&
    monthStart(filter.from) &&
    monthStart(filter.compare_from);
  const monthShift = byMonths
    ? (Number(filter.from.slice(0, 4)) -
        Number(filter.compare_from!.slice(0, 4))) *
        12 +
      Number(filter.from.slice(5, 7)) -
      Number(filter.compare_from!.slice(5, 7))
    : 0;
  const dayShift = filter.compare_from
    ? (Date.parse(filter.from) - Date.parse(filter.compare_from)) / 86400000
    : 0;
  const bucket = (date: string) => {
    if (byMonths) {
      const d = new Date(
        Date.UTC(
          Number(date.slice(0, 4)),
          Number(date.slice(5, 7)) - 1 + monthShift,
          1,
        ),
      );
      return d.toISOString().slice(0, 7);
    }
    return new Date(Date.parse(date) + dayShift * 86400000)
      .toISOString()
      .slice(0, 7);
  };
  const compare = new Map<string, { income: bigint; expense: bigint }>();
  for (const e of all) {
    if (!inRange(e.date, filter.compare_from, filter.compare_to)) continue;
    const key = bucket(e.date),
      entry = compare.get(key) ?? { income: ZERO, expense: ZERO };
    for (const l of e.lines) {
      if (typeOf(l.account) === "income") entry.income -= l.amount;
      else if (typeOf(l.account) === "expense") entry.expense += l.amount;
    }
    compare.set(key, entry);
  }
  return {
    from: filter.from,
    to: filter.to,
    compare: filter.compare_from
      ? { from: filter.compare_from, to: filter.compare_to! }
      : null,
    rows: report.monthly.map((m) => {
      const c = compare.get(m.month.slice(0, 7)) ?? {
        income: ZERO,
        expense: ZERO,
      };
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

/**
 * Month-end balances as accounting.breakdown answers measure balance: each
 * account on its normal side (assets and expenses debit positive, the rest
 * credit positive), for the accounts asked for, or by default bank and cash.
 */
export function demoBalanceBreakdown(filter: BreakdownFilter): BreakdownData {
  const chosen = ACCOUNTS.filter((a) =>
    filter.account_ids
      ? filter.account_ids.includes(id(a.n))
      : filter.account_types
        ? (filter.account_types as string[]).includes(a.type)
        : a.subtype === "bank" || a.subtype === "cash",
  );
  const sign = new Map(
    chosen.map((a) => [
      a.n,
      // As the books sign a balance: the normal side positive, so a contra
      // asset such as accumulated depreciation reads credit positive.
      (a.type === "asset" || a.type === "expense") !== !!a.contra
        ? BigInt(1)
        : BigInt(-1),
    ]),
  );
  const all = entries().filter((e) => live(e, { mode: filter.mode }));
  const balanceAt = (date: string) => {
    let s = ZERO;
    for (const e of all)
      if (e.date <= date)
        for (const l of e.lines)
          if (sign.has(l.account)) s += l.amount * sign.get(l.account)!;
    return s;
  };
  const rows: BreakdownData["rows"] = [];
  for (
    let m = new Date(`${filter.from.slice(0, 7)}-01T00:00:00Z`);
    m.toISOString().slice(0, 7) <= filter.to.slice(0, 7);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
  ) {
    const key = m.toISOString().slice(0, 10);
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    rows.push({
      key,
      label: key.slice(0, 7),
      count: 0,
      balance_cents: balanceAt(end < filter.to ? end : filter.to).toString(),
    });
  }
  return {
    from: filter.from,
    to: filter.to,
    compare: null,
    rows,
    total: { balance_cents: balanceAt(filter.to).toString() },
    revision: "4821",
  };
}

/** The journal lines behind a drill-down, the way report_lines pages them. */
export async function demoReportDetail(
  filter: ReportFilter,
): Promise<ReportDetail> {
  // As accounting.report_lines answers: each line's running balance is its
  // account's balance through that line, from the start of the books, and
  // the opening is everything in scope before the first date.
  const rows: ReportDetail["rows"] = [];
  const running = new Map<number, bigint>();
  let opening = ZERO,
    inRangeTotal = ZERO;
  for (const e of entries()) {
    if (!live(e, filter) || e.date > filter.to) continue;
    e.lines.forEach((l, i) => {
      const account = byNumber.get(l.account)!;
      if (filter.account_ids && !filter.account_ids.includes(id(l.account)))
        return;
      if (
        filter.account_types &&
        !(filter.account_types as string[]).includes(account.type)
      )
        return;
      const balance = (running.get(l.account) ?? ZERO) + l.amount;
      running.set(l.account, balance);
      if (e.date < filter.from) {
        opening += l.amount;
        return;
      }
      inRangeTotal += l.amount;
      rows.push({
        id: `line-${e.key}-${i}`,
        entry_id: `entry-${e.key}`,
        entry_date: e.date,
        memo: `${e.memo}${e.party !== null ? `, ${partyName.get(e.party)}` : ""}`,
        line_memo: "",
        account_id: id(l.account),
        account_name: account.name,
        account_type: account.type,
        amount_cents: l.amount.toString(),
        running_cents: balance.toString(),
        status: e.draft ? "draft" : "posted",
        primary_origin: "bank_feed",
      });
    });
  }
  const offset = filter.offset ?? 0;
  return {
    revision: "4821",
    total: rows.length,
    total_cents: inRangeTotal.toString(),
    opening_cents: opening.toString(),
    rows: rows.slice(offset, offset + 100),
  };
}

/**
 * Recurring charges as accounting.recurring finds them, from the synthetic
 * journal: money out on exactly one bank, card or cash line that pays an
 * expense, grouped by contact (or description), with a cadence when the
 * median gap and most gaps fit one. Stopped once one and a half beats pass.
 */
export function demoRecurring(filter: RecurringFilter): RecurringData {
  const asOf = filter.as_of;
  const since = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 1 - 37, Number(asOf.slice(8, 10))))
    .toISOString()
    .slice(0, 10);
  const money = new Set(ACCOUNTS.filter((a) => ["bank", "card", "cash"].includes(a.subtype ?? "")).map((a) => a.n));
  type Occurrence = { date: string; amount: bigint; category: number; bank: number; party: number | null; memo: string };
  const series = new Map<string, Occurrence[]>();
  for (const e of entries()) {
    if (e.date < since || e.date > asOf || !live(e, { mode: filter.mode })) continue;
    const banks = e.lines.filter((l) => money.has(l.account));
    const expenses = e.lines.filter((l) => typeOf(l.account) === "expense").sort((a, b) => (b.amount > a.amount ? 1 : -1));
    if (banks.length !== 1 || banks[0].amount >= ZERO || !expenses.length) continue;
    const key = e.party !== null ? `c:${e.party}` : `d:${e.memo}`;
    const list = series.get(key) ?? [];
    const same = list.find((o) => o.date === e.date);
    if (same) same.amount += -banks[0].amount;
    else
      list.push({ date: e.date, amount: -banks[0].amount, category: expenses[0].account, bank: banks[0].account, party: e.party, memo: e.memo });
    series.set(key, list);
  }
  const cadences = [
    { cadence: "weekly" as const, months: 0, days: 7, low: 5, high: 9, nominal: 7, perYear: 52 },
    { cadence: "monthly" as const, months: 1, days: 0, low: 25, high: 35, nominal: 30, perYear: 12 },
    { cadence: "quarterly" as const, months: 3, days: 0, low: 80, high: 100, nominal: 91, perYear: 4 },
    { cadence: "annual" as const, months: 12, days: 0, low: 330, high: 400, nominal: 365, perYear: 1 },
  ];
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const found: (RecurringData["series"][number] & { annual: bigint })[] = [];
  for (const [, list] of series) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = list.slice(1).map((o, i) => day(o.date) - day(list[i].date));
    const sorted = [...gaps].sort((a, b) => a - b);
    const mid = (sorted.length - 1) / 2;
    const median = (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
    const fit = cadences.find(
      (c) => median >= c.low && median <= c.high && gaps.filter((g) => g >= c.low && g <= c.high).length / gaps.length >= 0.6,
    );
    if (!fit) continue;
    const last = list.at(-1)!,
      previous = list.at(-2)!;
    const changes = list
      .map((o, i) => (i > 0 && list[i - 1].amount !== o.amount ? { on: o.date, from_cents: list[i - 1].amount.toString(), to_cents: o.amount.toString() } : null))
      .filter((c) => c !== null);
    const next = new Date(`${last.date}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + fit.months);
    next.setUTCDate(next.getUTCDate() + fit.days);
    const annual = last.amount * BigInt(fit.perYear);
    found.push({
      contact: last.party !== null ? { id: partyId(last.party), name: partyName.get(last.party) ?? "Contact" } : null,
      descriptor_key: last.party === null ? last.memo : null,
      category: byNumber.get(last.category)!.name,
      bank_account: byNumber.get(last.bank)!.name,
      cadence: fit.cadence,
      count: list.length,
      first_date: list[0].date,
      last_date: last.date,
      next_expected: next.toISOString().slice(0, 10),
      status: day(asOf) - day(last.date) > 1.5 * fit.nominal ? "stopped" : "active",
      last_cents: last.amount.toString(),
      previous_cents: previous.amount.toString(),
      average_cents: (list.reduce((s, o) => s + o.amount, ZERO) / BigInt(list.length)).toString(),
      price_change: changes.at(-1) ?? null,
      annual_cents: annual.toString(),
      annual,
    });
  }
  found.sort((a, b) =>
    a.status !== b.status ? (a.status === "stopped" ? 1 : -1) : b.annual > a.annual ? 1 : b.annual < a.annual ? -1 : b.last_date.localeCompare(a.last_date),
  );
  const wanted = filter.status ?? "all";
  const listed = found.filter((s) => wanted === "all" || s.status === wanted);
  const offset = filter.offset ?? 0,
    limit = filter.limit ?? 50;
  const activeAnnual = found.filter((s) => s.status === "active").reduce((s, r) => s + r.annual, ZERO);
  return {
    as_of: asOf,
    from: since,
    book_mode: filter.mode,
    total: listed.length,
    offset,
    limit,
    totals: {
      active: found.filter((s) => s.status === "active").length,
      stopped: found.filter((s) => s.status === "stopped").length,
      active_annual_cents: activeAnnual.toString(),
      active_monthly_cents: ((activeAnnual * BigInt(2) + BigInt(12)) / BigInt(24)).toString(),
    },
    series: listed.slice(offset, offset + limit).map((s) => {
      const { annual, ...rest } = s;
      void annual;
      return rest;
    }),
  };
}

/**
 * Monthly activity on chosen accounts, as accounting.breakdown answers it
 * with account_ids (measure activity): each month's income and expense on
 * those accounts only.
 */
export function demoAccountActivity(filter: BreakdownFilter): BreakdownData {
  const wanted = new Set(filter.account_ids ?? []);
  const rows: BreakdownData["rows"] = [];
  const all = entries().filter((e) => live(e, { mode: filter.mode }) && inRange(e.date, filter.from, filter.to));
  for (
    let m = new Date(`${filter.from.slice(0, 7)}-01T00:00:00Z`);
    m.toISOString().slice(0, 7) <= filter.to.slice(0, 7);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
  ) {
    const key = m.toISOString().slice(0, 7);
    let income = ZERO,
      expense = ZERO;
    for (const e of all)
      if (e.date.startsWith(key))
        for (const l of e.lines)
          if (wanted.has(id(l.account))) {
            if (typeOf(l.account) === "income") income -= l.amount;
            else if (typeOf(l.account) === "expense") expense += l.amount;
          }
    rows.push({
      key: `${key}-01`,
      label: key,
      count: 0,
      income_cents: income.toString(),
      expense_cents: expense.toString(),
      net_cents: (income - expense).toString(),
    });
  }
  const sumOf = (k: "income_cents" | "expense_cents") =>
    rows.reduce((s, r) => s + BigInt(r[k] ?? "0"), ZERO);
  return {
    from: filter.from,
    to: filter.to,
    compare: null,
    rows,
    total: {
      income_cents: sumOf("income_cents").toString(),
      expense_cents: sumOf("expense_cents").toString(),
      net_cents: (sumOf("income_cents") - sumOf("expense_cents")).toString(),
    },
    revision: "4821",
  };
}

/** The support reports the demo can show; the others need real books. */
export const DEMO_SUPPORT_REPORTS: readonly SupportReportId[] = [
  "contractor-worksheet",
  "tax-workpapers",
  "payroll-register",
  "asset-register",
  "loan-register",
];

/**
 * A support report as accounting.support_report answers it, from the
 * synthetic journal. The contractor worksheet: every contact with the
 * contractor role, with reviewed payments in the calendar year from bank
 * and cash accounts (net of refunds) and from the card, as the books split
 * them.
 */
export function demoSupportReport(filter: SupportReportFilter): SupportReportData {
  if (filter.report_id === "tax-workpapers") return demoTaxWorkpapers(filter);
  if (filter.report_id === "payroll-register") return demoPayrollRegister(filter);
  if (filter.report_id === "asset-register") return demoAssetRegister(filter);
  if (filter.report_id === "loan-register") return demoLoanRegister(filter);
  if (filter.report_id !== "contractor-worksheet")
    throw new Error("This report is available with your own books.");
  const year = filter.to.slice(0, 4);
  const from = `${year}-01-01`;
  const subtype = new Map(ACCOUNTS.map((a) => [a.n, a.subtype]));
  const rows = PARTIES.filter((p) => p.roles.includes("contractor"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      let cash = ZERO,
        card = ZERO;
      for (const e of entries()) {
        if (e.draft || e.party !== p.n || e.date < from || e.date > filter.to) continue;
        for (const l of e.lines) {
          const kind = subtype.get(l.account);
          if (kind === "bank" || kind === "cash") cash -= l.amount;
          if (kind === "card") card -= l.amount;
        }
      }
      const [kind, w9] = p.tax ?? ["unknown", "missing"];
      return {
        id: partyId(p.n),
        contractor_party_id: partyId(p.n),
        cells: [p.name, kind, w9, cash.toString(), card.toString()],
      };
    });
  const sum = (i: number) => rows.reduce((s, r) => s + BigInt(r.cells[i]), ZERO).toString();
  const line = Number(year) >= 2026 ? "200000" : "60000";
  return {
    definition_version: 1,
    report_id: "contractor-worksheet",
    legal_name: "Demo Studio LLC",
    revision: "4821",
    filter: { ...filter, from },
    columns: [
      { label: "Payee", numeric: false },
      { label: "Classification", numeric: false },
      { label: "Documentation", numeric: false },
      { label: "Cash paid net of refunds", numeric: true },
      { label: "Card payments excluded", numeric: true },
    ],
    rows: rows.slice(filter.offset, filter.offset + 100),
    count: rows.length,
    total_cells: ["Total", "", "", sum(3), sum(4)],
    notes: [
      `Annual reporting threshold in cents: ${line}. Owner classifications and exclusions require review; this worksheet does not file a return.`,
    ],
  };
}

/**
 * The demo's tax treatments: each income and expense account's treatment
 * as the workpapers editor stores it. Education and Uncategorized expense
 * have none in 2026, so the workpapers show what is not ready.
 */
const DEMO_TREATMENTS: Record<number, { concept: string; bps?: number; separately?: boolean }> = {
  10: { concept: "gross_receipts" },
  11: { concept: "gross_receipts" },
  12: { concept: "gross_receipts" },
  13: { concept: "gross_receipts" },
  14: { concept: "interest", separately: true },
  20: { concept: "other_deduction" },
  21: { concept: "other_deduction" },
  22: { concept: "other_deduction" },
  23: { concept: "other_deduction" },
  24: { concept: "advertising" },
  25: { concept: "other_deduction" },
  26: { concept: "other_deduction" },
  27: { concept: "other_deduction" },
  28: { concept: "travel" },
  29: { concept: "meals_50", bps: 5000 },
  30: { concept: "other_deduction" },
  31: { concept: "officer_compensation" },
  32: { concept: "payroll_taxes" },
  33: { concept: "other_deduction" },
  34: { concept: "other_deduction" },
  35: { concept: "other_deduction" },
  36: { concept: "depreciation" },
  37: { concept: "other_deduction" },
  38: { concept: "interest" },
};
const DEMO_UNTREATED: Record<number, number[]> = { 2026: [35, 37] };
const DEDUCTIBLE_TREATMENTS = new Set([
  "cogs",
  "officer_compensation",
  "salaries",
  "payroll_taxes",
  "rent",
  "advertising",
  "meals_50",
  "travel",
  "depreciation",
  "interest",
  "other_deduction",
]);
const SEPARATE_ADJUSTMENTS = new Set([
  "stock_basis_opening",
  "debt_basis_opening",
  "interest",
  "qualified_dividend",
  "short_gain",
  "long_gain",
  "charity",
  "tax_exempt",
]);
const DEMO_DOCUMENT = "d2000000-0000-4000-8000-000000000001";
const DEMO_OWNER = "d4000000-0000-4000-8000-000000000001";

/** The owner's adjustments in the demo: one without its document. */
function demoAdjustments(year: number, through: string): TaxAdjustment[] {
  const list: [string, string, string, string, string | null][] =
    year === 2026
      ? [
          ["2026-03-20", "ordinary_adjustment", "15000", "State late-filing penalty added back", null],
          ["2026-06-30", "ordinary_adjustment", "-213300", "Tax depreciation above book on the laptop", DEMO_DOCUMENT],
          ["2026-09-15", "charity", "50000", "Donation to the local food bank", DEMO_DOCUMENT],
        ]
      : year === 2025
        ? [["2025-12-31", "ordinary_adjustment", "-106700", "Tax depreciation above book on the laptop", DEMO_DOCUMENT]]
        : [];
  return list
    .filter(([date]) => date <= through)
    .map(([date, concept, amount, reason, document], i) => ({
      id: `d3000000-0000-4000-8000-${String(year * 10 + i).padStart(12, "0")}`,
      adjustment_key: `d3100000-0000-4000-8000-${String(year * 10 + i).padStart(12, "0")}`,
      tax_year: year,
      version: 1,
      document_id: document,
      reason,
      created_at: `${date}T12:00:00Z`,
      created_by: DEMO_OWNER,
      effective_date: date,
      concept: concept as TaxAdjustment["concept"],
      amount_cents: amount,
      active: true,
      current: true,
    }));
}

/** amount x bps / 10000, rounded half away from zero, as Postgres round() does. */
const roundShare = (amount: bigint, bps: bigint) => {
  const whole = ((amount < ZERO ? -amount : amount) * bps + BigInt(5000)) / BigInt(10000);
  return amount < ZERO ? -whole : whole;
};

/** The tax source as accounting.tax_source builds it, from the synthetic journal. */
export function demoTaxSource(year: number, through: string): TaxSource {
  const from = `${year}-01-01`;
  const untreated = new Set(DEMO_UNTREATED[year] ?? []);
  const treatment = (n: number) => (untreated.has(n) ? undefined : DEMO_TREATMENTS[n]);
  const sums = new Map<number, { book: bigint; ordinary: bigint; n: number }>();
  const months = new Map<string, { book: bigint; ordinary: bigint }>();
  for (const e of entries()) {
    if (e.draft || e.date < from || e.date > through) continue;
    for (const l of e.lines) {
      const a = byNumber.get(l.account)!;
      if (a.type !== "income" && a.type !== "expense") continue;
      const m = treatment(l.account);
      const book = -l.amount;
      const bps = BigInt(m?.bps ?? 10000);
      // As accounting.tax_lines counts it: receipts in full, deductions at
      // their share (rounded half up), everything else nothing.
      const ordinary =
        !m || m.separately
          ? ZERO
          : m.concept === "gross_receipts"
            ? book
            : DEDUCTIBLE_TREATMENTS.has(m.concept)
              ? -roundShare(l.amount, bps)
              : ZERO;
      const s = sums.get(l.account) ?? { book: ZERO, ordinary: ZERO, n: 0 };
      sums.set(l.account, { book: s.book + book, ordinary: s.ordinary + ordinary, n: s.n + 1 });
      const key = `${e.date.slice(0, 7)}-01`;
      const mm = months.get(key) ?? { book: ZERO, ordinary: ZERO };
      months.set(key, { book: mm.book + book, ordinary: mm.ordinary + ordinary });
    }
  }
  const adjustments = demoAdjustments(year, through);
  const accounts = ACCOUNTS.filter((a) => a.type === "income" || a.type === "expense")
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => {
      const m = treatment(a.n);
      const s = sums.get(a.n) ?? { book: ZERO, ordinary: ZERO, n: 0 };
      return {
        account_id: id(a.n),
        name: a.name,
        code: a.code,
        account_type: a.type as "income" | "expense",
        mapping: m
          ? {
              id: `d5000000-0000-4000-8000-${String(year * 100 + a.n).padStart(12, "0")}`,
              tax_year: year,
              version: 1,
              document_id: null,
              reason: "",
              created_at: `${year}-01-15T12:00:00Z`,
              created_by: DEMO_OWNER,
              account_id: id(a.n),
              // The books store the treatment token (meals_50, other_deduction).
              concept: m.concept as TaxConcept,
              deductible_bps: m.bps ?? 10000,
              separately_stated: !!m.separately,
            }
          : null,
        book_cents: s.book.toString(),
        ordinary_cents: s.ordinary.toString(),
        line_count: s.n,
        current: !!m,
      };
    });
  const book = [...sums.values()].reduce((t, s) => t + s.book, ZERO);
  const ordinary = [...sums.values()].reduce((t, s) => t + s.ordinary, ZERO);
  const adjusted =
    ordinary +
    adjustments
      .filter((a) => !SEPARATE_ADJUSTMENTS.has(a.concept))
      .reduce((t, a) => t + BigInt(a.amount_cents), ZERO);
  const separately: Record<string, bigint> = {};
  for (const a of accounts)
    if (a.mapping?.separately_stated)
      separately[a.mapping.concept] = (separately[a.mapping.concept] ?? ZERO) + BigInt(a.book_cents);
  for (const a of adjustments)
    if (SEPARATE_ADJUSTMENTS.has(a.concept) && !a.concept.endsWith("_basis_opening"))
      separately[a.concept] = (separately[a.concept] ?? ZERO) + BigInt(a.amount_cents);
  const monthly: TaxSource["monthly"] = [];
  for (let m = 1; m <= Number(through.slice(5, 7)); m++) {
    const key = `${year}-${pad(m)}-01`;
    const end = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    const adj = adjustments
      .filter((a) => !SEPARATE_ADJUSTMENTS.has(a.concept) && a.effective_date.slice(0, 7) === key.slice(0, 7))
      .reduce((t, a) => t + BigInt(a.amount_cents), ZERO);
    const v = months.get(key) ?? { book: ZERO, ordinary: ZERO };
    monthly.push({
      month: key,
      book_cents: v.book.toString(),
      ordinary_cents: (v.ordinary + adj).toString(),
      // The demo closed every month through June 2026.
      complete: end <= through && key <= "2026-06-01",
    });
  }
  const drafts = demoReportData({ from, to: through, mode: "posted", offset: 0 }).quality.draft_count;
  return {
    year,
    through,
    revision: "4821",
    fingerprint: `demo-${year}-${through}`,
    year_settings: { classification: "s_corp" },
    accounts,
    adjustments,
    basis: null,
    monthly,
    separately_stated: Object.fromEntries(Object.entries(separately).map(([k, v]) => [k, v.toString()])),
    book_profit_cents: book.toString(),
    mapped_ordinary_cents: ordinary.toString(),
    adjusted_ordinary_cents: adjusted.toString(),
    book_to_tax_cents: (adjusted - book).toString(),
    unmapped_accounts: accounts.filter((a) => a.line_count > 0 && !a.mapping).length,
    drafts,
    unavailable_adjustments: 0,
  };
}

/** The tax workpapers as accounting.support_report answers them. */
function demoTaxWorkpapers(filter: SupportReportFilter): SupportReportData {
  const year = Number(filter.to.slice(0, 4));
  const source = demoTaxSource(year, filter.to);
  const rows = [
    ...source.accounts
      .filter((a) => a.line_count > 0)
      .map((a) => ({
        label: a.name,
        row: {
          id: a.account_id,
          tax_kind: "account" as const,
          tax_account_id: a.account_id,
          cells: [
            a.name,
            a.mapping?.concept ?? "Unmapped",
            a.book_cents,
            a.ordinary_cents,
            (BigInt(a.ordinary_cents) - BigInt(a.book_cents)).toString(),
          ],
        },
      })),
    ...source.adjustments.map((a) => {
      const ordinary = SEPARATE_ADJUSTMENTS.has(a.concept) ? "0" : a.amount_cents;
      return {
        label: a.reason,
        row: { id: a.id, tax_kind: "adjustment" as const, cells: [a.reason, a.concept, "0", ordinary, ordinary] },
      };
    }),
  ]
    .sort((x, y) => x.label.localeCompare(y.label))
    .map((x) => x.row);
  return {
    definition_version: 1,
    report_id: "tax-workpapers",
    legal_name: "Demo Studio LLC",
    revision: source.revision,
    filter: { ...filter, from: `${year}-01-01` },
    columns: [
      { label: "Account or adjustment", numeric: false },
      { label: "Treatment", numeric: false },
      { label: "Book profit contribution", numeric: true },
      { label: "Ordinary taxable contribution", numeric: true },
      { label: "Book-to-tax difference", numeric: true },
    ],
    rows: rows.slice(filter.offset, filter.offset + 100),
    count: rows.length,
    total_cells: ["Total", "", source.book_profit_cents, source.adjusted_ordinary_cents, source.book_to_tax_cents],
    notes: [
      "Tax workpapers use year-to-date posted activity through the cutoff. Separately stated items and basis amounts are retained in the attached tax source.",
    ],
    tax_workpaper: source,
  };
}

/**
 * The demo's payroll runs, one a month for the owner, from the synthetic
 * journal: the salary entry (officer compensation, net pay from checking,
 * 20% withheld to payroll taxes payable), the employer taxes entry and the
 * provider's fee. A run whose salary entry still awaits review is a draft;
 * one duplicate import in March 2026 was voided.
 */
function demoPayrollRuns(year: number, through: string): PayrollYearRun[] {
  const all = entries().filter((e) => e.date.startsWith(`${year}-`) && e.date <= through);
  const runs: PayrollYearRun[] = [];
  for (const salary of all.filter((e) => e.memo === "Payroll")) {
    const gross = salary.lines.find((l) => l.account === 31)!.amount;
    const month = salary.date.slice(0, 7);
    const taxes = all.find((e) => e.memo === "Payroll taxes" && e.date.slice(0, 7) === month);
    const fee = all.find((e) => e.memo === "Payroll service" && e.date.slice(0, 7) === month);
    const employer = taxes ? taxes.lines.find((l) => l.account === 32)!.amount : ZERO;
    const withheld = (gross * BigInt(20)) / BigInt(100);
    const part = (bps: number) => (gross * BigInt(bps)) / BigInt(10000);
    const federal = part(1000),
      social = part(620),
      medicare = part(145);
    const employerSocial = part(620);
    const n = Number(month.slice(5, 7));
    const status = salary.draft ? "draft" : "posted";
    runs.push({
      id: `d6000000-0000-4000-8000-${String(year * 100 + n).padStart(12, "0")}`,
      provider_run_id: `PR-${year}-${String(n).padStart(2, "0")}`,
      pay_date: salary.date,
      status,
      entry_id: status === "posted" ? `entry-${salary.key}` : null,
      gross_cents: gross.toString(),
      net_cents: (gross - withheld).toString(),
      employee_withholding_cents: withheld.toString(),
      employer_tax_cents: employer.toString(),
      components: [
        { kind: "officer_wages", label: "Officer wages", amount_cents: gross.toString(), account_id: id(31) },
        { kind: "net_pay", label: "Net pay", amount_cents: (gross - withheld).toString(), account_id: id(1) },
        { kind: "employee_tax", label: "Federal income tax", amount_cents: federal.toString(), account_id: id(4) },
        { kind: "employee_tax", label: "Social Security", amount_cents: social.toString(), account_id: id(4) },
        { kind: "employee_tax", label: "Medicare", amount_cents: medicare.toString(), account_id: id(4) },
        {
          kind: "employee_tax",
          label: "State income tax",
          amount_cents: (withheld - federal - social - medicare).toString(),
          account_id: id(4),
        },
        ...(employer > ZERO
          ? [
              { kind: "employer_tax", label: "Employer Social Security", amount_cents: employerSocial.toString(), account_id: id(32) },
              { kind: "employer_tax", label: "Employer Medicare", amount_cents: (employer - employerSocial).toString(), account_id: id(32) },
            ]
          : []),
        ...(fee && !fee.draft
          ? [{ kind: "provider_fee", label: "Payroll service fee", amount_cents: fee.lines.find((l) => l.account === 33)!.amount.toString(), account_id: id(33) }]
          : []),
      ],
      ytd: {
        run_employees: [
          {
            key: "alex-morgan",
            name: "Alex Morgan",
            is_officer: true,
            gross_cash_cents: gross.toString(),
            federal_taxable_cents: gross.toString(),
            federal_withheld_cents: federal.toString(),
            state_taxable_cents: gross.toString(),
            state_withheld_cents: (withheld - federal - social - medicare).toString(),
            social_security_wages_cents: gross.toString(),
            medicare_wages_cents: gross.toString(),
          },
        ],
      },
    });
  }
  if (year === 2026 && through >= "2026-03-01") {
    const march = runs.find((r) => r.pay_date.startsWith("2026-03"));
    if (march)
      runs.push({
        ...march,
        id: "d6000000-0000-4000-8000-000000999901",
        provider_run_id: "PR-2026-03-DUP",
        status: "void",
        entry_id: "d7000000-0000-4000-8000-000000000001",
      });
  }
  return runs;
}

/** The payroll year as accounting.payroll answers it for a year and cutoff. */
export function demoPayrollYear(year: number, through: string): PayrollYearRead {
  const runs = demoPayrollRuns(year, through);
  const active = runs.filter((r) => r.status === "posted");
  const facts = active.flatMap((r) => r.ytd?.run_employees ?? []);
  const sum = (pick: (e: PayrollEmployee) => string | null | undefined) =>
    facts.reduce((s, e) => s + BigInt(pick(e) ?? "0"), ZERO).toString();
  return {
    year,
    through,
    revision: "4821",
    fingerprint: `demo-payroll-${year}-${through}`,
    run_count: active.length,
    drafts: runs.filter((r) => r.status === "draft").length,
    employees: facts.length
      ? [
          {
            key: "alex-morgan",
            name: "Alex Morgan",
            is_officer: true,
            gross_cash_cents: sum((e) => e.gross_cash_cents),
            federal_taxable_cents: sum((e) => e.federal_taxable_cents),
            federal_withheld_cents: sum((e) => e.federal_withheld_cents),
            state_taxable_cents: sum((e) => e.state_taxable_cents),
            state_withheld_cents: sum((e) => e.state_withheld_cents),
            social_security_wages_cents: sum((e) => e.social_security_wages_cents),
            medicare_wages_cents: sum((e) => e.medicare_wages_cents),
          },
        ]
      : [],
    coverage: null,
    rows: [...runs].sort((a, b) => b.pay_date.localeCompare(a.pay_date) || a.id.localeCompare(b.id)),
    count: runs.length,
  };
}

/** The payroll register as accounting.support_report answers it. */
function demoPayrollRegister(filter: SupportReportFilter): SupportReportData {
  const runs = demoPayrollRuns(Number(filter.to.slice(0, 4)), filter.to).filter(
    (r) => r.status === "posted" && r.pay_date >= filter.from,
  );
  const rows = runs
    .sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      run_id: r.id,
      cells: [r.pay_date, r.provider_run_id, r.gross_cents, r.employee_withholding_cents, r.employer_tax_cents, r.net_cents],
    }));
  const sum = (i: number) => rows.reduce((s, r) => s + BigInt(r.cells[i]), ZERO).toString();
  return {
    definition_version: 1,
    report_id: "payroll-register",
    legal_name: "Demo Studio LLC",
    revision: "4821",
    filter,
    columns: [
      { label: "Pay date", numeric: false },
      { label: "Provider run", numeric: false },
      { label: "Gross wages", numeric: true },
      { label: "Employee withholding", numeric: true },
      { label: "Employer taxes", numeric: true },
      { label: "Net pay", numeric: true },
    ],
    rows: rows.slice(filter.offset, filter.offset + 100),
    count: rows.length,
    total_cells: ["Total", "", sum(2), sum(3), sum(4), sum(5)],
    notes: [
      "Includes posted runs not reversed by the selected cutoff. A later void does not remove a run from an earlier report.",
    ],
  };
}

/**
 * The demo's fixed asset register: the laptop (June 2025) and a studio
 * camera kit (February 2026), each depreciated monthly over 36 months. A
 * monitor arm booked straight to Equipment in August 2026 is not in the
 * register, so the register and the books differ by its cost.
 */
const DEMO_ASSETS = [
  {
    n: 1,
    name: "Laptop",
    acquisition: "Laptop",
    depreciation: "Depreciation",
    acquired: "2025-06-12",
    method: "Straight line over 36 months, no salvage value",
  },
  {
    n: 2,
    name: "Studio camera kit",
    acquisition: "Studio camera kit",
    depreciation: "Depreciation, camera kit",
    acquired: "2026-02-18",
    method: "Straight line over 36 months, no salvage value",
  },
];
const assetId = (n: number) => `d8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One demo asset's cost and depreciation through a date, from its own entries. */
function demoAssetState(asset: (typeof DEMO_ASSETS)[number], to: string) {
  let cost = ZERO,
    depreciation = ZERO;
  for (const e of entries()) {
    if (e.draft || e.date > to) continue;
    if (e.memo !== asset.acquisition && e.memo !== asset.depreciation) continue;
    for (const l of e.lines) {
      if (l.account === 7) cost += l.amount;
      if (l.account === 8) depreciation -= l.amount;
    }
  }
  return { cost, depreciation };
}

/** The asset registers as accounting.registers lists them as of a date. */
export function demoRegisters(to: string): RegisterView {
  const rows = DEMO_ASSETS.filter((a) => a.acquired <= to).map((a) => {
    const s = demoAssetState(a, to);
    return {
      id: assetId(a.n),
      version: 1,
      kind: "asset" as const,
      body: {
        name: a.name,
        started_on: a.acquired,
        initial_cents: s.cost.toString(),
        account_id: id(7),
        expense_account_id: id(36),
        terms: "",
        in_service_on: a.acquired,
        accumulated_account_id: id(8),
        method: a.method,
      },
      document_id: null,
      state: {
        cost_cents: s.cost.toString(),
        depreciation_cents: s.depreciation.toString(),
        carrying_cents: (s.cost - s.depreciation).toString(),
        principal_cents: "0",
        initialized: true,
        disposed: false,
      },
    };
  });
  return { revision: "4821", as_of: to, count: rows.length, offset: 0, rows };
}

/** The asset register as accounting.support_report answers it. */
function demoAssetRegister(filter: SupportReportFilter): SupportReportData {
  const to = filter.to;
  const rows = DEMO_ASSETS.filter((a) => a.acquired <= to)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => {
      const s = demoAssetState(a, to);
      return {
        id: assetId(a.n),
        register_id: assetId(a.n),
        register_kind: "asset" as const,
        cells: [a.name, a.acquired, s.cost.toString(), s.depreciation.toString(), (s.cost - s.depreciation).toString()],
      };
    });
  const sum = (i: number) => rows.reduce((t, r) => t + BigInt(r.cells[i]), ZERO).toString();
  // The controls: each account's register amount against the books.
  const control = (n: number, name: string) => {
    let register = ZERO,
      books = ZERO;
    for (const e of entries()) {
      if (e.draft || e.date > to) continue;
      const own = DEMO_ASSETS.some((a) => e.memo === a.acquisition || e.memo === a.depreciation);
      for (const l of e.lines)
        if (l.account === n) {
          books += l.amount;
          if (own) register += l.amount;
        }
    }
    return {
      account_id: id(n),
      name,
      register_cents: register.toString(),
      book_cents: books.toString(),
      difference_cents: (books - register).toString(),
    };
  };
  const controls = [control(8, "Accumulated depreciation"), control(7, "Equipment")];
  return {
    definition_version: 1,
    report_id: "asset-register",
    legal_name: "Demo Studio LLC",
    revision: "4821",
    filter,
    columns: [
      { label: "Asset", numeric: false },
      { label: "Acquired", numeric: false },
      { label: "Recorded cost", numeric: true },
      { label: "Accumulated depreciation", numeric: true },
      { label: "Carrying value", numeric: true },
    ],
    rows: rows.slice(filter.offset, filter.offset + 100),
    count: rows.length,
    total_cells: ["Total", "", sum(2), sum(3), sum(4)],
    controls: {
      rows: controls,
      ready: controls.every((c) => c.difference_cents === "0"),
      missing_documents: 0,
    },
    notes: ["Balances include actual posted movements through the cutoff. Proposed schedule rows do not change the ledger."],
  };
}

/**
 * The demo's loan register: the equipment loan from the bank (no interest
 * recorded on its payments) and a loan from the owner, Alex Morgan, repaid
 * monthly with interest on the remaining balance.
 */
const DEMO_LOANS = [
  {
    n: 11,
    name: "Equipment loan",
    lender: "Demo Community Bank",
    account: 6,
    started: "2025-02-03",
    initial: "1000000",
    draw: "Equipment loan funded",
    payment: "Loan payment",
  },
  {
    n: 12,
    name: "Shareholder loan from Alex Morgan",
    lender: "Alex Morgan",
    account: 45,
    started: "2026-04-15",
    initial: "500000",
    draw: "Loan from Alex Morgan",
    payment: "Shareholder loan payment",
  },
];
const loanId = (n: number) => `d8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const loanEntries = (loan: (typeof DEMO_LOANS)[number], to: string) =>
  entries().filter((e) => !e.draft && e.date <= to && (e.memo === loan.draw || e.memo === loan.payment));
const loanBalance = (loan: (typeof DEMO_LOANS)[number], to: string) =>
  -loanEntries(loan, to).reduce(
    (s, e) => s + e.lines.filter((l) => l.account === loan.account).reduce((t, l) => t + l.amount, ZERO),
    ZERO,
  );

/** The loan registers as accounting.registers lists them as of a date. */
export function demoLoanRegisters(to: string): RegisterView {
  const rows = DEMO_LOANS.filter((l) => l.started <= to).map((l) => ({
    id: loanId(l.n),
    version: 1,
    kind: "loan" as const,
    body: {
      name: l.name,
      started_on: l.started,
      initial_cents: l.initial,
      account_id: id(l.account),
      expense_account_id: id(38),
      terms: "",
      lender: l.lender,
      fee_account_id: id(26),
    },
    document_id: null,
    state: {
      cost_cents: "0",
      depreciation_cents: "0",
      carrying_cents: "0",
      principal_cents: loanBalance(l, to).toString(),
      initialized: true,
      disposed: false,
    },
  }));
  return { revision: "4821", as_of: to, count: rows.length, offset: 0, rows };
}

/** One loan as accounting.registers details it: its posted movements as of a date. */
export function demoLoanDetail(registerId: string, to: string): RegisterDetail {
  const loan = DEMO_LOANS.find((l) => loanId(l.n) === registerId);
  if (!loan) throw new Error("This register is available with your own books.");
  const view = demoLoanRegisters(to).rows.find((r) => r.id === registerId)!;
  const movements = loanEntries(loan, to)
    .map((e) => {
      const principal = e.lines.filter((l) => l.account === loan.account).reduce((t, l) => t + l.amount, ZERO);
      const interest = e.lines.filter((l) => l.account === 38).reduce((t, l) => t + l.amount, ZERO);
      const kind = principal < ZERO ? ("draw" as const) : ("payment" as const);
      return {
        id: `entry-${e.key}`,
        kind,
        effective_date: e.date,
        entry_id: `entry-${e.key}`,
        mode: "new" as const,
        body: {
          kind,
          date: e.date,
          amount_cents: (principal < ZERO ? -principal : principal).toString(),
          ...(kind === "payment" ? { interest_cents: interest.toString(), fee_cents: "0" } : {}),
        },
        lines: e.lines.map((l) => ({ account_id: id(l.account), amount_cents: l.amount.toString() })),
        document_id: DEMO_DOCUMENT,
        reason: "",
        void: null,
      };
    })
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  return {
    id: registerId,
    version: 1,
    kind: "loan",
    record: { revision: 1, body: view.body, document_id: null, reason: "", created_at: `${loan.started}T12:00:00Z` },
    as_of: to,
    state: view.state,
    movement_count: movements.length,
    movements,
    revision_count: 1,
    revisions: [],
    offset: 0,
  };
}

/** The loan register as accounting.support_report answers it. */
function demoLoanRegister(filter: SupportReportFilter): SupportReportData {
  const to = filter.to;
  const rows = DEMO_LOANS.filter((l) => l.started <= to)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => ({
      id: loanId(l.n),
      register_id: loanId(l.n),
      register_kind: "loan" as const,
      cells: [l.name, l.started, loanBalance(l, to).toString()],
    }));
  const control = (n: number, name: string) => {
    let register = ZERO,
      books = ZERO;
    for (const e of entries()) {
      if (e.draft || e.date > to) continue;
      const own = DEMO_LOANS.some((l) => e.memo === l.draw || e.memo === l.payment);
      for (const l of e.lines)
        if (l.account === n) {
          books += l.amount;
          if (own) register += l.amount;
        }
    }
    return {
      account_id: id(n),
      name,
      register_cents: register.toString(),
      book_cents: books.toString(),
      difference_cents: (books - register).toString(),
    };
  };
  const controls = [control(6, "Equipment loan"), control(45, "Loan from shareholder")];
  return {
    definition_version: 1,
    report_id: "loan-register",
    legal_name: "Demo Studio LLC",
    revision: "4821",
    filter,
    columns: [
      { label: "Loan", numeric: false },
      { label: "Originated", numeric: false },
      { label: "Principal balance", numeric: true },
    ],
    rows: rows.slice(filter.offset, filter.offset + 100),
    count: rows.length,
    total_cells: ["Total", "", rows.reduce((t, r) => t + BigInt(r.cells[2]), ZERO).toString()],
    controls: { rows: controls, ready: controls.every((c) => c.difference_cents === "0"), missing_documents: 0 },
    notes: ["Balances include actual posted movements through the cutoff. Proposed schedule rows do not change the ledger."],
  };
}
