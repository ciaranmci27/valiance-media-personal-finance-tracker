import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { hashApiKey } from "./keys";
import {
  ApiError,
  databaseError,
  errorResponse,
  successResponse,
} from "./http";
import type { ApiOperation } from "./operations";

export interface ApiContext<O extends ApiOperation> {
  query: z.infer<O["query"]>;
  params: O["params"] extends z.ZodObject
    ? z.infer<O["params"]>
    : Record<string, never>;
  body: O["body"] extends z.ZodObject
    ? z.infer<O["body"]>
    : Record<string, never>;
  /** The caller's Idempotency-Key on creates (a uuid), else a fresh one. */
  idempotencyKey: string;
  /** SHA-256 of the caller's key; every books call re-checks it in SQL. */
  keyHash: string;
  /** This deployment's origin, for links into the app (review_url). */
  origin: string;
  service: SupabaseClient;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;

async function readBody(request: NextRequest): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json"))
    throw new ApiError(
      415,
      "VALIDATION_ERROR",
      "Send a JSON body with Content-Type: application/json.",
      {
        reason: "unsupported_media_type",
      },
    );
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new ApiError(413, "VALIDATION_ERROR", "The body is too large.", {
      reason: "body_too_large",
    });
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "The body is not valid JSON.", {
      reason: "invalid_json",
    });
  }
}

interface Claim {
  state: "new" | "replay" | "conflict" | "busy";
  status?: number;
  response?: unknown;
  token?: string;
}

export interface ApiResult {
  data: unknown;
  meta?: Record<string, unknown>;
}

interface Authorization {
  key_id: string;
  member_id: string;
  limit: number;
  remaining: number;
  reset_at: string;
}

function readKey(request: NextRequest): string | null {
  const header = request.headers.get("x-api-key")?.trim();
  if (header) return header;
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  return bearer?.[1] ?? null;
}

function validation(
  error: z.ZodError,
  where: "path" | "query" | "body",
): ApiError {
  return new ApiError(
    422,
    "VALIDATION_ERROR",
    `Check the ${where} parameters.`,
    {
      reason: "invalid_parameters",
      hint: "issues names each parameter and what is wrong with it.",
      issues: error.issues.map((issue) => ({
        parameter:
          issue.path.join(".") ||
          (issue.code === "unrecognized_keys" ? issue.keys.join(", ") : ""),
        message: issue.message,
      })),
    },
  );
}

/**
 * Wraps one API operation. The key is checked by public.api_authorize, in SQL,
 * against the operation's permission: the scope must be on the key AND the
 * member must hold it, plus 'Use the API'. That call also counts the rate
 * limit. Parameters are parsed with the operation's schemas, the answer goes
 * out in the standard envelope, and every request (refusals included) is
 * written to public.api_requests after the response.
 */
