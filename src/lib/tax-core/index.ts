/**
 * tax-core: shared tax data + types for estimator and payroll.
 *
 * Public API. Import from "@/lib/tax-core"; do not reach into subpaths
 * directly from feature code (year files and states are structural).
 *
 * Features are independent: the estimator can be removed without breaking
 * payroll, and vice versa. This module owns the numbers both features need.
 */

export type {
  FilingStatus,
  TaxBracket,
  Pub15TBracket,
  Pub15TBracketsByStatus,
  Pub15TPeriod,
  Pub15TTable,
  PayrollFicaDefaults,
  PayrollFutaDefaults,
  PayrollStdDeductions,
  StateTaxConfig,
  TaxYearDefaults,
} from "./types";

export { FILING_STATUS_LABELS } from "./types";

export {
  TAX_YEARS,
  getTaxYearDefaults,
  getAvailableTaxYears,
} from "./years";

export {
  STATE_TAX_DATA,
  STATE_OPTIONS,
  getStateTaxConfig,
} from "./states";
