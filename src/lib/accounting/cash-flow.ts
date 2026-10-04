import type {
  BreakdownData,
  BreakdownFilter,
  ReportAccount,
  ReportData,
  ReportFilter,
} from "./reports";
import type { StatementRow } from "./profit-loss";
import { periodScope } from "./profit-loss";
import { formatCents } from "./money";

/**
 * Where the cash came from and where it went, built from the books' own
 * account movements (the indirect method): profit, then every change in a
 * balance that is not bank or cash, sorted into running the business,
 * equipment, and owner and loans. Because every entry balances, the parts
 * always add up to the change in bank and cash.
 *
 * Why not the books' cash classification (accounting.cash_lines)? It sorts
 * each bank line by the account on the other side, so a card payment or a
 * savings transfer recorded as a linked transfer (bank to transit, transit
 * to card or savings) lands in "internal transfers" rather than paying the
 * card, and shareholder loans count as operating. Working from balances is
 * immune to how a payment was routed: money moved between your own bank
 * accounts nets to zero, and paying the card shows as the card balance going
 * down.
 */

const ZERO = BigInt(0);

/** Notes the exports and the coverage panel carry about how the report is built. */
export const CASH_FLOW_NOTES = [
  "Built from the change in every balance (the indirect method): profit, then each balance that moved, sorted into running the business, equipment and investments, and owner and loans.",
  "Money moved between your own bank and cash accounts is not cash in or out; a card payment shows as the card balance going down.",
  "Owner accounts that hold money both ways count their credits as money put in and their debits as money taken out.",
];
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");

/* ------------------------------------------------------------------------ */
/* How each balance is sorted                                               */
/* ------------------------------------------------------------------------ */

export type CashRole =
  | "cash"
  | "transit"
  | "equipment"
  | "depreciation"
  | "owner"
  | "opening"
  | "loan"
  | "card"
  | "owed"
  | "customers"
  | "other"
  | "result";

const LOAN_PURPOSES = new Set([
  "loans_payable",
  "shareholder_loan",
  "due_to_shareholder",
  "due_from_shareholder",
]);
const TRANSIT_PURPOSES = new Set(["transfers_in_transit", "undeposited_funds"]);
const OPENING_PURPOSES = new Set([
  "opening_balance_equity",
  "opening_retained_earnings",
  "retained_earnings",
]);

/** What a balance means for cash, by its kind, subtype and purpose. */
export function cashRole(
  a: Pick<ReportAccount, "account_type" | "cash_kind" | "subtype" | "purpose">,
): CashRole {
  if (a.account_type === "income" || a.account_type === "expense") return "result";
  if (a.cash_kind === "bank" || a.cash_kind === "cash") return "cash";
  if (a.cash_kind === "card") return "card";
  const subtype = (a.subtype ?? "").toLowerCase(),
    purpose = a.purpose ?? "";
  if (a.account_type === "equity")
    // Opening balances and retained earnings move only when balances are
    // entered or corrected: that is not the owner putting money in.
    return ["opening_balance", "retained_earnings"].includes(subtype) || OPENING_PURPOSES.has(purpose)
      ? "opening"
      : "owner";
  if (["transit", "undeposited"].includes(subtype) || TRANSIT_PURPOSES.has(purpose))
    return "transit";
  if (subtype === "accumulated_depreciation" || purpose === "accumulated_depreciation")
    return "depreciation";
  if (subtype === "fixed_asset") return "equipment";
  if (subtype === "loan" || LOAN_PURPOSES.has(purpose)) return "loan";
  if (subtype === "receivable") return "customers";
  if (a.account_type === "liability") return "owed";
  return "other";
}

/** Cash effect of a balance's movement: a liability rising or an asset falling frees cash. */
const effect = (a: Pick<ReportAccount, "period_cents">) => -big(a.period_cents);
const compareEffect = (a: Pick<ReportAccount, "compare_period_cents">) =>
  -big(a.compare_period_cents);

