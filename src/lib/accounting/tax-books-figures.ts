/**
 * The figures the accounting books can supply to the Tax Estimator for a
 * year, flattened from the ledger read (`tax_source`) and the payroll year
 * read (`payroll`). Pure: the route fetches, this file decides what is
 * offered, what is held back, and why.
 */
import type { TaxSource } from "./tax-workpapers";
import type { PayrollEmployee, PayrollYear } from "./payroll";
import { toEstimatorDollars } from "./tax-projection";
import type { BooksFigureKey, IncomeType } from "@/types/database";

export interface BooksFigure {
  key: BooksFigureKey;
  group: "business" | "investments" | "payroll";
  label: string;
  /** One line under the label. Dates are rendered by the UI from `through`. */
  detail: string;
  kind: "income" | "gain" | "withholding";
  /** Omitted for business profit: the estimator types it from its classification. */
  income_type?: IncomeType;
  term?: "short" | "long";
  jurisdiction?: "federal" | "state";
  amount_cents: string;
  /** YYYY-MM-DD the amount covers. */
  through: string;
  document_id: string | null;
  wage_bases_cents?: { social_security: string; medicare: string; state?: string };
  available: boolean;
  reason?: string;
}

export interface BooksFigures {
  year: number;
  through: string;
  /** The books' own classification for the year, for the UI to compare. */
  classification: string | null;
  figures: BooksFigure[];
  notes: string[];
  /** Bank and imported activity still waiting for a category; not in the figures. */
  unreviewed: number;
}

export interface BooksFiguresInput {
  year: number;
  through: string;
  source: TaxSource | null;
  sourceError: string | null;
  payroll: PayrollYear | null;
  payrollError: string | null;
}

const INVESTMENTS: {
  concept: "interest" | "qualified_dividend" | "short_gain" | "long_gain";
  label: string;
  kind: "income" | "gain";
  income_type?: IncomeType;
  term?: "short" | "long";
}[] = [
  { concept: "interest", label: "Interest", kind: "income", income_type: "1099" },
  { concept: "qualified_dividend", label: "Qualified dividends", kind: "income", income_type: "qualified_dividend" },
  { concept: "short_gain", label: "Short-term gains", kind: "gain", term: "short" },
  { concept: "long_gain", label: "Long-term gains", kind: "gain", term: "long" },
];

const NEEDS_REGISTER = "Posted payroll runs carry no per-employee figures";

function inRange(cents: string): boolean {
  try {
    toEstimatorDollars(cents);
    return true;
  } catch {
    return false;
  }
}

