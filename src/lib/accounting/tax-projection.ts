import { z } from "zod";
import type { TaxSource } from "./tax-workpapers";

// This bounds the number-based tax engine, not the exact accounting ledger.
export const ESTIMATOR_MAX_CENTS = BigInt("1000000000000");
export function toEstimatorDollars(cents: string): number {
  if (!/^-?(0|[1-9][0-9]*)$/.test(cents))
    throw new Error("Invalid exact tax input.");
  const value = BigInt(cents);
  if (value > ESTIMATOR_MAX_CENTS || value < -ESTIMATOR_MAX_CENTS)
    throw new Error(
      "This amount exceeds the supported tax-estimator range of USD 10 billion.",
    );
  const result = Number(value) / 100;
  if (Math.round(result * 100) !== Number(value))
    throw new Error("Tax input lost cent precision.");
  return result;
}
export function fromEstimatorDollars(amount: number): string {
  if (!Number.isFinite(amount))
    throw new Error("The tax calculation returned an invalid amount.");
  // Round the engine's decimal representation, including exponent notation.
  // Multiplying a float by100 misrounds decimal halves such as10.075.
  const [mantissa, exponent = "0"] = Math.abs(amount)
    .toString()
    .toLowerCase()
    .split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction),
    shift = 2 + Number(exponent) - fraction.length;
  const magnitude =
    shift >= 0
      ? digits * BigInt(10) ** BigInt(shift)
      : roundRatio(digits, BigInt(10) ** BigInt(-shift));
  const cents = amount < 0 ? -magnitude : magnitude;
  if (cents > ESTIMATOR_MAX_CENTS || cents < -ESTIMATOR_MAX_CENTS)
    throw new Error(
      "The tax calculation exceeds the supported estimator range.",
    );
  return cents.toString();
}
const signedCents = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);
const exclusion = z
  .object({ entry_id: z.uuid(), reason: z.string().trim().min(1).max(500) })
  .strict();