export function withApi<const O extends ApiOperation>(
  op: O,
  handler: (context: ApiContext<O>) => Promise<ApiResult>,
) {
  return async (
    request: NextRequest,
    routeContext: { params: Promise<Record<string, string>> },
  ) => {
    const started = Date.now();
    const requestId = randomUUID();
    let authorization: Authorization | null = null;
    let status = 200;
    let errorCode: string | null = null;
    let service: SupabaseClient | null = null;
    let keyHash: string | null = null;

    const rateHeaders = (): Record<string, string> =>
      authorization
        ? {
            "X-RateLimit-Limit": String(authorization.limit),
            "X-RateLimit-Remaining": String(
              Math.max(0, authorization.remaining),
            ),
            "X-RateLimit-Reset": String(
              Math.floor(new Date(authorization.reset_at).getTime() / 1000),
            ),
          }
        : {};

    try {
      if (isDemoMode())
        throw new ApiError(403, "FORBIDDEN", "The API is off in demo mode.", {
          reason: "demo_mode",
        });
      service = getServiceClient();
      const key = readKey(request);
      if (!key)
        throw new ApiError(
          401,
          "UNAUTHORIZED",
          "Send your API key in the x-api-key header.",
          { reason: "missing_api_key" },
        );
      keyHash = hashApiKey(key);

      const { data, error } = await service.rpc("api_authorize", {
        p_key_hash: keyHash,
        p_permission: op.permission,
      });
      if (error) throw databaseError(error.message, op.permission);
      authorization = data as Authorization;

      const params = op.params
        ? op.params.safeParse(await routeContext.params)
        : { success: true as const, data: {} };
      if (!params.success) throw validation(params.error, "path");
      const query = op.query.safeParse(
        Object.fromEntries(request.nextUrl.searchParams),
      );
      if (!query.success) throw validation(query.error, "query");
      const raw = op.body ? await readBody(request) : {};
      const body = op.body
        ? op.body.safeParse(raw)
        : { success: true as const, data: {} };
      if (!body.success) throw validation(body.error, "body");

      // Creates carry an Idempotency-Key: the first answer is stored per key
      // and replayed on a retry, and a different request under the same key
      // is refused, so a retried create never writes twice.
      let idempotencyKey: string = randomUUID();
      let claimToken: string | null = null;
      if (op.idempotent) {
        const header = request.headers.get("idempotency-key")?.trim() ?? "";
        if (!UUID.test(header))
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Send an Idempotency-Key header holding a new uuid for each create.",
            {
              reason: "missing_idempotency_key",
            },
          );
        idempotencyKey = header.toLowerCase();
        const requestHash = createHash("sha256")
          .update(
            `${request.method} ${request.nextUrl.pathname} ${JSON.stringify(body.data)}`,
          )
          .digest("hex");
        const { data: claim, error: claimError } = await service.rpc(
          "api_idempotency_claim",
          {
            p_key_hash: keyHash,
            p_idempotency_key: idempotencyKey,
            p_request_hash: requestHash,
          },
        );
        if (claimError) throw databaseError(claimError.message, op.permission);
        const outcome = claim as Claim;
        if (outcome.state === "conflict")
          throw new ApiError(
            409,
            "CONFLICT",
            "This Idempotency-Key was already used for a different request.",
            {
              reason: "idempotency_conflict",
            },
          );
        if (outcome.state === "busy")
          throw new ApiError(
            409,
            "CONFLICT",
            "A request with this Idempotency-Key is still running. Retry shortly.",
            {
              reason: "idempotency_in_progress",
            },
          );
        if (outcome.state === "replay") {
          status = outcome.status ?? 200;
          return successResponse(op.source, outcome.response, requestId, {
            ...rateHeaders(),
            "Idempotent-Replay": "true",
          });
        }
        claimToken = outcome.token ?? null;
      }

      try {
        const result = await handler({
          query: query.data as ApiContext<O>["query"],
          params: params.data as ApiContext<O>["params"],
          body: body.data as ApiContext<O>["body"],
          idempotencyKey,
          keyHash,
          origin: request.nextUrl.origin,
          service,
        });
        if (claimToken) {
          const { error: storeError } = await service.rpc(
            "api_idempotency_finish",
            {
              p_key_hash: keyHash,
              p_idempotency_key: idempotencyKey,
              p_token: claimToken,
              p_status: 200,
              p_response: result.data ?? null,
            },
          );
          if (storeError)
            console.error(
              `[api] ${op.id} ${requestId} idempotency store failed`,
              storeError.message,
            );
        }
        return successResponse(
          op.source,
          result.data,
          requestId,
          rateHeaders(),
          result.meta,
        );
      } catch (failure) {
        // Nothing was written, so the key is freed for a corrected retry.
        if (claimToken)
          await service.rpc("api_idempotency_release", {
            p_key_hash: keyHash,
            p_idempotency_key: idempotencyKey,
            p_token: claimToken,
          });
        throw failure;
      }
    } catch (caught) {
      const error =
        caught instanceof ApiError
          ? caught
          : new ApiError(
              500,
              "INTERNAL_ERROR",
              "Something went wrong on the server.",
              { reason: "internal" },
            );
      if (!(caught instanceof ApiError))
        console.error(`[api] ${op.id} ${requestId}`, caught);
      status = error.status;
      errorCode = String(error.details.reason ?? error.code);
      const extra: Record<string, string> = rateHeaders();
      if (error.status === 429)
        extra["Retry-After"] = String(60 - new Date().getUTCSeconds());
      return errorResponse(error, requestId, extra);
    } finally {
      const log: Record<string, unknown> & {
        api_key_id: string | null;
        team_member_id: string | null;
      } = {
        api_key_id: authorization?.key_id ?? null,
        team_member_id: authorization?.member_id ?? null,
        method: request.method,
        path: request.nextUrl.pathname,
        operation: op.id,
        status,
        error_code: errorCode,
        duration_ms: Date.now() - started,
        // The MCP server calls these same handlers and says so; the label
        // only sorts the log, it grants nothing. Sent only for MCP, so REST
        // logging never depends on the column (default 'rest').
        ...(request.headers.get("x-api-via") === "mcp" ? { via: "mcp" } : {}),
      };
      const client = service;
      // Calls without a usable key carry no identity and would let anyone
      // write rows at will, so only calls that reached a key are logged.
      const anonymous =
        errorCode === "missing_api_key" || errorCode === "invalid_api_key";
      if (client && !anonymous) {
        const hash = keyHash;
        const write = async () => {
          // A real key that was refused (scope, member, expiry, rate) is still
          // attributed to its key and member.
          if (!log.api_key_id && hash) {
            const { data: key } = await client
              .from("api_keys")
              .select("id, team_member_id")
              .eq("key_hash", hash)
              .maybeSingle();
            if (key) {
              log.api_key_id = key.id as string;
              log.team_member_id =
                (key.team_member_id as string | null) ?? null;
            }
          }
          const { error } = await client.from("api_requests").insert(log);
          if (error) console.error("[api] request log failed", error.message);
        };
        // after() runs the write once the response is sent; outside a Next
        // request (scripts) it is unavailable and the write runs directly.
        try {
          after(write);
        } catch {
          void write();
        }
      }
    }
  };
}
