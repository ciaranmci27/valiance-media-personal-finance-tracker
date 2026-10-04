import { CLASSIFICATION_PHRASES, type ProfileClassification } from "../business-classification";
import { formatCents } from "./money";
import type { SupportReportData } from "./support-reports";
import { treatmentLabel, type TaxSource } from "./tax-workpapers";

/**
 * The tax workpapers report: what the owner hands a tax preparer (or types
 * into a return) for a tax year, and what is not ready yet. Everything here
 * is the books' own figures from accounting.tax_source: each income and
 * expense account's book amount, the amount its tax treatment counts as
 * ordinary income, the owner's adjustments and the separately stated items.
 * Tax years are calendar years, as the books key them. These are the books'
 * figures to hand a preparer, never a tax outcome.
 */

const ZERO = BigInt(0);
const big = (value: string | number | undefined | null) => BigInt(value || 0);

/** The tax source the report carries, when the books returned one. */
export const taxSourceOf = (data: SupportReportData): TaxSource | null => data.tax_workpaper ?? null;

/** The tax years offered: this year and the three before it. */
export function taxYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return [year, year - 1, year - 2, year - 3];
}

/** January 1 through today in the current year, else the whole year. */
export function taxScope(year: number, today: string) {
  const through = String(year) === today.slice(0, 4) ? today : `${year}-12-31`;
  return { report_id: "tax-workpapers" as const, from: `${year}-01-01`, to: through, offset: 0 };
}

