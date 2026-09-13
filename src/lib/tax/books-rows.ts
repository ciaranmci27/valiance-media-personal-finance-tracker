/**
 * Turning books figures into estimator rows, and keeping them fresh.
 *
 * A books row stores what the books report so far plus what the owner expects
 * for the rest of the year; `amount` is always the sum, so the tax engine
 * never has to know where a number came from. Everything here is pure and
 * safe in the browser.
 */
import type { BooksFigure } from "@/lib/accounting/tax-books-figures";
import {
  fromEstimatorDollars,
  toEstimatorDollars,
} from "@/lib/accounting/tax-projection";
import type {
  BooksFigureKey,
  BooksLink,
  TaxCapitalGainEntry,
  TaxClassification,
  TaxIncomeSource,
  TaxPaymentEntry,
} from "@/types/database";

export type BooksRole =
  | "business_profit"
  | "wages"
  | "investment"
  | "gain"
  | "withholding";

/** Cent rounding through the exact decimal converters, so 10.075 is 10.08. */
const round = (dollars: number) => {
  try {
    return toEstimatorDollars(fromEstimatorDollars(dollars));
  } catch {
    return Math.round(dollars * 100) / 100;
  }
};
const newId = () => crypto.randomUUID();

export function booksRole(key: BooksFigureKey): BooksRole {
  if (key === "business_profit") return "business_profit";
  if (key === "interest" || key === "qualified_dividend") return "investment";
  if (key === "short_gain" || key === "long_gain") return "gain";
  if (key.startsWith("payroll:wages:")) return "wages";
  return "withholding";
}

/** The books role a template chip stands for, so a books row can satisfy it. */
export function templateBooksRole(
  template: Pick<TaxIncomeSource, "name" | "income_type">,
): "business_profit" | "wages" | "investment" | null {
  if (template.income_type === "w2") return "wages";
  if (template.income_type === "k1") return "business_profit";
  if (template.income_type === "qualified_dividend") return "investment";
  if (template.income_type === "1099") {
    if (/interest|dividend/i.test(template.name)) return "investment";
    if (/business|profit/i.test(template.name)) return "business_profit";
  }
  return null;
}

export function booksAmount(link: Pick<BooksLink, "actual" | "rest">): number {
  return round(link.actual + link.rest);
}

/** Wage bases for a payroll wages row: each verified base plus the rest of year. */
export function booksWageBases(
  link: BooksLink,
  state: string | null,
): TaxIncomeSource["wage_bases"] | undefined {
  if (!link.bases) return undefined;
  const bases: NonNullable<TaxIncomeSource["wage_bases"]> = {
    social_security: round(link.bases.social_security + link.rest),
    medicare: round(link.bases.medicare + link.rest),
  };
  if (link.bases.state !== undefined && state) {
    bases.state = round(link.bases.state + link.rest);
    bases.state_code = state;
  }
  return bases;
}

function linkFromFigure(figure: BooksFigure, now: string): BooksLink {
  const link: BooksLink = {
    key: figure.key,
    actual: toEstimatorDollars(figure.amount_cents),
    through: figure.through,
    rest: 0,
    document_id: figure.document_id,
    refreshed_at: now,
  };
  if (figure.wage_bases_cents) {
    link.bases = {
      social_security: toEstimatorDollars(figure.wage_bases_cents.social_security),
      medicare: toEstimatorDollars(figure.wage_bases_cents.medicare),
      ...(figure.wage_bases_cents.state !== undefined
        ? { state: toEstimatorDollars(figure.wage_bases_cents.state) }
        : {}),
    };
  }
  return link;
}

export interface EstimatorRows {
  income: TaxIncomeSource[];
  gains: TaxCapitalGainEntry[];
  payments: TaxPaymentEntry[];
}

export interface RowsFromFiguresContext {
  taxClassification: TaxClassification | null;
  state: string | null;
  /** ISO timestamp stamped as `refreshed_at`. */
  now: string;
  existing: EstimatorRows;
}

