import type { ReportAccount, ReportData, ReportDetail, ReportFilter } from "./reports";
import { cashRole } from "./cash-flow";
import { percentOf, periodScope, type StatementRow } from "./profit-loss";

/**
 * Money between the owner and the business: what the owner put in and took
 * out of the owner equity accounts, what the business paid the owner as
 * salary, and how both compare with what the business earned. Built from the
 * report's own account movements: a credit to an owner equity account is
 * money put in, a debit is money taken out, so a mixed "Investment /
 * Drawings" account splits the same way the balance sheet splits it.
 * Opening balances and retained earnings are not the owner's doing and are
 * shown apart; loans between the owner and the business are not equity and
 * are listed on their own.
 */

const ZERO = BigInt(0);
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");

const LOAN_PURPOSES = new Set(["shareholder_loan", "due_to_shareholder", "due_from_shareholder"]);
const SALARY_PURPOSES = new Set(["officer_compensation", "officer_wages"]);

/** The owner's equity accounts: contributions, draws, distributions, mixed accounts. */
export const ownerAccounts = (data: ReportData) =>
  data.accounts.filter((a) => cashRole(a) === "owner");
/** Opening balances and retained earnings: equity the owner did not move. */
export const openingAccounts = (data: ReportData) =>
  data.accounts.filter((a) => cashRole(a) === "opening");
/** Loans between the owner and the business, either way. */
export const ownerLoanAccounts = (data: ReportData) =>
  data.accounts.filter((a) => LOAN_PURPOSES.has(a.purpose ?? ""));
/** The owner's pay through payroll: officer compensation. */
export const salaryAccounts = (data: ReportData) =>
  data.accounts.filter(
    (a) => a.account_type === "expense" && SALARY_PURPOSES.has(a.purpose ?? ""),
  );

const sum = (list: ReportAccount[], f: (a: ReportAccount) => bigint) =>
  list.reduce((s, a) => s + f(a), ZERO);

export interface OwnerTotals {
  putIn: bigint;
  /** Positive: what was taken out. */
  takenOut: bigint;
  salary: bigint;
  profit: bigint;
  /** Opening balances and corrections to them in the period (credit positive). */
  opening: bigint;
  /** Loans with the owner: what the owner lent (credits) and what came back (debits). */
  lent: bigint;
  repaid: bigint;
  startingEquity: bigint;
  endingEquity: bigint;
  /** Taken out as a share of profit, percent; null without a profit. */
  takenShare: number | null;
  /** Owner accounts that moved both ways in the period. */
  mixed: ReportAccount[];
  /** Whether the books record owner salary at all (an officer compensation account). */
  salaryTracked: boolean;
}

/** Ending equity is the balance sheet's; starting equity backs out the period. */
export function ownerTotals(data: ReportData, previous = false): OwnerTotals {
  const totals = previous ? data.comparison : data.totals;
  const period = (a: ReportAccount) => big(previous ? a.compare_period_cents : a.period_cents);
  const owners = ownerAccounts(data);
  // A credit to an owner account is money in; a debit is money out. The
  // comparison has only each account's net, so there it splits by sign.
  const putIn = previous
    ? sum(owners, (a) => (period(a) < ZERO ? -period(a) : ZERO))
    : sum(owners, (a) => big(a.credit_cents));
  const takenOut = previous
    ? sum(owners, (a) => (period(a) > ZERO ? period(a) : ZERO))
    : sum(owners, (a) => big(a.debit_cents));
  const loans = ownerLoanAccounts(data);
  const profit = big(totals.net_cents);
  const opening = -sum(openingAccounts(data), period);
  const endingEquity = big(totals.equity_cents) + big(totals.prior_cents) + big(totals.year_cents);
  const equityMoved = -sum(
    data.accounts.filter((a) => a.account_type === "equity"),
    period,
  );
  return {
    putIn,
    takenOut,
    salary: sum(salaryAccounts(data), period),
    profit,
    opening,
    lent: previous ? sum(loans, (a) => (period(a) < ZERO ? -period(a) : ZERO)) : sum(loans, (a) => big(a.credit_cents)),
    repaid: previous ? sum(loans, (a) => (period(a) > ZERO ? period(a) : ZERO)) : sum(loans, (a) => big(a.debit_cents)),
    startingEquity: endingEquity - equityMoved - profit,
    endingEquity,
    takenShare: profit > ZERO ? percentOf(takenOut, profit) : null,
    mixed: previous ? [] : owners.filter((a) => big(a.credit_cents) > ZERO && big(a.debit_cents) > ZERO),
    salaryTracked: salaryAccounts(data).length > 0,
  };
}

