import { formatCents } from "./money";
import type { RegisterView } from "./registers";
import type { SupportReportData } from "./support-reports";

/**
 * Fixed assets: what equipment the business owns, what it is worth on the
 * books, how much depreciation is this year's, and whether the register
 * agrees with the balance sheet. The asset register (accounting.support_
 * report, asset-register) lists each register asset as of a date with its
 * recorded cost, accumulated depreciation and carrying value, and its
 * controls compare the register with the fixed asset and accumulated
 * depreciation accounts. The registers list (accounting.registers) adds
 * each asset's in-service date, method (the owner's own words) and status.
 * Everything here is posted activity; no future depreciation is projected,
 * because the books do not store a schedule.
 */

const ZERO = BigInt(0);
const big = (value: string | number | null | undefined) => BigInt(value || 0);

/** This year and the three before it. */
export function assetYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return [year, year - 1, year - 2, year - 3];
}

/** As of today in the current year, else the year's last day. */
export function assetScope(year: number, today: string) {
  const to = String(year) === today.slice(0, 4) ? today : `${year}-12-31`;
  return { report_id: "asset-register" as const, from: `${year}-01-01`, to, offset: 0 };
}

/** The previous year's end, for this year's depreciation. */
export function priorScope(scope: { to: string }) {
  const end = `${Number(scope.to.slice(0, 4)) - 1}-12-31`;
  return { report_id: "asset-register" as const, from: end, to: end, offset: 0 };
}

export interface AssetLine {
  id: string;
  name: string;
  acquired: string;
  inService: string | null;
  method: string;
  /** The fixed asset account, when the registers list was read. */
  accountId: string | null;
  cost: bigint;
  accumulated: bigint;
  book: bigint;
  /** Share of cost depreciated, 0 to 100. */
  used: number;
  /** Depreciation posted this year; null when the prior year is not known, or the asset left the books this year. */
  thisYear: bigint | null;
  disposed: boolean;
}

/** Each register asset as of the date, with this year's depreciation when the prior year end is read. */
export function assetLines(
  data: SupportReportData,
  prior: SupportReportData | null,
  registers: RegisterView | null,
): AssetLine[] {
  const before = new Map((prior?.rows ?? []).map((r) => [r.register_id ?? r.id, r.cells]));
  const info = new Map((registers?.rows ?? []).map((r) => [r.id, r]));
  return data.rows
    .map((r) => {
      const id = r.register_id ?? r.id;
      const [name, acquired, costText, accumulatedText, bookText] = r.cells;
      const cost = big(costText),
        accumulated = big(accumulatedText),
        book = big(bookText);
      const reg = info.get(id);
      const body = reg?.body as { in_service_on?: string; method?: string; account_id?: string } | undefined;
      const earlier = before.get(id);
      const disposed = !!(reg?.state?.disposed || (cost === ZERO && earlier && big(earlier[2]) > ZERO));
      const thisYear =
        prior === null || disposed
          ? null
          : accumulated - (earlier ? big(earlier[3]) : ZERO);
      return {
        id,
        name,
        acquired,
        inService: body?.in_service_on ?? null,
        method: body?.method?.trim() ?? "",
        accountId: body?.account_id ?? null,
        cost,
        accumulated,
        book,
        used: cost > ZERO ? Number((accumulated * BigInt(1000)) / cost) / 10 : 0,
        thisYear,
        disposed,
      };
    })
    .sort((a, b) => Number(a.disposed) - Number(b.disposed) || (b.cost > a.cost ? 1 : b.cost < a.cost ? -1 : 0) || a.name.localeCompare(b.name));
}

export interface AssetTotals {
  count: number;
  cost: bigint;
  accumulated: bigint;
  book: bigint;
  /** Null when the prior year end was not read. */
  thisYear: bigint | null;
}

