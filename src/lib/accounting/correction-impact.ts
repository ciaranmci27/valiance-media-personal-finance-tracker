import type { AccountingAccount, JournalLine } from "./contracts";

type Line = Pick<JournalLine, "account_id" | "amount_cents">;

/** Compare signed ledger amounts, preserving integer cents throughout. */
export function correctionImpact(
  original: Line[],
  replacement: Line[],
  accounts: Map<string, AccountingAccount>,
) {
  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  for (const [lines, sums] of [
    [original, before],
    [replacement, after],
  ] as const)
    for (const line of lines)
      sums.set(
        line.account_id,
        (sums.get(line.account_id) ?? BigInt(0)) + BigInt(line.amount_cents),
      );
  return [...new Set([...before.keys(), ...after.keys()])].map((id) => {
    const account = accounts.get(id);
    const sign = account?.normal_side === "credit" ? -BigInt(1) : BigInt(1);
    const previous = (before.get(id) ?? BigInt(0)) * sign;
    const next = (after.get(id) ?? BigInt(0)) * sign;
    return {
      id,
      name: account?.name ?? "Account",
      before: previous,
      after: next,
      change: next - previous,
    };
  });
}
