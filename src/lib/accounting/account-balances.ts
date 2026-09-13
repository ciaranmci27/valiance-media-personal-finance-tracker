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
      // balance_sign already converts provider balances to the account's display convention.
      const bank =
        mapping && observation?.balance_cents != null
          ? BigInt(observation.balance_cents) * BigInt(mapping.balance_sign)
          : null;
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
