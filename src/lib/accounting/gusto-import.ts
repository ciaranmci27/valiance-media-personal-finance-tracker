import { z } from "zod";
import { payrollBodySchema, type PayrollBody } from "./payroll";
import { readXlsx, xlsxDate } from "./xlsx";

/**
 * Gusto's "Payroll data export" workbook (Reports > Payroll data export, one
 * .xlsx): one row per employee per payroll on the payrolls sheet, with the
 * earnings, taxes and deductions sheets keyed by payroll id. The parser is
 * strict: every figure is read to the cent, gross pay must equal net pay plus
 * employee taxes and deductions, and anything it cannot book is refused by
 * name. Personal details (addresses, rates, job titles) are never read.
 */
export const gustoMappingSchema = z
  .object({
    wages: z.guid(),
    employer_tax: z.guid(),
    net_pay: z.guid(),
    tax_payable: z.guid(),
    officers: z.array(z.string().min(1).max(160)).max(50),
  })
  .strict();
export type GustoMapping = z.infer<typeof gustoMappingSchema>;

/**
 * new: record the payroll. link:<entry>:<version>: link it to the entry the
 * preview found (for a difference, keep the books as they are).
 * correct:<entry>:<version>: change that entry first (its date to the Gusto
 * pay date for a date match, its amounts to Gusto's for a difference).
 */
export const gustoChoiceSchema = z.union([
  z.literal("new"),
  z.string().regex(/^(link|correct):[0-9a-f-]{36}:[1-9][0-9]{0,9}$/),
]);

export interface GustoTax {
  name: string;
  type: "employee" | "employer";
  amount: string;
}
export interface GustoCheck {
  payroll_id: string;
  employee_id: string;
  employee: string;
  gross: string;
  net: string;
  employee_tax: string;
  employer_tax: string;
  taxes: GustoTax[];
  federal_taxable: string | null;
  federal_withheld: string;
  state_taxable: string | null;
  state_withheld: string;
  social_security_wages: string | null;
  medicare_wages: string | null;
}
export interface GustoRun {
  check_date: string;
  period_from: string;
  period_to: string;
  payroll_ids: string[];
  checks: GustoCheck[];
}
/** A payroll Gusto lists with no pay at all (a $0 catch-up payroll), left out of the import. */
export interface GustoSkipped {
  payroll_id: string;
  check_date: string;
  period_from: string;
  period_to: string;
  /** Employer tax credits on a payroll with no pay (Gusto's tax corrections), in cents, negative. */
  credits?: { name: string; amount: string }[];
}
export interface GustoReport {
  /** First and last check dates in the file, among payrolls with pay ("" when there are none). */
  from: string;
  to: string;
  runs: GustoRun[];
  employees: string[];
  /** Payrolls whose pay, taxes and deductions are all zero. Never booked or linked. */
  skipped: GustoSkipped[];
}

/** "6 payrolls had no pay ($0) and were left out: Jul 1 to Sep 30, 2024." */
export function gustoSkippedNote(
  skipped: GustoSkipped[],
  label: (date: string) => string,
): string {
  if (!skipped.length) return "";
  const from = skipped.map((s) => s.period_from).sort()[0];
  const to = skipped
    .map((s) => s.period_to)
    .sort()
    .at(-1)!;
  const range =
    from.slice(0, 4) === to.slice(0, 4)
      ? `${label(from).replace(/, \d{4}$/, "")} to ${label(to)}`
      : `${label(from)} to ${label(to)}`;
  return `${skipped.length} ${skipped.length === 1 ? "payroll" : "payrolls"} had no pay ($0) and ${skipped.length === 1 ? "was" : "were"} left out: ${range}.`;
}

/**
 * "Gusto also credited back $4.90 of AZ Unemployment Tax on Mar 31, 2025..."
 * Tax corrections are not imported; Gusto refunds them to the bank.
 */
