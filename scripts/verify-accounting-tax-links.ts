import assert from "node:assert/strict";
import {
  buildTaxOverlay,
  applyTaxOverlay,
  validateTaxTargets,
  type TaxLinkInputs,
  type TaxLinkBody,
} from "../src/lib/accounting/tax-links";
import type { TaxEstimate } from "../src/types/database";
import type { TaxSource } from "../src/lib/accounting/tax-workpapers";
import type { PayrollYear } from "../src/lib/accounting/payroll";
let checks = 0;
const check = (a: unknown, b: unknown) => {
  assert.deepEqual(a, b);
  checks++;
};
const fails = (f: () => unknown, r: RegExp) => {
  assert.throws(f, r);
  checks++;
};
const estimate = {
  tax_year: 2026,
  tax_classification: "s_corp",
  state: "AZ",
  income_sources: [
    {
      id: "business",
      name: "Company",
      amount: 11000,
      income_type: "k1",
      subject_to_se: false,
    },
    {
      id: "wages",
      name: "Owner wages",
      amount: 25000,
      income_type: "w2",
      subject_to_se: false,
    },
    {
      id: "spouse",
      name: "Spouse",
      amount: 70000,
      income_type: "w2",
      subject_to_se: false,
      taxpayer: "spouse",
    },
    {
      id: "interest",
      name: "Interest",
      amount: 100,
      income_type: "1099",
      subject_to_se: false,
    },
  ],
  capital_gains: [
    { id: "gain", description: "Stock", term: "long", amount: 800 },
  ],
  payments: [
    {
      id: "federal",
      type: "federal",
      category: "withholding",
      label: "Wages",
      linked_income_id: "wages",
      amount: 3000,
      paid_on: "2026-01-01",
    },
    {
      id: "state",
      type: "state",
      category: "withholding",
      label: "Wages",
      linked_income_id: "wages",
      amount: 500,
    },
    {
      id: "manual",
      type: "federal",
      category: "payment",
      label: "Estimate",
      amount: 200,
    },
  ],
} as TaxEstimate;
const body: TaxLinkBody = {
  cutoff_mode: "fixed",
  through: "2026-08-31",
  business_target_id: "business",
  forecast: { method: "manual", remaining_cents: "100000" },
  separate_targets: [],
  manual_separate_review: null,
  payroll: {
    employee_key: "owner",
    income_target_id: "wages",
    federal_payment_id: "federal",
    state_payment_id: "state",
    state_code: "AZ",
    remaining: {
      federal_taxable_cents: "100000",
      social_security_wages_cents: "110000",
      medicare_wages_cents: "110000",
      state_taxable_cents: "105000",
      federal_withheld_cents: "10000",
      state_withheld_cents: "1000",
    },
  },
};
const input: TaxLinkInputs = {
  link: { id: "link", version: 1, body },
  estimate,
  forecast_evidence: { prior: null, exclusions: [] },
  manual_review_document_available: false,
  after_cutoff_count: 0,
  source: {
    year: 2026,
    through: "2026-08-31",
    year_settings: {
      current: true,
      classification: "s_corp",
      id: "synthetic-profile",
      tax_year: 2026,
      version: 1,
      document_id: null,
      reason: "Profile classification",
      created_at: "2026-01-01T00:00:00Z",
      created_by: "synthetic-owner",
    },
    revision: "1",
    fingerprint: "synthetic",
    accounts: [],
    adjustments: [],
    basis: null,
    book_profit_cents: "400000",
    mapped_ordinary_cents: "400000",
    book_to_tax_cents: "0",
    unmapped_accounts: 0,
    unavailable_adjustments: 0,
    incomplete_imports: 0,
    drafts: 0,
    adjusted_ordinary_cents: "400000",
    separately_stated: {},
    monthly: [],
  } satisfies TaxSource,
  payroll: {
    coverage: {
      current: true,
      through_date: "2026-08-31",
      document_id: "evidence",
      employees: [
        {
          key: "owner",
          federal_taxable_cents: "900000",
          social_security_wages_cents: "950000",
          medicare_wages_cents: "970000",
          state_taxable_cents: "910000",
          federal_withheld_cents: "50000",
          state_withheld_cents: "5000",
        },
      ],
    },
  } as PayrollYear,
};
const original = structuredClone(input),
  calculation = buildTaxOverlay(input),
  copy = applyTaxOverlay(estimate, calculation.overlay, "link");