/* ------------------------------------------------------------------------ */
/* Totals and the bridge                                                    */
/* ------------------------------------------------------------------------ */

export interface CashFlowTotals {
  starting: bigint;
  ending: bigint;
  change: bigint;
  profit: bigint;
  operating: bigint;
  equipment: bigint;
  /** Owner money in (credits to equity), positive. */
  ownerIn: bigint;
  /** Owner money out (debits to equity), negative. */
  ownerOut: bigint;
  borrowed: bigint;
  repaid: bigint;
  /** Opening balances entered or corrected during the period. */
  opening: bigint;
  transit: bigint;
  /** Everything that brought cash in, and everything that took it out (negative). */
  cashIn: bigint;
  cashOut: bigint;
  /** Starting cash plus the parts, less ending cash; zero when the books balance. */
  difference: bigint;
}

export function cashFlowTotals(data: ReportData): CashFlowTotals {
  let operating = big(data.totals.net_cents),
    equipment = ZERO,
    ownerIn = ZERO,
    ownerOut = ZERO,
    borrowed = ZERO,
    repaid = ZERO,
    opening = ZERO,
    transit = ZERO;
  for (const a of data.accounts) {
    const role = cashRole(a);
    const moved = effect(a);
    if (role === "card" || role === "owed" || role === "customers" || role === "other" || role === "depreciation")
      operating += moved;
    else if (role === "equipment") equipment += moved;
    else if (role === "transit") transit += moved;
    else if (role === "opening") opening += moved;
    else if (role === "owner" || role === "loan") {
      // Credits brought money in, debits took it out; a mixed owner account
      // (or a dedicated one with a correction) splits the same way.
      const credits = big(a.credit_cents),
        debits = big(a.debit_cents);
      if (role === "owner") {
        ownerIn += credits;
        ownerOut -= debits;
      } else {
        borrowed += credits;
        repaid -= debits;
      }
    }
  }
  const starting = big(data.totals.cash_opening_cents),
    ending = big(data.totals.cash_ending_cents);
  const parts = [operating, equipment, ownerIn, ownerOut, borrowed, repaid, opening, transit];
  const cashIn = parts.filter((p) => p > ZERO).reduce((s, p) => s + p, ZERO);
  const cashOut = parts.filter((p) => p < ZERO).reduce((s, p) => s + p, ZERO);
  return {
    starting,
    ending,
    change: ending - starting,
    profit: big(data.totals.net_cents),
    operating,
    equipment,
    ownerIn,
    ownerOut,
    borrowed,
    repaid,
    opening,
    transit,
    cashIn,
    cashOut,
    difference: starting + cashIn + cashOut - ending,
  };
}

export interface BridgeLine {
  key: string;
  label: string;
  amount: bigint;
  filter?: Partial<ReportFilter>;
}

/** The accounts in a role, as a journal drill for the period. */
function scopeOf(data: ReportData, roles: CashRole[]): Partial<ReportFilter> | undefined {
  const ids = data.accounts
    .filter((a) => roles.includes(cashRole(a)) && (big(a.period_cents) !== ZERO || big(a.debit_cents) !== ZERO))
    .map((a) => a.id);
  return ids.length ? { ...periodScope(data), account_ids: ids.slice(0, 500) } : undefined;
}

/** Starting cash to ending cash, one plain line per kind of movement. */
export function cashBridge(data: ReportData): { lines: BridgeLine[]; totals: CashFlowTotals } {
  const t = cashFlowTotals(data);
  const candidates: BridgeLine[] = [
    {
      key: "operating",
      label: "From running the business",
      amount: t.operating,
      filter: { ...periodScope(data), account_types: ["income" as const, "expense" as const] },
    },
    { key: "equipment", label: "Equipment and investments", amount: t.equipment, filter: scopeOf(data, ["equipment"]) },
    { key: "ownerIn", label: "Money you put in", amount: t.ownerIn, filter: scopeOf(data, ["owner"]) },
    { key: "ownerOut", label: "Money you took out", amount: t.ownerOut, filter: scopeOf(data, ["owner"]) },
    { key: "borrowed", label: "Borrowed", amount: t.borrowed, filter: scopeOf(data, ["loan"]) },
    { key: "repaid", label: "Loans repaid", amount: t.repaid, filter: scopeOf(data, ["loan"]) },
    { key: "opening", label: "Opening balances entered", amount: t.opening, filter: scopeOf(data, ["opening"]) },
    {
      key: "transit",
      label: t.transit < ZERO ? "On its way between your accounts" : "Arrived from between your accounts",
      amount: t.transit,
      filter: scopeOf(data, ["transit"]),
    },
  ];
  const lines = candidates.filter((l) => l.amount !== ZERO || l.key === "operating");
  return { lines, totals: t };
}

