import type {
  FeedCanonicalAccount,
  FeedConnection,
  FeedData,
  FeedIdentity,
} from "./feeds";

const connectionPriority: Record<FeedConnection["status"], number> = {
  active: 0,
  reconnect_required: 1,
  disconnected: 2,
  claiming: 2,
};

/**
 * The feed link a ledger account uses now. A reissued card keeps its old,
 * closed links next to the open one; the open link wins, then the one closed
 * last.
 */
export function currentFeedAccount(
  accounts: readonly FeedCanonicalAccount[],
  accountId: string,
): FeedCanonicalAccount | undefined {
  let best: FeedCanonicalAccount | undefined;
  for (const a of accounts) {
    if (a.account_id !== accountId) continue;
    if (
      !best ||
      (best.is_closed && !a.is_closed) ||
      (!!best.is_closed === !!a.is_closed &&
        (a.closed_on ?? "") > (best.closed_on ?? ""))
    )
      best = a;
  }
  return best;
}

/** Resolve by the book account's mapping, never by the owner's name or card digits. */
export function bankIdentitiesByAccount(feeds: FeedData | null) {
  const identities = new Map<string, FeedIdentity>();
  if (!feeds) return identities;
  const accounts = new Map(feeds.accounts.map((a) => [a.id, a]));
  const priorities = new Map(
    feeds.connections.map((c) => [c.id, connectionPriority[c.status]]),
  );
  // An open link outranks every closed one, so a reissued card shows its
  // current number; among equals a live connection wins.
  const rank = (identity: FeedIdentity) =>
    (accounts.get(identity.feed_account_id ?? "")?.is_closed ? 10 : 0) +
    (priorities.get(identity.connection_id) ?? 2);
  for (const identity of feeds.identities) {
    const accountId = identity.feed_account_id
      ? accounts.get(identity.feed_account_id)?.account_id
      : undefined;
    if (!accountId) continue;
    const previous = identities.get(accountId);
    // Keep historical identities after disconnecting, but prefer a live connection.
    if (!previous || rank(identity) < rank(previous)) {
      identities.set(accountId, identity);
    }
  }
  return identities;
}
