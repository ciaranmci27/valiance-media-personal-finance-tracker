import type { FeedCanonicalAccount, FeedData, FeedIdentity } from "./feeds";

/**
 * Card reissues. When a bank replaces a card (a new number after a loss or a
 * product change) the feed shows a new account and the old one goes quiet.
 * These rules spot the likely pair so the owner can link the new feed to the
 * same ledger account in one click. Deterministic rules only: a pair is
 * suggested when exactly one quiet link and one new account fit.
 */

export type FeedKind = "bank" | "card";

/** Days without a new movement before a link counts as quiet. */
export const QUIET_DAYS = 30;
/** How far behind the connection's newest sighting a stopped account is. */
const STOPPED_SECONDS = 2 * 86400;

const CARD_WORDS =
  /\b(card|credit|visa|master ?card|amex|american express|rewards)\b/i;
const BANK_WORDS = /\b(checking|chequing|savings|money market|deposit)\b/i;

/**
 * Whether a discovered account is a card or a bank account, from what the
 * provider says about it. SimpleFIN has no account type, so: the name's own
 * words, then a card-only issuer, then a balance owed. Null when unsure.
 */
export function feedKind(
  identity: Pick<FeedIdentity, "name" | "institution" | "balance">,
): FeedKind | null {
  if (CARD_WORDS.test(identity.name)) return "card";
  if (BANK_WORDS.test(identity.name)) return "bank";
  if (/american express|\bamex\b/i.test(identity.institution)) return "card";
  const raw = identity.balance?.balance_cents;
  if (raw != null && /^-\d+$/.test(raw) && BigInt(raw) < BigInt(0))
    return "card";
  return null;
}

const institutionKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** The product name without numbers or punctuation, so a new card number still matches. */
const nameStem = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
const dayNumber = (date: string) =>
  Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 86400000);

export interface ReplacementSuggestion {
  /** The new, unmapped feed account. */
  identity: FeedIdentity;
  /** The quiet link it likely replaces. */
  replaces: FeedCanonicalAccount;
  /** What the provider calls the quiet link's account (its old number). */
  replacedIdentity: FeedIdentity;
  /** The ledger account both belong to. */
  accountId: string;
}

/**
 * Quiet links: open, and either the provider stopped returning the account
 * or nothing new arrived for QUIET_DAYS. `today` is the books' `YYYY-MM-DD`.
 */
export function isQuietLink(
  link: FeedCanonicalAccount,
  identity: FeedIdentity | undefined,
  newestSeen: number | undefined,
  today: string,
): boolean {
  if (link.is_closed) return false;
  if (
    identity?.seen_at !== undefined &&
    newestSeen !== undefined &&
    newestSeen - identity.seen_at > STOPPED_SECONDS
  )
    return true;
  const last = link.last_movement_on ?? link.created_at?.slice(0, 10) ?? null;
  return !!last && dayNumber(today) - dayNumber(last) >= QUIET_DAYS;
}

/**
 * Suggestions keyed by the new feed account's id. A new account is offered
 * for a quiet link of the same institution and the same kind (the ledger
 * account's kind against the new account's), once the owner has not said no
 * to that pair. When several fit, the product name decides; still several,
 * nothing is suggested.
 */
export function replacementSuggestions(
  feeds: FeedData | null,
  kinds: ReadonlyMap<string, string>,
  today: string,
): Map<string, ReplacementSuggestion> {
  const result = new Map<string, ReplacementSuggestion>();
  if (!feeds) return result;
  const active = new Set(
    feeds.connections.filter((c) => c.status === "active").map((c) => c.id),
  );
  const newestSeen = new Map<string, number>();
  for (const i of feeds.identities)
    if (i.seen_at !== undefined)
      newestSeen.set(
        i.connection_id,
        Math.max(newestSeen.get(i.connection_id) ?? 0, i.seen_at),
      );
  const quiet = feeds.accounts.flatMap((link) => {
    const identity = feeds.identities.find(
      (i) => i.feed_account_id === link.id,
    );
    const kind = kinds.get(link.account_id);
    if (!identity || (kind !== "bank" && kind !== "card")) return [];
    return isQuietLink(
      link,
      identity,
      newestSeen.get(identity.connection_id),
      today,
    )
      ? [{ link, identity, kind }]
      : [];
  });
  const pairs: { identity: FeedIdentity; link: (typeof quiet)[number] }[] = [];
  for (const identity of feeds.identities) {
    if (
      identity.feed_account_id !== null ||
      identity.ownership === "personal" ||
      identity.ownership === "ignored" ||
      identity.currency !== "USD" ||
      !active.has(identity.connection_id)
    )
      continue;
    const kind = feedKind(identity);
    if (!kind) continue;
    let fits = quiet.filter(
      (q) =>
        q.kind === kind &&
        institutionKey(q.identity.institution) ===
          institutionKey(identity.institution) &&
        !(identity.not_replacing ?? []).includes(q.link.id),
    );
    if (fits.length > 1)
      fits = fits.filter(
        (q) => nameStem(q.identity.name) === nameStem(identity.name),
      );
    if (fits.length === 1) pairs.push({ identity, link: fits[0] });
  }
  for (const pair of pairs) {
    // One quiet link offered to two new accounts is a guess; offer neither.
    if (pairs.filter((p) => p.link.link.id === pair.link.link.id).length > 1)
      continue;
    result.set(pair.identity.id, {
      identity: pair.identity,
      replaces: pair.link.link,
      replacedIdentity: pair.link.identity,
      accountId: pair.link.link.account_id,
    });
  }
  return result;
}