/* ------------------------------------------------------------------------ */
/* Profit vs cash                                                           */
/* ------------------------------------------------------------------------ */

export interface ProfitCashLine {
  key: string;
  label: string;
  /** What the change means, in a few words. */
  hint: string;
  /** The same reason as the end of a sentence ("mostly because ..."). */
  because: string;
  amount: bigint;
  filter?: Partial<ReportFilter>;
}

function hintFor(
  role: CashRole,
  name: string,
  amount: bigint,
): { label: string; hint: string; because: string } {
  const up = amount > ZERO;
  switch (role) {
    case "card":
      return up
        ? {
            label: `${name} balance went up`,
            hint: "You spent on the card but have not paid it yet.",
            because: "you spent on the card and have not paid it yet",
          }
        : {
            label: `${name} balance went down`,
            hint: "You paid the card, including spending from before this period.",
            because: "you paid down the card",
          };
    case "depreciation":
      return {
        label: "Depreciation",
        hint: up
          ? "An expense on paper as equipment wears out; no cash left."
          : "A depreciation correction; no cash moved.",
        because: "depreciation is an expense but not cash",
      };
    case "customers":
      return up
        ? {
            label: `${name} went down`,
            hint: "Customers paid money they owed from before.",
            because: "customers paid what they owed",
          }
        : {
            label: `${name} went up`,
            hint: "Customers owe you more, not collected yet.",
            because: "customers owe you more that is not collected yet",
          };
    case "owed":
      return up
        ? {
            label: `${name} went up`,
            hint: "Owed but not paid out yet, so the cash is still with you.",
            because: `${name.toLowerCase()} is owed but not paid out yet`,
          }
        : {
            label: `${name} went down`,
            hint: "You paid out amounts owed from before.",
            because: "you paid out amounts owed from before",
          };
    default:
      return up
        ? {
            label: `${name} went down`,
            hint: "Used up or collected something paid for earlier.",
            because: "you used up things paid for earlier",
          }
        : {
            label: `${name} went up`,
            hint: "Paid ahead for something not yet an expense.",
            because: "you paid ahead for things not yet an expense",
          };
  }
}

/** How many changes the profit vs cash story names before folding the rest. */
export const PROFIT_CASH_LINES = 6;

/**
 * Profit turned into cash from running the business: each balance that moved
 * in the gap, in the owner's words, largest first.
 */
