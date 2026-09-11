import { z } from "zod";
const id = z.uuid(),
  // Discovered accounts are keyed by a hash cast to uuid, which is not RFC 4122
  // shaped, so those ids take the looser GUID check.
  discovered = z.guid(),
  version = z.number().int().min(0).max(2147483646),
  reason = z.string().trim().min(1).max(1000);
const stamp = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .pipe(z.string().refine((s) => Number(s) <= 4133980800));
export const feedCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("feed.claim"),
      id,
      expected_version: version,
      name: z.string().trim().min(1).max(120),
      claim_id: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("feed.disconnect"),
      id,
      expected_version: version,
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("feed.schedule"),
      id,
      expected_version: version,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("feed.map"),
      id: discovered,
      expected_version: version,
      expected_feed_version: version.optional(),
      ownership: z.enum(["company", "personal", "ignored"]),
      account_id: id.nullable(),
      history_start: stamp,
      posting_timezone: z.enum(["UTC", "America/Phoenix"]),
      movement_sign: z.union([z.literal(1), z.literal(-1)]),
      balance_sign: z.union([z.literal(1), z.literal(-1)]),
      reviewed: z.literal(true),
      reason,
    })
    .strict(),
  z
    .object({
      type: z.literal("feed.skip"),
      id: discovered,
      expected_version: version,
      through: stamp,
      reason,
    })
    .strict(),
  z.object({ type: z.literal("feed.prepare"), id: discovered }).strict(),
]);
export type FeedCommand = z.infer<typeof feedCommandSchema>;
export interface FeedConnection {
  id: string;
  name: string;
  status: "claiming" | "active" | "reconnect_required" | "disconnected";
  version: number;
  scheduled: boolean;
  next_sync_at: string | null;
  last_success_at: string | null;
  last_error: string;
  lease_until: string | null;
}
/** Mirrors the workspace sync_due rule: active, scheduled, and no complete run in the last six hours. */
export function feedSyncDue(connection: FeedConnection, now = Date.now()) {
  return (
    connection.status === "active" &&
    connection.scheduled &&
    (connection.last_success_at === null ||
      Date.parse(connection.last_success_at) < now - 6 * 60 * 60 * 1000)
  );
}
export interface FeedCanonicalAccount {
  id: string;
  account_id: string;
  history_start: string;
  checkpoint: string | null;
  posting_timezone: "UTC" | "America/Phoenix";
  movement_sign: 1 | -1;
  balance_sign: 1 | -1;
  version: number;
  can_edit_settings: boolean;
}
export interface FeedIdentity {
  id: string;
  connection_id: string;
  provider_connection_id: string;
  provider_account_id: string;
  name: string;
  institution: string;
  currency: string;
  ownership: "unreviewed" | "company" | "personal" | "ignored";
  version: number;
  feed_account_id: string | null;
  last_seen_at: string;
  account: FeedCanonicalAccount | null;
  balance: {
    balance_cents: string | null;
    available_cents: string | null;
    balance_at: number;
    issues: { code: string; message: string }[];
    created_at: string;
  } | null;
}
export interface FeedData {
  owner_id: string;
  connections: FeedConnection[];
  accounts: FeedCanonicalAccount[];
  identities: FeedIdentity[];
  runs: {
    id: string;
    connection_id: string;
    actor_kind: "owner" | "worker";
    status: string;
    started_at: string;
    finished_at: string | null;
    error: string;
  }[];
  queue: { feed_account_id: string; ready: number; pending: number }[];
}
