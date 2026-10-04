import type { ReportAccount, ReportData, ReportDetail, ReportFilter } from "./reports";
import { fiscalYearStart } from "./fiscal-year";

/**
 * The general ledger: each account's lines for a period with a running
 * balance. The books return every line's running balance from the start of
 * the books (accounting.report_lines). That is the balance for assets,
 * liabilities and equity. For income and expenses the ledger reads like the
 * profit and loss instead: the balance starts at the fiscal year's start, so
 * the opening is this fiscal year before the period; a period that spans
 * fiscal years shows only its own activity.
 */

const ZERO = BigInt(0);
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");

export type LedgerType = "asset" | "liability" | "equity" | "income" | "expense";
export const LEDGER_TYPES: LedgerType[] = ["asset", "liability", "equity", "income", "expense"];
export const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

const isResult = (a: Pick<ReportAccount, "account_type">) =>
  a.account_type === "income" || a.account_type === "expense";

/**
 * Balances read on each account's usual side: assets and expenses as
 * debits, liabilities, equity and income as credits. A negative balance is
 * on the unusual side (a contra account, an overdrawn bank).
 */
export const usualSide = (type: string) =>
  type === "liability" || type === "equity" || type === "income" ? BigInt(-1) : BigInt(1);

/** Whether the period sits inside one fiscal year. */
export function oneFiscalYear(filter: { from: string; to: string }, fiscalMonth = 1): boolean {
  return fiscalYearStart(filter.from, fiscalMonth) === fiscalYearStart(filter.to, fiscalMonth);
}

/**
 * What to take off the books' running balance for an account: nothing for
 * balance sheet accounts; for income and expenses, everything before the
 * fiscal year (when the period is in one fiscal year) or before the period.
 * The report's prior balance is the balance before the fiscal year of the
 * period's end, from the same business settings.
 */
export function ledgerOffset(a: ReportAccount, data: ReportData, fiscalMonth = 1): bigint {
  if (!isResult(a)) return ZERO;
  return oneFiscalYear(data.filter, fiscalMonth) ? big(a.prior_cents) : big(a.opening_cents);
}

/** What the selected income or expense account's balance means, said plainly. */
export function basisSentence(filter: { from: string; to: string }, fiscalMonth = 1): string {
  return oneFiscalYear(filter, fiscalMonth)
    ? "The balance runs from the start of the fiscal year."
    : "This period spans fiscal years, so the balance is this period's activity.";
}

export interface LedgerAccount {
  id: string;
  code: string | null;
  name: string;
  type: LedgerType;
  opening: bigint;
  debit: bigint;
  credit: bigint;
  closing: bigint;
  /** The period's change, on the account's usual side (see usualSide). */
  change: bigint;
  account: ReportAccount;
}

/** Every account with a balance or activity, in type and number order. */
export function ledgerAccounts(data: ReportData, fiscalMonth = 1): LedgerAccount[] {
  return data.accounts
    .map((a) => {
      const offset = ledgerOffset(a, data, fiscalMonth);
      const side = usualSide(a.account_type);
      return {
        id: a.id,
        code: a.code || null,
        name: a.name,
        type: a.account_type as LedgerType,
        opening: side * (big(a.opening_cents) - offset),
        debit: big(a.debit_cents),
        credit: big(a.credit_cents),
        closing: side * (big(a.ending_cents) - offset),
        change: side * big(a.period_cents),
        account: a,
      };
    })
    .filter((a) => a.debit !== ZERO || a.credit !== ZERO || a.opening !== ZERO || a.closing !== ZERO)
    .sort(
      (x, y) =>
        LEDGER_TYPES.indexOf(x.type) - LEDGER_TYPES.indexOf(y.type) ||
        (x.code ?? "~").localeCompare(y.code ?? "~") ||
        x.name.localeCompare(y.name),
    );
}

export interface LedgerTotals {
  debits: bigint;
  credits: bigint;
  /** Accounts with any debit or credit in the period. */
  active: number;
}