/**
 * Adds the chosen figures as rows. An untouched template row (same role,
 * zero amount, not synced from income tracking) is adopted instead of
 * duplicated, so a "Business Profit" chip becomes the books row.
 */
export function rowsFromFigures(
  figures: BooksFigure[],
  ctx: RowsFromFiguresContext,
): EstimatorRows & { firstId: string | null; addedIds: string[] } {
  const income = ctx.existing.income.map((row) => ({ ...row }));
  const gains = ctx.existing.gains.map((row) => ({ ...row }));
  const payments = ctx.existing.payments.map((row) => ({ ...row }));
  const addedIds: string[] = [];
  const existingKeys = new Set<string>(
    [...income, ...gains, ...payments].flatMap((row) => (row.books ? [row.books.key] : [])),
  );
  // Wages rows added in this pass, so withholding can pair with them.
  const wagesRowByEmployee = new Map<string, string>();

  const adoptIncome = (role: "business_profit" | "wages" | "investment") =>
    income.find(
      (row) =>
        !row.books &&
        !row.linked_source_id &&
        row.amount === 0 &&
        templateBooksRole(row) === role,
    );

  for (const figure of figures) {
    if (!figure.available || existingKeys.has(figure.key)) continue;
    existingKeys.add(figure.key);
    const link = linkFromFigure(figure, ctx.now);
    const amount = booksAmount(link);
    const role = booksRole(figure.key);

    if (figure.kind === "gain") {
      const row: TaxCapitalGainEntry = {
        id: newId(),
        description: figure.label,
        amount,
        term: figure.term ?? "long",
        books: link,
      };
      gains.push(row);
      addedIds.push(row.id);
      continue;
    }

    if (figure.kind === "withholding") {
      const employeeKey = figure.key.split(":").slice(2).join(":");
      const wagesId = wagesRowByEmployee.get(employeeKey);
      const type = figure.jurisdiction ?? "federal";
      const adopted = payments.find(
        (row) =>
          !row.books &&
          row.category !== "payment" &&
          row.type === type &&
          row.amount === 0 &&
          !!wagesId &&
          row.linked_income_id === wagesId,
      );
      const target: TaxPaymentEntry = adopted ?? {
        id: newId(),
        type,
        category: "withholding",
        label: figure.label,
        amount,
      };
      target.category = "withholding";
      target.label = adopted ? target.label || figure.label : figure.label;
      target.amount = amount;
      target.books = link;
      target.verified_through = link.through;
      if (figure.document_id) target.document_id = figure.document_id;
      else delete target.document_id;
      if (wagesId) target.linked_income_id = wagesId;
      if (!adopted) payments.push(target);
      addedIds.push(target.id);
      continue;
    }

    // Income
    const adopted =
      role === "business_profit" || role === "wages" || role === "investment"
        ? adoptIncome(role)
        : undefined;
    const typed = incomeTyping(figure, ctx.taxClassification);
    const target: TaxIncomeSource = adopted ?? {
      id: newId(),
      name: figure.label,
      amount,
      subject_to_se: typed.subject_to_se,
      income_type: typed.income_type,
    };
    target.amount = amount;
    target.income_type = typed.income_type;
    target.subject_to_se = typed.subject_to_se;
    if (typed.materially_participates !== undefined) {
      target.materially_participates = typed.materially_participates;
    }
    target.books = link;
    const wageBases = booksWageBases(link, ctx.state);
    if (wageBases) target.wage_bases = wageBases;
    if (!adopted) income.push(target);
    addedIds.push(target.id);
    if (role === "wages") {
      wagesRowByEmployee.set(figure.key.split(":").slice(2).join(":"), target.id);
    }
  }

  return { income, gains, payments, firstId: addedIds[0] ?? null, addedIds };
}

function incomeTyping(
  figure: BooksFigure,
  classification: TaxClassification | null,
): Pick<TaxIncomeSource, "income_type" | "subject_to_se"> & {
  materially_participates?: boolean;
} {
  if (figure.key === "business_profit") {
    if (classification === "s_corp" || classification === "partnership") {
      return { income_type: "k1", subject_to_se: false, materially_participates: true };
    }
    return { income_type: "1099", subject_to_se: true };
  }
  if (figure.income_type === "w2") return { income_type: "w2", subject_to_se: false };
  if (figure.income_type === "qualified_dividend") {
    return { income_type: "qualified_dividend", subject_to_se: false };
  }
  return { income_type: figure.income_type ?? "1099", subject_to_se: false };
}

