import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import {
  gustoCreditNote,
  gustoFileRange,
  gustoYears,
  gustoSkippedNote,
  parseGusto,
  type GustoMapping,
  type GustoResult,
} from "../src/lib/accounting/gusto-import";
import { gustoItems } from "../src/lib/accounting/server/gusto-payload";
import { readXlsx, xlsxDate } from "../src/lib/accounting/xlsx";
import {
  gustoDefaultChoices,
  gustoRunChoices,
  gustoSummary,
  gustoUnits,
} from "../src/lib/accounting/gusto-review";
import {
  payrollTies,
  registerRuns,
  type PayrollYearRead,
} from "../src/lib/accounting/payroll-register";
import type { SupportReportData } from "../src/lib/accounting/support-reports";
import type { ReportData } from "../src/lib/accounting/reports";
import { accountingTestDb } from "./accounting-test-db";

/**
 * The Gusto importer on a synthetic Payroll data export (made-up people and
 * amounts): the workbook reader and parser, then every link state against
 * books shaped like Wave's payroll journals (a month's two runs in one
 * journal, penny differences), commit, duplicates, conflicts, undo, a
 * journal several runs share, and the payroll register ties.
 * Pass a real export path to also parse it locally (nothing is stored).
 */

type Cell = string | { n: string };
const num = (value: string | number): Cell => ({ n: String(value) });
const serial = (iso: string) =>
  num(
    (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) -
      Date.UTC(1899, 11, 30)) /
      86_400_000,
  );
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const letter = (i: number) => String.fromCharCode(65 + i);

/** A minimal .xlsx shaped like Gusto's: shared strings, numbers, and dates as serial numbers. */
function workbook(
  sheets: [string, Cell[][]][],
  options: { inline?: boolean } = {},
): Uint8Array {
  const shared: string[] = [];
  const index = new Map<string, number>();
  const sharedIndex = (s: string) => {
    if (!index.has(s)) {
      index.set(s, shared.length);
      shared.push(s);
    }
    return index.get(s)!;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach(([, rows], i) => {
    const xml = rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell, c) =>
              typeof cell === "string"
                ? options.inline
                  ? `<c r="${letter(c)}${r + 1}" t="inlineStr"><is><t>${esc(cell)}</t></is></c>`
                  : `<c r="${letter(c)}${r + 1}" s="0" t="s"><v>${sharedIndex(cell)}</v></c>`
                : `<c r="${letter(c)}${r + 1}" s="0" t="n"><v>${cell.n}</v></c>`,
            )
            .join("")}</row>`,
      )
      .join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`,
    );
  });
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="false"/><sheets>${sheets
      .map(
        ([name], i) =>
          `<sheet sheetId="${i + 1}" name="${esc(name)}" r:id="rId${i + 1}"></sheet>`,
      )
      .join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Target="worksheets/sheet${i + 1}.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Id="rId${i + 1}"/>`,
      )
      .join("")}</Relationships>`,
  );
  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
      .map((s) => `<si><t>${esc(s)}</t></si>`)
      .join("")}</sst>`,
  );
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
  );
  return zipSync(files);
}

interface Person {
  id: string;
  first: string;
  last: string;
}
interface Pay {
  person: Person;
  gross: number;
  fit: number;
  state: number;
  suta: number;
  futa: number;
  extraEarning?: [string, number];
  deduction?: number;
}
interface Run {
  id: string;
  check: string;
  from: string;
  to: string;
  pays: Pay[];
}
const ALEX: Person = { id: "emp_a1", first: "Alex", last: "Sample" };
const JAMIE: Person = { id: "emp_b2", first: "Jamie", last: "Example" };
const ss = (gross: number) => Math.round(gross * 0.062);
const med = (gross: number) => Math.round(gross * 0.0145);
const eeTax = (p: Pay) => p.fit + ss(p.gross) + med(p.gross) + p.state;
const erTax = (p: Pay) => ss(p.gross) + med(p.gross) + p.suta + p.futa;
const netOf = (p: Pay) => p.gross - eeTax(p) - (p.deduction ?? 0);
const dollars = (cents: number) =>
  (cents / 100).toFixed(2).replace(/\.00$/, ".0");

function exportOf(
  runs: Run[],
  tweak: (sheets: Map<string, Cell[][]>) => void = () => {},
  options: { inline?: boolean } = {},
) {
  const period = (r: Run) => `${r.from} - ${r.to}`;
  const sheets = new Map<string, Cell[][]>([
    [
      "employees",
      [
        [
          "Id",
          "First name",
          "Last name",
          "Latest hire date",
          "Department",
          "Primary job title",
        ],
        ...[ALEX, JAMIE].map(
          (p) =>
            [
              p.id,
              p.first,
              p.last,
              serial("2023-01-01"),
              "",
              "Synthetic",
            ] as Cell[],
        ),
      ],
    ],
    ["employee_jobs", [["Employee id", "Employee name", "Job title"]]],
    ["work_locations", [["Id", "Street 1", "City"]]],
    [
      "payrolls",
      [
        [
          "Id",
          "Employee id",
          "Employee name",
          "Check date",
          "Payment period start",
          "Payment period end",
          "Payment method",
          "Gross pay",
          "Net pay",
        ],
        ...runs.flatMap((r) =>
          r.pays.map(
            (p) =>
              [
                r.id,
                p.person.id,
                `${p.person.last}, ${p.person.first}`,
                serial(r.check),
                serial(r.from),
                serial(r.to),
                "Direct Deposit",
                num(dollars(p.gross)),
                num(dollars(netOf(p))),
              ] as Cell[],
          ),
        ),
      ],
    ],
    [
      "earnings",
      [
        [
          "Employee id",
          "Employee name",
          "Payroll id",
          "Payroll check date",
          "Payroll payment period",
          "Type",
          "Job title",
          "Hours",
          "Rate",
          "Amount",
        ],
        ...runs.flatMap((r) =>
          r.pays.flatMap((p) => {
            const extra = p.extraEarning;
            const base = [
              p.person.id,
              `${p.person.last}, ${p.person.first}`,
              r.id,
              serial(r.check),
              period(r),
            ] as Cell[];
            return [
              [
                ...base,
                "Regular",
                "Synthetic",
                num("86.666667"),
                num("1.0"),
                num(dollars(p.gross - (extra?.[1] ?? 0))),
              ],
              ...(extra
                ? [
                    [
                      ...base,
                      extra[0],
                      "Synthetic",
                      num("0.0"),
                      num("0.0"),
                      num(dollars(extra[1])),
                    ],
                  ]
                : []),
            ] as Cell[][];
          }),
        ),
      ],
    ],
    [
      "taxes",
      [
        [
          "Employee id",
          "Employee name",
          "Payroll id",
          "Payroll check date",
          "Payroll payment period",
          "Tax",
          "Type",
          "Amount",
          "Subject wage",
          "Gross subject wage",
        ],
        ...runs.flatMap((r) =>
          r.pays.flatMap((p) => {
            const base = [
              p.person.id,
              `${p.person.last}, ${p.person.first}`,
              r.id,
              serial(r.check),
              period(r),
            ] as Cell[];
            const g = num(dollars(p.gross));
            return [
              [
                ...base,
                "Federal Income Tax",
                "Employee",
                num(dollars(p.fit)),
                g,
                g,
              ],
              [
                ...base,
                "Social Security",
                "Employee",
                num(dollars(ss(p.gross))),
                g,
                g,
              ],
              [
                ...base,
                "Social Security",
                "Employer",
                num(dollars(ss(p.gross))),
                g,
                g,
              ],
              [
                ...base,
                "Medicare",
                "Employee",
                num(dollars(med(p.gross))),
                g,
                g,
              ],
              [
                ...base,
                "Medicare",
                "Employer",
                num(dollars(med(p.gross))),
                g,
                g,
              ],
              [...base, "FUTA", "Employer", num(dollars(p.futa)), g, g],
              [
                ...base,
                "ZZ Unemployment Tax",
                "Employer",
                num(dollars(p.suta)),
                g,
                g,
              ],
              [
                ...base,
                "ZZ Withholding Tax",
                "Employee",
                num(dollars(p.state)),
                g,
                g,
              ],
              [
                ...base,
                "Additional Medicare",
                "Employee",
                num("0.0"),
                num("0.0"),
                g,
              ],
            ] as Cell[][];
          }),
        ),
      ],
    ],
    [
      "deductions",
      [
        [
          "Employee id",
          "Employee name",
          "Payroll id",
          "Payroll check date",
          "Payroll payment period",
          "Name",
          "Type",
          "Employee deduction",
          "Employer contribution",
        ],
        ...runs.flatMap((r) =>
          r.pays
            .filter((p) => p.deduction)
            .map(
              (p) =>
                [
                  p.person.id,
                  `${p.person.last}, ${p.person.first}`,
                  r.id,
                  serial(r.check),
                  period(r),
                  "Synthetic plan",
                  "Pre-tax",
                  num(dollars(p.deduction!)),
                  num("0.0"),
                ] as Cell[],
            ),
        ),
      ],
    ],
  ]);
  tweak(sheets);
  return workbook([...sheets], options);
}

