import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  toEstimatorDollars,
  fromEstimatorDollars,
  projectBusinessIncome,
  businessForecastSchema,
  type BusinessForecast,
} from "../src/lib/accounting/tax-projection";
import type { TaxSource } from "../src/lib/accounting/tax-workpapers";
let checks = 0;
function check(a: unknown, b: unknown) {
  assert.deepEqual(a, b);
  checks++;
}
function fail(fn: () => unknown, message: RegExp) {
  assert.throws(fn, message);
  checks++;
}
const source = {
  year: 2026,
  through: "2026-03-15",
  year_settings: { current: true, classification: "s_corp" },
  unmapped_accounts: 0,
  unavailable_adjustments: 0,
  incomplete_imports: 0,
  drafts: 0,
  adjusted_ordinary_cents: "600000",
  monthly: [
    { month: "2026-01-01", ordinary_cents: "1000000", complete: true },
    { month: "2026-02-01", ordinary_cents: "800000", complete: true },
    { month: "2026-03-01", ordinary_cents: "-1200000", complete: false },
  ],
} as TaxSource;
const noEvidence = { prior: null, exclusions: [] };
const average: BusinessForecast = {
  method: "average",
  months: ["2026-01-01", "2026-02-01"],
  current_month_remaining_cents: "50000",
  exclusions: [],
};
const value = projectBusinessIncome(source, average, noEvidence);
check(value.actual_cents, "600000");
check(value.remaining_cents, "8150000");
check(value.annual_cents, "8750000");
check(value.base_cents, "900000");
check(value.remaining_full_months, 9);
const id = randomUUID(),
  excluded = projectBusinessIncome(
    source,
    { ...average, exclusions: [{ entry_id: id, reason: "One-time contract" }] },
    {
      prior: null,
      exclusions: [
        { entry_id: id, entry_date: "2026-01-10", ordinary_cents: "200000" },
      ],
    },
  );
