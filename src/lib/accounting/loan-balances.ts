import { formatCents } from "./money";
import { assetTies, type AssetTie } from "./fixed-assets";
import type { RegisterDetail, RegisterView } from "./registers";
import type { SupportReportData } from "./support-reports";

/**
 * Loan balances: what is owed on each loan, how much has been paid down,
 * how much of the payments was interest, and whether the register agrees
 * with the books. The loan register (accounting.support_report,
 * loan-register) gives each loan's principal balance as of a date and
 * compares the register with the loan accounts. The registers list adds
 * the lender, start date and first principal; each loan's detail adds its
 * posted movements (draws and payments, with the interest and fees the
 * payment recorded). The books store no rate or schedule, so nothing here
 * projects payments ahead.
 */

const ZERO = BigInt(0);
const big = (value: string | number | null | undefined) => BigInt(value || 0);

export function loanYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return [year, year - 1, year - 2, year - 3];
}

/** As of today in the current year, else the year's last day. */
export function loanScope(year: number, today: string) {
  const to = String(year) === today.slice(0, 4) ? today : `${year}-12-31`;
  return { report_id: "loan-register" as const, from: `${year}-01-01`, to, offset: 0 };
}

export interface LoanMovement {
  date: string;
  entryId: string;
  kind: string;
  /** Principal borrowed (draw) or repaid (payment), positive. */
  drawn: bigint;
  repaid: bigint;
  interest: bigint;
  fees: bigint;
}

/**
 * A loan's posted movements as of the date, from its lines: the loan
 * account's debits repay principal and its credits borrow it; interest and
 * fees are the lines on the loan's interest and fee accounts. Movements
 * reversed on or before the date are left out.
 */
