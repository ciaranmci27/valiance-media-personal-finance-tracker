import { formatCents } from "./money";
import type { PayrollEmployee, PayrollYear } from "./payroll";
import type { ReportData } from "./reports";
import type { SupportReportData } from "./support-reports";

/**
 * The payroll register: what payroll cost for a calendar year, what was
 * taken home, and whether every run ties to the books. The register itself
 * (accounting.support_report) lists each run that is posted and not
 * reversed by the cutoff, with its gross wages, employee withholding,
 * employer taxes and net pay. The payroll year (accounting.payroll) adds
 * each run's components (withholding by type, employer costs, the accounts
 * they post to) and the per-employee facts the provider reported, where it
 * has them. Payroll is calendar-year, as W-2s and 941s are. These are the
 * books' figures; the page never states a filing amount the data does not
 * hold.
 */

const ZERO = BigInt(0);
const big = (value: string | number | null | undefined) => BigInt(value || 0);

/** This year and the three before it. */
export function payrollYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return [year, year - 1, year - 2, year - 3];
}

export type PayrollQuarter = 1 | 2 | 3 | 4;

/** A year (or one quarter of it), never past today. */
export function payrollScope(year: number, today: string, quarter: PayrollQuarter | null = null) {
  const from = quarter ? `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01` : `${year}-01-01`;
  const end = quarter
    ? new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10)
    : `${year}-12-31`;
  return { report_id: "payroll-register" as const, from, to: end < today ? end : today, offset: 0 };
}

/** The quarters that have started by today, for the year. */
export function payrollQuarters(year: number, today: string): PayrollQuarter[] {
  return ([1, 2, 3, 4] as PayrollQuarter[]).filter((q) => `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01` <= today);
}

/** Which quarter a scope is, or null for the whole year (a scope inside the first quarter reads as it). */
export function quarterOf(scope: { from: string; to: string }): PayrollQuarter | null {
  const year = Number(scope.from.slice(0, 4));
  const month = Number(scope.from.slice(5, 7));
  if (scope.from.slice(8) !== "01" || month % 3 !== 1) return null;
  const q = ((month - 1) / 3 + 1) as PayrollQuarter;
  const end = new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10);
  return scope.to <= end ? q : null;
}

export interface RegisterRun {
  id: string;
  date: string;
  run: string;
  gross: bigint;
  withholding: bigint;
  employer: bigint;
  net: bigint;
  quarter: PayrollQuarter;
}

