/**
 * Demo data for Settings > API, built relative to now so every state the page
 * draws stays visible: an agent key in daily use, one about to expire, one
 * revoked, and a request log with an MCP call and a refusal. Read-only: the
 * demo never stores a key. Alex holds "Payroll and 1099 reports" but the key
 * does not carry it yet, so Edit access has something to add.
 */

import { siteConfig } from "@/config/site";
import { API_SCOPE_KEYS } from "@/lib/api/scopes";

/** The synthetic demo owner (lib/team/access.ts). */
const OWNER_ID = "00000000-0000-4000-8000-000000000000";
const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const SCRIPT_KEY = "00000000-0000-4000-8000-0000000000b2";
const AGENT_KEY = "00000000-0000-4000-8000-0000000000b1";
const OLD_KEY = "00000000-0000-4000-8000-0000000000b3";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const READS = ["accounting.read", "income.read", "expenses.read", "net_worth.read", "tax.read"];

function demoKeys() {
  return [
    {
      id: AGENT_KEY,
      name: "Alex AI Agent",
      key_prefix: "vmfin_340f73b5",
      team_member_id: AGENT_ID,
      created_by: OWNER_ID,
      scopes: [...READS, "accounting.draft"],
      expires_at: ahead(364 * DAY),
      last_used_at: ago(2 * MIN),
      disabled_at: null,
      revoked_at: null,
      created_at: ago(1 * DAY),
      updated_at: ago(1 * DAY),
    },
    {
      id: SCRIPT_KEY,
      name: "Weekly report script",
      key_prefix: "vmfin_9c1e04aa",
      team_member_id: OWNER_ID,
      created_by: OWNER_ID,
      scopes: ["accounting.read", "income.read"],
      expires_at: ahead(6 * DAY),
      last_used_at: ago(3 * DAY),
      disabled_at: null,
      revoked_at: null,
      created_at: ago(84 * DAY),
      updated_at: ago(84 * DAY),
    },
    {
      id: OLD_KEY,
      name: "Old spreadsheet sync",
      key_prefix: "vmfin_51d7b2e0",
      team_member_id: OWNER_ID,
      created_by: OWNER_ID,
      scopes: ["accounting.read"],
      expires_at: ahead(20 * DAY),
      last_used_at: ago(40 * DAY),
      disabled_at: null,
      revoked_at: ago(30 * DAY),
      created_at: ago(70 * DAY),
      updated_at: ago(30 * DAY),
    },
  ];
}

function demoMembers() {
  return [
    {
      id: OWNER_ID,
      name: siteConfig.realName,
      role: "owner",
      status: "active",
      has_sign_in: true,
      can_use_api: true,
      api_scopes: [...API_SCOPE_KEYS],
    },
    {
      id: AGENT_ID,
      name: "Alex A.",
      role: "agent",
      status: "active",
      has_sign_in: true,
      can_use_api: true,
      api_scopes: [...READS, "accounting.draft", "accounting.payroll"],
    },
  ];
}

export function demoApiKeysPayload() {
  const keys = demoKeys();
  const members = demoMembers();

  const calls: [number, string, string, string | null, number, string | null, number, "rest" | "mcp"][] = [
    [2 * MIN, "GET", "/api/v1/books/revision", "books.revision", 200, null, 41, "mcp"],
    [3 * MIN, "GET", "/api/v1/books/transactions", "books.transactions.list", 200, null, 312, "mcp"],
    [3 * MIN, "POST", "/api/v1/books/rules", "books.rules.create", 201, null, 188, "mcp"],
    [4 * MIN, "GET", "/api/v1/books/rules", "books.rules.list", 200, null, 97, "mcp"],
    [61 * MIN, "GET", "/api/v1/books/revision", "books.revision", 200, null, 38, "rest"],
    [3 * DAY, "GET", "/api/v1/books/summary", "books.summary", 200, null, 254, "rest"],
    [3 * DAY, "GET", "/api/v1/tracker/income", "tracker.income.summary", 200, null, 133, "rest"],
    [4 * DAY, "POST", "/api/v1/tracker/expenses", "tracker.expenses.create", 403, "missing_key_scope", 22, "rest"],
  ];
  const requests = calls.map(([age, method, path, operation, status, error_code, duration_ms, via], i) => ({
    id: `demo-request-${i}`,
    at: ago(age),
    api_key_id: via === "mcp" ? AGENT_KEY : SCRIPT_KEY,
    team_member_id: via === "mcp" ? AGENT_ID : OWNER_ID,
    method,
    path,
    operation,
    status,
    error_code,
    duration_ms,
    via,
  }));

  return { keys, members, requests };
}

/** A created key for the demo's show-once step. Never stored, never valid. */
export function demoCreatedKey(input: { name: string; scopes: string[]; days: number; member_id?: string }) {
  return {
    key: {
      id: `demo-key-${Date.now()}`,
      name: input.name,
      key_prefix: "vmfin_demo0000",
      team_member_id: input.member_id ?? OWNER_ID,
      created_by: OWNER_ID,
      scopes: input.scopes,
      expires_at: ahead(input.days * DAY),
      last_used_at: null,
      disabled_at: null,
      revoked_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    secret: `vmfin_demo${"0".repeat(44)}`,
  };
}

/**
 * A demo key with its access (and name, when sent) edited, for Edit key. Never
 * stored. Null when the key is not an active demo key or a scope is one its
 * member does not hold, which the route answers as read-only.
 */
export function demoEditedKey(id: string, scopes: string[], name?: string) {
  const key = demoKeys().find((k) => k.id === id && !k.revoked_at);
  const member = demoMembers().find((m) => m.id === key?.team_member_id);
  if (!key || !member || scopes.some((scope) => !member.api_scopes.includes(scope))) return null;
  const wanted = new Set(scopes);
  return {
    ...key,
    name: name ?? key.name,
    scopes: API_SCOPE_KEYS.filter((scope) => wanted.has(scope)),
    updated_at: new Date().toISOString(),
  };
}