/* ------------------------------------------------------------------------ */
/* Where your equity went                                                    */
/* ------------------------------------------------------------------------ */

export interface EquityStep {
  key: string;
  label: string;
  amount: bigint;
  hint?: string;
  filter?: Partial<ReportFilter>;
}

/** Starting equity to ending equity: put in, profit, taken out, and anything else. */
export function equityRollForward(data: ReportData): {
  start: bigint;
  lines: EquityStep[];
  end: bigint;
} {
  const t = ownerTotals(data);
  const scope = periodScope(data);
  const owners = ownerAccounts(data).map((a) => a.id);
  const lines: EquityStep[] = [
    {
      key: "in",
      label: "Money you put in",
      amount: t.putIn,
      filter: owners.length ? { ...scope, account_ids: owners } : undefined,
    },
    {
      key: "profit",
      label: t.profit < ZERO ? "Loss this period" : "Profit this period",
      amount: t.profit,
      filter: { ...scope, account_types: ["income", "expense"] },
    },
    {
      key: "out",
      label: "Money you took out",
      amount: -t.takenOut,
      filter: owners.length ? { ...scope, account_ids: owners } : undefined,
    },
  ];
  if (t.opening !== ZERO) {
    const ids = openingAccounts(data).map((a) => a.id);
    lines.push({
      key: "opening",
      label: "Opening balances and corrections",
      amount: t.opening,
      hint: "Balances entered or corrected, not money moved by you.",
      filter: ids.length ? { ...scope, account_ids: ids } : undefined,
    });
  }
  return {
    start: t.startingEquity,
    lines: lines.filter((l) => l.amount !== ZERO || l.key === "profit"),
    end: t.endingEquity,
  };
}

/* ------------------------------------------------------------------------ */
/* The owner's transactions                                                  */
/* ------------------------------------------------------------------------ */

export interface OwnerLine {
  id: string;
  entryId: string;
  date: string;
  memo: string;
  account: string;
  /** Positive: put in. Negative: taken out. */
  amount: bigint;
}

/** Journal lines on the owner accounts, newest first; credits are money in. */
export function ownerLines(detail: ReportDetail["rows"]): OwnerLine[] {
  return detail
    .map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      date: r.entry_date,
      memo: r.memo,
      account: r.account_name,
      amount: -big(r.amount_cents),
    }))
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));
}

/** The journal scope for the owner accounts' lines in the period. */
export function ownerLinesFilter(data: ReportData): ReportFilter | null {
  const ids = ownerAccounts(data).map((a) => a.id);
  if (!ids.length) return null;
  return {
    from: data.filter.from,
    to: data.filter.to,
    mode: data.filter.mode,
    offset: 0,
    account_ids: ids.slice(0, 500),
  };
}

/* ------------------------------------------------------------------------ */
/* Month by month                                                            */
/* ------------------------------------------------------------------------ */

export interface OwnerMonth {
  month: string;
  at: string;
  partial: { from: string; to: string } | null;
  putIn: bigint;
  takenOut: bigint;
  salary: bigint | null;
  profit: bigint;
  /** Running totals from the period's start. */
  takenSoFar: bigint;
  profitSoFar: bigint;
}