export function assetTotals(lines: AssetLine[], data: SupportReportData): AssetTotals {
  const held = lines.filter((l) => !l.disposed);
  const known = lines.length > 0 && lines.every((l) => l.thisYear !== null || l.disposed);
  return {
    count: held.length,
    cost: big(data.total_cells[2]),
    accumulated: big(data.total_cells[3]),
    book: big(data.total_cells[4]),
    thisYear: known ? held.reduce((s, l) => s + (l.thisYear ?? ZERO), ZERO) : null,
  };
}

export interface AssetTie {
  key: string;
  tone: "good" | "look";
  accountId: string;
  account: string;
  /** What the register says the account should hold, on the account's usual side. */
  register: bigint;
  books: bigint;
  title: string;
  detail: string;
}

/**
 * The register against the books, account by account: the fixed asset
 * accounts hold the assets' cost, the accumulated depreciation accounts
 * hold their depreciation. A difference is an entry booked to the account
 * outside the register, or a register entry missing from the books.
 */
export function assetTies(data: SupportReportData, fix = "add it as an asset, or move it"): AssetTie[] {
  return (data.controls?.rows ?? []).map((r) => {
    const register = big(r.register_cents),
      books = big(r.book_cents);
    // Accumulated depreciation and loans sit on the credit side: read them as positive amounts.
    const side = register < ZERO || books < ZERO ? BigInt(-1) : BigInt(1);
    const reg = side * register,
      bk = side * books;
    const diff = bk - reg;
    return diff === ZERO
      ? {
          key: r.account_id,
          tone: "good" as const,
          accountId: r.account_id,
          account: r.name,
          register: reg,
          books: bk,
          title: `${r.name} ties to the register`,
          detail: `${formatCents(bk)} in the books, the same as the register.`,
        }
      : {
          key: r.account_id,
          tone: "look" as const,
          accountId: r.account_id,
          account: r.name,
          register: reg,
          books: bk,
          title: `${r.name} ${diff > ZERO ? "holds" : "is short"} ${formatCents(diff > ZERO ? diff : -diff)} ${diff > ZERO ? "more than the register" : "of the register"}`,
          detail:
            diff > ZERO
              ? `The books hold ${formatCents(bk)}; the register explains ${formatCents(reg)}. Something was booked to this account outside the register: ${fix}.`
              : `The register expects ${formatCents(reg)}; the books hold ${formatCents(bk)}. A register entry is not in the books as of this date.`,
        };
  });
}

export interface AssetYear {
  year: number;
  /** Depreciation posted in the year, all register assets. */
  depreciation: bigint;
  /** Book value at the year's end (or the as-of date for the current year). */
  book: bigint;
}

/**
 * Depreciation posted each year, from the register at each year end: the
 * increase in accumulated depreciation, assets that left the books aside.
 * Only years the register covers, never a projection.
 */
export function assetHistory(ends: { year: number; data: SupportReportData }[]): AssetYear[] {
  const sorted = [...ends].sort((a, b) => a.year - b.year);
  const out: AssetYear[] = [];
  let previous: Map<string, string[]> = new Map();
  for (const { year, data } of sorted) {
    const now = new Map(data.rows.map((r) => [r.register_id ?? r.id, r.cells]));
    let depreciation = ZERO;
    for (const [id, cells] of now) {
      const before = previous.get(id);
      const gone = big(cells[2]) === ZERO && before && big(before[2]) > ZERO;
      if (!gone) depreciation += big(cells[3]) - (before ? big(before[3]) : ZERO);
    }
    if (data.rows.length) out.push({ year, depreciation, book: big(data.total_cells[4]) });
    previous = now;
  }
  return out;
}

export const ASSET_NOTES = [
  "The register lists each asset recorded in Manage, Registers, with its cost, the depreciation posted to it, and its book value (cost less depreciation) as of the date.",
  "This year's depreciation is the depreciation posted since the end of last year. An asset sold or written off this year is shown at nothing and left out of it.",
  "Ties to the books compare the register with the fixed asset and accumulated depreciation accounts. A difference means something was booked to those accounts outside the register.",
  "The books store no future schedule, so nothing here projects depreciation ahead. Methods are the descriptions you gave each asset.",
];
