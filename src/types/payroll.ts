/**
 * Payroll types
 * Mirror the 9 payroll tables defined in 20260417_create_payroll.sql.
 * Shape matches the Database convention used in database.ts
 * (Row / Insert / Update triples + convenience exports).
 */

// ============================================================================
// Enum unions
// ============================================================================

import type { FilingStatus } from "@/lib/tax-core";
export type { FilingStatus };

export type PayFrequency =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "annual";

export type EmploymentType = "w2" | "1099";
export type EmployeeStatus = "active" | "terminated";

export type RunType = "regular" | "off_cycle" | "correction";
export type RunStatus = "draft" | "finalized" | "paid" | "voided";

export type CalculationMethod =
  | "none"
  | "flat"
  | "flat_employee_elected"
  | "progressive"
  | "custom";

export type ConfigChangeType = "organization" | "federal" | "state";

export type DepositType =
  | "federal_941"
  | "federal_940"
  | "state_withholding"
  | "state_suta"
  | "state_sdi";

export type DepositStatus = "scheduled" | "paid" | "late";

/** IRS Pub 15 deposit schedules for Form 941 (income tax + FICA) liabilities. */
export type FederalDepositSchedule = "monthly" | "semiweekly";

/** State withholding deposit schedules. Arizona A1-WP recognizes all three. */
export type StateDepositSchedule = "quarterly" | "monthly" | "semiweekly";

export type PayrollFormType =
  | "941"
  | "940"
  | "w2"
  | "w3"
  | "efw2"
  | "a1_qrt"
  | "a1_apr"
  | "other";

export type PayrollFormStatus = "draft" | "generated" | "filed";

export type PayrollRunEventType =
  | "created"
  | "updated"
  | "finalized"
  | "paid"
  | "voided"
  | "deleted"
  | "restored";

export type PayrollDepositEventType =
  | "created"
  | "amount_changed"
  | "runs_changed"
  | "paid"
  | "unpaid"
  | "marked_late"
  | "note_updated"
  | "deleted"
  | "restored"
  | "updated";

// ============================================================================
// JSONB shape types
// ============================================================================

export interface PayrollAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

// ---- Federal brackets (Pub 15-T percentage method) ----
export interface FederalBracket {
  min: number;
  max: number | null;
  rate: number;
  base_tax: number;
}

export interface FederalBracketsByStatus {
  single: FederalBracket[];
  mfj: FederalBracket[];
  mfs: FederalBracket[];
  hoh: FederalBracket[];
}

/**
 * Pub 15-T Worksheet 1A Step 1j additive. When an employee has W-4 Step 2(c)
 * checked and the config does NOT provide a separate `w4_step2_checked` table,
 * the engine adds this amount to annualized wages before bracket lookup. This
 * is the documented equivalent of using the higher-withholding table.
 * Pub 15-T 2025 values: { mfj: 12900, other: 8600 }.
 */
export interface FederalStep2Additive {
  /** Added when filing_status is "mfj". */
  mfj: number;
  /** Added for single / mfs / hoh. */
  other: number;
}

export interface FederalBrackets {
  period: "annual" | "weekly" | "biweekly" | "semimonthly" | "monthly";
  source: string;
  w4_step2_unchecked: FederalBracketsByStatus;
  w4_step2_checked?: FederalBracketsByStatus;
  step2_additive?: FederalStep2Additive;
}

// ---- Federal FICA / FUTA / standard deductions ----
export interface FicaConfig {
  ss_rate: number;
  ss_wage_base: number;
  medicare_rate: number;
  additional_medicare_rate: number;
  additional_medicare_threshold: number;
}

export interface FutaConfig {
  /** Net FUTA rate for the normal (non-reduced) case. The IRS headline
   *  rate is 6.0% but employers in states that are current on their
   *  Title XII advances get a 5.4% credit, so effective is 0.6%. */
  rate: number;
  wage_base: number;
  /** States designated by DOL as "credit-reduction" for this tax year
   *  have their 5.4% credit trimmed. An employer in such a state pays
   *  (rate + reduction) on the same wage base. Keyed by state code. AZ
   *  is never on this list; entries only matter if the org ever hires
   *  out-of-state. Omit or leave empty when no state is affected. */
  credit_reduction_states?: Record<string, number>;
}

export interface StdDeductions {
  single: number;
  mfj: number;
  mfs: number;
  hoh: number;
}

// ---- State tax config variants (polymorphic, keyed by calculation_method) ----
export interface StateConfigNone {
  notes?: string;
}

