/**
 * The shapes the Tax Estimator page hands to its cards and sheet.
 *
 * `EstimatorModel` is data (rows, the calculation, the schedule, the books
 * refresh state). `EstimatorActions` is every mutation, wrapped so children
 * never hold raw setters and every change goes through the page's dirty
 * tracking and autosave.
 */
import type { FilingStatus, TaxYearConfig } from "@/lib/tax/constants";
import type { FullTaxBreakdown } from "@/lib/tax/calculations";
import type { MeterSegments, PaymentSchedule, QuarterKey } from "@/lib/tax/payment-schedule";
import type {
  BusinessType,
  IncomeType,
  TaxCapitalGainEntry,
  TaxClassification,
  TaxIncomeSource,
  TaxPaymentEntry,
} from "@/types/database";

export type EditTarget =
  | { mode: "income" | "gain" | "withholding" | "payment"; id: string }
  | { mode: "household" }
  | { mode: "notes" }
  | { mode: "profile" }
  | { mode: "add-income" }
  | { mode: "add-paid" };

/** The steps the guided setup walks a thin year through. */
export type GuideStepKey = "profile" | "income" | "paid" | "household";

export interface Household {
  dependents: number;
  otherDependents: number;
  additionalDeductions: number;
  additionalCredits: number;
  taxpayerAge65: boolean;
  taxpayerBlind: boolean;
  spouseAge65: boolean;
  spouseBlind: boolean;
  isSstb: boolean;
  businessW2Wages: number;
  businessPropertyBasis: number;
}

/** What the page knows about rows that come from the accounting books. */
export interface BooksState {
  /** Accounting is reachable for this session (never in demo mode). */
  available: boolean;
  status: "idle" | "loading" | "error";
  /** Cutoff of the last successful refresh. */
  through: string | null;
  error: string;
  /** Rows whose figure moved on the last refresh. */
  moved: { id: string; name: string; from: number; to: number }[];
  /** Rows the last refresh could not update; their values were kept. */
  problems: string[];
  /** Bank and imported activity still waiting for a category; not in the figures. */
  unreviewed: number;
}

export interface EstimatorModel {
  year: number;
  /** `YYYY-MM-DD` in the books timezone, fixed for the session. */
  today: string;
  filingStatus: FilingStatus;
  state: string | null;
  businessType: BusinessType | null;
  taxClassification: TaxClassification | null;
  taxConfig: TaxYearConfig;
  incomeSources: TaxIncomeSource[];
  capitalGains: TaxCapitalGainEntry[];
  payments: TaxPaymentEntry[];
  household: Household;
  showQbiLimitInputs: boolean;
  notes: string;
  breakdown: FullTaxBreakdown;
  schedule: PaymentSchedule;
  meter: MeterSegments;
  books: BooksState;
  /** The IRS annualized instalment for the next deadline, beside the tax so far. */
  annualized: AnnualizedState | null;
}

/**
 * What must be in by the next deadline under the annualized income method:
 * income through the period, scaled to a year, taxed, times the period's
 * cumulative share, less what is already paid. No forecast anywhere.
 */
export type AnnualizedState =
  | {
      kind: "ready";
      quarter: QuarterKey;
      /** Last day of income counted, `YYYY-MM-DD`. */
      through: string;
      /** The period has not closed yet, so the figure grows until it does. */
      partial: boolean;
      /** The penalty-free minimum: the period's share at the 90% rule. */
      federal: number;
      state: number;
      /** The same instalment without the cushion, a quarter of the year per deadline. */
      full: { federal: number; state: number };
      /** Cumulative share of the annualized tax due by this deadline (0.225 to 0.9). */
      share: number;
      /** The cumulative share without the cushion (0.25 to 1). */
      paceShare: number;
      /** The deadline after this one, where an unpaid shortfall stops accruing. */
      following: string;
      /** How far the actual figure falls short, and roughly what that costs until the next deadline. */
      shortfall: { federal: number; state: number; cost: number } | null;
    }
  | { kind: "unavailable"; reason: string };

export interface EstimatorActions {
  income: {
    /** Appends an empty row and returns its id so the caller can open it. */
    add: () => string;
    /** Appends template rows (plus their W-2 withholding) and returns the first id. */
    addTemplates: (rows: TaxIncomeSource[]) => string | null;
    update: (
      id: string,
      field: keyof TaxIncomeSource,
      value: string | number | boolean,
    ) => void;
    remove: (id: string) => void;
    unlink: (id: string) => void;
    relink: (id: string) => void;
    setType: (id: string, type: IncomeType) => void;
    toggleSe: (id: string) => void;
    toggleMaterialParticipation: (id: string) => void;
    toggleTaxpayer: (id: string) => void;
    canHaveSeToggle: (type: IncomeType) => boolean;
    /** Books rows: the owner's rest-of-year amount; the row amount follows. */
    setRest: (id: string, rest: number) => void;
    /** Drops the books link and keeps the amount as a manual figure. */
    unlinkBooks: (id: string) => void;
  };
  gains: {
    add: () => string;
    update: (
      id: string,
      field: keyof TaxCapitalGainEntry,
      value: string | number,
    ) => void;
    remove: (id: string) => void;
    setRest: (id: string, rest: number) => void;
    unlinkBooks: (id: string) => void;
  };
  payments: {
    addWithholding: () => string;
    addPayment: (preset?: Partial<TaxPaymentEntry>) => string;
    update: (
      id: string,
      field: keyof TaxPaymentEntry,
      value: string | number,
    ) => void;
    remove: (id: string) => void;
    setRest: (id: string, rest: number) => void;
    unlinkBooks: (id: string) => void;
  };
  setHousehold: (patch: Partial<Household>) => void;
  /** Filing status and state. Business structure stays with tax settings. */
  setProfile: (patch: { filingStatus?: FilingStatus; state?: string | null }) => void;
  setNotes: (value: string) => void;
  openImport: () => void;
  /** Opens the "From your books" picker. */
  openBooks: () => void;
  refreshBooks: () => void;
  guide: {
    /** Acknowledge a step that cannot be inferred from data ("nothing paid yet"). */
    markStep: (step: "paid" | "household", done: boolean) => void;
    hide: () => void;
  };
}
