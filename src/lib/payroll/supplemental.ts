// Supplemental wage federal withholding (IRS Pub 15, Supplemental Wages).
//
// Supplemental wages = bonuses, commissions, retroactive pay, severance,
// overtime separately identified, awards, back pay, accumulated sick leave.
// For our owner-operator scope this is primarily off-cycle bonuses.
//
// Two acceptable methods (IRS Pub 15, section "Supplemental Wages"):
//   A. Aggregate method - add the supplemental to the regular period's
//      wages and withhold as if all of it were wages paid in the period.
//   B. Flat-rate method - withhold a flat 22% (or 37% above $1M aggregate
//      year-to-date for supplemental alone).
//
// This module implements method B, which is the default for off-cycle
// runs in this app. The $1M threshold is specifically for SUPPLEMENTAL
// wages paid to a single employee in a calendar year - not total wages.
//
// FICA (SS + Medicare + Add Medicare) and state tax are calculated
// NORMALLY on supplemental wages. This file only handles the federal
// income tax portion.

import { round2 } from "./rounding";

/** Flat rate for the first $1,000,000 of supplemental wages per employee per year. */
export const SUPPLEMENTAL_FLAT_RATE = 0.22;

/** Mandatory rate for supplemental wages above $1,000,000 per employee per year. */
export const SUPPLEMENTAL_HIGH_RATE = 0.37;

/** Annual threshold at which the mandatory higher rate kicks in. */
export const SUPPLEMENTAL_HIGH_THRESHOLD = 1_000_000;

export interface SupplementalFederalInput {
  /** Gross dollar amount of this supplemental payment BEFORE §125/401(k)
   *  deductions. Used for the $1M cumulative threshold test so it matches
   *  the basis stored in supplementalYtd (which is gross_pay from prior
   *  off-cycle runs). */
  grossThisPeriod: number;
  /** FIT-taxable portion of this supplemental payment (gross minus §125
   *  and 401(k) deferrals). This is the amount the 22%/37% rate is applied
   *  to - withholding is done on wages subject to federal income tax. */
  taxableThisPeriod: number;
  /** Cumulative GROSS supplemental wages paid to this employee YTD BEFORE
   *  this run. (Do NOT include regular wages - only prior supplemental
   *  payments, measured on the same gross basis as grossThisPeriod.) */
  supplementalYtd: number;
}

export interface SupplementalFederalResult {
  federalIncomeTax: number;
  /** Taxable portion of this payment withheld at 22%. */
  amountAtFlatRate: number;
  /** Taxable portion of this payment withheld at 37% (above the $1M threshold). */
  amountAtHighRate: number;
}

export function calculateSupplementalFederal(
  input: SupplementalFederalInput,
): SupplementalFederalResult {
  const gross = Math.max(0, input.grossThisPeriod || 0);
  const taxable = Math.max(0, input.taxableThisPeriod || 0);
  const priorYtd = Math.max(0, input.supplementalYtd || 0);

  // Threshold math is always on the GROSS basis so it matches the cumulative
  // YTD bucket. Compute what portion of THIS run's gross is above $1M.
  const cumulativeAfter = priorYtd + gross;
  const overAfter = Math.max(0, cumulativeAfter - SUPPLEMENTAL_HIGH_THRESHOLD);
  const overBefore = Math.max(0, priorYtd - SUPPLEMENTAL_HIGH_THRESHOLD);
  const grossAtHighRate = Math.max(0, overAfter - overBefore);

  // Proportionally map the gross split back onto the TAXABLE base, which is
  // what withholding is actually applied to. Avoids double-counting when
  // §125/401(k) has already pulled wages out of the federal tax base.
  const highFraction = gross > 0 ? grossAtHighRate / gross : 0;
  const amountAtHighRate = taxable * highFraction;
  const amountAtFlatRate = Math.max(0, taxable - amountAtHighRate);

  const tax =
    amountAtFlatRate * SUPPLEMENTAL_FLAT_RATE +
    amountAtHighRate * SUPPLEMENTAL_HIGH_RATE;

  return {
    federalIncomeTax: round2(tax),
    amountAtFlatRate: round2(amountAtFlatRate),
    amountAtHighRate: round2(amountAtHighRate),
  };
}