export interface StateConfigFlat {
  rate: number;
  form?: string;
  notes?: string;
}

/** AZ shape: employee picks an A-4 rate; actualTaxRate is the real flat rate. */
export interface StateConfigFlatEmployeeElected {
  actualTaxRate: number;
  rates: number[];
  defaultRate: number;
  form?: string;
  notes?: string;
}

export interface StateBracket {
  min: number;
  max: number | null;
  rate: number;
  base_tax: number;
}

export interface StateConfigProgressive {
  period: "annual";
  brackets: {
    single: StateBracket[];
    mfj?: StateBracket[];
    mfs?: StateBracket[];
    hoh?: StateBracket[];
  };
  std_deduction?: Partial<StdDeductions>;
  form?: string;
  notes?: string;
}

export interface StateConfigCustom {
  [key: string]: unknown;
}

export type StateConfigPayload =
  | StateConfigNone
  | StateConfigFlat
  | StateConfigFlatEmployeeElected
  | StateConfigProgressive
  | StateConfigCustom;

export interface StateSdiConfig {
  rate?: number;
  wage_base?: number;
  side?: "employee" | "employer" | "both";
}

export interface StateSutaConfig {
  newEmployerRate?: number;
  wageBase?: number;
  rangeMin?: number;
  rangeMax?: number;
  formsDue?: string[];
}

/**
 * Payment portal metadata for a single state deposit type. Used by the
 * deposits UI to render "Pay at [portal]" deep links with per-state
 * instructions. Federal deposits (941/940) use EFTPS, which is hardcoded
 * in the UI since it's universal.
 */
export interface StatePaymentPortal {
  /** Short portal label, e.g. "AZTaxes", "AZ DES Tax", "EDD e-Services". */
  portal: string;
  /** Full agency name, shown in the expanded instructions header. */
  agency: string;
  /** External URL opened when the admin clicks "Pay at [portal]". */
  url: string;
  /** Agency form code the admin should select in the portal (e.g. "A1-WP"). */
  form: string;
  /** Step-by-step actions the admin follows inside the portal. */
  steps: string[];
}

/**
 * Per-deposit-type payment portal map stored on state_tax_configs. Keys are
 * the matching DepositType values; a null value means the state doesn't
 * participate in that deposit type (e.g. AZ has no state_sdi).
 */
export interface StatePaymentPortals {
  state_withholding?: StatePaymentPortal | null;
  state_suta?: StatePaymentPortal | null;
  state_sdi?: StatePaymentPortal | null;
}

// ---- Employee state-level withholding election ----
/** Shape matches state_tax_configs.calculation_method for the employee's state. */
export interface EmployeeStateElectionFlat {
  rate?: number;
  extra_withholding?: number;
}

export interface EmployeeStateElectionFlatEmployeeElected {
  rate: number;
  dependents?: number;
  extra_withholding?: number;
}

export interface EmployeeStateElectionProgressive {
  filing_status?: FilingStatus;
  allowances?: number;
  extra_withholding?: number;
}

export type EmployeeStateElection =
  | EmployeeStateElectionFlat
  | EmployeeStateElectionFlatEmployeeElected
  | EmployeeStateElectionProgressive
  | Record<string, unknown>;

// ---- Run-level ----
/**
 * Withholding category drives which tax bases the deduction reduces:
 *   - post_tax: reduces net pay only; does not reduce any tax base.
 *   - pre_tax_401k: reduces FIT + SIT taxable wages. Does NOT reduce
 *     FICA (SS/Medicare) or FUTA/SUTA. Per IRS Pub 15.
 *   - pre_tax_125: Section 125 cafeteria plan (most health/dental/vision
 *     premiums, FSA, HSA contributions made via cafeteria plan). Reduces
 *     FIT, SIT, FICA, FUTA, and SUTA wages.
 *
 * Missing category is treated as post_tax for backward compatibility
 * with runs finalized before pre-tax support was added.
 */
export type WithholdingCategory = "post_tax" | "pre_tax_401k" | "pre_tax_125";

export const WITHHOLDING_CATEGORY_LABELS: Record<WithholdingCategory, string> = {
  post_tax: "Post-tax (e.g. garnishment, Roth 401k)",
  pre_tax_401k: "Pre-tax 401(k) / 403(b) / 457",
  pre_tax_125: "Pre-tax §125 (health, HSA via cafeteria, FSA)",
};

