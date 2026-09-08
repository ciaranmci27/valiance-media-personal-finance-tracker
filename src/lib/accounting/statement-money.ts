// Card statements show amounts owed as positive. The ledger remains debit-positive.
// This exact conversion is its own inverse, for both display and entered balances.
export function statementCents(value: string | bigint, card: boolean): string {
  const cents = BigInt(value);
  return (card ? -cents : cents).toString();
}