export function loanMovements(detail: RegisterDetail, asOf: string): LoanMovement[] {
  const body = detail.record?.body as { account_id?: string; expense_account_id?: string; fee_account_id?: string } | undefined;
  const loan = body?.account_id,
    interest = body?.expense_account_id,
    fee = body?.fee_account_id;
  return detail.movements
    .filter((m) => m.effective_date <= asOf && !(m.void && m.void.effective_date <= asOf))
    .map((m) => {
      const on = (id: string | undefined) =>
        id ? (m.lines ?? []).filter((l) => l.account_id === id).reduce((s, l) => s + big(l.amount_cents), ZERO) : ZERO;
      const principal = on(loan);
      return {
        date: m.effective_date,
        entryId: m.entry_id,
        kind: m.kind,
        drawn: principal < ZERO ? -principal : ZERO,
        repaid: principal > ZERO ? principal : ZERO,
        interest: on(interest),
        fees: fee && fee !== interest ? on(fee) : ZERO,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface LoanLine {
  id: string;
  name: string;
  lender: string;
  started: string;
  /** The loan's first principal, as recorded in the register. */
  original: bigint;
  accountId: string | null;
  balance: bigint;
  /** Repaid to date, when the movements were read. */
  repaid: bigint | null;
  repaidThisYear: bigint | null;
  interestThisYear: bigint | null;
  feesThisYear: bigint | null;
  /** Share of everything borrowed that has been repaid, 0 to 100. */
  paidShare: number;
  /** A loan from the owner (a shareholder loan), by the lender or the loan's name. */
  shareholder: boolean;
}

/** Whether a loan is from the owner: the lender is an owner contact, or the name says so. */
export function isShareholderLoan(name: string, lender: string, owners: string[]): boolean {
  const l = lender.trim().toLowerCase();
  if (l && owners.some((o) => o.trim().toLowerCase() === l)) return true;
  return /\b(shareholder|owner|officer|member)\b/i.test(`${name} ${lender}`);
}

export function loanLines(
  data: SupportReportData,
  registers: RegisterView | null,
  details: Map<string, RegisterDetail> | null,
  owners: string[] = [],
): LoanLine[] {
  const info = new Map((registers?.rows ?? []).map((r) => [r.id, r]));
  const yearStart = `${data.filter.to.slice(0, 4)}-01-01`;
  return data.rows
    .map((r) => {
      const id = r.register_id ?? r.id;
      const [name, started, balanceText] = r.cells;
      const body = info.get(id)?.body as { lender?: string; initial_cents?: string; account_id?: string } | undefined;
      const detail = details?.get(id);
      const moves = detail ? loanMovements(detail, data.filter.to) : null;
      const year = moves?.filter((m) => m.date >= yearStart) ?? null;
      const sum = (list: LoanMovement[] | null, pick: (m: LoanMovement) => bigint) =>
        list ? list.reduce((s, m) => s + pick(m), ZERO) : null;
      const repaid = sum(moves, (m) => m.repaid);
      const drawn = sum(moves, (m) => m.drawn);
      const lender = body?.lender?.trim() ?? "";
      return {
        id,
        name,
        lender,
        started,
        original: big(body?.initial_cents),
        accountId: body?.account_id ?? null,
        balance: big(balanceText),
        repaid,
        repaidThisYear: sum(year, (m) => m.repaid),
        interestThisYear: sum(year, (m) => m.interest),
        feesThisYear: sum(year, (m) => m.fees),
        paidShare: repaid !== null && drawn ? Number((repaid * BigInt(1000)) / drawn) / 10 : 0,
        shareholder: isShareholderLoan(name, lender, owners),
      };
    })
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0) || a.name.localeCompare(b.name));
}

export interface LoanTotals {
  count: number;
  /** Loans with a balance. */
  open: number;
  owed: bigint;
  repaidThisYear: bigint | null;
  interestThisYear: bigint | null;
  feesThisYear: bigint | null;
}

export function loanTotals(lines: LoanLine[], data: SupportReportData): LoanTotals {
  const all = <K extends "repaidThisYear" | "interestThisYear" | "feesThisYear">(k: K) =>
    lines.length && lines.every((l) => l[k] !== null) ? lines.reduce((s, l) => s + (l[k] ?? ZERO), ZERO) : null;
  return {
    count: lines.length,
    open: lines.filter((l) => l.balance > ZERO).length,
    owed: big(data.total_cells[2]),
    repaidThisYear: all("repaidThisYear"),
    interestThisYear: all("interestThisYear"),
    feesThisYear: all("feesThisYear"),
  };
}

/** The register against the loan accounts. */
export function loanTies(data: SupportReportData): AssetTie[] {
  return assetTies(data, "record it in the loan's register, or move it");
}

export interface LoanYear {
  year: number;
  borrowed: bigint;
  repaid: bigint;
  interest: bigint;
  /** Owed at the year's end (or the as-of date for its year). */
  owed: bigint;
}

/** Principal borrowed and repaid each year, and what was owed at each year end, from posted movements only. */
export function loanHistory(details: RegisterDetail[], asOf: string): LoanYear[] {
  const moves = details.flatMap((d) => loanMovements(d, asOf));
  if (!moves.length) return [];
  const first = Number(moves[0].date.slice(0, 4));
  const firstYear = Math.min(...moves.map((m) => Number(m.date.slice(0, 4))), first);
  const last = Number(asOf.slice(0, 4));
  const out: LoanYear[] = [];
  let owed = ZERO;
  for (let y = firstYear; y <= last; y++) {
    const list = moves.filter((m) => m.date.startsWith(`${y}-`));
    const borrowed = list.reduce((s, m) => s + m.drawn, ZERO);
    const repaid = list.reduce((s, m) => s + m.repaid, ZERO);
    owed += borrowed - repaid;
    out.push({ year: y, borrowed, repaid, interest: list.reduce((s, m) => s + m.interest, ZERO), owed });
  }
  return out;
}

/** One sentence on the loans as of the date. */
export function loanSentence(t: LoanTotals, asOf: string): string {
  if (!t.count) return "No loans in the register.";
  if (!t.open) return `Every loan in the register is paid off as of ${asOf}.`;
  return `${formatCents(t.owed)} owed on ${t.open} ${t.open === 1 ? "loan" : "loans"}.`;
}

export const LOAN_NOTES = [
  "The register lists each loan recorded in Manage, Registers, with its principal balance as of the date: what was borrowed less what was repaid.",
  "Paid down and interest come from each loan's posted movements: the loan account's debits repay principal, and the interest is what the payment recorded on the loan's interest account.",
  "A loan from the owner (a shareholder loan) is marked as one when its lender is an owner contact or its name says so.",
  "The books store no rate or payment schedule, so nothing here projects payments ahead.",
];