export interface BooksRefreshResult extends EstimatorRows {
  changed: boolean;
  /** Rows whose figure moved, for the owner to see. */
  moved: { id: string; name: string; from: number; to: number }[];
  /** Rows that could not be refreshed; their values were kept. */
  problems: string[];
}

/**
 * Applies fresh figures to the rows that carry a books link. A row is only
 * rewritten on a cents-exact difference, is never zeroed because a figure
 * went missing, and only loses its rest-of-year amount once the books cover
 * the whole year.
 */
export function applyBooksRefresh(
  rows: EstimatorRows,
  figures: BooksFigure[],
  ctx: { state: string | null; now: string },
): BooksRefreshResult {
  const byKey = new Map(figures.map((figure) => [figure.key, figure]));
  const moved: BooksRefreshResult["moved"] = [];
  const problems: string[] = [];
  let changed = false;

  function refresh<T extends { id: string; amount: number; books?: BooksLink }>(
    row: T,
    name: string,
  ): T {
    if (!row.books) return row;
    const figure = byKey.get(row.books.key);
    if (!figure) {
      problems.push(`${name} is no longer offered by the books`);
      return row;
    }
    if (!figure.available) {
      problems.push(`${name}: ${figure.reason ?? "unavailable"}`);
      return row;
    }
    let link: BooksLink;
    try {
      link = linkFromFigure(figure, ctx.now);
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : "invalid figure"}`);
      return row;
    }
    const yearComplete = figure.through.endsWith("-12-31");
    const rest = yearComplete ? 0 : row.books.rest;
    const same =
      fromEstimatorDollars(row.books.actual) === figure.amount_cents &&
      row.books.through === figure.through &&
      (row.books.document_id ?? null) === (figure.document_id ?? null) &&
      rest === row.books.rest &&
      JSON.stringify(row.books.bases ?? null) === JSON.stringify(link.bases ?? null);
    if (same) return row;

    const nextLink: BooksLink = { ...link, rest };
    const before = row.amount;
    const after = booksAmount(nextLink);
    if (before !== after) moved.push({ id: row.id, name, from: before, to: after });
    changed = true;
    return { ...row, amount: after, books: nextLink };
  }

  const income = rows.income.map((row) => {
    const next = refresh(row, row.name || "Income");
    if (next === row || !next.books) return next;
    const wageBases = booksWageBases(next.books, ctx.state);
    return wageBases ? { ...next, wage_bases: wageBases } : next;
  });
  const gains = rows.gains.map((row) => refresh(row, row.description || "Capital gain"));
  const payments = rows.payments.map((row) => {
    const next = refresh(row, row.label || "Withholding");
    if (next === row || !next.books) return next;
    const withDoc: TaxPaymentEntry = { ...next, verified_through: next.books.through };
    if (next.books.document_id) withDoc.document_id = next.books.document_id;
    else delete withDoc.document_id;
    return withDoc;
  });

  return { income, gains, payments, changed, moved, problems };
}

/** The amount stays; the row becomes a manual one. */
export function unlinkBooks<T extends { books?: BooksLink }>(row: T): T {
  const next = { ...row };
  delete next.books;
  return next;
}

/** Owner typed a new rest-of-year figure. */
export function withRest<T extends { amount: number; books?: BooksLink }>(
  row: T,
  rest: number,
  state: string | null,
): T {
  if (!row.books) return row;
  const books: BooksLink = { ...row.books, rest: round(rest) };
  const next = { ...row, amount: booksAmount(books), books } as T & {
    wage_bases?: TaxIncomeSource["wage_bases"];
  };
  const wageBases = booksWageBases(books, state);
  if (wageBases) next.wage_bases = wageBases;
  return next;
}