check(excluded.actual_cents, "600000");
check(excluded.annual_cents, "7850000");
check(excluded.excluded_cents, "200000");
check(
  projectBusinessIncome(
    source,
    { method: "manual", remaining_cents: "-700000" },
    noEvidence,
  ).annual_cents,
  "-100000",
);
check(
  projectBusinessIncome(
    { ...source, through: "2026-12-31" },
    { method: "manual", remaining_cents: "0" },
    noEvidence,
  ).annual_cents,
  "600000",
);
fail(
  () =>
    projectBusinessIncome(
      { ...source, through: "2026-12-31" },
      { method: "manual", remaining_cents: "1" },
      noEvidence,
    ),
  /completed tax year/,
);
fail(
  () =>
    projectBusinessIncome(
      { ...source, through: "2026-03-31" },
      average,
      noEvidence,
    ),
  /month-end/,
);
fail(
  () =>
    projectBusinessIncome(
      source,
      { ...average, months: ["2026-03-01"] },
      noEvidence,
    ),
  /closed complete months/,
);
fail(
  () =>
    projectBusinessIncome(
      source,
      { ...average, months: ["2026-01-01", "2026-01-01"] },
      noEvidence,
    ),
  /only once/,
);
fail(
  () =>
    projectBusinessIncome(
      { ...source, unmapped_accounts: 1 },
      average,
      noEvidence,
    ),
  /mappings/,
);
fail(
  () =>
    projectBusinessIncome(
      { ...source, incomplete_imports: 1 },
      average,
      noEvidence,
    ),
  /imports/,
);
fail(
  () =>
    projectBusinessIncome(
      { ...source, unavailable_adjustments: 1 },
      average,
      noEvidence,
    ),
  /evidence/,
);
fail(
  () =>
    projectBusinessIncome(
      { ...source, year_settings: null },
      average,
      noEvidence,
    ),
  /classification/,
);
fail(
  () =>
    projectBusinessIncome(
      source,
      { ...average, exclusions: [{ entry_id: id, reason: "One-off" }] },
      noEvidence,
    ),
  /Each one-off/,
);
fail(
  () =>
    projectBusinessIncome(
      source,
      {
        ...average,
        exclusions: [
          { entry_id: id, reason: "One-off" },
          { entry_id: id, reason: "Repeated" },
        ],
      },
      {
        prior: null,
        exclusions: [
          { entry_id: id, entry_date: "2026-01-10", ordinary_cents: "200000" },
        ],
      },
    ),
  /only once/,
);
check(
  projectBusinessIncome(
    { ...source, drafts: 2 },
    average,
    noEvidence,
  ).notes.some((n) => n.includes("2 draft")),
  true,
);
const prior = {
  ...source,
  year: 2025,
  through: "2025-12-31",
  monthly: Array.from({ length: 12 }, (_, i) => ({
    month: `2025-${String(i + 1).padStart(2, "0")}-01`,
    ordinary_cents: String((i + 1) * 10000),
    book_cents: "0",
    complete: true,
  })),
};
const pattern: BusinessForecast = {
  method: "prior_pattern",
  current_month_remaining_cents: "50000",
  exclusions: [],
};
const patterned = projectBusinessIncome(source, pattern, {
  prior,
  exclusions: [],
});
check(patterned.remaining_cents, "770000");
check(patterned.annual_cents, "1370000");
check(patterned.selected_months.length, 9);
fail(() => projectBusinessIncome(source, pattern, noEvidence), /prior-year/);
fail(
  () =>
    projectBusinessIncome(source, pattern, {
      prior: {
        ...prior,
        year_settings: { ...prior.year_settings!, classification: "sole_prop" },
      },
      exclusions: [],
    }),
  /same reviewed/,
);
fail(
  () =>
    projectBusinessIncome(source, pattern, {
      prior: {
        ...prior,
        monthly: prior.monthly.map((m) => ({ ...m, complete: false })),
      },
      exclusions: [],
    }),
  /closed complete/,
);
const odd = {
  ...source,
  through: "2026-09-30",
  monthly: [
    {
      month: "2026-01-01",
      ordinary_cents: "1",
      book_cents: "0",
      complete: true,
    },
    {
      month: "2026-02-01",
      ordinary_cents: "0",
      book_cents: "0",
      complete: true,
    },
  ],
};
check(
  projectBusinessIncome(
    odd,
    { ...average, current_month_remaining_cents: "0" },
    noEvidence,
  ).remaining_cents,
  "2",
);
check(
  projectBusinessIncome(
    {
      ...odd,
      monthly: odd.monthly.map((m) => ({
        ...m,
        ordinary_cents: m.month.includes("01-01") ? "-1" : "0",
      })),
    },
    { ...average, current_month_remaining_cents: "0" },
    noEvidence,
  ).remaining_cents,
  "-2",
);
for (const cents of [
  "0",
  "1",
  "-1",
  "101",
  "-101",
  "999999999999",
  "1000000000000",
  "-1000000000000",
]) {
  check(fromEstimatorDollars(toEstimatorDollars(cents)), cents);
}
for (const cents of ["1.2", "1e3", "01", "1000000000001", "-1000000000001"]) {
  fail(() => toEstimatorDollars(cents), /Invalid|range/);
}
fail(() => fromEstimatorDollars(Infinity), /invalid/);
fail(() => fromEstimatorDollars(NaN), /invalid/);
fail(() => fromEstimatorDollars(10000000001), /range/);
check(fromEstimatorDollars(-1.005), "-101");
check(fromEstimatorDollars(1.005), "101");
check(businessForecastSchema.safeParse({ method: "manual" }).success, false);
check(fromEstimatorDollars(10.075), "1008");
check(fromEstimatorDollars(-10.075), "-1008");
check(fromEstimatorDollars(1e-7), "0");
check(fromEstimatorDollars(999.995), "100000");
console.log(`Accounting tax projections: ${checks} assertions passed.`);