export function ownerMonths(
  data: ReportData,
  lines: OwnerLine[] | null,
  salary: { key: string; expense_cents?: string }[] | null,
): OwnerMonth[] {
  const { from, to } = data.filter;
  const salaryBy = new Map((salary ?? []).map((r) => [r.key.slice(0, 7), big(r.expense_cents)]));
  let taken = ZERO,
    earned = ZERO;
  return data.monthly.map((m) => {
    const key = m.month.slice(0, 7);
    const month = `${key}-01`;
    const last = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0))
      .toISOString()
      .slice(0, 10);
    const start = from > month ? from : month,
      end = to < last ? to : last;
    const inMonth = (lines ?? []).filter((l) => l.date.startsWith(key));
    const putIn = inMonth.filter((l) => l.amount > ZERO).reduce((s, l) => s + l.amount, ZERO);
    const takenOut = -inMonth.filter((l) => l.amount < ZERO).reduce((s, l) => s + l.amount, ZERO);
    const profit = big(m.net_cents);
    taken += takenOut;
    earned += profit;
    return {
      month,
      at: end,
      partial: start !== month || end !== last ? { from: start, to: end } : null,
      putIn,
      takenOut,
      salary: salary ? (salaryBy.get(key) ?? ZERO) : null,
      profit,
      takenSoFar: taken,
      profitSoFar: earned,
    };
  });
}

/* ------------------------------------------------------------------------ */
/* Plain notes                                                               */
/* ------------------------------------------------------------------------ */