export interface WithholdingLineItem {
  id: string;
  label: string;
  amount: number;
  /** Tax treatment of this deduction. Defaults to post_tax when absent. */
  category?: WithholdingCategory;
  /** @deprecated Retained for legacy rows; engine ignores in favor of
   *  `category`. New code should set `category` and leave this as false. */
  taxable: boolean;
  notes?: string;
}

/**
 * Frozen copies of config/employee rows at finalize time.
 * Typed as opaque records because the shape is whatever the row looked
 * like when the run was finalized; treat them as read-only snapshots.
 * For runtime use, cast to PayrollEmployee / FederalTaxConfig / etc.
 */
export type EmployeeSnapshot = Record<string, unknown>;
export type FederalConfigSnapshot = Record<string, unknown>;
export type StateConfigSnapshot = Record<string, unknown>;
export type OrganizationSnapshot = Record<string, unknown>;

// ============================================================================
// Form data shapes (payroll_forms.form_data)
// ============================================================================

export interface Form941Data {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
  line_1_employees: number;
  line_2_wages: number;
  line_3_federal_income_tax: number;
  line_5a_ss_wages: number;
  line_5a_ss_tax: number;
  line_5c_medicare_wages: number;
  line_5c_medicare_tax: number;
  line_5d_additional_medicare_wages: number;
  line_5d_additional_medicare_tax: number;
  line_5e_total_ss_medicare: number;
  line_6_total_taxes_before_adjustments: number;
  /** Fractions-of-cents adjustment: aggregate FICA per Line 5e minus the sum
   *  of per-paycheck rounded FICA. Usually a few cents. Admin can override. */
  line_7_fractions_of_cents: number;
  line_10_total_taxes_after_adjustments: number;
  line_12_total_taxes: number;
  line_13a_total_deposits: number;
  line_14_balance_due: number;
  line_15_overpayment: number;
  deposit_schedule: "monthly" | "semiweekly";
  /** Present only for monthly depositors (Line 16 Box B). Sums to Line 12. */
  monthly_liability?: { month1: number; month2: number; month3: number };
  /** Present only for semiweekly depositors (Schedule B / Line 16 Box C).
   *  One entry per day of the quarter on which 941 liability was incurred. */
  schedule_b?: Array<{ date: string; amount: number }>;
}

export interface Form940Data {
  tax_year: number;
  line_3_total_payments: number;
  line_4_payments_exempt: number;
  line_5_payments_over_7000: number;
  line_7_total_taxable: number;
  line_8_futa_before_adjustments: number;
  line_12_futa_after_adjustments: number;
  line_14_balance_due: number;
  line_15_overpayment: number;
  quarterly_liability?: { q1: number; q2: number; q3: number; q4: number };
}

export interface FormW2Data {
  tax_year: number;
  employee_id: string;
  /** Employee name as it appeared on the pay-date snapshot. */
  employee_name: string;
  /** Last 4 of SSN if available, for cross-check display only. */
  employee_ssn_last4?: string;
  box_1_wages: number;
  box_2_federal_income_tax: number;
  box_3_ss_wages: number;
  box_4_ss_tax: number;
  box_5_medicare_wages: number;
  box_6_medicare_tax: number;
  /** Box 12 codes. D = pre-tax 401(k). DD = employer health coverage cost.
   *  We only populate D from the per-run withholdings today; admin can add
   *  more after generating via the viewer. */
  box_12?: Array<{ code: string; amount: number }>;
  /** Cafeteria-plan (§125) reductions to taxable wages. Tracked for
   *  reference; Box 1 already excludes them. */
  box_14_section_125?: number;
  /** Primary state (single-state employees) OR first state for display.
   *  Multi-state detail lives on `states`. */
  box_15_state: string;
  /** Primary/aggregate state wages. For single-state employees this equals
   *  `states[0].wages`; for multi-state it equals the sum across `states`. */
  box_16_state_wages: number;
  /** Primary/aggregate state income tax. For single-state equals
   *  `states[0].tax`; for multi-state equals the sum across `states`. */
  box_17_state_income_tax: number;
  /** Per-state breakdown. Always populated (length >= 1 when any run has a
   *  resolvable state). IRS W-2 supports up to two states on one form; a
   *  third state requires a supplemental form. When `length > 2` the
   *  aggregator emits a warning so the admin can split the W-2 manually. */
  states: Array<{
    code: string;
    wages: number;
    tax: number;
  }>;
  box_18_local_wages?: number;
  box_19_local_income_tax?: number;
  box_20_locality?: string;
}

