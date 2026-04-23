// Zod schemas for payroll tax configuration JSONB blobs.
//
// These guard the write boundary (editor submit handlers) AND the read
// boundary (engine entry). Keeping them in one file means a single source of
// truth: when shapes drift from the TS types, tsc catches the mismatch on the
// `satisfies z.ZodType<T>` assertions below.
//
// Conventions:
//   - Rates are decimal fractions in [0, 1]. 6.2% stored as 0.062.
//   - Dollar amounts are non-negative.
//   - Bracket arrays are sorted by `min` ascending; the schema enforces that.
//   - `max: null` means "no upper bound" and is only valid on the final entry.

import { z } from "zod";

import type {
  EmployeeStateElectionFlat,
  EmployeeStateElectionFlatEmployeeElected,
  EmployeeStateElectionProgressive,
  FederalBracket,
  FederalBrackets,
  FederalBracketsByStatus,
  FicaConfig,
  FutaConfig,
  StateBracket,
  StateConfigFlat,
  StateConfigFlatEmployeeElected,
  StateConfigNone,
  StateConfigProgressive,
  StateSdiConfig,
  StateSutaConfig,
  StdDeductions,
} from "@/types/payroll";

// ─── Primitives ───────────────────────────────────────────────────────────────

const rate = z
  .number({ error: "Must be a number" })
  .min(0, "Must be at least 0")
  .max(1, "Rate must be between 0 and 1 (e.g. 0.062 for 6.2%)");

const money = z
  .number({ error: "Must be a number" })
  .min(0, "Must be at least 0");

const positiveMoney = z
  .number({ error: "Must be a number" })
  .positive("Must be greater than 0");

// ─── Federal brackets ─────────────────────────────────────────────────────────

const federalBracketSchema = z
  .object({
    min: money,
    max: z.number().positive().nullable(),
    rate,
    base_tax: money,
  })
  .refine((b) => b.max === null || b.max > b.min, {
    message: "Bracket max must be greater than min (or null for the top bracket)",
    path: ["max"],
  }) satisfies z.ZodType<FederalBracket>;

const bracketArraySchema = (label: string) =>
  z
    .array(federalBracketSchema)
    .min(1, `${label} requires at least one bracket`)
    .superRefine((rows, ctx) => {
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].min <= rows[i - 1].min) {
          ctx.addIssue({
            code: "custom",
            message: `${label} bracket #${i + 1} min must be greater than previous bracket min`,
            path: [i, "min"],
          });
        }
      }
      // Only the last bracket may have max: null.
      for (let i = 0; i < rows.length - 1; i += 1) {
        if (rows[i].max === null) {
          ctx.addIssue({
            code: "custom",
            message: `${label}: only the top bracket may have max = null`,
            path: [i, "max"],
          });
        }
      }
    });

const federalBracketsByStatusSchema = z.object({
  single: bracketArraySchema("single"),
  mfj: bracketArraySchema("mfj"),
  mfs: bracketArraySchema("mfs"),
  hoh: bracketArraySchema("hoh"),
}) satisfies z.ZodType<FederalBracketsByStatus>;

const federalStep2AdditiveSchema = z.object({
  mfj: money,
  other: money,
});

export const federalBracketsSchema = z.object({
  period: z.enum(["annual", "weekly", "biweekly", "semimonthly", "monthly"]),
  source: z.string().min(1, "Source citation is required"),
  w4_step2_unchecked: federalBracketsByStatusSchema,
  w4_step2_checked: federalBracketsByStatusSchema.optional(),
  step2_additive: federalStep2AdditiveSchema.optional(),
}) satisfies z.ZodType<FederalBrackets>;

// ─── FICA ─────────────────────────────────────────────────────────────────────

export const ficaConfigSchema = z.object({
  ss_rate: rate,
  ss_wage_base: positiveMoney,
  medicare_rate: rate,
  additional_medicare_rate: rate,
  additional_medicare_threshold: money,
}) satisfies z.ZodType<FicaConfig>;