const pay = (person: Person, gross: number, extra: Partial<Pay> = {}): Pay => ({
  person,
  gross,
  fit: 31900,
  state: 8750,
  suta: 5833,
  futa: 1750,
  ...extra,
});
const run = (
  id: string,
  check: string,
  from: string,
  to: string,
  pays: Pay[],
): Run => ({ id, check, from, to, pays });

// The synthetic year: a run in March, two a month after, Alex every run and Jamie from April.
const R = {
  mar: run("payrolls_r01", "2023-03-31", "2023-03-16", "2023-03-31", [
    pay(ALEX, 291667),
  ]),
  apr1: run("payrolls_r02", "2023-04-14", "2023-04-01", "2023-04-15", [
    pay(ALEX, 291667),
    pay(JAMIE, 150000, { fit: 9000, state: 3000, futa: 900 }),
  ]),
  apr2: run("payrolls_r03", "2023-04-28", "2023-04-16", "2023-04-30", [
    pay(ALEX, 291667),
    pay(JAMIE, 150000, { fit: 9000, state: 3000, futa: 900 }),
  ]),
  may1: run("payrolls_r04", "2023-05-15", "2023-05-01", "2023-05-15", [
    pay(ALEX, 291667, { futa: 0 }),
  ]),
  may2: run("payrolls_r05", "2023-05-31", "2023-05-16", "2023-05-31", [
    pay(ALEX, 291667, { futa: 0, fit: 32000 }),
  ]),
  jun1: run("payrolls_r06", "2023-06-15", "2023-06-01", "2023-06-15", [
    pay(ALEX, 216667, { futa: 0 }),
  ]),
  jun2: run("payrolls_r07", "2023-06-30", "2023-06-16", "2023-06-30", [
    pay(ALEX, 216667, { futa: 0, suta: 5834 }),
  ]),
  jul1: run("payrolls_r08", "2023-07-14", "2023-07-01", "2023-07-15", [
    pay(ALEX, 216667, { futa: 0 }),
  ]),
  jul2: run("payrolls_r09", "2023-07-31", "2023-07-16", "2023-07-31", [
    pay(ALEX, 216667, { futa: 0, suta: 5832 }),
  ]),
  aug1: run("payrolls_r10", "2023-08-15", "2023-08-01", "2023-08-15", [
    pay(ALEX, 216667, { futa: 0 }),
  ]),
  aug2: run("payrolls_r11", "2023-08-31", "2023-08-16", "2023-08-31", [
    pay(ALEX, 216667, { futa: 0 }),
    pay(JAMIE, 50000, { fit: 0, state: 0, futa: 300 }),
  ]),
};
const YEAR = Object.values(R);

