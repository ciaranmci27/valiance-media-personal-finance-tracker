import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { ApiError } from "@/lib/api/http";
import { booksToday } from "@/lib/api/books";
import { calculateFullTax } from "@/lib/tax/calculations";
import { getTaxYearConfig } from "@/lib/tax/constants";
import type { Database } from "@/types/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaxEstimateRow = Database["public"]["Tables"]["tax_estimates"]["Row"];

/** Whole dollars from the engine to integer cents. */
const cents = (dollars: number) => String(Math.round(dollars * 100));

/**
 * The Tax Estimator's figures for one year: the saved inputs run through
 * calculateFullTax with that year's configuration, exactly as the screen does.
 * Read after api_authorize checked tax.read on the key and its member.
 */
export const GET = withApi(
  apiOperation("tax.estimate"),
  async ({ query, service }) => {
    const year = query.year ?? Number((await booksToday(service)).slice(0, 4));
    const config = getTaxYearConfig(year);
    if (!config)
      throw new ApiError(
        404,
        "NOT_FOUND",
        `The estimator has no tax tables for ${year}.`,
        { reason: "unsupported_year" },
      );
    const { data, error } = await service
      .from("tax_estimates")
      .select("*")
      .eq("tax_year", year)
      .is("deleted_at", null)
      .maybeSingle();
    if (error)
      throw new ApiError(
        500,
        "INTERNAL_ERROR",
        "Could not read the tax estimator.",
      );
    if (!data)
      throw new ApiError(
        404,
        "NOT_FOUND",
        `There is no estimate for ${year}.`,
        { reason: "not_found" },
      );
    const row = data as TaxEstimateRow;

    const breakdown = calculateFullTax(
      row.income_sources ?? [],
      row.capital_gains ?? [],
      row.payments ?? [],
      Number(row.additional_deductions ?? 0),
      row.filing_status,
      config,
      row.state ?? null,
      row.dependents ?? 0,
      row.other_dependents ?? 0,
      Number(row.additional_credits ?? 0),
      row.tax_classification ?? null,
      {
        isSstb: row.is_sstb ?? false,
        businessW2Wages: Number(row.business_w2_wages ?? 0),
        businessPropertyBasis: Number(row.business_property_basis ?? 0),
        taxpayerAge65: row.taxpayer_age_65 ?? false,
        taxpayerBlind: row.taxpayer_blind ?? false,
        spouseAge65: row.spouse_age_65 ?? false,
        spouseBlind: row.spouse_blind ?? false,
      },
    );

    return {
      data: {
        year,
        saved_at: row.updated_at,
        books_linked: [
          ...(row.income_sources ?? []),
          ...(row.capital_gains ?? []),
          ...(row.payments ?? []),
        ].some((item) => Boolean((item as { books?: unknown }).books)),
        filing_status: row.filing_status,
        state: row.state ?? null,
        total_income_cents: cents(breakdown.totalIncome),
        agi_cents: cents(breakdown.agi),
        taxable_income_cents: cents(breakdown.taxableIncome),
        federal_liability_cents: cents(breakdown.federalLiability),
        state_liability_cents: cents(breakdown.stateLiability),
        self_employment_tax_cents: cents(breakdown.selfEmploymentTax.total),
        total_liability_cents: cents(breakdown.totalLiability),
        total_paid_cents: cents(breakdown.totalPaid),
        remaining_cents: cents(breakdown.netRemaining),
        federal_remaining_cents: cents(breakdown.federalRemaining),
        state_remaining_cents: cents(breakdown.stateRemaining),
        payments: (row.payments ?? []).map((payment) => ({
          type: payment.type,
          category: payment.category ?? null,
          quarter: payment.quarter ?? null,
          label: payment.label,
          amount_cents: cents(Number(payment.amount)),
        })),
      },
    };
  },
);
