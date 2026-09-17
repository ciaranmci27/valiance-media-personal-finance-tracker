const ZERO = BigInt(0);
export const MAX_CENTS = BigInt("9223372036854775807");

/** Exact USD input. No floats, exponents, locale guessing, or fractional cents. */
export function parseUsd(input: string): bigint {
  const value = input.trim();
  if (value.length > 64 || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Enter a USD amount such as 1250.50 without commas.");
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (/[1-9]/.test(fraction.slice(2)))
    throw new Error("Amounts cannot contain fractional cents.");
  const cents =
    BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  if (cents > MAX_CENTS) throw new Error("Amount exceeds the supported range.");
  return negative ? -cents : cents;
}

export function readCents(value: string): bigint {
  if (!/^-?(0|[1-9]\d*)$/.test(value) || value.length > 20)
    throw new Error("Invalid integer cents.");
  const cents = BigInt(value);
  if (cents > MAX_CENTS || cents < -MAX_CENTS)
    throw new Error("Amount exceeds the supported range.");
  return cents;
}

export function centsToDecimal(value: string | bigint): string {
  const cents = typeof value === "bigint" ? value : readCents(value);
  const magnitude = cents < ZERO ? -cents : cents;
  return `${cents < ZERO ? "-" : ""}${magnitude / BigInt(100)}.${String(magnitude % BigInt(100)).padStart(2, "0")}`;
}

export function formatCents(value: string | bigint): string {
  // Report aggregates may exceed a single line's bigint range. Formatting stays exact.
  const cents = typeof value === "bigint" ? value : BigInt(value);
  const decimal = centsToDecimal(cents);
  const [whole, fraction] = decimal.replace("-", "").split(".");
  return `${cents < ZERO ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

/** Journal lines use positive cents for debits and negative cents for credits. */
export function journalTotals(lines: readonly { amount_cents: string }[]) {
  let debit = ZERO;
  let credit = ZERO;
  for (const line of lines) {
    const amount = readCents(line.amount_cents);
    if (amount > ZERO) debit += amount;
    else credit -= amount;
  }
  return { debit, credit };
}

/** Largest remainder, stable input-order tie break, with no floating point. */
export function allocateCents(
  total: bigint,
  weights: readonly bigint[],
): bigint[] {
  if (!weights.length || weights.some((w) => w < ZERO))
    throw new Error("Provide nonnegative weights.");
  const sum = weights.reduce((a, b) => a + b, ZERO);
  if (sum === ZERO) throw new Error("At least one weight must be positive.");
  const magnitude = total < ZERO ? -total : total;
  const rows = weights.map((w, index) => ({
    index,
    cents: (magnitude * w) / sum,
    remainder: (magnitude * w) % sum,
  }));
  const remaining = magnitude - rows.reduce((a, r) => a + r.cents, ZERO);
  const ordered = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (let index = 0; BigInt(index) < remaining; index++)
    ordered[index].cents += BigInt(1);
  return rows.map((row) => (total < ZERO ? -row.cents : row.cents));
}
