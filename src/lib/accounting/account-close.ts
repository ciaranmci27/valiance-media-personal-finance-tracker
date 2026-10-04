import { formatCents } from "./money";

/**
 * Closing a bank, card or cash account. A closed account keeps every past
 * entry and balance; it takes nothing dated after its closing day and its bank
 * feed stops syncing. The server (ledger_command account.close) decides; this
 * module holds the client's reading of it.
 */

export const CLOSABLE_KINDS = ["bank", "card", "cash"] as const;

/** An account new money can go through: not archived and not closed. */
export function isOpenAccount(account: {
  is_archived: boolean;
  closed_on?: string | null;
}): boolean {
  return !account.is_archived && !account.closed_on;
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
function day(value: unknown): string {
  if (typeof value !== "string") return "that day";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? value : dateFormat.format(parsed);
}
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function payload(
  message: string,
  code: string,
): Record<string, unknown> | null {
  const at = message.indexOf(code);
  if (at < 0) return null;
  const start = message.indexOf("{", at);
  const end = message.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  try {
    return JSON.parse(message.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The plain reason a close was refused, with the amount or count the server
 * sent, or null when the message is not a close refusal.
 */
export function closeRefusal(message: string): string | null {
  const balance = payload(message, "ACCT_CLOSE_BALANCE");
  if (balance) {
    const raw = String(balance.balance_cents ?? "0");
    const cents = /^-?\d+$/.test(raw) ? BigInt(raw) : BigInt(0);
    const amount = formatCents(cents < BigInt(0) ? -cents : cents);
    const on = day(balance.closed_on);
    if (balance.kind === "card")
      return cents < BigInt(0)
        ? `This card still shows ${amount} owed on ${on}. Record the payoff, then close it.`
        : `This card still shows a ${amount} credit on ${on}. Record the refund, then close it.`;
    return cents > BigInt(0)
      ? `This account still holds ${amount} on ${on}. Record the transfer out, then close it.`
      : `This account is overdrawn by ${amount} on ${on}. Record the deposit that cleared it, then close it.`;
  }
  const later = payload(message, "ACCT_CLOSE_LATER_ENTRIES");
  if (later) {
    const count = Number(later.count ?? 0);
    return `${plural(count, "transaction is", "transactions are")} dated after ${day(later.closed_on)}, the first on ${day(later.first)}. Choose a closing date on or after the last one.`;
  }
  const drafts = payload(message, "ACCT_CLOSE_DRAFTS");
  if (drafts) {
    const count = Number(drafts.count ?? 0);
    return `${plural(count, "transaction", "transactions")} on this account still ${count === 1 ? "needs" : "need"} review. Review or delete ${count === 1 ? "it" : "them"}, then close the account.`;
  }
  return null;
}