export function gustoCreditNote(
  skipped: GustoSkipped[],
  label: (date: string) => string,
): string {
  const credits = skipped.flatMap((s) =>
    (s.credits ?? []).map((c) => ({ ...c, date: s.check_date })),
  );
  if (!credits.length) return "";
  const money = (amount: string) =>
    `$${(Number(-BigInt(amount)) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const list = credits
    .map((c) => `${money(c.amount)} of ${c.name} on ${label(c.date)}`)
    .join("; ");
  return `Gusto also credited back ${list} as a tax correction. It is not imported: Gusto refunds it to your bank, so book that deposit to your employer payroll taxes.`;
}

export type GustoState =
  | "new"
  | "duplicate"
  | "match"
  | "date_match"
  | "group_match"
  | "difference"
  | "conflict";
export interface GustoEntryCandidate {
  id: string;
  version: number;
  entry_date: string;
  memo: string;
  can_correct: boolean;
  lines: { account_id: string; amount_cents: string }[];
}
export interface GustoDifference {
  account_id: string;
  books_cents: string;
  gusto_cents: string;
  difference_cents: string;
}
export interface GustoResult {
  key: string;
  pay_date: string;
  period_from: string;
  period_to: string;
  gross: string;
  net: string;
  employee_tax: string;
  employer_tax: string;
  employee_count: number;
  state: GustoState;
  message: string;
  /** Every run linked to the same entry, this one included, when there are several. */
  group: string[];
  entry: GustoEntryCandidate | null;
  difference: GustoDifference[];
  run_id: string | null;
  entry_id: string | null;
}
/**
 * A Gusto fee withdrawal or refund deposit already in the books on a
 * non-payroll category, which the import can move: fees and fee refunds to
 * Payroll fees, a deposit matching a tax credit in the file to employer taxes.
 */
export interface GustoFeeRow {
  id: string;
  version: number;
  entry_date: string;
  memo: string;
  /** The bank line: negative for a withdrawal, positive for a deposit. */
  amount_cents: string;
  kind: "fee" | "fee_refund" | "tax_refund";
  line_id: string;
  from_account_id: string;
  to_account_id: string | null;
  /** Why the row cannot be moved, or null when it can. */
  blocked: string | null;
}
export const gustoFeeSelectionSchema = z
  .array(
    z.object({ id: z.guid(), version: z.number().int().positive() }).strict(),
  )
  .max(500);

/**
 * The date range in a Gusto export's file name:
 * payroll_data_export_<company>_<YYYY-MM-DD>_to_<YYYY-MM-DD>_<timestamp>.xlsx.
 * Null when the name does not follow that pattern or the dates are not real.
 */
export function gustoFileRange(
  name: string | null | undefined,
): { from: string; to: string } | null {
  const m =
    /_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})(?:_[^/\\]*)?\.xlsx$/i.exec(
      name ?? "",
    );
  if (!m) return null;
  const real = (iso: string) =>
    !Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) &&
    new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso &&
    Number(iso.slice(0, 4)) >= 1990 &&
    Number(iso.slice(0, 4)) <= 2100;
  if (!real(m[1]) || !real(m[2]) || m[1] > m[2]) return null;
  if (Number(m[2].slice(0, 4)) - Number(m[1].slice(0, 4)) > 19) return null;
  return { from: m[1], to: m[2] };
}

/**
 * The calendar years an export covers, for finding its fees in the books: the
 * years of its payrolls, every year of the file name's date range, and the
 * year the owner chose for a file with neither.
 */
export function gustoYears(
  report: GustoReport,
  range: { from: string; to: string } | null = null,
  chosen: number | null = null,
): number[] {
  const spanned: number[] = [];
  if (range)
    for (
      let y = Number(range.from.slice(0, 4));
      y <= Number(range.to.slice(0, 4));
      y++
    )
      spanned.push(y);
  return [
    ...new Set([
      ...[
        ...report.runs.map((r) => r.check_date),
        ...report.skipped.map((s) => s.check_date),
      ].map((d) => Number(d.slice(0, 4))),
      ...spanned,
      ...(chosen ? [chosen] : []),
    ]),
  ].sort((a, b) => a - b);
}

/** Tax credits on no-pay payrolls, which Gusto refunds to the bank. */
export function gustoCredits(report: GustoReport) {
  return report.skipped.flatMap((s) =>
    (s.credits ?? []).map((c) => ({
      check_date: s.check_date,
      name: c.name,
      amount: c.amount,
    })),
  );
}

export interface GustoPreview {
  provider: "gusto";
  skipped: GustoSkipped[];
  fees?: GustoFeeRow[];
  fee_account?: string | null;
  /** The calendar years the file covers, for its fees. */
  years?: number[];
  from: string;
  to: string;
  employees: string[];
  mapping: GustoMapping;
  results: GustoResult[];
}

export const GUSTO_SHEETS = [
  "employees",
  "payrolls",
  "earnings",
  "taxes",
  "deductions",
] as const;
const MAX_BYTES = 2_000_000;

/** Earnings Gusto pays in cash through payroll. Anything else is refused by name. */
const CASH_EARNINGS = new Set([
  "regular",
  "salary",
  "overtime",
  "double overtime",
  "bonus",
  "commission",
  "holiday",
  "holiday pay",
  "paid time off",
  "pto",
  "sick",
  "sick pay",
  "vacation",
  "retroactive pay",
  "severance",
]);

function cents(value: string, label: string): bigint {
  const text = value.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!text) return BigInt(0);
  if (text.startsWith("-") || text.startsWith("("))
    throw new Error(
      `${label}: negative amounts (voided or corrected payrolls) need a separate correction. Nothing has been imported.`,
    );
  const plain = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (plain && (plain[2] ?? "").replace(/0+$/, "").length <= 2) {
    const result =
      BigInt(plain[1]) * BigInt(100) +
      BigInt((plain[2] ?? "").slice(0, 2).padEnd(2, "0"));
    if (result > BigInt(999999999999999))
      throw new Error(`${label}: amount is too large.`);
    return result;
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 9_999_999_999)
    throw new Error(`${label}: expected an amount such as 2916.67.`);
  const scaled = number * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6)
    throw new Error(`${label}: amounts must be whole cents.`);
  return BigInt(rounded);
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60) || "tax";

interface Sheet {
  name: string;
  headers: string[];
  rows: { line: number; get: (header: string) => string }[];
}

function sheetOf(
  sheets: Map<string, string[][]>,
  name: string,
  required: readonly string[],
): Sheet {
  const rows = sheets.get(name);
  if (!rows)
    throw new Error(
      `This workbook has no ${name} sheet. In Gusto, open Reports, choose Payroll data export, and upload the .xlsx it downloads.`,
    );
  const headers = (rows[0] ?? []).map((h) => h.trim());
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length)
    throw new Error(
      `The ${name} sheet repeats a column heading. Export the report again.`,
    );
  for (const header of required)
    if (!headers.includes(header))
      throw new Error(
        `The ${name} sheet is missing the “${header}” column. Export the report again.`,
      );
  const index = new Map(headers.map((h, i) => [h, i]));
  return {
    name,
    headers,
    rows: rows
      .slice(1)
      .map((cells, i) => ({ cells, line: i + 2 }))
      .filter(({ cells }) => cells.some((c) => c.trim() !== ""))
      .map(({ cells, line }) => ({
        line,
        get: (header: string) => (cells[index.get(header) ?? -1] ?? "").trim(),
      })),
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Parses Gusto's Payroll data export workbook into payroll runs, one per check date and pay period. */
export function parseGusto(bytes: Uint8Array): GustoReport {
  if (bytes.length > MAX_BYTES)
    throw new Error("Choose a Gusto payroll export smaller than 2 MB.");
  const book = readXlsx(bytes, GUSTO_SHEETS);
  const date = (value: string, label: string) => {
    const iso = xlsxDate(value, book.date1904);
    if (!iso) throw new Error(`${label}: expected a date.`);
    return iso;
  };
  const payrolls = sheetOf(book.sheets, "payrolls", [
    "Id",
    "Employee id",
    "Employee name",
    "Check date",
    "Payment period start",
    "Payment period end",
    "Gross pay",
    "Net pay",
  ]);
  const earnings = sheetOf(book.sheets, "earnings", [
    "Employee id",
    "Payroll id",
    "Payroll check date",
    "Type",
    "Amount",
  ]);
  const taxes = sheetOf(book.sheets, "taxes", [
    "Employee id",
    "Payroll id",
    "Payroll check date",
    "Tax",
    "Type",
    "Amount",
    "Subject wage",
  ]);
  const deductions = sheetOf(book.sheets, "deductions", [
    "Employee id",
    "Payroll id",
    "Name",
    "Employee deduction",
    "Employer contribution",
  ]);
  // Names only; nothing else about an employee is read.
  const names = new Map<string, string>();
  const people = book.sheets.get("employees");
  if (people) {
    const sheet = sheetOf(book.sheets, "employees", [
      "Id",
      "First name",
      "Last name",
    ]);
    for (const row of sheet.rows) {
      const name = `${row.get("First name")} ${row.get("Last name")}`
        .replace(/\s+/g, " ")
        .trim();
      if (ID.test(row.get("Id")) && name) names.set(row.get("Id"), name);
    }
  }
  if (payrolls.rows.length > 10_000)
    throw new Error("Import up to 10,000 paychecks at a time.");

  interface Working extends GustoCheck {
    credits: { name: string; amount: string }[];
    check_date: string;
    period_from: string;
    period_to: string;
    earned: bigint;
    deducted: bigint;
    seen_taxes: Set<string>;
    facts: Map<string, string[]>;
  }
  const checks = new Map<string, Working>();
  const payrollDates = new Map<string, string>();
  // Gusto lists some $0 off-cycle checks with no pay period. Those fall back
  // to the check date and are left out below; a paid one is refused.
  const noPeriod = new Set<string>();
  const checkKey = (payroll: string, employee: string) =>
    `${payroll}|${employee}`;
  for (const row of payrolls.rows) {
    const label = `Payrolls sheet, row ${row.line}`;
    const payroll_id = row.get("Id");
    const employee_id = row.get("Employee id");
    if (!ID.test(payroll_id) || !ID.test(employee_id))
      throw new Error(`${label}: the payroll and employee ids are required.`);
    const check_date = date(row.get("Check date"), `${label}, check date`);
    const blankPeriod =
      !row.get("Payment period start").trim() &&
      !row.get("Payment period end").trim();
    if (blankPeriod) noPeriod.add(payroll_id);
    const period_from = blankPeriod
      ? check_date
      : date(row.get("Payment period start"), `${label}, pay period start`);
    const period_to = blankPeriod
      ? check_date
      : date(row.get("Payment period end"), `${label}, pay period end`);
    if (period_from > period_to)
      throw new Error(`${label}: the pay period ends before it starts.`);
    if (
      payrollDates.has(payroll_id) &&
      payrollDates.get(payroll_id) !==
        `${check_date}|${period_from}|${period_to}`
    )
      throw new Error(
        `${label}: payroll ${payroll_id} has more than one check date or pay period.`,
      );
    payrollDates.set(payroll_id, `${check_date}|${period_from}|${period_to}`);
    const key = checkKey(payroll_id, employee_id);
    if (checks.has(key))
      throw new Error(
        `${label}: this paycheck appears twice. Export the report again.`,
      );
    const listed = row.get("Employee name");
    const flipped = /^([^,]+),\s*(.+)$/.exec(listed);
    const employee = (
      names.get(employee_id) ??
      (flipped ? `${flipped[2]} ${flipped[1]}` : listed)
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!employee || employee.length > 160)
      throw new Error(`${label}: the employee name is missing.`);
    const gross = cents(row.get("Gross pay"), `${label}, gross pay`);
    const net = cents(row.get("Net pay"), `${label}, net pay`);
    checks.set(key, {
      payroll_id,
      employee_id,
      employee,
      check_date,
      period_from,
      period_to,
      gross: String(gross),
      net: String(net),
      employee_tax: "0",
      employer_tax: "0",
      taxes: [],
      federal_taxable: null,
      federal_withheld: "0",
      state_taxable: null,
      state_withheld: "0",
      social_security_wages: null,
      medicare_wages: null,
      earned: BigInt(0),
      deducted: BigInt(0),
      seen_taxes: new Set(),
      facts: new Map(),
      credits: [],
    });
  }
  const checkFor = (row: Sheet["rows"][number], sheet: string) => {
    const label = `${sheet} sheet, row ${row.line}`;
    const check = checks.get(
      checkKey(row.get("Payroll id"), row.get("Employee id")),
    );
    if (!check)
      throw new Error(
        `${label}: this row belongs to a payroll that is not on the payrolls sheet. Export the report again.`,
      );
    return { check, label };
  };
  for (const row of earnings.rows) {
    const { check, label } = checkFor(row, "Earnings");
    if (
      date(row.get("Payroll check date"), `${label}, check date`) !==
      check.check_date
    )
      throw new Error(`${label}: the check date does not match the payroll.`);
    const type = row.get("Type");
    const amount = cents(row.get("Amount"), `${label}, ${type || "amount"}`);
    if (amount !== BigInt(0) && !CASH_EARNINGS.has(type.toLowerCase()))
      throw new Error(
        `${label}: “${type || "Unnamed"}” earnings need an account mapping this importer does not support yet. Nothing has been imported.`,
      );
    check.earned += amount;
  }
  for (const row of taxes.rows) {
    const { check, label } = checkFor(row, "Taxes");
    if (
      date(row.get("Payroll check date"), `${label}, check date`) !==
      check.check_date
    )
      throw new Error(`${label}: the check date does not match the payroll.`);
    const name = row.get("Tax").replace(/\s+/g, " ");
    const type = row.get("Type").toLowerCase();
    if (!name || name.length > 120)
      throw new Error(`${label}: the tax name is missing.`);
    if (type !== "employee" && type !== "employer")
      throw new Error(
        `${label}: “${row.get("Type")}” is not Employee or Employer.`,
      );
    const seen = `${type}|${name.toLowerCase()}`;
    if (check.seen_taxes.has(seen))
      throw new Error(
        `${label}: ${name} (${type}) appears twice for this paycheck. Export the report again.`,
      );
    check.seen_taxes.add(seen);
    // Gusto's tax corrections list an employer tax as a negative amount on
    // a payroll with no pay. Held aside here; a paid payroll with one is refused.
    const raw = row.get("Amount").trim();
    if (type === "employer" && /^-\$?[\d,]+(\.\d+)?$/.test(raw)) {
      const credit = cents(raw.slice(1), `${label}, ${name}`);
      if (credit > BigInt(0))
        check.credits.push({ name, amount: String(-credit) });
      continue;
    }
    const amount = cents(row.get("Amount"), `${label}, ${name}`);
    const subject = row.get("Subject wage")
      ? String(cents(row.get("Subject wage"), `${label}, subject wage`))
      : null;
    if (type === "employee") {
      check.employee_tax = String(BigInt(check.employee_tax) + amount);
      if (name === "Federal Income Tax") {
        check.federal_withheld = String(
          BigInt(check.federal_withheld) + amount,
        );
        check.federal_taxable = subject;
      } else if (/^[A-Z]{2} (Withholding|Income) Tax$/.test(name)) {
        check.state_withheld = String(BigInt(check.state_withheld) + amount);
        check.facts.set("state", [
          ...(check.facts.get("state") ?? []),
          subject ?? "",
        ]);
      } else if (name === "Social Security")
        check.social_security_wages = subject;
      else if (name === "Medicare") check.medicare_wages = subject;
    } else check.employer_tax = String(BigInt(check.employer_tax) + amount);
    if (amount > BigInt(0))
      check.taxes.push({ name, type, amount: String(amount) });
  }
  for (const row of deductions.rows) {
    const { check, label } = checkFor(row, "Deductions");
    const name = row.get("Name") || "Unnamed deduction";
    const employee = cents(row.get("Employee deduction"), `${label}, ${name}`);
    const employer = cents(
      row.get("Employer contribution"),
      `${label}, ${name}`,
    );
    if (employee !== BigInt(0) || employer !== BigInt(0))
      throw new Error(
        `${label}: the “${name}” deduction needs an account mapping this importer does not support yet. Nothing has been imported.`,
      );
    check.deducted += employee;
  }
  const runs = new Map<string, GustoRun>();
  const nameOwners = new Map<string, string>();
  // A paycheck with no pay, no taxes and no deductions (Gusto's $0 catch-up
  // payrolls) is left out. Zero gross with anything else on it is refused.
  const empty = (check: Working) =>
    BigInt(check.gross) === BigInt(0) &&
    BigInt(check.net) === BigInt(0) &&
    check.earned === BigInt(0) &&
    BigInt(check.employee_tax) === BigInt(0) &&
    BigInt(check.employer_tax) === BigInt(0) &&
    check.deducted === BigInt(0);
  const paid = new Set(
    [...checks.values()].filter((c) => !empty(c)).map((c) => c.payroll_id),
  );
  const skipped = new Map<string, GustoSkipped>();
  for (const check of checks.values()) {
    const label = `Payroll ${check.payroll_id} for ${check.employee}`;
    if (empty(check)) {
      if (!paid.has(check.payroll_id))
        skipped.set(check.payroll_id, {
          payroll_id: check.payroll_id,
          check_date: check.check_date,
          period_from: check.period_from,
          period_to: check.period_to,
          ...(check.credits.length ? { credits: check.credits } : {}),
        });
      continue;
    }
    if (check.credits.length)
      throw new Error(
        `${label}: this paycheck has pay and a negative ${check.credits[0].name}. Check this payroll in Gusto. Nothing has been imported.`,
      );
    if (noPeriod.has(check.payroll_id))
      throw new Error(
        `${label}: this payroll has pay but no pay period. Check this payroll in Gusto. Nothing has been imported.`,
      );
    if (BigInt(check.gross) === BigInt(0))
      throw new Error(
        `${label}: gross pay is zero but the paycheck has taxes, deductions or net pay. Check this payroll in Gusto. Nothing has been imported.`,
      );
    if (check.earned !== BigInt(check.gross))
      throw new Error(
        `${label}: the earnings do not add up to gross pay. Export the report again, or check for earnings this importer does not support.`,
      );
    if (
      BigInt(check.gross) !==
      BigInt(check.net) + BigInt(check.employee_tax) + check.deducted
    )
      throw new Error(
        `${label}: gross pay does not equal net pay plus employee taxes and deductions. Check for reimbursements or corrections in Gusto.`,
      );
    const owner = nameOwners.get(check.employee.toLowerCase());
    if (owner && owner !== check.employee_id)
      throw new Error(
        `Two employees are both named ${check.employee}. Rename one in Gusto, then export again.`,
      );
    nameOwners.set(check.employee.toLowerCase(), check.employee_id);
    const states = check.facts.get("state") ?? [];
    const key = `${check.check_date}|${check.period_from}|${check.period_to}`;
    const run = runs.get(key) ?? {
      check_date: check.check_date,
      period_from: check.period_from,
      period_to: check.period_to,
      payroll_ids: [],
      checks: [],
    };
    if (!run.payroll_ids.includes(check.payroll_id))
      run.payroll_ids.push(check.payroll_id);
    run.checks.push({
      payroll_id: check.payroll_id,
      employee_id: check.employee_id,
      employee: check.employee,
      gross: check.gross,
      net: check.net,
      employee_tax: check.employee_tax,
      employer_tax: check.employer_tax,
      taxes: check.taxes.sort(
        (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
      ),
      federal_taxable: check.federal_taxable,
      federal_withheld: check.federal_withheld,
      state_taxable: states.length === 1 && states[0] !== "" ? states[0] : null,
      state_withheld: check.state_withheld,
      social_security_wages: check.social_security_wages,
      medicare_wages: check.medicare_wages,
    });
    runs.set(key, run);
  }
  if (runs.size > 500)
    throw new Error("Choose a date range with up to 500 payrolls.");
  const sorted = [...runs.values()]
    .map((run) => ({
      ...run,
      payroll_ids: run.payroll_ids.sort(),
      checks: run.checks.sort(
        (a, b) =>
          a.employee.localeCompare(b.employee) ||
          a.payroll_id.localeCompare(b.payroll_id),
      ),
    }))
    .sort(
      (a, b) =>
        a.check_date.localeCompare(b.check_date) ||
        a.period_from.localeCompare(b.period_from) ||
        a.period_to.localeCompare(b.period_to),
    );
  // A file with no paid payrolls is still a valid export: it can carry
  // Gusto's fees and refunds for the years it covers (see gustoYears).
  for (const run of sorted)
    if (new Set(run.checks.map((c) => c.employee_id)).size > 50)
      throw new Error(
        `The ${run.check_date} payroll has more than 50 employees.`,
      );
  return {
    from: sorted[0]?.check_date ?? "",
    to: sorted.at(-1)?.check_date ?? "",
    runs: sorted,
    employees: [
      ...new Set(sorted.flatMap((r) => r.checks.map((c) => c.employee))),
    ].sort(),
    skipped: [...skipped.values()].sort(
      (a, b) =>
        a.period_from.localeCompare(b.period_from) ||
        a.payroll_id.localeCompare(b.payroll_id),
    ),
  };
}

const sum = (values: (string | null)[]) =>
  values.some((v) => v === null)
    ? null
    : String(values.reduce((t, v) => t + BigInt(v as string), BigInt(0)));

/** The payroll body for one Gusto run: wages, net pay, and each tax by name, ready for accrual posting. */
export function gustoBody(run: GustoRun, mapping: GustoMapping): PayrollBody {
  const people = [...new Set(run.checks.map((c) => c.employee_id))];
  const employees = people
    .map((id) => {
      const checks = run.checks.filter((c) => c.employee_id === id);
      const name = checks[0].employee;
      return {
        key: name.toLowerCase(),
        name,
        is_officer: mapping.officers.includes(name),
        gross_cash_cents: sum(checks.map((c) => c.gross))!,
        federal_taxable_cents: sum(checks.map((c) => c.federal_taxable)),
        federal_withheld_cents: sum(checks.map((c) => c.federal_withheld))!,
        state_taxable_cents: sum(checks.map((c) => c.state_taxable)),
        state_withheld_cents: sum(checks.map((c) => c.state_withheld))!,
        social_security_wages_cents: sum(
          checks.map((c) => c.social_security_wages),
        ),
        medicare_wages_cents: sum(checks.map((c) => c.medicare_wages)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const components: PayrollBody["components"] = [];
  const add = (
    key: string,
    kind: string,
    label: string,
    amount: bigint,
    account: string,
    offset: string | null = null,
  ) => {
    if (amount > BigInt(0))
      components.push({
        key,
        kind,
        label,
        amount_cents: String(amount),
        account_id: account,
        offset_account_id: offset,
        expected_on: null,
      });
  };
  for (const officer of [true, false])
    add(
      officer ? "officer_wages" : "other_wages",
      officer ? "officer_wages" : "other_wages",
      officer ? "Officer wages" : "Employee wages",
      employees
        .filter((e) => e.is_officer === officer)
        .reduce((t, e) => t + BigInt(e.gross_cash_cents), BigInt(0)),
      mapping.wages,
    );
  add(
    "net_pay",
    "net_pay",
    "Net pay",
    run.checks.reduce((t, c) => t + BigInt(c.net), BigInt(0)),
    mapping.net_pay,
  );
  for (const type of ["employee", "employer"] as const) {
    const totals = new Map<string, bigint>();
    for (const check of run.checks)
      for (const tax of check.taxes.filter((t) => t.type === type))
        totals.set(
          tax.name,
          (totals.get(tax.name) ?? BigInt(0)) + BigInt(tax.amount),
        );
    for (const [name, amount] of [...totals].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (type === "employee")
        add(
          `employee_tax:${slug(name)}`,
          "employee_tax",
          name,
          amount,
          mapping.tax_payable,
        );
      else
        add(
          `employer_tax:${slug(name)}`,
          "employer_tax",
          `${name} (employer)`,
          amount,
          mapping.employer_tax,
          mapping.tax_payable,
        );
    }
  }
  if (
    new Set(components.map((c) => c.key)).size !== components.length ||
    components.length > 40
  )
    throw new Error(
      `The ${run.check_date} payroll has more tax lines than this importer supports.`,
    );
  return payrollBodySchema.parse({
    pay_date: run.check_date,
    period_from: run.period_from,
    period_to: run.period_to,
    declared_gross_cents: sum(run.checks.map((c) => c.gross)),
    declared_net_cents: sum(run.checks.map((c) => c.net)),
    employees,
    components,
  });
}
