import { createHash } from "node:crypto";
import { z } from "zod";
import { parseUsd } from "../money";
import { safeProviderMessage, SimpleFinError } from "./simplefin-transport";

export const SIMPLEFIN_PROTOCOL = "2.0.0-draft-2026-03-19";
export const SYNC_OVERLAP_SECONDS = 5 * 86400;
export const SYNC_WINDOW_SECONDS = 90 * 86400;
const identifier = z.string().min(1).max(500),
  timestamp = z.number().int().min(0).max(4133980800);
const providerError = z.object({
  code: z.string().min(1).max(100),
  msg: z.string().max(10000),
  conn_id: identifier.optional(),
  account_id: identifier.optional(),
});
const connection = z.object({
  conn_id: identifier,
  name: z.string().min(1).max(500),
  org_id: identifier,
  org_url: z.string().max(8192).optional(),
  sfin_url: z.string().max(8192),
});
const transaction = z
  .object({
    id: identifier,
    posted: timestamp,
    amount: z.string().max(100),
    description: z.string().max(1000),
    pending: z.boolean().optional(),
    transacted_at: timestamp.optional(),
  })
  .passthrough();
const account = z
  .object({
    id: identifier,
    conn_id: identifier,
    name: z.string().min(1).max(500),
    currency: z.string().max(500),
    balance: z.string().max(100),
    "available-balance": z.string().max(100).optional(),
    "balance-date": timestamp,
    transactions: z.array(z.unknown()).max(50000).optional(),
  })
  .passthrough();
