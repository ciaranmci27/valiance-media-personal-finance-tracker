import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PermissionKey } from "@/lib/access-control";

/**
 * Finance API keys: `vmfin_` plus 48 hex characters (24 random bytes). Only
 * the SHA-256 hash is stored; the full key is shown once.
 */
export function generateApiKey(): string {
  return `vmfin_${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The leading characters kept so a person can tell their keys apart. */
export function keyPrefix(key: string): string {
  return key.slice(0, 14);
}

/** Every column of public.api_keys except key_hash, which never leaves the server. */
export const API_KEY_COLUMNS =
  "id, name, key_prefix, team_member_id, created_by, scopes, expires_at, last_used_at, disabled_at, revoked_at, created_at, updated_at";

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  team_member_id: string | null;
  created_by: string | null;
  scopes: PermissionKey[];
  expires_at: string | null;
  last_used_at: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
