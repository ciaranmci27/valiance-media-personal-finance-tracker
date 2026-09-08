import {applyTaxOverlay, type TaxLinkView} from "./tax-links";
import {fromEstimatorDollars} from "./tax-projection";
import {taxPaymentPlanBodySchema, type TaxPaymentPlanBody, type PaymentReview} from "./tax-payment-inputs";
export {taxPaymentPlanBodySchema, paymentReviewSchema, type TaxPaymentPlanBody, type PaymentReview} from "./tax-payment-inputs";
export interface TaxPaymentPlanInputs {
  year: number;
  as_of: string;
  financial_revision: string;
  tax: TaxLinkView;
  plan: {
    id: string;
    version: number;
    body: TaxPaymentPlanBody;
    reason: string;
  } | null;
  available_documents: string[];
}
/** Uses current link inputs and available evidence. No plan row or cached plan is persisted. */
export function taxLinkSafeHarbor(tax: TaxLinkView, context: {as_of: string; financial_revision: string; available_documents: string[]}): TaxPaymentPlanResult {
  return calculatePaymentPlan({
    ...context,
    year: tax.estimate?.tax_year ?? Number(context.as_of.slice(0,4)),
    tax,
    plan: tax.link?.body.safe_harbor ? {id: tax.link.id, version: tax.link.version, body: tax.link.body.safe_harbor, reason: tax.link.reason} : null,
  });
}
export const federalDeadlines: Record<number, readonly string[]> = {
  2025: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
  2026: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
};
export function planPayments(inputs: TaxPaymentPlanInputs) {
  const { tax } = inputs;
  if (!tax.estimate) return [];
  return tax.link?.enabled && tax.current && tax.snapshot
    ? applyTaxOverlay(
        tax.estimate,
        tax.snapshot.payload.calculation.overlay,
        tax.link.id,
      ).payments
    : tax.estimate.payments;
}
export function validatePaymentPlan(
  body: TaxPaymentPlanBody,
  inputs: TaxPaymentPlanInputs,
) {
  const estimate = inputs.tax.estimate;
  if (!estimate) throw new Error("Create this year's personal estimate first.");
  if (body.state_code !== estimate.state)
    throw new Error("Review the state jurisdiction in the personal estimate.");
  if (
    body.federal &&
    (!federalDeadlines[inputs.year] ||
      body.federal.filing_status !== estimate.filing_status)
  )
    throw new Error(
      "This prior-year method supports 2025 and 2026 with an unchanged filing status. Use a documented manual target for other cases.",
    );
  for (const row of body.manual)
    if (
      row.date < `${inputs.year}-01-01` ||
      row.date > `${inputs.year + 1}-12-31`
    )
      throw new Error(
        "Manual payment deadlines must belong to this tax year or the following filing year.",
      );
  for (const review of body.reviews)
    if (
      review.date < `${inputs.year}-01-01` ||
      review.date > inputs.as_of ||
      (review.kind !== "estimated" && review.date > `${inputs.year}-12-31`)
    )
      throw new Error(
        "Payment dates and withholding review dates must be within the tax year through the selected date. Estimated payments may occur in the following year.",
      );
}
export interface PlannedInstallment {
  date: string;
  target_cents: string;
  cumulative_target_cents: string;
  paid_by_deadline_cents: string;
  gap_at_deadline_cents: string | null;
  remaining_as_of_cents: string;
}
export interface TaxPaymentPlanResult {
  definition_version: 1;
  engine_version: "payment-plan-v1";
  year: number;
  as_of: string;
  ready: boolean;
  issues: string[];
  payments: {
    id: string;
    label: string;
    jurisdiction: "federal" | "state";
    kind: PaymentReview["kind"];
    amount_cents: string;
    date: string;
    document_id: string;
  }[];
  federal: PlanJurisdiction;
  state: PlanJurisdiction;
}
interface PlanJurisdiction {
  method: "prior_year" | "manual" | "unconfigured";
  prior_multiplier: 100 | 110 | null;
  annual_target_cents: string | null;
  estimated_paid_cents: string;
  withheld_actual_cents: string;
  withheld_forecast_cents: string;
  installments: PlannedInstallment[];
}
const zero = BigInt(0),
  maxZero = (n: bigint) => (n > zero ? n : zero);
const ceilRatio = (n: bigint, d: bigint) => (n + d - BigInt(1)) / d;

