import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { TextDecoder } from "node:util";

// Exact hosts from the SimpleFIN Bridge developer guide. Institution-supplied
// URLs are metadata and are never network destinations for this adapter.
const hosts = new Set(["bridge.simplefin.org", "beta-bridge.simplefin.org"]);
export class SimpleFinError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "SimpleFinError";
  }
}
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
export function bridgeUrl(
  raw: string,
  kind: "claim" | "access" | "request",
): URL {
  if (raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw))
    throw new SimpleFinError(
      "invalid_url",
      "Use a valid SimpleFIN Bridge token.",
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SimpleFinError(
      "invalid_url",
      "Use a valid SimpleFIN Bridge token.",
    );
  }
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.hash
  )
    throw new SimpleFinError(
      "invalid_host",
      "Only the verified SimpleFIN Bridge HTTPS hosts are supported.",
    );
  if (
    kind === "claim" &&
    (url.username ||
      url.password ||
      url.search ||
      !/^\/simplefin\/claim\/[A-Za-z0-9._~%-]+$/.test(url.pathname))
  )
    throw new SimpleFinError(
      "invalid_claim",
      "This is not a SimpleFIN setup token.",
    );
  if (
    kind === "access" &&
    (!url.username ||
      !url.password ||
      url.search ||
      !/^\/simplefin\/?$/.test(url.pathname))
  )
    throw new SimpleFinError(
      "invalid_access",
      "The provider returned an unsupported access URL.",
    );
  if (
    kind === "request" &&
    (url.username ||
      url.password ||
      !/^\/simplefin\/(?:accounts|info)$/.test(url.pathname))
  )
    throw new SimpleFinError(
      "invalid_request",
      "Unsupported SimpleFIN request.",
    );
  if (kind === "access")
    try {
      const user = decodeURIComponent(url.username),
        password = decodeURIComponent(url.password);
      if (user.includes(":") || /[\r\n\u0000]/.test(user + password))
        throw new Error();
    } catch {
      throw new SimpleFinError(
        "invalid_access",
        "The provider returned unsupported access credentials.",
      );
    }
  return url;
}
export function setupClaimUrl(token: string): URL {
  const trimmed = token.trim();
  if (
    trimmed.length < 16 ||
    trimmed.length > 12000 ||
    trimmed.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
  )
    throw new SimpleFinError(
      "invalid_token",
      "Paste the complete SimpleFIN setup token.",
    );
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(trimmed, "base64"),
    );
  } catch {
    throw new SimpleFinError(
      "invalid_token",
      "The setup token is not valid UTF-8.",
    );
  }
  return bridgeUrl(decoded, "claim");
}
export function safeProviderMessage(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, "[provider URL]")
    .replace(/(?:Basic|Bearer)\s+\S+/gi, "[credentials]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1000);
}
type Destination = { address: string; family: number };
export type ProviderResponse = {
  status: number;
  body: string;
  retryAfter: string | null;
};
export type ProviderTransport = (
  url: URL,
  method: "GET" | "POST",
  authorization?: string,
) => Promise<ProviderResponse>;
export async function resolveBridge(hostname: string): Promise<Destination> {
  if (!hosts.has(hostname))
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
  return new Promise((resolve, reject) => {
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
function requireSuccess(response: ProviderResponse, claim = false) {
  if (response.status === 200) return;
  if (response.status >= 300 && response.status < 400)
    throw new SimpleFinError(
      "redirect_refused",
      "The provider redirected this request. Reconnect using a current Bridge setup token.",
    );
  if (response.status === 403)
    throw new SimpleFinError(
      claim ? "claim_rejected" : "access_revoked",
      claim
        ? "This setup token was already used or is invalid. Disable it in SimpleFIN and create a new token."
        : "SimpleFIN access was revoked or expired. Reconnect to resume.",
    );
  if (response.status === 402)
    throw new SimpleFinError(
      "subscription_required",
      "Check your SimpleFIN subscription before syncing again.",
    );
  const seconds = Number(response.retryAfter);
  const delay =
    Number.isFinite(seconds) && seconds > 0
      ? Math.min(Math.ceil(seconds), 86400)
      : null;
  if (response.status === 429)
    throw new SimpleFinError(
      "rate_limited",
      "SimpleFIN has paused requests. Retry after the displayed wait.",
      delay ?? 3600,
    );
  throw new SimpleFinError(
    "provider_unavailable",
    "SimpleFIN could not complete this request. Try again later.",
    delay ?? 3600,
  );
}
export async function claimSimpleFin(
  token: string,
  transport: ProviderTransport = secureProviderTransport,
): Promise<string> {
  const result = await transport(setupClaimUrl(token), "POST");
  requireSuccess(result, true);
  return bridgeUrl(result.body.trim(), "access").href;
}
export async function requestSimpleFin(
  accessUrl: string,
  parameters: Record<string, string>,
  transport: ProviderTransport = secureProviderTransport,
): Promise<unknown> {
  const access = bridgeUrl(accessUrl, "access"),
    url = new URL(access.href);
  const authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, "utf8").toString("base64")}`;
  url.username = "";
  url.password = "";
  url.pathname = url.pathname.replace(/\/$/, "") + "/accounts";
  url.search = new URLSearchParams({ ...parameters, version: "2" }).toString();
  const response = await transport(url, "GET", authorization);
  requireSuccess(response);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new SimpleFinError(
      "invalid_json",
      "SimpleFIN returned an unreadable response. Coverage was not advanced.",
    );
  }
}