export interface FormW3Data {
  tax_year: number;
  /** Count of W-2 forms included in this transmittal (Box c). */
  w2_count: number;
  /** Sum of Box 1 from all W-2s. */
  box_1_wages: number;
  /** Sum of Box 2 from all W-2s. */
  box_2_federal_income_tax: number;
  /** Sum of Box 3 from all W-2s. */
  box_3_ss_wages: number;
  /** Sum of Box 4 from all W-2s. */
  box_4_ss_tax: number;
  /** Sum of Box 5 from all W-2s. */
  box_5_medicare_wages: number;
  /** Sum of Box 6 from all W-2s. */
  box_6_medicare_tax: number;
  /** Sum of Box 12 D (elective deferrals). */
  box_12_d_elective_deferrals: number;
  /** Sum of Box 16 state wages across all W-2s, all states. */
  box_16_state_wages: number;
  /** Sum of Box 17 state income tax across all W-2s, all states. */
  box_17_state_income_tax: number;
  /** Per-state breakdown for state-specific reconciliations (e.g., AZ
   *  A1-APR Line B). Aggregated from the `states` arrays on each W-2.
   *  Always populated when any W-2 has resolvable state data. */
  states: Array<{
    code: string;
    wages: number;
    tax: number;
  }>;
}

export interface FormA1QrtData {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Count of employees paid in the quarter. */
  employees: number;
  /** Total Arizona wages paid in the quarter (sum of gross per run). */
  total_az_wages: number;
  /** Line A: total Arizona income tax withheld during the quarter. */
  line_a_az_tax_withheld: number;
  /** Line B: total Arizona income tax deposited (form A1-WP / AZTaxes). */
  line_b_az_tax_paid: number;
  /** Line C (overpayment): max(0, B - A). */
  line_c_overpayment: number;
  /** Line D (balance due): max(0, A - B). */
  line_d_balance_due: number;
  /** Deposit schedule in effect for this quarter. */
  deposit_schedule: StateDepositSchedule;
  /** Monthly breakdown when deposit_schedule is 'monthly'. */
  monthly_liability?: { month1: number; month2: number; month3: number };
  /** Per-pay-date liability when deposit_schedule is 'semiweekly'
   *  (Schedule A on AZ A1-QRT). */
  schedule_a?: Array<{ date: string; amount: number }>;
}

export interface FormA1AprData {
  tax_year: number;
  /** Total Arizona wages across all four quarters. */
  total_az_wages: number;
  /** Total Arizona income tax withheld (W-2 Box 17 aggregate). */
  total_az_withheld: number;
  /** Sum of Line A across all four A1-QRTs. */
  a1_qrt_line_a_sum: number;
  /** Sum of Line B across all four A1-QRTs. */
  a1_qrt_line_b_sum: number;
  /** Reconciliation adjustment: total_az_withheld - a1_qrt_line_a_sum.
   *  Non-zero when quarterly returns under/over-reported. */
  adjustment: number;
  /** Per-quarter breakdown for the reconciliation table. */
  quarterly: {
    q1: { wages: number; withheld: number; reported: number; deposited: number };
    q2: { wages: number; withheld: number; reported: number; deposited: number };
    q3: { wages: number; withheld: number; reported: number; deposited: number };
    q4: { wages: number; withheld: number; reported: number; deposited: number };
  };
  /** Count of W-2s attached. */
  w2_count: number;
  /** Total employees paid at any point during the year. */
  total_employees: number;
}

export type PayrollFormData =
  | Form941Data
  | Form940Data
  | FormW2Data
  | FormW3Data
  | FormA1QrtData
  | FormA1AprData
  | Record<string, unknown>;

// ============================================================================
// Tables (Row / Insert / Update)
// ============================================================================

