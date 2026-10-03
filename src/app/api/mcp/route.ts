import { NextResponse, type NextRequest } from "next/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { hashApiKey } from "@/lib/api/keys";
import { ApiError, databaseError } from "@/lib/api/http";
import {
  createFinanceServer,
  type McpCaller,
  type McpProfile,
} from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The finance MCP server: Streamable HTTP, stateless, JSON responses. It
 * serves the 2026-07-28 protocol and the older initialize handshake (which
 * Hermes still sends) from one server definition.
 *
 * Authentication is the v1 API key in x-api-key (or Authorization: Bearer).
 * The key decides which tools are listed, and every tool call runs the v1
 * route handler as that key, so the scopes, member permissions, rate limit
 * and request log are REST's. Revoking a key closes both doors.
 */
const mcp = createMcpHandler(
  ({ authInfo }) => createFinanceServer(authInfo?.extra?.caller as McpCaller),
  {
    legacy: "stateless",
    responseMode: "json",
    onerror: (error) => console.error("[mcp]", error.message),
  },
);

function rpcError(
  status: number,
  message: string,
  data?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message, ...(data ? { data } : {}) },
    },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

function readKey(request: NextRequest): string | null {
  const header = request.headers.get("x-api-key")?.trim();
  if (header) return header;
  return (
    /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ??
    null
  );
}

/** Browsers send Origin; server clients such as Hermes do not. A foreign one is refused. */
function foreignOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}

export async function POST(request: NextRequest) {
  if (foreignOrigin(request))
    return rpcError(403, "This origin may not call the finance MCP server.");
  if (isDemoMode())
    return rpcError(403, "The API is off in demo mode.", {
      reason: "demo_mode",
    });
  const key = readKey(request);
  if (!key)
    return rpcError(401, "Send your API key in the x-api-key header.", {
      reason: "missing_api_key",
    });

  let profile: McpProfile;
  try {
    const { data, error } = await getServiceClient().rpc("api_key_profile", {
      p_key_hash: hashApiKey(key),
    });
    if (error) throw databaseError(error.message, "api.use");
    profile = data as McpProfile;
  } catch (caught) {
    const failure =
      caught instanceof ApiError
        ? caught
        : new ApiError(
            500,
            "INTERNAL_ERROR",
            "Something went wrong on the server.",
            {
              reason: "internal",
            },
          );
    if (!(caught instanceof ApiError) || failure.status >= 500)
      console.error("[mcp] profile", caught);
    return rpcError(failure.status, failure.message, failure.details);
  }

  const caller: McpCaller = {
    key,
    profile,
    origin: request.nextUrl.origin,
  };
  return mcp.fetch(request, {
    authInfo: {
      token: key,
      clientId: profile.member_id,
      scopes: profile.scopes,
      extra: { caller },
    },
  });
}

/** Stateless: there is no stream to open and no session to end. */
function methodNotAllowed() {
  return rpcError(
    405,
    "Method not allowed. Send JSON-RPC with POST.",
    undefined,
    {
      Allow: "POST",
    },
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