export function profitToCash(data: ReportData): {
  profit: bigint;
  lines: ProfitCashLine[];
  operating: bigint;
} {
  const profit = big(data.totals.net_cents);
  const lines = data.accounts
    .map((a) => ({ a, role: cashRole(a), amount: effect(a) }))
    .filter(
      ({ role, amount }) =>
        amount !== ZERO &&
        ["card", "owed", "customers", "other", "depreciation"].includes(role),
    )
    .map(({ a, role, amount }) => {
      const words = hintFor(role, a.name, amount);
      return {
        key: a.id,
        label: words.label,
        hint: words.hint,
        because: words.because,
        amount,
        filter: { ...periodScope(data), account_ids: [a.id] },
      };
    })
    .sort((x, y) => {
      const ax = x.amount < ZERO ? -x.amount : x.amount,
        ay = y.amount < ZERO ? -y.amount : y.amount;
      return ay > ax ? 1 : ay < ax ? -1 : 0;
    });
  const operating = lines.reduce((s, l) => s + l.amount, profit);
  // Past a handful, the smaller changes fold into one line so the story
  // stays readable; their drill opens every one of them.
  if (lines.length <= PROFIT_CASH_LINES + 1) return { profit, lines, operating };
  const shown = lines.slice(0, PROFIT_CASH_LINES),
    rest = lines.slice(PROFIT_CASH_LINES);
  const ids = rest.flatMap((l) => l.filter?.account_ids ?? []);
  return {
    profit,
    lines: [
      ...shown,
      {
        key: "rest",
        label: `${rest.length} smaller changes`,
        hint: "Other bills, prepayments and balances that moved a little.",
        because: "of several smaller changes",
        amount: rest.reduce((s, l) => s + l.amount, ZERO),
        filter: { ...periodScope(data), account_ids: ids.slice(0, 500) },
      },
    ],
    operating,
  };
}

