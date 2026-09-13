import Papa from "papaparse";
import { z } from "zod";
import { payrollBodySchema, type PayrollBody } from "./payroll";

export const patriotMappingSchema = z
  .object({
    wages: z.uuid(),
    employer_tax: z.uuid(),
    net_pay: z.uuid(),
    tax_payable: z.uuid(),
    officers: z.array(z.string().min(1).max(160)).max(50),
  })
  .strict();
export type PatriotMapping = z.infer<typeof patriotMappingSchema>;
export const patriotChoiceSchema = z.union([
  z.literal("new"),
  z.uuid(),
  z
    .string()
    .regex(
      /^(link-date|correct-date):[0-9a-f-]{36}:[1-9][0-9]*:\d{4}-\d{2}-\d{2}$/,
    ),
]);
export interface PatriotCheck {
  employee: string;
  paycheck: string;
  pay_date: string;
  period_from: string;
  period_to: string;
  gross: string;
  net: string;
  employee_tax: string;
  employer_tax: string;
  federal_withheld: string;
  state_withheld: string;
  details: [string, string][];
}
export interface PatriotGroup {
  pay_date: string;
  period_from: string;
  period_to: string;
  checks: PatriotCheck[];
}
export interface PatriotReport {
  company_id: string;
  company_name: string;
  groups: PatriotGroup[];
  employees: string[];
}
export interface PatriotResult {
  key: string;
  pay_date: string;
  period_from: string;
  period_to: string;
  gross: string;
  net: string;
  employer_tax: string;
  employee_count: number;
  state: "new" | "duplicate" | "match" | "date_match" | "conflict";
  message: string;
  candidates: {
    id: string;
    memo: string;
    entry_date?: string;
    version?: number;
    amounts_match?: boolean;
    can_correct_date?: boolean;
    lines?: { account_id: string; amount_cents: string }[];
  }[];
  run_id?: string;
  entry_id?: string;
}
export interface PatriotPreview {
  company_id: string;
  company_name: string;
  employees: string[];
  mapping: PatriotMapping;
  results: PatriotResult[];
}

function date(value: string, label: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) throw new Error(`${label}: expected a date such as 9/1/2026.`);
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (
    +m[3] < 1900 ||
    +m[3] > 2100 ||
    +m[1] < 1 ||
    +m[1] > 12 ||
    +m[2] < 1 ||
    +m[2] > 31 ||
    new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) !== iso
  )
    throw new Error(`${label}: invalid date.`);
  return iso;
}
function cents(value: string, label: string): bigint {
  if (!value.trim()) return BigInt(0);
  const v = value.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Error(
      `${label}: negative, voided, or invalid amounts need a separate correction.`,
    );
  const [whole, fraction = ""] = v.split(".");
  const result = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(999999999999999))
    throw new Error(`${label}: amount is too large.`);
  return result;
}
const info = new Set([
  "Pay Date",
  "Transaction Date",
  "Pay Period",
  "Source",
  "Paycheck #",
  "Location Name",
  "Employee",
  "Employee Name",
]);
const earnings = new Set([
  "Regular",
  "Overtime",
  "Double Time",
  "Bonus",
  "Commission",
  "Holiday",
  "Vacation",
  "Sick",
  "Salary",
]);
const employeeTax = (s: string) =>
  /^(Federal Income Tax|Medicare|Social Security|Additional Medicare Tax)$/.test(
    s,
  ) || /^[A-Za-z ]+ State (Tax|Income Tax)$/.test(s);
const employerTax = (s: string) =>
  /^(Employer Medicare Tax|Employer Social Security|Federal Unemployment Tax)$/.test(
    s,
  ) || /^[A-Za-z ]+ State Unemployment \(SUTA\)$/.test(s);

