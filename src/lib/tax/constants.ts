/**
 * Tax estimator constants.
 *
 * Data lives in @/lib/tax-core (shared with payroll). This file is a thin
 * compatibility shim so existing estimator imports keep working.
 */

import type { TaxYearDefaults } from "@/lib/tax-core";
import { getTaxYearDefaults, getAvailableTaxYears as getCoreYears } from "@/lib/tax-core";

export type { FilingStatus, TaxBracket } from "@/lib/tax-core";
export { FILING_STATUS_LABELS } from "@/lib/tax-core";

/** Estimator-facing alias for the shared year shape. */
export type TaxYearConfig = TaxYearDefaults;

export function getAvailableTaxYears(): number[] {
  return getCoreYears();
}

export function getTaxYearConfig(year: number): TaxYearConfig | undefined {
  return getTaxYearDefaults(year);
}
