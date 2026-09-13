// Exact conversion between the books' integer cents and the number-based tax
// engine's dollars. The bound protects the engine, not the ledger.
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
  // Multiplying a float by 100 misrounds decimal halves such as 10.075.
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
function roundRatio(value: bigint, divisor: bigint) {
  if (divisor <= BigInt(0)) throw new Error("Invalid divisor.");
  const magnitude = value < BigInt(0) ? -value : value;
  const quotient = magnitude / divisor,
    remainder = magnitude % divisor;
  const rounded =
    quotient + (remainder * BigInt(2) >= divisor ? BigInt(1) : BigInt(0));
  return value < BigInt(0) ? -rounded : rounded;
}