export const businessForecastSchema = z.discriminatedUnion("method", [
  z
    .object({ method: z.literal("manual"), remaining_cents: signedCents })
    .strict(),
  z
    .object({
      method: z.literal("average"),
      months: z
        .array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/))
        .min(1)
        .max(12),
      current_month_remaining_cents: signedCents,
      exclusions: z.array(exclusion).max(100),
    })
    .strict(),
  z
    .object({
      method: z.literal("prior_pattern"),
      current_month_remaining_cents: signedCents,
      exclusions: z.array(exclusion).max(100),
    })
    .strict(),
]);
export type BusinessForecast = z.infer<typeof businessForecastSchema>;
/** Exclusion amounts come from the server's posted ledger, never client amounts. */
export interface TaxForecastEvidence {
  prior: TaxSource | null;
  exclusions: {
    entry_id: string;
    entry_date: string;
    ordinary_cents: string;
  }[];
}
export interface BusinessProjection {
  actual_cents: string;
  remaining_cents: string;
  annual_cents: string;
  method: BusinessForecast["method"];
  selected_months: string[];
  excluded_cents: string;
  base_cents: string | null;
  remaining_full_months: number;
  current_month_remaining_cents: string;
  notes: string[];
}
function requireTreatment(source: TaxSource) {
  if (
    !source.year_settings?.current ||
    source.unmapped_accounts ||
    source.unavailable_adjustments
  )
    throw new Error(
      "Review the year classification, active account mappings and adjustment evidence first.",
    );
  if (source.incomplete_imports)
    throw new Error(
      "Complete the affected imports before using their amounts in a tax projection.",
    );
}
function roundRatio(value: bigint, divisor: bigint) {
  if (divisor <= BigInt(0))
    throw new Error("Choose at least one complete month.");
  const magnitude = value < BigInt(0) ? -value : value;
  const quotient = magnitude / divisor,
    remainder = magnitude % divisor;
  const rounded =
    quotient + (remainder * BigInt(2) >= divisor ? BigInt(1) : BigInt(0));
  return value < BigInt(0) ? -rounded : rounded;
}
export function projectBusinessIncome(
  source: TaxSource,
  forecast: BusinessForecast,
  evidence: TaxForecastEvidence,
): BusinessProjection {
  requireTreatment(source);
  const parsed = businessForecastSchema.safeParse(forecast);
  if (!parsed.success)
    throw new Error(
      "Choose an explicit forecast and complete its assumptions.",
    );
  const cutoff = new Date(`${source.through}T00:00:00Z`),
    month = cutoff.getUTCMonth() + 1;
  if (
    !Number.isFinite(cutoff.getTime()) ||
    cutoff.toISOString().slice(0, 10) !== source.through ||
    cutoff.getUTCFullYear() !== source.year
  )
    throw new Error("Invalid tax projection cutoff.");
  const monthEnd =
    new Date(Date.UTC(source.year, month, 0)).getUTCDate() ===
    cutoff.getUTCDate();
  const actual = BigInt(source.adjusted_ordinary_cents),
    fullMonths = 12 - month;
  let remaining = BigInt(0),
    excluded = BigInt(0),
    base: bigint | null = null,
    partial = BigInt(0);
  const selected: string[] = [],
    notes: string[] = [];
  if (forecast.method === "manual") {
    remaining = BigInt(forecast.remaining_cents);
    if (source.through === `${source.year}-12-31` && remaining !== BigInt(0))
      throw new Error(
        "A completed tax year cannot include a remaining-year forecast.",
      );
    notes.push(
      "Remaining income is the explicit manual forecast, including all days after the cutoff.",
    );
  } else {
    partial = BigInt(forecast.current_month_remaining_cents);
    if (monthEnd && partial !== BigInt(0))
      throw new Error("A month-end cutoff has no remaining partial month.");
    if (fullMonths === 0 && monthEnd && forecast.exclusions.length)
      throw new Error("A completed year has no forecast months to adjust.");
    const baseSource =
      forecast.method === "prior_pattern" ? evidence.prior : source;
    if (!baseSource)
      throw new Error("The prior-year monthly pattern is unavailable.");
    if (forecast.method === "prior_pattern") {
      requireTreatment(baseSource);
      if (
        baseSource.year !== source.year - 1 ||
        baseSource.through !== `${source.year - 1}-12-31` ||
        baseSource.year_settings?.classification !==
          source.year_settings?.classification
      )
        throw new Error(
          "Use a complete prior year with the same reviewed tax classification.",
        );
      for (let next = month + 1; next <= 12; next++)
        selected.push(`${source.year - 1}-${String(next).padStart(2, "0")}-01`);
    } else selected.push(...forecast.months);
    if (new Set(selected).size !== selected.length)
      throw new Error("Each forecast base month can be selected only once.");
    const known = new Map(baseSource.monthly.map((m) => [m.month, m]));
    for (const selectedMonth of selected) {
      const record = known.get(selectedMonth);
      if (!record?.complete || !selectedMonth.startsWith(`${baseSource.year}-`))
        throw new Error(
          "Forecast bases must be explicitly selected, closed complete months.",
        );
    }
    const ids = new Set<string>();
    for (const item of forecast.exclusions) {
      if (ids.has(item.entry_id))
        throw new Error("Exclude a one-off entry only once.");
      ids.add(item.entry_id);
      const fact = evidence.exclusions.find(
        (e) => e.entry_id === item.entry_id,
      );
      if (!fact || !selected.includes(`${fact.entry_date.slice(0, 7)}-01`))
        throw new Error(
          "Each one-off exclusion must belong to a selected forecast base month.",
        );
      excluded += BigInt(fact.ordinary_cents);
    }
    const selectedTotal =
      selected.reduce(
        (total, key) => total + BigInt(known.get(key)!.ordinary_cents),
        BigInt(0),
      ) - excluded;
    if (forecast.method === "average") {
      base = roundRatio(selectedTotal, BigInt(selected.length));
      // Round the complete forecast once, avoiding a repeated rounded-month bias.
      remaining =
        roundRatio(
          selectedTotal * BigInt(fullMonths),
          BigInt(selected.length),
        ) + partial;
      notes.push(
        "Average uses only selected closed months. One-off exclusions affect the forecast base, not recorded actual income.",
      );
    } else {
      base = selectedTotal;
      remaining = selectedTotal + partial;
      notes.push(
        "Remaining full months repeat the same months from the prior year, without an inferred growth rate.",
      );
    }
    if (!monthEnd)
      notes.push(
        "The remainder of the current partial month is an explicit manual amount.",
      );
  }
  if (source.drafts)
    notes.push(
      `${source.drafts} draft transactions are excluded from actual income. This estimate remains provisional.`,
    );
  const annual = actual + remaining;
  // Check all values crossing the existing engine's number boundary.
  for (const value of [actual, remaining, annual])
    toEstimatorDollars(value.toString());
  return {
    actual_cents: actual.toString(),
    remaining_cents: remaining.toString(),
    annual_cents: annual.toString(),
    method: forecast.method,
    selected_months: selected,
    excluded_cents: excluded.toString(),
    base_cents: base?.toString() ?? null,
    remaining_full_months: fullMonths,
    current_month_remaining_cents: partial.toString(),
    notes,
  };
}