/** Payroll Details, Group By Check. Report totals and earnings columns are never added to Gross Pay. */
export function parsePatriot(csv: string): PatriotReport {
  if (csv.length > 2_000_000 || csv.includes("\0"))
    throw new Error("Use a UTF-8 Payroll Details CSV smaller than 2 MB.");
  const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ""), {
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length)
    throw new Error(
      "This CSV has malformed quotes or rows. Export Payroll Details again.",
    );
  const rows = parsed.data;
  const start = rows.findIndex(
    (r) => r[0]?.trim() === "Pay Date" && r.includes("Gross Pay"),
  );
  if (start < 0)
    throw new Error(
      "Choose Patriot Payroll Details with Group By set to Check.",
    );
  const meta = Object.fromEntries(
    rows.slice(0, start).map((r) => {
      const text = r.join(",");
      const i = text.indexOf(":");
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }),
  );
  if (
    meta["Group By"] !== "Check" ||
    !meta["Company ID"] ||
    !meta["Company Name"]
  )
    throw new Error(
      "The company and Group By: Check header are required. Upload the original Patriot export.",
    );
  const headers = rows[start].map((h) => h.trim());
  if (new Set(headers).size !== headers.length)
    throw new Error("The report contains duplicate column headings.");
  for (const h of [
    "Pay Date",
    "Pay Period",
    "Source",
    "Paycheck #",
    "Gross Pay",
    "Net Pay",
  ])
    if (!headers.includes(h)) throw new Error(`The report is missing ${h}.`);
  if (rows.length - start - 1 > 10000)
    throw new Error("Import up to 10,000 paycheck rows at a time.");
  const groups = new Map<string, PatriotGroup>();
  const seen = new Set<string>();
  for (const [offset, row] of rows.slice(start + 1).entries()) {
    const label = `Paycheck row ${offset + 1}`;
    if (row.length !== headers.length)
      throw new Error(`${label}: unexpected column count.`);
    const r = Object.fromEntries(headers.map((h, i) => [h, row[i].trim()]));
    const employee = r["Employee Name"] || r.Employee || meta.Employee;
    if (
      !employee ||
      /^(all|all employees|total|totals)$/i.test(employee) ||
      employee.length > 160
    )
      throw new Error(
        `${label}: individual employee names are required. Export one employee at a time if this report omits names.`,
      );
    if (!/^(Auto Payroll Paycheck|Paycheck)$/.test(r.Source))
      throw new Error(
        `${label}: ${r.Source || "unknown source"} needs manual review. No payrolls have been imported.`,
      );
    const period = r["Pay Period"].split(/\s+-\s+/);
    if (period.length !== 2)
      throw new Error(`${label}: pay period is missing.`);
    const pay_date = date(r["Pay Date"], label),
      period_from = date(period[0], label),
      period_to = date(period[1], label);
    if (period_from > period_to || period_to > pay_date)
      throw new Error(`${label}: review the pay period and pay date.`);
    for (const [field, before] of [
      ["Report Start Date", true],
      ["Report End Date", false],
    ] as const) {
      if (
        meta[field] &&
        (before
          ? pay_date < date(meta[field], field)
          : pay_date > date(meta[field], field))
      )
        throw new Error(`${label}: pay date is outside the report range.`);
    }
    let withholding = BigInt(0),
      employer = BigInt(0),
      federal = BigInt(0),
      state = BigInt(0);
    const details: [string, string][] = [];
    for (const h of headers) {
      if (info.has(h)) continue;
      const amount = cents(r[h], `${label}, ${h}`);
      if (employeeTax(h)) {
        withholding += amount;
        if (h === "Federal Income Tax") federal += amount;
        if (h.includes(" State ")) state += amount;
      } else if (employerTax(h)) employer += amount;
      else if (
        h !== "Gross Pay" &&
        h !== "Net Pay" &&
        !earnings.has(h) &&
        amount !== BigInt(0)
      )
        throw new Error(
          `${label}: “${h}” needs an account mapping this importer does not support yet. Nothing has been imported.`,
        );
      if (amount !== BigInt(0) && !earnings.has(h))
        details.push([h, String(amount)]);
    }
    const gross = cents(r["Gross Pay"], label),
      net = cents(r["Net Pay"], label);
    if (gross <= BigInt(0) || gross !== net + withholding)
      throw new Error(
        `${label}: gross pay does not equal net pay plus withholding. Check for deductions or reimbursements.`,
      );
    const key = `${pay_date}|${period_from}|${period_to}`;
    const checkKey = JSON.stringify([
      key,
      employee.toLowerCase(),
      r["Paycheck #"],
    ]);
    if (seen.has(checkKey))
      throw new Error(
        `${label}: repeated or ambiguous paycheck for ${employee}. Export checks with distinct paycheck numbers.`,
      );
    seen.add(checkKey);
    const group = groups.get(key) ?? {
      pay_date,
      period_from,
      period_to,
      checks: [],
    };
    group.checks.push({
      employee,
      paycheck: r["Paycheck #"],
      pay_date,
      period_from,
      period_to,
      gross: String(gross),
      net: String(net),
      employee_tax: String(withholding),
      employer_tax: String(employer),
      federal_withheld: String(federal),
      state_withheld: String(state),
      details: details.sort(([a], [b]) => a.localeCompare(b)),
    });
    groups.set(key, group);
  }
  if (!groups.size || groups.size > 500)
    throw new Error("Choose a report containing 1 to 500 payroll periods.");
  return {
    company_id: meta["Company ID"],
    company_name: meta["Company Name"],
    groups: [...groups.values()].sort(
      (a, b) =>
        a.pay_date.localeCompare(b.pay_date) ||
        a.period_from.localeCompare(b.period_from),
    ),
    employees: [
      ...new Set(
        [...groups.values()].flatMap((g) => g.checks.map((c) => c.employee)),
      ),
    ].sort(),
  };
}