// ─── FUTA ─────────────────────────────────────────────────────────────────────

export const futaConfigSchema = z.object({
  rate,
  wage_base: positiveMoney,
  credit_reduction_states: z.record(z.string(), rate).optional(),
}) satisfies z.ZodType<FutaConfig>;

// ─── Standard deductions ──────────────────────────────────────────────────────

export const stdDeductionsSchema = z.object({
  single: money,
  mfj: money,
  mfs: money,
  hoh: money,
}) satisfies z.ZodType<StdDeductions>;

// ─── State config variants ────────────────────────────────────────────────────

export const stateConfigNoneSchema = z.object({
  notes: z.string().optional(),
}) satisfies z.ZodType<StateConfigNone>;

export const stateConfigFlatSchema = z.object({
  rate,
  form: z.string().optional(),
  notes: z.string().optional(),
}) satisfies z.ZodType<StateConfigFlat>;

export const stateConfigFlatElectedSchema = z
  .object({
    actualTaxRate: rate,
    rates: z
      .array(rate)
      .min(1, "Add at least one allowed rate"),
    defaultRate: rate,
    form: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine((c) => c.rates.includes(c.defaultRate), {
    message: "Default rate must be one of the allowed rates",
    path: ["defaultRate"],
  }) satisfies z.ZodType<StateConfigFlatEmployeeElected>;

const stateBracketSchema = z
  .object({
    min: money,
    max: z.number().positive().nullable(),
    rate,
    base_tax: money,
  })
  .refine((b) => b.max === null || b.max > b.min, {
    message: "Bracket max must be greater than min (or null for top bracket)",
    path: ["max"],
  }) satisfies z.ZodType<StateBracket>;

const stateBracketArraySchema = (label: string) =>
  z
    .array(stateBracketSchema)
    .min(1, `${label} requires at least one bracket`)
    .superRefine((rows, ctx) => {
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].min <= rows[i - 1].min) {
          ctx.addIssue({
            code: "custom",
            message: `${label} bracket #${i + 1} min must exceed previous min`,
            path: [i, "min"],
          });
        }
      }
      for (let i = 0; i < rows.length - 1; i += 1) {
        if (rows[i].max === null) {
          ctx.addIssue({
            code: "custom",
            message: `${label}: only the top bracket may have max = null`,
            path: [i, "max"],
          });
        }
      }
    });

export const stateConfigProgressiveSchema = z.object({
  period: z.literal("annual"),
  brackets: z.object({
    single: stateBracketArraySchema("single"),
    mfj: stateBracketArraySchema("mfj").optional(),
    mfs: stateBracketArraySchema("mfs").optional(),
    hoh: stateBracketArraySchema("hoh").optional(),
  }),
  std_deduction: stdDeductionsSchema.partial().optional(),
  form: z.string().optional(),
  notes: z.string().optional(),
}) satisfies z.ZodType<StateConfigProgressive>;

// "custom" is intentionally permissive - the engine throws on custom anyway,
// so the schema just records that the blob is an object.
export const stateConfigCustomSchema = z.record(z.string(), z.unknown());

// ─── State employer-side taxes ────────────────────────────────────────────────

export const stateSutaConfigSchema = z
  .object({
    newEmployerRate: rate.optional(),
    wageBase: money.optional(),
    rangeMin: rate.optional(),
    rangeMax: rate.optional(),
    formsDue: z.array(z.string()).optional(),
  })
  .refine(
    (c) =>
      c.rangeMin === undefined ||
      c.rangeMax === undefined ||
      c.rangeMax >= c.rangeMin,
    {
      message: "SUTA range max must be >= range min",
      path: ["rangeMax"],
    },
  ) satisfies z.ZodType<StateSutaConfig>;

export const stateSdiConfigSchema = z.object({
  rate: rate.optional(),
  wage_base: money.optional(),
  side: z.enum(["employee", "employer", "both"]).optional(),
}) satisfies z.ZodType<StateSdiConfig>;

