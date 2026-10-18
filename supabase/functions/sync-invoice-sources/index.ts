// Supabase Edge Function: sync-invoice-sources
//
// Called by pg_cron (job accounting-sync-invoice-sources, hourly at :47) through
// pg_net. Runs the same invoice source sync as the Next.js Sync now route,
// through the same accounting.invoice_sync_server lease, so the two never
// overlap. Auth is the shared worker secret (x-worker-secret, or a Bearer
// token), not a JWT: deploy with verify_jwt = false (supabase/config.toml).
//
// Secrets: INVOICE_SOURCE_ENCRYPTION_KEY (plus _V<N> for rotated keys) and
// ACCOUNTING_WORKER_SECRET, the same values as admin/.env. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
import { createClient } from "@supabase/supabase-js";
import {
  runInvoiceSources,
  type InvoiceRpc,
} from "../_shared/invoices/sync.ts";
import {
  InvoiceSourceError,
  publicAddress,
  sourceBaseUrl,
  type SourceTransport,
} from "../_shared/invoices/contract.ts";
import { decryptVersioned } from "../_shared/feeds/aes-gcm.ts";

const encoder = new TextEncoder();
const RESPONSE_LIMIT = 10 * 1024 * 1024;
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
/** Every A and AAAA record must be public before the request goes out. */
async function requirePublicHost(host: string) {
  const records: string[] = [];
  for (const type of ["A", "AAAA"] as const)
    try {
      records.push(...(await Deno.resolveDns(host, type)));
    } catch {
      /* A host may have only one family. */
    }
  if (!records.length || records.some((address) => !publicAddress(address)))
    throw new InvoiceSourceError(
      "invalid_url",
      "The invoicing system's address is not on the public internet.",
    );
}
/** HTTPS to public hosts only, no redirects, 20 seconds and 10 MB per request. */
const fetchTransport: SourceTransport = async ({
  method,
  url,
  apiKey,
  body,
}) => {
  const target = new URL(url);
  sourceBaseUrl(`${target.protocol}//${target.host}`);
  await requirePublicHost(target.hostname.replace(/^\[|\]$/g, ""));
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: "application/json",
        "User-Agent": "ValianceAccounting/1",
        "x-api-key": apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new InvoiceSourceError(
      "unreachable",
      "The invoicing system could not be reached within 20 seconds.",
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
        throw new InvoiceSourceError(
          "invalid_response",
          "The invoicing system's response is too large.",
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
  try {
    return {
      status: response.status,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    throw new InvoiceSourceError(
      "invalid_response",
      "The invoicing system returned unreadable text.",
    );
  }
};
const rpc: InvoiceRpc = async (command) => {
  const { data, error } = await client
    .schema("accounting")
    .rpc("invoice_sync_server", { command });
  if (error) throw new Error(error.message);
  return data;
};
const decrypt = (cipher: string) =>
  decryptVersioned(cipher, (version) =>
    Deno.env.get(
      version === 1
        ? "INVOICE_SOURCE_ENCRYPTION_KEY"
        : `INVOICE_SOURCE_ENCRYPTION_KEY_V${version}`,
    ),
  );

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const secret = Deno.env.get("ACCOUNTING_WORKER_SECRET") ?? "";
  const provided =
    req.headers.get("x-worker-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 32 || !sameSecret(provided, secret))
    return json({ error: "Unauthorized." }, 401);
  if (
    !supabaseUrl ||
    !serviceKey ||
    !Deno.env.get("INVOICE_SOURCE_ENCRYPTION_KEY")
  )
    return json({ error: "The invoice source worker is not configured." }, 503);
  let source = "supabase";
  try {
    const body = await req.json();
    if (body && typeof body.source === "string")
      source = body.source.slice(0, 40);
  } catch {
    /* An empty body is a plain tick. */
  }
  try {
    const result = await runInvoiceSources({
      rpc,
      decrypt,
      transport: fetchTransport,
      source,
      budgetSeconds: BUDGET_SECONDS,
    });
    console.log(JSON.stringify({ event: "sync-invoice-sources", ...result }));
    return json(result, 200);
  } catch (error) {
    console.error(
      "[sync-invoice-sources]",
      error instanceof Error ? error.message : String(error),
    );
    return json(
      {
        error: "The invoice source run failed. Review the source's last error.",
      },
      503,
    );
  }
});
