/**
 * State tax data shim.
 *
 * Data lives in @/lib/tax-core/states. This file re-exports it so existing
 * estimator/payroll imports keep working.
 */

export type { StateTaxConfig } from "@/lib/tax-core";
export {
  STATE_TAX_DATA,
  STATE_OPTIONS,
  getStateTaxConfig,
} from "@/lib/tax-core";
