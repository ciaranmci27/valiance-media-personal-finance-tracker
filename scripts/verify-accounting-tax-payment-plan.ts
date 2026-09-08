import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  calculatePaymentPlan,
  taxPaymentPlanBodySchema,
  validatePaymentPlan,
  federalDeadlines,
  taxLinkSafeHarbor,
  type TaxPaymentPlanInputs,
  type TaxPaymentPlanBody,
} from "../src/lib/accounting/tax-payment-plan";
import type { TaxEstimate } from "../src/types/database";
let checks = 0;
const check = (a: unknown, b: unknown) => {
  assert.deepEqual(a, b);
  checks++;
};
const fails = (f: () => unknown, r: RegExp) => {
  assert.throws(f, r);
  checks++;
};
const doc = randomUUID(),
  id = randomUUID(),
  estimateId = randomUUID();
const body: TaxPaymentPlanBody = {
  federal: {
    prior_tax_cents: "1000000",
    prior_agi_cents: "15000000",
    filing_status: "single",
    document_id: doc,
    standard_rules_confirmed: true,
  },
  state_code: null,
  manual: [],
  taxpayer_confirmed: true,
  reviews: [
    {
      payment_id: "actual",
      amount_cents: "200000",
      jurisdiction: "federal",
      kind: "withholding_actual",
      date: "2026-08-31",
      document_id: doc,
    },
    {
      payment_id: "future",
      amount_cents: "100000",
      jurisdiction: "federal",
      kind: "withholding_forecast",
      date: "2026-08-31",
      document_id: doc,
    },
    {
      payment_id: "payment",
      amount_cents: "180000",
      jurisdiction: "federal",
      kind: "estimated",
      date: "2026-04-16",
      document_id: doc,
    },
  ],
};
const input: TaxPaymentPlanInputs = {
  year: 2026,
  as_of: "2026-09-07",
  financial_revision: "1",
  available_documents: [doc],
  plan: { id, version: 1, body, reason: "Synthetic" },
  tax: {
    estimate: {
      id: estimateId,
      additional_deductions: 0, business_type: 'llc', tax_classification: 's_corp',
      dependents: 0, other_dependents: 0, additional_credits: 0, is_sstb: false,
      business_w2_wages: 0, business_property_basis: 0, taxpayer_age_65: false,
      taxpayer_blind: false, spouse_age_65: false, spouse_blind: false,
      notes: null, deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      tax_year: 2026,
      filing_status: "single",
      state: null,
      income_sources: [],
      capital_gains: [],
      payments: [
        {
          id: "actual",
          type: "federal",
          category: "withholding",
          label: "Actual",
          amount: 2000,
        },
        {
          id: "future",
          type: "federal",
          category: "withholding",
          label: "Future",
          amount: 1000,
        },
        {
          id: "payment",
          type: "federal",
          category: "payment",
          label: "Q1",
          amount: 1800,
        },
      ],
    } satisfies TaxEstimate,
    personal_hash: null,
    current: false,
    link: null,
    job: null,
    snapshot: null,
  },
};
const calc = (mutate?: (copy: TaxPaymentPlanInputs) => void) => {
  const c = structuredClone(input);
  mutate?.(c);
  return calculatePaymentPlan(c);
};
check(calc().ready, true);
check(calc().federal.annual_target_cents, "1000000");
check(calc().federal.prior_multiplier, 100);
check(
  calc().federal.installments.map((r) => r.target_cents),
  ["175000", "175000", "175000", "175000"],
);
check(calc().federal.installments[0].gap_at_deadline_cents, "175000");
check(calc().federal.installments[0].remaining_as_of_cents, "0");
check(calc().federal.installments[1].remaining_as_of_cents, "170000");
check(calc().federal.installments[2].gap_at_deadline_cents, null);
check(calc().federal.withheld_actual_cents, "200000");
check(calc().federal.withheld_forecast_cents, "100000");
check(
  calc((c) => (c.plan!.body.federal!.prior_agi_cents = "15000001")).federal
    .prior_multiplier,
  110,
);
check(
  calc((c) => {
    c.tax.estimate!.filing_status = "mfs";
    c.plan!.body.federal!.filing_status = "mfs";
    c.plan!.body.federal!.prior_agi_cents = "7500000";
  }).federal.prior_multiplier,
  100,
);
check(
  calc((c) => {
    c.tax.estimate!.filing_status = "mfs";
    c.plan!.body.federal!.filing_status = "mfs";
    c.plan!.body.federal!.prior_agi_cents = "7500001";
  }).federal.prior_multiplier,
  110,
);
check(
  calc((c) => (c.plan!.body.federal!.prior_agi_cents = "-15000001")).federal
    .prior_multiplier,
  100,
);
check(
  calc(
    (c) => (c.plan!.body.federal!.prior_tax_cents = "1"),
  ).federal.installments.map((r) => r.target_cents),
  ["0", "0", "0", "0"],
);
check(
  calc((c) => {
    c.plan!.body.federal!.prior_tax_cents = "300001";
  }).federal.installments.map((r) => r.target_cents),
  ["1", "0", "0", "0"],
);
check(
  calc((c) => {
    c.plan!.body.federal!.prior_tax_cents = "300003";
  }).federal.installments.map((r) => r.target_cents),
  ["1", "1", "1", "0"],
);
check(
  calc((c) => (c.plan!.body.reviews[2].date = "2026-04-15")).federal
    .installments[0].gap_at_deadline_cents,
  "0",
);
check(
  calc((c) => (c.plan!.body.reviews[2].date = "2026-09-08")).federal
    .estimated_paid_cents,
  "0",
);
check(calc((c) => (c.tax.estimate!.payments[0].amount = 2001)).ready, false);
check(calc((c) => (c.available_documents = [])).federal.method, "unconfigured");
check(calc((c) => (c.available_documents = [])).payments, []);
check(
  calc((c) => (c.plan!.body.reviews = [])).federal.estimated_paid_cents,
  "0",
);
check(
  calc((c) => (c.plan!.body.reviews[0].jurisdiction = "state")).federal
    .withheld_actual_cents,
  "0",
);
check(
  calc((c) => (c.plan!.body.reviews[2].kind = "withholding_actual")).federal
    .estimated_paid_cents,
  "0",
);
check(
  calc((c) => (c.tax.estimate!.filing_status = "mfj")).federal.method,
  "unconfigured",
);
check(
  calc((c) => {
    c.year = 2027;
    c.tax.estimate!.tax_year = 2027;
  }).federal.method,
  "unconfigured",
);
check(
  calc((c) => (c.as_of = "2027-01-15")).federal.withheld_forecast_cents,
  "0",
);
check(
  calc((c) => {
    c.tax.estimate!.state = "AZ";
    c.plan!.body.state_code = "AZ";
  }).ready,
  false,
);
check(
  calc((c) => {
    c.plan!.body.federal = null;
    c.plan!.body.manual = [
      {
        jurisdiction: "federal",
        date: "2026-09-15",
        amount_cents: "500000",
        document_id: doc,
        reason: "Net required payments after withholding",
      },
    ];
  }).federal.installments[0].remaining_as_of_cents,
  "320000",
);
check(
  calc((c) => {
    c.plan!.body.federal = null;
    c.plan!.body.manual = [
      {
        jurisdiction: "federal",
        date: "2026-09-15",
        amount_cents: "500000",
        document_id: doc,
        reason: "Net",
      },
    ];
  }).federal.annual_target_cents,
  "500000",
);
check(federalDeadlines[2025], [
  "2025-04-15",
  "2025-06-16",
  "2025-09-15",
  "2026-01-15",
]);
check(calc((c) => (c.plan = null)).ready, false);
fails(
  () =>
    taxPaymentPlanBodySchema.parse({
      ...body,
      reviews: [body.reviews[0], body.reviews[0]],
    }),
  /Review each/,
);
fails(
  () =>
    taxPaymentPlanBodySchema.parse({
      ...body,
      manual: [
        {
          jurisdiction: "federal",
          date: "2026-09-15",
          amount_cents: "1",
          document_id: doc,
          reason: "X",
        },
      ],
    }),
  /either/,
);
fails(
  () => validatePaymentPlan({ ...body, state_code: "AZ" }, input),
  /jurisdiction/,
);
fails(() => calc((c) => (c.tax.estimate!.payments[0].amount = -1)), /negative/);
fails(
  () => calc((c) => c.tax.estimate!.payments.push(c.tax.estimate!.payments[0])),
  /unique/,
);
check(input.tax.estimate!.payments[0].amount, 2000);
const linked = structuredClone(input);
linked.tax.link = { id: "link", version: 1, enabled: true } as any;
linked.tax.current = true;
linked.tax.snapshot = { payload: { calculation: { issues: [], overlay: {
  income: [], gains: [], payments: [{ id: "actual", actual_cents: "210000", future_cents: "90000", through: "2026-09-07", document_id: doc }],
} } } } as any;
linked.tax.estimate!.payments = linked.tax.estimate!.payments.filter(p => p.id !== "future");
linked.plan!.body.reviews = linked.plan!.body.reviews.filter(r => r.payment_id === "payment");
check(calculatePaymentPlan(linked).ready, true);
check(calculatePaymentPlan(linked).federal.withheld_actual_cents, "210000");
check(calculatePaymentPlan(linked).federal.withheld_forecast_cents, "90000");
check(calculatePaymentPlan(linked).payments.length, 3);
linked.tax.snapshot!.payload.calculation.issues.push({ key: "missing", message: "Coverage incomplete", severity: "blocking" });
check(calculatePaymentPlan(linked).ready, false);
check(calculatePaymentPlan(linked).issues.includes("Coverage incomplete"), true);
linked.tax.current = false;
check(calculatePaymentPlan(linked).federal.withheld_actual_cents, "0");
check(calculatePaymentPlan(linked).federal.withheld_forecast_cents, "0");
check(calculatePaymentPlan(linked).ready, false);
const large = calc(c => { c.plan!.body.federal!.prior_tax_cents = "999999999999999999"; c.plan!.body.federal!.prior_agi_cents = "15000001"; });
check(large.federal.annual_target_cents, "1099999999999999999");
check(large.federal.installments.reduce((s, r) => s + BigInt(r.target_cents), BigInt(0)).toString(), "1099999999999699999");


const taxLink = {...input.tax, link:{id,version:1,estimate_id:estimateId,enabled:false,body:{safe_harbor:body} as import('../src/lib/accounting/tax-links').TaxLinkBody,reason:'Synthetic forecast inputs'}};
check(taxLinkSafeHarbor(taxLink,{as_of:input.as_of,financial_revision:input.financial_revision,available_documents:input.available_documents}), calculatePaymentPlan({...input,tax:taxLink}));
check(taxLinkSafeHarbor(taxLink,{as_of:input.as_of,financial_revision:input.financial_revision,available_documents:[]}).ready,false);
console.log(`Pure safe-harbor and installment math: ${checks} assertions passed.`);
