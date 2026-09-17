import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { TextDecoder } from "node:util";
import {
  BRIDGE_HOSTS,
  bridgeUrl,
  SimpleFinError,
  type ProviderResponse,
  type ProviderTransport,
} from "@feeds/protocol.ts";

// The protocol pieces live in supabase/functions/_shared/feeds so the
// sync-feeds edge function ships the same parser and request rules. This
// module keeps the Node-only transport: DNS pinning and private-address checks.
export {
  SimpleFinError,
  bridgeUrl,
  setupClaimUrl,
  safeProviderMessage,
  claimSimpleFin,
  requestSimpleFin,
  feedStorageError,
  type ProviderResponse,
  type ProviderTransport,
} from "@feeds/protocol.ts";

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase(),
      [first, second] = normalized
        .split(":")
        .map((part) => parseInt(part || "0", 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !normalized.includes(".") &&
      !normalized.includes("%") &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      first !== 0x2002 &&
      first !== 0x3fff
    );
  }
  return false;
}
type Destination = { address: string; family: number };
export async function resolveBridge(hostname: string): Promise<Destination> {
  if (!BRIDGE_HOSTS.has(hostname))
    throw new SimpleFinError("invalid_host", "Unsupported SimpleFIN host.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SimpleFinError(
                "dns_timeout",
                "The provider could not be reached. Try again later.",
              ),
            ),
          15000,
        );
      }),
    ]);
    if (!records.length || records.some((r) => !publicAddress(r.address)))
      throw new SimpleFinError(
        "private_address",
        "The provider resolved to an unsupported network address.",
      );
    return records.find((r) => r.family === 4) ?? records[0];
  } catch (e) {
    if (e instanceof SimpleFinError) throw e;
    throw new SimpleFinError(
      "dns_failed",
      "The provider could not be reached. Try again later.",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const secureProviderTransport: ProviderTransport = async (
  url,
  method,
  authorization,
) => {
  bridgeUrl(url.href, method === "POST" ? "claim" : "request");
  const destination = await resolveBridge(url.hostname);
  return new Promise<ProviderResponse>((resolve, reject) => {
    // Pin the validated DNS answer so a second lookup cannot rebind the request.
    const req = request(
      url,
      {
        method,
        signal: AbortSignal.timeout(25000),
        agent: false,
        headers: {
          Accept: method === "POST" ? "text/plain" : "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
          ...(method === "POST" ? { "Content-Length": "0" } : {}),
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [destination]);
          else callback(null, destination.address, destination.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) {
            res.destroy();
            reject(
              new SimpleFinError(
                "response_size",
                "The provider response is too large. Use a shorter sync window.",
              ),
            );
          } else chunks.push(chunk);
        });
        res.on("error", () =>
          reject(
            new SimpleFinError(
              "response_interrupted",
              "The provider response was interrupted. Saved progress is retained.",
            ),
          ),
        );
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
              retryAfter:
                typeof res.headers["retry-after"] === "string"
                  ? res.headers["retry-after"]
                  : null,
            });
          } catch {
            reject(
              new SimpleFinError(
                "invalid_response",
                "The provider returned invalid text.",
              ),
            );
          }
        });
      },
    );
    req.on("error", () =>
      reject(
        new SimpleFinError(
          "request_failed",
          "The provider could not be reached. Saved progress is retained.",
        ),
      ),
    );
    req.end();
  });
};
