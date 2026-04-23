// IRS rounds payroll dollar amounts to the nearest cent. Payroll taxes
// accumulate across many multiplications (rate * wage, proration, etc.),
// so every intermediate result that becomes a stored dollar figure must
// be explicitly rounded to avoid binary-float drift.
//
// Rules used here:
//   - round2(): banker-free, uses standard "round half away from zero"
//     semantics. This matches how payroll calculators and IRS examples
//     treat half-cent cases (e.g. $0.005 -> $0.01).
//   - Works on positive and negative values symmetrically so corrections
//     and reversing entries round the same direction.

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100)) / 100;
}

export function toCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) * 100);
}

export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return cents / 100;
}