export function patriotBody(
  group: PatriotGroup,
  mapping: PatriotMapping,
): PayrollBody {
  const employees = [...new Set(group.checks.map((c) => c.employee))]
    .sort()
    .map((name) => {
      const checks = group.checks.filter((c) => c.employee === name);
      const sum = (field: "gross" | "federal_withheld" | "state_withheld") =>
        String(checks.reduce((v, c) => v + BigInt(c[field]), BigInt(0)));
      return {
        key: name.toLowerCase(),
        name,
        is_officer: mapping.officers.includes(name),
        gross_cash_cents: sum("gross"),
        federal_withheld_cents: sum("federal_withheld"),
        state_withheld_cents: sum("state_withheld"),
      };
    });
  const sum = (field: "gross" | "net" | "employee_tax" | "employer_tax") =>
    String(group.checks.reduce((v, c) => v + BigInt(c[field]), BigInt(0)));
  const components: PayrollBody["components"] = [];
  const add = (
    kind: string,
    amount: string,
    account: string,
    offset: string | null = null,
  ) => {
    if (BigInt(amount) > BigInt(0))
      components.push({
        key: kind,
        kind,
        label: kind.replaceAll("_", " "),
        amount_cents: amount,
        account_id: account,
        offset_account_id: offset,
        expected_on: null,
      });
  };
  for (const officer of [true, false])
    add(
      officer ? "officer_wages" : "other_wages",
      String(
        employees
          .filter((e) => e.is_officer === officer)
          .reduce((v, e) => v + BigInt(e.gross_cash_cents), BigInt(0)),
      ),
      mapping.wages,
    );
  add("net_pay", sum("net"), mapping.net_pay);
  add("employee_tax", sum("employee_tax"), mapping.tax_payable);
  add(
    "employer_tax",
    sum("employer_tax"),
    mapping.employer_tax,
    mapping.tax_payable,
  );
  return payrollBodySchema.parse({
    pay_date: group.pay_date,
    period_from: group.period_from,
    period_to: group.period_to,
    declared_gross_cents: sum("gross"),
    declared_net_cents: sum("net"),
    employees,
    components,
  });
}
