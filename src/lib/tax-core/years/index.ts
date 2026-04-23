/**
 * Tax year registry.
 *
 * To add a new year: create `./<year>.ts`, import it here, and register it
 * in the TAX_YEARS map. All estimator + payroll defaults will pick it up.
 */

import type { TaxYearDefaults } from "../types";
import { TAX_YEAR_2025 } from "./2025";
import { TAX_YEAR_2026 } from "./2026";

export const TAX_YEARS: Record<number, TaxYearDefaults> = {
  2025: TAX_YEAR_2025,
  2026: TAX_YEAR_2026,
};

export function getTaxYearDefaults(year: number): TaxYearDefaults | undefined {
  return TAX_YEARS[year];
}

export function getAvailableTaxYears(): number[] {
  return Object.keys(TAX_YEARS)
    .map(Number)
    .sort((a, b) => b - a);
}
