import {taxPaymentPlanBodySchema} from "./tax-payment-inputs";
import type {TaxPaymentPlanResult} from "./tax-payment-plan";
import { z } from "zod";
import { dateSchema } from "./contracts";
import {
  businessForecastSchema,
  projectBusinessIncome,
  toEstimatorDollars,
  type BusinessProjection,
  type TaxForecastEvidence,
} from "./tax-projection";
import type { TaxSource } from "./tax-workpapers";
import { payrollFactLabels, type PayrollYear } from "./payroll";
import type {
  TaxEstimate,
  TaxIncomeSource,
  TaxCapitalGainEntry,
  TaxPaymentEntry,
} from "@/types/database";
import type { FullTaxBreakdown, BracketLine } from "@/lib/tax/calculations";

/** Null is the explicit unbounded upper edge of the final retained tax bracket. */
export type RetainedTaxOutput = Omit<
  FullTaxBreakdown,
  "federalTax" | "ltcgTax"
> & {
  federalTax: {
    total: number;
    bracketBreakdown: (Omit<BracketLine, "rangeEnd"> & {
      rangeEnd: number | null;
    })[];
  };
  ltcgTax: {
    total: number;
    bracketBreakdown: (Omit<BracketLine, "rangeEnd"> & {
      rangeEnd: number | null;
    })[];
  };
};

export interface TaxLinkSnapshot {
  id: string;
  link_id: string;
  link_version: number;
  financial_revision: string;
  personal_hash: string;
  through_date: string;
  created_at: string;
  payload: {
    engine_version: string;
    calculation: TaxLinkCalculation;
    outputs: RetainedTaxOutput;
  };
  inputs?: TaxLinkInputs;
}
export interface TaxLinkView {
  estimate: TaxEstimate | null;
  personal_hash: string | null;
  current: boolean;
  link: {
    id: string;
    estimate_id: string;
    version: number;
    enabled: boolean;
    body: TaxLinkBody;
    reason: string;
  } | null;
  job: {
    state: string;
    attempts: number;
    last_error: string | null;
    next_due: string;
    updated_at: string;
  } | null;
  snapshot: TaxLinkSnapshot | null;
  worker_enabled?: boolean;
  safe_harbor?: TaxPaymentPlanResult;
}

