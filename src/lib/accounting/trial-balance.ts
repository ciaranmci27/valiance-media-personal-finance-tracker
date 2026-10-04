import type { ReportAccount, ReportData, ReportFilter } from "./reports";
import { BOOKS_START } from "./balance-sheet";
import { fiscalYearStart } from "./fiscal-year";

/**
 * The trial balance as of a date: every account's balance in a debit or a
 * credit column. Assets, liabilities and equity show their balance through
 * the date; income and expenses show this fiscal year to date, and the
 * profit of earlier years (which the books never close into an account)
 * shows as its own line, so the columns add up the way an accountant
 * expects. Built from the balance sheet's read (from the start of the
 * books), which carries each account's ending balance and its year to date.
 */

const ZERO = BigInt(0);
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");

export type TrialType = "asset" | "liability" | "equity" | "income" | "expense";
export const TRIAL_TYPES: TrialType[] = ["asset", "liability", "equity", "income", "expense"];
export const TYPE_LABELS: Record<TrialType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};
const TYPE_ONE: Record<TrialType, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};
export const typeWord = (t: TrialType) => TYPE_ONE[t];

/** The line for profit of earlier years, which no account holds. */
export const PRIOR_PROFIT = "prior-profit";

export interface TrialLine {
  /** The account id, or PRIOR_PROFIT. */
  id: string;
  code: string | null;
  name: string;
  type: TrialType;
  /** Debit positive, credit negative. */
  balance: bigint;
  compare: bigint;
  debit: bigint;
  credit: bigint;
  account: ReportAccount | null;
}

const isResult = (a: Pick<ReportAccount, "account_type">) =>
  a.account_type === "income" || a.account_type === "expense";

/** Each account's balance on the trial balance (debit positive). */
export function trialBalanceOf(a: ReportAccount, previous = false): bigint {
  if (isResult(a)) return big(previous ? a.compare_year_cents : a.year_cents);
  return big(previous ? a.compare_ending_cents : a.ending_cents);
}

export function trialLines(data: ReportData, showZero = false): TrialLine[] {
  const comparing = !!data.filter.compare_to;
  const lines: TrialLine[] = data.accounts
    .map((a) => {
      const balance = trialBalanceOf(a),
        compare = comparing ? trialBalanceOf(a, true) : ZERO;
      return {
        id: a.id,
        code: a.code || null,
        name: a.name,
        type: a.account_type as TrialType,
        balance,
        compare,
        debit: balance > ZERO ? balance : ZERO,
        credit: balance < ZERO ? -balance : ZERO,
        account: a,
      };
    })
    .filter((l) => showZero || l.balance !== ZERO || l.compare !== ZERO);
  // Earlier years' profit is equity in all but name: the books compute it
  // rather than close it into an account, so it stands on its own line.
  const prior = -big(data.totals.prior_cents),
    priorThen = comparing ? -big(data.comparison.prior_cents) : ZERO;
  if (prior !== ZERO || priorThen !== ZERO)
    lines.push({
      id: PRIOR_PROFIT,
      code: null,
      name: "Profit from earlier years",
      type: "equity",
      balance: prior,
      compare: priorThen,
      debit: prior > ZERO ? prior : ZERO,
      credit: prior < ZERO ? -prior : ZERO,
      account: null,
    });
  const order = (l: TrialLine) => TRIAL_TYPES.indexOf(l.type);
  return lines.sort(
    (x, y) =>
      order(x) - order(y) ||
      (x.id === PRIOR_PROFIT ? 1 : y.id === PRIOR_PROFIT ? -1 : 0) ||
      (x.code ?? "~").localeCompare(y.code ?? "~") ||
      x.name.localeCompare(y.name),
  );
}

export interface TrialTotals {
  debits: bigint;
  credits: bigint;
  difference: bigint;
  /** Accounts with a balance on the date (the earlier-years line is not an account). */
  accounts: number;
  compareDebits: bigint;
  compareCredits: bigint;
  compareAccounts: number;
}

export function trialTotals(lines: TrialLine[]): TrialTotals {
  const sum = (f: (l: TrialLine) => bigint) => lines.reduce((s, l) => s + f(l), ZERO);
  const debits = sum((l) => l.debit),
    credits = sum((l) => l.credit);
  return {
    debits,
    credits,
    difference: debits - credits,
    accounts: lines.filter((l) => l.account && l.balance !== ZERO).length,
    compareDebits: sum((l) => (l.compare > ZERO ? l.compare : ZERO)),
    compareCredits: sum((l) => (l.compare < ZERO ? -l.compare : ZERO)),
    compareAccounts: lines.filter((l) => l.account && l.compare !== ZERO).length,
  };
}

export interface TypeTotal {
  type: TrialType;
  label: string;
  debit: bigint;
  credit: bigint;
  count: number;
}

export function byType(lines: TrialLine[]): TypeTotal[] {
  return TRIAL_TYPES.map((type) => {
    const list = lines.filter((l) => l.type === type && l.balance !== ZERO);
    return {
      type,
      label: TYPE_LABELS[type],
      debit: list.reduce((s, l) => s + l.debit, ZERO),
      credit: list.reduce((s, l) => s + l.credit, ZERO),
      count: list.length,
    };
  }).filter((t) => t.count > 0);
}

/**
 * The journal behind a line: through the date, or this fiscal year for
 * income and expenses (the year starts in the business settings' month).
 */