export type PayrollDatabase = {
  public: {
    Tables: {
      organization_config: {
        Row: {
          id: string;
          legal_name: string;
          fein: string;
          state_tax_id: string | null;
          state_ui_id: string | null;
          address: PayrollAddress | Record<string, never>;
          signer_name: string;
          signer_title: string | null;
          phone: string | null;
          email: string | null;
          accountant_email: string | null;
          default_email_account_id: string | null;
          federal_deposit_schedule: FederalDepositSchedule;
          state_deposit_schedule: StateDepositSchedule;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          legal_name: string;
          fein: string;
          state_tax_id?: string | null;
          state_ui_id?: string | null;
          address?: PayrollAddress | Record<string, never>;
          signer_name: string;
          signer_title?: string | null;
          phone?: string | null;
          email?: string | null;
          accountant_email?: string | null;
          default_email_account_id?: string | null;
          federal_deposit_schedule?: FederalDepositSchedule;
          state_deposit_schedule?: StateDepositSchedule;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          legal_name?: string;
          fein?: string;
          state_tax_id?: string | null;
          state_ui_id?: string | null;
          address?: PayrollAddress | Record<string, never>;
          signer_name?: string;
          signer_title?: string | null;
          phone?: string | null;
          email?: string | null;
          accountant_email?: string | null;
          default_email_account_id?: string | null;
          federal_deposit_schedule?: FederalDepositSchedule;
          state_deposit_schedule?: StateDepositSchedule;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      federal_tax_configs: {
        Row: {
          id: string;
          tax_year: number;
          brackets: FederalBrackets;
          fica: FicaConfig;
          futa: FutaConfig;
          std_deductions: StdDeductions;
          version_hash: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tax_year: number;
          brackets: FederalBrackets;
          fica: FicaConfig;
          futa: FutaConfig;
          std_deductions: StdDeductions;
          version_hash: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tax_year?: number;
          brackets?: FederalBrackets;
          fica?: FicaConfig;
          futa?: FutaConfig;
          std_deductions?: StdDeductions;
          version_hash?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      state_tax_configs: {
        Row: {
          id: string;
          state_code: string;
          tax_year: number;
          calculation_method: CalculationMethod;
          config: StateConfigPayload;
          sdi_config: StateSdiConfig | Record<string, never>;
          suta_config: StateSutaConfig | Record<string, never>;
          payment_portals: StatePaymentPortals | Record<string, never>;
          version_hash: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          state_code: string;
          tax_year: number;
          calculation_method: CalculationMethod;
          config?: StateConfigPayload;
          sdi_config?: StateSdiConfig | Record<string, never>;
          suta_config?: StateSutaConfig | Record<string, never>;
          payment_portals?: StatePaymentPortals | Record<string, never>;
          version_hash: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          state_code?: string;
          tax_year?: number;
          calculation_method?: CalculationMethod;
          config?: StateConfigPayload;
          sdi_config?: StateSdiConfig | Record<string, never>;
          suta_config?: StateSutaConfig | Record<string, never>;
          payment_portals?: StatePaymentPortals | Record<string, never>;
          version_hash?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      config_change_history: {
        Row: {
          id: string;
          config_type: ConfigChangeType;
          config_id: string;
          changed_at: string;
          old_values: Record<string, unknown> | null;
          new_values: Record<string, unknown> | null;
          change_summary: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          config_type: ConfigChangeType;
          config_id: string;
          changed_at?: string;
          old_values?: Record<string, unknown> | null;
          new_values?: Record<string, unknown> | null;
          change_summary?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          config_type?: ConfigChangeType;
          config_id?: string;
          changed_at?: string;
          old_values?: Record<string, unknown> | null;
          new_values?: Record<string, unknown> | null;
          change_summary?: string | null;
          created_at?: string;
        };
      };
      payroll_employees: {
        Row: {
          id: string;
          first_name: string;
          last_name: string;
          email: string | null;
          phone: string | null;
          address: PayrollAddress | Record<string, never>;
          ssn_encrypted: string | null;
          ssn_key_version: number | null;
          employment_type: EmploymentType;
          hire_date: string;
          termination_date: string | null;
          status: EmployeeStatus;
          pay_amount: number;
          pay_frequency: PayFrequency;
          pay_anchor_date: string;
          semimonthly_days: number[] | null;
          monthly_day: number | null;
          pay_lag_days: number;
          target_annual_comp: number | null;
          w4_filing_status: FilingStatus;
          w4_multiple_jobs: boolean;
          w4_exempt: boolean;
          w4_dependents_amount: number;
          w4_other_income: number;
          w4_deductions: number;
          w4_extra_withholding: number;
          state_code: string;
          state_config: EmployeeStateElection;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          first_name: string;
          last_name: string;
          email?: string | null;
          phone?: string | null;
          address?: PayrollAddress | Record<string, never>;
          ssn_encrypted?: string | null;
          ssn_key_version?: number | null;
          employment_type?: EmploymentType;
          hire_date: string;
          termination_date?: string | null;
          status?: EmployeeStatus;
          pay_amount: number;
          pay_frequency: PayFrequency;
          pay_anchor_date: string;
          semimonthly_days?: number[] | null;
          monthly_day?: number | null;
          pay_lag_days?: number;
          target_annual_comp?: number | null;
          w4_filing_status?: FilingStatus;
          w4_multiple_jobs?: boolean;
          w4_exempt?: boolean;
          w4_dependents_amount?: number;
          w4_other_income?: number;
          w4_deductions?: number;
          w4_extra_withholding?: number;
          state_code: string;
          state_config?: EmployeeStateElection;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          first_name?: string;
          last_name?: string;
          email?: string | null;
          phone?: string | null;
          address?: PayrollAddress | Record<string, never>;
          ssn_encrypted?: string | null;
          ssn_key_version?: number | null;
          employment_type?: EmploymentType;
          hire_date?: string;
          termination_date?: string | null;
          status?: EmployeeStatus;
          pay_amount?: number;
          pay_frequency?: PayFrequency;
          pay_anchor_date?: string;
          semimonthly_days?: number[] | null;
          monthly_day?: number | null;
          pay_lag_days?: number;
          target_annual_comp?: number | null;
          w4_filing_status?: FilingStatus;
          w4_multiple_jobs?: boolean;
          w4_exempt?: boolean;
          w4_dependents_amount?: number;
          w4_other_income?: number;
          w4_deductions?: number;
          w4_extra_withholding?: number;
          state_code?: string;
          state_config?: EmployeeStateElection;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      payroll_runs: {
        Row: {
          id: string;
          employee_id: string;
          run_type: RunType;
          status: RunStatus;
          period_start: string;
          period_end: string;
          pay_date: string;
          gross_pay: number;
          federal_income_tax: number;
          state_income_tax: number;
          social_security_employee: number;
          medicare_employee: number;
          additional_medicare: number;
          state_disability_employee: number;
          other_withholdings: WithholdingLineItem[];
          net_pay: number;
          social_security_employer: number;
          medicare_employer: number;
          futa: number;
          suta: number;
          state_disability_employer: number;
          social_security_wages: number;
          medicare_wages: number;
          additional_medicare_wages: number;
          futa_wages: number;
          suta_wages: number;
          state_taxable_wages: number;
          employee_snapshot: EmployeeSnapshot | null;
          federal_config_snapshot: FederalConfigSnapshot | null;
          state_config_snapshot: StateConfigSnapshot | null;
          organization_snapshot: OrganizationSnapshot | null;
          finalized_at: string | null;
          paid_at: string | null;
          payment_method: string | null;
          payment_reference: string | null;
          reverses_run_id: string | null;
          void_reason: string | null;
          ytd_stale: boolean;
          ytd_stale_reason: string | null;
          stub_sent_at: string | null;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          employee_id: string;
          run_type?: RunType;
          status?: RunStatus;
          period_start: string;
          period_end: string;
          pay_date: string;
          gross_pay: number;
          federal_income_tax?: number;
          state_income_tax?: number;
          social_security_employee?: number;
          medicare_employee?: number;
          additional_medicare?: number;
          state_disability_employee?: number;
          other_withholdings?: WithholdingLineItem[];
          net_pay: number;
          social_security_employer?: number;
          medicare_employer?: number;
          futa?: number;
          suta?: number;
          state_disability_employer?: number;
          social_security_wages?: number;
          medicare_wages?: number;
          additional_medicare_wages?: number;
          futa_wages?: number;
          suta_wages?: number;
          state_taxable_wages?: number;
          employee_snapshot?: EmployeeSnapshot | null;
          federal_config_snapshot?: FederalConfigSnapshot | null;
          state_config_snapshot?: StateConfigSnapshot | null;
          organization_snapshot?: OrganizationSnapshot | null;
          finalized_at?: string | null;
          paid_at?: string | null;
          payment_method?: string | null;
          payment_reference?: string | null;
          reverses_run_id?: string | null;
          void_reason?: string | null;
          ytd_stale?: boolean;
          ytd_stale_reason?: string | null;
          stub_sent_at?: string | null;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          employee_id?: string;
          run_type?: RunType;
          status?: RunStatus;
          period_start?: string;
          period_end?: string;
          pay_date?: string;
          gross_pay?: number;
          federal_income_tax?: number;
          state_income_tax?: number;
          social_security_employee?: number;
          medicare_employee?: number;
          additional_medicare?: number;
          state_disability_employee?: number;
          other_withholdings?: WithholdingLineItem[];
          net_pay?: number;
          social_security_employer?: number;
          medicare_employer?: number;
          futa?: number;
          suta?: number;
          state_disability_employer?: number;
          social_security_wages?: number;
          medicare_wages?: number;
          additional_medicare_wages?: number;
          futa_wages?: number;
          suta_wages?: number;
          state_taxable_wages?: number;
          employee_snapshot?: EmployeeSnapshot | null;
          federal_config_snapshot?: FederalConfigSnapshot | null;
          state_config_snapshot?: StateConfigSnapshot | null;
          organization_snapshot?: OrganizationSnapshot | null;
          finalized_at?: string | null;
          paid_at?: string | null;
          payment_method?: string | null;
          payment_reference?: string | null;
          reverses_run_id?: string | null;
          void_reason?: string | null;
          ytd_stale?: boolean;
          ytd_stale_reason?: string | null;
          stub_sent_at?: string | null;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      payroll_run_history: {
        Row: {
          id: string;
          run_id: string;
          event_type: PayrollRunEventType;
          status: RunStatus;
          gross_pay: number;
          net_pay: number;
          changed_at: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          run_id: string;
          event_type: PayrollRunEventType;
          status: RunStatus;
          gross_pay: number;
          net_pay: number;
          changed_at?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          run_id?: string;
          event_type?: PayrollRunEventType;
          status?: RunStatus;
          gross_pay?: number;
          net_pay?: number;
          changed_at?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
        };
      };
      payroll_tax_deposits: {
        Row: {
          id: string;
          deposit_type: DepositType;
          period_start: string;
          period_end: string;
          due_date: string;
          amount: number;
          status: DepositStatus;
          paid_at: string | null;
          payment_reference: string | null;
          included_run_ids: string[];
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          deposit_type: DepositType;
          period_start: string;
          period_end: string;
          due_date: string;
          amount: number;
          status?: DepositStatus;
          paid_at?: string | null;
          payment_reference?: string | null;
          included_run_ids?: string[];
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          deposit_type?: DepositType;
          period_start?: string;
          period_end?: string;
          due_date?: string;
          amount?: number;
          status?: DepositStatus;
          paid_at?: string | null;
          payment_reference?: string | null;
          included_run_ids?: string[];
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      payroll_deposit_history: {
        Row: {
          id: string;
          deposit_id: string;
          event_type: PayrollDepositEventType;
          status: DepositStatus;
          amount: number;
          before_snapshot: Record<string, unknown> | null;
          after_snapshot: Record<string, unknown> | null;
          changed_by: string | null;
          changed_at: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          deposit_id: string;
          event_type: PayrollDepositEventType;
          status: DepositStatus;
          amount: number;
          before_snapshot?: Record<string, unknown> | null;
          after_snapshot?: Record<string, unknown> | null;
          changed_by?: string | null;
          changed_at?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
        };
      };
      payroll_forms: {
        Row: {
          id: string;
          form_type: PayrollFormType;
          tax_year: number;
          quarter: number | null;
          employee_id: string | null;
          status: PayrollFormStatus;
          form_data: PayrollFormData;
          generated_at: string | null;
          filed_at: string | null;
          confirmation_number: string | null;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          form_type: PayrollFormType;
          tax_year: number;
          quarter?: number | null;
          employee_id?: string | null;
          status?: PayrollFormStatus;
          form_data?: PayrollFormData;
          generated_at?: string | null;
          filed_at?: string | null;
          confirmation_number?: string | null;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          form_type?: PayrollFormType;
          tax_year?: number;
          quarter?: number | null;
          employee_id?: string | null;
          status?: PayrollFormStatus;
          form_data?: PayrollFormData;
          generated_at?: string | null;
          filed_at?: string | null;
          confirmation_number?: string | null;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
  };
};

// ============================================================================
// Convenience exports
// ============================================================================

export type OrganizationConfig =
  PayrollDatabase["public"]["Tables"]["organization_config"]["Row"];
export type OrganizationConfigInsert =
  PayrollDatabase["public"]["Tables"]["organization_config"]["Insert"];
export type OrganizationConfigUpdate =
  PayrollDatabase["public"]["Tables"]["organization_config"]["Update"];

export type FederalTaxConfig =
  PayrollDatabase["public"]["Tables"]["federal_tax_configs"]["Row"];
export type FederalTaxConfigInsert =
  PayrollDatabase["public"]["Tables"]["federal_tax_configs"]["Insert"];
export type FederalTaxConfigUpdate =
  PayrollDatabase["public"]["Tables"]["federal_tax_configs"]["Update"];

export type StateTaxConfig =
  PayrollDatabase["public"]["Tables"]["state_tax_configs"]["Row"];
export type StateTaxConfigInsert =
  PayrollDatabase["public"]["Tables"]["state_tax_configs"]["Insert"];
export type StateTaxConfigUpdate =
  PayrollDatabase["public"]["Tables"]["state_tax_configs"]["Update"];

export type ConfigChangeHistory =
  PayrollDatabase["public"]["Tables"]["config_change_history"]["Row"];
export type ConfigChangeHistoryInsert =
  PayrollDatabase["public"]["Tables"]["config_change_history"]["Insert"];

export type PayrollEmployee =
  PayrollDatabase["public"]["Tables"]["payroll_employees"]["Row"];
export type PayrollEmployeeInsert =
  PayrollDatabase["public"]["Tables"]["payroll_employees"]["Insert"];
export type PayrollEmployeeUpdate =
  PayrollDatabase["public"]["Tables"]["payroll_employees"]["Update"];

export type PayrollRun =
  PayrollDatabase["public"]["Tables"]["payroll_runs"]["Row"];
export type PayrollRunInsert =
  PayrollDatabase["public"]["Tables"]["payroll_runs"]["Insert"];
export type PayrollRunUpdate =
  PayrollDatabase["public"]["Tables"]["payroll_runs"]["Update"];

export type PayrollRunHistory =
  PayrollDatabase["public"]["Tables"]["payroll_run_history"]["Row"];
export type PayrollRunHistoryInsert =
  PayrollDatabase["public"]["Tables"]["payroll_run_history"]["Insert"];

export type PayrollTaxDeposit =
  PayrollDatabase["public"]["Tables"]["payroll_tax_deposits"]["Row"];
export type PayrollTaxDepositInsert =
  PayrollDatabase["public"]["Tables"]["payroll_tax_deposits"]["Insert"];
export type PayrollTaxDepositUpdate =
  PayrollDatabase["public"]["Tables"]["payroll_tax_deposits"]["Update"];

export type PayrollDepositHistory =
  PayrollDatabase["public"]["Tables"]["payroll_deposit_history"]["Row"];
export type PayrollDepositHistoryInsert =
  PayrollDatabase["public"]["Tables"]["payroll_deposit_history"]["Insert"];

export type PayrollForm =
  PayrollDatabase["public"]["Tables"]["payroll_forms"]["Row"];
export type PayrollFormInsert =
  PayrollDatabase["public"]["Tables"]["payroll_forms"]["Insert"];
export type PayrollFormUpdate =
  PayrollDatabase["public"]["Tables"]["payroll_forms"]["Update"];

// ============================================================================
// Extended types with joins
// ============================================================================

export type PayrollEmployeeWithRuns = PayrollEmployee & {
  payroll_runs: PayrollRun[];
};

export type PayrollRunWithEmployee = PayrollRun & {
  payroll_employees: PayrollEmployee;
};

/** Shape returned by the runs list page: narrows the joined employee to the
 *  fields needed for display so SSNs and other sensitive columns never leave
 *  the server. */
export type PayrollRunListItem = PayrollRun & {
  payroll_employees: Pick<
    PayrollEmployee,
    "id" | "first_name" | "last_name"
  > | null;
};

export type PayrollRunWithHistory = PayrollRun & {
  payroll_run_history: PayrollRunHistory[];
};

// ============================================================================
// UI labels
// ============================================================================

export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Semi-monthly",
  monthly: "Monthly",
  annual: "Annual",
};

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  mfj: "Married filing jointly",
  mfs: "Married filing separately",
  hoh: "Head of household",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: "Draft",
  finalized: "Finalized",
  paid: "Paid",
  voided: "Voided",
};

export const RUN_TYPE_LABELS: Record<RunType, string> = {
  regular: "Regular",
  off_cycle: "Off-cycle",
  correction: "Correction",
};

export const CALCULATION_METHOD_LABELS: Record<CalculationMethod, string> = {
  none: "No state income tax",
  flat: "Flat rate",
  flat_employee_elected: "Employee-elected flat rate",
  progressive: "Progressive brackets",
  custom: "Custom",
};

export const DEPOSIT_TYPE_LABELS: Record<DepositType, string> = {
  federal_941: "Federal withholding & FICA",
  federal_940: "FUTA",
  state_withholding: "State withholding",
  state_suta: "SUTA",
  state_sdi: "SDI",
};

export const PAYROLL_FORM_TYPE_LABELS: Record<PayrollFormType, string> = {
  "941": "Form 941",
  "940": "Form 940",
  w2: "W-2",
  w3: "W-3",
  efw2: "EFW2",
  a1_qrt: "AZ A-1-QRT",
  a1_apr: "AZ A-1-APR",
  other: "Other",
};
