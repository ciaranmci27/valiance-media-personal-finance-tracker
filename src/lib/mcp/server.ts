import "server-only";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Server, type CallToolResult } from "@modelcontextprotocol/server";
import type { ApiOperation } from "@/lib/api/operations";
import { FINANCE_GUIDE } from "./guide";
import { routeHandler } from "./handlers";
import { GUIDE_TOOL, toolsForScopes, type McpTool } from "./tools";

/** Who the key acts as, from public.api_key_profile. */
export interface McpProfile {
  key_id: string;
  member_id: string;
  member_name: string;
  role: string;
  expires_at: string | null;
  /** Scopes on the key that the member still holds. */
  scopes: string[];
}

export interface McpCaller {
  key: string;
  profile: McpProfile;
  /** This deployment's origin, for the in-process request URLs. */
  origin: string;
}

/** Hermes spills larger results to disk; reads over this are refused with a hint. */
export const MAX_RESULT_CHARS = 40_000;

/**
 * Refusals that the agent can fix by changing the call. These come back as
 * ordinary results: Hermes opens a circuit breaker after three error results
 * in a row, which should happen for a bad key or an outage, not for a typo.
 */
const FIXABLE_FORBIDDEN = new Set(["drafts_only", "command_not_allowed"]);

interface Envelope {
  success?: boolean;
  source?: string;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  request_id?: string;
}

function textResult(
  payload: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function refusal(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  requestId?: string,
): CallToolResult {
  const fatal =
    status === 401 ||
    status === 429 ||
    status >= 500 ||
    (status === 403 && !FIXABLE_FORBIDDEN.has(String(details.reason)));
  return textResult(
    {
      ok: false,
      status,
      error: { code, message, ...details },
      ...(requestId ? { request_id: requestId } : {}),
    },
    fatal,
  );
}

function queryValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  // Anything else is not a query value; send it as text so the operation's
  // schema refuses it with a readable 422.
  return JSON.stringify(value);
}

/**
 * Runs one operation through its v1 route handler, in this process, as the
 * caller's key. withApi then authorizes the scope, counts the rate limit,
 * parses every argument with the operation's schemas, applies idempotency
 * and logs the request with via = mcp, exactly as for REST.
 */
export async function runOperation(
  op: ApiOperation,
  args: Record<string, unknown>,
  caller: McpCaller,
  maxChars = MAX_RESULT_CHARS,
  present?: (data: unknown) => unknown,
): Promise<CallToolResult> {
  const handler = routeHandler(op.path, op.method);
  if (!handler)
    return refusal(500, "INTERNAL_ERROR", "This tool is not wired up.", {
      reason: "internal",
    });

  const paramKeys = new Set(Object.keys(op.params?.shape ?? {}));
  const queryKeys = new Set(Object.keys(op.query.shape));
  const params: Record<string, string> = {};
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let idempotencyKey: string | null = null;
  for (const [name, value] of Object.entries(args)) {
    if (name === "idempotency_key" && op.idempotent) {
      // Left out, null or empty: the server makes one below.
      if (value !== undefined && value !== null && value !== "")
        idempotencyKey = typeof value === "string" ? value : String(value);
      continue;
    }
    if (paramKeys.has(name)) {
      if (value !== undefined && value !== null) params[name] = String(value);
    } else if (queryKeys.has(name) || !op.body) {
      // Unknown names land where the strict schema will refuse them.
      const text = queryValue(value);
      if (text !== null) query.set(name, text);
    } else body[name] = value;
  }
  if (op.idempotent && !idempotencyKey) idempotencyKey = randomUUID();

  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const url = `${caller.origin}${path}${query.size ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    "x-api-key": caller.key,
    "x-api-via": "mcp",
  };
  if (op.body) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const response = await handler(
    new NextRequest(url, {
      method: op.method,
      headers,
      ...(op.body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
  const envelope = (await response.json().catch(() => null)) as Envelope | null;
  const requestId = envelope?.request_id;

  if (!response.ok || !envelope?.success) {
    const error = envelope?.error;
    return refusal(
      response.status,
      error?.code ?? "INTERNAL_ERROR",
      error?.message ?? "Something went wrong on the server.",
      error?.details ?? {},
      requestId,
    );
  }

  const payload: Record<string, unknown> = {
    ok: true,
    source: envelope.source,
    data: present ? present(envelope.data) : envelope.data,
    ...(envelope.meta ? { meta: envelope.meta } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(response.headers.get("idempotent-replay") === "true"
      ? { replayed: true }
      : {}),
    request_id: requestId,
  };
  // Writes always report what happened, whatever their size; only reads
  // are refused for size, since a read can always be narrowed.
  if (op.method === "GET" && JSON.stringify(payload).length > maxChars)
    return refusal(
      413,
      "RESULT_TOO_LARGE",
      `The answer is over ${maxChars.toLocaleString("en-US")} characters.`,
      {
        reason: "result_too_large",
        hint: "Narrow it with the tool's filters (a date range, q, type or kind) or a smaller limit with offset paging.",
      },
      requestId,
    );
  return textResult(payload);
}

function guideResult(caller: McpCaller, tools: McpTool[]): CallToolResult {
  const payload = {
    ok: true,
    guide: FINANCE_GUIDE,
    you: {
      name: caller.profile.member_name,
      role: caller.profile.role,
      scopes: caller.profile.scopes,
      key_expires_at: caller.profile.expires_at,
    },
    tools: tools
      .filter((tool) => tool.definition.name !== GUIDE_TOOL)
      .map((tool) => tool.definition.name),
  };
  return {
    content: [
      {
        type: "text",
        text: `${FINANCE_GUIDE}\n\nYou are ${payload.you.name} (${payload.you.role}). Scopes: ${payload.you.scopes.join(", ") || "none"}. Key expires: ${payload.you.key_expires_at ?? "never"}.\nTools: ${payload.tools.join(", ")}`,
      },
    ],
    structuredContent: payload,
  };
}

/**
 * One server per HTTP request (the endpoint is stateless): the tool list is
 * the caller's, and tools/call accepts only tools on it. Validation is left
 * to the operations' own schemas through withApi, so a bad argument is the
 * same readable 422 REST gives, returned as { ok: false }.
 */
export function createFinanceServer(caller: McpCaller): Server {
  const tools = toolsForScopes(caller.profile.scopes);
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const server = new Server(
    { name: "valiance-finance", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Valiance Media finance: the books (official numbers, drafts only) and the owner's trackers. Call finance_guide first.",
    },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: tools.map((tool) => tool.definition),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const tool = byName.get(name);
    let result: CallToolResult;
    if (!tool)
      result = refusal(
        404,
        "NOT_FOUND",
        `No tool named ${name} for this key.`,
        {
          reason: "unknown_tool",
          hint: "List the tools again; your key's scopes decide which you can use.",
        },
      );
    else if (!tool.operation) result = guideResult(caller, tools);
    else {
      const args = request.params.arguments;
      result = await runOperation(
        tool.operation,
        {
          ...tool.defaults,
          ...(args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {}),
        },
        caller,
        MAX_RESULT_CHARS,
        tool.present,
      ).catch((failure: unknown) => {
        console.error(`[mcp] ${name}`, failure);
        return refusal(
          500,
          "INTERNAL_ERROR",
          "Something went wrong on the server.",
          { reason: "internal" },
        );
      });
    }
    return server.projectCallToolResult(result, undefined);
  });

  return server;
}