/** Exact-cent installment planning, independent of the annual tax engine. */
export function calculatePaymentPlan(
  inputs: TaxPaymentPlanInputs,
): TaxPaymentPlanResult {
  const body = inputs.plan
    ? taxPaymentPlanBodySchema.parse(inputs.plan.body)
    : null;
  const issues: string[] = [],
    payments: TaxPaymentPlanResult["payments"] = [];
  const docs = new Set(inputs.available_documents);
  if (!body) issues.push("Review payment evidence and choose a target method.");
  if (body) {
    try {
      validatePaymentPlan(body, inputs);
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  const { tax, year, as_of } = inputs;
  if (tax.link?.enabled) {
    if (!tax.current)
      issues.push(
        "The linked tax estimate needs a refresh. Retained withholding is not counted as current evidence.",
      );
    else if (tax.snapshot)
      issues.push(
        ...tax.snapshot.payload.calculation.issues.map((i) => i.message),
      );
  }
  const rows = planPayments(inputs);
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error("Payment row IDs must be unique.");
  for (const row of rows) {
    const amount = fromEstimatorDollars(row.amount);
    if (BigInt(amount) < zero)
      throw new Error(
        "Payments cannot be negative. Correct the source payment.",
      );
    if (BigInt(amount) === zero) continue;
    const linked =
      tax.current &&
      !!tax.snapshot?.payload.calculation.overlay.payments.some(
        (p) =>
          p.id === row.id ||
          row.id === `accounting-forecast:${tax.link?.id}:${p.id}`,
      );
    const review =
      linked && row.document_id && row.verified_through
        ? {
            payment_id: row.id,
            amount_cents: amount,
            jurisdiction: row.type,
            kind:
              row.timing === "forecast"
                ? ("withholding_forecast" as const)
                : ("withholding_actual" as const),
            date: row.verified_through,
            document_id: row.document_id,
          }
        : body?.reviews.find((p) => p.payment_id === row.id);
    const category = row.category ?? "withholding";
    if (
      !review ||
      review.amount_cents !== amount ||
      review.jurisdiction !== row.type ||
      (review.kind === "estimated") !== (category === "payment") ||
      !docs.has(review.document_id) ||
      review.date > as_of ||
      review.date < `${year}-01-01` ||
      (review.kind !== "estimated" && review.date > `${year}-12-31`) ||
      (row.type === "state" &&
        (!body?.state_code || body.state_code !== tax.estimate?.state))
    ) {
      issues.push(
        `Review the amount, jurisdiction, date and evidence for ${row.label || "an unnamed payment"}. It is excluded from verified payments.`,
      );
      continue;
    }
    if (as_of > `${year}-12-31` && review.kind === "withholding_forecast") {
      issues.push(
        `Replace the remaining withholding forecast for ${row.label} with the final actual amount.`,
      );
      continue;
    }
    payments.push({
      id: row.id,
      label: row.label,
      jurisdiction: row.type,
      kind: review.kind,
      amount_cents: amount,
      date: review.date,
      document_id: review.document_id,
    });
  }
  const group = (jurisdiction: "federal" | "state"): PlanJurisdiction => {
    const selected = payments.filter((p) => p.jurisdiction === jurisdiction);
    const sum = (kind: PaymentReview["kind"]) =>
      selected
        .filter((p) => p.kind === kind)
        .reduce((s, p) => s + BigInt(p.amount_cents), zero);
    const paid = sum("estimated"),
      actual = sum("withholding_actual"),
      future = sum("withholding_forecast");
    const result: PlanJurisdiction = {
      method: "unconfigured",
      prior_multiplier: null,
      annual_target_cents: null,
      estimated_paid_cents: paid.toString(),
      withheld_actual_cents: actual.toString(),
      withheld_forecast_cents: future.toString(),
      installments: [],
    };
    let targets: { date: string; amount: bigint }[] = [];
    if (jurisdiction === "federal" && body?.federal) {
      const f = body.federal;
      if (
        !federalDeadlines[year] ||
        f.filing_status !== tax.estimate?.filing_status ||
        !docs.has(f.document_id)
      ) {
        issues.push(
          "Review supported federal rules, unchanged filing status and the prior return evidence.",
        );
      } else {
        result.method = "prior_year";
        result.prior_multiplier =
          BigInt(f.prior_agi_cents) >
          BigInt(f.filing_status === "mfs" ? 7500000 : 15000000)
            ? 110
            : 100;
        const required = ceilRatio(
          BigInt(f.prior_tax_cents) * BigInt(result.prior_multiplier),
          BigInt(100),
        );
        result.annual_target_cents = required.toString();
        const net = maxZero(required - actual - future);
        let preceding = zero;
        targets = federalDeadlines[year].map((date, i) => {
          const cumulative = ceilRatio(net * BigInt(i + 1), BigInt(4));
          const amount = cumulative - preceding;
          preceding = cumulative;
          return { date, amount };
        });
      }
    } else if (body) {
      const manual = body.manual.filter((r) => r.jurisdiction === jurisdiction);
      if (manual.length) {
        const valid = manual.every(
          (r) =>
            docs.has(r.document_id) &&
            r.date >= `${year}-01-01` &&
            r.date <= `${year + 1}-12-31`,
        );
        if (
          !valid ||
          (jurisdiction === "state" && body.state_code !== tax.estimate?.state)
        )
          issues.push(
            `Review the ${jurisdiction} manual schedule and its evidence.`,
          );
        else {
          result.method = "manual";
          targets = manual
            .map((r) => ({ date: r.date, amount: BigInt(r.amount_cents) }))
            .sort((a, b) => a.date.localeCompare(b.date));
          result.annual_target_cents = targets
            .reduce((s, r) => s + r.amount, zero)
            .toString();
        }
      }
    }
    let cumulative = zero;
    for (const target of targets) {
      cumulative += target.amount;
      const paidBy = selected
        .filter((p) => p.kind === "estimated" && p.date <= target.date)
        .reduce((s, p) => s + BigInt(p.amount_cents), zero);
      result.installments.push({
        date: target.date,
        target_cents: target.amount.toString(),
        cumulative_target_cents: cumulative.toString(),
        paid_by_deadline_cents: paidBy.toString(),
        gap_at_deadline_cents:
          target.date <= as_of ? maxZero(cumulative - paidBy).toString() : null,
        remaining_as_of_cents: maxZero(cumulative - paid).toString(),
      });
    }
    return result;
  };
  const federal = group("federal"),
    state = group("state");
  if (federal.method === "unconfigured")
    issues.push("No federal installment target is configured.");
  if (tax.estimate?.state && state.method === "unconfigured")
    issues.push("State payment rules need a documented manual schedule.");
  return {
    definition_version: 1,
    engine_version: "payment-plan-v1",
    year,
    as_of,
    ready: issues.length === 0,
    issues: [...new Set(issues)],
    payments,
    federal,
    state,
  };
}