const whole = (cents: bigint) => {
  const negative = cents < ZERO,
    v = negative ? -cents : cents;
  return `${negative ? "-" : ""}$${(v / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
};

/** One sentence: what came and went, against what the business earned. */
export function ownerSentence(t: OwnerTotals): string {
  const moved =
    t.putIn > ZERO && t.takenOut > ZERO
      ? `You put in ${whole(t.putIn)} and took out ${whole(t.takenOut)}`
      : t.takenOut > ZERO
        ? `You took out ${whole(t.takenOut)}`
        : t.putIn > ZERO
          ? `You put in ${whole(t.putIn)}`
          : "No money moved between you and the business";
  const earned =
    t.profit > ZERO
      ? `, while the business made ${whole(t.profit)} in profit`
      : t.profit < ZERO
        ? `, while the business lost ${whole(-t.profit)}`
        : "";
  return `${moved}${earned}.`;
}

export interface OwnerNote {
  tone: "info" | "look";
  text: string;
}

/**
 * Things worth a look, stated as what the books show. The S corporation line
 * is general information only, shown when the books record both owner salary
 * and money taken out; it never says what the tax outcome is.
 */
export function ownerNotes(t: OwnerTotals): OwnerNote[] {
  const notes: OwnerNote[] = [];
  if (t.takenOut > ZERO && t.profit > ZERO && t.takenOut > t.profit)
    notes.push({
      tone: "look",
      text: `You took out ${whole(t.takenOut - t.profit)} more than the business earned this period. The difference came from earlier profits, money you put in, or cash the business had.`,
    });
  if (t.takenOut > ZERO && t.profit <= ZERO)
    notes.push({
      tone: "look",
      text: "You took money out in a period the business did not make a profit, so it came from earlier profits or cash on hand.",
    });
  for (const a of t.mixed)
    notes.push({
      tone: "info",
      text: `${a.name} holds money both ways: its credits count as money put in and its debits as money taken out.`,
    });
  if (t.salary > ZERO && t.takenOut > ZERO)
    notes.push({
      tone: "info",
      text: "For information only: S corporation owners who work in the business are generally expected to pay themselves a reasonable salary before taking distributions. Your tax preparer can say what is reasonable for you.",
    });
  if (t.lent > ZERO || t.repaid > ZERO)
    notes.push({
      tone: "info",
      text: `Loans between you and the business are not equity: ${whole(t.lent)} lent and ${whole(t.repaid)} repaid this period, shown on their own.`,
    });
  return notes;
}

/* ------------------------------------------------------------------------ */
/* The statement                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The equity roll-forward as a formal table, with comparison and change:
 * starting equity, money between you and the business (every owner account
 * when `details` is on), profit, opening balances, ending equity, then any
 * loans with the owner. Each line's comparison comes from the same report.
 */
export function ownerStatement(data: ReportData, details: boolean): StatementRow[] {
  const comparing = !!data.filter.compare_from;
  const now = ownerTotals(data);
  const then = ownerTotals(data, true);
  const scope = periodScope(data);
  const compareScope: Partial<ReportFilter> = {
    ...scope,
    from: data.filter.compare_from ?? data.filter.from,
    to: data.filter.compare_to ?? data.filter.to,
  };
  const out: StatementRow[] = [];
  const values = (a: bigint, b: bigint) =>
    comparing ? [a.toString(), b.toString(), (a - b).toString()] : [a.toString()];
  const push = (
    key: string,
    label: string,
    kind: StatementRow["kind"],
    section: string,
    a: bigint,
    b: bigint,
    filter?: Partial<ReportFilter>,
    indent = false,
  ) =>
    out.push({
      key,
      label,
      kind,
      section,
      // Money moved by the owner is neither good nor bad; profit and equity are.
      side: key === "profit" || key === "start" || key === "end" ? "result" : "neutral",
      values: kind === "heading" ? [] : values(a, b),
      detail: filter ? [filter, { ...filter, from: compareScope.from, to: compareScope.to }] : undefined,
      indent,
    });
  const EQUITY = "Your equity";
  out.push({ key: "h-equity", label: EQUITY, kind: "heading", section: EQUITY, side: "result", values: [] });
  push("start", "Starting equity", "account", EQUITY, now.startingEquity, then.startingEquity);
  const owners = ownerAccounts(data);
  const net = (a: ReportAccount, previous = false) =>
    -big(previous ? a.compare_period_cents : a.period_cents);
  push(
    "net",
    "Put in, less taken out",
    "account",
    EQUITY,
    now.putIn - now.takenOut,
    then.putIn - then.takenOut,
    owners.length ? { ...scope, account_ids: owners.map((a) => a.id) } : undefined,
  );
  if (details)
    for (const a of owners.filter((x) => net(x) !== ZERO || (comparing && net(x, true) !== ZERO)))
      push(a.id, a.name, "account", EQUITY, net(a), net(a, true), { ...scope, account_ids: [a.id] }, true);
  push(
    "profit",
    "Profit",
    "account",
    EQUITY,
    now.profit,
    then.profit,
    { ...scope, account_types: ["income", "expense"] },
  );
  if (now.opening !== ZERO || then.opening !== ZERO) {
    const ids = openingAccounts(data).map((a) => a.id);
    push("opening", "Opening balances and corrections", "account", EQUITY, now.opening, then.opening, ids.length ? { ...scope, account_ids: ids } : undefined);
  }
  push("end", "Ending equity", "total", EQUITY, now.endingEquity, then.endingEquity);
  const loans = ownerLoanAccounts(data).filter(
    (a) => big(a.period_cents) !== ZERO || (comparing && big(a.compare_period_cents) !== ZERO),
  );
  if (loans.length) {
    const LOANS = "Loans with you";
    out.push({ key: "h-loans", label: LOANS, kind: "heading", section: LOANS, side: "result", values: [] });
    for (const a of loans)
      push(a.id, a.name, "account", LOANS, net(a), net(a, true), { ...scope, account_ids: [a.id] }, true);
  }
  return out;
}

/** Notes the exports and the coverage panel carry about how the report is built. */
export const OWNER_NOTES = [
  "Money put in is every credit to the owner equity accounts; money taken out is every debit. An account that holds money both ways splits the same way.",
  "Salary is officer compensation paid through payroll, before taxes. It is an expense of the business, not a draw.",
  "Ending equity matches the balance sheet. Starting equity is ending equity less this period's movement and profit.",
  "Comparison figures for money put in and taken out use each account's net movement in that period.",
];

/** Whether the owner has nothing on the books for this period. */
export function isEmptyOwnerReport(data: ReportData): boolean {
  const t = ownerTotals(data);
  return (
    t.putIn === ZERO &&
    t.takenOut === ZERO &&
    t.salary === ZERO &&
    t.endingEquity === ZERO &&
    big(data.totals.net_cents) === ZERO
  );
}