export function trialScope(
  data: ReportData,
  line: TrialLine,
  fiscalStartMonth = 1,
): Partial<ReportFilter> | undefined {
  if (!line.account) return undefined;
  return {
    from: isResult(line.account) ? fiscalYearStart(data.filter.to, fiscalStartMonth) : BOOKS_START,
    to: data.filter.to,
    mode: data.filter.mode,
    account_ids: [line.account.id],
    offset: 0,
  };
}

/* ------------------------------------------------------------------------ */
/* Worth a look                                                              */
/* ------------------------------------------------------------------------ */

export interface TrialCheck {
  key: string;
  tone: "look" | "info";
  title: string;
  detail: string;
  line?: TrialLine;
}

const money = (cents: bigint) => {
  const negative = cents < ZERO,
    v = negative ? -cents : cents;
  const whole = (v / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const part = (v % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${part}`;
};

/**
 * What an accountant would ask about, from what the books show. Each check
 * names the account and the amount; none of them says the books are wrong.
 */
export function trialChecks(data: ReportData, lines: TrialLine[]): TrialCheck[] {
  const checks: TrialCheck[] = [];
  const t = trialTotals(lines);
  if (t.difference !== ZERO)
    checks.push({
      key: "difference",
      tone: "look",
      title: `Debits and credits differ by ${money(t.difference < ZERO ? -t.difference : t.difference)}`,
      detail: "Every entry should balance. Review the transactions awaiting review and any incomplete ones.",
    });
  for (const l of lines) {
    const a = l.account;
    if (!a || l.balance === ZERO) continue;
    const debitSide = a.normal_side === "debit";
    const unusual = debitSide ? l.balance < ZERO : l.balance > ZERO;
    const amount = money(l.balance < ZERO ? -l.balance : l.balance);
    if ((a.purpose ?? "").startsWith("uncategorized")) {
      checks.push({
        key: `u-${a.id}`,
        tone: "look",
        title: `${a.name} holds ${amount}`,
        detail: "Money still waiting for a category. Your accountant will want it sorted before the books are final.",
        line: l,
      });
      continue;
    }
    if (a.subtype === "opening_balance" || a.purpose === "opening_balance_equity") {
      checks.push({
        key: `o-${a.id}`,
        tone: "info",
        title: `${a.name} holds ${amount}`,
        detail: "Opening balance equity usually ends at zero once opening balances are complete; your accountant may move it into owner equity or retained earnings.",
        line: l,
      });
      continue;
    }
    if (["transit", "undeposited"].includes(a.subtype ?? "") || ["transfers_in_transit", "undeposited_funds"].includes(a.purpose ?? "")) {
      checks.push({
        key: `t-${a.id}`,
        tone: "info",
        title: `${amount} is between your own accounts`,
        detail: `${a.name} holds money that left one account and has not arrived in the other. It clears once the other side is recorded.`,
        line: l,
      });
      continue;
    }
    if (!unusual) continue;
    // Draws and distributions sit on the debit side of equity by nature.
    if (a.account_type === "equity") continue;
    const detail =
      a.cash_kind === "bank" || a.cash_kind === "cash"
        ? "A bank or cash account in credit means more went out than came in: an overdraft, or a deposit not recorded yet."
        : a.cash_kind === "card"
          ? "A card with a debit balance means it was paid more than was spent on it: a refund or an overpayment."
          : a.account_type === "liability"
            ? "A payable in debit means more was paid than was owed, so the business is owed money back."
            : a.account_type === "expense"
              ? "An expense with a credit balance usually means a refund or a payment filed under the wrong category."
              : a.account_type === "income"
                ? "Income with a debit balance usually means refunds bigger than the sales, or income filed under the wrong category."
                : "An asset with a credit balance usually means a payment filed under the wrong account.";
    checks.push({
      key: `s-${a.id}`,
      tone: "look",
      title: `${a.name} has a ${l.balance < ZERO ? "credit" : "debit"} balance of ${amount}`,
      detail,
      line: l,
    });
  }
  if (data.filter.mode === "working") {
    const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
    if (awaiting > 0)
      checks.push({
        key: "drafts",
        tone: "info",
        title: `${awaiting} ${awaiting === 1 ? "transaction is" : "transactions are"} not reviewed yet`,
        detail: "They are included here. Switch Includes to Reviewed only for the figures your accountant will see as final.",
      });
  }
  if (data.quality.uncategorized_lines > 0)
    checks.push({
      key: "lines",
      tone: "look",
      title: `${data.quality.uncategorized_lines} reviewed ${data.quality.uncategorized_lines === 1 ? "line needs" : "lines need"} a category`,
      detail: "Reviewed transactions with lines still in an uncategorized account.",
    });
  return checks;
}

/** A balance as "$1,234.00 Dr" or "Cr". */
export function sideLabel(balance: bigint): string {
  if (balance === ZERO) return "$0.00";
  return `${money(balance < ZERO ? -balance : balance)} ${balance < ZERO ? "Cr" : "Dr"}`;
}

/** Notes the exports and the coverage panel carry about how the report is built. */
export const TRIAL_NOTES = [
  "Assets, liabilities and equity are balances through the date. Income and expenses are this fiscal year to date.",
  "The books do not close earlier years' profit into an account, so it is listed as Profit from earlier years under equity.",
  "Debit balances are in the Debit column and credit balances in the Credit column; the two columns add up to the same total when the books balance.",
];