export function ledgerTotals(accounts: LedgerAccount[]): LedgerTotals {
  return {
    debits: accounts.reduce((s, a) => s + a.debit, ZERO),
    credits: accounts.reduce((s, a) => s + a.credit, ZERO),
    active: accounts.filter((a) => a.debit !== ZERO || a.credit !== ZERO).length,
  };
}

export interface LedgerLine {
  id: string;
  entryId: string;
  date: string;
  description: string;
  /** The line's own note, when it has one. */
  note: string;
  accountId: string;
  account: string;
  debit: bigint;
  credit: bigint;
  /** What the line did to its account, on the account's usual side (+ grows it). */
  change: bigint;
  /** The account's balance after this line, on the ledger's basis and its usual side. */
  balance: bigint;
  draft: boolean;
}

/** The books' lines as ledger lines, balances on the ledger's basis. */
export function ledgerLines(
  rows: ReportDetail["rows"],
  data: ReportData,
  fiscalMonth = 1,
): LedgerLine[] {
  const offsets = new Map(data.accounts.map((a) => [a.id, ledgerOffset(a, data, fiscalMonth)]));
  return rows.map((r) => {
    const amount = big(r.amount_cents);
    return {
      id: r.id,
      entryId: r.entry_id,
      date: r.entry_date,
      description: r.memo,
      note: r.line_memo,
      accountId: r.account_id,
      account: r.account_name,
      debit: amount > ZERO ? amount : ZERO,
      credit: amount < ZERO ? -amount : ZERO,
      change: usualSide(r.account_type) * amount,
      balance:
        usualSide(r.account_type) * (big(r.running_cents) - (offsets.get(r.account_id) ?? ZERO)),
      draft: r.status === "draft",
    };
  });
}

/**
 * Lines matching a search: words in the description, note or account, or an
 * amount ("1,250", "1250.00" or "$1250" all find $1,250.00).
 */
export function matchLines(lines: LedgerLine[], query: string): LedgerLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  const digits = q.replace(/[$,\s]/g, "");
  const amount = /^\d+(\.\d{1,2})?$/.test(digits)
    ? BigInt(Math.round(Number(digits) * 100))
    : null;
  return lines.filter(
    (l) =>
      `${l.description} ${l.note} ${l.account}`.toLowerCase().includes(q) ||
      (amount !== null && (l.debit === amount || l.credit === amount)),
  );
}

/** The scope the ledger reads lines for: one account, or every account. */
export function ledgerScope(data: ReportData, accountId: string | null): ReportFilter {
  return {
    from: data.filter.from,
    to: data.filter.to,
    mode: data.filter.mode,
    offset: 0,
    ...(accountId ? { account_ids: [accountId] } : {}),
  };
}

/** Notes the exports and the coverage panel carry about how the report is built. */
export const LEDGER_NOTES = [
  "Each account lists its lines in date order with the balance after each line.",
  "Balances read on each account's usual side: assets and expenses as debits; liabilities, equity and income as credits. A negative balance sits on the unusual side, as a contra account or an overdrawn bank does.",
  "Assets, liabilities and equity carry their balance from the start of the books. Income and expenses start from the fiscal year, so their balance reads like the profit and loss; a period that spans fiscal years shows only its own activity.",
  "Descriptions are the transaction's description as the books hold it; contacts appear in it where the bank or the owner recorded them.",
];

export interface LedgerSection {
  account: LedgerAccount;
  lines: LedgerLine[];
}

/** Lines grouped under their accounts, in the ledger's account order, each account's lines in date order. */
export function ledgerSections(accounts: LedgerAccount[], lines: LedgerLine[]): LedgerSection[] {
  const by = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const list = by.get(l.accountId);
    if (list) list.push(l);
    else by.set(l.accountId, [l]);
  }
  return accounts.map((account) => ({ account, lines: by.get(account.id) ?? [] }));
}

/** The line's description with its own note, as the exports print it. */
export const lineText = (l: Pick<LedgerLine, "description" | "note">) =>
  l.note && l.note !== l.description
    ? `${l.description || "No description"} / ${l.note}`
    : l.description || "No description";