/** The register's runs, oldest first. */
export function registerRuns(data: SupportReportData): RegisterRun[] {
  return data.rows
    .map((r) => {
      const [date, run, gross, withholding, employer, net] = r.cells;
      return {
        id: r.run_id ?? r.id,
        date,
        run,
        gross: big(gross),
        withholding: big(withholding),
        employer: big(employer),
        net: big(net),
        quarter: (Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1) as PayrollQuarter,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.run.localeCompare(b.run));
}

/** One run as the payroll year returns it (accounting.payroll rows). */
export interface PayrollYearRun {
  id: string;
  provider_run_id: string;
  pay_date: string;
  status: string;
  entry_id: string | null;
  gross_cents: string;
  net_cents: string;
  employee_withholding_cents: string;
  employer_tax_cents: string;
  components: { kind: string; label?: string; amount_cents: string; account_id?: string | null }[];
  ytd: { run_employees?: PayrollEmployee[] } | null;
}
export type PayrollYearRead = PayrollYear & { rows: PayrollYearRun[]; count: number };

/** The payroll year's runs by id, for the register's runs. */
export const runIndex = (year: PayrollYearRead | null) =>
  new Map((year?.rows ?? []).map((r) => [r.id, r]));

const EMPLOYEE_KINDS = new Set(["employee_tax", "retirement_deferral", "other_deduction"]);
const EMPLOYER_KINDS = new Set(["employer_tax", "employer_retirement", "employer_benefit", "provider_fee"]);
const KIND_NAMES: Record<string, string> = {
  employee_tax: "Tax withheld",
  retirement_deferral: "Retirement deferral",
  other_deduction: "Other deduction",
  employer_tax: "Employer taxes",
  employer_retirement: "Employer retirement",
  employer_benefit: "Employer benefits",
  provider_fee: "Payroll service fee",
};

export interface PayrollTotals {
  runs: number;
  gross: bigint;
  withholding: bigint;
  /** Employer payroll taxes, as the register records them. */
  employerTax: bigint;
  /** Other employer costs from the components (retirement, benefits, the service fee). */
  employerOther: bigint;
  net: bigint;
  /** Gross wages plus every employer cost the books know of. */
  cost: bigint;
  /** Whether the components were read, so other employer costs are known. */
  detailed: boolean;
}

export function payrollTotals(runs: RegisterRun[], year: PayrollYearRead | null): PayrollTotals {
  const index = runIndex(year);
  const detailed = !!year && runs.every((r) => index.has(r.id));
  const employerOther = detailed
    ? runs.reduce(
        (s, r) =>
          s +
          (index.get(r.id)?.components ?? [])
            .filter((c) => EMPLOYER_KINDS.has(c.kind) && c.kind !== "employer_tax")
            .reduce((t, c) => t + big(c.amount_cents), ZERO),
        ZERO,
      )
    : ZERO;
  const gross = runs.reduce((s, r) => s + r.gross, ZERO);
  const employerTax = runs.reduce((s, r) => s + r.employer, ZERO);
  return {
    runs: runs.length,
    gross,
    withholding: runs.reduce((s, r) => s + r.withholding, ZERO),
    employerTax,
    employerOther,
    net: runs.reduce((s, r) => s + r.net, ZERO),
    cost: gross + employerTax + employerOther,
    detailed,
  };
}

/**
 * Where the payroll money went: withholding by its label (federal income
 * tax, Social Security, and so on) and employer costs by theirs, from the
 * runs' components. Without the components, one line each.
 */
export function payrollBreakdown(
  runs: RegisterRun[],
  year: PayrollYearRead | null,
): { withholding: { label: string; amount: bigint }[]; employer: { label: string; amount: bigint }[] } {
  const t = payrollTotals(runs, year);
  if (!t.detailed)
    return {
      withholding: t.withholding ? [{ label: "Withheld from pay", amount: t.withholding }] : [],
      employer: t.employerTax ? [{ label: "Employer taxes", amount: t.employerTax }] : [],
    };
  const index = runIndex(year);
  const sum = (kinds: Set<string>) => {
    const out = new Map<string, bigint>();
    for (const r of runs)
      for (const c of index.get(r.id)?.components ?? [])
        if (kinds.has(c.kind)) {
          const label = c.label?.trim() || KIND_NAMES[c.kind] || c.kind;
          out.set(label, (out.get(label) ?? ZERO) + big(c.amount_cents));
        }
    return [...out.entries()]
      .map(([label, amount]) => ({ label, amount }))
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  };
  const withholding = sum(EMPLOYEE_KINDS);
  const employer = sum(EMPLOYER_KINDS);
  // Components that do not add up to the register's figure are shown as a
  // remainder line, so the card always matches the register.
  const wSum = withholding.reduce((s, x) => s + x.amount, ZERO);
  if (wSum !== t.withholding) withholding.push({ label: "Other withholding", amount: t.withholding - wSum });
  return { withholding, employer };
}

export interface PayrollMonth {
  month: string;
  net: bigint;
  withholding: bigint;
  employer: bigint;
  gross: bigint;
  runs: number;
  partial: { from: string; to: string } | null;
}

/** Each month of the scope: net pay, withholding and employer cost (taxes plus other employer costs). */
export function payrollMonths(
  runs: RegisterRun[],
  scope: { from: string; to: string },
  year: PayrollYearRead | null,
): PayrollMonth[] {
  const t = payrollTotals(runs, year);
  const index = runIndex(year);
  const other = (r: RegisterRun) =>
    t.detailed
      ? (index.get(r.id)?.components ?? [])
          .filter((c) => EMPLOYER_KINDS.has(c.kind) && c.kind !== "employer_tax")
          .reduce((s, c) => s + big(c.amount_cents), ZERO)
      : ZERO;
  const out: PayrollMonth[] = [];
  let y = Number(scope.from.slice(0, 4)),
    m = Number(scope.from.slice(5, 7));
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (`${key}-01` > scope.to) break;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const list = runs.filter((r) => r.date.startsWith(key));
    out.push({
      month: `${key}-01`,
      net: list.reduce((s, r) => s + r.net, ZERO),
      withholding: list.reduce((s, r) => s + r.withholding, ZERO),
      employer: list.reduce((s, r) => s + r.employer + other(r), ZERO),
      gross: list.reduce((s, r) => s + r.gross, ZERO),
      runs: list.length,
      partial: end > scope.to ? { from: `${key}-01`, to: scope.to } : null,
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export interface QuarterSummary {
  quarter: PayrollQuarter;
  runs: number;
  gross: bigint;
  withholding: bigint;
  employer: bigint;
  net: bigint;
  /** The provider's reported figures, when every run in the quarter has them. */
  facts: {
    federalWithheld: bigint;
    socialSecurityWages: bigint;
    medicareWages: bigint;
  } | null;
}

/** Each quarter with runs: the register's totals and, where every run reports them, the 941-style wage facts. */
export function quarterSummaries(runs: RegisterRun[], year: PayrollYearRead | null): QuarterSummary[] {
  const index = runIndex(year);
  const out: QuarterSummary[] = [];
  for (const q of [1, 2, 3, 4] as PayrollQuarter[]) {
    const list = runs.filter((r) => r.quarter === q);
    if (!list.length) continue;
    const employees = list.map((r) => index.get(r.id)?.ytd?.run_employees ?? null);
    const complete =
      employees.every((e) => e && e.length > 0) &&
      employees.every((e) =>
        e!.every(
          (x) =>
            x.federal_withheld_cents != null && x.social_security_wages_cents != null && x.medicare_wages_cents != null,
        ),
      );
    const sum = (pick: (e: PayrollEmployee) => string | null | undefined) =>
      employees.reduce((s, e) => s + (e ?? []).reduce((t, x) => t + big(pick(x)), ZERO), ZERO);
    out.push({
      quarter: q,
      runs: list.length,
      gross: list.reduce((s, r) => s + r.gross, ZERO),
      withholding: list.reduce((s, r) => s + r.withholding, ZERO),
      employer: list.reduce((s, r) => s + r.employer, ZERO),
      net: list.reduce((s, r) => s + r.net, ZERO),
      facts: complete
        ? {
            federalWithheld: sum((x) => x.federal_withheld_cents),
            socialSecurityWages: sum((x) => x.social_security_wages_cents),
            medicareWages: sum((x) => x.medicare_wages_cents),
          }
        : null,
    });
  }
  return out;
}

/** Who each run paid, by name, from the provider's per-employee lines. */
export function runEmployees(run: RegisterRun, year: PayrollYearRead | null): string[] {
  return (runIndex(year).get(run.id)?.ytd?.run_employees ?? []).map((e) => e.name);
}

export interface PayrollTie {
  key: string;
  /** "good" ties out; "look" needs a look; "info" is worth knowing. */
  tone: "good" | "look" | "info";
  title: string;
  detail: string;
  /** A journal entry to open, when the flag is about one run. */
  entryId?: string | null;
}

/**
 * Whether every run ties to the books: each run in the register has its
 * journal entry, each run's gross is its net pay plus withholding, and the
 * payroll expense accounts hold what the runs posted to them (a difference
 * is an entry outside payroll). Drafts and voided runs are said plainly.
 */
export function payrollTies(
  runs: RegisterRun[],
  year: PayrollYearRead | null,
  books: ReportData | null,
): PayrollTie[] {
  const out: PayrollTie[] = [];
  const index = runIndex(year);
  const off = runs.filter((r) => r.gross !== r.net + r.withholding);
  out.push(
    off.length
      ? {
          key: "math",
          tone: "look",
          title: `${off.length} ${off.length === 1 ? "run does" : "runs do"} not add up`,
          detail: `Gross wages should equal net pay plus withholding. Check ${off.map((r) => r.run).join(", ")}.`,
          entryId: index.get(off[0].id)?.entry_id ?? null,
        }
      : {
          key: "math",
          tone: "good",
          title: "Every run adds up",
          detail: "Each run's gross wages are its net pay plus withholding.",
        },
  );
  if (!year) return out;
  const missing = runs.filter((r) => !index.get(r.id)?.entry_id);
  out.push(
    missing.length
      ? {
          key: "journal",
          tone: "look",
          title: `${missing.length} ${missing.length === 1 ? "run has" : "runs have"} no journal entry here`,
          detail: `${missing.map((r) => r.run).join(", ")} ${missing.length === 1 ? "is" : "are"} in the register but not in this year's payroll list. Refresh, or open Payroll.`,
        }
      : {
          key: "journal",
          tone: "good",
          title: "Every run has its journal entry",
          detail: `${runs.length} ${runs.length === 1 ? "run" : "runs"}, each posted to the books.`,
        },
  );
  if (books) {
    const posted = new Map<string, bigint>();
    for (const r of runs)
      for (const c of index.get(r.id)?.components ?? [])
        if (c.account_id && (EMPLOYER_KINDS.has(c.kind) || c.kind === "officer_wages" || c.kind === "other_wages"))
          posted.set(c.account_id, (posted.get(c.account_id) ?? ZERO) + big(c.amount_cents));
    for (const [id, amount] of posted) {
      const account = books.accounts.find((a) => a.id === id);
      if (!account) continue;
      const inBooks = big(account.period_cents);
      const diff = inBooks - amount;
      out.push(
        diff === ZERO
          ? {
              key: `acct-${id}`,
              tone: "good",
              title: `${account.name} ties to the runs`,
              detail: `${formatCents(amount)} from payroll, the same as the books.`,
            }
          : {
              key: `acct-${id}`,
              tone: "look",
              title: `${account.name} differs by ${formatCents(diff < ZERO ? -diff : diff)}`,
              detail: `The posted runs put ${formatCents(amount)} here; the books hold ${formatCents(inBooks)}. ${
                diff > ZERO
                  ? year.drafts > 0
                    ? "The extra may belong to a draft run, or was booked outside payroll."
                    : "The extra was booked outside payroll."
                  : "A run's entry is not in this period's books."
              }`,
            },
      );
    }
  }
  const drafts = year.drafts;
  if (drafts > 0)
    out.push({
      key: "drafts",
      tone: "look",
      title: `${drafts} payroll ${drafts === 1 ? "run is" : "runs are"} still a draft`,
      detail: "Drafts are not in the register until they are posted. Open Payroll to finish them.",
    });
  const voided = (year.rows ?? []).filter((r) => r.status === "void" || r.status === "voided");
  if (voided.length)
    out.push({
      key: "voided",
      tone: "info",
      title: `${voided.length} voided ${voided.length === 1 ? "run is" : "runs are"} left out`,
      detail: `${voided.map((r) => r.provider_run_id).join(", ")}: reversed in the books, so not in the register.`,
    });
  return out;
}

export const PAYROLL_NOTES = [
  "The register lists each payroll run posted to the books and not reversed by the end of the period, by pay date. Payroll is calendar-year, as W-2s and quarterly returns are.",
  "Employee withholding is everything taken out of gross pay (taxes and other deductions). Employer taxes are the business's own payroll taxes; other employer costs (retirement, benefits, the payroll service fee) come from each run's details.",
  "Quarter wage figures (federal income tax withheld, Social Security and Medicare wages) are the payroll provider's. The register screen shows them only when every run in the quarter reports them. Compare them with your filed returns; this register does not file anything.",
];