const money = (cents: bigint) => {
  const negative = cents < ZERO,
    v = negative ? -cents : cents;
  const whole = (v / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}`;
};

/** The headline sentence of the profit and cash story, in whole dollars. */
export function profitCashSentence(
  t: CashFlowTotals,
  lines: ProfitCashLine[] = [],
): string {
  const gap = t.operating - t.profit;
  const opening =
    t.profit >= ZERO
      ? `You made ${money(t.profit)} in profit`
      : `The business lost ${money(-t.profit)}`;
  const business =
    t.operating >= ZERO
      ? `running the business brought in ${money(t.operating)} of cash`
      : `running the business used ${money(-t.operating)} of cash`;
  // The biggest change pulling the same way as the gap names the reason.
  const reason = lines.find((l) => (gap > ZERO ? l.amount > ZERO : l.amount < ZERO));
  const why =
    gap === ZERO
      ? "."
      : `: ${money(gap > ZERO ? gap : -gap)} ${gap > ZERO ? "more" : "less"}${reason ? `, mostly because ${reason.because}` : ""}.`;
  return `${opening}, and ${business}${why}`;
}

/** The bridge in one line: how far cash moved, from where to where. */
export function bridgeSentence(t: CashFlowTotals): string {
  if (t.change === ZERO)
    return `Cash ended where it started, at ${formatCents(t.ending)}.`;
  const by = formatCents(t.change > ZERO ? t.change : -t.change);
  return `Cash went ${t.change > ZERO ? "up" : "down"} by ${by}, from ${formatCents(t.starting)} to ${formatCents(t.ending)}.`;
}

/** What happened after the business: the owner, loans and equipment. */
export function afterBusinessSentence(t: CashFlowTotals): string | null {
  const parts: string[] = [];
  if (t.ownerOut < ZERO) parts.push(`you took out ${money(-t.ownerOut)}`);
  if (t.ownerIn > ZERO) parts.push(`you put in ${money(t.ownerIn)}`);
  if (t.repaid < ZERO) parts.push(`you repaid ${money(-t.repaid)} of loans`);
  if (t.borrowed > ZERO) parts.push(`you borrowed ${money(t.borrowed)}`);
  if (t.equipment < ZERO) parts.push(`you spent ${money(-t.equipment)} on equipment`);
  if (t.equipment > ZERO) parts.push(`you sold ${money(t.equipment)} of equipment`);
  if (t.opening !== ZERO)
    parts.push(`opening balances ${t.opening > ZERO ? "added" : "took off"} ${money(t.opening > ZERO ? t.opening : -t.opening)}`);
  if (t.transit < ZERO) parts.push(`${money(-t.transit)} was still on its way between your accounts`);
  if (t.transit > ZERO) parts.push(`${money(t.transit)} arrived from between your accounts`);
  if (!parts.length) return null;
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const direction =
    t.change >= ZERO ? `cash went up by ${money(t.change)}` : `cash went down by ${money(-t.change)}`;
  return `After that, ${list}, so ${direction}.`;
}

/* ------------------------------------------------------------------------ */
/* Month by month                                                           */
/* ------------------------------------------------------------------------ */

export interface CashMonth {
  /** First of the month, YYYY-MM-DD. */
  month: string;
  /** The day the balance is taken: the month end, or the period end. */
  at: string;
  ending: bigint;
  change: bigint;
  profit: bigint;
  partial: { from: string; to: string } | null;
}

/** Month-end bank and cash for the period (the books' default for a balance). */
export function cashSeriesFilter(filter: ReportFilter): BreakdownFilter {
  return {
    from: filter.from,
    to: filter.to,
    mode: filter.mode,
    group_by: "month",
    measure: "balance",
  };
}

export function cashMonths(data: ReportData, series: BreakdownData | null | undefined): CashMonth[] {
  const balances = new Map((series?.rows ?? []).map((r) => [r.key.slice(0, 7), big(r.balance_cents)]));
  const { from, to } = data.filter;
  let previous = big(data.totals.cash_opening_cents);
  return data.monthly.map((m) => {
    const month = `${m.month.slice(0, 7)}-01`;
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
      .toISOString()
      .slice(0, 10);
    const start = from > month ? from : month,
      end = to < last ? to : last;
    const ending = balances.get(month.slice(0, 7)) ?? previous;
    const change = ending - previous;
    previous = ending;
    return {
      month,
      at: end,
      ending,
      change,
      profit: big(m.net_cents),
      partial: start !== month || end !== last ? { from: start, to: end } : null,
    };
  });
}

/* ------------------------------------------------------------------------ */
/* The statement (indirect method)                                          */
/* ------------------------------------------------------------------------ */

const GROUP_LABELS: Record<string, string> = {
  depreciation: "Depreciation (not cash)",
  card: "Change in what you owe on cards",
  owed: "Change in payroll, taxes and other bills owed",
  customers: "Change in what customers owe you",
  other: "Change in other things paid ahead or held",
};

/**
 * The formal statement of cash flows, indirect method: net profit and the
 * changes that turn it into cash from running the business, then equipment,
 * then owner and loans, then money between your own accounts, ending at the
 * change in cash and the starting and ending balances. Every account shows
 * each account; the summary folds them into a line per kind.
 */
export function cashFlowStatement(
  data: ReportData,
  details: boolean,
): StatementRow[] {
  const comparing = !!data.filter.compare_from;
  const scope = periodScope(data);
  const compareScope: Partial<ReportFilter> = {
    ...scope,
    from: data.filter.compare_from ?? data.filter.from,
    to: data.filter.compare_to ?? data.filter.to,
  };
  const rows: StatementRow[] = [];
  const values = (current: bigint, previous: bigint) =>
    comparing
      ? [current.toString(), previous.toString(), (current - previous).toString()]
      : [current.toString()];
  const push = (
    key: string,
    label: string,
    kind: StatementRow["kind"],
    section: string,
    current: bigint,
    previous: bigint,
    filter?: Partial<ReportFilter>,
    indent = false,
  ) =>
    rows.push({
      key,
      label,
      kind,
      section,
      side: kind === "total" ? "result" : "income",
      values: kind === "heading" ? [] : values(current, previous),
      detail: filter
        ? [filter, { ...filter, from: compareScope.from, to: compareScope.to }]
        : undefined,
      indent,
    });
  const heading = (label: string) => push(`h-${label}`, label, "heading", label, ZERO, ZERO);
  const ofRoles = (roles: CashRole[]) => data.accounts.filter((a) => roles.includes(cashRole(a)));
  const sum = (list: ReportAccount[], f: (a: ReportAccount) => bigint) =>
    list.reduce((s, a) => s + f(a), ZERO);
  const moved = (a: ReportAccount) => effect(a) !== ZERO || (comparing && compareEffect(a) !== ZERO);
  const accountRow = (a: ReportAccount, section: string) =>
    push(a.id, a.name, "account", section, effect(a), compareEffect(a), { ...scope, account_ids: [a.id] }, true);

  const operatingRoles: CashRole[] = ["depreciation", "card", "owed", "customers", "other"];
  const RUNNING = "Cash from running the business";
  heading(RUNNING);
  push("profit", "Net profit", "account", RUNNING, big(data.totals.net_cents), big(data.comparison.net_cents), {
    ...scope,
    account_types: ["income", "expense"],
  });
  for (const role of operatingRoles) {
    const list = ofRoles([role]).filter(moved);
    if (!list.length) continue;
    if (details) for (const a of list) accountRow(a, RUNNING);
    else
      push(`g-${role}`, GROUP_LABELS[role], "account", RUNNING, sum(list, effect), sum(list, compareEffect), {
        ...scope,
        account_ids: list.map((a) => a.id),
      });
  }
  const operating = ofRoles(operatingRoles);
  const operatingNow = big(data.totals.net_cents) + sum(operating, effect),
    operatingThen = big(data.comparison.net_cents) + sum(operating, compareEffect);
  push("t-operating", RUNNING, "subtotal", RUNNING, operatingNow, operatingThen);

  const sections: [string, CashRole[], string][] = [
    ["Equipment and investments", ["equipment"], "Cash from equipment and investments"],
    ["Owner and loans", ["owner", "loan"], "Cash from owner and loans"],
    ["Opening balances", ["opening"], ""],
    ["Between your own accounts", ["transit"], ""],
  ];
  let restNow = ZERO,
    restThen = ZERO;
  for (const [title, roles, total] of sections) {
    const list = ofRoles(roles).filter(moved);
    if (!list.length) continue;
    heading(title);
    // The last two sections are short lists with no subtotal of their own.
    if (details || !total) for (const a of list) accountRow(a, title);
    else if (title === "Owner and loans") {
      const owner = list.filter((a) => cashRole(a) === "owner"),
        loans = list.filter((a) => cashRole(a) === "loan");
      if (owner.length)
        push("g-owner", "Owner money in and out, net", "account", title, sum(owner, effect), sum(owner, compareEffect), {
          ...scope,
          account_ids: owner.map((a) => a.id),
        });
      if (loans.length)
        push("g-loans", "Loans, net", "account", title, sum(loans, effect), sum(loans, compareEffect), {
          ...scope,
          account_ids: loans.map((a) => a.id),
        });
    } else
      push(`g-${title}`, "Bought and sold, net", "account", title, sum(list, effect), sum(list, compareEffect), {
        ...scope,
        account_ids: list.map((a) => a.id),
      });
    const now = sum(list, effect),
      then = sum(list, compareEffect);
    restNow += now;
    restThen += then;
    if (total) push(`t-${title}`, total, "subtotal", title, now, then);
  }
  const cashAccounts = data.accounts.filter((a) => cashRole(a) === "cash").map((a) => a.id);
  const cashScope = cashAccounts.length ? { ...scope, account_ids: cashAccounts } : undefined;
  push(
    "change",
    "Net change in cash",
    "total",
    "Cash",
    operatingNow + restNow,
    operatingThen + restThen,
    cashScope,
  );
  push(
    "starting",
    "Starting cash",
    "subtotal",
    "Cash",
    big(data.totals.cash_opening_cents),
    big(data.comparison.cash_opening_cents),
  );
  push(
    "ending",
    "Ending cash",
    "total",
    "Cash",
    big(data.totals.cash_ending_cents),
    big(data.comparison.cash_ending_cents),
    cashScope ? { ...cashScope, from: "1900-01-01" } : undefined,
  );
  return rows;
}

/** Whether nothing moved bank or cash, or any balance, in either period. */
export function isEmptyCashFlow(data: ReportData): boolean {
  return (
    big(data.totals.cash_opening_cents) === ZERO &&
    big(data.totals.cash_ending_cents) === ZERO &&
    !data.accounts.some(
      (a) =>
        big(a.period_cents) !== ZERO ||
        (!!data.filter.compare_from && big(a.compare_period_cents) !== ZERO),
    )
  );
}

