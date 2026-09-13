import type { FeedConnection, FeedData, FeedIdentity } from "./feeds";

const connectionPriority: Record<FeedConnection["status"], number> = {
  active: 0,
  reconnect_required: 1,
  disconnected: 2,
  claiming: 2,
};

/** Resolve by the book account's mapping, never by the owner's name or card digits. */
export function bankIdentitiesByAccount(feeds: FeedData | null) {
  const identities = new Map<string, FeedIdentity>();
  if (!feeds) return identities;
  const accounts = new Map(feeds.accounts.map((a) => [a.id, a.account_id]));
  const priorities = new Map(
    feeds.connections.map((c) => [c.id, connectionPriority[c.status]]),
  );
  for (const identity of feeds.identities) {
    const accountId = identity.feed_account_id
      ? accounts.get(identity.feed_account_id)
      : undefined;
    if (!accountId) continue;
    const previous = identities.get(accountId);
    // Keep historical identities after disconnecting, but prefer a live connection.
    if (
      !previous ||
      (priorities.get(identity.connection_id) ?? 2) <
        (priorities.get(previous.connection_id) ?? 2)
    ) {
      identities.set(accountId, identity);
    }
  }
  return identities;
}