check(calculation.issues, []);
check(calculation.source_period.from, "2026-01-01");
check(copy.income_sources[0].amount, 5000);
check(copy.income_sources[1].amount, 10000);
check(copy.income_sources[1].wage_bases, {
  social_security: 10600,
  medicare: 10800,
  state: 10150,
  state_code: "AZ",
});
check(copy.income_sources[2], estimate.income_sources[2]);
check(copy.capital_gains, estimate.capital_gains);
check(copy.payments.find((r) => r.id === "federal")?.amount, 500);
check(copy.payments.find((r) => r.id === "federal")?.paid_on, undefined);
check(
  copy.payments.find((r) => r.id === "federal")?.verified_through,
  "2026-08-31",
);
check(
  copy.payments.find((r) => r.id === "manual"),
  estimate.payments[2],
);
check(
  copy.payments.filter((r) => r.timing === "forecast").map((r) => r.amount),
  [100, 10],
);
check(input, original);
const broken = structuredClone(input);
broken.source.unmapped_accounts = 1;
check(
  buildTaxOverlay(broken).overlay.income.map((r) => r.id),
  ["wages"],
);
check(buildTaxOverlay(broken).issues[0].key, "business");
broken.source.unmapped_accounts = 0;
broken.payroll!.coverage!.employees[0].social_security_wages_cents = null;
check(
  buildTaxOverlay(broken).overlay.income.map((r) => r.id),
  ["business"],
);
check(buildTaxOverlay(broken).overlay.payments.length, 2);
broken.payroll!.coverage!.current = false;
check(buildTaxOverlay(broken).overlay.payments, []);
const negative = structuredClone(input);
negative.source.adjusted_ordinary_cents = "-900000";
check(
  buildTaxOverlay(negative).overlay.income.map((r) => r.id),
  ["wages"],
);
negative.source.basis = {
  id: "synthetic",
  tax_year: 2026,
  version: 1,
  document_id: null,
  reason: "Synthetic basis case",
  created_at: "2026-01-01T00:00:00Z",
  created_by: "synthetic",
  through_date: "2026-08-31",
  source_fingerprint: "synthetic",
  current: true,
  body: {
    opening_stock_cents: "100000",
    opening_debt_cents: "0",
    allowed_loss_cents: "250000",
    ending_stock_cents: null,
    ending_debt_cents: null,
    distribution_reviewed: false,
    limitations: "",
  },
} satisfies TaxSource["basis"];
check(buildTaxOverlay(negative).overlay.income[0].amount_cents, "-250000");
check(buildTaxOverlay(negative).issues[0].key, "loss-limit");
negative.source.basis!.body.opening_debt_cents = null;
check(
  buildTaxOverlay(negative).overlay.income.map((r) => r.id),
  ["wages"],
);
const separate = structuredClone(input);
separate.source.separately_stated.interest = "10001";
check(buildTaxOverlay(separate).issues[0].key, "separate-interest");
separate.link.body.separate_targets = [
  { concept: "interest", target_id: "interest", remaining_cents: "999" },
];
check(
  buildTaxOverlay(separate).overlay.income.find((r) => r.id === "interest")
    ?.amount_cents,
  "11000",
);
separate.source.separately_stated.charity = "-10000";
check(buildTaxOverlay(separate).issues[0].key, "manual-separate");
separate.link.body.manual_separate_review = {
  charity_cents: "-10000",
  tax_exempt_cents: "0",
  document_id: "10000000-0000-4000-8000-000000000001",
  reason: "Reviewed outside estimator",
};
separate.manual_review_document_available = true;
check(buildTaxOverlay(separate).issues[0].key, "manual-separate-reviewed");
const changed = structuredClone(estimate);
changed.income_sources[0].income_type = "w2";
fails(() => validateTaxTargets(changed, body), /correct income type/);
changed.income_sources = structuredClone(estimate.income_sources);
changed.income_sources[0].linked_source_id = "personal";
fails(() => validateTaxTargets(changed, body), /Unlink/);
changed.income_sources[0].is_unlinked = true;
validateTaxTargets(changed, body);
checks++;
changed.payments[0].linked_income_id = "spouse";
fails(() => validateTaxTargets(changed, body), /different wage source/);
fails(
  () =>
    validateTaxTargets(
      {
        ...estimate,
        income_sources: [
          ...estimate.income_sources,
          estimate.income_sources[0],
        ],
      },
      body,
    ),
  /unique ID/,
);
fails(
  () =>
    buildTaxOverlay({ ...input, estimate: { ...estimate, tax_year: 2025 } }),
  /same tax year/,
);
const advanced = structuredClone(input);
advanced.link.body.cutoff_mode = "today";
advanced.source.through = "2026-09-01";
check(
  buildTaxOverlay(advanced).issues.map((r) => r.key),
  ["forecast-review", "payroll"],
);
const removed = structuredClone(estimate);
removed.income_sources = [];
fails(() => applyTaxOverlay(removed, calculation.overlay, "link"), /removed/);
const conflict = structuredClone(estimate);
conflict.payments.push({
  ...estimate.payments[0],
  id: "accounting-forecast:link:federal",
});
fails(
  () => applyTaxOverlay(conflict, calculation.overlay, "link"),
  /conflicts/,
);
const huge = structuredClone(input);
huge.link.body.forecast = {
  method: "manual",
  remaining_cents: "1000000000001",
};
check(buildTaxOverlay(huge).issues[0].key, "business");
console.log(`${checks} tax overlay checks passed.`);
