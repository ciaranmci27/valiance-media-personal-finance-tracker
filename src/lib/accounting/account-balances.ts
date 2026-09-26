import type { BalanceRow } from "./contracts";
import type { FeedData } from "./feeds";
import type { AccountProfile } from "./workflows";
import { bankIdentitiesByAccount } from "./bank-identity";

export function accountBalances(
  accounts: BalanceRow[],
  profiles: AccountProfile[],
  feeds: FeedData | null,
) {
  const identities = bankIdentitiesByAccount(feeds);
  const canonical = new Map(
    feeds?.accounts.map((a) => [a.account_id, a]) ?? [],
  );
  const kinds = new Map(profiles.map((p) => [p.account_id, p.cash_kind]));
  return new Map(
    accounts.map((account) => {
      const card = kinds.get(account.id) === "card";
      const book =
        BigInt(account.ending_cents) * (card ? BigInt(-1) : BigInt(1));
      const mapping = canonical.get(account.id);
      const observation = identities.get(account.id)?.balance;
      // balance_sign normalizes the provider balance into ledger convention
      // (assets positive, card debt negative), the same convention as
      // ending_cents and the server's close checks. Cards flip to "amount
      // owed" here, exactly as the book balance does above.
      const observed =
        mapping && observation?.balance_cents != null
          ? BigInt(observation.balance_cents) * BigInt(mapping.balance_sign)
          : null;
      const bank = observed === null ? null : card ? -observed : observed;
      return [
        account.id,
        {
          book,
          bank,
          amount: bank ?? book,
          card,
          observedAt:
            bank !== null && observation ? observation.balance_at : null,
        },
      ];
    }),
  );
}

/** Everything still parked in the uncategorized accounts, as a positive amount. */
export function uncategorizedCents<T>(
  rows: readonly T[],
  purpose: (row: T) => string | null | undefined,
  cents: (row: T) => string,
): bigint {
  let total = BigInt(0);
  for (const row of rows) {
    if (!purpose(row)?.startsWith("uncategorized")) continue;
    const value = BigInt(cents(row));
    total += value < BigInt(0) ? -value : value;
  }
  return total;
}
