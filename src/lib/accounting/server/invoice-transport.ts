import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

export function publicInvoiceAddress(address: string): boolean {
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
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase(),
      [first, second] = normalized
        .split(":")
        .map((p) => parseInt(p || "0", 16));
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
export function invoiceDestination(raw: string): URL {
  if (raw.length > 4096 || /[\u0000-\u0020\u007f]/.test(raw))
    throw new Error("Endpoint URL is invalid.");
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "Use a public HTTPS endpoint on port 443 without embedded credentials or a fragment.",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) && !publicInvoiceAddress(host))
  )
    throw new Error("Endpoint must use a public network destination.");
  return url;
}
type Address = { address: string; family: number };
export async function resolveInvoice(
  host: string,
  resolver: (host: string) => Promise<Address[]> = (h) =>
    lookup(h, { all: true, verbatim: true }),
): Promise<Address> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Endpoint DNS lookup timed out.")),
          5000,
        );
      }),
    ]);
    if (
      !records.length ||
      records.some((r) => !publicInvoiceAddress(r.address))
    )
      throw new Error("Endpoint DNS returned an unsupported network address.");
    return records.find((r) => r.family === 4) ?? records[0];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export type InvoiceTransport = (input: {
  snapshot_id: string;
  cursor?: number;
}) => Promise<unknown>;
export function invoiceSourceUrl(raw: string) {
  const origin = invoiceDestination(raw);
  if (origin.pathname !== "/" || origin.search)
    throw new Error("Configure the CRM origin without a path or query.");
  return new URL("/api/internal/accounting/invoices/snapshot", origin).href;
}
export function invoiceTransport(
  origin: string,
  secret: string,
): InvoiceTransport {
  const destination = invoiceSourceUrl(origin);
  return async (input) => {
    const started = Date.now(),
      url = new URL(destination),
      body = JSON.stringify(input);
    const address = await resolveInvoice(url.hostname.replace(/^\[|\]$/g, ""));
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          agent: false,
          signal: AbortSignal.timeout(
            Math.max(1, 20000 - (Date.now() - started)),
          ),
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            "User-Agent": "ValianceAccounting/1",
          },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.destroy();
            reject(
              new Error(`Invoice source returned HTTP ${res.statusCode ?? 0}.`),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4200000) {
              res.destroy();
              reject(
                new Error("Invoice snapshot exceeds the supported page size."),
              );
            } else chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              resolve(
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                ),
              );
            } catch {
              reject(new Error("Invoice source returned invalid JSON."));
            }
          });
          res.on("error", () =>
            reject(new Error("Invoice source response was interrupted.")),
          );
          res.on("aborted", () =>
            reject(new Error("Invoice source response was interrupted.")),
          );
        },
      );
      req.on("error", () =>
        reject(
          new Error("Invoice source could not be reached within 20 seconds."),
        ),
      );
      req.end(body);
    });
  };
}