/** Treatments in the order a return reads: income, then deductions, then the rest. */
const TREATMENT_ORDER = [
  "gross_receipts",
  "interest",
  "qualified_dividend",
  "short_gain",
  "long_gain",
  "tax_exempt",
  "cogs",
  "officer_compensation",
  "salaries",
  "payroll_taxes",
  "rent",
  "advertising",
  "meals_50",
  "travel",
  "depreciation",
  "other_deduction",
  "charity",
  "nondeductible",
  "balance_sheet_only",
];
/** Treatments the books count at their deductible share. */
const DEDUCTIBLE = new Set([
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

export interface TaxLine {
  id: string;
  code: string;
  name: string;
  type: "income" | "expense";
  /** The tax treatment token, or null when the account has none for the year. */
  treatment: string | null;
  /** The treatment as the owner reads it. */
  label: string;
  /** The share counted, 0 to 100, for deductible treatments. */
  percent: number | null;
  separately: boolean;
  /** Profit contribution in the books: income adds, expenses subtract. */
  book: bigint;
  /** What the treatment counts toward ordinary income. */
  tax: bigint;
  /** Tax less book. */
  adjustment: bigint;
}

/** Every income and expense account with activity in the year, by treatment. */
export function taxLines(source: TaxSource): TaxLine[] {
  return source.accounts
    .filter((a) => a.line_count > 0)
    .map((a) => {
      const treatment = a.mapping?.concept ?? null;
      const book = big(a.book_cents);
      const tax = big(a.ordinary_cents);
      const bps = a.mapping?.deductible_bps ?? 10000;
      return {
        id: a.account_id,
        code: a.code,
        name: a.name,
        type: a.account_type,
        treatment,
        label: treatment ? treatmentLabel(treatment) : "No tax treatment yet",
        percent: treatment && DEDUCTIBLE.has(treatment) ? bps / 100 : null,
        separately: !!(a.mapping as { separately_stated?: boolean } | null)?.separately_stated,
        book,
        tax,
        adjustment: tax - book,
      };
    })
    .sort(
      (x, y) =>
        rank(x.treatment) - rank(y.treatment) ||
        (x.code ?? "").localeCompare(y.code ?? "") ||
        x.name.localeCompare(y.name),
    );
}
const rank = (t: string | null) => {
  if (t === null) return 1000;
  const i = TREATMENT_ORDER.indexOf(t);
  return i < 0 ? 900 : i;
};

/** Accounts grouped under their treatment, in return order; untreated last. */
export function taxGroups(lines: TaxLine[]): { key: string; label: string; lines: TaxLine[] }[] {
  const out: { key: string; label: string; lines: TaxLine[] }[] = [];
  for (const l of lines) {
    const key = l.treatment ?? "none";
    const group = out.find((g) => g.key === key);
    if (group) group.lines.push(l);
    else out.push({ key, label: l.label, lines: [l] });
  }
  return out;
}

/** Adjustments that change ordinary income; the others are separately stated. */
const SEPARATE_CONCEPTS = new Set([
  "stock_basis_opening",
  "debt_basis_opening",
  "interest",
  "qualified_dividend",
  "short_gain",
  "long_gain",
  "charity",
  "tax_exempt",
]);

export interface TaxAdjustmentLine {
  id: string;
  reason: string;
  concept: string;
  label: string;
  date: string;
  amount: bigint;
  /** Changes ordinary income (false: separately stated or basis). */
  ordinary: boolean;
  /** A supporting document is attached. */
  supported: boolean;
}

export function taxAdjustments(source: TaxSource): TaxAdjustmentLine[] {
  return source.adjustments.map((a) => ({
    id: a.id,
    reason: a.reason,
    concept: a.concept,
    label: treatmentLabel(a.concept),
    date: a.effective_date,
    amount: big(a.amount_cents),
    ordinary: !SEPARATE_CONCEPTS.has(a.concept),
    supported: !!a.document_id,
  }));
}

export interface TaxTotals {
  book: bigint;
  /** What the treatments count, before the owner's adjustments. */
  mapped: bigint;
  /** The books' ordinary income: treatments plus ordinary adjustments. */
  taxable: bigint;
  /** Taxable less book. */
  difference: bigint;
  /** Readiness items that need the owner. */
  notReady: number;
  untreated: number;
}

export function taxTotals(source: TaxSource, readiness: TaxCheck[]): TaxTotals {
  return {
    book: big(source.book_profit_cents),
    mapped: big(source.mapped_ordinary_cents),
    taxable: big(source.adjusted_ordinary_cents),
    difference: big(source.book_to_tax_cents),
    notReady: readiness.filter((c) => c.tone === "look").length,
    untreated: taxLines(source).filter((l) => l.treatment === null).length,
  };
}

export interface BridgeLine {
  key: string;
  label: string;
  hint: string;
  amount: bigint;
  /** The accounts behind the line, for the drill. */
  accounts: string[];
}

/**
 * From book profit to the books' taxable profit: each kind of difference
 * as one line (the part of meals not counted, nondeductible amounts, items
 * stated separately, accounts with no treatment yet), then each ordinary
 * adjustment with its reason. A difference the lines do not explain is
 * shown as its own line, so the bridge always ends on the books' figure.
 */
export function taxBridge(source: TaxSource): { start: bigint; lines: BridgeLine[]; end: bigint } {
  const lines = taxLines(source);
  const out: BridgeLine[] = [];
  // Each account explains one line only, the first that fits.
  const used = new Set<string>();
  const add = (key: string, label: string, hint: string, match: (l: TaxLine) => boolean) => {
    const list = lines.filter((l) => !used.has(l.id) && match(l) && l.adjustment !== ZERO);
    if (!list.length) return;
    list.forEach((l) => used.add(l.id));
    out.push({ key, label, hint, amount: list.reduce((s, l) => s + l.adjustment, ZERO), accounts: list.map((l) => l.id) });
  };
  add("untreated", "No tax treatment yet", "Left out until each account has a treatment", (l) => l.treatment === null);
  add("meals", "Meals not counted", "The share of meals the treatment leaves out", (l) => l.treatment === "meals_50");
  add(
    "partial",
    "Partly counted deductions",
    "Deductions counted at less than 100%",
    (l) => l.treatment !== "meals_50" && l.percent !== null && l.percent < 100 && !l.separately,
  );
  add("nondeductible", "Nondeductible expenses", "Not counted as deductions", (l) => l.treatment === "nondeductible");
  add("separate", "Stated separately", "Moved off the ordinary line, listed on their own", (l) => l.separately);
  add(
    "excluded",
    "Left out of ordinary income",
    "Book amounts the treatment does not count",
    (l) => l.treatment !== null && !l.separately && l.percent === null && l.treatment !== "nondeductible" && l.treatment !== "gross_receipts",
  );
  for (const a of taxAdjustments(source).filter((x) => x.ordinary))
    out.push({ key: `adj-${a.id}`, label: a.reason, hint: `${a.label}, ${a.supported ? "with a document" : "no document attached"}`, amount: a.amount, accounts: [] });
  const start = big(source.book_profit_cents);
  const end = big(source.adjusted_ordinary_cents);
  const explained = out.reduce((s, l) => s + l.amount, ZERO);
  if (start + explained !== end)
    out.push({
      key: "other",
      label: "Other difference",
      hint: "Between book profit and the treated accounts",
      amount: end - start - explained,
      accounts: [],
    });
  return { start, lines: out, end };
}

/** The separately stated items, as the books total them. */
export function taxSeparately(source: TaxSource): { concept: string; label: string; amount: bigint }[] {
  return Object.entries(source.separately_stated)
    .map(([concept, amount]) => ({ concept, label: treatmentLabel(concept), amount: big(amount) }))
    .filter((x) => x.amount !== ZERO)
    .sort((a, b) => rank(a.concept) - rank(b.concept));
}

export interface TaxCheck {
  key: string;
  /** "look" must be settled before the workpapers are complete; "info" is worth knowing. */
  tone: "look" | "info";
  title: string;
  detail: string;
  /** Where it is fixed. */
  fix: "accounts" | "adjustments" | "review" | "settings" | null;
}

/** What is missing before the workpapers are complete, each with a plain next step. */
export function taxReadiness(source: TaxSource): TaxCheck[] {
  const out: TaxCheck[] = [];
  for (const l of taxLines(source).filter((x) => x.treatment === null))
    out.push({
      key: `untreated-${l.id}`,
      tone: "look",
      title: `Give ${l.name} a tax treatment`,
      detail: `Its ${formatCents(l.book < ZERO ? -l.book : l.book)} of ${l.type === "income" ? "income" : "spending"} is left out of the ordinary income figure until it has one.`,
      fix: "accounts",
    });
  if (source.drafts > 0)
    out.push({
      key: "drafts",
      tone: "look",
      title: `${source.drafts} ${source.drafts === 1 ? "transaction is" : "transactions are"} awaiting review`,
      detail: "Only reviewed transactions count. Review them so the year is complete.",
      fix: "review",
    });
  for (const a of taxAdjustments(source).filter((x) => !x.supported))
    out.push({
      key: `support-${a.id}`,
      tone: "look",
      title: `Attach a document to "${a.reason}"`,
      detail: "An adjustment your preparer can rely on has its support attached: a receipt, a schedule or a letter.",
      fix: "adjustments",
    });
  if (source.unavailable_adjustments > 0)
    out.push({
      key: "unavailable",
      tone: "look",
      title: `${source.unavailable_adjustments} ${source.unavailable_adjustments === 1 ? "adjustment points" : "adjustments point"} at a missing document`,
      detail: "The document was archived or removed. Attach it again.",
      fix: "adjustments",
    });
  if (!source.year_settings?.classification)
    out.push({
      key: "classification",
      tone: "look",
      title: "Set how the business is taxed",
      detail: "Business settings say which return the figures are for.",
      fix: "settings",
    });
  const months = source.monthly;
  const open = months.filter((m) => !m.complete).length;
  if (months.length && open)
    out.push({
      key: "months",
      tone: "info",
      title: `${open} of ${months.length} ${months.length === 1 ? "month is" : "months are"} not closed`,
      detail: "Closing a month locks it, so its figures cannot change after you hand them over.",
      fix: null,
    });
  return out;
}

/** "an S corporation", or null when the books do not say. */
export function classificationPhrase(source: TaxSource): string | null {
  const c = source.year_settings?.classification as ProfileClassification | undefined;
  return c && CLASSIFICATION_PHRASES[c] ? CLASSIFICATION_PHRASES[c] : null;
}

/** One sentence for the year. */
export function taxSentence(source: TaxSource, t: TaxTotals, inProgress: boolean): string {
  const as = classificationPhrase(source);
  const head = `The books show ${formatCents(t.taxable)} of ordinary income for ${source.year}${inProgress ? " so far" : ""}${as ? `, taxed as ${as}` : ""}.`;
  return t.notReady
    ? `${head} ${t.notReady} ${t.notReady === 1 ? "thing needs" : "things need"} you before the workpapers are complete.`
    : `${head} Nothing is missing.`;
}

export const TAX_NOTES = [
  "Figures are the books' own: each account's reviewed activity in the calendar tax year, counted by the tax treatment you gave it, plus your adjustments. They are what you hand a preparer, not a tax result.",
  "Book amounts are profit contributions: income adds, expenses subtract. The adjustment column is the tax amount less the book amount.",
  "Separately stated items (interest, dividends, capital gains, charitable gifts, tax-exempt income) are moved off the ordinary line and listed on their own.",
  "Shareholder basis is not tracked in the books. Your preparer works it out from last year's basis, this year's income, and your contributions and distributions (see Owner activity).",
];