function isZero(cents: string | undefined | null): boolean {
  return !cents || !/^-?(0|[1-9][0-9]*)$/.test(cents) || BigInt(cents) === BigInt(0);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function buildBooksFigures(input: BooksFiguresInput): BooksFigures {
  const figures: BooksFigure[] = [];
  const notes: string[] = [];
  const { source, payroll } = input;

  if (source) {
    const settings = source.year_settings;
    // Unmapped accounts contribute zero to ordinary income, so the profit is
    // wrong (not merely provisional) until every account has a treatment.
    const gate = !settings
      ? "Set the tax classification in Business settings"
      : source.unmapped_accounts > 0
        ? `${plural(source.unmapped_accounts, "account")} still need a tax treatment`
        : source.unavailable_adjustments > 0
          ? "Some tax adjustments are unavailable"
          : null;

    const cCorp = settings?.classification === "c_corp";
    const profitOk = inRange(source.adjusted_ordinary_cents);
    const negative = source.adjusted_ordinary_cents.startsWith("-");
    figures.push({
      key: "business_profit",
      group: "business",
      label: "Business profit",
      detail: negative
        ? "Loss so far. Basis limits are not applied."
        : "Ordinary income after tax treatment",
      kind: "income",
      amount_cents: source.adjusted_ordinary_cents,
      through: source.through,
      document_id: null,
      available: !cCorp && !gate && profitOk,
      reason: cCorp
        ? "Taxed at the company, not on your return"
        : (gate ?? (profitOk ? undefined : "Outside the estimator range")),
    });

    for (const item of INVESTMENTS) {
      const cents = source.separately_stated[item.concept];
      if (!cents || isZero(cents)) continue;
      const ok = inRange(cents);
      figures.push({
        key: item.concept,
        group: "investments",
        label: item.label,
        detail: "Separately stated on the books",
        kind: item.kind,
        income_type: item.income_type,
        term: item.term,
        amount_cents: cents,
        through: source.through,
        document_id: null,
        available: !gate && ok,
        reason: gate ?? (ok ? undefined : "Outside the estimator range"),
      });
    }

  } else if (input.sourceError) {
    notes.push(input.sourceError);
  }

  if (payroll) {
    const coverage = payroll.coverage;
    if (!coverage) {
      // No provider-verified register: the posted runs add up, so offer
      // those sums; each row says where it came from.
      if (payroll.employees.length > 0) {
        for (const employee of sortEmployees(payroll.employees)) {
          figures.push(...employeeFigures(employee, payroll.through, null, "runs"));
        }
      } else if (payroll.run_count > 0) {
        notes.push(NEEDS_REGISTER);
      }
    } else {
      if (!coverage.current) {
        notes.push(
          "The payroll provider report is no longer in storage. Figures still come from the verified register.",
        );
      }
      const documentId = coverage.current ? coverage.document_id : null;
      const through = coverage.source_through_date ?? coverage.through_date;
      for (const employee of sortEmployees(coverage.employees)) {
        figures.push(...employeeFigures(employee, through, documentId, "register"));
      }
    }
    if (payroll.drafts > 0) {
      notes.push(`${plural(payroll.drafts, "draft payroll run")} not included yet`);
    }
  } else if (input.payrollError) {
    notes.push(input.payrollError);
  }

  return {
    year: input.year,
    through: input.through,
    classification: source?.year_settings?.classification ?? null,
    figures,
    notes,
    unreviewed: source?.drafts ?? 0,
  };
}

function sortEmployees(employees: PayrollEmployee[]): PayrollEmployee[] {
  return [...employees].sort((a, b) =>
    a.is_officer === b.is_officer ? a.name.localeCompare(b.name) : a.is_officer ? -1 : 1,
  );
}

function employeeFigures(
  employee: PayrollEmployee,
  through: string,
  documentId: string | null,
  basis: "register" | "runs",
): BooksFigure[] {
  const out: BooksFigure[] = [];
  const has = (value: string | null | undefined): value is string =>
    typeof value === "string" && inRange(value);
  const where = basis === "register" ? "the verified register" : "posted payroll runs";
  const missing = (label: string) =>
    basis === "register"
      ? `The register does not report ${label}`
      : `The posted runs do not report ${label}`;

  // Taxable wages are the right figure. When the runs never reported them,
  // gross pay is the honest fallback and the row says so.
  const gross = has(employee.gross_cash_cents) ? employee.gross_cash_cents : null;
  const taxable = has(employee.federal_taxable_cents) ? employee.federal_taxable_cents : null;
  const wagesAmount = taxable ?? gross;
  const base = (value: string | null | undefined) => (has(value) ? value : wagesAmount);
  const ssBase = base(employee.social_security_wages_cents);
  const medicareBase = base(employee.medicare_wages_cents);
  const wagesOk = wagesAmount !== null && ssBase !== null && medicareBase !== null;
  out.push({
    key: `payroll:wages:${employee.key}`,
    group: "payroll",
    label: `${employee.name} wages`,
    detail: taxable
      ? `Federal taxable wages from ${where}`
      : `Gross pay from ${where}. Taxable wages were not reported.`,
    kind: "income",
    income_type: "w2",
    amount_cents: wagesAmount ?? "0",
    through,
    document_id: documentId,
    wage_bases_cents: wagesOk
      ? {
          social_security: ssBase,
          medicare: medicareBase,
          ...(has(employee.state_taxable_cents)
            ? { state: employee.state_taxable_cents }
            : {}),
        }
      : undefined,
    available: wagesOk,
    reason: wagesOk ? undefined : missing("wages"),
  });

  const federalOk = has(employee.federal_withheld_cents);
  out.push({
    key: `payroll:federal_withheld:${employee.key}`,
    group: "payroll",
    label: `${employee.name} federal withholding`,
    detail: `Federal income tax withheld, from ${where}`,
    kind: "withholding",
    jurisdiction: "federal",
    amount_cents: employee.federal_withheld_cents ?? "0",
    through,
    document_id: documentId,
    available: federalOk,
    reason: federalOk ? undefined : missing("federal income tax withheld"),
  });

  const stateOk = has(employee.state_withheld_cents);
  out.push({
    key: `payroll:state_withheld:${employee.key}`,
    group: "payroll",
    label: `${employee.name} state withholding`,
    detail: `State income tax withheld, from ${where}. Assumes your home state.`,
    kind: "withholding",
    jurisdiction: "state",
    amount_cents: employee.state_withheld_cents ?? "0",
    through,
    document_id: documentId,
    available: stateOk,
    reason: stateOk ? undefined : missing("state income tax withheld"),
  });

  return out;
}