// ─── Dispatcher: state config keyed by calculation_method ─────────────────────

export type StateCalculationMethod =
  | "none"
  | "flat"
  | "flat_employee_elected"
  | "progressive"
  | "custom";

export function parseStateConfigByMethod(
  method: StateCalculationMethod,
  raw: unknown,
): z.ZodSafeParseResult<unknown> {
  switch (method) {
    case "none":
      return stateConfigNoneSchema.safeParse(raw);
    case "flat":
      return stateConfigFlatSchema.safeParse(raw);
    case "flat_employee_elected":
      return stateConfigFlatElectedSchema.safeParse(raw);
    case "progressive":
      return stateConfigProgressiveSchema.safeParse(raw);
    case "custom":
      return stateConfigCustomSchema.safeParse(raw);
  }
}

// ─── Aggregate payloads (full row writes) ─────────────────────────────────────

export const federalTaxConfigWriteSchema = z.object({
  tax_year: z.number().int().min(1900).max(2100),
  brackets: federalBracketsSchema,
  fica: ficaConfigSchema,
  futa: futaConfigSchema,
  std_deductions: stdDeductionsSchema,
  version_hash: z.string().optional(),
  notes: z.string().nullable().optional(),
});

export interface StateTaxConfigWritePayload {
  tax_year: number;
  state_code: string;
  calculation_method: StateCalculationMethod;
  config: unknown;
  sdi_config: unknown;
  suta_config: unknown;
  payment_portals?: unknown;
  version_hash?: string;
  notes?: string | null;
}

const statePaymentPortalSchema = z
  .object({
    portal: z.string(),
    agency: z.string(),
    url: z.string().url(),
    form: z.string(),
    steps: z.array(z.string()),
  })
  .strict();

const statePaymentPortalsSchema = z
  .object({
    state_withholding: statePaymentPortalSchema.nullable().optional(),
    state_suta: statePaymentPortalSchema.nullable().optional(),
    state_sdi: statePaymentPortalSchema.nullable().optional(),
  })
  .strict();

/** Parses a state_tax_configs write payload, dispatching on calculation_method. */
export function parseStateTaxConfigWrite(
  payload: StateTaxConfigWritePayload,
): z.ZodSafeParseResult<unknown> {
  const sdi = stateSdiConfigSchema.safeParse(payload.sdi_config);
  if (!sdi.success) return sdi;

  const suta = stateSutaConfigSchema.safeParse(payload.suta_config);
  if (!suta.success) return suta;

  if (payload.payment_portals !== undefined) {
    const portals = statePaymentPortalsSchema.safeParse(
      payload.payment_portals,
    );
    if (!portals.success) return portals;
  }

  return parseStateConfigByMethod(payload.calculation_method, payload.config);
}

// ─── Employee state election ──────────────────────────────────────────────────
// Shapes live in types/payroll.ts; re-exported here as zod for the employee
// editor. Only exported for the specific methods that need real validation.

export const employeeStateElectionFlatSchema = z.object({
  rate: rate.optional(),
  extra_withholding: money.optional(),
}) satisfies z.ZodType<EmployeeStateElectionFlat>;

export const employeeStateElectionFlatElectedSchema = z.object({
  rate,
  dependents: z.number().int().min(0).optional(),
  extra_withholding: money.optional(),
}) satisfies z.ZodType<EmployeeStateElectionFlatEmployeeElected>;

export const employeeStateElectionProgressiveSchema = z.object({
  filing_status: z.enum(["single", "mfj", "mfs", "hoh"]).optional(),
  allowances: z.number().int().min(0).optional(),
  extra_withholding: money.optional(),
}) satisfies z.ZodType<EmployeeStateElectionProgressive>;

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Flattens a ZodError into a single user-facing string. Use for toast. */
export function formatZodError(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return "Invalid configuration";
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}
