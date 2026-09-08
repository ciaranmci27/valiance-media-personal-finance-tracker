import {
  buildTaxOverlay,
  applyTaxOverlay,
  type TaxLinkInputs,
  type TaxLinkSnapshot,
} from "./tax-links";
import { fromEstimatorDollars } from "./tax-projection";
import { calculateFullTax, type BracketLine } from "../tax/calculations";
import { getTaxYearConfig } from "../tax/constants";
import { z } from "zod";
import type { TaxEstimate } from "@/types/database";

export const TAX_LINK_ENGINE_VERSION = "accounting-tax-v1";
const amount = z.number().finite().min(-10000000000).max(10000000000);
const income = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    amount,
    income_type: z.enum([
      "w2",
      "k1",
      "1099",
      "qualified_dividend",
      "retirement",
    ]),
    subject_to_se: z.boolean(),
    taxpayer: z.enum(["self", "spouse"]).optional(),
    wage_bases: z
      .object({
        social_security: amount.nonnegative(),
        medicare: amount.nonnegative(),
        state: amount.nonnegative().optional(),
        state_code: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
      })
      .optional(),
  })
  .passthrough();
const estimateSchema = z
  .object({
    tax_year: z.number().int().min(1900).max(2100),
    filing_status: z.enum(["single", "mfj", "mfs", "hoh"]),
    income_sources: z.array(income).max(1000),
    capital_gains: z
      .array(
        z
          .object({
            id: z.string().min(1),
            amount,
            term: z.enum(["short", "long"]),
          })
          .passthrough(),
      )
      .max(1000),
    payments: z
      .array(
        z
          .object({
            id: z.string().min(1),
            type: z.enum(["federal", "state"]),
            amount: amount.nonnegative(),
          })
          .passthrough(),
      )
      .max(1000),
    additional_deductions: amount.nonnegative(),
    additional_credits: amount.nonnegative(),
    dependents: z.number().int().min(0).max(100),
    other_dependents: z.number().int().min(0).max(100),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    tax_classification: z
      .enum(["sole_prop", "disregarded", "s_corp", "c_corp", "partnership"])
      .nullable(),
    is_sstb: z.boolean(),
    business_w2_wages: amount.nonnegative(),
    business_property_basis: amount.nonnegative(),
    taxpayer_age_65: z.boolean(),
    taxpayer_blind: z.boolean(),
    spouse_age_65: z.boolean(),
    spouse_blind: z.boolean(),
  })
  .passthrough();
export function calculateTaxLink(
  inputs: TaxLinkInputs,
): TaxLinkSnapshot["payload"] {
  const calculation = buildTaxOverlay(inputs);
  const copy = applyTaxOverlay(
    inputs.estimate,
    calculation.overlay,
    inputs.link.id,
  );
  return {
    engine_version: TAX_LINK_ENGINE_VERSION,
    calculation,
    outputs: calculatePersonalEstimate({ ...inputs.estimate, ...copy }),
  };
}
export function calculatePersonalEstimate(e: TaxEstimate) {
  const valid = estimateSchema.safeParse(e);
  if (!valid.success)
    throw new Error(
      "Review the personal estimator inputs. A required field is invalid or exceeds its supported range.",
    );
  const config = getTaxYearConfig(e.tax_year);
  if (!config)
    throw new Error(
      "The existing tax calculator does not support this tax year.",
    );
  for (const row of [...e.income_sources, ...e.capital_gains, ...e.payments])
    fromEstimatorDollars(row.amount);
  const outputs = calculateFullTax(
    e.income_sources,
    e.capital_gains,
    e.payments,
    e.additional_deductions,
    e.filing_status,
    config,
    e.state,
    e.dependents,
    e.other_dependents,
    e.additional_credits,
    e.tax_classification,
    {
      isSstb: e.is_sstb,
      businessW2Wages: e.business_w2_wages,
      businessPropertyBasis: e.business_property_basis,
      taxpayerAge65: e.taxpayer_age_65,
      taxpayerBlind: e.taxpayer_blind,
      spouseAge65: e.spouse_age_65,
      spouseBlind: e.spouse_blind,
    },
  );
  const bracket = (row: BracketLine) => ({
    ...row,
    rangeEnd: row.rangeEnd === Infinity ? null : row.rangeEnd,
  });
  const retained = {
    ...outputs,
    federalTax: {
      ...outputs.federalTax,
      bracketBreakdown: outputs.federalTax.bracketBreakdown.map(bracket),
    },
    ltcgTax: {
      ...outputs.ltcgTax,
      bracketBreakdown: outputs.ltcgTax.bracketBreakdown.map(bracket),
    },
  };
  for (const value of Object.values(retained))
    if (typeof value === "number") fromEstimatorDollars(value);
  // The unbounded bracket edge above is the only intentional non-finite value.
  JSON.stringify(retained, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("The tax calculation exceeded its supported range.");
    return value;
  });
  return retained;
}
export type TaxRefreshRpc = (
  command: Record<string, unknown>,
) => Promise<unknown>;
export async function refreshTaxLink(
  rpc: TaxRefreshRpc,
  linkId: string,
  force = false,
) {
  const claim = (await rpc({ type: "start", link_id: linkId, force })) as {
    state: string;
    lease_token?: string;
    inputs?: TaxLinkInputs;
    snapshot_id?: string;
  };
  if (claim.state !== "running") return claim;
  if (!claim.lease_token || !claim.inputs)
    throw new Error("The tax refresh did not return a valid lease.");
  let payload: TaxLinkSnapshot["payload"];
  try {
    payload = calculateTaxLink(claim.inputs);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Tax calculation failed.";
    await rpc({
      type: "fail",
      link_id: linkId,
      lease_token: claim.lease_token,
      error: message,
    });
    return { state: "failed", error: message };
  }
  // A transport failure here is uncertain. Retain the lease for recovery rather
  // than overwrite a successful finish with a separate failure operation.
  return (await rpc({
    type: "finish",
    link_id: linkId,
    lease_token: claim.lease_token,
    payload,
  })) as { state: string; snapshot_id?: string };
}
