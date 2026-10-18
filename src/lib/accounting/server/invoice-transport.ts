import "server-only";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import {
  InvoiceSourceError,
  publicAddress,
  sourceBaseUrl,
  type SourceTransport,
} from "@invoices/contract.ts";

type Address = { address: string; family: number };
const RESPONSE_LIMIT = 10 * 1024 * 1024;

/** Every address the host resolves to must be public; the connection is then pinned to one of them, so DNS cannot swap in a private one mid-request. */
export async function resolvePublic(
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
          () =>
            reject(
              new InvoiceSourceError(
                "unreachable",
                "The invoicing system's address did not resolve in time.",
              ),
            ),
          5000,
        );
      }),
    ]);
    if (!records.length || records.some((r) => !publicAddress(r.address)))
      throw new InvoiceSourceError(
        "invalid_url",
        "The invoicing system's address is not on the public internet.",
      );
    return records.find((r) => r.family === 4) ?? records[0];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTPS only, public destinations only, no redirects, 20 seconds and 10 MB per request. */
export const secureSourceTransport: SourceTransport = async ({
  method,
  url,
  apiKey,
  body,
}) => {
  const started = Date.now(),
    target = new URL(url);
  sourceBaseUrl(`${target.protocol}//${target.host}`);
  const address = await resolvePublic(target.hostname.replace(/^\[|\]$/g, ""));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method,
        agent: false,
        signal: AbortSignal.timeout(
          Math.max(1, 20000 - (Date.now() - started)),
        ),
        headers: {
          Accept: "application/json",
          "User-Agent": "ValianceAccounting/1",
          "x-api-key": apiKey,
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }),
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) {
            res.destroy();
            reject(
              new InvoiceSourceError(
                "invalid_response",
                "The invoicing system's response is too large.",
              ),
            );
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            });
          } catch {
            reject(
              new InvoiceSourceError(
                "invalid_response",
                "The invoicing system returned unreadable text.",
              ),
            );
          }
        });
        res.on("error", () =>
          reject(
            new InvoiceSourceError(
              "unreachable",
              "The invoicing system's response was interrupted.",
            ),
          ),
        );
        res.on("aborted", () =>
          reject(
            new InvoiceSourceError(
              "unreachable",
              "The invoicing system's response was interrupted.",
            ),
          ),
        );
      },
    );
    req.on("error", () =>
      reject(
        new InvoiceSourceError(
          "unreachable",
          "The invoicing system could not be reached within 20 seconds.",
        ),
      ),
    );
    req.end(payload);
  });
};