const target = z.string().min(1).max(160),
  cents = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/),
  positive = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const taxLinkBodySchema = z
  .object({
    safe_harbor: taxPaymentPlanBodySchema.nullable().optional(),
    cutoff_mode: z.enum(["fixed", "today"]),
    through: dateSchema,
    business_target_id: target.nullable(),
    forecast: businessForecastSchema,
    separate_targets: z
      .array(
        z
          .object({
            concept: z.enum([
              "interest",
              "qualified_dividend",
              "short_gain",
              "long_gain",
            ]),
            target_id: target,
            remaining_cents: cents,
          })
          .strict(),
      )
      .max(4),
    payroll: z
      .object({
        employee_key: target,
        income_target_id: target.nullable(),
        federal_payment_id: target.nullable(),
        state_payment_id: target.nullable(),
        state_code: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable(),
        remaining: z
          .object({
            federal_taxable_cents: positive.nullable(),
            federal_withheld_cents: positive.nullable(),
            state_taxable_cents: positive.nullable(),
            state_withheld_cents: positive.nullable(),
            social_security_wages_cents: positive.nullable(),
            medicare_wages_cents: positive.nullable(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    manual_separate_review: z
      .object({
        charity_cents: cents,
        tax_exempt_cents: cents,
        document_id: z.uuid(),
        reason: z.string().trim().min(1).max(1000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TaxLinkBody = z.infer<typeof taxLinkBodySchema>;
export const taxLinkCommandSchema = z
  .object({
    type: z.literal("tax.link.save"),
    id: z.uuid(),
    estimate_id: z.uuid(),
    expected_version: z.number().int().min(0),
    enabled: z.boolean(),
    body: taxLinkBodySchema,
    reason: z.string().trim().min(1).max(1000),
    verified: z.literal(true),
  })
  .strict();
export interface TaxOverlay {
  income: {
    id: string;
    amount_cents: string;
    wage_bases?: {
      social_security_cents: string;
      medicare_cents: string;
      state_cents?: string;
      state_code?: string;
    };
  }[];
  gains: { id: string; amount_cents: string }[];
  payments: {
    id: string;
    actual_cents: string;
    future_cents: string;
    through: string;
    document_id: string;
  }[];
}
export interface TaxLinkIssue {
  key: string;
  message: string;
  severity: "blocking" | "warning";
}
export interface TaxLinkCalculation {
  definition_version: 1;
  overlay: TaxOverlay;
  issues: TaxLinkIssue[];
  projection: BusinessProjection | null;
  source_period: {
    from: string;
    through: string;
    forecast_reviewed_through: string;
  };
}
export interface TaxLinkInputs {
  link: { id: string; version: number; body: TaxLinkBody };
  estimate: TaxEstimate;
  source: TaxSource;
  forecast_evidence: TaxForecastEvidence;
  payroll: PayrollYear | null;
  manual_review_document_available: boolean;
  after_cutoff_count: number;
}
export function validateTaxTargets(
  estimate: Pick<
    TaxEstimate,
    "income_sources" | "capital_gains" | "payments" | "tax_classification"
  >,
  body: TaxLinkBody,
) {
  for (const rows of [
    estimate.income_sources,
    estimate.capital_gains,
    estimate.payments,
  ])
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw new Error("Each existing estimator row must have a unique ID.");
  const usedIncome = new Set<string>(),
    usedGains = new Set<string>(),
    usedPayments = new Set<string>();
  const income = (id: string, type: string) => {
    const row = estimate.income_sources.find((r) => r.id === id);
    if (
      !row ||
      row.income_type !== type ||
      row.subject_to_se ||
      usedIncome.has(id)
    )
      throw new Error(
        "Choose distinct estimator income rows with the correct income type and no self-employment flag.",
      );
    if (row.linked_source_id && !row.is_unlinked)
      throw new Error(
        "Unlink this row from personal Income before linking it to the accounting books.",
      );
    usedIncome.add(id);
    return row;
  };
  if (body.business_target_id) {
    if (estimate.tax_classification !== "s_corp")
      throw new Error(
        "Automatic ordinary-income linkage currently requires the reviewed S corporation template.",
      );
    income(body.business_target_id, "k1");
  }
  const concepts = new Set<string>();
  for (const separate of body.separate_targets) {
    if (concepts.has(separate.concept))
      throw new Error("Link each separately stated concept only once.");
    concepts.add(separate.concept);
    if (
      separate.concept === "interest" ||
      separate.concept === "qualified_dividend"
    )
      income(
        separate.target_id,
        separate.concept === "interest" ? "1099" : "qualified_dividend",
      );
    else {
      const row = estimate.capital_gains.find(
        (r) => r.id === separate.target_id,
      );
      if (
        !row ||
        row.term !== (separate.concept === "short_gain" ? "short" : "long") ||
        usedGains.has(row.id)
      )
        throw new Error(
          "Choose a distinct capital-gain row with the matching holding period.",
        );
      usedGains.add(row.id);
    }
  }
  if (body.payroll) {
    if (body.payroll.income_target_id)
      income(body.payroll.income_target_id, "w2");
    for (const [id, jurisdiction] of [
      [body.payroll.federal_payment_id, "federal"],
      [body.payroll.state_payment_id, "state"],
    ] as const) {
      if (!id) continue;
      const row = estimate.payments.find((p) => p.id === id);
      if (
        !row ||
        row.type !== jurisdiction ||
        row.category === "payment" ||
        usedPayments.has(id)
      )
        throw new Error(
          "Choose distinct withholding rows for their correct jurisdictions.",
        );
      usedPayments.add(id);
      if (
        row.linked_income_id &&
        body.payroll.income_target_id &&
        row.linked_income_id !== body.payroll.income_target_id
      )
        throw new Error("The withholding belongs to a different wage source.");
    }
  }
  if (!usedIncome.size && !usedGains.size && !usedPayments.size)
    throw new Error("Select at least one existing estimator target.");
}

export function buildTaxOverlay(input: TaxLinkInputs): TaxLinkCalculation {
  const { source, estimate, link } = input,
    body = taxLinkBodySchema.parse(link.body),
    overlay: TaxOverlay = { income: [], gains: [], payments: [] },
    issues: TaxLinkIssue[] = [];
  const issue = (
    key: string,
    message: string,
    severity: TaxLinkIssue["severity"] = "blocking",
  ) => issues.push({ key, message, severity });
  validateTaxTargets(estimate, body);
  if (
    estimate.tax_year !== source.year ||
    Number(body.through.slice(0, 4)) !== source.year
  )
    throw new Error(
      "The books, forecast and estimator must use the same tax year.",
    );
  let projection: BusinessProjection | null = null;
  const treatmentReady =
    source.year_settings?.current &&
    !source.unmapped_accounts &&
    !source.unavailable_adjustments &&
    !source.incomplete_imports;
  if (body.cutoff_mode === "today" && body.through !== source.through)
    issue(
      "forecast-review",
      "Actuals advanced beyond the date when the remaining forecast was reviewed. Update the remaining assumptions before relying on a payment target.",
      "warning",
    );
  if (input.after_cutoff_count)
    issue(
      "after-cutoff",
      `${input.after_cutoff_count} posted transactions fall after the selected cutoff. Advance the cutoff to include them.`,
      "warning",
    );
  if (source.drafts)
    issue(
      "drafts",
      `${source.drafts} draft transactions remain outside the posted tax inputs.`,
      "warning",
    );
  if (body.business_target_id) {
    try {
      if (source.year_settings?.classification !== "s_corp")
        throw new Error(
          "Review the S corporation classification for this source year.",
        );
      projection = projectBusinessIncome(
        source,
        body.forecast,
        input.forecast_evidence,
      );
      let annual = BigInt(projection.annual_cents);
      if (annual < BigInt(0)) {
        const basis = source.basis;
        if (
          !basis?.current ||
          basis.body.opening_stock_cents === null ||
          basis.body.opening_debt_cents === null ||
          basis.body.allowed_loss_cents === null ||
          basis.body.limitations.trim()
        )
          throw new Error(
            "A negative business estimate needs current supported opening basis and an externally reviewed allowable loss without unresolved limitations. The manual business input is retained.",
          );
        const supported = BigInt(basis.body.allowed_loss_cents);
        if (-annual > supported) {
          annual = -supported;
          issue(
            "loss-limit",
            "The linked loss is capped at the supported allowable business loss. Additional losses remain outside this estimate.",
            "warning",
          );
        }
      }
      overlay.income.push({
        id: body.business_target_id,
        amount_cents: annual.toString(),
      });
    } catch (e) {
      issue(
        "business",
        e instanceof Error ? e.message : "Business projection unavailable.",
      );
    }
  }
  for (const concept of [
    "interest",
    "qualified_dividend",
    "short_gain",
    "long_gain",
  ] as const) {
    const amount = source.separately_stated[concept] ?? "0",
      mapping = body.separate_targets.find((t) => t.concept === concept);
    if (!mapping) {
      if (BigInt(amount) !== BigInt(0))
        issue(
          `separate-${concept}`,
          `Link the separately stated ${concept.replaceAll("_", " ")} amount or resolve its treatment. It has not been added to another income row.`,
        );
      continue;
    }
    if (!treatmentReady) {
      issue(
        `separate-${concept}`,
        "Complete the source treatment and import reviews before linking separately stated income.",
      );
      continue;
    }
    const annual = (
      BigInt(amount) + BigInt(mapping.remaining_cents)
    ).toString();
    toEstimatorDollars(annual);
    if (
      source.through.endsWith("-12-31") &&
      BigInt(mapping.remaining_cents) !== BigInt(0)
    ) {
      issue(
        `separate-${concept}`,
        "A completed year cannot include projected separately stated income.",
      );
      continue;
    }
    if (concept === "interest" || concept === "qualified_dividend")
      overlay.income.push({ id: mapping.target_id, amount_cents: annual });
    else overlay.gains.push({ id: mapping.target_id, amount_cents: annual });
  }
  const charity = source.separately_stated.charity ?? "0",
    exempt = source.separately_stated.tax_exempt ?? "0",
    review = body.manual_separate_review;
  if (BigInt(charity) !== BigInt(0) || BigInt(exempt) !== BigInt(0)) {
    if (
      !review ||
      review.charity_cents !== charity ||
      review.tax_exempt_cents !== exempt ||
      !input.manual_review_document_available
    )
      issue(
        "manual-separate",
        "Charitable contributions or tax-exempt income need current documented personal-return and basis treatment. No personal deduction has been added automatically.",
      );
    else
      issue(
        "manual-separate-reviewed",
        "Charitable and tax-exempt amounts retain the documented external treatment. This overlay adds no personal deduction.",
        "warning",
      );
  }
  if (body.payroll) {
    const payroll = body.payroll,
      coverage = input.payroll?.coverage,
      employee = coverage?.employees.find(
        (e) => e.key === payroll.employee_key,
      );
    if (
      !coverage?.current ||
      coverage.through_date !== source.through ||
      !employee
    )
      issue(
        "payroll",
        "Current verified provider coverage for the selected employee and cutoff is unavailable. Manual payroll inputs are retained.",
      );
    else {
      const annual = (key: keyof typeof payrollFactLabels) => {
        const actual = employee[key],
          future = payroll.remaining[key];
        if (actual == null || future === null)
          throw new Error(
            `${payrollFactLabels[key]} or its remaining-year forecast is unavailable.`,
          );
        if (source.through.endsWith("-12-31") && BigInt(future) !== BigInt(0))
          throw new Error(
            "A completed payroll year cannot include future wages or withholding.",
          );
        const value = (BigInt(actual) + BigInt(future)).toString();
        toEstimatorDollars(value);
        return value;
      };
      if (payroll.income_target_id)
        try {
          const amount = annual("federal_taxable_cents"),
            ss = annual("social_security_wages_cents"),
            medicare = annual("medicare_wages_cents");
          let stateWages: string | undefined;
          if (estimate.state) {
            if (payroll.state_code !== estimate.state)
              throw new Error(
                "Confirm the state jurisdiction for the verified payroll wage figures.",
              );
            stateWages = annual("state_taxable_cents");
          }
          overlay.income.push({
            id: payroll.income_target_id,
            amount_cents: amount,
            wage_bases: {
              social_security_cents: ss,
              medicare_cents: medicare,
              ...(stateWages !== undefined
                ? { state_cents: stateWages, state_code: estimate.state! }
                : {}),
            },
          });
        } catch (e) {
          issue(
            "payroll-wages",
            `${e instanceof Error ? e.message : "Wage facts unavailable."} The manual wage input is retained.`,
          );
        }
      for (const [id, key] of [
        [payroll.federal_payment_id, "federal_withheld_cents"],
        [payroll.state_payment_id, "state_withheld_cents"],
      ] as const) {
        if (!id) continue;
        try {
          if (
            key === "state_withheld_cents" &&
            (!estimate.state || payroll.state_code !== estimate.state)
          )
            throw new Error(
              "Confirm the state jurisdiction for the withheld amount.",
            );
          annual(key);
          overlay.payments.push({
            id,
            actual_cents: employee[key]!,
            future_cents: payroll.remaining[key]!,
            through: coverage.through_date,
            document_id: coverage.document_id,
          });
        } catch (e) {
          issue(
            `payroll-${key}`,
            `${e instanceof Error ? e.message : "Withholding unavailable."} The manual withholding input is retained.`,
          );
        }
      }
    }
  }
  return {
    definition_version: 1,
    overlay,
    issues,
    projection,
    source_period: {
      from: `${source.year}-01-01`,
      through: source.through,
      forecast_reviewed_through: body.through,
    },
  };
}

/** Apply only selected amounts to a calculation copy. Never persist this copy. */
export function applyTaxOverlay(
  base: {
    income_sources: TaxIncomeSource[];
    capital_gains: TaxCapitalGainEntry[];
    payments: TaxPaymentEntry[];
  },
  overlay: TaxOverlay,
  linkId: string,
) {
  const result = {
    income_sources: base.income_sources.map((row) => ({ ...row })),
    capital_gains: base.capital_gains.map((row) => ({ ...row })),
    payments: base.payments.map((row) => ({ ...row })),
  };
  for (const update of overlay.income) {
    const row = result.income_sources.find((r) => r.id === update.id);
    if (!row)
      throw new Error(
        "A linked income target was removed. Review the accounting link.",
      );
    row.amount = toEstimatorDollars(update.amount_cents);
    if (update.wage_bases)
      row.wage_bases = {
        social_security: toEstimatorDollars(
          update.wage_bases.social_security_cents,
        ),
        medicare: toEstimatorDollars(update.wage_bases.medicare_cents),
        ...(update.wage_bases.state_cents !== undefined
          ? {
              state: toEstimatorDollars(update.wage_bases.state_cents),
              state_code: update.wage_bases.state_code,
            }
          : {}),
      };
  }
  for (const update of overlay.gains) {
    const row = result.capital_gains.find((r) => r.id === update.id);
    if (!row)
      throw new Error(
        "A linked gain target was removed. Review the accounting link.",
      );
    row.amount = toEstimatorDollars(update.amount_cents);
  }
  for (const update of overlay.payments) {
    const row = result.payments.find((r) => r.id === update.id);
    if (!row)
      throw new Error(
        "A linked withholding target was removed. Review the accounting link.",
      );
    row.amount = toEstimatorDollars(update.actual_cents);
    row.timing = "actual";
    row.category = "withholding";
    row.document_id = update.document_id;
    row.verified_through = update.through;
    delete row.paid_on;
    if (BigInt(update.future_cents) !== BigInt(0)) {
      const id = `accounting-forecast:${linkId}:${row.id}`;
      if (result.payments.some((p) => p.id === id))
        throw new Error("The forecast payment ID conflicts with a manual row.");
      result.payments.push({
        ...row,
        id,
        label: `Projected remaining ${row.type} payroll withholding`,
        amount: toEstimatorDollars(update.future_cents),
        timing: "forecast",
      });
    }
  }
  return result;
}