async function main() {
  let checks = 0;
  const ok = (value: unknown, message?: string) => {
    assert.ok(value, message);
    checks++;
  };
  const eq = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const throwsLike = (fn: () => unknown, pattern: RegExp) => {
    assert.throws(fn, pattern);
    checks++;
  };

  // The reader: shared and inline strings, dates, and refusing what is not a workbook.
  const book = readXlsx(
    exportOf([R.mar], () => {}, { inline: true }),
    ["payrolls"],
  );
  eq(book.sheets.get("payrolls")![1].slice(0, 3), [
    "payrolls_r01",
    "emp_a1",
    "Sample, Alex",
  ]);
  eq(xlsxDate("45016.0", false), "2023-03-31");
  eq(xlsxDate("2023-03-31", false), "2023-03-31");
  eq(xlsxDate("2/30/2023", false), null);
  throwsLike(
    () => readXlsx(strToU8("Pay Date,Gross Pay\n"), []),
    /not an Excel workbook/,
  );
  throwsLike(
    () => readXlsx(zipSync({ "hello.txt": strToU8("hi") }), []),
    /not an Excel workbook/,
  );

  // The parser: runs, names from the employees sheet, facts, and strict refusals.
  const report = parseGusto(exportOf(YEAR));
  eq(report.runs.length, 11);
  eq([report.from, report.to], ["2023-03-31", "2023-08-31"]);
  eq(report.employees, ["Alex Sample", "Jamie Example"]);
  const april = report.runs[1];
  eq(april.check_date, "2023-04-14");
  eq(
    april.period_to > april.check_date,
    true,
    "Gusto pays before the period ends",
  );
  const alexApril = april.checks.find((c) => c.employee === "Alex Sample")!;
  eq(alexApril.social_security_wages, "291667");
  eq(alexApril.medicare_wages, "291667");
  eq(alexApril.federal_withheld, "31900");
  eq(alexApril.state_withheld, "8750");
  eq(
    BigInt(alexApril.gross),
    BigInt(alexApril.net) + BigInt(alexApril.employee_tax),
  );
  eq(
    parseGusto(exportOf([R.mar], () => {}, { inline: true })).runs[0].checks[0]
      .gross,
    "291667",
  );
  throwsLike(
    () => parseGusto(exportOf([R.mar], (s) => s.delete("taxes"))),
    /no taxes sheet/,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) => (s.get("payrolls")![1][8] = num("2000.00"))),
      ),
    /gross pay does not equal net pay plus employee taxes/,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([
          run("payrolls_x", "2023-03-31", "2023-03-16", "2023-03-31", [
            pay(ALEX, 291667, { extraEarning: ["Group Term Life", 1000] }),
          ]),
        ]),
      ),
    /“Group Term Life” earnings/,
  );
  eq(
    parseGusto(
      exportOf([
        run("payrolls_x", "2023-03-31", "2023-03-16", "2023-03-31", [
          pay(ALEX, 291667, { extraEarning: ["Bonus", 1000] }),
        ]),
      ]),
    ).runs.length,
    1,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([
          run("payrolls_x", "2023-03-31", "2023-03-16", "2023-03-31", [
            pay(ALEX, 291667, { deduction: 1000 }),
          ]),
        ]),
      ),
    /“Synthetic plan” deduction/,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) => (s.get("payrolls")![1][7] = num("-2916.67"))),
      ),
    /negative amounts/,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) =>
          s.get("payrolls")!.push(s.get("payrolls")![1]),
        ),
      ),
    /appears twice/,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf(
          [R.mar],
          (s) => (s.get("taxes")![1][3] = serial("2023-04-01")),
        ),
      ),
    /check date does not match/,
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) => (s.get("taxes")![1][7] = num("319.005"))),
      ),
    /whole cents/,
  );
  // A year with no Gusto payroll: every sheet has headings only. It parses to a
  // fees-only file whose years come from Gusto's file name or the owner's pick.
  const empty = parseGusto(exportOf([]));
  eq([empty.runs, empty.skipped, empty.from, empty.to], [[], [], "", ""]);
  const gustoName = (from: string, to: string) =>
    `payroll_data_export_example-company_${from}_to_${to}_2026-10-04T00-53-58-07-00.xlsx`;
  eq(gustoFileRange(gustoName("2026-01-01", "2026-12-31")), {
    from: "2026-01-01",
    to: "2026-12-31",
  });
  eq(gustoYears(empty, gustoFileRange(gustoName("2026-01-01", "2026-12-31"))), [
    2026,
  ]);
  eq(
    gustoYears(empty, gustoFileRange(gustoName("2024-07-01", "2025-06-30"))),
    [2024, 2025],
    "a range spanning two years covers both",
  );
  eq(
    gustoYears(empty, null, 2026),
    [2026],
    "a chosen year when the name has no range",
  );
  eq(
    gustoYears(empty),
    [],
    "no payrolls, no range, no pick: the year must be asked",
  );
  eq(gustoFileRange("my-payroll.xlsx"), null);
  eq(gustoFileRange(gustoName("2026-02-30", "2026-12-31")), null);
  eq(gustoFileRange(gustoName("2026-12-31", "2026-01-01")), null);
  eq(
    gustoYears(
      parseGusto(exportOf([R.mar])),
      gustoFileRange(gustoName("2022-11-01", "2023-12-31")),
    ),
    [2022, 2023],
    "the name's range adds years before the first payroll",
  );
  throwsLike(
    () => parseGusto(exportOf([], (s) => s.delete("payrolls"))),
    /no payrolls sheet/,
  );

  // Gusto's $0 catch-up payrolls (no pay, no taxes, no deductions) are left out and reported.
  const catchUp = (
    id: string,
    check: string,
    from: string,
    to: string,
  ): Cell[] => [
    id,
    ALEX.id,
    "Sample, Alex",
    serial(check),
    serial(from),
    serial(to),
    "Direct Deposit",
    num("0.0"),
    num("0.0"),
  ];
  const withEmpty = parseGusto(
    exportOf([R.mar], (s) =>
      s
        .get("payrolls")!
        .push(
          catchUp("payrolls_z1", "2023-04-03", "2023-01-01", "2023-01-15"),
          catchUp("payrolls_z2", "2023-04-03", "2023-01-16", "2023-01-31"),
        ),
    ),
  );
  eq(withEmpty.runs.length, 1);
  eq([withEmpty.from, withEmpty.to], ["2023-03-31", "2023-03-31"]);
  eq(
    withEmpty.skipped.map((x) => x.payroll_id),
    ["payrolls_z1", "payrolls_z2"],
  );
  const shortDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  eq(
    gustoSkippedNote(withEmpty.skipped, (d) =>
      shortDate.format(new Date(`${d}T00:00:00Z`)),
    ),
    "2 payrolls had no pay ($0) and were left out: Jan 1 to Jan 31, 2023.",
  );
  // A $0 off-cycle check Gusto lists with no pay period is left out too.
  const offCycle = catchUp(
    "payrolls_z3",
    "2023-04-03",
    "2023-01-01",
    "2023-01-15",
  );
  offCycle[4] = "";
  offCycle[5] = "";
  offCycle[6] = "Check";
  const withOffCycle = parseGusto(
    exportOf([R.mar], (s) => s.get("payrolls")!.push(offCycle)),
  );
  eq(withOffCycle.runs.length, 1);
  eq(
    withOffCycle.skipped.map((x) => [x.payroll_id, x.period_from, x.period_to]),
    [["payrolls_z3", "2023-04-03", "2023-04-03"]],
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) => {
          const row = s.get("payrolls")![1];
          row[4] = "";
          row[5] = "";
        }),
      ),
    /has pay but no pay period/,
  );
  // A tax correction: a $0 check carrying a negative employer tax is left out and its credit reported.
  const withCredit = parseGusto(
    exportOf([R.mar], (s) => {
      s.get("payrolls")!.push(offCycle);
      s.get("taxes")!.push([
        ALEX.id,
        "Sample, Alex",
        "payrolls_z3",
        serial("2023-04-03"),
        "",
        "AZ Unemployment Tax",
        "Employer",
        num("-4.9"),
        num("0.0"),
        num("0.0"),
      ]);
    }),
  );
  eq(withCredit.runs.length, 1);
  eq(withCredit.skipped[0].credits, [
    { name: "AZ Unemployment Tax", amount: "-490" },
  ]);
  eq(
    gustoCreditNote(withCredit.skipped, (d) =>
      shortDate.format(new Date(`${d}T00:00:00Z`)),
    ),
    "Gusto also credited back $4.90 of AZ Unemployment Tax on Apr 3, 2023 as a tax correction. It is not imported: Gusto refunds it to your bank, so book that deposit to your employer payroll taxes.",
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) => {
          const taxes = s.get("taxes")!;
          const row = taxes.find((r) => r[6] === "Employer")!;
          row[7] = num("-1.00");
        }),
      ),
    /has pay and a negative/,
  );
  const dummy: GustoMapping = {
    wages: randomUUID(),
    employer_tax: randomUUID(),
    net_pay: randomUUID(),
    tax_payable: randomUUID(),
    officers: [],
  };
  eq(
    gustoItems(withEmpty, dummy).map((i) => [i.key, i.fingerprint]),
    gustoItems(parseGusto(exportOf([R.mar])), dummy).map((i) => [
      i.key,
      i.fingerprint,
    ]),
    "left-out payrolls do not change the real runs' keys",
  );
  throwsLike(
    () =>
      parseGusto(
        exportOf([R.mar], (s) => {
          s.get("payrolls")!.push(
            catchUp("payrolls_z1", "2023-04-03", "2023-01-01", "2023-01-15"),
          );
          s.get("taxes")!.push([
            ALEX.id,
            "Sample, Alex",
            "payrolls_z1",
            serial("2023-04-03"),
            "2023-01-01 - 2023-01-15",
            "FUTA",
            "Employer",
            num("1.00"),
            num("0.0"),
            num("0.0"),
          ]);
        }),
      ),
    /gross pay is zero but the paycheck has taxes/,
  );
  // A file with only $0 payrolls is a fees-only file, not an error.
  const onlyEmpty = parseGusto(
    exportOf([], (s) =>
      s
        .get("payrolls")!
        .push(catchUp("payrolls_z1", "2023-04-03", "2023-01-01", "2023-01-15")),
    ),
  );
  eq(
    [onlyEmpty.runs.length, onlyEmpty.skipped.length, onlyEmpty.from],
    [0, 1, ""],
  );
  eq(
    gustoYears(onlyEmpty),
    [2023],
    "the $0 payroll's check date still names its year",
  );

  const db = await accountingTestDb(
    process.env.GUSTO_SCHEMA === "canonical" ? "canonical" : "migrations",
  );
  const command = async (c: object) =>
    (
      await db.query<{
        r: { id: string; version: number; storage_path?: string } & Record<
          string,
          unknown
        >;
      }>("SELECT accounting.operate($1::jsonb) r", [
        JSON.stringify({ key: randomUUID(), command: c }),
      ])
    ).rows[0].r;
  const call = async (request: object) =>
    (
      await db.query<{ r: GustoResult[] }>(
        "SELECT accounting.gusto_import($1::jsonb) r",
        [JSON.stringify(request)],
      )
    ).rows[0].r;
  const read = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, params)).rows[0].r;
  /** Reads a table directly, as the database owner, to check what commands left behind. */
  const inspect = async <T>(sql: string, params: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return await read<T>(sql, params);
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const entryDetail = (id: string) =>
    read<{
      id: string;
      version: number;
      status: string;
      entry_date: string;
      payroll_run_id: string | null;
      payroll_run_ids: string[];
      lines: { account_id: string; amount_cents: string }[];
    }>("SELECT accounting.entry_detail($1) r", [id]);
  const runDetail = (id: string) =>
    read<{
      id: string;
      version: number;
      status: string;
      provider: string;
      entry_shared: boolean;
      import_mode: string;
      import_undone: boolean;
      register: { body: { ytd: Record<string, Record<string, unknown>> } };
    }>("SELECT accounting.payroll($1) r", [
      JSON.stringify({ view: "detail", id }),
    ]);
  try {
    const mapping: GustoMapping = {
      wages: randomUUID(),
      employer_tax: randomUUID(),
      net_pay: randomUUID(),
      tax_payable: randomUUID(),
      officers: ["Alex Sample"],
    };
    for (const name of [
      "wages",
      "employer_tax",
      "net_pay",
      "tax_payable",
    ] as const)
      await command({
        type: "account.create",
        id: mapping[name],
        name: {
          wages: "Payroll Salary and Wages",
          employer_tax: "Payroll Employer Taxes",
          net_pay: "Net Salary Payable",
          tax_payable: "Taxes Payable",
        }[name],
        account_type:
          name === "wages" || name === "employer_tax" ? "expense" : "liability",
        subtype:
          name === "wages" || name === "employer_tax"
            ? "payroll_expense"
            : "payroll_liability",
      });
    const evidence = async (hash: string) => {
      const document_id = randomUUID();
      const doc = await command({
        type: "document.prepare",
        id: document_id,
        original_name: "synthetic-gusto.xlsx",
        mime_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size_bytes: "2000",
        content_hash: hash,
      });
      await db.query(
        "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
        [doc.storage_path],
      );
      await command({
        type: "document.complete",
        id: document_id,
        expected_version: doc.version,
      });
      return { document_id, content_hash: hash };
    };
    const file = await evidence("c".repeat(64));
    await db.exec("RESET ROLE");
    eq(
      (
        await db.query<{ ok: boolean }>(
          "SELECT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'=ANY(allowed_mime_types) ok FROM storage.buckets WHERE id='accounting-private'",
        )
      ).rows[0].ok,
      true,
      "the evidence bucket takes .xlsx",
    );
    await db.exec("SET ROLE authenticated");

    // The books, as Wave left them: account totals per run, split across lines.
    const totals = (runs: Run[]) => {
      const pays = runs.flatMap((r) => r.pays);
      const sum = (f: (p: Pay) => number) => pays.reduce((t, p) => t + f(p), 0);
      return {
        wages: sum((p) => p.gross),
        employer: sum(erTax),
        net: sum(netOf),
        taxes: sum((p) => eeTax(p) + erTax(p)),
      };
    };
    const journal = async (
      date: string,
      memo: string,
      t: ReturnType<typeof totals>,
    ) => {
      const half = Math.floor(t.taxes / 2);
      const draft = await command({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo,
        kind: "manual",
        lines: [
          { account_id: mapping.wages, amount_cents: String(t.wages) },
          {
            account_id: mapping.employer_tax,
            amount_cents: String(t.employer - 100),
          },
          { account_id: mapping.employer_tax, amount_cents: "100" },
          { account_id: mapping.net_pay, amount_cents: String(-t.net) },
          { account_id: mapping.tax_payable, amount_cents: String(-half) },
          {
            account_id: mapping.tax_payable,
            amount_cents: String(-(t.taxes - half)),
          },
        ],
      });
      return (
        await command({
          type: "entry.post",
          id: draft.id,
          expected_version: draft.version,
        })
      ).id;
    };
    const penny = (t: ReturnType<typeof totals>) => ({
      ...t,
      wages: t.wages + 1,
      employer: t.employer - 1,
    });
    const books = {
      mar: await journal("2023-03-29", "Payroll for 3/31", totals([R.mar])),
      apr: await journal(
        "2023-04-30",
        "Payroll for 4/15 & 4/30",
        totals([R.apr1, R.apr2]),
      ),
      may1: await journal("2023-05-15", "Payroll for 5/15", totals([R.may1])),
      may2: await journal("2023-05-31", "Payroll for 5/31", totals([R.may2])),
      jun: await journal(
        "2023-06-30",
        "Payroll for 6/15 & 6/30",
        penny(totals([R.jun1, R.jun2])),
      ),
      jul: await journal(
        "2023-07-31",
        "Payroll for 7/15 & 7/31",
        penny(totals([R.jul1, R.jul2])),
      ),
    };
    // A bank payment of net pay is never a candidate.
    await (async () => {
      const bank = await inspect<string>(
        "SELECT id r FROM accounting.accounts WHERE name='Business checking'",
      );
      const draft = await command({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: "2023-08-15",
        memo: "Online Transfer / Payment: Debit GUSTO payroll",
        lines: [
          { account_id: mapping.net_pay, amount_cents: "150000" },
          { account_id: bank, amount_cents: "-150000" },
        ],
      });
      await command({
        type: "entry.post",
        id: draft.id,
        expected_version: draft.version,
      });
    })();

    const items = gustoItems(report, mapping);
    const base = { mapping, ...file, items };
    // A run's key and fingerprint do not depend on the date range exported.
    const alone = gustoItems(parseGusto(exportOf([R.apr1])), mapping)[0];
    eq([alone.key, alone.fingerprint], [items[1].key, items[1].fingerprint]);
    ok(/^Gusto 2023-04-14 [a-f0-9]{64}$/.test(alone.key));
    eq(
      items[1].body.components.map((c) => c.label),
      [
        "Officer wages",
        "Employee wages",
        "Net pay",
        "Federal Income Tax",
        "Medicare",
        "Social Security",
        "ZZ Withholding Tax",
        "FUTA (employer)",
        "Medicare (employer)",
        "Social Security (employer)",
        "ZZ Unemployment Tax (employer)",
      ],
      "each tax keeps its own name",
    );
    eq(
      items[1].body.employees.find((e) => e.name === "Jamie Example")
        ?.is_officer,
      false,
    );

    const preview = await call({ ...base, mode: "preview" });
    const byKey = new Map(preview.map((r) => [r.key, r]));
    const state = (r: Run) => byKey.get(items[YEAR.indexOf(r)].key)!;
    eq(
      YEAR.map((r) => state(r).state),
      [
        "date_match",
        "group_match",
        "group_match",
        "match",
        "match",
        "difference",
        "difference",
        "difference",
        "difference",
        "new",
        "new",
      ],
    );
    eq(state(R.mar).entry?.id, books.mar);
    eq(state(R.apr1).entry?.id, books.apr);
    eq(state(R.apr1).group, [items[1].key, items[2].key]);
    eq(state(R.may2).entry?.id, books.may2);
    eq(state(R.jun1).entry?.id, books.jun);
    eq(
      state(R.jun1)
        .difference.map((d) => [d.account_id, d.difference_cents])
        .sort(),
      [
        [mapping.wages, "1"],
        [mapping.employer_tax, "-1"],
      ].sort(),
      "the penny difference is shown per account",
    );
    eq(state(R.jun1).entry?.can_correct, true);
    ok(/Keep that date or move it/.test(state(R.mar).message));
    ok(state(R.apr1).message.includes("together with 1 other"));
    eq(state(R.aug1).entry, null);
    eq(
      preview.find((r) => r.state === "new")?.employee_tax,
      String(eeTax(R.aug1.pays[0])),
    );

    // The review screen: one unit per payroll or shared entry, with one choice each.
    const units = gustoUnits(preview);
    eq(
      units.map((u) => [u.month, u.state, u.runs.length]),
      [
        ["2023-03", "date_match", 1],
        ["2023-04", "group_match", 2],
        ["2023-05", "match", 1],
        ["2023-05", "match", 1],
        ["2023-06", "difference", 2],
        ["2023-07", "difference", 2],
        ["2023-08", "new", 1],
        ["2023-08", "new", 1],
      ],
    );
    const defaults = gustoDefaultChoices(units);
    eq(
      defaults[units[0].key],
      undefined,
      "a date difference waits for the owner",
    );
    eq(
      defaults[units[4].key],
      `correct:${books.jun}:${state(R.jun1).entry!.version}`,
      "a difference defaults to Gusto",
    );
    eq(gustoSummary(units, defaults), {
      payrolls: 11,
      link: 8,
      needChoice: 1,
      posted: 2,
      skipped: 0,
      corrections: 2,
    });
    eq(
      Object.keys(gustoRunChoices(units, defaults)).length,
      10,
      "every run in a group carries the unit's choice",
    );
    eq(gustoSummary(units, { ...defaults, [units[6].key]: "" }).skipped, 1);

    // A group is imported together: one member alone is refused.
    const choose = (pick: (r: Run) => string | undefined) => {
      const out: Record<string, string> = {};
      YEAR.forEach((r, i) => {
        const choice = pick(r);
        if (choice) out[items[i].key] = choice;
      });
      return out;
    };
    const link = (r: Run) =>
      `link:${state(r).entry!.id}:${state(r).entry!.version}`;
    const correct = (r: Run) =>
      `correct:${state(r).entry!.id}:${state(r).entry!.version}`;
    const commit = (choices: Record<string, string>, request: object = base) =>
      call({
        ...request,
        mode: "commit",
        items: gustoItems(report, mapping, choices),
      });
    await assert.rejects(
      () => commit(choose((r) => (r === R.apr1 ? link(r) : undefined))),
      /ACCT_GUSTO_GROUP_CHOICE/,
    );
    await assert.rejects(
      () => commit(choose((r) => (r === R.may1 ? correct(r) : undefined))),
      /ACCT_GUSTO_CHANGED/,
      "an exact match is linked, not corrected",
    );
    await assert.rejects(
      () => commit(choose((r) => (r === R.may1 ? "new" : undefined))),
      /ACCT_GUSTO_CHANGED/,
      "a matched run cannot be recorded twice",
    );
    await assert.rejects(
      () =>
        commit(
          choose((r) => (r === R.aug1 ? "new" : undefined)),
          { ...base, content_hash: "d".repeat(64) },
        ),
      /DOCUMENT_UNAVAILABLE/,
    );
    checks += 4;

    const imported = await commit(
      choose((r) => {
        if (r === R.mar) return correct(r); // move the journal to the Gusto pay date
        if (r === R.jul1 || r === R.jul2) return correct(r); // correct the pennies to Gusto
        if (r === R.aug1 || r === R.aug2) return "new";
        return link(r); // match, group, and keep the June pennies
      }),
    );
    const result = new Map(imported.map((r) => [r.key, r]));
    const done = (r: Run) => result.get(items[YEAR.indexOf(r)].key)!;
    ok(
      imported.every((r) => r.run_id && r.entry_id),
      "every run is imported and linked",
    );
    eq(done(R.apr1).entry_id, books.apr);
    eq(done(R.apr2).entry_id, books.apr);
    eq(done(R.jun1).entry_id, books.jun);
    eq(done(R.may1).entry_id, books.may1);
    ok(
      done(R.jul1).entry_id !== books.jul &&
        done(R.jul1).entry_id === done(R.jul2).entry_id,
      "the corrected July journal is a new entry both runs share",
    );
    ok(done(R.mar).entry_id !== books.mar);
    eq((await entryDetail(done(R.mar).entry_id!)).entry_date, "2023-03-31");
    ok(done(R.aug1).entry_id !== done(R.aug2).entry_id);
    const july = await entryDetail(done(R.jul1).entry_id!);
    const sumOn = (
      lines: { account_id: string; amount_cents: string }[],
      account: string,
    ) =>
      lines
        .filter((l) => l.account_id === account)
        .reduce((t, l) => t + Number(l.amount_cents), 0);
    eq(
      sumOn(july.lines, mapping.wages),
      totals([R.jul1, R.jul2]).wages,
      "July now holds Gusto's wages",
    );
    eq(
      july.entry_date,
      "2023-07-31",
      "a corrected amount keeps the journal date",
    );
    eq((await entryDetail(books.jul)).status, "posted");
    ok(
      !!(await inspect<{ id: string } | null>(
        "SELECT to_jsonb(e) r FROM accounting.journal_entries e WHERE e.reverses_entry_id=$1",
        [books.jul],
      )),
      "the old July journal is reversed",
    );
    const aprilEntry = await entryDetail(books.apr);
    eq(
      aprilEntry.payroll_run_ids.sort(),
      [done(R.apr1).run_id, done(R.apr2).run_id].sort(),
    );
    eq(aprilEntry.payroll_run_id, done(R.apr1).run_id);
    const june = await runDetail(done(R.jun1).run_id!);
    eq(
      [june.provider, june.entry_shared, june.import_mode, june.status],
      ["gusto", true, "linked", "posted"],
    );
    const juneMeta = june.register.body.ytd.gusto_import;
    eq(
      [
        juneMeta.link_state,
        juneMeta.resolution,
        (juneMeta.difference as unknown[]).length,
      ],
      ["difference", "kept_books", 2],
    );
    eq(juneMeta.payroll_ids, ["payrolls_r06"]);
    eq(juneMeta.document_id, file.document_id);
    const may = await runDetail(done(R.may1).run_id!);
    eq(
      [may.entry_shared, may.register.body.ytd.gusto_import.link_state],
      [false, "match"],
    );
    const run_employees = (
      await inspect<{
        ytd: {
          run_employees: {
            social_security_wages_cents: string;
            medicare_wages_cents: string;
          }[];
        };
      }>("SELECT to_jsonb(p) r FROM accounting.payroll_runs p WHERE id=$1", [
        done(R.apr1).run_id,
      ])
    ).ytd.run_employees;
    eq(run_employees.map((e) => e.social_security_wages_cents).sort(), [
      "150000",
      "291667",
    ]);
    eq(run_employees.map((e) => e.medicare_wages_cents).sort(), [
      "150000",
      "291667",
    ]);
    eq(
      (
        await inspect<{ n: number }>(
          "SELECT jsonb_build_object('n',count(*)) r FROM accounting.document_links WHERE document_id=$1 AND payroll_run_id IS NOT NULL",
          [file.document_id],
        )
      ).n,
      11,
    );

    // Importing the same export again changes nothing.
    eq(
      (await call({ ...base, mode: "preview" })).map((r) => r.state),
      Array(11).fill("duplicate"),
    );
    eq(
      (await commit(choose(() => "new"))).every((r) => r.state === "duplicate"),
      true,
    );
    // An export whose figures changed for an imported payroll is a conflict, never a duplicate.
    const changed = gustoItems(
      parseGusto(
        exportOf([
          { ...R.aug1, pays: [pay(ALEX, 216667, { futa: 0, fit: 30000 })] },
        ]),
      ),
      mapping,
    );
    eq(
      (await call({ ...base, mode: "preview", items: changed }))[0].state,
      "conflict",
    );
    await assert.rejects(
      () =>
        call({
          ...base,
          mode: "commit",
          items: changed.map((i) => ({ ...i, choice: "new" })),
        }),
      /ACCT_GUSTO_CHANGED/,
    );
    checks++;

    // The payroll register: every run once, the year ties to the books where the books agree with Gusto.
    const register = (from: string, to: string) =>
      read<SupportReportData>("SELECT accounting.support_report($1) r", [
        JSON.stringify({ report_id: "payroll-register", from, to, offset: 0 }),
      ]);
    const year = (through: string) =>
      read<PayrollYearRead>("SELECT accounting.payroll($1) r", [
        JSON.stringify({ year: 2023, through }),
      ]);
    const pl = (from: string, to: string) =>
      read<ReportData>("SELECT accounting.report('summary',$1) r", [
        JSON.stringify({ from, to, mode: "posted", offset: 0 }),
      ]);
    const all = await register("2023-01-01", "2023-12-31");
    eq(all.count, 11);
    eq(
      all.total_cells[2],
      String(YEAR.reduce((t, r) => t + totals([r]).wages, 0)),
    );
    const ties = (from: string, to: string) =>
      Promise.all([register(from, to), year(to), pl(from, to)]).then(
        ([data, y, b]) => payrollTies(registerRuns(data), y, b),
      );
    const spring = await ties("2023-04-01", "2023-05-31");
    eq(
      spring.filter((t) => t.tone !== "good").map((t) => t.key),
      [],
      "a linked group ties to its journal",
    );
    eq(spring.filter((t) => t.key.startsWith("acct-")).length, 2);
    const whole = await ties("2023-01-01", "2023-12-31");
    eq(
      whole
        .filter((t) => t.tone === "look")
        .map((t) => t.title)
        .sort(),
      [
        "Payroll Employer Taxes differs by $0.01",
        "Payroll Salary and Wages differs by $0.01",
      ],
      "the kept June penny shows on the register",
    );

    // A journal several runs share is never reversed: void and delete refuse it.
    await assert.rejects(
      async () =>
        command({
          type: "payroll.void",
          id: done(R.apr1).run_id,
          expected_version: (await runDetail(done(R.apr1).run_id!)).version,
          effective_date: "2023-09-01",
          reason: "Synthetic void",
        }),
      /ACCT_PAYROLL_ENTRY_SHARED/,
    );
    await assert.rejects(
      async () =>
        command({
          type: "entry.reverse",
          id: books.apr,
          expected_version: (await entryDetail(books.apr)).version,
          entry_date: "2023-09-01",
          reason: "Synthetic delete",
        }),
      /ACCT_PAYROLL_ENTRY_SHARED/,
    );
    checks += 2;
    // A single linked run still voids as before.
    const voided = await command({
      type: "payroll.void",
      id: done(R.may1).run_id,
      expected_version: may.version,
      effective_date: "2023-09-01",
      reason: "Synthetic void",
    });
    eq((await runDetail(voided.id)).status, "voided");

    // Undo of a linked group: both runs come off, the journal stays, and it can be linked again.
    const undone = await read<{ run_ids: string[]; journal_mode: string }>(
      "SELECT accounting.operate($1) r",
      [
        JSON.stringify({
          key: randomUUID(),
          command: {
            type: "payroll.import.undo",
            id: done(R.apr1).run_id,
            expected_version: (await runDetail(done(R.apr1).run_id!)).version,
            effective_date: "2023-09-01",
            reason: "Synthetic undo",
          },
        }),
      ],
    );
    eq(undone.journal_mode, "linked");
    eq(
      undone.run_ids.sort(),
      [done(R.apr1).run_id, done(R.apr2).run_id].sort(),
    );
    const after = await entryDetail(books.apr);
    eq([after.status, after.payroll_run_ids], ["posted", []]);
    eq(
      await inspect<boolean>(
        "SELECT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=$1) r",
        [books.apr],
      ),
      false,
    );
    const apr2 = await runDetail(done(R.apr2).run_id!);
    eq([apr2.status, apr2.import_undone], ["voided", true]);
    const again = await call({ ...base, mode: "preview" });
    eq(
      again
        .filter((r) => r.key === items[1].key || r.key === items[2].key)
        .map((r) => r.state),
      ["group_match", "group_match"],
    );
    eq(again.find((r) => r.key === items[1].key)?.entry?.id, books.apr);
    // Undo of a run the import recorded reverses its journal.
    const aug = await runDetail(done(R.aug1).run_id!);
    eq(aug.import_mode, "created");
    await command({
      type: "payroll.import.undo",
      id: aug.id,
      expected_version: aug.version,
      effective_date: "2023-09-01",
      reason: "Synthetic undo",
    });
    eq(
      await inspect<boolean>(
        "SELECT EXISTS(SELECT 1 FROM accounting.journal_entries WHERE reverses_entry_id=$1 AND status='posted') r",
        [done(R.aug1).entry_id],
      ),
      true,
    );
    // ...and that journal cannot be restored around the payroll workflow.
    await assert.rejects(
      async () =>
        command({
          type: "entry.restore",
          id: done(R.aug1).entry_id,
          expected_version: (await entryDetail(done(R.aug1).entry_id!)).version,
          entry_date: "2023-09-02",
          reason: "Synthetic restore",
        }),
      /ACCT_RESTORE_WORKFLOW/,
    );
    checks++;

    // Gusto fees and refunds in the books, moved in the same import.
    const ids = await inspect<Record<string, string>>(
      "SELECT jsonb_object_agg(name,id) r FROM accounting.accounts WHERE name IN ('Business checking','Software')",
    );
    const checking = ids["Business checking"],
      software = ids["Software"];
    await db.exec("RESET ROLE");
    const payrollFees = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.accounts(name,type,subtype,system_purpose) VALUES('Payroll fees','expense','operating_expense','payroll_fees') RETURNING id",
      )
    ).rows[0].id;
    await db.exec("SET ROLE authenticated");
    const book = async (
      date: string,
      memo: string,
      lines: [string, number][],
    ) => {
      const draft = await command({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo,
        lines: lines.map(([account_id, cents]) => ({
          account_id,
          amount_cents: String(cents),
        })),
      });
      return (
        await command({
          type: "entry.post",
          id: draft.id,
          expected_version: draft.version,
        })
      ).id;
    };
    const feeEntry = await book("2023-04-05", "Gusto", [
      [software, 4964],
      [checking, -4964],
    ]);
    const taxRefund = await book("2023-04-08", "Gusto", [
      [checking, 490],
      [software, -490],
    ]);
    const feeRefund = await book("2023-06-10", "GUSTO REFUND", [
      [checking, 40],
      [software, -40],
    ]);
    const lockedFee = await book("2023-09-05", "Gusto", [
      [software, 5935],
      [checking, -5935],
    ]);
    const reconciledFee = await book("2023-11-03", "Gusto", [
      [software, 5962],
      [checking, -5962],
    ]);
    // Never listed: already on Payroll fees, not Gusto, three lines, and payroll payments (the 2023-08-15 withdrawal above).
    await book("2023-05-05", "Gusto", [
      [payrollFees, 4964],
      [checking, -4964],
    ]);
    await book("2023-05-06", "Adobe", [
      [software, 2000],
      [checking, -2000],
    ]);
    await book("2023-05-07", "Gusto", [
      [software, 3000],
      [ids["Software"], 1000],
      [checking, -4000],
    ]);
    // The fee withdrawal is matched to its bank transaction; the match must survive the move.
    await db.exec("RESET ROLE");
    const bankAccount = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.bank_accounts(account_id) VALUES($1) RETURNING id",
        [checking],
      )
    ).rows[0].id;
    const observation = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.bank_transactions(bank_account_id,source,external_id,posted_date,amount_cents,description,content_hash,raw_payload,state) VALUES($1,'simplefin','gusto-fee','2023-04-05',-4964,'GUSTO FEE',$2,'{}','posted') RETURNING id",
        [bankAccount, "e".repeat(64)],
      )
    ).rows[0].id;
    await db.exec("SET ROLE authenticated");
    const feeDetail = await entryDetail(feeEntry);
    await command({
      type: "bank.match",
      id: randomUUID(),
      bank_transaction_id: observation,
      allocations: [
        {
          line_id: (
            feeDetail as unknown as {
              lines: { id: string; account_id: string }[];
            }
          ).lines.find((l) => l.account_id === checking)!.id,
          amount_cents: "4964",
        },
      ],
      reason: "Fixture match",
    });
    // A bank reconciliation holds the November fee.
    await db.exec("RESET ROLE");
    const reconciliation = (
      await db.query<{ id: string }>(
        "INSERT INTO accounting.reconciliations(bank_account_id,statement_start,statement_end,opening_balance_cents,ending_balance_cents,difference_cents) VALUES($1,'2023-11-01','2023-11-30',0,0,0) RETURNING id",
        [bankAccount],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO accounting.reconciliation_items(reconciliation_id,journal_line_id,amount_cents) SELECT $1,id,amount_cents FROM accounting.journal_lines WHERE entry_id=$2 AND account_id=$3",
      [reconciliation, reconciledFee, checking],
    );
    await db.exec("SET ROLE authenticated");

    type FeeRow = {
      id: string;
      version: number;
      kind: string;
      to_account_id: string | null;
      from_account_id: string;
      amount_cents: string;
      blocked: string | null;
    };
    const credits = [
      { check_date: "2023-03-31", name: "ZZ Unemployment Tax", amount: "-490" },
    ];
    const feeRequest = {
      mapping,
      fee_account: payrollFees,
      years: [2023],
      credits,
    };
    const listFees = (request: object = feeRequest) =>
      read<FeeRow[]>("SELECT accounting.gusto_fees($1) r", [
        JSON.stringify(request),
      ]);
    const listed = await listFees();
    eq(
      listed.map((r) => [r.id, r.kind, r.to_account_id, r.blocked]),
      [
        [feeEntry, "fee", payrollFees, null],
        [taxRefund, "tax_refund", mapping.employer_tax, null],
        [feeRefund, "fee_refund", payrollFees, null],
        [lockedFee, "fee", payrollFees, null],
        [reconciledFee, "fee", payrollFees, "Part of a bank reconciliation."],
      ],
      "fees, a matched tax refund and a fee refund; payroll payments and settled entries are not listed",
    );
    eq(listed[0].from_account_id, software);
    eq(listed[0].amount_cents, "-4964");
    // A deposit more than 45 days after the credit is a fee refund, not a tax refund.
    eq(
      (
        await listFees({
          ...feeRequest,
          credits: [{ ...credits[0], check_date: "2023-02-01" }],
        })
      ).find((r) => r.id === taxRefund)?.kind,
      "fee_refund",
    );
    // Without a fees account, fees wait; the tax refund can still move.
    eq(
      (await listFees({ ...feeRequest, fee_account: null }))
        .map((r) => [r.kind, r.blocked])
        .slice(0, 2),
      [
        ["fee", "Choose a payroll fees account first."],
        ["tax_refund", null],
      ],
    );
    eq(
      ((await call({ mode: "defaults" })) as unknown as { fee_account: string })
        .fee_account,
      payrollFees,
      "defaults name the payroll fees account",
    );
    // The file's payrolls are imported (or skipped); a commit can carry only the fee moves.
    const pick = (rows: FeeRow[], wanted: string[]) =>
      rows
        .filter((r) => wanted.includes(r.id))
        .map((r) => ({ id: r.id, version: r.version }));
    const feeCommit = (selected: { id: string; version: number }[]) =>
      call({
        ...base,
        mode: "commit",
        items: gustoItems(report, mapping),
        fees: { fee_account: payrollFees, years: [2023], credits, selected },
      });
    await assert.rejects(
      () => feeCommit(pick(listed, [reconciledFee])),
      /ACCT_GUSTO_CHANGED/,
    );
    await assert.rejects(
      () => feeCommit([{ id: feeEntry, version: listed[0].version + 1 }]),
      /ACCT_GUSTO_CHANGED/,
    );
    checks += 2;
    const runsBefore = await inspect<number>(
      "SELECT count(*)::integer r FROM accounting.payroll_runs",
    );
    await feeCommit(pick(listed, [feeEntry, taxRefund, feeRefund]));
    eq(
      await inspect<number>(
        "SELECT count(*)::integer r FROM accounting.payroll_runs",
      ),
      runsBefore,
      "a fees-only commit adds no payroll",
    );
    const moved = await inspect<
      {
        id: string;
        entry_date: string;
        lines: [string, number][];
        matches: number;
      }[]
    >(
      `SELECT jsonb_agg(jsonb_build_object('id',e.id,'entry_date',e.entry_date,
        'lines',(SELECT jsonb_agg(jsonb_build_array(l.account_id,l.amount_cents) ORDER BY l.sort_order) FROM accounting.journal_lines l WHERE l.entry_id=e.id),
        'matches',(SELECT count(*) FROM accounting.bank_matches m JOIN accounting.journal_lines l ON l.id=m.journal_line_id WHERE l.entry_id=e.id)) ORDER BY e.entry_date) r
       FROM accounting.journal_entries e WHERE e.replaces_entry_id = ANY($1::uuid[]) AND e.status='posted'`,
      [`{${feeEntry},${taxRefund},${feeRefund}}`],
    );
    eq(
      moved.map((m) => [m.entry_date, m.lines]),
      [
        [
          "2023-04-05",
          [
            [payrollFees, 4964],
            [checking, -4964],
          ],
        ],
        [
          "2023-04-08",
          [
            [checking, 490],
            [mapping.employer_tax, -490],
          ],
        ],
        [
          "2023-06-10",
          [
            [checking, 40],
            [payrollFees, -40],
          ],
        ],
      ],
      "same date and bank line; only the category moves",
    );
    eq(moved[0].matches, 1, "the bank match follows the moved fee");
    eq(
      (await listFees()).map((r) => r.id),
      [lockedFee, reconciledFee],
      "moved entries are not offered again",
    );

    // A fees-only export (no payroll rows at all): no items, years from its file name.
    const decemberFee = await book("2023-12-04", "Gusto", [
      [software, 5962],
      [checking, -5962],
    ]);
    const emptyName = gustoName("2023-01-01", "2023-12-31");
    const emptyDoc = randomUUID();
    const prepared = await command({
      type: "document.prepare",
      id: emptyDoc,
      original_name: emptyName,
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size_bytes: "1500",
      content_hash: "f".repeat(64),
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [prepared.storage_path],
    );
    await command({
      type: "document.complete",
      id: emptyDoc,
      expected_version: prepared.version,
    });
    // The commit re-reads the stored file: its kept name gives the same years as the upload did.
    const stored = await read<{ documents: { original_name: string }[] }>(
      "SELECT accounting.documents($1) r",
      [JSON.stringify({ id: emptyDoc })],
    );
    const storedName =
      stored.documents.find((d) => d.original_name === emptyName)
        ?.original_name ?? "";
    const emptyYears = gustoYears(empty, gustoFileRange(storedName));
    eq(emptyYears, [2023], "the stored evidence keeps the name and its range");
    const emptyFees = await listFees({
      ...feeRequest,
      years: emptyYears,
      credits: [],
    });
    const december = emptyFees.find((r) => r.id === decemberFee)!;
    eq([december.kind, december.blocked], ["fee", null]);
    eq(
      await call({
        mapping,
        mode: "preview",
        document_id: emptyDoc,
        content_hash: "f".repeat(64),
        items: [],
      }),
      [],
      "a file with no payrolls previews no runs",
    );
    await call({
      mapping,
      mode: "commit",
      document_id: emptyDoc,
      content_hash: "f".repeat(64),
      items: [],
      fees: {
        fee_account: payrollFees,
        years: emptyYears,
        credits: [],
        selected: [{ id: december.id, version: december.version }],
      },
    });
    eq(
      (await listFees()).some((r) => r.id === decemberFee),
      false,
      "a fees-only file moves its fees",
    );
    eq(
      ((await call({ mode: "defaults" })) as unknown as { first_year: number })
        .first_year,
      2023,
      "defaults name the books' first year",
    );

    // A partial month: one run of a month the books hold as one journal is a conflict, not new wages.
    const sep = [
      run("payrolls_r12", "2023-09-15", "2023-09-01", "2023-09-15", [
        pay(ALEX, 216667, { futa: 0 }),
      ]),
      run("payrolls_r13", "2023-09-29", "2023-09-16", "2023-09-30", [
        pay(ALEX, 216667, { futa: 0 }),
      ]),
    ];
    await journal("2023-09-30", "Payroll for 9/15 & 9/30", totals(sep));
    const partial = await call({
      ...base,
      mode: "preview",
      items: gustoItems(parseGusto(exportOf([sep[0]])), mapping),
    });
    eq(partial[0].state, "conflict");
    ok(/Include the whole month/.test(partial[0].message));
    eq(
      (
        await call({
          ...base,
          mode: "preview",
          items: gustoItems(parseGusto(exportOf(sep)), mapping),
        })
      ).map((r) => r.state),
      ["group_match", "group_match"],
    );

    // A locked month is a conflict.
    await db.exec("RESET ROLE");
    await db.exec(
      "INSERT INTO accounting.periods(month,status,locked_at) VALUES('2023-10-01','locked',now())",
    );
    await db.exec("SET ROLE authenticated");
    const october = gustoItems(
      parseGusto(
        exportOf([
          run("payrolls_r14", "2023-10-13", "2023-10-01", "2023-10-15", [
            pay(ALEX, 216667, { futa: 0 }),
          ]),
        ]),
      ),
      mapping,
    );
    eq(
      (await call({ ...base, mode: "preview", items: october }))[0].state,
      "conflict",
    );
    eq(
      (await listFees()).find((r) => r.id === lockedFee)?.blocked,
      "This month is locked.",
      "a fee in a locked month is shown but cannot move",
    );

    // Defaults remember the Gusto mapping; nothing is reachable without the owner role.
    eq(
      (
        (await call({ mode: "defaults" })) as unknown as {
          mapping: GustoMapping;
        }
      ).mapping,
      mapping,
    );
    await db.exec("SET ROLE anon");
    await assert.rejects(() => call({ mode: "defaults" }), /permission denied/);
    await db.exec("SET ROLE authenticated");
    checks++;

    for (const path of process.argv.slice(2)) {
      const local = parseGusto(new Uint8Array(await readFile(path)));
      gustoItems(local, { ...mapping, officers: local.employees });
      console.log(
        `Local export: ${local.runs.length} payrolls parsed and balanced (${local.from} to ${local.to}).`,
      );
    }
    console.log(
      `Gusto checks passed (${checks}): workbook reader, parser refusals, match, date match with date correction, group match, penny differences kept and corrected, new, duplicate, conflict, group choices, shared-entry void and delete refused, undo of linked groups and recorded runs, partial-month and locked-month conflicts, register ties, and moving Gusto fees and refunds.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error.message, error.where ?? "", error.internalQuery ?? "");
  process.exitCode = 1;
});