const envelope = z.object({
  errlist: z.array(providerError).max(2000),
  errors: z.array(z.string().max(10000)).max(2000).optional(),
  connections: z.array(connection).max(1000),
  accounts: z.array(z.unknown()).max(2000),
});
export type ProviderIssue = {
  code: string;
  message: string;
  provider_connection_id: string | null;
  provider_account_id: string | null;
};
export interface FeedTransaction {
  external_id: string;
  posted: number;
  transacted_at: number | null;
  amount_cents: string;
  description: string;
  state: "posted" | "pending" | "nonfinancial";
  hash: string;
  raw: Record<string, unknown>;
}
export interface FeedAccount {
  provider_connection_id: string;
  provider_account_id: string;
  name: string;
  institution: string;
  institution_id: string;
  currency: string;
  balance_cents: string | null;
  available_cents: string | null;
  balance_at: number;
  transactions: FeedTransaction[];
  issues: ProviderIssue[];
  complete: boolean;
  hash: string;
  raw: Record<string, unknown>;
}
export interface FeedResponse {
  protocol: typeof SIMPLEFIN_PROTOCOL;
  accounts: FeedAccount[];
  issues: ProviderIssue[];
  complete: boolean;
  hash: string;
}
function stable(value: unknown, depth = 0): unknown {
  if (depth > 40)
    throw new SimpleFinError(
      "response_depth",
      "The provider response contains unsupported nested data. Coverage was not advanced.",
    );
  if (Array.isArray(value)) return value.map((v) => stable(v, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, stable(v, depth + 1)]),
    );
  return value;
}
export const sourceHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
/** The end timestamp is exclusive, matching the pinned provider contract. */
export function syncWindow(
  historyStart: number,
  checkpoint: number | null,
  now: number,
  resumeFloor: number | null = null,
): { start: number; end: number; catchingUp: boolean } {
  if (
    !Number.isSafeInteger(historyStart) ||
    !Number.isSafeInteger(now) ||
    historyStart < 0 ||
    historyStart > now ||
    (checkpoint !== null &&
      (!Number.isSafeInteger(checkpoint) ||
        checkpoint < historyStart ||
        checkpoint > now + 1))
  )
    throw new SimpleFinError(
      "invalid_window",
      "Choose a valid bank history start and sync checkpoint.",
    );
  if (
    resumeFloor !== null &&
    (!Number.isSafeInteger(resumeFloor) ||
      resumeFloor < historyStart ||
      checkpoint === null ||
      resumeFloor > checkpoint)
  )
    throw new SimpleFinError(
      "invalid_window",
      "The retained history gap does not agree with this sync checkpoint.",
    );
  const start = Math.max(
      historyStart,
      (checkpoint ?? historyStart) - SYNC_OVERLAP_SECONDS,
      resumeFloor ?? historyStart,
    ),
    end = Math.min(start + SYNC_WINDOW_SECONDS, now + 1);
  return { start, end, catchingUp: end < now + 1 };
}
export function postingDate(
  timestampSeconds: number,
  zone: "UTC" | "America/Phoenix",
): string {
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    timestampSeconds <= 0 ||
    timestampSeconds > 4133980800
  )
    throw new SimpleFinError(
      "invalid_date",
      "The source transaction has no valid posted date.",
    );
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampSeconds * 1000));
  const part = (kind: string) => parts.find((p) => p.type === kind)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function parseSimpleFin(
  raw: unknown,
  window: { start: number; end: number },
  now = Math.floor(Date.now() / 1000),
  balancesOnly = false,
): FeedResponse {
  if (
    !Number.isSafeInteger(window.start) ||
    !Number.isSafeInteger(window.end) ||
    window.start < 0 ||
    window.end <= window.start ||
    window.end - window.start > SYNC_WINDOW_SECONDS
  )
    throw new SimpleFinError(
      "invalid_window",
      "SimpleFIN requests must use a positive window of at most 90 days.",
    );
  const parsed = envelope.safeParse(raw);
  if (!parsed.success)
    throw new SimpleFinError(
      "protocol_mismatch",
      "The response does not match the pinned SimpleFIN version 2 contract. Coverage was not advanced.",
    );
  const issues: ProviderIssue[] = parsed.data.errlist.map((e) => ({
    code: e.code,
    message: safeProviderMessage(e.msg),
    provider_connection_id: e.conn_id ?? null,
    provider_account_id: e.account_id ?? null,
  }));
  for (const message of parsed.data.errors ?? [])
    issues.push({
      code: "legacy_error",
      message: safeProviderMessage(message),
      provider_connection_id: null,
      provider_account_id: null,
    });
  const issue = (
    code: string,
    message: string,
    c: string | null = null,
    a: string | null = null,
  ): ProviderIssue => ({
    code,
    message,
    provider_connection_id: c,
    provider_account_id: a,
  });
  const connections = new Map<string, z.infer<typeof connection>>();
  for (const c of parsed.data.connections) {
    if (connections.has(c.conn_id))
      issues.push(
        issue(
          "duplicate_connection",
          "The provider repeated a connection identity.",
          c.conn_id,
        ),
      );
    else connections.set(c.conn_id, c);
  }
  const accounts: FeedAccount[] = [],
    seen = new Set<string>();
  for (const source of parsed.data.accounts) {
    const result = account.safeParse(source);
    if (!result.success) {
      const hint = z
        .object({ id: identifier, conn_id: identifier })
        .safeParse(source);
      issues.push(
        issue(
          "invalid_account",
          "The provider returned an invalid account record.",
          hint.success ? hint.data.conn_id : null,
          hint.success ? hint.data.id : null,
        ),
      );
      continue;
    }
    const a = result.data,
      key = JSON.stringify([a.conn_id, a.id]),
      c = connections.get(a.conn_id),
      accountIssues: ProviderIssue[] = [];
    if (seen.has(key)) {
      issues.push(
        issue(
          "duplicate_account",
          "The provider repeated an account identity.",
          a.conn_id,
          a.id,
        ),
      );
      continue;
    }
    seen.add(key);
    if (!c)
      accountIssues.push(
        issue(
          "unknown_connection",
          "This account references a missing provider connection.",
          a.conn_id,
          a.id,
        ),
      );
    const add = (code: string, message: string) =>
      accountIssues.push(issue(code, message, a.conn_id, a.id));
    let balance: string | null = null,
      available: string | null = null;
    if (a.currency !== "USD")
      add(
        "unsupported_currency",
        "Only company accounts denominated in USD are supported.",
      );
    else
      try {
        balance = parseUsd(a.balance).toString();
        if (a["available-balance"] !== undefined)
          available = parseUsd(a["available-balance"]).toString();
      } catch {
        add(
          "invalid_balance",
          "The provider balance is not an exact USD amount.",
        );
      }
    if (a["balance-date"] === 0 || a["balance-date"] > now + 300)
      add(
        "invalid_balance_date",
        "The provider balance has an unavailable or future timestamp.",
      );
    if (a.transactions === undefined && !balancesOnly)
      add(
        "missing_transactions",
        "The response omitted transactions. A missing list is not evidence of an empty period.",
      );
    const transactions: FeedTransaction[] = [],
      transactionIds = new Set<string>();
    for (const sourceTransaction of balancesOnly
      ? []
      : (a.transactions ?? [])) {
      if (Buffer.byteLength(JSON.stringify(sourceTransaction)) > 25000) {
        add(
          "transaction_size",
          "A provider movement contains too much attached data to retain safely. Review the source account.",
        );
        continue;
      }
      const parsedTransaction = transaction.safeParse(sourceTransaction);
      if (!parsedTransaction.success) {
        add(
          "invalid_transaction",
          "A provider transaction is malformed. Review this account before accepting coverage.",
        );
        continue;
      }
      const t = parsedTransaction.data;
      if (transactionIds.has(t.id)) {
        add(
          "duplicate_transaction",
          "The provider repeated a transaction ID in this account.",
        );
        continue;
      }
      transactionIds.add(t.id);
      let amount: string;
      try {
        amount = parseUsd(t.amount).toString();
      } catch {
        add(
          "invalid_amount",
          "A provider movement is not an exact USD amount.",
        );
        continue;
      }
      const pending = t.pending === true || t.posted === 0;
      if (!pending && (t.posted < window.start || t.posted >= window.end)) {
        add(
          "out_of_window",
          "The provider returned a posted movement outside the requested range.",
        );
        continue;
      }
      if (!pending && t.posted > now + 300) {
        add(
          "future_posting",
          "A provider movement has a future posted timestamp.",
        );
        continue;
      }
      transactions.push({
        external_id: t.id,
        posted: t.posted,
        transacted_at: t.transacted_at ?? null,
        amount_cents: amount,
        description: t.description.trim() || "Imported bank movement",
        state: pending ? "pending" : amount === "0" ? "nonfinancial" : "posted",
        hash: sourceHash(sourceTransaction),
        raw: sourceTransaction as Record<string, unknown>,
      });
    }
    accounts.push({
      provider_connection_id: a.conn_id,
      provider_account_id: a.id,
      name: a.name,
      institution: c?.name ?? "Unknown institution",
      institution_id: c?.org_id ?? "",
      currency: a.currency,
      balance_cents: balance,
      available_cents: available,
      balance_at: a["balance-date"],
      transactions,
      issues: accountIssues,
      complete: false,
      hash: sourceHash(source),
      raw: source as Record<string, unknown>,
    });
  }
  // Scope known protocol prefixes. Unknown/malformed error scopes block all
  // account coverage rather than guessing which institution lost data.
  for (const a of accounts) {
    for (const e of issues) {
      const accountScoped = e.provider_account_id !== null,
        connectionScoped = e.provider_connection_id !== null;
      const prefix = e.code.split(".")[0];
      const known =
        (prefix === "con" && connectionScoped) ||
        (prefix === "act" && connectionScoped && accountScoped) ||
        [
          "duplicate_connection",
          "duplicate_account",
          "invalid_account",
        ].includes(prefix);
      if (
        !known ||
        (!accountScoped && !connectionScoped) ||
        ((!connectionScoped ||
          e.provider_connection_id === a.provider_connection_id) &&
          (!accountScoped || e.provider_account_id === a.provider_account_id))
      )
        a.issues.push(e);
    }
    a.complete = a.issues.length === 0;
  }
  return {
    protocol: SIMPLEFIN_PROTOCOL,
    accounts,
    issues,
    complete: issues.length === 0 && accounts.every((a) => a.complete),
    hash: sourceHash(raw),
  };
}
