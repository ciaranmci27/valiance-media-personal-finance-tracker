// Supabase Edge Function: sync-feeds
//
// Called by pg_cron (job accounting-sync-feeds, hourly at :17) through pg_net.
// Runs the same SimpleFIN pull as the Next.js worker route, through the same
// accounting.sync_server lease, so it can never overlap a manual "Sync now".
// Auth is the shared worker secret (x-worker-secret, or a Bearer token), not
// a JWT: deploy with verify_jwt = false (supabase/config.toml).
//
// Secrets: SIMPLEFIN_ENCRYPTION_KEY (plus _V<N> for rotated keys) and
// ACCOUNTING_WORKER_SECRET, the same values as admin/.env. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
import { createClient } from "@supabase/supabase-js";
import { runDueFeeds, type FeedRpc } from "../_shared/feeds/sync.ts";
import { decryptVersioned } from "../_shared/feeds/aes-gcm.ts";
import {
  bridgeUrl,
  feedStorageError,
  SimpleFinError,
  type ProviderTransport,
} from "../_shared/feeds/protocol.ts";

const encoder = new TextEncoder();
const RESPONSE_LIMIT = 20 * 1024 * 1024;
/** Under the 150s wall clock of the free plan, with room for the response. */
const BUDGET_SECONDS = 100;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const client = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
function sameSecret(provided: string, expected: string): boolean {
  const a = encoder.encode(provided),
    b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a[index] ^ b[index];
  return difference === 0;
}
/** fetch with the Bridge host allowlist, no redirects, a 25s limit and a 20MB cap. */
const fetchTransport: ProviderTransport = async (
  url,
  method,
  authorization,
) => {
  bridgeUrl(url.href, method === "POST" ? "claim" : "request");
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
      headers: {
        Accept: method === "POST" ? "text/plain" : "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });
  } catch {
    throw new SimpleFinError(
      "request_failed",
      "The provider could not be reached. Saved progress is retained.",
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new SimpleFinError(
          "response_size",
          "The provider response is too large. Use a shorter sync window.",
        );
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SimpleFinError(
      "invalid_response",
      "The provider returned invalid text.",
    );
  }
  return {
    status: response.status,
    body,
    retryAfter: response.headers.get("retry-after"),
  };
};
const rpc: FeedRpc = async (command) => {
  const { data, error } = await client
    .schema("accounting")
    .rpc("sync_server", { command });
  if (error) throw feedStorageError(error.message);
  return data;
};
const decrypt = async (cipher: string) =>
  bridgeUrl(
    await decryptVersioned(cipher, (version) =>
      Deno.env.get(
        version === 1
          ? "SIMPLEFIN_ENCRYPTION_KEY"
          : `SIMPLEFIN_ENCRYPTION_KEY_V${version}`,
      ),
    ),
    "access",
  ).href;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const secret = Deno.env.get("ACCOUNTING_WORKER_SECRET") ?? "";
  const provided =
    req.headers.get("x-worker-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 32 || !sameSecret(provided, secret))
    return json({ error: "Unauthorized." }, 401);
  if (!supabaseUrl || !serviceKey || !Deno.env.get("SIMPLEFIN_ENCRYPTION_KEY"))
    return json({ error: "The feed worker is not configured." }, 503);
  let source = "supabase";
  try {
    const body = await req.json();
    if (body && typeof body.source === "string")
      source = body.source.slice(0, 40);
  } catch {
    /* An empty body is a plain tick. */
  }
  try {
    const result = await runDueFeeds({
      rpc,
      decrypt,
      transport: fetchTransport,
      source,
      budgetSeconds: BUDGET_SECONDS,
    });
    console.log(JSON.stringify({ event: "sync-feeds", ...result }));
    return json(result, 200);
  } catch (error) {
    console.error(
      "[sync-feeds]",
      error instanceof Error ? error.message : String(error),
    );
    return json(
      {
        error:
          "The feed run failed. Review the retained connection diagnostics.",
      },
      503,
    );
  }
});
